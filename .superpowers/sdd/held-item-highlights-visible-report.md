# Held Item Highlights must be visible — report

Branch: `fix/held-item-highlights-must-be-visible` (worktree `C:\Users\Admin\AppData\Local\Temp\fba-wt-ihvisible`)

## The defect, confirmed against current code (line numbers drifted from the brief; noted below)

Both push sites live in `src/lib/fba/listingPipeline.ts`'s `runListingPipeline`, inside the
`if (highlightsAttr) { ... }` block (brief said `~:11759`; on this branch's base it's `:11761`).

- **Single-design** (brief's `:11843` — on this base it was `:11846`):
  `const { value: hl } = buildItemHighlights(...); if (hl) { pdiFinal.push(...) }`. `hold` was
  destructured away and discarded; when `hl === ''` (held), **nothing was pushed**.
- **Multi-design** (a few lines above, brief's `:11814` area — this base `:11817`):
  `if (composed > 0) { pdiFinal.push({ per_design: true, ... }) } else if (built.shared.hold) {
  console.warn(...) }`. When every design held (`composed === 0`, the live B0DSCDZC6K case:
  family-level `theme_fit` present, no per-design `theme_fit_by_design`, migration 061), **nothing
  was pushed** either — only a server log line.

Confirmed why this hides PR #667's control: the "Rate designs against pool" button and the
per-row "Held · designs-unrated" badges in `src/app/fba/listing/[asin]/page.tsx` all live
**inside** `recs.product_details_improvements.map(...)`, gated on a row matching
`isItemHighlightsField`. With no row pushed, that whole per-design UI block — including the button
— never renders. `per_child_item_highlights` (the array PR #667's gate actually reads via
`perDesignIhRows`) was **already** being populated unconditionally
(`perChildItemHighlights = built.perChild`, before the `if (composed > 0)` check) — so the data the
button needs was always there; only the **marker row's existence** was the gate that failed.

## What was built

**`src/lib/fba/listingPipeline.ts`** — both branches now push the row unconditionally:
- Multi-design: `pdiFinal.push({ field_name, current_value: null, recommended_value: '',
  per_design: true, hold: built.shared.hold, reason: <composed-text or a HELD-specific text via
  IH_HOLD_MESSAGES> })` runs every time, not just when `composed > 0`.
- Single-design: `buildItemHighlights` now destructures `{ value: hl, hold }`; the row is always
  pushed, `hold: hl ? null : hold`, `reason` switches to a HELD-specific sentence when empty.
- Added `hold?: IhHoldReason | null` to `PipelineProductDetailImprovement`.

**`src/lib/fba/perDesignItemHighlights.ts`** — `IhHoldReason` + `IH_HOLD_MESSAGES` **moved here**
from `listingPipeline.ts` (which does `import OpenAI from 'openai'` at module scope — a server-only
dependency that must never reach the client bundle). This module was already pure and already
imported by the client-side listing page, so it's the natural home; `listingPipeline.ts` now
imports and re-exports both names, so every existing importer (`itemHighlightHold.test.ts`,
`itemHighlightPerDesign.test.ts`, `regenerate-item-highlight/route.ts`) is unaffected — a
relocation, not a behavior change.

**`src/lib/fba/productDetailAttrs.ts`** — new `isEmptyDetailValue` + `isProductDetailGap`. The
latter is **the one gap predicate** now called from both `syncListingContent.ts`'s
`fetchScoringContext` and the `ai-recommendations` route's own live-rescore (previously two
hand-copied inline filters — the route's own comment already said "using the SAME predicate as
syncListingContent", which was aspirational, not enforced). It exempts a row from the Features gap
count when `current_value` is empty **and** `hold` is set — gated on `current_value`
(not `recommended_value`) deliberately: `stickyDetails.ts` can snap a held row's
`recommended_value`/`current_value` **back** to a prior accepted push (a real value) while leaving
the stale `hold` flag riding along on the spread; checking `current_value` means that snapped-back
row is correctly never treated as held or as a gap, regardless of the stale flag.

**`src/app/fba/listing/[asin]/page.tsx`**:
- `heldEmpty = !!pd.hold && !(pd.recommended_value ?? '').trim()` — the same stale-flag-safe
  compound check, used to (a) force `pushable = false` for a held single-design row (previously
  `pushable` had no emptiness check at all for the non-per-design case — see "push safety" below),
  and (b) pick the `blockedReason` text.
- New render branch for the **single-design** held case: a `Held · <reason>` badge +
  `IH_HOLD_MESSAGES[pd.hold]` (field name, empty value badge, the reason, and the action — matches
  what the existing multi-design per-row badges already did).
- Multi-design per-row "Held" tooltip now uses `IH_HOLD_MESSAGES[r.hold]` for **every** reason
  (was: a two-bucket ternary — `designs-unrated` got its own sentence, the other three reasons
  shared one generic line). Every hold reason now gets its own explanation, per the brief.
- Confirmed (not changed — see "brief assumptions" below) that PR #667's button gate
  (`ihRows.some(row => !row.line && row.hold === 'designs-unrated')`) **self-corrects** once the
  marker row exists, because it reads `per_child_item_highlights`, which was already populated
  unconditionally.

**`src/app/api/fba/regenerate-item-highlight/route.ts`** — the two success-path writes now stamp
`hold: null` explicitly (both are only reached when a real value was composed) so the stored row's
data model stays honest, on top of the UI/scorer's stale-flag-safe compound check already
neutralizing it either way.

**`src/app/api/fba/listing-optimizer/ai-recommendations/route.ts`** — added `per_design`/`hold` to
the route's own `ProductDetailImprovement` interface (previously untyped even though the pipeline
already stamped `per_design` on it after #667) and switched its live-rescore gap count to the
shared `isProductDetailGap`.

## Push safety — verified, not assumed (the brief's "push back before building" trigger)

Checked every layer between a held row and Amazon before writing a line of the fix, since a row
with an empty value reaching Amazon would be worse than the bug:

1. **Client `pushable`**: single-design held rows are now explicitly excluded (`!heldEmpty`, new).
   Per-design held rows were already excluded (`ihRows.some((r) => !!r.line)` — unchanged,
   pre-existing).
2. **Server `loadDetailContext`** (`pushExecutor.ts`): already refuses (400, "No AI recommendation
   found... Run an AI audit first") when the matched row's `recommended_value` is empty — for
   *any* field, not just Item Highlights — and separately refuses per-design pushes with
   `PER_DESIGN_IH_ALL_HELD_REASON` when every design's line is empty. Both pre-existing, untouched.
3. **`buildPerSkuItemHighlightMap`** (the actual per-SKU value resolver at push time): skips any
   entry whose `item_highlight` is empty — `if (!line) continue` — so even a direct call bypassing
   the UI can never hand Amazon an empty value.
4. **`bulkEligibleDetails`** (Auto Push all): already requires a non-empty `recommended_value`
   (single-design) or `perDesignIhReady` (at least one composed, unpushed line — per-design) —
   both pre-existing, both correctly exclude a fully-held row.

**Conclusion: a held row is not pushable to Amazon, at four independent layers, three of which
were already there.** No push-back was needed against the brief.

## Features-score doctrine — verified, not assumed

Before this fix, `isWriteBlockedPreLaunch` alone exempted Item Highlights from the gap count — but
the live settled data says `item_highlights_api_state.supported = true` (Amazon accepts writes
now), so that exemption **no longer fires**. Pushing a held row visible, without a second
exemption, would have made every held family's Features score regress the moment this shipped.
`isProductDetailGap`'s new `hold`-based exemption (item 2 above) is that second doctrine, additive
to (not replacing) the write-block one — both are independently testable and tested (see below).

## Tests

New files, both RED-verified against the unmodified branch tip before restoring the fix (details
below), then GREEN on the fixed source:

- **`src/lib/fba/itemHighlightSilentHold.test.ts`** (8 tests) — pure-predicate tests for
  `isEmptyDetailValue` / `isProductDetailGap`: a held row (any of the 5 hold reasons) is not a gap
  even with `apiSupported:true`; an unrelated never-proposed field still is; a row snapped back to
  a real accepted value by the sticky gate (stale `hold` riding along) is correctly not a gap
  either way; enum-invalid still docks; write-block still exempts independently. One test
  re-implements the OLD inline filter side-by-side to show the count it *would* have produced (1)
  vs the fixed predicate's count (0) on the identical held row.
- **`src/lib/fba/itemHighlightSilentHold.integration.test.ts`** (4 tests) — drives the real
  `runListingPipeline()` (same harness as `gatePerChildMultiDesign.integration.test.ts`):
  - **THE LIVE CASE**: 2-design family (GATOR/SHARK), pool with family-level `themeFit: 2`/`3` but
    no `themeFitByDesign` anywhere → asserts the marker row EXISTS, `recommended_value === ''`,
    `hold === 'designs-unrated'`, `per_design === true`, `per_child_item_highlights` carries the
    same reason per SKU, the PR #667 button gate predicate evaluates `true` against that array, and
    `isProductDetailGap` on the live row returns `false`.
  - **Single-design held**: unrated pool (`themeFit: null` everywhere, the exact fixture from
    `itemHighlightHold.test.ts`'s `unrated-pool` case) → row exists, `hold === 'unrated-pool'`,
    `per_design` falsy, not a gap.
  - **Not held**: the exact composing fixture from `itemHighlightHold.test.ts` → row exists with a
    real non-empty value, `hold == null`, and (control) `isProductDetailGap` on it is `true` (an
    un-pushed real recommendation is still a normal, closable gap — the exemption must not
    over-fire).
  - **Attribute absent from menu** (`detailAttributeMenu: [{ key: 'material', ... }]`, no Item
    Highlights entry) → asserts no row at all — proves the fix didn't turn the genuinely-correct
    "not applicable" case into a phantom row.

**RED-before-GREEN, proven, not asserted:**
- `isProductDetailGap`'s hold exemption: temporarily replaced the
  `if (currentEmpty && row.hold != null) return false` line with a no-op comment. Re-ran
  `itemHighlightSilentHold.test.ts` — **3 of 8 failed** (the two direct "is not a gap" assertions
  and the load-bearing old-vs-new comparison), exactly the tests that name the exemption. Restored
  the real line (diff-confirmed byte-identical to before); re-ran: 8/8 green.
- The push-decision fix itself: `cp`'d the modified `listingPipeline.ts` aside, restored the
  branch-tip (pre-fix) version via `git show HEAD:...`, and re-ran
  `itemHighlightSilentHold.integration.test.ts` — **2 of 4 failed**: both held-case tests
  (`expected undefined to be defined` — the row was genuinely absent, reproducing the live bug),
  while the "not held" and "attribute absent" control tests correctly stayed green (unaffected by
  the fix, as they should be). Restored the fixed file; re-ran: 4/4 green.

## Baseline vs final tests

- Baseline (`main` HEAD, fresh worktree, `pnpm install --frozen-lockfile` first — a brand-new
  worktree has no `node_modules`): **107 test files passed, 1988 tests passed + 4 expected fail
  (1992 total)**.
- Final (after all changes): **109 test files passed, 2000 tests passed + 4 expected fail (2004
  total)**. Delta is exactly the 2 new files (8 + 4 = 12 new tests) — zero regressions.
- `npx tsc --noEmit`: clean, both before touching anything and after.
- `npx eslint` on every touched/new file, diffed line-for-line against `origin/main`'s output on
  the same files: **identical set of pre-existing issues** (71 problems both before and after —
  all `react-hooks/refs` errors in unrelated bulk-push progress UI, plus pre-existing unused-var
  warnings; line numbers shifted only from added lines/comments). Zero new lint issues. Lint is
  `continue-on-error: true` in CI regardless.
- Local `next build` not attempted — brief pre-warned this worktree fails it with a Turbopack
  symlink error unrelated to the change; the pushed PR's CI build is the real gate (see below).

## Brief assumptions that were WRONG

- **Line numbers**: `:11759`/`:11843`/`:~11814` on the brief's base shifted to `:11761`/`:11846`/
  `:11817` on this branch's `main` tip (PRs #665-#667 landed ~100 lines above, as the brief itself
  warned would happen) — followed the code, confirmed via grep on the unique `IH_REASON` string and
  the `highlightsAttr.title` match, not the line numbers.
- **"Fix the gate too" contingency**: the brief hedged that PR #667's button gate
  (`ihRows.some(row => !row.line && row.hold === 'designs-unrated')`) might need fixing once rows
  are always pushed. It did not — `per_child_item_highlights` was already populated unconditionally
  (`perChildItemHighlights = built.perChild` ran before the old `if (composed > 0)` check), so the
  gate's own data source was never the problem; only the marker row's existence in
  `product_details_improvements` (a different array) was. Verified live via the integration test's
  explicit assertion on the gate predicate, not just inferred from reading the code.
- **The write-block exemption implicitly still covering this**: it does not, and this was the
  actual risk the brief's "push back" trigger was aimed at. `item_highlights_api_state.supported`
  is `true` in the live settled data, so `isWriteBlockedPreLaunch` no longer exempts anything —
  without the new `hold`-based exemption in `isProductDetailGap`, shipping this fix alone would
  have silently docked every held family's Features score the moment it deployed. Built and tested
  the second exemption rather than assuming the first one still applied.
