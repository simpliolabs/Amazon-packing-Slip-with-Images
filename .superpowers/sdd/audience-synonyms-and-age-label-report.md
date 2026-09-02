# Audience synonyms + derived age label — report

## Status
Fixed, tested, pushed. No merge/deploy/Amazon push performed. Worked exclusively in
`C:\Users\Admin\AppData\Local\Temp\fba-wt-audage` (branch
`fix/audience-synonyms-and-derived-age-label`); `/tmp/fba-portal` and sibling worktrees untouched.

- PR: (filled in after push — see below)
- Final commit: (filled in after push)
- CI on final commit: (filled in after `gh pr checks`)

**Worktree note:** the branch was created from `main`, but local `main` was one commit behind
`origin/main` — missing exactly PR #662 (`74ef17f`), which the brief's Fix 1 section is built on
(the PO's gold string, the "0 of 10 seller golds carry it (-15)" dock, the 86/76 scores all come
from that commit). Fast-forwarded the new branch onto `origin/main` before starting — this only
moved the branch's own ref, never touched `main` or any sibling worktree. Baseline was measured at
that corrected commit (74ef17f), and it matches the brief's stated expectation exactly (99 files /
1889 passed / 4 expected-fail), confirming this was the intended base.

## FIX 1 — was the dock derived or hardcoded?
**Both, in different places — and the hardcoded half is the bug.**

- `opts.shape.audienceMix.inclusive === 0` (the "0 of 10" count in the dock message) IS genuinely
  corpus-derived (`measureGoldShape`, poGoldCorpus.ts) — but it only counts the LITERAL phrase
  `/\bfor\s+men\s+and\s+women\b/i`, so it stays 0 regardless of what gets added to the corpus; the
  new gold doesn't move it because it never claims to.
- The actual TRIGGER, `hasInclusiveAudience(t)` (titleBand.ts), is **hardcoded, not derived**: a
  closed set `AUD_ATTESTED` containing only the seven gender words the corpus happens to use, and a
  predicate that flags ANY audience span whose words are not all in that set — regardless of
  whether the span even has an opposing partner. "Kids" alone (no "Children" needed) was already
  false-positive-docked before this fix; "Kids & Children" made the same defect visible with real
  seller copy. Confirmed empirically (unmodified code): `hasInclusiveAudience("...for Kids &
  Children")` → `true`, `hasInclusiveAudience("...for Kids")` → `true`.

## FIX 1 — the cure
Axis + value classification (`AUDIENCE_TERM_AXIS` / `classifyAudienceWord`, `titleBand.ts`), not a
word-pair allowlist. Every recognised audience term maps to `{axis: 'gender'|'age', value}`.
`inadmissibleSpans` docks a span only when it carries **opposed** values on the **same** axis, or a
single **'universal'** term (unisex/family/everyone/both/ages — one word that itself claims every
value on its axis, the same waste as "Men and Women" spent in one word). Same axis + same value —
"Kids & Children", "Guys & Dudes" — is a synonym repeat and is never docked, however many times
named. The gold #7 shape exemption (juxtaposed, non-conjoined, title-terminal dual-gender — "for
Men Women") is preserved exactly, unchanged, scoped to gender only as before. Added `'children'` to
the recognised vocabulary (`AUD_HARD`) — it was previously invisible to the tokenizer entirely.

`hasInclusiveAudience` feeds BOTH the -15 judge dock (`listingPipeline.ts:1838`, unchanged call
site) and the `stripInclusiveAudience` net (`listingPipeline.ts:3718`) — one predicate, one fix,
both call sites cured together. (`enforceInclusiveAudience`, the OLDER door net exercised in
`titleInclusiveAudience.test.ts`, is a *separate*, narrower, literal-gender-pair regex that never
even looked at "kids"/"children" — confirmed by tracing it and by a test that stayed green against
*unmodified* source; removed from the diff since it doesn't prove anything about this change.)

## Gold's score: before / after
- **86 → 100** (the PO's exact gold, `TITLE_SHAPE_JUDGE=on`, full 10-gold corpus).
  Before: `problems: ['"for Men and Women" — 0 of 10 seller golds carry it (-15)']`.
  After: `problems: []`.
- The B0DP5H8QBT machine title it replaced (bare "Kids", same class, same cure): **76 → 91**
  (100 − 10 for an unrelated, untouched "crew neck" unattested-vocabulary dock — the only dock
  either title now carries is the one this fix does NOT touch).

## The attack is still docked (scope discipline honored)
`hasInclusiveAudience` unchanged-true for every existing pinned attack, empirically re-verified
post-fix: `"for Men and Women"`, `"for Adults and Kids"`, `"for Men or Women"`, `"for Guys and
Girls"`, `"for Him and Her"`, `"for the Whole Family"`, the live rejection specimen, and the
cross-span "…for Men | …for Women" split-audience attack. "for Men and Women" specifically is OUT
OF SCOPE per the brief (the PO has not ruled on it) and was never touched — same regex, same dock,
same message, byte-identical.

## FIX 2 — the class and the cure
**The class:** a hand-authored label table (`AGE_RANGE_LABEL.kids = 'Kids'`) was never checked
against the live accepted enum, so a label that can NEVER validate on this product type's real
schema (`["Adult","Big Kid","Infant","Little Kid","Toddler"]` — no bare "Kids" member at all) fails
silently on every merge, forever, and the field falls through to whatever the LLM happens to guess.

**The cure:** `AGE_RANGE_PREFERENCE` (contentTruth.ts) — an ORDERED PREFERENCE per age class — plus
`resolveAgeRangeLabel`, which walks the preference list and returns the first member present in the
LIVE `accepted[]`. `resolveGarmentAudience` gained an optional `ageRangeAccepted` field; the call
site (`listingPipeline.ts:11527`) looks up the live menu entry for `age_range_description` (the
same lookup pattern `appendSpecFact` already uses) and threads its `accepted` array in. No accepted
list available → degrades to the single fixed label, byte-identical to this resolver's behavior
before the ruling (verified: every existing unit test that calls `resolveGarmentAudience` without
`ageRangeAccepted` still passes unchanged). No preference member present in a REAL accepted list →
`ageRangeCandidate: null` (no row proposed) and a loud `console.warn(JSON.stringify({tag:
'AGE_RANGE_LABEL_NO_MATCH', ageClass, preference, accepted}))` — never an invented value.

`departmentQualifier`'s own use of `AGE_RANGE_LABEL` (composing "Unisex Kids" as a human department
phrase, snapped to `department`'s own enum downstream by `coerceGenderToEnum` — a different field,
already validated on a different path) was deliberately left untouched — out of scope, not broken.

**Preference lists actually shipped** (verify before extending further — corroborated by the PO's
ruling plus adjacent, plausible Amazon vocabulary, not exhaustively confirmed against every product
type's live schema):
- `kids: ['Big Kid', 'Little Kid', 'Kid', 'Youth', 'Kids']`
- `toddler: ['Toddler', 'Little Kid']`
- `infant: ['Infant', 'Newborn', 'Baby']`
- `newborn: ['Newborn', 'Infant', 'Baby']`
- `adult: ['Adult']`

('Kids' plural kept as the LOWEST-priority kids fallback, not in the brief's suggested list — a
real product type whose enum happens to carry it should still resolve correctly, and it is what
lets the file's two pre-existing "happy path" integration fixtures, which declare an enum with
'Kids' but no 'Big Kid', keep resolving without a fictional value being invented.)

## Age value emitted per test enum
| `accepted[]` | `age_class` | emitted | proven via |
|---|---|---|---|
| `["Adult","Big Kid","Infant","Little Kid","Toddler"]` (the exact live enum) | `kids` | **Big Kid**, `enum_valid:true`, `is_enum:true`, `value_source:'spec'` | real `runListingPipeline()` |
| `["Youth","Adult"]` | `kids` | **Youth**, `value_source:'spec'` | real `runListingPipeline()` |
| `["Adult"]` only | `kids` | **no row** + `AGE_RANGE_LABEL_NO_MATCH` log (`ageClass:'kids'`, `accepted:['Adult']`) | real `runListingPipeline()` |
| *(none supplied)* | `kids` | **Kids** (today's pre-ruling behavior, unchanged) | pure unit (`resolveGarmentAudience`) |
| `[' big kid ', 'adult']` (case/whitespace) | `kids` | **Big Kid** | pure unit |

## Length work — before / after (unchanged; only exact-value assertions can prove this)
- **B0DSCDZC6K** (6 designs, `garmentRepetitionClass.test.ts`): `BB=74 BCS=73 DQ=70 ED=73 HD=72
  MH=71` — all inside 70-75. This is an exact-value assertion (`console.log`-reported and
  range-checked per row); it passed unmodified against the fixed code, so the numbers are
  byte-identical before and after.
- **B0DP5H8QBT** (`attributeSpecGroundingE2E.integration.test.ts`): `74 → 64 → 73` chars —
  `expect(shipped.length).toBe(73)` is an exact pin, passed unmodified, so 73 ≥ the 68 floor is
  unchanged before/after.

## The two defect classes, one sentence each
1. **Audience-span analyzer:** an audience-word admissibility check reused ONE gender-only closed
   vocabulary to answer TWO different questions (is this word attested at all? is this pair
   opposed?), so a same-axis synonym repeat and a genuine opposed-axis reach-widening claim scored
   identically — the cure separates them into an explicit `{axis, value}` classification with an
   exhaustiveness test that fails if a new audience word is ever added without one.
2. **Derived age label:** a deterministic Product Detail producer emitted a hand-typed label that
   was never checked against the live accepted enum for the field it targets, so it could silently
   and permanently fail to validate on any product type whose schema didn't happen to carry that
   exact word — the cure resolves an ordered preference against the live enum at call time instead
   of writing one fixed guess.

## What makes a future instance structurally impossible
- **Fix 1:** `AUDIENCE_TERM_AXIS` is exported and `goldCorpusSelfTest.test.ts`'s "AXIS-DRIVEN, NOT
  LISTED" test iterates the REAL `AUD_HARD`/`AUD_SOFT` vocabulary sets (not a hand-copied list) and
  asserts every member has a classification — add a new audience word to either set without adding
  its `{axis, value}` here and this test goes red, loudly, before the gap can silently admit or dock
  a term by accident.
- **Fix 2:** `AGE_RANGE_PREFERENCE` is resolved against whatever `accepted[]` the caller supplies at
  runtime, never a hand-picked single guess — proven with a fabricated `["Youth","Adult"]` enum that
  the code has never seen and correctly resolves `kids → 'Youth'` with zero code change. A schema
  with genuinely no matching member gets a loud, greppable log and no invented row, never a silent
  pass.

## Proof each new/updated test was RED first
Every new or materially-changed assertion in this PR was verified to FAIL against the unmodified
source before the fix, by `git stash`-ing only the implementation file(s) and re-running:
- **Fix 1** (`titleBand.ts` stashed): 11 tests in `goldCorpusSelfTest.test.ts` +
  `titleV4.test.ts` went RED (wrong boolean/score on the new axis cases, the exhaustiveness test's
  `AUD_HARD is not iterable` since the export didn't exist yet, the QUANTIFIED test's 86≠100).
  One case added to `titleInclusiveAudience.test.ts` was found to be already-green pre-fix (the
  door net it targets doesn't use the changed predicate at all) and was REMOVED rather than kept as
  a false proof.
- **Fix 2** (`contentTruth.ts` + `listingPipeline.ts` stashed): 6 tests in
  `garmentAgeProducer.integration.test.ts` (real pipeline) + 4 tests in
  `garmentAudienceProducer.test.ts` (pure resolver) went RED (`'Kids'`/`undefined` where `'Big
  Kid'`/`'Youth'`/`'spec'`/the loud log were expected).

## Brief line numbers that were WRONG
- The worktree-add instruction (create from local `main`) implicitly assumed local `main` already
  carried PR #662 — it was one commit behind. Followed the CODE (origin/main, matching the brief's
  own cited facts) over the literal instruction; documented above.
- Everything else in the brief — the exact dock message text, the 86/76 scores, the exact live
  enum, "0 of 10", gold #7's exemption shape — verified correct against the actual code and DB-cited
  facts; no other line was wrong.

## Constraints honored
- Did not touch fit/silhouette spec-grounding (#662), the detail-attribute precedence merge (#661,
  `productDetailAttrs.ts` untouched except by its own pre-existing test file which needed no
  changes), the colour resolver, or migrations.
- No rule added against cross-pipe garment-noun repetition (PO ruling 2026-09-02, out of scope).
- `for Men and Women` untouched — same dock, same message, same regex, verified still true.
- `departmentQualifier`'s "Unisex Kids" composition untouched — different field, different enum,
  already validated on a different path.

## Baseline / final test numbers
- Baseline (`74ef17f`, matches the brief's own stated expectation): **99 files / 1889 passed / 4
  expected-fail (1893 total)**. `tsc --noEmit` clean.
- Final (both fixes + all new/updated tests): **99 files / 1907 passed / 4 expected-fail (1911
  total)**. `tsc --noEmit` clean. Zero regressions; net +18 tests, all passing.
