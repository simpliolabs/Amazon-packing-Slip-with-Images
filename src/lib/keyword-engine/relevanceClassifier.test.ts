import { describe, it, expect } from 'vitest'
import { buildRelevancePrompt, parseRelevanceVerdict } from './relevanceClassifier'

describe('buildRelevancePrompt — v2=false (pre-V2, byte-identical to shipped)', () => {
  const kwBlock = '0: valentine shirt\n1: art teacher clothes'
  const ctx = { title: 'THE CEO Cupid Comfort Colors Shirt for Women', brand: 'THE CEO', category: 'apparel / graphic t-shirt', designTheme: 'Cupid', audienceLean: 'lean_female' }

  it('does NOT include the Design theme / Audience lean block', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx, false)
    expect(user).not.toMatch(/Design theme/i)
    expect(user).not.toMatch(/Audience lean/i)
  })

  it('does NOT include Rule 6 (WRONG-THEME merch)', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx, false)
    expect(user).not.toMatch(/WRONG[-\s]?THEME/i)
    expect(user).not.toMatch(/\b6\.\s/)
  })

  it('DOES include the pre-V2 5 rules', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx, false)
    expect(user).toMatch(/1\. CELEBRITY/)
    expect(user).toMatch(/2\. FOREIGN-LANGUAGE/)
    expect(user).toMatch(/5\. An ADJACENT-but-different/)
  })
})

describe('buildRelevancePrompt — v2=true', () => {
  const kwBlock = '0: valentine shirt\n1: art teacher clothes'
  const ctx = { title: 'THE CEO Cupid Comfort Colors Shirt for Women', brand: 'THE CEO', category: 'apparel / graphic t-shirt', designTheme: 'Cupid', audienceLean: 'lean_female' }

  it('INCLUDES the design theme in the prompt', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx, true)
    expect(user).toMatch(/Design theme:\s*Cupid/)
  })

  it('INCLUDES the audience lean in the prompt', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx, true)
    expect(user).toMatch(/Audience lean:\s*lean_female/)
  })

  it('INCLUDES Rule 6 with WRONG-THEME language', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx, true)
    expect(user).toMatch(/6\.\s*WRONG-THEME/)
    expect(user).toMatch(/art teacher/i)
  })

  it('with blank designTheme + null audienceLean, still SAFE (no crash, no leaked "undefined")', () => {
    const { user } = buildRelevancePrompt(kwBlock, { title: 't', designTheme: null, audienceLean: null }, true)
    expect(user).not.toMatch(/undefined/)
    expect(user).not.toMatch(/null/)
  })

  it('omits the design block entirely when BOTH designTheme AND audienceLean are absent', () => {
    // Prevents polluting the prompt with an empty header when the classifier has nothing to say.
    const { user } = buildRelevancePrompt(kwBlock, { title: 't' }, true)
    expect(user).not.toMatch(/Design theme:/)
    expect(user).not.toMatch(/Audience lean:/)
  })

  it('KEEPS the pre-V2 5 rules alongside Rule 6', () => {
    const { user } = buildRelevancePrompt(kwBlock, ctx, true)
    expect(user).toMatch(/1\. CELEBRITY/)
    expect(user).toMatch(/5\. An ADJACENT-but-different/)
    expect(user).toMatch(/6\.\s*WRONG-THEME/)
  })

  it('the system message is unchanged between v2 modes', () => {
    const { system: s1 } = buildRelevancePrompt(kwBlock, ctx, false)
    const { system: s2 } = buildRelevancePrompt(kwBlock, ctx, true)
    expect(s1).toBe(s2)
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
