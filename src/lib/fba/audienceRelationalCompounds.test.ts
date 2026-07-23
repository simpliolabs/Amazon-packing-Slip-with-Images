import { describe, it, expect } from 'vitest'
import { deriveAudienceRelationalCompounds } from './audienceRelationalCompounds'

describe('deriveAudienceRelationalCompounds — Fix C golf-widow case', () => {
  it('emits widow + wife compounds for lean_female + male-pronoun hint ("He\'s Golfing")', () => {
    const seeds = deriveAudienceRelationalCompounds("He's Golfing", 'lean_female', 'SHIRT')
    expect(seeds).toContain('golf widow shirt')
    expect(seeds).toContain('golf widow tee')
    expect(seeds).toContain('golf wife shirt')
    expect(seeds).toContain('golf wife tee')
    expect(seeds.length).toBeLessThanOrEqual(4)
  })

  it('strips -ing gerund from theme ("Golfing" → "golf")', () => {
    const seeds = deriveAudienceRelationalCompounds("He's Golfing", 'lean_female', 'SHIRT')
    for (const s of seeds) expect(s).toMatch(/^golf /)
  })

  it('works with "his" instead of "he\'s"', () => {
    const seeds = deriveAudienceRelationalCompounds("His Golf Life", 'lean_female', 'SHIRT')
    expect(seeds.length).toBeGreaterThan(0)
    expect(seeds.some((s) => s.startsWith('golf '))).toBe(true)
  })

  it('hard-lean female is treated same as lean_female', () => {
    const seeds = deriveAudienceRelationalCompounds("He's Fishing", 'female', 'SHIRT')
    expect(seeds).toContain('fish widow shirt')
  })
})

describe('deriveAudienceRelationalCompounds — symmetric male-lean case', () => {
  it('emits husband + boyfriend compounds for lean_male + female-pronoun hint', () => {
    const seeds = deriveAudienceRelationalCompounds("She's Shopping", 'lean_male', 'SHIRT')
    expect(seeds).toContain('shop husband shirt')
    expect(seeds).toContain('shop boyfriend shirt')
  })
})

describe('deriveAudienceRelationalCompounds — skip conditions', () => {
  it('returns [] on lean=null (universal)', () => {
    expect(deriveAudienceRelationalCompounds("He's Golfing", null, 'SHIRT')).toEqual([])
  })

  it('returns [] on lean=unisex', () => {
    expect(deriveAudienceRelationalCompounds("He's Golfing", 'unisex', 'SHIRT')).toEqual([])
  })

  it('returns [] when designName is empty', () => {
    expect(deriveAudienceRelationalCompounds('', 'lean_female', 'SHIRT')).toEqual([])
  })

  it('returns [] when designName has NO gender-pronoun hint', () => {
    expect(deriveAudienceRelationalCompounds('Best Golf Design Ever', 'lean_female', 'SHIRT')).toEqual([])
    expect(deriveAudienceRelationalCompounds('Golf Life', 'lean_female', 'SHIRT')).toEqual([])
  })

  it('returns [] when lean and hint are the SAME gender (widow needs OPPOSITE)', () => {
    // female lean + female hint = no compound (would be same-gender-widow, doesn't exist)
    expect(deriveAudienceRelationalCompounds("She's Golfing", 'lean_female', 'SHIRT')).toEqual([])
    // male lean + male hint = no compound
    expect(deriveAudienceRelationalCompounds("He's Golfing", 'lean_male', 'SHIRT')).toEqual([])
  })

  it('SKIPS gift-SKU: designName already contains a relational carrier (husband/wife/etc)', () => {
    // "Best Husband Ever" → seller already named the spouse; anti-lean territory, not a widow-inject
    expect(deriveAudienceRelationalCompounds('Best Husband Ever', 'lean_female', 'SHIRT')).toEqual([])
    expect(deriveAudienceRelationalCompounds("Wife's Golf Life", 'lean_female', 'SHIRT')).toEqual([])
    expect(deriveAudienceRelationalCompounds('Golf Widow Life', 'lean_female', 'SHIRT')).toEqual([])
  })

  it('returns [] when no theme token extractable (all filtered by connector/garment/short)', () => {
    // Only pronoun + connector → no theme content left
    expect(deriveAudienceRelationalCompounds("He's In", 'lean_female', 'SHIRT')).toEqual([])
  })

  it('adversarial: bare "he" alone is NOT a hint (avoids false positives on generic pronoun phrases)', () => {
    // A song-title-style design with bare "he" should NOT trigger a widow-inject
    expect(deriveAudienceRelationalCompounds('The Way He Loves Me', 'lean_female', 'SHIRT')).toEqual([])
    expect(deriveAudienceRelationalCompounds('He Wins Big', 'lean_female', 'SHIRT')).toEqual([])
  })

  it('adversarial: bare "she" is NOT a hint (symmetric to bare "he")', () => {
    expect(deriveAudienceRelationalCompounds('The Way She Loves Me', 'lean_male', 'SHIRT')).toEqual([])
  })

  it('adversarial: bare "him"/"her" as object pronouns do NOT fire alone (need possessive/contraction)', () => {
    // "him" is not in the hint set; only possessives/contractions/relational nicknames are
    expect(deriveAudienceRelationalCompounds('Tell Him Now', 'lean_female', 'SHIRT')).toEqual([])
  })
})

describe('deriveAudienceRelationalCompounds — output shape', () => {
  it('caps output at 4 seeds max', () => {
    const seeds = deriveAudienceRelationalCompounds("He's Golfing Really Hard Always", 'lean_female', 'SHIRT')
    expect(seeds.length).toBeLessThanOrEqual(4)
  })

  it('output is deduplicated', () => {
    const seeds = deriveAudienceRelationalCompounds("He's Golfing", 'lean_female', 'SHIRT')
    expect(new Set(seeds).size).toBe(seeds.length)
  })

  it('all output entries are non-empty strings', () => {
    const seeds = deriveAudienceRelationalCompounds("He's Golfing", 'lean_female', 'SHIRT')
    for (const s of seeds) {
      expect(typeof s).toBe('string')
      expect(s.length).toBeGreaterThan(0)
    }
  })
})
