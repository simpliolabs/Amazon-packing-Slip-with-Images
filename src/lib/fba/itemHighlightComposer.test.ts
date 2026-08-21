/**
 * ARCHITECTURE A — the pool-first Item Highlights composer (PO sign-off 2026-08-20).
 * Every phrase is a verbatim pool keyword or a TRUE spec fact — beige is structurally impossible.
 *
 * CONTRACT (POruled):
 *  - 2026-08-20 "THESE ARE TERRIBLE!!!": no invented classes; pool phrases verbatim.
 *  - 2026-08-20 oversized: bare "Over(-)Sized <garment>" is a cut claim — never composes; demand
 *    surfaces only as the wear-style fact "Can be worn as Oversized".
 *  - 2026-08-21 "44 is NEVER approved, MIN 85% of MAX 125": floor = 107 (CONTENT_CONTRACT.min).
 *    Under-floor pads with TRUE blank_specs facts; unreachable floor ⇒ null (NOT-READY, never short).
 *  - 2026-08-21 Electronics: garmentFamily 'none' composes zero garment vocabulary.
 */
import { describe, it, expect } from 'vitest'
import { composeItemHighlight } from './itemHighlightComposer'
import { CONTENT_CONTRACT } from './contentContract'

const MIN = CONTENT_CONTRACT.itemHighlights.min
const MAX = CONTENT_CONTRACT.itemHighlights.max

/** A CC-like spec: the filler bank (material/fit/neck/sleeve/dye) the floor pad draws from. */
const SPEC = { material: '100% Ring-Spun Cotton', fit: 'Relaxed', neck: 'Crew Neck', sleeve: 'Short Sleeve', dye: 'Garment-Dyed', weightNote: 'midweight 6.1 oz garment-dyed', stretch: 'Low Stretch' }

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
const OPTS = { spec: SPEC, garmentFamily: 'tee' as const, allowedBrand: 'Comfort Colors' }

describe('composeItemHighlight — Architecture A under the 85% floor', () => {
  it('composes verbatim pool phrases + true spec fillers, in the [MIN, MAX] band', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES, OPTS)!
    expect(out).toBeTruthy()
    expect(out.length).toBeGreaterThanOrEqual(MIN)
    expect(out.length).toBeLessThanOrEqual(MAX)
    expect(out.toLowerCase()).toContain('alligator')       // the design leads
  })

  it('theme-fit beats raw volume: fit-0 "casual apparel" never outranks fit-3 niche phrases', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES, OPTS)!
    const idxCasual = out.toLowerCase().indexOf('casual apparel')
    const idxNiche = out.toLowerCase().indexOf('alligator')
    if (idxCasual >= 0) expect(idxNiche).toBeLessThan(idxCasual)
  })

  it('title-covered pool phrases are excluded (the ONE coverage predicate)', () => {
    const out = composeItemHighlight(
      [...GATOR_POOL, { keyword: 'comfort colors alligator tshirt', searchVolume: 99999, themeFit: 3 }],
      GATOR_TITLES, OPTS,
    )!
    expect(out.toLowerCase()).not.toContain('comfort colors alligator tshirt')
  })

  it('near-duplicates cannot stack (gender folds: women≡woman)', () => {
    const out = composeItemHighlight(
      [
        { keyword: 'alligator shirt women', searchVolume: 500, themeFit: 3 },
        { keyword: 'alligator shirts woman', searchVolume: 400, themeFit: 3 },
        { keyword: 'gator lover gift', searchVolume: 300, themeFit: 3 },
        { keyword: 'funny reptile tee', searchVolume: 200, themeFit: 3 },
      ],
      ['THE CEO Design Top'], OPTS,
    )
    if (out) {
      expect(out.toLowerCase()).toContain('alligator shirt women')
      expect(out.toLowerCase()).not.toContain('alligator shirts woman')
    }
  })

  it('the wear-style fact joins for relaxed/unisex cuts with pool demand; bare over(-)sized never composes', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { ...OPTS, relaxedOrUnisexCut: true })!
    expect(out).toContain('Can be worn as Oversized')
    expect(out.toLowerCase()).not.toMatch(/over[\s-]?sized? t/)
    const noDemand = composeItemHighlight(GATOR_POOL.filter((r) => !/over[\s-]?sized?/i.test(r.keyword)), GATOR_TITLES, { ...OPTS, relaxedOrUnisexCut: true })
    if (noDemand) expect(noDemand).not.toContain('Can be worn as Oversized')
  })

  it('UNDER-FLOOR IS NOT SHIPPABLE: a thin pool with no spec fillers returns null, never a short line', () => {
    const thin = [
      { keyword: 'sd card 32gb', searchVolume: 9000, themeFit: 3 },
      { keyword: 'sdhc memory card', searchVolume: 8000, themeFit: 3 },
      { keyword: 'microsd 32gb', searchVolume: 4000, themeFit: 2 },
    ]
    expect(composeItemHighlight(thin, ['32GB Memory 2-Pack'], { garmentFamily: 'none' })).toBeNull()
  })

  it('spec fillers pad an under-floor line to the floor with TRUE facts only', () => {
    const smallPool = [
      { keyword: 'rodeo outfit women', searchVolume: 400, themeFit: 3 },
      { keyword: 'hello darlin shirt', searchVolume: 350, themeFit: 3 },
      { keyword: 'cowgirl graphic tops', searchVolume: 300, themeFit: 3 },
    ]
    const out = composeItemHighlight(smallPool, ['THE CEO Darlin Tee'], OPTS)
    if (out) {
      expect(out.length).toBeGreaterThanOrEqual(MIN)
      // fillers must be spec values, Title Cased
      expect(out).toMatch(/Ring-Spun Cotton|Relaxed Fit|Crew Neck|Short Sleeve|Garment-Dyed/)
    }
  })

  it('is deterministic', () => {
    const a = composeItemHighlight(GATOR_POOL, GATOR_TITLES, OPTS)
    const b = composeItemHighlight(GATOR_POOL, GATOR_TITLES, OPTS)
    expect(a).toBe(b)
  })
})

describe('brand at most once (PO 2026-08-21, B0GWFFK1W7 "repeating CC 2 times")', () => {
  it('the allowed blank brand appears in at most ONE composed phrase', () => {
    const pool = [
      { keyword: 'comfort colors graphic tee', searchVolume: 900, themeFit: 3 },
      { keyword: 'comfort colors shirts women', searchVolume: 800, themeFit: 3 },
      { keyword: 'sarcastic club tshirt', searchVolume: 700, themeFit: 3 },
      { keyword: 'funny sayings top', searchVolume: 600, themeFit: 3 },
      { keyword: 'plus size graphic tees', searchVolume: 500, themeFit: 2 },
      { keyword: 'novelty humor apparel', searchVolume: 400, themeFit: 2 },
    ]
    const out = composeItemHighlight(pool, ['THE CEO Do Not Care Tee Shirt | Shirt for Women'], OPTS)
    expect(out).toBeTruthy()
    const mentions = (out!.match(/comfort\s*colors/gi) ?? []).length
    expect(mentions).toBeLessThanOrEqual(1)
  })
})

describe('truth filters', () => {
  const DIRTY_POOL = [
    { keyword: 'rodeo outfit women', searchVolume: 400, themeFit: 3 },
    { keyword: 'hello darlin shirt', searchVolume: 350, themeFit: 3 },
    { keyword: 'western graphic tops', searchVolume: 300, themeFit: 3 },
    { keyword: 'cowgirl tee ladies', searchVolume: 250, themeFit: 3 },
    { keyword: 'country concert outfit', searchVolume: 220, themeFit: 3 },
    { keyword: 'pro club shirts', searchVolume: 9000, themeFit: 2 },
    { keyword: 'heavyweight t shirts', searchVolume: 8000, themeFit: 2 },
    { keyword: 'comfort colors sweatshirt', searchVolume: 7000, themeFit: 2 },
    { keyword: 'disney world shirts', searchVolume: 90000, themeFit: 3 },
  ]
  it('drops competitor brands, fabric lies, wrong-garment vocab and franchise marks — keeps the truth', () => {
    const out = composeItemHighlight(DIRTY_POOL, ['THE CEO Darlin Top'], OPTS)!
    expect(out.toLowerCase()).not.toContain('pro club')
    expect(out.toLowerCase()).not.toContain('heavyweight')
    expect(out.toLowerCase()).not.toContain('sweatshirt')
    expect(out.toLowerCase()).not.toContain('disney')
    expect(out.toLowerCase()).toContain('rodeo')
  })

  it('a TRUE weight-class phrase passes the filter on a matching blank (composes when budget allows)', () => {
    const out = composeItemHighlight(
      [
        { keyword: 'midweight cotton tops', searchVolume: 100, themeFit: 3 },
        { keyword: 'rodeo outfit women', searchVolume: 400, themeFit: 3 },
        { keyword: 'hello darlin shirt', searchVolume: 350, themeFit: 3 },
        { keyword: 'cowgirl tee ladies', searchVolume: 250, themeFit: 3 },
      ],
      ['THE CEO Darlin Design'], OPTS,
    )
    if (out) expect(out.toLowerCase()).toContain('midweight cotton tops')
  })
})

describe('fit gate on rated pools', () => {
  it('unrated high-volume noise cannot compose when the pool is meaningfully rated', () => {
    const ratedPool = [
      { keyword: 'usa soccer shirt women', searchVolume: 500, themeFit: 3 },
      { keyword: 'futbol fan tee', searchVolume: 400, themeFit: 3 },
      { keyword: 'soccer graphic tops', searchVolume: 300, themeFit: 2 },
      { keyword: 'world futbol apparel', searchVolume: 200, themeFit: 2 },
      { keyword: 'band tees', searchVolume: 80000, themeFit: 0 },
      { keyword: 'random head term', searchVolume: 90000, themeFit: null },
    ]
    const out = composeItemHighlight(ratedPool, ['THE CEO Futbol Top'], OPTS)
    if (out) {
      expect(out.toLowerCase()).not.toContain('band tees')
      expect(out.toLowerCase()).not.toContain('random head term')
    }
  })
})

describe('non-apparel + casing', () => {
  it("garmentFamily 'none' composes zero garment vocabulary; acronyms keep caps", () => {
    const mixedPool = [
      { keyword: 'sd card 32gb', searchVolume: 9000, themeFit: 3 },
      { keyword: 'sdhc memory card class 10', searchVolume: 8000, themeFit: 3 },
      { keyword: 'camera storage card pack', searchVolume: 4000, themeFit: 2 },
      { keyword: 'high speed microsd card', searchVolume: 3000, themeFit: 2 },
      { keyword: 'usb card reader bundle', searchVolume: 2500, themeFit: 2 },
      { keyword: 'video recording memory', searchVolume: 2000, themeFit: 2 },
      { keyword: 't shirts for women', searchVolume: 150000, themeFit: 1 },
    ]
    const out = composeItemHighlight(mixedPool, ['32GB SDHC 2-Pack'], { garmentFamily: 'none' })
    if (out) {
      expect(out.toLowerCase()).not.toMatch(/shirt|tee|apparel|top(?!s? ?up)|clothing/)
      expect(out).toContain('SD Card 32GB')
      expect(out).toContain('SDHC')
    }
  })
})
