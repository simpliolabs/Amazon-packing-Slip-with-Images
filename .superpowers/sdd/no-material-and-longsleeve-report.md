# Fix 1 (material banned from title) + Fix 2 (long-sleeve alias bleed) — report

Branch: `fix/no-material-and-longsleeve-alias-bleed`, off `main` @ `e6a70f7` (includes PR #662/#663).
Worktree: `C:\Users\Admin\AppData\Local\Temp\fba-wt-nomat`.

## Status: DONE, both fixes shipped, full suite green, tsc clean.

## Brief assumptions that were WRONG (verified against the code/history, followed the code)

1. **The commit that shipped fabric vocabulary into the title pad is NOT "PR #662, merged
   `74ef17f`".** `74ef17f` (title "spec-ground fit/silhouette claims in the title (#662)") is
   about the **FIT** ban (oversized/boxy/fitted/cropped/baggy/tapered/loose) — a separate,
   still-valid 2026-09-02 fix, untouched here. The actual material-vocab commit is **PR #658,
   `109d8f1`, "Title: fabric-vocab supply + corpus-derived ship floor"** (2026-09-01) — confirmed
   by its diff (`listingPipeline.ts` +11/-0 at the `titleBandCtx` spec builder, `titleBand.ts`
   +142/-33 including `titleSafeMaterial`, `truthBandHarness.ts` +86 including
   `runLiveFailureReproWithMaterial`). All my Fix 1 edits target PR #658's actual sites.
2. **The exact live defect string** (`"...Business B*tch Tee Shirt | Long Sleeve Cotton Polyester
   Tshirt"`) does not appear verbatim anywhere in the repo's fixtures/tests/history — it is a
   fresh production observation, not reproducible byte-for-byte from existing test data. Traced the
   **mechanism** instead, and it explains the exact co-occurrence: `ctx.spec.material`
   (listingPipeline.ts's `titleBandCtx` closure) is the **family-DOMINANT** blank's material,
   reused unscoped for every per-child/per-design title exit — so ANY child in a mixed family can
   ship the dominant blank's material regardless of its OWN blank. Meanwhile `Tshirt`-class aliases
   bleed in via the PER-DESIGN garment union (`garmentFactSegments(perDesign.families)`,
   listingPipeline.ts ~9923). Both bugs are independent; they simply co-occurred on the Business
   B*tch child in production. Fix 1 removes the material bleed structurally regardless of scope;
   Fix 2 removes the alias bleed at its source.
3. **Line numbers in the brief were close but not exact** (as expected/pre-authorized): material
   site was `listingPipeline.ts:9471` (not ~9462-9463) and `titleBand.ts`'s `push(ctx.spec?.material)`
   was at line ~433 (not ~397-399/353-360, which was `titleSafeMaterial`'s own definition, further
   up). `garmentNoun.ts`'s `LONG_SLEEVE_TEE_BASE` was at ~262-269 pre-edit, matching the brief's
   ~260-268 closely.
4. **Theme/occasion vocabulary already existed and was already wired** — this was NOT a gap to
   fill. `listingPipeline.ts`'s `poolSegmentsFor`/`bandPoolSegments` (~9420-9450) and
   `titleBand.ts`'s `candidateSegments`' `poolSegments` loop (~478, right after the fact-segment
   loop) were built 2026-08-22 ("the cure for the #630/#631 revert") specifically to offer
   truth-gated, listing-researched keyword-pool phrases — including theme/occasion phrases like
   "motivational", "gift" when the pool has them — as title-pad fill. Removing material from the
   fact bank does not remove any wiring; it just lets the search reach this pre-existing bank
   sooner. **No new mechanism was built for this.**

## Fix 1 — material banned from title

**Sites changed** (all verified by reading, not by the brief's guess):
- `src/lib/fba/titleBand.ts`: `TitleBandCtx.spec` type — removed the `material` field (structural,
  not just unpopulated: `// @ts-expect-error` pins it in `titleMaterialFloorGate.test.ts`).
  `candidateSegments` — removed `push(ctx.spec?.material)`.
  `titleSafeMaterial()` — deleted (dead: its only caller was the removed wiring).
  **Belt-and-suspenders**: `TITLE_WASTE_SOURCE` (the SAME terminal net that already bans
  "unisex"/"classic fit", `stripTitleWasteVocabulary`) extended with fabric words (cotton,
  polyester, ring-spun, combed, airlume, spandex, rayon, linen, nylon, elastane, viscose, denim,
  fleece) — this catches a material word that reaches an assembled title by ANY other route (a raw
  council draft, or a stale `priorTitle` written before this ruling — the live kids specimen was
  exactly this case). This reuses the door's own existing seam per its own doctrine ("reuse the
  same seam, not a parallel one") rather than adding a second net.
- `src/lib/fba/listingPipeline.ts`: `titleBandCtx()`'s `spec:` construction — dropped
  `material: titleSafeMaterial(blankSpec.material)`. Removed the now-dead `titleSafeMaterial`
  import. `blankFacts` (bullets/description/Product-Detail prose) is UNTOUCHED — material still
  reaches those surfaces exactly as before.
- `src/lib/fba/truthBandHarness.ts`: deleted `runLiveFailureReproWithMaterial()` (the Option B
  demo function) + its now-dead `titleSafeMaterial` import.

**Additive source for the freed character budget**: the **pre-existing** truth-gated pool bank
(see "wrong assumption #4" above) — theme/occasion vocabulary from the listing's own researched
keyword pool. Nothing new was wired.

**Tests**:
- `src/lib/fba/titleMaterialFloorGate.test.ts` — rewritten. Kept Option C (corpus-derived floor,
  unchanged) coverage. Replaced Option B's "material lifts the title" tests with: a structural
  `@ts-expect-error` pin, a same-shape scenario proving pool-sourced theme/occasion words (not
  material) reach band, and a case proving an empty pool ships honestly shorter rather than
  fabricating a value.
- `src/lib/fba/titleMaterialAndSleeveE2E.integration.test.ts` (new) — drives the REAL
  `runListingPipeline()`.
- Fixed 3 pre-existing tests whose PINNED values depended on material being either absent from a
  shared banned-word list or present in title-pad output: `titleWasteVocabulary.test.ts` (a
  carve-out fixture's incidental "Cotton" filler collided with the new ban — swapped for a neutral
  word), `goldCorpusSelfTest.test.ts` and `titleShapeJudge.test.ts` (both score the PO's own
  gold corpus via `titleQualityJudge`, which deliberately shares `isTitleWasteVocabulary` with the
  door "so the producer and the door can never drift apart" — one PRE-EXISTING PO gold,
  `"...Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men"`, predates the 2026-09-03
  ruling and states a fabric word, so it now legitimately docks -10 under `TITLE_SHAPE_JUDGE=on`.
  Updated the pinned scores/regression lists with a documented reason — did NOT touch
  `poGoldCorpus.ts`'s gold text itself, which is out of this task's scope).

## Fix 2 — long-sleeve alias bleed

**Root cause, confirmed exactly as the brief traced it**: `garmentNoun.ts`'s
`LONG_SLEEVE_TEE_BASE.aliases` spread `...SHIRT_BASE.aliases` wholesale.
`SHIRT_BASE.aliases = ['shirt', 't-shirt', 'tshirt', 'tee', 'graphic tee']`. The bleed site is
`listingPipeline.ts:9398`'s `garmentFactSegments()`, which calls
`resolveGarment({blankFamily: f}).aliases` for every garment family in a design's resolved union
and title-cases EVERY alias into a title-pad candidate segment — feeding BOTH the broadcast pad
(`bandFactSegments`) and, critically, each design's OWN per-design facts via `buildGroupTruthCtx`
→ `familyGarmentUnion` → `perDesignTruthCtx.families` → `garmentFactSegments(perDesign.families)`
(listingPipeline.ts ~9923). Reproduced live in the E2E test: BB's own resolved union genuinely
computes `{sweatshirt, long_sleeve_tee}` (from a minority of its children on a 6014 blank), and
pre-fix this handed `garmentFactSegments` the words `Tshirt`/`T-Shirt`/`Shirt`/`Graphic Tee` as
candidates for a family whose true sleeve fact is Long Sleeve.

**Cure (structural, not a hand-picked exception)**: `SHORT_SLEEVE_IMPLYING_ALIASES` — a new
exported `Set(['tshirt', 't-shirt', 'tee', 'graphic tee'])`, derived as the short-sleeve-specific
subset of `SHIRT_BASE.aliases` (bare `'shirt'` stays, silhouette-neutral).
`LONG_SLEEVE_TEE_BASE.aliases` now spreads `SHIRT_BASE_SLEEVE_NEUTRAL_ALIASES =
SHIRT_BASE.aliases.filter(a => !SHORT_SLEEVE_IMPLYING_ALIASES.has(a))` instead of the raw list. Any
future sleeve-specific family (e.g. a 3/4-sleeve base) reuses the same filter and is correct by
construction.

**Inverse direction — checked, no bug found**: `KIDS_TEE_BASE` (migration 058's 64000B row,
genuinely `sleeve: 'Short Sleeve'`) still spreads `...SHIRT_BASE.aliases` UNFILTERED, and that is
CORRECT — short-sleeve words are true of that family. Confirmed structurally: `KIDS_TEE_BASE` does
NOT spread `LONG_SLEEVE_TEE_BASE`'s aliases (no wholesale spread in that direction either), and
`SWEATSHIRT_BASE`/`HOODIE_BASE` never spread `SHIRT_BASE.aliases` at all (they have their own
literal vocabulary). Only the one direction (long-sleeve inheriting short-sleeve words) was ever
broken. `pickDistinctGarmentForm(title, bandGarment.aliases)` (listingPipeline.ts:9478) is a
SEPARATE site that resolves via the productType-only legacy path (`garmentFor`/`garmentNounFor`),
never reaches `LONG_SLEEVE_TEE_BASE` for this family (productType='SHIRT' always falls through to
plain `SHIRT_BASE`), and was unaffected either way.

**Tests**:
- `src/lib/fba/garmentNoun.test.ts` (new — this module had ZERO prior test coverage). Table-driven
  over `SHORT_SLEEVE_IMPLYING_ALIASES` asserting `resolveGarment({blankFamily:'long_sleeve_tee'})
  .aliases` never contains any of them (fails if a future edit reintroduces the wholesale spread);
  positive checks that the neutral `'shirt'` and the family's own long-sleeve overlay survive;
  inverse-direction checks for `kids_tee`/`tee` (must KEEP short-sleeve words — correct, not a bug)
  and `sweatshirt`/`hoodie` (never carried them at all).
- `titleMaterialAndSleeveE2E.integration.test.ts` also asserts BB's shipped title never contains a
  short-sleeve word, and captures/asserts on the `BLANK_GARMENT_UNION` console log directly
  (`union` containing `long_sleeve_tee`) — proving the PRECONDITION the live defect depends on
  actually fired, not merely that a string is absent.

## Before/after character counts (driven through the REAL `runListingPipeline()`)

`TITLE_SHIP_FLOOR()` = 68 throughout (Option C, unchanged).

### B0DSCDZC6K — all 6 designs (mixed 18000-sweatshirt-dominant / 6014-long-sleeve-tee family)

| Design | BEFORE | len | AFTER | len |
|---|---|---|---|---|
| BCS | `THE CEO Billionare Coming Soon Motivational Graphic Sweatshirt \| Crew Neck` | 74 | *(byte-identical — never carried material)* | 74 |
| DQ | `THE CEO Don't Quit Motivational Graphic Sweatshirt \| Long Sleeve Pullover` | 73 | *(byte-identical)* | 73 |
| ED | `THE CEO Entrepreneur Definition Motivational Graphic \| Cotton Polyester` | 71 | `THE CEO Entrepreneur Definition Motivational Graphic \| Long Sleeve Pullover` | 75 |
| HD | `THE CEO Hustle Definiton Motivational Graphic Sweatshirt \| Long Sleeve` | 70 | *(byte-identical)* | 70 |
| MH | `THE CEO Mother Hustler Motivational Graphic Sweatshirt \| Cotton Polyester` | 73 | `THE CEO Mother Hustler Motivational Graphic Sweatshirt \| Crew Neck Pullover` | 75 |
| BB | `THE CEO Business B*tch Motivational Graphic, Print Design \| Long Sleeve` | 71 | *(byte-identical)* | 71 |

ED and MH are the two designs whose search order reached the material candidate pre-fix (proving
Fix 1 live); both refill from TRUE facts and land IN BAND (70-75), one even longer than before.
BCS/DQ/HD/BB never reached material in this fixture's search order (their fact/pool banks filled
band first) — byte-identical before/after, confirming Fix 1 introduced zero regression where
material was never the deciding factor. BB's `BLANK_GARMENT_UNION` log independently confirms its
union is `{sweatshirt, long_sleeve_tee}` both runs (the Fix 2 precondition fired); BB's own search
order never needed the bad alias in this fixture, so the definitive Fix 2 proof is
`garmentNoun.test.ts`'s direct table-driven assertion, not this specimen's string.

### B0DP5H8QBT — kids specimen (64000B, genuinely short-sleeve)

BEFORE: `THE CEO Don't Quit Motivational T-Shirt | Kids Ring-Spun Cotton Crew Neck` — 73 chars.
AFTER: `THE CEO Don't Quit Motivational T-Shirt | Kids Short Sleeve Crew Neck Tee` — 73 chars.

`SHIP_TITLE_WASTE` log: `{"decision":"stripped","note":"removed Ring-Spun, Cotton; 73 → 73 chars"}`
— proves the branch ran (this is the belt-and-suspenders scrub catching a STALE prior title that
predates the ruling, since a truthful in-band title has no other reason to be touched). Refilled
to the identical 73 chars from the blank's TRUE facts (Short Sleeve, Crew Neck, Tee — all real
64000B spec). Also confirms the inverse-direction claim: "Short Sleeve"/"Tee" on a genuinely
short-sleeve family is correct, and no "Long Sleeve" claim was ever asserted.

## Test numbers

- Baseline (`main` @ `e6a70f7`, before any edit): **99 test files, 1907 passed + 4 expected-fail
  (1911 total), 0 failures.**
- Final (this branch): **101 test files, 1916 passed + 4 expected-fail (1920 total), 0 failures.**
  (+2 new files: `garmentNoun.test.ts`, `titleMaterialAndSleeveE2E.integration.test.ts`.)
- `npx tsc --noEmit`: clean.

## `LONG_SLEEVE_TEE_BASE.aliases` — before/after

BEFORE (wholesale spread):
```
['long sleeve t-shirt', 'long sleeve tshirt', 'long sleeve tee', 'long sleeve shirt',
 'longsleeve shirt', 'longsleeve tee', 'long sleeve',
 'shirt', 't-shirt', 'tshirt', 'tee', 'graphic tee']   // last 5 spread wholesale from SHIRT_BASE
```

AFTER (filtered):
```
['long sleeve t-shirt', 'long sleeve tshirt', 'long sleeve tee', 'long sleeve shirt',
 'longsleeve shirt', 'longsleeve tee', 'long sleeve',
 'shirt']   // SHIRT_BASE_SLEEVE_NEUTRAL_ALIASES: only the silhouette-neutral remainder
```

Removed: `t-shirt`, `tshirt`, `tee`, `graphic tee` (exactly `SHORT_SLEEVE_IMPLYING_ALIASES`).

## Constraints honored

- Did not touch detail-attribute precedence (#661), the colour resolver, migrations, or age-label
  work (#663).
- Did not add a rule against garment-concept repetition (PO ruled that fine 2026-09-02) — Fix 2 is
  strictly about WRONG sleeve length.
- Did not touch the audit agent's Product Details prompt or the Product-Detail (Fabric/Material)
  attribute path — `blankFacts`/`descAttrs` (bullets/description/Product-Detail prose) untouched;
  material still reaches those surfaces.
- Did not touch `poGoldCorpus.ts`'s gold title text — only test files that SCORE that text against
  a now-updated shared predicate.
- No merge, no deploy, no push to Amazon.
