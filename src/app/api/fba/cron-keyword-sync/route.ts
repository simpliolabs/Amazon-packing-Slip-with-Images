/**
 * GET /api/fba/cron-keyword-sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Refreshes the outcome loop's SQP time-series (task #89). Picks ASINs whose SQP cache has EXPIRED
 * (>30 days old), and for each runs syncKeywordData — which fetches the latest monthly SQP report and
 * writes a new keyword_share_snapshots row (one per keyword per data-month).
 *
 * WHY THE CRON RUNS FREQUENTLY BUT THE SIGNAL IS STILL MONTHLY:
 *   Amazon publishes SQP data ONCE PER MONTH (last full calendar month), so the rose/flat/fell signal can
 *   never update faster than monthly — running weekly fetches the SAME monthly report and the snapshot
 *   dedups (UNIQUE asin,keyword,snapshot_date). The cron runs OFTEN anyway because a single SQP report takes
 *   5-8 minutes and a serverless function can't fetch a whole catalog in one invocation — so each run
 *   refreshes a small time-budgeted BATCH and a frequent schedule spreads the slow per-ASIN fetches across
 *   the early-month window. More frequency ⇒ faster catalog COVERAGE, NOT a faster signal.
 *
 * Auth: Authorization: Bearer <CRON_SECRET> (Vercel cron) OR x-cron-secret header (external/Coolify scheduler)
 * — same contract as /api/fba/cron-sync.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 800 // a single SQP report poll is 5-8 min; allow headroom for one in-flight fetch

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { syncKeywordData } from '@/lib/sync/syncKeywordData'

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authed =
    request.headers.get('authorization') === `Bearer ${cronSecret}` ||
    request.headers.get('x-cron-secret') === cronSecret
  if (!cronSecret || !authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = Date.now()
  // Start a NEW (5-8 min) fetch only while under this budget, so the last in-flight fetch finishes well
  // under maxDuration; a frequent schedule picks up the rest next run.
  const BUDGET_MS = 4 * 60 * 1000
  const MAX_PER_RUN = 4

  const supabase = await createAdminClient()

  // ASINs whose SQP cache is stale (>30d) → syncKeywordData will fetch fresh and capture a new monthly
  // snapshot. (A fresh cache means a snapshot was already captured this cycle, so we skip it — no duplicate
  // SP-API report, no duplicate row.) Best-effort: a query error degrades to a no-op 200.
  const { data: stale, error } = await supabase
    .from('keyword_cache')
    .select('asin')
    .eq('source', 'sqp')
    .lt('expires_at', new Date().toISOString())
    .limit(100)
  if (error) {
    return NextResponse.json({ ok: false, stage: 'select_stale', error: error.message }, { status: 200 })
  }

  const asins = [...new Set(((stale ?? []) as { asin: string }[]).map((r) => r.asin).filter(Boolean))]
  const refreshed: string[] = []
  const errors: { asin: string; error: string }[] = []

  for (const asin of asins) {
    if (refreshed.length >= MAX_PER_RUN || Date.now() - start > BUDGET_MS) break
    try {
      await syncKeywordData(asin) // fresh SQP fetch → captureShareSnapshots writes the monthly row
      refreshed.push(asin)
    } catch (e) {
      errors.push({ asin, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return NextResponse.json({
    ok: true,
    triggered_at: new Date(start).toISOString(),
    elapsed_ms: Date.now() - start,
    totalStale: asins.length,
    refreshed,
    errors,
    remaining: Math.max(0, asins.length - refreshed.length - errors.length),
  })
}
