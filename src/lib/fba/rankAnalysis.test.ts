import { describe, it, expect } from 'vitest'
import { contentActionFor, rankRowCompare, rankOpportunityKey, deriveLiveActionType, sameCopyEpoch, type ActionType } from './rankAnalysis'
import { deriveActionType } from '@/lib/keyword-engine/calculateScore'

/* 2026-08-08 rank-row coherence (screenshot bug: ✗ icon + "PROMOTE — present" in ONE row).
 * Two pure rules under test:
 *   1. contentActionFor must NEVER assert a presence it wasn't handed — action_type is a
 *      research-time snapshot and deriveActionType's score>=20 fallback labels zero-presence
 *      keywords UPGRADE, so "UPGRADE ⇒ present" was never an invariant.
 *   2. rankRowCompare's tie-break prefers UNCOVERED (the old inline comparator was inverted
 *      against its own "prefer uncovered" comment). */

const ACTION_TYPES: ActionType[] = ['CRITICAL', 'UPGRADE', 'REINFORCE', 'DEFENDED', 'OPTIMIZED']

describe('contentActionFor — never asserts un-handed presence', () => {
  it('UPGRADE + not covered → ADD, never "PROMOTE — present"', () => {
    expect(contentActionFor('UPGRADE', false, false)).toBe('ADD — high-opportunity term not yet in your copy')
  })

  it('DEFENDED + not covered → ADD, never "DEFEND — you\'re covered"', () => {
    expect(contentActionFor('DEFENDED', false, false)).toBe('ADD — high-opportunity term not yet in your copy')
  })

  it('CRITICAL + not covered → ADD (unchanged)', () => {
    expect(contentActionFor('CRITICAL', false, false)).toBe('ADD — high-opportunity term not yet in your copy')
  })

  it('sweep: for EVERY actionType, youCover=false text never claims presence/coverage', () => {
    for (const at of ACTION_TYPES) {
      for (const inTitle of [false, true]) {
        const out = contentActionFor(at, false, inTitle)
        expect(out, `${at} inTitle=${inTitle}: "${out}"`).not.toMatch(/PROMOTE|DEFEND|COVERED|present|covered/)
      }
    }
  })

  it('UPGRADE + covered + not in title → PROMOTE (the true promote case survives)', () => {
    expect(contentActionFor('UPGRADE', true, false)).toBe('PROMOTE — present, pull into the title (higher weight)')
  })

  it('UPGRADE + covered + already in title → COVERED', () => {
    expect(contentActionFor('UPGRADE', true, true)).toMatch(/^COVERED/)
  })

  it('DEFENDED + covered → DEFEND (unchanged)', () => {
    expect(contentActionFor('DEFENDED', true, true)).toBe("DEFEND — you're covered here; hold it")
  })

  it('pre-existing branches untouched: IRRELEVANT / not-a-target / BACKEND slot', () => {
    expect(contentActionFor('IRRELEVANT' as ActionType, false, false)).toMatch(/^SKIP — off-product/)
    expect(contentActionFor('UPGRADE', false, false, false)).toMatch(/^SKIP — not a ranking target/)
    expect(contentActionFor('UPGRADE', false, false, true, 'BACKEND')).toMatch(/^BACKEND — off-season/)
  })
})

describe('rankRowCompare — market opportunity desc, then UNCOVERED first', () => {
  const row = (marketOpportunity: number | null, coverageGapScore: number, youCover: boolean) =>
    ({ marketOpportunity, coverageGapScore, youCover })

  it('equal keys: uncovered sorts BEFORE covered (the inverted tie-break, fixed)', () => {
    const covered = row(7, 50, true)
    const uncovered = row(7, 50, false)
    expect(rankRowCompare(uncovered, covered)).toBeLessThan(0)
    expect([covered, uncovered].sort(rankRowCompare)[0]).toBe(uncovered)
  })

  it('higher market opportunity leads regardless of coverage', () => {
    const hiCovered = row(9, 10, true)
    const loUncovered = row(3, 10, false)
    expect([loUncovered, hiCovered].sort(rankRowCompare)[0]).toBe(hiCovered)
  })

  it('null native falls back to the composite on one 0-100 axis (rankOpportunityKey)', () => {
    expect(rankOpportunityKey(row(5, 40, false))).toBe(50)   // native 5 × 10
    expect(rankOpportunityKey(row(null, 40, false))).toBe(40) // composite as-is
    expect([row(null, 40, false), row(5, 0, true)].sort(rankRowCompare)[0]).toEqual(row(5, 0, true))
  })
})

describe('deriveLiveActionType — the =on display re-derivation (one decision, one freshness)', () => {
  const cov = (o: Partial<{ covered: boolean; inTitle: boolean; inBullets: boolean; inDescription: boolean; inBackend: boolean }> = {}) =>
    ({ covered: false, inTitle: false, inBullets: false, inDescription: false, inBackend: false, ...o })

  it('IRRELEVANT passes through untouched (relevance authority stays with the classifier)', () => {
    expect(deriveLiveActionType('IRRELEVANT', 90, cov({ covered: true, inBackend: true }))).toBe('IRRELEVANT')
    expect(deriveLiveActionType('IRRELEVANT', 90, cov())).toBe('IRRELEVANT')
  })

  it('COVERED-ELSEWHERE guard: backend/description-only coverage + score>=50 → DEFENDED, never a red CRITICAL beside a green ✓ (the standard post-push state)', () => {
    expect(deriveLiveActionType('CRITICAL', 60, cov({ covered: true, inBackend: true }))).toBe('DEFENDED')
    expect(deriveLiveActionType('CRITICAL', 60, cov({ covered: true, inDescription: true }))).toBe('DEFENDED')
    expect(deriveLiveActionType('CRITICAL', 60, cov({ covered: true, inDescription: true, inBackend: true }))).toBe('DEFENDED')
  })

  it('cross-field coverage (covered:true, every flag false) also never renders CRITICAL', () => {
    expect(deriveLiveActionType('CRITICAL', 60, cov({ covered: true }))).toBe('DEFENDED')
  })

  it('live-uncovered high score stays CRITICAL — a stored CRITICAL cannot be spuriously downgraded', () => {
    expect(deriveLiveActionType('CRITICAL', 60, cov())).toBe('CRITICAL')
    expect(deriveLiveActionType('OPTIMIZED', 60, cov())).toBe('CRITICAL')  // live re-derivation, stored value irrelevant
  })

  it('bullets-only coverage still derives UPGRADE (the true promote case survives the guard)', () => {
    expect(deriveLiveActionType('UPGRADE', 40, cov({ covered: true, inBullets: true }))).toBe('UPGRADE')
  })

  it('KNOWN BIAS (documented, accepted): a research-covered keyword later DROPPED from copy under-tiers to UPGRADE — its stored score is gap-amplified (~raw/3)', () => {
    // covered at research: raw 90 × multiplier 1.0 / 3 = 30 stored; copy later drops it → zero live presence
    expect(deriveLiveActionType('OPTIMIZED', 30, cov())).toBe('UPGRADE')  // not CRITICAL — see deriveLiveActionType docstring
  })
})

describe('sameCopyEpoch — the council-headline carry gate (pool-only fingerprint moves)', () => {
  it('same copy half, different pool half → true (heal restamp/re-research must not wipe the PAID headline)', () => {
    expect(sameCopyEpoch('aaa:p1', 'aaa:p2')).toBe(true)
  })
  it('copy half moved → false (real copy changes reset the headline)', () => {
    expect(sameCopyEpoch('aaa:p1', 'bbb:p1')).toBe(false)
  })
  it('legacy single-hash / absent stored fingerprint → false (fails toward a full reset)', () => {
    expect(sameCopyEpoch('deadbeef', 'aaa:p1')).toBe(false)
    expect(sameCopyEpoch(null, 'aaa:p1')).toBe(false)
    expect(sameCopyEpoch(undefined, 'aaa:p1')).toBe(false)
    expect(sameCopyEpoch('', 'aaa:p1')).toBe(false)
  })
})

describe('deriveActionType — the display re-derivation input (and the trap the net guards)', () => {
  it('TRAP DOCUMENTED: score>=20 with ZERO presence is UPGRADE — "UPGRADE ⇒ present" is NOT an invariant', () => {
    expect(deriveActionType(30, { inTitle: false, inBullets: false, coverageCount: 0 })).toBe('UPGRADE')
  })

  it('live per-field flags re-derive coherently (the buildFreeCore =on path input shape)', () => {
    expect(deriveActionType(60, { inTitle: false, inBullets: false, coverageCount: 0 })).toBe('CRITICAL')
    expect(deriveActionType(40, { inTitle: false, inBullets: true, coverageCount: 2 })).toBe('UPGRADE')
    expect(deriveActionType(30, { inTitle: true, inBullets: false, coverageCount: 1 })).toBe('REINFORCE')
    expect(deriveActionType(90, { inTitle: true, inBullets: true, coverageCount: 2 })).toBe('DEFENDED')
    expect(deriveActionType(10, { inTitle: false, inBullets: true, coverageCount: 3 })).toBe('OPTIMIZED')
    expect(deriveActionType(5, { inTitle: false, inBullets: false, coverageCount: 0 })).toBe('OPTIMIZED')
  })
})
