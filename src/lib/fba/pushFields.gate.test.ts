import { describe, it, expect } from 'vitest'
import { titlePushBlocked } from './pushFields'

/* Push-boundary title gate. CORRECTED 2026-09-05: Amazon does NOT rewrite item_name >75 (its live
   schema allows 200). The gate is still right to exist because
 * Item Highlights 100476-rejects SKUs whose live title exceeds it. The gate refuses the PATCH
 * before the mess is made — refuse, never truncate (a mid-word slice ships garbage). */
describe('titlePushBlocked', () => {
  it('THE ADVERSARIAL-REVIEW CLASS: a trademark-scrub-lengthened 80-char title is refused', () => {
    // PR #450 review: a title banded to 73 could leave the pipeline at 80 after a scrub
    // substitution lengthened it. Nothing between there and Amazon capped at 75 — pushFields
    // capped at the generic 200. This is the row that must block.
    expect(titlePushBlocked([{ sku: 'A', chars: 80, changed: true }])).toEqual({ sku: 'A', chars: 80 })
  })

  it('75 exactly passes; 76 refuses — the bound is Amazon’s, off by zero', () => {
    expect(titlePushBlocked([{ sku: 'A', chars: 75, changed: true }])).toBeNull()
    expect(titlePushBlocked([{ sku: 'A', chars: 76, changed: true }])).toEqual({ sku: 'A', chars: 76 })
  })

  it('UNCHANGED rows never block — they are not being sent', () => {
    // A family whose stored title is long but identical to Amazon must still allow pushing the
    // OTHER rows; refusing on a row the PATCH will skip would dead-lock the family.
    expect(titlePushBlocked([{ sku: 'A', chars: 120, changed: false }, { sku: 'B', chars: 74, changed: true }])).toBeNull()
  })

  it('reports the FIRST offender so the error names a concrete SKU', () => {
    const v = titlePushBlocked([
      { sku: 'A', chars: 74, changed: true },
      { sku: 'B', chars: 90, changed: true },
      { sku: 'C', chars: 91, changed: true },
    ])
    expect(v).toEqual({ sku: 'B', chars: 90 })
  })

  it('an empty diff is safe', () => {
    expect(titlePushBlocked([])).toBeNull()
  })
})
