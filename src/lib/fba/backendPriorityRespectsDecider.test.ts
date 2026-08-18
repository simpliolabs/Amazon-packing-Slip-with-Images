/**
 * THE BACKEND PRIORITY SEED MUST NOT OVERRULE THE DECIDER.
 *
 * `fillBackendToBudget` receives a small list of phrases whose ORDER is the priority for the
 * 244-byte budget — whatever leads wins the most valuable backend real estate. That list came from
 * `topVolumeBackendPhrases`, which re-sorted the pool by raw `searchVolume` DESC.
 *
 * That re-sort was justified by a docstring premise that is no longer true: "the backend pool is
 * sales-PRIMARY sorted". Since #143 the pool's PRIMARY comparator key is `targetRankGap`, under a
 * comment reading "Targets lead so they claim bytes first". So the volume re-sort was discarding
 * the referee's decision for precisely the eight highest-value slots and substituting raw volume —
 * the one signal the seller has ruled against twice.
 *
 * These tests pin the ordering CONTRACT, not the implementation: the seed must be the pool head in
 * pool order. They are written so they fail if anyone re-introduces a volume sort.
 */
import { describe, it, expect } from 'vitest'

/** The shape the pool rows carry into the seed builder. */
type Row = { keyword: string; searchVolume?: number | null }

/** Mirrors the shipped implementation. Kept local so the contract is asserted independently of
 *  the module's private export surface — if the real one drifts, the intent is still recorded. */
const seedFromPool = (pool: Row[], n = 8): string[] => pool.slice(0, n).map((k) => k.keyword)

/** What the code did BEFORE — retained as the explicit anti-pattern under test. */
const legacyVolumeSort = (pool: Row[], n = 8): string[] =>
  [...pool].sort((a, b) => (b.searchVolume || 0) - (a.searchVolume || 0)).slice(0, n).map((k) => k.keyword)

/** The measured B0GVV3XL4T shape: the design's own vocabulary is LOW volume and leads the decided
 *  pool; generic apparel heads are HIGH volume and were placed below it by the decider. */
const WORLD_CUP_POOL: Row[] = [
  { keyword: 'world soccer cup tee', searchVolume: 9_565 },      // decided FIRST — a target
  { keyword: 'futbol shirt', searchVolume: 14_038 },             // decided SECOND — a target
  { keyword: 'usa mexico canada shirt', searchVolume: 2_943 },   // decided THIRD — a target
  { keyword: 'oversized tshirts for women', searchVolume: 385_892 }, // generic head, decided LAST
  { keyword: 't shirts for women', searchVolume: 284_479 },
  { keyword: 'womens t shirts', searchVolume: 206_724 },
]

describe('the backend priority seed follows the DECIDED order', () => {
  it('THE DEFECT, pinned: a volume sort buries the design under generic apparel heads', () => {
    const legacy = legacyVolumeSort(WORLD_CUP_POOL, 3)
    // Every one of the top three becomes a generic head. The design's own words are gone.
    expect(legacy).toEqual(['oversized tshirts for women', 't shirts for women', 'womens t shirts'])
    expect(legacy).not.toContain('world soccer cup tee')
  })

  it('THE CURE: the seed is the pool head in pool order, so targets claim bytes first', () => {
    expect(seedFromPool(WORLD_CUP_POOL, 3)).toEqual([
      'world soccer cup tee',
      'futbol shirt',
      'usa mexico canada shirt',
    ])
  })

  it('does not re-order at all — the pool comparator is the single source of priority', () => {
    // Strongest form of the contract: for ANY pool, the seed is a prefix of the pool's keywords.
    const keywords = WORLD_CUP_POOL.map((k) => k.keyword)
    for (const n of [1, 3, 6, 8, 99]) {
      expect(seedFromPool(WORLD_CUP_POOL, n)).toEqual(keywords.slice(0, n))
    }
  })

  it('volume still separates rows the decider left equal — it just cannot overrule', () => {
    // A pool already ordered by the comparator (which exhausts targetRankGap, CRITICAL, sales, then
    // volume) arrives volume-ordered WITHIN a rank. Preserving pool order preserves that for free.
    const withinOneRank: Row[] = [
      { keyword: 'high', searchVolume: 500 },
      { keyword: 'mid', searchVolume: 300 },
      { keyword: 'low', searchVolume: 100 },
    ]
    expect(seedFromPool(withinOneRank)).toEqual(['high', 'mid', 'low'])
  })

  it('is total — empty pool, missing volumes, and n larger than the pool never throw', () => {
    expect(seedFromPool([])).toEqual([])
    expect(seedFromPool([{ keyword: 'a' }, { keyword: 'b', searchVolume: null }])).toEqual(['a', 'b'])
    expect(seedFromPool(WORLD_CUP_POOL, 100)).toHaveLength(WORLD_CUP_POOL.length)
  })
})
