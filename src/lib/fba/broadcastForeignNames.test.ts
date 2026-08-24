import { describe, it, expect } from 'vitest'
import { verdictForAssembledTitle } from './titleBand'
import { buildPhraseTruthCtx } from './contentTruth'
import { designScopeTokens, isForeignToDesign } from './designScope'

const sweatFacts = {
  apparelProduct: true,
  garmentFamily: 'sweatshirt' as const,
  familyGarmentFamilies: ['sweatshirt' as const],
  spec: { fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight fleece' },
  allowedBrand: null,
  designTokens: ['Motivational Entrepreneur'],
  audienceLean: 'lean_male' as const,
}

/* The task brief's own template hardcoded `foreignTokens: new Set(['business', 'btch'])`. Two
 * corrections verified against the REAL implementation before pinning this test (both confirmed by
 * direct execution, not assumption):
 *
 * 1. TOKEN VALUE: `designScopeTokens('Business B*tch')` — the exact call `listingPipeline.ts`'s
 *    `broadcastForeignTokens` makes on every per-design name — actually derives `['busines', 'tch']`,
 *    not `['business', 'btch']`. `fillNormTok`'s plural fold (`designScope.ts`) strips a bare
 *    trailing "s" with no ss/us/is guard (unlike `coverage-core.ts`'s `foldPlural`), so "business"
 *    folds to "busines"; "b*tch" splits on the star into "b" (dropped, 1 char) + "tch". Built HERE
 *    from the real function rather than hand-typed, so this test tracks the tokenizer instead of
 *    silently drifting from it.
 * 2. MISSING `reject`: `foreignTokens` alone only reaches `applyTitleTruthNet`'s segment-0
 *    (money-phrase) WORD-level scrub (`scrubMoneyPhrase`) — never a later pipe segment, which is
 *    never wholly dropped by a phrase predicate. The live regression's foreign phrase sits AFTER the
 *    pipe, so convicting it also requires the net's SEGMENT-level droppable predicate,
 *    `rejectSegment` — the second ctx field `verdictForAssembledTitle`/`applyTitleTruthNet` already
 *    define for exactly this. Confirmed by direct execution: `foreignTokens` alone left the live
 *    string byte-identical; adding `reject: (seg) => isForeignToDesign(seg, foreignTokens)` — the
 *    SAME whole-phrase rejector the per-child exit already binds to its own foreign set, no new
 *    predicate — dropped the foreign segment. `listingPipeline.ts`'s `broadcastReject` binds this
 *    identically for the broadcast exit; this fixture mirrors that real wiring exactly. */
const foreignTokens = new Set(designScopeTokens('Business B*tch'))
const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)

describe('broadcast exit rejects sibling design names', () => {
  it('rejects the live regression string carrying a per-design name', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt for Men',
      { truth, protect: 'Motivational Entrepreneur', foreignTokens, reject },
    )
    expect(v.ok).toBe(false)
  })

  it('keeps the family theme on the broadcast title', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur | Long Sleeve Pullover Fall Crewneck',
      { truth, protect: 'Motivational Entrepreneur', foreignTokens, reject },
    )
    expect(v.ok).toBe(true)
  })
})
