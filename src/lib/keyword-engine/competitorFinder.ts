/**
 * Auto-Competitor Detection
 *
 * When a product has no keyword data (new listing) and no manually-set competitor,
 * this module automatically finds the best competitor ASIN by:
 *
 * 1. Using vision-derived product identity (if available) to build a search query
 * 2. Searching Amazon for that query
 * 3. Picking the top-ranking competitor that:
 *    - Is NOT our own ASIN
 *    - Has similar product type
 *    - Ranks well (top 5 in search results)
 *
 * The found competitor is stored in listing_seo_scores.competitor_asin for reuse.
 */

import { createClient } from '@supabase/supabase-js';
import { ProductIdentity } from './visionScanner';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export interface CompetitorResult {
  competitorAsin: string;
  searchQuery: string;
  source: 'vision' | 'title' | 'manual';
  confidence: number;
}

/**
 * Find the best competitor ASIN for keyword research.
 *
 * Priority:
 * 1. Manually-set competitor (from listing_seo_scores.competitor_asin) — always wins
 * 2. Vision-derived search → Amazon search → pick top result
 * 3. Title-derived search → Amazon search → pick top result
 *
 * @param asin - The child ASIN to find a competitor for
 * @param parentAsin - The parent ASIN (for DB lookups)
 * @param visionIdentity - Optional pre-fetched vision identity
 * @param listingTitle - Fallback: the listing title
 */
export async function findBestCompetitor(
  asin: string,
  parentAsin: string,
  visionIdentity?: ProductIdentity | null,
  listingTitle?: string
): Promise<CompetitorResult | null> {
  // Priority 1: Check for manually-set competitor
  const manual = await getManualCompetitor(parentAsin);
  if (manual) {
    return {
      competitorAsin: manual,
      searchQuery: 'manual',
      source: 'manual',
      confidence: 1.0,
    };
  }

  // Priority 2: Use vision-derived suggested search terms
  if (visionIdentity && visionIdentity.suggestedSearchTerms.length > 0) {
    // Use the first suggested search term (most relevant)
    const searchQuery = visionIdentity.suggestedSearchTerms[0];
    const competitor = await searchAmazonForCompetitor(searchQuery, asin);
    if (competitor) {
      // Store for future use
      await storeCompetitor(parentAsin, competitor);
      return {
        competitorAsin: competitor,
        searchQuery,
        source: 'vision',
        confidence: 0.85,
      };
    }
  }

  // Priority 3: Use listing title to build a search query
  if (listingTitle) {
    // Extract the product name from the title (first meaningful phrase)
    const searchQuery = buildSearchQueryFromTitle(listingTitle);
    if (searchQuery) {
      const competitor = await searchAmazonForCompetitor(searchQuery, asin);
      if (competitor) {
        await storeCompetitor(parentAsin, competitor);
        return {
          competitorAsin: competitor,
          searchQuery,
          source: 'title',
          confidence: 0.6,
        };
      }
    }
  }

  return null;
}

/**
 * Get manually-set competitor ASIN from the database.
 */
async function getManualCompetitor(parentAsin: string): Promise<string | null> {
  const { data } = await supabase
    .from('listing_seo_scores')
    .select('competitor_asin')
    .eq('parent_asin', parentAsin)
    .single();

  return (data as { competitor_asin: string | null } | null)?.competitor_asin || null;
}

/**
 * Store a found competitor ASIN in the database.
 */
async function storeCompetitor(parentAsin: string, competitorAsin: string): Promise<void> {
  const { error } = await supabase
    .from('listing_seo_scores')
    .update({ competitor_asin: competitorAsin } as never)
    .eq('parent_asin', parentAsin);

  if (error) {
    console.error(`[competitorFinder] Failed to store competitor for ${parentAsin}:`, error.message);
  } else {
    console.log(`[competitorFinder] Stored competitor ${competitorAsin} for ${parentAsin}`);
  }
}

/**
 * Search Amazon for a competitor ASIN using the SP-API or a lightweight search.
 * Returns the ASIN of the top-ranking competitor (not our own product).
 *
 * NOTE: This uses Amazon's search suggestions or catalog search.
 * For MVP, we use a simple approach: query the Jungle Scout keyword API
 * with the search term and pick the top-ranking ASIN.
 */
async function searchAmazonForCompetitor(
  query: string,
  excludeAsin: string
): Promise<string | null> {
  // For now, this is a placeholder that returns null.
  // The actual implementation would use:
  // 1. Amazon SP-API Catalog Search (searchCatalogItems)
  // 2. Or scrape Amazon search results
  // 3. Or use Jungle Scout's product search API
  //
  // Since the user manually sets competitors via Helium 10 / Cerebro,
  // this auto-detection is a future enhancement.
  // The vision scanner + manual competitor workflow is the primary path.
  console.log(`[competitorFinder] Auto-search not yet implemented. Query: "${query}", exclude: ${excludeAsin}`);
  return null;
}

/**
 * Build a search query from a listing title.
 * Extracts the product name/design name, stripping generic suffixes.
 */
function buildSearchQueryFromTitle(title: string): string | null {
  // Remove common suffixes: size, color, "for Men & Women", etc.
  const cleaned = title
    .replace(/\s*[-–—]\s*(Small|Medium|Large|XL|2XL|3XL|XXL|XXXL|S|M|L)\s*$/i, '')
    .replace(/\s*[-–—]\s*(Black|White|Red|Blue|Green|Navy|Gray|Grey|Purple|Pink|Orange|Yellow|Violet|Heather)\s*$/i, '')
    .replace(/\s*[-–—]\s*(for|ideal for)\s+men\s*[&,]\s*women\s*$/i, '')
    .replace(/\s*[-–—]\s*(Soft|Premium|Comfort|Colors?)\s+.*$/i, '')
    .trim();

  // Take the first meaningful segment (before the first dash)
  const firstSegment = cleaned.split(/\s*[-–—]\s*/)[0].trim();

  if (firstSegment.length < 5) return null;

  // Add "shirt" or "tshirt" if not already present
  const hasApparel = /shirt|tee|top/i.test(firstSegment);
  return hasApparel ? firstSegment : `${firstSegment} shirt`;
}
