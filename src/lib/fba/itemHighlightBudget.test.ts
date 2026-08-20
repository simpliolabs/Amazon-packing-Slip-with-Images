/**
 * ONE ITEM-HIGHLIGHTS BUDGET (generation-invariants INVARIANT 5) — the 125-char contract constant
 * is the ONLY cap in the chain, pinned BEHAVIORALLY so no link can quietly regress to the retired 75.
 *
 * History: PO capped IH at 75 (2026-07-19, phrase-quality era), raised it to Amazon's stated 125
 * budget (2026-08-10, CONTENT_CONTRACT.itemHighlights) — and the editor modal shipped 2026-08-18
 * with a fresh hardcoded 75 anyway, telling the seller a 77-char value was over budget while every
 * other link accepted 125 (PO-caught 2026-08-20). A scattered budget means "the cap" has as many
 * values as there are call sites; these tests fail if ANY link re-forks.
 */
import { describe, it, expect } from 'vitest'
import { CONTENT_CONTRACT } from './contentContract'
import { validateItemHighlights } from './listingPipeline'
import { capItemHighlightRepeats } from './productDetailAttrs'

// 118 chars, clean distinct phrases, no repeats past the word cap, no sentence punctuation.
const VAL_118 = '100% Ring-Spun Cotton, Relaxed Unisex Fit, Crew Neck, Bold Motivational Print, Durable Wash-Safe Graphic, Gift Ready'

describe('the one Item Highlights budget', () => {
  it('the contract says 125 max / 110 fill target — the PO 2026-08-10 ruling', () => {
    expect(CONTENT_CONTRACT.itemHighlights.max).toBe(125)
    expect(CONTENT_CONTRACT.itemHighlights.fillTarget).toBe(110)
  })

  it('a clean 110-125-band value passes the generator validator UNFLAGGED (no hidden 75 gate)', () => {
    expect(VAL_118.length).toBeGreaterThan(75)   // the exact value the retired cap would reject
    const problems = validateItemHighlights(VAL_118, 'THE CEO', false, [])
    expect(problems.filter((p) => /characters/.test(p))).toEqual([])
  })

  it('the terminal net passes the same value through UNCUT (no hidden 75 truncation)', () => {
    expect(capItemHighlightRepeats(VAL_118)).toBe(VAL_118)
  })

  it('an over-budget value IS flagged and IS capped at a comma boundary — the cap exists, once', () => {
    const long = VAL_118 + ', Everyday Layering Staple'   // pushes past 125
    expect(long.length).toBeGreaterThan(CONTENT_CONTRACT.itemHighlights.max)
    expect(validateItemHighlights(long, 'THE CEO', false, []).some((p) => /characters/.test(p))).toBe(true)
    const capped = capItemHighlightRepeats(long)
    expect(capped.length).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)
    expect(capped.endsWith(',')).toBe(false)
  })
})
