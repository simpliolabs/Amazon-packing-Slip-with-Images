import { describe, it, expect } from 'vitest'
import { inheritJsMeasurements } from './mergeInherit'

/* Adversarial MEDIUM (2026-08-08): the SQP-wins merge nulled the four JS-measured fields for every
 * dual-source keyword — organicRank (Item 3) AND the three migration-055 native metrics, whose null
 * persisted STICKY (nativeCols had nothing to carry on first research; needsNativeBackfill can never
 * fire once ANY row has the metric). The one-directional inherit contract is pinned here. */

const sqpRow = (over: Record<string, unknown> = {}) => ({
  keyword: 'comfort colors shirt',
  searchVolume: 1000,
  coverageGapScore: 50,
  organicRank: null as number | null,
  jsEaseOfRanking: null as number | null,
  jsRelevancyScore: null as number | null,
  marketOpportunity: null as number | null,
  ...over,
})

describe('inheritJsMeasurements — SQP-wins merge, JS-measured fields survive', () => {
  it('inherits ALL FOUR measured fields when the SQP row has null and the JS row has values', () => {
    const existing = sqpRow()
    const out = inheritJsMeasurements(existing, { organicRank: 12, jsEaseOfRanking: 87, jsRelevancyScore: 71, marketOpportunity: 6 })
    expect(out.organicRank).toBe(12)
    expect(out.jsEaseOfRanking).toBe(87)
    expect(out.jsRelevancyScore).toBe(71)
    expect(out.marketOpportunity).toBe(6)
    // SQP still wins every other field (copy, not replacement)
    expect(out.keyword).toBe('comfort colors shirt')
    expect(out.searchVolume).toBe(1000)
    // input not mutated
    expect(existing.organicRank).toBeNull()
  })

  it('one-directional: an SQP value (hypothetical) is NEVER overwritten by the JS row', () => {
    const existing = sqpRow({ organicRank: 3, marketOpportunity: 9 })
    const out = inheritJsMeasurements(existing, { organicRank: 40, jsEaseOfRanking: 50, marketOpportunity: 2 })
    expect(out.organicRank).toBe(3)          // existing non-null wins
    expect(out.marketOpportunity).toBe(9)    // existing non-null wins
    expect(out.jsEaseOfRanking).toBe(50)     // null-in-existing still inherits
  })

  it('partial inherit: only the null-in-existing / non-null-in-js fields move', () => {
    const out = inheritJsMeasurements(sqpRow(), { organicRank: null, marketOpportunity: 4 })
    expect(out.organicRank).toBeNull()
    expect(out.marketOpportunity).toBe(4)
    expect(out.jsEaseOfRanking).toBeNull()
  })

  it('returns the SAME reference when nothing inherits (merge site can skip the map write)', () => {
    const existing = sqpRow()
    expect(inheritJsMeasurements(existing, {})).toBe(existing)
    expect(inheritJsMeasurements(existing, { organicRank: null, marketOpportunity: undefined })).toBe(existing)
    const full = sqpRow({ organicRank: 1, jsEaseOfRanking: 2, jsRelevancyScore: 3, marketOpportunity: 4 })
    expect(inheritJsMeasurements(full, { organicRank: 9, jsEaseOfRanking: 9, jsRelevancyScore: 9, marketOpportunity: 9 })).toBe(full)
  })

  it('a JS zero is a value, not an absence — 0 inherits over null', () => {
    const out = inheritJsMeasurements(sqpRow(), { marketOpportunity: 0 })
    expect(out.marketOpportunity).toBe(0)
  })
})
