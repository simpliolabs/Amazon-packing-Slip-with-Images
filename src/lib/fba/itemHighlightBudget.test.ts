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
import { capItemHighlightRepeats, type IhNetResult } from './productDetailAttrs'

// 118 chars, clean distinct phrases, no repeats past the word cap, no sentence punctuation.
const VAL_118 = '100% Ring-Spun Cotton, Relaxed Unisex Fit, Crew Neck, Bold Motivational Print, Durable Wash-Safe Graphic, Gift Ready'

/** IH TERMINAL NET FIX ROUND 1: `capItemHighlightRepeats` returns a typed union — unwrap it for a
 *  test that expects the net to ACCEPT the line (a refusal throws loudly, naming the reason). */
function okValue(r: IhNetResult): string {
  if (!r.ok) throw new Error(`expected the net to accept the line, but it refused: ${r.reason}`)
  return r.value
}

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
    expect(okValue(capItemHighlightRepeats(VAL_118))).toBe(VAL_118)
  })

  // R2 (finish-line-rulings.md, controller RULING, 2026-09-08): implement the spec's rule
  // LITERALLY — "the length rule refuses rather than truncates" (docs/superpowers/specs/2026-09-07-
  // item-highlight-terminal-net.md) — with NO qualification. REPRODUCED live
  // (phase-1-final-review-2.md IMPORTANT 2, scratchpad/finish-a/r2-truncate.ts): before this fix,
  // `capItemHighlightRepeats` refused an over-max amputation ONLY when the survivor landed under
  // the 107 floor; above the floor (this exact fixture: 142c -> silently capped to 116c, which
  // clears the floor) it still shipped the truncated line as `{ok:true}` with NO refusal and NO
  // signal — the class IMPORTANT 2 measured. This value's own survivor (VAL_118, 118c) clears the
  // floor, so it is exactly that case: it MUST now refuse, not cap.
  it('an over-budget value is REFUSED, never silently capped at a comma boundary, even when the amputated survivor would have cleared the floor (R2, finish-line-rulings.md, 2026-09-08)', () => {
    const long = VAL_118 + ', Everyday Layering Staple'   // pushes past 125
    expect(long.length).toBeGreaterThan(CONTENT_CONTRACT.itemHighlights.max)
    expect(validateItemHighlights(long, 'THE CEO', false, []).some((p) => /characters/.test(p))).toBe(true)
    expect(capItemHighlightRepeats(long)).toEqual({ ok: false, reason: 'over-max' })
  })
})
