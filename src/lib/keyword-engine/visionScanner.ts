/**
 * Vision LLM Product Identity Scanner
 *
 * Analyzes the product's main image using GPT-4.1-mini with vision to extract:
 * - Product type (e.g., "graphic t-shirt")
 * - Design theme (e.g., "cartoon alligator, retro 90s style")
 * - Key visual elements (e.g., "alligator wearing sunglasses, text 'Later Gator'")
 * - Searchable seed keywords (e.g., ["later gator", "alligator", "gator", "90s", "retro"])
 *
 * This provides ground-truth product identity that doesn't depend on
 * the (potentially poorly-written) listing title or bullets.
 */

import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

// Lazy Proxy (2026-08-03, tests-into-CI): a module-top createClient THROWS without env, which made
// every test suite importing this module un-runnable locally and in CI. The Proxy defers client
// construction to the first real property access, so env-free unit tests never trigger it; runtime
// behavior is byte-identical (same client, created once).
let _supabase: ReturnType<typeof createClient<any>> | null = null
const supabase = new Proxy({} as ReturnType<typeof createClient<any>>, {
  get(_t, prop) {
    _supabase ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    return (_supabase as unknown as Record<string | symbol, unknown>)[prop]
  },
})

export interface ProductIdentity {
  productType: string;           // e.g., "graphic t-shirt"
  designTheme: string;           // e.g., "cartoon alligator with retro 90s aesthetic"
  visualElements: string[];      // e.g., ["alligator wearing sunglasses", "text 'Later Gator'", "vintage color wash"]
  seedKeywords: string[];        // e.g., ["later gator", "alligator", "gator", "90s", "retro", "vintage"]
  suggestedSearchTerms: string[];// e.g., ["later gator tshirt", "alligator shirt", "see you later alligator"]
  confidence: number;            // 0-1 confidence score
  scannedAt: string;             // ISO timestamp
}

const VISION_PROMPT = `You are an Amazon product keyword research expert. Analyze this product image and extract the product identity for keyword research purposes.

Your job is to identify:
1. What TYPE of product this is (be specific: "graphic t-shirt", "coffee mug", "phone case", etc.)
2. What is the DESIGN THEME (the main visual concept/joke/reference)
3. What are the KEY VISUAL ELEMENTS (text on the product, characters, symbols, colors)
4. What SEED KEYWORDS would a shopper search to find this exact product
5. What FULL SEARCH TERMS would a shopper type into Amazon to find this product

CRITICAL RULES:
- If there is TEXT on the product, read it EXACTLY (this is usually the most important keyword)
- Focus on what makes this product UNIQUE vs generic products in the same category
- Think like a SHOPPER: what would someone type into Amazon search to find THIS specific design?
- Include both the exact text/phrase AND variations shoppers might use
- Include the product category combined with the design theme

Respond in this exact JSON format:
{
  "productType": "string",
  "designTheme": "string",
  "visualElements": ["string", "string", ...],
  "seedKeywords": ["keyword1", "keyword2", ...],
  "suggestedSearchTerms": ["full search term 1", "full search term 2", ...],
  "confidence": 0.95
}

For seedKeywords: Include 5-15 individual words or short phrases that are CORE to this product's identity.
For suggestedSearchTerms: Include 5-10 full Amazon search queries a shopper would use.`;

/**
 * Scan a product image and extract its identity using Vision LLM.
 * Results are cached in the DB to avoid repeated API calls.
 */
export async function scanProductImage(
  asin: string,
  imageUrl: string,
  options: { forceRescan?: boolean; openai?: OpenAI } = {}
): Promise<ProductIdentity | null> {
  const { forceRescan = false } = options;

  // Check for cached result
  if (!forceRescan) {
    const cached = await getCachedIdentity(asin);
    if (cached) {
      console.log(`[visionScanner] Cache HIT for ${asin}. Using stored product identity.`);
      return cached;
    }
  }

  if (!imageUrl) {
    console.warn(`[visionScanner] No image URL for ${asin}. Cannot scan.`);
    return null;
  }

  console.log(`[visionScanner] Scanning product image for ${asin}: ${imageUrl}`);

  try {
    // Prefer the seller's saved key (passed from the route). The env OPENAI_API_KEY is usually NOT
    // set in prod — the key lives in app_settings — so `new OpenAI()` silently failed, which is why
    // product_identity has been empty and the design name fell back to title-scraping.
    const openai = options.openai ?? new OpenAI();

    const response = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail: 'high',
              },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1000,
      temperature: 0.2,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      console.error(`[visionScanner] Empty response from Vision LLM for ${asin}`);
      return null;
    }

    const parsed = JSON.parse(content) as Omit<ProductIdentity, 'scannedAt'>;
    const identity: ProductIdentity = {
      ...parsed,
      scannedAt: new Date().toISOString(),
    };

    // Cache the result
    await storeIdentity(asin, identity);
    console.log(`[visionScanner] Successfully scanned ${asin}. Seed keywords: [${identity.seedKeywords.join(', ')}]`);

    return identity;
  } catch (err) {
    console.error(`[visionScanner] Vision LLM error for ${asin}:`, err);
    return null;
  }
}

/**
 * Get the product image URL for an ASIN from the database.
 * Checks listing_seo_scores first (parent ASIN), then catalog_products.
 */
export async function getProductImageUrl(asin: string): Promise<string | null> {
  // Try listing_seo_scores (has image_url for parent ASINs)
  const { data: scoreRow } = await supabase
    .from('listing_seo_scores')
    .select('image_url')
    .eq('parent_asin', asin)
    .single();

  if ((scoreRow as { image_url: string | null } | null)?.image_url) {
    return (scoreRow as { image_url: string }).image_url;
  }

  // Try catalog_products (has image_url for child ASINs)
  const { data: catalogRow } = await supabase
    .from('catalog_products')
    .select('image_url')
    .or(`asin.eq.${asin},parent_asin.eq.${asin}`)
    .limit(1)
    .single();

  if ((catalogRow as { image_url: string | null } | null)?.image_url) {
    return (catalogRow as { image_url: string }).image_url;
  }

  return null;
}

/**
 * Get cached product identity from the database.
 * Returns null if not cached or if cache is older than 30 days.
 */
async function getCachedIdentity(asin: string): Promise<ProductIdentity | null> {
  const { data } = await supabase
    .from('product_identity')
    .select('identity_data, scanned_at')
    .eq('asin', asin)
    .single();

  if (!data) return null;

  // Check if cache is still fresh (30 days)
  const scannedAt = new Date((data as { scanned_at: string }).scanned_at).getTime();
  const ageMs = Date.now() - scannedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays > 30) {
    console.log(`[visionScanner] Cache STALE for ${asin} (${Math.round(ageDays)} days old). Will rescan.`);
    return null;
  }

  return (data as { identity_data: ProductIdentity }).identity_data;
}

/**
 * Store product identity in the database.
 */
async function storeIdentity(asin: string, identity: ProductIdentity): Promise<void> {
  const { error } = await supabase
    .from('product_identity')
    .upsert({
      asin,
      identity_data: identity,
      scanned_at: identity.scannedAt,
    }, { onConflict: 'asin' });

  if (error) {
    console.error(`[visionScanner] Failed to store identity for ${asin}:`, error.message);
  }
}

/**
 * Get seed keywords for the relevance filter.
 * Priority: Vision-derived > Title-derived
 * Returns a Set of lowercase seed tokens.
 */
export async function getVisionSeedKeywords(
  asin: string,
  parentAsin?: string
): Promise<string[] | null> {
  // Try to get cached identity for the child ASIN or parent ASIN
  const targetAsin = parentAsin || asin;

  const identity = await getCachedIdentity(targetAsin);
  if (identity) {
    return identity.seedKeywords;
  }

  // Also try the child ASIN if parent didn't have it
  if (parentAsin && parentAsin !== asin) {
    const childIdentity = await getCachedIdentity(asin);
    if (childIdentity) {
      return childIdentity.seedKeywords;
    }
  }

  return null;
}
