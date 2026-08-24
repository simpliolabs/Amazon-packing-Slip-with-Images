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
 * ONLY ONE POOL candidate is supplied, matching the live specimen (`TITLE_ADMISSION_IS_VERIFICATION.md`
 * §1: 69 chars, under the 70 floor — decision `facts-exhausted`, not `padded`). A second, clean POOL
 * candidate long enough to land in-band on its own would make the existing length-only accept logic
 * return that one first regardless of this fix, masking the defect instead of proving it. The spec
 * FACTS (`fit`/`sleeve`/`neck`) are still real, ordinary candidates — `candidateSegments` tries them
 * BEFORE `poolSegments` — so the pad does not merely refuse and stall: it skips the lie and still
 * pads with "Long Sleeve" (a genuine, verified product fact), landing on `facts-exhausted` at a
 * specific, pinned string. Both assertions below are load-bearing: a pure `not.toMatch(/Business/i)`
 * would also pass if the pad had starved to `''` or returned the input untouched — pinning the exact
 * decision and string proves the pad did its job around the lie, not merely avoided it (review round
 * 1, 2026-08-23 — MINOR finding).
 */
import { describe, it, expect } from 'vitest'
import { enforceTitleBand, settleTruthBand } from './titleBand'
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
    // Pinned, not just a negative: proves the pad SKIPPED the lie and still padded from a genuine
    // fact (`spec.sleeve`), rather than merely refusing/starving.
    expect(out.decision).toBe('facts-exhausted')
    expect(out.title).toBe('THE CEO Motivational Entrepreneur | Long Sleeve')
  })

  /* THE SECOND LIVE SPECIMEN (review round 1, 2026-08-23 — CRITICAL 1). Not the sibling-name class
   * above: an UNSPEC'D ATTRIBUTE CLAIM. `phraseTruthVerdict` has no fit-claim rule and
   * `isTitleWasteVocabulary` matches only `unisex|classic fit`, so "Oversized Graphic Tees" passed
   * `truthOk` and sat in `poolSegments` as admissible — reproduced live: "THE CEO Don't Quit
   * Motivational T-Shirt Tee Shirt | Oversized Graphic Tees" (74 chars) on a Classic-fit Gildan
   * 64000B. Confirmed by direct execution before wiring the fix: WITHOUT a `verify` ctx this exact
   * candidate is admitted (`decision: 'padded'`, byte-identical to the live string above); the
   * assertions below are WITH `verify`, proving `enforceTitleBand`'s verify gate catches this class
   * too — the SAME wiring this task's other fix already added, not a second mechanism. */
  it('does not let an unspec\'d attribute claim ("Oversized" on a Classic-fit blank) ship either', () => {
    const spec = { fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun' }
    const truth = buildPhraseTruthCtx(
      {
        garmentFamily: 'tee',
        mixedFamilies: ['tee'],
        spec,
        allowedBrand: null,
        designTokens: ["Don't Quit Motivational"],
        audienceLean: null,
      },
      'title',
    )
    const title = "THE CEO Don't Quit Motivational T-Shirt Tee Shirt"
    const out = enforceTitleBand(
      title,
      { apparel: true, spec, factSegments: [], poolSegments: ['Oversized Graphic Tees'], truthOk: () => true },
      { truth, protect: "Don't Quit Motivational" },
    )

    expect(out.title).not.toMatch(/Oversized/i)
    expect(out.decision).toBe('facts-exhausted')
    expect(out.title).toBe("THE CEO Don't Quit Motivational T-Shirt Tee Shirt | Short Sleeve")
  })
})

/**
 * `settleTruthBand`'s refusal-path seed (review round 1, 2026-08-23 — CRITICAL 2, ruled "the class
 * fix": even if a pad somewhere admits a lie — this task's own fix, or a future writer nobody has
 * armed yet — the ship gate must catch it before `shipped-truthful-under-band`/`unreachable-no-prior`
 * can hand it out). Pre-fix, `let best = produced` seeded the refusal path's shippable value with
 * the UNVERIFIED `produced` string; `best` was only ever REPLACED by a verified candidate, never
 * verified itself at the seed. On an already-in-band-but-untrue `produced`, the DFS's own top-of-
 * function check returns `null` at depth 0 without ever reaching that replacement, so the unverified
 * seed passed straight through to the decision literally named "shipped-truthful-under-band".
 *
 * Reproduced here by handing `settleTruthBand` a `produced` string that ALREADY carries a sibling
 * design's name — simulating a future pad nobody has armed with `verify` yet, i.e. exactly the
 * defence-in-depth case CRITICAL 1's per-call-site fix cannot itself guarantee for all time. `prior`
 * is null so the refusal path cannot fall back to it either — this isolates the seed itself.
 */
describe('settleTruthBand never ships its own unverified seed', () => {
  it('an already-corrupted `produced` cannot become "best" — ships empty and holds rather than the lie', () => {
    const spec = { fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight fleece' }
    const truth = buildPhraseTruthCtx(
      {
        garmentFamily: 'sweatshirt', mixedFamilies: ['sweatshirt'], spec, allowedBrand: null,
        designTokens: ['Motivational Entrepreneur'], audienceLean: 'lean_male',
      },
      'title',
    )
    const foreignTokens = new Set(designScopeTokens('Business B*tch'))
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    // Already 69 chars, already carrying the lie — as if some OTHER, unarmed writer had produced it.
    const produced = 'THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt for Men'

    const r = settleTruthBand({
      produced,
      prior: null,
      apparel: true,
      band: { apparel: true, spec, factSegments: [], poolSegments: [], truthOk: () => true },
      truth, protect: 'Motivational Entrepreneur', foreignTokens, reject,
    })

    expect(r.title).not.toMatch(/Business/i)
    // Pinned exactly: proves the seed itself was never verified-true and so could never ship,
    // not merely that this particular append search happened not to find it.
    expect(r.title).toBe('')
    expect(r.decision).toBe('unreachable-no-prior')
    expect(r.hold).toBe(true)
  })
})
