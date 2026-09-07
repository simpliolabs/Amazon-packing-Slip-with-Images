/**
 * The per-design Item Highlight PUSH MAP (PO 2026-08-21): every SKU gets ITS design's line; a SKU
 * whose design has no composed line is SKIPPED ('no-line-for-design') — never another design's line,
 * never a broadcast value (there is none to give: the map has no broadcast input by construction).
 */
import { describe, it, expect } from 'vitest'
import { buildPerSkuItemHighlightMap, markPushedItemHighlights, perDesignIhRows, NO_LINE_FOR_DESIGN, REPEAT_IN_STORED_LINE, type PerChildItemHighlight } from './perDesignItemHighlights'

// FIX WAVE 2 (I-2, 2026-09-06): BOTH lines originally repeated a folded significant word (`men`
// twice in BM_LINE; `graphic`/`tee` twice in RK_LINE) — harmless before this fix (this describe
// block tests SKU/twin resolution and push-through stamping, never repeat content), but
// `buildPerSkuItemHighlightMap` now REFUSES any stored line that repeats one (see below), so a
// fixture written before the absolute no-repeat ruling existed would now be skipped by the very
// tests that assert it gets MAPPED. Re-worded, same shape/length, zero repeated folded tokens.
const BM_LINE = 'Gym Motivation Shirts, Workout Graphic Tees, Lifting Apparel for Men, Fitness Clothing Line, Crew Neck'
const RK_LINE = 'Real King Novelty Tee, Workout Graphic Apparel, Lifting Gear for Men, Bodybuilding Tops, Crew Neck'
const ENTRIES: PerChildItemHighlight[] = [
  { sku: 'BM64000L-BK', asin: 'B0BM000001', item_highlight: BM_LINE, designKey: 'BM', designName: 'Beast Mode', hold: null },
  { sku: 'BM64000M-BK', asin: 'B0BM000002', item_highlight: BM_LINE, designKey: 'BM', designName: 'Beast Mode', hold: null },
  { sku: 'DQ64000L-BK', asin: 'B0DQ000001', item_highlight: '', designKey: 'DQ', designName: "Don't Quit", hold: 'thin-candidates' },
  { sku: 'RK64000L-BK', asin: 'B0RK000001', item_highlight: RK_LINE, designKey: 'RK', designName: 'Real King', hold: null },
]

describe('buildPerSkuItemHighlightMap', () => {
  it('assigns each SKU its OWN design line and skips the held design with no-line-for-design', () => {
    const targets = [
      { sku: 'BM64000L-BK', asin: 'B0BM000001' }, { sku: 'BM64000M-BK', asin: 'B0BM000002' },
      { sku: 'DQ64000L-BK', asin: 'B0DQ000001' }, { sku: 'RK64000L-BK', asin: 'B0RK000001' },
    ]
    const { values, skipped } = buildPerSkuItemHighlightMap(ENTRIES, targets, 'B0DQ5YZH38')
    expect(values.get('BM64000L-BK')).toBe(BM_LINE)
    expect(values.get('BM64000M-BK')).toBe(BM_LINE)
    expect(values.get('RK64000L-BK')).toBe(RK_LINE)
    expect(values.has('DQ64000L-BK')).toBe(false)
    expect(skipped).toEqual([{ sku: 'DQ64000L-BK', asin: 'B0DQ000001', reason: NO_LINE_FOR_DESIGN }])
  })

  it('an FBM twin (absent by SKU, same ASIN) inherits its sibling design line — the same twin resolution every per-child push applies', () => {
    const { values, skipped } = buildPerSkuItemHighlightMap(ENTRIES, [{ sku: 'RK64000L-BK-FBM', asin: 'B0RK000001' }, { sku: 'DQ64000L-BK-FBM', asin: 'B0DQ000001' }], null)
    expect(values.get('RK64000L-BK-FBM')).toBe(RK_LINE)
    expect(skipped.map((s) => s.sku)).toEqual(['DQ64000L-BK-FBM'])   // the held design's twin is skipped too
  })

  it('the variation parent hub and an unknown SKU are skipped — never given any design line', () => {
    const { values, skipped } = buildPerSkuItemHighlightMap(ENTRIES, [{ sku: 'GYM-PARENT', asin: 'B0DQ5YZH38' }, { sku: 'ZZ64000L-BK', asin: 'B0ZZ000001' }], 'B0DQ5YZH38')
    expect(values.size).toBe(0)
    expect(skipped.map((s) => s.sku)).toEqual(['GYM-PARENT', 'ZZ64000L-BK'])
  })

  it('an empty / missing array yields no values (every target skipped) — a broadcast fallback does not exist here', () => {
    const { values, skipped } = buildPerSkuItemHighlightMap(null, [{ sku: 'BM64000L-BK', asin: 'B0BM000001' }], null)
    expect(values.size).toBe(0)
    expect(skipped).toHaveLength(1)
  })
})

/* ─── FIX WAVE 2 (I-2b, 2026-09-06, final whole-branch review #2 controller RULING) ───────────────
 *
 * The PO ruling ("2. No Repeat as per Amazon Ruules") was enforced at GENERATION only
 * (itemHighlightComposer.ts, Task 6) — a per-design line stored BEFORE that ruling shipped (or a
 * hand-edited row) could still carry a repeated significant word, and until this fix
 * `buildPerSkuItemHighlightMap` mapped it straight through to the push payload (reproduced against
 * unmodified HEAD bea1f24: a MAIN-era line carrying `tee` twice — final-review-2-findings.md
 * section 0(a) — was MAPPED, `skipped: []`). This is the LAST pure function before Amazon, so it is
 * the one place a terminal net can catch every path that could ever have written a bad line — stale
 * bytes, a manual DB edit, a future producer bug — not just the composer's own output. Reuses the
 * composer's OWN fold (`lineHasSignificantRepeat` / `significantFolded`, itemHighlightComposer.ts)
 * rather than a new tokenizer (coherence INVARIANT 1): a folding drift between "what the composer
 * calls a repeat" and "what the push seam calls a repeat" is exactly the class of bug this project's
 * memory calls out (coverage-token-folding-shirt-hub-trap). */
describe('FIX WAVE 2 (I-2b): buildPerSkuItemHighlightMap refuses a stored line that repeats a significant word', () => {
  const STALE_LINE_REPEATED_TEE = 'Graphic Novelty Tee for Men, Boss Definition Motivation Wear, Funny Tee Gift Idea Today, Ring-Spun Cotton, Classic Fit'

  it('a stale stored line with `tee` twice (the reviewer-executed MAIN-era reproduction) is SKIPPED with repeat-in-stored-line, never mapped', () => {
    const entries: PerChildItemHighlight[] = [
      { sku: 'BD64000L-BK', asin: 'B0BD000001', item_highlight: STALE_LINE_REPEATED_TEE, designKey: 'BD', designName: 'Boss Definition', hold: null },
    ]
    const { values, skipped } = buildPerSkuItemHighlightMap(entries, [{ sku: 'BD64000L-BK', asin: 'B0BD000001' }], null)
    expect(values.has('BD64000L-BK')).toBe(false)
    expect(skipped).toEqual([{ sku: 'BD64000L-BK', asin: 'B0BD000001', reason: REPEAT_IN_STORED_LINE }])
  })

  it('a clean stored line (no repeated folded token) is mapped exactly as before — the refusal is scoped to the defect, not a blanket re-check that starves healthy lines', () => {
    const { values, skipped } = buildPerSkuItemHighlightMap(ENTRIES, [{ sku: 'BM64000L-BK', asin: 'B0BM000001' }], null)
    expect(values.get('BM64000L-BK')).toBe(BM_LINE)
    expect(skipped).toHaveLength(0)
  })

  it('an FBM twin resolved by ASIN through a repeated stored line is refused too — the twin resolution never bypasses the repeat check', () => {
    const entries: PerChildItemHighlight[] = [
      { sku: 'BD64000L-BK', asin: 'B0BD000001', item_highlight: STALE_LINE_REPEATED_TEE, designKey: 'BD', designName: 'Boss Definition', hold: null },
    ]
    const { values, skipped } = buildPerSkuItemHighlightMap(entries, [{ sku: 'BD64000L-BK-FBM', asin: 'B0BD000001' }], null)
    expect(values.has('BD64000L-BK-FBM')).toBe(false)
    expect(skipped).toEqual([{ sku: 'BD64000L-BK-FBM', asin: 'B0BD000001', reason: REPEAT_IN_STORED_LINE }])
  })
})

describe('perDesignIhRows + markPushedItemHighlights', () => {
  it('one row per design with line, hold, SKU count and the on-Amazon mirror', () => {
    const rows = perDesignIhRows(ENTRIES)
    expect(rows.map((r) => [r.designKey, r.designName, r.skuCount, r.hold, r.onAmazon])).toEqual([
      ['BM', 'Beast Mode', 2, null, false], ['DQ', "Don't Quit", 1, 'thin-candidates', false], ['RK', 'Real King', 1, null, false],
    ])
    expect(rows[1].line).toBe('')
  })

  it('write-through stamps pushed_value only on the accepted SKUs whose value equals their own line', () => {
    const marked = markPushedItemHighlights(ENTRIES, [
      { sku: 'BM64000L-BK', asin: 'B0BM000001', value: BM_LINE },
      { sku: 'RK64000L-BK-FBM', asin: 'B0RK000001', value: RK_LINE },   // twin → stamps the RK entry by ASIN
      { sku: 'BM64000M-BK', asin: 'B0BM000002', value: 'some other line' },  // mismatch → never stamped
    ])
    expect(marked.changed).toBe(true)
    const by = new Map(marked.entries.map((e) => [e.sku, e.pushed_value ?? null]))
    expect(by.get('BM64000L-BK')).toBe(BM_LINE)
    expect(by.get('BM64000M-BK')).toBeNull()
    expect(by.get('RK64000L-BK')).toBe(RK_LINE)
    expect(by.get('DQ64000L-BK')).toBeNull()
    const rows = perDesignIhRows(marked.entries)
    expect(rows.find((r) => r.designKey === 'RK')!.onAmazon).toBe(true)
    expect(rows.find((r) => r.designKey === 'BM')!.onAmazon).toBe(false)   // one of two BM SKUs pushed
  })
})
