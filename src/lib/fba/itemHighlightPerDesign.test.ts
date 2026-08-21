/**
 * Item Highlight on MULTI-DESIGN families = ONE SHARED LINE (PO 2026-08-21, B0DQ5YZH38
 * BD Boss Definition / BM Beast Mode / DQ Don't Quit / RIACG Relax I'm a CEO / RK Real King).
 *
 * The ruling: design names are stripped (each child's title already carries its design) and every
 * phrase must be TRUE FOR EVERY DESIGN — the pool is rated against EACH design's card and a phrase
 * composes only when its fit is >= 2 under EVERY design (min over designs).
 *
 * Pins: (1) min-over-designs — a phrase fit 3/3/3/3/1 is excluded, 2/2/3/2/2 composes; (2) a
 * partially rated pool HOLDS `designs-unrated` naming the missing keys — never a line from a partial
 * judgment; (3) union-title coverage — a phrase covered by ONE design's title never composes;
 * (4) the ONE line is identical on every per-child entry; (5) every design's name tokens are
 * excluded even when rated fit 3 everywhere; (6) single-design parity — buildItemHighlights ignores
 * the per-design column, and a one-group family equals buildItemHighlights on the same inputs;
 * (7) the sticky gate never snaps a per-design marker row to an accepted broadcast push.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('OpenAI must never be called by the Item Highlights producer') })
vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create } } } }))

import { buildItemHighlights, buildItemHighlightsPerDesign, IH_HOLD_MESSAGES } from './listingPipeline'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'
import { applyStickyDetails } from './stickyDetails'
import { collapseSharedIhRows, perDesignIhRows } from './perDesignItemHighlights'
import { makeCoverageChecker } from '@/lib/keyword-engine/coverage-core'
import { DESIGN_RATED_MIN_SHARE, minFitOverDesigns, unratedDesignKeys, parseThemeFitByDesign } from '@/lib/keyword-engine/themeFitByDesign'
import { THEME_RATE_MIN_SHARE } from '@/lib/keyword-engine/themeRatingRun'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const KEYS = ['BD', 'BM', 'DQ', 'RIACG', 'RK'] as const
type Fits = Partial<Record<(typeof KEYS)[number], 0 | 1 | 2 | 3>>

/** A pool row rated under each design (a missing key = never rated under that design). */
const kw = (keyword: string, searchVolume: number, fits: Fits | number | null = 3): AnalyzedKeyword => {
  const byDesign = fits === null ? null
    : typeof fits === 'number' ? Object.fromEntries(KEYS.map((k) => [k, { fit: fits, about: 'gym' }]))
      : Object.fromEntries(Object.entries(fits).map(([k, f]) => [k, { fit: f, about: 'gym' }]))
  return { keyword, searchVolume, themeFit: 3, themeFitByDesign: byDesign } as unknown as AnalyzedKeyword
}

const GILDAN = DEFAULT_BLANK_SPECS[1]

const BD = { key: 'BD', designName: 'Boss Definition', skus: [{ sku: 'BD64000L-BK', asin: 'B0BD000001' }], titles: ['THE CEO Boss Definition Shirt for Men Funny Office Tee'] }
const BM = { key: 'BM', designName: 'Beast Mode', skus: [{ sku: 'BM64000L-BK', asin: 'B0BM000001' }, { sku: 'BM64000M-BK', asin: 'B0BM000002' }], titles: ['THE CEO Beast Mode Shirt for Men Workout Tee'] }
const DQ = { key: 'DQ', designName: "Don't Quit", skus: [{ sku: 'DQ64000L-BK', asin: 'B0DQ000001' }], titles: ["THE CEO Don't Quit Gym Motivation Shirt for Men Tee"] }
const RIACG = { key: 'RIACG', designName: "Relax I'm a CEO", skus: [{ sku: 'RIACG64000L-BK', asin: 'B0RI000001' }], titles: ["THE CEO Relax I'm a CEO Shirt for Men Funny Boss Tee"] }
const RK = { key: 'RK', designName: 'Real King', skus: [{ sku: 'RK64000L-BK', asin: 'B0RK000001' }], titles: ['THE CEO Real King Graffiti Shirt for Men Crown Tee'] }
const GROUPS = [BD, BM, DQ, RIACG, RK]
const FAMILY_TITLE = 'Funny Shirts for Men Graphic Tees'

/** Shared category phrases true for every design (>= 2 everywhere) + the ruling's two twins. */
const SHARED: AnalyzedKeyword[] = [
  kw('graphic tees for men', 9000, { BD: 3, BM: 3, DQ: 3, RIACG: 3, RK: 3 }),
  kw('funny tshirts men', 8000, { BD: 3, BM: 2, DQ: 2, RIACG: 3, RK: 2 }),
  kw('novelty shirts for guys', 7000, { BD: 2, BM: 2, DQ: 3, RIACG: 2, RK: 2 }),     // the 2/2/3/2/2 twin
  kw('mens graphic apparel', 6500, { BD: 3, BM: 3, DQ: 3, RIACG: 3, RK: 2 }),
  kw('sarcastic shirts for men', 6000, { BD: 3, BM: 2, DQ: 2, RIACG: 3, RK: 2 }),
  kw('humor tops for men', 5500, 2),
  kw('cool tshirts for men', 5000, 2),
  kw('statement tee shirts', 4500, 2),
  kw('attitude shirts men', 4000, 2),
  kw('mens novelty clothing', 3800, 2),
]
const WOMEN = kw('motivational shirts women', 9500, { BD: 3, BM: 3, DQ: 3, RIACG: 3, RK: 1 })   // the 3/3/3/3/1 twin
const POOL: AnalyzedKeyword[] = [...SHARED, WOMEN]

const build = (pool: AnalyzedKeyword[], groups = GROUPS) =>
  buildItemHighlightsPerDesign({ groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })

describe('the shared line — min over designs (PO 2026-08-21)', () => {
  const r = build(POOL)
  const line = r.shared.value.toLowerCase()

  it('composes ONE line, >= 107 chars, with no OpenAI call', () => {
    expect(r.shared.hold).toBeNull()
    expect(r.shared.value.length).toBeGreaterThanOrEqual(107)
    expect(r.shared.designKeys).toEqual(['BD', 'BM', 'DQ', 'RIACG', 'RK'])
    expect(create).not.toHaveBeenCalled()
  })

  it('a phrase fit 3/3/3/3/1 ("Motivational Shirts Women" — fit 1 on the Real King graffiti tee) is EXCLUDED', () => {
    expect(minFitOverDesigns(WOMEN, [...KEYS])).toBe(1)
    expect(line).not.toContain('motivational shirts women')
  })

  it('a phrase fit 2/2/3/2/2 composes (true for every design)', () => {
    expect(minFitOverDesigns(SHARED[2], [...KEYS])).toBe(2)
    expect(line).toContain('novelty shirts for guys')
  })

  it('the ONE line is identical on every design and every per-child entry', () => {
    expect(new Set(r.perDesign.map((d) => d.value)).size).toBe(1)
    expect(r.perChild.map((e) => e.sku)).toEqual(['BD64000L-BK', 'BM64000L-BK', 'BM64000M-BK', 'DQ64000L-BK', 'RIACG64000L-BK', 'RK64000L-BK'])
    for (const e of r.perChild) {
      expect(e.item_highlight).toBe(r.shared.value)
      expect(e.hold).toBeNull()
    }
    expect(r.perChild.find((e) => e.sku === 'RK64000L-BK')?.designName).toBe('Real King')
  })

  it('the UI collapses the identical per-design rows into ONE "shared across N designs" row', () => {
    const rows = perDesignIhRows(r.perChild)
    expect(rows).toHaveLength(5)
    const collapsed = collapseSharedIhRows(rows)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].designs.map((d) => d.designKey)).toEqual(['BD', 'BM', 'DQ', 'RIACG', 'RK'])
    expect(collapsed[0].skuCount).toBe(6)
    expect(collapsed[0].line).toBe(r.shared.value)
    // The capability stays: rows that differ do not collapse.
    const differing = collapseSharedIhRows([...rows.slice(0, 4), { ...rows[4], line: 'Something Else' }])
    expect(differing).toHaveLength(2)
  })
})

describe('the shared line — partial rating HOLDS, names the missing designs (never a partial judgment)', () => {
  it('a pool with NO rating under RK holds `designs-unrated` with ["RK"]; no line anywhere', () => {
    const partial = POOL.map((k) => {
      const { RK: _rk, ...rest } = (k.themeFitByDesign ?? {}) as Record<string, { fit: 0 | 1 | 2 | 3 }>
      return { ...k, themeFitByDesign: rest } as AnalyzedKeyword
    })
    expect(unratedDesignKeys(partial, [...KEYS])).toEqual(['RK'])
    const r = build(partial)
    expect(r.shared.hold).toBe('designs-unrated')
    expect(r.shared.missingDesigns).toEqual(['RK'])
    expect(r.shared.value).toBe('')
    for (const d of r.perDesign) { expect(d.value).toBe(''); expect(d.hold).toBe('designs-unrated'); expect(d.missingDesigns).toEqual(['RK']) }
    for (const e of r.perChild) { expect(e.item_highlight).toBe(''); expect(e.hold).toBe('designs-unrated') }
    expect(IH_HOLD_MESSAGES['designs-unrated']).toMatch(/per_design: true/)
  })

  it('a design rated on fewer than 30% of the rows is unrated (the rater\'s own acceptance share)', () => {
    expect(DESIGN_RATED_MIN_SHARE).toBe(THEME_RATE_MIN_SHARE)
    const thin = POOL.map((k, i) => {
      if (i < 2) return k
      const { RK: _rk, ...rest } = (k.themeFitByDesign ?? {}) as Record<string, { fit: 0 | 1 | 2 | 3 }>
      return { ...k, themeFitByDesign: rest } as AnalyzedKeyword
    })
    expect(unratedDesignKeys(thin, [...KEYS])).toEqual(['RK'])   // 2/11 < 30%
    expect(build(thin).shared.hold).toBe('designs-unrated')
  })

  it('a row missing ANY design\'s rating has a null shared fit (excluded by the fit gate), even when every design is rated overall', () => {
    const row = kw('edge phrase shirts', 100, { BD: 3, BM: 3, DQ: 3, RIACG: 3 })
    expect(minFitOverDesigns(row, [...KEYS])).toBeNull()
    const r = build([...POOL, row])
    expect(r.shared.hold).toBeNull()
    expect(r.shared.value.toLowerCase()).not.toContain('edge phrase')
  })

  it('a completely unrated pool (no per-design column at all — pre-061 rows) holds with every key named', () => {
    const r = build(POOL.map((k) => ({ ...k, themeFitByDesign: null } as AnalyzedKeyword)))
    expect(r.shared.hold).toBe('designs-unrated')
    expect(r.shared.missingDesigns).toEqual(['BD', 'BM', 'DQ', 'RIACG', 'RK'])
  })
})

describe('the shared line — union-title coverage + every design name stripped', () => {
  it('a phrase covered by ONLY ONE design\'s title (DQ: "gym motivation shirts") never composes for the family', () => {
    const phrase = kw('gym motivation shirts', 9999, 3)
    expect(makeCoverageChecker(DQ.titles[0])('gym motivation shirts')).toBe(true)
    expect(makeCoverageChecker(BM.titles[0])('gym motivation shirts')).toBe(false)
    const r = build([phrase, ...POOL])
    expect(r.shared.hold).toBeNull()
    expect(r.shared.value.toLowerCase()).not.toContain('gym motivation shirts')
  })

  it('a phrase naming ANY design ("beast mode shirt", "real king tee") is excluded even when rated fit 3 under every design', () => {
    const r = build([kw('beast mode shirt', 9999, 3), kw('real king tee', 9998, 3), kw('dont quit shirts', 9997, 3), ...POOL])
    expect(r.shared.hold).toBeNull()
    expect(r.shared.value.toLowerCase()).not.toMatch(/beast|king|quit/)
    expect(r.shared.foreignDropped).toBe(3)
  })
})

describe('single-design parity (pin) + the per-design column parser', () => {
  it('buildItemHighlights ignores themeFitByDesign entirely — a single-design family is byte-identical with or without it', () => {
    const plain = SHARED.map((k) => ({ keyword: k.keyword, searchVolume: k.searchVolume, themeFit: 3 } as unknown as AnalyzedKeyword))
    const withCol = SHARED.map((k) => ({ keyword: k.keyword, searchVolume: k.searchVolume, themeFit: 3, themeFitByDesign: { RK: { fit: 0, about: 'x' } } } as unknown as AnalyzedKeyword))
    const a = buildItemHighlights({ finalTitle: BM.titles[0], pool: plain, apparelProduct: true, blankBrand: GILDAN, netTitles: BM.titles })
    const b = buildItemHighlights({ finalTitle: BM.titles[0], pool: withCol, apparelProduct: true, blankBrand: GILDAN, netTitles: BM.titles })
    expect(a.value.length).toBeGreaterThanOrEqual(107)
    expect(b).toEqual(a)
  })

  it('ONE group rated under its own key composes byte-identically to buildItemHighlights (no partition, min over one design = its fit)', () => {
    const pool = SHARED.map((k) => ({ ...k, themeFit: k.themeFitByDesign!.BM.fit } as AnalyzedKeyword))
    const single = buildItemHighlights({ finalTitle: BM.titles[0], pool, apparelProduct: true, blankBrand: GILDAN, netTitles: BM.titles })
    const via = build(pool, [BM])
    expect(via.perDesign[0].value).toBe(single.value)
    expect(via.perDesign[0].hold).toBe(single.hold)
  })

  it('parseThemeFitByDesign keeps only well-formed {fit: 0-3} entries', () => {
    expect(parseThemeFitByDesign(null)).toBeNull()
    expect(parseThemeFitByDesign([])).toBeNull()
    expect(parseThemeFitByDesign({ BM: { fit: 3, about: 'gym' }, RK: { fit: 7 }, DQ: 'x', BD: { fit: 0 } }))
      .toEqual({ BM: { fit: 3, about: 'gym' }, BD: { fit: 0, about: null } })
  })
})

describe('the broadcast Item Highlight row on a multi-design family is NEVER design-specific', () => {
  it('the sticky gate leaves a per-design MARKER row untouched even when a broadcast push was accepted', () => {
    const fresh = [{ field_name: 'Item Highlight', sp_api_key: 'title_differentiation', recommended_value: '', per_design: true, current_value: null }]
    const prior = [{ field_name: 'Item Highlight', sp_api_key: 'title_differentiation', recommended_value: 'Beast Mode Shirt, Gym Motivation Shirts, Workout Graphic Tees', current_value: 'Beast Mode Shirt, Gym Motivation Shirts, Workout Graphic Tees' }]
    const accepted = new Map([['titledifferentiation', 'Beast Mode Shirt, Gym Motivation Shirts, Workout Graphic Tees']])
    const out = applyStickyDetails({ fresh, prior, acceptedByKey: accepted, log: () => {} })
    expect(out.details[0].recommended_value).toBe('')
    expect(out.details[0].per_design).toBe(true)
    expect(out.ihReverted).toBe(false)
    // and the prior-equality fallback path (push-log unreadable) must not carry a line either
    const out2 = applyStickyDetails({ fresh, prior, acceptedByKey: null, log: () => {} })
    expect(out2.details[0].recommended_value).toBe('')
    expect(out2.details[0].current_value ?? null).toBeNull()
  })
})
