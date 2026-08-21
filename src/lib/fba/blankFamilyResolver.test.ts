import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_BLANK_SPECS, rowToSpec, extractStyleCode, intersectBlankSpecs, resolveFamilyBlank,
  resolveBlankRowForNet, resolveFamilyBlankForNet, composerGarmentFamily, type BlankSpecRow,
} from './blankSpecs'

/* SKU-FIRST BLANK RESOLUTION (PO ruling 2026-08-21, SELLER_PROFILE.md "Blank identity is stated in
 * the CHILD SKU"): the blank is the STYLE CODE in the child SKU; families with no code get a PO
 * override; mixed-blank families claim only the INTERSECTION of facts. These tests pin the pure core
 * (extractStyleCode / intersectBlankSpecs / resolveFamilyBlank) against the migration-058 rows and
 * the ONE async seam (resolveBlankRowForNet) against a fake listing_content read. */

// The catalog as PostgREST returns it after migration 058 (single-backslash patterns), in id order.
const DB_ROWS = [
  { match_pattern: '\\bcomfort\\s*colors?\\b', brand: 'Comfort Colors', brand_in_copy: true, fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck', weight_note: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed', stretch: 'Low Stretch', fit_to_size: 'Runs Slightly Small', style_code: '1717', garment_family: 'tee' },
  { match_pattern: '\\bgildan\\b|\\b64000', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weight_note: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton', style_code: '64000', garment_family: 'tee' },
  { match_pattern: '\\b6014', brand: 'Comfort Colors', brand_in_copy: true, fit: 'Relaxed', sleeve: 'Long Sleeve', neck: 'Crew Neck', weight_note: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed', stretch: 'Low Stretch', fit_to_size: 'Runs Slightly Small', style_code: '6014', garment_family: 'long_sleeve_tee' },
  { match_pattern: 'g?64400', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weight_note: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton', style_code: '64400', garment_family: 'long_sleeve_tee' },
  { match_pattern: '\\b1800(?:0)?(?=\\D|$)|\\b18000', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weight_note: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester', style_code: '18000', garment_family: 'sweatshirt' },
  { match_pattern: '\\b18500', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Hooded', weight_note: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester', style_code: '18500', garment_family: 'hoodie' },
  { match_pattern: '\\bbc3001|\\b3001(?=\\D|$)', brand: 'Bella+Canvas', brand_in_copy: false, fit: 'Retail', sleeve: 'Short Sleeve', neck: 'Crew Neck', weight_note: 'lightweight 4.2 oz combed ring-spun', material: '100% Airlume Combed Ring-Spun Cotton', style_code: '3001', garment_family: 'tee' },
  { match_pattern: '\\b64000b', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weight_note: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton', style_code: '64000B', garment_family: 'kids_tee' },
]
const OVERRIDES = [
  { parent_asin: 'B0FC8R484P', style_code: '64000' },
  { parent_asin: 'B0FKFHSCS9', style_code: '1717' },
  { parent_asin: 'B0DP5H8QBT', style_code: '64000B' },
]

// The module's own (service-role) client serves the catalog + overrides; listing_content comes from
// the caller-supplied `db`. Resolves immediately (the sibling test file pins the HANG fail-open).
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ order: () => Promise.resolve(table === 'blank_specs' ? { data: DB_ROWS, error: null } : { data: [], error: null }) }),
        limit: () => Promise.resolve(table === 'blank_family_overrides' ? { data: OVERRIDES, error: null } : { data: [], error: null }),
      }),
    }),
  }),
}))

const ROWS = DB_ROWS.map((r) => rowToSpec(r)).filter((r): r is BlankSpecRow => !!r)
const CODES = ROWS.map((r) => r.styleCode!).filter(Boolean)
const byCode = (code: string): BlankSpecRow => ROWS.find((r) => r.styleCode === code)!
const skus = (prefix: string, n: number, sizes = ['S', 'M', 'L', 'XL', '2XL']): { sku: string }[] =>
  Array.from({ length: n }, (_, i) => ({ sku: `${prefix}${sizes[i % sizes.length]}-C${i}` }))

describe('rowToSpec — reads style_code / garment_family fail-open', () => {
  it('carries both new columns onto the row (spec object untouched)', () => {
    const r = rowToSpec(DB_ROWS[4])!
    expect(r.styleCode).toBe('18000')
    expect(r.garmentFamily).toBe('sweatshirt')
    expect('styleCode' in r.spec).toBe(false)
  })
  it('missing columns (pre-058 DB) → undefined, legacy behaviour', () => {
    const r = rowToSpec({ match_pattern: '\\bx\\b', brand: 'X' })!
    expect(r.styleCode).toBeUndefined()
    expect(r.garmentFamily).toBeUndefined()
  })
  it('an unknown garment_family value is dropped, never propagated', () => {
    expect(rowToSpec({ match_pattern: 'a', garment_family: 'onesie' })!.garmentFamily).toBeUndefined()
  })
  it('the in-code seeds carry the 058 style codes (fail-open floor stays SKU-resolvable)', () => {
    expect(DEFAULT_BLANK_SPECS.map((r) => [r.styleCode, r.garmentFamily])).toEqual([['1717', 'tee'], ['64000', 'tee']])
  })
})

describe('extractStyleCode — the child SKU leading token states the blank', () => {
  it.each([
    ['640002XL', '64000'],
    ['ADWF64000', '64000'],
    ['ADWF64000-BLK-L', '64000'],
    ['64000BLK-M', '64000'],          // B + letters = a colour, NOT the youth code
    ['G644002XL', '64400'],
    ['G64400L', '64400'],
    ['BCSG18002X', '18000'],          // 1800 + glued size "2X" — the PO's "1800x"
    ['EDG1800L', '18000'],
    ['XYZ18000', '18000'],
    ['HDG18500M', '18500'],
    ['BC3001XL', '3001'],
    ['17172XL', '1717'],
    ['1717M-WHT', '1717'],
    ['60142XL', '6014'],
    ['64000BYM', '64000B'],           // youth code + youth size → the kids row
    ['64000B2XL', '64000B'],
    ['64000B', '64000B'],
  ])('%s → %s', (sku, code) => {
    expect(extractStyleCode(sku, CODES)).toBe(code)
  })

  it.each([
    'MAHATS-2XL-BK', '1V-C6WM-US5T', 'AJK-FUNNY-L', '', 'THECEO-BLK-M',
    '18501X',        // 1850 is not an elision of 18500 (only a trailing ZERO may be elided)
    '17170',         // extra digit after a digit-ending code is not a size token
  ])('%s → null', (sku) => {
    expect(extractStyleCode(sku, CODES)).toBeNull()
  })

  it('longest code wins regardless of the order the catalog supplies', () => {
    expect(extractStyleCode('64000BYS', ['64000', '64000B'])).toBe('64000B')
    expect(extractStyleCode('64000BYS', ['64000B', '64000'])).toBe('64000B')
    expect(extractStyleCode('HDG18500M', ['18000', '18500'])).toBe('18500')
  })

  it('is case-insensitive and tolerates an empty code list', () => {
    expect(extractStyleCode('bc3001xl', CODES)).toBe('3001')
    expect(extractStyleCode('BC3001XL', [])).toBeNull()
  })

  it('a PO-typed code with the SELLER_PROFILE letter prefix (G64400, BC3001) still matches and is returned verbatim', () => {
    expect(extractStyleCode('G644002XL', ['G64400', '64000'])).toBe('G64400')
    expect(extractStyleCode('BC3001XL', ['BC3001'])).toBe('BC3001')
    expect(extractStyleCode('3001XL', ['BC3001'])).toBe('BC3001')
  })
})

describe('intersectBlankSpecs — a fact ships only when EVERY resolved blank agrees', () => {
  it('single spec is returned verbatim', () => {
    expect(intersectBlankSpecs([byCode('1717').spec])).toEqual(byCode('1717').spec)
  })
  it('64000 + 3001: brand/fit/material/weight dropped, Short Sleeve + Crew Neck kept, brandInCopy false', () => {
    const s = intersectBlankSpecs([byCode('64000').spec, byCode('3001').spec])!
    expect(s).toEqual({ brandInCopy: false, sleeve: 'Short Sleeve', neck: 'Crew Neck' })
  })
  it('64000 + 64400: sleeve dropped, everything else (same blank family) kept', () => {
    const s = intersectBlankSpecs([byCode('64000').spec, byCode('64400').spec])!
    expect(s.sleeve).toBeUndefined()
    expect(s).toMatchObject({ brand: 'Gildan', brandInCopy: false, fit: 'Classic', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton' })
  })
  it('brandInCopy=false wins if ANY blank forbids the brand; a fact one blank omits is dropped', () => {
    const s = intersectBlankSpecs([byCode('1717').spec, byCode('6014').spec])!
    expect('brandInCopy' in s).toBe(false) // both CC rows allow it → absent (never materialized true)
    expect(s.dye).toBe('Garment-Dyed')
    const mixed = intersectBlankSpecs([byCode('1717').spec, byCode('64000').spec])!
    expect(mixed.brandInCopy).toBe(false)
    expect(mixed.dye).toBeUndefined()
  })
  it('empty input → null', () => {
    expect(intersectBlankSpecs([])).toBeNull()
  })
})

describe('resolveFamilyBlank — per-child style codes → override → legacy regex → null', () => {
  it('85×64000 + 41×BC3001 → mixed; dominant 64000; intersection keeps Short Sleeve / Crew Neck only', () => {
    const r = resolveFamilyBlank(ROWS, [...skus('64000', 85), ...skus('BC3001', 41)], null, 'THE CEO Funny Shirt SHIRT')
    expect(r.source).toBe('sku')
    expect(r.mixed).toBe(true)
    expect(r.byStyle).toEqual({ '64000': 85, '3001': 41 })
    expect(r.dominant?.styleCode).toBe('64000')
    expect(r.spec).toEqual({ brandInCopy: false, sleeve: 'Short Sleeve', neck: 'Crew Neck' })
    expect(r.garmentFamily).toBe('tee')
  })

  it('64000 + G64400 long-sleeve subset → sleeve dropped, Gildan facts kept', () => {
    const r = resolveFamilyBlank(ROWS, [...skus('ADWF64000', 30), ...skus('G64400', 10)], null, 'THE CEO Cat Shirt')
    expect(r.mixed).toBe(true)
    expect(r.spec?.sleeve).toBeUndefined()
    expect(r.spec?.brand).toBe('Gildan')
    expect(r.dominant?.styleCode).toBe('64000')
  })

  it('a sweatshirt family resolves 18000 even though no brand word appears anywhere and a tee row is first by id', () => {
    const r = resolveFamilyBlank(ROWS, [...skus('BCSG1800', 20, ['S', 'M', 'L', 'XL', '2X']), ...skus('HDG18500', 8)], null, 'THE CEO Christmas Sweatshirt SWEATSHIRT')
    expect(r.source).toBe('sku')
    expect(r.dominant?.styleCode).toBe('18000')
    expect(r.garmentFamily).toBe('sweatshirt')
    expect(r.mixed).toBe(true)
    expect(r.spec?.neck).toBeUndefined()         // Crew Neck vs Hooded — never claimed
    expect(r.spec?.sleeve).toBe('Long Sleeve')
    expect(r.spec?.material).toBe('50% Cotton / 50% Polyester')
    expect(r.spec?.brandInCopy).toBe(false)
  })

  it('a sweatshirt family whose hay also says "Comfort Colors" still resolves by SKU, not by the first regex row', () => {
    const r = resolveFamilyBlank(ROWS, skus('EDG1800', 12), null, 'Comfort Colors style Sweatshirt')
    expect(r.dominant?.styleCode).toBe('18000')
    expect(r.spec?.brand).toBe('Gildan')
  })

  it('override path: MAHATS SKUs carry no code → the 64000 row; AJK → 1717', () => {
    const m = resolveFamilyBlank(ROWS, skus('MAHATS-', 8), '64000', 'THE CEO Mama Shirt')
    expect(m.source).toBe('override')
    expect(m.dominant?.styleCode).toBe('64000')
    expect(m.mixed).toBe(false)
    expect(m.spec).toEqual(byCode('64000').spec)
    const a = resolveFamilyBlank(ROWS, skus('AJK-', 5), '1717', 'THE CEO Funny Shirt')
    expect(a.dominant?.styleCode).toBe('1717')
    expect(a.spec?.brand).toBe('Comfort Colors')
  })

  it('override path (PO 2026-08-21): opaque-SKU kids family + 64000B override → kids_tee row, composer family "tee"', () => {
    const r = resolveFamilyBlank(ROWS, [{ sku: '1V-C6WM-US5T' }, { sku: '2W-D7XN-VT6U' }], '64000B', 'THE CEO Kids Dinosaur Shirt')
    expect(r.source).toBe('override')
    expect(r.dominant?.styleCode).toBe('64000B')
    expect(r.garmentFamily).toBe('kids_tee')
    expect(composerGarmentFamily(r.garmentFamily)).toBe('tee')
    expect(r.spec?.brandInCopy).toBe(false)
  })

  it('an override naming an unknown style code is ignored (falls through to legacy/null, never throws)', () => {
    const r = resolveFamilyBlank(ROWS, skus('MAHATS-', 3), '99999', 'THE CEO Plain Shirt')
    expect(r.dominant).toBeNull()
    expect(r.source).toBeNull()
  })

  it('SKU codes beat the override when both exist (the SKU is the statement)', () => {
    const r = resolveFamilyBlank(ROWS, skus('17172', 4, ['XL']), '64000', 'THE CEO Shirt')
    expect(r.source).toBe('sku')
    expect(r.dominant?.styleCode).toBe('1717')
  })

  it('legacy regex fallback still resolves a "Comfort Colors"-titled family with no style codes', () => {
    const r = resolveFamilyBlank(ROWS, skus('THECEO-', 6), null, 'THE CEO Gator Tee | Comfort Colors Shirt SHIRT')
    expect(r.source).toBe('legacy')
    expect(r.dominant?.styleCode).toBe('1717')
    expect(r.spec).toEqual(byCode('1717').spec)
  })

  it('legacy fallback keeps the old gate: a hay with no garment word resolves nothing', () => {
    const r = resolveFamilyBlank(ROWS, skus('THECEO-', 2), null, 'Comfort Colors Coffee Mug')
    expect(r.dominant).toBeNull()
  })

  it('garment conflict → null with a warn: "Sweatshirt" hay but every SKU is a 64000 tee', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = resolveFamilyBlank(ROWS, skus('640002', 5, ['XL']), null, 'THE CEO Holiday Sweatshirt')
    expect(r.dominant).toBeNull()
    expect(r.spec).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('BLANK_GARMENT_CONFLICT'))
    warn.mockRestore()
  })

  it('garment conflict the other way: "Shirt" hay never inherits an 18500 hoodie row (legacy regex or SKU)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveFamilyBlank(ROWS, skus('HDG18500', 4), null, 'THE CEO Funny T-Shirt').dominant).toBeNull()
    expect(resolveFamilyBlank(ROWS, skus('THECEO-', 2), null, 'THE CEO Funny T-Shirt 18500').dominant).toBeNull()
    warn.mockRestore()
  })

  it('pre-058 rows (no garment_family) are treated as tees: the old looksShirt semantics hold on the seeds', () => {
    const legacySeeds = DEFAULT_BLANK_SPECS.map((r) => ({ match: r.match, spec: r.spec }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveFamilyBlank(legacySeeds, [], null, 'Comfort Colors Sweatshirt').dominant).toBeNull()
    expect(resolveFamilyBlank(legacySeeds, [], null, 'Comfort Colors Shirt').dominant?.spec.brand).toBe('Comfort Colors')
    warn.mockRestore()
  })

  it('no children, no override, no hay → null without throwing', () => {
    const r = resolveFamilyBlank(ROWS, [], undefined, '')
    expect(r).toEqual({ dominant: null, byStyle: {}, mixed: false, spec: null, garmentFamily: null, source: null })
  })
})

describe('composerGarmentFamily — the 5-way DB enum folds to the composer vocabulary', () => {
  it.each([
    ['tee', 'tee'], ['long_sleeve_tee', 'tee'], ['kids_tee', 'tee'], ['sweatshirt', 'sweatshirt'], ['hoodie', 'hoodie'],
  ] as const)('%s → %s', (gf, out) => {
    expect(composerGarmentFamily(gf)).toBe(out)
  })
  it('unknown / absent → null (caller keeps its title-regex guess)', () => {
    expect(composerGarmentFamily(undefined)).toBeNull()
    expect(composerGarmentFamily(null)).toBeNull()
  })
})

describe('resolveBlankRowForNet — the ONE async seam, per-child SKUs from listing_content', () => {
  const fakeDb = (rows: { sku: string; product_type?: string; title?: string }[]) => ({
    from: () => ({ select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: rows, error: null }) }) }) }),
  })

  it('mixed 64000 + BC3001 family: returns the dominant row shaped as before, spec = intersection, no brand claim', async () => {
    const row = await resolveBlankRowForNet(
      fakeDb([...skus('64000', 6).map((s) => ({ ...s, product_type: 'SHIRT', title: 'THE CEO Funny Shirt' })), ...skus('BC3001', 3)]),
      { parentAsin: 'B0GR1K3TXF', titles: ['THE CEO Funny Shirt'] },
    )
    expect(row).not.toBeNull()
    expect(row!.match.source).toBe(byCode('64000').match.source)
    expect(row!.styleCode).toBe('64000')
    expect(row!.spec).toEqual({ brandInCopy: false, sleeve: 'Short Sleeve', neck: 'Crew Neck' })
    expect(row!.garmentFamily).toBe('tee')
  })

  it('sweatshirt family resolves the 18000 row (the old looksShirt gate nulled every sweatshirt)', async () => {
    const row = await resolveBlankRowForNet(
      fakeDb(skus('BCSG1800', 5, ['S', 'M', 'L', 'XL', '2X']).map((s) => ({ ...s, product_type: 'SWEATSHIRT', title: 'THE CEO Merry Sweatshirt' }))),
      { parentAsin: 'B0DSCDZC6K', titles: ['THE CEO Merry Sweatshirt'] },
    )
    expect(row?.styleCode).toBe('18000')
    expect(row?.garmentFamily).toBe('sweatshirt')
    expect(row?.spec.weightNote).toBe('heavyweight 8.0 oz fleece')
  })

  it('override path via the DB table: MAHATS family → 64000; the rich result exposes source/byStyle', async () => {
    const rich = await resolveFamilyBlankForNet(
      fakeDb(skus('MAHATS-', 4).map((s) => ({ ...s, product_type: 'SHIRT', title: 'THE CEO Mama Shirt' }))),
      { parentAsin: 'B0FC8R484P', titles: ['THE CEO Mama Shirt'] },
    )
    expect(rich.source).toBe('override')
    expect(rich.dominant?.styleCode).toBe('64000')
    expect(rich.byStyle).toEqual({})
  })

  it('opaque-SKU kids family (B0DP5H8QBT) → 64000B via override', async () => {
    const row = await resolveBlankRowForNet(
      fakeDb([{ sku: '1V-C6WM-US5T', product_type: 'SHIRT', title: 'THE CEO Kids Shirt' }]),
      { parentAsin: 'B0DP5H8QBT', titles: ['THE CEO Kids Shirt'] },
    )
    expect(row?.styleCode).toBe('64000B')
    expect(row?.garmentFamily).toBe('kids_tee')
  })

  it('a throwing db → null (the net no-ops, never throws)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = await resolveBlankRowForNet({ from: () => { throw new Error('boom') } }, { parentAsin: 'X', titles: [] })
    expect(row).toBeNull()
    warn.mockRestore()
  })
})
