/**
 * syncKeywordIntelligence.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrator for keyword intelligence sync.
 *
 * Determines the best data source for an ASIN and runs the appropriate sync:
 *   - Has SQP data (established product with sales) → syncKeywordData (SQP)
 *   - Jungle Scout enabled → also fetch competitor keywords
 *   - No data available → sibling inheritance (handled inside syncKeywordData)
 *
 * This is the function called by:
 *   1. The API route /api/fba/intelligence/[asin] (on-demand)
 *   2. The scheduled sync job (monthly refresh)
 *
 * Karpathy principle: Goal-driven. One function, one purpose.
 */

import { syncKeywordData } from './syncKeywordData';
import { fetchKeywordsByASIN, getJungleScoutStatus } from './jungleScoutClient';
import {
  getCachedKeywords,
  getStoredAnalysis,
  runKeywordEngine,
  storeAnalysis,
  EngineResult,
  ListingContent,
} from '../keyword-engine';
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
}

/**
 * Main entry point for keyword intelligence.
 *
 * Priority order:
 *   1. Stored analysis (DB) — if fresh and useStoredAnalysis=true
 *   2. Cached raw data (keyword_cache) → re-run engine
 *   3. Fresh SQP fetch → engine → store
 *   4. Jungle Scout (if enabled) → merge → engine → store
 */
export async function syncKeywordIntelligence(
  asin: string,
  options: IntelligenceOptions = {}
): Promise<EngineResult> {
  const {
    forceRefresh = false,
    includeJungleScout = true,
    useStoredAnalysis = true,
  } = options;

  // Path 1: Return stored analysis if available and not forcing refresh
  if (useStoredAnalysis && !forceRefresh) {
    const stored = await getStoredAnalysis(asin, 100);
    if (stored && stored.length > 0) {
      // Build a lightweight EngineResult from stored data
      return buildResultFromStored(asin, stored);
    }
  }

  // On forceRefresh: clear stale cached data so the engine re-runs with fresh presence data
  if (forceRefresh) {
    await supabase.from('keyword_cache').delete().eq('asin', asin);
    await supabase.from('keyword_analysis').delete().eq('asin', asin);
    console.log(`[syncKeywordIntelligence] Cleared stale cache for ${asin} (forceRefresh)`);
  }

  // Path 2 & 3: Run SQP sync (handles cache check internally)
  const sqpResult = await syncKeywordData(asin);

  // Path 4: Augment with Jungle Scout if enabled and budget allows
  // Note: forceRefresh clears keyword_cache above, so getCachedKeywords will return null
  // and we will always re-fetch from JS on forceRefresh. This is intentional.
  const jsStatus = await getJungleScoutStatus();
  if (includeJungleScout && jsStatus.enabled) {
    try {
      const jsCached = forceRefresh ? null : await getCachedKeywords(asin, 'jungle_scout');
      if (!jsCached) {
        // Fetch from Jungle Scout
        const jsKeywords = await fetchKeywordsByASIN([asin]);
        const jsRows = jsKeywords.get(asin) ?? [];

        if (jsRows.length > 0) {
          // Fetch listing content for presence check (column-based schema)
          const { data: listing } = await supabase
            .from('listing_content')
            .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
            .eq('asin', asin)
            .single();

          // Run engine on JS data
          const jsResult = runKeywordEngine(asin, jsRows, listing ?? {}, 'jungle_scout');

          // Merge JS results into SQP results (SQP takes precedence for same keywords)
          const mergedKeywords = mergeKeywordResults(
            sqpResult.allKeywords,
            jsResult.allKeywords
          );

          // Store merged analysis
          await storeAnalysis(asin, mergedKeywords);

          // Return merged result
          return {
            ...sqpResult,
            allKeywords: mergedKeywords,
            topOpportunities: mergedKeywords.slice(0, 25),
            totalKeywordsAnalyzed: mergedKeywords.length,
            summary: buildSummary(mergedKeywords),
          };
        }
      }
    } catch (err) {
      console.error(`[syncKeywordIntelligence] Jungle Scout augmentation failed for ${asin}:`, err);
      // Don't fail — return SQP result
    }
  }

  return sqpResult;
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
