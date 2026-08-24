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
import {
  enforceTitleBand, settleTruthBand, enforceTitleTruthBand, settleTitle, verdictForAssembledTitle,
  candidateFactCount, type SettleTitleCtx,
} from './titleBand'
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
 * `enforceTitleTruthBand`'s empty-title ratchet guard (review round 2, 2026-08-23 — NEW BREAKAGE 1;
 * corrected in review round 3 — CRITICAL-A / IMPORTANT-B). `settleTruthBand`'s `''` seed is CORRECT
 * in isolation (the test above pins it) — but nothing downstream used to stop that `''` from
 * becoming what the DOOR itself ships on a hold. That is not merely a blank UI: `recommended_title`
 * persists with no empty check, and the NEXT run reads `priorTitle` from that same stored value, so
 * an unguarded `''` is a ONE-WAY RATCHET — once stored, the family can never recover a prior again.
 *
 * ROUND 2's OWN FIX WAS WRONG (CRITICAL-A): it fell back to a caller-supplied `emptyHoldFallback`
 * that the only real caller filled with `raw` — `settleTitle`'s UN-netted, pre-every-stage input.
 * That undoes every subtractive correction the door already made (waste vocabulary, color strip,
 * inclusive audience, `applyTitleTruthNet` itself) and can re-ship exactly the untrue segment those
 * stages just removed — the SAME defect class round 1's seed fix closed, reopened one door over. It
 * was also opt-in (IMPORTANT-B): omit the argument and the guard silently did nothing.
 *
 * ROUND 3 replaces it with `netted` — computed INSIDE this function (no caller can omit it), and
 * `drop.title` (post `settleTitle` steps 1-11) run through `applyTitleTruthNet` +
 * `dropOrphanPoolFragments`, i.e. every subtractive stage already applied. `prior` remains a second,
 * structurally-unreachable-in-practice backstop (see `titleBand.ts`'s own proof: an empty `netted`
 * routes to `settleTruthBand`'s `not-produced` exit, `hold: false`, before a hold can ever be
 * raised — so `settled.hold === true` is itself a proof `netted` is non-empty here). No test below
 * exercises the `prior`-branch specifically for that reason; it is documented, not demonstrated.
 *
 * Fixture: a KIDS-TEE ctx (B0DP5H8QBT's family class, one of the plan's two acceptance ASINs), a
 * 73-char already-in-band `produced` that fails ONLY on `missing-youth-marker`, empty fact/pool
 * banks so nothing is appendable — plus a SEPARATE fixture carrying a sibling design's name, which
 * is the reviewer's own second repro and the one that actually distinguishes `netted` from `raw`.
 */
describe('enforceTitleTruthBand never ships an empty title on a hold', () => {
  const truth = buildPhraseTruthCtx(
    { garmentFamily: 'kids_tee', mixedFamilies: ['kids_tee'], spec: null, allowedBrand: null, designTokens: ['Cute Dino'], audienceLean: null },
    'title',
  )
  const produced = 'THE CEO Cute Dino Graphic Tee Shirt | Short Sleeve Crew Neck Cotton Blend'
  const band = { apparel: true, spec: null, factSegments: [], poolSegments: [], truthOk: () => true }

  it('is the exact live shape: in-band, missing-youth-marker (asserted, not assumed), and genuinely nothing appendable', () => {
    expect(produced.length).toBeGreaterThanOrEqual(70)
    expect(produced.length).toBeLessThanOrEqual(75)
    expect(verdictForAssembledTitle(produced, { truth, protect: 'Cute Dino' })).toEqual({ ok: false, reason: 'missing-youth-marker' })
    // "Nothing appendable" is not assumed from an empty poolSegments/factSegments array — it is the
    // REASON candidateFactCount, and therefore the search's own append loop, has zero candidates to
    // try, which is WHY `best` cannot recover past the seed at all.
    expect(candidateFactCount(produced, band)).toBe(0)
  })

  it('CHARACTERIZATION PIN — no prior: ships this run\'s own already-netted material, never "", under an honest hold', () => {
    const r = enforceTitleTruthBand({ produced, prior: null, apparel: true, band, truth, protect: 'Cute Dino' })
    expect(r.decision).toBe('unreachable-no-prior')
    expect(r.hold).toBe(true)
    expect(r.title).not.toBe('')
    // The fallback IS `netted`, structurally — not a value this test or any caller supplied.
    expect(r.title).toBe(r.netted)
  })

  it('CHARACTERIZATION PIN — prior set but ALSO fails truth: `netted` outranks it (round 2 shipped the prior here; round 3 does not)', () => {
    const priorAlsoUntrue = 'THE CEO Cute Dino Graphic Tee Shirt | Cotton Blend' // also missing the youth marker
    const r = enforceTitleTruthBand({ produced, prior: priorAlsoUntrue, apparel: true, band, truth, protect: 'Cute Dino' })
    expect(r.decision).toBe('shipped-truthful-under-band')
    expect(r.hold).toBe(true)
    expect(r.title).toBe(r.netted)
    // Round 2's PO ruling ("a usable-but-untrue prior may be KEPT") covered PRESERVING existing
    // stored copy against being overwritten by nothing. It did not authorise preferring a
    // known-untrue prior over this run's own already-scrubbed material once one exists.
    expect(r.title).not.toBe(priorAlsoUntrue)
  })

  /**
   * CRITICAL-A, reproduced directly and pinned. `args.produced` here is deliberately the UN-netted
   * string — parallel to what `settleTitle` calls `raw` — carrying a sibling design's name
   * (`Business B*tch`) that `applyTitleTruthNet` removes on the way to `netted`. Round 2's fallback
   * bypassed `netted` entirely and would have shipped this fixture's sibling name verbatim (the
   * reviewer's own live reproduction: `{"decision":"unreachable-no-prior","hold":true,"title":
   * "THE CEO Cute Dino Business B*tch Graphic Tee Shirt | Short Sleeve Cotton"}`); this test would
   * have caught that regression at the moment it was written.
   */
  it('CRITICAL-A regression: the fallback ships already-netted material — a sibling design name stays gone, never restored', () => {
    const foreignTokens = new Set(designScopeTokens('Business B*tch'))
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    const producedWithSibling = 'THE CEO Cute Dino Graphic Tee Shirt | Business B*tch Cotton Blend'
    const r = enforceTitleTruthBand({
      produced: producedWithSibling, prior: null, apparel: true, band, truth, protect: 'Cute Dino',
      foreignTokens, reject,
    })
    expect(r.hold).toBe(true)
    expect(r.title).not.toBe('')
    expect(r.title).not.toMatch(/business/i) // NOT restored — round 2's fallback would have shipped it
    expect(r.title).toBe(r.netted)
    expect(r.title).toBe('THE CEO Cute Dino Graphic Tee Shirt') // pinned exactly, not just a negative
  })

  /**
   * CRITICAL-A, reproduced end-to-end through `settleTitle` itself — not just `enforceTitleTruthBand`
   * in isolation — because the reviewer's own live specimen was exactly this shape: step 7
   * (`stripVariantColorWords`) SUCCEEDS at removing a color word (70 → 64 chars), the title still
   * cannot reach the band (a kids family missing its youth marker, nothing appendable), and the door
   * holds. Round 2's fallback shipped `raw` — the color word came BACK, because `raw` predates step
   * 7 entirely. This test fails against round 2's code (`raw` still has "Black") and passes here.
   */
  it('CRITICAL-A, end-to-end through settleTitle: a color word step 7 already removed does not come back', () => {
    // A SEPARATE kids-tee truth ctx, matching THIS test's own design name ("Cool Cat", not the
    // describe block's "Cute Dino") — the guard's mechanism does not depend on which design it is,
    // but the fixture should be internally consistent with what it claims to model.
    const coolCatTruth = buildPhraseTruthCtx(
      { garmentFamily: 'kids_tee', mixedFamilies: ['kids_tee'], spec: null, allowedBrand: null, designTokens: ['Cool Cat'], audienceLean: null },
      'title',
    )
    const kidsCtx: SettleTitleCtx = {
      produced: true,
      apparel: true,
      bandCtxFor: () => ({ apparel: true, spec: null, factSegments: [], poolSegments: [], truthOk: () => true }),
      moneyKws: null,
      moneyTailMode: 'off',
      moneyCtx: { apparel: true, lean: null, spec: null, protect: 'Cool Cat', garmentBrand: null, truth: coolCatTruth, allowAppend: true },
      spec: null,
      capTitle75: (t) => (t.length > 75 ? t.slice(0, 75) : t),
      colorProtect: 'Cool Cat',
      lean: null,
      v4NoPad: false,
      v4Mode: 'off',
      specFactTokens: [],
      truth: coolCatTruth,
      protect: 'Cool Cat',
      scrubProtectedOverlap: false,
      prior: null,
      holdScope: 'test',
      parentAsin: null,
    }
    const rawInput = 'THE CEO Cool Cat Black Graphic Design Tee Shirt For The Holiday Season'
    const r = settleTitle(rawInput, kidsCtx)
    expect(r.hold).toBe(true)
    expect(r.title).not.toBe('')
    expect(r.title).not.toMatch(/\bBlack\b/) // step 7's strip stays stripped
    expect(r.title).toBe('THE CEO Cool Cat Graphic Design Tee Shirt For The Holiday Season')
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
  // EXPLICIT restore, not `process.env.X = prev` (review round 3, 2026-08-23 — TEST QUALITY): when
  // `prev` is `undefined` (the common case — this var is unset outside this test), assigning it
  // back COERCES to the literal string `"undefined"`, which is truthy and would silently change
  // `rulingOverFloor()`'s behaviour for any test that runs after this one without its own
  // `afterEach`. The `afterEach` below happens to `delete` the var regardless and masks it today —
  // this makes the restore correct on its own terms, not dependent on that second line.
  const withFlag = <T>(mode: string, fn: () => T): T => {
    const prev = process.env.TITLE_RULING_OVER_FLOOR
    process.env.TITLE_RULING_OVER_FLOOR = mode
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.TITLE_RULING_OVER_FLOOR
      else process.env.TITLE_RULING_OVER_FLOOR = prev
    }
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

  it('CHARACTERIZATION PIN — reproduces the worst case: in-band, no hold, the color word ships anyway', () => {
    // Documents the STILL-ACCEPTED trade-off, deliberately, not a claim that this is ideal: a
    // `band-guard` refusal is correct behaviour (an honest §5 violation beats an out-of-band title),
    // and this task does not change WHETHER it can happen — only whether it is visible when it does
    // (the WARN test below). If a future change makes this scenario raise a hold instead, that is
    // an intentional supersession of this pin, not a regression, and this test should be updated.
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

/**
 * Task 4, handoff/TITLE_ADMISSION_IS_VERIFICATION.md §6 — "prove, then delete". Two pad gates inside
 * `candidateSegments`'s `push()` closure (titleBand.ts) were candidates for deletion because
 * `verdictForAssembledTitle` was expected to already own the same rule. THE GUARD: each may be
 * deleted ONLY after a passing proof that the verifier already rejects what the gate rejected: a
 * FAILING proof means the gate is NOT duplicated and must stay.
 *
 * Both fixtures below reuse `sweatFacts` — a plain sweatshirt family, matching the pad's own
 * `SWEATSHIRT_CLASSES = {sweatshirt, crewneck}` allow-set (contentTruth.ts), so "Crewneck"/"Fall
 * Crewneck" segments are individually TRUE and only their CONCEPT overlap is under test.
 */
describe('the verifier already owns what the pad gates duplicate', () => {
  const sweatFacts = {
    garmentFamily: 'sweatshirt' as const,
    mixedFamilies: ['sweatshirt'] as const,
    spec: { fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight fleece' },
    allowedBrand: null,
    designTokens: ['Motivational Entrepreneur'],
    audienceLean: 'lean_male' as const,
  }

  /**
   * THE CONCEPT GATE (`conceptIsNew`, formerly in `push()`) — PROVEN REDUNDANT, DELETED.
   * `titleHasDuplicateConcept` runs UNCONDITIONALLY inside `verdictForAssembledTitle` (outside the
   * `if (ctx.truth)` block — see titleBand.ts's own doc on that function), so it catches this class
   * of defect even with NO ground truth at all. Both branches below prove it, matching the fail-open
   * doctrine every other truth-ctx consumer in this file already takes.
   */
  it('rejects a concept restated in two spellings (the conceptIsNew pad gate) — WITH a truth ctx', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur Crewneck | Long Sleeve Crew Neck Pullover',
      { truth, protect: 'Motivational Entrepreneur' },
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('duplicate-concept')
  })

  it('rejects the SAME duplicate-concept title with NO truth ctx at all (fail-open parity — proves the pad gate added nothing the truth-independent check did not already cover)', () => {
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur Crewneck | Long Sleeve Crew Neck Pullover',
      { truth: null, protect: 'Motivational Entrepreneur' },
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toBe('duplicate-concept')
  })

  /**
   * THE ONE-CLASS GATE (`committedClass` / `dominantGarmentGroup`, still in `push()`) — NOT PROVEN
   * REDUNDANT, KEPT. `verdictForAssembledTitle`'s own equivalent (`garmentGroupsIn(t).size > 1` →
   * `'two-garment-classes'`) lives INSIDE `if (ctx.truth)`. `committedClass` is pure text
   * (`dominantGarmentGroup`, no ctx parameter at all), so it protects a real path the verifier
   * structurally cannot on its own: an apparel-heuristic-true, blank-UNRESOLVED listing
   * (`looksApparel` in listingPipeline.ts is independent of blank resolution; `truthGarmentFamily`
   * is null whenever the blank does not resolve, regardless of `apparelProduct`) — the fail-open,
   * "no ground truth to judge against" state this whole file's own doctrine names explicitly.
   *
   * The gap is not new to this task — it is ALREADY pinned at `titleBand.test.ts:497`
   * (`verdictForAssembledTitle('… Sweatshirt | Hoodie Pullover', { truth: null }).ok === true`,
   * inside "with no truth ctx, the truth/foreign-name half is skipped (fail-open) but concept +
   * punctuation still run"). This describe block re-derives the same fact from the OTHER direction —
   * as a reason to keep a pad gate, not just as a fact about the verifier — and pins it a second
   * time so a future edit cannot silently delete `committedClass` on the strength of the WITH-truth
   * test below alone.
   */
  it('WITH a resolved truth ctx: a second (but individually true) garment class is rejected by the verifier', () => {
    const mixedTruth = buildPhraseTruthCtx(
      { ...sweatFacts, mixedFamilies: ['sweatshirt', 'hoodie'] as const },
      'title',
    )
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur Sweatshirt | Long Sleeve Hoodie',
      { truth: mixedTruth, protect: 'Motivational Entrepreneur' },
    )
    // Not pinned to 'two-garment-classes': the truth net's own idempotence probe
    // (`enforceSingleGarmentClass`, baked into `applyTitleTruthNet`) catches this BEFORE the
    // explicit `garmentGroupsIn` check is ever reached, via `'untrue-or-foreign-segment-present'`.
    // Either reason satisfies the guard — `ok: false` is what makes the candidate un-admittable.
    expect(v.ok).toBe(false)
  })

  it('WITHOUT a truth ctx (unresolved blank): the verifier does NOT catch the second garment class — the gap `committedClass` alone still covers, and why it stays', () => {
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur Sweatshirt | Long Sleeve Hoodie',
      { truth: null, protect: 'Motivational Entrepreneur' },
    )
    // Deliberately `ok: true` — do NOT "fix" this by deleting `committedClass`; fix it (if ever
    // wanted) by first closing this gap in `verdictForAssembledTitle` itself, then re-running this
    // whole describe block's proof.
    expect(v.ok).toBe(true)
  })
})
