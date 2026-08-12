/**
 * titleRulingAuthority.test.ts — a seller's editorial ruling must not be vetoed by our own
 * preferred floor, and must not depend on an unrelated cell in a spec table.
 *
 * THE INCIDENT (B0GVV3XL4T, 2026-08-10). The seller ruled "Unisex" is not a title word. The door
 * removed it — 61 → 54 chars — then had to re-pad from BLANK_SPECS to reach the band. For that
 * Gildan blank the entire pad vocabulary tops out at 69, because the one candidate that reaches
 * band ("Classic Fit Shirt", 74) is banned by the SAME ruling. 69 < TITLE_BAND_LO (70), so the
 * guard refused byte-identical and THE BANNED WORD SHIPPED.
 *
 * 75 is Amazon's (they rewrite a longer title). 70 is OURS — `scoreTitleQuality`'s golden band,
 * enforced by nothing outside this repo. Treating them as one tier is what let the second one
 * outrank a seller ruling.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { stripTitleWasteVocabulary, removalPermitted, TITLE_BAND_LO, TITLE_BAND_HI } from './titleBand'

const TITLE = 'THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee'
/** The real Gildan row: brandInCopy=false ⇒ garmentBrand collapses to '' upstream. */
const GILDAN = { apparel: true, garmentBrand: '', spec: { fit: 'Classic Fit', sleeve: 'Short Sleeve', neck: 'Crew Neck' }, garmentSecond: 'Shirt' }
/** Same blank, one cell different — the proof that the veto was arbitrary. */
const RELAXED = { ...GILDAN, spec: { ...GILDAN.spec, fit: 'Relaxed Fit' } }

const withFlag = <T>(mode: string, fn: () => T): T => {
  const prev = process.env.TITLE_RULING_OVER_FLOOR
  process.env.TITLE_RULING_OVER_FLOOR = mode
  try { return fn() } finally { process.env.TITLE_RULING_OVER_FLOOR = prev }
}
afterEach(() => { delete process.env.TITLE_RULING_OVER_FLOOR })

const strip = (band: unknown, moneyKws: string[] | null) =>
  stripTitleWasteVocabulary(TITLE, { apparel: true, band: band as never, moneyKws, money: null })

describe('removalPermitted — the two bounds are not the same kind of thing', () => {
  it('Amazon\'s cap vetoes in BOTH modes — it is externally enforced', () => {
    expect(removalPermitted(TITLE_BAND_HI + 1).ok).toBe(false)
    expect(withFlag('on', () => removalPermitted(TITLE_BAND_HI + 1).ok)).toBe(false)
  })

  it('our floor vetoes only when EXPLICITLY off; the default is on (2026-08-11)', () => {
    // The default flipped after the mint guard made the floor veto the last thing keeping banned
    // vocabulary alive. TITLE_RULING_OVER_FLOOR=off is now the kill switch, not the default.
    expect(withFlag('off', () => removalPermitted(TITLE_BAND_LO - 1).ok)).toBe(false)
    expect(removalPermitted(TITLE_BAND_LO - 1).ok).toBe(true)
    expect(withFlag('on', () => removalPermitted(TITLE_BAND_LO - 1).ok)).toBe(true)
  })

  it('in-band is permitted either way', () => {
    expect(removalPermitted(TITLE_BAND_LO).ok).toBe(true)
    expect(withFlag('on', () => removalPermitted(TITLE_BAND_HI).ok)).toBe(true)
  })
})

describe('stripTitleWasteVocabulary — the PO ruling', () => {
  it('THE INCIDENT CANNOT RECUR: the strip is unconditional in BOTH flag arms', () => {
    // This test used to PIN the defect (band-guard refusal, "Unisex" ships). The seller rejected
    // that outcome three times, so the strip no longer consults the floor at all.
    for (const mode of ['off', 'on']) {
      const r = withFlag(mode, () => strip(GILDAN, null))
      expect(r.decision, mode).toBe('stripped')
      expect(/\bunisex\b/i.test(r.title), mode).toBe(false)
    }
  })

  it('OFF: the SAME removal is permitted when one unrelated spec cell changes', () => {
    // "Classic Fit" is itself banned, so it cannot be the pad's refill; "Relaxed Fit" can. Whether
    // the seller's ruling is honoured therefore depended on blank_specs.fit — which has nothing to
    // do with the ruling. That arbitrariness is the defect, not the arithmetic.
    const r = withFlag('off', () => strip(RELAXED, null))
    expect(r.decision).toBe('stripped')
    expect(/\bunisex\b/i.test(r.title)).toBe(false)
  })

  it('ON: the ruling holds on the real Gildan blank — a short clean title beats a padded banned one', () => {
    const r = withFlag('on', () => strip(GILDAN, null))
    expect(r.decision).toBe('stripped')
    expect(/\bunisex\b/i.test(r.title)).toBe(false)
    expect(r.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)   // Amazon's cap still absolute
  })

  it('ON: the outcome is INDEPENDENT of money-keyword supply', () => {
    // The whole point. At off, whether a seller ruling is honoured depends on whether the keyword
    // pool happens to carry a scored candidate — which on this ASIN it does not (88 rows, zero
    // market_opportunity). A ruling must not be a function of data availability.
    for (const kws of [null, ['graphic t shirts']] as (string[] | null)[]) {
      const r = withFlag('on', () => strip(GILDAN, kws))
      expect(r.decision, `moneyKws=${JSON.stringify(kws)}`).toBe('stripped')
      expect(/\bunisex\b/i.test(r.title)).toBe(false)
    }
  })

  it('ON: a title with no waste is still untouched — the flag widens nothing else', () => {
    const clean = 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee'
    const r = withFlag('on', () => stripTitleWasteVocabulary(clean, { apparel: true, band: GILDAN as never, moneyKws: null, money: null }))
    expect(r.decision).toBe('no-waste')
    expect(r.title).toBe(clean)
  })
})

describe('removalPermitted — the ABSOLUTE floor (adversarial review, 2026-08-10)', () => {
  it('at ON there is still a hard lower bound — the flag lowers the floor, it does not delete it', () => {
    // The first cut of removalPermitted returned ok for ANY length at 'on', because the only lower
    // bound in the predicate was the one being relaxed. removalPermitted(1).ok was true.
    expect(withFlag('on', () => removalPermitted(1).ok)).toBe(false)
    expect(withFlag('on', () => removalPermitted(49).ok)).toBe(false)
    expect(withFlag('on', () => removalPermitted(50).ok)).toBe(true)
  })

  it('the realistic trigger is a MISSING blank_specs row, not a contrived input', () => {
    // blank_specs fails OPEN when a blank has no row (task #159): candidateSegments then yields
    // nothing, the pad cannot add a character, and the removal ships at its raw stripped length.
    const noSpec = { apparel: true, garmentBrand: '', spec: null, garmentSecond: null }
    const r = withFlag('on', () => stripTitleWasteVocabulary(TITLE, { apparel: true, band: noSpec as never, moneyKws: null, money: null }))
    expect(r.title.length).toBeGreaterThanOrEqual(50)
    if (r.decision === 'stripped') expect(/\bunisex\b/i.test(r.title)).toBe(false)
  })
})
