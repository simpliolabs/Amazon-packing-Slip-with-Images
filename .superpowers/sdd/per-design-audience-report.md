# Per-design audience lean (migration 066) — report

## Status

Code complete, committed, pushed. PR open. CI ("Build" workflow) fired and was **pending** as of
this report — see CI status section below for the live check and how to re-verify.

## PR

https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/pull/652

Branch: `feat/per-design-audience` (worktree: `C:\Users\Admin\AppData\Local\Temp\fba-wt-audience`)

## Commit

`c4d5f5eb7fbb3729de87812029f55efcd26af9bd` — "feat(fba): per-design audience lean (migration 066)"
(one commit, 9 files changed, 613 insertions / 15 deletions)

## CI status

`gh pr checks 652` immediately after opening:
```
build	pending	0	https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/actions/runs/32999063233/job/98275774001
```
Unlike the brief's warning example (a prior PR on this repo where GitHub Actions never fired), this
run DID start — a real run ID/job exists. If it is still `pending`/`no checks reported` ~10+ minutes
after this report, say so plainly rather than waiting indefinitely (per the brief's instruction) — do
not re-run `gh pr checks 652` in a sleep loop without reporting a real result first.

Only `build.yml`'s "Build" step is blocking; its "Lint" step is `continue-on-error: true`
("non-blocking — informational only") — two PRE-EXISTING lint errors unrelated to this change
(`PerDesignCard.tsx:119` `react-hooks/set-state-in-effect` on the untouched design-name editor,
`listingPipeline.ts:11283` `prefer-const` inside the unrelated backend generator, both confirmed
present on `main` before this branch) do not gate the PR.

## The FULL migration SQL (paste-and-run in the Supabase SQL editor)

```sql
-- 066_audience_lean_by_design.sql — PER-DESIGN seller-declared audience lean for multi-design
-- families (PO ruling 2026-08-26, applying the garment per-design ruling — migration 062,
-- blank_assignments — to audience). Idempotent; safe to re-run. Apply BY HAND in the Supabase SQL
-- editor.
--
-- WHY. Family B0DSCDZC6K carries ONE family-wide audience_lean='lean_male' (migration 029), but its
-- designs are genuinely mixed: "Mother Hustler" / "Business B*tch" are female-coded; "Don't Quit" /
-- "Hustle Definiton" / "Billionare Coming Soon" / "Entrepreneur Definition" are neutral. No single
-- family value is correct — lean_male mis-genders 2 designs, lean_female would mis-gender 4, and
-- unisex unlocks the FEWEST keywords of all (asserting either gender is a lie on a genuinely
-- unisex design). The cross-gender veto (titleBand.ts, PR #651) rejects 43 of the family's
-- 69-keyword pool under lean_male even though most of those 43 are true of 2 of the family's own
-- 6 designs. "We know what the design is" (PO) — this column is where that statement lives.
--
-- SHAPE, mirroring the PROVEN per-design idiom already live TWICE on this exact table (034
-- design_name_overrides, 061's twin theme_fit_by_design on keyword_analysis): a JSONB map keyed by
-- the SAME designKey `detectDesignGroups` derives from the child SKUs (listingPipeline.ts) — the
-- key per_child_titles[] / design_name_overrides / theme_fit_by_design all already use.
--
-- NOT blank_assignments' shape (062, a scope+key TABLE keyed on a single child SKU): that table
-- exists because a SKU's OWN style code can individually be WRONG — a manufacturing/catalog fact
-- that can genuinely disagree SKU-to-SKU inside one design group. Audience is not that kind of
-- fact — every SKU inside one design group shares the same audience by construction, so it is a
-- per-DESIGN editorial judgment, the same shape as the design's own NAME. Reusing the design-name-
-- override idiom is "reuse, don't reinvent" pointed at the closer-fitting precedent: no new table,
-- no new loader, no new RLS/cache surface — colocated on the SAME row as the family-level
-- audience_lean (029) it falls back to, so "audience" stays ONE home on this table, not two.
--
-- PRECEDENCE (read by listingPipeline.ts's per-design resolution — audienceAssignment.ts's
-- resolveDesignAudienceLean, NOT a new predicate: it feeds the SAME buildPhraseTruthCtx / the SAME
-- cross-gender veto every other lean already drives):
--   1. audience_lean_by_design[designKey]   (this column)     -> source 'design-assignment'
--   2. audience_lean                        (migration 029)   -> source 'family-default'
-- An unassigned design inherits today's family value automatically — NULL/absent key = inherit, so
-- nothing changes for any family until the PO assigns a design an audience of its own.

ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS audience_lean_by_design jsonb;

COMMENT ON COLUMN listing_seo_scores.audience_lean_by_design IS
  'PER-DESIGN seller-declared audience lean for multi-design families: {"<designKey>": "male"|"female"|"lean_male"|"lean_female"|"unisex"}. Same designKey per_child_titles[]/design_name_overrides/theme_fit_by_design use. Precedence (audienceAssignment.ts): this map -> the family audience_lean (029) -> null. PO-editable via /api/fba/audience-lean, no deploy. NULL/absent key for a design = inherit the family value (safety property: nothing changes until the PO assigns).';

NOTIFY pgrst, 'reload schema';
```

No backfill statement is needed or included: absent/NULL for any design key already means "inherit
the family value" by construction, which is exactly today's behavior — the safety property holds
with zero data migration.

## Test numbers

- **Baseline (`main`, before any change)**: `npx vitest run --no-cache` → **87 test files, 1694
  passed + 4 expected fail (1698 total)**, exit 0.
- **Final (this branch)**: `npx vitest run --no-cache` → **89 test files, 1706 passed + 4 expected
  fail (1710 total)**, exit 0. **+12 new tests, zero regressions** (1698 → 1710 = +12; every
  pre-existing test still passes).
- `npx tsc --noEmit` → clean, exit 0.
- Real `pnpm install --frozen-lockfile` (52.4s) + `pnpm run build` (Turbopack, CI's exact
  placeholder Supabase/OpenAI env) → **`✓ Compiled successfully`**, `/api/fba/audience-lean` present
  in the route manifest. (An earlier attempt using a Windows junction to `main`'s `node_modules` to
  skip reinstall time hit a real Turbopack bug — "Symlink points out of the filesystem root" — so a
  fresh, real `pnpm install` was done in the worktree instead; this is the number that counts.)

## How precedence is tested

Two files, two levels:

1. **`src/lib/fba/audienceAssignment.test.ts`** (9 tests) — pure unit tests of
   `resolveDesignAudienceLean` in isolation (zero imports, no Supabase env guard needed): an
   assigned design uses its own value; an unassigned design in a family that has OTHER assignments
   falls back to the family value; the family value alone still works with `undefined`/`null`/`{}`
   for the map (the no-op-until-assigned property, three ways); no family value and no assignment
   resolves to `null` (never a guess); every seller-facing enum value round-trips; a malformed/
   garbage map entry falls through to the family value instead of asserting garbage; empty/
   whitespace/absent `designKey` falls through safely; `designKey` match is case-sensitive/exact
   (matches every other designKey consumer in this repo); the live B0DSCDZC6K shape (2 assigned +
   4 inherited designs in one family).

2. **`src/lib/fba/audienceAssignmentPipeline.integration.test.ts`** (3 tests) — drives the REAL
   `runListingPipeline()` with a stubbed OpenAI client (no network), same harness as the existing
   `gatePerChildMultiDesign.integration.test.ts` (Supabase env nulled in `beforeAll`/restored in
   `afterAll` — the CI trap: `build.yml` sets placeholder Supabase env, and every lazy-Proxy
   Supabase client in the pipeline — `blankSpecs.ts` etc. — would otherwise attempt a real ~4s
   network call per read and time the test out). A 2-design family (GATOR / SHARK):
   - **Assigned design (SHARK='female') vs unassigned sibling (GATOR) in the SAME run**: asserts
     the `DESIGN_AUDIENCE_TRUTH` log line (added as observability, mirroring the existing
     `DESIGN_GARMENT_TRUTH` "loud on both branches" doctrine) shows SHARK resolved via
     `'design-assignment'` with `lean='female'` while GATOR resolved via `'family-default'` with
     `lean='lean_male'` (the family value) — proving the assignment did NOT leak onto its sibling.
     Also asserts both designs' shipped titles are non-empty and ≤200 chars (length AND content, on
     the real title door's output, not the stub).
   - **No `audienceLeanByDesign` at all** (the exact shape every existing `PipelineInput` caller
     sends today): both designs resolve `'family-default'` — the no-op-until-assigned property
     proven through the full pipeline, not just the resolver.
   - **No family value either**: an unassigned design resolves to `lean: null`, never a guessed
     gender.

   This log line is the SAME `resolveDesignAudienceLean` call that separately feeds (a) the
   per-design `PhraseTruthCtx.audienceLean`, (b) `perDesignTruthCtx`'s raw `lean` (which reaches the
   cross-gender veto), and (c) `groupInput.audienceLean` (the writer stage) — one pure resolution,
   asserted once, consumed three times by construction, so proving it correct here is proving all
   three consumers correct.

## A correction to the brief (found by reading the code, not assumed)

The brief frames the fix as "wire the per-design audience into `buildGroupTruthCtx`'s
`PhraseTruthCtx.audienceLean` field" and states that alone makes "the cross-gender veto and
audience-lean-lie... judge each design against its own audience automatically." **That is only true
for `audience-lean-lie`.** Reading `titleBand.ts`'s `crossGenderLeanVeto`/`crossGenderTailVeto` (the
mechanism that actually rejects the 43 of 69 keywords) showed they read `ctx.lean` from
`MoneyTailCtx`/`TitleBandCtx` — a **field entirely separate from `PhraseTruthCtx.audienceLean`**,
populated in `listingPipeline.ts` from one family-wide closure variable (`lean`, `runListingPipeline`
line ~8758), used identically for every design group regardless of `buildGroupTruthCtx`'s per-design
ctx. Wiring only `PhraseTruthCtx.audienceLean` would have fixed `audience-lean-lie` and left the
cross-gender veto — the mechanism the brief's own 69/43/26 numbers describe — completely unfixed for
per-design titles.

The actual fix threads a per-exit `lean` through THREE more places, all inside `listingPipeline.ts`,
none inside `titleBand.ts` (the veto functions themselves are byte-for-byte untouched, per the
brief's constraint):
- `titleBandCtx()`'s `scope` param and `.lean` field (feeds `candidateSegments`'s pad-admission veto)
- `bandTitle()`'s `bandScope` param and `moneyCtx.lean` (feeds `enforceMoneyTail`'s money-tail veto)
- `titleScopeFor()`'s `band.lean`, sourced from `perDesignTruthCtx`'s (now-extended) raw `lean`,
  which is set from the SAME `resolveDesignAudienceLean` call `buildGroupTruthCtx` already makes

A fourth spot, `resolveGroupDesignName`'s `groupInput.audienceLean`, was also necessary: the WRITER
stage (`runTitleAgent`, called via `buildTitleFor`) recomputes its own `lean` directly from
`input.audienceLean` (its own `PipelineInput` param, by design — "Local, not param, because
runTitleAgent already receives input: PipelineInput", per its own comment) rather than from any
`lean` argument passed to it. Without overriding `groupInput.audienceLean` per design group, the
title WRITER (what the LLM council actually composes) would still have judged every design against
the family lean even after the terminal net's veto was fixed — a title could pass the terminal net
scoped to SHARK's own audience while never having been WRITTEN with SHARK's audience in mind.

This is exactly the kind of drift the brief warned about ("my briefs on this repo have been wrong
TEN times") — verified by reading `titleBand.ts` and tracing every call site of `crossGenderLeanVeto`
and `moneyCtx.lean`/`titleBandCtx().lean` before writing any code, not by trusting the brief's framing.

## A deviation from the brief's suggested shape (and why)

The brief asked me to study `blank_assignments` (062) and, by default, mirror its shape (a
`scope`+`key` table, `child` scope keyed on the SKU) — while explicitly inviting me to say so and do
something else if extending it, or a different reuse, is cleaner. I did not extend `blank_assignments`
and did not create a new scope+key table. Instead: `listing_seo_scores.audience_lean_by_design`, a
JSONB map keyed by `designKey` — mirroring `design_name_overrides` (034) and `theme_fit_by_design`
(061), both already live on this exact concern (per-design content, not per-SKU facts). Reasons:

1. **Audience is a per-DESIGN fact, not a per-SKU fact.** `blank_assignments`' child scope exists
   because a SKU's own style code can individually be WRONG (a catalog/manufacturing error — the
   B0DSG4T5BR specimen migration 062's own header documents). Every SKU inside one design group
   shares the same audience by construction; there is no analogous "this one SKU disagrees" case for
   audience to defend against.
2. **`blank_assignments.style_code` is `NOT NULL`.** Extending it with an audience column would
   either force every audience-only assignment to also carry a (possibly wrong) style code, or
   require loosening a live NOT NULL constraint plus a new CHECK — real surgery to an existing
   production table for a loosely-related concern.
3. **Consistency with the existing split.** At the FAMILY level, audience (`audience_lean`, 029) and
   blank identity (`blank_specs`/`blank_family_overrides`) already live in separate homes today. A
   per-design table that merged them would be a NEW inconsistency, not a fix for one.
4. **designKey vs SKU as the join key.** The Garment UI's per-child row (page.tsx ~4625) renders one
   row per SKU because a style code genuinely is a per-SKU fact. The natural UI surface for audience
   is the existing per-design card (`PerDesignCard.tsx`, one card per design group), which already
   carries `designKey` as its identity — keying by SKU would have forced an awkward "which SKU
   represents the design" choice with no such choice actually needed.

## Precedence and scope boundary (documented, not hidden)

- `buildGroupTruthCtx`'s "inherit-family-dominant" fallback (when a design group's own BLANK does
  not resolve) still returns the pure family ctx (`titleTruthCtx`) with no per-design audience
  applied, even if that design has an assignment. This mirrors the pre-existing garment-truth
  fail-open exactly — the whole per-design ctx concept in this file is anchored on the group's blank
  resolving. A design that has BOTH no resolvable blank AND a PO audience assignment will not get
  that assignment applied to its title until its blank also resolves. This is a real, narrow scope
  boundary, not a bug I fixed silently — flagging it rather than expanding the fix's surface, per the
  "surgical" instruction.
- Scoped to **TITLE only**, matching `buildGroupTruthCtx`/`perDesignTruthCtx`'s own existing scope
  (its ctx is built with `field: 'title'` hardcoded; bullets/description/backend still read the
  FAMILY-level `bulletsTruthCtx`/`descTruthCtx`/`backendTruthCtx`). Extending per-design audience to
  those fields would be a materially larger change to a 9,000+ line file under an explicit
  surgical-only instruction, and is not what the brief's own cross-gender-veto/69-keyword framing is
  about (that mechanism is title-only in this codebase today).
- The single-design and couple/unified-set (broadcast) title paths are untouched by design: a
  single-design family has no "design" narrower than the family itself, and a couple/matching title
  is genuinely one shared concept answerable to every child — both already used the family `lean`
  before this change and still do.

## Concerns

- Per the scope boundary above, a design with a PO-set audience assignment but an unresolved blank
  silently keeps inheriting the family audience for its title until the blank also resolves. Worth a
  follow-up if the PO wants audience decoupled from blank resolution entirely (would need to change
  `buildGroupTruthCtx`'s early-return, which currently conflates "no per-design ctx at all" with "no
  per-design blank").
- I could not fully verify CI (see CI status above) before this report — a real Actions run started
  (unlike a prior PR on this repo, cited in an earlier report at
  `.superpowers/sdd/parent-judge-gender-veto-report.md`, where it never fired), but was still
  `pending` as of writing.
- No route-level tests exist anywhere in this repo (confirmed via search) for any `/api/fba/*` route,
  so `/api/fba/audience-lean`'s new GET handler and `designKey` POST branch are verified by
  `tsc --noEmit` + the real `next build` compiling them, plus manual code review against the
  `design-name-override` route's proven pattern — not by an automated route test, consistent with
  this repo's existing convention.
