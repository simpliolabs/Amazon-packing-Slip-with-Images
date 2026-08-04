import { describe, it, expect } from 'vitest'
import { collapseRepeatedWords, enforceTitleBand, pickDistinctGarmentForm, scrubUnspecdGarmentClaims, TITLE_BAND_LO, TITLE_BAND_HI, type TitleBandCtx } from './titleBand'

/* The LIVE failure this net exists to fix (B0GF49RLDL, 2026-07-29 21:03 regen). */
const LIVE_66 = 'THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women'

/** The facts a Comfort Colors 1717 tee actually has — nothing invented. */
const CC: TitleBandCtx = {
  apparel: true,
  garmentBrand: 'Comfort Colors',
  spec: { fit: 'Relaxed Fit', sleeve: 'Short Sleeve', neck: 'Crewneck' },
  garmentSecond: 'Tee',
}

describe('enforceTitleBand', () => {
  it('the live 66-char title is raised INTO the 70-75 band', () => {
    expect(LIVE_66.length).toBe(66) // pin the fixture: this is the real shipped length
    const v = enforceTitleBand(LIVE_66, CC)
    expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    // it padded with a FACT, not a marketing word, and kept the audience tail last
    expect(v.title).toMatch(/for Women$/)
    expect(v.notes[0]).toMatch(/band net: \+"/)
  })

  it('inserts the " | " separator when the title has none', () => {
    const v = enforceTitleBand(LIVE_66, CC)
    expect(v.title).toContain(' | ')
    expect(v.title).not.toMatch(/\|\s*$/) // never a dangling separator
  })

  it('is IDEMPOTENT — a second pass is byte-identical', () => {
    const once = enforceTitleBand(LIVE_66, CC).title
    const twice = enforceTitleBand(once, CC).title
    expect(twice).toBe(once)
  })

  it('is MONOTONE — never returns shorter than the input, never exceeds the cap', () => {
    for (const t of [LIVE_66, 'THE CEO Cupid Tee', 'A'.repeat(69), 'A'.repeat(74)]) {
      const v = enforceTitleBand(t, CC)
      expect(v.title.length).toBeGreaterThanOrEqual(t.trim().length)
      expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    }
  })

  it('leaves a title ALREADY in band byte-identical', () => {
    // The REAL 73-char title the same listing produced earlier the same day — the shape we want back.
    const inBand = 'THE CEO Cupid Valentine Tee Shirt | Pixel Art Comfort Colors Women Tshirt'
    expect(inBand.length).toBe(73)
    expect(inBand.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(enforceTitleBand(inBand, CC).title).toBe(inBand)
  })

  it('leaves an OVER-cap title untouched — capping belongs to capTitle75, not here', () => {
    const long = 'THE CEO Cupid Valentine Pixel Art Graphic Tee Shirt | Comfort Colors Relaxed Fit TShirt for Women'
    expect(long.length).toBeGreaterThan(TITLE_BAND_HI)
    expect(enforceTitleBand(long, CC).title).toBe(long)
  })

  it('NON-apparel is never padded — a short non-apparel title is legitimately short', () => {
    const t = 'THE CEO Ceramic Coffee Mug 11oz'
    expect(enforceTitleBand(t, { ...CC, apparel: false }).title).toBe(t)
  })

  it('never repeats a fact the title already states', () => {
    // "Comfort Colors" and "Relaxed Fit" are BOTH already present in the live title.
    const v = enforceTitleBand(LIVE_66, CC)
    expect((v.title.match(/Comfort Colors/gi) ?? []).length).toBe(1)
    expect((v.title.match(/Relaxed Fit/gi) ?? []).length).toBe(1)
  })

  it('with NO facts available it degrades HONESTLY — unchanged, and it says so', () => {
    const v = enforceTitleBand(LIVE_66, { apparel: true })
    expect(v.title).toBe(LIVE_66)
    expect(v.notes[0]).toMatch(/NO product facts available to reach 70/)
  })

  it('padded-but-still-short is reported, never silently passed off as in-band', () => {
    // One short fact only: cannot bridge 40 → 70, so the note must admit it.
    const short = 'THE CEO Cupid Tee for Women'
    const v = enforceTitleBand(short, { apparel: true, garmentSecond: 'Shirt' })
    expect(v.title.length).toBeLessThan(TITLE_BAND_LO)
    expect(v.notes[0]).toMatch(/facts exhausted below 70|NO product facts/)
  })

  it('empty / whitespace input is passed through untouched (the degrade gate owns empty)', () => {
    expect(enforceTitleBand('', CC).title).toBe('')
    expect(enforceTitleBand('   ', CC).title).toBe('   ')
    expect(enforceTitleBand('   ', CC).notes).toEqual([])
  })

  it('an existing pipe is respected — the second segment joins with a space, not a 2nd pipe', () => {
    const withPipe = 'THE CEO Cupid Valentine Tee | Pixel Art Shirt for Women'
    expect(withPipe.length).toBeLessThan(TITLE_BAND_LO)
    const v = enforceTitleBand(withPipe, CC)
    expect((v.title.match(/\|/g) ?? []).length).toBe(1)
  })

  it('collapses double spaces so the output is always clean bytes', () => {
    const v = enforceTitleBand('THE CEO  Cupid   Valentine Tee for Women', CC)
    expect(v.title).not.toMatch(/\s{2,}/)
  })
})

/* ── Regression for the WIRING, not the leaf: the caller must hand us a garment form whose coverage
 * token is genuinely new. `T-Shirt` folds to the same token as `Shirt` (coverage-core foldGarment),
 * so padding "…Shirt" with "T-Shirt" buys no indexing — it just looks padded. The pipeline's alias
 * picker rejects any alias whose letters contain a garment word already present; this pins the leaf's
 * behaviour for both the good and the bad input so a future ctx change cannot silently regress it. */
describe('garmentSecond must be a genuinely distinct surface form', () => {
  const LIVE = 'THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women'
  it('a DISTINCT form ("Tee") lands the title in band', () => {
    const v = enforceTitleBand(LIVE, { apparel: true, garmentSecond: 'Tee' })
    expect(v.title).toContain(' | Tee')
    expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
  })
  it('a longer redundant form cannot sneak past the cap — 76 chars is refused, not truncated', () => {
    // "T-Shirt" is both redundant (folds to the same coverage token as the "Shirt" already present)
    // AND two chars too long: 66 + " | T-Shirt" = 76. The leaf refuses it on the CAP alone and
    // degrades honestly rather than truncating mid-word. Redundancy itself is filtered by
    // listingPipeline's alias picker BEFORE the leaf is called (it rejects any alias whose letters
    // contain a garment word the title already carries) — belt and braces, two independent reasons.
    const v = enforceTitleBand(LIVE, { apparel: true, garmentSecond: 'T-Shirt' })
    expect(v.title).toBe(LIVE)
    expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    expect(v.notes[0]).toMatch(/NO product facts available to reach 70/)
  })
})

/* ── pickDistinctGarmentForm — the function whose INLINE ancestor shipped dead code.
 * The original lived inside listingPipeline.ts as six lines with a template-literal word-boundary
 * escape one backslash short (it compiled to the BACKSPACE control character), so its containment
 * check ALWAYS returned false, every title got `shirt`, the leaf rejected it as already-present, and
 * the whole net silently no-opped on the exact case it was built for. CI, tsc and 15 tests were all
 * green. These tests exist so that can never happen again — they would have failed immediately. */
describe('pickDistinctGarmentForm', () => {
  // The real SHIRT_BASE alias list from garmentNoun.ts.
  const SHIRT = ['shirt', 't-shirt', 'tshirt', 'tee', 'graphic tee'] as const
  const LIVE = 'THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women'

  it('THE REGRESSION: a title saying "Shirt" gets "Tee", never "shirt"/"T-Shirt"/"TShirt"', () => {
    expect(pickDistinctGarmentForm(LIVE, SHIRT)).toBe('Tee')
  })

  it('a title saying "Tee" gets "Shirt" — symmetric', () => {
    expect(pickDistinctGarmentForm('THE CEO Cupid Valentine Graphic Tee for Women', SHIRT)).toBe('Shirt')
  })

  it('hyphen and glued spellings both count as PRESENT (t-shirt / tshirt fold to shirt)', () => {
    expect(pickDistinctGarmentForm('THE CEO Cupid T-Shirt for Women', SHIRT)).toBe('Tee')
    expect(pickDistinctGarmentForm('THE CEO Cupid TShirt for Women', SHIRT)).toBe('Tee')
  })

  it('returns null when every single-word form is already present', () => {
    expect(pickDistinctGarmentForm('Cupid Shirt Tee TShirt', SHIRT)).toBeNull()
  })

  it('never returns a multi-word alias (a title segment must stay tight)', () => {
    expect(pickDistinctGarmentForm('Cupid Shirt Tee Tshirt', ['graphic tee'])).toBeNull()
  })

  it('Title-Cases the pick, including hyphenated forms', () => {
    expect(pickDistinctGarmentForm('Cupid Tee', ['t-shirt'])).toBe('T-Shirt')
    expect(pickDistinctGarmentForm('Cupid Tee', ['beanie'])).toBe('Beanie')
  })

  it('a non-shirt garment family works (headwear)', () => {
    const HAT = ['hat', 'cap', 'snapback', 'visor']
    expect(pickDistinctGarmentForm('THE CEO Cupid Valentine Dad Hat', HAT)).toBe('Cap')
  })

  it('regex metacharacters in the title or alias can never throw (no RegExp is built)', () => {
    expect(() => pickDistinctGarmentForm('Cupid (Valentine) [*] +Shirt?', SHIRT)).not.toThrow()
    expect(() => pickDistinctGarmentForm('Cupid Shirt', ['te(e']))
      .not.toThrow()
  })

  it('is case-insensitive about what is already present', () => {
    expect(pickDistinctGarmentForm('CUPID VALENTINE SHIRT FOR WOMEN', SHIRT)).toBe('Tee')
  })
})

/* ── PHASE 0: the decision verdict. A net whose success is indistinguishable from its absence is not
 * verifiable — on the first live run the title came back at 75 with no log line, and the only honest
 * answer was "unknown". Every branch must report WHY, and these tests pin the mapping so the live
 * evidence gate ("show me a decision:'padded' with from<70 and to in [70,75]") is trustworthy. */
describe('TitleBandDecision — every branch reports why', () => {
  const LIVE_SHORT = 'THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women' // 66

  it("padded — the ONLY verdict that proves the net works", () => {
    const v = enforceTitleBand(LIVE_SHORT, CC)
    expect(v.decision).toBe('padded')
    expect(LIVE_SHORT.length).toBeLessThan(TITLE_BAND_LO)
    expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it("in-band — healthy no-op, and now distinguishable from never running", () => {
    const inBand = 'THE CEO Cupid Valentine Tee Shirt | Pixel Art Comfort Colors Women Tshirt'
    expect(enforceTitleBand(inBand, CC).decision).toBe('in-band')
  })

  it("over-cap — capping is capTitle75's job, so the net stands down and says so", () => {
    const long = 'THE CEO Cupid Valentine Pixel Art Graphic Tee Shirt | Comfort Colors Relaxed Fit TShirt for Women'
    expect(long.length).toBeGreaterThan(TITLE_BAND_HI)
    expect(enforceTitleBand(long, CC).decision).toBe('over-cap')
  })

  it("non-apparel — deliberate skip, not a failure", () => {
    expect(enforceTitleBand('THE CEO Ceramic Coffee Mug 11oz', { ...CC, apparel: false }).decision).toBe('non-apparel')
  })

  it("no-facts — unchanged, and the verdict admits it (never silent)", () => {
    const v = enforceTitleBand(LIVE_SHORT, { apparel: true })
    expect(v.decision).toBe('no-facts')
    expect(v.title).toBe(LIVE_SHORT)
  })

  it("facts-exhausted — improved but still short; an honest partial, not a success", () => {
    const v = enforceTitleBand('THE CEO Cupid Tee for Women', { apparel: true, garmentSecond: 'Shirt' })
    expect(v.decision).toBe('facts-exhausted')
    expect(v.title.length).toBeLessThan(TITLE_BAND_LO)
    expect(v.title.length).toBeGreaterThan('THE CEO Cupid Tee for Women'.length)
  })

  it('empty — the degrade gate owns blank, never this net', () => {
    expect(enforceTitleBand('', CC).decision).toBe('empty')
    expect(enforceTitleBand('   ', CC).decision).toBe('empty')
  })

  it('the verdict never contradicts the returned title', () => {
    const cases: Array<[string, TitleBandCtx]> = [
      [LIVE_SHORT, CC], [LIVE_SHORT, { apparel: true }], ['A'.repeat(72), CC],
      ['A'.repeat(80), CC], ['', CC], ['THE CEO Mug', { ...CC, apparel: false }],
    ]
    for (const [t, ctx] of cases) {
      const v = enforceTitleBand(t, ctx)
      if (v.decision === 'padded') {
        expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
        expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
      }
      if (v.decision === 'in-band') expect(v.title).toBe(t.trim())
      if (v.decision === 'no-facts' || v.decision === 'non-apparel' || v.decision === 'over-cap') {
        expect(v.title).toBe(t.trim())
      }
    }
  })
})

/* ── collapseRepeatedWords (#148). THE LIVE DEFECT, verified in the shipped recommendation for
 * B0GF49RLDL at 2026-07-29 21:03:
 *   "THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt, Tshirt for Women"
 * "Tshirt" twice. deduplicatePhrases only compares ADJACENT windows, so a non-adjacent repeat was
 * invisible. PO decision: VARIETY — two garment nouns is the goal, so this must never collapse to
 * one; it removes same-form repeats and any third form. */
describe('collapseRepeatedWords', () => {
  const LIVE_REPEAT = 'THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt, Tshirt for Women'

  it('THE LIVE DEFECT: the duplicate Tshirt goes, and its dangling comma with it', () => {
    const v = collapseRepeatedWords(LIVE_REPEAT)
    expect((v.title.match(/tshirt/gi) ?? []).length).toBe(1)
    expect(v.title).not.toMatch(/,\s*,|,\s*for\b/)
    expect(v.removed.length).toBe(1)
    expect(v.title.length).toBeLessThan(LIVE_REPEAT.length)
  })

  it('VARIETY IS PRESERVED — two distinct garment nouns survive (never collapses to one)', () => {
    const v = collapseRepeatedWords(LIVE_REPEAT)
    expect(v.title).toMatch(/\bTee\b/)
    expect(v.title).toMatch(/\bShirt\b/)
  })

  it('SURFACE VARIETY IS NOT REPETITION — three distinct forms are the GOLD shape, untouched', () => {
    // My first implementation capped garment forms at two, reading "variety" as "exactly two". Two
    // tests falsified it immediately: it dropped BOTH Tshirts from the live defect, and it mutated
    // clean titles — because the repo's gold pattern carries Tee + Shirt + TShirt ("Tee Shirt" is a
    // compound garment, "TShirt" a second, differently-typed search). Only a REPEAT is the defect.
    const gold = 'THE CEO Later Gator Tee Shirt | Comfort Colors TShirt for Women'
    const v = collapseRepeatedWords(gold)
    expect(v.title).toBe(gold)
    expect(v.removed).toEqual([])
  })

  it('keeps two distinct garment nouns after a repeat is removed', () => {
    const v = collapseRepeatedWords('THE CEO Cupid Tee Shirt Tank Tank for Women')
    expect(v.removed).toContain('Tank')
    expect(v.title).toMatch(/\bTee\b/)
    expect(v.title).toMatch(/\bShirt\b/)
  })

  it('connectors may repeat — "for", "and", "the" are not significant words', () => {
    const t = 'THE CEO Cupid Tee for Men and Women and Teens'
    const v = collapseRepeatedWords(t)
    expect((v.title.match(/\band\b/g) ?? []).length).toBe(2)
  })

  it('men/women/cotton COUNT as significant — they are allowed once', () => {
    const v = collapseRepeatedWords('THE CEO Cotton Tee Cotton Shirt for Women')
    expect((v.title.match(/cotton/gi) ?? []).length).toBe(1)
  })

  it('punctuation never hides a duplicate ("Tshirt," == "Tshirt")', () => {
    const v = collapseRepeatedWords('THE CEO Valentine Tshirt, Tshirt Gift')
    expect((v.title.match(/tshirt/gi) ?? []).length).toBe(1)
  })

  it('keeps the FIRST occurrence — earliest position is the most valuable', () => {
    const v = collapseRepeatedWords('Alpha Cupid Beta Cupid Gamma')
    expect(v.title).toBe('Alpha Cupid Beta Gamma')
  })

  it('is IDEMPOTENT — a second pass changes nothing', () => {
    const once = collapseRepeatedWords(LIVE_REPEAT).title
    expect(collapseRepeatedWords(once).title).toBe(once)
    expect(collapseRepeatedWords(once).removed).toEqual([])
  })

  it('a clean title is returned untouched with nothing removed', () => {
    const clean = 'THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt for Women'
    const v = collapseRepeatedWords(clean)
    expect(v.title).toBe(clean)
    expect(v.removed).toEqual([])
  })

  it('never leaves a dangling separator or trailing punctuation', () => {
    for (const t of ['THE CEO Tee Shirt | Tshirt Tshirt', 'Cupid Tee, Tee', 'Alpha | Beta Beta']) {
      const v = collapseRepeatedWords(t)
      expect(v.title).not.toMatch(/[\s,;:|]$/)
      expect(v.title).not.toMatch(/\s{2,}/)
    }
  })

  it('empty input is safe', () => {
    expect(collapseRepeatedWords('').title).toBe('')
    expect(collapseRepeatedWords('   ').removed).toEqual([])
  })
})

describe('customizable (Amazon Custom, 2026-07-31) — "Personalized" as a leading fact segment', () => {
  const ctx = (over: object) => ({ apparel: true, garmentBrand: null, spec: null, garmentSecond: 'Tee', ...over })
  it('an enrolled listing pads with Personalized first', () => {
    const short = 'THE CEO We Still Do Anniversary Shirt for Men and Women' // 55
    const v = enforceTitleBand(short, ctx({ customizable: true }))
    expect(v.title).toMatch(/Personalized/)
    expect(v.title.length).toBeGreaterThanOrEqual(70)
    expect(v.title.length).toBeLessThanOrEqual(75)
  })
  it('a non-enrolled listing NEVER gains Personalized (false claim)', () => {
    const short = 'THE CEO We Still Do Anniversary Shirt for Men and Women'
    const v = enforceTitleBand(short, ctx({ customizable: false }))
    expect(v.title).not.toMatch(/Personalized/)
  })
  it('a title already saying Personalized is not double-padded with it', () => {
    const has = 'THE CEO Personalized We Still Do Anniversary Shirt for Men and Women' // 68
    const v = enforceTitleBand(has, ctx({ customizable: true }))
    expect((v.title.match(/Personalized/g) || []).length).toBe(1)
  })
})

/* ── SPEC-TRUTH NET (2026-08-04, the POOL_STRATA-flip leak) ─────────────────────────────────────
 * The composed pool carries the MARKET'S fabric vocabulary ("comfort colors heavyweight t shirt"),
 * and the first fresh title regen after the flip echoed it into a midweight blank's title. */
describe('scrubUnspecdGarmentClaims', () => {
  const CC_SPEC = { fit: 'Relaxed', weightNote: 'midweight 6.1 oz garment-dyed' }
  const GILDAN_SPEC = { fit: 'Classic', weightNote: 'lightweight 4.5 oz ring-spun' }

  it('the LIVE specimen: strips pool-leaked "Heavyweight" + wrong "Classic Fit" on a CC blank', () => {
    const live = "THE CEO Cupid Valentine Women's Heavyweight Cotton T-Shirt Classic Fit Crew"
    const r = scrubUnspecdGarmentClaims(live, CC_SPEC)
    expect(r.removed).toEqual(['Heavyweight', 'Classic Fit'])
    expect(r.title).toBe("THE CEO Cupid Valentine Women's Cotton T-Shirt Crew")
    expect(r.title).not.toMatch(/\s{2,}/)
  })

  it('keeps claims the spec BACKS: "Midweight" + "Relaxed Fit" survive on the CC blank', () => {
    const t = 'THE CEO Cupid Tee | Midweight Comfort Colors Relaxed Fit Shirt for Women'
    const r = scrubUnspecdGarmentClaims(t, CC_SPEC)
    expect(r.removed).toEqual([])
    expect(r.title).toBe(t)
  })

  it('keeps Gildan-backed claims on the Gildan spec ("Lightweight", "Classic Fit")', () => {
    const t = 'THE CEO We Still Do Tee | Lightweight Classic Fit Tshirt for Men and Women'
    expect(scrubUnspecdGarmentClaims(t, GILDAN_SPEC).removed).toEqual([])
  })

  it('NULL spec = claim NOTHING: every weight/fit claim goes (the weight-truth rule)', () => {
    const t = 'THE CEO Dog Mom Heavyweight Relaxed Fit Oversized Tee Shirt for Women'
    const r = scrubUnspecdGarmentClaims(t, null)
    expect(r.removed).toEqual(['Heavyweight', 'Relaxed Fit', 'Oversized'])
    expect(r.title).toBe('THE CEO Dog Mom Tee Shirt for Women')
  })

  it('standalone "Oversized" is a claim; bare "Classic"/"Relaxed" are NOT ("Classic Car Shirt" is a design)', () => {
    const r1 = scrubUnspecdGarmentClaims('THE CEO Oversized Sunset Tee for Women', CC_SPEC)
    expect(r1.removed).toEqual(['Oversized'])
    const r2 = scrubUnspecdGarmentClaims('THE CEO Classic Car Lover Shirt | Relaxed Weekend Tee', CC_SPEC)
    expect(r2.removed).toEqual([])
    expect(r2.title).toBe('THE CEO Classic Car Lover Shirt | Relaxed Weekend Tee')
  })

  it('is idempotent and repairs comma/separator residue', () => {
    const t = 'THE CEO Cupid Tee | Heavyweight, for Women'
    const once = scrubUnspecdGarmentClaims(t, CC_SPEC)
    expect(once.title).toBe('THE CEO Cupid Tee | for Women'.replace(' | for', ' for')) // separator repaired before tail
    const twice = scrubUnspecdGarmentClaims(once.title, CC_SPEC)
    expect(twice.removed).toEqual([])
    expect(twice.title).toBe(once.title)
  })
})
