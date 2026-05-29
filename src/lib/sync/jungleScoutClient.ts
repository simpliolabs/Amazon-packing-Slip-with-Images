/**
 * jungleScoutClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Jungle Scout API client — SCAFFOLDED, NOT ACTIVE.
 *
 * This module is ready to activate once the Jungle Scout API key is added
 * to environment variables. Until then, all functions return empty arrays
 * and log a warning.
 *
 * Activation checklist:
 *   1. Add JUNGLE_SCOUT_API_KEY to .env.local and Hostinger env vars
 *   2. Add JUNGLE_SCOUT_API_NAME to .env.local (your JS account name)
 *   3. Set JUNGLE_SCOUT_ENABLED=true in .env.local
 *   4. The isEnabled() check below will automatically activate the client
 *
 * API docs: https://developer.junglescout.com/api/keywords/
 * Plan required: Growth Accelerator ($49/mo) + API Tier 1 ($29/mo)
 *
 * Karpathy principle: Simplicity first. Don't activate until needed.
 */

import {
  JungleScoutKeywordRow,
  isWithinBudget,
  logApiCall,
  setCachedKeywords,
} from '../keyword-engine';

const JS_BASE_URL = 'https://developer.junglescout.com/api';

function isEnabled(): boolean {
  return process.env.JUNGLE_SCOUT_ENABLED === 'true'
    && !!process.env.JUNGLE_SCOUT_API_KEY
    && !!process.env.JUNGLE_SCOUT_API_NAME;
}

function getAuthHeader(): string {
  const key = process.env.JUNGLE_SCOUT_API_KEY!;
  const name = process.env.JUNGLE_SCOUT_API_NAME!;
  // JS uses Base64-encoded "name:key" for auth
  const encoded = Buffer.from(`${name}:${key}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Fetch keywords for up to 10 ASINs in a single API call.
 * Returns up to 100 keywords per call.
 *
 * Budget: 1 call consumed per invocation regardless of ASIN count.
 * Batch up to 10 ASINs to maximize efficiency.
 */
export async function fetchKeywordsByASIN(
  asins: string[]
): Promise<Map<string, JungleScoutKeywordRow[]>> {
  const result = new Map<string, JungleScoutKeywordRow[]>();

  if (!isEnabled()) {
    console.warn('[jungleScoutClient] Jungle Scout API not enabled. Set JUNGLE_SCOUT_ENABLED=true to activate.');
    return result;
  }

  // Budget check
  const budget = await isWithinBudget('jungle_scout');
  if (!budget.allowed) {
    console.warn(`[jungleScoutClient] Monthly budget exhausted (${budget.callsUsed}/${budget.callsUsed + budget.callsRemaining} calls used)`);
    return result;
  }

  // Batch: max 10 ASINs per call
  const batch = asins.slice(0, 10);

  try {
    const resp = await fetch(
      `${JS_BASE_URL}/keywords/keywords_by_asin_query?marketplace=us&sort=-monthly_trend&page[size]=100`,
      {
        method: 'POST',
        headers: {
          'Authorization': getAuthHeader(),
          'Content-Type': 'application/json',
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
      return result;
    }

    const data = await resp.json();

    // Parse response and group by ASIN
    for (const item of data?.data ?? []) {
      const attrs = item.attributes ?? {};
      const keyword = attrs.name ?? '';
      const row: JungleScoutKeywordRow = {
        keyword,
        searchVolume: attrs.monthly_search_volume_exact ?? 0,
        organicProductCount: attrs.organic_product_count ?? 0,
        sponsoredProductCount: attrs.sponsored_product_count ?? 0,
        exactPpcBid: attrs.ppc_bid_exact ?? undefined,
        broadPpcBid: attrs.ppc_bid_broad ?? undefined,
        relevancyScore: attrs.relevancy_score ?? undefined,
      };

      // JS returns keywords relevant to the queried ASINs
      // Associate each keyword with all queried ASINs (they all rank for it)
      for (const asin of batch) {
        if (!result.has(asin)) result.set(asin, []);
        result.get(asin)!.push(row);
      }
    }

    // Cache results for each ASIN
    for (const asin of batch) {
      const keywords = result.get(asin) ?? [];
      if (keywords.length > 0) {
        await setCachedKeywords(asin, 'jungle_scout', keywords);
      }
    }

  } catch (err) {
    console.error('[jungleScoutClient] Fetch error:', err);
    await logApiCall('jungle_scout', 'keywords_by_asin_query', batch, 500);
  }

  return result;
}

/**
 * Reverse ASIN lookup: get keywords for a competitor ASIN.
 * Same API endpoint — just pass the competitor's ASIN.
 */
export async function reverseAsinLookup(
  competitorAsin: string
): Promise<JungleScoutKeywordRow[]> {
  const result = await fetchKeywordsByASIN([competitorAsin]);
  return result.get(competitorAsin) ?? [];
}

/**
 * Get current Jungle Scout API status for display in the UI.
 */
export function getJungleScoutStatus(): {
  enabled: boolean;
  message: string;
} {
  if (!isEnabled()) {
    return {
      enabled: false,
      message: 'Jungle Scout API not configured. Add JUNGLE_SCOUT_API_KEY to env vars to enable competitor keyword research.',
    };
  }
  return {
    enabled: true,
    message: 'Jungle Scout API active — competitor keyword research available.',
  };
}
