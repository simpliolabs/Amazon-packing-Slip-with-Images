import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildSeedFromTitle, buildFallbackSeed, deriveNicheSeeds } from './keywordResearcher'
import { garmentNounFor, familyScanWords, foreignHeadNoun, GARMENT_HEAD_WORDS, SHIRT_BASE } from '../fba/garmentNoun'

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

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PRODUCT-TYPE STRIKE — PO ruling 2026-08-13.
 *
 * "When you put USA Mexico Canada in your gold title — were you going after people searching for
 * those countries, or just naming what the design is about?"  ->  "No — it just describes the design."
 *
 * So the countries belong in the title, but `usa jersey` traffic is NOT to be chased: a shopper who
 * wants a real jersey will not buy a graphic tee. This is decidable against the listing's own product
 * type, so it is code's job — as a strike, never as an edit.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
describe('foreignHeadNoun — a DIFFERENT product is struck, by HEAD noun', () => {
  const shirt = SHIRT_BASE

  it('strikes the keyword the seller told us not to chase', () => {
    expect(foreignHeadNoun('usa jersey', shirt)).toBe('jersey')
    expect(foreignHeadNoun('mexico soccer jersey', shirt)).toBe('jersey')
  })

  it('THE TRAP THIS SHAPE EXISTS TO AVOID: "New Jersey" keeps its shirt', () => {
    // Scanning for ANY occurrence of a foreign garment word would strike this and cost a New Jersey
    // design its own word. English puts the head LAST, so this phrase is about a SHIRT.
    expect(foreignHeadNoun('new jersey girl shirt', shirt)).toBeNull()
    expect(foreignHeadNoun('new jersey tee', shirt)).toBeNull()
  })

  it('a bare "new jersey" is left to the DESIGN VOCABULARY, not decided here', () => {
    // Head IS foreign, so this returns "jersey" — and the title's grounding filter then asks whether
    // the design is genuinely about it. A New Jersey design has "jersey" in groundVocab and keeps it;
    // the World Cup design does not, and loses it. The fallback is the ruling, not this predicate.
    expect(foreignHeadNoun('new jersey', shirt)).toBe('jersey')
  })

  it('leaves this listing\'s own garment and non-garment phrases alone', () => {
    for (const kw of ['oversized tshirts for women', 'comfort colors graphic tshirt', 'graphic tee']) {
      expect(foreignHeadNoun(kw, shirt), kw).toBeNull()
    }
    for (const kw of ['futbol', '2026 world soccer cup', 'usa mexico canada', 'football']) {
      expect(foreignHeadNoun(kw, shirt), kw).toBeNull()
    }
  })

  it('is family-relative, not a fixed list — a HAT listing strikes shirts and keeps caps', () => {
    const hat = garmentNounFor('HAT', 'Snapback Cap')
    expect(foreignHeadNoun('world cup snapback cap', hat)).toBeNull()
    expect(foreignHeadNoun('world cup tee', hat)).toBe('tee')
    // …and the mirror image on the shirt listing.
    expect(foreignHeadNoun('world cup hat', shirt)).toBe('hat')
  })

  it('is total — empty and garment-less input never throws', () => {
    expect(foreignHeadNoun('', shirt)).toBeNull()
    expect(foreignHeadNoun('   ', shirt)).toBeNull()
  })
})
