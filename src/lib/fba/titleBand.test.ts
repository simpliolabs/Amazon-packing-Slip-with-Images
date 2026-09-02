import { describe, it, expect } from 'vitest'
import {
  collapseRepeatedWords, enforceMoneyTail, enforceTitleBand, pickDistinctGarmentForm,
  scrubUnspecdGarmentClaims, settleTruthBand, settleTitle, titleHasDuplicateConcept, titleHasPunctuationDefect,
  verdictForAssembledTitle, TITLE_BAND_LO, TITLE_BAND_HI, TITLE_SHIP_FLOOR, type TitleBandCtx, type SettleTitleCtx,
  ATTRIBUTE_CLAIM_STATUS, FIT_CLAIM_BARE_WORDS, FIT_CLAIM_SUFFIX_WORDS, FIT_WORD_CANON,
} from './titleBand'
import type { PhraseTruthCtx } from './contentTruth'
import { isForeignToDesign } from './designScope'

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

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * ATTRIBUTE-CLAIM CLASS TEST (PR #663, 2026-09-02, live B0DP5H8QBT) — "a pool-sourced phrase
 * carrying a product-attribute adjective is admitted to the title without checking it against the
 * resolved blank's own attribute fields". Closes the class, not just the one word: table-driven off
 * `FIT_CLAIM_BARE_WORDS`/`FIT_CLAIM_SUFFIX_WORDS` (titleBand.ts) so a word added to either array is
 * automatically exercised here with no new test code, and every case asserts on `r.removed` — the
 * net's own DECISION record — never merely on the word's absence from `r.title` (four fixes this
 * repo shipped green while reproducing a failure's vocabulary but not its shape).
 */
describe('ATTRIBUTE CLAIMS ARE SPEC-GROUNDED, NOT A WORD BLOCKLIST (PR #663, 2026-09-02)', () => {
  // The exact resolved spec for B0DP5H8QBT's blank (migration 058, style_code 64000B): a Gildan
  // youth tee. `fit='Classic'` — nothing in blank_specs or any migration ever states 'oversized'.
  const KIDS_64000B_SPEC = { fit: 'Classic', weightNote: 'lightweight 4.5 oz ring-spun' }

  it('THE LIVE CASE: a fit=Classic kids blank ships WITHOUT the pool-leaked "Oversized" and KEEPS the true "Crew Neck"', () => {
    const live = "THE CEO Don't Quit Motivational T-Shirt | Kids Oversized Tshirts Crew Neck"
    expect(live.length).toBe(74) // the exact live specimen, character-for-character
    const r = scrubUnspecdGarmentClaims(live, KIDS_64000B_SPEC)
    // The DECISION tag — the net must have actually decided to remove it, not merely ship a string
    // that happens not to contain the word.
    expect(r.removed).toEqual(['Oversized'])
    expect(r.title).not.toMatch(/oversized/i)
    expect(r.title).toContain('Crew Neck') // the TRUE attribute survives untouched
    expect(r.title).toBe("THE CEO Don't Quit Motivational T-Shirt | Kids Tshirts Crew Neck")
    expect(r.title.length).toBe(64)
  })

  it('THE POSITIVE CONTROL: a blank whose OWN fit states it MAY use the word — spec-grounding, not censorship', () => {
    const oversizedBlank = { fit: 'Oversized' } // a hypothetical future blank_specs row, zero code change needed
    const r = scrubUnspecdGarmentClaims('THE CEO Street Style Oversized Tee for Women', oversizedBlank)
    expect(r.removed).toEqual([]) // decision: nothing removed
    expect(r.title).toContain('Oversized')
    expect(r.title.length).toBe('THE CEO Street Style Oversized Tee for Women'.length)
  })

  it('containment, not equality: a multi-word fit value still backs each single claimed word (the fitOk robustness fix)', () => {
    const compoundBlank = { fit: 'Oversized Boxy' } // hypothetical compound catalog value
    const r1 = scrubUnspecdGarmentClaims('THE CEO Street Oversized Tee', compoundBlank)
    expect(r1.removed).toEqual([])
    const r2 = scrubUnspecdGarmentClaims('THE CEO Street Boxy Tee', compoundBlank)
    expect(r2.removed).toEqual([])
  })

  it('the class test: EVERY bare fit word the blank does NOT state is refused (table-driven off FIT_CLAIM_BARE_WORDS)', () => {
    const REFUSED_BASE = 'THE CEO Design Name Tee for Kids'
    for (const word of FIT_CLAIM_BARE_WORDS) {
      const cap = word[0].toUpperCase() + word.slice(1)
      const title = `THE CEO Design Name ${cap} Tee for Kids`
      const r = scrubUnspecdGarmentClaims(title, KIDS_64000B_SPEC) // fit=Classic; none of these words is 'classic'
      expect(r.removed, `expected "${word}" to be refused against fit=Classic`).toHaveLength(1)
      expect(r.title.toLowerCase(), `"${word}" leaked into the shipped title`).not.toContain(word)
      expect(r.title).toBe(REFUSED_BASE)
      expect(r.title.length).toBe(REFUSED_BASE.length)
    }
  })

  it('the class test: EVERY bare fit word the blank DOES state is admitted (table-driven off FIT_CLAIM_BARE_WORDS)', () => {
    for (const word of FIT_CLAIM_BARE_WORDS) {
      const canon = FIT_WORD_CANON[word] ?? word
      const cap = word[0].toUpperCase() + word.slice(1)
      const title = `THE CEO Design Name ${cap} Tee for Kids`
      // spec.fit stores the CANONICAL form — the realistic DB shape (a PO types 'Oversized', never
      // the informal 'Oversize') — proving the word's own claim normalizes to match it.
      const spec = { fit: canon[0].toUpperCase() + canon.slice(1) }
      const r = scrubUnspecdGarmentClaims(title, spec)
      expect(r.removed, `expected "${word}" to be admitted against fit=${spec.fit}`).toEqual([])
      expect(r.title).toBe(title)
      expect(r.title.length).toBe(title.length)
    }
  })

  it('the class test: EVERY suffix ("<word> Fit") the blank does NOT state is refused (table-driven off FIT_CLAIM_SUFFIX_WORDS)', () => {
    const RETAIL_SPEC = { fit: 'Retail' } // the real BC3001 catalog value — none of these words
    const REFUSED_BASE = 'THE CEO Design Name Tee for Kids'
    for (const word of FIT_CLAIM_SUFFIX_WORDS) {
      const cap = word[0].toUpperCase() + word.slice(1)
      const title = `THE CEO Design Name ${cap} Fit Tee for Kids`
      const r = scrubUnspecdGarmentClaims(title, RETAIL_SPEC)
      expect(r.removed, `expected "${word} Fit" to be refused against fit=Retail`).toHaveLength(1)
      expect(r.title).toBe(REFUSED_BASE)
      expect(r.title.length).toBe(REFUSED_BASE.length)
    }
  })

  it('the class test: EVERY suffix ("<word> Fit") the blank DOES state is admitted (table-driven off FIT_CLAIM_SUFFIX_WORDS)', () => {
    for (const word of FIT_CLAIM_SUFFIX_WORDS) {
      const cap = word[0].toUpperCase() + word.slice(1)
      const title = `THE CEO Design Name ${cap} Fit Tee for Kids`
      const spec = { fit: cap }
      const r = scrubUnspecdGarmentClaims(title, spec)
      expect(r.removed, `expected "${word} Fit" to be admitted against fit=${cap}`).toEqual([])
      expect(r.title).toBe(title)
      expect(r.title.length).toBe(title.length)
    }
  })

  it('bare ambiguous words stay UNMATCHED without "Fit": ("Loose Cannon", "Fitted for the role") never lose real design vocabulary', () => {
    // Sibling of the existing "Classic Car Shirt"/"Relaxed Weekend" proof above — every SUFFIX word
    // is deliberately excluded from the bare alternation for the same false-positive reason.
    for (const word of FIT_CLAIM_SUFFIX_WORDS) {
      const cap = word[0].toUpperCase() + word.slice(1)
      const title = `THE CEO ${cap} Cannon Tee for Kids` // bare, no "Fit" suffix
      const r = scrubUnspecdGarmentClaims(title, KIDS_64000B_SPEC)
      expect(r.removed, `bare "${word}" (no "Fit") must NOT be treated as a claim`).toEqual([])
      expect(r.title).toBe(title)
      expect(r.title.length).toBe(title.length)
    }
  })

  it('ATTRIBUTE_CLAIM_STATUS is the compile-time exhaustiveness gate: every BlankSpec attribute field is a DELIBERATE, documented decision', () => {
    const entries = Object.entries(ATTRIBUTE_CLAIM_STATUS)
    // Documents the full field set this registry currently classifies. tsc --noEmit is the REAL
    // enforcement (a field added to BlankSpec without a matching key here fails to compile — see
    // the registry's own doc comment in titleBand.ts) — this assertion is a runtime double-check
    // that every classified field carries a real, non-empty justification, never a silent gap.
    expect(entries.map(([k]) => k).sort()).toEqual(
      ['dye', 'fit', 'fitToSize', 'material', 'neck', 'sleeve', 'stretch', 'weightNote'].sort(),
    )
    for (const [field, s] of entries) {
      if (s.status === 'net') continue // 'fit' — judged by scrubUnspecdGarmentClaims itself, proven above
      if (s.status === 'legacy-net') {
        expect(s.note?.length, `${field}'s legacy-net status needs a real note`).toBeGreaterThan(0)
      } else {
        expect(s.reason?.length, `${field}'s unclaimed status needs a real reason, not a silent gap`).toBeGreaterThan(0)
      }
    }
  })
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE WHOLE-STRING VERIFY (title-settle rewrite, handoff/TITLE_SETTLE_REWRITE.md, 2026-08-22).
 * Direct, fine-grained unit coverage of `verdictForAssembledTitle` and the two ctx-free checks it
 * composes, plus proof that the additive search (`settleTruthBand`) and the money-tail installer
 * (`enforceMoneyTail`) both actually CALL it — the fix for the four consecutive live failures on
 * B0DSCDZC6K (#630/#632/#634/#637), where a per-segment/per-candidate gate could not see a violation
 * that only exists in the ASSEMBLED string. The end-to-end fixture lives in `truthBandHarness.ts` /
 * `truthBandGate.test.ts`; this file pins the primitives in isolation.
 */
const MIXED_SWEAT_HOODIE_UNISEX: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt', mixedFamilies: ['sweatshirt', 'hoodie'], spec: null,
  allowedBrand: null, audience: 'adult', designTokens: [], audienceLean: 'unisex', field: 'title',
}

describe('titleHasDuplicateConcept', () => {
  it('flags the SAME concept restated in two spellings ("Crewneck" + "Crew Neck")', () => {
    expect(titleHasDuplicateConcept('THE CEO Fall Crewneck | Long Sleeve Crew Neck')).toBe(true)
  })

  it('does NOT flag the golds\' noun ×2 pattern ("Tee Shirt | … TShirt")', () => {
    expect(titleHasDuplicateConcept('THE CEO Alligator Tee Shirt | Comfort Colors TShirt for Women')).toBe(false)
  })

  it('does not flag ordinary non-repeating vocabulary', () => {
    expect(titleHasDuplicateConcept('THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover')).toBe(false)
  })
})

describe('titleHasPunctuationDefect', () => {
  it('flags the live specimen "Entrepreneur, |"', () => {
    expect(titleHasPunctuationDefect('THE CEO Motivational Entrepreneur, | Long Sleeve')).toBe(true)
  })

  it('flags a trailing separator', () => {
    expect(titleHasPunctuationDefect('THE CEO Mother Hustler Sweatshirt |')).toBe(true)
  })

  it('a clean title has no defect', () => {
    expect(titleHasPunctuationDefect('THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover')).toBe(false)
  })
})

describe('verdictForAssembledTitle — the ONE predicate for an assembled title', () => {
  it('ok on a clean, single-class, truthful title', () => {
    expect(verdictForAssembledTitle('THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover', { truth: MIXED_SWEAT_HOODIE_UNISEX })).toEqual({ ok: true })
  })

  it('rejects two garment classes even when each noun is individually true of the family', () => {
    const v = verdictForAssembledTitle('THE CEO Mother Hustler Sweatshirt | Hoodie Pullover', { truth: MIXED_SWEAT_HOODIE_UNISEX })
    expect(v.ok).toBe(false)
  })

  it('rejects a forced gender on a unisex family', () => {
    const v = verdictForAssembledTitle('THE CEO Mother Hustler Sweatshirt | Long Sleeve for Women', { truth: MIXED_SWEAT_HOODIE_UNISEX })
    expect(v.ok).toBe(false)
  })

  it('rejects a sibling design name', () => {
    // `foreignTokens` alone scrubs segment 0 word-by-word; a TAIL segment carrying a sibling's whole
    // name is dropped only via `reject` (the same pairing every real caller supplies — see
    // `applyTitleTruthNet`'s own doc on why the two are separate levers).
    const foreignTokens = new Set(['billionare', 'coming', 'soon'])
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    const v = verdictForAssembledTitle('THE CEO Mother Hustler | Billionare Coming Soon Gift', { truth: MIXED_SWEAT_HOODIE_UNISEX, foreignTokens, reject })
    expect(v.ok).toBe(false)
  })

  it('rejects a duplicated concept', () => {
    const v = verdictForAssembledTitle('THE CEO Fall Crewneck | Long Sleeve Crew Neck', { truth: MIXED_SWEAT_HOODIE_UNISEX })
    expect(v.ok).toBe(false)
  })

  it('rejects a punctuation defect', () => {
    const v = verdictForAssembledTitle('THE CEO Entrepreneur, | Long Sleeve', { truth: MIXED_SWEAT_HOODIE_UNISEX })
    expect(v.ok).toBe(false)
  })

  it('with no truth ctx, the truth/foreign-name half is skipped (fail-open) but concept + punctuation still run', () => {
    expect(verdictForAssembledTitle('THE CEO Fall Crewneck | Long Sleeve Crew Neck', { truth: null }).ok).toBe(false)
    expect(verdictForAssembledTitle('THE CEO Mother Hustler Sweatshirt | Hoodie Pullover', { truth: null }).ok).toBe(true)
  })
})

describe('enforceMoneyTail — consults the whole-string verify, not just the keyword\'s own truth (2026-08-22)', () => {
  it('refuses a candidate that is individually true but introduces a SECOND garment class already committed by the title', () => {
    const r = enforceMoneyTail(
      'THE CEO Mother Hustler Sweatshirt',
      'hoodie pullover long sleeve gift set',
      { apparel: true, truth: MIXED_SWEAT_HOODIE_UNISEX, allowAppend: true },
    )
    // Both "hoodie" and "pullover" pass `phraseTruthVerdict` alone (the family's union permits both),
    // but the ASSEMBLED title would name two garment classes at once — the exact defect class this
    // rewrite exists to close. The candidate must not win the slot.
    expect(r.decision).not.toBe('applied')
  })

  it('still applies a clean candidate that introduces no whole-string violation', () => {
    const r = enforceMoneyTail(
      'THE CEO Mother Hustler Sweatshirt',
      'cozy fleece pullover gift for family',
      { apparel: true, truth: MIXED_SWEAT_HOODIE_UNISEX, allowAppend: true },
    )
    expect(r.decision).toBe('applied')
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(r.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it('refuses a candidate that would carry a sibling design\'s name', () => {
    const r = enforceMoneyTail(
      'THE CEO Mother Hustler Sweatshirt',
      'billionare coming soon gift for family and friends',
      {
        apparel: true, truth: MIXED_SWEAT_HOODIE_UNISEX, allowAppend: true,
        foreignTokens: new Set(['billionare', 'coming', 'soon']),
      },
    )
    expect(r.decision).not.toBe('applied')
  })
})

describe('settleTruthBand — the additive search re-verifies the WHOLE string, not just length (2026-08-22)', () => {
  it('never appends a candidate that would carry a sibling design name, even when the band pool itself was not pre-filtered for it (defense in depth)', () => {
    const foreignTokens = new Set(['billionare', 'coming', 'soon'])
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    const band: TitleBandCtx = {
      apparel: true,
      factSegments: [],
      // Deliberately UNFILTERED — simulates a caller that forgot to sibling-scope its band ctx. The
      // whole-string verify, driven by `foreignTokens`/`reject` passed directly to `settleTruthBand`,
      // must still refuse the phrase — it does not rely solely on the band ctx being correctly wired.
      poolSegments: ['Billionare Coming Soon Gift For The Whole Family', 'Cozy Fleece Pullover For Everyone'],
      truthOk: () => true,
    }
    const r = settleTruthBand({
      produced: 'THE CEO Mother Hustler', prior: null, apparel: true, band,
      truth: MIXED_SWEAT_HOODIE_UNISEX, foreignTokens, reject,
    })
    expect(r.title.toLowerCase()).not.toContain('billionare')
  })

  it('never appends a candidate that would introduce a second garment class', () => {
    const band: TitleBandCtx = {
      apparel: true,
      factSegments: [],
      poolSegments: ['Hoodie Pullover Long Sleeve For The Whole Family', 'Cozy Fleece Sweatshirt For Everyone'],
      truthOk: () => true,
    }
    const r = settleTruthBand({
      produced: 'THE CEO Mother Hustler Sweatshirt', prior: null, apparel: true, band,
      truth: MIXED_SWEAT_HOODIE_UNISEX,
    })
    const groups = [...r.title.matchAll(/\b(?:sweatshirts?|pullovers?|crewnecks?|hood(?:ie|ed)s?)\b/gi)]
    const hasHoodie = groups.some((m) => /hood/i.test(m[0]))
    const hasSweatFamily = groups.some((m) => /sweatshirt|pullover|crewneck/i.test(m[0]))
    // Never BOTH at once — that is exactly the two-garment-class defect.
    expect(hasHoodie && hasSweatFamily).toBe(false)
  })
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FLOOR (title-floor-baseline task). Four live attempts, three production reverts: PR #646
 * shipped a 29-char parent; PR #647 added `TITLE_TRUTHFUL_SHIP_FLOOR = 65` and shipped a 42-char
 * parent anyway (the constant existed but sat on a code path the shipped title never took); a plain
 * regen on the reverted baseline produced a 42-char parent again. THE DIAGNOSIS: `settleTruthBand`
 * had no floor at all — `refused-kept-prior` / `shipped-truthful-under-band` / `unreachable-no-prior`
 * could each ship ANY length down to zero. These tests reproduce the collapse FIRST (see the first
 * `it` below — this must FAIL on the pre-fix baseline) before asserting the fix.
 */
describe('settleTruthBand — THE FLOOR (title-floor-baseline task, PO ruling "65-75 shippable, 70 is target")', () => {
  it('REPRODUCTION: the truth net strips a sibling design name from a 65-char prior, leaving a 42-char produced title with a thin pool — the real collapse PR #646/#647 shipped live', () => {
    const foreignTokens = new Set(['billionare', 'coming', 'soon'])
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    // THE LYING PRIOR — carries a sibling design's name ("Billionare Coming Soon" belongs to a
    // different design in the family), otherwise in band. Pinned so the fixture itself is legible.
    const prior = 'THE CEO Mother Hustler Sweatshirt Billionare Coming Soon Crewneck'
    expect(prior.length).toBe(65)
    // What the truth net leaves AFTER stripping the sibling's name — the exact 42-char collapse.
    const produced = 'THE CEO Mother Hustler Sweatshirt Crewneck'
    expect(produced.length).toBe(42)
    // A THIN pool: no truthful search phrase and no additional facts, so the additive search cannot
    // refill the gap — this is the genuine "band is unreachable from true material" case, not a
    // search-algorithm miss.
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const r = settleTruthBand({ produced, prior, apparel: true, band, truth: MIXED_SWEAT_HOODIE_UNISEX, foreignTokens, reject })
    // THE FIX: never ship under the hard floor unlabeled. Truth still outranks the lying prior (the
    // standing 2026-08-23 ruling), so the honest 42-char material still ships — but it must be
    // FLAGGED, not silently indistinguishable from a healthy 65-69 ship.
    expect(r.title).not.toBe(prior)                 // never the lying prior
    expect(r.title.toLowerCase()).not.toContain('billionare')
    expect(r.len).toBe(42)
    expect(r.len).toBeLessThan(TITLE_SHIP_FLOOR())
    expect(r.decision).toBe('shipped-truthful-below-floor')
    expect(r.hold).toBe(true)                        // the operator must see this
  })

  it('the 65-69 zone (above floor, below golden band) still reports the ORIGINAL under-band label, not the new floor label', () => {
    const foreignTokens = new Set(['billionare', 'coming', 'soon'])
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    const prior = 'THE CEO Mother Hustler Sweatshirt Billionare Coming Soon Crewneck'
    // 68 chars — true, in-cap, below the 70 golden band and exactly AT the derived floor (the corpus's
    // own lenMin — see TITLE_SHIP_FLOOR's doc; NOT the old hand-typed 65, which this length would also
    // have cleared, but the point of this fixture is to sit AT the real, derived boundary).
    const produced = 'THE CEO Mother Hustler Sweatshirt Crewneck Pullover Cozy Toasty Gift'
    expect(produced.length).toBe(68)
    expect(produced.length).toBeGreaterThanOrEqual(TITLE_SHIP_FLOOR())
    expect(produced.length).toBeLessThan(TITLE_BAND_LO)
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const r = settleTruthBand({ produced, prior, apparel: true, band, truth: MIXED_SWEAT_HOODIE_UNISEX, foreignTokens, reject })
    expect(r.len).toBeGreaterThanOrEqual(TITLE_SHIP_FLOOR())
    expect(r.len).toBeLessThan(TITLE_BAND_LO)
    expect(r.decision).toBe('shipped-truthful-under-band')
    expect(r.hold).toBe(true)
  })

  it('a TRUE prior below the floor still ships (nothing better to rank it against) but the reason names the floor', () => {
    // The prior itself is true and short — e.g. a pre-band-standard legacy title.
    const shortTruePrior = 'THE CEO Mother Hustler Sweatshirt'
    expect(shortTruePrior.length).toBeLessThan(TITLE_SHIP_FLOOR())
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const r = settleTruthBand({ produced: 'THE CEO Mother Hustler', prior: shortTruePrior, apparel: true, band, truth: MIXED_SWEAT_HOODIE_UNISEX })
    expect(r.title).toBe(shortTruePrior)
    expect(r.decision).toBe('refused-kept-prior')     // truth still wins the label — it really is the kept prior
    expect(r.reason).toMatch(/ship floor/)
    expect(r.hold).toBe(true)
  })

  it('NEVER EMIT EMPTY: an empty `produced` with a non-empty prior ships the prior, not "" — the ratchet this fix closes', () => {
    const prior = 'THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover Crewneck'
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const r = settleTruthBand({ produced: '', prior, apparel: true, band, truth: null })
    expect(r.title).toBe(prior)
    expect(r.title).not.toBe('')
    expect(r.decision).toBe('not-produced')
    expect(r.hold).toBe(true)
  })

  it('NEVER EMIT EMPTY: an empty `produced` with NO prior at all has nothing to fall back to — this is the one accepted residual gap, but it must be VISIBLE (hold=true), never silent', () => {
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const r = settleTruthBand({ produced: '', prior: null, apparel: true, band, truth: null })
    expect(r.title).toBe('')
    expect(r.hold).toBe(true)
    expect(r.reason).toMatch(/no prior/)
  })
})

describe('settleTitle — NEVER EMIT EMPTY, the PRIMARY site (title-floor-baseline task, item 2)', () => {
  const minimalCtx = (overrides: Partial<SettleTitleCtx>): SettleTitleCtx => ({
    produced: true,
    apparel: true,
    bandCtxFor: () => ({ apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }),
    moneyKws: null,
    moneyTailMode: 'off',
    moneyCtx: { apparel: true, allowAppend: true },
    spec: null,
    capTitle75: (t: string) => t,
    colorProtect: null,
    lean: 'unisex',
    v4NoPad: false,
    v4Mode: 'off',
    specFactTokens: [],
    truth: null,
    protect: '',
    reject: undefined,
    foreignTokens: undefined,
    scrubProtectedOverlap: false,
    prior: null,
    holdScope: 'broadcast',
    parentAsin: 'B0TEST0000',
    ...overrides,
  })

  it('a produced=true run with an empty raw (AI quota outage / empty LLM response) falls back to a non-empty prior instead of shipping "" — the exact live 2026-08-26 ratchet', () => {
    const prior = 'THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover Crewneck'
    const r = settleTitle('', minimalCtx({ prior }))
    expect(r.title).toBe(prior)
    expect(r.title).not.toBe('')
    expect(r.hold).toBe(true)
    expect(r.holdEntry).toBeDefined()
  })

  it('the benign produced=false passthrough (bullets/keywords-only regen) is UNCHANGED — byte-identical, hold=false', () => {
    const priorTitle = 'THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover Crewneck'
    const r = settleTitle(priorTitle, minimalCtx({ produced: false, prior: priorTitle }))
    expect(r.title).toBe(priorTitle)
    expect(r.decision).toBe('not-produced')
    expect(r.hold).toBe(false)
  })

  it('produced=true, empty raw, AND no prior at all: the one accepted residual gap — still empty, but hold=true now instead of silently false', () => {
    const r = settleTitle('', minimalCtx({ prior: null }))
    expect(r.title).toBe('')
    expect(r.hold).toBe(true)
  })
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PAD'S CROSS-GENDER VETO (PR #649 follow-up). #649 gave `buildNicheParentTitle` the same
 * validateTitle reject-and-retry loop `runTitleAgent` already had — it worked, live: 0 of 6 children
 * shipped under 65 chars, vs 4 of 6 before. But two children shipped with the pad appending a POOL
 * PHRASE carrying "For Women" onto a `lean_male` family:
 *   "THE CEO Don't Quit Sweatshirt | Pullover Sweatshirts For Women for Men"   (self-contradictory)
 *   "THE CEO Hustle Definiton Sweatshirt | Pullover Sweatshirts For Women"     (fights the lean)
 * `enforceMoneyTail` already has this exact veto for the MONEY TAIL slot (kw vs `ctx.lean`, kw vs the
 * title's own audience tail) — `candidateSegments` (the facts pad, titleBand.ts) never had it at all:
 * no lean/gender check anywhere in its body. These tests reproduce the live collapse FIRST (RED
 * against pre-fix code) before asserting the fix.
 */
describe('candidateSegments (the facts pad) — CROSS-GENDER VETO (PR #649 follow-up)', () => {
  it('REPRODUCTION: a lean_male family with only a "For Women" pool phrase available pads WITHOUT it — the exact live B0.. collapse ("Pullover Sweatshirts For Women" on a lean_male family)', () => {
    const title = 'THE CEO Hustle Definiton Sweatshirt'
    expect(title.length).toBe(35) // pin the fixture
    const ctx: TitleBandCtx = {
      apparel: true,
      lean: 'lean_male',
      poolSegments: ['Pullover Sweatshirts For Women'],
      truthOk: () => true,
    }
    const v = enforceTitleBand(title, ctx)
    // The candidate must never be admitted: no "for women" anywhere in the result, and since it was
    // the ONLY candidate in the bank, the pad has nothing left to say — same length as the input.
    expect(v.title.toLowerCase()).not.toContain('for women')
    expect(v.title).toBe(title)
    expect(v.title.length).toBe(35)
  })

  it('REPRODUCTION: a lean_male family whose title ALREADY carries "for Men" must never pad into the self-contradictory "For Women for Men" — the second live shipped string', () => {
    const title = 'THE CEO Dont Quit Sweatshirt for Men'
    expect(title.length).toBe(36) // pin the fixture
    const ctx: TitleBandCtx = {
      apparel: true,
      lean: 'lean_male',
      poolSegments: ['Pullover Sweatshirts For Women'],
      truthOk: () => true,
    }
    const v = enforceTitleBand(title, ctx)
    expect(v.title).not.toContain('Pullover Sweatshirts For Women for Men')
    expect(v.title.toLowerCase()).not.toContain('for women')
    expect(v.title).toBe(title)
    expect(v.title.length).toBe(36)
  })

  it('a lean_male family still accepts a pool phrase that agrees with the lean (fail-open direction unchanged)', () => {
    const title = 'THE CEO Hustle Definiton Sweatshirt'
    const ctx: TitleBandCtx = {
      apparel: true,
      lean: 'lean_male',
      poolSegments: ['Pullover Sweatshirts For Men'],
      truthOk: () => true,
    }
    const v = enforceTitleBand(title, ctx)
    expect(v.title.toLowerCase()).toContain('for men')
    expect(v.title.length).toBe(66)
  })

  it('a UNISEX family (no lean) still accepts a "For Women" pool phrase — the veto is lean-scoped, not a blanket ban', () => {
    const title = 'THE CEO Hustle Definiton Sweatshirt'
    const ctx: TitleBandCtx = {
      apparel: true,
      lean: 'unisex',
      poolSegments: ['Pullover Sweatshirts For Women'],
      truthOk: () => true,
    }
    const v = enforceTitleBand(title, ctx)
    expect(v.title.toLowerCase()).toContain('for women')
    expect(v.title.length).toBe(68)
  })

  it('with no `lean` on ctx at all (absent field), behavior is fail-open — byte-identical to a family with no veto information', () => {
    const title = 'THE CEO Hustle Definiton Sweatshirt'
    const ctx: TitleBandCtx = {
      apparel: true,
      poolSegments: ['Pullover Sweatshirts For Women'],
      truthOk: () => true,
    }
    const v = enforceTitleBand(title, ctx)
    expect(v.title.toLowerCase()).toContain('for women')
    expect(v.title.length).toBe(68)
  })
})
