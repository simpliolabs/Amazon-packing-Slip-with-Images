# Plan — Item Highlights: per-design lines, readable, truthful

**Spec:** `docs/superpowers/specs/2026-09-05-item-highlights-rebuild.md` (R2, approved).
**Branch:** `feat/ih-per-design` (worktree). Base: `main` at `42cc564`.

## Why (one paragraph, for orientation only)

The live Item Highlight for family B0DSCDZC6K is one line shared by all six designs:
`Crewneck Sweatshirts Women, Fall Sweatshirts for Women, Graphic Crewneck, 50% Cotton / 50% Polyester, Classic Fit`.
It reads generic because `buildItemHighlightsPerDesign` composes ONE line by intersecting all six
designs (every design is "foreign" to every other; rank by the MINIMUM theme-fit across all six), so
design vocabulary is stripped by construction — no vision model can fix that. It repeats "Women" and
"Sweatshirts" because the composer's only anti-repeat rule is "adds ≥1 new token". And the line
LIVE on Amazon (pushed 2026-07-23, before the truth stage existed) still says `relaxed unisex fit`
on a Classic-fit blank. Per-design storage (`per_child_item_highlights`, migration 060) and the
per-design push path (`pushExecutor.ts:780 readPerDesignItemHighlights`, `buildPerSkuItemHighlightMap`)
already exist and were verified 2026-09-06.

## Global Constraints (binding — copy into every reviewer dispatch)

- **Composer stays deterministic. No LLM.** PO sign-off 2026-08-20 after rejecting the LLM version
  ("THESE ARE TERRIBLE!!!"). Any task that adds an OpenAI call to the Item Highlights path is wrong.
- **Truth over length.** A line that cannot reach `CONTENT_CONTRACT.itemHighlights.min` (107)
  truthfully HOLDS with a named reason. Never pad with an unprovable attribute. Never invent a class.
- **ONE coverage predicate.** Any "already covered / duplicate token" decision goes through the
  existing coverage-core folding (`ihFoldWord` / `significantFolded`), never a new tokenizer.
- **Amazon ≤2 per-word cap** (`ihRepeatViolations`, `capItemHighlightRepeats`) stays as defence in
  depth at the push boundary. The new repeat rule is STRICTER at composition; it does not replace
  the push-boundary net.
- **Never borrow another design's line.** A design with no composable line is `no-line-for-design`
  and its SKUs are held. Cross-design fallback is forbidden.
- **Material vocabulary is banned from TITLES only** (PO 2026-09-03). It is permitted in Item
  Highlights. Do not "fix" `50% Cotton / 50% Polyester` out of the line.
- **Fit/fabric claims must be provable from `blank_specs`.** `relaxed` may not appear for a blank
  whose fit is `Classic`. This is what `ihTruthVerdict` exists for — reuse it, do not add a net.
- **Do not touch** the push rails, the hold reasons, the marker row (#668), or the title path.
- Tests assert the RETURNED BYTES of the function under test, downstream of the consumer, and prove
  the branch ran. A test that only asserts a mock was called does not count.

---

## Task 1: Compose ONE line PER DESIGN, not one shared line

**Files:** `src/lib/fba/listingPipeline.ts` (`buildItemHighlightsPerDesign`, ~line 2437 on main
`42cc564`; find it with `grep -n "export function buildItemHighlightsPerDesign"`), plus its existing
tests (`grep -rln "buildItemHighlightsPerDesign" src/lib/fba/*.test.ts`).

**What it does today (read this in the code before changing anything):** builds a `sharedForeign`
set as the UNION of every design's foreign tokens (`buildForeignDesignTokens(..., {strictNames:true})`
over `designKeys`), filters the pool to keywords foreign to NONE of them, re-scores each survivor
with `minFitOverDesigns(k, designKeys)`, composes ONE `value`, and writes that same value into every
design's `perDesign` entry and every SKU's `perChild` entry (`IH_SHARED` log line).

**What it must do instead:** for EACH design key `d` in `designKeys`:
1. Foreign set = `buildForeignDesignTokens` over the OTHER designs only (exclude `d`). A design's own
   vocabulary is never foreign to itself.
2. Pool for `d` = pool keywords not foreign to `d`, scored by `d`'s OWN `themeFit` (the per-design
   rating that already exists — do NOT take a minimum over designs).
3. Compose with the existing composer (`composeItemHighlight` or whatever `buildItemHighlights`
   calls — reuse, do not fork), passing `d`'s own audience lean and `d`'s design name so audience
   truth is per-design.
4. `perDesign[d].line` = that line; every SKU whose design is `d` gets it in `perChild`.
5. A design whose pool cannot compose HOLDS with the existing hold reason (`no-line-for-design`,
   unrated-pool, thin-pool) — ONLY that design's SKUs are held. Other designs are unaffected.

**Keep the return shape** `{ perDesign, perChild, shared }` so the route and push seam compile
unchanged. `shared.value` becomes `''` when lines differ across designs (it is already documented
as "no broadcast line by construction" for per-design families — see `pushExecutor.ts:791`);
`shared.designKeys` / `missingDesigns` / `foreignDropped` keep their meaning. Replace the `IH_SHARED`
log with one `IH_PER_DESIGN` line per design carrying `{design, pool, scoped, len, hold}`.

**Tests (write these FIRST, watch them fail against unmodified source, then implement):**
- Six designs with distinct rated pools → six DISTINCT `perDesign` lines; each SKU's `perChild` line
  equals its own design's line, never a sibling's.
- Design A's distinguishing phrase (e.g. `motivational entrepreneur sweatshirt`) appears in A's line
  and in NO other design's line.
- A design whose pool is unrated (`ratedShare < 0.3`) holds with the existing reason while the other
  five still compose — assert the five lines are non-empty and the held one's SKUs carry
  `hold` and an empty `item_highlight`.
- `lean_female` design's line may contain `Women`; a `unisex` sibling's line must not carry a bare
  gendered audience word it cannot support (reuse the existing audience predicate in the truth
  stage — assert on the returned bytes).
- Blank 18000 (`fit: 'Classic'`): the word `relaxed` never appears in any returned line. (This is
  the live falsehood; it should already be prevented by `ihTruthVerdict` — the test PROVES it.)
- Every existing test for `buildItemHighlightsPerDesign` still passes or is updated with a comment
  saying which assertion changed and why (the shared-line assertions are expected to change).

**Verify:** `npx tsc --noEmit` → 0; `npx vitest run src/lib/fba/` all green except the 4
pre-existing expected-fails.

## Task 2: A phrase that repeats a used significant token loses its slot

**File:** `src/lib/fba/itemHighlightComposer.ts`. The selection loops at the lines matching
`if (!folded.some((w) => !usedFolded.has(w))) continue` (two sites on main `42cc564`: the pool-phrase
loop and the spec-fact loop). Find them with `grep -n "usedFolded.has" src/lib/fba/itemHighlightComposer.ts`.

**Today:** a candidate is accepted if it adds AT LEAST ONE new folded significant token. So
`Crewneck Sweatshirts Women` then `Fall Sweatshirts for Women` (adds only `fall`) is accepted, and
the line repeats `sweatshirts` and `women`. Amazon's ≤2 cap passes it because each appears exactly
twice.

**New rule, deterministic, in BOTH loops:** rank candidates in two tiers.
- Tier A: candidates whose folded significant tokens are ALL new (zero overlap with `usedFolded`).
- Tier B: candidates that add ≥1 new token but repeat ≥1 used token (today's rule).
Fill from Tier A in the existing order (theme-fit, then volume). Fall back to Tier B ONLY when Tier A
is exhausted AND the line is still under `CONTENT_CONTRACT.itemHighlights.fillTarget` (110). Never
pick from Tier B while a Tier-A candidate remains. Garment-noun surface variety (`shirts` / `tees` /
`top` as distinct indexed tokens) is already rewarded and must keep working — those are DIFFERENT
folded tokens, so they are Tier A by construction; do not special-case them.

**Tests (first, RED against unmodified source):**
- Pool `[Crewneck Sweatshirts Women (fit 3, vol 900), Fall Sweatshirts for Women (fit 3, vol 800),
  Graphic Pullover Top (fit 3, vol 700), Long Sleeve Crewneck (fit 2, vol 600)]`: the composed line
  contains `Graphic Pullover Top` BEFORE it contains `Fall Sweatshirts for Women`, and `women`
  appears at most once unless Tier A was exhausted below 110 chars.
- With a pool whose Tier A cannot reach 110 chars, Tier B is used and the line still reaches
  `min` (107) — the fallback is real, not dead.
- The existing `ihRepeatViolations` test file still passes untouched.

**Verify:** as Task 1.

## Task 3: Prove the wire — per-design lines reach the push seam with the truth fix intact

**Files:** `src/lib/fba/perDesignItemHighlights.ts` (`buildPerSkuItemHighlightMap`), and the push
seam it feeds (`pushExecutor.ts` around `readPerDesignItemHighlights`, ~line 780). NO production
code change is expected in this task; it is a wire-liveness test. If a production change turns out
to be necessary, STOP and report `DONE_WITH_CONCERNS` explaining why.

**Write one test file** that:
- builds a six-design `perChild` array via the real `buildItemHighlightsPerDesign` (from Task 1),
- feeds it to the real `buildPerSkuItemHighlightMap`,
- asserts each SKU maps to ITS design's line (six distinct values across the map),
- asserts the held design's SKUs map to `NO_LINE_FOR_DESIGN` and are absent from the pushable set,
- asserts that for blank 18000 no mapped value contains `relaxed`, and at least one contains
  `Classic` — this is the exact truth-fix that must ship over the live `relaxed unisex fit`.

This test is the acceptance for the whole plan: it proves Tasks 1 and 2 produce bytes the push
boundary will actually send, downstream of the consumer, not just that the functions exist.

**Verify:** as Task 1.

## Task 4: `ihTruthVerdict` gains a fit-claim rule grounded in `blank_specs.fit`

**Added by controller ruling after Task 1** (see ledger): the plan assumed this rule existed; the Task 1
implementer proved empirically that it does not — a `relaxed fit tee` pool phrase composes through
unchanged on a `Classic` blank today. This is the exact class behind the LIVE falsehood
(`relaxed unisex fit` on Gildan 18000, Classic fit) that Task 3's push is meant to kill; without this
rule the next pool can reintroduce it.

**File:** `src/lib/fba/contentTruth.ts` — `ihTruthVerdict` (find with `grep -n "ihTruthVerdict"`). Extend
the ONE shared predicate; do NOT add a separate net anywhere. The weight-class rule already in it is
the pattern to follow.

**Rule:** a phrase asserting a FIT (`relaxed`, `classic`, `oversized`, `slim`, `fitted`, `boxy`,
`regular` — build the list from the existing fit vocabulary in `blankSpecs.ts`/`garmentNoun.ts`, do not
invent one) is truthful ONLY if it matches `spec.fit` (case-insensitive, after the existing fold). No
spec → no fit claim may pass (fail CLOSED for this one class — a fit claim with no blank behind it is
exactly how the live lie shipped). Phrases with no fit word are unaffected.

**Tests (RED first):** `relaxed fit tee` on a Classic blank → rejected with a named reason; `classic
fit sweatshirt` on a Classic blank → ok; `oversized` on a Comfort Colors Relaxed blank → rejected
(Relaxed ≠ Oversized — the PO's 2026-08-20 wear-style ruling is a SEPARATE, opt-in fact and must not be
conflated); a phrase with no fit word → unchanged verdict; `relaxed` with `spec: null` → rejected.
Then re-run the Task 1 test file and assert the "relaxed never appears on a Classic blank" case now
holds with a `relaxed` phrase PRESENT in the pool (Task 1 could only prove the ordinary case).

**Verify:** as Task 1.

## Task 5: per-design audience truth in the Item Highlight composer

**Added by controller ruling after Task 1** (see ledger): the plan's audience bullet assumed per-design
audience-lean plumbing in the IH path; none exists (the gender rule is title-only). The PO's complaint
"Women repeating twice" was on a UNISEX family.

**Files:** `src/lib/fba/itemHighlightComposer.ts` and/or `buildItemHighlightsPerDesign` — wherever the
per-design pool is scoped (Task 1's partition). REUSE the title path's audience predicate (find it:
`grep -n "stripInclusiveAudience\|enforceHardAudience\|audienceLean\|designPhraseCarriesGender"
src/lib/fba/listingPipeline.ts src/lib/fba/titleBand.ts src/lib/fba/contentTruth.ts`) — do not write a
second gender rule. A design whose lean is `unisex` may not carry a bare `Women`/`Men`/`Ladies`/`Mens`
phrase unless the DESIGN PHRASE itself carries the gender (that exemption already exists for titles);
`lean_female` / `lean_male` designs may.

**Tests (RED first):** unisex design with a women-heavy pool → returned line carries no bare gendered
audience word; `lean_female` sibling in the same family → its line MAY carry `Women`; a unisex design
whose design phrase itself is gendered (e.g. "Mother Hustler") keeps its own phrase. Assert on returned
bytes.

**Verify:** as Task 1.

## Task 6: NO repeated significant word — absolute. Tier B is replaced by HOLD.

**PO RULING 2026-09-06**, verbatim: *"2. No Repeat as per Amazon Ruules"* — given in answer to the
controller's proposed spec amendment ("no repeat unless the 107 floor cannot otherwise be reached
truthfully"). The amendment is REJECTED; the spec row stands as written:
`No repeats | no significant word twice — Women, … Women is a FAIL (stricter than Amazon's cap of 2)`.

**What ships today (PR #673, Task 2) and must change:** `itemHighlightComposer.ts` fills from Tier A
(all folded significant tokens new) and then FALLS BACK to Tier B (adds ≥1 new token but repeats ≥1
used token) whenever Tier A is exhausted below `fillTarget` (110). The final reviewer's probe shipped
`Shirts` twice on one design under that fallback. Under this ruling a Tier-B pick is never allowed.

**The rule:** in BOTH selection loops (pool phrases and the spec-fact pad), a candidate that repeats
ANY already-used folded significant token is REJECTED, full stop. If Tier A is exhausted and the
line is still under `CONTENT_CONTRACT.itemHighlights.min` (107), the design HOLDS with a NEW named
reason (e.g. `under-floor-no-repeat` — follow the existing `IhHoldReason` / `IH_HOLD_MESSAGES` pattern
exactly, with a PO-facing message that says the pool cannot fill 107 chars without repeating a word
and names the action: rate/enrich the pool). Never compose a repeat to reach the floor. The push-
boundary ≤2 cap (`ihRepeatViolations` / `capItemHighlightRepeats`) STAYS as defence in depth.

**Task 2's pad-loop ruling still applies:** the six spec-fact fillers are independent truths and share
only the code-appended boilerplate `Fit`/`Fabric`; the pad loop judges against the pre-pad snapshot
(`usedBeforePad`) so `Classic Fit` + `Unisex Fit` may co-exist (PO ruling 2026-08-06). That exemption
is NOT a repeat in the spec's sense and is unchanged. A spec fact that repeats a POOL token is still
rejected.

**Files:** `src/lib/fba/itemHighlightComposer.ts` (both loops; the `tier` outer loop collapses to Tier
A only — delete the Tier-B pass rather than gating it, so the dead branch cannot be re-enabled by a
constant), `src/lib/fba/listingPipeline.ts` (`IhHoldReason` union + `IH_HOLD_MESSAGES`), and the
tests that pinned the fallback (`itemHighlightComposer.test.ts` — the Task 2 test that proved the
fallback was REAL must now be inverted deliberately with a comment: it proves the HOLD instead).

**Tests (RED first):** a pool where Tier A reaches only 49 chars and Tier B would reach 107 → returns
null/hold with `under-floor-no-repeat` (today it composes with a repeat); the realistic six-design
fixture under unisex still composes all six ≥107 with ZERO repeated significant tokens (assert by
folding every line and checking for duplicates — returned bytes, not the composer's internal set);
the pad-loop exemption still holds (`Classic Fit` + `Unisex Fit` co-exist); `womenCount === 1` on
the Task 2 fixture (the assertion the final reviewer said was untested in the branch where it bites).
Then re-run the acceptance test `itemHighlightPushSeam.test.ts` — if any design now HOLDS on the
re-baselined fixture, that is a real consequence of the ruling: report it, do not re-fixture; the
controller decides whether the fixture pool is representative.

**Verify:** `npx tsc --noEmit` → 0; full `npx vitest run src/lib/fba/` green except the 4 pre-existing
expected-fails.

## Task 7: extend the audience lexicon — for BOTH surfaces, ONE lexicon

**PO RULING 2026-09-06**, verbatim: *"1. Extend"* — given in answer to: the shared forced-gender
lexicon is `wom[ae]n's?|ladies|lady` / `m[ae]n's?` only, so `guys`, `dudes`, `bros`, `gals`, `girls`,
`boys` are invisible and six unisex lines lead "Novelty Shirts for Guys". The PO chose to extend the
SHARED predicate, knowing it changes the TITLE path too.

**The rule:** extend `LEAN_FEM_RE` / `LEAN_MASC_RE` (`src/lib/fba/contentTruth.ts:262-263`, and their
`_G` derivations at `:276-277` which must stay derived via `new RegExp(source,'gi')`) so the
forced-gender rule (c2) recognises: feminine `gals|girls|girl|ladies|lady|women|womens|woman|womans`;
masculine `guys|guy|dudes|dude|bros|bro|gents|gent|men|mens|man|mans` (build the final lists from the
existing patterns plus these; keep the apostrophe/plural handling the existing regexes have). Apply
the word-boundary discipline the existing regexes use so `germany` / `human` / `management` are not
matched.

**ONE lexicon, not four.** The Task 5 review found two other copies: `src/lib/sync/syncListingContent.ts:382-383`
and `src/lib/keyword-engine/nicheGuards.ts:220-221`. Either derive all consumers from the ONE
exported source (preferred — export the pattern strings from `contentTruth.ts` and import them; check
for import cycles first, `contentTruth.ts` is a leaf) or, if a consumer cannot import without a
cycle, add an ENUMERATION test that fails when any copy's word set differs from the source. A silent
fourth copy is how this class recurs.

**Kids/adult interaction — check before building:** `girls`/`boys` are also kids-audience words in
rule (c) (`contentTruth.ts` kids/adult, `KIDS_AUDIENCE`). A phrase like `shirts for girls` on a kids
family must not now be rejected by (c2) as "feminine on a unisex kids design" when it is the correct
kids audience — trace how (c2) reads `audienceLean` vs how (c) reads the kids blank, and pin the
interaction: kids family + `for girls` + design lean unisex → ok (kids audience wins); adult unisex
family + `for guys` → rejected; `lean_male` adult family + `for guys` → ok. If the two rules
conflict in a way the ruling did not anticipate, STOP and report BLOCKED with the trace.

**Title-path consequence, pinned:** a title candidate `for guys` on an adult `lean_female` design is
now rejected the same way `for men` is (`field:'title'`); the existing title tests must stay green
except any that pinned `guys` passing — change those deliberately with a comment citing this ruling.

**Tests (RED first):** unisex adult design, men-heavy pool with `novelty shirts for guys` → line has
no bare masculine word (today it leads with it); `lean_male` sibling → may carry it; kids interaction
pins above; title-path pins above; lexicon-parity enumeration test (or the shared-import proof).

**Verify:** as Task 6; plus the title-path suites (`titleBand`, `truthBandGate`, `titleMoneyTail`,
`lockedTitleTruth`) and `syncListingContent`/`nicheGuards` tests.
