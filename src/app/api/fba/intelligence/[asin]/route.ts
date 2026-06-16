/**
 * GET  /api/fba/intelligence/[asin]
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns keyword intelligence for an ASIN.
 * Accepts both parent and child ASINs — parent ASINs are resolved to
 * their top child ASIN automatically.
 *
 * Query params:
 *   ?refresh=true   — Force a fresh SQP fetch (ignores cache)
 *   ?stored=true    — Return stored analysis only (fastest, no API calls)
 *
 * Response shape:
 * {
 *   asin: string,            // resolved child ASIN
 *   parentAsin?: string,     // original parent ASIN (if resolved)
 *   analyzedAt: string,
 *   dataSource: 'sqp' | 'jungle_scout' | 'inherited',
 *   totalKeywordsAnalyzed: number,
 *   summary: { critical, upgrade, reinforce, defended, optimized },
 *   topOpportunities: AnalyzedKeyword[],
 *   apiUsage: { used, limit, remaining, provider },
 *   jungleScoutEnabled: boolean,
 * }
 *
 * POST /api/fba/intelligence/[asin]
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggers a fresh keyword sync for the ASIN.
 * Returns immediately with { status: 'syncing' } — sync runs in background.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { syncKeywordIntelligence } from '@/lib/sync/syncKeywordIntelligence';
import { getApiUsageStats, getStoredAnalysis } from '@/lib/keyword-engine';
import { getJungleScoutStatus } from '@/lib/sync/jungleScoutClient';
import { resolveToChildAsin } from '@/lib/fba/resolveAsin';
import { checkPresenceAny } from '@/lib/keyword-engine/checkPresence';
import { loadListingRowsForPresence, loadRepresentativeListingRow } from '@/lib/keyword-engine/loadListingContent';

// resolveToChildAsin extracted to @/lib/fba/resolveAsin (shared with the rank-analysis route, no fork).

// ── GET ───────────────────────────────────────────────────────────────────────

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

    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const storedOnly = searchParams.get('stored') === 'true';
    // Niche enrichment (PO 2026-06-14): ADD the missing design-niche keyword universe(s) to the
    // already-researched pool (cheap — keyword queries only, ≤2 credits, storage-first), then
    // re-process so they surface in Intelligence. Auto-detected from the vision design theme.
    const enrichNiche = searchParams.get('enrich') === 'niche';

    // Resolve parent → child ASIN
    const resolved = await resolveToChildAsin(inputAsin, supabase);

    if (!resolved) {
      return NextResponse.json(
        { error: `ASIN ${inputAsin} not found in catalog. Run a listing sync first.` },
        { status: 404 }
      );
    }

    const { childAsin, parentAsin } = resolved;

    let result;

    if (storedOnly) {
      // Fast path: return stored analysis without any API calls.
      let stored = await getStoredAnalysis(childAsin, 100);

      // Real research timestamp (keyword_cache.fetched_at) — drives the self-heal below AND lets the
      // UI detect when a background re-research completed (auto-chain). analyzedAt is the RESPONSE
      // time, not the research time.
      let researchedAt: string | null = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: cr } = await (supabase as any).from('keyword_cache')
          .select('fetched_at').eq('asin', childAsin).eq('source', 'keyword_research').maybeSingle()
        researchedAt = (cr as { fetched_at?: string } | null)?.fetched_at ?? null
      } catch { /* best-effort — null just disables self-heal + completion detection */ }

      // SELF-HEAL PROMOTION (PO 2026-06-15): the page reads keyword_analysis (this stored path), but
      // the rich JS research pool lives in keyword_cache and is only promoted by a NON-stored run —
      // which page-load never triggers — so the page showed 1 SQP keyword while a full pool sat
      // unpromoted (root cause of "Intelligence returned only 1 keyword"). If a NEWER research pool
      // exists than the stored analysis AND the stored analysis is thin (<=1 kw → never promoted),
      // run a ONE-SHOT promotion: useStoredAnalysis:false bypasses the Path-1 short-circuit;
      // forceRefresh:false cache-HITS the research → 0 Jungle Scout credits; the relevance gate (with
      // never-collapse floor) still applies. storeAnalysis stamps analyzed_at > researchedAt, so this
      // is idempotent — it won't re-fire on the next load (no per-load engine churn, no loop).
      if ((!stored || stored.length <= 1) && researchedAt) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: aRow } = await (supabase as any).from('keyword_analysis')
            .select('analyzed_at').eq('asin', childAsin)
            .order('analyzed_at', { ascending: false }).limit(1).maybeSingle()
          const lastAnalyzedAt = (aRow as { analyzed_at?: string } | null)?.analyzed_at ?? null
          const researchNewer = !lastAnalyzedAt || new Date(researchedAt).getTime() > new Date(lastAnalyzedAt).getTime()
          // Promote ONLY when the fresh research pool is BIGGER than what's stored. This single check
          // gives credit safety (a non-zero fresh size ⇒ researchKeywords cache-HITS ⇒ 0 credits; an
          // expired cache reads as 0) AND prevents per-load churn (an empty/≤stored pool can't help,
          // so we don't re-run the engine every load when storeAnalysis won't advance analyzed_at).
          const { freshResearchPoolSize } = await import('@/lib/keyword-engine/keywordResearcher')
          const poolSize = await freshResearchPoolSize(childAsin)
          if (researchNewer && poolSize > (stored?.length ?? 0)) {
            console.log(`[intelligence] self-heal ${childAsin}: stored=${stored?.length ?? 0}, fresh pool=${poolSize} (newer than analysis ${lastAnalyzedAt}) — promoting cached pool (0 credits)`)
            const promoteTitle = (await loadRepresentativeListingRow(supabase, childAsin))?.title || undefined
            await syncKeywordIntelligence(childAsin, {
              forceRefresh: false, includeJungleScout: true, useStoredAnalysis: false,
              parentAsin: parentAsin || undefined, listingTitle: promoteTitle,
            })
            const promoted = await getStoredAnalysis(childAsin, 100)
            if (promoted && promoted.length > (stored?.length ?? 0)) {
              stored = promoted
              console.log(`[intelligence] self-heal ${childAsin}: promoted to ${promoted.length} keywords`)
            }
          } else if (researchNewer) {
            console.log(`[intelligence] self-heal ${childAsin}: fresh pool=${poolSize} not larger than stored=${stored?.length ?? 0} — skipping (no gain; cache expired reads as 0 → no credit spend)`)
          }
        } catch (e) { console.warn('[intelligence] self-heal promotion failed (non-fatal):', e instanceof Error ? e.message : e) }
      }

      if (!stored || stored.length === 0) {
        return NextResponse.json(
          {
            asin: childAsin,
            parentAsin,
            analyzedAt: null,
            dataSource: null,
            totalKeywordsAnalyzed: 0,
            summary: { critical: 0, upgrade: 0, reinforce: 0, defended: 0, optimized: 0 },
            topOpportunities: [],
            message: 'No analysis available yet. Trigger a sync to generate keyword intelligence.',
          },
          { status: 200 }
        );
      }
      // Group by category and apply dynamic cap:
      // CRITICAL: 5-10 (show all scoring ≥50, min 5, max 10)
      // UPGRADE/REINFORCE/DEFENDED: top 10 each
      const criticalAll = stored.filter(k => k.actionType === 'CRITICAL')
        .sort((a, b) => b.opportunityScore - a.opportunityScore);
      const criticalCapped = criticalAll.length <= 5
        ? criticalAll
        : criticalAll.filter(k => k.opportunityScore >= 50).slice(0, 10).length >= 5
          ? criticalAll.filter(k => k.opportunityScore >= 50).slice(0, 10)
          : criticalAll.slice(0, 5);

      const upgradeTop = stored.filter(k => k.actionType === 'UPGRADE')
        .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
      const reinforceTop = stored.filter(k => k.actionType === 'REINFORCE')
        .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
      const defendedTop = stored.filter(k => k.actionType === 'DEFENDED')
        .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);

      result = {
        asin: childAsin,
        parentAsin,
        analyzedAt: new Date().toISOString(),
        researchedAt,
        dataSource: stored[0]?.dataSource ?? 'sqp',
        totalKeywordsAnalyzed: stored.length,
        topOpportunities: [...criticalCapped, ...upgradeTop, ...reinforceTop, ...defendedTop],
        allKeywords: stored,
        summary: {
          critical: criticalAll.length,
          upgrade: stored.filter(k => k.actionType === 'UPGRADE').length,
          reinforce: stored.filter(k => k.actionType === 'REINFORCE').length,
          defended: stored.filter(k => k.actionType === 'DEFENDED').length,
          optimized: stored.filter(k => k.actionType === 'OPTIMIZED').length,
        },
      };
    } else {
      // Get competitor ASIN for reverse lookup fallback
      const { data: scoreData } = await supabase
        .from('listing_seo_scores')
        .select('competitor_asin')
        .eq('parent_asin', parentAsin || inputAsin)
        .single();
      const competitorAsin = (scoreData as { competitor_asin?: string } | null)?.competitor_asin || undefined;

      // Fetch listing title for seed fallback (needed when no vision identity exists).
      // Twin-safe: .single() errors when the ASIN has FBA+FBM rows. Representative row, NOT
      // the presence union — a seed must be ONE title, not two concatenated.
      const listingTitle = (await loadRepresentativeListingRow(supabase, childAsin))?.title || undefined;

      // Niche enrichment runs FIRST (adds missing design-niche universes to the cached pool),
      // then the sync below re-processes the enriched pool (forceRefresh:false so it cache-hits
      // — no extra full research — and useStoredAnalysis:false so the engine re-runs on the new
      // keywords). Best-effort: a derivation/JS error leaves the pool unchanged, never breaks GET.
      let nicheEnrich: Awaited<ReturnType<typeof import('@/lib/keyword-engine/keywordResearcher').enrichResearchWithNiche>> | null = null;
      if (enrichNiche) {
        try {
          const { enrichResearchWithNiche } = await import('@/lib/keyword-engine/keywordResearcher');
          // Pass parentAsin: vision identity is stored under the parent, so the child-only read missed it.
          nicheEnrich = await enrichResearchWithNiche(childAsin, parentAsin || undefined);
          console.log(`[intelligence] niche enrich for ${childAsin}: ${nicheEnrich.note} (${nicheEnrich.creditsUsed} credits)`);
        } catch (e) {
          console.warn('[intelligence] niche enrich failed (non-fatal):', e instanceof Error ? e.message : e);
        }
      }

      // Full sync path — use resolved child ASIN
      result = await syncKeywordIntelligence(childAsin, {
        forceRefresh: enrichNiche ? false : forceRefresh,
        includeJungleScout: true,
        useStoredAnalysis: enrichNiche ? false : !forceRefresh,
        competitorAsin,
        parentAsin: parentAsin || undefined,
        listingTitle,
      });

      // Attach parent ASIN to result
      if (parentAsin) {
        result = { ...result, parentAsin };
      }
      if (nicheEnrich) {
        result = { ...result, nicheEnrich };
      }
    }

    // ── Rank-tracker trend enrichment: attach the PREVIOUS snapshot's organic rank per keyword
    // so the table can show movement (12 ▲ was 18). One bounded query; best-effort — a missing
    // table (migration 026 not applied) or any error leaves rows un-enriched, never breaks GET.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any; // keyword_rank_snapshots not in generated types yet (migration 026)
      const { data: snaps } = await db
        .from('keyword_rank_snapshots')
        .select('keyword, organic_rank, snapshot_date')
        .eq('asin', childAsin)
        .order('snapshot_date', { ascending: false })
        .limit(400);
      if (Array.isArray(snaps) && snaps.length > 0) {
        // First row per keyword = latest snapshot, second = previous.
        const latest = new Map<string, number | null>();
        const prev = new Map<string, number | null>();
        for (const s of snaps as { keyword: string; organic_rank: number | null }[]) {
          const k = s.keyword.toLowerCase();
          if (!latest.has(k)) latest.set(k, s.organic_rank);
          else if (!prev.has(k)) prev.set(k, s.organic_rank);
        }
        const enrich = (rows?: { keyword: string; organicRank?: number | null; prevOrganicRank?: number | null }[]) => {
          for (const r of rows ?? []) {
            const k = r.keyword.toLowerCase();
            if (r.organicRank == null && latest.has(k)) r.organicRank = latest.get(k) ?? null;
            if (prev.has(k)) r.prevOrganicRank = prev.get(k) ?? null;
          }
        };
        enrich((result as { topOpportunities?: { keyword: string }[] }).topOpportunities);
        enrich((result as { allKeywords?: { keyword: string }[] }).allKeywords);
      }
    } catch (e) {
      console.warn('[intelligence GET] rank-trend enrichment skipped (non-fatal):', e instanceof Error ? e.message : e);
    }

    // ── LIVE Present-In: stored inTitle/inBullets/… flags freeze at research time — and the
    // .single() twin bug used to compute them against {} (every keyword "nowhere" while the
    // live title literally contained the phrase — B0FK8NM9RT). Recompute against CURRENT
    // content on every read so the Present-In column always matches what's live, agreeing
    // with the rank panel by construction. Action chips/scores intentionally stay from the
    // research run (they price the opportunity at research time). Best-effort: a missing
    // content row leaves stored flags untouched.
    try {
      const liveRows = await loadListingRowsForPresence(supabase, childAsin);
      if (liveRows.length > 0) {
        type PresenceRow = { keyword: string; inTitle?: boolean; inBullets?: boolean; inDescription?: boolean; inBackend?: boolean };
        const recompute = (rows?: PresenceRow[]) => {
          for (const r of rows ?? []) {
            // OR'd across the ASIN's FBA+FBM twin rows — divergent twins can't shadow each other.
            const p = checkPresenceAny(r.keyword, liveRows);
            r.inTitle = p.inTitle;
            r.inBullets = p.inBullets;
            r.inDescription = p.inDescription;
            r.inBackend = p.inBackend;
          }
        };
        recompute((result as { topOpportunities?: PresenceRow[] }).topOpportunities);
        recompute((result as { allKeywords?: PresenceRow[] }).allKeywords);
      }
    } catch (e) {
      console.warn('[intelligence GET] live presence recompute skipped (non-fatal):', e instanceof Error ? e.message : e);
    }

    // Get API usage stats for the UI meter
    const rawUsage = await getApiUsageStats();
    const jsStatus = await getJungleScoutStatus();
    // Normalize to the shape page.tsx ApiUsageStats expects: { used, limit, remaining, provider }
    const apiUsage = {
      used: rawUsage.jungleScout.callsUsed,
      limit: rawUsage.jungleScout.budget,
      remaining: rawUsage.jungleScout.budget - rawUsage.jungleScout.callsUsed,
      provider: 'Jungle Scout',
      planLimit: rawUsage.jungleScout.planLimit,
      warningLevel: rawUsage.jungleScout.warningLevel,
      warningMessage: rawUsage.jungleScout.warningMessage,
    };

    return NextResponse.json({
      ...result,
      apiUsage,
      jungleScoutEnabled: jsStatus.enabled,
      jungleScoutMessage: jsStatus.message,
    });

  } catch (error) {
    console.error('[GET /api/fba/intelligence/[asin]]', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

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

    // Resolve parent → child ASIN
    const resolved = await resolveToChildAsin(inputAsin, supabase);

    if (!resolved) {
      return NextResponse.json(
        { error: `ASIN ${inputAsin} not found in catalog. Run a listing sync first.` },
        { status: 404 }
      );
    }

    const { childAsin } = resolved;

    // Get competitor ASIN for reverse lookup fallback
    const { data: scoreData } = await supabase
      .from('listing_seo_scores')
      .select('competitor_asin')
      .eq('parent_asin', inputAsin)
      .single();
    const competitorAsin = (scoreData as { competitor_asin?: string } | null)?.competitor_asin || undefined;

    // Fetch listing title for seed fallback (twin-safe; representative row — a seed must be ONE title)
    const listingTitle = (await loadRepresentativeListingRow(supabase, childAsin))?.title || undefined;

    // Optional seller-typed research seed (Intelligence tab "Re-research" box). Tolerant parse —
    // the POST historically has no body, so absence must not break the existing trigger.
    let manualSeed: string | undefined;
    try {
      const body = (await request.json()) as { seed?: string } | null;
      const s = (body?.seed ?? '').trim();
      if (s) manualSeed = s.slice(0, 80);
    } catch { /* no body — legacy trigger */ }

    // Fire and forget — run sync in background using resolved child ASIN
    syncKeywordIntelligence(childAsin, {
      forceRefresh: true,
      manualSeed,
      competitorAsin,
      parentAsin: inputAsin,
      listingTitle,
    }).catch(err => {
      console.error(`[POST /api/fba/intelligence/${inputAsin}] Background sync error (child: ${childAsin}):`, err);
    });

    return NextResponse.json({
      status: 'syncing',
      asin: childAsin,
      inputAsin,
      message: `Keyword intelligence sync started for ${childAsin}${inputAsin !== childAsin ? ` (resolved from parent ${inputAsin})` : ''}. SQP report takes 5–8 minutes to process. The panel will auto-update when ready.`,
    });

  } catch (error) {
    console.error('[POST /api/fba/intelligence/[asin]]', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
