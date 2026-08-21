/**
 * designScope — the ONE cross-design pool partition. Pins the soft (bullets/description, extracted
 * verbatim) vs strict (Item Highlight truth rule) difference: a pool harvested on ONE design's
 * identity is full of that design's name — the pool-frequency exemption must not re-license it for
 * the other designs' highlight (PO 2026-08-21, B0DQ5YZH38 "Beast Mode Shirt" on Don't Quit).
 */
import { describe, it, expect } from 'vitest'
import { buildForeignDesignTokens, isForeignToDesign, fillNormTok } from './designScope'

const DESIGNS = [{ key: 'BM', name: 'Beast Mode' }, { key: 'DQ', name: "Don't Quit" }, { key: 'RK', name: 'Real King' }]
/** A pool harvested on the BM identity: "beast" in 40% of rows. */
const BM_HEAVY_POOL = ['beast mode shirt', 'beast mode gym tee', 'beast mode workout tank', 'beast mode tshirt men', 'gym motivation shirts', 'workout graphic tees', 'lifting apparel men', 'fitness clothing men', 'real king shirt', "don't quit shirt"]

describe('buildForeignDesignTokens — soft (bullets) vs strict (Item Highlight)', () => {
  it('SOFT: a pool-frequent name token is niche-exempt (the review-caught "Fishing Trip" rule — bullets behavior unchanged)', () => {
    const foreignFor = buildForeignDesignTokens(DESIGNS, { familyTitleText: 'Gym Shirts for Men', poolKeywords: BM_HEAVY_POOL })
    expect(isForeignToDesign('beast mode shirt', foreignFor('DQ'))).toBe(false)   // "beast"+"mode" frequent ⇒ exempt
    expect(isForeignToDesign("don't quit shirt", foreignFor('BM'))).toBe(true)    // "quit" rare ⇒ foreign
  })

  it('STRICT: another design NAME is foreign however full of it the pool is; identity seeds keep every exemption', () => {
    const foreignFor = buildForeignDesignTokens(DESIGNS, { familyTitleText: 'Gym Shirts for Men', poolKeywords: BM_HEAVY_POOL, strictNames: true })
    expect(isForeignToDesign('beast mode shirt', foreignFor('DQ'))).toBe(true)
    expect(isForeignToDesign('beast mode shirt', foreignFor('RK'))).toBe(true)
    expect(isForeignToDesign('beast mode shirt', foreignFor('BM'))).toBe(false)   // own
    expect(isForeignToDesign('gym motivation shirts', foreignFor('DQ'))).toBe(false)  // shared family phrase
  })

  it('family-title tokens and ≥50%-name-shared tokens are niche even in strict mode', () => {
    const fishing = [{ key: 'FT', name: 'Fishing Trip' }, { key: 'FH', name: 'Fish Hard' }, { key: 'OF', name: 'Only Fins' }]
    const foreignFor = buildForeignDesignTokens(fishing, { familyTitleText: 'Funny Fishing Shirts for Men', poolKeywords: [], strictNames: true })
    expect(isForeignToDesign('fishing gifts for dad', foreignFor('OF'))).toBe(false)   // "fishing" in the family title
    expect(isForeignToDesign('fish hard apparel', foreignFor('FT'))).toBe(true)        // "hard" is FH's own word
    expect(isForeignToDesign('fins and scales tee', foreignFor('FT'))).toBe(true)      // "fins" is OF's own word
  })

  it('identity (vision) phrases extend a design vocabulary but stay soft: a pool-frequent seed word is never foreign', () => {
    const d = [{ key: 'BM', name: 'Beast Mode', identity: ['gym', 'lifting'] }, { key: 'DQ', name: "Don't Quit", identity: ['motivation'] }]
    const foreignFor = buildForeignDesignTokens(d, { familyTitleText: '', poolKeywords: ['gym shirt', 'gym tee', 'gym tank', 'gym hoodie', 'quit tee'], strictNames: true })
    expect(isForeignToDesign('gym shirt', foreignFor('DQ'))).toBe(false)     // "gym" frequent in pool ⇒ exempt (identity token)
    expect(isForeignToDesign('lifting shirt', foreignFor('DQ'))).toBe(true)  // "lifting" only BM's seed, rare ⇒ foreign
    expect(isForeignToDesign('motivation tee', foreignFor('BM'))).toBe(true)
  })

  it('fillNormTok folds gender plurals, light plurals and tshirt→shirt (the title fill dedup contract)', () => {
    expect(['mens', 'womens', 'tees', 'shirts', 'tshirt', 'men'].map(fillNormTok)).toEqual(['men', 'women', 'tee', 'shirt', 'shirt', 'men'])
  })
})
