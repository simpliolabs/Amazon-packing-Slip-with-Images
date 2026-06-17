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
const JUNGLE_SCOUT_MONTHLY_BUDGET = 950; // Hard cap — keyword research PAUSES here (isWithinBudget)
const JUNGLE_SCOUT_PLAN_LIMIT = 1000;    // The paid plan's monthly call limit; JS bills $0.05/call ABOVE this.
const JS_WARN_AT_PCT = 80;               // PO 2026-06-15: surface a usage warning at 80% of the cap, so we see overages coming.
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

  // ONE timestamp for the whole run — every row written below carries it, and the stale-prune at
  // the END deletes only this ASIN's NATIVE rows OLDER than it. This replaces the old
  // delete-THEN-upsert order, which left keyword_analysis EMPTY if the process died between the
  // delete and the upsert — a Coolify redeploy 502 mid-regen wiped B0G884ZJ27's Intelligence tab
  // (2026-06-17). Upsert-first is interrupt-safe: an interrupt leaves stale rows, never an empty set.
  const runTs = new Date().toISOString();
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
    title_density: kw.titleDensity ?? null,
    organic_rank: kw.organicRank ?? null,
    data_source: kw.dataSource,
    analyzed_at: runTs,
  }));

  // Batch UPSERT FIRST in chunks of 100 (upsert, not insert: a surviving imported row with the same
  // keyword must not abort the whole chunk — unique (asin, keyword)). Doing this BEFORE any delete
  // guarantees the analysis is never momentarily empty.
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('keyword_analysis')
      .upsert(chunk, { onConflict: 'asin,keyword' });
    if (error && (error.code === '42703' || error.code === 'PGRST204' || /title_density|organic_rank/i.test(error.message ?? ''))) {
      // Migration 025/026 (title_density / organic_rank) not applied yet — NEVER let a new
      // column break a native sync: retry without them (same fallback pattern as logPush).
      const legacy = chunk.map((row) => {
        const { title_density: _omitTd, organic_rank: _omitRank, ...rest } = row;
        return rest;
      });
      await supabase.from('keyword_analysis').upsert(legacy, { onConflict: 'asin,keyword' });
    } else if (error) {
      console.warn('[storeAnalysis] upsert failed:', error.message);
    }
  }

  // STALE-PRUNE (interrupt-safe cleanup): drop this ASIN's NATIVE rows NOT refreshed this run
  // (older analyzed_at). Imports (data_source='import') are always preserved — the seller's H10
  // competitor research (PR #176) must survive native re-syncs; a keyword collision already let the
  // fresh native row win in the upsert above ("graduating" an import to native). Runs AFTER the
  // upsert, so an interrupt before this point keeps stale rows rather than emptying the analysis.
  await supabase
    .from('keyword_analysis')
    .delete()
    .eq('asin', asin)
    .neq('data_source', 'import')
    .lt('analyzed_at', runTs);
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
    titleDensity: row.title_density ?? null,
    organicRank: row.organic_rank ?? null,
  }));
}

/**
 * Rank tracker capture (PO: "track OUR ranking keywords over time"): one snapshot row per
 * (asin, keyword, DAY) of our Jungle Scout organic rank — same-day re-runs collapse via upsert.
 * organic_rank NULL = checked-but-not-ranking (the row's presence still marks the check, so the
 * series shows when we entered/left the rankings). Best-effort: a missing table (migration 026
 * not applied) must never break a keyword sync — mirrors the share-snapshots contract (#162).
 */
export async function captureRankSnapshots(
  asin: string,
  rows: { keyword: string; organicRank?: number | null; searchVolume?: number | null }[]
): Promise<void> {
  if (!rows || rows.length === 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const snaps = rows
    .filter((r) => r.keyword && r.keyword.trim())
    .map((r) => ({
      asin,
      keyword: r.keyword.toLowerCase().trim(),
      snapshot_date: today,
      organic_rank: (r.organicRank ?? 0) > 0 ? r.organicRank : null,
      search_volume: r.searchVolume ?? null,
    }));
  if (snaps.length === 0) return;
  try {
    for (let i = 0; i < snaps.length; i += 100) {
      const { error } = await supabase
        .from('keyword_rank_snapshots')
        .upsert(snaps.slice(i, i + 100), { onConflict: 'asin,keyword,snapshot_date' });
      if (error) {
        console.warn('[captureRankSnapshots] upsert failed (non-fatal):', error.message);
        return;
      }
    }
  } catch (e) {
    console.warn('[captureRankSnapshots] failed (non-fatal):', e instanceof Error ? e.message : e);
  }
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
  jungleScout: {
    callsUsed: number; budget: number; percentUsed: number; remaining: number; planLimit: number;
    warningLevel: 'ok' | 'approaching' | 'critical' | 'paused'; warningMessage: string;
  };
}> {
  const { data } = await supabase
    .from('api_usage_this_month')
    .select('provider, calls_used');

  const jsRow = data?.find(r => r.provider === 'jungle_scout');
  const callsUsed = jsRow?.calls_used ?? 0;
  const percentUsed = Math.round((callsUsed / JUNGLE_SCOUT_MONTHLY_BUDGET) * 100);
  const remaining = Math.max(0, JUNGLE_SCOUT_MONTHLY_BUDGET - callsUsed);

  // PO 2026-06-15: warn BEFORE the plan's overage kicks in. The 950 cap pauses research 50 calls below
  // the 1,000-call plan limit (overage = $0.05/call above 1,000), so escalate as we approach the cap.
  let warningLevel: 'ok' | 'approaching' | 'critical' | 'paused' = 'ok';
  let warningMessage = '';
  if (callsUsed >= JUNGLE_SCOUT_MONTHLY_BUDGET) {
    warningLevel = 'paused';
    warningMessage = `Jungle Scout monthly cap reached (${callsUsed}/${JUNGLE_SCOUT_MONTHLY_BUDGET}). Keyword research is PAUSED to avoid $0.05/call overages — it resets next month, or raise the cap to continue into overages.`;
  } else if (percentUsed >= 90) {
    warningLevel = 'critical';
    warningMessage = `${callsUsed}/${JUNGLE_SCOUT_MONTHLY_BUDGET} Jungle Scout calls used (${percentUsed}%) — research pauses at ${JUNGLE_SCOUT_MONTHLY_BUDGET}, ${JUNGLE_SCOUT_PLAN_LIMIT - JUNGLE_SCOUT_MONTHLY_BUDGET} calls before $0.05/call overages.`;
  } else if (percentUsed >= JS_WARN_AT_PCT) {
    warningLevel = 'approaching';
    warningMessage = `${callsUsed}/${JUNGLE_SCOUT_MONTHLY_BUDGET} Jungle Scout calls used (${percentUsed}%) this month — approaching the monthly cap.`;
  }

  return {
    jungleScout: {
      callsUsed,
      budget: JUNGLE_SCOUT_MONTHLY_BUDGET,
      percentUsed,
      remaining,
      planLimit: JUNGLE_SCOUT_PLAN_LIMIT,
      warningLevel,
      warningMessage,
    },
  };
}
