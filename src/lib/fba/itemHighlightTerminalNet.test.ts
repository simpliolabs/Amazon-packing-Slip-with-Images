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
 */
import { describe, it, expect } from 'vitest'
import { capItemHighlightRepeats, classifyStoredIhLine } from './productDetailAttrs'
import { CONTENT_CONTRACT } from './contentContract'
import {
  buildPerSkuItemHighlightMap, perDesignIhRows, pushableDesignLines,
  UNDER_FLOOR, NO_LINE_FOR_DESIGN, REPEAT_IN_STORED_LINE,
  type PerChildItemHighlight,
} from './perDesignItemHighlights'

describe('H10 — the <=2-per-word cap must count across the WHOLE line, not fail open on a comma-less line', () => {
  const IN = 'this comfy sweatshirt is a sweatshirt every sweatshirt fan wants as their go to sweatshirt'

  it('REPRODUCTION (would be RED at HEAD c1eabe9): 4x "sweatshirt", no comma', () => {
    expect(IN.length).toBe(90)
    expect((IN.match(/sweatshirt/g) ?? []).length).toBe(4)
  })

  it('FIX: is no longer returned byte-identical to the violating input', () => {
    const out = capItemHighlightRepeats(IN)
    expect(out).not.toBe(IN)
  })

  it('FIX: refuses outright (empty) — a single comma-less phrase that itself violates the cap has no' +
     ' trailing phrase to drop, so it is refused, never partially shipped', () => {
    expect(capItemHighlightRepeats(IN)).toBe('')
  })
})

describe('H11 — the 125-char cap must not fail open on a comma-less line (no phrase-count guard)', () => {
  const base = 'This is a wonderfully soft and breathable crewneck pullover made from premium cotton blend fabric designed for everyday comfort during chilly mornings lazy weekends and cozy evenings at home with friends and family gatherings galore'
  const IN = base.slice(0, 218)

  it('REPRODUCTION (would be RED at HEAD c1eabe9): 218 chars, no comma, no repeat', () => {
    expect(IN.length).toBe(218)
    expect(IN.includes(',')).toBe(false)
  })

  it('FIX: never ships over the contract max, and is refused (not truncated) when the sole phrase alone exceeds it', () => {
    const out = capItemHighlightRepeats(IN)
    expect(out.length).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)
    expect(out).toBe('')
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

  it('FIX: never returns the silently-amputated 88-char survivor', () => {
    const out = capItemHighlightRepeats(IN)
    expect(out).not.toBe(clause1)
  })

  it('FIX: refuses outright (empty) — dropping the trailing clause is the only way to fit the max, and' +
     ' that survivor sits under CONTENT_CONTRACT.itemHighlights.min, so amputation is refused, not shipped', () => {
    const out = capItemHighlightRepeats(IN)
    expect(out).toBe('')
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
