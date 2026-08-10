/**
 * syncKeywordIntelligence.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrator for keyword intelligence sync.
 *
 * V2 Pipeline:
 *   1. Check stored analysis (fast path)
 *   2. Run SQP sync (if available)
 *   3. Run researchKeywords() — the new 3-credit pipeline:
 *      Vision Scan → 1 seed → keywords_by_keyword → share_of_voice → competitor ASIN → 3 buckets
 *   4. Merge SQP + JS results → store analysis
 *
 * Called by:
 *   1. /api/fba/intelligence/[asin] (on-demand)
 *   2. /api/fba/listing-optimizer/ai-recommendations (auto-sync)
 *   3. Scheduled sync job (monthly refresh)
 *
 * Karpathy principle: Surgical change. Replaced the old multi-step fallback
 * logic with a single call to researchKeywords() which handles everything.
 */

import { syncKeywordData } from './syncKeywordData';
import { inheritJsMeasurements } from './mergeInherit';
import { getJungleScoutStatus } from './jungleScoutClient';
import {
  getCachedKeywords,
  getStoredAnalysis,
  runKeywordEngine,
  storeAnalysis,
  EngineResult,
} from '../keyword-engine';
import { captureRankSnapshots } from '../keyword-engine/cacheService';
import { researchKeywords, getCachedResearch } from '../keyword-engine/keywordResearcher';
import { loadListingRowsForPresence } from '../keyword-engine/loadListingContent';
import { isOffNicheKeyword, isForeignKeyword } from '../keyword-engine/nicheGuards';
import { classifyOffNicheKeywords } from '../keyword-engine/relevanceClassifier';
// KEYWORD_TARGET_SET (#143). selectionMode is a CALL-TIME env read, so a Coolify flip + restart
// changes behaviour with no rebuild. loadSelectionContext short-circuits to zero queries at `off`.
import { selectionMode, resolveRankingTargets, type SelectionContext } from '../keyword-engine/selection-core';
import { loadSelectionContextWithSources, readWindow } from '../keyword-engine/selectionContext';
import { buildThemeCard, rateThemeFit, newThemeRunId } from '../keyword-engine/themeRater';
import type { ThemeRatings } from '../keyword-engine/cacheService';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Invalidate this listing's keyword universe so the NEXT regen re-researches from scratch.
 *
 * Called when the seller changes a reference SIGNAL that seeds research — the Design Name (which
 * selectSeeds already feeds to the Seed Agent) or the Competitor ASIN (force-harvested in Phase 4).
 * Without this, the empty-only auto-sync gate in the recs route never re-seeds once a (signal-less)
 * universe exists, so the newly-entered design/competitor is silently ignored (the B0DMXMH266
 * fishing regression). We clear ONLY keyword_analysis (the per-listing derived universe) — never the
 * cross-listing keyword_seed_pool or the raw keyword_cache, so siblings are untouched and a rebuild
 * costs 0 fresh JS credits when the raw pull is still warm. Deleting only the derived analysis means
 * the next recs run's `if (analysis empty)` gate fires → fresh research with the new signal.
 */
export async function invalidateKeywordUniverse(parentAsin: string): Promise<void> {
  const asins = new Set<string>();
  try {
    const { data: score } = await supabase
      .from('listing_seo_scores').select('top_child_asin').eq('parent_asin', parentAsin).single();
    const rep = (score as { top_child_asin?: string | null } | null)?.top_child_asin;
    if (rep) asins.add(rep);
    const { data: kids } = await supabase
      .from('listing_content').select('asin').eq('parent_asin', parentAsin);
    for (const k of (kids ?? []) as { asin: string | null }[]) if (k.asin) asins.add(k.asin);
    if (asins.size === 0) { asins.add(parentAsin); }
    await supabase.from('keyword_analysis').delete().in('asin', [...asins]);
    console.log(`[invalidateKeywordUniverse] Cleared keyword_analysis for ${asins.size} asin(s) of ${parentAsin} — reference signal changed → next regen re-researches.`);
  } catch (e) {
    console.warn(`[invalidateKeywordUniverse] Non-fatal: could not clear universe for ${parentAsin}:`, e instanceof Error ? e.message : e);
  }
}

export interface IntelligenceOptions {
  /** Force a fresh fetch even if cache is valid */
  forceRefresh?: boolean;
  /** Include Jungle Scout competitor data if available */
  includeJungleScout?: boolean;
  /** Return stored analysis if available (fastest path) */
  useStoredAnalysis?: boolean;
  /** Competitor ASIN (legacy — now auto-detected via SOV) */
  competitorAsin?: string;
  /** Parent ASIN (needed for competitor storage) */
  parentAsin?: string;
  /** Listing title (fallback seed for keyword research) */
  listingTitle?: string;
  /** Seller-typed seed for the research pipeline (Intelligence tab "Re-research" box) — beats
   *  every derived seed. Costs 3 JS credits per run like any fresh research. */
  manualSeed?: string;
}

/**
 * Main entry point for keyword intelligence.
 *
 * Priority order:
 *   1. Stored analysis (DB) — if fresh and useStoredAnalysis=true
 *   2. Cached raw data (keyword_cache) → re-run engine
 *   3. Fresh SQP fetch → engine → store
 *   4. researchKeywords() (if JS enabled) → 3-bucket pipeline → merge
 */
export async function syncKeywordIntelligence(
  asin: string,
  options: IntelligenceOptions = {}
): Promise<EngineResult> {
  const {
    forceRefresh = false,
    includeJungleScout = true,
    useStoredAnalysis = true,
    parentAsin,
    listingTitle,
    manualSeed,
  } = options;

  // Path 1: Return stored analysis if available and not forcing refresh
  if (useStoredAnalysis && !forceRefresh) {
    const stored = await getStoredAnalysis(asin, readWindow(100));
    if (stored && stored.length > 0) {
      return buildResultFromStored(asin, stored);
    }
  }

  // On forceRefresh: clear only the ANALYSIS cache (keyword_analysis) so the engine re-runs.
  // Do NOT delete keyword_cache — that holds the raw JS API data which costs credits to re-fetch.
  if (forceRefresh) {
    // KEYWORD_TARGET_SET (#143, PO Q1 → gated, not unconditional). This delete is REDUNDANT with
    // storeAnalysis's stale-prune (which drops native rows older than the run timestamp) and is
    // strictly more destructive than it: the prune preserves `data_source='import'` rows — the
    // seller's H10 competitor research (PR #176) — while this wipes them too.
    //
    // It is also a live pool-emptying hazard of exactly the 2026-06-17 shape: research runs for
    // minutes between this DELETE and the eventual store, and a failure anywhere in between leaves
    // keyword_analysis EMPTY rather than stale. Upsert-first + prune-after is interrupt-safe.
    //
    // Gated on `!== 'off'` rather than removed outright: dropping it changes what `off` persists on
    // a forced re-research, and the off-parity contract is not worth breaking mid-flip for a bug
    // that only bites on failure. Revisit as unconditional once the flag is fully rolled out.
    if (selectionMode() === 'off') {
      await supabase.from('keyword_analysis').delete().eq('asin', asin);
      console.log(`[syncKeywordIntelligence] Cleared analysis cache for ${asin} (forceRefresh). Raw keyword_cache preserved.`);
    } else {
      console.log(`[syncKeywordIntelligence] forceRefresh for ${asin}: pre-research DELETE skipped (KEYWORD_TARGET_SET) — storeAnalysis's stale-prune handles it and imports survive.`);
    }
  }

  // Path 2 & 3: Run SQP sync (handles cache check internally)
  const sqpResult = await syncKeywordData(asin);

  // Path 4: Augment with Jungle Scout research pipeline
  const jsStatus = await getJungleScoutStatus();
  if (includeJungleScout && jsStatus.enabled) {
    try {
      // Parent for the relevance gate (used by BOTH the cache-hit and fresh-research paths below).
      const resolvedParent = (parentAsin || await getParentAsin(asin)) || asin;
      // Check if we already have fresh JS data cached (avoid burning credits)
      const rawCached = await getCachedKeywords(asin, 'jungle_scout');
      const cachedAge = rawCached ? await getKeywordCacheAge(asin, 'jungle_scout') : Infinity;
      const JS_REFRESH_TTL_HOURS = 24;

      if (rawCached && cachedAge < JS_REFRESH_TTL_HOURS && !forceRefresh) {
        console.log(`[syncKeywordIntelligence] JS cache HIT for ${asin} (${Math.round(cachedAge)}h old). Skipping JS API call.`);
        // Re-run engine on cached data to get fresh presence analysis.
        // NOT .single(): an ASIN has FBA+FBM twin rows and .single() errors on 2+ matches,
        // which silently fed {} to the engine → every keyword flagged "nowhere" (B0FK8NM9RT).
        // ALL twin rows are passed — presence is OR'd per row (divergent twins can't shadow).
        const listingRows = await loadListingRowsForPresence(supabase, asin);

        // Source the ENRICHED research pool (keyword_research cache) when present — it carries the
        // #270 seed-pool niche merge + #280 universes (tagged fromUniverse), which the raw per-ASIN
        // 'jungle_scout' pull never saw. getCachedResearch is a pure DB read (0 JS credits). Without
        // this, a steady-state reload re-stored only the raw pull and silently dropped the universes
        // from keyword_analysis until the next forced research — the cache-hit half of the #283 miss.
        // Falls back to the raw pull when no research cache exists yet.
        const research = await getCachedResearch(asin);
        const poolRows = (research && research.allKeywords.length > 0)
          ? research.allKeywords
          : (rawCached as import('../keyword-engine').JungleScoutKeywordRow[]);

        // Gate BEFORE the engine on the raw JS rows — same ordering as the fresh-research path below,
        // so the two can't drift (this branch used to gate post-engine, which dropped the fromUniverse
        // flag: the other half of the #283 miss). Raw JS rows carry .keyword + fromUniverse, so the
        // gate's universe exemption + never-collapse floor both apply.
        const gated = await applyRelevanceGate(asin, resolvedParent, poolRows, listingRows, listingTitle);
        const jsResult = runKeywordEngine(asin, gated.keywords as import('../keyword-engine').RawKeywordRow[], listingRows, 'jungle_scout');
        const mergedKeywords = mergeKeywordResults(sqpResult.allKeywords, jsResult.allKeywords);
        // The gate's ctx/ratings ride along to the ONE place selection is computed. ctx null ⇒
        // legacy 15-column write (see StoreAnalysisOpts.ctx).
        // measuredRanks: this pool is the JS research harvest (served from cache), whose ranks were
        // MEASURED by Phase 4b at the original fetch — rank absence genuinely means "not ranking".
        await storeAnalysis(asin, mergedKeywords, { ctx: gated.ctx, ratings: gated.ratings, themeRunId: gated.themeRunId, measuredRanks: true });

        return {
          ...sqpResult,
          allKeywords: mergedKeywords,
          // These rows are FRESH from the engine and carry no selection_rank, so the resolver always
          // RECOMPUTES here — which makes ctx load-bearing rather than a formality. With no context
          // there is no honest recompute (an inert ctx would route the design's OWN season to
          // BACKEND), so fall to the legacy list instead of guessing.
          topOpportunities: gated.ctx
            ? resolveRankingTargets(mergedKeywords, {
                legacy: (r) => r.slice(0, 25),
                site: 'syncKeywordIntelligence.cacheHit',
                ctx: gated.ctx,
                inputAsin: asin,
              })
            : mergedKeywords.slice(0, 25),
          totalKeywordsAnalyzed: mergedKeywords.length,
          summary: buildSummary(mergedKeywords),
          dataSource: 'jungle_scout',
        };
      }

      // No fresh cache — run the full 3-credit research pipeline (resolvedParent computed above).
      // CATEGORY seed from the live SP-API productType (NON-apparel only) — the seed-quality fix:
      // a vision/title seed is PRODUCT-LITERAL ("post it notes variety pack"), so the niche query
      // returns our own phrasing and Share-of-Voice crowns whoever wins that narrow phrase — never
      // the category winner. SELF_STICK_NOTE → "self stick notes" finds the Mr.-Pen-class niche.
      // Apparel keeps vision/title seeds (design-led niches). Best-effort: any failure → undefined.
      let categorySeed: string | undefined;
      // Hoisted (2026-07-21): the live SP-API productType is resolved here anyway for the category
      // seed — pass it to researchKeywords too so the shared garment-noun resolver (GARMENT_NOUN
      // flag) can seed a HAT as a hat instead of a t-shirt. Apparel keeps vision/title seeds
      // (categorySeed stays undefined for apparel), but productType is threaded for ALL types.
      let resolvedProductType: string | undefined;
      try {
        const { getProductType } = await import('../amazon/productType');
        const { getAccessToken } = await import('../amazon/auth');
        const { APPAREL_PRODUCT_TYPES } = await import('../fba/listingPipeline');
        const { data: skuRow } = await supabase
          .from('listing_content').select('sku').eq('asin', asin).maybeSingle();
        const sku = (skuRow as { sku?: string } | null)?.sku;
        if (sku) {
          const { data: sellerRow } = await supabase
            .from('app_settings').select('value').eq('key', 'amazon_seller_id').maybeSingle();
          const sellerId = (sellerRow as { value?: string } | null)?.value
            || process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID;
          if (sellerId) {
            const pt = await getProductType(sellerId, await getAccessToken(), sku);
            resolvedProductType = pt || undefined;
            if (pt && pt !== 'PRODUCT' && !APPAREL_PRODUCT_TYPES.test(pt.toUpperCase())) {
              const words = pt.toLowerCase().split('_');
              // Naive pluralize the head noun ("self stick note" → "self stick notes") — matches
              // how shoppers type category queries.
              if (!/s$/.test(words[words.length - 1])) words[words.length - 1] += 's';
              categorySeed = words.join(' ');
              console.log(`[syncKeywordIntelligence] category seed from productType ${pt}: "${categorySeed}"`);
            }
          }
        }
      } catch (e) {
        console.warn('[syncKeywordIntelligence] category-seed resolution failed (non-fatal):', e instanceof Error ? e.message : e);
      }
      const researchResult = await researchKeywords(asin, resolvedParent || asin, {
        forceRefresh,
        listingTitle,
        manualSeed,
        categorySeed,
        productType: resolvedProductType,
      });

      // Instrument the research pool size so an empty/thin pool is VISIBLE in prod logs — the
      // disambiguation the diagnosis flagged: "gate stripped to zero" vs "research returned nothing".
      console.log(`[syncKeywordIntelligence] research pool for ${asin}: ${researchResult.allKeywords.length} kw (seed source: ${researchResult.source})`);
      if (researchResult.allKeywords.length > 0) {
        // Fetch listing content for presence check (twin-safe; all rows, OR'd per row)
        const listingRows = await loadListingRowsForPresence(supabase, asin);

        // Relevance gate + never-collapse floor (shared helper, applied identically to the cache-hit
        // path above so the two can't drift; gates BEFORE the engine + storage).
        const gatedFresh = await applyRelevanceGate(asin, resolvedParent, researchResult.allKeywords, listingRows, listingTitle);
        const filteredKeywords = gatedFresh.keywords;

        // Run engine on research results (against OUR listing content)
        const jsResult = runKeywordEngine(asin, filteredKeywords, listingRows, 'jungle_scout');

        // Merge JS results into SQP results (SQP takes precedence for same keywords)
        const mergedKeywords = mergeKeywordResults(sqpResult.allKeywords, jsResult.allKeywords);
        // measuredRanks: Phase 4b just measured OUR ranks on this fresh research — nulls are honest.
        await storeAnalysis(asin, mergedKeywords, { ctx: gatedFresh.ctx, ratings: gatedFresh.ratings, themeRunId: gatedFresh.themeRunId, measuredRanks: true });

        // Rank tracker (PO: "track OUR ranking keywords over time"): snapshot our organic rank
        // per keyword from this FRESH Jungle Scout measurement. The cache-hit path deliberately
        // does NOT capture — its ranks were measured (and snapshotted) at the original fetch.
        // Same rule when researchKeywords itself served its 14-day cache VERBATIM (adversarial
        // MEDIUM, 2026-08-08 — the >24h-raw-cache promotion path, e.g. every ease-restamp/weight
        // flip): stamping snapshot_date=TODAY over ranks measured up to 14 days ago would corrupt
        // the rank time-series and fake the "Checked <date>" tooltip's measurement claim.
        if (researchResult.servedFromCache) {
          console.log(`[syncKeywordIntelligence] research for ${asin} served from cache — skipping rank-snapshot capture (ranks were measured & snapshotted at the original fetch)`);
        } else {
          await captureRankSnapshots(asin, researchResult.allKeywords.map((k) => ({
            keyword: k.keyword, organicRank: k.organicRank ?? null, searchVolume: k.searchVolume ?? null,
          })));
        }

        console.log(`[syncKeywordIntelligence] Research pipeline complete for ${asin}: ${researchResult.allKeywords.length} keywords, ${researchResult.creditsUsed} credits, competitor: ${researchResult.competitor?.asin || 'none'}`);

        return {
          ...sqpResult,
          allKeywords: mergedKeywords,
          // These rows are FRESH from the engine and carry no selection_rank, so the resolver always
          // RECOMPUTES here — which makes ctx load-bearing rather than a formality. With no context
          // there is no honest recompute (an inert ctx would route the design's OWN season to
          // BACKEND), so fall to the legacy list instead of guessing.
          topOpportunities: gatedFresh.ctx
            ? resolveRankingTargets(mergedKeywords, {
                legacy: (r) => r.slice(0, 25),
                site: 'syncKeywordIntelligence.research',
                ctx: gatedFresh.ctx,
                inputAsin: asin,
              })
            : mergedKeywords.slice(0, 25),
          totalKeywordsAnalyzed: mergedKeywords.length,
          summary: buildSummary(mergedKeywords),
          dataSource: 'jungle_scout',
        };
      }
    } catch (err) {
      console.error(`[syncKeywordIntelligence] Research pipeline failed for ${asin}:`, err);
      // Don't fail — return SQP result
    }
  }

  return sqpResult;
}

/**
 * POOL-ENTRY RELEVANCE GATE (PO 2026-06-15 anti-pollution: stop soccer listings pulling in
 * family/graduation keywords). Filters the JS pool against the listing's OWN identity tokens.
 *
 * Applied wherever the JS pool is stored — BOTH the fresh-research and the cache-hit paths — so the
 * two can never drift (previously only the fresh path gated; a cache-hit re-run re-stored ungated).
 *
 * NEVER-COLLAPSE FLOOR (PO sign-off 2026-06-15): if the gate would drop the ENTIRE pool — an
 * over-narrow / sparse identity, e.g. a short slogan design like "my therapist gave up" — keep the
 * pool UNFILTERED and warn. The gate is anti-pollution INSURANCE, not a hard zero; collapsing a pool
 * to nothing is what starved Intelligence + the description-coverage dock. ALWAYS logs kept/before
 * (even when nothing dropped) so the gate's real effect on a listing is visible in prod logs.
 */
/**
 * What the gate returns. `ctx: null` is the load-bearing signal — see StoreAnalysisOpts.ctx: it
 * tells storeAnalysis "no context was established, write the legacy payload", which is strictly
 * different from an INERT context (that would persist a target set computed against
 * `designSeasons: []` and route a Valentine design's own keywords to BACKEND as if that were truth).
 */
interface RelevanceGateResult<T> {
  keywords: T[];
  ctx: SelectionContext | null;
  ratings: ThemeRatings | null;
  themeRunId: string | null;
}

async function applyRelevanceGate<T extends { keyword: string }>(
  asin: string,
  resolvedParent: string,
  keywords: T[],
  listingRows: { title?: string | null }[] | null,
  listingTitle?: string,
): Promise<RelevanceGateResult<T>> {
  try {
    const { identityTokensOf, keywordIsRelevant, guaranteedIdentitySynonyms } = await import('../keyword-engine/keywordResearcher');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;
    // THE DEAD WIRE (fixed 2026-08-09). `design_name_overrides` — the PER-DESIGN map, migration 034 —
    // was NOT in this select, but line ~409 read `scoreRow.design_name_overrides` and handed the
    // result to buildThemeCard. It was therefore ALWAYS undefined, so every MULTI-DESIGN family
    // (scalar null + map populated, which is exactly what the per-design name UI writes) resolved
    // ZERO design names ⇒ null theme card ⇒ empty rating map ⇒ theme_fit NULL on every row ⇒ the
    // whole target set ordered on market score alone, with no log and no guard. An inline cast at
    // the read site hid it from tsc.
    const { data: scoreRow } = await db.from('listing_seo_scores')
      .select('product_title, design_name_override, design_name_overrides, audience_lean').eq('parent_asin', resolvedParent).maybeSingle();
    const childTitles = (listingRows ?? []).map((r) => r.title).filter(Boolean) as string[];

    /* ── KEYWORD_TARGET_SET (#143) ─────────────────────────────────────────────────────────────
     * HOISTED above the first early return. `apparelCtx` used to be computed at the off-niche
     * layer, below three returns that can exit before it — so a gate that bailed early could not
     * have built a context even if it wanted to.
     *
     * `rated()` is the OPT-OUT net: EVERY return inside this try goes through it, so a future
     * early-exit added here inherits the rating by construction rather than by remembering. Nets
     * that must be remembered are the ones that get forgotten — that is the section-regen lesson
     * (d93f93d), applied structurally.
     */
    const apparelCtx = [scoreRow?.product_title, listingTitle, ...childTitles].filter(Boolean).join(' ');
    const isApparelPool = /\b(?:t-?shirts?|tshirts?|shirts?|hoodies?|sweatshirts?|apparel)\b/i.test(apparelCtx);

    let ratedOnce = false;
    const rated = async (out: T[]): Promise<RelevanceGateResult<T>> => {
      // Idempotence guard: rated() is called on exactly one return path per invocation, but a
      // refactor that nested two of them would otherwise fire the rater twice and bill for it.
      if (ratedOnce) return { keywords: out, ctx: null, ratings: null, themeRunId: null };
      ratedOnce = true;

      // `off` short-circuits BEFORE any await, so the flag genuinely costs zero network calls.
      if (selectionMode() === 'off') return { keywords: out, ctx: null, ratings: null, themeRunId: null };

      try {
        // ONE load, TWO consumers. `loadSelectionContextWithSources` returns the same four design
        // signals it derived the seasons from, and the card is built from THOSE — not from a second,
        // narrower re-read of the score row. Before this, the seasons read four sources and the card
        // read one-and-a-half, eight lines apart, so a design the seller had never named by hand got
        // a correct season and no theme card at all. Zero extra queries: every source was loaded.
        const { ctx, sources } = await loadSelectionContextWithSources({
          supabase: db,
          childAsin: asin,
          parentAsin: resolvedParent,
          scoreRow,
          haystack: apparelCtx,
          site: 'syncKeywordIntelligence.gate',
        });
        const card = await buildThemeCard({
          asin,
          parentAsin: resolvedParent,
          designNameOverride: sources.designNameOverride ?? null,
          designNameOverrides: sources.designNameOverridesByKey ?? null,
          visionDesignTheme: sources.visionDesign?.designTheme ?? null,
          resolvedDesignName: sources.resolvedDesignName ?? null,
          audienceLean: (scoreRow as { audience_lean?: string | null } | null)?.audience_lean ?? null,
          supabase: db,
        });
        // No card ⇒ no design signal ⇒ nothing trustworthy to rate against. The ctx still stands
        // (it carries the haystack + apparel verdict + seasons), so selection still runs — every
        // band is simply null, which the selector treats as 2 and never hard-gates.
        const ratings = await rateThemeFit(out.map((k) => k.keyword), card, {
          asin,
          currentTitle: scoreRow?.product_title || listingTitle || null,
          audienceLean: (scoreRow as { audience_lean?: string | null } | null)?.audience_lean ?? null,
        });
        return {
          keywords: out,
          ctx,
          ratings: ratings.size > 0 ? ratings : null,
          themeRunId: ratings.size > 0 ? newThemeRunId() : null,
        };
      } catch (e) {
        // FAIL-OPEN: ctx null ⇒ storeAnalysis writes the legacy payload and preserves whatever
        // signals are already stored. Never an INERT ctx, which would look like a real answer.
        console.warn(`[syncKeywordIntelligence] theme rating failed for ${asin} (non-fatal; legacy write):`, e instanceof Error ? e.message : e);
        return { keywords: out, ctx: null, ratings: null, themeRunId: null };
      }
    };

    const identity = identityTokensOf(scoreRow?.product_title, scoreRow?.design_name_override, listingTitle, ...childTitles);
    if (identity.size === 0) {
      console.log(`[syncKeywordIntelligence] relevance gate: no identity tokens for ${asin} — pool kept UNFILTERED (${keywords.length} kw)`);
      return rated(keywords);
    }
    // IDENTITY-SYNONYM OPPORTUNITIES (2026-07-15): add the design's identity siblings (football/fútbol for a
    // soccer design) to the STORED pool so they surface as ranking OPPORTUNITIES in the RANK panel AND the
    // scorer AND the generator — ONE opportunity source (coherence Invariant 6), not merely placed by the
    // generator. Each synonym clones its highest-volume harvested SIBLING so runKeywordEngine (downstream)
    // scores it as the high-value term it is; Amazon indexes the LITERAL token (no soccer↔football stemming),
    // so it only counts covered when really present. Asymmetric: a gridiron "football" design yields nothing.
    const synTargets = guaranteedIdentitySynonyms(scoreRow?.product_title, listingTitle, ...childTitles);
    const volOf = (k: T) => (k as { searchVolume?: number; volume?: number }).searchVolume ?? (k as { volume?: number }).volume ?? 0;
    const addSynonyms = (set: T[]): T[] => {
      if (synTargets.length === 0) return set;
      const adds: T[] = [];
      for (const { synonym, sources } of synTargets) {
        const re = new RegExp(`\\b${synonym}\\b`, 'i');
        if (set.some((k) => re.test(k.keyword))) continue;                    // already harvested — leave it
        const srcRe = new RegExp(`\\b(?:${sources.join('|')})\\b`, 'i');
        let best: T | null = null;                                            // highest-volume harvested sibling
        for (const k of set) if (srcRe.test(k.keyword) && (best === null || volOf(k) > volOf(best))) best = k;
        // INHERIT THE PLACEMENT PRIORITY, NEVER THE MEASURED METRICS (PO ruling 2026-08-09, "A: YES").
        //
        // This line used to be a bare `{ ...best, keyword: synonym }` — "inherit its volume/data
        // profile" — which copied the SOURCE row's NATIVE Jungle Scout metrics onto a token Jungle
        // Scout never measured. Because these rows persist to keyword_analysis specifically so they
        // "surface as ranking OPPORTUNITIES in the RANK panel" (the comment above), the seller was
        // shown `football` carrying `soccer jersey`'s measured opportunity — fabricated market data,
        // and a direct contradiction of the standing rule that the opportunity number must be the
        // provider's own (SELLER_PROFILE §5, "never our fabricated composite").
        //
        // The three NATIVE columns (migration 055) are nulled; everything else is kept. That split is
        // the whole fix, and it is why nothing regresses:
        //   - `carriesMarketOpportunity` (marketDataHealth.ts:109) now reads FALSE for these rows, so
        //     they can never win the title money-tail pin on numbers nobody measured, and the
        //     marketDataHealth census stops counting them as measured supply.
        //   - `priorityDisplay(marketOpportunity, coverageGapScore)` (page.tsx:4552) falls through to
        //     the `~N` composite, which the UI ALREADY renders as explicitly-not-market-data.
        //   - `coverageGapScore` + `searchVolume` are retained, so the synonym keeps its placement
        //     power and still reaches the backend bytes — which is the entire point of adding it, and
        //     per the PO's scope ruling ("B: NO [customer-facing], but backend yes") the backend is
        //     exactly where it belongs.
        // Net effect: the term still gets indexed; the NUMBER next to it stops lying.
        if (best) adds.push({
          ...best,
          keyword: synonym,
          jsEaseOfRanking: null,
          jsRelevancyScore: null,
          marketOpportunity: null,
        } as T);
      }
      if (adds.length) console.log(`[syncKeywordIntelligence] identity-synonym opportunities for ${asin}: +${adds.map((a) => a.keyword).join(', ')}`);
      return adds.length ? [...set, ...adds] : set;
    };
    const before = keywords.length;
    // EXEMPT universe keywords (#280): broad-category / garment-brand angles ("graphic tees for women",
    // "comfort colors shirt") are made entirely of generic apparel/category tokens, so keywordIsRelevant's
    // token-overlap would strip the whole universe — the gate and the universes structurally fight each
    // other. These are deterministic, on-product, rule-generated angles (no AI seed → can't carry a
    // hallucinated theme), so exempting them does NOT reopen the soccer-pollution trap, which flows
    // through the design-NICHE query (still fully gated below). PO 2026-06-17 "RELAX, YES".
    const kept = keywords.filter((k) => (k as { fromUniverse?: boolean }).fromUniverse || keywordIsRelevant(k.keyword, identity));
    if (kept.length === 0 && before > 0) {
      console.warn(`[syncKeywordIntelligence] relevance gate would drop ALL ${before} kw for ${asin} (identity too narrow: [${[...identity].slice(0, 8).join(', ')}]) — keeping pool UNFILTERED (never-collapse floor)`);
      return rated(keywords);
    }
    console.log(`[syncKeywordIntelligence] relevance gate for ${asin}: kept ${kept.length}/${before} (dropped ${before - kept.length} off-product)`);

    // OFF-NICHE layer (2026-07-14): the token-overlap gate above keeps keywords that share only a
    // GENERIC token ("shirt"/"tees"/"women") with identity, so celebrity merch ("usher and chris brown
    // shirt"), foreign-language dupes ("grafica tees women") and off-niche gear survive into the stored
    // pool and dock the score forever (an unfixable dock). Clean them at the SOURCE with the SAME
    // predicates the scoring seams use: the deterministic net (enumerable classes) + an LLM pass (the
    // semantic tail). Broad on-product category angles (fromUniverse) are exempt. Fail-open + floor.
    // apparelCtx / isApparelPool are HOISTED to the top of this try (KEYWORD_TARGET_SET #143) so the
    // early returns above can build a SelectionContext. Same values, computed once.
    // #280 universe terms keep the TOKEN-OVERLAP exemption above (they are generic on-product category
    // angles keywordIsRelevant would wrongly strip) — but they are NOT exempt from CONTAMINATION. A broad
    // category universe's keywords_by_keyword expansion drags in foreign-language dupes ("camisas para
    // hombres") and off-niche gear the same as any pool, so the DETERMINISTIC nets (foreign + off-niche)
    // run over universe AND niche terms alike. The LLM IRRELEVANT pass stays scoped to NON-universe terms
    // so the semantic classifier can't strip a legit broad angle (the very reason universes were exempted
    // from token-overlap). PO 2026-07-17 — the exemption is for genericness, never contamination.
    const candidates = kept.filter((k) => !(k as { fromUniverse?: boolean }).fromUniverse);
    const offNiche = new Set<string>();
    // Foreign-language duplicates are off-niche for ANY listing (universe included) — an English listing
    // can never index a Spanish keyword.
    for (const k of kept) if (isForeignKeyword(k.keyword)) offNiche.add(k.keyword);
    if (isApparelPool) {
      // Deterministic apparel off-niche net (foreign / competitor-blank / wholesale / gear) — universe rows too.
      for (const k of kept) if (isOffNicheKeyword(k.keyword, { context: apparelCtx })) offNiche.add(k.keyword);
    }
    // LLM semantic gate on NON-universe candidates. (RELEVANCE_THEME_V2 — the designTheme /
    // audienceLean / Rule-6 prompt threading and its universe wrong-theme pass — was RETIRED
    // 2026-08-03 at live UNSET: it caught ZERO on a live forced re-research, and the cure shipped
    // as KEYWORD_TARGET_SET at the selection seam instead. Wrong-theme contamination is now priced
    // out by targetScore's theme_fit, not filtered at ingestion. Git ref: pre-1732d8f.)
    const llmDrop = await classifyOffNicheKeywords(
      candidates.map((k) => k.keyword),
      {
        title: scoreRow?.product_title || listingTitle,
        category: isApparelPool ? 'apparel / graphic t-shirt' : null,
      },
    );
    for (const kw of llmDrop) offNiche.add(kw);

    if (offNiche.size === 0) return rated(addSynonyms(kept));
    const kept2 = kept.filter((k) => !offNiche.has(k.keyword));
    if (kept2.length === 0 && before > 0) {
      console.warn(`[syncKeywordIntelligence] off-niche gate would drop ALL for ${asin} — keeping ${kept.length} (never-collapse floor)`);
      return rated(addSynonyms(kept));
    }
    console.log(`[syncKeywordIntelligence] off-niche gate for ${asin}: dropped ${offNiche.size} off-niche (${kept2.length}/${kept.length} kept)`);
    return rated(addSynonyms(kept2));
  } catch (e) {
    console.warn('[syncKeywordIntelligence] relevance gate failed (non-fatal; pool unfiltered):', e instanceof Error ? e.message : e);
    // ctx:null — the OUTER catch cannot have established context, so storeAnalysis must write the
    // legacy payload and preserve stored signals. An INERT ctx here would look like a real answer.
    return { keywords, ctx: null, ratings: null, themeRunId: null };
  }
}

// ─── Cache Age Helper ───────────────────────────────────────────────────────

async function getKeywordCacheAge(
  asin: string,
  source: 'sqp' | 'jungle_scout'
): Promise<number> {
  const { data } = await supabase
    .from('keyword_cache')
    .select('fetched_at')
    .eq('asin', asin)
    .eq('source', source)
    .single();

  if (!data?.fetched_at) return Infinity;
  const fetchedAt = new Date(data.fetched_at).getTime();
  const ageMs = Date.now() - fetchedAt;
  return ageMs / (1000 * 60 * 60);
}

// ─── Parent ASIN Resolution ─────────────────────────────────────────────────

async function getParentAsin(asin: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('listing_content')
      .select('parent_asin')
      .eq('asin', asin)
      // .limit(1), NOT .single(): FBA+FBM twin rows share the ASIN and .single() errors
      // on 2+ matches (twins share one parent_asin, so any row answers the question).
      .limit(1)
      .maybeSingle();
    return (data as { parent_asin: string | null } | null)?.parent_asin || null;
  } catch {
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildResultFromStored(
  asin: string,
  stored: ReturnType<typeof getStoredAnalysis> extends Promise<infer T> ? NonNullable<T> : never
): EngineResult {
  // KEYWORD_TARGET_SET (#143). `stored` arrives from getStoredAnalysis, which at `on` ALREADY
  // ordered it selection_rank-first. Re-sorting by coverageGapScore here would throw that away and
  // hand back the gap-amplified ordering this PR exists to stop — so at `on` the incoming order is
  // authoritative and only the pooled tail (rank NULL) needs the legacy sort.
  //
  // No `resolveRankingTargets` here, deliberately: this is a synchronous helper with no DB access,
  // so it cannot build a real SelectionContext, and the recompute branch on a ≤30-keyword pool would
  // then run against `designSeasons: []` — routing a Valentine design's own keywords to BACKEND.
  // Reordering what the writer already decided is the correct scope for this site; deciding
  // membership is not.
  const targetsLive = selectionMode() === 'on';
  const sorted = targetsLive
    ? [...stored].sort((a, b) => {
        const ar = typeof a.selectionRank === 'number' ? a.selectionRank : Infinity;
        const br = typeof b.selectionRank === 'number' ? b.selectionRank : Infinity;
        if (ar !== br) return ar - br;
        if (b.coverageGapScore !== a.coverageGapScore) return b.coverageGapScore - a.coverageGapScore;
        return a.keyword.localeCompare(b.keyword);
      })
    : [...stored].sort((a, b) => b.coverageGapScore - a.coverageGapScore);
  return {
    asin,
    analyzedAt: new Date().toISOString(),
    dataSource: stored[0]?.dataSource ?? 'sqp',
    totalKeywordsAnalyzed: stored.length,
    topOpportunities: sorted.slice(0, 25),
    allKeywords: sorted,
    summary: buildSummary(stored),
  };
}

function mergeKeywordResults(
  sqpKeywords: EngineResult['allKeywords'],
  jsKeywords: EngineResult['allKeywords']
): EngineResult['allKeywords'] {
  const merged = new Map<string, (typeof sqpKeywords)[0]>();

  // SQP takes precedence
  for (const kw of sqpKeywords) {
    merged.set(kw.keyword.toLowerCase(), kw);
  }

  // Add JS keywords that don't exist in SQP
  for (const kw of jsKeywords) {
    const key = kw.keyword.toLowerCase();
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, kw);
    } else {
      // FIELD-LEVEL inherit (Item 3 / Rank-column-empty + adversarial MEDIUM, 2026-08-08): SQP rows
      // NEVER carry the JS-measured fields (organicRank + the three migration-055 native metrics),
      // so the whole-row SQP precedence above silently nulled — permanently and unhealably, see
      // mergeInherit.ts — the values only the JS path produces, for every dual-source keyword.
      // SQP still wins every other field; the rule itself lives in the pure, tested helper.
      const inherited = inheritJsMeasurements(existing, kw);
      if (inherited !== existing) merged.set(key, inherited);
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.coverageGapScore - a.coverageGapScore);
}

function buildSummary(keywords: EngineResult['allKeywords']): EngineResult['summary'] {
  return {
    critical: keywords.filter(k => k.actionType === 'CRITICAL').length,
    upgrade: keywords.filter(k => k.actionType === 'UPGRADE').length,
    reinforce: keywords.filter(k => k.actionType === 'REINFORCE').length,
    defended: keywords.filter(k => k.actionType === 'DEFENDED').length,
    optimized: keywords.filter(k => k.actionType === 'OPTIMIZED').length,
  };
}
// build: 20260602-172806
