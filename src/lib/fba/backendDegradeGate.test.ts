import { describe, it, expect } from 'vitest'
import {
  tryParsePriorKeywords,
  minKeywordBytes,
  shouldPreserveKeywords,
  cappedMinKeywordBytes,
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PRESERVE RATCHET — an over-cap prior must not beat every possible fresh output for ever.
 *
 * LIVE INCIDENT (B0GVV3XL4T, diagnosed 2026-08-10). `scrubPub` runs AFTER the fill's 250-byte cap
 * and `scrubTrademarks` LENGTHENS what it rewrites ("world cup" -> "world soccer cup"), so the
 * STORED prior was 251 bytes. Fresh output is hard-capped at 250. The comparator was raw
 * `minKeywordBytes(prior) > minKeywordBytes(fresh)`, so 251 > (anything <= 250) was TRUE for every
 * possible regeneration — the family's 98 children stayed byte-identical from June to August while
 * each regen advanced generated_at and silently re-preserved the fossil. The keyword pool changed
 * completely underneath it (0 -> 15+ on-theme rows) and none of it could ever reach the bytes.
 *
 * Amazon never receives that byte anyway — the push boundary re-caps at 250 (pushFields.ts:101).
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('preserve ratchet — over-cap prior cannot win for ever', () => {
  const rows = (n: number) => [{ sku: 's', asin: 'a', keywords: 'x'.repeat(n) }]

  it('cappedMinKeywordBytes clamps at the contract byte cap', () => {
    expect(cappedMinKeywordBytes(rows(251))).toBe(250)
    expect(cappedMinKeywordBytes(rows(260))).toBe(250)
    expect(cappedMinKeywordBytes(rows(244))).toBe(244)   // under cap is untouched
  })

  it('THE BUG: a 251-byte prior no longer beats a 250-byte fresh', () => {
    expect(shouldPreserveKeywords({ prior: rows(251), fresh: rows(250), contaminatedPrior: false })).toBe(false)
  })

  it('and it no longer beats a fresh output at ANY legal size — the ratchet is gone', () => {
    for (const freshBytes of [220, 230, 240, 244, 248, 249, 250]) {
      expect(
        shouldPreserveKeywords({ prior: rows(251), fresh: rows(freshBytes), contaminatedPrior: false }),
        `251-byte prior must not beat a ${freshBytes}-byte fresh`,
      ).toBe(freshBytes < 250)   // only genuinely-thinner fresh loses, and only on merit
    }
  })

  it('the rule still does its REAL job: a genuinely longer prior WITHIN the cap still wins', () => {
    expect(shouldPreserveKeywords({ prior: rows(248), fresh: rows(200), contaminatedPrior: false })).toBe(true)
    expect(shouldPreserveKeywords({ prior: rows(230), fresh: rows(244), contaminatedPrior: false })).toBe(false)
  })

  it('a contaminated prior still never wins, over-cap or not', () => {
    expect(shouldPreserveKeywords({ prior: rows(251), fresh: rows(200), contaminatedPrior: true })).toBe(false)
  })
})
