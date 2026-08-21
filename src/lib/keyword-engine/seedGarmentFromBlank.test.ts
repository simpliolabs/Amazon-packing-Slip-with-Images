import { describe, it, expect, vi } from 'vitest'
import { garmentNounFor, resolveGarment, SHIRT_BASE, familyScanWords, foreignHeadNoun } from '../fba/garmentNoun'
import { resolveSeedGarment, buildSeedFromTitle, buildFallbackSeed, validateSeeds, teeProven } from './keywordResearcher'

/* KEYWORD UNIVERSE FOLLOWS THE BLANK, NOT AMAZON'S productType (PO ruling 2026-08-21,
 * SELLER_PROFILE.md). B0GQ6PGR2N is a Comfort Colors 6014 long-sleeve TEE listed under productType
 * SWEATSHIRT; garmentNounFor(productType) seeded a sweatshirt universe onto it (47 of 52 harvested
 * keywords). These tests pin the ONE seam: resolveGarment (pure) prefers blank_specs.garment_family
 * and falls back to productType + title BYTE-IDENTICALLY to garmentNounFor; resolveSeedGarment
 * (async) feeds it from the SKU-first blank resolver with a DB-only read. */

// The catalog as PostgREST returns it after migration 058 (single-backslash patterns), in id order.
const DB_ROWS = [
  { match_pattern: '\\bcomfort\\s*colors?\\b', brand: 'Comfort Colors', brand_in_copy: true, fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck', material: '100% Ring-Spun Cotton', style_code: '1717', garment_family: 'tee' },
  { match_pattern: '\\bgildan\\b|\\b64000', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', material: 'Ring-Spun Cotton', style_code: '64000', garment_family: 'tee' },
  { match_pattern: '\\b6014', brand: 'Comfort Colors', brand_in_copy: true, fit: 'Relaxed', sleeve: 'Long Sleeve', neck: 'Crew Neck', material: '100% Ring-Spun Cotton', style_code: '6014', garment_family: 'long_sleeve_tee' },
  { match_pattern: '\\b1800(?:0)?(?=\\D|$)|\\b18000', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', material: '50% Cotton / 50% Polyester', style_code: '18000', garment_family: 'sweatshirt' },
  { match_pattern: '\\b18500', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Hooded', material: '50% Cotton / 50% Polyester', style_code: '18500', garment_family: 'hoodie' },
  { match_pattern: '\\b64000b', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', material: 'Ring-Spun Cotton', style_code: '64000B', garment_family: 'kids_tee' },
]

// The module's own (service-role) client serves the catalog + overrides; listing_content comes from
// the caller-supplied `db` below. Nothing here can reach Jungle Scout — the only I/O is this mock.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ order: () => Promise.resolve(table === 'blank_specs' ? { data: DB_ROWS, error: null } : { data: [], error: null }) }),
        limit: () => Promise.resolve({ data: [], error: null }),
      }),
    }),
  }),
}))

/** A fake listing_content read for ONE family: `select('sku, title').eq('parent_asin', X).limit(n)`. */
function familyDb(parent: string, rows: { sku: string; title: string }[]) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, value: string) => ({
          limit: () => Promise.resolve({ data: table === 'listing_content' && value === parent ? rows : [], error: null }),
        }),
      }),
    }),
  }
}

// B0GQ6PGR2N as stored (child SKU 6014M-EP-LS-SweetPotato; Amazon productType SWEATSHIRT).
const LS_TITLE = 'Comfort Colors Sweet vs Rude Potato Long Sleeve Shirt, Espresso, Medium'
const LS_FAMILY = familyDb('B0GQ6PGR2N', [
  { sku: '6014M-EP-LS-SweetPotato', title: LS_TITLE },
  { sku: '6014L-EP-LS-SweetPotato', title: LS_TITLE },
  { sku: '6014M-EP-LS-RudePotato', title: LS_TITLE.replace('Sweet vs Rude', 'Rude vs Sweet') },
])

describe('resolveGarment — the blank is the truth, productType is the fallback', () => {
  it('SWEATSHIRT productType + blank 6014 (long_sleeve_tee) ⇒ SHIRT family with the long-sleeve alias', () => {
    const g = resolveGarment({ productType: 'SWEATSHIRT', title: LS_TITLE, blankFamily: 'long_sleeve_tee' })
    expect(g.source).toBe('blank')
    expect(g.blankFamily).toBe('long_sleeve_tee')
    expect(g.family).toBe('shirt')
    expect(g.noun).toBe('shirt')
    expect(g.seedNoun).toBe('long sleeve shirt')
    expect(g.display).toBe('Long Sleeve Shirt')
    // The category head names SHIRTS, never sweatshirts.
    expect(g.categoryHead('women')).toBe('long sleeve shirts for women')
    expect(g.categoryHead('men')).toBe('long sleeve shirts for men')
    expect(g.categoryHead('women')).not.toMatch(/sweatshirt/)
  })
  it('a bare "tee" in the title refines WITHIN the sleeve, never drops it', () => {
    const refined = resolveGarment({ productType: 'SWEATSHIRT', title: 'Potato Long Sleeve Tee', blankFamily: 'long_sleeve_tee' })
    expect(refined.seedNoun).toBe('long sleeve tee')
    const bare = resolveGarment({ productType: 'SWEATSHIRT', title: 'Potato Graphic Tee', blankFamily: 'long_sleeve_tee' })
    expect(bare.seedNoun).toBe('long sleeve shirt')
  })
  it('the long-sleeve shirt keeps the SHIRT head-noun scans (tee/shirt are its own, sweatshirt is foreign)', () => {
    const g = resolveGarment({ productType: 'SWEATSHIRT', title: LS_TITLE, blankFamily: 'long_sleeve_tee' })
    const scan = familyScanWords(g)
    for (const w of ['shirt', 'tee', 'tshirt']) expect(scan.has(w), w).toBe(true)
    for (const w of ['long', 'sleeve']) expect(scan.has(w), w).toBe(false)   // modifiers are never garment words (#156)
    expect(foreignHeadNoun('potato long sleeve tee', g)).toBeNull()
    expect(foreignHeadNoun('potato sweatshirt', g)).toBe('sweatshirt')
  })
  it('SHIRT productType + blank 18000 (sweatshirt) ⇒ SWEATSHIRT family, identical to the productType sweatshirt', () => {
    const g = resolveGarment({ productType: 'SHIRT', title: 'Cozy Potato Shirt', blankFamily: 'sweatshirt' })
    expect(g.source).toBe('blank')
    expect(g.family).toBe('sweatshirt')
    expect(g.categoryHead('women')).toBe('graphic sweatshirts for women')
    const { source: _s, blankFamily: _b, ...rest } = g
    expect(rest).toEqual(garmentNounFor('SWEATSHIRT', 'Cozy Potato Shirt'))
  })
  it('blank 18500 (hoodie) ⇒ the existing hoodie family', () => {
    const g = resolveGarment({ productType: 'SHIRT', title: null, blankFamily: 'hoodie' })
    expect(g.family).toBe('hoodie')
    expect(g.categoryHead('men')).toBe('graphic hoodies for men')
  })
  it('blank 64000B (kids_tee) ⇒ SHIRT family with a kids/youth audience head', () => {
    const g = resolveGarment({ productType: 'SHIRT', title: 'Dinosaur Roar Youth Tee', blankFamily: 'kids_tee' })
    expect(g.source).toBe('blank')
    expect(g.family).toBe('shirt')
    expect(g.seedNoun).toBe('youth tee')
    expect(g.categoryHead('women')).toBe('graphic tees for kids')   // adult audience from the title is ignored
    expect(resolveGarment({ productType: 'SHIRT', title: 'Dinosaur Roar Shirt', blankFamily: 'kids_tee' }).seedNoun).toBe('kids shirt')
  })
  it('blank tee ⇒ the frozen shirt base, byte-identical to the no-blank shirt resolution', () => {
    for (const title of ['Potato Graphic Tee', 'Potato T-Shirt', null]) {
      const { source, blankFamily, ...rest } = resolveGarment({ productType: 'SWEATSHIRT', title, blankFamily: 'tee' })
      expect(source).toBe('blank')
      expect(blankFamily).toBe('tee')
      expect(rest).toEqual(garmentNounFor(null, title))
    }
  })
  it('NO blank ⇒ byte-identical to garmentNounFor for every family and the shirt default', () => {
    const cases: [string | null, string | null][] = [
      ['SWEATSHIRT', LS_TITLE], ['HAT', 'Cashflow Snapback Cap'], ['HOODIE', null], ['TANK_TOP', 'Muscle Tank'],
      ['SHIRT', 'Potato Graphic Tee'], ['SHIRT', 'Potato T-Shirt'], [null, 'Potato Tee'], ['PRODUCT', null], ['', ''],
    ]
    for (const [productType, title] of cases) {
      for (const blankFamily of [null, undefined, '']) {
        const { source, blankFamily: bf, ...rest } = resolveGarment({ productType, title, blankFamily })
        expect(source, `${productType}/${title}`).toBe('productType')
        expect(bf).toBeNull()
        expect(rest, `${productType}/${title}`).toEqual(garmentNounFor(productType, title))
      }
    }
    // The shirt default is the SAME frozen object, not a copy — the zero-shirt-regression guarantee.
    expect(garmentNounFor('SHIRT', 'Potato T-Shirt')).toBe(SHIRT_BASE)
  })
  it('an unknown garment_family falls through to the productType path (fail-open, never a guess)', () => {
    const g = resolveGarment({ productType: 'HAT', title: null, blankFamily: 'onesie' })
    expect(g.source).toBe('productType')
    expect(g.family).toBe('headwear')
  })
})

describe('resolveSeedGarment — the async seam reads the SKU-first blank, never research', () => {
  it('B0GQ6PGR2N: SWEATSHIRT productType, 6014 children ⇒ shirt family seeded from the blank', async () => {
    const g = await resolveSeedGarment({ asin: 'B0GQ6PGR2N', parentAsin: 'B0GQ6PGR2N', listingTitle: LS_TITLE, productType: 'SWEATSHIRT' }, LS_FAMILY)
    expect(g.source).toBe('blank')
    expect(g.blankFamily).toBe('long_sleeve_tee')
    expect(g.family).toBe('shirt')
    expect(g.categoryHead('women')).toBe('long sleeve shirts for women')
    // The seed builders downstream now speak shirt (the 'vs' token is today's buildSeedFromTitle
    // behaviour — length-2 tokens survive its filter — pinned as-is, not this seam's concern).
    expect(buildSeedFromTitle(LS_TITLE, g)).toBe('sweet vs shirt')
    expect(buildFallbackSeed('sweet vs shirt', LS_TITLE, g)).toBe('comfort colors shirt')
  })
  it('SHIRT productType, 18000 children ⇒ sweatshirt family seeded from the blank', async () => {
    const db = familyDb('B0DSCDZC6K', [{ sku: 'BCSG18002X-BLK', title: 'Cozy Potato Sweatshirt' }, { sku: 'EDG1800L-BLK', title: 'Cozy Potato Sweatshirt' }])
    const g = await resolveSeedGarment({ asin: 'B0DSCDZC6K', parentAsin: 'B0DSCDZC6K', listingTitle: 'Cozy Potato Sweatshirt', productType: 'SHIRT' }, db)
    expect(g.source).toBe('blank')
    expect(g.family).toBe('sweatshirt')
    expect(g.categoryHead('women')).toBe('graphic sweatshirts for women')
  })
  it("the blank resolver's garment-compatibility gate is CONSUMED, not bypassed: a 'Shirt' title over 18000 SKUs nulls the blank ⇒ productType path", async () => {
    // resolveFamilyBlank (unchanged here) refuses a blank whose class contradicts EVERY garment word in
    // the hay (BLANK_GARMENT_CONFLICT). This seam inherits that: the contradiction is logged, never
    // silently overridden. The hay is titles + SKUs only — the productType is deliberately NOT in it,
    // so SWEATSHIRT/SHIRT productTypes can never veto the SKU by themselves (the B0GQ6PGR2N case).
    const db = familyDb('B0DSCDZC6K', [{ sku: 'BCSG18002X-BLK', title: 'Cozy Potato Shirt' }])
    const g = await resolveSeedGarment({ asin: 'B0DSCDZC6K', parentAsin: 'B0DSCDZC6K', listingTitle: 'Cozy Potato Shirt', productType: 'SHIRT' }, db)
    expect(g.source).toBe('productType')
    expect(g.family).toBe('shirt')
  })
  it('no resolvable blank (opaque SKUs, no override, no brand in the hay) ⇒ the productType path, unchanged', async () => {
    const db = familyDb('B0XXXXXXXX', [{ sku: 'AMZN-OPAQUE-1', title: 'Cashflow Snapback Cap' }])
    const g = await resolveSeedGarment({ asin: 'B0XXXXXXXX', parentAsin: 'B0XXXXXXXX', listingTitle: 'Cashflow Snapback Cap', productType: 'HAT' }, db)
    expect(g.source).toBe('productType')
    const { source: _s, blankFamily: _b, ...rest } = g
    expect(rest).toEqual(garmentNounFor('HAT', 'Cashflow Snapback Cap'))
  })
  it('a failing listing_content read fails OPEN to the productType path', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ limit: () => Promise.reject(new Error('boom')) }) }) }) }
    const g = await resolveSeedGarment({ asin: 'B0GQ6PGR2N', parentAsin: 'B0GQ6PGR2N', listingTitle: LS_TITLE, productType: 'SWEATSHIRT' }, db)
    expect(g.source).toBe('productType')
    expect(g.family).toBe('sweatshirt')
  })
})

describe('teeProven — the broad heads "is it really a tee?" guard', () => {
  const LS = resolveGarment({ productType: 'SWEATSHIRT', title: LS_TITLE, blankFamily: 'long_sleeve_tee' })
  it('a BLANK-sourced shirt family is proof: the 6014 family titled "Long Sleeve Shirt" gets its heads without a "tee" in the title', () => {
    expect(teeProven(LS, `sweet vs shirt ${LS_TITLE.toLowerCase()}`)).toBe(true)
    expect(teeProven(resolveGarment({ productType: 'SHIRT', title: 'Potato Shirt', blankFamily: 'tee' }), 'potato shirt')).toBe(true)
  })
  it('no-blank shirts keep the legacy regex byte-for-byte (title must SAY tee/t-shirt)', () => {
    expect(teeProven(SHIRT_BASE, 'potato shirt comfort colors potato long sleeve shirt')).toBe(false)
    expect(teeProven(SHIRT_BASE, 'potato tee')).toBe(true)
    expect(teeProven(SHIRT_BASE, 'potato t-shirt')).toBe(true)
    expect(teeProven(garmentNounFor('SHIRT', 'Potato Shirt'), 'potato shirt')).toBe(false)
  })
  it('non-shirt families pass on the family itself, as before', () => {
    expect(teeProven(garmentNounFor('HAT', 'Cashflow Cap'), 'cashflow cap')).toBe(true)
    expect(teeProven(garmentNounFor('SWEATSHIRT', null), 'potato')).toBe(true)
  })
})

describe('validateSeeds — the appended product word survives the 4-token cap whole', () => {
  const identity = new Set<string>()   // empty identity → no hallucination gate, the cap is the subject
  it('1-token product word, short seeds: byte-identical to the legacy append + cap', () => {
    expect(validateSeeds(['sweet potato'], identity, 'tshirt')).toEqual(['sweet potato tshirt'])
    expect(validateSeeds(['sweet rude potato'], identity, 'tshirt')).toEqual(['sweet rude potato tshirt'])
    expect(validateSeeds(['sweet potato shirt'], identity, 'tshirt')).toEqual(['sweet potato shirt'])   // already carries one: no append
    expect(validateSeeds(['a b c d e shirt'], identity, 'tshirt')).toEqual(['a b c d'])                 // cap on a seed that carries its own word: unchanged
  })
  it('a multi-token product word is never cut into a garment-less seed', () => {
    expect(validateSeeds(['sweet potato'], identity, 'long sleeve shirt')).toEqual(['sweet potato long sleeve shirt'])
    expect(validateSeeds(['sweet rude potato'], identity, 'long sleeve shirt')).toEqual(['sweet rude long sleeve shirt'])
    expect(validateSeeds(['sweet potato'], identity, 'tank top')).toEqual(['sweet potato tank top'])
    expect(validateSeeds(['sweet rude potato'], identity, 'tank top')).toEqual(['sweet rude tank top'])
  })
  it('a 1-token product word on a long seed now survives too (legacy shipped "a b c d" garment-less)', () => {
    expect(validateSeeds(['a b c d e'], identity, 'tshirt')).toEqual(['a b c tshirt'])
  })
})
