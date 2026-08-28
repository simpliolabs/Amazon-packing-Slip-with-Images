import { describe, it, expect } from 'vitest'
import { resolveChildColor } from './childColorResolver'

// Live specimen: family B0DP5H8QBT (12 children, Amazon-generated opaque SKUs). No segment of
// any of these SKUs is a colour code and none ever will be — decodeSkuColor returns null for all
// four today. This is the reproducing test: it must FAIL before the resolver exists / before a
// catalog colour is wired in as the first-class source.
const OPAQUE_SKUS = ['1V-C6WM-US5T', '3A-MINF-4TRD', '4K-WJVI-T618', '5M-0T69-IFXD']

describe('resolveChildColor — reproducing the B0DP5H8QBT collapse', () => {
  it('opaque Amazon-generated SKUs with NO stored colour all resolve null, source "none"', () => {
    for (const sku of OPAQUE_SKUS) {
      const result = resolveChildColor({ asin: `ASIN-${sku}`, sku, title: null, storedColor: null })
      expect(result.color).toBeNull()
      expect(result.source).toBe('none')
    }
  })

  it('the SAME opaque SKUs, once a catalog colour is stored, resolve each to its OWN distinct colour', () => {
    const stored: Record<string, string> = {
      '1V-C6WM-US5T': 'Black',
      '3A-MINF-4TRD': 'Navy',
      '4K-WJVI-T618': 'Heather Grey',
      '5M-0T69-IFXD': 'Maroon',
    }
    const resolved = OPAQUE_SKUS.map((sku) =>
      resolveChildColor({ asin: `ASIN-${sku}`, sku, title: null, storedColor: stored[sku] }).color,
    )
    expect(resolved).toEqual(['Black', 'Navy', 'Heather Grey', 'Maroon'])
    expect(new Set(resolved).size).toBe(4) // four DISTINCT colours, not a collapse
  })
})

describe('resolveChildColor — no regression on decodable SKUs', () => {
  it('a SKU the existing decoder reads correctly resolves IDENTICALLY when no catalog colour is stored', () => {
    // 'BK' is a real entry in SKU_COLOR_CODES (skuColorCodes.ts) -> 'Black'; decodeSkuColor reads
    // it from the last '-'-separated segment with no ambiguity.
    const sku = 'AQS-TMB-BK'
    const withoutCatalog = resolveChildColor({ asin: 'A1', sku, title: null, storedColor: null })
    const withUndefinedCatalog = resolveChildColor({ asin: 'A1', sku, title: null }) // storedColor omitted entirely
    expect(withoutCatalog.color).toBe('Black')
    expect(withoutCatalog.source).toBe('sku')
    // Byte-identical across both "nothing stored" shapes (null vs omitted).
    expect(withUndefinedCatalog).toEqual(withoutCatalog)
  })

  it('an empty-string stored colour is treated as "not fetched", not a real colour — falls through to the decoder', () => {
    const result = resolveChildColor({ asin: 'A1', sku: 'AQS-TMB-BK', title: null, storedColor: '' })
    expect(result.color).toBe('Black')
    expect(result.source).toBe('sku')
  })
})

describe('resolveChildColor — precedence: catalog WINS over a decodable SKU segment', () => {
  it('a stored catalog colour is used VERBATIM even when the SKU segment also decodes to a (different) colour', () => {
    // 'BK' would decode to 'Black' via decodeSkuColor — the catalog says otherwise (a real live
    // case: the SKU code and Amazon's own recorded colour can legitimately disagree, e.g. a
    // reused blank code). The stored value must win, verbatim, not be reconciled/renamed.
    const result = resolveChildColor({ asin: 'A1', sku: 'AQS-TMB-BK', title: null, storedColor: 'Jet Black Heather' })
    expect(result.color).toBe('Jet Black Heather')
    expect(result.source).toBe('catalog')
  })

  it('a stored colour with incidental whitespace is trimmed but otherwise passed through verbatim', () => {
    const result = resolveChildColor({ asin: 'A1', sku: 'AQS-TMB-BK', title: null, storedColor: '  Navy  ' })
    expect(result.color).toBe('Navy')
    expect(result.source).toBe('catalog')
  })
})

describe('resolveChildColor — source field proves the branch that ran', () => {
  it('reports source "none" only when BOTH the catalog value and the decoder are absent', () => {
    const result = resolveChildColor({ asin: 'A1', sku: '1V-C6WM-US5T', title: 'Some Design - Novelty Tee', storedColor: undefined })
    expect(result.source).toBe('none')
    expect(result.color).toBeNull()
  })

  it('reports source "sku" when the title-tail fallback is what actually resolved it (no code-table hit)', () => {
    // No SKU segment decodes; the title's trailing "- Color - Size" tail is decodeSkuColor's LAST
    // fallback (skuColorCodes.ts). Prove the SKU branch specifically fired, not just "some string".
    const result = resolveChildColor({
      asin: 'A1',
      sku: '1V-C6WM-US5T',
      title: 'Retro Sunset Graphic Tee - Forest Mist - Large',
      storedColor: null,
    })
    expect(result.source).toBe('sku')
    expect(result.color).toBe('Forest Mist')
  })
})
