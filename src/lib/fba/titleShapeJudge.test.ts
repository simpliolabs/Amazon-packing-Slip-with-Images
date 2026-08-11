/**
 * titleShapeJudge.test.ts — the producer's arbiter must be able to tell the PO's gold from the
 * title the PO rejected.
 *
 * WHY THIS FILE EXISTS. On 2026-08-10 the seller rejected
 *   "THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee | Crew Neck"
 * for the second time, against their own gold
 *   "THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee".
 *
 * Five prior fixes all landed at the SHIP DOOR. None landed in `titleQualityJudge` — the only
 * deterministic title measurement in the pipeline, and the arbiter for BOTH producer-side actors
 * (the council's fail-open winner-pick and the humanizer's adopt gate). Measured before this change:
 * the judge scored the rejected title 95/100 and the gold 100/100. A 5-point gap is not a gradient;
 * it is why the same wrong shape kept coming back no matter how many nets were added downstream.
 *
 * The tests below pin the two properties that make the arbiter useful, and — just as importantly —
 * the two that stop it from over-reaching onto the seller's OWN unpiped titles.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { titleQualityJudge, titleShapeTerms } from './listingPipeline'
import { SEED_GOLD_TITLES, measureGoldShape } from './poGoldCorpus'

const REJECTED = 'THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee | Crew Neck'
const GOLD = 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee'
/** The seller's own measured ceiling over their piped titles. Not a number we invented. */
const CEILING = measureGoldShape(SEED_GOLD_TITLES).maxLeftWords

const withFlag = <T>(mode: string, fn: () => T): T => {
  const prev = process.env.TITLE_SHAPE_JUDGE
  process.env.TITLE_SHAPE_JUDGE = mode
  try { return fn() } finally { process.env.TITLE_SHAPE_JUDGE = prev }
}
afterEach(() => { delete process.env.TITLE_SHAPE_JUDGE })

describe('titleShapeTerms — pure, flag-free measurement', () => {
  it('measures the left segment only when a separator exists', () => {
    expect(titleShapeTerms(GOLD, 10).leftWords).toBe(8)
    expect(titleShapeTerms(REJECTED, 10).leftWords).toBe(12)
  })

  it('an UNPIPED title has no left segment — null, never its whole word count', () => {
    // This is the guard for PO gold #2 and for the ~70% of the live corpus that carries no pipe.
    // Scoring an unpiped title's whole length as a "left segment" is the exact inflation that
    // measureGoldShape was corrected for; re-importing it here would dock most of the corpus.
    const t = 'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup'
    const terms = titleShapeTerms(t, 10)
    expect(terms.hasPipe).toBe(false)
    expect(terms.leftWords).toBeNull()
    expect(terms.leftDock).toBe(0)
  })

  it('docks 5 per word over the ceiling, capped so it can never outweigh brand-front (-20)', () => {
    expect(titleShapeTerms(REJECTED, 10).leftDock).toBe(10)          // 12 words, 2 over
    expect(titleShapeTerms(GOLD, 10).leftDock).toBe(0)               // 8 words, under
    const huge = `THE CEO ${'Word '.repeat(30)}Tee | Football Tee`
    expect(titleShapeTerms(huge, 10).leftDock).toBe(20)              // capped
  })

  it('no ceiling supplied ⇒ no left dock, so every existing caller is unaffected', () => {
    expect(titleShapeTerms(REJECTED, null).leftDock).toBe(0)
    expect(titleShapeTerms(REJECTED, undefined).leftDock).toBe(0)
  })

  it('reads waste vocabulary through the DOOR\'S predicate, so the two can never drift', () => {
    expect(titleShapeTerms(REJECTED, 10).wasteDock).toBe(10)         // "Unisex"
    expect(titleShapeTerms(GOLD, 10).wasteDock).toBe(0)
    expect(titleShapeTerms('THE CEO Golf Tee | Classic Fit Shirt', 10).wasteDock).toBe(10)
  })
})

describe('titleQualityJudge — the gradient toward the seller\'s shape', () => {
  it('OFF: byte-identical to the pre-2026-08-10 judge (merging this changes nothing)', () => {
    const off = withFlag('off', () => titleQualityJudge(REJECTED, { brandName: 'THE CEO', maxLeftWords: CEILING }))
    const noFlag = titleQualityJudge(REJECTED, { brandName: 'THE CEO' })
    expect(off.score).toBe(noFlag.score)
    expect(off.problems).toEqual(noFlag.problems)
  })

  it('OFF: the judge cannot separate the rejected title from the gold — this is the defect', () => {
    const bad = withFlag('off', () => titleQualityJudge(REJECTED, { brandName: 'THE CEO', maxLeftWords: CEILING }).score)
    const good = withFlag('off', () => titleQualityJudge(GOLD, { brandName: 'THE CEO', maxLeftWords: CEILING }).score)
    // Documented, not asserted as desirable: a 5-point gap between a twice-rejected title and the
    // seller's own gold is why five door-side patches never held.
    expect(good - bad).toBeLessThan(10)
  })

  it('ON: the gold beats the rejected title by a real margin (>= 25)', () => {
    const bad = withFlag('on', () => titleQualityJudge(REJECTED, { brandName: 'THE CEO', maxLeftWords: CEILING }).score)
    const good = withFlag('on', () => titleQualityJudge(GOLD, { brandName: 'THE CEO', maxLeftWords: CEILING }).score)
    expect(good - bad).toBeGreaterThanOrEqual(25)
  })

  it('ON: no PO gold scores LOWER than it does today — the change must not dock the seller', () => {
    const shape = measureGoldShape(SEED_GOLD_TITLES)
    for (const g of SEED_GOLD_TITLES) {
      const off = withFlag('off', () => titleQualityJudge(g, { brandName: 'THE CEO', maxLeftWords: shape.maxLeftWords }).score)
      const on = withFlag('on', () => titleQualityJudge(g, { brandName: 'THE CEO', maxLeftWords: shape.maxLeftWords }).score)
      expect(on, `gold regressed: ${g}`).toBeGreaterThanOrEqual(off)
    }
  })

  it('ON: an unpiped gold takes a left-segment dock of exactly 0', () => {
    const unpiped = 'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup'
    const off = withFlag('off', () => titleQualityJudge(unpiped, { brandName: 'THE CEO', maxLeftWords: 10 }).score)
    const on = withFlag('on', () => titleQualityJudge(unpiped, { brandName: 'THE CEO', maxLeftWords: 10 }).score)
    expect(on).toBe(off)
  })
})
