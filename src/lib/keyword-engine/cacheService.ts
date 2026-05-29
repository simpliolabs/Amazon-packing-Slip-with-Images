/**
 * cacheService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages keyword cache reads and writes in the `keyword_cache` and
 * `keyword_analysis` tables.
 *
 * Cache TTL: 30 days (keyword data doesn't change dramatically week-to-week)
 * Budget protection: checks api_usage_log before allowing any external call
 *
 * Karpathy principle: Simplicity first. Cache miss = fetch. Cache hit = return.
 * No complex invalidation logic — TTL is the only rule.
 */

import { createClient } from '@supabase/supabase-js';
import { AnalyzedKeyword, EngineResult } from './engine';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Budget Constants ─────────────────────────────────────────────────────────
const JUNGLE_SCOUT_MONTHLY_BUDGET = 950; // Hard cap (50 below the 1,000 plan limit)
const CACHE_TTL_DAYS = 30;

// ─── Cache Read ───────────────────────────────────────────────────────────────

/**
 * Check if fresh cached keyword data exists for an ASIN + source.
 * Returns null if cache miss or expired.
 */
export async function getCachedKeywords(
  asin: string,
  source: 'sqp' | 'jungle_scout'
): Promise<unknown[] | null> {
  const { data, error } = await supabase
    .from('keyword_cache')
    .select('keyword_data, expires_at')
    .eq('asin', asin)
    .eq('source', source)
    .single();

  if (error || !data) return null;

  // Check TTL
  if (new Date(data.expires_at) < new Date()) {
    // Expired — delete stale entry
    await supabase
      .from('keyword_cache')
      .delete()
      .eq('asin', asin)
      .eq('source', source);
    return null;
  }

  return data.keyword_data as unknown[];
}

// ─── Cache Write ──────────────────────────────────────────────────────────────

/**
 * Store raw keyword API response in the cache.
 * Uses upsert to handle re-fetches cleanly.
 */
export async function setCachedKeywords(
  asin: string,
  source: 'sqp' | 'jungle_scout',
  keywordData: unknown[]
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

  await supabase
    .from('keyword_cache')
    .upsert(
      {
        asin,
        source,
        keyword_data: keywordData,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
      },
      { onConflict: 'asin,source' }
    );
}

// ─── Analysis Storage ─────────────────────────────────────────────────────────

/**
 * Persist analyzed keyword results to keyword_analysis table.
 * Uses upsert on (asin, keyword) to handle re-analysis cleanly.
 */
export async function storeAnalysis(
  asin: string,
  keywords: AnalyzedKeyword[]
): Promise<void> {
  if (!keywords || keywords.length === 0) return;

  const rows = keywords.map(kw => ({
    asin,
    keyword: kw.keyword,
    opportunity_score: kw.opportunityScore,
    action_type: kw.actionType,
    action_text: kw.actionText,
    in_title: kw.inTitle,
    in_bullets: kw.inBullets,
    in_description: kw.inDescription,
    in_backend: kw.inBackend,
    search_volume: kw.searchVolume,
    competing_products: kw.competingProducts,
    keyword_sales: kw.keywordSales,
    data_source: kw.dataSource,
    analyzed_at: new Date().toISOString(),
  }));

  // Batch upsert in chunks of 100 to avoid payload limits
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await supabase
      .from('keyword_analysis')
      .upsert(chunk, { onConflict: 'asin,keyword' });
  }
}

/**
 * Retrieve stored analysis for an ASIN from the DB.
 * Returns null if no analysis exists yet.
 */
export async function getStoredAnalysis(
  asin: string,
  topN = 25
): Promise<AnalyzedKeyword[] | null> {
  const { data, error } = await supabase
    .from('keyword_analysis')
    .select('*')
    .eq('asin', asin)
    .order('opportunity_score', { ascending: false })
    .limit(topN);

  if (error || !data || data.length === 0) return null;

  return data.map(row => ({
    keyword: row.keyword,
    opportunityScore: row.opportunity_score,
    actionType: row.action_type,
    actionText: row.action_text ?? '',
    rationale: '',
    urgency: row.opportunity_score >= 50 ? 'high' : row.opportunity_score >= 25 ? 'medium' : 'low',
    estimatedImpact: '',
    searchVolume: row.search_volume ?? 0,
    keywordSales: row.keyword_sales ?? 0,
    competingProducts: row.competing_products ?? 0,
    asinImpressionShare: 0,
    asinClickShare: 0,
    asinPurchaseShare: 0,
    inTitle: row.in_title,
    inBullets: row.in_bullets,
    inDescription: row.in_description,
    inBackend: row.in_backend,
    dataSource: row.data_source,
  }));
}

// ─── API Budget Protection ────────────────────────────────────────────────────

/**
 * Log an external API call for budget tracking.
 */
export async function logApiCall(
  provider: 'jungle_scout' | 'sqp',
  endpoint: string,
  asins: string[],
  responseStatus: number
): Promise<void> {
  await supabase.from('api_usage_log').insert({
    provider,
    endpoint,
    asins_requested: asins,
    response_status: responseStatus,
    called_at: new Date().toISOString(),
  });
}

/**
 * Check if we're within the Jungle Scout API budget for this month.
 * Returns true if a call is allowed, false if budget is exhausted.
 */
export async function isWithinBudget(
  provider: 'jungle_scout' | 'sqp'
): Promise<{ allowed: boolean; callsUsed: number; callsRemaining: number }> {
  if (provider === 'sqp') {
    // SQP is free — always allowed
    return { allowed: true, callsUsed: 0, callsRemaining: 999999 };
  }

  const { data } = await supabase
    .from('api_usage_this_month')
    .select('calls_used')
    .eq('provider', 'jungle_scout')
    .single();

  const callsUsed = data?.calls_used ?? 0;
  const callsRemaining = JUNGLE_SCOUT_MONTHLY_BUDGET - callsUsed;

  return {
    allowed: callsRemaining > 0,
    callsUsed,
    callsRemaining,
  };
}

/**
 * Get current API usage stats for the UI meter.
 */
export async function getApiUsageStats(): Promise<{
  jungleScout: { callsUsed: number; budget: number; percentUsed: number };
}> {
  const { data } = await supabase
    .from('api_usage_this_month')
    .select('provider, calls_used');

  const jsRow = data?.find(r => r.provider === 'jungle_scout');
  const callsUsed = jsRow?.calls_used ?? 0;

  return {
    jungleScout: {
      callsUsed,
      budget: JUNGLE_SCOUT_MONTHLY_BUDGET,
      percentUsed: Math.round((callsUsed / JUNGLE_SCOUT_MONTHLY_BUDGET) * 100),
    },
  };
}
