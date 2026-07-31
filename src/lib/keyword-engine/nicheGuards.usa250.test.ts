import { describe, it, expect } from 'vitest'
import { isOffNicheKeyword } from './nicheGuards'

// Live specimens (B0GR22ZHBW, 2026-07-31): America-250 event terms seated as CRITICAL on a
// vow-renewal WEDDING-anniversary tee while the LLM relevance gate was dead (PR #460).
const WEDDING_CTX = { context: 'THE CEO We Still Do Anniversary T-Shirt vow renewal wedding vows marriage husband wife' }
const PATRIOTIC_CTX = { context: 'THE CEO America 250th Anniversary Patriotic USA Flag Shirt 1776' }

describe('isOffNicheKeyword — USA-250 dated public event', () => {
  it('drops the two live CRITICAL specimens on a wedding-anniversary listing', () => {
    expect(isOffNicheKeyword('250th anniversary usa shirt', WEDDING_CTX)).toBe(true)
    expect(isOffNicheKeyword('250 anniversary usa merchandise', WEDDING_CTX)).toBe(true)
  })
  it('drops standalone semiquincentennial on a non-patriotic listing', () => {
    expect(isOffNicheKeyword('semiquincentennial shirt', WEDDING_CTX)).toBe(true)
  })
  it('KEEPS the terms on a genuinely patriotic USA-250 design (context escape)', () => {
    expect(isOffNicheKeyword('250th anniversary usa shirt', PATRIOTIC_CTX)).toBe(false)
    expect(isOffNicheKeyword('america 250 merchandise', PATRIOTIC_CTX)).toBe(false)
  })
  it('never touches the wearer\'s own anniversary terms', () => {
    expect(isOffNicheKeyword('25th anniversary gift', WEDDING_CTX)).toBe(false)
    expect(isOffNicheKeyword('anniversary shirt for couples', WEDDING_CTX)).toBe(false)
    expect(isOffNicheKeyword('50th wedding anniversary', WEDDING_CTX)).toBe(false)
  })
  it('a plain 250 with no USA signal is not an event term', () => {
    expect(isOffNicheKeyword('250 piece design bundle', WEDDING_CTX)).toBe(false)
  })
})

import { hasDatedEventContamination } from './nicheGuards'

describe('hasDatedEventContamination — soup-level test for the preserve seam', () => {
  // The live stored string that the preserve kept re-persisting over clean fresh output.
  const DIRTY_SOUP = 'we still do women men 250th anniversary usa shirt 250 merchandise unisex graphic tee couples married vow renewal husband wife newlywed jet ebony charcoal cotton fit'
  it('flags the live contaminated backend soup on a wedding title', () => {
    expect(hasDatedEventContamination(DIRTY_SOUP, { context: 'THE CEO We Still Do Anniversary T-Shirt for Men and Women' })).toBe(true)
  })
  it('a clean soup passes', () => {
    expect(hasDatedEventContamination('we still do anniversary couples married vow renewal wedding husband wife tee', { context: 'THE CEO We Still Do Anniversary T-Shirt' })).toBe(false)
  })
  it('a genuinely patriotic listing keeps its soup (context escape)', () => {
    expect(hasDatedEventContamination(DIRTY_SOUP, { context: 'THE CEO America 250th Anniversary Patriotic USA Shirt' })).toBe(false)
  })
  it('empty input is never contaminated', () => {
    expect(hasDatedEventContamination('', {})).toBe(false)
  })
})
