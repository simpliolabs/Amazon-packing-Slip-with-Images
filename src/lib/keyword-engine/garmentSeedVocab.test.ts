import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildSeedFromTitle, buildFallbackSeed, deriveNicheSeeds } from './keywordResearcher'
import { garmentNounFor, familyScanWords, GARMENT_HEAD_WORDS, SHIRT_BASE } from '../fba/garmentNoun'

// #156 — the seed-vocabulary net. The old GARMENT_NOUN=on union split multi-word aliases into
// tokens, making modifiers (dad/graphic/crew/baseball/bucket/winter/kitchen/muscle/…) "apparel
// words" for EVERY listing: 'Best Dad Ever Shirt' seeded the SHARED pool as 'best ever dad' and
// '<Design> Graphic Tee' as '<design> graphic'. These tests pin the head-noun vocabulary and the
// family-scoped title scan, in BOTH flag modes (the scan is per-call, no module reset needed).

const HAT = garmentNounFor('HAT', null)

describe('GARMENT_HEAD_WORDS — modifiers are never garment words', () => {
  it('excludes every modifier half of the multi-word aliases', () => {
    for (const w of ['dad', 'trucker', 'bucket', 'baseball', 'knit', 'winter', 'hooded', 'crew', 'neck', 'muscle', 'novelty', 'set', 'kitchen', 'graphic']) {
      expect(GARMENT_HEAD_WORDS.has(w), w).toBe(false)
    }
  })
  it('includes the real head nouns', () => {
    for (const w of ['shirt', 'tee', 'hat', 'cap', 'snapback', 'hoodie', 'beanie', 'apron', 'socks']) {
      expect(GARMENT_HEAD_WORDS.has(w), w).toBe(true)
    }
  })
})

describe('familyScanWords — per-listing scan vocabulary', () => {
  it('shirt family is a subset of the historical literal (zero shirt regression)', () => {
    const base = new Set(['shirt', 'shirts', 'tshirt', 'tshirts', 't-shirt', 'tee', 'tees', 'top', 'tops', 'hoodie', 'sweatshirt', 'tank'])
    for (const w of familyScanWords(SHIRT_BASE)) expect(base.has(w), w).toBe(true)
    expect(familyScanWords(SHIRT_BASE).has('graphic')).toBe(false)
  })
  it('headwear family adds its heads but never its modifiers', () => {
    const scan = familyScanWords(HAT)
    for (const w of ['hat', 'cap', 'snapback', 'visor']) expect(scan.has(w), w).toBe(true)
    for (const w of ['dad', 'trucker', 'bucket', 'baseball']) expect(scan.has(w), w).toBe(false)
  })
})

describe('buildSeedFromTitle — the poisoning specimens', () => {
  it("'Best Dad Ever Shirt' keeps dad as a DESIGN token: 'best dad shirt'", () => {
    expect(buildSeedFromTitle('Best Dad Ever Shirt', SHIRT_BASE)).toBe('best dad shirt')
  })
  it("'Best Dad Ever Hat' on the hat family: 'best dad hat', never 'best ever dad'", () => {
    expect(buildSeedFromTitle('Best Dad Ever Hat', HAT)).toBe('best dad hat')
  })
  it("'Retro Sunset Graphic Tee for Women' seeds the GARMENT, never 'graphic' ('retro'/'graphic' are SEED_GENERIC, mode-independent)", () => {
    expect(buildSeedFromTitle('Retro Sunset Graphic Tee for Women', SHIRT_BASE)).toBe('sunset tee')
  })
  it("a shirt listing never picks a cross-family head from its design phrase ('Coat of Arms')", () => {
    // 'coat' is not in the shirt family's scan set, so it stays a design token and the garment is 'shirt'.
    const seed = buildSeedFromTitle('Coat of Arms Ireland Shirt', SHIRT_BASE)
    expect(seed.endsWith(' shirt')).toBe(true)
    expect(seed).toContain('coat')
  })
  it('the hat fix still works: snapback recognized on its own family', () => {
    const g = garmentNounFor('HAT', 'Cashflow Snapback Cap')
    expect(buildSeedFromTitle('Cashflow Snapback Cap', g)).toBe('cashflow snapback')
  })
})

describe('buildFallbackSeed — family-scoped product word', () => {
  it("blank-brand fallback on a Graphic Tee title yields the garment, not 'graphic'", () => {
    const out = buildFallbackSeed('some seed', 'Retro Comfort Colors Graphic Tee', SHIRT_BASE)
    expect(out).toBe('comfort colors tee')
  })
})

describe('deriveNicheSeeds — product-word append survives modifier-named themes', () => {
  const identity = { designTheme: 'Bucket List Adventures', seedKeywords: [], suggestedSearchTerms: [] }
  afterEach(() => { delete process.env.GARMENT_NOUN; vi.resetModules() })

  it('OFF: appends the garment word (bucket is not a product word)', () => {
    const out = deriveNicheSeeds(identity, 'alligator shirt')
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]).toMatch(/tshirt|shirt|tee/)
  })
  it('ON: heads-only regex — bucket/baseball/winter themes still get the garment word', async () => {
    process.env.GARMENT_NOUN = 'on'
    vi.resetModules()
    const mod = await import('./keywordResearcher')
    for (const theme of ['Bucket List Adventures', 'Baseball Mom Life', 'Winter Wonderland Magic']) {
      const out = mod.deriveNicheSeeds({ designTheme: theme, seedKeywords: [], suggestedSearchTerms: [] }, 'alligator shirt')
      expect(out.length, theme).toBeGreaterThan(0)
      expect(out[0], theme).toMatch(/tshirt|shirt|tee/)
    }
  })
})
