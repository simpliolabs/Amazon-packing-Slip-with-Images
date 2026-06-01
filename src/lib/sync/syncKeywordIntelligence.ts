/**
 * syncKeywordIntelligence.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrator for keyword intelligence sync.
 *
 * Determines the best data source for an ASIN and runs the appropriate sync:
 *   - Has SQP data (established product with sales) → syncKeywordData (SQP)
 *   - Jungle Scout enabled → fetch keywords for own ASIN first
 *   - If own ASIN returns 0 keywords → fallback to competitor ASIN (reverse ASIN lookup)
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
  /** Competitor ASIN to use for reverse lookup if own ASIN has no data */
  competitorAsin?: string;
}

/**
 * Main entry point for keyword intelligence.
 *
 * Priority order:
 *   1. Stored analysis (DB) — if fresh and useStoredAnalysis=true
 *   2. Cached raw data (keyword_cache) → re-run engine
 *   3. Fresh SQP fetch → engine → store
 *   4. Jungle Scout (if enabled):
 *      a. Try own ASIN first
 *      b. If 0 results → fallback to competitor ASIN (reverse ASIN lookup)
 */
export async function syncKeywordIntelligence(
  asin: string,
  options: IntelligenceOptions = {}
): Promise<EngineResult> {
  const {
    forceRefresh = false,
    includeJungleScout = true,
    useStoredAnalysis = true,
    competitorAsin,
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
  const jsStatus = await getJungleScoutStatus();
  if (includeJungleScout && jsStatus.enabled) {
    try {
      const jsCached = forceRefresh ? null : await getCachedKeywords(asin, 'jungle_scout');
      if (!jsCached) {
        // Step A: Try own ASIN first
        let jsRows = (await fetchKeywordsByASIN([asin])).get(asin) ?? [];
        let jsSource = asin;

        // Step B: If own ASIN returns 0 keywords, fallback to competitor ASIN
        if (jsRows.length === 0) {
          const fallbackAsin = competitorAsin || await getCompetitorAsin(asin);
          if (fallbackAsin) {
            console.log(`[syncKeywordIntelligence] Own ASIN ${asin} returned 0 JS keywords. Falling back to competitor: ${fallbackAsin}`);
            jsRows = (await fetchKeywordsByASIN([fallbackAsin])).get(fallbackAsin) ?? [];
            jsSource = fallbackAsin;
            if (jsRows.length > 0) {
              console.log(`[syncKeywordIntelligence] Got ${jsRows.length} keywords from competitor ${fallbackAsin}`);
            }
          } else {
            console.log(`[syncKeywordIntelligence] Own ASIN ${asin} returned 0 JS keywords and no competitor ASIN configured.`);
          }
        }

        if (jsRows.length > 0) {
          // Fetch listing content for presence check (column-based schema)
          const { data: listing } = await supabase
            .from('listing_content')
            .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
            .eq('asin', asin)
            .single();

          // ── Relevance filter for competitor-fallback keywords ──────────────
          // When keywords come from a competitor ASIN (not our own), many will
          // be completely unrelated to our product (e.g. "Stephen Colbert shirt"
          // appearing on a Later Gator tshirt competitor). Filter to only keep
          // keywords that share at least one meaningful token with our listing.
          if (jsSource !== asin) {
            const listingText = [
              (listing as Record<string, string> | null)?.title ?? '',
              (listing as Record<string, string> | null)?.bullet_1 ?? '',
              (listing as Record<string, string> | null)?.bullet_2 ?? '',
              (listing as Record<string, string> | null)?.bullet_3 ?? '',
              (listing as Record<string, string> | null)?.bullet_4 ?? '',
              (listing as Record<string, string> | null)?.bullet_5 ?? '',
            ].join(' ').toLowerCase();

            // Extract meaningful seed tokens from our listing (3+ chars, not stopwords).
            // We also exclude generic apparel/category words (shirt, tee, tshirt, etc.)
            // so that competitor keywords like "Stephen Colbert shirt" don't match just
            // because our listing contains the word "shirt".
            const STOPWORDS = new Set([
              // Common English stopwords
              'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'has', 'have',
              'its', 'our', 'your', 'all', 'can', 'not', 'but', 'from', 'they', 'will',
              'been', 'more', 'also', 'into', 'than', 'then', 'when', 'what', 'which',
              'who', 'how', 'any', 'each', 'both', 'very', 'just', 'over', 'such', 'even',
              'most', 'made', 'make', 'like', 'only', 'well', 'way', 'may', 'per',
              // Generic apparel/category words — too broad to use as product-specific seeds
              'shirt', 'shirts', 'tshirt', 'tshirts', 'tee', 'tees', 'top', 'tops',
              'clothing', 'apparel', 'wear', 'wearing', 'clothes', 'outfit', 'outfits',
              'mens', 'womens', 'unisex', 'men', 'women', 'man', 'woman', 'adult', 'adults',
              'size', 'sizes', 'small', 'medium', 'large', 'xlarge', '2xl', '3xl',
              'cotton', 'fabric', 'soft', 'comfortable', 'comfort', 'breathable',
              'casual', 'everyday', 'gift', 'gifts', 'idea', 'ideas', 'funny', 'cute',
              'graphic', 'print', 'printed', 'design', 'style', 'styled', 'stylish',
              'vintage', 'retro', 'classic', 'cool', 'awesome', 'nice', 'great', 'good',
              'fit', 'fitting', 'wear', 'worn', 'new', 'best', 'top', 'quality',
            ]);
            const seedTokens = new Set(
              listingText.split(/[\s,\-–—]+/)
                .filter(t => t.length >= 3 && !STOPWORDS.has(t))
            );

            const beforeCount = jsRows.length;
            jsRows = jsRows.filter(row => {
              const kw = (row as { keyword: string }).keyword.toLowerCase();
              const kwTokens = kw.split(/[\s,\-–—]+/).filter(t => t.length >= 3);
              // Keep if any keyword token matches any listing seed token
              return kwTokens.some(t => seedTokens.has(t));
            });
            console.log(`[syncKeywordIntelligence] Relevance filter: ${beforeCount} → ${jsRows.length} keywords (competitor fallback from ${jsSource})`);
          }
          // ─────────────────────────────────────────────────────────────────

          // Run engine on JS data (against OUR listing content, not the competitor's)
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
            dataSource: 'jungle_scout',
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

// ─── Competitor ASIN Resolution ──────────────────────────────────────────────

/**
 * Get the competitor ASIN for a given product ASIN.
 * Looks up listing_seo_scores.competitor_asin field.
 * Returns null if not set.
 */
async function getCompetitorAsin(asin: string): Promise<string | null> {
  try {
    // Check listing_seo_scores for this child ASIN
    const { data: scoreRow } = await supabase
      .from('listing_seo_scores')
      .select('competitor_asin')
      .eq('asin', asin)
      .single();

    if ((scoreRow as { competitor_asin: string | null } | null)?.competitor_asin) {
      return (scoreRow as { competitor_asin: string }).competitor_asin;
    }

    // Also check by parent_asin (the ASIN might be stored at parent level)
    const { data: listing } = await supabase
      .from('listing_content')
      .select('parent_asin')
      .eq('asin', asin)
      .single();

    const parentAsin = (listing as { parent_asin: string | null } | null)?.parent_asin;
    if (parentAsin) {
      const { data: parentScore } = await supabase
        .from('listing_seo_scores')
        .select('competitor_asin')
        .eq('parent_asin', parentAsin)
        .single();

      if ((parentScore as { competitor_asin: string | null } | null)?.competitor_asin) {
        return (parentScore as { competitor_asin: string }).competitor_asin;
      }
    }
  } catch {
    // Column might not exist yet — that's fine
  }

  return null;
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
