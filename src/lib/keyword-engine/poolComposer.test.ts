import { describe, it, expect } from 'vitest'
import { composePool, mergeKeywordRows, DEFAULT_STRATA_CAPS, type PoolRow } from './poolComposer'

// POOL_STRATA Phase 1 net (handoff/POOL_STRATA_PLAN.md). These tests pin the strata GUARANTEES —
// the properties that make the #144 failure class ("the rows arrived and the cap ate them")
// impossible by construction — not equivalence with the old two-band cut it will replace.

const row = (keyword: string, searchVolume: number, extra?: Partial<PoolRow>): PoolRow => ({ keyword, searchVolume, ...extra })

/** The B0GF49RLDL crowding shape: a wall of high-volume broad rows + a handful of low-volume
 *  design-own rows that a pure volume sort always evicts. */
function crowdedMerge(): PoolRow[] {
  const broad = Array.from({ length: 120 }, (_, i) => row(`broad head term ${String(i).padStart(3, '0')}`, 500_000 - i * 1000, { fromUniverse: true }))
  const design = [
    row('cupid valentine shirt', 450),
    row('valentine cupid tee', 400),
    row('cupid arrow shirt', 320),
    row('valentines day cupid tshirt', 280),
    row('cupid graphic shirt', 210),
  ]
  return [...broad, ...design]
}

describe('composePool — strata guarantees', () => {
  const tokens = ['cupid', 'valentine']

  it('design-own rows ALWAYS ship under crowding (the #144 cure)', () => {
    const comp = composePool(crowdedMerge(), tokens)
    const shipped = new Set(comp.rows.map((r) => r.keyword))
    for (const kw of ['cupid valentine shirt', 'valentine cupid tee', 'cupid arrow shirt', 'valentines day cupid tshirt', 'cupid graphic shirt']) {
      expect(shipped.has(kw), kw).toBe(true)
    }
    expect(comp.designTokenHits).toBeGreaterThanOrEqual(5)
    expect(comp.rows.length).toBe(DEFAULT_STRATA_CAPS.total)
  })

  it('broad-head retention is exact: the merge top-30 by volume all ship', () => {
    const merged = crowdedMerge()
    const comp = composePool(merged, tokens)
    const top30 = [...merged].sort((a, b) => b.searchVolume - a.searchVolume).slice(0, 30).map((r) => r.keyword)
    const shipped = new Set(comp.rows.map((r) => r.keyword))
    for (const kw of top30) expect(shipped.has(kw), kw).toBe(true)
    expect(comp.broadTopRetained).toBe(30)
  })

  it('deterministic: same input → same sha; different composition → different sha', () => {
    const a = composePool(crowdedMerge(), tokens)
    const b = composePool(crowdedMerge(), tokens)
    expect(a.sha).toBe(b.sha)
    const c = composePool(crowdedMerge().slice(0, 50), tokens)
    expect(c.sha).not.toBe(a.sha)
  })

  it('no design tokens → S2 empty, but S3 still guarantees the non-universe harvest rows', () => {
    const comp = composePool(crowdedMerge(), [])
    expect(comp.strata.s2).toBe(0)
    expect(comp.designTokenHits).toBe(0)
    expect(comp.rows.length).toBe(DEFAULT_STRATA_CAPS.total)
    // The 5 non-universe rows are exactly the design-seed/competitor harvest — S3's flag-independent
    // guarantee ships them even with zero tokens; the remainder is volume order.
    const shipped = new Set(comp.rows.map((r) => r.keyword))
    for (const kw of ['cupid valentine shirt', 'valentine cupid tee', 'cupid arrow shirt', 'valentines day cupid tshirt', 'cupid graphic shirt']) {
      expect(shipped.has(kw), kw).toBe(true)
    }
  })

  it('s2Gate keeps junk OUT of the guaranteed stratum (it must win a volume seat instead)', () => {
    const merged = [...crowdedMerge(), row('cupid nike shirt', 990)]
    const comp = composePool(merged, ['cupid', 'valentine'], { s2Gate: (kw) => !/nike/.test(kw) })
    // The gated row is NOT in the final blob: too low-volume for S1/S4, barred from S2, and it is
    // a fromUniverse-less row… make it universe so S3 can't take it either:
    const merged2 = [...crowdedMerge(), row('cupid nike shirt', 990, { fromUniverse: true })]
    const comp2 = composePool(merged2, ['cupid', 'valentine'], { s2Gate: (kw) => !/nike/.test(kw) })
    expect(comp2.rows.some((r) => r.keyword === 'cupid nike shirt')).toBe(false)
    expect(comp.strata.s2).toBeLessThanOrEqual(25)
  })

  it('S3 falls back to non-fromUniverse rows when nicheHead was never tagged (flag-independent)', () => {
    const broad = Array.from({ length: 110 }, (_, i) => row(`broad ${i}`, 400_000 - i * 500, { fromUniverse: true }))
    const harvest = Array.from({ length: 10 }, (_, i) => row(`fishing harvest term ${i}`, 900 - i))
    const comp = composePool([...broad, ...harvest], [])
    const shipped = new Set(comp.rows.map((r) => r.keyword))
    // All 10 low-volume non-universe harvest rows survive via S3 despite 110 higher-volume rows.
    for (const r of harvest) expect(shipped.has(r.keyword), r.keyword).toBe(true)
  })

  it('nicheHead:true universe rows qualify for S3', () => {
    const broad = Array.from({ length: 110 }, (_, i) => row(`broad ${i}`, 400_000 - i * 500, { fromUniverse: true }))
    const tail = [row('golf widow shirt', 700, { fromUniverse: true, nicheHead: true })]
    const comp = composePool([...broad, ...tail], [])
    expect(comp.rows.some((r) => r.keyword === 'golf widow shirt')).toBe(true)
  })

  it('caps are respected: never more than total rows, strata within their caps', () => {
    const comp = composePool(crowdedMerge(), ['cupid', 'valentine'])
    expect(comp.rows.length).toBeLessThanOrEqual(DEFAULT_STRATA_CAPS.total)
    expect(comp.strata.s1).toBeLessThanOrEqual(DEFAULT_STRATA_CAPS.s1Broad)
    expect(comp.strata.s2).toBeLessThanOrEqual(DEFAULT_STRATA_CAPS.s2Design)
    expect(comp.strata.s3).toBeLessThanOrEqual(DEFAULT_STRATA_CAPS.s3NicheTail)
  })
})

describe('mergeKeywordRows — niche precedence, first-writer-wins', () => {
  it('dedupes case-insensitively with niche winning', () => {
    const niche = [row('Cupid Shirt', 500)]
    const comp = [row('cupid shirt', 900), row('other tee', 100)]
    const merged = mergeKeywordRows(niche, comp)
    expect(merged.length).toBe(2)
    expect(merged.find((r) => r.keyword.toLowerCase() === 'cupid shirt')?.searchVolume).toBe(500)
  })
})
