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
import { getJungleScoutStatus } from './jungleScoutClient';
import {
  getCachedKeywords,
  getStoredAnalysis,
  runKeywordEngine,
  storeAnalysis,
  EngineResult,
} from '../keyword-engine';
import { captureRankSnapshots } from '../keyword-engine/cacheService';
import { researchKeywords } from '../keyword-engine/keywordResearcher';
import { loadListingRowsForPresence } from '../keyword-engine/loadListingContent';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

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
    const stored = await getStoredAnalysis(asin, 100);
    if (stored && stored.length > 0) {
      return buildResultFromStored(asin, stored);
    }
  }

  // On forceRefresh: clear only the ANALYSIS cache (keyword_analysis) so the engine re-runs.
  // Do NOT delete keyword_cache — that holds the raw JS API data which costs credits to re-fetch.
  if (forceRefresh) {
    await supabase.from('keyword_analysis').delete().eq('asin', asin);
    console.log(`[syncKeywordIntelligence] Cleared analysis cache for ${asin} (forceRefresh). Raw keyword_cache preserved.`);
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

        // Gate the CACHED pool too (the fresh-research path gated, this one didn't — drift). Same
        // gate + never-collapse floor, so a cache-hit re-run can't re-store off-product keywords.
        // (Gated post-engine here — the engine output carries .keyword; the raw union type doesn't.)
        const jsResult = runKeywordEngine(asin, rawCached as import('../keyword-engine').RawKeywordRow[], listingRows, 'jungle_scout');
        const gatedJs = await applyRelevanceGate(asin, resolvedParent, jsResult.allKeywords, listingRows, listingTitle);
        const mergedKeywords = mergeKeywordResults(sqpResult.allKeywords, gatedJs);
        await storeAnalysis(asin, mergedKeywords);

        return {
          ...sqpResult,
          allKeywords: mergedKeywords,
          topOpportunities: mergedKeywords.slice(0, 25),
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
      });

      // Instrument the research pool size so an empty/thin pool is VISIBLE in prod logs — the
      // disambiguation the diagnosis flagged: "gate stripped to zero" vs "research returned nothing".
      console.log(`[syncKeywordIntelligence] research pool for ${asin}: ${researchResult.allKeywords.length} kw (seed source: ${researchResult.source})`);
      if (researchResult.allKeywords.length > 0) {
        // Fetch listing content for presence check (twin-safe; all rows, OR'd per row)
        const listingRows = await loadListingRowsForPresence(supabase, asin);

        // Relevance gate + never-collapse floor (shared helper, applied identically to the cache-hit
        // path above so the two can't drift; gates BEFORE the engine + storage).
        const filteredKeywords = await applyRelevanceGate(asin, resolvedParent, researchResult.allKeywords, listingRows, listingTitle);

        // Run engine on research results (against OUR listing content)
        const jsResult = runKeywordEngine(asin, filteredKeywords, listingRows, 'jungle_scout');

        // Merge JS results into SQP results (SQP takes precedence for same keywords)
        const mergedKeywords = mergeKeywordResults(sqpResult.allKeywords, jsResult.allKeywords);
        await storeAnalysis(asin, mergedKeywords);

        // Rank tracker (PO: "track OUR ranking keywords over time"): snapshot our organic rank
        // per keyword from this FRESH Jungle Scout measurement. The cache-hit path deliberately
        // does NOT capture — its ranks were measured (and snapshotted) at the original fetch.
        await captureRankSnapshots(asin, researchResult.allKeywords.map((k) => ({
          keyword: k.keyword, organicRank: k.organicRank ?? null, searchVolume: k.searchVolume ?? null,
        })));

        console.log(`[syncKeywordIntelligence] Research pipeline complete for ${asin}: ${researchResult.allKeywords.length} keywords, ${researchResult.creditsUsed} credits, competitor: ${researchResult.competitor?.asin || 'none'}`);

        return {
          ...sqpResult,
          allKeywords: mergedKeywords,
          topOpportunities: mergedKeywords.slice(0, 25),
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
async function applyRelevanceGate<T extends { keyword: string }>(
  asin: string,
  resolvedParent: string,
  keywords: T[],
  listingRows: { title?: string | null }[] | null,
  listingTitle?: string,
): Promise<T[]> {
  try {
    const { identityTokensOf, keywordIsRelevant } = await import('../keyword-engine/keywordResearcher');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;
    const { data: scoreRow } = await db.from('listing_seo_scores')
      .select('product_title, design_name_override').eq('parent_asin', resolvedParent).maybeSingle();
    const childTitles = (listingRows ?? []).map((r) => r.title).filter(Boolean) as string[];
    const identity = identityTokensOf(scoreRow?.product_title, scoreRow?.design_name_override, listingTitle, ...childTitles);
    if (identity.size === 0) {
      console.log(`[syncKeywordIntelligence] relevance gate: no identity tokens for ${asin} — pool kept UNFILTERED (${keywords.length} kw)`);
      return keywords;
    }
    const before = keywords.length;
    const kept = keywords.filter((k) => keywordIsRelevant(k.keyword, identity));
    if (kept.length === 0 && before > 0) {
      console.warn(`[syncKeywordIntelligence] relevance gate would drop ALL ${before} kw for ${asin} (identity too narrow: [${[...identity].slice(0, 8).join(', ')}]) — keeping pool UNFILTERED (never-collapse floor)`);
      return keywords;
    }
    console.log(`[syncKeywordIntelligence] relevance gate for ${asin}: kept ${kept.length}/${before} (dropped ${before - kept.length} off-product)`);
    return kept;
  } catch (e) {
    console.warn('[syncKeywordIntelligence] relevance gate failed (non-fatal; pool unfiltered):', e instanceof Error ? e.message : e);
    return keywords;
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
  const sorted = [...stored].sort((a, b) => b.opportunityScore - a.opportunityScore);
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
    if (!merged.has(key)) {
      merged.set(key, kw);
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.opportunityScore - a.opportunityScore);
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
