/**
 * marketDataHealth.test.ts — PO ruling 2026-08-09 ("VOLUME is not the biggest thing we look at but
 * the JS opportunity and ranking ability with the right volume").
 * ─────────────────────────────────────────────────────────────────────────────
 * Two pure rules under test, both of which a silent regression would make invisible again:
 *   1. `rankByMarketOpportunity` — THE money-tail admission rule. A pool with no market data must
 *      yield NOTHING, never a volume-only pick; volume may only break ties between market-scored
 *      rows. This is the exact refusal listingPipeline's titleMoneyKws now depends on.
 *   2. `deriveMarketDataState` / `deriveMarketDataHealth` — the fresh/stale/unscored/empty/unknown
 *      boundaries, including the precedence question (unscored OUTRANKS stale) that decides what
 *      the seller is actually told about B0GVV3XL4T.
 *
 * TTL is imported from keywordResearcher, never typed as a literal here — a test that hard-codes 14
 * would keep passing after someone changed the real constant, which is the drift this pins shut.
 */
import { describe, it, expect } from 'vitest'
import { RESEARCH_TTL_DAYS } from './keywordResearcher'
import {
  carriesMarketOpportunity,
  hasAnyMarketOpportunity,
  carriesThemeFit,
  hasAnyThemeFit,
  rankByMarketOpportunity,
  researchAgeDays,
  deriveMarketDataState,
  deriveMarketDataHealth,
  unknownMarketDataHealth,
  type MarketDataState,
} from './marketDataHealth'

const NOW = Date.UTC(2026, 7, 9)                                   // 2026-08-09, the probe date
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

describe('carriesMarketOpportunity — a finite number, INCLUDING 0', () => {
  const cases: [string, unknown, boolean][] = [
    ['a normal score', 6.2, true],
    ['a measured ZERO (a measurement, not an absence)', 0, true],
    ['the top of the 0-10 scale', 10, true],
    ['null (not measured — SQP/import/pre-055 rows)', null, false],
    ['undefined (field absent from a hand-built literal)', undefined, false],
    ['NaN (a corrupted number is not a measurement)', NaN, false],
    ['Infinity', Infinity, false],
    ['a numeric STRING (never silently coerce)', '6.2', false],
  ]
  for (const [label, value, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(carriesMarketOpportunity({ marketOpportunity: value as number | null })).toBe(expected)
    })
  }

  it('null/undefined row → false, never a throw', () => {
    expect(carriesMarketOpportunity(null)).toBe(false)
    expect(carriesMarketOpportunity(undefined)).toBe(false)
  })

  it('hasAnyMarketOpportunity: ONE scored row among many unscored is enough', () => {
    expect(hasAnyMarketOpportunity([{ marketOpportunity: null }, { marketOpportunity: null }])).toBe(false)
    expect(hasAnyMarketOpportunity([{ marketOpportunity: null }, { marketOpportunity: 0 }])).toBe(true)
    expect(hasAnyMarketOpportunity([])).toBe(false)
    expect(hasAnyMarketOpportunity(null)).toBe(false)
  })
})

describe('rankByMarketOpportunity — NO silent volume-only fallback (the money-tail refusal)', () => {
  const kw = (keyword: string, marketOpportunity: number | null, searchVolume: number) =>
    ({ keyword, marketOpportunity, searchVolume })
  const id = <T,>(r: T) => r as T & { marketOpportunity?: number | null; searchVolume?: number | null }

  it('THE B0GVV3XL4T SHAPE: zero rows carry market data → EMPTY, not the volume leader', () => {
    // The live pool: unwinnable heads at the top by volume, the niche design nowhere near it.
    const pool = [
      kw('usa soccer jersey', null, 1_980_000),
      kw('usa soccer shirt', null, 657_000),
      kw('mens graphic tee', null, 90_000),
    ]
    expect(rankByMarketOpportunity(pool, id)).toEqual([])
  })

  it('a single unscored candidate is REFUSED, not promoted by default', () => {
    expect(rankByMarketOpportunity([kw('usa soccer jersey', null, 1_980_000)], id)).toEqual([])
  })

  it('volume NEVER outranks market data: the 1.98M unscored head loses to a 5K scored term', () => {
    const out = rankByMarketOpportunity([
      kw('usa soccer jersey', null, 1_980_000),
      kw('football widow shirt', 7.1, 5_400),
    ], id)
    expect(out.map((r) => r.keyword)).toEqual(['football widow shirt'])
  })

  it('unscored rows are DROPPED even when scored rows exist (volume can only tie-break scored rows)', () => {
    const out = rankByMarketOpportunity([
      kw('scored-low', 2, 100),
      kw('unscored-huge', null, 999_999),
      kw('scored-high', 9, 100),
    ], id)
    expect(out.map((r) => r.keyword)).toEqual(['scored-high', 'scored-low'])
  })

  it('volume breaks a tie BETWEEN two market-scored rows (the only sanctioned use of volume)', () => {
    const out = rankByMarketOpportunity([
      kw('tie-low-vol', 6, 1_000),
      kw('tie-high-vol', 6, 50_000),
    ], id)
    expect(out.map((r) => r.keyword)).toEqual(['tie-high-vol', 'tie-low-vol'])
  })

  it('a measured 0 is a candidate (an honest zero still beats an unmeasured row)', () => {
    const out = rankByMarketOpportunity([
      kw('measured-zero', 0, 10),
      kw('unmeasured', null, 999_999),
    ], id)
    expect(out.map((r) => r.keyword)).toEqual(['measured-zero'])
  })

  it('works through a WRAPPER selector (the pipeline ranks {k, safe} pairs, not raw rows)', () => {
    const wrapped = [
      { k: kw('a', null, 900_000), safe: 'a' },
      { k: kw('b', 8, 10), safe: 'b' },
    ]
    expect(rankByMarketOpportunity(wrapped, (e) => e.k).map((e) => e.safe)).toEqual(['b'])
  })

  it('empty / null in → empty out, never a throw (fail-open)', () => {
    expect(rankByMarketOpportunity([], id)).toEqual([])
    expect(rankByMarketOpportunity(null, id)).toEqual([])
    expect(rankByMarketOpportunity(undefined, id)).toEqual([])
  })

  it('does not mutate its input (the caller still owns the candidate list)', () => {
    const pool = [kw('a', 1, 10), kw('b', 9, 10)]
    const before = pool.map((r) => r.keyword)
    rankByMarketOpportunity(pool, id)
    expect(pool.map((r) => r.keyword)).toEqual(before)
  })
})

describe('researchAgeDays — an unreadable stamp is UNKNOWN, never "0 days old"', () => {
  it('counts whole days', () => {
    expect(researchAgeDays(daysAgo(46), NOW)).toBe(46)
    expect(researchAgeDays(daysAgo(0), NOW)).toBe(0)
  })
  it('null / empty / garbage → null', () => {
    expect(researchAgeDays(null, NOW)).toBeNull()
    expect(researchAgeDays(undefined, NOW)).toBeNull()
    expect(researchAgeDays('', NOW)).toBeNull()
    expect(researchAgeDays('not-a-date', NOW)).toBeNull()
  })
})

describe('deriveMarketDataState — boundaries + precedence', () => {
  /** `withFit` / `withRank` default to a RATED, SELECTED pool so every pre-existing case keeps
   *  asserting exactly what it asserted before the `unrated` state existed. The unrated cases pass
   *  them explicitly — a default that silently produced 'unrated' would make this whole table lie. */
  const st = (
    rows: number, withMo: number, ageDays: number | null,
    withFit = rows, withRank = rows,
  ): MarketDataState =>
    deriveMarketDataState({
      rows, rowsWithMarketOpportunity: withMo, rowsWithThemeFit: withFit,
      rowsWithSelectionRank: withRank, ageDays, ttlDays: RESEARCH_TTL_DAYS,
    })

  const table: [string, number, number, number | null, MarketDataState][] = [
    ['no rows at all',                            0,  0, 3,                     'empty'],
    ['no rows, and no date either',               0,  0, null,                  'empty'],
    ['rows but ZERO scored (B0GVV3XL4T)',        88,  0, 46,                    'unscored'],
    ['rows, zero scored, FRESH research',        88,  0, 1,                     'unscored'],
    ['rows, zero scored, unknown date',          88,  0, null,                  'unscored'],
    ['scored + inside the TTL',                  88, 40, 1,                     'fresh'],
    ['scored + EXACTLY at the TTL (servable)',   88, 40, RESEARCH_TTL_DAYS,     'fresh'],
    ['scored + one day past the TTL',            88, 40, RESEARCH_TTL_DAYS + 1, 'stale'],
    ['scored + 46 days old',                     88, 40, 46,                    'stale'],
    ['scored + researched today',                88, 40, 0,                     'fresh'],
    ['scored but the date is unreadable',        88, 40, null,                  'unknown'],
    ['a single scored row still counts',          1,  1, 0,                     'fresh'],
  ]
  for (const [label, rows, withMo, ageDays, expected] of table) {
    it(`${label} → ${expected}`, () => expect(st(rows, withMo, ageDays)).toBe(expected))
  }

  it('PRECEDENCE: unscored OUTRANKS stale — the seller must learn the pool is unscored, not just old', () => {
    // B0GVV3XL4T is BOTH. If staleness won, the banner would read "research is a bit old" and the
    // real failure (every number on screen is volume order) would stay invisible.
    expect(st(88, 0, 46)).toBe('unscored')
  })

  it('PRECEDENCE: empty OUTRANKS everything (no rows ⇒ nothing to be unscored or stale about)', () => {
    expect(st(0, 0, 999)).toBe('empty')
  })

  it('the TTL boundary mirrors the cache-expiry check exactly (ageDays > TTL, strictly)', () => {
    expect(st(10, 10, RESEARCH_TTL_DAYS - 1)).toBe('fresh')
    expect(st(10, 10, RESEARCH_TTL_DAYS)).toBe('fresh')
    expect(st(10, 10, RESEARCH_TTL_DAYS + 1)).toBe('stale')
  })

  /* ── `unrated` — the theme_fit half of the same disease ─────────────────────────────────────── */

  const unratedTable: [string, number, number, number, number, number | null, MarketDataState][] = [
    // rows, withMo, withFit, withRank, ageDays
    ['THE LIVE SHAPE: 86 scored rows, 30 selected, ZERO rated', 86, 86, 0, 30, 0,  'unrated'],
    ['still unrated even when the research is FRESH',           86, 86, 0, 30, 0,  'unrated'],
    ['still unrated when the date is unreadable',               86, 86, 0, 30, null, 'unrated'],
    ['ONE rated row is enough to clear it',                     86, 86, 1, 30, 0,  'fresh'],
    ['a fully rated pool is fresh',                             86, 86, 86, 30, 0, 'fresh'],
    ['NO selection ran ⇒ never unrated (flag off/shadow)',      86, 86, 0, 0,  0,  'fresh'],
    ['a band-0 verdict IS a rating (counted by the caller)',    86, 86, 86, 30, 0, 'fresh'],
  ]
  for (const [label, rows, withMo, withFit, withRank, ageDays, expected] of unratedTable) {
    it(`unrated: ${label} → ${expected}`, () =>
      expect(st(rows, withMo, ageDays, withFit, withRank)).toBe(expected))
  }

  it('PRECEDENCE: unscored OUTRANKS unrated — no market data cannot be fixed by rating it', () => {
    expect(st(86, 0, 0, 0, 30)).toBe('unscored')
  })

  it('PRECEDENCE: unrated OUTRANKS stale AND unknown — a pool nobody judged is wrong, not merely old', () => {
    expect(st(86, 86, RESEARCH_TTL_DAYS + 99, 0, 30)).toBe('unrated')
    expect(st(86, 86, null, 0, 30)).toBe('unrated')
  })

  it('FLAG-OFF BYTE-IDENTITY: at off/shadow both target-set counts read 0, so `unrated` is unreachable', () => {
    // The read mapper leaves theme_fit AND selection_rank undefined unless KEYWORD_TARGET_SET=on.
    // That pair — 0 rated AND 0 selected — must never produce the banner, or every listing in the
    // portal would show it the moment the flag is rolled back.
    for (const age of [0, 1, RESEARCH_TTL_DAYS, RESEARCH_TTL_DAYS + 1, null]) {
      expect(st(86, 86, age, 0, 0)).not.toBe('unrated')
    }
  })
})

describe('deriveMarketDataHealth — counts + fail-open', () => {
  const row = (mo: number | null, rank: number | null, fit: number | null = 2) =>
    ({ marketOpportunity: mo, selectionRank: rank, themeFit: fit })

  it('reproduces the LIVE B0GVV3XL4T verdict end to end', () => {
    const pool = Array.from({ length: 88 }, () => row(null, null, null))
    const h = deriveMarketDataHealth(pool, daysAgo(46), { ttlDays: RESEARCH_TTL_DAYS, now: NOW })
    expect(h.rows).toBe(88)
    expect(h.rowsWithMarketOpportunity).toBe(0)
    expect(h.rowsWithSelectionRank).toBe(0)
    expect(h.rowsWithThemeFit).toBe(0)
    expect(h.ageDays).toBe(46)
    expect(h.ttlDays).toBe(RESEARCH_TTL_DAYS)
    expect(h.state).toBe('unscored')
  })

  it('reproduces the SECOND live shape: market data cured, theme_fit still absent (2026-08-09)', () => {
    // 86 rows all carrying market_opportunity, 30 holding a selection rank, NOT ONE rated. The
    // banner must say "never rated against this design", not "fresh".
    const pool = Array.from({ length: 86 }, (_, i) => row(6, i < 30 ? i + 1 : null, null))
    const h = deriveMarketDataHealth(pool, daysAgo(0), { ttlDays: RESEARCH_TTL_DAYS, now: NOW })
    expect(h.rows).toBe(86)
    expect(h.rowsWithMarketOpportunity).toBe(86)
    expect(h.rowsWithSelectionRank).toBe(30)
    expect(h.rowsWithThemeFit).toBe(0)
    expect(h.state).toBe('unrated')
  })

  it('a band-0 verdict is a RATING, not an absence — it must clear `unrated`', () => {
    const pool = Array.from({ length: 5 }, (_, i) => row(6, i + 1, 0))
    const h = deriveMarketDataHealth(pool, daysAgo(0), { ttlDays: RESEARCH_TTL_DAYS, now: NOW })
    expect(h.rowsWithThemeFit).toBe(5)
    expect(h.state).toBe('fresh')
  })

  it('carriesThemeFit / hasAnyThemeFit mirror the market predicate exactly', () => {
    expect(carriesThemeFit({ themeFit: 0 })).toBe(true)
    expect(carriesThemeFit({ themeFit: 3 })).toBe(true)
    expect(carriesThemeFit({ themeFit: null })).toBe(false)
    expect(carriesThemeFit({})).toBe(false)              // off/shadow: the key is absent
    expect(carriesThemeFit({ themeFit: NaN })).toBe(false)
    expect(carriesThemeFit(null)).toBe(false)
    expect(hasAnyThemeFit([{ themeFit: null }, { themeFit: 1 }])).toBe(true)
    expect(hasAnyThemeFit([{ themeFit: null }, {}])).toBe(false)
    expect(hasAnyThemeFit(null)).toBe(false)
  })

  it('counts scored rows and selected targets independently', () => {
    const h = deriveMarketDataHealth(
      [row(7, 1), row(null, 2), row(0, null), row(null, null)],
      daysAgo(2), { ttlDays: RESEARCH_TTL_DAYS, now: NOW },
    )
    expect(h.rows).toBe(4)
    expect(h.rowsWithMarketOpportunity).toBe(2)          // 7 and a measured 0
    expect(h.rowsWithSelectionRank).toBe(2)              // ranks 1 and 2
    expect(h.state).toBe('fresh')
  })

  it('selectionRank 0 counts as selected (rank is 0-indexable; NOT NULL is the membership rule)', () => {
    expect(deriveMarketDataHealth([row(5, 0)], daysAgo(1), { ttlDays: RESEARCH_TTL_DAYS, now: NOW })
      .rowsWithSelectionRank).toBe(1)
  })

  it('empty pool → state empty, all counts 0, researchedAt echoed', () => {
    const h = deriveMarketDataHealth([], daysAgo(3), { ttlDays: RESEARCH_TTL_DAYS, now: NOW })
    expect(h).toMatchObject({ rows: 0, rowsWithMarketOpportunity: 0, rowsWithSelectionRank: 0, rowsWithThemeFit: 0, state: 'empty', ageDays: 3 })
  })

  it('null rows → empty, never a throw', () => {
    expect(deriveMarketDataHealth(null, null, { ttlDays: RESEARCH_TTL_DAYS, now: NOW }).state).toBe('empty')
  })

  it('FAIL-OPEN: a row array that throws while being read degrades to unknown, never propagates', () => {
    const hostile = new Proxy([{}], { get() { throw new Error('read failed') } }) as unknown as { marketOpportunity?: number | null }[]
    expect(deriveMarketDataHealth(hostile, null, { ttlDays: RESEARCH_TTL_DAYS, now: NOW }).state).toBe('unknown')
  })

  it('unknownMarketDataHealth is the honest zero-value (never a fabricated fresh)', () => {
    expect(unknownMarketDataHealth(RESEARCH_TTL_DAYS)).toEqual({
      rows: 0, rowsWithMarketOpportunity: 0, rowsWithSelectionRank: 0, rowsWithThemeFit: 0,
      researchedAt: null, ageDays: null, ttlDays: RESEARCH_TTL_DAYS, state: 'unknown',
    })
  })
})
