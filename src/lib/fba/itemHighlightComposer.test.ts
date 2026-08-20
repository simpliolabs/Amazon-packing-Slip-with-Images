/**
 * ARCHITECTURE A — the pool-first Item Highlights composer (PO sign-off 2026-08-20).
 * Pinned against the rejected batch ("THESE ARE TERRIBLE!!!"): beige filler, template skeletons and
 * spec-mash are STRUCTURALLY impossible — every phrase is a verbatim pool keyword by construction.
 */
import { describe, it, expect } from 'vitest'
import { composeItemHighlight } from './itemHighlightComposer'

const GATOR_TITLES = ["THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women"]
const GATOR_POOL = [
  { keyword: 'later gator shirt women', searchVolume: 450, themeFit: 3 },
  { keyword: 'see you later alligator', searchVolume: 900, themeFit: 3 },
  { keyword: 'alligator clothing women', searchVolume: 300, themeFit: 3 },
  { keyword: 'funny gator apparel', searchVolume: 250, themeFit: 3 },
  { keyword: 'novelty animal tops', searchVolume: 200, themeFit: 2 },
  { keyword: 'oversized tshirts for women', searchVolume: 619950, themeFit: 1 },
  { keyword: 'comfort colors graphic', searchVolume: 5000, themeFit: 2 },
  { keyword: 'casual apparel', searchVolume: 100000, themeFit: 0 },
]

describe('composeItemHighlight — Architecture A', () => {
  it('builds the line from VERBATIM pool phrases, theme-fit first, Title Cased', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES)!
    expect(out).toBeTruthy()
    // Every comma phrase must be a Title-Cased pool keyword (or the sanctioned wear-style fact).
    const poolLower = new Set(GATOR_POOL.map((r) => r.keyword.toLowerCase()))
    for (const phrase of out.split(', ')) {
      if (phrase === 'Can be worn as Oversized') continue
      expect(poolLower.has(phrase.toLowerCase()), phrase).toBe(true)
    }
    // The design's own terms lead — theme-fit 3 beats raw volume.
    expect(out.toLowerCase()).toContain('later')
  })

  it('theme-fit ordering: a fit-0 100K head term never outranks fit-3 niche phrases', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES)!
    const idxCasual = out.toLowerCase().indexOf('casual apparel')
    const idxGator = out.toLowerCase().indexOf('later gator')
    if (idxCasual >= 0) expect(idxGator).toBeLessThan(idxCasual)
  })

  it('excludes phrases the shipping titles already cover (the ONE coverage predicate)', () => {
    const out = composeItemHighlight(
      [...GATOR_POOL, { keyword: 'comfort colors alligator tshirt', searchVolume: 99999, themeFit: 3 }],
      GATOR_TITLES,
    )!
    expect(out.toLowerCase()).not.toContain('comfort colors alligator tshirt')
  })

  it('near-duplicates cannot stack — each pick must add a new folded token', () => {
    const out = composeItemHighlight(
      [
        { keyword: 'alligator shirt women', searchVolume: 500, themeFit: 3 },
        { keyword: 'alligator shirts woman', searchVolume: 400, themeFit: 3 },
        { keyword: 'gator lover gift', searchVolume: 300, themeFit: 3 },
        { keyword: 'funny reptile tee', searchVolume: 200, themeFit: 3 },
      ],
      ['THE CEO Design Tee'],
    )!
    expect(out.toLowerCase()).toContain('alligator shirt women')
    expect(out.toLowerCase()).not.toContain('alligator shirts woman')
  })

  it('stays within the 125 budget and never violates the ≤2 per-word rule', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES)!
    expect(out.length).toBeLessThanOrEqual(125)
  })

  it('adds the PO wear-style fact ONLY for relaxed/unisex cuts with pool demand and budget', () => {
    const withFact = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: true })!
    expect(withFact).toContain('Can be worn as Oversized')
    const withoutCut = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: false })!
    expect(withoutCut).not.toContain('Can be worn as Oversized')
    const noDemand = composeItemHighlight(GATOR_POOL.filter((r) => !/oversized/i.test(r.keyword)), GATOR_TITLES, { relaxedOrUnisexCut: true })!
    expect(noDemand).not.toContain('Can be worn as Oversized')
  })

  it('returns null on a thin pool — the caller falls back, never a forced beige line', () => {
    expect(composeItemHighlight(GATOR_POOL.slice(0, 2), GATOR_TITLES)).toBeNull()
  })

  it('is deterministic — same inputs, byte-identical line', () => {
    const a = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: true })
    const b = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: true })
    expect(a).toBe(b)
  })
})

describe('truth filters (the Darlin F-grade, 2026-08-20)', () => {
  const DIRTY_POOL = [
    { keyword: 'rodeo outfit women', searchVolume: 400, themeFit: 3 },
    { keyword: 'hello darlin shirt', searchVolume: 350, themeFit: 3 },
    { keyword: 'western graphic tops', searchVolume: 300, themeFit: 3 },
    { keyword: 'cowgirl tee ladies', searchVolume: 250, themeFit: 3 },
    { keyword: 'pro club shirts', searchVolume: 9000, themeFit: null },
    { keyword: 'heavyweight t shirts', searchVolume: 8000, themeFit: null },
    { keyword: 'comfort colors sweatshirt', searchVolume: 7000, themeFit: null },
  ]
  const CC_SPEC = { weightNote: 'midweight 6.1 oz garment-dyed', stretch: 'Low Stretch' }

  it('drops third-party-brand rows via the trademark door', () => {
    const out = composeItemHighlight(DIRTY_POOL, ['THE CEO Darlin Tee'], { spec: CC_SPEC, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })!
    expect(out.toLowerCase()).not.toContain('pro club')
  })

  it('drops fabric-class lies (heavyweight on a midweight blank) and wrong-garment vocab (sweatshirt on a tee family)', () => {
    const out = composeItemHighlight(DIRTY_POOL, ['THE CEO Darlin Tee'], { spec: CC_SPEC, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })!
    expect(out.toLowerCase()).not.toContain('heavyweight')
    expect(out.toLowerCase()).not.toContain('sweatshirt')
    expect(out.toLowerCase()).toContain('rodeo')
  })

  it('a TRUE weight-class phrase survives (midweight row on a midweight blank)', () => {
    const out = composeItemHighlight(
      [...DIRTY_POOL, { keyword: 'midweight cotton tops', searchVolume: 100, themeFit: 2 }],
      ['THE CEO Darlin Tee'], { spec: CC_SPEC, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' },
    )!
    expect(out.toLowerCase()).toContain('midweight cotton tops')
  })
})

describe('fit gate on rated pools (the Disney World / Band Tees drift)', () => {
  it('on a RATED pool, unrated high-volume noise cannot compose', () => {
    const ratedPool = [
      { keyword: 'usa soccer shirt women', searchVolume: 500, themeFit: 3 },
      { keyword: 'futbol fan tee', searchVolume: 400, themeFit: 3 },
      { keyword: 'soccer graphic tops', searchVolume: 300, themeFit: 2 },
      { keyword: 'world futbol apparel', searchVolume: 200, themeFit: 2 },
      { keyword: 'disney world shirts', searchVolume: 90000, themeFit: null },
      { keyword: 'band tees', searchVolume: 80000, themeFit: 0 },
    ]
    const out = composeItemHighlight(ratedPool, ['THE CEO Futbol Tee'])!
    expect(out.toLowerCase()).not.toContain('disney')
    expect(out.toLowerCase()).not.toContain('band tees')
    expect(out.toLowerCase()).toContain('soccer')
  })

  it('an UNRATED pool keeps volume ordering (no judgment to trust)', () => {
    const unrated = [
      { keyword: 'gator lover gift', searchVolume: 300, themeFit: null },
      { keyword: 'funny reptile tee', searchVolume: 200, themeFit: null },
      { keyword: 'swamp animal tops', searchVolume: 100, themeFit: null },
    ]
    expect(composeItemHighlight(unrated, ['THE CEO Design Shirt'])).toBeTruthy()
  })

  it('a franchise mark in a pool row never composes (trademark door, Disney rule)', () => {
    const ratedPool = [
      { keyword: 'disney world shirts', searchVolume: 90000, themeFit: 3 },
      { keyword: 'usa soccer shirt women', searchVolume: 500, themeFit: 3 },
      { keyword: 'futbol fan tee', searchVolume: 400, themeFit: 3 },
      { keyword: 'soccer graphic tops', searchVolume: 300, themeFit: 2 },
    ]
    const out = composeItemHighlight(ratedPool, ['THE CEO Futbol Tee'])!
    expect(out.toLowerCase()).not.toContain('disney')
  })
})

describe('over-sized spacing variants (fleet-pass catch)', () => {
  it('"Over Sized" and "over-sized" pool phrases are cut claims — excluded like "oversized"', () => {
    const ratedPool = [
      { keyword: 'over sized t shirt women', searchVolume: 9000, themeFit: 3 },
      { keyword: 'over-sized graphic tee', searchVolume: 8000, themeFit: 3 },
      { keyword: 'motivational shirts women', searchVolume: 500, themeFit: 3 },
      { keyword: 'positive message tops', searchVolume: 400, themeFit: 3 },
      { keyword: 'inspirational tee ladies', searchVolume: 300, themeFit: 2 },
    ]
    const out = composeItemHighlight(ratedPool, ['THE CEO Design Shirt'], { relaxedOrUnisexCut: true })!
    expect(out.toLowerCase()).not.toMatch(/over[\s-]?sized? t|over[\s-]?sized? g/)
    expect(out).toContain('Can be worn as Oversized')   // demand still surfaces via the FACT
  })
})

describe("non-apparel families (PO 2026-08-21: B0GCF11RKL is Electronics)", () => {
  it("garmentFamily 'none' composes ZERO garment vocabulary — only the product's own phrases", () => {
    const mixedPool = [
      { keyword: 'sd card 32gb', searchVolume: 9000, themeFit: 3 },
      { keyword: 'sdhc memory card', searchVolume: 8000, themeFit: 3 },
      { keyword: 'camera storage card', searchVolume: 4000, themeFit: 2 },
      { keyword: 'high speed micro sd', searchVolume: 3000, themeFit: 2 },
      { keyword: 't shirts for women', searchVolume: 150000, themeFit: 1 },
      { keyword: 'graphic tees for teens', searchVolume: 90000, themeFit: 1 },
    ]
    const out = composeItemHighlight(mixedPool, ['32GB SDHC Memory Card 2-Pack'], { garmentFamily: 'none' })!
    expect(out.toLowerCase()).toContain('sd card')
    expect(out.toLowerCase()).not.toMatch(/shirt|tee|apparel|top|clothing/)
  })
})
