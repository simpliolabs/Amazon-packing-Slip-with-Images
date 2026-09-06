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
 *   - "`r.shared.foreignDropped` equals a fixed count (3)" -> DELETED, not replaced by an equivalent
 *     pin. The shared aggregate no longer names a single meaningful count under per-design isolation
 *     (each design drops a DIFFERENT number of foreign phrases); the replacement test (the "excluded
 *     from every OTHER design" case below) asserts per-design phrase exclusion directly instead of an
 *     aggregate number. Per-design counts still live on each `PerDesignItemHighlight.foreignDropped`.
 *   - the cross-design-name exclusion check narrowed from a WORD-LEVEL regex (`/beast|king|quit/` —
 *     matching any line containing any of a sibling's bare name-words anywhere) to WHOLE-PHRASE
 *     matching (`/beast mode shirt|real king tee|dont quit shirts/` — matching the exact candidate
 *     phrase) — per-design partition excludes the CANDIDATE PHRASE that names a sibling, not every
 *     line that happens to contain one of a sibling's bare words for an unrelated reason.
 *   - `IH_HOLD_MESSAGES['designs-unrated']`'s assertion widened from `toMatch(/per_design: true/)` to
 *     `toMatch(/per_design: true|per-design theme rating/)` to accommodate the per-design-isolated
 *     hold message's wording (see Minors #10/#11 in the final fix wave for the message text itself).
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
import { ihFoldWord, IH_INSIGNIFICANT } from './productDetailAttrs'
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

/** TASK 6 (2026-09-06, absolute no-repeat) test helper: an INDEPENDENT fold over the RETURNED
 *  bytes — deliberately NOT the composer's own private `significantFolded` (itemHighlightComposer.ts)
 *  — so this proves the wire's output obeys the PO's ruling, not merely the composer's internal
 *  bookkeeping (`test-proves-the-mock-not-the-wire`). Mirrors the composer's own fold RULES
 *  (`ihFoldWord` + the same gender-plural collapse) using only the exported primitives. */
const GENDER_FOLDS: Record<string, string> = { women: 'woman', men: 'man', ladies: 'lady', gals: 'gal' }
const dupedFoldedTokens = (line: string): string[] => {
  const counts = new Map<string, number>()
  for (const raw of line.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    const f = ihFoldWord(raw)
    const w = GENDER_FOLDS[f] ?? f
    if (!w || IH_INSIGNIFICANT.has(w)) continue
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, c]) => c > 1).map(([w]) => w)
}

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

  it('a phrase fit 3 on five designs / fit 1 on RK is excluded from RK on FIT alone — the min-over-designs verdict is still 1, no longer the caller\'s gate', () => {
    // RESTORED (final fix wave, 2026-09-06, Important #3): the POSITIVE half of this assertion was
    // deleted with a factually WRONG justification. The comment used to claim it moved to the Task 5
    // describe block below because "Task 5 wires the family's audience_lean into the composer" and
    // this build would therefore trigger the forced-gender rule on the five non-RK designs. It does
    // not: `build()` (this file's own helper, defined above) never passes `audienceLean` to
    // `buildItemHighlightsPerDesign` — rule (c2) is a no-op on every case in THIS describe block, so
    // the phrase composes for the five non-RK designs for the ORIGINAL reason (Task 1's fit-based
    // partition), unchanged, exactly as it did before Task 5 existed.
    //
    // This was the ONLY guard against a silent reversal to min-over-designs: if
    // `themeFit: minFitOverDesigns(k, designKeys)` were ever restored at listingPipeline.ts:2495 (the
    // pre-Task-1 shared-line gate this task replaced), WOMEN's min-over-designs verdict — asserted
    // below to be 1 (RK's fit) — would exclude the phrase from EVERY design, not just RK. With the
    // positive half deleted, no remaining test in this file would have caught that regression (see
    // the wave's report for a one-time RED demonstration: temporarily restoring the min-over-designs
    // line at :2495 turns this exact assertion red).
    //
    // The genuinely audience-rule-driven case (a UNISEX family, a bare gendered phrase excluded from
    // ALL designs including RK, because of `audienceLean`, not fit) is a DIFFERENT fixture entirely —
    // it lives in its own Task 5 describe block below, with its own dedicated small pool (this
    // block's big SHARED bank is heavily "for Men" market copy and would starve every design's
    // candidate count for a reason orthogonal to the rule that block exists to test). That block is
    // not a replacement for this one; both are needed.
    expect(minFitOverDesigns(WOMEN, [...KEYS])).toBe(1)
    for (const k of ['BD', 'BM', 'DQ', 'RIACG', 'SM']) expect(lineFor(r, k)).toContain('motivational shirts women')
    expect(lineFor(r, 'RK')).not.toContain('motivational shirts women')
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
    // TASK 6 (2026-09-06, absolute no-repeat): SHARED's own phrases share `shirt`/`man`/`graphic`
    // (see file header) so only 2 of its 10 rows ever compose as mutually non-repeating Tier A —
    // below MIN_CANDIDATES (3) regardless of blank-spec padding. Two all-new local phrases are
    // added (LOCAL to this test — SHARED itself is used file-wide and stays untouched) so the parity
    // pin below still has a genuine composed value to compare, not a HOLD.
    const EXTRA: AnalyzedKeyword[] = [
      { keyword: 'weekend cookout vibes', searchVolume: 100, themeFit: 3 } as unknown as AnalyzedKeyword,
      { keyword: 'holiday backyard celebration', searchVolume: 90, themeFit: 3 } as unknown as AnalyzedKeyword,
    ]
    const plain = [...SHARED, ...EXTRA].map((k) => ({ keyword: k.keyword, searchVolume: k.searchVolume, themeFit: 3 } as unknown as AnalyzedKeyword))
    const withCol = [...SHARED, ...EXTRA].map((k) => ({ keyword: k.keyword, searchVolume: k.searchVolume, themeFit: 3, themeFitByDesign: { RK: { fit: 0, about: 'x' } } } as unknown as AnalyzedKeyword))
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

/**
 * TASK 5 (2026-09-06, item-highlights-per-design plan, controller-added after Task 1's review):
 * per-design audience truth. Root cause (proven by the Task 1 implementer): the Item Highlights path
 * had NO audience-lean rule at all — `ihTruthVerdict` hardcoded `audienceLean: null`, so a UNISEX
 * design's own scoped pool could carry a bare "for Women"/"for Men" market phrase unchecked (the live
 * PO complaint, "Why is Women repeating Twice?", was on UNISEX family B0DSCDZC6K). The fix reuses the
 * SAME forced-gender predicate the title path already has (`phraseTruthVerdict`'s (c2) rule,
 * contentTruth.ts) — widened to also read `field: 'highlights'` — never a second gender rule.
 *
 * A DEDICATED, SMALL pool (not this file's big POOL/SHARED bank — see the comment on the test above
 * this block) so candidate counts are easy to reason about and the assertions are not fragile against
 * unrelated "for Men" market copy already baked into Task 1's fixture.
 */
describe('Task 5: per-design audience truth in the Item Highlight composer', () => {
  /** Gender-neutral filler, rated for every design in `GROUPS` (Task 1's own six-design family) via
   *  the module's `kw()` helper — 3 candidates is enough to clear MIN_CANDIDATES with nothing for the
   *  forced-gender rule to act on, so any exclusion the tests below observe is provably the audience
   *  rule, not a starved pool. */
  const NEUTRAL_FILLER: AnalyzedKeyword[] = [
    kw('graphic novelty apparel', 9000, 3),
    kw('cool print clothing', 8500, 3),
    kw('trendy design gear', 8000, 3),
  ]
  /** TASK 7 (2026-09-06, PO ruling "1. Extend"): the masculine-slang twin of `WOMEN` above — same
   *  shape (a bare gendered market phrase, rated true for every design), but the exact live instance
   *  the final whole-branch reviewer caught: SIX unisex designs shipping "Novelty Shirts for Guys"
   *  because `guys` was invisible to the pre-Task-7 masculine lexicon (`m[ae]n['’]?s?` only). Deliberately
   *  NOT reusing NEUTRAL_FILLER's own vocabulary (no shared significant word) so a HOLD here could only
   *  be the audience rule, never an incidental Task-6 repeat collision. */
  const MEN_SLANG = kw('motivational shirts guys', 9500, 3)

  it('a UNISEX family: a bare gendered market phrase ("...women") composes for NO design — not even the five whose fit is high, and not RK (whose exclusion is independently a FIT fact, proven above)', () => {
    const r = buildItemHighlightsPerDesign({
      groups: GROUPS, pool: [...NEUTRAL_FILLER, WOMEN], apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex',
    })
    for (const k of KEYS) {
      expect(lineFor(r, k)).not.toContain('women')
      expect(lineFor(r, k).length).toBeGreaterThanOrEqual(107)   // genuinely composed, not held
      // TASK 6 (2026-09-06, absolute no-repeat): every design composes here (unlike T5-g's larger,
      // repeat-heavy pool — see that describe block's own comment), so this is where the "zero
      // repeated significant token" pin lives for a genuine six-design-under-unisex composition.
      expect(dupedFoldedTokens(lineFor(r, k))).toEqual([])
      // Also the non-vacuous version of itemHighlightPushSeam.test.ts's "Classic Fit ships" pin
      // (that file's own pool no longer composes at all under Task 6 — see its file header): GILDAN
      // is Classic-fit, so its own pad fact can only ever emit "Classic Fit", never "Relaxed Fit".
      expect(lineFor(r, k)).toContain('classic')
    }
  })

  it('a lean_female-ASSIGNED design MAY carry "Women" even while the family default is unisex — the assignment wins over the family value (resolveDesignAudienceLean\'s own precedence, reused unchanged)', () => {
    const rAssigned = buildItemHighlightsPerDesign({
      groups: [BD], pool: [...NEUTRAL_FILLER, WOMEN], apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex', audienceLeanByDesign: { BD: 'lean_female' },
    })
    expect(lineFor(rAssigned, 'BD')).toContain('motivational shirts women')
    // Sanity contrast: the SAME design, SAME pool, no assignment — inherits the family's unisex
    // default and excludes it (this is the property the test above already proves for all six; kept
    // here as a one-line same-inputs contrast so the precedence itself is visible in one place).
    const rUnassigned = buildItemHighlightsPerDesign({
      groups: [BD], pool: [...NEUTRAL_FILLER, WOMEN], apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex',
    })
    expect(lineFor(rUnassigned, 'BD')).not.toContain('women')
  })

  it('TASK 7: a UNISEX family: a bare gendered MASCULINE SLANG market phrase ("...for guys") composes for NO design — the PO\'s exact live instance, reproduced then closed', () => {
    const r = buildItemHighlightsPerDesign({
      groups: GROUPS, pool: [...NEUTRAL_FILLER, MEN_SLANG], apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex',
    })
    for (const k of KEYS) {
      expect(lineFor(r, k)).not.toContain('guys')
      expect(lineFor(r, k)).not.toContain('men')            // no bare masculine word leaks through either
      expect(lineFor(r, k).length).toBeGreaterThanOrEqual(107)   // genuinely composed, not held
      expect(dupedFoldedTokens(lineFor(r, k))).toEqual([])
    }
  })

  it('TASK 7: a lean_male-ASSIGNED design MAY carry "guys" even while the family default is unisex — the assignment wins over the family value, same precedence as the feminine case above', () => {
    const rAssigned = buildItemHighlightsPerDesign({
      groups: [BD], pool: [...NEUTRAL_FILLER, MEN_SLANG], apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex', audienceLeanByDesign: { BD: 'lean_male' },
    })
    expect(lineFor(rAssigned, 'BD')).toContain('motivational shirts guys')
    // Sanity contrast: the SAME design, SAME pool, no assignment — inherits the family's unisex
    // default and excludes it.
    const rUnassigned = buildItemHighlightsPerDesign({
      groups: [BD], pool: [...NEUTRAL_FILLER, MEN_SLANG], apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex',
    })
    expect(lineFor(rUnassigned, 'BD')).not.toContain('guys')
  })

  it('a UNISEX design whose OWN name carries the gender ("Lady Boss") keeps its own name-phrase, but still rejects an UNRELATED gendered market phrase — the exemption covers the design\'s identity, not every gendered phrase in its pool', () => {
    // Single-group family (Task 1\'s own "single-design parity" pin already proves
    // `buildItemHighlightsPerDesign` with ONE group is valid) — rated for ONLY this design's key, so
    // a phrase carrying "Lady"/"Women" can never be misread as leaking from a sibling's rating.
    const LADY_BOSS = { key: 'LB', designName: 'Lady Boss', skus: [{ sku: 'LB64000L-BK', asin: 'B0LB000001' }], titles: ['THE CEO Lady Boss Tee'] }
    const kwLB = (keyword: string, searchVolume: number): AnalyzedKeyword =>
      ({ keyword, searchVolume, themeFit: 3, themeFitByDesign: { LB: { fit: 3, about: 'apparel' } } } as unknown as AnalyzedKeyword)
    const pool = [
      kwLB('graphic novelty apparel', 9000),
      kwLB('cool print clothing', 8500),
      kwLB('trendy design gear', 8000),
      kwLB('lady boss motivation apparel', 9999),   // carries the design's OWN name — exempt
      kwLB('motivational shirts women', 9990),      // a market phrase, NOT the design's name — still a lie
    ]
    const r = buildItemHighlightsPerDesign({
      groups: [LADY_BOSS], pool, apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex',
    })
    expect(lineFor(r, 'LB')).toContain('lady boss motivation apparel')
    expect(lineFor(r, 'LB')).not.toContain('motivational shirts women')
  })
})

/**
 * PROMOTED MINOR T5-g (final fix wave, 2026-09-06): the final whole-branch reviewer's own probe,
 * converted into a permanent pin — "the highest-value missing pin on the branch". The REALISTIC
 * six-design fixture (Task 1's own POOL — OWN_PHRASES + SHARED + WOMEN, the same one every other
 * describe block above uses) run with `audienceLean: 'unisex'`, exercising BOTH fixed rules at once
 * on a single realistic family: the fit-based per-design partition (Task 1) AND the forced-gender
 * rule now wired into Item Highlights (Task 5) — WOMEN (fit 1 on RK, a bare gendered market phrase)
 * must be absent from every line for TWO independent reasons depending on the design (fit for RK,
 * audience for the other five), and every design must still reach the floor truthfully, on its own
 * name, with the Classic-fit blank's OWN pad fact ("Classic Fit") present and never "Relaxed".
 *
 * TASK 6 CONSEQUENCE (2026-09-06) — REPORTED, NOT RE-FIXTURED, per the task brief's own guardrail
 * for `itemHighlightPushSeam.test.ts` (the same principle applies here: this is "a real consequence
 * of the ruling," for the controller to judge, not a bug to paper over with a bigger pool):
 *
 * Under the absolute no-repeat rule this pool no longer composes for ANY of the six designs under a
 * unisex lean — all six now HOLD `under-floor-no-repeat`. Mechanically: SHARED's own 10 phrases are
 * almost entirely "X shirt(s)/tshirts/tops for men" boilerplate (see the SHARED definition above);
 * under `audienceLean: 'unisex'` the forced-gender rule (Task 5) drops every bare gendered phrase as
 * `audience-lean-lie` (9 of the 12 scoped rows per design — confirmed via the composer's own
 * `IH_COMPOSER_NULL` diagnostic, run 2026-09-06: `"candidates":3,"picked":2,"truthDrops":
 * {"audience-lean-lie":9}` for BD/BM/DQ/RIACG/SM; RK's own count is 8, not 9 — RK's fit-1 rating on
 * the WOMEN phrase (see the `WOMEN` const above) excludes that one row on FIT alone before the
 * audience check ever runs, so it is never counted as an `audience-lean-lie` drop for RK specifically
 * — FIX ROUND 1 (2026-09-06) correction, per the fix-round-1 findings: this comment previously said
 * "9 for every design"), leaving only 3 truth-clean candidates per design: that
 * design's OWN name phrase, "novelty shirts for guys", and "statement tee shirts" — and the latter
 * two themselves share `shirt`, so only 2 of the 3 are ever mutually Tier-A. 2 < MIN_CANDIDATES (3),
 * so the composer holds before the pad loop even runs (Tier-A reach: 2 candidates, 0 chars composed).
 *
 * This is NOT a bug: Task 5's audience-truth net (removes every gendered market phrase) stacked on
 * Task 6's absolute rule (removes the repeat that used to paper over what was left) on a keyword bank
 * that happens to be unusually repetitive once the gendered phrases are gone. The "zero repeated
 * significant tokens on a genuinely composing six-design family" pin the Task 6 brief also asked for
 * now lives on the Task 5 describe block's own first test above (a smaller, still-real six-design/
 * per-design-partition pool that DOES compose under unisex) — this fixture cannot serve as that
 * vehicle any more. Flagging for the controller to decide whether SHARED is worth enriching with more
 * gender-neutral phrasing; not done here (SHARED is reused file-wide by dozens of other tests whose
 * own numbers this task must not disturb).
 *
 * TASK 7 CONSEQUENCE (2026-09-06, lexicon extension, PO ruling "1. Extend") — REPORTED, NOT
 * RE-FIXTURED, same guardrail as the Task 6 consequence directly above: extending `LEAN_MASC_RE` to
 * recognize `guys` reclassifies SHARED's own "novelty shirts for guys" row from truth-clean into a
 * TENTH `audience-lean-lie` drop (confirmed via the composer's own `IH_COMPOSER_NULL` diagnostic, run
 * 2026-09-06: `"candidates":2,"picked":0,"truthDrops":{"audience-lean-lie":10}` for BD/BM/DQ/RIACG/SM;
 * RK's own count is 9, not 10, for the same fit-1-excludes-WOMEN-first reason noted above). All SIX
 * designs still HOLD (unchanged qualitative outcome — this pool already held before Task 7), but the
 * HOLD REASON moves EARLIER in the composer's own gate order: only 2 truth-clean candidates remain
 * (that design's OWN name phrase + "statement tee shirts") — 2 < MIN_CANDIDATES (3) fires the
 * `too-few-candidates` gate (`itemHighlightComposer.ts:339`) BEFORE the repeat-filter stage the OLD
 * 3-candidate/2-Tier-A count used to reach, so the hold reason changes from `under-floor-no-repeat` to
 * `thin-candidates`. Tier-A reach is unchanged in spirit (2 mutually non-repeating candidates either
 * way, still below the floor of 3) — only WHICH gate reports it changes, because one of the two
 * candidates that used to survive to the repeat stage is now excluded earlier, on TRUTH grounds
 * instead of on REPEAT grounds. Same non-fix as Task 6's own note: not a bug, and not re-fixtured here
 * for the same reason (SHARED is reused file-wide; enriching it is the controller's call).
 */
describe('T5-g: the realistic six-design fixture — TASK 6+7 CONSEQUENCE: now HOLDS under a UNISEX family lean', () => {
  it('all six designs HOLD thin-candidates (Task 7: was under-floor-no-repeat before the lexicon extension) — Task 5+6+7 stacked leave only 2 truth-clean candidates per design on this pool, below MIN_CANDIDATES (3), one gate earlier than before', () => {
    const r = buildItemHighlightsPerDesign({
      groups: GROUPS, pool: POOL, apparelProduct: true, blankBrand: GILDAN,
      familyTitleText: FAMILY_TITLE, audienceLean: 'unisex',
    })
    expect(GILDAN.spec.fit).toBe('Classic')
    for (const k of KEYS) {
      expect(holdFor(r, k)).toBe('thin-candidates')
      expect(lineFor(r, k)).toBe('')
    }
    // Also assert on the RETURNED BYTES directly (per_child/perDesign values, not the lowercased
    // helper) — matches the promoted minor's own wording ("assert on returned bytes").
    for (const d of r.perDesign) {
      expect(d.hold).toBe('thin-candidates')
      expect(d.value).toBe('')
    }
  })
})
