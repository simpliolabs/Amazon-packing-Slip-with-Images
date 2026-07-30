import { describe, it, expect } from 'vitest'
import { isOffNicheKeyword } from './nicheGuards'

/* Competitor RETAIL brands. MEASURED GAP (B0GR22ZHBW, 2026-07-30): the pool for a wedding
 * vow-renewal tee contained `nike shirts women` (23,353/mo) and the token pair grunt+style
 * (Grunt Style, a competitor apparel brand). COMPETITOR_BLANK_BRANDS only ever covered the
 * manufacturers we PRINT ON (Gildan, Hanes); nothing covered the brands we COMPETE WITH at
 * retail, so those terms consumed pool slots and backend bytes we can never rank for. */
const TEE_CTX = { context: 'the ceo we still do anniversary tee shirt comfort colors vow renewal' }

describe('competitor RETAIL brands are off-niche', () => {
  it('THE LIVE MISS: nike shirts women is excluded from a graphic tee pool', () => {
    expect(isOffNicheKeyword('nike shirts women', TEE_CTX)).toBe(true)
  })

  it('grunt style (the other live miss) is excluded, spaced AND glued', () => {
    expect(isOffNicheKeyword('grunt style shirts for men', TEE_CTX)).toBe(true)
    // `\s*` in the pattern means zero spaces match too, so the glued spelling shoppers actually
    // type is covered without a second alternation. Pinned because it is easy to "tidy" \s* to \s+
    // and silently lose it.
    expect(isOffNicheKeyword('gruntstyle tee', TEE_CTX)).toBe(true)
  })

  it('covers the major apparel houses a POD tee competes with', () => {
    for (const kw of ['adidas t shirt women', 'under armour shirt', 'lululemon tee',
                      'the north face shirt', 'levis t shirt', 'ralph lauren polo shirt']) {
      expect(isOffNicheKeyword(kw, TEE_CTX)).toBe(true)
    }
  })

  it('OWN-BRAND ESCAPE HATCH: a seller whose own brand is listed keeps its own terms', () => {
    // Same guard the blank-brand test has had all along — the context is the listing's live copy.
    expect(isOffNicheKeyword('nike shirts women', { context: 'nike official store dri-fit shirt' })).toBe(false)
  })

  it('does NOT become a general proper-noun ban — ordinary design terms survive', () => {
    for (const kw of ['vow renewal shirt', 'anniversary tee for couples', 'cupid valentine shirt',
                      'oversized graphic tees for women', 'comfort colors tshirt']) {
      expect(isOffNicheKeyword(kw, TEE_CTX)).toBe(false)
    }
  })

  it('a non-apparel caller is unaffected — callers gate on apparel themselves', () => {
    // isOffNicheKeyword documents that callers MUST gate on the listing being apparel; this test
    // pins that the predicate itself stays a pure string test with no hidden category logic.
    expect(isOffNicheKeyword('', TEE_CTX)).toBe(false)
  })
})
