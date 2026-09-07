/**
 * IH TERMINAL NET, PHASE 1 (2026-09-07, spec docs/superpowers/specs/2026-09-07-item-highlight-
 * terminal-net.md, PO 2026-09-07 verbatim "B: yesm go" — fix the terminal nets BEFORE the writer).
 *
 * Pins H10-H13, each reproduced against the REAL functions at HEAD c1eabe9 with a throwaway probe
 * (`scratchpad/ih-research/probe-h10-h13.mts`) before any repo file changed — the critique's
 * section 5 (H10-H13) and section 1 (C3). All four were RED at c1eabe9 (see the probe output quoted
 * inline below); this file is what turned them GREEN.
 *
 *   H10 IN  "this comfy sweatshirt is a sweatshirt every sweatshirt fan wants as their go to
 *            sweatshirt" (90 chars, no comma, "sweatshirt" x4)
 *       OUT (HEAD) len=90 identical=true            — the raw input, unchanged
 *   H11 IN  a 218-char comma-less line, no repeats
 *       OUT (HEAD) len=218 identical=true, over125=true — 218 raw chars handed toward the SP-API PATCH
 *   H12 IN  "This wonderfully soft crewneck pullover is perfect for chilly mornings and lazy
 *            weekends, featuring a relaxed everyday fit that pairs easily with jeans sneakers or
 *            your favorite leggings" (186 chars, ONE comma)
 *       OUT (HEAD) len=88 identical=false — the second clause silently deleted, survivor now BELOW
 *            the 107-char floor and nothing re-checked it
 *   H13 IN  an 80-char (here: 77-char, same point) stored line, no repeat
 *       OUT (HEAD) classifyStoredIhLine = 'ok' — pushable, despite sitting 30 chars under the floor
 *
 * FIX ROUND 1 (2026-09-07, controller RULING on phase-1-fix-round-findings.md, opus review
 * phase-1-review.md BLOCKING 1 + BLOCKING 2): Phase 1's fix encoded "refused" as `''` — the same
 * token eight callers already read as "no value". `capItemHighlightRepeats` now returns a TYPED,
 * OUT-OF-BAND `IhNetResult` (`{ok:true, value} | {ok:false, reason}`), so a caller MUST destructure
 * `.ok` before it can read a value — the compiler refuses one that does not. The two BLOCKING
 * reproductions are pinned below exactly as the reviewer ran them (`buildDetailPatchValue` on the
 * 218-char H11 line; `applyBlankBrandNetPerDesign` on the 129-char two-phrase line), plus IMPORTANT
 * 4 (a REPEAT-driven drop landing under the floor must also refuse, not just a LENGTH-driven one).
 */
import { describe, it, expect } from 'vitest'
import { capItemHighlightRepeats, classifyStoredIhLine, buildDetailPatchValue, type DetailAttribute, type IhNetResult } from './productDetailAttrs'
import { applyBlankBrandNetPerDesign, DEFAULT_BLANK_SPECS } from './blankSpecs'
import { CONTENT_CONTRACT } from './contentContract'
import {
  buildPerSkuItemHighlightMap, perDesignIhRows, pushableDesignLines,
  UNDER_FLOOR, NO_LINE_FOR_DESIGN, REPEAT_IN_STORED_LINE,
  type PerChildItemHighlight,
} from './perDesignItemHighlights'

/** Unwraps an IhNetResult for a test that EXPECTS the net to have accepted the line — a refusal
 *  throws loudly (naming the reason) instead of silently comparing `undefined` to a string. */
function okValue(r: IhNetResult): string {
  if (!r.ok) throw new Error(`expected the net to accept the line, but it refused: ${r.reason}`)
  return r.value
}

describe('H10 — the <=2-per-word cap must count across the WHOLE line, not fail open on a comma-less line', () => {
  const IN = 'this comfy sweatshirt is a sweatshirt every sweatshirt fan wants as their go to sweatshirt'

  it('REPRODUCTION (would be RED at HEAD c1eabe9): 4x "sweatshirt", no comma', () => {
    expect(IN.length).toBe(90)
    expect((IN.match(/sweatshirt/g) ?? []).length).toBe(4)
  })

  it('FIX: refuses outright — a single comma-less phrase that itself violates the cap has no' +
     ' trailing phrase to drop, so it is refused (typed, out-of-band), never partially shipped', () => {
    expect(capItemHighlightRepeats(IN)).toEqual({ ok: false, reason: 'repeat-over-budget' })
  })
})

describe('H11 — the 125-char cap must not fail open on a comma-less line (no phrase-count guard)', () => {
  const base = 'This is a wonderfully soft and breathable crewneck pullover made from premium cotton blend fabric designed for everyday comfort during chilly mornings lazy weekends and cozy evenings at home with friends and family gatherings galore'
  const IN = base.slice(0, 218)

  it('REPRODUCTION (would be RED at HEAD c1eabe9): 218 chars, no comma, no repeat', () => {
    expect(IN.length).toBe(218)
    expect(IN.includes(',')).toBe(false)
  })

  it('FIX: never ships over the contract max — refused (typed) when the sole phrase alone exceeds it', () => {
    expect(capItemHighlightRepeats(IN)).toEqual({ ok: false, reason: 'over-max' })
  })

  it("BLOCKING 1 REPRODUCTION (reviewer's exact input, phase-1-review.md): buildDetailPatchValue" +
     ' must return [] on refusal — never [{value:""}], which is a live SP-API replace patch that' +
     ' CLEARS the shopper-visible field', () => {
    const H11 = 'A remarkably durable garment constructed from ringspun combed fibres finished with double needle stitching throughout every seam so it survives repeated laundering while keeping its original silhouette and vivid colour'
    expect(H11.length).toBe(218)
    const attr: DetailAttribute = { spApiKey: 'item_highlights', scope: 'broadcast' }
    const patch = buildDetailPatchValue(attr, H11, 'ATVPDKIKX0DER', 'en_US')
    expect(patch).toEqual([])
  })
})

describe('H12 — the length rule must REFUSE, not amputate a two-clause line below the floor', () => {
  const clause1 = 'This wonderfully soft crewneck pullover is perfect for chilly mornings and lazy weekends'
  const clause2 = 'featuring a relaxed everyday fit that pairs easily with jeans sneakers or your favorite leggings'
  const IN = `${clause1}, ${clause2}`

  it('REPRODUCTION (would be RED at HEAD c1eabe9): 186 chars, one comma, two clauses', () => {
    expect(IN.length).toBe(186)
    expect(clause1.length).toBe(88)
    expect(IN.split(',').length).toBe(2)
  })

  it('FIX: refuses outright (typed) — dropping the trailing clause is the only way to fit the max,' +
     ' and that survivor sits under CONTENT_CONTRACT.itemHighlights.min, so amputation is refused, not shipped', () => {
    expect(capItemHighlightRepeats(IN)).toEqual({ ok: false, reason: 'under-floor' })
  })
})

describe('IMPORTANT 4 (fix round 1) — a REPEAT-driven drop that lands under the floor must also refuse', () => {
  // Reviewer's exact reproduction (phase-1-review.md, IMPORTANT 4): the repeat cap alone drops
  // "Cotton Feel Softness" (the third "cotton" phrase, over IH_MAX_WORD_REPEATS), leaving a
  // 4-phrase, 90-char survivor — under the floor — with NO length-driven drop having occurred, so
  // Phase 1's floor guard (scoped to `capped.length < kept.length`) never fired.
  const IN = 'Cotton Rich Tee, Cotton Blend Comfort, Cotton Feel Softness, Durable Twin Needle Hems, Gift Ready Packaging Idea'
  const OLD_SHIPPED_OUTPUT = 'Cotton Rich Tee, Cotton Blend Comfort, Durable Twin Needle Hems, Gift Ready Packaging Idea'

  it('REPRODUCTION: 112 chars in, a repeat-only drop would have left a 90-char, under-floor survivor', () => {
    expect(IN.length).toBe(112)
    expect(OLD_SHIPPED_OUTPUT.length).toBe(90)
    expect(OLD_SHIPPED_OUTPUT.length).toBeLessThan(CONTENT_CONTRACT.itemHighlights.min)
    expect(classifyStoredIhLine(OLD_SHIPPED_OUTPUT)).toBe('repeat-in-stored-line')
  })

  it('FIX: refuses (typed) instead of shipping the repeat-driven, under-floor survivor', () => {
    expect(capItemHighlightRepeats(IN)).toEqual({ ok: false, reason: 'under-floor' })
  })
})

describe('H13 — classifyStoredIhLine must refuse an under-floor line, not classify it "ok"', () => {
  // 77 chars — the exact reproduction point (any value < CONTENT_CONTRACT.itemHighlights.min=107
  // and non-repeating demonstrates the same gap).
  const IN = '100% Ring-Spun Cotton, Relaxed Fit, Crew Neck, Soft Everyday Wear, Gift Ready'

  it('REPRODUCTION (would be RED at HEAD c1eabe9): 77 chars, well under the 107 floor, no repeat', () => {
    expect(IN.length).toBeLessThan(CONTENT_CONTRACT.itemHighlights.min)
  })

  it('FIX: classifies under-floor, not ok', () => {
    expect(classifyStoredIhLine(IN)).toBe('under-floor')
  })

  it('a line AT or ABOVE the floor with the same content shape still classifies ok (the new rule is scoped to length, not a blanket re-check)', () => {
    const padded = IN + ', Machine Washable Durable Print'
    expect(padded.length).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min)
    expect(classifyStoredIhLine(padded)).toBe('ok')
  })
})

describe('H13 CONSEQUENCE — the under-floor refusal reaches the push seam and the card, not just the classifier', () => {
  const UNDER_FLOOR_LINE = '100% Ring-Spun Cotton, Relaxed Fit, Crew Neck, Soft Everyday Wear, Gift Ready' // 77 chars
  const entries: PerChildItemHighlight[] = [
    { sku: 'UF-SKU', asin: 'B0UF000001', item_highlight: UNDER_FLOOR_LINE, designKey: 'UF', designName: 'Under Floor', hold: null },
  ]

  it('buildPerSkuItemHighlightMap (the push seam) refuses it with reason under-floor, never maps it', () => {
    const { values, skipped } = buildPerSkuItemHighlightMap(entries, [{ sku: 'UF-SKU', asin: 'B0UF000001' }], null)
    expect(values.has('UF-SKU')).toBe(false)
    expect(skipped).toEqual([{ sku: 'UF-SKU', asin: 'B0UF000001', reason: UNDER_FLOOR }])
    expect(skipped[0].reason).not.toBe(NO_LINE_FOR_DESIGN)
    expect(skipped[0].reason).not.toBe(REPEAT_IN_STORED_LINE)
  })

  it('perDesignIhRows (the card, PRE-FLIGHT) carries skipReason under-floor and is excluded from pushableDesignLines', () => {
    const rows = perDesignIhRows(entries)
    expect(rows[0].skipReason).toBe(UNDER_FLOOR)
    expect(pushableDesignLines(entries)).toEqual([])
  })
})

describe('BLOCKING 2 REPRODUCTION (fix round 1, phase-1-review.md) — a refusal must never overwrite stored content', () => {
  const CC = DEFAULT_BLANK_SPECS[0] // Comfort Colors — brand allowed in copy

  it("applyBlankBrandNetPerDesign on the reviewer's exact 129-char two-phrase line: refused -> kept unchanged, changed:false (never '' / changed:true)", () => {
    const line129 = 'Heavyweight ring spun combed cotton crewneck built for daily wear with a soft brushed inner face x, Reinforced Shoulder Taping OK'
    expect(line129.length).toBe(129)
    const entries = [{ sku: 'SKU-1', asin: 'B0TEST0001', item_highlight: line129 }]
    const perChildTitles = [{ sku: 'SKU-1', asin: 'B0TEST0001', title: 'THE CEO See You Later Alligator Shirt | Long Sleeve Shirt for Women' }]
    const result = applyBlankBrandNetPerDesign(entries, perChildTitles, CC)
    expect(result.entries[0].item_highlight).toBe(line129)
    expect(result.changed).toBe(false)
  })
})

describe('MINOR 6 (fix round 1) — the repeat cap counts WHOLE-LINE across multiple phrases, not per-segment', () => {
  it('a THIRD phrase repeating the same significant word drops (whole-line tally), even though every individual phrase is a distinct segment', () => {
    // "cotton" appears in phrase 1 and 2 (budget 2, Amazon's own flat cap) — the THIRD occurrence in
    // phrase 3 must be the one that drops, proving the tally persists ACROSS phrases rather than
    // resetting per comma-segment (a per-segment counter would never see three). A fourth, distinct
    // padding phrase keeps the post-eviction survivor clear of the (unrelated) floor refusal this
    // pin is not about — it exists purely to isolate the WHOLE-LINE repeat count.
    const IN = 'Cotton Rich Graphic Tee Design, Cotton Blend Everyday Comfort Wear, Cotton Feel Soft Breathable Touch, Durable Reinforced Stitching For Daily Wear'
    const out = okValue(capItemHighlightRepeats(IN))
    expect(out).toBe('Cotton Rich Graphic Tee Design, Cotton Blend Everyday Comfort Wear, Durable Reinforced Stitching For Daily Wear')
    expect(out).not.toContain('Feel Soft Breathable Touch')
  })
})
