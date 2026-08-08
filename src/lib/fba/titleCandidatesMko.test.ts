/**
 * titleCandidatesMko.test.ts — the ease-aware TITLE tiebreak (PO 2026-08-08 3-factor rule).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * `selectTitleCandidates` sorts by coverageGapScore DESC (gap-chasing for placement is locked
 * doctrine) with ties-only tiebreaks. This suite pins the NEW first tiebreak, `mkoRank`:
 * marketOpportunity ≥ 6 (native, demand-gated 0-10 — migration 055) wins a composite TIE.
 *
 * The named acceptance case is B0FKKN8XKV: "cute christian shirts for women" (3,749/mo, ease 100,
 * marketOpportunity 6.2) must qualify as a title/placement candidate instead of being buried by
 * volume-correlated composite ordering. The constraints pinned here:
 *   - TIES ONLY: a higher coverageGapScore ALWAYS wins, whatever the opportunity says —
 *     CRITICAL money keywords keep first claim.
 *   - STRICT NO-OP without native data: null/absent marketOpportunity sorts byte-identically.
 *   - The ≥6 threshold is the JS niche-score "strong" band; 5.9 does not promote.
 */
import { describe, it, expect } from 'vitest'
import { selectTitleCandidates } from './listingPipeline'
import type { SeasonPolicy } from './listingPipeline'
import type { AnalyzedKeyword } from '../keyword-engine/engine'

/** Inert season policy: nothing is off-season, no diff logging — isolates the sort under test. */
const SEASON: SeasonPolicy = { derived: [], effective: [], isOffSeason: () => false, diff: () => {} }

const mk = (o: Partial<AnalyzedKeyword> & { keyword: string }): AnalyzedKeyword => ({
  coverageGapScore: 50,
  actionType: 'UPGRADE',
  actionText: '',
  rationale: '',
  urgency: 'medium',
  estimatedImpact: '',
  searchVolume: 1_000,
  keywordSales: 0,
  competingProducts: 1_000,
  asinImpressionShare: 0,
  asinClickShare: 0,
  asinPurchaseShare: 0,
  inTitle: false,
  inBullets: false,
  inDescription: false,
  inBackend: false,
  dataSource: 'jungle_scout',
  titleDensity: null,
  organicRank: null,
  ...o,
})

const keywords = (rows: AnalyzedKeyword[]): string[] =>
  selectTitleCandidates(rows, 'THE CEO', null, SEASON).map((c) => c.keyword)

/* Seven mutually non-overlapping filler candidates (wordOverlapRatio < 0.5 pairwise and against the
 * acceptance keyword), all at the SAME composite so the sort's tie zone is fully exercised. */
const PEERS = [
  'alpha bravo charlie tee',
  'delta echo foxtrot hoodie',
  'golf hotel india sweatshirt',
  'juliet kilo lima top',
  'mike november oscar crewneck',
  'papa quebec romeo pullover',
  'sierra tango uniform blouse',
]

describe('mkoRank — ease-aware TIES-ONLY tiebreak in selectTitleCandidates', () => {
  it.each<[string, number | null | undefined, boolean]>([
    ['opportunity 6.2 (≥6, the JS "strong" band) wins the tie', 6.2, true],
    ['opportunity exactly 6 wins the tie', 6, true],
    ['opportunity 5.9 (below threshold) does NOT promote', 5.9, false],
    ['opportunity null (SQP/import row) is a strict no-op', null, false],
    ['opportunity absent (pre-migration-054 row) is a strict no-op', undefined, false],
  ])('%s', (_name, mo, promoted) => {
    const rows = [
      mk({ keyword: 'comfort colors tshirt' }), // input-first at the same composite (stable sort)
      mk({ keyword: 'cute christian shirts for women', marketOpportunity: mo }),
    ]
    const out = keywords(rows)
    expect(out[0]).toBe(promoted ? 'cute christian shirts for women' : 'comfort colors tshirt')
  })

  it('TIES ONLY: a higher coverageGapScore always beats a higher opportunity — CRITICAL money keywords keep first claim', () => {
    const rows = [
      mk({ keyword: 'cute christian shirts for women', coverageGapScore: 50, marketOpportunity: 10 }),
      mk({ keyword: 'comfort colors tshirt', coverageGapScore: 60, marketOpportunity: null, actionType: 'CRITICAL' }),
    ]
    expect(keywords(rows)[0]).toBe('comfort colors tshirt')
  })

  it('ACCEPTANCE (B0FKKN8XKV): "cute christian shirts for women" makes the 7-seat cut on its opportunity instead of being buried', () => {
    // 8th in input order at an equal composite: WITHOUT native data the stable sort leaves it 8th
    // and the top-7 slice drops it — exactly the "buried by volume ordering" failure.
    const buried = [...PEERS.map((k) => mk({ keyword: k })),
      mk({ keyword: 'cute christian shirts for women', searchVolume: 3_749, marketOpportunity: null })]
    expect(keywords(buried)).not.toContain('cute christian shirts for women')

    // WITH its native metric (ease 100 → marketOpportunity 6.2) it wins the tie zone and the seat.
    const promoted = [...PEERS.map((k) => mk({ keyword: k })),
      mk({ keyword: 'cute christian shirts for women', searchVolume: 3_749, marketOpportunity: 6.2 })]
    const out = keywords(promoted)
    expect(out).toContain('cute christian shirts for women')
    expect(out[0]).toBe('cute christian shirts for women')
  })

  it('no-op guarantee: an all-null-opportunity pool sorts byte-identically with the tiebreak present', () => {
    const rows = [
      mk({ keyword: 'alpha bravo charlie tee', coverageGapScore: 70 }),
      mk({ keyword: 'delta echo foxtrot hoodie', coverageGapScore: 60 }),
      mk({ keyword: 'golf hotel india sweatshirt', coverageGapScore: 50 }),
    ]
    expect(keywords(rows)).toEqual([
      'alpha bravo charlie tee',
      'delta echo foxtrot hoodie',
      'golf hotel india sweatshirt',
    ])
  })
})
