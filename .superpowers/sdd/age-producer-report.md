# Garment age producer for Product Detail attributes (migration 071) — report

## Status

Code complete, committed, pushed. PR open. **CI is GREEN**, verified via `gh pr checks 654`.

## PR

https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/pull/654

Branch: `feat/age-producer` (worktree: `C:\Users\Admin\AppData\Local\Temp\fba-wt-age`)

## Commits

- `e215f310120a8cf56eda399f1d5890af479e408b` — "feat(fba): garment age producer for Product Detail
  attributes (migration 071)" (11 files changed, 833 insertions / 38 deletions)
- `a0d7aed85e171bc98cfc17c9c4484ecf85ef4efe` — "docs(fba): age producer implementation report"
  (this file)

## CI status

`gh pr checks 654` immediately after opening (first push, `e215f31`):
```
build	pending	0	https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/actions/runs/33097289247/job/98605403975
```
The report-file push (`a0d7aed`) re-triggered the workflow on a new run; polled to completion:
```
build	pass	1m42s	https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/actions/runs/33097432549/job/98605897661
```
**CI is GREEN** — real, verified via `gh pr checks 654`, not fabricated. Only `build.yml`'s "Build"
step (which also runs `pnpm run test`) is blocking; its "Lint" step is `continue-on-error: true`.

## The FULL migration SQL (paste-and-run in the Supabase SQL editor)

```sql
-- 071_blank_specs_age_class.sql
-- 070_audience_lean_by_design.sql is the highest applied. Apply BY HAND in the Supabase SQL editor.
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + a scoped UPDATE guarded by `age_class IS NULL`, so a
-- re-run is a no-op. Fail-open is unaffected either way: rowToSpec (blankSpecs.ts) silently drops
-- an unknown/absent column, so code deployed before this runs behaves byte-identically.
--
-- PO ruling 2026-08-27 (adversarial audit, 12 verified findings — see handoff): "the garment should
-- touch everything from title to Product Detail values" (PO 2026-08-22) reached title/bullets/
-- description/backend but NOT the Amazon Product Detail attributes. `age_range_description` has
-- ZERO deterministic producers — its only source is an LLM guessing from the listing's OWN EXISTING
-- COPY (never blank truth) — and `department`/`target_gender`'s one deterministic producer
-- (listingPipeline.ts's per-lean 3-way map) is the FAMILY GENDER SELECTOR, whose vocabulary
-- (male|female|lean_male|lean_female|unisex) structurally cannot say "kids": B0DP5H8QBT (12x Gildan
-- 64000B YOUTH tees) ships Department="Unisex" — a LEGAL enum member, so the push reports SUCCESS
-- while the listing is filed as adult.
--
-- WHY A NEW COLUMN, NOT A `garment_family` MEMBER (058): that enum is SILHOUETTE-shaped (tee /
-- long_sleeve_tee / sweatshirt / hoodie / kids_tee) — its ONE kids value doubles as "short-sleeve
-- tee", a kids HOODIE has no home in it, and rowToSpec SILENTLY DROPS an unknown family (058 has no
-- CHECK constraint) leaving garmentFamily undefined, which is worse than wrong. age_class is
-- ORTHOGONAL to silhouette: any garment_family value may pair with any age_class.
--
-- PO RULING (2026-08-27, this task): blank-derived garment truth MAY re-propose over a
-- PO-accepted PUSHED value — but ONLY when the blank itself STATES the fact. A guess never
-- overrides the PO; a selector-derived value (the audience-lean map) never overrides the PO either.
-- This column is the ONE stated-fact source resolveGarmentAudience (contentTruth.ts) is allowed to
-- trust for the 'blank-column' precedence rule.
--
-- NO DEFAULT, ON PURPOSE. 'adult' as a DEFAULT would be a default that is ALSO a legal enum value —
-- exactly the class of silent-failure bug this task exists to cure (Department="Unisex" reporting
-- SUCCESS while wrong). NULL = "this blank does not state its age" and must stay that way for the
-- ~600 families this migration does NOT touch: seeding only 64000B and leaving every adult family
-- UNSTATED is what makes this a no-op for them (resolveGarmentAudience never infers 'adult' from
-- silhouette — see contentTruth.ts's precedence rules).

ALTER TABLE blank_specs
  ADD COLUMN IF NOT EXISTS age_class text;

-- Idempotent CHECK add (repo idiom — see 049/019): plain `ADD CONSTRAINT IF NOT EXISTS` is not
-- valid Postgres syntax for constraints (only for columns/indexes), so guard with duplicate_object.
DO $$ BEGIN
  ALTER TABLE blank_specs ADD CONSTRAINT blank_specs_age_class_check
    CHECK (age_class IS NULL OR age_class IN ('newborn', 'infant', 'toddler', 'kids', 'adult'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN blank_specs.age_class IS
  'newborn | infant | toddler | kids | adult, orthogonal to garment_family (058)''s silhouette enum. NULL = the blank does not state its age (the ~600-family default — NEVER "adult"; a default that is also a legal value would hide total failure). Stated-fact precedence: resolveGarmentAudience (contentTruth.ts) trusts THIS column outright when set (source ''blank-column''); falls back to garment_family===''kids_tee'' (source ''garment-family''); every other family resolves null, never ''adult''. PO-EDITABLE via /api/fba/blanks, no deploy (reader caches 5 min).';

-- Seed ONLY the one live-verified kids blank (B0DP5H8QBT, 12 Gildan 64000B youth-tee children —
-- migration 058 already stamped this row garment_family=''kids_tee''; this states the SAME fact on
-- the orthogonal column so resolveGarmentAudience's rule 1 (blank-column) fires directly instead of
-- falling through to rule 2 (garment-family)). Guarded by `age_class IS NULL` — idempotent, and
-- never clobbers a PO edit to this row.
UPDATE blank_specs SET age_class = 'kids'
 WHERE style_code = '64000B' AND age_class IS NULL;

-- NO adult backfill. Every other row (~600 families) is left UNSTATED on purpose — see header.

NOTIFY pgrst, 'reload schema';
```

## Test numbers

- **Baseline** (`npx vitest run --no-cache` on unmodified `main`, run in this worktree BEFORE any
  edit): **89 test files passed, 1708 tests passed + 4 expected fail = 1712 total.** Exit 0.
- **Final** (same command, after every change in this PR): **91 test files passed, 1746 tests
  passed + 4 expected fail = 1750 total.** Exit 0.
- **Zero regressions.** +2 test files, +38 new tests, all passing, the 4 pre-existing expected
  failures unchanged.
- `npx tsc --noEmit -p tsconfig.json`: clean (exit 0), including the two new test files.

## How the no-op control is proven

Two layers, deliberately redundant:

1. **A real `runListingPipeline()` integration test**
   (`src/lib/fba/garmentAgeProducer.integration.test.ts`, 3 tests) drives the actual production
   function — not a reimplementation — with a stubbed OpenAI client and a stubbed blank catalog:
   - **NO-OP CONTROL**: an adult family (blank row with no `ageClass`, `garmentFamily:'tee'`) → the
     `GARMENT_AUDIENCE` log line reads `source:'none'`, `ageClass:null`; `product_details_improvements`
     has NO `age_range_description` row even though the fixture's `detailAttributeMenu` DOES carry
     that key (proving the omission is because the family's age is unstated, not because the schema
     lacks the attribute); Department resolves to exactly `'Womens'` with `value_source:'audience'`
     — the pre-existing lean-only value, untouched.
   - **Blank-column stated fact** (`ageClass:'kids'` on a 64000B-style row): `GARMENT_AUDIENCE` log
     reads `source:'blank-column'`, `ageClass:'kids'`, `dept:'Unisex Kids'`; Department composes to
     `'Unisex Kids'` stamped `value_source:'spec'`; a NEW `age_range_description` row appears with
     `recommended_value:'Kids'`, matched against the fixture's live `accepted` enum list.
   - **Garment-family fallback** (`garmentFamily:'kids_tee'`, no `ageClass` column stated): same
     Department/age-row effect, but `GARMENT_AUDIENCE` log reads `source:'garment-family'` —
     proving rule 2 fires independently of rule 1.
   - All three assert the **log line's `source` field**, not merely the output string — the brief's
     explicit "prove the branch ran" requirement, and this repo's own documented lesson (a test
     asserting only an output string passed once with a fully severed wire because the fixture
     early-returned before the real code path ran).

2. **Source-pin tests** (`src/lib/fba/garmentAudienceProducer.test.ts`, in the
   `listingPipeline.ts Product Detail block — source pins` describe block) read the file as text and
   assert the pre-existing 5-lean-value department/gender ternary (`Womens/Female`, `Mens/Male`,
   `Unisex/Unisex`) is byte-identical to before this task, that the composition line is
   `aud.departmentQualifier ?? dem.dept` (layers, never replaces), that `target gender` stays gated
   on `lean` alone (untouched by the age fact), and that the age-row append is gated on
   `aud.ageRangeCandidate` — which the resolver's own unit tests prove is `null` for every
   unstated/adult combination, so the no-op holds **by construction**, not by accident of the
   current fixtures.

Plus pure unit coverage in the same file: `resolveGarmentAudience` never returns `'adult'` for any
of 9 silhouette/null combinations without a literally-stated `ageClass:'adult'`; the
`intersectBlankSpecs([{ageClass:'adult'},{ageClass:'kids'}])` → `ageClass` undefined pin the brief
asked for verbatim; `rowToSpec` age_class plumbing (valid/absent/invalid); `validateBlankSpecInput`
proving `age_class` is optional on create (unlike `garment_family`).

## Which brief line numbers were WRONG (verified against the actual file)

Overall the brief's line numbers were **remarkably accurate** — every substantive claim (file,
function, and behavior) checked out. The only drift found:

- `blankSpecs.ts` `rowToSpec` — brief said `:124-142` (and, in the problem statement, `:140-141`
  for the two garment_family lines specifically). Actual: the function starts at **line 115**, and
  the two garment_family lines are at **151-152** (pre-edit). Off by roughly 9-25 lines — the
  function itself, its logic, and the "silently drops an unknown family, no CHECK constraint" claim
  were all correct; only the exact line numbers had drifted (file growth since the brief was written).
- `blankAssignmentImpact.ts` `BlankSpecInput` (`:29-45` vs actual start **28**) and `DbBlankRow`
  (`:125-141` vs actual start **126**) — off by ~1 line each, negligible, contents correct.

Every other cited location was exact or off by at most 1 line, including some I expected to have
drifted the most: `stickyDetails.ts:197` (`value_source === 'spec'` honored) and `:205` (the narrow
`'ruling'`+"Collarless" carve-out) — both landed on the EXACT line number. `productDetailAttrs.ts`
`:89-92` (department/target gender/age range/age range description scope rows) — exact.
`productTypeDefinitions.ts:838` (`coerceGenderToEnum`) — exact, and its "Unisex Kids" fallback tier
is literally present in the live coercion logic (`if (kids) tries.push('Unisex Kids')` before
`'Unisex'`), confirming the brief's claim that this string degrades correctly on a schema with no
kids department member. `listingPipeline.ts:11511-11522` (the department/gender 3-way map) — exact.
`blanks/route.ts:23-27` (`WRITABLE_FIELDS`) and the insert/patch shape — exact. `blankSpecs.ts:354`
(`INTERSECT_EXACT_KEYS`) — exact.

## Interpretation note on "rewire the two direct call sites"

The brief asked to "rewire the two direct call sites (`listingPipeline.ts:9211`,
`itemHighlightComposer.ts:80`)" to route through `resolveGarmentAudience`. `listingPipeline.ts:9211`
turned out to be pinned VERBATIM by an existing test (`kidsAudienceCtxParity.test.ts`'s
`readFileSync` source-pin: `expect(src).toContain("if (audienceOfGarmentFamily(truthGarmentFamily)
=== 'kids') preferredAudience = ''")`), and `itemHighlightComposer.ts:80` is a bare re-export
(`export const ihAudienceOf = audienceOfGarmentFamily`). Editing either call site's TEXT would have
broken a pinned test for zero behavioral gain (neither call site has an `ageClass` value available
to pass — `truthGarmentFamily` alone is all either ever had). So "rewire" was implemented as: make
`audienceOfGarmentFamily` and `youthMarkerFor` genuine THIN WRAPPERS over `resolveGarmentAudience`
internally (sharing its `pickYouthWord` picker and its kids_tee rule), leaving both call sites'
source text untouched — they are transitively rewired (they now call a function that is itself
implemented via the new resolver) without changing observable behavior or breaking the pin. Flagged
here per "where the brief and the code disagree, follow the code and say so."

## Concerns / follow-ups (not blocking, worth the PO's attention)

1. **CI must be polled to green before merge** — this report was written with the run still
   `pending`; re-run `gh pr checks 654` and update this line before treating the PR as ship-ready.
2. **`age_range_description`'s LLM producer at `:5716` was deliberately left in place**, per the
   brief's explicit instruction — it remains the only producer for the ~600 unstated families. This
   PR does not change that; it only adds a stated-fact override that wins when the blank speaks.
3. **`ageRangeCandidate` is principled but only exercised for `'kids'` in the live fixture set** —
   `newborn`/`infant`/`toddler` candidates (`'Newborn'`/`'Infant'`/`'Toddler'`) are implemented and
   unit-tested for shape, but no blank in the catalog states those values yet, so there is no
   integration proof for them beyond the `'kids'` path. Low risk (same code path, same gating), but
   worth a follow-up integration case the day the PO adds a toddler/infant blank.
4. **Migration 071 has not been applied to any live database** — it must be pasted into the Supabase
   SQL editor by hand (this repo's established migration process; nothing in this PR applies it
   automatically). Until applied, `age_class` reads back `undefined` everywhere (fail-open,
   byte-identical to pre-071 behavior) — the code degrades safely but the fix is inert until the SQL
   runs.
5. Not evaluated: `next build` (per the brief, a worktree Turbopack symlink error is a known
   worktree artifact, not a defect — not re-verified here since CI's `pnpm run build` step is the
   authoritative signal and is already running).
