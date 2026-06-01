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

// Cache credentials in memory for 5 minutes to avoid DB round-trips on every call
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
      credentialsCache = { value: creds, expiresAt: Date.now() + 5 * 60 * 1000 };
      return creds;
    }
  } catch (err) {
    console.warn('[jungleScoutClient] Could not load credentials from DB, falling back to env vars:', err);
  }

  const apiKey = process.env.JUNGLE_SCOUT_API_KEY ?? '';
  const keyName = process.env.JUNGLE_SCOUT_API_NAME ?? '';
  const enabled = process.env.JUNGLE_SCOUT_ENABLED === 'true' && !!apiKey && !!keyName;

  const creds: JsCredentials = { enabled, apiKey, keyName };
  credentialsCache = { value: creds, expiresAt: Date.now() + 5 * 60 * 1000 };
  return creds;
}

export function invalidateCredentialsCache(): void {
  credentialsCache = null;
}

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
