# Fix 1 (inclusive-audience/theme vocab) + Fix 2 (ship floor) — report

Branch: `fix/inclusive-audience-vocab-and-floor-gate`, off `origin/main` @ `988a4b7` (includes
PR #664 material ban + PR #665 per-design Garment UI — the local `main` ref was stale at `e6a70f7`
[#663]; fetched and re-based the branch onto `origin/main` before starting, since #664 is the PR
this whole task is about).

Worktree: `C:\Users\Admin\AppData\Local\Temp\fba-wt-inclusive`.

## Status: DONE. Both fixes shipped, full suite green (106 files, 1974 passed + 4 expected-fail,
0 failures), tsc clean.

## WHY PR #664's OWN E2E TEST DISAGREED WITH LIVE — the finding that mattered most

Two independent fixture-mismatches, confirmed empirically (not assumed) by reverting my own Fix 1
and re-running the reproduction fixture:

1. **The pool.** PR #664's `titleMaterialAndSleeveE2E.integration.test.ts` used a 4-keyword
   `makePool()` — `'motivational entrepreneur sweatshirt'`, `'graphic sweatshirts for men'`,
   `'hustle mindset gift'`, `'boss lady sweatshirt'` — hand-picked, perfectly on-theme, perfectly
   ungendered. That pool trivially supplies fill for every design. The real B0DSCDZC6K pool is 69
   keywords dominated by women's-only phrases, which `phraseTruthVerdict`'s `audience-lean-lie`
   rule correctly rejects on a `unisex` family — so the real pool supplies **nothing**.
2. **The OpenAI stub.** PR #664's stub returned the identical rich plain-text title candidate for
   every design (`"THE CEO Motivational Entrepreneur Graphic Sweatshirt for Everyone"`), which
   alone supplies most of the 70-75 gap regardless of the pool or fix under test. I made the SAME
   mistake on my first draft (reused PR #664's stub verbatim) and it also masked the defect —
   confirmed by running my draft fixture against **unmodified source** and watching it pass with
   no fix applied at all. Only after minimizing the stub to `'THE CEO Sweatshirt'` (so shipped
   length is driven by product facts + pool, not incidental LLM-stub verbosity) did the fixture
   reproduce live byte-for-byte: **HD=58, DQ=61, BB=65, MH=65, all `decision:'refused-kept-prior'`,
   BCS/ED both clearing floor** — an exact match to the brief's 2026-09-04 measurement. See
   `titleInclusiveAudienceFloorE2E.integration.test.ts`'s file doc for the full trace.

**The lesson, stated plainly: an E2E test's OWN stub can be exactly as unrealistic as its fixture
data, and both have to be minimized to the real signal for the test to mean anything.** This is
the second time this exact class of fixture-mismatch has shipped a false-green in this file
lineage; worth naming as its own review checklist item, not just this incident.

## FIX 1 — inclusive-audience / use-case / theme vocabulary, truth-conditioned

**Scope was widened mid-flight by the coordinator** (mid-session message) from "inclusive audience
phrase admissible on unisex" to the general class: **PRODUCT-FACT vocabulary** (fabric/fit/sleeve/
neck/garment noun — spec-grounded, material still banned, untouched) vs. **USE-CASE/AUDIENCE/
THEME vocabulary** (gift/occasion/theme/inclusive-audience — asserts nothing about the physical
garment, cannot be a spec lie, is legitimate pool-sourced fill). Investigated the second class
first, since the PO's own "Gift for Boss" example and this family's own broadcast title (ending in
"Gift") implied a gap there.

**Finding: there was no code bug in the general theme-vocabulary class.** Read `candidateSegments`
(titleBand.ts) end to end: pool phrases are gated ONLY by `ctx.truthOk` (`phraseTruthVerdict` —
wrong-garment-noun, audience-lean-lie, capability claims, competitor brand, weight-class), plus
`wordsAreNew`/`alreadyStates`/the one-garment-class/concept-dedup gates. Nothing there docks a
phrase for "not being in the seller's golds" — that corpus-frequency inference lives in EXACTLY
ONE place, `titleQualityJudge`'s `-15 "for Men and Women" dock` (listingPipeline.ts), and it is
scoped to the inclusive-audience phrase specifically, not theme/gift vocabulary generally. Proved
this with a dedicated test (`inclusiveAudienceTruthCondition.test.ts`'s last `describe` block: a
"Gift" pool phrase pads a title identically on every lean value, and `titleQualityJudge` carries no
gift/theme dock at all) — passes unmodified, confirming no change was needed there.

**So Fix 1 is exactly the ORIGINAL, narrower scope: the inclusive-audience phrase, truth-
conditioned on `audience_lean='unisex'`**, plus confirming (not re-implementing) that the broader
theme class was already correctly unblocked.

**Route used: CONSTRUCTED, not pool.** Per the brief's own fallback: the live B0DSCDZC6K pool is
women's-skewed and (in my fixture, deliberately harsher than the brief even claims — see the test
file) carries **zero** admissible generic/inclusive phrase. `titleBand.ts`'s `candidateSegments`
now constructs the fact directly from `ctx.lean` (the SAME field `crossGenderLeanVeto` already
reads) — a restatement of the family's own declared audience, not a market term:

```ts
// titleBand.ts, candidateSegments(), between the GENERIC PAIRS loop and the pool-segments loop
if (ctx.lean === 'unisex') {
  push('for Men and Women')
  push('for Men & Women')
  push('for Men Women')   // gold #7's own attested juxtaposed terminal shape
}
```

Three PO-named equivalent phrasings (titleBand.ts's own DEFECT-1 doc lists all four the PO named:
"for Men and Women", "for Men & Women", "Men's and Women's", "Mens Womens" — I used the three that
read naturally as a TRAILING tail; "Mens Womens"/"Men's and Women's" as bare stacked-adjective
forms don't fit this door's append-only mechanics). Every existing gate still applies (`push()`'s
waste-vocabulary/`truthOk`/cross-gender/one-class/concept/`alreadyStates` checks), so this is not a
bypass — `phraseTruthVerdict`'s existing `audience-lean-lie` rule (contentTruth.ts) already treats
a phrase naming BOTH genders as inclusive-not-forced and passes it on `unisex`; the new code only
adds the CANDIDATE, it does not relax any gate.

**The judge dock** (`titleQualityJudge`, listingPipeline.ts:~1848), the one genuine "corpus
inference vs PO ruling" conflict the brief named:

```ts
if (opts.shape.audienceMix.inclusive === 0 && hasInclusiveAudience(t) && opts.lean !== 'unisex') {
  score -= 15
  ...
}
```

Extends the EXISTING `opts.lean` seam already threaded through this function for the
AUDIENCE-WHEN-LEAN dock a few lines below (per the brief's instruction — no second audience
rulebook). `hasInclusiveAudience` itself (the axis+value predicate, PR #663) is UNCHANGED — it
still correctly reports "Men and Women" as an opposed-axis span regardless of family lean; the
gating is entirely at this ONE call site, so `goldCorpusSelfTest.test.ts`'s existing "OUT OF SCOPE,
the PO has not ruled on it" test (which never passes a `lean`) is unaffected and still passes.

**What the pad actually shipped, per design, source (all confirmed via
`titleInclusiveAudienceFloorE2E.integration.test.ts`, driving the real `runListingPipeline()`):**

| Design | Shipped title | Len | Decision | Source |
|---|---|---|---|---|
| Hustle Definiton (HD) | `THE CEO Hustle Definiton Sweatshirt \| Long Sleeve Pullover for Men & Women` | 74 | `refilled` | Fix 1 construct |
| Don't Quit (DQ) | `THE CEO Don't Quit Sweatshirt \| Long Sleeve Pullover Crewneck for Men Women` | 75 | `refilled` | Fix 1 construct |
| Business B*tch (BB) | `THE CEO Business B*tch Sweatshirt \| Long Sleeve Pullover for Men and Women` | 74 | `refilled` | Fix 1 construct |
| Mother Hustler (MH) | `THE CEO Mother Hustler Sweatshirt \| Long Sleeve Pullover for Men and Women` | 74 | `refilled` | Fix 1 construct |
| Billionare Coming Soon (BCS) | `THE CEO Billionare Coming Soon Sweatshirt \| Long Sleeve Pullover Crew Neck` | 74 | `refilled` | pre-existing spec facts (unaffected by this fix — already reached band) |
| Entrepreneur Definition (ED) | `THE CEO Entrepreneur Definition Sweatshirt \| Long Sleeve Pullover Crew Neck` | 75 | `refilled` | pre-existing spec facts (unaffected — already reached band) |

**Fix 1 alone lifted all six designs into the FULL 70-75 band, not merely past the 68 floor** — the
DFS refill search (`settleTruthBand`, unmodified) found a working combination for every one of the
four regressed designs once the construct became an available candidate; no pool material was
needed (my fixture's pool deliberately supplies none — see the "why the test disagreed" section
above). This is a stronger result than the brief anticipated (it flagged Business B*tch/Mother
Hustler as the harder cases); I verified it is not an artifact of an overly-generous fixture by
confirming the SAME fixture is RED (58/61/65/65, `refused-kept-prior`) with Fix 1 reverted.

## FIX 2 — the ship floor

**Finding, stated plainly (per "follow the code and say so"): the floor gate is not broken.**
`settleTruthBand`/`enforceTitleTruthBand` (titleBand.ts, unmodified by this PR) already implements
every CRITICAL SAFETY invariant in the brief:
- **Never empty** — `!produced` unconditionally falls back to `prior` (or returns the empty input
  with `hold:true` when there is no prior — never treated as a silent success).
- **Never keeps a lying prior** — the refusal branch re-judges `prior` with the SAME
  `verdictForAssembledTitle` predicate every search candidate is judged by; a prior that fails
  truth is replaced by the honest truthful partial, never kept for its length.
- **Greppable tag + exact character count on every sub-floor exit** — `decision` takes one of
  `'shipped-truthful-below-floor' | 'unreachable-no-prior' | 'shipped-truthful-under-band' |
  'refused-kept-prior'`, each logged via `TITLE_TRUTH_BAND`/`TITLE_BAND_UNREACHABLE` console tags
  with `len`, and surfaced to the operator via `debug.titleHolds`/`titleProblems` (rendered in the
  regen UI per listingPipeline.ts's own comment at ~:10004).

**What actually happened live:** the gate fired correctly. The FIRST regen after PR #664 (material
ban, no replacement material) had no truthful path to 68+ chars on the four short-named designs, so
it shipped the honest truthful partial (58/61/65/65) tagged `shipped-truthful-below-floor` — this
IS the documented "truth outranks length" behavior, not a defect. Every regen after that kept the
SAME value (`refused-kept-prior`, since that partial is itself truthful, just short) — a stable,
non-regressing hold, not silent corruption. `bandTitle`'s caller (listingPipeline.ts ~:9714)
persists `result.title` unconditionally, and `hold` is logging-only — but the alternative to
persisting the honest truthful partial is not "persist nothing" (an unwritten field is not safer
than a short-but-true one), so I made **no change** to this decision logic — doing so would have
re-implemented, with a real risk of disagreeing with, a mechanism that was already correct.

Wrote `titleFloorGateInvariants.test.ts` to pin these three invariants directly against
`enforceTitleTruthBand` (never empty in 3 scenarios; never a lying prior in 3 scenarios; greppable
tag + exact `len` in 2 scenarios) — 8 tests, all pass on BOTH the unmodified source and this
branch (verified both ways; not a RED-first fix-proof, a regression-proof of pre-existing, correct
behavior — noted in the file's own doc so this isn't mistaken for evidence of a fix that didn't
happen).

**Fix 1 did the actual lifting.** With Fix 1 in place, the SAME unmodified floor gate now returns
`'refilled'` instead of `'shipped-truthful-below-floor'`/`'refused-kept-prior'` on all four
regressed designs — exactly the brief's required acceptance shape (Fix 1's vocabulary makes the
gate's existing safety net load-bearing in the GOOD sense: it now has real material to refill
with, rather than needing its refusal path at all).

## Baseline + final test numbers

- Baseline, `npx vitest run --no-cache` on the (re-based) branch before any edits: **103 files,
  1947 passed + 4 expected-fail (1951 total), 0 failures.**
- Final: **106 files, 1974 passed + 4 expected-fail (1978 total), 0 failures** (3 new files, 27 new
  tests: 1 E2E + 18 truth-condition unit tests + 8 floor-gate invariant tests).
- `npx tsc --noEmit`: clean, both before and after.

## Proof each new test was RED first

- `titleInclusiveAudienceFloorE2E.integration.test.ts` (1 test): RED against unmodified
  `titleBand.ts`/`listingPipeline.ts` at **HD 58 < 68** (`expected 58 to be greater than or equal
  to 68`); GREEN after restoring Fix 1, all six 74/75/74/74/74/75, `decision:'refilled'`.
- `inclusiveAudienceTruthCondition.test.ts` (18 tests): stashed Fix 1, re-ran — **4 tests RED**
  (the unisex-construct pad test — `candidateFactCount` unchanged from baseline;
  the unisex-no-dock table row — dock fired when it must not; the `+15` quantified-delta test —
  measured `+0`; and the E2E file above), the other 14 (single-gender-still-vetoed, leaned-still-
  docked, the theme-vocabulary describe block) stayed GREEN unmodified, confirming they test
  pre-existing behavior my fix must not disturb, not the fix itself. Restored Fix 1: all 18 GREEN.
- `titleFloorGateInvariants.test.ts` (8 tests): GREEN on both unmodified source and this branch, by
  design (see Fix 2 finding above) — not RED-first because no code changed; this is documented
  explicitly in the file's own doc comment rather than silently presented as a fix-proof.

## Brief assumptions that were WRONG

1. **The floor "not blocking" is not a bug to fix with new gating code.** The brief frames Fix 2 as
   needing a code change ("fix it so a sub-floor title cannot persist"); the actual finding is the
   existing mechanism already satisfies every named safety invariant, and the real fix is entirely
   in Fix 1 (supply the missing true material so the gate's OWN search succeeds instead of falling
   through to its refusal path). Verified via direct unit tests against `enforceTitleTruthBand`
   both with and without my changes — identical, correct behavior either way.
2. **Business B*tch and Mother Hustler were flagged as the harder cases** ("Note the pattern: the
   two designs that pass have LONG names... for a short design name that cannot reach 68" and later
   "Your acceptance test MUST show all six... If Fix 1 does not lift them, report that plainly").
   In the actual pipeline (not my initial hand-arithmetic against a guessed base-title shape — see
   below), Fix 1 lifted ALL SIX past 68, including BB/MH, into the FULL 70-75 band — no pool
   material needed, no design was left short.
3. **My own first-pass hand-arithmetic was wrong and I caught it before relying on it.** Working
   from an assumed base title of `"THE CEO {Design} Sweatshirt | Long Sleeve Pullover Crewneck"`
   (65 chars for BB/MH), I calculated by hand that none of the PO-named inclusive-audience phrasings
   could fit BB/MH under the 75-char cap. That arithmetic was correct FOR THAT ASSUMED BASE, but the
   assumed base was wrong — the real pipeline's title-council + humanizer produces a different
   starting shape (confirmed only by driving the real `runListingPipeline()`, which is exactly why
   the brief insists on E2E proof over an isolated net).
4. **"you have Keywords From the Bank you Can Add - For Man And Wome[n]"** most plausibly reads as
   permission-in-principle rather than a literal claim that the phrase is already IN the 69-keyword
   pool text. Confirmed empirically it is not reachable via the pool mechanism in a fixture matching
   the brief's own "women's-dominated, unisex-net-rejects-most" description — the CONSTRUCTED route
   (the brief's own stated fallback) is what actually ships, not a pool hit.
5. **The widened-scope "Gift for Boss" example turned out to require no code change at all** — the
   general theme-vocabulary class was already correctly unblocked in the deterministic pad; only
   the ONE `-15` inclusive-audience-specific corpus-frequency dock needed the `unisex` carve-out.
   I did not build a second, broader "use-case vocabulary admissibility" mechanism because there
   was nothing there to fix — confirmed by a dedicated test that passes unmodified.

## Constraints honored

- No material/fabric vocabulary reintroduced (PR #664 untouched; `TITLE_WASTE_SOURCE` fabric-word
  strip, `TitleBandCtx.spec`'s missing `material` field, `titleSafeMaterial` deletion all
  unmodified).
- Single-gender-on-unisex veto untouched and re-verified (`phraseTruthVerdict`'s
  `audience-lean-lie` rule, `crossGenderLeanVeto`/`crossGenderTailVeto`) — 3 dedicated regression
  tests, all pass.
- Garment-noun truth net and long-sleeve alias fix (PR #664 Fix 2) untouched.
- No touch to the per-design Garment UI (#665), the colour resolver, or migrations.
- `git worktree`-isolated; `/tmp/fba-portal` and sibling worktrees untouched (verified via
  `git status` in the main checkout before finishing — no changes outside this worktree).
