/**
 * SILENT-HOLD DEFECT CLASS CLOSED (2026-09-04, B0DSCDZC6K): when an Item Highlight is HELD (the
 * deterministic composer refuses — no truthful line composes for the single design, or for EVERY
 * design on a multi-design family), the pipeline used to push NO row into product_details_improvements
 * at all. The field then read as "no recommendation" instead of "held, here's why" — and because the
 * per-design UI block (page.tsx) and the "Rate designs against pool" control (PR #667) are both keyed
 * off that row EXISTING, an absent row hid them inside a container that could never render.
 *
 * THE FIX (listingPipeline.ts, both push sites — the single-design `{ value: hl }` destructure and the
 * multi-design `if (composed > 0)` gate): ALWAYS push the row when the attribute is in the menu, empty
 * value or not, carrying WHY via a new `hold` field.
 *
 * THIS FILE pins the piece of that fix that is a pure, fast, isolated unit: `isProductDetailGap`
 * (productDetailAttrs.ts) — the ONE gap predicate syncListingContent.ts's fetchScoringContext AND the
 * ai-recommendations route's own live-rescore both now call. A held row (current_value empty, `hold`
 * set) must NOT dock the Features score — the existing "a field the seller cannot close must not dock
 * Features" doctrine (write-blocked exemption), extended to the NEW reason a field can be unfillable.
 * The live-pipeline proof that the row itself gets PUSHED lives in
 * itemHighlightSilentHold.integration.test.ts (drives the real runListingPipeline()).
 */
import { describe, it, expect } from 'vitest'
import { isProductDetailGap, isEmptyDetailValue } from './productDetailAttrs'

describe('isEmptyDetailValue', () => {
  it('null, undefined, "", and whitespace-only are empty; a real string is not', () => {
    expect(isEmptyDetailValue(null)).toBe(true)
    expect(isEmptyDetailValue(undefined)).toBe(true)
    expect(isEmptyDetailValue('')).toBe(true)
    expect(isEmptyDetailValue('   ')).toBe(true)
    expect(isEmptyDetailValue('Beast Mode Shirt, Gym Motivation Shirts')).toBe(false)
  })
})

describe('isProductDetailGap — a HELD row must not dock the Features score', () => {
  it('a held row (empty current_value, hold set) is NOT a gap, even though Amazon now accepts Item Highlight writes (apiSupported:true — the write-block exemption alone no longer applies)', () => {
    const held = { field_name: 'Item Highlight', sp_api_key: 'title_differentiation', current_value: null, hold: 'designs-unrated' as const }
    expect(isProductDetailGap(held, { apiSupported: true })).toBe(false)
  })

  it('every hold reason is exempt, not just designs-unrated — the class fix, not a special case', () => {
    const reasons = ['unrated-pool', 'thin-candidates', 'under-floor', 'no-spec', 'designs-unrated'] as const
    for (const hold of reasons) {
      const row = { field_name: 'Item Highlight', sp_api_key: 'title_differentiation', current_value: null, hold }
      expect(isProductDetailGap(row, { apiSupported: true })).toBe(false)
    }
  })

  it('a row with NO hold and an empty current_value IS still a real gap (unrelated fields must keep docking)', () => {
    const neverProposed = { field_name: 'Material', sp_api_key: 'material_type', current_value: null }
    expect(isProductDetailGap(neverProposed, { apiSupported: true })).toBe(true)
  })

  it('a stale `hold` riding a row the sticky gate snapped BACK to a real accepted value is not exempted — and does not need to be, because current_value is non-empty (not a gap either way)', () => {
    // stickyDetails.ts's snap sets BOTH recommended_value and current_value to the accepted string but
    // does not know about / clear `hold` — this proves the predicate's current_value-emptiness gate
    // (not the presence of `hold` alone) is what keeps this row from being miscounted in EITHER
    // direction: it is correctly NOT a gap (current_value is populated), not because of the hold flag.
    const snappedBack = { field_name: 'Item Highlight', sp_api_key: 'title_differentiation', current_value: 'Beast Mode Shirt, Gym Motivation Shirts', hold: 'unrated-pool' as const }
    expect(isProductDetailGap(snappedBack, { apiSupported: true })).toBe(false)
  })

  it('an enum-invalid row still docks even when current_value is non-empty (unaffected by the hold exemption)', () => {
    const invalidEnum = { field_name: 'Department', sp_api_key: 'department', current_value: 'Unisex Adult', is_enum: true, enum_valid: false }
    expect(isProductDetailGap(invalidEnum, { apiSupported: true })).toBe(true)
  })

  it('write-blocked still exempts Item Highlights independently of the new hold exemption (apiSupported:false)', () => {
    const notHeldButBlocked = { field_name: 'Item Highlight', sp_api_key: 'title_differentiation', current_value: null }
    expect(isProductDetailGap(notHeldButBlocked, { apiSupported: false })).toBe(false)
  })

  it('PROVING THE PREDICATE IS LOAD-BEARING: without the hold exemption, a held row WOULD dock — the exact regression this fix prevents now that isWriteBlockedPreLaunch alone (apiSupported:true) no longer shields it', () => {
    // Re-implements the OLD inline filter (pre-fix, both syncListingContent.ts and the
    // ai-recommendations route carried this copy) to show the count it WOULD have produced.
    const isWriteBlockedPreLaunchStub = () => false // apiSupported:true -> never blocks, matching live settled data
    const oldIsEmpty = (v: unknown) => !v || !String(v).trim()
    const held = { field_name: 'Item Highlight', current_value: null, hold: 'designs-unrated' as const }
    const oldGapCount = [held].filter((p) => !isWriteBlockedPreLaunchStub() && oldIsEmpty(p.current_value)).length
    expect(oldGapCount).toBe(1) // the old logic WOULD have docked this row
    const newGapCount = [held].filter((p) => isProductDetailGap(p, { apiSupported: true })).length
    expect(newGapCount).toBe(0) // the fixed predicate does not
  })
})
