/**
 * titleMoneyTailAppend.test.ts — the money tail may APPEND where none existed (PO ruling 2026-08-10).
 *
 * THE DEFECT, measured live on B0GVV3XL4T. `enforceMoneyTail` was replace-only by an explicit
 * conservative choice ('no-tail' — "never APPENDS where none existed"), taken when the reference gold
 * happened to already carry a replaceable tail. The council hands the door a PIPE-LESS 61-char title,
 * so the money door abstained — and `enforceTitleBand`'s pad, which runs AFTER it, appended
 * " | Crew Neck" (a BLANK_SPECS neck value) to reach the 70-75 band.
 *
 * Net effect: a SPEC FACT took the highest-value position in the title because the money door declined
 * to. The PO's objection was exact: "WHY did we need the filler CREW NECK there? crew neck can go on
 * highlights" — and, on the same ruling, "Main money or design word needs to be short and sweet, up to
 * 6-7 words, not entire 65 characters".
 *
 * These tests pin the fix AND its safety rails: appending must never override the band, the
 * word-repeat guard, the design-right guard or the audience veto — it may only claim a slot the pad
 * would otherwise have filled with filler.
 */

import { describe, it, expect } from 'vitest'
import { enforceMoneyTail, type MoneyTailCtx } from './titleBand'

/** The real shape the council produced for B0GVV3XL4T: 61 chars, NO pipe, no audience tail. */
const PIPELESS = 'THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee'

const ctx = (over: Partial<MoneyTailCtx> = {}): MoneyTailCtx => ({
  apparel: true,
  lean: null,
  spec: null,
  protect: '2026 World Soccer Cup',
  garmentBrand: 'Comfort Colors',
  allowAppend: true,
  ...over,
})

describe('money tail — append where none existed', () => {
  it('THE REGRESSION: with append OFF the door abstains, which is what let the pad weld a spec fact in', () => {
    const r = enforceMoneyTail(PIPELESS, 'Football Tee', ctx({ allowAppend: false }))
    expect(r.decision).toBe('no-tail')
    expect(r.title).toBe(PIPELESS)          // unchanged — the pad then appends "| Crew Neck" downstream
  })

  it('APPEND ALONE IS NOT ENOUGH — a 12-word left segment leaves no room for ANY tail', () => {
    // This is the PO's ruling proved arithmetically. PIPELESS is 61 chars; " | Football Tee" is 15,
    // so the shortest useful money tail lands at 76 — over the 75 cap. Enabling append does NOT
    // rescue a bloated left segment; it returns 'no-fit' and the pad still owns the space.
    expect(PIPELESS.length).toBe(61)
    const r = enforceMoneyTail(PIPELESS, 'Football Tee', ctx())
    expect(r.decision).toBe('no-fit')
  })

  it('THE FIX WORKS ON THE PO GOLD SHAPE: a short design segment leaves room, and the tail lands', () => {
    // The PO's own gold: "THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee".
    // Left = 39 chars / 7 words. THAT is what makes the money position exist at all.
    const SHORT = 'THE CEO 2026 World Soccer Cup Tee Shirt'
    expect(SHORT.split(/\s+/).length).toBeLessThanOrEqual(8)   // brand(2) + 6 design words
    const r = enforceMoneyTail(SHORT, 'USA Mexico Canada Football Tee', ctx())
    expect(r.decision).toBe('applied')
    expect(r.title).toContain(' | ')
    expect(r.title.toLowerCase()).toContain('football')
    expect(r.title.length).toBeGreaterThanOrEqual(70)
    expect(r.title.length).toBeLessThanOrEqual(75)
  })

  it('the band still rules: a keyword that cannot land in 70-75 is refused, not force-fitted', () => {
    const r = enforceMoneyTail(PIPELESS, 'Extremely Long Unfittable Championship Supporter Jersey Phrase', ctx())
    expect(r.decision).not.toBe('applied')
    expect(r.title).toBe(PIPELESS)
  })

  it('appending never bypasses the word-repeat guard', () => {
    // "Soccer" and "Cup" are already on the left — a tail repeating them must skip.
    const r = enforceMoneyTail(PIPELESS, 'Soccer Cup Shirt', ctx())
    expect(r.decision).not.toBe('applied')
  })

  it('a title that ALREADY has a tail is unaffected by the append path (replace semantics preserved)', () => {
    const withTail = 'THE CEO 2026 World Soccer Cup Tee Shirt | Classic Fit'
    const a = enforceMoneyTail(withTail, 'Football Tee', ctx())
    const b = enforceMoneyTail(withTail, 'Football Tee', ctx({ allowAppend: false }))
    expect(a.decision).toBe(b.decision)     // append flag is irrelevant when a tail exists
    expect(a.title).toBe(b.title)
  })

  it('no keyword ⇒ no invented tail: a shorter title beats a fact in the money slot', () => {
    const r = enforceMoneyTail(PIPELESS, null, ctx())
    expect(r.decision).not.toBe('applied')
    expect(r.title).toBe(PIPELESS)
  })
})
