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
import { researchKeywords } from '../keyword-engine/keywordResearcher';
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
      // Check if we already have fresh JS data cached (avoid burning credits)
      const rawCached = await getCachedKeywords(asin, 'jungle_scout');
      const cachedAge = rawCached ? await getKeywordCacheAge(asin, 'jungle_scout') : Infinity;
      const JS_REFRESH_TTL_HOURS = 24;

      if (rawCached && cachedAge < JS_REFRESH_TTL_HOURS && !forceRefresh) {
        console.log(`[syncKeywordIntelligence] JS cache HIT for ${asin} (${Math.round(cachedAge)}h old). Skipping JS API call.`);
        // Re-run engine on cached data to get fresh presence analysis
        const { data: listing } = await supabase
          .from('listing_content')
          .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
          .eq('asin', asin)
          .single();

        const jsResult = runKeywordEngine(asin, rawCached as import('../keyword-engine').RawKeywordRow[], listing ?? {}, 'jungle_scout');
        const mergedKeywords = mergeKeywordResults(sqpResult.allKeywords, jsResult.allKeywords);
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

      // No fresh cache — run the full 3-credit research pipeline
      const resolvedParent = parentAsin || await getParentAsin(asin);
      const researchResult = await researchKeywords(asin, resolvedParent || asin, {
        forceRefresh,
        listingTitle,
      });

      if (researchResult.allKeywords.length > 0) {
        // Fetch listing content for presence check
        const { data: listing } = await supabase
          .from('listing_content')
          .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
          .eq('asin', asin)
          .single();

        // Run engine on research results (against OUR listing content)
        const jsResult = runKeywordEngine(asin, researchResult.allKeywords, listing ?? {}, 'jungle_scout');

        // Merge JS results into SQP results (SQP takes precedence for same keywords)
        const mergedKeywords = mergeKeywordResults(sqpResult.allKeywords, jsResult.allKeywords);
        await storeAnalysis(asin, mergedKeywords);

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
      .single();
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
