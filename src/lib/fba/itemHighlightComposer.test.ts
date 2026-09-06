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
 *  - 2026-08-21 TRUTH STAGE (14-family review): garment-noun truth, capability claims, audience
 *    truth, theme-fit >= 2 on rated pools, oversized = Comfort Colors ONLY, brand waterfall INSIDE
 *    the composer (never a post-net rewrite).
 */
import { describe, it, expect } from 'vitest'
import { composeItemHighlight, composeItemHighlightDetailed, ihTruthVerdict, ihAudienceOf } from './itemHighlightComposer'
import { ensureBlankBrandInHighlights, DEFAULT_BLANK_SPECS } from './blankSpecs'
import { CONTENT_CONTRACT } from './contentContract'
import { scrubTrademarks } from './trademarkGuard'

const MIN = CONTENT_CONTRACT.itemHighlights.min
const MAX = CONTENT_CONTRACT.itemHighlights.max

/** A CC-like spec: the filler bank (material/fit/neck/sleeve/dye) the floor pad draws from. */
const SPEC = { brand: 'Comfort Colors', material: '100% Ring-Spun Cotton', fit: 'Relaxed', neck: 'Crew Neck', sleeve: 'Short Sleeve', dye: 'Garment-Dyed', weightNote: 'midweight 6.1 oz garment-dyed', stretch: 'Low Stretch' }
/** Gildan 64000 — Classic fit, brand never in copy. */
const GILDAN_SPEC = { brand: 'Gildan', brandInCopy: false, material: 'Ring-Spun Cotton', fit: 'Classic', neck: 'Crew Neck', sleeve: 'Short Sleeve', weightNote: 'lightweight 4.5 oz ring-spun' }

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

  it('the wear-style fact joins ONLY on a Comfort Colors (Relaxed) spec with pool demand; bare over(-)sized never composes', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES, OPTS)!
    expect(out).toContain('Can be worn as Oversized')
    expect(out.toLowerCase()).not.toMatch(/over[\s-]?sized? t/)
    const noDemand = composeItemHighlight(GATOR_POOL.filter((r) => !/over[\s-]?sized?/i.test(r.keyword)), GATOR_TITLES, OPTS)
    if (noDemand) expect(noDemand).not.toContain('Can be worn as Oversized')
  })

  it('PO RULING 2026-08-21 ("A: comfort colors"): the oversized wear-fact is ABSENT on a Gildan Classic-fit spec even with pool demand (Trump families)', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { spec: GILDAN_SPEC, garmentFamily: 'tee', allowedBrand: null })
    expect(out).toBeTruthy()
    expect(out!.toLowerCase()).not.toContain('oversized')
    // unisex alone no longer qualifies: a spec with no brand (mixed-blank intersection) is not CC
    const { brand: _b, ...noBrand } = SPEC
    void _b
    const mixed = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { spec: noBrand, garmentFamily: 'tee', allowedBrand: null })
    if (mixed) expect(mixed).not.toContain('Can be worn as Oversized')
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

  it('PO 2026-08-06: "Unisex Fit" joins the floor-pad filler bank ONLY when blank_specs.unisex is TRUE', () => {
    const smallPool = [
      { keyword: 'rodeo outfit women', searchVolume: 400, themeFit: 3 },
      { keyword: 'hello darlin shirt', searchVolume: 350, themeFit: 3 },
      { keyword: 'cowgirl graphic tops', searchVolume: 300, themeFit: 3 },
    ]
    // the CC spec with the DB unisex flag set (migration 054) — the pad draws material, fit, then the unisex fact
    const thinSpec = { ...SPEC, unisex: true }
    const withUnisex = composeItemHighlight(smallPool, ['THE CEO Darlin Tee | Comfort Colors Shirt'], { spec: thinSpec, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })
    expect(withUnisex).toBeTruthy()
    expect(withUnisex).toContain('Unisex Fit')
    expect(withUnisex!.length).toBeGreaterThanOrEqual(MIN)
    // TASK 6 REGRESSION PIN (2026-09-06): "Unisex Fit" is only interesting here because "Relaxed
    // Fit" is ALSO in the line — the pad-loop's `usedBeforePad` snapshot exemption (Task 2,
    // 2026-08-06 ruling) lets both co-exist even though they share the literal word "Fit" this
    // bank's own templates append. The absolute no-repeat rule (Task 6) must NOT break this: a spec
    // fact repeating a POOL token is still rejected, but "Classic"/"Relaxed" + "Unisex" sharing only
    // boilerplate is not a repeat in the spec's sense.
    expect(withUnisex).toContain('Relaxed Fit')
    const { unisex: _u, ...noUnisex } = thinSpec
    void _u
    const without = composeItemHighlight(smallPool, ['THE CEO Darlin Tee | Comfort Colors Shirt'], { spec: noUnisex, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })
    if (without) expect(without).not.toContain('Unisex Fit')
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

  it('FISHING/OUTDOOR competitor brands + the Salt Life mark never compose (live pools 2026-08-21)', () => {
    const FISHING_POOL = [
      { keyword: 'huk shirts for men', searchVolume: 90000, themeFit: 3 },
      { keyword: 'salt life shirts', searchVolume: 80000, themeFit: 3 },
      { keyword: 'columbia fishing shirts', searchVolume: 70000, themeFit: 3 },
      { keyword: 'under armour fishing shirt', searchVolume: 60000, themeFit: 3 },
      { keyword: 'magellan fishing shirts', searchVolume: 50000, themeFit: 3 },
      { keyword: 'simms fishing shirt', searchVolume: 40000, themeFit: 3 },
      { keyword: 'aftco shirts', searchVolume: 30000, themeFit: 3 },
      { keyword: 'pelagic fishing shirts', searchVolume: 30000, themeFit: 3 },
      { keyword: 'bassdash shirts', searchVolume: 20000, themeFit: 3 },
      { keyword: 'bass fishing shirt', searchVolume: 400, themeFit: 3 },
      { keyword: 'funny fishing shirt', searchVolume: 350, themeFit: 3 },
      { keyword: 'fishing gifts for dad', searchVolume: 300, themeFit: 3 },
      { keyword: 'angler graphic tee', searchVolume: 250, themeFit: 3 },
    ]
    const out = (composeItemHighlight(FISHING_POOL, ['THE CEO Bass Fishing Shirt'], OPTS) ?? '').toLowerCase()
    for (const brand of ['huk', 'salt life', 'columbia', 'under armour', 'magellan', 'simms', 'aftco', 'pelagic', 'bassdash']) {
      expect(out).not.toContain(brand)
    }
    // The verdict names the stage, so the IH_COMPOSER_NULL line can say which door shut.
    expect(ihTruthVerdict('huk shirts for men', TRUTH_TEE)).toEqual({ ok: false, reason: 'competitor-brand' })
    expect(ihTruthVerdict('under armor shirts', TRUTH_TEE)).toEqual({ ok: false, reason: 'competitor-brand' })
    // Salt Life is a registered MARK, not a blank maker: the trademark door rejects it byte-identically.
    expect(scrubTrademarks('salt life shirts')).not.toBe('salt life shirts')
    expect(scrubTrademarks('Salt Life Shirts')).not.toMatch(/salt\s*life/i)
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

describe('unrated pools HOLD (PO ruling 2026-08-21: never improvise from volume order)', () => {
  it('a pool the rater has judged under 30% of returns null BEFORE selection — even when every phrase would otherwise compose', () => {
    const unrated = GATOR_POOL.map((r) => ({ ...r, themeFit: null }))
    expect(composeItemHighlight(unrated, GATOR_TITLES, OPTS)).toBeNull()
    // 2 of 8 rated = 25% < 30% — still unrated
    const barely = GATOR_POOL.map((r, i) => ({ ...r, themeFit: i < 2 ? 3 : null }))
    expect(composeItemHighlight(barely, GATOR_TITLES, OPTS)).toBeNull()
    // 3 of 8 = 37.5% — the rater's verdict governs and only the rated fit-3 phrases may compose
    const rated = GATOR_POOL.map((r, i) => ({ ...r, themeFit: i < 3 ? 3 : null }))
    const out = composeItemHighlight(rated, GATOR_TITLES, OPTS)
    if (out) expect(out.toLowerCase()).not.toContain('casual apparel')
  })

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

/* ─── TRUTH STAGE (PO 2026-08-21, 14-family review) — one pin per live defect ─────────────────── */

const TRUTH_TEE = { garmentFamily: 'tee' as const, spec: GILDAN_SPEC, allowedBrand: null, audience: ihAudienceOf('tee') }
const TRUTH_KIDS = { garmentFamily: 'kids_tee' as const, spec: GILDAN_SPEC, allowedBrand: null, audience: ihAudienceOf('kids_tee') }

describe('ihTruthVerdict — garment-noun truth', () => {
  it('B0H7CMPZR3: a Gildan 64000 TEE never composes "France Soccer Jersey" (a tee is not a jersey)', () => {
    expect(ihTruthVerdict('france soccer jersey', TRUTH_TEE)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    const pool = [
      { keyword: 'france soccer jersey', searchVolume: 90000, themeFit: 3 },
      { keyword: 'france soccer shirt women', searchVolume: 500, themeFit: 3 },
      { keyword: 'les bleus fan tee', searchVolume: 400, themeFit: 3 },
      { keyword: 'french football tops', searchVolume: 300, themeFit: 2 },
      { keyword: 'soccer fan apparel ladies', searchVolume: 250, themeFit: 2 },
      { keyword: 'world futbol graphic shirts', searchVolume: 200, themeFit: 2 },
    ]
    const out = composeItemHighlight(pool, ['THE CEO France Futbol Tee'], { spec: GILDAN_SPEC, garmentFamily: 'tee', allowedBrand: null })
    if (out) expect(out.toLowerCase()).not.toContain('jersey')
  })

  it('B0DMXMH266: "Hooded Fishing Shirts" is rejected on a crew tee; hooded is hoodie-only', () => {
    expect(ihTruthVerdict('hooded fishing shirts for men', TRUTH_TEE)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    // A hoodie IS a hooded sweatshirt (coordinator ruling 2026-08-21): hoodie families accept
    // hoodie(s) / hooded sweatshirt(s) / sweatshirt(s) / pullover(s); only tee nouns (and a crew neck) are foreign.
    const HOODIE = { ...TRUTH_TEE, garmentFamily: 'hoodie' as const, audience: ihAudienceOf('hoodie') }
    for (const p of ['hooded sweatshirt for fishing', 'fishing hoodies for men', 'fishing sweatshirt', 'cozy pullover hoodie', 'fleece pullovers']) {
      expect(ihTruthVerdict(p, HOODIE)).toEqual({ ok: true })
    }
    expect(ihTruthVerdict('fishing tees for men', HOODIE)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(ihTruthVerdict('fishing t shirt', HOODIE)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(ihTruthVerdict('holiday crewneck', HOODIE)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(ihTruthVerdict('fishing hoodie for men', { ...TRUTH_TEE, garmentFamily: 'sweatshirt', audience: ihAudienceOf('sweatshirt') })).toEqual({ ok: false, reason: 'wrong-garment-noun' })
  })

  it("the family's own nouns pass: shirt/tee/t-shirt/tshirt/top on tees; sweatshirt/crewneck/pullover on sweatshirts", () => {
    for (const p of ['fishing shirts for men', 'funny tees', 'graphic t-shirts', 'novelty tshirt', 'cute tops', 'tops & tees']) {
      expect(ihTruthVerdict(p, TRUTH_TEE)).toEqual({ ok: true })
    }
    for (const p of ['funny sweatshirts', 'holiday crewneck', 'cozy pullover']) {
      expect(ihTruthVerdict(p, { ...TRUTH_TEE, garmentFamily: 'sweatshirt' })).toEqual({ ok: true })
    }
    // the wrong direction still rejects (as already coded): tee vocab on a sweatshirt, sweatshirt vocab on a tee
    expect(ihTruthVerdict('funny tees', { ...TRUTH_TEE, garmentFamily: 'sweatshirt' })).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(ihTruthVerdict('holiday crewneck', TRUTH_TEE)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    // other garments are never a tee
    for (const p of ['mens tank top', 'golf polo', 'summer dress']) expect(ihTruthVerdict(p, TRUTH_TEE).ok).toBe(false)
  })

  it("non-apparel ('none') still composes zero garment vocabulary; unresolved (null) family has no noun rule", () => {
    expect(ihTruthVerdict('t shirts for women', { ...TRUTH_TEE, garmentFamily: 'none', audience: null })).toEqual({ ok: false, reason: 'garment-vocab-on-non-apparel' })
    expect(ihTruthVerdict('soccer jersey', { ...TRUTH_TEE, garmentFamily: null, audience: null })).toEqual({ ok: true })
  })
})

describe('ihTruthVerdict — capability claims (no BlankSpec states a capability today ⇒ always rejected)', () => {
  it('B0DMXMH266: "Sun Protection" never composes on a Gildan tee', () => {
    expect(ihTruthVerdict('sun protection fishing shirt', TRUTH_TEE)).toEqual({ ok: false, reason: 'capability-claim' })
  })
  it('the full ban list: UPF / SPF / moisture-wicking / quick-dry / waterproof / water-resistant / thermal / insulated / breathable mesh / antimicrobial / odor-resistant / compression', () => {
    for (const p of ['upf 50 shirts', 'spf fishing tee', 'moisture wicking shirts', 'moisture-wicking tee', 'quick dry shirts', 'quick-dry tops', 'waterproof shirt', 'water resistant tee', 'thermal shirts', 'insulated top', 'breathable mesh shirt', 'antimicrobial tee', 'odor resistant shirts', 'compression shirts']) {
      expect(ihTruthVerdict(p, TRUTH_TEE)).toEqual({ ok: false, reason: 'capability-claim' })
    }
    expect(ihTruthVerdict('breathable cotton shirt', TRUTH_TEE)).toEqual({ ok: true })   // "breathable" alone is not the banned "breathable mesh"
  })
})

describe('ihTruthVerdict — fit-claim truth (Task 4, 2026-09-06: live B0DSCDZC6K shipped "relaxed unisex fit" on a Gildan 18000, whose blank_specs.fit is Classic — a false product claim, indexed by Google)', () => {
  it('rejects "relaxed fit tee" on the Classic-fit blank (TRUTH_TEE / GILDAN_SPEC) with a named reason', () => {
    expect(ihTruthVerdict('relaxed fit tee', TRUTH_TEE)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
  it('accepts "classic fit sweatshirt" on the SAME blank — the claim matches spec.fit', () => {
    expect(ihTruthVerdict('classic fit sweatshirt', { ...TRUTH_TEE, garmentFamily: 'sweatshirt' })).toEqual({ ok: true })
  })
  it('rejects bare "oversized" on a Comfort Colors Relaxed blank — Relaxed != Oversized (the PO\'s 2026-08-20 wear-style fact "Can be worn as Oversized" is a SEPARATE, opt-in claim the composer pushes straight onto `picked` without ever asking this predicate, so it can never be conflated with this rule)', () => {
    const TRUTH_CC = { garmentFamily: 'tee' as const, spec: SPEC, allowedBrand: 'Comfort Colors', audience: ihAudienceOf('tee') }
    expect(ihTruthVerdict('oversized', TRUTH_CC)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
  it('a phrase with no fit word is unaffected', () => {
    expect(ihTruthVerdict('graphic tee for men', TRUTH_TEE)).toEqual({ ok: true })
  })
  it('fails CLOSED: a fit claim with no spec behind it never passes — an unconfirmed blank backs no claim', () => {
    expect(ihTruthVerdict('relaxed fit tee', { ...TRUTH_TEE, spec: null })).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
  it('never touches the spec-fact PAD filler ("${spec.fit} Fit") or "Unisex Fit" — both bypass ihTruthVerdict entirely (composer pushes factFillers straight onto `picked`), and neither would trip this rule even if it did: the pad emits spec.fit verbatim (self-true by construction), and "unisex" is not fit vocabulary', () => {
    expect(ihTruthVerdict('classic fit', TRUTH_TEE)).toEqual({ ok: true })        // the pad's own emitted phrase, self-true
    expect(ihTruthVerdict('unisex fit', TRUTH_TEE)).toEqual({ ok: true })         // "unisex" carries no fit-claim word
  })

  // --- FIX ROUND 1 (2026-09-06) — the Task 4 reviewer (a24c8bba) executed ihTruthVerdict directly
  // against HEAD 2ca9798 and found all of these PASSING (`{ ok: true }`) when every one is the live
  // lie or a variant of it. Root cause: FIT_CLAIM_RE required the fit word immediately adjacent to
  // "fit" (`\s+fit\b`) and phraseTruthVerdict read only the FIRST match. Fixed at contentTruth.ts:546
  // (non-adjacent match, bounded to the comma-delimited segment, separator `[\s-]+`-equivalent via a
  // not-a-comma lazy span) and :613 (iterate every match, reject if ANY is unbacked).
  it('REPRODUCTION: rejects "relaxed unisex fit" on the Classic-fit blank — the exact live B0DSCDZC6K string, non-adjacent ("unisex" sits between the claim word and "fit")', () => {
    expect(ihTruthVerdict('relaxed unisex fit', TRUTH_TEE)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
  it('rejects the full live IH line "cotton blend fabric, relaxed unisex fit, crew neck design, cuff sleeves" on Classic — called directly (as the reviewer did) to prove the predicate itself is comma-segment-safe; in production the composer never hands ihTruthVerdict a multi-segment string like this (candidates are single un-comma\'d 2-5 word pool keywords, itemHighlightComposer.ts:242 `ihTruthVerdict(r.keyword, truthCtx)`) — the realistic per-candidate segment is covered by the REPRODUCTION test above ("relaxed unisex fit" alone)', () => {
    expect(ihTruthVerdict('cotton blend fabric, relaxed unisex fit, crew neck design, cuff sleeves', TRUTH_TEE)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
  it('rejects the hyphenated form "relaxed-fit" on Classic', () => {
    expect(ihTruthVerdict('relaxed-fit', TRUTH_TEE)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
  it('rejects "relaxed fit oversized tee" on a Relaxed blank — the FIRST claim ("relaxed fit") matches spec.fit, but the SECOND, unbacked claim ("oversized") must still be examined, not laundered by the first match being true', () => {
    const TRUTH_CC = { garmentFamily: 'tee' as const, spec: SPEC, allowedBrand: 'Comfort Colors', audience: ihAudienceOf('tee') }
    expect(ihTruthVerdict('relaxed fit oversized tee', TRUTH_CC)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })

  // --- FIX ROUND 2 (final fix wave, 2026-09-06, Important #2) — reproduced against HEAD 7c53fc2 by
  // calling phraseTruthVerdict directly (see the wave's report): on a Relaxed blank, "relaxed oversized
  // fit tee" returned `{ ok: true }` — the lazy span between "relaxed" and "fit" swallowed the bare
  // word "oversized" INSIDE one match, so it was never independently judged (a TRUE claim laundered a
  // LATER FALSE one). "relaxed fit oversized tee" and "oversized relaxed fit tee" already rejected
  // correctly (the false claim sits outside any span). All three orderings must now agree.
  it('Important #2: all three orderings of "relaxed"/"oversized"/"fit" on a Relaxed blank agree — none may let "oversized" be swallowed by the "relaxed ... fit" span', () => {
    const TRUTH_CC = { garmentFamily: 'tee' as const, spec: SPEC, allowedBrand: 'Comfort Colors', audience: ihAudienceOf('tee') }
    // REPRODUCED AS A DEFECT against HEAD 7c53fc2: this ordering alone returned { ok: true } (see the
    // probe in the wave's report) — the fix must flip it to fit-claim-lie, matching the other two.
    expect(ihTruthVerdict('relaxed oversized fit tee', TRUTH_CC)).toEqual({ ok: false, reason: 'fit-claim-lie' })
    expect(ihTruthVerdict('relaxed fit oversized tee', TRUTH_CC)).toEqual({ ok: false, reason: 'fit-claim-lie' })
    expect(ihTruthVerdict('oversized relaxed fit tee', TRUTH_CC)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })

  // --- FIX ROUND 2 (final fix wave, 2026-09-06, T4-b) — FIT_WORD_CANON (titleBand.ts:758) was never
  // mirrored into this rule, and IH's own word list did not even recognize the informal spelling
  // "oversize" (no trailing "d") as a fit claim at all — so a FALSE "oversize" claim on a blank whose
  // spec does NOT back it silently shipped uncaught (the phrase never reached rule (f) in the first
  // place). Recognizing it (mirroring titleBand's own bare-word list) plus the canon map closes that
  // gap without widening the PO's seven-word vocabulary — "oversize" is the SAME word as the
  // already-approved "oversized", not an eighth one.
  it('T4-b (the defect this closes): "oversize tee" (informal spelling) on a Classic blank is now REJECTED — before this fix the word was not recognized at all, so a false claim silently passed', () => {
    expect(ihTruthVerdict('oversize tee', TRUTH_TEE)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
  it('T4-b (FIT_WORD_CANON pin, spec.fit=\'Oversized\'): "oversize tee" (informal) is accepted once the blank\'s OWN spec states the canonical spelling — GREEN both before and after by construction (see the wave\'s report: before this fix "oversize" was not a recognized claim word at all, so the phrase passed trivially; after the fix it passes for the RIGHT reason — recognized, and the canon/containment backs it)', () => {
    expect(ihTruthVerdict('oversize tee', { ...TRUTH_TEE, spec: { ...GILDAN_SPEC, fit: 'Oversized' } })).toEqual({ ok: true })
  })
  it('no false positive: "classic rock shirt" on Classic passes — the suffix ruling stands (a SUFFIX word with no "fit" anywhere in the phrase is ordinary design vocabulary, never a claim)', () => {
    expect(ihTruthVerdict('classic rock shirt', TRUTH_TEE)).toEqual({ ok: true })
  })
  it('a lone "fit" with no preceding claim word is not a claim: "great fit tee" passes (the brief\'s own "crewneck fit for all sizes" example trips the UNRELATED wrong-garment-noun rule (a) — "crewneck" is its own noun class that the plain tee family does not allow, orthogonal to this rule; swapped to an equally lone-"fit" phrase that does not collide with rule (a))', () => {
    expect(ihTruthVerdict('great fit tee', TRUTH_TEE)).toEqual({ ok: true })
  })
  it('SEGMENT-BOUNDED BY DESIGN: "relaxed cotton, unisex fit" passes — "relaxed" (segment 1) and "fit" (segment 2) are in DIFFERENT comma segments, so they may not bind to form a claim; each segment alone carries no claim word, so ok is the correct answer', () => {
    expect(ihTruthVerdict('relaxed cotton, unisex fit', TRUTH_TEE)).toEqual({ ok: true })
  })
})

describe('ihTruthVerdict — audience truth (derived from garmentFamily, never a title)', () => {
  it('B0DP5H8QBT (kids_tee 64000B): women / plus-size / men / ladies / adult phrases are rejected', () => {
    expect(ihAudienceOf('kids_tee')).toBe('kids')
    for (const p of ['motivational shirts women', 't shirts for women', 'plus size tees', 'plus-size tops', 'mens graphic tee', 'ladies tops', 'adult humor shirt', 'shirts for woman', 'womans shirts', 'mans graphic tee', 'lady tops']) {
      expect(ihTruthVerdict(p, TRUTH_KIDS)).toEqual({ ok: false, reason: 'audience-adult-on-kids' })
    }
    expect(ihTruthVerdict('kids dinosaur shirt', TRUTH_KIDS)).toEqual({ ok: true })
  })
  it("a women's (adult) family rejects kids / toddler / youth / boys / girls / baby phrases", () => {
    expect(ihAudienceOf('tee')).toBe('adult')
    for (const p of ['kids dinosaur shirt', 'kid graphic tee', 'toddler tees', 'youth shirts', 'boys tops', 'girls tshirt', 'baby shirt']) {
      expect(ihTruthVerdict(p, TRUTH_TEE)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
    }
    expect(ihTruthVerdict('motivational shirts women', TRUTH_TEE)).toEqual({ ok: true })
  })
  it('the kids family line carries no adult-audience phrase end to end', () => {
    const pool = [
      { keyword: 'motivational shirts women', searchVolume: 9000, themeFit: 3 },
      { keyword: 't shirts for women', searchVolume: 8000, themeFit: 3 },
      { keyword: 'plus size graphic tees', searchVolume: 7000, themeFit: 3 },
      { keyword: 'kids motivational shirt', searchVolume: 500, themeFit: 3 },
      { keyword: 'positive quote tees for kids', searchVolume: 400, themeFit: 3 },
      { keyword: 'inspirational youth tops', searchVolume: 300, themeFit: 3 },
      { keyword: 'school spirit tshirt', searchVolume: 250, themeFit: 2 },
      { keyword: 'growth mindset apparel', searchVolume: 200, themeFit: 2 },
    ]
    const out = composeItemHighlight(pool, ['THE CEO Be Kind Kids Tee'], { spec: GILDAN_SPEC, garmentFamily: 'kids_tee', allowedBrand: null })
    if (out) expect(out.toLowerCase()).not.toMatch(/\b(?:women|woman|womens|ladies|men|mens|adult|plus[\s-]?size)\b/)
  })
})

describe('minimum theme fit 2 on rated pools (B0DQ5YZH38: fit-1 "Band Tees" led the line)', () => {
  it('a fit-1 phrase never composes on a rated pool, even with budget to spare', () => {
    const pool = [
      { keyword: 'band tees', searchVolume: 80000, themeFit: 1 },
      { keyword: 'rock concert shirt women', searchVolume: 500, themeFit: 3 },
      { keyword: 'vintage music tee', searchVolume: 400, themeFit: 3 },
      { keyword: 'guitar graphic tops', searchVolume: 300, themeFit: 3 },
      { keyword: 'music lover apparel', searchVolume: 200, themeFit: 2 },
    ]
    const out = composeItemHighlight(pool, ['THE CEO Rock On Design'], { spec: SPEC, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })
    if (out) expect(out.toLowerCase()).not.toContain('band tees')
  })
})

describe('brand waterfall INSIDE the composer (B0FKFHSCS9: 1717 by override, title lacks the brand)', () => {
  const CC = DEFAULT_BLANK_SPECS[0]
  const NO_BRAND_TITLE = 'THE CEO Later Gator Tee Shirt | Alligator Tshirt for Women'
  const POOL_WITH_BRAND = [
    { keyword: 'later gator shirt women', searchVolume: 450, themeFit: 3 },
    { keyword: 'see you later alligator', searchVolume: 900, themeFit: 3 },
    { keyword: 'comfort colors graphic tee', searchVolume: 5000, themeFit: 3 },
    { keyword: 'comfort colors shirts ladies', searchVolume: 4000, themeFit: 3 },
    { keyword: 'funny gator apparel', searchVolume: 250, themeFit: 3 },
    { keyword: 'novelty animal tops', searchVolume: 200, themeFit: 2 },
    { keyword: 'swamp humor clothing', searchVolume: 150, themeFit: 2 },
  ]

  it('picks exactly ONE brand-bearing POOL phrase when the title lacks the brand; the net passes the line through byte-identical', () => {
    const out = composeItemHighlight(POOL_WITH_BRAND, [NO_BRAND_TITLE], { spec: SPEC, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })!
    expect(out).toBeTruthy()
    expect((out.match(/comfort\s*colors/gi) ?? []).length).toBe(1)
    expect(out).toContain('Comfort Colors Graphic Tee')          // the higher-volume fit-3 pool candidate wins
    expect(out).not.toMatch(/authentic/i)                        // never the post-net rewrite
    expect(ensureBlankBrandInHighlights(out, [NO_BRAND_TITLE], CC)).toBe(out)
    expect(out.length).toBeGreaterThanOrEqual(MIN)
    expect(out.length).toBeLessThanOrEqual(MAX)
  })

  it('falls back to the deterministic spec phrase "<Brand> <garment noun>" when no pool candidate carries the brand', () => {
    const pool = POOL_WITH_BRAND.filter((r) => !/comfort/i.test(r.keyword))
    const out = composeItemHighlight(pool, [NO_BRAND_TITLE], { spec: SPEC, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })!
    expect(out).toBeTruthy()
    expect(out).toContain('Comfort Colors Tee')
    expect((out.match(/comfort\s*colors/gi) ?? []).length).toBe(1)
    expect(ensureBlankBrandInHighlights(out, [NO_BRAND_TITLE], CC)).toBe(out)
    const ls = composeItemHighlight(pool, [NO_BRAND_TITLE], { spec: { ...SPEC, sleeve: 'Long Sleeve' }, garmentFamily: 'long_sleeve_tee', allowedBrand: 'Comfort Colors' })!
    expect(ls).toContain('Comfort Colors Long Sleeve Shirt')
  })

  it('when EVERY title already carries the brand, no brand phrase is forced (brand-once still holds)', () => {
    const out = composeItemHighlight(POOL_WITH_BRAND, [GATOR_TITLES[0]], { spec: SPEC, garmentFamily: 'tee', allowedBrand: 'Comfort Colors' })!
    expect((out.match(/comfort\s*colors/gi) ?? []).length).toBeLessThanOrEqual(1)
    expect(out).not.toContain('Comfort Colors Tee,')
  })

  it('a brand-forbidden blank (Gildan, allowedBrand null) never gets a brand phrase', () => {
    const out = composeItemHighlight(POOL_WITH_BRAND, [NO_BRAND_TITLE], { spec: GILDAN_SPEC, garmentFamily: 'tee', allowedBrand: null })
    if (out) expect(out.toLowerCase()).not.toMatch(/comfort colors|gildan/)
  })
})

/* ─── TASK 2 (2026-09-06, PO "Why is Women repeating Twice?") — SUPERSEDED BY TASK 6 ────────────
 *
 * Root cause: the selection loops accepted a candidate that added only ONE new folded token
 * ("Fall Sweatshirts for Women" adds only `fall`) ahead of an all-new candidate ("Graphic Pullover
 * Top" / "Novelty Retro Graphic"), purely because the repeat-heavy one sorted higher on theme-fit
 * or volume. Amazon's ≤2-per-word cap then passed the line because each repeat landed exactly
 * twice. Task 2's fix ranked in two tiers — Tier A (every token new) fills before a Tier-B
 * FALLBACK (repeats a used token) — in BOTH the pool-phrase loop and the spec-fact floor-pad loop,
 * engaging Tier B only once Tier A was exhausted and the line was still short of the fill band.
 *
 * TASK 6 (2026-09-06, PO ruling verbatim "2. No Repeat as per Amazon Ruules" — rejecting the
 * controller's proposed amendment "no repeat unless the 107 floor cannot otherwise be reached
 * truthfully"): the Tier-B FALLBACK above is DELETED, not gated. Three consequences for the tests
 * below (each documented at its own site, not just here):
 *  1. the first test is REWRITTEN, not merely re-asserted: its original 4-phrase pool only ever
 *     yields 2 mutually non-repeating pool phrases, which is below MIN_CANDIDATES and now HOLDS
 *     regardless of spec (the too-few-picked gate fires before the pad loop ever runs) — a THIRD
 *     all-new phrase is added so a genuine composition still exists to pin `womenCount === 1` on
 *     (the assertion the final reviewer flagged as untested in the branch where it bites).
 *  2. the second test — "the Tier-B fallback is real" — is the one the brief names to INVERT: same
 *     pool, same absence of spec, but now proves the HOLD instead of the fallback (not deleted).
 *  3. the third test's own pool ALSO secretly required its OWN pool loop's Tier-B fallback
 *     ("weekend adventure look", which repeated `weekend`) to reach a length where the pad loop's
 *     `fit` filler alone could cross MIN — under the absolute rule that candidate is rejected
 *     forever, so it is swapped for one more all-new phrase, keeping this test isolated to the PAD
 *     loop's tier rule (which is genuinely unchanged in shape, only Tier B is gone).
 *
 * NOTE (Task 2, still true): the brief's own illustrative pool ("Graphic Pullover Top" as the
 * all-new candidate) does NOT discriminate old vs. new code with these keywords — "top" matches
 * GARMENT_SURFACE_RE, so the PRE-EXISTING "prefer a new garment surface" pass already promotes it
 * ahead of "Fall Sweatshirts for Women" on unmodified source. The tests below keep the same shape
 * (fit/volume, the `women`/`sweatshirt`/`crewneck` repeats) but swap the all-new candidate for one
 * with NO garment surface match, which genuinely isolates the tier rule. */
describe('TASK 2/6: a phrase repeating a used token is REJECTED, never a fallback (PO 2026-09-06)', () => {
  it('the absolute rule composes with the repeat-heavy candidates excluded entirely — `women` appears exactly ONCE even though the repeat candidate sorts higher on volume (the pin the final reviewer flagged as untested)', () => {
    const pool = [
      { keyword: 'crewneck sweatshirts women', searchVolume: 900, themeFit: 3 },
      { keyword: 'fall sweatshirts for women', searchVolume: 850, themeFit: 3 },   // repeats `sweatshirt`/`women` — NEVER composes since Task 6
      { keyword: 'novelty retro graphic', searchVolume: 800, themeFit: 3 },        // all new, no garment-surface head start
      { keyword: 'weekend getaway vibe', searchVolume: 750, themeFit: 3 },         // TASK 6: 3rd all-new pool phrase — MIN_CANDIDATES needs 3, and the original 2-pick pool now HOLDS regardless of spec (see file-header note)
      { keyword: 'long sleeve crewneck', searchVolume: 600, themeFit: 2 },         // repeats `crewneck` — NEVER composes since Task 6
    ]
    const spec = { material: '100% Cotton Blend', fit: 'Relaxed', unisex: true, neck: 'Crew Neck', sleeve: 'Short Sleeve', dye: 'Garment-Dyed' }
    const out = composeItemHighlight(pool, [], { spec: spec as any })!
    expect(out).toBeTruthy()
    expect(out.length).toBeGreaterThanOrEqual(MIN)
    expect(out.length).toBeLessThanOrEqual(MAX)
    expect(out.toLowerCase()).toContain('novelty retro graphic')
    expect(out.toLowerCase()).toContain('weekend getaway vibe')
    // the repeat candidates never compose, full stop — not merely deprioritized behind a fallback
    expect(out.toLowerCase()).not.toContain('fall sweatshirts for women')
    expect(out.toLowerCase()).not.toContain('long sleeve crewneck')
    const womenCount = (out.match(/\bwomen\b/gi) ?? []).length
    expect(womenCount).toBe(1)
  })

  it('INVERTED (PO ruling 2026-09-06, "2. No Repeat as per Amazon Ruules"): the Tier-B fallback this test used to prove was REAL is now DEAD. Tier A alone ("Crewneck Sweatshirts Women" + "Novelty Retro Graphic", ~49 chars) cannot reach the 107-char floor without repeating `sweatshirt`/`crewneck`/`women`, and no `spec` is passed, so the design HOLDS `under-floor-no-repeat` instead of composing a repeat to get there. This exact pool is the branch\'s recorded reproduction: run unmodified (HEAD f64175f), it composes a 122-char line containing `crewneck`x2/`sweatshirt`x2/`women`x2/`sleeve`x2 — the defect this ruling closes.', () => {
    const pool = [
      { keyword: 'crewneck sweatshirts women', searchVolume: 900, themeFit: 3 },
      { keyword: 'fall sweatshirts for women', searchVolume: 850, themeFit: 3 },   // repeats sweatshirt/women
      { keyword: 'novelty retro graphic', searchVolume: 800, themeFit: 3 },        // Tier A
      { keyword: 'long sleeve crewneck', searchVolume: 600, themeFit: 2 },         // repeats crewneck
      { keyword: 'sleeve detail graphic', searchVolume: 550, themeFit: 2 },        // repeats sleeve (once `long sleeve crewneck` would have composed it under the old fallback)
    ]
    // Tier A alone is ~49 chars — nowhere near the 107 floor — and only 2 pool phrases, under
    // MIN_CANDIDATES(3) too. No spec is passed, so there is no pad path either. Before Task 6 this
    // ran the pool loop's OWN Tier-B fallback to reach 107+ (the test this replaces asserted exactly
    // that); that fallback is deleted, so this now HOLDS.
    const res = composeItemHighlightDetailed(pool, [], {})
    expect(res.line).toBeNull()
    expect(res.stage).toBe('under-floor-no-repeat')
    expect(composeItemHighlight(pool, [], {})).toBeNull()
  })

  it('the spec-fact PAD loop applies the same absolute rule: a repeat-token filler (`material` restating `cotton`) never composes; a non-repeating one (`fit`) that alone reaches the floor does', () => {
    const pool = [
      { keyword: 'soft cotton graphic tee', searchVolume: 900, themeFit: 3 },
      { keyword: 'retro vibes design', searchVolume: 800, themeFit: 3 },
      { keyword: 'casual weekend style', searchVolume: 700, themeFit: 3 },
      { keyword: 'bright bold statement print', searchVolume: 650, themeFit: 3 },  // TASK 6: swapped in for the original "weekend adventure look" (repeated `weekend`, only ever composed via the pool loop's own now-deleted Tier-B fallback) — this pool is now fully Tier-A internally, isolating the PAD loop's own tier rule
    ]
    // `material` is FIRST in the filler priority bank but repeats `cotton` — REJECTED absolutely,
    // never merely deprioritized. `fit` is later in priority but all-new and, alone, sufficient to
    // cross MIN once the (now fully Tier-A) pool phrases have filled the line.
    const spec = { material: '100% Cotton', fit: 'Super Relaxed' }
    const out = composeItemHighlight(pool, [], { spec: spec as any })!
    expect(out).toBeTruthy()
    expect(out.length).toBeGreaterThanOrEqual(MIN)
    expect(out.length).toBeLessThanOrEqual(MAX)
    expect(out).toContain('Super Relaxed Fit')
    expect(out).not.toContain('100% Cotton')
  })
})
