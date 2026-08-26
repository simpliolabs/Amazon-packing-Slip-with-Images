# PR #652 review fixes — report

Commit: `3647477` on `feat/per-design-audience` (pushed to `origin`, updates PR #652).

## Fix A — parallel `perDesignLean` map

`perDesignTruthCtx.set` (confirmed at `listingPipeline.ts:9340` before edits) sits below two early
returns (`:9307` no-apparel/no-children, `:9309-9314` blank doesn't resolve) — brief's line numbers
were correct. Did NOT hoist that map (it also carries `ctx`/`families`, which drive
`band.facts`/`band.pool` — garment vocabulary admissibility, the exact class reverted 3x live).
Added a parallel `const perDesignLean = new Map<string, AudienceLean>()`, written unconditionally
(`if (key) perDesignLean.set(key, groupAudience.lean)`) immediately after the `DESIGN_AUDIENCE_TRUTH`
log, above both early exits. `titleScopeFor`'s `band.lean` now reads
`(key ? perDesignLean.get(key) : undefined) ?? perDesign?.lean ?? lean` (was `perDesign?.lean ?? lean`).
Added the requested `DESIGN_BAND_LEAN` log (`{tag, design, lean}`) at the point `band` is fully
constructed in `titleScopeFor`.

## Fix B — per-group `preferredAudience`

Confirmed `buildTitleFor`'s positional signature: 5th = `preferredAudience`, 10th = `lean` — brief
was correct. Lifted the `~8863-8871` ternary into `preferredAudienceFor(l: AudienceLean): string`,
kept the text-sniffing fallback verbatim for `l === null`. At the per-design loop's `buildTitleFor`
call (now `:10270` after the earlier edits shifted line numbers — brief's `~10225` was the pre-edit
location and was correct at the time), added `gLean = groupInput.audienceLean ?? null` and
`groupPreferredAudience = gLean ? preferredAudienceFor(gLean) : preferredAudience`, passed as the
5th arg; `gLean` replaces the inline expression as the 10th arg (same value, now named). Verified
`groupInput.audienceLean` is the correct per-group source — it's set at `groupAudienceFor(group.key).lean`
in `resolveGroupDesignName`, which is the SAME resolver Fix A's `perDesignLean` and the existing
`DESIGN_AUDIENCE_TRUTH` log use, and falls back to the family value when unassigned, so an unassigned
sibling gets `gLean === lean` and `preferredAudienceFor(gLean) === preferredAudience` (verified,
no push-back needed here).

## Fix C — one token

Confirmed: `listingPipeline.ts`'s `bandTitle` closure builds THREE `lean`-bearing objects —
`titleBandCtx`'s return (`scope?.lean ?? lean`, already correct), `moneyCtx` (`bandScope?.lean ?? lean`,
already correct), and the object passed to `settleTitle` as `SettleTitleCtx`, which had a bare
`lean,` (the family value only). Traced `SettleTitleCtx.lean` into `titleBand.ts:2659`
(`enforceInclusiveAudience(moneyed, { apparel: ctx.apparel, lean: ctx.lean, ... })`) — confirmed this
is exactly the #649-class veto the brief described. Changed to `lean: bandScope?.lean ?? lean,`. Line
number in the brief (`:9656`) was correct pre-edit; shifted to `:9670`→now `:9676` after Fix A/B edits
landed above it.

## Fix D — test wire + floor

Confirmed the fixture never triggers `resolveFamilyBlank`'s legacy-regex match: `DEFAULT_BLANK_SPECS`
(the fail-open seed catalog reached once Supabase env is nulled) only matches "comfort colors" or
"gildan"/"64000", neither of which appears in the fixture's per-group hay
(`[attributePinFinal, groupRepTitle, input.productType, groupSkuHay]`). Confirmed via a temporary
debug run that, pre-fix, both groups logged `DESIGN_GARMENT_TRUTH` `'inherit-family-dominant'`.

Added `vi.mock('@/lib/fba/blankSpecs', ...)` overriding only `loadBlankSpecRows` (keeps
`resolveFamilyBlank`/`familyGarmentUnion` etc. real) to return one stub row matching `/\bshirt\b/i` —
`input.productType` ('SHIRT') is present in every group's hay unconditionally, so this fires for both
GATOR and SHARK regardless of title/vision text. Verified via debug run: both now log `'own-blank'`.
Added `captureGarmentTruthLog` and `captureBandLeanLog` helpers (same last-write-wins idiom as the
existing `captureAudienceTruthLog`).

Test 1 now additionally asserts: `garmentTruth.SHARK === 'own-blank'` and `garmentTruth.GATOR ===
'own-blank'`; both SKUs' titles `>= 65` chars (was `> 0`) alongside the existing `<= 200`; SHARK's
title does not match `/\bfor Men\b/i`; GATOR's does not match `/\bfor Women\b/i`. Verified via debug
run that both titles are non-trivial strings (~70+ chars) satisfying these — NOTE: the shared
`KITCHEN_SINK` OpenAI stub returns identical canned JSON to every `create()` call regardless of
prompt content, which causes the per-child titles to include a garbled literal fragment of that JSON
(a pre-existing harness property, confirmed unrelated to this PR — the sibling
`gatePerChildMultiDesign.integration.test.ts` avoids asserting on title text for the same reason). The
new assertions still hold and are real regression guards for future stub improvements; they are not
currently distinguishing on this particular canned text since neither garbled title happens to contain
"for Men"/"for Women".

Added two new tests: (1) a soft-lean run (`audienceLean: 'unisex'`, `audienceLeanByDesign: {SHARK:
'lean_female'}`) asserting `DESIGN_AUDIENCE_TRUTH` and `DESIGN_BAND_LEAN` both carry the soft value
correctly, since `enforceHardAudience` never fires for soft/unisex leans and so provides no downstream
repair for a Fix A/B regression; (2) a dedicated `DESIGN_BAND_LEAN` proof, in one run, that the
assigned design (SHARK, 'female') and unassigned sibling (GATOR, inherits family 'lean_male') each
report the correct value. Both verified via debug run before being written into the real test.

## Fix E — migration renumber

`git mv supabase/migrations/066_audience_lean_by_design.sql
supabase/migrations/070_audience_lean_by_design.sql` (067/068/069 confirmed absent — consumed by
hand-applied security migrations per the brief). Updated the file's own header comment (`066_...sql`
→ `070_...sql`; left the unrelated `migration 062` reference in the same file untouched). Updated
every other in-repo comment/string naming "migration 066" or the old filename: `src/app/api/fba/
audience-lean/route.ts` (4 occurrences, including the user-facing error string that names the file to
run), `src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`, `src/app/fba/listing/[asin]/
page.tsx` (3), `src/components/fba/PerDesignCard.tsx` (2), `src/lib/fba/audienceAssignment.ts` (2),
`src/lib/fba/listingPipeline.ts` (1), and the two references inside the audience pipeline test file
itself. Deliberately left `.superpowers/sdd/per-design-audience-report.md` untouched — it's a dated
log of commit `c4d5f5e...` ("migration 066"), an immutable git commit message; rewriting the report to
say 070 would make it inconsistent with the commit it documents. Verified with a repo-wide grep that
no other `066` reference to this migration remains.

## Constraints verified

- `git diff main...HEAD -- src/lib/fba/titleBand.ts` — empty (confirmed both before and after commit).
- No-op-until-assigned: every fallback chain in Fix A/B/C preserves its original `?? lean` direction
  for the unassigned case; test 2/3 (pre-existing) and the new `DESIGN_BAND_LEAN` test all confirm an
  unassigned sibling gets the exact family value at every seam (`DESIGN_AUDIENCE_TRUTH`,
  `DESIGN_BAND_LEAN`, `preferredAudienceFor`).
- `npx tsc --noEmit` — clean, 0 errors, both mid-way (after Fix A/B/C) and at the end.

## Baseline vs final test counts

- Baseline (`npx vitest run --no-cache`, current branch before any edits): 89 test files passed,
  **1706 passed | 4 expected fail (1710 total)**, exit 0.
- Final (same command, after all edits): 89 test files passed, **1708 passed | 4 expected fail (1712
  total)**, exit 0. Zero regressions; +2 is exactly the two new Fix D tests.

## Lines that were wrong in the brief

None of the cited line numbers were structurally wrong — every one matched the code at the time it
was read (mostly `~N` and off by single digits, or shifted downward by prior edits in this same
session, which the brief's own "PROPOSAL to verify" framing anticipated). No fix was declined.

## Fixes declined

None — all five (A-E) were verified against the actual code and applied as specified, with two
verification pushes explicitly checked per the brief's "push back" instruction (Fix A's parallel-map
rationale, Fix B's `groupInput.audienceLean` source) — both confirmed correct as proposed, no
deviation needed.
