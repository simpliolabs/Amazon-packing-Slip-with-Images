import { describe, it, expect } from 'vitest'
import { DEFAULT_BLANK_SPECS, rowToSpec, matchBlankSpec, loadBlankSpecRows } from './blankSpecs'

/* The blank_specs slice (2026-08-04): the catalog moved from a hardcoded const in
 * listingPipeline.ts to the blank_specs DB table (migration 053). These tests pin the THREE
 * byte-identity oracles: (1) the in-code seeds ARE the historical rows, (2) a migration-053 DB row
 * decodes to the SAME spec the hardcoded row produced, (3) the matcher keeps lookupBlankSpec's
 * exact semantics (first match wins, joined hay, SKU-glued style numbers). */

// The migration 053 seed rows EXACTLY as PostgREST returns them (single-backslash patterns —
// the SQL literals '\bcomfort\s*colors?\b' / '\bgildan\b|\b64000' arrive as these JS strings).
const DB_SEED_ROWS = [
  { match_pattern: '\\bcomfort\\s*colors?\\b', brand: 'Comfort Colors', brand_in_copy: true, fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck', weight_note: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed', stretch: 'Low Stretch', fit_to_size: 'Runs Slightly Small', active: true },
  { match_pattern: '\\bgildan\\b|\\b64000', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weight_note: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton', dye: null, stretch: null, fit_to_size: null, active: true },
]

describe('DEFAULT_BLANK_SPECS — byte-identical to the historical hardcoded table', () => {
  it('pins the Comfort Colors row (every field, exact strings)', () => {
    expect(DEFAULT_BLANK_SPECS[0].spec).toEqual({
      brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck',
      weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton',
      dye: 'Garment-Dyed', stretch: 'Low Stretch', fitToSize: 'Runs Slightly Small',
    })
    // Historically the CC row OMITS brandInCopy (= brand allowed in copy). Absence, not true.
    expect('brandInCopy' in DEFAULT_BLANK_SPECS[0].spec).toBe(false)
  })

  it('pins the Gildan row incl. the explicit brandInCopy:false (the Gildan rule)', () => {
    expect(DEFAULT_BLANK_SPECS[1].spec).toEqual({
      brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Short Sleeve',
      neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton',
    })
  })
})

describe('matchBlankSpec — identical semantics to the deleted lookupBlankSpec', () => {
  it('matches "Comfort Colors" anywhere in the joined hay', () => {
    const s = matchBlankSpec(DEFAULT_BLANK_SPECS, null, 'THE CEO Cupid Tee | Comfort Colors Shirt', undefined, 'SHIRT')
    expect(s?.brand).toBe('Comfort Colors')
  })

  it('matches the SKU-glued Gildan style number "640002XL" (\\b64000 has NO trailing boundary)', () => {
    const s = matchBlankSpec(DEFAULT_BLANK_SPECS, 'Some Title', null, null, 'SHIRT', 'ABC-640002XL DEF-64000LG')
    expect(s?.brand).toBe('Gildan')
    expect(s?.brandInCopy).toBe(false)
  })

  it('returns null when no blank matches (unknown garment)', () => {
    expect(matchBlankSpec(DEFAULT_BLANK_SPECS, 'THE CEO Ceramic Mug 11oz', 'MUG-BLK-11')).toBeNull()
  })

  it('first matching row wins when hay mentions both blanks', () => {
    const s = matchBlankSpec(DEFAULT_BLANK_SPECS, 'comfort colors vs gildan 64000 comparison tee')
    expect(s?.brand).toBe('Comfort Colors')
  })

  it('does NOT substring-match ("discomfort colorsy" must not hit the CC \\b anchors)', () => {
    expect(matchBlankSpec(DEFAULT_BLANK_SPECS, 'discomfort colorsy shirt')).toBeNull()
  })
})

describe('rowToSpec — DB row decode (must mirror migration 053 column semantics)', () => {
  it('decodes each migration-053 seed row to the EXACT in-code seed spec (the parity oracle)', () => {
    const decoded = DB_SEED_ROWS.map((r) => rowToSpec(r))
    expect(decoded[0]?.spec).toEqual(DEFAULT_BLANK_SPECS[0].spec)
    expect(decoded[1]?.spec).toEqual(DEFAULT_BLANK_SPECS[1].spec)
    // And the compiled patterns behave identically on the live hays:
    expect(matchBlankSpec(decoded as NonNullable<(typeof decoded)[number]>[], 'Comfort Colors Shirt')?.brand).toBe('Comfort Colors')
    expect(matchBlankSpec(decoded as NonNullable<(typeof decoded)[number]>[], 'SKU 640002XL')?.brand).toBe('Gildan')
  })

  it('NULL columns become ABSENT fields, never empty strings', () => {
    const r = rowToSpec({ match_pattern: '\\btest\\b', brand: 'Test', dye: null, stretch: null })
    expect(r?.spec).toEqual({ brand: 'Test' })
    expect('dye' in (r?.spec ?? {})).toBe(false)
  })

  it('brand_in_copy=true (the DB default) does NOT materialize brandInCopy — only explicit false does', () => {
    const t = rowToSpec({ match_pattern: 'a', brand: 'A', brand_in_copy: true })
    const f = rowToSpec({ match_pattern: 'b', brand: 'B', brand_in_copy: false })
    expect('brandInCopy' in (t?.spec ?? {})).toBe(false)
    expect(f?.spec.brandInCopy).toBe(false)
  })

  it('an invalid regex row is SKIPPED (returns null), never throws the catalog down', () => {
    expect(rowToSpec({ match_pattern: '(unclosed', brand: 'Broken' })).toBeNull()
    expect(rowToSpec({ match_pattern: null })).toBeNull()
  })
})

describe('loadBlankSpecRows — fail-open floor', () => {
  it('resolves to the in-code seeds when no DB is reachable (this sandbox has no supabase env)', async () => {
    const rows = await loadBlankSpecRows()
    expect(rows).toBe(DEFAULT_BLANK_SPECS)
  })
})
