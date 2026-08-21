/**
 * FAMILY ROSTER tests — INVARIANT 2: one resolver. The family-skus route and the variant-death
 * alarm both call resolveFamilyRoster; these pin the merge rule the route used inline before
 * (DB seed + twin-name-guarded discovered twins + base_name/FBA-first sort) and the 113-SKU
 * Later Gator shape (56 ASINs x FBA+FBM = 112 children + the parent hub the route appends).
 */
import { describe, it, expect } from 'vitest'
import { resolveFamilyRoster, stripFulfillmentSuffix, fulfillmentOf, isSystemSku, type FamilySkuRef } from './familyRoster'

describe('resolveFamilyRoster — the 113-SKU family', () => {
  const sizes = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']
  const colors = ['ORC', 'BLK', 'WHT', 'NVY', 'GRY', 'RED', 'BLU', 'GRN']
  const asins: { asin: string; base: string }[] = []
  let n = 0
  for (const c of colors) for (const s of sizes) asins.push({ asin: `B0FAM${String(n++).padStart(5, '0')}`, base: `6014${s}-${c}-Later-Gator-LS-TS` })
  // listing_content: FBA row for every ASIN, FBM twin row for only the first 14 (historical dedup).
  const cached: FamilySkuRef[] = asins.flatMap(({ asin, base }, i) =>
    i < 14 ? [{ sku: `${base}-FBA`, asin }, { sku: base, asin }] : [{ sku: `${base}-FBA`, asin }])
  // discovery (live or persisted): both twins under every ASIN.
  const discovered: FamilySkuRef[] = asins.flatMap(({ asin, base }) => [{ sku: `${base}-FBA`, asin }, { sku: base, asin }])

  it('returns the union of DB rows and their FBA/FBM twins: 112 children for 56 ASINs', () => {
    expect(cached).toHaveLength(70)
    const roster = resolveFamilyRoster(cached, discovered)
    expect(roster).toHaveLength(112)
    expect(roster.filter((r) => r.origin === 'cached')).toHaveLength(70)
    expect(roster.filter((r) => r.origin === 'discovered')).toHaveLength(42)
    // every ASIN has exactly its two twins
    const perAsin = new Map<string, string[]>()
    for (const r of roster) perAsin.set(r.asin, [...(perAsin.get(r.asin) ?? []), r.sku])
    expect(perAsin.size).toBe(56)
    for (const [, skus] of perAsin) expect(skus).toHaveLength(2)
  })

  it('sorts by base_name then FBA before FBM (the route order the UI relies on)', () => {
    const roster = resolveFamilyRoster(cached, discovered)
    for (let i = 1; i < roster.length; i++) {
      const a = roster[i - 1], b = roster[i]
      const cmp = a.base_name.localeCompare(b.base_name)
      expect(cmp <= 0).toBe(true)
      if (cmp === 0) expect(a.fulfillment).toBe('FBA')
    }
    expect(roster[0]).toMatchObject({ sku: '60142XL-BLK-Later-Gator-LS-TS-FBA', fulfillment: 'FBA', base_name: '60142XL-BLK-Later-Gator-LS-TS' })
    expect(roster[1]).toMatchObject({ sku: '60142XL-BLK-Later-Gator-LS-TS', fulfillment: 'FBM' })
  })

  it('is idempotent and tolerant of a discovery superset / duplicates', () => {
    const once = resolveFamilyRoster(cached, discovered)
    const twice = resolveFamilyRoster(cached, [...discovered, ...discovered, ...cached])
    expect(twice).toEqual(once)
  })
})

describe('resolveFamilyRoster — guards', () => {
  const cached: FamilySkuRef[] = [{ sku: 'DAFEI-482-32G-FBA', asin: 'B0SD32' }, { sku: 'amzn.gr.SYSTEM', asin: 'B0SD32' }]

  it('twin-name guard: a discovered SKU must match a cached SKU base name under the SAME ASIN', () => {
    const roster = resolveFamilyRoster(cached, [
      { sku: 'DAFEI-482-32G', asin: 'B0SD32' },      // real FBM twin → in
      { sku: 'DAFEI-482-128GB', asin: 'B0SD32' },    // stale mapping under the 32G ASIN → out (PR #63 bug)
      { sku: 'DAFEI-482-32G', asin: 'B0OTHER' },     // right name, wrong ASIN → out
    ])
    expect(roster.map((r) => r.sku)).toEqual(['DAFEI-482-32G-FBA', 'DAFEI-482-32G'])
  })

  it('Amazon-managed system SKUs never enter — cached or discovered', () => {
    const roster = resolveFamilyRoster(cached, [{ sku: 'amzn.gr.OTHER', asin: 'B0SD32' }])
    expect(roster.map((r) => r.sku)).toEqual(['DAFEI-482-32G-FBA'])
  })

  it('no discovery ⇒ the cached rows alone (the fail-open floor)', () => {
    expect(resolveFamilyRoster(cached, []).map((r) => r.sku)).toEqual(['DAFEI-482-32G-FBA'])
    expect(resolveFamilyRoster([], [{ sku: 'X', asin: 'B0X' }])).toEqual([]) // nothing to anchor a twin to
  })
})

describe('SKU helpers (byte-identical to the route\'s former inline versions)', () => {
  it('stripFulfillmentSuffix', () => {
    expect(stripFulfillmentSuffix('DAFEI-482-32G-FBA')).toBe('DAFEI-482-32G')
    expect(stripFulfillmentSuffix('DAFEI-482-32G')).toBe('DAFEI-482-32G')
    expect(stripFulfillmentSuffix('X_MFN')).toBe('X')
    expect(stripFulfillmentSuffix('6014XL-ORC-Later-Gator-LS-TS')).toBe('6014XL-ORC-Later-Gator-LS-TS')
  })
  it('fulfillmentOf', () => {
    expect(fulfillmentOf('A-FBA')).toBe('FBA')
    expect(fulfillmentOf('A-FBM')).toBe('FBM')
    expect(fulfillmentOf('A_MFN')).toBe('FBM')
    expect(fulfillmentOf('6014XL-ORC-Later-Gator-LS-TS')).toBe('FBM')
    expect(fulfillmentOf('PLAIN')).toBe('unknown')
  })
  it('isSystemSku', () => {
    expect(isSystemSku('amzn.gr.ABC')).toBe(true)
    expect(isSystemSku('AMZN.x')).toBe(true)
    expect(isSystemSku('my-amzn.sku')).toBe(false)
  })
})
