import { describe, it, expect } from 'vitest'
import { guaranteedIdentitySynonyms } from '@/lib/keyword-engine/keywordResearcher'
import {
  collapseRepeatedWords,
  enforceInclusiveAudience,
  enforceTitleBand,
  fixApostropheCase,
  isTitleWasteVocabulary,
  scrubUnspecdGarmentClaims,
  stripTitleWasteVocabulary,
  stripVariantColorWords,
  tryMoneyTail,
  TITLE_BAND_LO,
  TITLE_BAND_HI,
  type MoneyTailCtx,
  type TitleBandCtx,
  type TitleWasteCtx,
} from './titleBand'

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PO RULING 2026-08-09 (SELLER_PROFILE §3, the B0GVV3XL4T rewrite). The PO rewrote the AI's title:
 *   AI:  THE CEO 2026 World Soccer Cup USA Mexico Canada Unisex Tee | Classic Fit   (72)
 *   PO:  THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee   (72)
 * Same budget; the PO spent 19 characters on a money keyword instead of two product facts. Three
 * rules fall out, and this file pins all three on COMPOSED bytes — the defect shipped through a
 * composition of nets, not through any single function:
 *   1. MONEY TAIL BEATS A SPEC-FACT TAIL (enforceMoneyTail's 'brand-tail' narrowing)
 *   2. "Unisex" / "Classic Fit" are not title words     (stripTitleWasteVocabulary)
 *   3. "Football" is a required soccer synonym          (keyword-engine/identitySynonyms.test.ts)
 */

/** Gildan 64000 — the blank whose REAL `fit` is "Classic", which is exactly why rule 2 needs a net
 *  and not a scrub: `scrubUnspecdGarmentClaims` correctly KEEPS "Classic Fit" here (the spec backs
 *  it), so the only thing that can remove it from a TITLE is a rule that says titles are different. */
const GILDAN_SPEC = { fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun' }
/** Gildan is `brand_in_copy=false` (§2), so the canonical shopper-facing brand is EMPTY — the exact
 *  condition under which the money tail's brand guard must not fire. */
const GILDAN_BAND: TitleBandCtx = {
  apparel: true,
  garmentBrand: null,
  spec: { fit: 'Classic Fit', sleeve: 'Short Sleeve', neck: 'Crew Neck' },
  garmentSecond: 'Shirt',
}
/** How the door composes `protect` (listingPipeline.ts:7999): the design name PLUS its §6 identity
 *  siblings, from the SAME map the pool injection uses. "Football" is this design's own concept in
 *  the spelling the rest of the world uses, so a pipe-right carrying it is carrying the DESIGN —
 *  which is what keeps the PO's soccer gold un-churnable by a merely-different money keyword. */
const doorProtect = (design: string): string =>
  [design, ...guaranteedIdentitySynonyms(design).map((s) => s.synonym)].join(' ')

const SOCCER_MONEY: MoneyTailCtx = {
  apparel: true, lean: null, spec: GILDAN_SPEC, protect: doorProtect('2026 World Soccer Cup'), garmentBrand: null,
}
/** What the money-keyword derivation hands the door for this listing once "football" is available as
 *  a phrase (rule 3): opportunity-sorted, 3-5 words, each carrying a garment noun. */
const SOCCER_KWS = ['usa mexico canada football tee', 'football tee shirt', 'soccer shirts for women']

const AI_TITLE = 'THE CEO 2026 World Soccer Cup USA Mexico Canada Unisex Tee | Classic Fit'
const PO_TITLE = 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee'

/**
 * Mirrors the wire order of `bandTitle` (listingPipeline.ts:7928) so every assertion below is made
 * on the bytes that actually persist:
 *   fixApostropheCase → scrubUnspecdGarmentClaims → capTitle75 → collapseRepeatedWords →
 *   stripTitleWasteVocabulary → tryMoneyTail → stripVariantColorWords → enforceInclusiveAudience →
 *   enforceTitleBand
 * `capTitle75` is the one stage not reproduced (it lives inside the 9,400-line pipeline and is not
 * exported); every fixture here is already ≤75 so it would be the identity function.
 */
const door = (
  title: string,
  opts: { band: TitleBandCtx; money: MoneyTailCtx; spec?: { fit?: string | null; weightNote?: string | null } | null; kws?: readonly string[] | null; protect?: string | null },
): string => {
  const cased = fixApostropheCase(title)
  const truth = scrubUnspecdGarmentClaims(cased, opts.spec ?? null).title
  let t = collapseRepeatedWords(truth).title
  t = stripTitleWasteVocabulary(t, { apparel: true, band: { ...opts.band }, moneyKws: opts.kws ?? null, money: opts.money }).title
  const mt = tryMoneyTail(t, opts.kws ?? null, opts.money)
  if (mt.applied) t = mt.title
  t = stripVariantColorWords(t, { apparel: true, protect: opts.protect ?? null, band: { ...opts.band } }).title
  t = enforceInclusiveAudience(t, { apparel: true, lean: opts.money.lean ?? null, band: { ...opts.band } }).title
  return enforceTitleBand(t, { ...opts.band }).title
}

/* ── THE THREE PO GOLDS ──────────────────────────────────────────────────────────────────────────
 * §3: "Protected as test fixtures — no net may alter them." All three, through the WHOLE composed
 * door, under attack keywords. Two of them were live-mutated before this change (the dedupe was
 * deleting the second garment noun); pinning the third gold is what exposed it. */
const CC_SPEC = { fit: 'Relaxed', weightNote: 'midweight 6.1 oz garment-dyed' }
const CC_BAND: TitleBandCtx = {
  apparel: true,
  garmentBrand: 'Comfort Colors',
  spec: { fit: 'Relaxed Fit', sleeve: 'Short Sleeve', neck: 'Crew Neck' },
  garmentSecond: 'Tee',
}
/** Each gold with the ATTACK keyword lists it must survive. The lists are what that listing's own
 *  derivation would hand the door (opportunity-sorted target-set rows for THAT design) plus
 *  deliberately hostile extras — a keyword that fits the band and shares no vocabulary with the
 *  title is the shape that killed titles in the pre-guard probe. */
const GOLDS: Array<{ name: string; title: string; len: number; protect: string; band: TitleBandCtx; money: MoneyTailCtx; spec: { fit?: string | null; weightNote?: string | null } | null; attacks: (readonly string[] | null)[] }> = [
  {
    name: 'gold #1 alligator (2026-07-22)',
    title: 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt',
    len: 72,
    protect: 'See You Later Alligator',
    band: CC_BAND,
    spec: CC_SPEC,
    money: { apparel: true, lean: null, spec: CC_SPEC, protect: 'See You Later Alligator', garmentBrand: 'Comfort Colors' },
    attacks: [null, ['comfort colors shirts for women'], ['cute graphic tshirts for women'], ['funny gator tees for women'], SOCCER_KWS],
  },
  {
    name: 'gold #2 praise-him (B0FKKN8XKV, 2026-08-08)',
    title: 'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women',
    len: 74,
    protect: 'I Will Praise Him in Every Season',
    band: CC_BAND,
    spec: CC_SPEC,
    money: { apparel: true, lean: 'female', spec: CC_SPEC, protect: 'I Will Praise Him in Every Season', garmentBrand: 'Comfort Colors' },
    // Its own money keyword leads, exactly as the opportunity-sorted derivation produces it, so the
    // loop short-circuits on 'already-covered' — the slot is satisfied and nothing may be installed
    // past it. (Without its own keyword in the list this tail is replaceable, and always has been:
    // 'Christian Shirts for Women' matched no fact token, so the pre-ruling guard never held it.)
    attacks: [null, ['christian shirts for women', 'cute graphic tshirts for women'], ['comfort colors shirts for women']],
  },
  {
    name: 'gold #3 soccer (B0GVV3XL4T, 2026-08-09)',
    title: PO_TITLE,
    len: 72,
    protect: '2026 World Soccer Cup',
    band: GILDAN_BAND,
    spec: GILDAN_SPEC,
    money: SOCCER_MONEY,
    attacks: [null, SOCCER_KWS, ['cute graphic tshirts for women', 'comfort colors shirts for women'], ['christian shirts for women']],
  },
]

describe('PO golds — byte-identical through the COMPOSED door', () => {
  it.each(GOLDS.map((g) => [g.name, g] as const))('%s is pinned at its recorded length', (_n, g) => {
    expect(g.title.length).toBe(g.len)
    expect(g.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(g.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it.each(GOLDS.map((g) => [g.name, g] as const))('%s survives the door under ATTACK keywords', (_n, g) => {
    for (const kws of g.attacks) {
      expect(door(g.title, { band: g.band, money: g.money, spec: g.spec, kws, protect: g.protect })).toBe(g.title)
    }
  })

  it('gold #3 is protected by its own CONCEPT, not by luck of the candidate list', () => {
    // The tail "USA Mexico Canada Football Tee" carries no brand and no spec fact, so after the
    // ruling only the design-right guard can hold it — and it only holds because §6's soccer ≡
    // football fold puts "football" in the design's own token set. Without the fold this gold is
    // replaceable by any keyword that happens to fit, which is churn, not optimisation.
    expect(guaranteedIdentitySynonyms('2026 World Soccer Cup').map((s) => s.synonym).sort()).toEqual(['football', 'futbol'])
    const bare: MoneyTailCtx = { ...SOCCER_MONEY, protect: '2026 World Soccer Cup' }
    expect(tryMoneyTail(PO_TITLE, ['cute graphic tshirts for women'], bare).applied).toBe(true)   // unfolded → churnable
    expect(tryMoneyTail(PO_TITLE, ['cute graphic tshirts for women'], SOCCER_MONEY).applied).toBe(false) // folded → held
  })

  it('THE REGRESSION THAT PINNING GOLD #3 EXPOSED: the dedupe used to eat the second garment noun', () => {
    // Live before this change, verified by running the shipped function:
    //   gold #1 72 → 66 (removed ["Shirt"])   ·   gold #3 72 → 68 (removed ["Tee"])
    // Both are the golds' deliberate noun ×2 across the pipe. Gold #2 escaped only because "Tee"
    // and "Shirts" are different letters. A repeat INSIDE one segment is still the #148 defect.
    for (const g of GOLDS) {
      const v = collapseRepeatedWords(g.title)
      expect(v.removed).toEqual([])
      expect(v.title).toBe(g.title)
    }
    const live148 = 'THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt, Tshirt for Women'
    expect(collapseRepeatedWords(live148).removed).toEqual(['Tshirt'])
    // A third occurrence of the same noun is still a repeat — "×2" is a cap, not a licence.
    expect(collapseRepeatedWords('THE CEO Tee Shirt | Cotton Tee | Graphic Tee').removed).toEqual(['Tee'])
  })
})

/* ── RULE 2: "Unisex" and "Classic Fit" are not title words ─────────────────────────────────────── */
describe('stripTitleWasteVocabulary', () => {
  const ctx = (over: Partial<TitleWasteCtx> = {}): TitleWasteCtx =>
    ({ apparel: true, band: GILDAN_BAND, moneyKws: null, money: SOCCER_MONEY, ...over })

  it('THE PO SPECIMEN: "Unisex" goes and the freed chars are handed to the money keyword', () => {
    const v = stripTitleWasteVocabulary(AI_TITLE, ctx({ moneyKws: SOCCER_KWS }))
    expect(v.decision).toBe('stripped')
    expect(v.title).toBe('THE CEO 2026 World Soccer Cup USA Mexico Canada Tee | Classic Fit')
    expect(v.title).not.toMatch(/unisex/i)
    // Returned UN-padded on purpose: the very next door stage installs the keyword in that space.
    expect(v.note).toMatch(/freed 7 chars for money keyword/)
  })

  it('strips "Classic Fit" mid-title when the title still lands in 70-75 (arm 2, no keyword)', () => {
    // 73 chars in, "Classic Fit " out (-12) → 61, and the facts pad lifts it back into the band
    // from a REAL Gildan fact ("Crew Neck") — arm 2 in full: removal + re-fill judged together.
    const t = 'THE CEO See You Later Alligator Classic Fit Graphic Tee Shirt Cotton Ring'
    expect(t.length).toBe(73)
    const v = stripTitleWasteVocabulary(t, ctx())
    expect(v.decision).toBe('stripped')
    expect(v.title).toBe('THE CEO See You Later Alligator Graphic Tee Shirt Cotton Ring | Crew Neck')
    expect(v.title).not.toMatch(/classic fit/i)
    expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it('REFUSES a removal that satisfies NEITHER arm — byte-identical, and it says why', () => {
    // Nothing to re-fill with (no facts at all) and no money keyword: a clean 63-char title is
    // worse than a wasteful 70-char one, because Amazon rewrites the short one.
    const t = 'THE CEO Later Gator Unisex Tee Shirt Cotton Graphic Crew Neck Pocket'
    expect(t.length).toBe(68)
    const v = stripTitleWasteVocabulary(t, ctx({ band: { apparel: true }, moneyKws: null }))
    expect(v.decision).toBe('band-guard')
    expect(v.title).toBe(t)
    expect(v.note).toMatch(/refused, byte-identical/)
  })

  it('CARVE-OUT: a pipe-right made of pure waste is the money tail\'s region, not this net\'s', () => {
    // Deleting "| Classic Fit" here would delete the PIPE, and enforceMoneyTail returns 'no-tail'
    // on a tail-less title — the removal would destroy the slot the ruling wants the keyword in.
    const t = 'THE CEO See You Later Alligator Graphic Tee Shirt Cotton | Classic Fit'
    const v = stripTitleWasteVocabulary(t, ctx({ moneyKws: null }))
    expect(v.decision).toBe('money-tail-owns')
    expect(v.title).toBe(t)
  })

  it('is IDEMPOTENT — a stripped result re-enters as no-waste, byte-identical', () => {
    const once = stripTitleWasteVocabulary(AI_TITLE, ctx({ moneyKws: SOCCER_KWS }))
    const twice = stripTitleWasteVocabulary(once.title, ctx({ moneyKws: SOCCER_KWS }))
    expect(twice.decision).toBe('money-tail-owns') // only the carved-out tail waste remains
    expect(twice.title).toBe(once.title)
    const clean = stripTitleWasteVocabulary(PO_TITLE, ctx({ moneyKws: SOCCER_KWS }))
    expect(clean.decision).toBe('no-waste')
    expect(clean.title).toBe(PO_TITLE)
  })

  it.each([
    ['empty is the degrade gate\'s call', '', { apparel: true }, 'empty'],
    ['non-apparel is out of scope (§8 is an apparel rule)', 'THE CEO Unisex Ceramic Mug 11oz', { apparel: false }, 'non-apparel'],
    ['a clean title reports no-waste', 'THE CEO Later Gator Tee Shirt | Comfort Colors TShirt for Women', { apparel: true }, 'no-waste'],
  ])('%s', (_n, title, over, decision) => {
    expect(stripTitleWasteVocabulary(title, ctx(over as Partial<TitleWasteCtx>)).decision).toBe(decision)
  })

  it('NEVER touches a genuine spec claim that is not the two named phrases', () => {
    // "Relaxed Fit" is Comfort Colors' real fit and NOT on the PO's waste list; "Classic Car" is a
    // design, not a fit claim — the same distinction FIT_CLAIM_RE draws.
    for (const t of [
      'THE CEO Cupid Tee | Midweight Comfort Colors Relaxed Fit Shirt for Women',
      'THE CEO Classic Car Lover Shirt | Long Sleeve Comfort Colors Tee for Men',
    ]) {
      const v = stripTitleWasteVocabulary(t, ctx({ band: CC_BAND }))
      expect(v.decision).toBe('no-waste')
      expect(v.title).toBe(t)
    }
  })

  it('THE OSCILLATION GUARD: the facts pad may not re-add what this net removes', () => {
    // `titleBandCtx` composes spec.fit straight from blank_specs → "Classic Fit" for a Gildan
    // family. Without the shared predicate the pad would re-install the exact phrase the net just
    // deleted, INSIDE ONE DOOR PASS — a live oscillation and a false idempotence claim.
    expect(isTitleWasteVocabulary('Classic Fit')).toBe(true)
    expect(isTitleWasteVocabulary('Unisex Tee')).toBe(true)
    expect(isTitleWasteVocabulary('Relaxed Fit')).toBe(false)
    expect(isTitleWasteVocabulary('Short Sleeve')).toBe(false)
    // "Classic Fit" is the FIRST candidate `candidateSegments` would offer for this Gildan band ctx
    // (spec.fit leads the fact order once the brand is empty). It must never appear; the pad falls
    // through to the next real fact instead.
    const padded = enforceTitleBand('THE CEO Later Gator Tee Shirt Cotton Graphic for Women', GILDAN_BAND).title
    expect(padded).not.toMatch(/classic fit/i)
    expect(padded).toMatch(/Short Sleeve/)
    expect(padded.length).toBeGreaterThan('THE CEO Later Gator Tee Shirt Cotton Graphic for Women'.length)
  })
})

/* ── THE COMPOSED TRACE: the AI title, through the door, versus the PO's rewrite ────────────────── */
describe('AI title → composed door → the PO\'s shape', () => {
  const OUT = 'THE CEO 2026 World Soccer Cup USA Mexico Canada Tee | Football Tee Shirt'

  it('lands the PO\'s SHAPE at the PO\'s length', () => {
    const out = door(AI_TITLE, { band: GILDAN_BAND, money: SOCCER_MONEY, spec: GILDAN_SPEC, kws: SOCCER_KWS, protect: '2026 World Soccer Cup' })
    expect(out).toBe(OUT)

    expect(AI_TITLE.length).toBe(72)
    expect(PO_TITLE.length).toBe(72)
    expect(out.length).toBe(72)                              // same budget the PO spent

    expect(out).not.toMatch(/unisex/i)                       // rule 2
    expect(out).not.toMatch(/classic fit/i)                  // rule 2 + rule 1
    expect(out).toMatch(/football/i)                         // rule 3
    // Rule 1: the pipe-right is the MONEY position, not a spec fact.
    const [, right] = out.split(' | ')
    expect(right).toBe('Football Tee Shirt')
    const [, poRight] = PO_TITLE.split(' | ')
    expect(poRight).toMatch(/football/i)
    // §3 "Product noun ×2": one garment noun each side of the pipe, exactly like the PO's.
    expect(out.split(' | ')[0]).toMatch(/\bTee\b/)
    expect(right).toMatch(/\bTee\b/)
    // Brand + design identity untouched on the left, as in the PO's own rewrite.
    expect(out.startsWith('THE CEO 2026 World Soccer Cup')).toBe(true)
    expect(PO_TITLE.startsWith('THE CEO 2026 World Soccer Cup')).toBe(true)
  })

  it('is IDEMPOTENT — re-running the door on the result is byte-identical', () => {
    const opts = { band: GILDAN_BAND, money: SOCCER_MONEY, spec: GILDAN_SPEC, kws: SOCCER_KWS, protect: '2026 World Soccer Cup' }
    const once = door(AI_TITLE, opts)
    expect(door(once, opts)).toBe(once)
  })

  it('WITHOUT a football candidate the door still removes the waste — it just cannot reach the gold', () => {
    // Proof that rule 2 and rule 3 are independent: strip the synonym out of the candidate list and
    // the money slot goes to whatever else qualifies, but "Unisex" is gone either way.
    const out = door(AI_TITLE, { band: GILDAN_BAND, money: SOCCER_MONEY, spec: GILDAN_SPEC, kws: null, protect: '2026 World Soccer Cup' })
    expect(out).not.toMatch(/unisex/i)
    expect(out.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(out.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })
})
