import { describe, it, expect } from 'vitest'
import {
  parentVariationsUrl,
  skuEditUrl,
  inventorySearchUrl,
  resolveParentSellerCentralTarget,
} from './sellerCentralUrls'

/* PO 2026-08-21 (B0DQ5YZH38): "The product LINK to open in Amazon doesn't work on this pop up".
 * The modal built its url inline and fell back to the ASIN-only `abis/listing/edit?asin=…` stub
 * whenever the heal-task payload was empty — which is every listing without an active heal task.
 * These tests pin the exact shapes AND the never-ASIN-only rule so the stub can't come back. */

const PARENT = 'B0DQ5YZH38'
const PARENT_SKU = '5D-IKV4-UUPH'

describe('inventorySearchUrl — the ONLY allowed no-SKU fallback', () => {
  it('is the inventory search for the ASIN', () => {
    expect(inventorySearchUrl(PARENT)).toBe('https://sellercentral.amazon.com/inventory?searchTerm=B0DQ5YZH38')
  })

  it('encodes anything unusual in the search term', () => {
    expect(inventorySearchUrl('A B&C')).toBe('https://sellercentral.amazon.com/inventory?searchTerm=A%20B%26C')
  })
})

describe('parentVariationsUrl — the PO-verified variations deep link', () => {
  it('emits the exact PO-verified shape when sku + productType are known', () => {
    expect(parentVariationsUrl({ sku: PARENT_SKU, asin: PARENT, productType: 'SHIRT' })).toBe(
      'https://sellercentral.amazon.com/abis/listing/edit/variations?sku=5D-IKV4-UUPH&asin=B0DQ5YZH38&productType=SHIRT&marketplaceID=ATVPDKIKX0DER&isVariationParent=true&ref_=myp_1x1#variations',
    )
  })

  it('omits productType (not the whole link) when Amazon answered nothing — the SKU is what identifies the listing', () => {
    expect(parentVariationsUrl({ sku: PARENT_SKU, asin: PARENT, productType: null })).toBe(
      'https://sellercentral.amazon.com/abis/listing/edit/variations?sku=5D-IKV4-UUPH&asin=B0DQ5YZH38&marketplaceID=ATVPDKIKX0DER&isVariationParent=true&ref_=myp_1x1#variations',
    )
  })

  it('falls back to inventory search when the SKU is unknown/blank — NEVER the ASIN-only stub', () => {
    expect(parentVariationsUrl({ sku: undefined, asin: PARENT, productType: 'SHIRT' }))
      .toBe(inventorySearchUrl(PARENT))
    expect(parentVariationsUrl({ sku: '   ', asin: PARENT })).toBe(inventorySearchUrl(PARENT))
  })

  it('url-encodes SKUs and productTypes that carry unsafe characters', () => {
    const url = parentVariationsUrl({ sku: 'A B/C&D', asin: PARENT, productType: 'SHIRT TYPE' })
    expect(url).toContain('sku=A%20B%2FC%26D')
    expect(url).toContain('productType=SHIRT%20TYPE')
  })
})

describe('skuEditUrl — single non-parent SKU', () => {
  it('emits the ABIS editor for that SKU', () => {
    expect(skuEditUrl({ sku: 'TEE-BLK-L-FBA', asin: 'B0CHILD001', productType: 'SHIRT' })).toBe(
      'https://sellercentral.amazon.com/abis/listing/edit?sku=TEE-BLK-L-FBA&asin=B0CHILD001&productType=SHIRT&marketplaceID=ATVPDKIKX0DER&ref_=myp_1x1',
    )
  })

  it('omits productType when unknown', () => {
    expect(skuEditUrl({ sku: 'TEE-BLK-L-FBA', asin: 'B0CHILD001' })).toBe(
      'https://sellercentral.amazon.com/abis/listing/edit?sku=TEE-BLK-L-FBA&asin=B0CHILD001&marketplaceID=ATVPDKIKX0DER&ref_=myp_1x1',
    )
  })

  it('falls back to inventory search with no SKU', () => {
    expect(skuEditUrl({ sku: null, asin: 'B0CHILD001' })).toBe(inventorySearchUrl('B0CHILD001'))
  })
})

describe('THE RULE: the ASIN-only stub shape is never emitted by any builder', () => {
  const cases = [
    { sku: PARENT_SKU, asin: PARENT, productType: 'SHIRT' },
    { sku: PARENT_SKU, asin: PARENT, productType: null },
    { sku: null, asin: PARENT, productType: 'SHIRT' },
    { sku: '', asin: PARENT, productType: '' },
    { sku: undefined, asin: PARENT },
  ]
  it('no builder ever produces `abis/listing/edit?asin=`', () => {
    for (const c of cases) {
      for (const url of [parentVariationsUrl(c), skuEditUrl(c)]) {
        expect(url).not.toContain('abis/listing/edit?asin=')
        expect(url).not.toContain('ref_=xx_addlisting_dnav_xx')
      }
    }
  })

  it('every no-SKU outcome is the inventory search, which always resolves', () => {
    for (const c of cases.filter((x) => !x.sku)) {
      expect(parentVariationsUrl(c)).toBe(inventorySearchUrl(PARENT))
      expect(skuEditUrl(c)).toBe(inventorySearchUrl(PARENT))
    }
  })
})

describe('resolveParentSellerCentralTarget — fallback order heal → family-skus → none', () => {
  it('prefers the heal:composite payload (Amazon itself named that SKU)', () => {
    const t = resolveParentSellerCentralTarget({
      parentAsin: PARENT,
      healParentSku: 'HEAL-SKU',
      healProductType: 'SHIRT',
      familyParentSku: PARENT_SKU,
      familyProductType: 'PRODUCT_X',
    })
    expect(t).toEqual({ sku: 'HEAL-SKU', asin: PARENT, productType: 'SHIRT', source: 'heal' })
  })

  it('THE B0DQ5YZH38 CASE: zero heal tasks → family-skus answers, link still works', () => {
    const t = resolveParentSellerCentralTarget({
      parentAsin: PARENT,
      healParentSku: undefined,
      healProductType: undefined,
      familyParentSku: PARENT_SKU,
      familyProductType: 'SHIRT',
    })
    expect(t).toEqual({ sku: PARENT_SKU, asin: PARENT, productType: 'SHIRT', source: 'family' })
    expect(parentVariationsUrl(t)).toBe(
      'https://sellercentral.amazon.com/abis/listing/edit/variations?sku=5D-IKV4-UUPH&asin=B0DQ5YZH38&productType=SHIRT&marketplaceID=ATVPDKIKX0DER&isVariationParent=true&ref_=myp_1x1#variations',
    )
  })

  it('takes the fields INDEPENDENTLY: heal sku + family productType', () => {
    const t = resolveParentSellerCentralTarget({
      parentAsin: PARENT,
      healParentSku: 'HEAL-SKU',
      healProductType: null,
      familyParentSku: PARENT_SKU,
      familyProductType: 'SHIRT',
    })
    expect(t.sku).toBe('HEAL-SKU')
    expect(t.productType).toBe('SHIRT')
    expect(t.source).toBe('heal')
  })

  it('resolves nothing when neither source answers — and the builder then hands over the inventory search', () => {
    const t = resolveParentSellerCentralTarget({ parentAsin: PARENT })
    expect(t).toEqual({ sku: null, asin: PARENT, productType: null, source: 'none' })
    expect(parentVariationsUrl(t)).toBe(inventorySearchUrl(PARENT))
  })

  it('treats blank/whitespace payload values as absent (the dead-wire shape)', () => {
    const t = resolveParentSellerCentralTarget({
      parentAsin: PARENT,
      healParentSku: '   ',
      healProductType: '',
      familyParentSku: PARENT_SKU,
      familyProductType: '  SHIRT  ',
    })
    expect(t.sku).toBe(PARENT_SKU)
    expect(t.productType).toBe('SHIRT')
    expect(t.source).toBe('family')
  })
})
