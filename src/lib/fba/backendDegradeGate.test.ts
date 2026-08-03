import { describe, it, expect } from 'vitest'
import {
  tryParsePriorKeywords,
  minKeywordBytes,
  shouldPreserveKeywords,
  descriptionVisibleLength,
  shouldPreserveDescription,
} from './backendDegradeGate'

// Shared preserve rules for the DEGRADE-MARKED sections — the dual-write-path parity net (#157).
// Live specimens encoded: the 898-vs-719 description inversion (PR #468), the clean-214B-vs-
// dirty-246B contamination ratchet (PR #470), the 70B-over-207B partial silent-ship (task #103).

const row = (keywords: string, sku = 'SKU', asin = 'ASIN') => ({ sku, asin, keywords })

describe('tryParsePriorKeywords', () => {
  it('parses a valid non-empty array', () => {
    const prior = tryParsePriorKeywords(JSON.stringify([row('valentine tee wife gift')]))
    expect(prior).not.toBeNull()
    expect(prior![0].keywords).toBe('valentine tee wife gift')
  })
  it('rejects null / empty / non-array / all-blank-keywords / malformed JSON', () => {
    expect(tryParsePriorKeywords(null)).toBeNull()
    expect(tryParsePriorKeywords('')).toBeNull()
    expect(tryParsePriorKeywords('"a string"')).toBeNull()
    expect(tryParsePriorKeywords('[]')).toBeNull()
    expect(tryParsePriorKeywords(JSON.stringify([row(''), row('  ')]))).toBeNull()
    expect(tryParsePriorKeywords('not json')).toBeNull()
  })
})

describe('minKeywordBytes — worst-child comparator', () => {
  it('returns the minimum non-empty byte length', () => {
    expect(minKeywordBytes([row('a'.repeat(240)), row('b'.repeat(207))])).toBe(207)
  })
  it('ignores empty rows; 0 when nothing non-empty', () => {
    expect(minKeywordBytes([row(''), row('abc')])).toBe(3)
    expect(minKeywordBytes([])).toBe(0)
    expect(minKeywordBytes(null)).toBe(0)
  })
  it('measures BYTES not chars (multi-byte)', () => {
    expect(minKeywordBytes([row('fútbol')])).toBe(7)
  })
})

describe('shouldPreserveKeywords — better-than-prior + contamination guard', () => {
  it('preserves: prior 207B beats fresh 70B (the task #103 specimen)', () => {
    expect(shouldPreserveKeywords({
      prior: [row('k'.repeat(207))],
      fresh: [row('k'.repeat(70))],
      contaminatedPrior: false,
    })).toBe(true)
  })
  it('ships fresh: fresh 214B beats prior 197B (better-than-prior amendment)', () => {
    expect(shouldPreserveKeywords({
      prior: [row('k'.repeat(197))],
      fresh: [row('k'.repeat(214))],
      contaminatedPrior: false,
    })).toBe(false)
  })
  it('NEVER preserves a contaminated prior even when longer (PR #470 ratchet fix: dirty 246B loses to clean 214B)', () => {
    expect(shouldPreserveKeywords({
      prior: [row('usa 250th anniversary tee ' + 'k'.repeat(220))],
      fresh: [row('k'.repeat(214))],
      contaminatedPrior: true,
    })).toBe(false)
  })
  it('no prior → ship fresh (new-listing branch: short output better than nothing)', () => {
    expect(shouldPreserveKeywords({ prior: null, fresh: [row('k'.repeat(50))], contaminatedPrior: false })).toBe(false)
    expect(shouldPreserveKeywords({ prior: [], fresh: [row('k')], contaminatedPrior: false })).toBe(false)
  })
  it('empty fresh (0 bytes) loses to any non-empty prior', () => {
    expect(shouldPreserveKeywords({ prior: [row('k'.repeat(190))], fresh: [], contaminatedPrior: false })).toBe(true)
  })
})

describe('descriptionVisibleLength + shouldPreserveDescription', () => {
  it('strips tags before measuring', () => {
    expect(descriptionVisibleLength('<b>Hi</b><ul><li>there</li></ul>')).toBe(7)
    expect(descriptionVisibleLength(null)).toBe(0)
  })
  it('preserves: prior 977 visible beats fresh 719', () => {
    expect(shouldPreserveDescription('<p>' + 'x'.repeat(977) + '</p>', 'x'.repeat(719))).toBe(true)
  })
  it('ships fresh: under-floor fresh 898 still beats prior 719 (PR #468 inversion fix)', () => {
    expect(shouldPreserveDescription('x'.repeat(719), 'x'.repeat(898))).toBe(false)
  })
  it('blank prior → never preserve', () => {
    expect(shouldPreserveDescription('', 'x'.repeat(100))).toBe(false)
    expect(shouldPreserveDescription('   ', 'x'.repeat(100))).toBe(false)
    expect(shouldPreserveDescription(null, '')).toBe(false)
  })
})
