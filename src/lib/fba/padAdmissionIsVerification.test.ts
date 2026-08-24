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
import { describe, it, expect, vi, afterEach } from 'vitest'
import { enforceTitleBand, settleTruthBand, enforceTitleTruthBand, settleTitle, type SettleTitleCtx } from './titleBand'
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

/**
 * `enforceTitleTruthBand`'s empty-title ratchet guard (review round 2, 2026-08-23 — NEW BREAKAGE 1,
 * introduced by the CRITICAL-2 fix above). `settleTruthBand`'s `''` seed is CORRECT in isolation (the
 * test above pins it) — but nothing downstream used to stop that `''` from becoming what the DOOR
 * itself ships on a hold. That is not merely a blank UI: `recommended_title` persists with no empty
 * check, and the NEXT run reads `priorTitle` from that same stored value, so an unguarded `''` is a
 * ONE-WAY RATCHET — once stored, the family can never recover a prior again.
 *
 * Reproduced on a KIDS-TEE ctx (B0DP5H8QBT's family class, one of the plan's two acceptance ASINs):
 * a 73-char, already-in-band `produced` that fails ONLY on `missing-youth-marker`, with an empty
 * fact/pool bank so no append can supply one. `search()` hits the top-of-function in-band check,
 * fails the verdict, and — since 'missing-youth-marker' IS the one reason the search still tries to
 * fix additively — finds nothing to append either, so `found` is null and the refusal path is the
 * only exit. Both of the reviewer's exact sub-cases are asserted: no prior, and a prior that ALSO
 * fails truth (the `shipped-truthful-under-band` decision this whole plan added on 2026-08-23).
 */
describe('enforceTitleTruthBand never ships an empty title on a hold', () => {
  const truth = buildPhraseTruthCtx(
    { garmentFamily: 'kids_tee', mixedFamilies: ['kids_tee'], spec: null, allowedBrand: null, designTokens: ['Cute Dino'], audienceLean: null },
    'title',
  )
  const produced = 'THE CEO Cute Dino Graphic Tee Shirt | Short Sleeve Crew Neck Cotton Blend'
  const band = { apparel: true, spec: null, factSegments: [], poolSegments: [], truthOk: () => true }

  it('is the exact live shape: in-band, missing-youth-marker, nothing appendable', () => {
    expect(produced.length).toBeGreaterThanOrEqual(70)
    expect(produced.length).toBeLessThanOrEqual(75)
  })

  it('no prior + no fallback supplied (pre-fix / absent-guard shape): ships "" — proves the guard is opt-in, byte-identical when absent', () => {
    const r = enforceTitleTruthBand({ produced, prior: null, apparel: true, band, truth, protect: 'Cute Dino' })
    expect(r.decision).toBe('unreachable-no-prior')
    expect(r.hold).toBe(true)
    expect(r.title).toBe('')
  })

  it('no prior, WITH emptyHoldFallback: keeps this run\'s own producer output rather than ship ""', () => {
    const r = enforceTitleTruthBand({
      produced, prior: null, apparel: true, band, truth, protect: 'Cute Dino',
      emptyHoldFallback: 'RAW PRODUCER OUTPUT',
    })
    expect(r.decision).toBe('unreachable-no-prior')
    expect(r.hold).toBe(true)
    expect(r.title).toBe('RAW PRODUCER OUTPUT')
  })

  it('prior set but ALSO fails truth: keeps the prior anyway (usable = non-empty + in-cap, not truth-clean) rather than ship ""', () => {
    const priorAlsoUntrue = 'THE CEO Cute Dino Graphic Tee Shirt | Cotton Blend' // also missing the youth marker
    const r = enforceTitleTruthBand({
      produced, prior: priorAlsoUntrue, apparel: true, band, truth, protect: 'Cute Dino',
      emptyHoldFallback: 'RAW PRODUCER OUTPUT',
    })
    expect(r.decision).toBe('shipped-truthful-under-band')
    expect(r.hold).toBe(true)
    // The prior wins over the fallback here — it is "usable" (non-empty, in-cap) even though it is
    // not truth-clean; requiring truth-cleanliness would recreate the exact dead end that produced
    // an empty `best` to begin with (see the guard's own doc in titleBand.ts).
    expect(r.title).toBe(priorAlsoUntrue)
  })
})

/**
 * `settleTitle`'s NEW WARN visibility for a stage refusal (review round 2, 2026-08-23 — NEW
 * BREAKAGE 3, introduced by CRITICAL 1's own fix). Arming steps 7/8's pads with `verify` can make
 * `padded` land shorter than it used to (a lying candidate that used to reach `removalPermitted`'s
 * floor is now correctly refused) — so a removal `removalPermitted` used to allow can now be
 * refused instead, and the §5 color/audience-waste word it would have removed SURVIVES. The strip
 * net itself is unchanged and correct (`band-guard`, byte-identical) — the gap was that this could
 * happen with NO hold and only a routine INFO line, i.e. silently.
 *
 * `TITLE_RULING_OVER_FLOOR=off` (the `withFlag` helper below, same pattern `titleRulingAuthority.
 * test.ts` already established) makes `removalPermitted` refuse below the 70 floor rather than
 * only below the absolute 50 floor — the exact condition under which a pad that can no longer admit
 * an untrue candidate is more likely to land short. The title below is engineered to reproduce the
 * WORST case precisely: `decision: 'in-band'`, `hold: false` — the color word "Black" ships with
 * ZERO hold signal, and the ONLY trace is the new `TITLE_STAGE_REFUSED_VISIBLE` warn.
 */
describe('settleTitle makes a stage-refusal band-guard VISIBLE, even when it raises no hold', () => {
  const withFlag = <T>(mode: string, fn: () => T): T => {
    const prev = process.env.TITLE_RULING_OVER_FLOOR
    process.env.TITLE_RULING_OVER_FLOOR = mode
    try { return fn() } finally { process.env.TITLE_RULING_OVER_FLOOR = prev }
  }
  afterEach(() => { delete process.env.TITLE_RULING_OVER_FLOOR })

  const ctx: SettleTitleCtx = {
    produced: true,
    apparel: true,
    bandCtxFor: () => ({ apparel: true, spec: null, factSegments: [], poolSegments: [], truthOk: () => true }),
    moneyKws: null,
    moneyTailMode: 'off',
    moneyCtx: { apparel: true, lean: null, spec: null, protect: 'Cool Cat', garmentBrand: null, truth: null, allowAppend: true },
    spec: null,
    capTitle75: (t) => (t.length > 75 ? t.slice(0, 75) : t),
    colorProtect: 'Cool Cat',
    lean: null,
    v4NoPad: false,
    v4Mode: 'off',
    specFactTokens: [],
    truth: null,
    protect: 'Cool Cat',
    scrubProtectedOverlap: false,
    prior: null,
    holdScope: 'test',
    parentAsin: null,
  }
  // Exactly 70 chars WITH "Black"; removing it (and the freed space, with no facts to re-pad from)
  // lands at 64 — under the 70 floor `TITLE_RULING_OVER_FLOOR=off` enforces, so the removal refuses
  // and the title ships in-band, unchanged, color word intact.
  const title = 'THE CEO Cool Cat Black Graphic Design Tee Shirt For The Holiday Season'

  it('reproduces the worst case: in-band, no hold, the color word ships anyway', () => {
    const r = withFlag('off', () => settleTitle(title, ctx))
    expect(r.decision).toBe('in-band')
    expect(r.hold).toBe(false)
    expect(r.title).toMatch(/\bBlack\b/) // the §5 violation survives — this is the pre-existing,
    // correct `band-guard` refusal; the point of this test is the WARN below, not this line.
  })

  it('the refusal is now VISIBLE via a dedicated WARN, independent of the routine INFO trace', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    withFlag('off', () => settleTitle(title, ctx))
    // Capture the calls BEFORE restoring — `mockRestore()` also clears `.mock.calls` (it does
    // everything `mockReset()` does, which does everything `mockClear()` does), so reading the
    // history after restoring always sees an empty array regardless of what actually happened.
    const calls = warnSpy.mock.calls
    const visible = calls
      .map((c) => { try { return JSON.parse(c[0] as string) } catch { return null } })
      .find((p) => p?.tag === 'TITLE_STAGE_REFUSED_VISIBLE')
    warnSpy.mockRestore()
    logSpy.mockRestore()

    expect(visible, `no TITLE_STAGE_REFUSED_VISIBLE warn among: ${JSON.stringify(calls)}`).toBeTruthy()
    expect(visible.stage).toBe('color-strip')
    expect(visible.title).toMatch(/\bBlack\b/)
  })
})
