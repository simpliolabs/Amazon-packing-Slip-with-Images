# Spec-values-must-be-enum-valid — report

## Status
Fixed, tested, pushed. PR open (see below). No merge/deploy/Amazon push performed.

## Live defect (B0DP5H8QBT, PR #660 @ 5a6e698)
`mergeDetailRowsByPrecedence` (`src/lib/fba/productDetailAttrs.ts`) picked the winning
`product_details_improvements` row for a field by **provenance rank alone**
(`spec > ruling > audience > unstamped`). It never asked whether the winning value is a
member of Amazon's live accepted enum for that attribute. `age_range_description`'s
deterministic producer (`contentTruth.ts`'s hardcoded `AGE_RANGE_LABEL.kids = 'Kids'`) always
outranks the mega-audit LLM's unstamped guess — even when the LLM's guess is an enum-accepted
member and the hardcoded label is not. Live: B0DP5H8QBT shipped `Age Range Description = 'Kids'`
(`value_source: 'spec'`), discarding the LLM's `'Big Kid'`, which for a real SHIRT product type's
accepted list (`Adult | Big Kid | Little Kid | Toddler | Infant | Newborn`) trades a value Amazon
accepts for one it very likely rejects.

Push-time (`pushExecutor.ts:888-892`) already re-validates and blocks a push when the value is
enum-invalid, so nothing reached Amazon. But the *recommendation* itself was wrong: a valid
alternative existed and was thrown away before validity was ever checked.

## The defect class (verbatim, confirmed by reading the code, not assumed)
**A deterministic, `spec`/`ruling`/`audience`-stamped value can win the field-precedence merge
purely on provenance, with no check that it is a member of the live accepted enum — so a
hardcoded label can outrank a competing value the LLM path was already contractually held to
validate ("recommended_value MUST be one of them, verbatim", `listingPipeline.ts:5686`ish). This
is not age-specific: every `appendSpecFact`/`overrideField` call site (department, target gender,
fit, sleeve, apparel_fabric_stretch, fit_to_size_sentiment, collar_style, age) shares the same
exposure — nothing enforced enum membership at the point precedence gets decided.**

## Deterministic call sites audited (`listingPipeline.ts`)
| Field | Site | Shape | Could create a genuine multi-row conflict? |
|---|---|---|---|
| Department | `pdiFinal.map` override, :11599 | unconditional overwrite | No — never duplicates, single row always |
| Target Gender | `pdiFinal.map` override, :11600 | unconditional overwrite | No — same as Department |
| Age Range Description | `appendSpecFact`, :11610 | append-if-not-spec-stamped | **Yes** — the live defect |
| Fit / Sleeve | `overrideField`, :11631-11632 | unconditional overwrite | No |
| Apparel Fabric Stretch / Fit to Size Sentiment | `overrideField` **and** paired `appendSpecFact`, :11639-11642 | overwrite, then append-if-absent (guard matches the same regex, so no duplicate in practice) | Structurally possible if the regexes ever diverge — now covered generically, not specially |
| Fabric Stretchability (binary) | `overrideField`, :11649 | unconditional overwrite | No |
| collar_style | `pdiFinal.map`, :11684-11691 | unconditional overwrite, **already enum-aware** (its own hand-rolled membership check at :11677-11681) | No — and already safe by a different, pre-existing mechanism |
| Model Name | `pdiFinal.flatMap`, :11700-11709 | strip-brand rewrite | No (free-text, not an enum) |

Only `age_range_description` creates a genuine append-alongside-a-guess duplicate today, but the
fix is at the merge choke point (not a special case for age), so a future `appendSpecFact`-shaped
producer for any other field is covered without new code.

## The cure — one change at the one choke point
`mergeDetailRowsByPrecedence` now takes two optional parameters: `menu` (the same
`detailAttributeMenu` — `{key, title, accepted?}[]` — already threaded through the pipeline from
the live Product Type Definitions fetch) and `coerce` (an injected `EnumCoercer`). When a field has
more than one competing row **and** the caller supplies both:

1. Every candidate row is coerced against the field's live accepted list.
2. **Validity now outranks provenance.** The winner is chosen from the valid pool first (provenance
   rank only breaks ties *within* that pool — a valid `spec` row still beats a valid `audience`/LLM
   row). An invalid row never outranks a valid one, regardless of `value_source`.
3. The winning row is coerced to the exact accepted member and stamped `is_enum` / `enum_valid` /
   `enum_accepted` / `normalized_from` — the same fields the LLM path already gets stamped with
   downstream (`ai-recommendations/route.ts:1355-1362`), so the merge's output is self-describing.
4. If **no** candidate coerces (no valid alternative exists), the provenance winner still ships
   (nothing better to prefer) but is stamped `enum_valid:false` and a `console.warn` fires with a
   greppable tag (`ENUM_PRECEDENCE_NO_VALID_CANDIDATE`) — never a silent, unflagged pass. Every row
   an invalid candidate lost to a valid one also logs (`ENUM_PRECEDENCE_REJECTED`).
5. **No-menu / no-accepted-list is a hard no-op**: omitting `menu`/`coerce`, a field absent from the
   menu, or a menu entry with no `accepted` list reproduces the exact pre-fix provenance-only rule,
   byte for byte. This function never invents an enum check where Amazon states none.

`coerceToEnum`/`coerceGenderToEnum` (`productTypeDefinitions.ts`, verified at :782 and :838 — the
brief's ~443-460/~838-869 line estimates were for `coerceDetailValue`'s call site and the
`coerceGenderToEnum` definition respectively, both close but not exact) are **reused, not
reimplemented** — but via dependency injection rather than a direct import. `productDetailAttrs.ts`
is imported by a client component (`fba/listing/[asin]/page.tsx`, for its pushable-check helpers),
and `productTypeDefinitions.ts` pulls in `@/lib/supabase/server`; a local `next build` in this
worktree fails on an unrelated Turbopack symlink error, so tree-shaking safety for a new static
import could not be verified here. `listingPipeline.ts` (server-only, confirmed by grep — no `.tsx`
imports it) builds the real coercer and passes it in at the single call site
(`pdiFinal = mergeDetailRowsByPrecedence(pdiFinal, input.detailAttributeMenu, enumCoerce)`),
mirroring the file's existing `SupabaseClient`-injection convention.

## What the age row resolves to after the fix
- Given a **realistic** live accepted list (`Adult | Big Kid | Little Kid | Toddler | Infant |
  Newborn` — no `'Kids'` plural member): ships `'Big Kid'`, `enum_valid: true`, `value_source`
  reverts to the LLM's (unstamped) — proven end-to-end through the real `runListingPipeline()` in
  `garmentAgeProducer.integration.test.ts`'s new case, not just the isolated merge unit.
- Given the pre-existing test fixture's accepted list (which happens to already include `'Kids'` —
  see push-back note below): still ships `'Kids'`, now additionally stamped `enum_valid: true` —
  unchanged output, byte-identical to before this fix, because `'Kids'` genuinely is valid in that
  fixture's world and `'Big Kid'` is not.
- No menu / no accepted list for the field: unchanged, `'Kids'` ships exactly as it did on `main`
  (the pre-fix, provenance-only behavior) — this is the explicit no-op guarantee, not an oversight.

## Push-back (as instructed)
`'Kids'` (plural) is **not** universally an accepted member — Amazon's real SHIRT
`age_range_description` enum is `Adult | Big Kid | Little Kid | Toddler | Infant | Newborn` per the
brief's live investigation. However, the *pre-existing* integration test fixture
(`garmentAgeProducer.integration.test.ts`, `AGE_RANGE_MENU_ATTR`, written for PR #660) declares
`accepted: ['Newborn','Infant','Toddler','Kids','Adult']` — i.e. that fixture's synthetic menu
already includes `'Kids'` and omits `'Big Kid'` entirely, so none of its pre-existing cases ever
exercised the real defect (spec invalid, LLM valid). Left that file's existing fixture/tests
untouched (out of scope, not wrong for what they test — precedence, not validity) and added one new
case with a realistic accepted list instead of rewriting the shared fixture, to avoid an unrelated
behavior change to `main`'s existing coverage.

## What makes a future instance structurally impossible
Any future deterministic producer (a new `appendSpecFact`/override call for any field) needs no
defensive "is this value enum-valid" logic of its own: as long as `mergeDetailRowsByPrecedence`
keeps receiving `input.detailAttributeMenu` and the injected coercer at its one call site, validity
is enforced structurally at the merge for every field the live menu carries an accepted list for —
the same "stamp provenance and push the row, precedence is enforced elsewhere" guarantee PR #660
established, now extended to "and validity is enforced elsewhere too." Verified generically:
`productDetailAttrs.test.ts`'s new `describe` block drives the rule over a field list that includes
fields no current producer emits (`'Battery Type'`, `'Some Brand New Attribute'`), proving a
hypothetical future field is covered without a hand-written case.

## Verification
- Baseline (`main` @ `5a6e698`, this worktree before any edit): `npx vitest run --no-cache` →
  **98 test files passed, 1853 tests passed | 4 expected fail (1857 total)**.
- Final: **98 test files passed, 1877 tests passed | 4 expected fail (1881 total)** — 24 new tests
  (23 in `productDetailAttrs.test.ts`, 1 in `garmentAgeProducer.integration.test.ts`), zero
  regressions, the same 4 expected failures carried over unchanged.
- `npx tsc --noEmit`: clean, both before writing tests and after the final edit.
- No SP-API PATCH/PUT/POST touched anywhere in this change — verified by diffstat: only
  `productDetailAttrs.ts`, `listingPipeline.ts`, and two test files changed.

## Files changed
- `src/lib/fba/productDetailAttrs.ts` — the fix (choke point).
- `src/lib/fba/listingPipeline.ts` — wiring (imports `coerceToEnum`/`coerceGenderToEnum`, builds
  the injected coercer, passes `input.detailAttributeMenu` + the coercer into the one merge call).
- `src/lib/fba/productDetailAttrs.test.ts` — new unit coverage (the class test + live case).
- `src/lib/fba/garmentAgeProducer.integration.test.ts` — one new end-to-end case with a realistic
  accepted enum.

Not touched: title subsystem, `blank_specs`, migrations 071/072, the colour resolver, Target
Gender's behavior (it never enters a multi-row merge conflict — always a single unconditional
overwrite — so the new validity logic is structurally never invoked for it).
