/**
 * padAdmissionIsVerification.test.ts — Task 3, handoff/TITLE_ADMISSION_IS_VERIFICATION.md.
 *
 * `enforceTitleBand`'s candidate loop (the "facts pad") accepted a candidate on LENGTH ALONE at
 * both its accept points — the first (`cand.length >= TITLE_BAND_LO`, an immediate 'padded' return)
 * and the second (`cand.length > best.length`, the 'facts-exhausted' monotone-improvement branch
 * this test exercises). `settleTruthBand`'s DFS already verifies every candidate it assembles; this
 * pad was the one remaining writer that did not.
 *
 * THE FIXTURE, corrected against the real code (the brief's hand-written snippet does not match
 * either): `PhraseTruthFacts` has no `apparelProduct`/`familyGarmentFamilies` fields — the real
 * names are `garmentFamily`/`mixedFamilies`. And `foreignTokens` alone does not drop a non-money-
 * phrase segment inside `applyTitleTruthNet` — only `opts.rejectSegment` does that (the whole-phrase
 * predicate `foreignTokens` merely backs at the word level); production always wires them as a pair
 * (`listingPipeline.ts` ~:9807: `reject = (seg) => isForeignToDesign(seg, foreign)`), so this test
 * builds both from the SAME real `designScopeTokens`/`isForeignToDesign` helpers rather than a
 * hand-typed token set (a hardcoded set the tokenizer does not actually produce broke a prior task's
 * brief the same way: "Business B*tch" tokenizes to "business"+"tch", never "btch").
 *
 * ONLY ONE pool candidate is supplied, matching the live specimen (`TITLE_ADMISSION_IS_VERIFICATION.md`
 * §1: 69 chars, under the 70 floor — decision `facts-exhausted`, not `padded`). A second, clean
 * candidate long enough to land in-band on its own would make the existing length-only accept logic
 * return that one first regardless of this fix, masking the defect instead of proving it.
 */
import { describe, it, expect } from 'vitest'
import { enforceTitleBand } from './titleBand'
import { buildPhraseTruthCtx } from './contentTruth'
import { designScopeTokens, isForeignToDesign } from './designScope'

describe('enforceTitleBand may not accept a candidate the verifier rejects', () => {
  it('does not let a sibling design name become "best" via the unverified facts-exhausted branch', () => {
    const spec = { fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight fleece' }
    const truth = buildPhraseTruthCtx(
      {
        garmentFamily: 'sweatshirt',
        mixedFamilies: ['sweatshirt'],
        spec,
        allowedBrand: null,
        designTokens: ['Motivational Entrepreneur'],
        audienceLean: 'lean_male',
      },
      'title',
    )

    // The SAME foreign-token/reject pairing production wires (listingPipeline.ts ~:9807), never a
    // hand-typed token set.
    const foreignTokens = new Set(designScopeTokens('Business B*tch'))
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)

    const title = 'THE CEO Motivational Entrepreneur'
    const out = enforceTitleBand(
      title,
      {
        apparel: true,
        spec,
        factSegments: [],
        // The live pool at repro time had nothing else to reach the band with either.
        poolSegments: ['Business B*tch Sweatshirt for Men'],
        truthOk: () => true,
      },
      { truth, protect: 'Motivational Entrepreneur', foreignTokens, reject },
    )

    expect(out.title).not.toMatch(/Business/i)
  })
})
