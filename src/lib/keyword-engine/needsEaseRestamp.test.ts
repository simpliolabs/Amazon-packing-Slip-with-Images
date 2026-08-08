import { describe, it, expect } from 'vitest'
import { needsEaseRestamp } from './selection-core'

/* Item 1 (PO 2026-08-08): KEYWORD_EASE_WEIGHT went live AFTER the last storeAnalysis write, so the
 * persisted selection_rank order was pre-ease. The intelligence GET self-heal refires the one-shot
 * cache-HIT promotion when THIS predicate says the stored stamp disagrees with the configured
 * weight. The tri-state (undefined / null / number) is the per-load-loop killer — pinned here. */

const ranked = (sew: number | null | undefined, rank = 1) =>
  sew === undefined ? { selectionRank: rank } : { selectionRank: rank, selectionEaseWeight: sew }
const pooled = (sew: number | null | undefined = undefined) =>
  sew === undefined ? { selectionRank: null } : { selectionRank: null, selectionEaseWeight: sew }

describe('needsEaseRestamp — gate conditions', () => {
  it('T1.1 never fires at off or shadow (reads stay legacy at shadow; off makes zero extra calls)', () => {
    expect(needsEaseRestamp([ranked(null)], 10, 'off')).toBe(false)
    expect(needsEaseRestamp([ranked(null)], 10, 'shadow')).toBe(false)
  })

  it('T1.2 never fires without a persisted selection (thin-pool self-heal owns that case)', () => {
    expect(needsEaseRestamp([], 10, 'on')).toBe(false)
    expect(needsEaseRestamp([pooled(), pooled(5)], 10, 'on')).toBe(false)
  })

  it('T1.3 pre-migration DB (stamp property ABSENT on every ranked row) never fires — fail-open', () => {
    expect(needsEaseRestamp([ranked(undefined), ranked(undefined, 2)], 10, 'on')).toBe(false)
  })
})

describe('needsEaseRestamp — stamp vs configured weight', () => {
  it('T1.4 migrated-but-unstamped (null) = "written under 0": fires iff weight != 0 (the PO live complaint)', () => {
    expect(needsEaseRestamp([ranked(null)], 10, 'on')).toBe(true)
    expect(needsEaseRestamp([ranked(null)], 0, 'on')).toBe(false)
  })

  it('T1.5 stamp 0 + weight 10 fires; stamp 10 + weight 10 does not (equality after one pass)', () => {
    expect(needsEaseRestamp([ranked(0)], 10, 'on')).toBe(true)
    expect(needsEaseRestamp([ranked(10)], 10, 'on')).toBe(false)
  })

  it('T1.6 ROLLBACK: stamp 15 + weight 0 fires exactly once (merge branch stamps the literal 0)', () => {
    expect(needsEaseRestamp([ranked(15)], 0, 'on')).toBe(true)
    // after the restamp pass the rows carry 0 -> no refire
    expect(needsEaseRestamp([ranked(0)], 0, 'on')).toBe(false)
  })

  it('T1.7 undefined rows are excluded from the probe (partial-column payloads cannot loop)', () => {
    expect(needsEaseRestamp([ranked(undefined), ranked(5, 2)], 5, 'on')).toBe(false)
    expect(needsEaseRestamp([ranked(undefined), ranked(5, 2)], 10, 'on')).toBe(true)
  })

  it('T1.8 HALF-RESTAMPED write (process death between chunks): ANY disagreeing stamp fires — even when rank 1 already agrees', () => {
    // Old first-non-null probe read this as healthy because rank 1's chunk had landed (stamp 5 ==
    // weightNow) while rank 2's chunk still carried the old stamp — frozen mixed selection_ranks.
    expect(needsEaseRestamp([ranked(5, 1), ranked(10, 2)], 5, 'on')).toBe(true)
    // mixed null (pre-ease era = "0") beside a current stamp also fires until fully rewritten
    expect(needsEaseRestamp([ranked(5, 1), ranked(null, 2)], 5, 'on')).toBe(true)
    // fully restamped → no refire (loop-safe: a COMPLETED merge write rewrites every ranked row)
    expect(needsEaseRestamp([ranked(5, 1), ranked(5, 2)], 5, 'on')).toBe(false)
  })
})
