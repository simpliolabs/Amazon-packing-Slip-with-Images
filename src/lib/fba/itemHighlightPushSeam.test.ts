/**
 * TASK 3 — prove the WIRE, not the mock (2026-09-06 item-highlights-per-design plan).
 *
 * This repo's documented failure class (PR #652, `test-proves-the-mock-not-the-wire`): a test
 * asserted a log line emitted 35 lines BEFORE the store; the fixture early-returned, the store
 * never ran, and a severed wire passed green. Tasks 1 (`buildItemHighlightsPerDesign`, this file's
 * sibling `itemHighlightPerDesign.test.ts`) and 2 (the composer's tier rule,
 * `itemHighlightComposer.test.ts`) each unit-test their own function in isolation. Neither proves
 * that the BYTES Task 1 returns are the bytes the push boundary (`pushExecutor.ts` ~:780
 * `readPerDesignItemHighlights` -> `buildPerSkuItemHighlightMap`, `perDesignItemHighlights.ts:129`)
 * will actually send to Amazon.
 *
 * THIS FILE closes that gap the only way that proves it without a network call: build a REAL
 * `perChild` array via the REAL `buildItemHighlightsPerDesign` (no mock of either function under
 * test), feed it to the REAL `buildPerSkuItemHighlightMap`, and assert on the RETURNED map —
 * downstream of both producers, at the last pure function before Amazon.
 *
 * `perDesignItemHighlights.test.ts` (pre-existing, PR #626) already unit-tests
 * `buildPerSkuItemHighlightMap` with HAND-BUILT `perChild` entries — that proves the mapper, not
 * that Task 1's actual output shape feeds it; a hand-built entry cannot go red when Task 1 changes
 * its output. This file is the wire-liveness acceptance the brief calls for; it does not replace
 * that file.
 *
 * FIXTURE NOTE: the six-design family (KEYS/kw/GROUPS/FAMILY_TITLE/GILDAN/OWN_* phrases) is carried
 * over VERBATIM from `itemHighlightPerDesign.test.ts` (Task 1) so this test stays in step with that
 * fixture, per the brief. The SHARED pool below is NOT copied from Task 1 — Task 1's own SHARED
 * bank is large enough (10 phrases, ~12 candidates surviving per design once truth/coverage filter)
 * that it never sits anywhere near the `MIN_CANDIDATES` cliff this file's own fixture originally did
 * — CHECKED (final fix wave, Important #6) and confirmed it does NOT share the cliff, so it needed
 * no re-baseline. This file's SHARED bank is deliberately SMALLER so every design's pool-only length
 * falls far enough under the floor that the composer's pad chain must walk past `material` into
 * `fit` to reach 107 — that is what makes the Classic-present assertion non-vacuous instead of a
 * coincidence of Task 1's own numbers.
 *
 * MARGIN-BEARING BY DESIGN (final fix wave, 2026-09-06, Important #6 — re-baselined after the final
 * reviewer found TWO zero-margin cliffs here). Both axes now carry explicit slack:
 *   - CANDIDATES: `MARGIN` below adds 3 more phrases per design (6 total vs the original 3), so
 *     losing any ONE `SHARED` phrase — the plan's OWN acceptance-test scenario, and exactly the
 *     defect that used to flip ALL SIX designs to `thin-candidates`/0 — now leaves 5, nowhere near
 *     `MIN_CANDIDATES` (3). Proven by the dedicated test below.
 *   - LENGTH: composed lines now land in [108, 118] (BD 118, BM 114, DQ 110, RIACG 108, RK 111, SM
 *     108 — verified empirically, see the wave's report for the pad-chain trace), never AT the exact
 *     107 floor the way BD used to sit before this fix (a one-character shrink in ANY filler word
 *     would have reversed a passing test). The full [112,118] band the plan asked for is not reachable
 *     for EVERY design simultaneously: `poolOnly` must stay under 89 chars for the LONGEST own-name
 *     design (BD, "Boss Definition Motivation Wear", 31 chars) or `material` alone would cross the
 *     floor and `fit` would never be reached at all (89 = 107 - 16, the material filler's length) —
 *     and `landing = poolOnly + 31` (material+fit, always, once poolOnly < 89) is IDENTICAL in form
 *     for every design, so the fixed ~10-char spread between the longest and shortest own-name
 *     phrase in Task 1's own fixture (31 vs 21 chars, which this file must not touch — see the note
 *     above) reproduces itself as a ~10-char spread in landing length no matter how the SHARED bank
 *     is sized. [108,118] is the tightest, safest band achievable under that constraint (BD's
 *     `poolOnly` is 87, two full characters of headroom below the hard 89 ceiling).
 * Pool-only (the 3 truthful pool phrases alone, before any pad filler) stays 77-87 chars for every
 * design — under 89 — so `Classic Fit` is still produced ONLY by the pad, never a coincidence of the
 * pool phrases' own wording.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('OpenAI must never be called by the Item Highlights producer') })
vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create } } } }))

import { buildItemHighlightsPerDesign } from './listingPipeline'
import { buildPerSkuItemHighlightMap, NO_LINE_FOR_DESIGN } from './perDesignItemHighlights'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const KEYS = ['BD', 'BM', 'DQ', 'RIACG', 'RK', 'SM'] as const
type Fits = Partial<Record<(typeof KEYS)[number], 0 | 1 | 2 | 3>>

/** A pool row rated under each design (a missing key = never rated under that design). Copied
 *  verbatim from itemHighlightPerDesign.test.ts (Task 1). */
const kw = (keyword: string, searchVolume: number, fits: Fits | number | null = 3): AnalyzedKeyword => {
  const byDesign = fits === null ? null
    : typeof fits === 'number' ? Object.fromEntries(KEYS.map((k) => [k, { fit: fits, about: 'gym' }]))
      : Object.fromEntries(Object.entries(fits).map(([k, f]) => [k, { fit: f, about: 'gym' }]))
  return { keyword, searchVolume, themeFit: 3, themeFitByDesign: byDesign } as unknown as AnalyzedKeyword
}

/** Gildan 64000 — fit: 'Classic', material: 'Ring-Spun Cotton'. The blank this plan's live defect
 *  (a shipped "relaxed unisex fit" on a Classic-fit blank) was reported against. */
const GILDAN = DEFAULT_BLANK_SPECS[1]

const BD = { key: 'BD', designName: 'Boss Definition', skus: [{ sku: 'BD64000L-BK', asin: 'B0BD000001' }], titles: ['THE CEO Boss Definition Shirt for Men Funny Office Tee'] }
const BM = { key: 'BM', designName: 'Beast Mode', skus: [{ sku: 'BM64000L-BK', asin: 'B0BM000001' }, { sku: 'BM64000M-BK', asin: 'B0BM000002' }], titles: ['THE CEO Beast Mode Shirt for Men Workout Tee'] }
const DQ = { key: 'DQ', designName: "Don't Quit", skus: [{ sku: 'DQ64000L-BK', asin: 'B0DQ000001' }], titles: ["THE CEO Don't Quit Gym Motivation Shirt for Men Tee"] }
const RIACG = { key: 'RIACG', designName: "Relax I'm a CEO", skus: [{ sku: 'RIACG64000L-BK', asin: 'B0RI000001' }], titles: ["THE CEO Relax I'm a CEO Shirt for Men Funny Boss Tee"] }
const RK = { key: 'RK', designName: 'Real King', skus: [{ sku: 'RK64000L-BK', asin: 'B0RK000001' }], titles: ['THE CEO Real King Graffiti Shirt for Men Crown Tee'] }
const SM = { key: 'SM', designName: 'Self Made', skus: [{ sku: 'SM64000L-BK', asin: 'B0SM000001' }], titles: ['THE CEO Self Made Grind Shirt for Men Hustle Tee'] }
const GROUPS = [BD, BM, DQ, RIACG, RK, SM]
const FAMILY_TITLE = 'Funny Shirts for Men Graphic Tees'
/** Every SKU across the family, in design order — the push targets `buildPerSkuItemHighlightMap`
 *  resolves against (mirrors `expanded.map((r) => ({ sku: r.sku, asin: r.asin }))` at the real
 *  push seam, pushExecutor.ts:1080/4616). */
const ALL_TARGETS = GROUPS.flatMap((g) => g.skus)

/** ONE distinguishing phrase per design, carrying that design's own name tokens — copied verbatim
 *  from itemHighlightPerDesign.test.ts (Task 1) so the per-design partition (own name survives into
 *  its own line, excluded from every sibling's) is the SAME proven behavior, not a reinvention. */
const OWN_BD = kw('boss definition motivation wear', 9999, 3)
const OWN_BM = kw('beast mode athletic apparel', 9998, 3)
const OWN_DQ = kw('dont quit athletic wear', 9997, 3)
const OWN_RIACG = kw('relax ceo energy wear', 9996, 3)
const OWN_RK = kw('real king throne apparel', 9995, 3)
const OWN_SM = kw('self made hustle wear', 9994, 3)
const OWN_PHRASES = [OWN_BD, OWN_BM, OWN_DQ, OWN_RIACG, OWN_RK, OWN_SM]

/** Deliberately SMALL shared bank (see file header) — two short, generic phrases rated true for
 *  every design, small enough that pool-only + the material filler alone cannot reach the 107
 *  floor, so the pad chain must walk into the `fit` filler for every one of the six designs. */
const SHARED: AnalyzedKeyword[] = [
  kw('graphic novelty tee for men', 9000, 3),
  kw('funny tee gift idea today', 8000, 3),
]

/**
 * MARGIN BANK (final fix wave, 2026-09-06, Important #6): three more phrases, rated true for every
 * design, RANKED BELOW `SHARED` (lower searchVolume, same themeFit) so the sort order (fit DESC then
 * volume DESC) always evaluates them AFTER both `SHARED` phrases have already been picked. Every
 * significant token in each of these three (folded: graphic/funny/tee/men/gift) is a SUBSET of the
 * union of `SHARED`'s own tokens — `classifyTier` (itemHighlightComposer.ts) finds nothing NEW in
 * them once `SHARED` is in `usedFolded`, so they are NEVER selected into the composed line (verified
 * empirically — see the wave's report's pad-chain trace) — they exist ONLY to widen `candidates`
 * (the array `MIN_CANDIDATES` gates on, BEFORE selection) from 3 to 6 per design, so losing any ONE
 * shared phrase (the plan's own acceptance test) leaves 5, nowhere near the `MIN_CANDIDATES` (3)
 * cliff the pre-fix fixture sat on exactly. They add ZERO bytes to any composed line by construction.
 */
const MARGIN: AnalyzedKeyword[] = [
  kw('funny graphic tees', 2000, 3),
  kw('mens gift tees', 1900, 3),
  kw('tee gift funny', 1800, 3),
]

const POOL: AnalyzedKeyword[] = [...OWN_PHRASES, ...SHARED, ...MARGIN]

const build = (pool: AnalyzedKeyword[]) =>
  buildItemHighlightsPerDesign({ groups: GROUPS, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })

describe('Important #6: the fixture no longer sits on the zero-margin candidate cliff', () => {
  it('losing ONE shared phrase (the exact cliff the pre-fix fixture sat on: 3 candidates -> 2, ALL SIX designs thin-candidates/0) now leaves every design still composing — MARGIN keeps candidates at 5, safely above MIN_CANDIDATES (3)', () => {
    const minusOne = [...OWN_PHRASES, SHARED[0], ...MARGIN]   // drop SHARED[1] — the plan's own acceptance-test scenario
    const r = build(minusOne)
    for (const k of KEYS) {
      const d = r.perDesign.find((p) => p.designKey === k)!
      expect(d.hold).toBeNull()
      expect(d.value.length).toBeGreaterThanOrEqual(107)
    }
  })
})

describe('push seam wire: real buildItemHighlightsPerDesign -> real buildPerSkuItemHighlightMap', () => {
  const r = build(POOL)
  const { values, skipped } = buildPerSkuItemHighlightMap(r.perChild, ALL_TARGETS, null)

  it('every design composed a non-empty line >= 107 chars, no OpenAI call — sanity precondition for the assertions below (not itself the wire proof)', () => {
    for (const k of KEYS) {
      const d = r.perDesign.find((p) => p.designKey === k)!
      expect(d.hold).toBeNull()
      expect(d.value.length).toBeGreaterThanOrEqual(107)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('each SKU maps to ITS OWN design\'s line — six distinct values across the map, never a sibling\'s (the exact class PR #652 would have missed: this reads the map the REAL Task 1 output produced, not a hand-built one)', () => {
    expect(skipped).toEqual([])
    expect(values.size).toBe(ALL_TARGETS.length)               // all 7 SKUs resolved
    expect(new Set(values.values()).size).toBe(KEYS.length)    // 6 distinct design lines
    // Cross-check every SKU against ITS OWN design's composed value specifically (not merely
    // "distinct from the others") — BM's two SKUs must both carry BM's line, RK's one SKU only RK's.
    for (const g of GROUPS) {
      const ownLine = r.perDesign.find((d) => d.designKey === g.key)!.value
      for (const s of g.skus) expect(values.get(s.sku)).toBe(ownLine)
    }
  })

  it('no mapped value contains "relaxed" for this Classic-fit blank — Task 4 SHIPPED (final fix wave, 2026-09-06, Minor #9: renamed from "NOTE (Task 4, not yet built)"): the assertion is now REAL. A "relaxed ..." phrase is PRESENT in the pool (rated a strong candidate for every design) and would otherwise win a slot on volume/fit alone — `ihTruthVerdict`\'s fit-claim rule (Task 4) is what keeps it out, proven here through the REAL wire (buildItemHighlightsPerDesign -> buildPerSkuItemHighlightMap), not phraseTruthVerdict called in isolation.', () => {
    expect(GILDAN.spec.fit).toBe('Classic')
    const adversarial = kw('relaxed fit graphic tee', 9993, 3)
    const rAdv = build([adversarial, ...POOL])
    const { values: advValues } = buildPerSkuItemHighlightMap(rAdv.perChild, ALL_TARGETS, null)
    for (const v of advValues.values()) expect(v.toLowerCase()).not.toContain('relaxed')
    // sanity: every design still composed a real line (the adversarial phrase was excluded by truth,
    // not by starving the pool below MIN_CANDIDATES).
    for (const k of KEYS) {
      const d = rAdv.perDesign.find((p) => p.designKey === k)!
      expect(d.hold).toBeNull()
      expect(d.value.length).toBeGreaterThanOrEqual(107)
    }
  })

  it('at least one mapped value contains "Classic" — the spec-fact pad truth-fix (blank_specs.fit -> "${fit} Fit", itemHighlightComposer.ts:359-361) that must ship over the live "relaxed unisex fit" defect this plan was opened against', () => {
    expect(Array.from(values.values()).some((v) => v.includes('Classic'))).toBe(true)
  })
})

describe('push seam wire: a held design is skipped at the map, never given a sibling\'s line', () => {
  // Reuses Task 1's own "RK unrated" scenario verbatim (itemHighlightPerDesign.test.ts: "a pool with
  // NO rating under RK holds `designs-unrated` for RK ONLY; the other five compose") — this is the
  // real hold path Task 1 proved, fed through the real map instead of asserted on in isolation.
  const partial = POOL.map((k) => {
    const { RK: _rk, ...rest } = (k.themeFitByDesign ?? {}) as Record<string, { fit: 0 | 1 | 2 | 3 }>
    return { ...k, themeFitByDesign: rest } as AnalyzedKeyword
  })
  const r = build(partial)
  const { values, skipped } = buildPerSkuItemHighlightMap(r.perChild, ALL_TARGETS, null)

  it('RK (designs-unrated) composes no line; its SKU maps to NO_LINE_FOR_DESIGN and is absent from the pushable set', () => {
    const rkEntry = r.perChild.find((e) => e.designKey === 'RK')!
    expect(rkEntry.hold).toBe('designs-unrated')
    expect(rkEntry.item_highlight).toBe('')
    const rkSku = RK.skus[0].sku
    expect(values.has(rkSku)).toBe(false)                                            // absent from the pushable set
    expect(skipped).toContainEqual({ sku: rkSku, asin: RK.skus[0].asin, reason: NO_LINE_FOR_DESIGN })
  })

  it('the other five designs still resolve their OWN lines through the map — a hold on one design never blocks or borrows for its siblings', () => {
    for (const g of GROUPS.filter((g) => g.key !== 'RK')) {
      const ownLine = r.perDesign.find((d) => d.designKey === g.key)!.value
      expect(ownLine.length).toBeGreaterThanOrEqual(107)
      for (const s of g.skus) expect(values.get(s.sku)).toBe(ownLine)
    }
  })
})
