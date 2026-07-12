/**
 * GET /api/fba/rank-analysis/[asin]
 * ─────────────────────────────────────────────────────────────────────────────
 * "Rank Top of Amazon" — the 0-cost cache read for the listing-page Intelligence tab.
 *   • Returns the cached council analysis if one exists, with a `stale` flag when the
 *     listing copy changed since it ran (content_fingerprint mismatch).
 *   • On a cache miss, computes and returns the FREE stored-core live (0 JS credits,
 *     0 OpenAI) so the panel always has something honest to show.
 * The expensive council + Share-of-Voice run is POST-only (added in a later increment).
 *
 * Accepts parent OR child ASINs — parents resolve to their top child via the SHARED
 * resolver (identical to the intelligence route, no fork).
 */
import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveToChildAsin } from '@/lib/fba/resolveAsin';
import { getJungleScoutStatus } from '@/lib/sync/jungleScoutClient';
import {
  buildFreeCore,
  freeCoreToResult,
  contentFingerprint,
  runCouncilAnalysis,
  type RankContext,
  type RankAnalysisResult,
} from '@/lib/fba/rankAnalysis';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  try {
    const supabase = await createAdminClient();
    const { asin: rawAsin } = await params;
    const inputAsin = rawAsin?.toUpperCase();

    if (!inputAsin || !/^[A-Z0-9]{10}$/.test(inputAsin)) {
      return NextResponse.json({ error: 'Invalid ASIN format' }, { status: 400 });
    }

    const resolved = await resolveToChildAsin(inputAsin, supabase);
    if (!resolved) {
      return NextResponse.json(
        { error: `ASIN ${inputAsin} not found in catalog. Run a listing sync first.` },
        { status: 404 }
      );
    }
    const { childAsin, parentAsin } = resolved;
    const refreshFree = new URL(request.url).searchParams.get('refresh') === 'free';
    let staleCache = false;  // set when a cache hit's fingerprint no longer matches → recompute live below

    // 1. Cache read (0 cost). maybeSingle() → a 0-row miss is null (no throw). The try/catch only
    //    fires on a REAL error (e.g. migration 021 not yet applied) → degrade to the free core.
    let row: { content_fingerprint: string; result: RankAnalysisResult } | null = null;
    try {
      const { data: cached } = await supabase
        .from('listing_rank_analysis')
        .select('content_fingerprint, result')
        .eq('child_asin', childAsin)
        .maybeSingle();
      row = cached as { content_fingerprint: string; result: RankAnalysisResult } | null;
      if (!refreshFree && row?.result && Object.keys(row.result).length > 0) {
        const fp = await contentFingerprint(parentAsin, childAsin, supabase);
        if (fp === row.content_fingerprint) {
          return NextResponse.json({ ...row.result, stale: false });
        }
        // Content changed since the analysis ran → the frozen per-row coverage is a LIE (a keyword
        // shows COVERED after a push removed it). Don't serve the frozen rows with a mere stale flag;
        // fall through to a live free-core recompute + re-persist so coverage matches what's live.
        staleCache = true;
      }
    } catch (cacheErr) {
      console.warn(`[rank-analysis GET] cache read failed for ${childAsin}, serving free core:`, cacheErr);
    }

    // 2. Cache miss OR ?refresh=free (the rank banner's "Re-check now" — the stale chip was a
    //    dead-end: "1 high-opportunity gap" with no way to act on it; PO: "NOTHING is actionable").
    //    Recompute the FREE core live (0 JS credits, 0 OpenAI — pure DB + coverage math).
    const analyzedAt = new Date().toISOString();
    const core = await buildFreeCore(childAsin, parentAsin, supabase);
    const fresh = freeCoreToResult(core, childAsin, parentAsin, analyzedAt);

    if ((refreshFree || staleCache) && fresh.analyzed) {
      // Carry forward the prior PAID per-keyword SOV + council realities BY KEYWORD — the same
      // merge runCouncilAnalysis does, so a free re-check NEVER wipes paid competition data
      // (the #154 blocker class). The headline intentionally resets to the deterministic
      // baseline: the old council's wording described coverage that just changed.
      const prior = row?.result ?? null;
      if (prior?.rows?.length) {
        const byKw = new Map(prior.rows.map((p) => [p.keyword.toLowerCase(), p]));
        for (const r of fresh.rows) {
          const p = byKw.get(r.keyword.toLowerCase());
          if (!p) continue;
          r.theirShare = p.theirShare;
          r.sellerVisible = p.sellerVisible;
          if (p.topCompetitorBrand) r.topCompetitorBrand = p.topCompetitorBrand;
          if (p.nonContentReality) r.nonContentReality = p.nonContentReality;
        }
        fresh.competitionRan = prior.competitionRan;
        fresh.creditsSpent = prior.creditsSpent;
      }
      // Persist with the FRESH fingerprint so the stale flag clears everywhere (full upsert is
      // safe here: every column is supplied, nothing resets to DEFAULT). Missing table = silent.
      try {
        const fp = await contentFingerprint(parentAsin, childAsin, supabase);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = supabase as any; // listing_rank_analysis not in generated types yet (migration 021)
        await db.from('listing_rank_analysis').upsert(
          { child_asin: childAsin, parent_asin: parentAsin, analyzed_at: analyzedAt, competition_ran: fresh.competitionRan, credits_spent: fresh.creditsSpent, content_fingerprint: fp, result: fresh, run_lock_at: null },
          { onConflict: 'child_asin' },
        );
      } catch (persistErr) {
        if (!isMissingTable(persistErr)) console.warn(`[rank-analysis GET refresh] persist failed for ${childAsin}:`, persistErr);
      }
    }
    return NextResponse.json({ ...fresh, stale: false });

  } catch (error) {
    console.error('[GET /api/fba/rank-analysis/[asin]]', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

/** True when the error signals listing_rank_analysis doesn't exist yet (migration 021 not applied) —
 *  the one persist failure we intentionally tolerate silently (GET still serves the free core). */
function isMissingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code || '';
  const msg = (e?.message || '').toLowerCase();
  return code === 'PGRST205' || code === '42P01' || msg.includes('does not exist') || msg.includes('could not find the table');
}

/** Minimal council context — the live child title (the playbook + coverage carry the rest). */
async function loadRankContext(
  childAsin: string,
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
): Promise<RankContext> {
  const { data } = await supabase
    .from('listing_content')
    .select('title')
    .eq('asin', childAsin)
    .maybeSingle();
  return { title: (data as { title?: string } | null)?.title || '' };
}

// ── POST ──────────────────────────────────────────────────────────────────────
// Runs the council (3 analysts → GPT-5 adversary → GPT-5 judge), NDJSON-streamed so Cloudflare's
// ~100s idle window can't drop the connection. The council only ENRICHES; the honest floor is
// deterministic. Persists the result keyed on child_asin. (SOV/competition = increment 6.)

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  try {
    const supabase = await createAdminClient();
    const { asin: rawAsin } = await params;
    const inputAsin = rawAsin?.toUpperCase();

    if (!inputAsin || !/^[A-Z0-9]{10}$/.test(inputAsin)) {
      return NextResponse.json({ error: 'Invalid ASIN format' }, { status: 400 });
    }

    const resolved = await resolveToChildAsin(inputAsin, supabase);
    if (!resolved) {
      return NextResponse.json(
        { error: `ASIN ${inputAsin} not found in catalog. Run a listing sync first.` },
        { status: 404 }
      );
    }
    const { childAsin, parentAsin } = resolved;

    const { searchParams } = new URL(request.url);
    const withCompetition = searchParams.get('competition') === 'true';
    // JS-enabled only matters for the credit-spending competition path.
    const jsEnabled = withCompetition ? (await getJungleScoutStatus()).enabled : false;

    // Run-lock — guards EVERY POST against duplicate spend on a double-click (competition spends Jungle
    // Scout credits AND the council always spends GPT-5 tokens). ATOMIC acquire: ensure the row exists,
    // then ONE conditional UPDATE (run_lock_at NULL or older than 90s). Postgres serializes the UPDATE, so
    // two concurrent POSTs can't both win — 0 rows updated ⇒ a run is already in flight ⇒ 409. Best-effort:
    // a missing table (migration 021 not applied) or any lock-infra error ⇒ proceed unlocked. Released on
    // completion (success persist sets run_lock_at:null; the error path clears it too).
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any; // listing_rank_analysis not in generated types yet (migration 021)
      await db.from('listing_rank_analysis').upsert(
        { child_asin: childAsin, parent_asin: parentAsin },
        { onConflict: 'child_asin', ignoreDuplicates: true },        // ensure the row exists; leave an existing one untouched
      );
      const cutoff = new Date(Date.now() - 90_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const { data: acquired, error: lockErr } = await db
        .from('listing_rank_analysis')
        .update({ run_lock_at: new Date().toISOString() })
        .eq('child_asin', childAsin)
        .or(`run_lock_at.is.null,run_lock_at.lt.${cutoff}`)
        .select('child_asin');
      if (!lockErr && (!acquired || acquired.length === 0)) {
        return NextResponse.json(
          { error: 'An analysis is already running for this ASIN. Try again in ~90s.' },
          { status: 409 },
        );
      }
    } catch { /* lock-infra error → proceed unlocked; the analysis still runs */ }

    const ctx = await loadRankContext(childAsin, supabase);

    // OpenAI client — key from app_settings (Settings UI), env fallback. `new OpenAI()` with no key
    // silently fails in prod (the env key is unset), so resolve it explicitly. Mirrors getOpenAI().
    const { resolveOpenAIKey } = await import('@/lib/openai/credentials');
    const openai = new OpenAI({
      apiKey: await resolveOpenAIKey(),
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        try {
          emit({ type: 'progress', message: 'Building the rank playbook from your keywords...' });
          const analyzedAt = new Date().toISOString();
          const { result, fingerprint } = await runCouncilAnalysis(
            openai, childAsin, parentAsin, ctx, supabase, analyzedAt,
            { withCompetition, jsEnabled, onProgress: (message) => emit({ type: 'progress', message }) },
          );

          // Persist + release the lock. Only cache a real (analyzed) result — a no_keywords result depends
          // on keyword_analysis, not content, so caching it could mask newly-synced keywords; for that case
          // we still release the lock. A missing table (migration 021 not applied) stays silent, but ANY
          // OTHER persist failure is surfaced so the user knows it wasn't cached (paid competition credits
          // were already spent). Cast — listing_rank_analysis isn't in the generated types yet.
          emit({ type: 'progress', message: 'Saving analysis...' });
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const db = supabase as any; // not in generated types yet (migration 021)
            // Analyzed → full upsert (caches the result + releases the lock). no_keywords → a TARGETED
            // UPDATE of run_lock_at ONLY: a partial UPSERT would reset omitted columns to DEFAULT and wipe
            // a prior PAID competition run (adversarial regression catch); an UPDATE writes only its SET.
            const resp = result.analyzed
              ? await db.from('listing_rank_analysis').upsert(
                  { child_asin: childAsin, parent_asin: parentAsin, analyzed_at: analyzedAt, competition_ran: result.competitionRan, credits_spent: result.creditsSpent, content_fingerprint: fingerprint, result, run_lock_at: null },
                  { onConflict: 'child_asin' },
                )
              : await db.from('listing_rank_analysis').update({ run_lock_at: null }).eq('child_asin', childAsin);
            const persistErr = (resp as { error?: unknown })?.error;
            if (persistErr && !isMissingTable(persistErr)) {
              console.warn(`[rank-analysis POST] persist error for ${childAsin}:`, persistErr);
              emit({ type: 'progress', message: 'Analysis complete, but it could not be saved — it will recompute next time.' });
            }
          } catch (persistErr) {
            console.warn(`[rank-analysis POST] persist threw for ${childAsin}:`, persistErr);
            emit({ type: 'progress', message: 'Analysis complete, but it could not be saved — it will recompute next time.' });
          }

          emit({ type: 'result', result });
          controller.close();
        } catch (err) {
          console.error('[rank-analysis POST] council error:', err);
          // Best-effort lock release so a failed run doesn't block a retry for ~90s.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase as any).from('listing_rank_analysis').update({ run_lock_at: null }).eq('child_asin', childAsin);
          } catch { /* ignore */ }
          emit({ type: 'error', error: err instanceof Error ? err.message : 'Unexpected error during rank analysis' });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('[POST /api/fba/rank-analysis/[asin]]', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
