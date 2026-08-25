/**
 * GET /api/fba/admin/backfill-title-truth            → DRY RUN: report how many title-lock rows in
 *                                                      `listing_change_log` are unvetted, and what the
 *                                                      MINER would currently produce (golds/reject
 *                                                      pairs) from whatever IS already vetted.
 * GET /api/fba/admin/backfill-title-truth?execute=1  → EXECUTE one batch (default 25, ?limit=N ≤ 50):
 *                                                      stamp `title_truth_ok`/`title_truth_reason` on
 *                                                      that many unvetted rows.
 *
 * WHY (feat/title-learning-loop, migration 065). `listing_change_log`'s title-lock edit rows are the
 * mined GOLD/REJECT-PAIR source for the title council's few-shot corpus (titleLearningMiner.ts), but
 * a gold must be truth-vetted at INGESTION — `verdictForAssembledTitle` against the family's resolved
 * blank — never re-resolved at read time. `lock-title/route.ts` now stamps every NEW lock going
 * forward; this route is the ONE-TIME pass over PRE-EXISTING history so the corpus is populated on
 * day one instead of waiting for the next time each family happens to be re-locked.
 *
 * SHAPE: batched (default 25/call), dry-run by default, PO-triggered (never cron) — same discipline
 * as `/api/fba/admin/backfill-images`, which this route is modeled on directly. Idempotent: only
 * rows where `title_truth_ok IS NULL` are selected, so re-running after a partial run (or a crash) is
 * always safe and never re-vets an already-stamped row.
 *
 * AUTH: gated by src/middleware.ts like every /api/fba route (cookie session / CRON_SECRET / Bearer
 * JWT). Trigger it from a logged-in browser tab.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { computeTitleTruthVerdict, mineTitleGolds, mineTitleRejectPairs, REJECT_PAIR_BRIEF_LIMIT, type ChangeLogTitleRow } from '@/lib/fba/titleLearningMiner'
import { GOLD_BRIEF_LIMIT } from '@/lib/fba/poGoldCorpus'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const CANDIDATE_FIELDS = ['title', 'title (locked)']

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams
  const execute = params.get('execute') === '1'
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '25', 10) || 25, 1), 50)

  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  // Every candidate row (regardless of vetted state) — needed for the dry-run's "what would the miner
  // produce right now" report, which only ever counts already-`title_truth_ok=true` rows for golds.
  const { data: allRows, error: allErr } = await db
    .from('listing_change_log')
    .select('id, parent_asin, sku, field, action, source, before_value, after_value, changed_at, title_truth_ok, title_truth_reason')
    .in('field', CANDIDATE_FIELDS)
    .eq('action', 'edit')
    .eq('source', 'manual_edit')
    .order('changed_at', { ascending: false })
    .limit(2000)
  if (allErr) return NextResponse.json({ error: allErr.message }, { status: 500 })

  const rows = (allRows ?? []) as (ChangeLogTitleRow & { id: number })[]
  const unvetted = rows.filter((r) => r.title_truth_ok === null || r.title_truth_ok === undefined)
  const batch = unvetted.slice(0, limit)

  if (!execute) {
    const golds = mineTitleGolds(rows, GOLD_BRIEF_LIMIT)
    const rejects = mineTitleRejectPairs(rows, REJECT_PAIR_BRIEF_LIMIT)
    return NextResponse.json({
      mode: 'dry-run',
      totalCandidateRows: rows.length,
      totalUnvetted: unvetted.length,
      wouldProcess: batch.map((r) => ({ id: r.id, parent_asin: r.parent_asin })),
      // What the corpus looks like from whatever IS already vetted (0 rows on a fresh DB — nothing has
      // been stamped yet until this route runs with ?execute=1, or a fresh lock/unlock happens).
      currentMinedGoldCount: golds.length,
      currentMinedRejectPairCount: rejects.length,
      hint: `add ?execute=1 to vet this batch of ${batch.length}; repeat until totalUnvetted reaches 0`,
    })
  }

  // BATCHED audience_lean LOOKUP — one query for the whole batch, not one per row, so a 25-row batch
  // costs one extra round trip instead of 25. Same field `lockTitleTruthStamp` (lock-title/route.ts)
  // reads at write time: omitting it here would make the backfill's verdict LESS accurate than a
  // fresh lock's (the audience-lean-lie rule only fires when a unisex lean is known).
  const parentAsins = [...new Set(batch.map((r) => r.parent_asin))]
  const { data: leanRows } = parentAsins.length
    ? await db.from('listing_seo_scores').select('parent_asin, audience_lean').in('parent_asin', parentAsins)
    : { data: [] as { parent_asin: string; audience_lean: string | null }[] }
  const leanByParent = new Map<string, string | null>(
    (leanRows ?? []).map((r: { parent_asin: string; audience_lean: string | null }): [string, string | null] => [r.parent_asin, r.audience_lean]),
  )

  const stamped: { id: number; parent_asin: string; ok: boolean | null }[] = []
  const failed: number[] = []

  for (const row of batch) {
    try {
      const verdict = await computeTitleTruthVerdict(supabase, row.parent_asin, row.after_value ?? '', leanByParent.get(row.parent_asin) ?? null)
      const { error: upErr } = await db
        .from('listing_change_log')
        .update({ title_truth_ok: verdict.ok, title_truth_reason: verdict.reason })
        .eq('id', row.id)
        .is('title_truth_ok', null) // idempotency guard: never clobber a row a concurrent run already stamped
      if (upErr) failed.push(row.id)
      else stamped.push({ id: row.id, parent_asin: row.parent_asin, ok: verdict.ok })
    } catch {
      failed.push(row.id)
    }
  }

  return NextResponse.json({
    mode: 'execute',
    processed: batch.length,
    stamped: stamped.length,
    stampedTrue: stamped.filter((s) => s.ok === true).length,
    stampedFalse: stamped.filter((s) => s.ok === false).length,
    failed,
    remainingUnvetted: unvetted.length - stamped.length,
    hint: unvetted.length - stamped.length > 0 ? 'call again with ?execute=1 for the next batch' : 'done — all candidate rows are vetted',
  })
}
