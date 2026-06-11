/**
 * outcomeSignals.ts — PHASE 2 of the outcome loop (task #89): turn the keyword_share_snapshots
 * time-series into a per-keyword signal — rose / flat / fell since the last snapshot, plus whether the
 * content CHANGED in that window (so "flat despite a content change" = a NON-content bottleneck:
 * rank now depends on reviews/price/velocity, not more copy).
 *
 * HONESTY: this only reports correlation ("share moved AFTER a change"), NEVER causation. And it returns
 * 'insufficient_data' (no actionable signal) until at least TWO distinct monthly snapshots exist — the
 * explicit guarantee that nothing misleading shows for the first ~1-2 months while history accrues.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface OutcomeSignal {
  keyword: string
  direction: 'rose' | 'flat' | 'fell' | 'insufficient_data'
  shareBefore: number | null
  shareAfter: number | null
  /** the live copy changed (fingerprint differs) between the two compared snapshots */
  contentChangedBetween: boolean
  /** content changed but share did NOT improve → the lever is now reviews/price/velocity, not copy */
  nonContentBottleneck: boolean
}

/** Impression-share points (0-100) within which a move is treated as noise, not a real rise/fall. */
const FLAT_BAND_PCT = 2.0
/** Below this monthly search volume, SQP share is too noisy to draw any conclusion. */
const MIN_VOLUME = 100

interface SnapRow {
  keyword: string
  snapshot_date: string
  impression_share: number | null
  search_volume: number | null
  content_fingerprint: string | null
}

/**
 * Returns a map keyed by LOWERCASED keyword. A keyword with <2 distinct monthly snapshots — or with
 * sub-threshold volume — gets direction:'insufficient_data' and is never surfaced as an actionable signal.
 * Table-missing / query error → empty map (never throws); callers treat that as "no signal".
 */
export async function computeOutcomeSignals(asin: string, supabase: SupabaseClient): Promise<Record<string, OutcomeSignal>> {
  const out: Record<string, OutcomeSignal> = {}
  if (!asin) return out

  let rows: SnapRow[] = []
  try {
    const { data, error } = await supabase
      .from('keyword_share_snapshots')
      .select('keyword, snapshot_date, impression_share, search_volume, content_fingerprint')
      .eq('asin', asin)
      .order('snapshot_date', { ascending: false })
      .limit(4000)
    if (error || !data) return out   // table not migrated yet / no history → no signals
    rows = data as unknown as SnapRow[]
  } catch {
    return out
  }

  // Group by keyword (rows are already newest-first by snapshot_date).
  const byKw = new Map<string, SnapRow[]>()
  for (const r of rows) {
    if (!r.keyword) continue
    const arr = byKw.get(r.keyword)
    if (arr) arr.push(r)
    else byKw.set(r.keyword, [r])
  }

  for (const [keyword, snaps] of byKw) {
    const key = keyword.toLowerCase()
    // Collapse to distinct snapshot_dates, newest-first (defensive — the unique key already dedups).
    const distinct: SnapRow[] = []
    const seenDates = new Set<string>()
    for (const s of snaps) {
      if (!seenDates.has(s.snapshot_date)) { seenDates.add(s.snapshot_date); distinct.push(s) }
    }

    if (distinct.length < 2) {
      out[key] = { keyword, direction: 'insufficient_data', shareBefore: null, shareAfter: distinct[0]?.impression_share ?? null, contentChangedBetween: false, nonContentBottleneck: false }
      continue
    }

    const after = distinct[0]
    const before = distinct[1]
    const aShare = after.impression_share
    const bShare = before.impression_share

    // Null shares or sub-threshold volume → too noisy/incomplete to trust → no actionable signal.
    if (aShare == null || bShare == null || (after.search_volume ?? 0) < MIN_VOLUME || (before.search_volume ?? 0) < MIN_VOLUME) {
      out[key] = { keyword, direction: 'insufficient_data', shareBefore: bShare, shareAfter: aShare, contentChangedBetween: false, nonContentBottleneck: false }
      continue
    }

    const delta = aShare - bShare
    const direction: OutcomeSignal['direction'] = delta > FLAT_BAND_PCT ? 'rose' : delta < -FLAT_BAND_PCT ? 'fell' : 'flat'
    const contentChangedBetween = !!before.content_fingerprint && !!after.content_fingerprint && before.content_fingerprint !== after.content_fingerprint
    const nonContentBottleneck = contentChangedBetween && (direction === 'flat' || direction === 'fell')

    out[key] = { keyword, direction, shareBefore: bShare, shareAfter: aShare, contentChangedBetween, nonContentBottleneck }
  }

  return out
}
