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
    expect(v.ok ? undefined : v.reason).not.toBe('unspecd-attribute-claim')
  })
})
