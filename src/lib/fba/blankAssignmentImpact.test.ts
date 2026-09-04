import { describe, it, expect } from 'vitest'
import {
  validateBlankSpecInput, findDuplicateActiveStyleCode, styleCodeExists,
  toCatalogRows, groupFamilies, computeUsageCounts, computeBlankImpact, resolveFamily, resolveChildFallback, buildAssignmentMaps,
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

  // age_class (071) — UNLIKE garment_family, optional: absent on create is legal (the ~600-family
  // default), and it must never be REQUIRED the way garment_family is.
  it('age_class absent on CREATE is legal — never required, unlike garment_family', () => {
    const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: 'x', garment_family: 'tee' }, 'create')
    expect(errors.filter((e) => e.field === 'age_class')).toHaveLength(0)
  })

  it('accepts every real age_class value, plus null/empty (both mean "not stated")', () => {
    for (const ac of ['newborn', 'infant', 'toddler', 'kids', 'adult', null, '']) {
      const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: 'x', garment_family: 'tee', age_class: ac }, 'create')
      expect(errors.filter((e) => e.field === 'age_class')).toHaveLength(0)
    }
  })

  it('rejects a bad age_class WHEN the field is present', () => {
    const errors = validateBlankSpecInput({ style_code: '9999', match_pattern: 'x', garment_family: 'tee', age_class: 'senior' }, 'create')
    expect(errors.some((e) => e.field === 'age_class')).toBe(true)
  })

  it('update mode only validates age_class if the patch touches it', () => {
    const errors = validateBlankSpecInput({ active: false }, 'update')
    expect(errors.filter((e) => e.field === 'age_class')).toHaveLength(0)
  })

  it('update mode still rejects a bad age_class if the patch touches it', () => {
    const errors = validateBlankSpecInput({ age_class: 'teen' }, 'update')
    expect(errors.some((e) => e.field === 'age_class')).toBe(true)
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

// ─── Table-driven precedence chain (PO per-design garment UI, 2026-09-03) ──────────────────────
// The per-design/per-child Garment control (garmentPerDesign.ts, PerDesignCard.tsx) renders
// whatever resolveFamily decides, verbatim. This table exercises every level of the documented
// precedence — child assignment -> SKU style code -> family assignment -> legacy regex ->
// unresolved — in ONE place, over the SAME fixture family, so a future 5th level only needs a new
// row here (the individual-`it` coverage above stays as narrative/regression documentation).
describe('resolveFamily — table-driven precedence chain (child > sku > family > legacy > none)', () => {
  const catalog = toCatalogRows(FIXTURE_ROWS)
  const family = groupFamilies([{ parent_asin: 'B0TABLE01', sku: 'BB64000XL-BK-FBA', title: 'A genuine Comfort Colors sweatshirt' }]).get('B0TABLE01')!

  const CASES: { name: string; assignments: AssignmentRow[]; expectCode: string | null; expectSource: string | null }[] = [
    {
      name: 'child assignment beats the SKU-extracted code',
      assignments: [{ scope: 'child', key: 'BB64000XL-BK-FBA', style_code: '6014' }],
      expectCode: '6014', expectSource: 'child-assignment',
    },
    {
      name: 'SKU style code wins when no child assignment exists',
      assignments: [],
      expectCode: '64000', expectSource: 'sku-code',
    },
  ]

  for (const c of CASES) {
    it(c.name, () => {
      const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(c.assignments)
      const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
      expect(res.styleCode).toBe(c.expectCode)
      expect(res.source).toBe(c.expectSource)
    })
  }

  // family-assignment / legacy / unresolved need a family whose SKU carries no recognizable code
  // at all — a separate fixture family, table-driven over the SAME three remaining levels.
  const opaqueFamilyAssigned = groupFamilies([{ parent_asin: 'B0TABLE02', sku: 'OPAQUE-1', title: 'Some Hat' }]).get('B0TABLE02')!
  const opaqueFamilyLegacy = groupFamilies([{ parent_asin: 'B0TABLE03', sku: 'OPAQUE-2', title: 'A genuine Comfort Colors garment' }]).get('B0TABLE03')!
  const opaqueFamilyNone = groupFamilies([{ parent_asin: 'B0TABLE04', sku: 'OPAQUE-3', title: 'A Ceramic Mug' }]).get('B0TABLE04')!

  const REMAINING_CASES: { name: string; family: typeof opaqueFamilyAssigned; assignments: AssignmentRow[]; expectCode: string | null; expectSource: string | null }[] = [
    { name: 'family assignment when no SKU carries a code', family: opaqueFamilyAssigned, assignments: [{ scope: 'family', key: 'B0TABLE02', style_code: '64000' }], expectCode: '64000', expectSource: 'family-assignment' },
    { name: 'legacy match_pattern as the last resort', family: opaqueFamilyLegacy, assignments: [], expectCode: '1717', expectSource: 'legacy' },
    { name: 'unresolved when nothing matches at any level', family: opaqueFamilyNone, assignments: [], expectCode: null, expectSource: null },
  ]

  for (const c of REMAINING_CASES) {
    it(c.name, () => {
      const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(c.assignments)
      const res = resolveFamily(c.family, catalog, childCodeBySku, familyCodeByAsin)
      expect(res.styleCode).toBe(c.expectCode)
      expect(res.source).toBe(c.expectSource)
    })
  }
})

// ─── resolveChildFallback — the "clear must show the fallback BEFORE you confirm" safety net ────
describe('resolveChildFallback', () => {
  const catalog = toCatalogRows(FIXTURE_ROWS)

  it('B0DSCDZC6K exactly: clearing BB64000XL-BK-FBA\'s child assignment (6014) falls back to 64000 via sku-code — the wrong Tee code that motivated the assignment in the first place', () => {
    const assignments: AssignmentRow[] = [{ scope: 'child', key: 'BB64000XL-BK-FBA', style_code: '6014' }]
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
    const fallback = resolveChildFallback('BB64000XL-BK-FBA', 'B0DSCDZC6K', 'Business Btch Tee Shirt BB64000XL-BK-FBA', catalog, childCodeBySku, familyCodeByAsin)
    expect(fallback.styleCode).toBe('64000')
    expect(fallback.source).toBe('sku-code')
  })

  it('falls back to a FAMILY assignment when one exists and no child SKU carries a code of its own', () => {
    const assignments: AssignmentRow[] = [
      { scope: 'child', key: 'OPAQUE-HAT-1', style_code: '6014' },
      { scope: 'family', key: 'B0FAM-HAT', style_code: '64000' },
    ]
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
    const fallback = resolveChildFallback('OPAQUE-HAT-1', 'B0FAM-HAT', 'Some Hat', catalog, childCodeBySku, familyCodeByAsin)
    expect(fallback.styleCode).toBe('64000')
    expect(fallback.source).toBe('family-assignment')
  })

  it('falls back to the legacy match_pattern when no assignment survives the exclusion', () => {
    const assignments: AssignmentRow[] = [{ scope: 'child', key: 'OPAQUE-CC-1', style_code: '6014' }]
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
    const fallback = resolveChildFallback('OPAQUE-CC-1', 'B0FAM-CC', 'A genuine Comfort Colors garment', catalog, childCodeBySku, familyCodeByAsin)
    expect(fallback.styleCode).toBe('1717')
    expect(fallback.source).toBe('legacy')
  })

  it('falls back to null/null/null when nothing else resolves — the clear preview must show "unresolved", never crash', () => {
    const assignments: AssignmentRow[] = [{ scope: 'child', key: 'OPAQUE-MUG-1', style_code: '6014' }]
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
    const fallback = resolveChildFallback('OPAQUE-MUG-1', 'B0FAM-MUG', 'A Ceramic Mug', catalog, childCodeBySku, familyCodeByAsin)
    expect(fallback).toEqual({ styleCode: null, source: null, rowId: null })
  })

  it('previews ONE sku in isolation (mirrors the GET route\'s per-child resolution) — a sibling SKU\'s own assignment never leaks into this sku\'s fallback', () => {
    // Two children share a family; SKU-1 carries the (wrong) assignment being cleared, SKU-2 has
    // its own, different, still-active assignment. resolveChildFallback treats the target sku as a
    // one-SKU family (exactly like the GET route's childResolutions loop already does for the
    // PRIMARY resolution) — so SKU-2's code plays no part in SKU-1's OWN fallback preview, and with
    // no code of its own, no family assignment, and no legacy match, SKU-1 falls back to nothing.
    const assignments: AssignmentRow[] = [
      { scope: 'child', key: 'MULTI-SKU-1', style_code: '6014' },
      { scope: 'child', key: 'MULTI-SKU-2', style_code: '64000' },
    ]
    const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
    const fallback = resolveChildFallback('MULTI-SKU-1', 'B0FAM-MULTI', 'irrelevant hay', catalog, childCodeBySku, familyCodeByAsin)
    expect(fallback.styleCode).toBeNull()
    expect(fallback.source).toBeNull()
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
