/**
 * nativeMarketMetrics.test.ts — PO data-truth rule 2026-08-08.
 * ─────────────────────────────────────────────────────────────────────────────
 * Pins the two pure helpers this change introduced:
 *   1. engine.nativeMarketMetrics — the ONLY producer of the per-keyword native market metrics
 *      (js_ease_of_ranking / js_relevancy_score / market_opportunity). Must be coverage-independent
 *      and must return null (honest "not measured"), never a fabricated 0, when data is absent.
 *   2. rankAnalysis.rankOpportunityKey — the RANK panel top-10 sort key: NATIVE metric leads,
 *      per-row composite fallback only when native is absent.
 * Also pins that marketOpportunity === poolOpportunityScore (ONE portal-wide definition — the
 * /fba/keywords pool dashboard and the listing RANK panel must never disagree about a 7.2).
 */
import { describe, it, expect } from 'vitest'
import { nativeMarketMetrics } from './engine'
import { poolOpportunityScore } from './poolOpportunity'
import { rankOpportunityKey } from '../fba/rankAnalysis'

describe('nativeMarketMetrics', () => {
  it('mirrors poolOpportunityScore exactly — ONE opportunity definition portal-wide', () => {
    const row = { searchVolume: 12000, organicProductCount: 800, easeOfRankingScore: 62, relevancyScore: 140 }
    const m = nativeMarketMetrics(row)
    expect(m.marketOpportunity).toBe(poolOpportunityScore({
      searchVolume: row.searchVolume,
      organicProductCount: row.organicProductCount,
      easeOfRankingScore: row.easeOfRankingScore,
    }))
    expect(m.jsEaseOfRanking).toBe(62)
    expect(m.jsRelevancyScore).toBe(140)
  })

  it('is coverage-independent: no presence/coverage input exists in its signature', () => {
    // The type admits only market fields — this test documents the contract; the real enforcement
    // is the parameter type itself (same discipline as selection-core's TargetInput omissions).
    const m1 = nativeMarketMetrics({ searchVolume: 5000, organicProductCount: 300, easeOfRankingScore: 40 })
    const m2 = nativeMarketMetrics({ searchVolume: 5000, organicProductCount: 300, easeOfRankingScore: 40 })
    expect(m1).toEqual(m2) // deterministic — nothing about OUR listing can move it
  })

  it('returns null marketOpportunity (n/a), never a fabricated 0, when volume is absent/zero', () => {
    expect(nativeMarketMetrics({}).marketOpportunity).toBeNull()
    expect(nativeMarketMetrics({ searchVolume: 0, easeOfRankingScore: 90 }).marketOpportunity).toBeNull()
    // A synthetic attributeAsKeyword row (searchVolume 0) must surface as "not measured".
    expect(nativeMarketMetrics({ searchVolume: 0 }).jsEaseOfRanking).toBeNull()
  })

  it('rounds ease/relevancy to integers (INTEGER columns) and tolerates missing ease', () => {
    const m = nativeMarketMetrics({ searchVolume: 1000, easeOfRankingScore: 71.6, relevancyScore: 2338.4 })
    expect(m.jsEaseOfRanking).toBe(72)
    expect(m.jsRelevancyScore).toBe(2338)
    // ease missing → poolOpportunityScore's low-competition fallback still yields a score.
    const noEase = nativeMarketMetrics({ searchVolume: 1000, organicProductCount: 500 })
    expect(noEase.jsEaseOfRanking).toBeNull()
    expect(noEase.marketOpportunity).not.toBeNull()
  })
})

describe('rankOpportunityKey', () => {
  it('uses the NATIVE metric (×10 onto the nominal 0-100 axis) when present', () => {
    expect(rankOpportunityKey({ marketOpportunity: 7.2, coverageGapScore: 99 })).toBe(72)
  })

  it('falls back to the composite ONLY when native is absent', () => {
    expect(rankOpportunityKey({ marketOpportunity: null, coverageGapScore: 52 })).toBe(52)
  })

  it('native 0 is a real measured value, not a fallback trigger', () => {
    expect(rankOpportunityKey({ marketOpportunity: 0, coverageGapScore: 52 })).toBe(0)
  })

  it('the PO 52→19 swing cannot move a native-carrying row: key is composite-invariant', () => {
    const before = rankOpportunityKey({ marketOpportunity: 6.1, coverageGapScore: 52 })
    const after = rankOpportunityKey({ marketOpportunity: 6.1, coverageGapScore: 19 })
    expect(before).toBe(after)
  })
})
