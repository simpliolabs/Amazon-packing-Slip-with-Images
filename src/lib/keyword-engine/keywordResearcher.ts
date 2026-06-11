/**
 * keywordResearcher.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vision-first keyword research orchestrator.
 *
 * Pipeline (3 JS credits total, cached 7 days):
 *   1. Vision Scan (free) → 1 seed term
 *   2. keywords_by_keyword (1 credit) → up to 100 niche keywords
 *   3. share_of_voice (1 credit) → auto-detect #1 competitor
 *   4. keywords_by_asin on #1 competitor (1 credit) → up to 100 competitor keywords
 *   5. Merge + categorize into 3 buckets: PRIMARY, COMPETITOR_MATCH, COMPETITOR_GAPS
 *
 * Karpathy principle: Goal-driven. One module, one purpose.
 */

import { JungleScoutKeywordRow } from './index';
import {
  fetchKeywordsByKeyword,
  fetchShareOfVoice,
  fetchKeywordsByASIN,
} from '../sync/jungleScoutClient';
import { ProductIdentity, scanProductImage, getProductImageUrl } from './visionScanner';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KeywordBuckets {
  /** Top 10 keywords by search volume (biggest prizes) */
  primary: JungleScoutKeywordRow[];
  /** Keywords the #1 competitor ranks well for (proven converters) */
  competitorMatch: JungleScoutKeywordRow[];
  /** High-volume keywords the competitor is NOT ranking for (easy opportunity) */
  competitorGaps: JungleScoutKeywordRow[];
}

export interface CompetitorMeta {
  asin: string;
  brand: string;
  link: string;
  clicksShare: number;
  conversionsShare: number;
}

export interface KeywordResearchResult {
  buckets: KeywordBuckets;
  /** All keywords flattened (for engine compatibility) */
  allKeywords: JungleScoutKeywordRow[];
  /** The seed term used */
  seedUsed: string;
  /** Auto-detected competitor metadata (null if SOV failed) */
  competitor: CompetitorMeta | null;
  /** How many JS API credits were consumed */
  creditsUsed: number;
  /** Source of the seed term */
  source: 'vision' | 'title' | 'manual' | 'category';
  /** ISO timestamp */
  researchedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const RESEARCH_CACHE_KEY = 'keyword_research';
const RESEARCH_TTL_DAYS = 7;

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Research keywords for a product using the automated 3-credit pipeline.
 *
 * @param asin - The child ASIN to research
 * @param parentAsin - The parent ASIN (for DB updates)
 * @param options - Configuration
 */
export async function researchKeywords(
  asin: string,
  parentAsin: string,
  options: {
    forceRefresh?: boolean;
    listingTitle?: string;
    manualSeed?: string;
    /** CATEGORY-level seed derived from the live SP-API productType ("self stick notes") — the
     *  fix for the seed-quality trap: a vision/title seed is PRODUCT-LITERAL ("post it notes
     *  variety pack"), so Phase 2 returns our own phrasing back and Phase 3 crowns whoever wins
     *  that narrow query — never the category winner whose keywords we need. Supplied by the
     *  caller for NON-apparel only (apparel niches are design-led; vision seeds them better). */
    categorySeed?: string;
  } = {}
): Promise<KeywordResearchResult> {
  const { forceRefresh = false, listingTitle, manualSeed, categorySeed } = options;

  // Check cache first
  if (!forceRefresh) {
    const cached = await getCachedResearch(asin);
    if (cached) {
      console.log(`[keywordResearcher] Cache HIT for ${asin}. Returning cached 3-bucket result.`);
      return cached;
    }
  }

  // ── Phase 1: Get 1 Seed Term ──────────────────────────────────────────────
  let seed: string;
  let source: 'vision' | 'title' | 'manual' | 'category';

  if (manualSeed) {
    seed = manualSeed;
    source = 'manual';
  } else if (categorySeed) {
    seed = categorySeed;
    source = 'category';
  } else {
    const visionSeed = await getTopVisionSeed(asin);
    if (visionSeed) {
      seed = visionSeed;
      source = 'vision';
    } else if (listingTitle) {
      seed = buildSeedFromTitle(listingTitle);
      source = 'title';
    } else {
      console.warn(`[keywordResearcher] No seed available for ${asin}. Cannot research.`);
      return emptyResult();
    }
  }

  console.log(`[keywordResearcher] Phase 1: Seed = "${seed}" (source: ${source})`);
  let creditsUsed = 0;

  // ── Phase 2: keywords_by_keyword (1 credit) ───────────────────────────────
  const nicheKeywords = await fetchKeywordsByKeyword(seed, { pageSize: 100 });
  creditsUsed++;
  console.log(`[keywordResearcher] Phase 2: ${nicheKeywords.length} niche keywords from "${seed}"`);

  // ── Phase 3: share_of_voice (1 credit) ────────────────────────────────────
  const sovCompetitors = await fetchShareOfVoice(seed);
  creditsUsed++;

  // Pick #1 competitor (excluding our own ASIN and parent ASIN)
  const ownAsins = new Set([asin, parentAsin]);
  const topCompetitor = sovCompetitors.find(c => !ownAsins.has(c.asin));

  let competitor: CompetitorMeta | null = null;
  let competitorKeywords: JungleScoutKeywordRow[] = [];

  if (topCompetitor) {
    competitor = {
      asin: topCompetitor.asin,
      brand: topCompetitor.brand,
      link: `https://amazon.com/dp/${topCompetitor.asin}`,
      clicksShare: topCompetitor.clicksShare,
      conversionsShare: topCompetitor.conversionsShare,
    };
    console.log(`[keywordResearcher] Phase 3: #1 competitor = ${topCompetitor.asin} (${topCompetitor.brand}, ${Math.round(topCompetitor.clicksShare * 100)}% clicks)`);

    // Store competitor metadata in DB
    await storeCompetitorMeta(parentAsin, competitor);

    // ── Phase 4: keywords_by_asin on #1 competitor (1 credit) ─────────────
    const compMap = await fetchKeywordsByASIN([topCompetitor.asin]);
    competitorKeywords = compMap.get(topCompetitor.asin) ?? [];
    creditsUsed++;
    console.log(`[keywordResearcher] Phase 4: ${competitorKeywords.length} competitor keywords from ${topCompetitor.asin}`);
  } else {
    console.log(`[keywordResearcher] Phase 3: No competitor found in SOV. Skipping Phase 4.`);
  }

  // ── Phase 5: Merge + 3-Bucket Categorization ──────────────────────────────
  const buckets = categorizeBuckets(nicheKeywords, competitorKeywords);
  const allKeywords = [...buckets.primary, ...buckets.competitorMatch, ...buckets.competitorGaps];

  const result: KeywordResearchResult = {
    buckets,
    allKeywords,
    seedUsed: seed,
    competitor,
    creditsUsed,
    source,
    researchedAt: new Date().toISOString(),
  };

  // Cache the result
  await cacheResearch(asin, result);
  console.log(`[keywordResearcher] Done. ${allKeywords.length} total keywords in 3 buckets (${creditsUsed} credits used).`);

  return result;
}

// ─── Bucket Categorization ──────────────────────────────────────────────────

function categorizeBuckets(
  nicheKeywords: JungleScoutKeywordRow[],
  competitorKeywords: JungleScoutKeywordRow[]
): KeywordBuckets {
  // Build a merged, deduplicated map (niche takes precedence for volume data)
  const merged = new Map<string, JungleScoutKeywordRow>();
  for (const kw of nicheKeywords) {
    merged.set(kw.keyword.toLowerCase(), kw);
  }
  for (const kw of competitorKeywords) {
    const key = kw.keyword.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, kw);
    }
  }

  // Sort all by search volume descending, cap at 100
  const allSorted = Array.from(merged.values())
    .sort((a, b) => b.searchVolume - a.searchVolume)
    .slice(0, 100);

  // Build competitor keyword set for categorization
  const compKwSet = new Set(competitorKeywords.map(k => k.keyword.toLowerCase()));

  // PRIMARY: Top 10 by volume
  const primary = allSorted.slice(0, 10);

  // Remaining keywords split into COMPETITOR_MATCH vs COMPETITOR_GAPS
  const remaining = allSorted.slice(10);
  const competitorMatch: JungleScoutKeywordRow[] = [];
  const competitorGaps: JungleScoutKeywordRow[] = [];

  for (const kw of remaining) {
    if (compKwSet.has(kw.keyword.toLowerCase())) {
      competitorMatch.push(kw);
    } else {
      competitorGaps.push(kw);
    }
  }

  return { primary, competitorMatch, competitorGaps };
}

// ─── Vision Seed Extraction ─────────────────────────────────────────────────

/**
 * Get the single best seed term from vision scanner.
 * Returns the first suggestedSearchTerm (most relevant full search query).
 */
async function getTopVisionSeed(asin: string): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('product_identity')
      .select('identity_data')
      .eq('asin', asin)
      .single();

    if (data) {
      const identity = (data as { identity_data: ProductIdentity }).identity_data;
      if (identity.suggestedSearchTerms?.length > 0) {
        return identity.suggestedSearchTerms[0];
      }
      // Fallback: combine top seed keyword + product type
      if (identity.seedKeywords?.length > 0) {
        return `${identity.seedKeywords[0]} ${identity.productType}`.trim();
      }
    }
  } catch {
    // Table might not exist yet
  }

  // No cached identity — try to scan now
  const imageUrl = await getProductImageUrl(asin);
  if (imageUrl) {
    console.log(`[keywordResearcher] No cached vision identity for ${asin}. Scanning...`);
    const identity = await scanProductImage(asin, imageUrl);
    if (identity && identity.suggestedSearchTerms && identity.suggestedSearchTerms.length > 0) {
      return identity.suggestedSearchTerms[0];
    }
  }

  return null;
}

// ─── Title-Based Seed (Fallback) ────────────────────────────────────────────

/**
 * Build a concise 2-3 word seed search term from a listing title.
 * Jungle Scout keywords_by_keyword works best with short, focused seeds.
 * Strategy: take the first meaningful noun phrase (2-3 words max).
 */
function buildSeedFromTitle(title: string): string {
  // Strip brand prefix (everything before first dash or colon)
  const firstSegment = title.split(/\s*[-–—:]\s*/)[0].trim();

  // Remove size/color/variant words
  const cleaned = firstSegment
    .replace(/\b(Small|Medium|Large|XL|2XL|3XL|XXL|Black|White|Red|Blue|Green|Navy|Gray|Vintage|Retro|Soft|Classic|Premium|Original)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Take only first 3 words to keep the seed tight
  const words = cleaned.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3);

  // Ensure apparel word is present
  const hasApparel = words.some(w => /shirt|tee|top|tshirt/.test(w));
  if (!hasApparel) {
    // Replace last word with 'tshirt' if over 2 words, else append
    if (words.length >= 3) {
      words[2] = 'tshirt';
    } else {
      words.push('tshirt');
    }
  }

  return words.join(' ');
}

// ─── Competitor Storage ─────────────────────────────────────────────────────

async function storeCompetitorMeta(parentAsin: string, meta: CompetitorMeta): Promise<void> {
  const { error } = await supabase
    .from('listing_seo_scores')
    .update({
      competitor_asin: meta.asin,
      competitor_brand: meta.brand,
      competitor_link: meta.link,
      competitor_sov_clicks: meta.clicksShare,
      competitor_sov_conversions: meta.conversionsShare,
    } as never)
    .eq('parent_asin', parentAsin);

  if (error) {
    console.error(`[keywordResearcher] Failed to store competitor meta for ${parentAsin}:`, error.message);
  }
}

// ─── Research Cache ─────────────────────────────────────────────────────────

async function cacheResearch(asin: string, result: KeywordResearchResult): Promise<void> {
  try {
    // keyword_cache columns: id, asin, source, keyword_data, fetched_at, expires_at,
    // competitor_asin, competitor_brand, sov_percentage
    // Extra metadata (seed, source, credits) is stored inside keyword_data wrapper.
    const expiresAt = new Date(
      new Date(result.researchedAt).getTime() + RESEARCH_TTL_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const { error } = await supabase
      .from('keyword_cache')
      .upsert({
        asin,
        source: RESEARCH_CACHE_KEY,
        keyword_data: result.allKeywords,
        fetched_at: result.researchedAt,
        expires_at: expiresAt,
        competitor_asin: result.competitor?.asin ?? null,
        competitor_brand: result.competitor?.brand ?? null,
        sov_percentage: result.competitor
          ? parseFloat((result.competitor.clicksShare * 100).toFixed(2))
          : null,
      }, { onConflict: 'asin,source' });

    if (error) {
      console.error(`[keywordResearcher] Cache write error for ${asin}:`, error.message, error.details);
    } else {
      console.log(`[keywordResearcher] Cache written for ${asin} (source: ${RESEARCH_CACHE_KEY}, ${result.allKeywords.length} keywords).`);
    }
  } catch (err) {
    console.error(`[keywordResearcher] Cache write exception for ${asin}:`, err);
  }
}

async function getCachedResearch(asin: string): Promise<KeywordResearchResult | null> {
  try {
    // Only select columns that actually exist in keyword_cache
    const { data } = await supabase
      .from('keyword_cache')
      .select('keyword_data, fetched_at, expires_at')
      .eq('asin', asin)
      .eq('source', RESEARCH_CACHE_KEY)
      .single();

    if (!data) return null;

    const row = data as {
      keyword_data: JungleScoutKeywordRow[];
      fetched_at: string;
      expires_at: string | null;
    };

    // Check TTL via expires_at (preferred) or fetched_at fallback
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      console.log(`[keywordResearcher] Cache EXPIRED for ${asin} (expires_at: ${row.expires_at}).`);
      return null;
    }
    const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays > RESEARCH_TTL_DAYS) {
      console.log(`[keywordResearcher] Cache EXPIRED for ${asin} (${Math.round(ageDays)} days > ${RESEARCH_TTL_DAYS} TTL).`);
      return null;
    }

    // Rebuild buckets from flat cached data (primary = top 10 by volume)
    const allSorted = (row.keyword_data ?? []).sort((a, b) => b.searchVolume - a.searchVolume);
    const primary = allSorted.slice(0, 10);
    const remaining = allSorted.slice(10);

    return {
      buckets: { primary, competitorMatch: remaining, competitorGaps: [] },
      allKeywords: allSorted,
      seedUsed: '',
      competitor: null,
      creditsUsed: 0,
      source: 'title',
      researchedAt: row.fetched_at,
    };
  } catch {
    return null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function emptyResult(): KeywordResearchResult {
  return {
    buckets: { primary: [], competitorMatch: [], competitorGaps: [] },
    allKeywords: [],
    seedUsed: '',
    competitor: null,
    creditsUsed: 0,
    source: 'title',
    researchedAt: new Date().toISOString(),
  };
}
// build: 20260602191152 - HOSTNAME fix
