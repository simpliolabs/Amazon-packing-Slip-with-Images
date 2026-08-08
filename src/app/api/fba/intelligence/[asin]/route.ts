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
// KEYWORD_TARGET_SET (#143). `targetSetLive` is computed SERVER-side and sent to the client: the
// browser must never call selectionMode() (a non-NEXT_PUBLIC_ env var reads undefined there, so it
// would always say 'off'), and gating the UI on payload row-shape instead would make a rollback
// need data surgery rather than an env flip.
import { selectionMode, selectionEaseWeight, needsEaseRestamp, resolveRankingTargets, legacyTierBuckets } from '@/lib/keyword-engine/selection-core';
import { loadSelectionContext, readWindow } from '@/lib/keyword-engine/selectionContext';
import { getJungleScoutStatus } from '@/lib/sync/jungleScoutClient';
import { resolveToChildAsin } from '@/lib/fba/resolveAsin';
import { checkPresenceAny } from '@/lib/keyword-engine/checkPresence';
// COHERENCE Invariant 6: at COVERAGE_CORE=on the Present-In tab decides coverage via the SAME shared
// field-agnostic predicate the RANK panel uses, so the two read screens are identical by construction.
import { coverageMode, coverageAcrossRows } from '@/lib/keyword-engine/coverage-core';
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
      // Stored-analysis timestamp (max keyword_analysis.analyzed_at) — hoisted out of the self-heal
      // branch (2026-08-08) and exposed as lastAnalyzedAt so the Re-research auto-chain can wait for
      // research → analysis PROMOTION: researchedAt advancing only proves researchKeywords cached its
      // harvest; the background sync continuation rewrites keyword_analysis tens of seconds later, and
      // chaining a regen in between read the PRE-research pool (the short-backend race). Read the
      // stamp BEFORE the rows (adversarial catch): if storeAnalysis lands between the two reads, the
      // pair errs stale-safe — promoted=false this poll, clean rows+stamp next poll — instead of
      // reporting promoted=true alongside pre-promotion rows.
      let lastAnalyzedAt: string | null = null
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: aRow } = await (supabase as any).from('keyword_analysis')
          .select('analyzed_at').eq('asin', childAsin)
          .order('analyzed_at', { ascending: false }).limit(1).maybeSingle()
        lastAnalyzedAt = (aRow as { analyzed_at?: string } | null)?.analyzed_at ?? null
      } catch { /* best-effort — null just means the auto-chain falls back to its timeout */ }

      // Fast path: return stored analysis without any API calls.
      // readWindow widens to RANKING_CANDIDATE_POOL at `on` ONLY, so all 30 targets are inside
      // the window (§P precondition). At off/shadow it returns 100 unchanged — byte-identical.
      let stored = await getStoredAnalysis(childAsin, readWindow(100));

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
      // NATIVE-METRIC BACKFILL (migration 055, PO 2026-08-08): stored rows written before #520 have
      // market_opportunity NULL on their JS-sourced rows. One cache-HIT engine pass stamps them at 0
      // credits — so ALSO fire the one-shot promotion when the pool is healthy but unstamped
      // (heal-on-read; idempotent: after one pass the JS rows carry the metric and this reads false;
      // SQP/import-only listings have no JS rows to stamp and never match, so no per-load churn).
      const needsNativeBackfill = !!stored && stored.length > 1 &&
        stored.some((k) => (k.dataSource === 'jungle_scout' || k.dataSource === 'inherited') && k.marketOpportunity == null) &&
        !stored.some((k) => k.marketOpportunity != null)
      // EASE-RESTAMP (migration 056, PO 2026-08-08): the stored selection was computed under a
      // DIFFERENT KEYWORD_EASE_WEIGHT than currently configured (ctxSha deliberately excludes the
      // weight — PR #522 — so staleness is detected by the persisted stamp instead). Same one-shot
      // cache-HIT promotion as needsNativeBackfill: 0 JS credits, idempotent — the merge-branch
      // write restamps every row, so this reads false on the next load (stamp equality after one pass).
      //
      // COOLDOWN (adversarial MEDIUM, 2026-08-08): the restamp is the one heal whose CLEARING
      // condition needs the LLM-dependent merge branch — a persistent legacy landing (AI quota
      // outage) would otherwise retry the full SQP-sync + LLM pass on EVERY page load and every 8s
      // auto-chain poll tick. A FAILED attempt's legacy write still advances analyzed_at, so
      // requiring lastAnalyzedAt to be ≥30min old self-throttles the retry (~2/hour) with no new
      // state. Scoped to the ease variant only: the native backfill clears even on the legacy
      // write, and the thin-pool heal is already gated by research-newer + bigger.
      const EASE_RESTAMP_COOLDOWN_MS = 30 * 60 * 1000
      const easeCoolingDown = !!lastAnalyzedAt && Date.now() - new Date(lastAnalyzedAt).getTime() < EASE_RESTAMP_COOLDOWN_MS
      const easeStale = needsEaseRestamp(stored ?? [], selectionEaseWeight(), selectionMode())
      if (easeStale && easeCoolingDown) {
        console.log(`[intelligence] ease-restamp for ${childAsin} deferred — last analysis write < 30min old (cooldown; will retry after it ages)`)
      }
      const needsEase = easeStale && !easeCoolingDown
      if ((!stored || stored.length <= 1 || needsNativeBackfill || needsEase) && researchedAt) {
        try {
          // lastAnalyzedAt hoisted above (2026-08-08) — same value this branch used to query inline.
          const researchNewer = !lastAnalyzedAt || new Date(researchedAt).getTime() > new Date(lastAnalyzedAt).getTime()
          // Promote ONLY when the fresh research pool is BIGGER than what's stored. This single check
          // gives credit safety (a non-zero fresh size ⇒ researchKeywords cache-HITS ⇒ 0 credits; an
          // expired cache reads as 0) AND prevents per-load churn (an empty/≤stored pool can't help,
          // so we don't re-run the engine every load when storeAnalysis won't advance analyzed_at).
          // Backfill variant: pool need only be NON-EMPTY (equal-size is fine — the point is the
          // stamp, not more rows) and the research-newer requirement is waived (analysis is newer by
          // definition; the CACHE being servable is the gate).
          const { freshResearchPoolSize } = await import('@/lib/keyword-engine/keywordResearcher')
          const poolSize = await freshResearchPoolSize(childAsin)
          // Backfill/restamp variants need only a NON-EMPTY servable cache (equal size is fine — the
          // point is the stamp, not more rows); the thin-pool heal keeps its research-newer + bigger gate.
          if ((needsNativeBackfill || needsEase) ? poolSize > 0 : (researchNewer && poolSize > (stored?.length ?? 0))) {
            const reason = needsEase
              ? `ease-restamp stored=${(stored ?? []).find((k) => k.selectionRank != null)?.selectionEaseWeight ?? 0} now=${selectionEaseWeight()}`
              : needsNativeBackfill ? 'native-metric backfill' : 'thin-pool promotion'
            console.log(`[intelligence] self-heal ${childAsin}: stored=${stored?.length ?? 0}, fresh pool=${poolSize} (${reason}) — promoting cached pool (0 credits)`)
            const promoteTitle = (await loadRepresentativeListingRow(supabase, childAsin))?.title || undefined
            await syncKeywordIntelligence(childAsin, {
              forceRefresh: false, includeJungleScout: true, useStoredAnalysis: false,
              parentAsin: parentAsin || undefined, listingTitle: promoteTitle,
            })
            const promoted = await getStoredAnalysis(childAsin, readWindow(100))
            // Backfill/restamp run at EQUAL size — accept the re-read whenever it's no smaller.
            if (promoted && ((needsNativeBackfill || needsEase) ? promoted.length >= (stored?.length ?? 0) : promoted.length > (stored?.length ?? 0))) {
              stored = promoted
              // storeAnalysis just stamped analyzed_at ≥ researchedAt — reflect it so the auto-chain
              // poll (which requires lastAnalyzedAt ≥ researchedAt) doesn't read a pre-promotion value.
              lastAnalyzedAt = new Date().toISOString()
              console.log(`[intelligence] self-heal ${childAsin}: promoted to ${promoted.length} keywords`)
              // LOUD LOOP GUARD (risk R1): if the promotion landed on the LEGACY storeAnalysis branch
              // (ctx null / prior-signal read failure) the stamp did NOT update and this will retry
              // next load — say so instead of silently churning OpenAI spend.
              if (needsEase && needsEaseRestamp(promoted, selectionEaseWeight(), selectionMode())) {
                console.warn(`[intelligence] self-heal ${childAsin}: ease-restamp FAILED (write landed on the legacy branch?) — will retry next load`)
              }
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
      // KEYWORD_TARGET_SET (#143). This was a VERBATIM copy of engine.ts's bucket arithmetic — two
      // copies of one rule, which is how this codebase grew seven disagreeing definitions of
      // "covered". Both now call the single `legacyTierBuckets`, and at `on` the resolver returns
      // the 30 persisted targets instead (falling open to exactly this legacy list on any
      // degenerate verdict).
      //
      // The ctx is loaded, not inert: the rows carry `selection_rank` at `on`, so the persisted
      // branch normally answers without touching ctx — but the recompute fallback on a thin pool
      // MUST see the real designSeasons or it routes the design's own occasion to BACKEND.
      // summary.critical counted the UNCAPPED CRITICAL list, so it is captured BEFORE the buckets
      // are replaced — the tier list changing must not silently change the badge above it.
      const criticalCount = stored.filter(k => k.actionType === 'CRITICAL').length;
      const selCtx = await loadSelectionContext({
        supabase,
        childAsin,
        parentAsin,
        site: 'intelligence.route',
      });
      const topOpportunities = resolveRankingTargets(stored, {
        legacy: legacyTierBuckets,
        site: 'intelligence.route',
        ctx: selCtx,
        inputAsin,
        resolvedAsin: childAsin,
      });

      result = {
        asin: childAsin,
        parentAsin,
        analyzedAt: new Date().toISOString(),
        researchedAt,
        // Max keyword_analysis.analyzed_at — the PROMOTION stamp. The auto-chain must not regen
        // until lastAnalyzedAt ≥ researchedAt (research cached but not yet promoted = mid-window).
        lastAnalyzedAt,
        dataSource: stored[0]?.dataSource ?? 'sqp',
        totalKeywordsAnalyzed: stored.length,
        topOpportunities,
        allKeywords: stored,
        summary: {
          critical: criticalCount,
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
        // Latest CHECK date per keyword (Item 3, PO 2026-08-08): a snapshot row's PRESENCE marks a
        // real Re-research measurement (captureRankSnapshots stores checked-but-not-ranking as a
        // NULL-rank row), so the UI can honestly split "checked <date> — not ranking" from
        // "never measured" instead of one ambiguous em-dash.
        const checkedAt = new Map<string, string>();
        for (const s of snaps as { keyword: string; organic_rank: number | null; snapshot_date?: string }[]) {
          const k = s.keyword.toLowerCase();
          if (!latest.has(k)) { latest.set(k, s.organic_rank); if (s.snapshot_date) checkedAt.set(k, s.snapshot_date); }
          else if (!prev.has(k)) prev.set(k, s.organic_rank);
        }
        const enrich = (rows?: { keyword: string; organicRank?: number | null; prevOrganicRank?: number | null; rankCheckedAt?: string | null }[]) => {
          for (const r of rows ?? []) {
            const k = r.keyword.toLowerCase();
            if (r.organicRank == null && latest.has(k)) r.organicRank = latest.get(k) ?? null;
            if (prev.has(k)) r.prevOrganicRank = prev.get(k) ?? null;
            if (checkedAt.has(k)) r.rankCheckedAt = checkedAt.get(k) ?? null;
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
        const useCore = coverageMode() === 'on';
        const recompute = (rows?: PresenceRow[]) => {
          for (const r of rows ?? []) {
            // OR'd across the ASIN's FBA+FBM twin rows — divergent twins can't shadow each other.
            // At =on, coverageAcrossRows is the SAME predicate the RANK panel uses (identical per-field
            // flags by construction); =off keeps checkPresenceAny byte-identical.
            const p = useCore ? coverageAcrossRows(r.keyword, liveRows) : checkPresenceAny(r.keyword, liveRows);
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
      // KEYWORD_TARGET_SET (#143). THE single switch the Intelligence tab gates every new UI branch
      // on. Server-computed for two reasons, both load-bearing:
      //   1. selectionMode() reads a non-NEXT_PUBLIC_ env var, so in the browser it is ALWAYS 'off'
      //      (commit 8581e63: a build-time-inlined flag read ON in the UI while being dead-code-
      //      eliminated from the bundle). The client cannot answer this question for itself.
      //   2. Gating on payload row-shape instead (\"does this row have selectionRank?\") would keep
      //      the new UI alive after a rollback, because the COLUMNS survive an env flip by design.
      //      A boolean the server recomputes each request makes rollback env+restart with no data
      //      surgery — which is the entire shadow/on contract.
      targetSetLive: selectionMode() === 'on',
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
