# Age-row provenance defect — report

## Status
Fixed, tested, pushed. PR open (see below). No merge/deploy/Amazon push performed.

## Live defect (B0DP5H8QBT)
`Age Range Description` shipped `'Big Kid'` with `value_source = null` (the mega-audit LLM's guess
from the listing's own existing copy) instead of the deterministic `'Kids'` row PR #654's garment
age producer was supposed to append.

## Which of the four causes was true
**Cause #1** — confirmed by reading the merged code, not assumed.

`appendSpecFact` (`src/lib/fba/listingPipeline.ts:11543-11554` pre-fix) guarded:

```ts
if (!menuAttr || pdiFinal.some((p) => rowRe.test(String(p.field_name ?? '')))) return
```

This skipped the deterministic append whenever **any** row already matched the field regex —
regardless of that existing row's `value_source`. The mega-audit's `product_details_improvements`
pass (and the "dedicated details-fill" pass, `listingPipeline.ts:5698-5749`) already proposes an
`Age Range Description` row (guessed from `variantDetails`/existing copy) on essentially every apparel
family with a live schema menu, and it always runs **before** the deterministic append at
`listingPipeline.ts:11598` (`if (aud.ageRangeCandidate) appendSpecFact('age_range_description', ...)`,
itself inside the `if (apparelProduct && (lean || aud.ageClass))` gate at `:11565`). So the LLM's row
won by simply arriving first — `appendSpecFact` never even tried to add its own row once one already
existed for the field.

This was NOT cause #2 (the append is not gated on `menuAttr.accepted` at all — it never checked the
accepted list, so a schema mismatch was not the failure). NOT cause #3 (the append site IS reached:
`aud.ageClass === 'kids'` via `blank-column` source makes the outer gate and `aud.ageRangeCandidate`
both truthy for this family). NOT cause #4 (nothing downstream re-merges or replaces the row after
`pdiFinal` is assembled — `stickyDetails.ts`'s `applyStickyDetails` only arbitrates a fresh row
against a *previously accepted push*, one row per field in, one row per field out; it does not
deduplicate multiple same-field rows in the same array, and no such duplicate-collapse existed
anywhere in the pipeline before this fix).

**Why it escaped CI**: the pre-fix integration test's own audit stub (`kitchenSink()` in
`garmentAgeProducer.integration.test.ts`) proposed only `Department`/`Target Gender` from the LLM —
never an `Age Range Description` row — so the guard's collision case was never exercised. Textbook
"test proves the mock, not the wire."

## Asymmetry with Department (why Department "just worked")
Department's deterministic value is applied via an **unconditional overwrite** inside a
`pdiFinal.map` (`listingPipeline.ts:11584-11589`) that replaces whatever row already exists — an
accident of a different call shape, not a stated rule. `age_range_description` had no equivalent
overwrite step, only the append-if-absent helper. `apparel_fabric_stretch` and `fit_to_size_sentiment`
were also safe, but only because each has a **paired** `overrideField(...)` call immediately before
its `appendSpecFact(...)` call (`listingPipeline.ts:11619-11630`) — the override always runs first and
stamps the row `'spec'`, so the append (unmodified) always found a `'spec'`-stamped row already present
and no-opped correctly. Age was the one call site relying on `appendSpecFact` alone.

## The defect class
**A deterministic, provenance-stamped producer and the mega-audit LLM can both emit a row for the
same detail field in the same `product_details_improvements` array, and nothing decided which one
ships — the outcome depended on which producer's call shape happened to be "overwrite" (safe) versus
"add-if-absent" (unsafe), an accident of how each site was individually hand-written, not an enforced
rule.** Any future deterministic producer that follows the "add if absent" shape (rather than
remembering to also write a paired unconditional override, as five of six prior sites did) inherits
the exact same exposure the age producer had.

## What makes a future instance structurally impossible
Added `mergeDetailRowsByPrecedence()` (`src/lib/fba/productDetailAttrs.ts`) — a pure function with a
closed precedence order (`spec` > `ruling` > `audience` > unstamped/LLM) — called **once**, on the
fully-assembled `pdiFinal` array, immediately before it ships (`listingPipeline.ts`, right before
`return scrubPublished({...})`). `appendSpecFact` no longer refuses to run when a row already exists
for the field (its guard now only skips when a matching row is **already** `'spec'`-stamped, avoiding
redundant duplicate pushes after `overrideField` already handled it) — it always emits its candidate,
and the merge is the one place, independent of any call site's shape, that resolves which row for a
field survives. A brand-new producer for a brand-new field needs no defensive "does a row already
exist" check of its own: stamp `value_source` and push the row; precedence is enforced structurally at
the merge, not by convention at each call site. Verified generically: `productDetailAttrs.test.ts`
drives the precedence rule over a field list that includes a field **no current producer emits**
(`'Battery Type'`), proving a hypothetical future field is covered without a hand-written case.

The merge deliberately does **not** collapse a field where every row is unstamped (no stamped
competitor exists) — that is a different, out-of-scope duplicate-row question this task was not asked
to fix, and collapsing it would have been an unrelated behavior change.

## Untouched (per constraints)
- `Target Gender` — value_source/logic at `listingPipeline.ts:11588` unchanged; still `'audience'` only.
- `blank_specs`, migration 071, the colour resolver — not touched.
- `titleBand.ts`, `contentTruth.ts` — not modified (only *read* `contentTruth.ts` for
  `resolveGarmentAudience`'s existing contract; no edits).

## Tests added
- `src/lib/fba/productDetailAttrs.test.ts` (new) — the class test: `mergeDetailRowsByPrecedence`
  driven over `FIELD_LIST = ['Age Range Description', 'Department', 'Fabric Type', 'Battery Type',
  'Some Brand New Attribute']` via `it.each`, both arrival orders, full precedence chain
  (spec > ruling > audience > unstamped), the no-op control (all-unstamped duplicates untouched),
  single-row no-op, case/spacing-insensitive field matching, and no cross-field contamination.
- `src/lib/fba/garmentAgeProducer.integration.test.ts` — added "THE LIVE CASE (B0DP5H8QBT)": drives
  the real `runListingPipeline()` with an OpenAI stub whose audit payload **already** proposes
  `Age Range Description = 'Big Kid'` (unstamped) alongside `blank_specs.age_class = 'kids'`. Asserts
  exactly one row ships, `value_source === 'spec'`, `recommended_value === 'Kids'` (not `'Big Kid'`),
  and the value is a member of the fixture's live `accepted` enum — provenance asserted directly, per
  "prove the branch ran, not just the output."
- Existing "NO-OP CONTROL" test (adult family, no stated `age_class`) re-verified unchanged/passing —
  the deterministic append is never attempted for that family (`aud.ageRangeCandidate` stays `null`),
  so nothing in this fix touches its byte-identical LLM-guess-only output.

## Verification
- Baseline (`main`, before any change), `npx vitest run --no-cache`: **97 test files, 1828 passed +
  4 expected-fail (1832 total)**, exit 0.
- Final (after fix), same command: **98 test files, 1853 passed + 4 expected-fail (1857 total)**,
  exit 0. Delta = +1 file, +25 tests, all passing — zero regressions.
- `npx tsc --noEmit`: exit 0, no errors.
- CI trap avoided: `productDetailAttrs.test.ts` imports only pure modules (no Supabase client
  construction at import time — confirmed by reading `contentContract.ts`'s own "NOTHING in this
  module has side effects" header) so no env-nulling was needed there.
  `garmentAgeProducer.integration.test.ts` already nulls/restores the three Supabase env vars
  (pre-existing pattern in that file, unchanged).

## Brief line numbers that were WRONG (or imprecise)
- The brief's own framing of PR #654's intent ("choosing a value from `menuAttr.accepted`") is
  **aspirational, not actual**: `appendSpecFact` never checked `val` against `menuAttr.accepted` —
  it only checked that `menuAttr` (the key) existed. `contentTruth.ts:313-315`'s docstring on
  `ageRangeCandidate` says the *caller* is supposed to match it against the live enum, but the actual
  caller (`appendSpecFact`) never did. This did not affect the live symptom (the hardcoded
  `AGE_RANGE_LABEL['kids'] = 'Kids'` already happens to be a real enum member on every schema seen in
  fixtures/tests) and was left alone — it is a separate, lower-severity gap outside this task's named
  defect (no test in this repo currently proves `menuAttr.accepted` is consulted; changing that was
  out of scope and risked touching the other two `appendSpecFact` call sites unnecessarily).
- No specific file:line in the brief was factually wrong about the code's location/shape — the
  `appendSpecFact` definition (~11543), its age call site (~11598), the outer gate (~11565), and the
  Department override (~11584-11589) all matched what the brief pointed at, within a few lines of
  drift from the brief's own "every line number is a proposal" caveat.
