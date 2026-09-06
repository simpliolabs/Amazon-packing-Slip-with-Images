/**
 * Item Highlight on MULTI-DESIGN families = ONE LINE PER DESIGN (PO ruling 2026-09-06, refining the
 * 2026-08-21 "one shared line" ruling this file used to pin).
 *
 * WHAT WAS WRONG WITH THE SHARED LINE. To make ONE line true of every design, the old code unioned
 * every design's foreign-token set (so EVERY design's own name/identity was foreign to the shared
 * line, including its OWN), filtered the pool to phrases foreign to NONE of them, and ranked
 * survivors by the MINIMUM theme-fit across every design. A phrase carrying any design's own
 * vocabulary was foreign to every OTHER design by construction, so design-specific vocabulary was
 * stripped BY CONSTRUCTION — six unrelated designs shipped the identical, generic line.
 *
 * THE FIX: for each design `d`, compose against `d`'s OWN theme-fit rating (never a minimum over
 * siblings) and a foreign set built from every OTHER design's vocabulary only — `d`'s own name/
 * identity is never foreign to itself. Reuses the SAME composer (`buildItemHighlights`) the
 * single-design path ships; no fork, no LLM.
 *
 * Pins: (1) each design composes its OWN line — distinct per design, no min-over-designs; (2) a
 * design's own name/identity phrase survives INTO its own line and is excluded from every sibling's
 * (the exact class the shared-line bug stripped from ALL of them, including its own); (3) a design
 * whose OWN column is unrated (< 30% of pool rows) holds `designs-unrated` in ISOLATION — siblings
 * still compose; (4) union-title coverage is now PER DESIGN — a phrase covered by THAT design's own
 * title never composes for it, regardless of siblings; (5) single-design parity — buildItemHighlights
 * ignores the per-design column, and a one-group family equals buildItemHighlights on the same
 * inputs; (6) the sticky gate never snaps a per-design marker row to an accepted broadcast push;
 * (7) `shared.value` is only ever non-empty in the degenerate case where every design's line happens
 * to be byte-identical (usually: every design held).
 *
 * CHANGED ASSERTIONS (were pinned to the old shared-line behavior, now updated — see each comment):
 *   - "composes ONE line >= 107 chars" -> each design's OWN line >= 107 chars (no single shared value).
 *   - "phrase fit 3/3/3/3/1/1 excluded from the shared line" -> excluded from the ONE design that
 *     rates it fit 1; composes for the five that rate it >= 2 (this is the whole point of the fix).
 *   - "the ONE line is identical on every design" -> the SIX lines are pairwise distinct.
 *   - "a pool with no rating under RK holds designs-unrated for EVERY design" -> holds only for RK;
 *     the other five (fully rated) still compose (this is exactly what the fix enables).
 *   - "UI collapses 5 identical rows into 1" -> distinct lines no longer collapse; kept as a test that
 *     the capability (rows that DO differ don't collapse) still works, now via the ordinary case.
 *
 * PROPERTY ASSERTIONS ONLY (never an exact composed string): the composer's phrase-ordering inside a
 * design's own line is not this task's contract — a follow-up task reorders picks (Tier A/B repeat
 * handling) and must not break these tests. Every assertion below is "line X contains/omits phrase Y"
 * or a length/shape check, never `.toBe('<exact line>')`.
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

const KEYS = ['BD', 'BM', 'DQ', 'RIACG', 'RK', 'SM'] as const
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
const SM = { key: 'SM', designName: 'Self Made', skus: [{ sku: 'SM64000L-BK', asin: 'B0SM000001' }], titles: ['THE CEO Self Made Grind Shirt for Men Hustle Tee'] }
const GROUPS = [BD, BM, DQ, RIACG, RK, SM]
const FAMILY_TITLE = 'Funny Shirts for Men Graphic Tees'

/** Category phrases rated true for every design (>= 2 everywhere) — the pool's generic bulk. */
const SHARED: AnalyzedKeyword[] = [
  kw('graphic tees for men', 9000, { BD: 3, BM: 3, DQ: 3, RIACG: 3, RK: 3, SM: 3 }),
  kw('funny tshirts men', 8000, { BD: 3, BM: 2, DQ: 2, RIACG: 3, RK: 2, SM: 2 }),
  kw('novelty shirts for guys', 7000, { BD: 2, BM: 2, DQ: 3, RIACG: 2, RK: 2, SM: 2 }),
  kw('mens graphic apparel', 6500, { BD: 3, BM: 3, DQ: 3, RIACG: 3, RK: 2, SM: 3 }),
  kw('sarcastic shirts for men', 6000, { BD: 3, BM: 2, DQ: 2, RIACG: 3, RK: 2, SM: 2 }),
  kw('humor tops for men', 5500, 2),
  kw('cool tshirts for men', 5000, 2),
  kw('statement tee shirts', 4500, 2),
  kw('attitude shirts men', 4000, 2),
  kw('mens novelty clothing', 3800, 2),
]
// The ruling's original twin: fit 3 for five designs, fit 1 (below MIN_THEME_FIT) for RK only.
const WOMEN = kw('motivational shirts women', 9500, { BD: 3, BM: 3, DQ: 3, RIACG: 3, RK: 1, SM: 3 })

/** ONE distinguishing phrase per design — carries that design's own name tokens, rated true for
 *  every design (fit uniform so the ONLY variable under test is the name-based partition, not fit),
 *  and never fully covered by that design's OWN title (each adds a word the title doesn't have) so
 *  it is a genuine composer candidate for its owner, not a redundant restatement of the title.
 *  STRICT NAMES makes each phrase foreign to the other five by construction — the exact class of
 *  token the shared-line bug stripped from EVERY design, including its own. */
const OWN_BD = kw('boss definition motivation wear', 9999, 3)
const OWN_BM = kw('beast mode athletic apparel', 9998, 3)
const OWN_DQ = kw('dont quit athletic wear', 9997, 3)
const OWN_RIACG = kw('relax ceo energy wear', 9996, 3)
const OWN_RK = kw('real king throne apparel', 9995, 3)
const OWN_SM = kw('self made hustle wear', 9994, 3)
const OWN_PHRASES = [OWN_BD, OWN_BM, OWN_DQ, OWN_RIACG, OWN_RK, OWN_SM]

const POOL: AnalyzedKeyword[] = [...OWN_PHRASES, ...SHARED, WOMEN]

const build = (pool: AnalyzedKeyword[], groups = GROUPS) =>
  buildItemHighlightsPerDesign({ groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })

const lineFor = (r: ReturnType<typeof build>, key: string): string => (r.perDesign.find((d) => d.designKey === key)?.value ?? '').toLowerCase()
const holdFor = (r: ReturnType<typeof build>, key: string) => r.perDesign.find((d) => d.designKey === key)?.hold ?? null

describe('each design composes its OWN line (PO 2026-09-06, refining the shared-line ruling)', () => {
  const r = build(POOL)

  it('every design composes >= 107 chars, no OpenAI call', () => {
    for (const k of KEYS) expect(lineFor(r, k).length).toBeGreaterThanOrEqual(107)
    expect(create).not.toHaveBeenCalled()
    expect(r.shared.designKeys).toEqual([...KEYS])
  })

  it('the six lines are pairwise DISTINCT — the shared-line bug made them byte-identical', () => {
    const lines = KEYS.map((k) => lineFor(r, k))
    expect(new Set(lines).size).toBe(KEYS.length)
  })

  it("each design's OWN name phrase appears in ITS line and in NO sibling's line (was stripped from ALL of them, including its own, under the old min-over-designs rule)", () => {
    const cases: [string, string][] = [
      ['BD', 'boss definition motivation wear'],
      ['BM', 'beast mode athletic apparel'],
      ['DQ', 'dont quit athletic wear'],
      ['RIACG', 'relax ceo energy wear'],
      ['RK', 'real king throne apparel'],
      ['SM', 'self made hustle wear'],
    ]
    for (const [owner, phrase] of cases) {
      expect(lineFor(r, owner)).toContain(phrase)
      for (const other of KEYS) {
        if (other === owner) continue
        expect(lineFor(r, other)).not.toContain(phrase)
      }
    }
  })

  it('a phrase fit 3 on five designs / fit 1 on RK composes for the five and is EXCLUDED only from RK — CHANGED from "excluded from the shared line always" (min-over-designs is no longer decisive)', () => {
    expect(minFitOverDesigns(WOMEN, [...KEYS])).toBe(1)   // the old min-over-designs verdict — still 1, no longer the caller's gate
    expect(lineFor(r, 'RK')).not.toContain('motivational shirts women')
    for (const k of ['BD', 'BM', 'DQ', 'RIACG', 'SM']) expect(lineFor(r, k)).toContain('motivational shirts women')
  })

  it('per-child entries carry each SKU\'s OWN design line, never a sibling\'s', () => {
    expect(r.perChild.map((e) => e.sku)).toEqual(['BD64000L-BK', 'BM64000L-BK', 'BM64000M-BK', 'DQ64000L-BK', 'RIACG64000L-BK', 'RK64000L-BK', 'SM64000L-BK'])
    for (const e of r.perChild) {
      expect(e.item_highlight.toLowerCase()).toBe(lineFor(r, e.designKey!))
      expect(e.hold).toBeNull()
    }
    expect(r.perChild.find((e) => e.sku === 'RK64000L-BK')?.designName).toBe('Real King')
  })

  it('shared.value is \'\' because the designs\' own lines differ — CHANGED from "shared.value carries the one line" (there is no broadcast line for a per-design family any more)', () => {
    expect(r.shared.value).toBe('')
    expect(r.shared.hold).toBeNull()   // every design composed — nothing to report as held
  })

  it('the per-design rows do NOT collapse in the UI (they genuinely differ) — CHANGED from "5 identical rows collapse to 1"; the collapse capability itself (rows that differ stay separate) is unchanged', () => {
    const rows = perDesignIhRows(r.perChild)
    expect(rows).toHaveLength(KEYS.length)
    const collapsed = collapseSharedIhRows(rows)
    expect(collapsed.length).toBe(KEYS.length)   // nothing to fold — every line is distinct
  })
})

describe('a design whose OWN rating is thin holds in ISOLATION — siblings still compose (CHANGED: the old rule held the WHOLE family)', () => {
  it('a pool with NO rating under RK holds `designs-unrated` for RK ONLY; the other five compose non-empty lines', () => {
    const partial = POOL.map((k) => {
      const { RK: _rk, ...rest } = (k.themeFitByDesign ?? {}) as Record<string, { fit: 0 | 1 | 2 | 3 }>
      return { ...k, themeFitByDesign: rest } as AnalyzedKeyword
    })
    expect(unratedDesignKeys(partial, [...KEYS])).toEqual(['RK'])
    const r = build(partial)

    // RK: held, isolated — its SKU carries the reason and an empty line.
    expect(holdFor(r, 'RK')).toBe('designs-unrated')
    expect(lineFor(r, 'RK')).toBe('')
    const rkEntry = r.perDesign.find((d) => d.designKey === 'RK')!
    expect(rkEntry.missingDesigns).toEqual(['RK'])
    for (const e of r.perChild.filter((e) => e.designKey === 'RK')) {
      expect(e.item_highlight).toBe('')
      expect(e.hold).toBe('designs-unrated')
    }

    // The other five: fully rated, unaffected — CHANGED from the old all-or-nothing gate.
    for (const k of ['BD', 'BM', 'DQ', 'RIACG', 'SM']) {
      expect(holdFor(r, k)).toBeNull()
      expect(lineFor(r, k).length).toBeGreaterThanOrEqual(107)
    }

    // shared.hold: null because SOMETHING composed (the marker-row consumer only reports "held"
    // when nothing did) — CHANGED from `designs-unrated` under the old all-or-nothing model.
    expect(r.shared.hold).toBeNull()
    expect(IH_HOLD_MESSAGES['designs-unrated']).toMatch(/per_design: true|per-design theme rating/)
  })

  it('a design rated on fewer than 30% of the rows is unrated (the rater\'s own acceptance share)', () => {
    expect(DESIGN_RATED_MIN_SHARE).toBe(THEME_RATE_MIN_SHARE)
    const thin = POOL.map((k, i) => {
      if (i < 2) return k
      const { RK: _rk, ...rest } = (k.themeFitByDesign ?? {}) as Record<string, { fit: 0 | 1 | 2 | 3 }>
      return { ...k, themeFitByDesign: rest } as AnalyzedKeyword
    })
    expect(unratedDesignKeys(thin, [...KEYS])).toEqual(['RK'])   // 2/17 < 30%
    const r = build(thin)
    expect(holdFor(r, 'RK')).toBe('designs-unrated')
    expect(holdFor(r, 'BD')).toBeNull()
  })

  it('a row missing ONLY RK\'s rating (present for every other design) never leaks into RK\'s own line; RK still composes from its OTHER rated rows', () => {
    const row = kw('edge phrase shirts', 100, { BD: 3, BM: 3, DQ: 3, RIACG: 3, SM: 3 })   // no RK key at all
    expect(minFitOverDesigns(row, [...KEYS])).toBeNull()
    const r = build([...POOL, row])
    expect(holdFor(r, 'RK')).toBeNull()          // RK's OWN rated share is still fine (the rest of POOL rates it)
    expect(lineFor(r, 'RK')).not.toContain('edge phrase')
  })

  it('a completely unrated pool (no per-design column at all — pre-061 rows) holds EVERY design with the missing keys named', () => {
    const r = build(POOL.map((k) => ({ ...k, themeFitByDesign: null } as AnalyzedKeyword)))
    for (const k of KEYS) expect(holdFor(r, k)).toBe('designs-unrated')
    expect(r.shared.hold).toBe('designs-unrated')
    expect(r.shared.missingDesigns).toEqual([...KEYS])
  })
})

describe('union-title coverage is now PER DESIGN + every sibling name stripped', () => {
  it('a phrase covered by ONE design\'s OWN title (DQ: "gym motivation shirts") never composes for THAT design, but is not excluded from siblings on that basis', () => {
    const phrase = kw('gym motivation shirts', 9999, 3)
    expect(makeCoverageChecker(DQ.titles[0])('gym motivation shirts')).toBe(true)
    expect(makeCoverageChecker(BM.titles[0])('gym motivation shirts')).toBe(false)
    const r = build([phrase, ...POOL])
    expect(lineFor(r, 'DQ')).not.toContain('gym motivation shirts')
    // POSITIVE half (fix round 1, Important #2): the old union-of-titles model would ALSO have
    // excluded this phrase from BM (DQ's title covering it used to poison the shared pool for every
    // design). BM's OWN title does not cover it, so per-design coverage must let it survive into
    // BM's line — this is the assertion that actually distinguishes per-design coverage from the
    // union model line 2478 replaced.
    expect(lineFor(r, 'BM')).toContain('gym motivation shirts')
  })

  it('a phrase naming ANY design ("beast mode shirt", "real king tee") is excluded from every OTHER design even when rated fit 3 under all of them', () => {
    const r = build([kw('beast mode shirt', 9999, 3), kw('real king tee', 9998, 3), kw('dont quit shirts', 9997, 3), ...POOL])
    for (const k of ['BD', 'RIACG', 'SM']) {
      expect(lineFor(r, k)).not.toMatch(/beast mode shirt|real king tee|dont quit shirts/)
    }
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

  it('ONE group rated under its own key composes byte-identically to buildItemHighlights (no partition, no siblings to be foreign to)', () => {
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

describe('truth stage: a Classic-fit blank never claims "relaxed" (blank_specs-provable fit/fabric only)', () => {
  it('blank 18000/64000 (fit: Classic) — no design\'s line contains "relaxed" anywhere in this pool', () => {
    // This pool never harvests a "relaxed ..." phrase at all, so this test proves only the ORDINARY
    // case (a Classic blank's own spec padding only ever emits "Classic Fit", never invents "Relaxed
    // Fit") — the adversarial case (a harvested "relaxed fit" phrase actually PRESENT in the pool) is
    // the next test below, which is what closes Task 4's gap.
    expect(GILDAN.spec.fit).toBe('Classic')
    const r = build(POOL)
    for (const k of KEYS) expect(lineFor(r, k)).not.toContain('relaxed')
  })

  it('Task 4 CLOSED: a harvested "relaxed fit tee" phrase PRESENT in the pool (themeFit 3 for every design — otherwise a strong composer candidate) is rejected by ihTruthVerdict\'s new fit-claim rule and never composes for ANY design — the adversarial case the note above (pre-Task-4) could only flag, not prove', () => {
    expect(GILDAN.spec.fit).toBe('Classic')
    const adversarial = kw('relaxed fit tee design', 9990, 3)
    const r = build([adversarial, ...POOL])
    for (const k of KEYS) expect(lineFor(r, k)).not.toContain('relaxed')
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
