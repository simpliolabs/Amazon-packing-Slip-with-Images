import { describe, it, expect } from 'vitest'
import {
  collapseRepeatedWords,
  enforceInclusiveAudience,
  enforceMoneyTail,
  enforceTitleBand,
  fixApostropheCase,
  TITLE_BAND_LO,
  TITLE_BAND_HI,
  type InclusiveAudienceCtx,
  type TitleBandCtx,
} from './titleBand'

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PO RULING 2026-08-09 (SELLER_PROFILE §4), on the PO's OWN locked title, verbatim:
 * "TERRIBLE and Wasting MEN, WOMEN".
 *
 *   THE CEO World Soccer Cup Soccer T-Shirt, Women'S T-Shirts for Men and Women
 *
 * TWO defects in 75 characters:
 *   1. "for Men and Women" — ~18 chars of nothing, and self-contradicting because the title already
 *      says "Women's T-Shirts". Docked since forever at listingPipeline.ts:1953-1959; never removed.
 *   2. "Women'S" — a Title-Case pass capitalising the letter after an apostrophe.
 * Both are enforced deterministically on the SHIPPED bytes, in the shared `bandTitle` seam that both
 * the single-design (`recommended_title`) and multi-design (`per_child_titles`) exits pass through.
 */

/** The PO's exact locked title. Pinned byte-for-byte — this fixture IS the ruling. */
const PO_BAD = "THE CEO World Soccer Cup Soccer T-Shirt, Women'S T-Shirts for Men and Women"

/** The two PO golds. SELLER_PROFILE §3: "Protected as test fixtures — no net may alter them." */
const GOLD_CHRISTIAN = 'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women'
const GOLD_ALLIGATOR = 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt'

/** The facts a Comfort Colors 1717 tee actually has — nothing invented (twin of titleBand.test.ts). */
const CC_BAND: TitleBandCtx = {
  apparel: true,
  garmentBrand: 'Comfort Colors',
  spec: { fit: 'Relaxed Fit', sleeve: 'Short Sleeve', neck: 'Crewneck' },
  garmentSecond: 'Tee',
}
const UNIVERSAL: InclusiveAudienceCtx = { apparel: true, lean: null, band: CC_BAND }
const LEAN_F: InclusiveAudienceCtx = { apparel: true, lean: 'lean_female', band: CC_BAND }

/**
 * Mirrors the wire order of `bandTitle` (listingPipeline.ts:7903) for the two stages this ruling
 * touches, so the PO fixture is asserted on COMPOSED bytes rather than on one net in isolation —
 * the defect shipped through a composition, not through a single function.
 * Order there: fixApostropheCase → specTruth → capTitle75 → collapseRepeatedWords →
 * enforceMoneyTail → enforceInclusiveAudience → enforceTitleBand.
 */
const door = (title: string, ctx: InclusiveAudienceCtx): string => {
  const cased = fixApostropheCase(title)
  const deduped = collapseRepeatedWords(cased).title
  const inclusive = enforceInclusiveAudience(deduped, ctx).title
  return enforceTitleBand(inclusive, ctx.band).title
}

describe("PO ruling 2026-08-09 — the PO's own locked title", () => {
  it('pins the fixture at the length the PO actually shipped', () => {
    expect(PO_BAD.length).toBe(75)
  })

  it('CURES BOTH DEFECTS on the shipped bytes, and lands in the 70-75 band', () => {
    const out = door(PO_BAD, UNIVERSAL)

    // DEFECT 1 — the inclusive tail is gone, and so is every equivalent of it.
    expect(out).not.toMatch(/for\s+men\s+and\s+women/i)
    expect(out).not.toMatch(/men.{0,4}\s*(?:and|&)\s*women/i)
    // DEFECT 2 — no capital letter survives after an apostrophe.
    expect(out).not.toMatch(/['’][A-Z]/)
    expect(out).toContain("Women's T-Shirts")

    // The design identity and the gendered noun (the REAL keyword) are untouched.
    expect(out).toContain('THE CEO World Soccer Cup')
    // And the freed characters went back into the band, from FACTS.
    expect(out.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(out.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    expect(out).toBe("THE CEO World Soccer Cup T-Shirt, Women's T-Shirts | Comfort Colors Tee")
  })

  it('is IDEMPOTENT — re-running the door on the cured title is byte-identical', () => {
    const once = door(PO_BAD, UNIVERSAL)
    expect(door(once, UNIVERSAL)).toBe(once)
  })

  it('DEFECT 1 rule (c) VERIFIED: enforceMoneyTail already claims "for Men and Women" as its replaceable tail', () => {
    // The proof is the DECISION, not the bytes: a title with no replaceable tail returns 'no-tail'
    // and never reaches the band-fit stage. On the PO's title it returns 'no-fit' — i.e. it DID
    // treat " for Men and Women" as the replaceable region, split the left side off, and only then
    // failed to fit this particular keyword. No extension to enforceMoneyTail is required.
    const deduped = collapseRepeatedWords(fixApostropheCase(PO_BAD)).title
    const v = enforceMoneyTail(deduped, 'graphic tees for women', {
      apparel: true, lean: null, spec: { fit: 'Relaxed', weightNote: 'Midweight 6.1 oz' },
      protect: 'World Soccer Cup', garmentBrand: 'Comfort Colors',
    })
    expect(v.decision).toBe('no-fit')
    expect(v.decision).not.toBe('no-tail')
    expect(v.title).toBe(deduped) // fail-open, byte-identical
  })

  it('DEFECT 1 rule (c) VERIFIED: a qualifying money keyword REPLACES the inclusive tail outright', () => {
    const v = enforceMoneyTail('THE CEO Pickleball Dink Responsibly Tee for Men and Women', 'funny graphic tees for women', {
      apparel: true, lean: null, spec: { fit: 'Relaxed', weightNote: 'Midweight 6.1 oz' },
      protect: 'Dink Responsibly', garmentBrand: 'Comfort Colors',
    })
    expect(v.decision).toBe('applied')
    expect(v.title).toBe('THE CEO Pickleball Dink Responsibly Tee | Funny Graphic Tees for Women')
    expect(v.title).not.toMatch(/for\s+men\s+and\s+women/i)
    expect(v.title.length).toBe(70)
  })
})

describe('PO golds are PROTECTED FIXTURES — no net may alter them', () => {
  it.each([
    ['gold #1 (christian)', GOLD_CHRISTIAN, 74],
    ['gold #2 (alligator)', GOLD_ALLIGATOR, 72],
  ])('%s is byte-identical through BOTH nets this ruling adds', (_name, gold, len) => {
    expect(gold.length).toBe(len)
    expect(fixApostropheCase(gold)).toBe(gold)
    for (const ctx of [UNIVERSAL, LEAN_F]) {
      // A female-leaned listing must not disturb them either ("for Women" is not an inclusive phrase).
      const inc = enforceInclusiveAudience(gold, ctx)
      expect(inc.decision).toBe('no-phrase')
      expect(inc.title).toBe(gold)
    }
  })

  it('gold #1 survives the whole composed door unchanged', () => {
    expect(door(GOLD_CHRISTIAN, UNIVERSAL)).toBe(GOLD_CHRISTIAN)
    expect(door(GOLD_CHRISTIAN, LEAN_F)).toBe(GOLD_CHRISTIAN)
  })

  it('PRE-EXISTING (not this ruling): collapseRepeatedWords DOES mutate gold #2 — pinned, reported, not fixed here', () => {
    // Gold #2 carries the garment noun TWICE by design ("…Alligator Shirt | Long Sleeve Comfort
    // Colors Shirt"). `collapseRepeatedWords` (#148, shipped before this ruling) removes any repeat
    // of a significant word, so it strips the trailing "Shirt" — 72 → 66 — and the band pad then
    // refills the hole with an unrelated fact. That is a live conflict between #148 and
    // SELLER_PROFILE §3 ("Protected as test fixtures — no net may alter them"); it predates this
    // change, is caused by neither new net, and is a PO scope call (is the noun repeat intentional
    // in the gold, or is #148 right?). Pinned here so the finding is visible in CI rather than lost.
    const v = collapseRepeatedWords(GOLD_ALLIGATOR)
    expect(v.removed).toEqual(['Shirt'])
    expect(v.title).toBe('THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors')
    // …and neither net this ruling adds contributes to that mutation:
    expect(fixApostropheCase(GOLD_ALLIGATOR)).toBe(GOLD_ALLIGATOR)
    expect(enforceInclusiveAudience(GOLD_ALLIGATOR, UNIVERSAL).title).toBe(GOLD_ALLIGATOR)
  })
})

describe('enforceInclusiveAudience — decision table', () => {
  const cases: Array<{ name: string; title: string; ctx: InclusiveAudienceCtx; decision: string; expected?: string }> = [
    {
      name: 'RULE (a) contradiction: a gendered noun elsewhere DELETES the inclusive phrase',
      title: "THE CEO World Soccer Cup T-Shirt, Women's T-Shirts for Men and Women",
      ctx: UNIVERSAL,
      decision: 'stripped',
      expected: "THE CEO World Soccer Cup T-Shirt, Women's T-Shirts | Comfort Colors Tee",
    },
    {
      name: 'RULE (a) BEATS rule (b): leaned + gendered noun still DELETES (narrowing would print the gender twice)',
      title: 'THE CEO Golf Widow Support Womens Graphic Tee Shirt for Men and Women',
      ctx: LEAN_F,
      decision: 'stripped',
      expected: 'THE CEO Golf Widow Support Womens Graphic Tee Shirt | Comfort Colors Tee',
    },
    {
      name: 'RULE (b) leaned: the tail NARROWS to the lean — §4 still requires a matching audience word',
      title: 'THE CEO Golf Widow Support Group Graphic Tee Shirt for Men and Women',
      ctx: LEAN_F,
      decision: 'narrowed',
      expected: 'THE CEO Golf Widow Support Group Graphic Tee Shirt | Relaxed Fit for Women',
    },
    {
      name: 'RULE (b) leaned, mid-title "Mens Womens": narrows to the ADJECTIVE form in place',
      title: 'THE CEO Golf Widow Support Group Mens Womens Graphic Tee Shirt',
      ctx: LEAN_F,
      decision: 'narrowed',
      expected: 'THE CEO Golf Widow Support Group Womens Graphic Tee Shirt | Comfort Colors',
    },
    {
      name: 'RULE (c) universal: no lean, no gendered noun — the money tail already declined, so the phrase STAYS',
      title: 'THE CEO Pickleball Dink Responsibly Graphic Tee for Men and Women',
      ctx: UNIVERSAL,
      decision: 'universal-allowed',
    },
    {
      name: 'BAND GUARD: a removal that cannot be re-filled to 70 is REFUSED, byte-identical (fail-open)',
      title: 'THE CEO Golf Widow Support Group Tee for Men and Women',
      ctx: LEAN_F,
      decision: 'band-guard',
    },
    {
      name: 'no-phrase: a single-gender tail is not an inclusive phrase',
      title: 'THE CEO Golf Widow Support Group Graphic Tee Shirt for Women',
      ctx: LEAN_F,
      decision: 'no-phrase',
    },
    {
      name: 'non-apparel is never touched',
      title: 'THE CEO 128GB Micro SD Memory Card High Speed for Men and Women',
      ctx: { apparel: false, lean: null, band: { ...CC_BAND, apparel: false } },
      decision: 'non-apparel',
    },
    {
      name: "empty is the degrade gate's call, never this net's",
      title: '',
      ctx: UNIVERSAL,
      decision: 'empty',
    },
  ]

  it.each(cases)('$name', ({ title, ctx, decision, expected }) => {
    const v = enforceInclusiveAudience(title, ctx)
    expect(v.decision).toBe(decision)
    if (expected !== undefined) {
      expect(v.title).toBe(expected)
      expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
      expect(v.title).not.toMatch(/\|\s*$/) // never a dangling separator
    } else {
      // every non-applying decision is byte-identical (modulo the shared trim normalization)
      expect(v.title).toBe(title.replace(/\s{2,}/g, ' ').trim() || title)
    }
  })

  it('every "equivalent" the PO named is recognised as the same phrase', () => {
    const equivalents = [
      'THE CEO World Soccer Cup Tee Womens Graphic Shirt for Men and Women',
      'THE CEO World Soccer Cup Tee Womens Graphic Shirt for Men & Women',
      'THE CEO World Soccer Cup Tee Womens Graphic Shirt for Women and Men',
      "THE CEO World Soccer Cup Tee Womens Graphic Men's and Women's Shirt",
      'THE CEO World Soccer Cup Tee Womens Graphic Mens Womens Shirt',
    ]
    for (const t of equivalents) {
      const v = enforceInclusiveAudience(t, UNIVERSAL)
      expect(v.decision, t).toBe('stripped') // "Womens" elsewhere makes each one a rule-(a) contradiction
      expect(v.title, t).not.toMatch(/men.{0,4}\s*(?:and|&)?\s*women/i)
    }
  })

  it('is IDEMPOTENT — an applied result re-enters as no-phrase, byte-identical', () => {
    for (const ctx of [UNIVERSAL, LEAN_F]) {
      const once = enforceInclusiveAudience("THE CEO World Soccer Cup T-Shirt, Women's T-Shirts for Men and Women", ctx)
      const twice = enforceInclusiveAudience(once.title, ctx)
      expect(twice.decision).toBe('no-phrase')
      expect(twice.title).toBe(once.title)
    }
  })

  it('NEVER exceeds the cap and never lands below the floor when it applies', () => {
    const inputs: Array<[string, InclusiveAudienceCtx]> = [
      ["THE CEO World Soccer Cup T-Shirt, Women's T-Shirts for Men and Women", UNIVERSAL],
      ['THE CEO Golf Widow Support Group Graphic Tee Shirt for Men and Women', LEAN_F],
      ['THE CEO Golf Widow Support Womens Graphic Tee Shirt for Men and Women', LEAN_F],
    ]
    for (const [title, ctx] of inputs) {
      const v = enforceInclusiveAudience(title, ctx)
      expect(['stripped', 'narrowed']).toContain(v.decision)
      expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    }
  })
})

describe('fixApostropheCase — the Title-Case artifact', () => {
  const cases: Array<[string, string, string]> = [
    ["the PO's own artifact", "Women'S T-Shirts", "Women's T-Shirts"],
    ['masculine possessive', "Men'S Graphic Tee", "Men's Graphic Tee"],
    ['the PO named it explicitly', "Dad'S Day Shirt", "Dad's Day Shirt"],
    ['contraction: not', "Don'T Quit Tee", "Don't Quit Tee"],
    ['contraction: are', "You'Re Enough Shirt", "You're Enough Shirt"],
    ['contraction: will', "I'Ll Be There Tee", "I'll Be There Tee"],
    ['contraction: have', "We'Ve Got This Tee", "We've Got This Tee"],
    ['smart apostrophe is handled too', 'Women’S T-Shirts', 'Women’s T-Shirts'],
    ['whole PO title', "Women'S T-Shirts for Men and Women", "Women's T-Shirts for Men and Women"],
  ]
  it.each(cases)('fixes %s', (_name, input, expected) => {
    expect(fixApostropheCase(input)).toBe(expected)
    expect(fixApostropheCase(fixApostropheCase(input))).toBe(expected) // idempotent
    expect(fixApostropheCase(input).length).toBe(input.length)         // length-neutral
  })

  const untouched: Array<[string, string]> = [
    ['the brand, an all-caps token', 'THE CEO Later Gator Tee'],
    ['all-caps possessive stays all-caps', "THE CEO'S Later Gator Tee"],
    ['TShirt / T-Shirt have no apostrophe', 'THE CEO Later Gator TShirt T-Shirt Tee'],
    ['an already-correct possessive', "THE CEO Women's Relaxed Fit Tee"],
    ['Irish name: a genuine capitalised word start', "THE CEO O'Brien Family Reunion Tee"],
    ['French elision: L\'Oreal-shaped token', "THE CEO L'Oreal Style Graphic Tee"],
    ['Rock\'N\'Roll — "N" is not an enclitic', "THE CEO Rock'N'Roll Graphic Tee"],
    ['o\'clock — a 5-letter run never matches', "THE CEO Five O'Clock Somewhere Tee"],
    ['plural possessive with no trailing letter', "THE CEO Girls' Trip Graphic Tee"],
    ['both PO golds', GOLD_CHRISTIAN],
    ['gold #2', GOLD_ALLIGATOR],
  ]
  it.each(untouched)('leaves %s byte-identical', (_name, input) => {
    expect(fixApostropheCase(input)).toBe(input)
  })

  it('the door applies it on the shipped bytes, not only at the casers', () => {
    // A council/LLM title or a stored prior can carry the artifact without passing any caser.
    // Fixture is already in band with no repeated significant word, so the door's OTHER stages are
    // no-ops and this isolates the apostrophe rule on the composed path.
    const artifact = "THE CEO See You Later Alligator Tee | Women'S Comfort Colors Graphic Shirt"
    expect(artifact.length).toBe(74)
    const out = door(artifact, UNIVERSAL)
    expect(out).toBe("THE CEO See You Later Alligator Tee | Women's Comfort Colors Graphic Shirt")
    expect(out).not.toMatch(/['’][A-Z]/)
    expect(out.length).toBe(artifact.length) // length-neutral: the band is never disturbed
  })
})
