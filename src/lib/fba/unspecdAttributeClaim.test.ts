import { describe, it, expect } from 'vitest'
import { verdictForAssembledTitle } from './titleBand'
import { buildPhraseTruthCtx } from './contentTruth'

const kidsFacts = {
  garmentFamily: 'kids_tee' as const,
  spec: { fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight ring spun' },
  allowedBrand: null,
  designTokens: ["Don't Quit"],
  audienceLean: 'unisex' as const,
}

describe('unspecd attribute claims are inadmissible, not merely stage-deleted', () => {
  it('rejects "Oversized" when the blank states Classic fit', () => {
    const truth = buildPhraseTruthCtx(kidsFacts, 'title')
    const v = verdictForAssembledTitle(
      "THE CEO Don't Quit Kids Tee | Oversized Graphic Tees",
      { truth, protect: "Don't Quit" },
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('unspecd-attribute-claim')
  })

  it('permits a fit the blank DOES state', () => {
    const truth = buildPhraseTruthCtx(
      { ...kidsFacts, spec: { ...kidsFacts.spec, fit: 'Oversized' } }, 'title')
    const v = verdictForAssembledTitle(
      "THE CEO Don't Quit Kids Tee | Oversized Graphic Tees",
      { truth, protect: "Don't Quit" },
    )
    // Was `expect(v.ok ? undefined : v.reason).not.toBe('unspecd-attribute-claim')` — trivially true
    // whenever `v.ok` is `true` (the `.reason` field does not exist on that arm), so it would still
    // pass with the whole feature deleted. Tightened (task #4 audit, 2026-08-23) to assert the verdict
    // itself, not merely that one string it never had a chance to produce.
    expect(v.ok).toBe(true)
  })
})
