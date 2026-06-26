/**
 * outcomeForListing.ts — PHASE C, the PUSH-EPOCH-AWARE outcome wrapper (spec §5 Phase C / Risk R1).
 *
 * THE PROBLEM IT SOLVES: computeOutcomeSignals (outcomeSignals.ts:83-84) compares the TWO LATEST
 * distinct snapshot_date rows with NO push-epoch awareness — so its window can straddle the push
 * (before-copy vs after-copy mixed in), reporting a move that the new copy never caused. Reusing it
 * verbatim for outcome would lie.
 *
 * WHAT THIS WRAPPER DOES (and does NOT do):
 *   1. FILTERS keyword_share_snapshots to snapshot_date > push_epoch_at (drop everything from before
 *      the measured copy went live).
 *   2. REQUIRES the compared pair to BOTH carry content_fingerprint == push_epoch_fingerprint (the
 *      copy under measurement is unchanged across the window — fingerprintOf() VERBATIM, so this is
 *      the SAME value snapshots/score-history store; spec §4-D/§4-E).
 *   3. DELEGATES the rose/flat/fell math to computeOutcomeSignals' constants (FLAT_BAND_PCT=2.0,
 *      MIN_VOLUME=100) — re-implemented here over the filtered rows so the thresholds never fork.
 *
 * "EVALUABLE" = >=2 post-epoch same-fingerprint snapshots. Because a fresh distinct snapshot_date
 * materializes ~monthly, real warm-up is ~2-3 months — surfaced honestly as "Measuring n/2".
 *
 * HONESTY: correlation only ("share moved AFTER the measured copy shipped"), never causation. This
 * is a PURE read over keyword_share_snapshots — it writes nothing. The cron (the only outcome
 * writer) consumes its result to set listing_outcome_state.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Mirror outcomeSignals.ts:25-27 EXACTLY — do not fork. */
const FLAT_BAND_PCT = 2.0
const MIN_VOLUME = 100
/** Evaluable once this many distinct post-epoch same-fingerprint snapshot_dates exist. */
export const MIN_POST_EPOCH_SNAPSHOTS = 2

export interface EpochContext {
  /** ISO timestamp the measured copy went live (listing_outcome_state.push_epoch_at). */
  pushEpochAt: string
  /** fingerprintOf() of that copy (listing_outcome_state.push_epoch_fingerprint). */
  pushEpochFingerprint: string
}

export interface EpochKeywordSignal {
  keyword: string
  direction: 'rose' | 'flat' | 'fell'
  shareBefore: number
  shareAfter: number
}

export type OutcomeAggregateVerdict =
  | 'won'
  | 'resurface_regression'
  | 'non_copy_bottleneck'
  | 'headroom_rewrite'

export interface ListingOutcome {
  /** TRUE once >=2 post-epoch same-fingerprint snapshots exist (the gate is open). */
  evaluable: boolean
  /** Distinct post-epoch same-fingerprint snapshot_dates seen (the "n" in "Measuring n/2"). */
  postEpochSnapshots: number
  /** Per-keyword signals over the post-epoch same-fingerprint window (empty until evaluable). */
  signals: EpochKeywordSignal[]
  /** Net roll-up verdict over the keyword set; null until evaluable. */
  verdict: OutcomeAggregateVerdict | null
  /** Human-readable "why" + the keywords that drove it (for the chip + sanity-check). */
  reason: string
  /** Counts that fed the roll-up (rose/flat/fell over evaluated keywords). */
  tally: { rose: number; flat: number; fell: number; evaluated: number }
}

interface SnapRow {
  keyword: string
  snapshot_date: string
  impression_share: number | null
  search_volume: number | null
  content_fingerprint: string | null
}

/**
 * Push-epoch-aware outcome for ONE listing's measured copy.
 *
 * `asin` is the snapshot key — for a catalog family it is the rolled-up top_child_asin; for a
 * standalone it is the listing's own ASIN (snapshots are keyed on that ASIN directly — spec R-MIG5).
 *
 * Returns evaluable:false with a partial snapshot count when the gate is still closed (the cron
 * uses that to keep 'measuring' / fire 'measurement_stalled', never to fabricate a verdict).
 * Table-missing / query error → evaluable:false (never throws), matching computeOutcomeSignals.
 */
export async function computeOutcomeForListing(
  asin: string,
  epoch: EpochContext,
  supabase: SupabaseClient,
): Promise<ListingOutcome> {
  const empty: ListingOutcome = {
    evaluable: false, postEpochSnapshots: 0, signals: [], verdict: null,
    reason: 'insufficient_data', tally: { rose: 0, flat: 0, fell: 0, evaluated: 0 },
  }
  if (!asin || !epoch?.pushEpochAt || !epoch?.pushEpochFingerprint) return empty

  let rows: SnapRow[] = []
  try {
    const { data, error } = await supabase
      .from('keyword_share_snapshots')
      .select('keyword, snapshot_date, impression_share, search_volume, content_fingerprint')
      // (1) post-epoch only — drop everything from before the measured copy went live.
      .gt('snapshot_date', epoch.pushEpochAt.slice(0, 10))
      // (2) same-fingerprint only — the copy under measurement is unchanged across the window.
      .eq('content_fingerprint', epoch.pushEpochFingerprint)
      .eq('asin', asin)
      .order('snapshot_date', { ascending: false })
      .limit(4000)
    if (error || !data) return empty
    rows = data as unknown as SnapRow[]
  } catch {
    return empty
  }

  // Distinct post-epoch snapshot_dates across the whole listing = the readiness count ("n/2").
  const allDates = new Set<string>()
  for (const r of rows) if (r.snapshot_date) allDates.add(r.snapshot_date)
  const postEpochSnapshots = allDates.size

  if (postEpochSnapshots < MIN_POST_EPOCH_SNAPSHOTS) {
    return { ...empty, postEpochSnapshots, reason: `measuring ${postEpochSnapshots}/${MIN_POST_EPOCH_SNAPSHOTS}` }
  }

  // Group by keyword (already newest-first by snapshot_date), then delegate the rose/flat/fell math.
  const byKw = new Map<string, SnapRow[]>()
  for (const r of rows) {
    if (!r.keyword) continue
    const arr = byKw.get(r.keyword)
    if (arr) arr.push(r); else byKw.set(r.keyword, [r])
  }

  const signals: EpochKeywordSignal[] = []
  let rose = 0, flat = 0, fell = 0
  for (const [keyword, snaps] of byKw) {
    // Distinct dates, newest-first (defensive — the unique key already dedups).
    const distinct: SnapRow[] = []
    const seen = new Set<string>()
    for (const s of snaps) if (!seen.has(s.snapshot_date)) { seen.add(s.snapshot_date); distinct.push(s) }
    if (distinct.length < 2) continue   // exclude keywords that are insufficient_data in this window (spec R9)

    const after = distinct[0]
    const before = distinct[1]
    const aShare = after.impression_share
    const bShare = before.impression_share
    // Null shares or sub-threshold volume → too noisy to trust → exclude (same gate as outcomeSignals).
    if (aShare == null || bShare == null || (after.search_volume ?? 0) < MIN_VOLUME || (before.search_volume ?? 0) < MIN_VOLUME) continue

    const delta = aShare - bShare
    const direction: EpochKeywordSignal['direction'] = delta > FLAT_BAND_PCT ? 'rose' : delta < -FLAT_BAND_PCT ? 'fell' : 'flat'
    if (direction === 'rose') rose++; else if (direction === 'fell') fell++; else flat++
    signals.push({ keyword, direction, shareBefore: bShare, shareAfter: aShare })
  }

  const evaluated = rose + flat + fell
  if (evaluated === 0) {
    // Gate is open on dates but every keyword is sub-volume/null → still not actionable.
    return { ...empty, postEpochSnapshots, evaluable: false, reason: `measuring ${postEpochSnapshots}/${MIN_POST_EPOCH_SNAPSHOTS} (no high-volume keyword to read yet)` }
  }

  // ── Net roll-up (the cron debounces 'resurface_regression' across consecutive evals — D-13). ──
  // rose-dominant → won; net fell → regression; flat-but-content-changed semantics: in this wrapper
  // the WHOLE window is same-fingerprint (the copy did NOT change), so flat/fell means MORE COPY did
  // not move the needle ⇒ the lever is non-copy (reviews/price/ads/velocity) UNLESS there is still
  // headroom to rewrite. We split flat→headroom_rewrite (try more copy) vs fell→non_copy_bottleneck
  // (copy isn't the problem); the cron may refine the lever from ads/price/review context.
  const top = (dir: EpochKeywordSignal['direction']) =>
    signals.filter((s) => s.direction === dir).slice(0, 5).map((s) => s.keyword)
  let verdict: OutcomeAggregateVerdict
  let reason: string
  if (rose > fell && rose >= flat) {
    verdict = 'won'
    reason = `${rose}/${evaluated} measured keywords rose since the epoch (e.g. ${top('rose').join(', ')}).`
  } else if (fell > rose) {
    verdict = 'resurface_regression'
    reason = `${fell}/${evaluated} measured keywords fell since the epoch (e.g. ${top('fell').join(', ')}) — debounce before resurfacing.`
  } else if (flat >= rose && flat > 0) {
    // Flat under unchanged copy: there may be headroom for stronger copy.
    verdict = 'headroom_rewrite'
    reason = `${flat}/${evaluated} measured keywords flat under unchanged copy (e.g. ${top('flat').join(', ')}) — more/stronger copy may help.`
  } else {
    verdict = 'non_copy_bottleneck'
    reason = `Copy shipped but share did not improve across ${evaluated} measured keywords — the lever is reviews/price/ads/velocity, not more copy.`
  }

  return {
    evaluable: true,
    postEpochSnapshots,
    signals,
    verdict,
    reason,
    tally: { rose, flat, fell, evaluated },
  }
}
