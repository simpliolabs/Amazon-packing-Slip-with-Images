import { describe, it, expect } from 'vitest'
import {
  validateBlankSpecInput, findDuplicateActiveStyleCode, styleCodeExists,
  toCatalogRows, groupFamilies, computeUsageCounts, computeBlankImpact, resolveFamily, buildAssignmentMaps,
  type DbBlankRow, type AssignmentRow,
} from './blankAssignmentImpact'

/* This suite covers the route-validation contract for POST/PATCH /api/fba/blanks, PUT
 * /api/fba/blank-assignment, and the blast-radius preview for POST /api/fba/blanks/impact — the
 * three pieces the task calls out explicitly: bad garment_family rejected, duplicate active
 * style_code rejected, invalid regex rejected WITH its message, unknown style_code assignment
 * rejected, and the impact calculation against fixture SKUs (17172XL-… → 1717;
 * BB64000XL-BK-FBA → 64000 unless a child assignment says 6014). */

// ─── Fixture catalog: mirrors the real 1717 / 6014 / 64000 rows (migrations 053/058) ───────────
const FIXTURE_ROWS: DbBlankRow[] = [
  { id: 1, match_pattern: '\\bcomfort\\s*colors?\\b', brand: 'Comfort Colors', brand_in_copy: true, style_code: '1717', garment_family: 'tee', active: true },
  { id: 2, match_pattern: '\\bgildan\\b|\\b64000', brand: 'Gildan', brand_in_copy: false, style_code: '64000', garment_family: 'tee', active: true },
  { id: 3, match_pattern: '\\b6014', brand: 'Comfort Colors', brand_in_copy: true, style_code: '6014', garment_family: 'long_sleeve_tee', active: true },
]

describe('validateBlankSpecInput', () => {
  it('rejects a bad garment_family on create', () => {
    const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: 'x', garment_family: 'sweater' }, 'create')
    expect(errors.some((e) => e.field === 'garment_family')).toBe(true)
  })

  it('accepts every real garment_family value', () => {
    for (const gf of ['tee', 'long_sleeve_tee', 'sweatshirt', 'hoodie', 'kids_tee']) {
      const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: 'x', garment_family: gf }, 'create')
      expect(errors.filter((e) => e.field === 'garment_family')).toHaveLength(0)
    }
  })

  it('rejects an invalid regex match_pattern WITH the regex engine\'s own message', () => {
    const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: '[unterminated', garment_family: 'tee' }, 'create')
    const err = errors.find((e) => e.field === 'match_pattern')
    expect(err).toBeDefined()
    expect(err!.message.length).toBeGreaterThan(0)
    expect(err!.message).not.toBe('match_pattern is required and cannot be blank')
  })

  it('accepts a valid regex match_pattern', () => {
    const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: '\\b9999', garment_family: 'tee' }, 'create')
    expect(errors.filter((e) => e.field === 'match_pattern')).toHaveLength(0)
  })

  it('rejects blank style_code and blank match_pattern on create', () => {
    const errors = validateBlankSpecInput({ style_code: '  ', match_pattern: '  ', garment_family: 'tee' }, 'create')
    expect(errors.some((e) => e.field === 'style_code')).toBe(true)
    expect(errors.some((e) => e.field === 'match_pattern')).toBe(true)
  })

  it('rejects a non-boolean brand_in_copy / unisex / active', () => {
    const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: 'x', garment_family: 'tee', brand_in_copy: 'false' as unknown, unisex: 1 as unknown, active: 'yes' as unknown }, 'create')
    expect(errors.map((e) => e.field).sort()).toEqual(['active', 'brand_in_copy', 'unisex'])
  })

  it('update mode only validates fields present in the patch — {id, active:false} alone is valid', () => {
    const errors = validateBlankSpecInput({ active: false }, 'update')
    expect(errors).toHaveLength(0)
  })

  it('update mode still rejects a bad garment_family if the patch touches it', () => {
    const errors = validateBlankSpecInput({ garment_family: 'not-a-family' }, 'update')
    expect(errors.some((e) => e.field === 'garment_family')).toBe(true)
  })
})

describe('findDuplicateActiveStyleCode', () => {
  const existing = [
    { id: 1, style_code: '1717', active: true },
    { id: 2, style_code: '64000', active: true },
    { id: 3, style_code: '6014', active: false }, // deactivated — must NOT block reuse
  ]

  it('rejects a style_code already used by an ACTIVE row', () => {
    expect(findDuplicateActiveStyleCode(existing, '1717')).toBe(1)
    expect(findDuplicateActiveStyleCode(existing, 'gildan '.trim())).toBeNull()
  })

  it('is case/whitespace insensitive', () => {
    expect(findDuplicateActiveStyleCode(existing, ' 1717 '.toLowerCase())).toBe(1)
  })

  it('allows reusing a DEACTIVATED row\'s old code', () => {
    expect(findDuplicateActiveStyleCode(existing, '6014')).toBeNull()
  })

  it('excludes the row being edited (PATCH keeping its own code)', () => {
    expect(findDuplicateActiveStyleCode(existing, '1717', 1)).toBeNull()
  })
})

describe('styleCodeExists (blank-assignment PUT validation)', () => {
  const known = ['1717', '64000', '6014']
  it('accepts a known style_code, case-insensitively', () => {
    expect(styleCodeExists(known, '6014')).toBe(true)
    expect(styleCodeExists(known, 'gildan')).toBe(false)
  })
  it('rejects an unknown style_code — the assignment PUT must 400 on this', () => {
    expect(styleCodeExists(known, '99999')).toBe(false)
  })
})

// ─── Impact / resolution — the two literal examples from the task ──────────────────────────────
describe('resolveFamily — fixture SKUs from the task spec', () => {
  const catalog = toCatalogRows(FIXTURE_ROWS)

  it('"17172XL-…" counts toward 1717 (glued-size SKU extraction, no assignment involved)', () => {
    const families = groupFamilies([{ parent_asin: 'B0TEST0001', sku: '17172XL-BLK', title: 'A Comfort Colors Tee' }])
    const family = families.get('B0TEST0001')!
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps([])
    const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
    expect(res.styleCode).toBe('1717')
    expect(res.source).toBe('sku-code')
  })

  it('"BB64000XL-BK-FBA" counts toward 64000 with no assignment', () => {
    const families = groupFamilies([{ parent_asin: 'B0TEST0002', sku: 'BB64000XL-BK-FBA', title: 'A Sweatshirt' }])
    const family = families.get('B0TEST0002')!
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps([])
    const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
    expect(res.styleCode).toBe('64000')
    expect(res.source).toBe('sku-code')
  })

  it('...UNLESS a child assignment says 6014 — the assignment wins over the SKU-extracted code', () => {
    const families = groupFamilies([{ parent_asin: 'B0TEST0002', sku: 'BB64000XL-BK-FBA', title: 'A Sweatshirt' }])
    const family = families.get('B0TEST0002')!
    const assignments: AssignmentRow[] = [{ scope: 'child', key: 'BB64000XL-BK-FBA', style_code: '6014' }]
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
    const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
    expect(res.styleCode).toBe('6014')
    expect(res.source).toBe('child-assignment')
  })

  it('falls back to a family assignment when no child SKU carries a recognizable code', () => {
    const families = groupFamilies([{ parent_asin: 'B0TEST0003', sku: 'MAHATS-BLK-L', title: 'Some Hat' }])
    const family = families.get('B0TEST0003')!
    const assignments: AssignmentRow[] = [{ scope: 'family', key: 'B0TEST0003', style_code: '64000' }]
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
    const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
    expect(res.styleCode).toBe('64000')
    expect(res.source).toBe('family-assignment')
  })

  it('falls back to the legacy match_pattern when nothing else resolves', () => {
    const families = groupFamilies([{ parent_asin: 'B0TEST0004', sku: 'OPAQUE-SKU-1', title: 'A genuine Comfort Colors garment' }])
    const family = families.get('B0TEST0004')!
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps([])
    const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
    expect(res.styleCode).toBe('1717')
    expect(res.source).toBe('legacy')
  })

  it('returns null/null/null when nothing resolves', () => {
    const families = groupFamilies([{ parent_asin: 'B0TEST0005', sku: 'OPAQUE-SKU-2', title: 'A Ceramic Mug' }])
    const family = families.get('B0TEST0005')!
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps([])
    const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
    expect(res).toEqual({ styleCode: null, source: null, rowId: null })
  })
})

describe('computeUsageCounts', () => {
  it('counts each family once, under the row it resolves to', () => {
    const catalog = toCatalogRows(FIXTURE_ROWS)
    const families = groupFamilies([
      { parent_asin: 'B0FAM1', sku: '17172XL-BLK', title: 't' },
      { parent_asin: 'B0FAM2', sku: '1717XL-RED', title: 't' },
      { parent_asin: 'B0FAM3', sku: 'BB64000XL-BK-FBA', title: 't' },
    ])
    const usage = computeUsageCounts(catalog, families, [])
    expect(usage.get(1)).toBe(2) // the two 1717 families
    expect(usage.get(2)).toBe(1) // the one 64000 family
  })
})

describe('computeBlankImpact', () => {
  it('reports resolvesTodayCount for an existing row and 0 delta when nothing changes', () => {
    const families = groupFamilies([
      { parent_asin: 'B0FAM1', sku: '17172XL-BLK', title: 't' },
      { parent_asin: 'B0FAM2', sku: 'BB64000XL-BK-FBA', title: 't' },
    ])
    const result = computeBlankImpact(FIXTURE_ROWS, families, [], { id: 1, styleCode: '1717', matchPattern: '\\bcomfort\\s*colors?\\b' })
    expect(result.resolvesTodayCount).toBe(1)
    expect(result.wouldResolveCount).toBe(1)
    expect(result.sampleAsins).toEqual([]) // no NEW families — nothing to sample
  })

  it('reports the DELTA in sampleAsins when a style_code change would pull in a new family', () => {
    // B0FAM2's SKU carries no code today (opaque) but WOULD match if we add style_code '9999' to
    // row id 2 (simulating "editing row 2 to claim this code").
    const families = groupFamilies([
      { parent_asin: 'B0FAM1', sku: 'BB64000XL-BK-FBA', title: 't' }, // already resolves to 64000 (row 2)
      { parent_asin: 'B0FAM2', sku: 'ADWF99992XL', title: 't' },      // would newly resolve to 9999 (row 2, renamed)
    ])
    const result = computeBlankImpact(FIXTURE_ROWS, families, [], { id: 2, styleCode: '9999', matchPattern: '\\bgildan\\b' })
    expect(result.resolvesTodayCount).toBe(1) // B0FAM1 resolves to row 2 today (as '64000')
    expect(result.wouldResolveCount).toBe(1) // only B0FAM2 matches '9999' after the rename (B0FAM1's SKU no longer matches '9999')
    expect(result.sampleAsins).toEqual(['B0FAM2'])
  })

  it('a brand-new blank (no id) has resolvesTodayCount 0 and previews wouldResolveCount from a synthetic row', () => {
    const families = groupFamilies([{ parent_asin: 'B0FAM9', sku: 'BC30012XL', title: 't' }])
    const result = computeBlankImpact(FIXTURE_ROWS, families, [], { id: null, styleCode: '3001', matchPattern: '\\bbc3001' })
    expect(result.resolvesTodayCount).toBe(0)
    expect(result.wouldResolveCount).toBe(1)
    expect(result.sampleAsins).toEqual(['B0FAM9'])
  })
})
