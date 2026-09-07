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
 *
 * TASK 6 CONSEQUENCE (2026-09-06, ABSOLUTE no-repeat, PO ruling verbatim "2. No Repeat as per Amazon
 * Ruules") — REPORTED, NOT RE-FIXTURED, per this task's own brief ("if any design HOLDS under the
 * absolute rule on that fixture, REPORT it ... do not re-fixture; the controller decides whether the
 * fixture pool is representative"):
 *
 * The "3 truthful pool phrases" this file's own margin math (above) is built on were NEVER all
 * mutually Tier-A: `SHARED` is `['graphic novelty tee for men', 'funny tee gift idea today']` — both
 * share the folded token `tee`. Under Task 2's (now-deleted) Tier-B fallback the second phrase still
 * composed (it added `funny`/`gift`/`idea`/`today`, merely repeating `tee`), giving 3 pool picks
 * (OWN + SHARED[0] + SHARED[1]) and the `poolOnly` lengths this file's comments cite (77-87). Under
 * the absolute rule SHARED[1] is REJECTED outright, leaving only 2 mutually non-repeating pool picks
 * (OWN + SHARED[0]) per design — below `MIN_CANDIDATES` (3) — so EVERY design in EVERY scenario below
 * now HOLDS `under-floor-no-repeat` before the pad loop (and `Classic Fit`) is ever reached. `MARGIN`
 * still does its OWN job (keeping `candidates.length` at 5-6, nowhere near the `too-few-candidates`
 * cliff it was built for — confirmed via the composer's own diagnostic log, run 2026-09-06); the new
 * cliff is a DIFFERENT gate (`too-few-picked`, via `under-floor-no-repeat`) that MARGIN was never
 * built to address, because Task 2 (whose fallback MARGIN's sibling phrases relied on being excluded
 * from) still allowed SHARED[1]'s repeat when this file was last re-baselined. The tests below are
 * updated to assert the TRUE (HOLD) outcome; the pool is untouched. This also means this file's own
 * "prove the real wire threads distinct per-design values" tests (below) can no longer demonstrate
 * that specific proof on THIS pool, since nothing composes any more — flagged as a coverage gap for
 * the controller, not silently patched.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('OpenAI must never be called by the Item Highlights producer') })
vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create } } } }))

import { buildItemHighlightsPerDesign } from './listingPipeline'
import { buildPerSkuItemHighlightMap, NO_LINE_FOR_DESIGN } from './perDesignItemHighlights'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'
import { ihFoldWord, IH_INSIGNIFICANT } from './productDetailAttrs'
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

describe('Important #6: the fixture no longer sits on the zero-margin CANDIDATE cliff (a DIFFERENT cliff — TASK 6 CONSEQUENCE, see file header — now holds every design regardless)', () => {
  it('losing ONE shared phrase (the exact candidate-count cliff the pre-fix fixture sat on: 3 candidates -> 2) still leaves `candidates` healthy — MARGIN keeps it at 5, safely above MIN_CANDIDATES (3) — but every design HOLDS anyway, for the absolute no-repeat reason (Task 6), not the thin-candidates reason MARGIN was built to prevent', () => {
    const minusOne = [...OWN_PHRASES, SHARED[0], ...MARGIN]   // drop SHARED[1] — the plan's own acceptance-test scenario
    const r = build(minusOne)
    for (const k of KEYS) {
      const d = r.perDesign.find((p) => p.designKey === k)!
      // TASK 6: not `thin-candidates` (MARGIN still prevents that cliff — its own job) and not
      // `designs-unrated` (every design is rated) — specifically the absolute no-repeat hold.
      expect(d.hold).toBe('under-floor-no-repeat')
      expect(d.value).toBe('')
    }
  })
})

describe('push seam wire: real buildItemHighlightsPerDesign -> real buildPerSkuItemHighlightMap', () => {
  const r = build(POOL)
  const { values, skipped } = buildPerSkuItemHighlightMap(r.perChild, ALL_TARGETS, null)

  it('TASK 6 CONSEQUENCE (see file header): every design now HOLDS under-floor-no-repeat on this exact pool, no OpenAI call regardless — replaces the pre-Task-6 sanity precondition ("every design composed >= 107 chars"), which no longer holds here', () => {
    for (const k of KEYS) {
      const d = r.perDesign.find((p) => p.designKey === k)!
      expect(d.hold).toBe('under-floor-no-repeat')
      expect(d.value).toBe('')
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('TASK 6 CONSEQUENCE: with every design held, the map resolves NOTHING and skips every SKU `no-line-for-design` — never a sibling\'s line (the class PR #652 would have missed still holds: a fully-held family maps to an empty pushable set, not a borrowed value). The ORIGINAL proof this test carried (six distinct per-design values thread correctly through the REAL map) cannot be demonstrated on this pool any more — flagged in the file header for the controller; not re-fixtured.', () => {
    expect(values.size).toBe(0)
    expect(skipped.length).toBe(ALL_TARGETS.length)
    for (const t of ALL_TARGETS) expect(skipped).toContainEqual({ sku: t.sku, asin: t.asin, reason: NO_LINE_FOR_DESIGN })
  })

  it('no mapped value contains "relaxed" for this Classic-fit blank — Task 4\'s fit-claim rule still excludes the adversarial phrase (truthDrops confirms `fit-claim-lie` fires), though on this now-fully-held pool the proof is vacuous over an empty map; the REAL (non-vacuous) proof that "relaxed" never ships on a Classic blank through a genuinely COMPOSING per-design wire now lives in itemHighlightPerDesign.test.ts\'s Task 5 describe block (augmented with a `.toContain(\'classic\')` pin, 2026-09-06).', () => {
    expect(GILDAN.spec.fit).toBe('Classic')
    const adversarial = kw('relaxed fit graphic tee', 9993, 3)
    const rAdv = build([adversarial, ...POOL])
    const { values: advValues } = buildPerSkuItemHighlightMap(rAdv.perChild, ALL_TARGETS, null)
    for (const v of advValues.values()) expect(v.toLowerCase()).not.toContain('relaxed')
    // TASK 6 CONSEQUENCE: the adversarial phrase is still excluded by TRUTH (fit-claim-lie), not by
    // starving the pool below MIN_CANDIDATES — but every design now holds `under-floor-no-repeat`
    // regardless (same mechanism as the rest of this file; see file header).
    for (const k of KEYS) {
      const d = rAdv.perDesign.find((p) => p.designKey === k)!
      expect(d.hold).toBe('under-floor-no-repeat')
    }
  })

  it('TASK 6 CONSEQUENCE: no mapped value contains "Classic" either, because nothing composes at all on this pool any more — the spec-fact pad truth-fix (blank_specs.fit -> "${fit} Fit") that must ship over the live "relaxed unisex fit" defect this plan was opened against is proven elsewhere (itemHighlightPerDesign.test.ts\'s Task 5 fixture, which DOES compose) rather than on this now-fully-held pool. Flagged for the controller — see file header.', () => {
    expect(values.size).toBe(0)
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

  it('the other five designs are NEVER held `designs-unrated` because of RK — isolation still holds (TASK 6 CONSEQUENCE: they now separately HOLD `under-floor-no-repeat` too, same as every other scenario in this file — see file header — so this no longer proves "still resolve their OWN lines"; it proves the narrower, still-real claim that RK\'s specific unrated-ness never spreads to a sibling\'s hold REASON)', () => {
    for (const g of GROUPS.filter((g) => g.key !== 'RK')) {
      const d = r.perDesign.find((dd) => dd.designKey === g.key)!
      expect(d.hold).not.toBe('designs-unrated')
      expect(d.hold).toBe('under-floor-no-repeat')
      // never borrowed RK's (or any sibling's) line, and never RK's specific hold reason
      for (const s of g.skus) expect(values.get(s.sku)).toBeUndefined()
    }
  })
})

/**
 * FIX ROUND 1 (2026-09-06), Important #2 + #3 (controller RULING, task-6-fix-round-1-findings.md):
 * a SECOND scenario, with its OWN mutually token-disjoint shared bank — `POOL`/`SHARED`/`MARGIN`
 * above are UNTOUCHED, and the hold-scenario tests above are the honest record of what the absolute
 * rule does on THAT pool (every design HOLDS there — see the file header). This scenario restores
 * BOTH lost proofs on a pool that actually composes:
 *   - Important #2: the six-design zero-duplicate-folded-token pin, on a pool where a Tier-B
 *     regression WOULD produce a duplicate (ADV2_* below) — not a pool so sparse nothing could ever
 *     repeat.
 *   - Important #3: the REAL `buildItemHighlightsPerDesign` output driven through the REAL
 *     `buildPerSkuItemHighlightMap` (the wire the file's own header names as its purpose), proving six
 *     distinct mapped values and BM's two SKUs both carrying BM's line.
 *
 * FIXTURE. Reuses this file's own `OWN_PHRASES` (unchanged, module-level, defined above) as each
 * design's identity phrase. `SHARED2` is a NEW, mutually disjoint 2-phrase bank (unlike the ORIGINAL
 * `SHARED`, whose two phrases both carried `tee` — the exact collision that sank the hold-scenario
 * fixture under the absolute rule): 'graphic novelty print' (graphic/novelty/print) and 'funny gift
 * idea today' (funny/gift/idea/today) share NO folded token with each other, with any `OWN_*` phrase,
 * or with any `ADV2_*` phrase below (checked by hand and confirmed empirically — see the report's
 * probe output). `ADV2_*` is ONE Tier-B-tempting phrase PER DESIGN: it repeats that design's OWN
 * name tokens (e.g. `ADV2_BD` repeats `boss`/`definition` from `OWN_BD`) while adding two brand-new
 * words ("daily grind") — high enough volume (9200, between each `OWN_*`'s ~9994-9999 and `SHARED2`'s
 * 9000/8000) that it would rank ABOVE `SHARED2` in the composer's fit/volume sort, so a Tier-B pass
 * would readily pick it up once `OWN_*` already established the repeat. `STRICT NAMES` (designScope.ts)
 * keeps each `ADV2_*` foreign to every OTHER design, exactly like `OWN_*` — it is a candidate ONLY
 * for the one design whose name it carries, so every design gets its OWN adversarial temptation.
 * (Note: an early draft used "champion" as the adversarial filler word and every design HELD
 * `too-few-candidates` — `champion` is Carhartt's sibling in `APPAREL_BRAND_RE`'s competitor-brand
 * lexicon (contentTruth.ts), so `ihTruthVerdict` correctly dropped it before selection ever ran; not
 * a repeat-rule finding, but recorded here since it cost real debugging time and the next person
 * editing this fixture will hit the same trap if they reach for a "motivational" word.)
 */
describe('FIX ROUND 1 (#2 + #3): a genuinely COMPOSING six-design pool, own mutually token-disjoint shared bank — restores the lost wire-liveness + zero-duplicate proofs', () => {
  const SHARED2: AnalyzedKeyword[] = [
    kw('graphic novelty print', 9000, 3),
    kw('funny gift idea today', 8000, 3),
  ]
  /** ONE Tier-B-tempting phrase per design — repeats that design's OWN name tokens (from `OWN_*`
   *  above), adds two brand-new words, and STRICT NAMES keeps it foreign to every sibling design.
   *  The absolute rule (Task 6) must reject every one of these; if it did not, the design's line
   *  would repeat its own name token twice (see the report's OLD-vs-NEW composer demonstration). */
  const ADV2_BD = kw('boss definition daily grind', 9200, 3)
  const ADV2_BM = kw('beast mode daily grind', 9200, 3)
  const ADV2_DQ = kw('dont quit daily grind', 9200, 3)
  const ADV2_RIACG = kw('relax ceo daily grind', 9200, 3)
  const ADV2_RK = kw('real king daily grind', 9200, 3)
  const ADV2_SM = kw('self made daily grind', 9200, 3)
  const ADV2_PHRASES = [ADV2_BD, ADV2_BM, ADV2_DQ, ADV2_RIACG, ADV2_RK, ADV2_SM]

  const POOL2: AnalyzedKeyword[] = [...OWN_PHRASES, ...ADV2_PHRASES, ...SHARED2]
  const r2 = build(POOL2)
  const { values: values2, skipped: skipped2 } = buildPerSkuItemHighlightMap(r2.perChild, ALL_TARGETS, null)

  /** Independent fold over the RETURNED bytes — deliberately NOT the production `significantFolded`
   *  (`productDetailAttrs.ts` as of round 2, F1; was `itemHighlightComposer.ts`) — mirrors
   *  itemHighlightPerDesign.test.ts's own helper (same fold rules: `ihFoldWord` + the gender-plural
   *  collapse) so this proves the WIRE's output obeys the no-repeat ruling, not merely the
   *  production fold's own bookkeeping. */
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

  it('all six designs compose (no hold) — the sanity precondition every assertion below needs', () => {
    for (const k of KEYS) {
      const d = r2.perDesign.find((p) => p.designKey === k)!
      expect(d.hold).toBeNull()
      expect(d.value.length).toBeGreaterThanOrEqual(107)
      expect(d.value.length).toBeLessThanOrEqual(125)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('Important #2: zero duplicate folded significant tokens in EVERY returned line (folded independently of the composer\'s own bookkeeping)', () => {
    for (const k of KEYS) {
      const d = r2.perDesign.find((p) => p.designKey === k)!
      expect(dupedFoldedTokens(d.value)).toEqual([])
    }
  })

  it('the absolute rule rejects the Tier-B-tempting ADV2 phrase for every design — each design\'s OWN name token appears exactly ONCE, never twice, even though the tempting phrase outranks SHARED2 on volume', () => {
    const nameTokenOf: Record<string, string> = { BD: 'boss', BM: 'beast', DQ: 'quit', RIACG: 'ceo', RK: 'king', SM: 'made' }
    for (const k of KEYS) {
      const d = r2.perDesign.find((p) => p.designKey === k)!
      const words = d.value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      const token = nameTokenOf[k]
      expect(words.filter((w) => w === token).length).toBe(1)
      // never the adversarial phrase's own distinguishing tail either
      expect(d.value.toLowerCase()).not.toContain('daily grind')
    }
  })

  it('Important #3: real buildItemHighlightsPerDesign output threads through the REAL buildPerSkuItemHighlightMap — six DISTINCT mapped values, nothing skipped', () => {
    expect(values2.size).toBe(ALL_TARGETS.length)
    expect(skipped2.length).toBe(0)
    const distinctLines = new Set([...values2.values()])
    expect(distinctLines.size).toBe(KEYS.length)
  })

  it('every SKU maps to ITS OWN design\'s line, never a sibling\'s — BM\'s two SKUs both carry BM\'s line', () => {
    for (const g of GROUPS) {
      const d = r2.perDesign.find((p) => p.designKey === g.key)!
      for (const s of g.skus) expect(values2.get(s.sku)).toBe(d.value)
    }
    // BM specifically: two SKUs, ONE design, the SAME composed value on both.
    expect(values2.get(BM.skus[0].sku)).toBe(values2.get(BM.skus[1].sku))
    expect(values2.get(BM.skus[0].sku)).toBe(r2.perDesign.find((p) => p.designKey === 'BM')!.value)
  })

  it('"Classic" appears in every composed line and is produced ONLY by the pad\'s `${spec.fit} Fit` — never a coincidence of pool wording (no pool phrase in POOL2 contains "classic")', () => {
    expect(POOL2.every((k) => !/classic/i.test(k.keyword))).toBe(true)
    for (const k of KEYS) {
      const d = r2.perDesign.find((p) => p.designKey === k)!
      expect(d.value.toLowerCase()).toContain('classic fit')
    }
  })

  /**
   * PAD-CHAIN TRACE for BD (report requirement — trace ONE design fully):
   * candidates sorted fit(tie=3) then volume DESC: OWN_BD(9999) > ADV2_BD(9200, REJECTED — repeats
   * boss/definition) > SHARED2[0] 'graphic novelty print'(9000) > SHARED2[1] 'funny gift idea
   * today'(8000). None of the three surviving phrases carry a GARMENT_SURFACE_RE token, so pass 1
   * (preferNewGarment) picks nothing; pass 2 picks all three Tier-A phrases: "Boss Definition
   * Motivation Wear, Graphic Novelty Print, Funny Gift Idea Today" = 77 chars (pool-only, well under
   * the 89-char ceiling past which `material` alone would cross 107 and `fit` would never be
   * reached). `opts.spec` = GILDAN (material 'Ring-Spun Cotton', fit 'Classic', neck 'Crew Neck',
   * sleeve 'Short Sleeve'; no `unisex`/`dye`). Pad priority order: material first — 77+2+16=95, still
   * under 107 — then fit — 95+2+11=108, crossing the floor — so the pad loop STOPS at `fit`; neck/
   * sleeve are never tried. Final: "Boss Definition Motivation Wear, Graphic Novelty Print, Funny
   * Gift Idea Today, Ring-Spun Cotton, Classic Fit" (108 chars). "Classic" is verified via the exact
   * composed value in the assertion below (never `.toBe()` on the whole string — property-only, per
   * this file's own discipline — but pinned to `.toContain` so a regression that drops the pad chain
   * before `fit` is caught).
   */
  it('BD pad-chain trace: pool-only (OWN_BD + SHARED2, ADV2_BD rejected) is 77 chars; the pad walks material (95) then fit (108, crossing the floor) — neck/sleeve never tried', () => {
    const bd = r2.perDesign.find((p) => p.designKey === 'BD')!
    expect(bd.value).toContain('Boss Definition Motivation Wear')
    expect(bd.value).toContain('Graphic Novelty Print')
    expect(bd.value).toContain('Funny Gift Idea Today')
    expect(bd.value).toContain('Ring-Spun Cotton')
    expect(bd.value).toContain('Classic Fit')
    expect(bd.value).not.toContain('Crew Neck')                      // pad stopped at `fit` — 108 >= 107
    expect(bd.value.length).toBe(108)
  })
})
