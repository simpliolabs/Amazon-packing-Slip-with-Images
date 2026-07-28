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
import {
  selectionMode,
  selectRankingTargets,
  type SelectionContext,
  type ThemeBand,
} from './selection-core';

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

/** What the rater produced this run, keyed by keyword. */
export type ThemeRatings = ReadonlyMap<string, { band: ThemeBand; about: string }>;

/**
 * KEYWORD_TARGET_SET (#143) write-side options. ALL optional — every existing caller keeps working
 * unchanged and writes the legacy 15-column payload.
 */
export interface StoreAnalysisOpts {
  /**
   * The listing's SelectionContext. `null` is a MEANINGFUL SIGNAL, not merely "absent": the
   * relevance gate's outer catch returns null to say "I could not establish context", and this
   * function then routes through the legacy branch. Defaulting a failed context to
   * INERT_SELECTION_CONTEXT instead would silently persist a target set computed against
   * `designSeasons: []` — i.e. it would route a Valentine design's own Valentine keywords to
   * BACKEND and persist that as truth. Absent context ⇒ write nothing, never guess.
   */
  ctx?: SelectionContext | null;
  /** This run's rater output. Absent/empty is fine — prior bands carry forward (see below). */
  ratings?: ThemeRatings | null;
  themeRunId?: string | null;
  /** Escape hatch for callers that persist a PARTIAL pool and must not recompute selection. */
  skipTargetSet?: boolean;
}

/** Prior per-keyword signals, plus whether the read actually SUCCEEDED. */
type PriorSignals = {
  ok: boolean;
  map: Map<string, { themeFit: ThemeBand | null; themeAbout: string | null; themeRunId: string | null; selectionRank: number | null }>;
};

/**
 * Read the signals already persisted for this ASIN so they can be carried forward.
 *
 * WHY STICKY. `theme_fit` costs an LLM call and is produced ONLY on a full research run, but
 * `storeAnalysis` is also called by the ungated SQP writer, the SQP-wins merge and the SQP cron —
 * none of which rate anything. Without carry-forward each of those would blank every band it
 * touched, and the next selector run would see an all-unrated pool.
 *
 * `ok` IS THE LOAD-BEARING FIELD (adversarial review, FATAL). A transient read failure returns an
 * EMPTY map, which is indistinguishable from "genuinely nothing stored" — and if this run's rater
 * also degraded, every row would then write `theme_fit: null` and ERASE the whole ASIN's ratings.
 * That is the "empty PERSISTED over approved copy" shape at column granularity. So a FAILED read
 * disables target-set writing for this run entirely: stale signals survive, nothing is erased.
 */
async function readPriorSignals(asin: string): Promise<PriorSignals> {
  const map: PriorSignals['map'] = new Map();
  try {
    const { data, error } = await supabase
      .from('keyword_analysis')
      .select('keyword, theme_fit, theme_about, theme_run_id, selection_rank')
      .eq('asin', asin);
    // A missing-column error here means migration 049 has not landed. That is NOT a failure — there
    // is genuinely nothing to carry forward — so report ok:true with an empty map and let the write
    // proceed (its own fallback strips the columns).
    if (error) {
      const missingCol = error.code === '42703' || error.code === 'PGRST204'
        || /theme_fit|theme_about|theme_run_id|selection_rank/i.test(error.message ?? '');
      return { ok: missingCol, map };
    }
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const kw = typeof r.keyword === 'string' ? r.keyword : null;
      if (!kw) continue;
      const tf = r.theme_fit;
      map.set(kw, {
        themeFit: tf === 0 || tf === 1 || tf === 2 || tf === 3 ? (tf as ThemeBand) : null,
        themeAbout: typeof r.theme_about === 'string' ? r.theme_about : null,
        themeRunId: typeof r.theme_run_id === 'string' ? r.theme_run_id : null,
        selectionRank: typeof r.selection_rank === 'number' ? r.selection_rank : null,
      });
    }
    return { ok: true, map };
  } catch {
    return { ok: false, map };
  }
}

/**
 * Persist analyzed keyword results to keyword_analysis table.
 * Uses upsert on (asin, keyword) to handle re-analysis cleanly.
 */
export async function storeAnalysis(
  asin: string,
  keywords: AnalyzedKeyword[],
  opts?: StoreAnalysisOpts
): Promise<void> {
  if (!keywords || keywords.length === 0) return;

  // ONE timestamp for the whole run — every row written below carries it, and the stale-prune at
  // the END deletes only this ASIN's NATIVE rows OLDER than it. This replaces the old
  // delete-THEN-upsert order, which left keyword_analysis EMPTY if the process died between the
  // delete and the upsert — a Coolify redeploy 502 mid-regen wiped B0G884ZJ27's Intelligence tab
  // (2026-06-17). Upsert-first is interrupt-safe: an interrupt leaves stale rows, never an empty set.
  const runTs = new Date().toISOString();

  /* ── KEYWORD_TARGET_SET (#143) ───────────────────────────────────────────────────────────────
   * WRITES happen at shadow AND on; every READ stays gated on `on` (doctrine 2). That asymmetry is
   * the whole reason the flip is a pure read-side change: by the time the flag flips, the columns
   * are already populated and correct, so `on` has nothing to compute and `off` has nothing to
   * undo.
   *
   * `ctx == null` disables the write — see StoreAnalysisOpts.ctx. So does a FAILED prior-signal
   * read, because a partial view of the existing signals cannot be safely written back.
   */
  const mode = selectionMode();
  const wantTargets = mode !== 'off' && !opts?.skipTargetSet && opts?.ctx != null;
  const prior = wantTargets ? await readPriorSignals(asin) : { ok: false, map: new Map() } as PriorSignals;
  const writeTargets = wantTargets && prior.ok;

  let rows: Record<string, unknown>[];

  if (!writeTargets) {
    // LEGACY PAYLOAD — byte-identical to pre-#143. This is the `off` path and every fail-open path.
    rows = keywords.map(kw => ({
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
    if (wantTargets && !prior.ok) {
      // Named explicitly: this run had context and (maybe) ratings but could not read what was
      // already stored, so it declined to write rather than risk erasing it.
      console.warn(`[storeAnalysis] KEYWORD_TARGET_SET skipped for ${asin}: prior-signal read failed (preserving stored signals)`);
    }
  } else {
    // MERGE: this run's ratings win; anything unrated inherits the prior band. An LLM that rated
    // 40 of 118 keywords must not blank the other 78.
    const ratings = opts?.ratings ?? null;
    const runId = opts?.themeRunId ?? null;
    const merged = keywords.map((kw) => {
      const fresh = ratings?.get(kw.keyword);
      const prev = prior.map.get(kw.keyword);
      return {
        kw,
        themeFit: (fresh ? fresh.band : prev?.themeFit ?? null) as ThemeBand | null,
        themeAbout: fresh ? fresh.about : prev?.themeAbout ?? null,
        themeRunId: fresh ? runId : prev?.themeRunId ?? null,
        prevSelectionRank: prev?.selectionRank ?? null,
      };
    });

    // SELECT over the FULL pool — never a LIMIT window. This is the one place selection is
    // computed; every reader just sorts by the rank persisted here.
    const verdict = selectRankingTargets(
      merged.map((m) => ({
        keyword: m.kw.keyword,
        searchVolume: m.kw.searchVolume,
        keywordSales: m.kw.keywordSales,
        competingProducts: m.kw.competingProducts,
        organicRank: m.kw.organicRank ?? null,
        actionType: m.kw.actionType,
        themeFit: m.themeFit,
        themeAbout: m.themeAbout,
        prevSelectionRank: m.prevSelectionRank,
      })),
      opts!.ctx!,
    );

    rows = merged.map((m) => ({
      asin,
      keyword: m.kw.keyword,
      opportunity_score: m.kw.opportunityScore,
      action_type: m.kw.actionType,
      action_text: m.kw.actionText,
      in_title: m.kw.inTitle,
      in_bullets: m.kw.inBullets,
      in_description: m.kw.inDescription,
      in_backend: m.kw.inBackend,
      search_volume: m.kw.searchVolume,
      competing_products: m.kw.competingProducts,
      keyword_sales: m.kw.keywordSales,
      title_density: m.kw.titleDensity ?? null,
      organic_rank: m.kw.organicRank ?? null,
      data_source: m.kw.dataSource,
      analyzed_at: runTs,
      // Sticky judgment signals.
      theme_fit: m.themeFit,
      theme_about: m.themeAbout,
      theme_run_id: m.themeRunId,
      // DERIVED selection — recomputed every run, so null here is a demotion by arithmetic, never a
      // persisted verdict. Non-targets get null: that is the membership predicate, not data loss.
      selection_rank: verdict.rankOf.get(m.kw.keyword) ?? null,
      selection_slot: verdict.slotOf.get(m.kw.keyword) ?? null,
      selection_reason: verdict.reasonOf.get(m.kw.keyword) ?? null,
    }));

    console.log(JSON.stringify({
      tag: 'KW_TARGET_SET',
      asin,
      mode,
      pool: keywords.length,
      targets: verdict.targets.length,
      guard: verdict.guard,
      slots: verdict.slotCounts,
      bands: verdict.bands,
      backstop: verdict.backstopCount,
      rescued: verdict.rescuedCount,
      sha: verdict.sha,
      rated: ratings?.size ?? 0,
      carriedForward: merged.filter((m) => m.themeFit !== null && !ratings?.has(m.kw.keyword)).length,
    }));
  }

  // Batch UPSERT FIRST in chunks of 100 (upsert, not insert: a surviving imported row with the same
  // keyword must not abort the whole chunk — unique (asin, keyword)). Doing this BEFORE any delete
  // guarantees the analysis is never momentarily empty.
  const chunkSize = 100;
  // Did ANY chunk actually land? The stale-prune below is keyed on `analyzed_at < runTs`, so if
  // every upsert failed there is nothing carrying runTs and the prune would delete the ASIN's
  // ENTIRE native pool. That is the "empty PERSISTED over approved copy" incident shape, and it
  // predates this PR — but a 21-column payload has strictly more ways to fail than a 15-column one,
  // so shipping the wider write without this guard would make a latent bug reachable.
  // UNCONDITIONAL (not flag-gated): it only ever fires when the write already failed, so it changes
  // nothing in normal operation at any mode, and doctrine 3 (fail-open, never empty) outranks
  // byte-identity in an error path.
  let wroteAny = false;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('keyword_analysis')
      .upsert(chunk, { onConflict: 'asin,keyword' });
    if (!error) { wroteAny = true; continue; }

    // Migration 025/026 (title_density / organic_rank) or 049 (the six target-set columns) not
    // applied yet — NEVER let a new column break a native sync: retry without them (same fallback
    // pattern as logPush). 23514 is added for 049's CHECK constraints: a half-applied migration can
    // have the column without the constraint, or reject a band the code considers valid.
    const missingCol = error.code === '42703' || error.code === 'PGRST204' || error.code === '23514'
      || /title_density|organic_rank|theme_fit|theme_about|theme_run_id|selection_rank|selection_slot|selection_reason/i.test(error.message ?? '');
    if (missingCol) {
      const legacy = chunk.map((row) => {
        const {
          title_density: _omitTd, organic_rank: _omitRank,
          theme_fit: _f, theme_about: _a, theme_run_id: _r,
          selection_rank: _sr, selection_slot: _ss, selection_reason: _sre,
          ...rest
        } = row;
        return rest;
      });
      // CAPTURE the retry error. Previously discarded, so a fallback that ALSO failed looked
      // identical to a success — and then the prune ran anyway.
      const { error: retryErr } = await supabase.from('keyword_analysis').upsert(legacy, { onConflict: 'asin,keyword' });
      if (retryErr) console.warn('[storeAnalysis] legacy-column retry failed:', retryErr.message);
      else wroteAny = true;
    } else {
      console.warn('[storeAnalysis] upsert failed:', error.message);
    }
  }

  // STALE-PRUNE (interrupt-safe cleanup): drop this ASIN's NATIVE rows NOT refreshed this run
  // (older analyzed_at). Imports (data_source='import') are always preserved — the seller's H10
  // competitor research (PR #176) must survive native re-syncs; a keyword collision already let the
  // fresh native row win in the upsert above ("graduating" an import to native). Runs AFTER the
  // upsert, so an interrupt before this point keeps stale rows rather than emptying the analysis.
  if (!wroteAny) {
    console.warn(`[storeAnalysis] no chunk persisted for ${asin} — SKIPPING stale-prune to preserve the existing pool`);
    return;
  }
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
  // §P PRECONDITION (selection-core.test.ts). `persistedIsComplete`'s saturation test
  // (`ranks.length < poolSize`) is sound ONLY because targets sort FIRST. A caller that orders by
  // opportunity_score and happens to catch rank 1 but not 2..N passes BOTH contiguity and
  // saturation, and ships a one-keyword target set. So when the target set is LIVE, selection_rank
  // is the PRIMARY sort key and the legacy score ordering becomes the tiebreak for the pooled tail.
  //
  // Gated on `=== 'on'`, never `!== 'off'`: at off AND shadow this is byte-identical to the
  // pre-#143 query, which is what makes the flip a pure read-side change (doctrine 2).
  //
  // `select('*')` already returns the six 049 columns once the migration lands, so there is no
  // projection to widen — and no projection that can 42703 on a pre-migration database.
  const targetsLive = selectionMode() === 'on';
  let q = supabase.from('keyword_analysis').select('*').eq('asin', asin);
  if (targetsLive) q = q.order('selection_rank', { ascending: true, nullsFirst: false });
  q = q.order('opportunity_score', { ascending: false });
  // Deterministic tiebreak. Postgres does not guarantee a stable order for equal sort keys, so two
  // reads of the same rows could return different windows at the LIMIT boundary — which would make
  // the parity oracle report a spurious disagreement between two sites reading identical data.
  if (targetsLive) q = q.order('keyword', { ascending: true });

  const { data, error } = await q.limit(topN);

  if (error || !data || data.length === 0) {
    // A pre-049 database cannot error here (select '*' + an ORDER on a missing column is only
    // reachable when targetsLive, i.e. after the operator flipped to `on`, which the runbook gates
    // on the migration). Log it rather than silently returning null on an unexpected shape.
    if (error) console.warn(`[getStoredAnalysis] read failed for ${asin}:`, error.message);
    return null;
  }

  return data.map(row => ({
    keyword: row.keyword,
    opportunityScore: row.opportunity_score,
    actionType: row.action_type,
    actionText: row.action_text ?? '',
    // `rationale` was declared at engine.ts:88 and hardcoded '' here since inception — never
    // rendered anywhere. selection_reason revives it with the selector's own deterministic prose
    // ("off-theme: art teachers (3/3 raters)"), which is what makes a demotion answerable on screen.
    // Gated: at off/shadow it stays '' exactly as today.
    rationale: (targetsLive ? (row.selection_reason as string | null) : null) ?? '',
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
    // Target-set fields surface ONLY at `on`. At off/shadow they stay `undefined`, so
    // `isRankingTarget` reads false for every row and every consumer falls open to its legacy list
    // without needing a second code path. This is the whole read-gating contract in four lines.
    themeFit: targetsLive ? ((row.theme_fit ?? null) as AnalyzedKeyword['themeFit']) : undefined,
    themeAbout: targetsLive ? ((row.theme_about ?? null) as string | null) : undefined,
    themeRunId: targetsLive ? ((row.theme_run_id ?? null) as string | null) : undefined,
    selectionRank: targetsLive ? ((row.selection_rank ?? null) as number | null) : undefined,
    selectionSlot: targetsLive ? ((row.selection_slot ?? null) as AnalyzedKeyword['selectionSlot']) : undefined,
    selectionReason: targetsLive ? ((row.selection_reason ?? null) as string | null) : undefined,
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
