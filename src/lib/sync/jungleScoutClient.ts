/**
 * jungleScoutClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Jungle Scout API client.
 *
 * Credentials are loaded from the database (app_settings table) first,
 * with fallback to environment variables for backwards compatibility.
 *
 * Auth format (per official docs):
 *   Authorization: KEY_NAME:API_KEY  (plain, NOT Base64)
 *   Content-Type: application/vnd.api+json
 *   Accept: application/vnd.junglescout.v1+json
 *   X-API-Type: junglescout
 *
 * API docs: https://developers.junglescout.com/api
 * Plan required: Growth Accelerator ($49/mo) + API Tier 1 ($29/mo)
 */

import {
  JungleScoutKeywordRow,
  isWithinBudget,
  logApiCall,
  setCachedKeywords,
} from '../keyword-engine';
import { createAdminClient } from '../supabase/server';

const JS_BASE_URL = 'https://developer.junglescout.com';

interface JsCredentials {
  enabled: boolean;
  apiKey: string;
  keyName: string;
}

// Cache credentials in memory for 30 seconds to avoid DB round-trips on every call
// Short TTL ensures credential updates take effect quickly without requiring a restart
let credentialsCache: { value: JsCredentials; expiresAt: number } | null = null;

async function getCredentials(): Promise<JsCredentials> {
  if (credentialsCache && Date.now() < credentialsCache.expiresAt) {
    return credentialsCache.value;
  }

  try {
    const adminClient = await createAdminClient();
    const { data: rows } = await adminClient
      .from('app_settings')
      .select('key, value')
      .in('key', ['jungle_scout_api_key', 'jungle_scout_key_name', 'jungle_scout_enabled']);

    const settings: Record<string, string> = {};
    for (const row of rows ?? []) {
      settings[(row as { key: string; value: string }).key] = (row as { key: string; value: string }).value;
    }

    const apiKey = settings['jungle_scout_api_key'] ?? '';
    const keyName = settings['jungle_scout_key_name'] ?? '';
    const enabledInDb = settings['jungle_scout_enabled'] === 'true';

    if (apiKey && keyName && enabledInDb) {
      const creds: JsCredentials = { enabled: true, apiKey, keyName };
      credentialsCache = { value: creds, expiresAt: Date.now() + 30 * 1000 }; // 30 seconds
      return creds;
    }
  } catch (err) {
    console.warn('[jungleScoutClient] Could not load credentials from DB, falling back to env vars:', err);
  }

  const apiKey = process.env.JUNGLE_SCOUT_API_KEY ?? '';
  const keyName = process.env.JUNGLE_SCOUT_API_NAME ?? '';
  const enabled = process.env.JUNGLE_SCOUT_ENABLED === 'true' && !!apiKey && !!keyName;

  const creds: JsCredentials = { enabled, apiKey, keyName };
  credentialsCache = { value: creds, expiresAt: Date.now() + 30 * 1000 }; // 30 seconds
  return creds;
}

export function invalidateCredentialsCache(): void {
  credentialsCache = null;
}

// ─── Keywords by ASIN (Reverse ASIN Lookup) ─────────────────────────────────

export async function fetchKeywordsByASIN(
  asins: string[]
): Promise<Map<string, JungleScoutKeywordRow[]>> {
  const result = new Map<string, JungleScoutKeywordRow[]>();

  const creds = await getCredentials();
  if (!creds.enabled) {
    console.warn('[jungleScoutClient] Jungle Scout API not enabled. Configure credentials in Settings.');
    return result;
  }

  const budget = await isWithinBudget('jungle_scout');
  if (!budget.allowed) {
    console.warn(`[jungleScoutClient] Monthly budget exhausted`);
    return result;
  }

  const batch = asins.slice(0, 10);

  try {
    // Auth: plain KEY_NAME:API_KEY — no Base64, no "Basic" prefix (per official JS docs)
    const authHeader = `${creds.keyName}:${creds.apiKey}`;

    const resp = await fetch(
      `${JS_BASE_URL}/api/keywords/keywords_by_asin_query?marketplace=us&sort=-monthly_search_volume_exact&page[size]=100`,
      {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/vnd.api+json',
          'Accept': 'application/vnd.junglescout.v1+json',
          'X-API-Type': 'junglescout',
        },
        body: JSON.stringify({
          data: {
            type: 'keywords_by_asin_query',
            attributes: {
              asins: batch,
              include_variants: false,
            },
          },
        }),
      }
    );

    await logApiCall('jungle_scout', 'keywords_by_asin_query', batch, resp.status);

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[jungleScoutClient] API error ${resp.status}: ${err}`);
      if (resp.status === 401 || resp.status === 403) {
        invalidateCredentialsCache();
      }
      return result;
    }

    const data = await resp.json();
    const items = data?.data ?? [];
    console.log(`[jungleScoutClient] Received ${items.length} keywords for ASINs: ${batch.join(', ')}`);

    for (const item of items) {
      const attrs = item.attributes ?? {};
      const keyword = attrs.name ?? '';
      if (!keyword) continue;

      const row: JungleScoutKeywordRow = {
        keyword,
        searchVolume: attrs.monthly_search_volume_exact ?? 0,
        organicProductCount: attrs.organic_product_count ?? 0,
        sponsoredProductCount: attrs.sponsored_product_count ?? 0,
        exactPpcBid: attrs.ppc_bid_exact ?? undefined,
        broadPpcBid: attrs.ppc_bid_broad ?? undefined,
        relevancyScore: attrs.relevancy_score ?? undefined,
        easeOfRankingScore: attrs.ease_of_ranking_score ?? undefined,
        monthlyTrend: attrs.monthly_trend ?? undefined,
        organicRank: attrs.organic_rank ?? undefined,
        primaryAsin: attrs.primary_asin ?? undefined,
      };

      // Use primary_asin from response to associate keyword with the right ASIN
      const targetAsin = attrs.primary_asin && batch.includes(attrs.primary_asin)
        ? attrs.primary_asin
        : batch[0];

      if (!result.has(targetAsin)) result.set(targetAsin, []);
      result.get(targetAsin)!.push(row);
    }

    for (const asin of batch) {
      const keywords = result.get(asin) ?? [];
      if (keywords.length > 0) {
        await setCachedKeywords(asin, 'jungle_scout', keywords);
        console.log(`[jungleScoutClient] Cached ${keywords.length} keywords for ASIN ${asin}`);
      }
    }

  } catch (err) {
    console.error('[jungleScoutClient] Fetch error:', err);
    await logApiCall('jungle_scout', 'keywords_by_asin_query', batch, 500);
  }

  return result;
}

export async function reverseAsinLookup(
  competitorAsin: string
): Promise<JungleScoutKeywordRow[]> {
  const result = await fetchKeywordsByASIN([competitorAsin]);
  return result.get(competitorAsin) ?? [];
}

// ─── Keywords by Keyword (Keyword Research) ──────────────────────────────────

/**
 * Fetch related keywords for a single seed keyword using JS keywords_by_keyword_query.
 *
 * This is the CORE of the new vision-first keyword research pipeline:
 * - Input: a single search term (e.g., "later gator tshirt")
 * - Output: up to 100 related keywords with search volume, competition, trends
 *
 * Cost: 1 API credit per call.
 * Use case: Call this 3-5 times with different seed terms from the vision scanner
 * to build a comprehensive keyword universe for the product.
 */
export async function fetchKeywordsByKeyword(
  searchTerm: string,
  options: { pageSize?: number; minSearchVolume?: number } = {}
): Promise<JungleScoutKeywordRow[]> {
  const { pageSize = 100, minSearchVolume = 0 } = options;

  const creds = await getCredentials();
  if (!creds.enabled) {
    console.warn('[jungleScoutClient] Jungle Scout API not enabled.');
    return [];
  }

  const budget = await isWithinBudget('jungle_scout');
  if (!budget.allowed) {
    console.warn(`[jungleScoutClient] Monthly budget exhausted`);
    return [];
  }

  try {
    const authHeader = `${creds.keyName}:${creds.apiKey}`;

    // Filter by minimum search volume if specified
    const filterParams = minSearchVolume > 0
      ? `&filter[min_monthly_search_volume_exact]=${minSearchVolume}`
      : '';

    const resp = await fetch(
      `${JS_BASE_URL}/api/keywords/keywords_by_keyword_query?marketplace=us&sort=-monthly_search_volume_exact&page[size]=${pageSize}${filterParams}`,
      {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/vnd.api+json',
          'Accept': 'application/vnd.junglescout.v1+json',
          'X-API-Type': 'junglescout',
        },
        body: JSON.stringify({
          data: {
            type: 'keywords_by_keyword_query',
            attributes: {
              search_terms: searchTerm,
            },
          },
        }),
      }
    );

    await logApiCall('jungle_scout', 'keywords_by_keyword_query', [searchTerm], resp.status);

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[jungleScoutClient] keywords_by_keyword API error ${resp.status}: ${err}`);
      if (resp.status === 401 || resp.status === 403) {
        invalidateCredentialsCache();
      }
      return [];
    }

    const data = await resp.json();
    const items = data?.data ?? [];
    console.log(`[jungleScoutClient] keywords_by_keyword: "${searchTerm}" → ${items.length} related keywords`);

    const results: JungleScoutKeywordRow[] = [];

    for (const item of items) {
      const attrs = item.attributes ?? {};
      const keyword = attrs.name ?? '';
      if (!keyword) continue;

      results.push({
        keyword,
        searchVolume: attrs.monthly_search_volume_exact ?? 0,
        organicProductCount: attrs.organic_product_count ?? 0,
        sponsoredProductCount: attrs.sponsored_product_count ?? 0,
        exactPpcBid: attrs.ppc_bid_exact ?? undefined,
        broadPpcBid: attrs.ppc_bid_broad ?? undefined,
        relevancyScore: attrs.relevancy_score ?? undefined,
        easeOfRankingScore: attrs.ease_of_ranking_score ?? undefined,
        monthlyTrend: attrs.monthly_trend ?? undefined,
      });
    }

    return results;

  } catch (err) {
    console.error('[jungleScoutClient] keywords_by_keyword fetch error:', err);
    await logApiCall('jungle_scout', 'keywords_by_keyword_query', [searchTerm], 500);
    return [];
  }
}

// ─── Share of Voice (Auto-Competitor Detection) ─────────────────────────────

export interface ShareOfVoiceCompetitor {
  asin: string;
  brand: string;
  clicksShare: number;
  conversionsShare: number;
}

/**
 * Fetch Share of Voice data for a keyword.
 * Returns the top ASINs dominating clicks/conversions for this search term.
 *
 * Cost: 1 API credit per call.
 * Use case: Auto-detect the #1 competitor without manual ASIN input.
 */
export async function fetchShareOfVoice(
  keyword: string
): Promise<ShareOfVoiceCompetitor[]> {
  const creds = await getCredentials();
  if (!creds.enabled) {
    console.warn('[jungleScoutClient] Jungle Scout API not enabled.');
    return [];
  }

  const budget = await isWithinBudget('jungle_scout');
  if (!budget.allowed) {
    console.warn(`[jungleScoutClient] Monthly budget exhausted`);
    return [];
  }

  try {
    const authHeader = `${creds.keyName}:${creds.apiKey}`;

    const encodedKeyword = encodeURIComponent(keyword);
    const resp = await fetch(
      `${JS_BASE_URL}/api/share_of_voice?marketplace=us&keyword=${encodedKeyword}`,
      {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/vnd.api+json',
          'Accept': 'application/vnd.junglescout.v1+json',
          'X-API-Type': 'junglescout',
        },
      }
    );

    await logApiCall('jungle_scout', 'share_of_voice', [keyword], resp.status);

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[jungleScoutClient] share_of_voice API error ${resp.status}: ${err}`);
      if (resp.status === 401 || resp.status === 403) {
        invalidateCredentialsCache();
      }
      return [];
    }

    const data = await resp.json();
    // Response: data.attributes.top_asins[] → { asin, name, brand, clicks, conversions, conversion_rate }
    // Note: clicks/conversions are raw integers, not percentages
    const topAsins: Record<string, unknown>[] = data?.data?.attributes?.top_asins ?? [];
    console.log(`[jungleScoutClient] share_of_voice: "${keyword}" → ${topAsins.length} competitors`);

    // Calculate total clicks to derive share percentages
    const totalClicks = topAsins.reduce((sum, item) => sum + ((item.clicks as number) || 0), 0);
    const totalConversions = topAsins.reduce((sum, item) => sum + ((item.conversions as number) || 0), 0);

    return topAsins.map((item: Record<string, unknown>) => ({
      asin: (item.asin as string) || '',
      brand: (item.brand as string) || (item.name as string) || '',
      clicksShare: totalClicks > 0 ? ((item.clicks as number) || 0) / totalClicks : 0,
      conversionsShare: totalConversions > 0 ? ((item.conversions as number) || 0) / totalConversions : 0,
    }));

  } catch (err) {
    console.error('[jungleScoutClient] share_of_voice fetch error:', err);
    await logApiCall('jungle_scout', 'share_of_voice', [keyword], 500);
    return [];
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

export async function getJungleScoutStatus(): Promise<{
  enabled: boolean;
  message: string;
}> {
  const creds = await getCredentials();
  if (!creds.enabled) {
    return {
      enabled: false,
      message: 'Jungle Scout API not configured. Go to Settings → Jungle Scout API to enter your credentials.',
    };
  }
  return {
    enabled: true,
    message: `Jungle Scout API active (key: ${creds.keyName}) — competitor keyword research available.`,
  };
}
