import { describe, it, expect } from 'vitest'
import { buildRelevancePrompt, parseRelevanceVerdict } from './relevanceClassifier'

// RELEVANCE_THEME_V2 retired 2026-08-03 at live UNSET: the pre-V2 prompt below IS the shipped
// behavior; these assertions pin it. The v2=true / buildThemeOnlyPrompt suites died with the branch
// (git ref: pre-1732d8f).
describe('buildRelevancePrompt — the shipped prompt', () => {
  const kwBlock = '0: valentine shirt\n1: art teacher clothes'
  const ctx = { title: 'THE CEO Cupid Comfort Colors Shirt for Women', brand: 'THE CEO', category: 'apparel / graphic t-shirt' }

  it('does NOT include the retired Design theme / Audience lean block', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx)
    // Anchored to the HEADER lines the retired v2 block emitted — the unconditional KEEP sentence
    // legitimately says "the design theme" in prose (added with #441), which a loose
    // /Design theme/i would false-flag.
    expect(user).not.toMatch(/^Design theme:/m)
    expect(user).not.toMatch(/^Audience lean:/m)
  })

  it('does NOT include the retired Rule 6 (WRONG-THEME merch)', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx)
    expect(user).not.toMatch(/WRONG[-\s]?THEME/i)
    expect(user).not.toMatch(/\b6\.\s/)
  })

  it('DOES include the 5 rules', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx)
    expect(user).toMatch(/1\. CELEBRITY/)
    expect(user).toMatch(/2\. FOREIGN-LANGUAGE/)
    expect(user).toMatch(/5\. An ADJACENT-but-different/)
  })

  it('carries title/brand/category and the JSON-only system contract', () => {
    const { system, user } = buildRelevancePrompt(kwBlock, ctx)
    expect(system).toMatch(/ONLY valid JSON/)
    expect(user).toMatch(/Title: THE CEO Cupid/)
    expect(user).toMatch(/Brand: THE CEO/)
    expect(user).toMatch(/Category: apparel \/ graphic t-shirt/)
  })
})

describe('parseRelevanceVerdict — pure parse+guard', () => {
  const uniq = ['valentine shirt', 'art teacher clothes', 'nurse t-shirt', 'cupid tee']

  it('returns the indexed keywords', () => {
    const drop = parseRelevanceVerdict('{"drop":[1,2]}', uniq)
    expect([...drop].sort()).toEqual(['art teacher clothes', 'nurse t-shirt'].sort())
  })

  it('ignores out-of-range indices', () => {
    const drop = parseRelevanceVerdict('{"drop":[1,42,-1,"nope"]}', uniq)
    expect([...drop]).toEqual(['art teacher clothes'])
  })

  it('returns empty set on malformed JSON', () => {
    expect(parseRelevanceVerdict('not json', uniq).size).toBe(0)
    expect(parseRelevanceVerdict('', uniq).size).toBe(0)
    expect(parseRelevanceVerdict('{"drop": "not an array"}', uniq).size).toBe(0)
  })

  it('applies never-collapse >50% floor (returns EMPTY when drop >half)', () => {
    // 3/4 = 75% > 50% → verdict rejected as misfire, empty set returned
    const drop = parseRelevanceVerdict('{"drop":[0,1,2]}', uniq)
    expect(drop.size).toBe(0)
  })

  it('drop == 50% exactly is KEPT (only >half rejects)', () => {
    // 2/4 = 50% ≤ 50% → verdict accepted
    const drop = parseRelevanceVerdict('{"drop":[0,1]}', uniq)
    expect(drop.size).toBe(2)
  })
})
