import { describe, it, expect } from 'vitest'
import { guaranteedIdentitySynonyms, identitySynonymPhrases, identityTokensOf, keywordIsRelevant } from './keywordResearcher'

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PO RULING 2026-08-09, SELLER_PROFILE §3 gold rule 3: '"Football" is a required international
 * synonym on soccer products — non-US shoppers search football, and "football tee" is its own
 * demand.' The PO's gold spends the money slot on it:
 *   THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee
 *
 * The map (IDENTITY_SYNONYMS) already existed and already guaranteed the BARE TOKEN reached the
 * pool. What it could not do is make the synonym CHOOSABLE for the title: the money-tail derivation
 * (listingPipeline.ts:7660) only considers 3-5 word candidates carrying a garment noun, and
 * "football" is one word — so the required synonym was structurally unable to win the slot it is
 * required to win. `identitySynonymPhrases` closes exactly that gap, and nothing else.
 */

describe('guaranteedIdentitySynonyms — the bare token (pre-existing, pinned)', () => {
  it('a soccer design gains football + futbol', () => {
    expect(guaranteedIdentitySynonyms('2026 World Soccer Cup').map((s) => s.synonym).sort())
      .toEqual(['football', 'futbol'])
  })
  it('ASYMMETRIC: a gridiron football design gains nothing (never admits soccer)', () => {
    expect(guaranteedIdentitySynonyms('Friday Night Football Mom Tee')).toEqual([])
  })
})

describe('identitySynonymPhrases — the synonym in a form the money selector can choose', () => {
  const SOCCER_POOL = [
    'usa mexico canada soccer tee',
    'soccer jersey women',
    'world soccer cup shirt',
    'soccer supporter tee',
    'graphic tees for women',
  ]

  it('mirrors the market phrase into the sibling term, 3-5 words with the garment noun intact', () => {
    const out = identitySynonymPhrases(SOCCER_POOL, 'THE CEO 2026 World Soccer Cup Tee')
    const phrases = out.map((p) => p.phrase)
    // THE PO'S OWN MONEY KEYWORD, derived rather than hardcoded.
    expect(phrases).toContain('usa mexico canada football tee')
    expect(phrases).toContain('football jersey women')
    // Every mirror names the real pool row it inherits its opportunity from.
    for (const p of out) expect(SOCCER_POOL).toContain(p.source)
  })

  it('THE ADJACENCY GUARD: only the modifier position is substituted, never a fixed phrase', () => {
    // "world soccer cup" is the seller's trademark SUBSTITUTION for the FIFA mark
    // (trademarkGuard.ts:19), not a category modifier — "world football cup shirt" is not a search.
    // The token there is followed by "cup", not by a garment noun, so it is never touched.
    const phrases = identitySynonymPhrases(SOCCER_POOL, 'World Soccer Cup').map((p) => p.phrase)
    expect(phrases).not.toContain('world football cup shirt')
    expect(phrases).not.toContain('world futbol cup shirt')
    for (const p of phrases) expect(p).not.toMatch(/\b(?:football|futbol)\s+cup\b/)
    // "soccer supporter tee" — "supporter" is not a garment noun either, so it stays soccer.
    expect(phrases).not.toContain('football supporter tee')
  })

  it('never mints a phrase the pool already has, and never a duplicate', () => {
    const pool = [...SOCCER_POOL, 'usa mexico canada football tee']
    const phrases = identitySynonymPhrases(pool, 'World Soccer Cup Tee').map((p) => p.phrase)
    expect(phrases.filter((p) => p === 'usa mexico canada football tee')).toEqual([])
    expect(new Set(phrases).size).toBe(phrases.length)
  })

  it('ASYMMETRIC, same as the map it extends: a gridiron listing yields nothing', () => {
    expect(identitySynonymPhrases(['sunday football tee', 'football jersey women'], 'Friday Night Football Mom')).toEqual([])
  })

  it('is inert on every non-soccer listing (no identity key ⇒ zero pool change)', () => {
    expect(identitySynonymPhrases(['christian shirts for women', 'faith tee shirt'], 'I Will Praise Him in Every Season')).toEqual([])
    expect(identitySynonymPhrases([], null, undefined)).toEqual([])
  })

  it('the mirrored phrase is ON-IDENTITY, so the pool relevance gate keeps it', () => {
    // A phrase the gate would drop is worse than useless — it would be injected and then filtered.
    const identity = identityTokensOf('THE CEO 2026 World Soccer Cup Tee', null, null)
    for (const { phrase } of identitySynonymPhrases(SOCCER_POOL, 'THE CEO 2026 World Soccer Cup Tee')) {
      expect(keywordIsRelevant(phrase, identity), phrase).toBe(true)
    }
  })

  it('every mirror satisfies the money-tail derivation shape (3-5 words + a garment noun)', () => {
    // This is the whole point of the change: the bare token could never pass this filter.
    const MT_GARMENT_RE = /\b(?:t-?shirts?|tshirts?|shirts?|tees?)\b/i
    const winners = identitySynonymPhrases(SOCCER_POOL, 'THE CEO 2026 World Soccer Cup Tee')
      .map((p) => p.phrase)
      .filter((p) => { const n = p.trim().split(/\s+/).length; return n >= 3 && n <= 5 && MT_GARMENT_RE.test(p) })
    expect(winners).toContain('usa mexico canada football tee')
    expect(MT_GARMENT_RE.test('football')).toBe(false)   // the bare token never could
  })
})
