import { describe, it, expect } from 'vitest'
import { enforceTitleBand, TITLE_BAND_LO, TITLE_BAND_HI, type TitleBandCtx } from './titleBand'

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
