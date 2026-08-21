/**
 * The per-design Item Highlight PUSH MAP (PO 2026-08-21): every SKU gets ITS design's line; a SKU
 * whose design has no composed line is SKIPPED ('no-line-for-design') — never another design's line,
 * never a broadcast value (there is none to give: the map has no broadcast input by construction).
 */
import { describe, it, expect } from 'vitest'
import { buildPerSkuItemHighlightMap, markPushedItemHighlights, perDesignIhRows, NO_LINE_FOR_DESIGN, type PerChildItemHighlight } from './perDesignItemHighlights'

const BM_LINE = 'Gym Motivation Shirts, Workout Graphic Tees, Lifting Apparel for Men, Fitness Clothing Men, Crew Neck'
const RK_LINE = 'Real King Graphic Tee, Workout Graphic Tees, Lifting Apparel for Men, Bodybuilding Tops, Crew Neck'
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
