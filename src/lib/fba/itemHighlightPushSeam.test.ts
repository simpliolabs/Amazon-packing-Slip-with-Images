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
 * bank is large enough that every design's line clears the 107-char floor from pool phrases (+ at
 * most the material filler) alone, so the `fit` filler ("Classic Fit") never gets exercised there.
 * This file's SHARED bank is deliberately SMALLER (2 short phrases) so every design's pool-only
 * length falls far enough under the floor that the composer's pad chain must walk past `material`
 * into `fit` to reach 107 (verified empirically against unmodified source: every one of the six
 * lines below is 107-121 chars and contains "Classic Fit") — this is what makes the Classic-present
 * assertion non-vacuous instead of a coincidence of Task 1's own numbers.
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
  kw('graphic tee mens', 9000, 3),
  kw('funny tee gift', 8000, 3),
]

const POOL: AnalyzedKeyword[] = [...OWN_PHRASES, ...SHARED]

const build = (pool: AnalyzedKeyword[]) =>
  buildItemHighlightsPerDesign({ groups: GROUPS, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })

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

  it('no mapped value contains "relaxed" for this Classic-fit blank — NOTE (Task 4, not yet built): `ihTruthVerdict` has no fit-claim rule keyed on "relaxed" vs `spec.fit` today, so this assertion is only meaningful because this pool never harvests a "relaxed ..." phrase (verified: SHARED/OWN_* contain no such phrase). It proves the ORDINARY case — a Classic blank\'s own spec pad never INVENTS "Relaxed" — not the adversarial one; closing that gap is Task 4\'s job, not this task\'s.', () => {
    expect(GILDAN.spec.fit).toBe('Classic')
    for (const v of values.values()) expect(v.toLowerCase()).not.toContain('relaxed')
  })

  it('at least one mapped value contains "Classic" — the spec-fact pad truth-fix (blank_specs.fit -> "${fit} Fit", itemHighlightComposer.ts:340) that must ship over the live "relaxed unisex fit" defect this plan was opened against', () => {
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
