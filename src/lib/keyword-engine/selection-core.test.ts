/**
 * selection-core.test.ts — the acceptance + invariant suite for KEYWORD_TARGET_SET.
 * ─────────────────────────────────────────────────────────────────────────────────────
 * What this file is FOR (read before adding a case):
 *
 *   1. THE NAMED BUG (§A). B0GF49RLDL ("Comfort Colors Halftone Cupid Valentine Shirt for Women").
 *      Today `opportunityScore = rawScore × presence.usageGapMultiplier ÷ 3.0` pays an up-to-3×
 *      premium for keywords we do NOT cover, so "art teacher clothes" (5,331/mo) scores 53 and
 *      lands CRITICAL while "comfort colors tshirt" (306,496/mo) scores 14 and sits in DEFENDED.
 *      §A is the acceptance test for that inversion and must never be weakened.
 *
 *   2. DETERMINISM (§C). This module is the parity oracle for four call sites. If the ordered
 *      target list is not a pure function of the input SET (input ARRAY ORDER included), every
 *      cross-site sha comparison is noise. §C is the single most important property in the file.
 *
 *   3. LEGACY PARITY (§L). `off` must be byte-identical to today. §L feeds one fixture to a verbatim
 *      transcription of engine.ts:310-325 and to `legacyTierBuckets`, and demands deep equality.
 *
 * HOUSE RULES OBSERVED HERE:
 *   - `selectRankingTargets` is PURE and reads NO env (§J proves it). Only `selectionMode` and
 *     `resolveRankingTargets` read `process.env`, so the flag is saved and restored around EVERY
 *     test (top-level beforeEach/afterEach) — no test may leak a mode into the next one.
 *   - Seasonality is NOT a fixture flag any more. It is computed inside the module from
 *     `isSeasonalKeyword`, so a "seasonal" fixture must be a keyword that genuinely contains a
 *     SEASONAL_TERMS entry. Fixtures assert that with `isSeasonalKeyword` rather than assuming it.
 *   - Where the source still has a defect, the test asserts the TRUE behaviour and says so in a
 *     WEAKNESS / CONSEQUENCE / DEFECT comment, with a companion `it.fails` asserting the CORRECT
 *     behaviour where one exists — so the suite is green today and turns green-for-real the moment
 *     the source is fixed. There are currently NO `it.fails`: every defect this suite pinned has been
 *     fixed at the source. What remains is a PRECONDITION rather than a bug — `persistedIsComplete`'s
 *     saturation test is sound only because targets sort FIRST, which `RANKING_CANDIDATE_POOL`'s
 *     docblock correctly states is a CONVENTION with no runtime assertion behind it (a callee cannot
 *     see its caller's ORDER BY, so no such assertion could usefully exist). `§P PRECONDITION` pins
 *     that dependency, and is the tripwire if a call site ever breaks the read-window convention.
 *     Grep CONSEQUENCE / PRECONDITION for the behaviours pinned as-is.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  RANKING_TARGET_COUNT,
  RANKING_CANDIDATE_POOL,
  TARGET_SLOTS,
  THEME_BAND_WEIGHT,
  INCUMBENCY_BONUS,
  RANKING_VOLUME_BACKSTOP,
  PROVEN_RANK_FLOOR,
  selectionMode,
  isRankingTarget,
  selectionSha,
  marketScore,
  effectiveBand,
  targetScore,
  selectRankingTargets,
  legacyTierBuckets,
  resolveRankingTargets,
} from './selection-core'
import type { TargetInput, TargetSlot, ThemeBand, SelectionContext } from './selection-core'
import { isSeasonalKeyword, seasonsIn, seasonRelation, isOffSeasonKeyword } from './seasonalTerms'

/* ── ENV HYGIENE ─────────────────────────────────────────────────────────────────────────────── */

const FLAG = 'KEYWORD_TARGET_SET'
let savedFlag: string | undefined

beforeEach(() => {
  savedFlag = process.env[FLAG]
  delete process.env[FLAG]
})

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
  vi.restoreAllMocks()
})

/* ── SELECTION CONTEXT ───────────────────────────────────────────────────────────────────────────
 * `ctx` is REQUIRED, not optional, on all three fields:
 *   - `haystack` / `isApparel` — nicheGuards documents that callers MUST gate on apparel and SHOULD
 *     pass the listing copy, because its own-brand / activewear / own-cut rescues INVERT without
 *     them (§R proves both directions).
 *   - `designSeasons` — the canonical occasions the DESIGN is itself about, from `seasonsIn(theme)`.
 *     `[]` means "this design has no seasonal theme", which reproduces the historical blanket
 *     seasonal strip byte-for-byte; a non-empty array makes the design's OWN holiday placeable (§H).
 *
 * DEFAULT `CTX` IS THE NON-SEASONAL DESIGN (`designSeasons: []`). Every section except §A and the
 * on-season tests in §H uses it, so its numbers are the historical baseline and any change to the
 * season split shows up as a §A/§H diff rather than as noise across the whole file.
 */
const HAYSTACK = 'comfort colors halftone cupid valentine shirt for women graphic tee garment dyed'

const CTX: SelectionContext = { haystack: HAYSTACK, isApparel: true, designSeasons: [] }
/** B0GF49RLDL's TRUE context: the design's own occasion is Valentine's Day. */
const B0GF49RLDL_CTX: SelectionContext = {
  haystack: HAYSTACK,
  isApparel: true,
  designSeasons: seasonsIn("Halftone Cupid Valentine's Day shirt for women"),
}
/** Apparel, but the listing copy is unknown — every context-rescue is off. */
const NO_COPY: SelectionContext = { haystack: '', isApparel: true, designSeasons: [] }
/** Not apparel ⇒ `isOffNicheKeyword` is skipped entirely (the foreign net still runs). */
const NOT_APPAREL: SelectionContext = { haystack: '', isApparel: false, designSeasons: [] }

/* ── FIXTURE FACTORY ─────────────────────────────────────────────────────────────────────────── */

/**
 * Defaults are chosen so nothing fires ACCIDENTALLY:
 *   organicRank null + actionType 'CRITICAL'  ⇒ the proven-performer floor is OFF
 *   prevSelectionRank null                    ⇒ the incumbency bonus is OFF
 *   themeFit 2                                ⇒ eligible, CATEGORY slot
 *   a non-seasonal, on-niche, English keyword ⇒ customer-facing slot, survives every net
 * A test that wants one of those levers must set it explicitly.
 *
 * `keywordSales` defaults to 0 for arithmetic tidiness ONLY. It is MARKET data and — since the
 * rewrite — feeds `marketScore` and nothing else; §A/§F prove a huge `keywordSales` can no longer
 * floor a band-0 row. There are NO `dataSource` and NO `isSeasonal` fields any more.
 */
const mk = (o: Partial<TargetInput> = {}): TargetInput => ({
  keyword: 'default graphic tee',
  searchVolume: 1_000,
  keywordSales: 0,
  competingProducts: 1_000,
  organicRank: null,
  actionType: 'CRITICAL',
  themeFit: 2,
  themeAbout: null,
  prevSelectionRank: null,
  ...o,
})

const kwOf = (rows: readonly TargetInput[]): string[] => rows.map((r) => r.keyword)
const selectedKeywords = (rows: readonly TargetInput[], ctx: SelectionContext = CTX): string[] =>
  kwOf(selectRankingTargets(rows, ctx).targets)

const SLOTS: TargetSlot[] = ['CORE', 'CATEGORY', 'BACKEND']

/** Deterministic Fisher-Yates (LCG) — the shuffle itself must not be a source of flake. */
function seededShuffle<T>(input: readonly T[], seed: number): T[] {
  const a = [...input]
  let s = seed >>> 0
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x1_0000_0000
  }
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** n on-theme (band 3) rows with strictly descending, distinct volumes. "cupid", never "valentine":
 *  a keyword containing a SEASONAL_TERMS entry is classified BACKEND, which would silently turn a
 *  CORE-quota fixture into a BACKEND-quota fixture. */
const manyCore = (n: number): TargetInput[] =>
  Array.from({ length: n }, (_, i) =>
    mk({
      keyword: `core-${pad(i)} cupid tee`,
      searchVolume: 100_000 - i * 137,
      competingProducts: 5_000,
      themeFit: 3,
    }),
  )

/** n category-universal (band 2) rows with strictly descending, distinct volumes. */
const manyCategory = (n: number): TargetInput[] =>
  Array.from({ length: n }, (_, i) =>
    mk({
      keyword: `cat-${pad(i)} cotton tee`,
      searchVolume: 90_000 - i * 211,
      competingProducts: 8_000,
      themeFit: 2,
    }),
  )

/** REAL strings, each containing a genuine SEASONAL_TERMS entry (asserted in §H). */
const SEASONAL_KEYWORDS: readonly string[] = [
  'christmas shirts for women',
  'halloween shirt women',
  'valentines day tee',
  'easter shirt women',
  'thanksgiving shirt women',
  'mothers day shirt',
  'fathers day shirt',
  'st patrick day shirt',
  'new year shirt',
  'black friday shirt',
]

const manySeasonal = (n: number): TargetInput[] =>
  SEASONAL_KEYWORDS.slice(0, n).map((keyword, i) =>
    mk({ keyword, searchVolume: 70_000 - i * 313, competingProducts: 9_000, themeFit: 3 }),
  )

/* ── THE B0GF49RLDL POOL (§A acceptance fixture) ─────────────────────────────────────────────────
 * Real numbers off the live listing. 22 rows: 9 band-3, 7 band-2, 2 band-1, 4 band-0.
 *
 * The band-0 rows carry a REALISTIC `keywordSales` of 400. That is the whole point of the fix: under
 * the previous revision any keywordSales > 0 floored a row to band 2 and re-admitted it, which is
 * why they used to be pinned at 0 to "dodge" the bug. They are now excluded on THEME alone.
 * The band-1 rows likewise carry real market sales (9,000 / 700) and stay band 1.
 *
 * 8 of these keywords are genuinely seasonal (they contain "valentine(s)" or "christmas"), which the
 * module derives itself — there is no `isSeasonal` field to set. §A asserts the consequence.
 */
const B0GF49RLDL = (): TargetInput[] => [
  // ── band 3 — the design's own subject: Valentine / Cupid / halftone pixel art ──
  mk({ keyword: 'valentines day shirts for women', searchVolume: 201_600, keywordSales: 1_400, competingProducts: 60_000, themeFit: 3, themeAbout: 'valentines day apparel' }),
  mk({ keyword: 'valentine shirt women', searchVolume: 33_800, keywordSales: 260, competingProducts: 22_000, themeFit: 3, themeAbout: 'valentines day apparel' }),
  mk({ keyword: 'cupid shirt', searchVolume: 4_102, keywordSales: 90, competingProducts: 3_800, themeFit: 3, themeAbout: 'cupid valentine' }),
  mk({ keyword: 'halftone cupid shirt', searchVolume: 512, keywordSales: 12, competingProducts: 300, themeFit: 3, themeAbout: 'cupid valentine' }),
  mk({ keyword: 'pixel art valentine tee', searchVolume: 340, keywordSales: 8, competingProducts: 210, themeFit: 3, themeAbout: 'pixel art valentine' }),
  mk({ keyword: 'cute valentines day shirt', searchVolume: 61_000, keywordSales: 520, competingProducts: 31_000, themeFit: 3, themeAbout: 'valentines day apparel' }),
  mk({ keyword: 'womens valentines day shirt', searchVolume: 90_000, keywordSales: 700, competingProducts: 40_000, themeFit: 3, themeAbout: 'valentines day apparel' }),
  mk({ keyword: 'valentines day t shirts', searchVolume: 110_000, keywordSales: 900, competingProducts: 52_000, themeFit: 3, themeAbout: 'valentines day apparel' }),

  // ── band 2 — category-universal revenue the listing genuinely sells into ──
  mk({ keyword: 'comfort colors tshirt', searchVolume: 306_496, keywordSales: 2_100, competingProducts: 90_000, themeFit: 2, themeAbout: 'garment brand / blank style' }),
  mk({ keyword: 'oversized tshirts for women', searchVolume: 619_950, keywordSales: 5_200, competingProducts: 120_000, themeFit: 2, themeAbout: 'womens tee fit' }),
  mk({ keyword: 'summer tops for women', searchVolume: 821_120, keywordSales: 6_100, competingProducts: 140_000, themeFit: 2, themeAbout: 'womens tops' }),
  mk({ keyword: 'graphic tees for women', searchVolume: 456_000, keywordSales: 3_800, competingProducts: 110_000, themeFit: 2, themeAbout: 'womens graphic tees' }),
  mk({ keyword: 'womens t shirts', searchVolume: 289_000, keywordSales: 2_400, competingProducts: 130_000, themeFit: 2, themeAbout: 'womens tees' }),
  mk({ keyword: 'cotton t shirts for women', searchVolume: 74_300, keywordSales: 610, competingProducts: 44_000, themeFit: 2, themeAbout: 'womens cotton tees' }),

  // ── band 1 — generic. REAL market sales: they must stay band 1 (see §A keywordSales regression). ──
  mk({ keyword: 'shirt', searchVolume: 1_200_000, keywordSales: 9_000, competingProducts: 200_000, themeFit: 1, themeAbout: 'any shirt' }),
  mk({ keyword: 'tee shirts', searchVolume: 88_000, keywordSales: 700, competingProducts: 70_000, themeFit: 1, themeAbout: 'any tee' }),

  // ── band 0 — THE BUG. Every one of these outranked the band-2 rows under opportunityScore. ──
  mk({ keyword: 'art teacher clothes', searchVolume: 5_331, keywordSales: 400, competingProducts: 4_100, themeFit: 0, themeAbout: 'art teachers' }),
  mk({ keyword: 'art teacher shirts', searchVolume: 3_434, keywordSales: 400, competingProducts: 2_900, themeFit: 0, themeAbout: 'art teachers' }),
  mk({ keyword: 'art teacher shirt', searchVolume: 7_010, keywordSales: 400, competingProducts: 5_600, themeFit: 0, themeAbout: 'art teachers' }),
  mk({ keyword: 'usher and chris brown shirt', searchVolume: 44_356, keywordSales: 400, competingProducts: 12_000, themeFit: 0, themeAbout: 'concert merch' }),

  // ── gifting / cross-season — structurally unplaceable in customer-facing copy, backend bytes only ──
  mk({ keyword: 'valentines day gifts for her', searchVolume: 673_000, keywordSales: 5_000, competingProducts: 150_000, themeFit: 3, themeAbout: 'valentines gifting' }),
  mk({ keyword: 'christmas shirts for women', searchVolume: 246_000, keywordSales: 1_900, competingProducts: 100_000, themeFit: 2, themeAbout: 'christmas apparel' }),
]

const OFF_THEME_ON_B0GF49RLDL = [
  'art teacher clothes',
  'art teacher shirts',
  'art teacher shirt',
  'usher and chris brown shirt',
]

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §0 — CONSTANTS. One home per budget (Invariant 5). If these drift, every number below is a lie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§0 constants', () => {
  it('TARGET_SLOTS sums to RANKING_TARGET_COUNT', () => {
    expect(TARGET_SLOTS.CORE + TARGET_SLOTS.CATEGORY + TARGET_SLOTS.BACKEND).toBe(RANKING_TARGET_COUNT)
    expect(RANKING_TARGET_COUNT).toBe(30)
    expect(TARGET_SLOTS).toEqual({ CORE: 14, CATEGORY: 10, BACKEND: 6 })
  })

  it('the read window is wide enough that every target is always inside it', () => {
    expect(RANKING_CANDIDATE_POOL).toBeGreaterThanOrEqual(RANKING_TARGET_COUNT)
  })

  it('THEME_BAND_WEIGHT is 4 ordinal bands, band 0 is zero, and it is monotonically increasing', () => {
    expect(THEME_BAND_WEIGHT).toHaveLength(4)
    expect(THEME_BAND_WEIGHT[0]).toBe(0)
    for (let b = 1; b < THEME_BAND_WEIGHT.length; b++) {
      expect(THEME_BAND_WEIGHT[b]).toBeGreaterThan(THEME_BAND_WEIGHT[b - 1])
    }
  })

  it('the budgets the tests below depend on are the shipped values', () => {
    expect(RANKING_VOLUME_BACKSTOP).toBe(8)
    expect(PROVEN_RANK_FLOOR).toBe(30)
    expect(INCUMBENCY_BONUS).toBe(2)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §A — THE NAMED BUG. B0GF49RLDL acceptance test. THIS IS THE REASON THE MODULE EXISTS.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§A B0GF49RLDL acceptance — relevance must out-rank the presence premium', () => {
  it('excludes EVERY art-teacher keyword from the target set', () => {
    const v = selectRankingTargets(B0GF49RLDL(), B0GF49RLDL_CTX)
    const picked = kwOf(v.targets)
    for (const kw of ['art teacher clothes', 'art teacher shirts', 'art teacher shirt']) {
      expect(picked).not.toContain(kw)
      expect(v.rankOf.has(kw)).toBe(false)
      expect(v.slotOf.has(kw)).toBe(false)
    }
  })

  it('excludes the celebrity/concert-merch keyword even at 44,356/mo', () => {
    const v = selectRankingTargets(B0GF49RLDL(), B0GF49RLDL_CTX)
    expect(kwOf(v.targets)).not.toContain('usher and chris brown shirt')
    expect(v.rankOf.has('usher and chris brown shirt')).toBe(false)
  })

  it('the excluded band-0 rows carry REALISTIC market sales (400) and are excluded anyway', () => {
    // The previous revision could only pass this section because the fixture pinned keywordSales to
    // 0. Any real listing has keywordSales > 0 on every one of these rows.
    for (const kw of OFF_THEME_ON_B0GF49RLDL) {
      const row = B0GF49RLDL().find((r) => r.keyword === kw)!
      expect(row.keywordSales).toBeGreaterThan(0)
      expect(effectiveBand(row)).toBe(0)
      expect(targetScore(row)).toBe(0)
    }
  })

  it('REGRESSION — keywordSales is MARKET data and must NEVER floor a band-0 row (FATAL bug, do not delete)', () => {
    // engine.ts:153 sets keywordSales from SQP `totalPurchaseCount` — market-wide purchases across
    // ALL ASINs — and engine.ts:194 from a Jungle Scout `relevancyScore / 5` proxy. It is > 0 for
    // nearly every row, so treating it as proof that WE perform on a keyword floored essentially the
    // WHOLE pool to band 2 and silently disabled the band-0 gate — the exact inversion §A exists to
    // stop. `effectiveBand` must not read it. 50,000 market sales, still band 0, still not a target.
    const offTheme = mk({
      keyword: 'art teacher clothes',
      searchVolume: 5_331,
      keywordSales: 50_000,
      competingProducts: 4_100,
      themeFit: 0,
      themeAbout: 'art teachers',
    })
    expect(effectiveBand(offTheme)).toBe(0)
    expect(targetScore(offTheme)).toBe(0)

    // …and in a real pool (12 rows above it by volume, so the volume backstop cannot rescue it either).
    const pool = [
      ...Array.from({ length: 12 }, (_, i) =>
        mk({ keyword: `core-${pad(i)} cupid tee`, searchVolume: 900_000 - i * 1_000, keywordSales: 6_000, competingProducts: 40_000, themeFit: 3 }),
      ),
      offTheme,
    ]
    const v = selectRankingTargets(pool, CTX)
    expect(kwOf(v.targets)).not.toContain('art teacher clothes')
    expect(v.reasonOf.get('art teacher clothes')).toMatch(/^off-theme: art teachers/)
    expect(v.bands).toEqual({ b0: 1, b1: 0, b2: 0, b3: 12 })
  })

  it('INCLUDES comfort colors tshirt (306,496/mo) AND oversized tshirts for women (619,950/mo)', () => {
    const picked = selectedKeywords(B0GF49RLDL(), B0GF49RLDL_CTX)
    expect(picked).toContain('comfort colors tshirt')
    expect(picked).toContain('oversized tshirts for women')
  })

  it('reverses the inversion: a 512/mo ON-theme term is a target while a 44,356/mo OFF-theme term is not', () => {
    const picked = selectedKeywords(B0GF49RLDL(), B0GF49RLDL_CTX)
    expect(picked).toContain('halftone cupid shirt') //   512/mo, themeFit 3
    expect(picked).not.toContain('usher and chris brown shirt') // 44,356/mo, themeFit 0
  })

  it('gives every excluded off-theme row an honest, deterministic reason carrying themeAbout', () => {
    const v = selectRankingTargets(B0GF49RLDL(), B0GF49RLDL_CTX)
    for (const kw of OFF_THEME_ON_B0GF49RLDL) {
      expect(v.reasonOf.get(kw)).toMatch(/^off-theme/)
      expect(v.reasonOf.get(kw)).toMatch(/pooled for backend indexing, not a ranking target$/)
    }
    expect(v.reasonOf.get('art teacher clothes')).toContain('art teachers')
    expect(v.reasonOf.get('usher and chris brown shirt')).toContain('concert merch')
  })

  it('reports the full band census, eligibleCount and a clean guard', () => {
    const v = selectRankingTargets(B0GF49RLDL(), B0GF49RLDL_CTX)
    expect(v.guard).toBeNull()
    expect(v.source).toBe('selector')
    expect(v.bands).toEqual({ b0: 4, b1: 2, b2: 7, b3: 9 })
    expect(v.bands.b0 + v.bands.b1 + v.bands.b2 + v.bands.b3).toBe(B0GF49RLDL().length)
    expect(v.eligibleCount).toBe(18) // 22 rows − 4 band-0, none of which the backstop rescues
  })

  it('selects ALL 18 eligible rows with dense ranks and honest slot counts', () => {
    const v = selectRankingTargets(B0GF49RLDL(), B0GF49RLDL_CTX)
    expect(v.targets).toHaveLength(18)
    expect(kwOf(v.targets).map((k) => v.rankOf.get(k))).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(v.slotCounts).toEqual({ CORE: 9, CATEGORY: 8, BACKEND: 1 })
    expect(SLOTS.reduce((n, s) => n + v.slotCounts[s], 0)).toBe(v.targets.length)
  })

  it('routes only the OFF-season keyword to BACKEND — the design’s OWN occasion is placeable', () => {
    // `designSeasons` is what makes this possible. All 8 seasonal rows name a holiday, but 7 of them
    // name THIS design's holiday, so they classify normally (CORE at band 3, CATEGORY otherwise) and
    // the generators may place them — the PO-reported "Valentine not in the description" gap. Only
    // `christmas shirts for women`, a DIFFERENT holiday, stays backend-only.
    const v = selectRankingTargets(B0GF49RLDL(), B0GF49RLDL_CTX)
    const seasonal = B0GF49RLDL().filter((r) => isSeasonalKeyword(r.keyword))
    expect(seasonal).toHaveLength(8) // 7 valentine* + 1 christmas — derived, never declared
    expect(B0GF49RLDL_CTX.designSeasons).toEqual(['valentine'])

    for (const r of seasonal) {
      const slot = v.slotOf.get(r.keyword)
      if (slot === undefined) continue
      if (seasonRelation(r.keyword, B0GF49RLDL_CTX.designSeasons) === 'off-season') expect(slot).toBe('BACKEND')
      else expect(slot).not.toBe('BACKEND')
    }
    expect(v.slotOf.get('valentines day gifts for her')).toBe('CORE') //     band 3, ON-season
    expect(v.slotOf.get('valentine shirt women')).toBe('CORE') //            band 3, ON-season
    expect(v.slotOf.get('christmas shirts for women')).toBe('BACKEND') //    band 2, OFF-season
    expect(v.slotCounts.BACKEND).toBe(1)
  })

  it('the design’s own subject is no longer starved by the 6-wide BACKEND bucket', () => {
    // Both rows were DROPPED under the blanket strip (see the CONSEQUENCE test below) purely because
    // 8 on-subject seasonal rows contended for 6 seasonal buckets. On-season classification puts them
    // in CORE, where 14 buckets were sitting unused.
    const v = selectRankingTargets(B0GF49RLDL(), B0GF49RLDL_CTX)
    for (const kw of ['valentine shirt women', 'pixel art valentine tee']) {
      expect(kwOf(v.targets)).toContain(kw)
      expect(v.slotOf.get(kw)).toBe('CORE')
    }
  })

  it('CONSEQUENCE (designSeasons EMPTY) — the blanket strip swallows the design’s own subject', () => {
    // KEPT VERBATIM as the evidence for the product conversation, now expressed as the explicit
    // `designSeasons: []` configuration it always was. With no declared design season EVERY holiday
    // keyword is off-season, so on a VALENTINE listing the design's own terms compete for 6 BACKEND
    // buckets while 12 of the 14 CORE buckets go unused, two of them are dropped outright, and the
    // set shrinks from 18 to 16. That is what a caller gets if it forgets to pass `designSeasons` —
    // the field is required by the type, but `[]` is a legal, silent, wrong value.
    const v = selectRankingTargets(B0GF49RLDL(), CTX) // CTX.designSeasons === []
    expect(CTX.designSeasons).toEqual([])
    expect(v.targets).toHaveLength(16)
    expect(v.slotCounts).toEqual({ CORE: 2, CATEGORY: 8, BACKEND: 6 })
    expect(v.slotCounts.BACKEND).toBe(TARGET_SLOTS.BACKEND)
    for (const kw of ['valentine shirt women', 'pixel art valentine tee']) {
      expect(kwOf(v.targets)).not.toContain(kw)
      // The copy names the real cause — a 6-wide bucket, not a rank-30 cut (§H).
      expect(v.reasonOf.get(kw)).toBe(
        'eligible (BACKEND) but the BACKEND quota of 6 was already full — still indexed via backend terms',
      )
    }
    for (const t of v.targets) {
      if (isSeasonalKeyword(t.keyword)) expect(v.slotOf.get(t.keyword)).toBe('BACKEND')
      else expect(v.slotOf.get(t.keyword)).not.toBe('BACKEND')
    }
    // The band-0 gate is unaffected by any of this — §A's core claim holds under BOTH contexts.
    for (const kw of OFF_THEME_ON_B0GF49RLDL) expect(kwOf(v.targets)).not.toContain(kw)
  })

  it('the raw-market ordering of the two headline keywords no longer inverts', () => {
    // Under opportunityScore: art teacher clothes 53 > comfort colors tshirt 14. Under targetScore
    // the presence multiplier is structurally absent, so the market math alone decides.
    const pool = B0GF49RLDL()
    const artTeacher = pool.find((r) => r.keyword === 'art teacher clothes')!
    const comfortColors = pool.find((r) => r.keyword === 'comfort colors tshirt')!
    expect(marketScore(comfortColors)).toBeGreaterThan(marketScore(artTeacher))
    expect(targetScore(artTeacher)).toBe(0) // band 0 ⇒ weight 0.00
    expect(targetScore(comfortColors)).toBeGreaterThan(0)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §B — PRESENCE-INVARIANCE. The whole fix, expressed as a type. Proven at the VALUE level here.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§B presence-invariance', () => {
  it('targetScore is referentially transparent — 100 calls on one row give one value', () => {
    const row = mk({ keyword: 'cupid shirt', searchVolume: 4_102, keywordSales: 90, competingProducts: 3_800, themeFit: 3 })
    const first = targetScore(row)
    for (let i = 0; i < 100; i++) expect(targetScore(row)).toBe(first)
  })

  it('mutating actionType CRITICAL → UPGRADE → REINFORCE → OPTIMIZED does NOT move the score', () => {
    const base = mk({ keyword: 'graphic tees for women', searchVolume: 456_000, competingProducts: 110_000, themeFit: 2 })
    const reference = targetScore(base)
    for (const actionType of ['CRITICAL', 'UPGRADE', 'REINFORCE', 'OPTIMIZED']) {
      expect(targetScore({ ...base, actionType })).toBe(reference)
    }
  })

  it("'DEFENDED' is the ONE actionType that may move the score — via the 1→2 floor only", () => {
    // WEAKNESS (documented in the module, kept documented here): deriveActionType
    // (calculateScore.ts:236) sets DEFENDED = inTitle && inBullets. So actionType IS a presence
    // signal, and this floor is the one channel through which coverage can still touch the target
    // set. It is deliberately clamped to 1→2 so it can never re-admit a band-0 keyword (§F).
    const base = mk({ keyword: 'generic tee', searchVolume: 50_000, competingProducts: 10_000, themeFit: 1 })
    expect(effectiveBand({ ...base, actionType: 'CRITICAL' })).toBe(1)
    expect(effectiveBand({ ...base, actionType: 'DEFENDED' })).toBe(2)
    expect(targetScore({ ...base, actionType: 'DEFENDED' })).toBeGreaterThan(targetScore({ ...base, actionType: 'CRITICAL' }))
  })

  it('excess presence-shaped properties on the row are structurally ignored by the score', () => {
    const base = mk({ keyword: 'comfort colors tshirt', searchVolume: 306_496, competingProducts: 90_000, themeFit: 2 })
    const covered = { ...base, inTitle: true, inBullets: true, inDescription: true, inBackend: true, usageGapMultiplier: 1.0, opportunityScore: 14 } as TargetInput
    const uncovered = { ...base, inTitle: false, inBullets: false, inDescription: false, inBackend: false, usageGapMultiplier: 3.0, opportunityScore: 53 } as TargetInput
    expect(targetScore(covered)).toBe(targetScore(base))
    expect(targetScore(uncovered)).toBe(targetScore(base))
  })

  it('two pools differing ONLY in coverage produce a byte-identical sha and an identical ordered list', () => {
    const clothe = (rows: readonly TargetInput[], covered: boolean): TargetInput[] =>
      rows.map((r) => ({ ...r, inTitle: covered, inBullets: covered, inDescription: covered, inBackend: covered, usageGapMultiplier: covered ? 1.0 : 3.0 }) as TargetInput)

    const allCovered = selectRankingTargets(clothe(B0GF49RLDL(), true), CTX)
    const noneCovered = selectRankingTargets(clothe(B0GF49RLDL(), false), CTX)
    expect(allCovered.sha).toBe(noneCovered.sha)
    expect(kwOf(allCovered.targets)).toEqual(kwOf(noneCovered.targets))
    expect(allCovered.slotCounts).toEqual(noneCovered.slotCounts)
  })

  it('shipping copy cannot silently reshuffle the seller’s targets — sha is stable across a "regenerate"', () => {
    const before = selectRankingTargets(B0GF49RLDL(), CTX)
    // Simulate a regenerate that now covers the top 5 keywords in title + bullets.
    const after = selectRankingTargets(
      B0GF49RLDL().map((r, i) => (i < 5 ? ({ ...r, inTitle: true, inBullets: true }) as TargetInput : r)),
      CTX,
    )
    expect(after.sha).toBe(before.sha)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §C — DETERMINISM. The single most important property in this file.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Tie-dense on purpose: repeated volume/sales/competition across bands so scores COLLIDE and the
 *  lexicographic tiebreak is the only thing standing between us and engine-dependent output. */
const tieDensePool = (n = 60): TargetInput[] =>
  Array.from({ length: n }, (_, i) =>
    mk({
      keyword: `kw-${pad(i)} tee`,
      searchVolume: [10_000, 20_000, 30_000][i % 3],
      competingProducts: 5_000,
      themeFit: (i % 4) as ThemeBand,
    }),
  )

describe('§C determinism / reproducibility', () => {
  it('50 runs of the same pool yield an identical sha and an identical ORDERED target list', () => {
    const first = selectRankingTargets(B0GF49RLDL(), CTX)
    for (let i = 0; i < 50; i++) {
      const again = selectRankingTargets(B0GF49RLDL(), CTX)
      expect(again.sha).toBe(first.sha)
      expect(kwOf(again.targets)).toEqual(kwOf(first.targets))
      expect(again.slotCounts).toEqual(first.slotCounts)
      expect(again.bands).toEqual(first.bands)
      expect(again.eligibleCount).toBe(first.eligibleCount)
    }
  })

  it('SHUFFLING the input array does NOT change the sha, the order, the slots or the reasons', () => {
    const canonical = selectRankingTargets(B0GF49RLDL(), CTX)
    for (let seed = 1; seed <= 25; seed++) {
      const shuffled = selectRankingTargets(seededShuffle(B0GF49RLDL(), seed), CTX)
      expect(shuffled.sha).toBe(canonical.sha)
      expect(kwOf(shuffled.targets)).toEqual(kwOf(canonical.targets))
      expect(shuffled.slotCounts).toEqual(canonical.slotCounts)
      expect(shuffled.bands).toEqual(canonical.bands)
      for (const kw of kwOf(canonical.targets)) {
        expect(shuffled.rankOf.get(kw)).toBe(canonical.rankOf.get(kw))
        expect(shuffled.slotOf.get(kw)).toBe(canonical.slotOf.get(kw))
        expect(shuffled.reasonOf.get(kw)).toBe(canonical.reasonOf.get(kw))
      }
    }
  })

  it('input order is irrelevant even in a TIE-DENSE pool that over-supplies every slot', () => {
    const canonical = selectRankingTargets(tieDensePool(), CTX)
    expect(canonical.targets).toHaveLength(RANKING_TARGET_COUNT)
    for (let seed = 101; seed <= 130; seed++) {
      const shuffled = selectRankingTargets(seededShuffle(tieDensePool(), seed), CTX)
      expect(shuffled.sha).toBe(canonical.sha)
      expect(kwOf(shuffled.targets)).toEqual(kwOf(canonical.targets))
    }
  })

  it('NaN market inputs cannot reinstate input-array order — the comparators guard with isFinite', () => {
    // `NaN !== 0` is TRUE, so a comparator that returned a NaN difference would skip the
    // lexicographic tiebreak and let V8 fall back to the array order it was handed. Every column
    // that feeds a comparator is NaN here, so the keyword tiebreak is the ONLY total order left.
    const nanPool = (): TargetInput[] =>
      Array.from({ length: 14 }, (_, i) =>
        mk({
          keyword: `nan-${pad(i)} tee`,
          searchVolume: NaN as unknown as number,
          keywordSales: NaN as unknown as number,
          competingProducts: NaN as unknown as number,
          themeFit: 2,
        }),
      )
    const canonical = selectRankingTargets(nanPool(), CTX)
    expect(canonical.guard).toBeNull()
    expect(kwOf(canonical.targets)).toEqual(nanPool().map((r) => r.keyword)) // lexicographic == index order
    expect(Number.isFinite(targetScore(nanPool()[0]))).toBe(true)
    expect(selectRankingTargets([...nanPool()].reverse(), CTX).sha).toBe(canonical.sha)
    for (let seed = 1; seed <= 20; seed++) {
      expect(selectRankingTargets(seededShuffle(nanPool(), seed), CTX).sha).toBe(canonical.sha)
    }
  })

  it('a NaN keywordSales alone does not change the sha either (num() coerces it to 0)', () => {
    const clean = manyCategory(12)
    const poisoned = manyCategory(12).map((r) => ({ ...r, keywordSales: NaN as unknown as number }))
    const a = selectRankingTargets(poisoned, CTX)
    const b = selectRankingTargets(seededShuffle(poisoned, 7), CTX)
    expect(a.sha).toBe(b.sha)
    expect(kwOf(a.targets)).toEqual(kwOf(selectRankingTargets(clean, CTX).targets))
  })

  it('the selector never mutates the array it was handed', () => {
    const pool = B0GF49RLDL()
    const before = kwOf(pool)
    selectRankingTargets(pool, CTX)
    expect(kwOf(pool)).toEqual(before)
  })

  it('no clock, no randomness — two runs separated by a Date/Math.random stub agree', () => {
    const first = selectRankingTargets(B0GF49RLDL(), CTX)
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    vi.spyOn(Date, 'now').mockReturnValue(0)
    expect(selectRankingTargets(B0GF49RLDL(), CTX).sha).toBe(first.sha)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §D — TIE-BREAKING. Equal scores must never be left to V8's sort.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§D tie-breaking', () => {
  const twins = (): TargetInput[] => [
    mk({ keyword: 'aaa identical tee', searchVolume: 50_000, keywordSales: 400, competingProducts: 9_000, themeFit: 3 }),
    mk({ keyword: 'zzz identical tee', searchVolume: 50_000, keywordSales: 400, competingProducts: 9_000, themeFit: 3 }),
  ]

  it('byte-identical numbers + bands ⇒ lexicographic ascending order', () => {
    const [a, z] = twins()
    expect(targetScore(a)).toBe(targetScore(z))
    const v = selectRankingTargets([a, z], CTX)
    expect(v.rankOf.get('aaa identical tee')).toBe(1)
    expect(v.rankOf.get('zzz identical tee')).toBe(2)
  })

  it('the SAME order results when the input is handed over reversed', () => {
    const [a, z] = twins()
    const v = selectRankingTargets([z, a], CTX)
    expect(kwOf(v.targets)).toEqual(['aaa identical tee', 'zzz identical tee'])
    expect(v.sha).toBe(selectRankingTargets([a, z], CTX).sha)
  })

  it('the volume backstop uses the same total order (volume desc, then keyword asc)', () => {
    // 10 band-0 twins at identical volume: only the top RANKING_VOLUME_BACKSTOP are rescued, so the
    // 8/9 boundary MUST be cut by the keyword tiebreak, identically in both input orders.
    const rows = Array.from({ length: 10 }, (_, i) =>
      mk({ keyword: `tie-${pad(i)} tee`, searchVolume: 500_000, competingProducts: 100_000, themeFit: 0, themeAbout: 'nothing' }),
    )
    const forward = selectRankingTargets(rows, CTX)
    const backward = selectRankingTargets([...rows].reverse(), CTX)
    expect(kwOf(forward.targets)).toEqual(kwOf(backward.targets))
    expect(forward.targets).toHaveLength(RANKING_VOLUME_BACKSTOP)
    expect(forward.reasonOf.get('tie-00 tee')).toMatch(/^volume backstop/)
    expect(forward.reasonOf.get('tie-09 tee')).toMatch(/^off-theme/)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §E — VOLUME BACKSTOP. Catastrophic over-pruning is now structurally impossible: the backstop is
 *      computed BEFORE the band gate, over the rows that survived only the deterministic nets.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§E absolute-volume backstop', () => {
  /** 8 misrated mega-volume rows (band 1) + 1 just-below-the-cut control + 35 genuine band-3 rows.
   *  The band-3 rows out-SCORE every band-1 row, so without the backstop all the slots go to them. */
  const misratedPool = (): TargetInput[] => [
    ...Array.from({ length: 8 }, (_, i) =>
      mk({
        keyword: `hv-${pad(i)} shirt`,
        searchVolume: 900_000 - i * 50_000, // 900k … 550k
        competingProducts: 80_000,
        themeFit: 1, // the raters got these WRONG
      }),
    ),
    mk({ keyword: 'hv-09 shirt', searchVolume: 500_000, competingProducts: 80_000, themeFit: 1 }), // 9th ⇒ NOT in the backstop
    ...Array.from({ length: 35 }, (_, i) =>
      mk({ keyword: `core-${pad(i)} cupid tee`, searchVolume: 1_200 - i * 10, competingProducts: 500, themeFit: 3 }),
    ),
  ]

  it('the misrated rows genuinely LOSE on score — the backstop is doing real work, not riding a tie', () => {
    const pool = misratedPool()
    const worstCore = Math.min(...pool.filter((r) => r.themeFit === 3).map((r) => targetScore(r)))
    const bestMisrated = Math.max(...pool.filter((r) => r.themeFit === 1).map((r) => targetScore(r)))
    expect(bestMisrated).toBeLessThan(worstCore)
  })

  it('the top RANKING_VOLUME_BACKSTOP eligible rows by RAW volume are targets anyway', () => {
    const v = selectRankingTargets(misratedPool(), CTX)
    const picked = kwOf(v.targets)
    for (let i = 0; i < RANKING_VOLUME_BACKSTOP; i++) expect(picked).toContain(`hv-${pad(i)} shirt`)
  })

  it('the 9th-highest volume row is NOT rescued — the backstop is exactly N wide', () => {
    const v = selectRankingTargets(misratedPool(), CTX)
    expect(kwOf(v.targets)).not.toContain('hv-09 shirt')
    expect(v.reasonOf.get('hv-09 shirt')).toMatch(/^eligible \(CATEGORY\) but outside the top 30/)
  })

  it('the backstop guarantees MEMBERSHIP, never POSITION — a rescued row ranks where its score says', () => {
    // `chosen` is re-sorted by byScoreThenKeyword after the quota fill, so claiming a slot first
    // buys nothing but membership. Every genuine band-3 row must out-RANK every backstop member.
    const v = selectRankingTargets(misratedPool(), CTX)
    const hvRanks = Array.from({ length: 8 }, (_, i) => v.rankOf.get(`hv-${pad(i)} shirt`)!)
    const coreRanks = kwOf(v.targets).filter((k) => k.startsWith('core-')).map((k) => v.rankOf.get(k)!)
    expect(Math.min(...hvRanks)).toBeGreaterThan(Math.max(...coreRanks))
    expect(hvRanks).toEqual([23, 24, 25, 26, 27, 28, 29, 30]) // dead last, every one of them
    expect(Math.max(...coreRanks)).toBe(22)
    // …and the reason string is the ordinary one: `rescued` is band-0-only.
    expect(v.reasonOf.get('hv-00 shirt')).toMatch(/^CATEGORY rank 23\/30 — market /)
  })

  it('backstop rows still respect the slot quotas and never breach the total', () => {
    const v = selectRankingTargets(misratedPool(), CTX)
    expect(v.targets).toHaveLength(RANKING_TARGET_COUNT)
    expect(v.slotCounts).toEqual({ CORE: 22, CATEGORY: 8, BACKEND: 0 })
    // The two invariants the cascade must preserve: the BACKEND LABEL is seasonal-only (so it can
    // never exceed the seasonal supply, and here there is none), and the total is the hard budget.
    expect(v.slotCounts.BACKEND).toBeLessThanOrEqual(TARGET_SLOTS.BACKEND)
    expect(SLOTS.reduce((n, s) => n + v.slotCounts[s], 0)).toBe(v.targets.length)
    expect(v.targets.length).toBeLessThanOrEqual(RANKING_TARGET_COUNT)
  })

  it('THE AI-QUOTA-OUTAGE SHAPE — every row rated band 0 still returns the top-8 by volume, guard null', () => {
    // This is the case the previous revision got WRONG: the backstop used to be computed AFTER the
    // band gate, over `eligible` only, so a rater run that flatlined every row to band 0 returned
    // ZERO targets and guard 'no-eligible'. It now runs over the deterministic-net survivors BEFORE
    // the gate, so the listing keeps its biggest legitimate traffic no matter what the rater does.
    const pool = Array.from({ length: 40 }, (_, i) =>
      mk({ keyword: `hv-${pad(i)} shirt`, searchVolume: 900_000 - i * 1_000, keywordSales: 500, competingProducts: 80_000, themeFit: 0, themeAbout: 'nothing' }),
    )
    const v = selectRankingTargets(pool, CTX)
    expect(v.guard).toBeNull()
    expect(v.targets).toHaveLength(RANKING_VOLUME_BACKSTOP)
    expect(v.eligibleCount).toBe(RANKING_VOLUME_BACKSTOP)
    expect(kwOf(v.targets)).toEqual(Array.from({ length: 8 }, (_, i) => `hv-${pad(i)} shirt`))
    expect(v.bands).toEqual({ b0: 40, b1: 0, b2: 0, b3: 0 })
    expect(v.slotCounts).toEqual({ CORE: 0, CATEGORY: 8, BACKEND: 0 })
    expect(v.sha).toBe(selectionSha(kwOf(v.targets)))
    // The rescued rows say WHY they are there…
    expect(v.reasonOf.get('hv-00 shirt')).toBe(
      'volume backstop (900,000/mo) — rated off-theme but too large to abandon · CATEGORY rank 1/30',
    )
    // …and the 9th still gets the honest off-theme reason.
    expect(v.reasonOf.get('hv-08 shirt')).toMatch(/^off-theme: nothing/)
  })

  it('a band-0 row rescued by the backstop still scores 0 and therefore ranks LAST', () => {
    const pool = [
      mk({ keyword: 'aaa mega generic shirt', searchVolume: 2_000_000, keywordSales: 9_999, competingProducts: 400_000, themeFit: 0, themeAbout: 'unrelated' }),
      ...Array.from({ length: 12 }, (_, i) =>
        mk({ keyword: `core-${pad(i)} cupid tee`, searchVolume: 300_000 - i * 1_000, keywordSales: 5_000, competingProducts: 800, themeFit: 3 }),
      ),
    ]
    const v = selectRankingTargets(pool, CTX)
    expect(v.targets).toHaveLength(13)
    expect(targetScore(pool[0])).toBe(0)
    expect(v.rankOf.get('aaa mega generic shirt')).toBe(13) // lexicographically first, ranked last
    expect(v.slotOf.get('aaa mega generic shirt')).toBe('CATEGORY')
    expect(v.reasonOf.get('aaa mega generic shirt')).toMatch(/^volume backstop \(2,000,000\/mo\)/)
  })

  it('backstopCount is min(RANKING_VOLUME_BACKSTOP, survivors) — it is a COVERAGE figure, not a signal', () => {
    // `backstop.size` is the size of the top-N-by-volume set among net survivors. It is 8 on any pool
    // with 8 or more survivors, i.e. essentially always, so it tells you the backstop RAN, never that
    // it MATTERED. Pinned so nobody reads a constant as a health metric.
    expect(selectRankingTargets(manyCore(40), CTX).backstopCount).toBe(RANKING_VOLUME_BACKSTOP)
    expect(selectRankingTargets(misratedPool(), CTX).backstopCount).toBe(RANKING_VOLUME_BACKSTOP)
    expect(selectRankingTargets(manyCore(3), CTX).backstopCount).toBe(3) // clamped by supply
    expect(selectRankingTargets([], CTX).backstopCount).toBe(0)
  })

  it('rescuedCount counts BAND-0 OVERRIDES only — 0 on a healthy pool, 0 on a misrated BAND-1 pool', () => {
    // `rescued` is `band === 0 && backstop.has(kw)`, so the counter answers exactly one question:
    // "how many rows did the backstop admit AGAINST an off-theme rating?". It is deliberately NOT a
    // "was the backstop load-bearing" metric: the misrated pool below is a case where the backstop is
    // the ONLY reason 8 mega-volume rows are targets at all (they lose on score to 35 band-3 rows),
    // and it still reads 0, because those rows were rated band 1 — nothing was overridden.
    expect(selectRankingTargets(manyCore(40), CTX).rescuedCount).toBe(0)
    expect(selectRankingTargets(misratedPool(), CTX).rescuedCount).toBe(0)
    expect(selectRankingTargets([], CTX).rescuedCount).toBe(0)

    const flatline = Array.from({ length: 40 }, (_, i) =>
      mk({ keyword: `hv-${pad(i)} shirt`, searchVolume: 900_000 - i * 1_000, keywordSales: 500, competingProducts: 80_000, themeFit: 0, themeAbout: 'nothing' }),
    )
    const v = selectRankingTargets(flatline, CTX)
    expect(v.rescuedCount).toBe(RANKING_VOLUME_BACKSTOP) // every target here is a band-0 override
    expect(v.rescuedCount).toBe(v.targets.length)
    expect(kwOf(v.targets).every((k) => v.reasonOf.get(k)!.startsWith('volume backstop'))).toBe(true)
  })

  it('a degenerate verdict still carries both counters, so the log line is never undefined', () => {
    for (const v of [selectRankingTargets([], CTX), selectRankingTargets(['camisas para hombre'].map((keyword) => mk({ keyword })), CTX)]) {
      expect(v.backstopCount).toBe(0)
      expect(v.rescuedCount).toBe(0)
      expect(v.guard).not.toBeNull()
    }
  })

  it('the backstop cannot resurrect a foreign or off-niche keyword — the nets run FIRST', () => {
    const pool = [
      mk({ keyword: 'camisas para hombre', searchVolume: 5_000_000, themeFit: 0 }),
      mk({ keyword: 'gildan t shirts', searchVolume: 4_000_000, themeFit: 0 }),
      mk({ keyword: 'cupid shirt', searchVolume: 4_102, themeFit: 3 }),
    ]
    const v = selectRankingTargets(pool, CTX)
    expect(kwOf(v.targets)).toEqual(['cupid shirt'])
    expect(v.reasonOf.get('camisas para hombre')).toMatch(/^foreign-language duplicate/)
    expect(v.reasonOf.get('gildan t shirts')).toMatch(/^off-niche/)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §F — PROVEN-PERFORMER FLOOR. 1→2 ONLY, NEVER 0→2.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§F proven-performer floor', () => {
  /** A pool whose 12 on-theme rows all out-VOLUME the row under test, so the volume backstop cannot
   *  rescue it and the band gate is the only thing deciding. (In a pool of ≤ 8 rows EVERY row is a
   *  backstop member, which would mask the gate — see §E.) */
  const withCover = (row: TargetInput): TargetInput[] => [
    row,
    ...Array.from({ length: 12 }, (_, i) =>
      mk({ keyword: `core-${pad(i)} cupid tee`, searchVolume: 900_000 - i * 1_000, keywordSales: 6_000, competingProducts: 40_000, themeFit: 3 }),
    ),
  ]

  /** The four combinations the floor is defined over: {band 0, band 1} × {DEFENDED, organicRank 5}. */
  it('band 0 + DEFENDED ⇒ STAYS band 0 (our own copy must not re-admit an off-theme keyword)', () => {
    // deriveActionType (calculateScore.ts:236) returns DEFENDED iff inTitle && inBullets — PURE
    // PRESENCE. A 0→2 rescue would let the copy we ship re-admit an off-theme keyword, which would
    // then instruct the generators to keep covering it: a self-reinforcing loop through the exact
    // channel `TargetInput` swears is closed.
    const row = mk({ keyword: 'art teacher clothes', searchVolume: 5_331, themeFit: 0, actionType: 'DEFENDED', themeAbout: 'art teachers' })
    expect(effectiveBand(row)).toBe(0)
    expect(targetScore(row)).toBe(0)
    const v = selectRankingTargets(withCover(row), CTX)
    expect(kwOf(v.targets)).not.toContain('art teacher clothes')
    expect(v.reasonOf.get('art teacher clothes')).toMatch(/^off-theme: art teachers/)
  })

  it('band 0 + organicRank 5 ⇒ STAYS band 0', () => {
    const row = mk({ keyword: 'art teacher clothes', searchVolume: 5_331, themeFit: 0, organicRank: 5, themeAbout: 'art teachers' })
    expect(effectiveBand(row)).toBe(0)
    const v = selectRankingTargets(withCover(row), CTX)
    expect(kwOf(v.targets)).not.toContain('art teacher clothes')
    expect(v.reasonOf.get('art teacher clothes')).toMatch(/^off-theme: art teachers/)
  })

  it('band 1 + DEFENDED ⇒ FLOORED to band 2', () => {
    expect(effectiveBand(mk({ keyword: 'tee shirts', themeFit: 1, actionType: 'DEFENDED' }))).toBe(2)
  })

  it('band 1 + organicRank 5 ⇒ FLOORED to band 2', () => {
    expect(effectiveBand(mk({ keyword: 'tee shirts', themeFit: 1, organicRank: 5 }))).toBe(2)
  })

  it('NO evidence ⇒ the band is untouched at 0 and at 1', () => {
    expect(effectiveBand(mk({ keyword: 'art teacher clothes', themeFit: 0 }))).toBe(0)
    expect(effectiveBand(mk({ keyword: 'tee shirts', themeFit: 1 }))).toBe(1)
  })

  it('keywordSales is NOT evidence at ANY band — it is a MARKET statistic (the fatal-bug regression)', () => {
    for (const sales of [1, 40, 500, 9_999, 50_000, 1_000_000]) {
      expect(effectiveBand(mk({ themeFit: 0, keywordSales: sales }))).toBe(0)
      expect(effectiveBand(mk({ themeFit: 1, keywordSales: sales }))).toBe(1)
    }
    // and it does still move the market score, which is the ONLY thing it may do
    expect(marketScore(mk({ searchVolume: 10_000, keywordSales: 5_000, competingProducts: 1_000 })))
      .toBeGreaterThan(marketScore(mk({ searchVolume: 10_000, keywordSales: 0, competingProducts: 1_000 })))
  })

  it('organicRank exactly at PROVEN_RANK_FLOOR floors a band-1 row; one past it does not', () => {
    expect(effectiveBand(mk({ themeFit: 1, organicRank: PROVEN_RANK_FLOOR }))).toBe(2)
    expect(effectiveBand(mk({ themeFit: 1, organicRank: PROVEN_RANK_FLOOR + 1 }))).toBe(1)
  })

  it('organicRank 0 / negative / NaN is NOT evidence (ranks are 1-based; 0 means "unknown")', () => {
    expect(effectiveBand(mk({ themeFit: 1, organicRank: 0 }))).toBe(1)
    expect(effectiveBand(mk({ themeFit: 1, organicRank: -3 }))).toBe(1)
    expect(effectiveBand(mk({ themeFit: 1, organicRank: NaN as unknown as number }))).toBe(1)
    expect(effectiveBand(mk({ themeFit: 0, organicRank: 0 }))).toBe(0)
  })

  it('the floor LIFTS band 1 to band 2 but never lifts band 2 or band 3 (it is a floor, not a boost)', () => {
    expect(effectiveBand(mk({ themeFit: 2, organicRank: 1, actionType: 'DEFENDED' }))).toBe(2)
    expect(effectiveBand(mk({ themeFit: 3, organicRank: 1, actionType: 'DEFENDED' }))).toBe(3)
  })

  it('the floor cannot manufacture eligibility out of a foreign or off-niche keyword', () => {
    // The deterministic nets run BEFORE the band resolve (step 1), so a floored foreign/off-niche row
    // never even reaches the band gate — the LLM proposes, the deterministic filter disposes.
    const pool = [
      mk({ keyword: 'camisas para hombre', themeFit: 1, organicRank: 2 }),
      mk({ keyword: 'gildan t shirts', themeFit: 1, organicRank: 3 }),
      mk({ keyword: 'cupid shirt', themeFit: 3 }),
    ]
    const v = selectRankingTargets(pool, CTX)
    expect(kwOf(v.targets)).toEqual(['cupid shirt'])
    expect(v.reasonOf.get('camisas para hombre')).toMatch(/^foreign-language duplicate/)
    expect(v.reasonOf.get('gildan t shirts')).toMatch(/^off-niche/)
    expect(v.bands).toEqual({ b0: 0, b1: 0, b2: 0, b3: 1 }) // netted rows are never even counted
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §G — SLOT QUOTAS + CASCADE. The PERSISTED slot is the CLASSIFIED slot, never the quota bucket.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§G slot quotas + cascade', () => {
  it('over-supplied CORE cascades CORE → CATEGORY → BACKEND and stops at exactly 30', () => {
    const v = selectRankingTargets(manyCore(40), CTX)
    expect(v.targets).toHaveLength(RANKING_TARGET_COUNT) // 14 + 10 + 6 buckets
    expect(v.slotCounts).toEqual({ CORE: 30, CATEGORY: 0, BACKEND: 0 }) // every row LABELLED CORE
  })

  it('over-supplied CATEGORY cascades CATEGORY → CORE → BACKEND and stops at exactly 30', () => {
    const v = selectRankingTargets(manyCategory(40), CTX)
    expect(v.targets).toHaveLength(RANKING_TARGET_COUNT)
    expect(v.slotCounts).toEqual({ CORE: 0, CATEGORY: 30, BACKEND: 0 })
  })

  it('a listing with NO seasonal supply reaches the FULL RANKING_TARGET_COUNT', () => {
    // The cascade is ASYMMETRIC: a customer-facing row MAY consume a spare BACKEND bucket, so the 6
    // seasonal buckets are not stranded when there is no seasonal supply. (Before that asymmetry the
    // effective budget for an ordinary listing was CORE + CATEGORY = 24 while the constant promised
    // 30.) The bucket is a COUNTER only — the persisted LABEL is still the classified slot, asserted
    // below, so nothing non-seasonal is ever marked BACKEND.
    for (const pool of [manyCore(60), manyCategory(60), [...manyCore(30), ...manyCategory(30)]]) {
      const v = selectRankingTargets(pool, CTX)
      expect(v.targets).toHaveLength(RANKING_TARGET_COUNT)
      expect(v.slotCounts.BACKEND).toBe(0)
    }
    const withSeasonal = selectRankingTargets([...manyCore(20), ...manyCategory(20), ...manySeasonal(10)], CTX)
    expect(withSeasonal.targets).toHaveLength(RANKING_TARGET_COUNT)
  })

  it('the RESERVATION PASS keeps the off-season 6 — a BACKEND bucket cannot be outbid on score', () => {
    // The asymmetric cascade alone had a second, less obvious effect: because customer-facing rows may
    // take a BACKEND bucket and placement is by SCORE, >24 strong customer-facing keywords consumed
    // all 6 BACKEND buckets before any off-season row was reached, and the listing shipped ZERO
    // off-season targets — trading the only slots those terms can EVER occupy for a 25th keyword that
    // is already eligible for title and bullets. The reservation pass places off-season rows first, so
    // the outcome no longer depends on how much customer-facing supply happens to exist.
    for (const visible of [24, 30, 40, 60]) {
      const v = selectRankingTargets([...manyCore(visible), ...manySeasonal(10)], CTX)
      expect(v.targets).toHaveLength(RANKING_TARGET_COUNT)
      expect(v.slotCounts).toEqual({ CORE: 24, CATEGORY: 0, BACKEND: TARGET_SLOTS.BACKEND })
      expect(kwOf(v.targets).filter((k) => isSeasonalKeyword(k))).toHaveLength(TARGET_SLOTS.BACKEND)
    }
  })

  it('the reservation is BOUNDED by TARGET_SLOTS.BACKEND — it can never starve the visible copy', () => {
    // 60 customer-facing rows against 10 off-season rows is maximum contention. Reservation costs the
    // visible copy exactly 6 slots, never more, and only when off-season supply actually exists.
    const contended = selectRankingTargets([...manyCore(60), ...manySeasonal(10)], CTX)
    expect(contended.slotCounts.BACKEND).toBe(TARGET_SLOTS.BACKEND)
    expect(contended.slotCounts.CORE + contended.slotCounts.CATEGORY)
      .toBe(RANKING_TARGET_COUNT - TARGET_SLOTS.BACKEND)
    // …and with NO off-season supply the reservation reserves nothing: all 30 go to visible copy.
    const uncontended = selectRankingTargets(manyCore(60), CTX)
    expect(uncontended.slotCounts).toEqual({ CORE: 30, CATEGORY: 0, BACKEND: 0 })
  })

  it('the reservation cannot promote an off-season row past its own 6-wide bucket', () => {
    // Going first buys the off-season rows their bucket, not a bigger one: CASCADE.BACKEND is still
    // ['BACKEND'], so 10 off-season rows still yield exactly 6 no matter how early they are placed.
    const v = selectRankingTargets([...manyCore(4), ...manySeasonal(10)], CTX)
    expect(v.slotCounts).toEqual({ CORE: 4, CATEGORY: 0, BACKEND: TARGET_SLOTS.BACKEND })
    expect(v.targets).toHaveLength(10)
  })

  it('zero seasonal supply leaves BACKEND empty when nothing needs to cascade into it', () => {
    const v = selectRankingTargets(manyCore(12), CTX)
    expect(v.targets).toHaveLength(12)
    expect(v.slotCounts).toEqual({ CORE: 12, CATEGORY: 0, BACKEND: 0 })
  })

  it('a mixed over-supply never breaches a per-slot quota and never breaches the total', () => {
    const v = selectRankingTargets([...manyCore(20), ...manyCategory(20), ...manySeasonal(10)], CTX)
    expect(v.targets).toHaveLength(RANKING_TARGET_COUNT)
    expect(v.slotCounts).toEqual({ CORE: 20, CATEGORY: 4, BACKEND: 6 })
    expect(v.slotCounts.BACKEND).toBeLessThanOrEqual(TARGET_SLOTS.BACKEND)
    expect(SLOTS.reduce((n, s) => n + v.slotCounts[s], 0)).toBe(v.targets.length)
  })

  it('the PERSISTED slot is the CLASSIFIED slot, never the quota bucket the row landed in', () => {
    // migration 049 makes BACKEND mean "exempt from the dock and from ADD advice". A non-seasonal row
    // mislabelled BACKEND would silently suppress real advice, so with >30 eligible NON-SEASONAL rows
    // no row may carry that label even though CORE rows are demonstrably filling the CATEGORY bucket.
    const pool = [...manyCore(25), ...manyCategory(20)]
    const v = selectRankingTargets(pool, CTX)
    expect(v.targets).toHaveLength(RANKING_TARGET_COUNT)
    expect(v.eligibleCount).toBeGreaterThan(RANKING_TARGET_COUNT)
    expect(v.slotCounts.BACKEND).toBe(0)
    for (const t of v.targets) expect(v.slotOf.get(t.keyword)).not.toBe('BACKEND')
    // Proof the cascade really did run — and through BOTH foreign buckets: 25 CORE-classified rows
    // placed into only 14 CORE buckets, which means 10 CATEGORY buckets AND 1 BACKEND bucket were
    // consumed by CORE rows, yet not one of them is LABELLED anything but CORE.
    expect(v.slotCounts).toEqual({ CORE: 25, CATEGORY: 5, BACKEND: 0 })
    expect(v.slotCounts.CORE).toBeGreaterThan(TARGET_SLOTS.CORE + TARGET_SLOTS.CATEGORY)
  })

  it('slotCounts always agrees with slotOf, and rankOf is dense 1..n in target order', () => {
    const v = selectRankingTargets([...manyCore(20), ...manyCategory(20), ...manySeasonal(8)], CTX)
    const recount: Record<TargetSlot, number> = { CORE: 0, CATEGORY: 0, BACKEND: 0 }
    v.targets.forEach((t, i) => {
      expect(v.rankOf.get(t.keyword)).toBe(i + 1)
      recount[v.slotOf.get(t.keyword)!]++
    })
    expect(recount).toEqual(v.slotCounts)
  })

  it('an eligible row that misses the cut is told it MISSED THE CUT, not that it is off-theme', () => {
    // Budget genuinely exhausted (30 chosen), so this is the "outside the top 30" wording — the
    // quota-full wording is reserved for the case where budget REMAINS (§H).
    const v = selectRankingTargets(manyCore(40), CTX)
    const missed = manyCore(40).map((r) => r.keyword).filter((k) => !v.rankOf.has(k))
    expect(missed).toHaveLength(10)
    for (const kw of missed) {
      expect(v.reasonOf.get(kw)).toMatch(/^eligible \(CORE\) but outside the top 30 — still indexed via backend terms$/)
      expect(v.reasonOf.get(kw)).not.toMatch(/off-theme/)
    }
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §H — SEASONAL, and the ON-season / OFF-season split. Six of seven generators hard-strip a holiday
 *      term, so an OFF-season term in a customer-facing slot is a dock no regenerate can clear —
 *      while blanket-stripping the design's OWN holiday was the "Valentine not in the description"
 *      gap. `ctx.designSeasons` is the one input that decides which of the two a keyword is.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§H seasonal routing (on-season vs off-season)', () => {
  const CHRISTMAS: SelectionContext = { ...CTX, designSeasons: ['christmas'] }

  it('the fixtures are genuinely seasonal by the SHARED predicate, not by a flag', () => {
    // There is no `isSeasonal` field any more: the module derives it from seasonalTerms.ts, the same
    // list the generators strip against, so the selector and the generators cannot drift.
    for (const kw of SEASONAL_KEYWORDS) expect(isSeasonalKeyword(kw)).toBe(true)
    for (const kw of ['cupid shirt', 'comfort colors tshirt', 'graphic tees for women']) {
      expect(isSeasonalKeyword(kw)).toBe(false)
    }
  })

  it('seasonsIn canonicalises surface variants so a design cannot disown half its own keywords', () => {
    // "valentine" and "valentines" must be ONE occasion, or a Valentine design reads half its own
    // subject as somebody else's holiday. Apostrophes are normalised for the same reason.
    expect(seasonsIn('valentines day shirts for women')).toEqual(['valentine'])
    expect(seasonsIn('valentine shirt women')).toEqual(['valentine'])
    expect(seasonsIn("valentine's day tee")).toEqual(['valentine'])
    expect(seasonsIn('new years eve shirt')).toEqual(['new-year'])
    expect(seasonsIn('new year shirt')).toEqual(['new-year'])
    expect(seasonsIn('mothers day shirt')).toEqual(['mothers-day'])
    expect(seasonsIn('cupid shirt')).toEqual([])
    expect(seasonsIn('')).toEqual([])
  })

  it('seasonRelation is the three-way split the slot classifier is built on', () => {
    expect(seasonRelation('cupid shirt', ['valentine'])).toBe('not-seasonal')
    expect(seasonRelation('valentines day tee', ['valentine'])).toBe('on-season')
    expect(seasonRelation('christmas shirts for women', ['valentine'])).toBe('off-season')
    // EMPTY designSeasons reproduces the historical blanket strip exactly: everything is off-season.
    expect(seasonRelation('valentines day tee', [])).toBe('off-season')
    expect(seasonRelation('cupid shirt', [])).toBe('not-seasonal')
    expect(isOffSeasonKeyword('christmas shirts for women', ['valentine'])).toBe(true)
    expect(isOffSeasonKeyword('valentines day tee', ['valentine'])).toBe(false)
  })

  it('an OFF-season keyword lands BACKEND even at band 3', () => {
    const v = selectRankingTargets(
      [
        mk({ keyword: 'valentines day gifts for her', searchVolume: 673_000, themeFit: 3 }),
        mk({ keyword: 'cupid shirt', searchVolume: 4_102, themeFit: 3 }),
      ],
      CTX, // designSeasons [] ⇒ valentine is somebody else's holiday
    )
    expect(v.slotOf.get('valentines day gifts for her')).toBe('BACKEND')
    expect(v.slotOf.get('cupid shirt')).toBe('CORE')
  })

  it('an OFF-season keyword lands BACKEND at every band, including the unrated null case', () => {
    for (const themeFit of [1, 2, 3, null] as (ThemeBand | null)[]) {
      const v = selectRankingTargets([mk({ keyword: 'christmas shirts for women', themeFit })], CTX)
      expect(v.slotOf.get('christmas shirts for women')).toBe('BACKEND')
    }
  })

  it('an ON-season keyword classifies by BAND like any other row — CORE at 3, CATEGORY otherwise', () => {
    const expected: Record<string, TargetSlot> = { '1': 'CATEGORY', '2': 'CATEGORY', '3': 'CORE', null: 'CATEGORY' }
    for (const themeFit of [1, 2, 3, null] as (ThemeBand | null)[]) {
      const v = selectRankingTargets([mk({ keyword: 'christmas shirts for women', themeFit })], CHRISTMAS)
      expect(v.slotOf.get('christmas shirts for women')).toBe(expected[String(themeFit)])
    }
  })

  it('ONE ctx field flips the whole classification — same rows, same bands, different slots', () => {
    const rows = [mk({ keyword: 'christmas shirts for women', searchVolume: 246_000, themeFit: 3 })]
    const off = selectRankingTargets(rows, CTX)
    const on = selectRankingTargets(rows, CHRISTMAS)
    expect(off.slotOf.get('christmas shirts for women')).toBe('BACKEND')
    expect(on.slotOf.get('christmas shirts for women')).toBe('CORE')
    expect(off.bands).toEqual(on.bands) // the BAND is unchanged; only the SLOT moves
    expect(off.sha).toBe(on.sha) // …and so is membership, here: the split is a placement decision
  })

  it('only the design’s OWN holiday is rescued — every other holiday stays backend-only', () => {
    const v = selectRankingTargets(manySeasonal(10), CHRISTMAS)
    expect(v.slotOf.get('christmas shirts for women')).toBe('CORE')
    for (const kw of SEASONAL_KEYWORDS.slice(1)) {
      const slot = v.slotOf.get(kw)
      if (slot !== undefined) expect(slot).toBe('BACKEND')
    }
    // The 1 on-season row takes a CORE bucket, so the 6 BACKEND buckets are still fully available.
    expect(v.slotCounts).toEqual({ CORE: 1, CATEGORY: 0, BACKEND: 6 })
    expect(v.targets).toHaveLength(7)
  })

  it('TOTALITY — an undefined or null designSeasons degrades to the blanket strip, never a throw', () => {
    // `designSeasons` is required at the TYPE level, but types are erased at runtime and this value
    // reaches the selector from routes and JSON payloads. It used to read `designSeasons.length`
    // unguarded, so a ctx built by a path that predates the field took the WHOLE selector down with a
    // TypeError. It is now coerced exactly like `num()` coerces the numeric columns, and the fallback
    // is the safe one: absent seasons ⇒ every holiday is somebody else's ⇒ historical behaviour.
    for (const absent of [undefined, null]) {
      const ctx = { haystack: '', isApparel: true, designSeasons: absent } as unknown as SelectionContext
      const rows = [mk({ keyword: 'christmas shirts for women', themeFit: 3 }), mk({ keyword: 'cupid shirt', themeFit: 3 })]
      const v = selectRankingTargets(rows, ctx)
      expect(v.guard).toBeNull()
      expect(v.slotOf.get('christmas shirts for women')).toBe('BACKEND')
      expect(v.slotOf.get('cupid shirt')).toBe('CORE')
      expect(v.sha).toBe(selectRankingTargets(rows, CTX).sha) // identical to designSeasons: []
    }
    expect(seasonRelation('christmas tee', undefined as unknown as string[])).toBe('off-season')
    // ONE off-season predicate, and it is the null-safe one. A second exported name with an identical
    // body was added and removed: two names for one predicate is how seven "isCovered"s were born.
    expect(isOffSeasonKeyword('christmas tee', undefined)).toBe(true)
    expect(isOffSeasonKeyword('christmas tee', null)).toBe(true)
    expect(isOffSeasonKeyword('christmas tee', [])).toBe(true)
    expect(isOffSeasonKeyword('christmas tee', ['christmas'])).toBe(false)
    expect(isOffSeasonKeyword('cupid shirt', null)).toBe(false) // not seasonal at all ⇒ not off-season
  })

  it('CASCADE.BACKEND is ["BACKEND"] — 10 seasonal rows yield 6 targets, ALL BACKEND, none CORE/CATEGORY', () => {
    // The previous revision cascaded BACKEND → CORE → CATEGORY, so beyond 6 seasonal rows the terms
    // reached customer-facing copy that six of seven generators then strip — an unfixable dock.
    const v = selectRankingTargets(manySeasonal(10), CTX)
    expect(v.targets).toHaveLength(TARGET_SLOTS.BACKEND)
    expect(v.targets.length).toBeLessThanOrEqual(TARGET_SLOTS.BACKEND)
    expect(v.slotCounts).toEqual({ CORE: 0, CATEGORY: 0, BACKEND: 6 })
    for (const t of v.targets) expect(v.slotOf.get(t.keyword)).toBe('BACKEND')
    for (const [, slot] of v.slotOf) expect(slot).toBe('BACKEND')
    expect(v.eligibleCount).toBe(10) // all 10 were eligible; 4 simply had nowhere to go
  })

  it('the 4 unplaced seasonal rows are told the QUOTA was full, not that they ranked outside 30', () => {
    // These rows are 7th-10th in a 10-row pool: they lost a 6-wide BUCKET, they are nowhere near rank
    // 30, and only 6 of the 30-target budget was spent. The two failure modes now get two different
    // strings, so the Intelligence tab can never explain a quota exhaustion as a ranking shortfall.
    const v = selectRankingTargets(manySeasonal(10), CTX)
    expect(v.targets.length).toBeLessThan(RANKING_TARGET_COUNT) // budget REMAINED
    const unplaced = SEASONAL_KEYWORDS.slice(0, 10).filter((k) => !v.rankOf.has(k))
    expect(unplaced).toHaveLength(4)
    for (const kw of unplaced) {
      expect(v.reasonOf.get(kw)).toBe(
        'eligible (BACKEND) but the BACKEND quota of 6 was already full — still indexed via backend terms',
      )
      expect(v.reasonOf.get(kw)).not.toMatch(/off-theme/)
      expect(v.reasonOf.get(kw)).not.toMatch(/outside the top/)
    }
  })

  it('a seasonal row can never displace a customer-facing row — the guarantee runs ONE WAY only', () => {
    // Guaranteed: CASCADE.BACKEND = ['BACKEND'], so a seasonal row that does not fit its 6-wide bucket
    // is dropped rather than promoted into copy the generators strip. NOT guaranteed in the other
    // direction: a customer-facing row MAY take a spare BACKEND bucket (see the §G CONSEQUENCE test).
    const v = selectRankingTargets([...manyCore(14), ...manySeasonal(10)], CTX)
    expect(v.slotCounts).toEqual({ CORE: 14, CATEGORY: 0, BACKEND: 6 })
    expect(v.targets).toHaveLength(20)
    // 14 CORE rows fit the 14 CORE buckets exactly, so nothing cascades and the seasonal 6 survive…
    expect(v.targets.length).toBeLessThan(RANKING_TARGET_COUNT)
    // …while 4 seasonal rows are refused even though 10 of the 30-target budget is still unspent.
    expect(SEASONAL_KEYWORDS.slice(0, 10).filter((k) => !v.rankOf.has(k))).toHaveLength(4)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §I — UNRATED ≠ OFF-THEME. A rater outage must never read as "everything is irrelevant".
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§I unrated rows', () => {
  it('themeFit null resolves to band 2', () => {
    expect(effectiveBand(mk({ themeFit: null }))).toBe(2)
    expect(targetScore(mk({ keyword: 'comfort colors tshirt', searchVolume: 306_496, themeFit: null }))).toBeCloseTo(
      marketScore(mk({ keyword: 'comfort colors tshirt', searchVolume: 306_496 })) * THEME_BAND_WEIGHT[2],
      10,
    )
  })

  it('an unrated row is selectable and lands the CATEGORY slot', () => {
    const v = selectRankingTargets([mk({ keyword: 'comfort colors tshirt', searchVolume: 306_496, themeFit: null })], CTX)
    expect(kwOf(v.targets)).toEqual(['comfort colors tshirt'])
    expect(v.slotOf.get('comfort colors tshirt')).toBe('CATEGORY')
    expect(v.bands).toEqual({ b0: 0, b1: 0, b2: 1, b3: 0 })
  })

  it('a WHOLLY unrated pool (rater outage / quota failure) still returns a full 30 — fail-open', () => {
    // The AI-quota-outage incident shape: a failed rating run must degrade to today's behaviour,
    // never to an empty set that then gets PERSISTED over a good one.
    const v = selectRankingTargets(manyCategory(40).map((r) => ({ ...r, themeFit: null })), CTX)
    expect(v.guard).toBeNull()
    expect(v.targets).toHaveLength(RANKING_TARGET_COUNT)
    expect(v.slotCounts).toEqual({ CORE: 0, CATEGORY: 30, BACKEND: 0 })
    expect(v.bands.b2).toBe(40)
    expect(v.eligibleCount).toBe(40)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §J — EDGE CASES + PURITY OF THE SELECTOR.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§J edge cases', () => {
  it('selectRankingTargets does NOT read env — off / shadow / on are byte-identical', () => {
    // The flag gates the CALLER (`resolveRankingTargets`), never the maths. A selector that read env
    // would make the shadow-mode parity oracle compare two different functions.
    const shas: string[] = []
    const lists: string[][] = []
    for (const v of ['off', 'shadow', 'on']) {
      process.env[FLAG] = v
      const verdict = selectRankingTargets(B0GF49RLDL(), CTX)
      shas.push(verdict.sha)
      lists.push(kwOf(verdict.targets))
    }
    delete process.env[FLAG]
    const unset = selectRankingTargets(B0GF49RLDL(), CTX)
    expect(new Set(shas).size).toBe(1)
    expect(shas[0]).toBe(unset.sha)
    expect(lists[0]).toEqual(lists[1])
    expect(lists[1]).toEqual(lists[2])
    expect(unset.source).toBe('selector')
  })

  it('empty pool ⇒ guard "empty-input", empty everything, sha of the empty list', () => {
    const v = selectRankingTargets([], CTX)
    expect(v.guard).toBe('empty-input')
    expect(v.targets).toEqual([])
    expect(v.sha).toBe('811c9dc5') // FNV-1a offset basis, untouched
    expect(v.sha).toBe(selectionSha([]))
    expect(v.slotCounts).toEqual({ CORE: 0, CATEGORY: 0, BACKEND: 0 })
    expect(v.bands).toEqual({ b0: 0, b1: 0, b2: 0, b3: 0 })
    expect(v.eligibleCount).toBe(0)
    expect(v.rankOf.size).toBe(0)
    expect(v.slotOf.size).toBe(0)
    expect(v.reasonOf.size).toBe(0)
    expect(v.source).toBe('selector')
  })

  it('a null/undefined pool is treated as empty-input, not as a crash', () => {
    expect(selectRankingTargets(null as unknown as TargetInput[], CTX).guard).toBe('empty-input')
    expect(selectRankingTargets(undefined as unknown as TargetInput[], CTX).guard).toBe('empty-input')
  })

  it('1-row pool ⇒ exactly one target at rank 1', () => {
    const v = selectRankingTargets([mk({ keyword: 'cupid shirt', themeFit: 3 })], CTX)
    expect(v.targets).toHaveLength(1)
    expect(v.rankOf.get('cupid shirt')).toBe(1)
    expect(v.slotOf.get('cupid shirt')).toBe('CORE')
    expect(v.guard).toBeNull()
  })

  it('12-row pool (fewer than the budget) ⇒ all 12 selected, no padding, no crash', () => {
    const v = selectRankingTargets(manyCore(12), CTX)
    expect(v.targets).toHaveLength(12)
    expect(new Set(kwOf(v.targets)).size).toBe(12)
  })

  it('a pool of ONLY low-volume band-0 rows ⇒ the top 8 are still rescued, the rest refused', () => {
    const v = selectRankingTargets(
      [
        mk({ keyword: 'art teacher clothes', themeFit: 0, themeAbout: 'art teachers' }),
        mk({ keyword: 'usher and chris brown shirt', themeFit: 0, themeAbout: 'concert merch' }),
      ],
      CTX,
    )
    // 2 rows ≤ RANKING_VOLUME_BACKSTOP, so BOTH are backstop members and the guard is clean.
    expect(v.guard).toBeNull()
    expect(v.targets).toHaveLength(2)
    expect(v.bands.b0).toBe(2)
    for (const kw of kwOf(v.targets)) expect(v.reasonOf.get(kw)).toMatch(/^volume backstop/)
  })

  it('a pool where EVERY keyword is foreign ⇒ guard "no-eligible", each row named as a duplicate', () => {
    const foreign = ['camisas para hombre', 'playeras mujer', 'ropa de mujer', 'regalos divertidos', 'camiseta grafica de mujer']
    const v = selectRankingTargets(foreign.map((keyword) => mk({ keyword, searchVolume: 90_000, themeFit: 2 })), CTX)
    expect(v.guard).toBe('no-eligible')
    expect(v.targets).toEqual([])
    expect(v.eligibleCount).toBe(0)
    // Netted rows never reach the band census — the nets are step 1, the band resolve is step 3.
    expect(v.bands).toEqual({ b0: 0, b1: 0, b2: 0, b3: 0 })
    for (const kw of foreign) expect(v.reasonOf.get(kw)).toBe('foreign-language duplicate — not a ranking target')
  })

  it('a pool where EVERY keyword is off-niche ⇒ guard "no-eligible"', () => {
    const offNiche = ['gildan t shirts', 'plain t shirts for women', 'oversized workout shirts', 'golf tees plastic', 'golf accessories']
    const v = selectRankingTargets(offNiche.map((keyword) => mk({ keyword, searchVolume: 90_000, themeFit: 2 })), CTX)
    expect(v.guard).toBe('no-eligible')
    expect(v.eligibleCount).toBe(0)
    for (const kw of offNiche) {
      expect(v.reasonOf.get(kw)).toBe('off-niche (equipment / wholesale / competitor blank) — not a ranking target')
    }
  })

  it('all-zero market inputs score a finite, non-NaN value and remain selectable', () => {
    const zero = mk({ keyword: 'zero everything tee', searchVolume: 0, keywordSales: 0, competingProducts: 0, organicRank: null, themeFit: 2 })
    expect(marketScore(zero)).toBe(10) // 0 + 0 + competitionScore(0)=0.5 × 20
    expect(targetScore(zero)).toBeCloseTo(8.5, 10) // 10 × THEME_BAND_WEIGHT[2]
    expect(Number.isFinite(targetScore(zero))).toBe(true)
    expect(kwOf(selectRankingTargets([zero], CTX).targets)).toEqual(['zero everything tee'])
  })

  it('negative / absurd market inputs do not produce NaN or a crash', () => {
    const weird = mk({ keyword: 'negative tee', searchVolume: -5, keywordSales: -5, competingProducts: -5, themeFit: 2 })
    expect(Number.isFinite(marketScore(weird))).toBe(true)
    expect(Number.isFinite(targetScore(weird))).toBe(true)
    expect(selectRankingTargets([weird], CTX).guard).toBeNull()
  })

  it('an empty-string keyword survives the nets and does not throw', () => {
    const v = selectRankingTargets([mk({ keyword: '', themeFit: 2 })], CTX)
    expect(v.guard).toBeNull()
    expect(v.rankOf.get('')).toBe(1)
    expect(v.slotOf.get('')).toBe('CATEGORY') // isSeasonalKeyword('') is false
  })

  it('duplicate keywords are placed at most once (Map/Set keyed by keyword)', () => {
    const dupe = mk({ keyword: 'cupid shirt', themeFit: 3 })
    const v = selectRankingTargets([dupe, { ...dupe }, { ...dupe }], CTX)
    expect(v.targets).toHaveLength(1)
    expect(v.bands.b3).toBe(3) // …but the band census still counts all three rows
    expect(v.eligibleCount).toBe(3)
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §K — INCUMBENCY. Damps churn among near-ties; never rescues an off-theme keyword.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§K incumbency damper', () => {
  const incumbent = (prevSelectionRank: number | null | undefined): TargetInput =>
    mk({ keyword: 'zzz incumbent tee', searchVolume: 100_000, competingProducts: 10_000, themeFit: 2, prevSelectionRank })
  // Lexicographically FIRST and higher volume — it wins any tie and any no-bonus comparison.
  const challenger = (): TargetInput =>
    mk({ keyword: 'aaa challenger tee', searchVolume: 120_000, competingProducts: 10_000, themeFit: 2 })

  it('CONTROL — with no incumbency, the slightly stronger challenger ranks first', () => {
    const v = selectRankingTargets([incumbent(null), challenger()], CTX)
    expect(kwOf(v.targets)).toEqual(['aaa challenger tee', 'zzz incumbent tee'])
  })

  it('the incumbent holds rank 1 against a near-tie challenger', () => {
    const v = selectRankingTargets([incumbent(3), challenger()], CTX)
    expect(kwOf(v.targets)).toEqual(['zzz incumbent tee', 'aaa challenger tee'])
  })

  it('the bonus is applied BEFORE the band multiplier (worth INCUMBENCY_BONUS × band weight)', () => {
    const withRank = targetScore(incumbent(3))
    const withoutRank = targetScore(incumbent(null))
    expect(withRank - withoutRank).toBeCloseTo(INCUMBENCY_BONUS * THEME_BAND_WEIGHT[2], 10)
  })

  it('the bonus is a DAMPER, not a lock — a clearly better challenger still wins', () => {
    const strong = mk({ keyword: 'aaa strong challenger tee', searchVolume: 900_000, competingProducts: 10_000, themeFit: 2 })
    const v = selectRankingTargets([incumbent(1), strong], CTX)
    expect(kwOf(v.targets)[0]).toBe('aaa strong challenger tee')
  })

  it('incumbency can NEVER rescue a band-0 row on score — the band weight zeroes it', () => {
    const offTheme = mk({ keyword: 'art teacher clothes', searchVolume: 5_331, themeFit: 0, themeAbout: 'art teachers', prevSelectionRank: 1 })
    expect(targetScore(offTheme)).toBe(0)
    const pool = [
      offTheme,
      ...Array.from({ length: 10 }, (_, i) =>
        mk({ keyword: `core-${pad(i)} cupid tee`, searchVolume: 500_000 - i * 1_000, themeFit: 3 }),
      ),
    ]
    const v = selectRankingTargets(pool, CTX)
    // 5,331/mo is the LOWEST volume in an 11-row pool, so the volume backstop does not reach it
    // either — the band-0 gate is the only thing under test here.
    expect(kwOf(v.targets)).not.toContain('art teacher clothes')
    expect(v.reasonOf.get('art teacher clothes')).toMatch(/^off-theme: art teachers/)
  })

  it('incumbency cannot rescue a foreign or off-niche keyword either', () => {
    const v = selectRankingTargets(
      [
        mk({ keyword: 'playeras mujer', themeFit: 3, prevSelectionRank: 1, searchVolume: 500_000 }),
        mk({ keyword: 'gildan t shirts', themeFit: 3, prevSelectionRank: 2, searchVolume: 500_000 }),
        mk({ keyword: 'cupid shirt', themeFit: 3 }),
      ],
      CTX,
    )
    expect(kwOf(v.targets)).toEqual(['cupid shirt'])
  })

  it('a prevSelectionRank of 0 still earns the bonus (0 is a legal previous rank only if 1-based is broken)', () => {
    // TRUE BEHAVIOUR: the check is `typeof === 'number' && isFinite`, so 0 counts. selection_rank is
    // documented as 1..30 dense, so 0 should never be persisted; asserted here so a future 0-based
    // write is caught by a failing test rather than by a silent reshuffle.
    expect(targetScore(incumbent(0)) - targetScore(incumbent(null))).toBeCloseTo(INCUMBENCY_BONUS * THEME_BAND_WEIGHT[2], 10)
  })

  it('an UNDEFINED prevSelectionRank does NOT earn the bonus', () => {
    // Previously the check was `!== null`, so a row read before migration 049 — or any row simply
    // built without the field — arrived as `undefined` and was silently treated as an incumbent.
    const undef = { ...incumbent(null), prevSelectionRank: undefined }
    expect(targetScore(undef)).toBe(targetScore(incumbent(null)))
    expect(targetScore(incumbent(undefined))).toBe(targetScore(incumbent(null)))
  })

  it('a NaN prevSelectionRank does NOT earn the bonus either', () => {
    const nan = { ...incumbent(null), prevSelectionRank: NaN as unknown as number }
    expect(targetScore(nan)).toBe(targetScore(incumbent(null)))
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §L — LEGACY PARITY. The byte-identical-`off` proof.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

type LegacyRow = { keyword: string; actionType: string; opportunityScore: number }

/** VERBATIM transcription of engine.ts:310-325. Do not tidy it: divergence here IS the test. */
function engineInline<T extends { actionType: string; opportunityScore: number }>(analyzed: readonly T[]): T[] {
  const criticalAll = analyzed.filter(a => a.actionType === 'CRITICAL')
    .sort((a, b) => b.opportunityScore - a.opportunityScore);
  const criticalCapped = criticalAll.length <= 5
    ? criticalAll
    : criticalAll.filter(a => a.opportunityScore >= 50).slice(0, 10).length >= 5
      ? criticalAll.filter(a => a.opportunityScore >= 50).slice(0, 10)
      : criticalAll.slice(0, 5);

  const upgradeTop = analyzed.filter(a => a.actionType === 'UPGRADE')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
  const reinforceTop = analyzed.filter(a => a.actionType === 'REINFORCE')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
  const defendedTop = analyzed.filter(a => a.actionType === 'DEFENDED')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);

  const topOpportunities = [...criticalCapped, ...upgradeTop, ...reinforceTop, ...defendedTop];
  return topOpportunities;
}

const legacyRow = (keyword: string, actionType: string, opportunityScore: number): LegacyRow => ({ keyword, actionType, opportunityScore })

const legacyTail = (): LegacyRow[] => [
  ...Array.from({ length: 14 }, (_, i) => legacyRow(`upg-${pad(i)}`, 'UPGRADE', 49 - i)),
  ...Array.from({ length: 12 }, (_, i) => legacyRow(`rei-${pad(i)}`, 'REINFORCE', 34 - i)),
  ...Array.from({ length: 11 }, (_, i) => legacyRow(`def-${pad(i)}`, 'DEFENDED', 30 - i)),
  ...Array.from({ length: 7 }, (_, i) => legacyRow(`opt-${pad(i)}`, 'OPTIMIZED', 12 - i)),
]

describe('§L legacyTierBuckets is a verbatim behavioural copy of engine.ts:310-325', () => {
  it('branch 1 — 4 CRITICALs (≤5) ⇒ all kept, identical to the inline logic', () => {
    const pool = [...Array.from({ length: 4 }, (_, i) => legacyRow(`crit-${pad(i)}`, 'CRITICAL', 90 - i * 3)), ...legacyTail()]
    expect(legacyTierBuckets(pool)).toEqual(engineInline(pool))
    expect(legacyTierBuckets(pool).filter((r) => r.actionType === 'CRITICAL')).toHaveLength(4)
  })

  it('branch 2 — 12 CRITICALs with 8 at ≥50 ⇒ those 8 kept, identical to the inline logic', () => {
    const pool = [
      ...Array.from({ length: 8 }, (_, i) => legacyRow(`crit-hi-${pad(i)}`, 'CRITICAL', 90 - i * 4)), // 90..62
      ...Array.from({ length: 4 }, (_, i) => legacyRow(`crit-lo-${pad(i)}`, 'CRITICAL', 49 - i)),
      ...legacyTail(),
    ]
    expect(legacyTierBuckets(pool)).toEqual(engineInline(pool))
    expect(legacyTierBuckets(pool).filter((r) => r.actionType === 'CRITICAL')).toHaveLength(8)
  })

  it('branch 3 — 12 CRITICALs with only 3 at ≥50 ⇒ falls back to slice(0,5), identical inline', () => {
    const pool = [
      ...Array.from({ length: 3 }, (_, i) => legacyRow(`crit-hi-${pad(i)}`, 'CRITICAL', 80 - i * 5)),
      ...Array.from({ length: 9 }, (_, i) => legacyRow(`crit-lo-${pad(i)}`, 'CRITICAL', 49 - i)),
      ...legacyTail(),
    ]
    expect(legacyTierBuckets(pool)).toEqual(engineInline(pool))
    expect(legacyTierBuckets(pool).filter((r) => r.actionType === 'CRITICAL')).toHaveLength(5)
  })

  it('branch 4 — 13 CRITICALs with 12 at ≥50 ⇒ capped at 10 by slice, identical inline', () => {
    const pool = [
      ...Array.from({ length: 12 }, (_, i) => legacyRow(`crit-hi-${pad(i)}`, 'CRITICAL', 99 - i * 2)),
      legacyRow('crit-lo-00', 'CRITICAL', 20),
      ...legacyTail(),
    ]
    expect(legacyTierBuckets(pool)).toEqual(engineInline(pool))
    expect(legacyTierBuckets(pool).filter((r) => r.actionType === 'CRITICAL')).toHaveLength(10)
  })

  it('the UPGRADE / REINFORCE / DEFENDED buckets are each capped at 10, in that concat order', () => {
    const pool = [...Array.from({ length: 4 }, (_, i) => legacyRow(`crit-${pad(i)}`, 'CRITICAL', 90 - i)), ...legacyTail()]
    const out = legacyTierBuckets(pool)
    expect(out).toEqual(engineInline(pool))
    expect(out.filter((r) => r.actionType === 'UPGRADE')).toHaveLength(10)
    expect(out.filter((r) => r.actionType === 'REINFORCE')).toHaveLength(10)
    expect(out.filter((r) => r.actionType === 'DEFENDED')).toHaveLength(10)
    expect(out.filter((r) => r.actionType === 'OPTIMIZED')).toHaveLength(0)
    expect(out.map((r) => r.actionType)).toEqual([
      ...Array(4).fill('CRITICAL'), ...Array(10).fill('UPGRADE'), ...Array(10).fill('REINFORCE'), ...Array(10).fill('DEFENDED'),
    ])
  })

  it('ties resolve identically in both implementations (same array order into the same sort)', () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => legacyRow(`crit-tie-${pad(i)}`, 'CRITICAL', 60)),
      ...Array.from({ length: 6 }, (_, i) => legacyRow(`upg-tie-${pad(i)}`, 'UPGRADE', 40)),
    ]
    expect(legacyTierBuckets(pool)).toEqual(engineInline(pool))
  })

  it('empty input ⇒ empty output in both implementations', () => {
    expect(legacyTierBuckets([])).toEqual([])
    expect(legacyTierBuckets([])).toEqual(engineInline([]))
  })

  it('neither implementation mutates the caller’s array', () => {
    const pool = [...Array.from({ length: 6 }, (_, i) => legacyRow(`crit-${pad(i)}`, 'CRITICAL', 40 + i)), ...legacyTail()]
    const before = pool.map((r) => r.keyword)
    legacyTierBuckets(pool)
    expect(pool.map((r) => r.keyword)).toEqual(before)
    engineInline(pool)
    expect(pool.map((r) => r.keyword)).toEqual(before)
  })

  it('the two implementations agree across 200 randomised pools', () => {
    const kinds = ['CRITICAL', 'UPGRADE', 'REINFORCE', 'DEFENDED', 'OPTIMIZED']
    let s = 42
    const next = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 0x1_0000_0000
    }
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(next() * 60)
      const pool = Array.from({ length: n }, (_, i) =>
        legacyRow(`kw-${pad(i)}`, kinds[Math.floor(next() * kinds.length)], Math.floor(next() * 100)),
      )
      expect(legacyTierBuckets(pool)).toEqual(engineInline(pool))
    }
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §M — selectionSha. The cross-site parity oracle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§M selectionSha', () => {
  it('returns 8 lowercase hex characters for every shape of input', () => {
    const cases: string[][] = [[], [''], ['a'], ['cupid shirt'], ['comfort colors tshirt', 'oversized tshirts for women'], kwOf(B0GF49RLDL())]
    for (const c of cases) expect(selectionSha(c)).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is stable — the same list hashes the same value every time', () => {
    const list = kwOf(B0GF49RLDL())
    const first = selectionSha(list)
    for (let i = 0; i < 25; i++) expect(selectionSha([...list])).toBe(first)
  })

  it('is ORDER-SENSITIVE across different lists', () => {
    expect(selectionSha(['a', 'b'])).not.toBe(selectionSha(['b', 'a']))
    expect(selectionSha(['cupid shirt', 'valentine tee'])).not.toBe(selectionSha(['valentine tee', 'cupid shirt']))
    const list = kwOf(B0GF49RLDL())
    expect(selectionSha(list)).not.toBe(selectionSha([...list].reverse()))
  })

  it('is content-sensitive — one changed member changes the hash', () => {
    expect(selectionSha(['cupid shirt', 'valentine tee'])).not.toBe(selectionSha(['cupid shirt', 'valentine tees']))
  })

  it('the empty list hashes to the FNV-1a offset basis', () => {
    expect(selectionSha([])).toBe('811c9dc5')
  })

  it('WHY THE SEPARATOR IS NOT A SPACE — two lists that collide under a space produce DIFFERENT shas', () => {
    // Keywords contain spaces, so joining on ' ' is NOT injective: ['a b','c'] and ['a','b c'] would
    // hash identically and the parity oracle would report a FALSE MATCH between two genuinely
    // different target sets. SHA_SEP is the explicit escape \u0000 — a character no keyword can contain.
    expect(['a b', 'c'].join(' ')).toBe(['a', 'b c'].join(' ')) // the collision, made explicit
    expect(selectionSha(['a b', 'c'])).not.toBe(selectionSha(['a', 'b c']))
    expect(selectionSha(['comfort colors', 'tshirt'])).not.toBe(selectionSha(['comfort', 'colors tshirt']))
    expect(selectionSha(['a b'])).not.toBe(selectionSha(['a', 'b']))
  })

  it('pins the separator to the ESCAPE "\\u0000" — a formatter that rewrites it breaks every sha at once', () => {
    // The separator is written as the explicit escape `\u0000`, NOT as a literal control byte
    // in the source: a literal NUL is invisible in editors, diffs and review, and any formatter or CI
    // text filter that normalises control characters would silently rewrite it, changing EVERY sha at
    // once and making the parity oracle report a permanent FALSE MISMATCH. This is the tripwire.
    const NUL = String.fromCharCode(0)
    const fnv1a = (s: string): string => {
      let h = 0x811c9dc5
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
      }
      return h.toString(16).padStart(8, '0')
    }
    for (const list of [['a', 'b'], ['x', 'y', 'z'], kwOf(B0GF49RLDL())]) {
      expect(selectionSha(list)).toBe(fnv1a(list.join(NUL)))
      expect(selectionSha(list)).not.toBe(fnv1a(list.join(' ')))
    }
  })

  it('the verdict sha is exactly the sha of the ORDERED target keyword list', () => {
    const v = selectRankingTargets(B0GF49RLDL(), CTX)
    expect(v.sha).toBe(selectionSha(kwOf(v.targets)))
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §N — isRankingTarget. THE membership predicate. Nothing may re-derive membership elsewhere.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§N isRankingTarget', () => {
  it('null / undefined / a missing property ⇒ false', () => {
    expect(isRankingTarget({ selectionRank: null })).toBe(false)
    expect(isRankingTarget({ selectionRank: undefined })).toBe(false)
    expect(isRankingTarget({})).toBe(false)
  })

  it('1 and RANKING_TARGET_COUNT ⇒ true (the documented dense 1..30 range)', () => {
    expect(isRankingTarget({ selectionRank: 1 })).toBe(true)
    expect(isRankingTarget({ selectionRank: RANKING_TARGET_COUNT })).toBe(true)
    for (let n = 1; n <= RANKING_TARGET_COUNT; n++) expect(isRankingTarget({ selectionRank: n })).toBe(true)
  })

  it('0 ⇒ FALSE — ranks are 1-based, so a smallint defaulting to 0 can never mint a phantom target', () => {
    expect(isRankingTarget({ selectionRank: 0 })).toBe(false)
  })

  it('negative ranks ⇒ false', () => {
    expect(isRankingTarget({ selectionRank: -1 })).toBe(false)
    expect(isRankingTarget({ selectionRank: -30 })).toBe(false)
  })

  it('non-integers ⇒ false', () => {
    expect(isRankingTarget({ selectionRank: 1.5 })).toBe(false)
    expect(isRankingTarget({ selectionRank: 29.999 })).toBe(false)
  })

  it('NaN / Infinity ⇒ false — a corrupt rank must never read as a target', () => {
    expect(isRankingTarget({ selectionRank: NaN })).toBe(false)
    expect(isRankingTarget({ selectionRank: Infinity })).toBe(false)
    expect(isRankingTarget({ selectionRank: -Infinity })).toBe(false)
  })

  it('out-of-range ⇒ false (31 and beyond)', () => {
    expect(isRankingTarget({ selectionRank: RANKING_TARGET_COUNT + 1 })).toBe(false)
    expect(isRankingTarget({ selectionRank: 9_999 })).toBe(false)
  })

  it('agrees with `if (row.selectionRank)` truthiness on every value that can legally be persisted', () => {
    // The predicate and the careless truthiness check must not disagree anywhere in 1..30, and the
    // predicate must be STRICTER everywhere else. That is what makes it safe to be the ONE definition.
    for (const n of [0, -1, 1.5, NaN, 31, 9_999]) expect(isRankingTarget({ selectionRank: n })).toBe(false)
    for (const n of [1, 2, 15, 29, 30]) expect(isRankingTarget({ selectionRank: n })).toBe(Boolean(n))
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §O — selectionMode. Call-time env read; unknown/unset ⇒ off.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§O selectionMode', () => {
  it('unset ⇒ off', () => {
    delete process.env[FLAG]
    expect(selectionMode()).toBe('off')
  })

  it('empty string ⇒ off', () => {
    process.env[FLAG] = ''
    expect(selectionMode()).toBe('off')
  })

  it('garbage ⇒ off (fail-safe default, never a throw)', () => {
    for (const v of ['true', '1', 'ON!', 'enabled', 'yes', 'shadow-mode', 'OFF']) {
      process.env[FLAG] = v
      expect(selectionMode()).toBe('off')
    }
  })

  it('"on" / "shadow" are recognised, case-insensitively', () => {
    for (const v of ['on', 'ON', 'On']) {
      process.env[FLAG] = v
      expect(selectionMode()).toBe('on')
    }
    for (const v of ['shadow', 'SHADOW', 'Shadow']) {
      process.env[FLAG] = v
      expect(selectionMode()).toBe('shadow')
    }
  })

  it('is read at CALL TIME — a mid-process flip is observed without a re-import', () => {
    process.env[FLAG] = 'off'
    expect(selectionMode()).toBe('off')
    process.env[FLAG] = 'on'
    expect(selectionMode()).toBe('on')
    process.env[FLAG] = 'shadow'
    expect(selectionMode()).toBe('shadow')
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §P — resolveRankingTargets. The one resolver every consumer calls. FAIL-OPEN IS ABSOLUTE.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

type ResolveRow = TargetInput & { selectionRank?: number | null }

describe('§P resolveRankingTargets', () => {
  const pool = (): ResolveRow[] => B0GF49RLDL().map((r) => ({ ...r }))
  const legacyOf = (rows: readonly ResolveRow[]): ResolveRow[] => rows.slice(0, 4)
  /** n plain band-2 rows. The SIZE matters: `persistedIsComplete` compares it against
   *  RANKING_CANDIDATE_POOL to decide whether a short persisted set is a real selection or a
   *  truncated read, so every persisted test states its window size deliberately. */
  const poolOf = (n: number): ResolveRow[] =>
    Array.from({ length: n }, (_, i) =>
      ({ ...mk({ keyword: `kw-${pad(i)} cotton tee`, searchVolume: 100_000 - i * 97, competingProducts: 5_000, themeFit: 2 }) }),
    )
  /** A FULL-SIZE read window — the shape the guard is armed for. */
  const fullWindow = (): ResolveRow[] => poolOf(RANKING_CANDIDATE_POOL)
  /** 100 rows: a real caller LIMIT, and deliberately BELOW RANKING_CANDIDATE_POOL. */
  const bigPool = (): ResolveRow[] => poolOf(100)
  /** Stamp ranks 1..k onto the first k rows, the way a prefix-truncated read window arrives. */
  const withPrefixRanks = (rows: ResolveRow[], k: number): ResolveRow[] => {
    for (let i = 0; i < k; i++) rows[i].selectionRank = i + 1
    return rows
  }
  const persistedFlag = (spy: { mock: { calls: unknown[][] } }): boolean =>
    JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).persisted

  it('off ⇒ returns the call site’s OWN legacy verdict, by identity', () => {
    delete process.env[FLAG]
    const rows = pool()
    const legacyResult = legacyOf(rows)
    const out = resolveRankingTargets(rows, { legacy: () => legacyResult, site: 'test', ctx: CTX })
    expect(out).toBe(legacyResult)
  })

  it('off ⇒ emits NOTHING (byte-identical to today, and silent)', () => {
    delete process.env[FLAG]
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    resolveRankingTargets(pool(), { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(spy).toHaveBeenCalledTimes(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('shadow ⇒ still returns legacy, but DOES emit the parity-oracle line', () => {
    process.env[FLAG] = 'shadow'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = pool()
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'rank-panel', ctx: CTX, inputAsin: 'B0GF49RLDL', resolvedAsin: 'B0GF49RLDL' })
    expect(kwOf(out)).toEqual(kwOf(legacyOf(rows)))
    expect(spy).toHaveBeenCalledTimes(1)
    const line = JSON.parse((spy.mock.calls[0] as unknown[])[0] as string)
    expect(line.tag).toBe('KW_TARGET_SET')
    expect(line.site).toBe('rank-panel')
    expect(line.mode).toBe('shadow')
    expect(line.inputAsin).toBe('B0GF49RLDL')
    expect(line.resolvedAsin).toBe('B0GF49RLDL')
    expect(line.persisted).toBe(false)
    expect(line.guard).toBe(null)
    expect(line.failOpen).toBe(false)
    expect(line.nPool).toBe(22)
    expect(line.nLegacy).toBe(4)
    expect(line.nNext).toBe(16)
    expect(line.shaNext).toBe(selectRankingTargets(rows, CTX).sha)
    expect(line.shaLegacy).toBe(selectionSha(kwOf(legacyOf(rows))))
  })

  it('on with NOTHING persisted ⇒ computes and returns the selector’s targets', () => {
    process.env[FLAG] = 'on'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = pool()
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(kwOf(out)).toEqual(kwOf(selectRankingTargets(rows, CTX).targets))
    expect(out).toHaveLength(16)
  })

  it('on ⇒ still emits the parity line (unlike TITLE_COUNCIL_V3, it does not go dark after the flip)', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    resolveRankingTargets(pool(), { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).mode).toBe('on')
  })

  it('FAIL-OPEN — on + guard "no-eligible" returns the LEGACY array, NEVER []', () => {
    // THE critical anti-regression: the prior revision shipped [] here, which is the exact shape of
    // the AI-quota-outage incident (an empty pool PERSISTED over approved copy).
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const foreignPool: ResolveRow[] = ['camisas para hombre', 'playeras mujer', 'ropa de mujer', 'regalos divertidos']
      .map((keyword) => ({ ...mk({ keyword, searchVolume: 90_000, themeFit: 2 }) }))
    const legacy = (r: readonly ResolveRow[]): ResolveRow[] => r.slice(0, 2)
    const out = resolveRankingTargets(foreignPool, { legacy, site: 'fail-open', ctx: CTX })
    expect(out).not.toEqual([])
    expect(out).toHaveLength(2)
    expect(kwOf(out)).toEqual(['camisas para hombre', 'playeras mujer'])
    const line = JSON.parse((spy.mock.calls[0] as unknown[])[0] as string)
    expect(line.guard).toBe('no-eligible')
    expect(line.failOpen).toBe(true)
    expect(line.nNext).toBe(0)
  })

  it('FAIL-OPEN — on + an EMPTY pool returns the legacy array, never []', () => {
    process.env[FLAG] = 'on'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const sentinel: ResolveRow[] = [{ ...mk({ keyword: 'sentinel tee' }) }]
    const out = resolveRankingTargets([] as ResolveRow[], { legacy: () => sentinel, site: 'test', ctx: CTX })
    expect(out).toBe(sentinel)
  })

  it('on + a COMPLETE persisted selection (30 of 100) ⇒ prefers it, ordered by selectionRank', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = bigPool()
    for (let i = 0; i < RANKING_TARGET_COUNT; i++) rows[i].selectionRank = RANKING_TARGET_COUNT - i // reversed on purpose
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(out).toHaveLength(RANKING_TARGET_COUNT)
    expect(kwOf(out)).toEqual(Array.from({ length: 30 }, (_, i) => `kw-${pad(29 - i)} cotton tee`))
    expect(JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).persisted).toBe(true)
  })

  it('on + a persisted selection from a SMALL but UNSATURATED pool is accepted, ordered by rank', () => {
    // The persisted ORDER is honoured verbatim — it is the write-time verdict, not a re-sort. The
    // 4th row is unranked on purpose: it is the non-target that proves the window is not truncated.
    process.env[FLAG] = 'on'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows: ResolveRow[] = [
      { ...mk({ keyword: 'aaa tee', themeFit: 3 }), selectionRank: 3 },
      { ...mk({ keyword: 'bbb tee', themeFit: 3 }), selectionRank: 1 },
      { ...mk({ keyword: 'ccc tee', themeFit: 3 }), selectionRank: 2 },
      { ...mk({ keyword: 'ddd tee', themeFit: 3 }) },
    ]
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(kwOf(out)).toEqual(['bbb tee', 'ccc tee', 'aaa tee'])
  })

  it('the SAME rows fully saturated instead recompute — and the recompute re-sorts by score', () => {
    // Drop the one non-target and the identical persisted set is refused, because the window can no
    // longer prove it was not cut short. The visible difference is the ORDER: the persisted verdict
    // said bbb/ccc/aaa, the recompute says aaa/bbb/ccc on the lexicographic tiebreak.
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows: ResolveRow[] = [
      { ...mk({ keyword: 'aaa tee', themeFit: 3 }), selectionRank: 3 },
      { ...mk({ keyword: 'bbb tee', themeFit: 3 }), selectionRank: 1 },
      { ...mk({ keyword: 'ccc tee', themeFit: 3 }), selectionRank: 2 },
    ]
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(persistedFlag(spy)).toBe(false)
    expect(kwOf(out)).toEqual(['aaa tee', 'bbb tee', 'ccc tee'])
  })

  /** A seasonal-capped pool: 14 CORE rows fill the 14 CORE buckets exactly, 10 seasonal rows contend
   *  for 6 BACKEND buckets ⇒ the selector legitimately writes N = 20, NOT RANKING_TARGET_COUNT. */
  const cappedPool = (): ResolveRow[] => [...manyCore(14), ...manySeasonal(10)].map((r) => ({ ...r }))

  it('SATURATION GUARD — a FULLY-SATURATED window (every row a target) is REJECTED and recomputed', () => {
    // THE truncation model. Targets sort FIRST, so a caller whose LIMIT lands below the target count
    // gets a window that is ENTIRELY targets, carrying exactly ranks 1..k — perfectly contiguous and
    // silently partial. Saturation is therefore the signal, not the window size: `ranks.length ===
    // poolSize` means the reader may have been cut off mid-block, so the set is refused.
    process.env[FLAG] = 'on'
    for (const k of [1, 3, 20, 29, RANKING_TARGET_COUNT]) {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const out = resolveRankingTargets(withPrefixRanks(poolOf(k), k), { legacy: legacyOf, site: 'truncated', ctx: CTX })
      expect(persistedFlag(spy)).toBe(false)
      expect(out).toHaveLength(k) // the recompute over this window, not the truncated read
      vi.restoreAllMocks()
    }
  })

  it('SATURATION GUARD — the fully-saturated edge recomputes to exactly the same set', () => {
    // Rejecting a saturated window is CHEAP and lossless when the pool really is that small: the
    // recompute runs over the same 5 rows and returns the same 5. The guard costs a recompute, never
    // a different answer, in the one case where it fires unnecessarily.
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = resolveRankingTargets(withPrefixRanks(poolOf(5), 5), { legacy: legacyOf, site: 'tiny', ctx: CTX })
    expect(persistedFlag(spy)).toBe(false)
    expect(out).toHaveLength(5)
    expect(kwOf(out)).toEqual(kwOf(selectRankingTargets(poolOf(5), CTX).targets))
  })

  it('SATURATION GUARD — ONE non-target row proves the whole block is present, so the set is ACCEPTED', () => {
    // The converse, and the reason the guard is not a count: a single non-target row proves the reader
    // got PAST the whole target block and is therefore holding all of it — whatever N the writer
    // produced. 30-of-31 is the tightest case; a legitimate N=20 in a full 120-row window is the one
    // that used to be wrongly discarded.
    process.env[FLAG] = 'on'
    for (const [poolSize, k] of [[31, 30], [24, 20], [40, 30], [120, 20], [120, 30], [150, 30]] as [number, number][]) {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const out = resolveRankingTargets(withPrefixRanks(poolOf(poolSize), k), { legacy: legacyOf, site: 'complete', ctx: CTX })
      expect(persistedFlag(spy)).toBe(true)
      expect(out).toHaveLength(k)
      vi.restoreAllMocks()
    }
  })

  it('ROUND TRIP — a legitimate N=20 write is accepted from BOTH a 24-row and a FULL 120-row window', () => {
    // The write/read disagreement that both earlier guards left open, now closed from both sides:
    // an off-season-capped listing legitimately writes 20, and BOTH callers read back that exact set
    // instead of recomputing a different, larger one.
    process.env[FLAG] = 'on'
    const capped = cappedPool()
    const written = selectRankingTargets(capped, CTX)
    expect(written.targets).toHaveLength(20)
    expect(written.targets.length).toBeLessThan(RANKING_TARGET_COUNT)
    for (const t of written.targets) {
      capped.find((r) => r.keyword === t.keyword)!.selectionRank = written.rankOf.get(t.keyword)!
    }

    const spySmall = vi.spyOn(console, 'log').mockImplementation(() => {})
    const small = resolveRankingTargets(capped, { legacy: legacyOf, site: 'read-back-small', ctx: CTX })
    expect(persistedFlag(spySmall)).toBe(true)
    expect(kwOf(small)).toEqual(kwOf(written.targets))
    vi.restoreAllMocks()

    // Same rows, same persisted ranks — only the READ WINDOW is bigger.
    const padded: ResolveRow[] = [
      ...capped,
      ...Array.from({ length: RANKING_CANDIDATE_POOL - capped.length }, (_, i) =>
        ({ ...mk({ keyword: `filler-${pad(i)} cotton tee`, searchVolume: 10 + i, competingProducts: 5_000, themeFit: 2 }) })),
    ]
    expect(padded).toHaveLength(RANKING_CANDIDATE_POOL)
    const spyFull = vi.spyOn(console, 'log').mockImplementation(() => {})
    const full = resolveRankingTargets(padded, { legacy: legacyOf, site: 'read-back-full', ctx: CTX })
    expect(persistedFlag(spyFull)).toBe(true)
    expect(kwOf(full)).toEqual(kwOf(written.targets)) // identical to the write, from both windows
  })

  it('nBackstopCovered / nRescued are emitted on the RECOMPUTE path and are 0 on the PERSISTED path', () => {
    // Both counters describe the selection that just ran. A persisted read runs no selection, so they
    // are structurally 0 there — a dashboard MUST filter on `persisted:false` or it will read
    // "backstop inert" from rows where the backstop never ran at all.
    //
    // The emitted KEY is `nBackstopCovered`, not `nBackstop`: it is a COVERAGE figure (how many rows
    // the backstop set covered), and it is min(RANKING_VOLUME_BACKSTOP, survivors) — i.e. 8 on any
    // real pool. The name carries that so a dashboard cannot read a constant as a health signal.
    // The VERDICT field keeps the plainer name `backstopCount`; only the JSON key is qualified.
    process.env[FLAG] = 'on'
    const flatline: ResolveRow[] = Array.from({ length: 40 }, (_, i) =>
      ({ ...mk({ keyword: `hv-${pad(i)} shirt`, searchVolume: 900_000 - i * 1_000, keywordSales: 500, competingProducts: 80_000, themeFit: 0, themeAbout: 'nothing' }) }),
    )

    const spyRecompute = vi.spyOn(console, 'log').mockImplementation(() => {})
    resolveRankingTargets(flatline, { legacy: legacyOf, site: 'recompute', ctx: CTX })
    const recomputed = JSON.parse((spyRecompute.mock.calls[0] as unknown[])[0] as string)
    expect(recomputed.persisted).toBe(false)
    expect(recomputed.nBackstopCovered).toBe(RANKING_VOLUME_BACKSTOP)
    expect(recomputed.nBackstop).toBeUndefined() // the un-qualified key must not come back
    expect(recomputed.nRescued).toBe(RANKING_VOLUME_BACKSTOP) // band-0 overrides, the signal that matters
    expect(recomputed.nNext).toBe(RANKING_VOLUME_BACKSTOP)
    vi.restoreAllMocks()

    // A healthy recompute: the backstop ran, overrode nothing.
    const spyHealthy = vi.spyOn(console, 'log').mockImplementation(() => {})
    resolveRankingTargets(fullWindow(), { legacy: legacyOf, site: 'healthy', ctx: CTX })
    const healthy = JSON.parse((spyHealthy.mock.calls[0] as unknown[])[0] as string)
    expect(healthy.persisted).toBe(false)
    expect(healthy.nBackstopCovered).toBe(RANKING_VOLUME_BACKSTOP)
    expect(healthy.nRescued).toBe(0)
    vi.restoreAllMocks()

    // The persisted path: no selection ran, so both are 0 REGARDLESS of what the pool looks like.
    const rows = fullWindow()
    const written = selectRankingTargets(rows, CTX)
    for (const t of written.targets) {
      rows.find((r) => r.keyword === t.keyword)!.selectionRank = written.rankOf.get(t.keyword)!
    }
    const spyPersisted = vi.spyOn(console, 'log').mockImplementation(() => {})
    resolveRankingTargets(rows, { legacy: legacyOf, site: 'persisted', ctx: CTX })
    const persistedLine = JSON.parse((spyPersisted.mock.calls[0] as unknown[])[0] as string)
    expect(persistedLine.persisted).toBe(true)
    expect(persistedLine.nBackstopCovered).toBe(0)
    expect(persistedLine.nRescued).toBe(0)
    expect(written.backstopCount).toBe(RANKING_VOLUME_BACKSTOP) // …even though the selection HAD 8
  })

  it('ROUND TRIP — a write of N=30 over a FULL window is accepted on read-back', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = fullWindow()
    const written = selectRankingTargets(rows, CTX)
    expect(written.targets).toHaveLength(RANKING_TARGET_COUNT)
    for (const t of written.targets) {
      rows.find((r) => r.keyword === t.keyword)!.selectionRank = written.rankOf.get(t.keyword)!
    }
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'read-back', ctx: CTX })
    expect(persistedFlag(spy)).toBe(true)
    expect(kwOf(out)).toEqual(kwOf(written.targets))
  })

  it('PRECONDITION — saturation is sound ONLY because targets sort FIRST (a CONVENTION, not enforced)', () => {
    // TRUE BEHAVIOUR, pinned so the assumption is visible in the suite rather than implicit in a
    // comment. A 100-row window carrying a SINGLE rank-1 row is ACCEPTED and ships a one-keyword set.
    // Under "targets sort FIRST" that is CORRECT: 1 target among 99 non-targets can only mean the
    // writer wrote 1 target — a truncated read can never produce that shape, because truncation cuts
    // INTO the target block and therefore returns nothing but targets (see THE REAL TRUNCATION MODEL).
    //
    // It is WRONG for any caller that orders by something else (say `opportunity_score`) and happens
    // to catch rank 1 but not ranks 2..N: contiguity passes, saturation passes, and a one-keyword set
    // ships. RANKING_CANDIDATE_POOL's docblock states plainly that the ordering is a CONVENTION with
    // no runtime assertion behind it — no `assertCandidateWindow` exists, and one could not usefully
    // exist, since a callee cannot see its caller's ORDER BY. The convention every call site owes:
    //   .order('selection_rank', { ascending: true, nullsFirst: false }) with limit >= RANKING_CANDIDATE_POOL
    // THIS TEST IS THE TRIPWIRE: if it ever has to change, the read-window convention has been broken
    // somewhere and `persistedIsComplete` is no longer sound.
    process.env[FLAG] = 'on'
    for (const poolSize of [50, 100, RANKING_CANDIDATE_POOL]) {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const out = resolveRankingTargets(withPrefixRanks(poolOf(poolSize), 1), { legacy: legacyOf, site: 'lone-target', ctx: CTX })
      expect(persistedFlag(spy)).toBe(true)
      expect(out).toHaveLength(1)
      expect(kwOf(out)).toEqual(['kw-00 cotton tee'])
      vi.restoreAllMocks()
    }
  })

  it('REJECTS a persisted set that does NOT start at rank 1 and recomputes', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = bigPool()
    rows[0].selectionRank = 2
    rows[1].selectionRank = 3
    rows[2].selectionRank = 4
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(out).toHaveLength(RANKING_TARGET_COUNT)
    expect(JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).persisted).toBe(false)
  })

  it('REJECTS a persisted set with a GAP in the middle and recomputes', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = bigPool()
    rows[0].selectionRank = 1
    rows[1].selectionRank = 2
    rows[2].selectionRank = 4 // 3 is missing — the window dropped a target
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(out).toHaveLength(RANKING_TARGET_COUNT)
    expect(JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).persisted).toBe(false)
  })

  it('REJECTS DUPLICATE persisted ranks and recomputes', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = bigPool()
    for (let i = 0; i < RANKING_TARGET_COUNT; i++) rows[i].selectionRank = 5
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(out).toHaveLength(RANKING_TARGET_COUNT)
    expect(JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).persisted).toBe(false)
  })

  it('REJECTS OUT-OF-RANGE persisted ranks and recomputes', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = bigPool()
    for (let i = 0; i < RANKING_TARGET_COUNT; i++) rows[i].selectionRank = 100 + i // > RANKING_TARGET_COUNT
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(out).toHaveLength(RANKING_TARGET_COUNT)
    expect(JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).persisted).toBe(false)
  })

  it('REJECTS a 0 / negative / non-integer persisted rank and recomputes', () => {
    // `isRankingTarget` filters the corrupt row out of `persisted` entirely, which leaves 2..30 —
    // no longer contiguous from 1 — so the whole set is refused rather than silently short by one.
    process.env[FLAG] = 'on'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    for (const bad of [0, -1, 2.5, NaN]) {
      const rows = bigPool()
      for (let i = 0; i < RANKING_TARGET_COUNT; i++) rows[i].selectionRank = i === 0 ? bad : i + 1
      expect(resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })).toHaveLength(RANKING_TARGET_COUNT)
    }
  })

  it('an over-budget rank 31 is DROPPED and the contiguous 1..30 beneath it is still accepted', () => {
    process.env[FLAG] = 'on'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = bigPool()
    for (let i = 0; i < RANKING_TARGET_COUNT + 1; i++) rows[i].selectionRank = i + 1 // 1..31
    const out = resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(JSON.parse((spy.mock.calls[0] as unknown[])[0] as string).persisted).toBe(true)
    expect(out).toHaveLength(RANKING_TARGET_COUNT)
    expect(kwOf(out)).not.toContain('kw-30 cotton tee') // the rank-31 row
  })

  it('THE REAL TRUNCATION MODEL — a caller with LIMIT k over a 30-target listing is refused', () => {
    // What a truncated read actually looks like on the wire: order by (is_target, selection_rank),
    // LIMIT k < N ⇒ the caller holds k rows, ALL of them targets, ranked 1..k. Every such window is
    // saturated, so every one of them recomputes instead of shipping a partial set. This is the case
    // that used to ship a 1-keyword target set.
    process.env[FLAG] = 'on'
    for (const limit of [1, 3, 20, 29]) {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const out = resolveRankingTargets(withPrefixRanks(poolOf(limit), limit), { legacy: legacyOf, site: 'limit', ctx: CTX })
      expect(persistedFlag(spy)).toBe(false)
      expect(out).not.toHaveLength(0) // fail-open still holds: never an empty set
      vi.restoreAllMocks()
    }
  })

  it('the legacy thunk receives a COPY — an in-place sort inside it cannot reorder the caller’s array', () => {
    // `readonly T[]` is erased at runtime and the four legacy thunks being replaced are sort-heavy.
    delete process.env[FLAG]
    const rows = pool()
    const before = kwOf(rows)
    const sortingThunk = (r: readonly ResolveRow[]): ResolveRow[] => {
      const a = r as ResolveRow[]
      a.sort((x, y) => (x.keyword < y.keyword ? -1 : x.keyword > y.keyword ? 1 : 0))
      return a
    }
    const out = resolveRankingTargets(rows, { legacy: sortingThunk, site: 'test', ctx: CTX })
    expect(kwOf(rows)).toEqual(before) // the CALLER's array is untouched…
    expect(kwOf(out)).toEqual([...before].sort()) // …while the thunk still saw every row
  })

  it('the selector also receives a COPY — an "on" run cannot reorder the caller’s array either', () => {
    process.env[FLAG] = 'on'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows = pool()
    const before = kwOf(rows)
    resolveRankingTargets(rows, { legacy: legacyOf, site: 'test', ctx: CTX })
    expect(kwOf(rows)).toEqual(before)
  })

  it('a legacy callback that throws propagates — the resolver adds no swallow layer', () => {
    delete process.env[FLAG]
    expect(() =>
      resolveRankingTargets(pool(), {
        legacy: () => {
          throw new Error('legacy blew up')
        },
        site: 'test',
        ctx: CTX,
      }),
    ).toThrow('legacy blew up')
  })

  it('ctx is threaded through to the selector — a non-apparel caller keeps its own-niche terms', () => {
    process.env[FLAG] = 'on'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const rows: ResolveRow[] = [
      { ...mk({ keyword: 'golf tees plastic bulk', searchVolume: 90_000, themeFit: 2 }) },
      { ...mk({ keyword: 'golf accessories', searchVolume: 80_000, themeFit: 2 }) },
    ]
    const apparel = resolveRankingTargets(rows, { legacy: () => [], site: 'test', ctx: CTX })
    const gear = resolveRankingTargets(rows, { legacy: () => [], site: 'test', ctx: NOT_APPAREL })
    expect(apparel).toEqual([]) // every row netted ⇒ no-eligible ⇒ fail open to the (empty) legacy
    expect(kwOf(gear)).toEqual(['golf tees plastic bulk', 'golf accessories'])
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §Q — marketScore. The raw curve, imported (never re-implemented) from calculateScore.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§Q marketScore', () => {
  it('is the jungle_scout weight profile with NO presence term: 45 × vol + 35 × sales + 20 × comp', () => {
    // 1,000,000 volume ⇒ logNorm 1.0 ; 10,000 sales ⇒ logNorm 1.0 ; 1 competitor ⇒ competitionScore 1.0
    expect(marketScore({ searchVolume: 1_000_000, keywordSales: 10_000, competingProducts: 1 })).toBeCloseTo(100, 6)
  })

  it('unknown competition (0) is neutral (0.5), not zero', () => {
    expect(marketScore({ searchVolume: 0, keywordSales: 0, competingProducts: 0 })).toBeCloseTo(10, 10)
  })

  it('is monotonic in volume and monotonic-decreasing in competition', () => {
    const at = (searchVolume: number, competingProducts: number): number => marketScore({ searchVolume, keywordSales: 0, competingProducts })
    expect(at(100_000, 10_000)).toBeGreaterThan(at(10_000, 10_000))
    expect(at(100_000, 1_000)).toBeGreaterThan(at(100_000, 100_000))
  })

  it('there is NO dataSource lever — every row is scored on ONE profile, so SQP and JS listings agree', () => {
    // `dataSource` was removed from TargetInput in the rewrite: rank momentum (wR) is SQP-only and is
    // a PRESENCE signal in disguise, so admitting it would re-open the very channel this module
    // exists to close, and would make instrumented listings select a different set than JS-only ones.
    // An excess `dataSource` on the row is therefore structurally inert.
    const base = mk({ keyword: 'cupid shirt', searchVolume: 4_102, keywordSales: 90, competingProducts: 3_800 })
    for (const dataSource of ['sqp', 'jungle_scout', 'inherited']) {
      expect(marketScore({ ...base, dataSource } as TargetInput)).toBe(marketScore(base))
      expect(targetScore({ ...base, dataSource } as TargetInput)).toBe(targetScore(base))
    }
  })

  it('coerces non-finite columns to 0 rather than poisoning the score with NaN', () => {
    expect(marketScore({ searchVolume: NaN, keywordSales: NaN, competingProducts: NaN })).toBe(10)
    expect(marketScore({ searchVolume: Infinity, keywordSales: 0, competingProducts: 0 })).toBe(10)
    expect(marketScore({ searchVolume: undefined as unknown as number, keywordSales: 0, competingProducts: 0 })).toBe(10)
  })

  it('targetScore = (marketScore + incumbency) × band weight, for every band', () => {
    for (const band of [0, 1, 2, 3] as ThemeBand[]) {
      const row = mk({ keyword: `band-${band} tee`, searchVolume: 50_000, competingProducts: 9_000, themeFit: band })
      expect(targetScore(row)).toBeCloseTo(marketScore(row) * THEME_BAND_WEIGHT[band], 10)
      const inc = { ...row, prevSelectionRank: 4 }
      expect(targetScore(inc)).toBeCloseTo((marketScore(row) + INCUMBENCY_BONUS) * THEME_BAND_WEIGHT[band], 10)
    }
  })
})

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * §R — SelectionContext. `ctx` is REQUIRED because nicheGuards' rescues INVERT without it.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('§R selection context (haystack + isApparel)', () => {
  /** One row per off-niche class in nicheGuards.ts, plus a control. */
  const nichePool = (): TargetInput[] => [
    mk({ keyword: 'gildan t shirts', searchVolume: 95_000, themeFit: 2 }), //        competitor blank brand
    mk({ keyword: 'oversized workout shirts', searchVolume: 94_000, themeFit: 2 }), // activewear
    mk({ keyword: 'golf tees plastic bulk', searchVolume: 93_000, themeFit: 2 }), //  golf pegs (equipment)
    mk({ keyword: 'plain t shirts for women', searchVolume: 92_000, themeFit: 2 }), // wholesale intent
    mk({ keyword: 'golf accessories', searchVolume: 91_000, themeFit: 2 }), //        non-apparel goods
    mk({ keyword: 'cupid shirt', searchVolume: 4_102, themeFit: 3 }), //              the control
  ]

  it('isApparel FALSE skips the isOffNicheKeyword net entirely', () => {
    const v = selectRankingTargets(nichePool(), NOT_APPAREL)
    expect(kwOf(v.targets)).toHaveLength(6)
    expect(kwOf(v.targets)).toContain('golf tees plastic bulk')
    expect(kwOf(v.targets)).toContain('golf accessories')
    expect(kwOf(v.targets)).toContain('gildan t shirts')
    expect(v.eligibleCount).toBe(6)
  })

  it('isApparel TRUE with an unknown haystack arms every net — only the control survives', () => {
    const v = selectRankingTargets(nichePool(), NO_COPY)
    expect(kwOf(v.targets)).toEqual(['cupid shirt'])
    for (const kw of ['gildan t shirts', 'oversized workout shirts', 'golf tees plastic bulk', 'plain t shirts for women', 'golf accessories']) {
      expect(v.reasonOf.get(kw)).toBe('off-niche (equipment / wholesale / competitor blank) — not a ranking target')
    }
  })

  it('the haystack is passed through — a listing whose OWN brand is Gildan keeps its own-brand keyword', () => {
    // isOffNicheKeyword's own-brand rescue is `brand && !ctx.includes(brand)`. Without the haystack a
    // genuine Gildan listing would lose every one of its own-brand terms; that inversion is exactly
    // why `ctx` is a REQUIRED parameter and not an optional one.
    const ownBrand: SelectionContext = { haystack: 'gildan ultra cotton heavy t shirt unisex', isApparel: true, designSeasons: [] }
    const kept = selectRankingTargets(nichePool(), ownBrand)
    expect(kwOf(kept.targets)).toContain('gildan t shirts')
    expect(kwOf(selectRankingTargets(nichePool(), NO_COPY).targets)).not.toContain('gildan t shirts')
    // …and the OTHER classes are still netted: the rescue is per-class, not a blanket disable.
    expect(kwOf(kept.targets)).not.toContain('oversized workout shirts')
    expect(kwOf(kept.targets)).not.toContain('golf accessories')
  })

  it('the haystack rescues activewear on a genuine activewear listing', () => {
    const gymListing: SelectionContext = { haystack: 'mens workout gym performance training tee', isApparel: true, designSeasons: [] }
    expect(selectedKeywords(nichePool(), gymListing)).toContain('oversized workout shirts')
    expect(selectedKeywords(nichePool(), NO_COPY)).not.toContain('oversized workout shirts')
  })

  it('the FOREIGN net is NOT apparel-gated — a foreign keyword is off-niche for ANY category', () => {
    const rows = [mk({ keyword: 'camisas para hombre', searchVolume: 500_000, themeFit: 3 }), mk({ keyword: 'cupid shirt', themeFit: 3 })]
    for (const ctx of [CTX, NO_COPY, NOT_APPAREL]) {
      const v = selectRankingTargets(rows, ctx)
      expect(kwOf(v.targets)).toEqual(['cupid shirt'])
      expect(v.reasonOf.get('camisas para hombre')).toBe('foreign-language duplicate — not a ranking target')
    }
  })

  it('the ctx changes the SELECTION, so it must be part of every parity comparison', () => {
    const a = selectRankingTargets(nichePool(), CTX)
    const b = selectRankingTargets(nichePool(), NOT_APPAREL)
    expect(a.sha).not.toBe(b.sha)
    expect(a.eligibleCount).not.toBe(b.eligibleCount)
  })
})

/* ── §O OPTIONAL KEYS (#143 consumer wiring) ──────────────────────────────────────────────────
 * organicRank / themeFit / themeAbout / prevSelectionRank became OPTIONAL KEYS so the reader-facing
 * `AnalyzedKeyword` (which leaves them absent at off/shadow) can structurally satisfy TargetInput.
 * The claim justifying that change is that an ABSENT key and an EXPLICIT null are indistinguishable
 * to every read. That claim is load-bearing — if it is false, a consumer passing rows straight from
 * getStoredAnalysis silently selects a DIFFERENT 30 than the writer did, and the parity oracle
 * would not catch it because both sides would be equally wrong. So it is pinned, not asserted.
 */
describe('§O optional keys — absent behaves exactly as explicit null', () => {
  /** Same row twice: once with the four keys explicitly null, once with them absent entirely. */
  const explicitNulls = (): TargetInput[] => [
    { keyword: 'cupid valentine shirt', searchVolume: 33_800, keywordSales: 40, competingProducts: 2_000,
      organicRank: null, actionType: 'CRITICAL', themeFit: null, themeAbout: null, prevSelectionRank: null },
    { keyword: 'comfort colors tshirt', searchVolume: 306_496, keywordSales: 900, competingProducts: 8_000,
      organicRank: null, actionType: 'DEFENDED', themeFit: null, themeAbout: null, prevSelectionRank: null },
    { keyword: 'art teacher clothes', searchVolume: 5_331, keywordSales: 10, competingProducts: 700,
      organicRank: null, actionType: 'CRITICAL', themeFit: null, themeAbout: null, prevSelectionRank: null },
  ]
  const keysAbsent = (): TargetInput[] => [
    { keyword: 'cupid valentine shirt', searchVolume: 33_800, keywordSales: 40, competingProducts: 2_000, actionType: 'CRITICAL' },
    { keyword: 'comfort colors tshirt', searchVolume: 306_496, keywordSales: 900, competingProducts: 8_000, actionType: 'DEFENDED' },
    { keyword: 'art teacher clothes', searchVolume: 5_331, keywordSales: 10, competingProducts: 700, actionType: 'CRITICAL' },
  ]

  it('produces a byte-identical sha, order, slots and reasons', () => {
    const a = selectRankingTargets(explicitNulls(), CTX)
    const b = selectRankingTargets(keysAbsent(), CTX)
    expect(b.sha).toBe(a.sha)
    expect(kwOf(b.targets)).toEqual(kwOf(a.targets))
    expect([...b.slotOf.entries()]).toEqual([...a.slotOf.entries()])
    expect([...b.reasonOf.entries()]).toEqual([...a.reasonOf.entries()])
    expect(b.bands).toEqual(a.bands)
  })

  it('an absent organicRank does not trip the proven floor (undefined is not a rank)', () => {
    // The floor is 1→2 for a row ranked within PROVEN_RANK_FLOOR. Absent must read as "not ranking",
    // exactly as null does — otherwise every unrated row from a pre-049 read would be floored.
    const band1 = { keyword: 'graphic tees for women', searchVolume: 90_000, keywordSales: 0,
      competingProducts: 5_000, actionType: 'CRITICAL', themeFit: 1 as const }
    expect(effectiveBand({ ...band1, organicRank: null })).toBe(1)
    expect(effectiveBand(band1)).toBe(1)                       // key absent
    expect(effectiveBand({ ...band1, organicRank: 12 })).toBe(2) // genuinely ranking ⇒ floored
  })

  it('an absent themeFit is band 2 (unrated is NOT off-theme) and is never hard-gated', () => {
    expect(effectiveBand({ keyword: 'k', searchVolume: 1, keywordSales: 0, competingProducts: 1, actionType: 'CRITICAL' })).toBe(2)
    const v = selectRankingTargets(keysAbsent(), CTX)
    expect(v.bands.b0).toBe(0)
    expect(v.targets.length).toBeGreaterThan(0)
  })

  it('an absent prevSelectionRank grants no incumbency bonus', () => {
    const base = { keyword: 'cupid shirt', searchVolume: 10_000, keywordSales: 0, competingProducts: 1_000,
      actionType: 'CRITICAL', themeFit: 3 as const }
    expect(targetScore(base)).toBe(targetScore({ ...base, prevSelectionRank: null }))
    expect(targetScore({ ...base, prevSelectionRank: 4 })).toBeGreaterThan(targetScore(base))
  })
})
