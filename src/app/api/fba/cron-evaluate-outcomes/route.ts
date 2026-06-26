/**
 * GET /api/fba/cron-evaluate-outcomes
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE C — THE OUTCOME-EVALUATION JOB (spec §5 Phase C). This cron is the SINGLE WRITER of outcome
 * state (Risk R6): the push hinge stamps 'measuring'; ONLY this cron sets a TERMINAL verdict
 * (won / resurface_regression / non_copy_bottleneck / headroom_rewrite / measurement_stalled). The
 * score-trigger may only ever write 'ready'/'needs_work' — never an outcome — so there is exactly one
 * writer of the measuring/outcome axis and no lost-update race against a concurrent re-score.
 *
 * WHAT IT DOES, per measuring listing:
 *   1. GATE: call the push-epoch-aware wrapper (computeOutcomeForListing) — a PURE read over
 *      keyword_share_snapshots filtered to snapshot_date > push_epoch_at AND content_fingerprint ==
 *      push_epoch_fingerprint. Evaluable iff >=2 distinct post-epoch same-fingerprint snapshot_dates
 *      (MIN_POST_EPOCH_SNAPSHOTS). The wrapper restates FLAT_BAND_PCT=2.0 / MIN_VOLUME=100 VERBATIM.
 *   2. GATE CLOSED + epoch > STALE_AFTER_DAYS (75d) ⇒ 'measurement_stalled' (the monthly SQP clock
 *      never produced 2 post-epoch months — surface it, never silently rot). Still measuring within
 *      75d ⇒ refresh snapshots_since_push + verdict_reason 'measuring n/2', no terminal verdict.
 *   3. GATE OPEN ⇒ aggregate the per-keyword signals against a COHORT BASELINE (Risk R9): subtract the
 *      cohort's median move so a market-wide swing nets out; keywords that are insufficient_data in
 *      EITHER month are already excluded by the wrapper. Then emit:
 *        rose-dominant            → 'won'
 *        net fell  (DEBOUNCED)    → 'resurface_regression' only after N=2 CONSECUTIVE fell evals (Risk R9)
 *        flat + copy CHANGED      → 'non_copy_bottleneck' (+ non_copy_lever) — copy isn't the lever
 *        flat + copy UNCHANGED    → 'headroom_rewrite' — more/stronger copy can still help
 *   4. WRITE listing_outcome_state (the truth) + an append-only listing_score_history row
 *      (trigger='outcome_resurface'). The verdict is NEVER mirrored onto listing_seo_scores (R-MIG7);
 *      the dashboard GET LEFT-JOINs the ledger by listing_key.
 *
 * Auth/shape MIRROR cron-keyword-sync: Authorization: Bearer <CRON_SECRET> OR x-cron-secret header,
 * BUDGET_MS time budget, MAX_PER_RUN cap, force-dynamic, maxDuration. Best-effort throughout — a
 * per-listing error never aborts the batch; a query error degrades to a no-op 200.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // pure reads over keyword_share_snapshots; far cheaper than an SQP fetch

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import {
  computeOutcomeForListing,
  type EpochContext,
  type ListingOutcome,
} from '@/lib/keyword-engine/outcomeForListing'
import { appendScoreHistory } from '@/lib/fba/scoreHistory'

/** Consecutive net-fell evals required before a regression resurfaces (Risk R9 / D-13). */
const REGRESSION_DEBOUNCE = 2
/** A measuring epoch older than this with the gate still closed → 'measurement_stalled'. */
const STALE_AFTER_DAYS = 75
/** Non-copy lever we attribute when copy shipped but share did not move. The cron picks the most
 *  plausible default; a richer ads/price/review signal can refine it later. */
const DEFAULT_NON_COPY_LEVER: 'reviews' | 'price' | 'ads' | 'velocity' = 'reviews'

interface OutcomeStateRow {
  listing_key: string
  parent_asin: string | null
  push_epoch_at: string | null
  push_epoch_fingerprint: string | null
  baseline_overall_score: number | null
  outcome_verdict: string | null
  consecutive_fell_evals: number | null
}

type TerminalVerdict =
  | 'won'
  | 'resurface_regression'
  | 'non_copy_bottleneck'
  | 'headroom_rewrite'
  | 'measurement_stalled'

/** Resolve the ASIN the snapshots are keyed on for this measuring listing.
 *  syncKeywordData captures snapshots under the representative ASIN (top_child for a catalog family;
 *  the standalone's own ASIN for a parent-null listing — spec R-MIG5). listing_seo_scores.top_child_asin
 *  holds exactly that representative ASIN, so it is the snapshot key. Fall back to the parent/listing
 *  key itself when the column is unset (standalone self-parent). */
async function resolveSnapshotAsin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  row: OutcomeStateRow,
): Promise<string | null> {
  const key = row.parent_asin || row.listing_key
  if (!key) return null
  try {
    const { data } = await db
      .from('listing_seo_scores')
      .select('top_child_asin')
      .eq('parent_asin', key)
      .maybeSingle()
    const topChild = (data as { top_child_asin: string | null } | null)?.top_child_asin
    return topChild || key
  } catch {
    return key
  }
}

/**
 * COHORT BASELINE (Risk R9): a market-wide swing should net out, so we compare this listing's median
 * keyword move against its cohort's median move and judge on the EXCESS. Cohort = the OTHER currently
 * measuring listings' net moves over THEIR same-fingerprint windows. If we can't build a cohort (too
 * few peers), the cohort delta is 0 (no adjustment) and we judge on the raw move — never blocking.
 *
 * Returns the cohort's median net keyword move (rose=+1, flat=0, fell=-1 per keyword), already excluding
 * insufficient_data keywords (the wrapper drops those before they reach us).
 */
function cohortMedianNetMove(peerOutcomes: ListingOutcome[]): number {
  const nets: number[] = []
  for (const o of peerOutcomes) {
    if (!o.evaluable || o.tally.evaluated === 0) continue
    nets.push((o.tally.rose - o.tally.fell) / o.tally.evaluated)
  }
  if (nets.length === 0) return 0
  nets.sort((a, b) => a - b)
  const mid = Math.floor(nets.length / 2)
  return nets.length % 2 ? nets[mid] : (nets[mid - 1] + nets[mid]) / 2
}

/** Did the live copy change since the epoch? Compares the live top-child fingerprint to the stamped
 *  push_epoch_fingerprint. flat + UNCHANGED → headroom_rewrite (more copy can help); flat + CHANGED →
 *  non_copy_bottleneck (someone shipped new copy and it still didn't move ⇒ the lever isn't copy).
 *  Best-effort: an unknown live fingerprint is treated as UNCHANGED (headroom is the safer default —
 *  it routes to Needs Work for a human, not to a "stop rewriting" pill). */
async function liveCopyChangedSinceEpoch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  row: OutcomeStateRow,
): Promise<boolean> {
  try {
    const key = row.parent_asin || row.listing_key
    const { data: sc } = await db
      .from('listing_seo_scores')
      .select('top_child_asin')
      .eq('parent_asin', key)
      .maybeSingle()
    const topChild = (sc as { top_child_asin: string | null } | null)?.top_child_asin || key
    const { fingerprintOf } = await import('@/lib/keyword-engine/shareSnapshots')
    const { data: kid } = await db
      .from('listing_content')
      .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
      .eq('asin', topChild)
      .maybeSingle()
    if (!kid) return false
    const liveFp = fingerprintOf(kid as never)
    return !!row.push_epoch_fingerprint && liveFp !== row.push_epoch_fingerprint
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authed =
    request.headers.get('authorization') === `Bearer ${cronSecret}` ||
    request.headers.get('x-cron-secret') === cronSecret
  if (!cronSecret || !authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = Date.now()
  const BUDGET_MS = 4 * 60 * 1000
  const MAX_PER_RUN = 50 // pure reads — far more headroom than the SQP-fetch cron

  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  // Pull listings still 'measuring' (the push hinge stamped them; only THIS cron moves them off).
  // Best-effort: a query error (table pre-039) degrades to a no-op 200.
  const { data: measuringRaw, error } = await db
    .from('listing_outcome_state')
    .select('listing_key, parent_asin, push_epoch_at, push_epoch_fingerprint, baseline_overall_score, outcome_verdict, consecutive_fell_evals')
    .eq('outcome_verdict', 'measuring')
    .not('push_epoch_at', 'is', null)
    .not('push_epoch_fingerprint', 'is', null)
    .limit(200)
  if (error) {
    return NextResponse.json({ ok: false, stage: 'select_measuring', error: error.message }, { status: 200 })
  }
  const measuring = (measuringRaw ?? []) as OutcomeStateRow[]

  // ── PASS 1: compute the wrapper outcome for every measuring listing (pure reads). We need them all
  // up front to build the cohort baseline before we judge any single one (Risk R9). ──
  const computed: { row: OutcomeStateRow; asin: string; outcome: ListingOutcome }[] = []
  for (const row of measuring) {
    if (computed.length >= MAX_PER_RUN || Date.now() - start > BUDGET_MS) break
    if (!row.push_epoch_at || !row.push_epoch_fingerprint) continue
    const asin = await resolveSnapshotAsin(db, row)
    if (!asin) continue
    const epoch: EpochContext = { pushEpochAt: row.push_epoch_at, pushEpochFingerprint: row.push_epoch_fingerprint }
    let outcome: ListingOutcome
    try {
      outcome = await computeOutcomeForListing(asin, epoch, supabase)
    } catch {
      continue // the wrapper never throws, but be defensive — a single bad listing never aborts the batch
    }
    computed.push({ row, asin, outcome })
  }

  // Cohort baseline = median net move across all EVALUABLE peers in this batch.
  const cohortDelta = cohortMedianNetMove(computed.filter((c) => c.outcome.evaluable).map((c) => c.outcome))

  const processed: { listing_key: string; verdict: string; snapshots: number; reason: string }[] = []
  const errors: { listing_key: string; error: string }[] = []
  const nowMs = Date.now()

  // ── PASS 2: judge + WRITE (this cron is the single writer of outcome state — Risk R6). ──
  for (const { row, asin, outcome } of computed) {
    try {
      const epochMs = row.push_epoch_at ? new Date(row.push_epoch_at).getTime() : null
      const epochAgeDays = epochMs != null ? (nowMs - epochMs) / (24 * 60 * 60 * 1000) : 0

      // GATE CLOSED ───────────────────────────────────────────────────────────────────────────────
      if (!outcome.evaluable) {
        if (epochMs != null && epochAgeDays > STALE_AFTER_DAYS) {
          // Epoch is old and the monthly SQP clock never produced 2 post-epoch months — stalled.
          const reason = `Measurement stalled — no 2nd post-push SQP month after ${Math.round(epochAgeDays)}d (have ${outcome.postEpochSnapshots}/2).`
          await writeVerdict(db, row, asin, 'measurement_stalled', reason, {
            snapshots: outcome.postEpochSnapshots, lever: null, consecutiveFell: 0,
          })
          processed.push({ listing_key: row.listing_key, verdict: 'measurement_stalled', snapshots: outcome.postEpochSnapshots, reason })
          continue
        }
        // Still legitimately measuring within the window — refresh the n/2 counter, no terminal verdict.
        await db.from('listing_outcome_state').update({
          snapshots_since_push: outcome.postEpochSnapshots,
          verdict_reason: outcome.reason, // 'measuring n/2' from the wrapper
          last_evaluated_at: new Date().toISOString(),
        }).eq('listing_key', row.listing_key)
        processed.push({ listing_key: row.listing_key, verdict: 'measuring', snapshots: outcome.postEpochSnapshots, reason: outcome.reason })
        continue
      }

      // GATE OPEN — apply the cohort baseline, then map to a terminal verdict ──────────────────────
      const { rose, fell, evaluated } = outcome.tally
      const rawNet = evaluated > 0 ? (rose - fell) / evaluated : 0
      const excessNet = rawNet - cohortDelta // subtract the market-wide swing (Risk R9)
      const prevFell = row.consecutive_fell_evals ?? 0

      let verdict: TerminalVerdict
      let reason: string
      let lever: 'reviews' | 'price' | 'ads' | 'velocity' | null = null
      let consecutiveFell = 0

      if (excessNet > 0 && rose >= fell) {
        // Beat the cohort on net rise → won.
        verdict = 'won'
        reason = `${outcome.reason} (excess vs cohort +${(excessNet * 100).toFixed(0)}%).`
        consecutiveFell = 0
      } else if (excessNet < 0 && fell > rose) {
        // Underperformed the cohort on net fall → REGRESSION, but DEBOUNCE it (Risk R9).
        consecutiveFell = prevFell + 1
        if (consecutiveFell >= REGRESSION_DEBOUNCE) {
          verdict = 'resurface_regression'
          reason = `${outcome.reason} (excess vs cohort ${(excessNet * 100).toFixed(0)}%; ${consecutiveFell} consecutive fell evals — debounce met).`
        } else {
          // Not yet debounced — hold 'measuring' but REMEMBER the fell so the next eval can confirm.
          const heldReason = `Net fell vs cohort but debouncing (${consecutiveFell}/${REGRESSION_DEBOUNCE}) — holding measuring before resurfacing a regression.`
          await db.from('listing_outcome_state').update({
            snapshots_since_push: outcome.postEpochSnapshots,
            consecutive_fell_evals: consecutiveFell,
            verdict_reason: heldReason,
            last_evaluated_at: new Date().toISOString(),
          }).eq('listing_key', row.listing_key)
          processed.push({ listing_key: row.listing_key, verdict: 'measuring', snapshots: outcome.postEpochSnapshots, reason: heldReason })
          continue
        }
      } else {
        // Flat (or no cohort-beating move either way) under the measured window. The wrapper's window is
        // always same-fingerprint, so we look at the LIVE copy: if someone shipped NEW copy since the
        // epoch and share still didn't move → non_copy_bottleneck (the lever isn't copy); if the copy is
        // UNCHANGED → there's still headroom for stronger copy → headroom_rewrite.
        const copyChanged = await liveCopyChangedSinceEpoch(db, row)
        if (copyChanged) {
          verdict = 'non_copy_bottleneck'
          lever = DEFAULT_NON_COPY_LEVER
          reason = `Copy changed since the epoch but share stayed flat across ${evaluated} measured keyword(s) — the lever is ${lever}/price/ads/velocity, not more copy.`
        } else {
          verdict = 'headroom_rewrite'
          reason = `Flat under unchanged copy across ${evaluated} measured keyword(s) — more/stronger copy can still help; routing back to Needs Work.`
        }
        consecutiveFell = 0
      }

      await writeVerdict(db, row, asin, verdict, reason, {
        snapshots: outcome.postEpochSnapshots, lever, consecutiveFell,
      })
      processed.push({ listing_key: row.listing_key, verdict, snapshots: outcome.postEpochSnapshots, reason })
    } catch (e) {
      errors.push({ listing_key: row.listing_key, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return NextResponse.json({
    ok: true,
    triggered_at: new Date(start).toISOString(),
    elapsed_ms: Date.now() - start,
    measuring: measuring.length,
    evaluated: computed.length,
    cohort_median_net: Number(cohortDelta.toFixed(4)),
    processed,
    errors,
  })
}

/**
 * Write a TERMINAL verdict to listing_outcome_state (the single source of truth) AND append a
 * listing_score_history row (trigger='outcome_resurface') so the merged change-history timeline shows
 * the resurface event. Best-effort on the history append — it never blocks the verdict write.
 */
async function writeVerdict(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  row: OutcomeStateRow,
  asin: string,
  verdict: TerminalVerdict,
  reason: string,
  extra: { snapshots: number; lever: 'reviews' | 'price' | 'ads' | 'velocity' | null; consecutiveFell: number },
): Promise<void> {
  const now = new Date().toISOString()
  await db.from('listing_outcome_state').update({
    outcome_verdict: verdict,
    verdict_reason: reason,
    non_copy_lever: extra.lever,
    snapshots_since_push: extra.snapshots,
    consecutive_fell_evals: extra.consecutiveFell,
    last_evaluated_at: now,
    resurfaced_at: now,
  }).eq('listing_key', row.listing_key)

  // Append an outcome-resurface score-history change-point. We read the listing's current score so the
  // history row carries the score at resurface time; lifecycle_state is the verdict (denormalized).
  try {
    const key = row.parent_asin || row.listing_key
    const { data: sc } = await db
      .from('listing_seo_scores')
      .select('parent_asin, overall_score, title_score, bullet_score, keyword_score, aplus_score, description_score, features_score, issues')
      .eq('parent_asin', key)
      .maybeSingle()
    if (sc) {
      await appendScoreHistory(db, {
        parent_asin: (sc as { parent_asin?: string | null }).parent_asin ?? row.parent_asin ?? null,
        asin: row.parent_asin ? null : row.listing_key,
        overall_score: (sc as { overall_score?: number | null }).overall_score ?? null,
        title_score: (sc as { title_score?: number | null }).title_score ?? null,
        bullet_score: (sc as { bullet_score?: number | null }).bullet_score ?? null,
        keyword_score: (sc as { keyword_score?: number | null }).keyword_score ?? null,
        aplus_score: (sc as { aplus_score?: number | null }).aplus_score ?? null,
        description_score: (sc as { description_score?: number | null }).description_score ?? null,
        features_score: (sc as { features_score?: number | null }).features_score ?? null,
        issues: Array.isArray((sc as { issues?: unknown[] }).issues) ? (sc as { issues: unknown[] }).issues : null,
        lifecycle_state: verdict,
      }, {
        trigger: 'outcome_resurface',
        scoredBy: null,
        scoredByName: 'System (outcome evaluation)',
        // Carry the epoch fingerprint so this row JOINs the snapshots / dedups against the push row.
        fingerprint: row.push_epoch_fingerprint,
      })
    }
  } catch (e) {
    console.warn('[cron-evaluate-outcomes] score-history append failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}
