# Per-design Garment UI — report

Branch: `feat/per-design-garment-ui` (worktree `C:\Users\Admin\AppData\Local\Temp\fba-wt-garmentui`)
Commit: `a982285` — "fba: per-design Garment control — the class, not just B0DSCDZC6K's row (PO 2026-09-03)"

## What existed already (verified before building)

`/api/fba/blank-assignment` (GET/PUT/DELETE) already supported `scope='child'` end-to-end, and
already returned a per-SKU `children[]` resolution array (styleCode/source/blankId) alongside the
family resolution. A per-SKU garment control already existed too, but only in the **Variant
Breakdown** tab (one row per SKU, not grouped by design). The gap was specifically: the **PER-DESIGN
CONTENT** cards (`PerDesignCard.tsx`) — the surface that groups a multi-design family's SKUs by
design and already carries a per-design Audience control built on the identical select+badge idiom
— had no Garment control at all. That is the exact class described in the brief: a wrong
`scope='child'` row is invisible on the one surface (per-design) where the PO actually looks when a
title says the wrong garment.

## What was built

- **`src/lib/fba/garmentPerDesign.ts`** (new) — client-safe module (zero dependency on
  `blankSpecs.ts`/`@supabase/supabase-js`, deliberately kept separate from
  `blankAssignmentImpact.ts` for that reason):
  - `SOURCE_LABEL` — the one label map (`child-assignment`→"assignment", `sku-code`→"from SKU
    code", `family-assignment`→"family default", `legacy`→"guessed from title"), moved out of
    `page.tsx`'s local duplicate so the family row, the per-SKU row, and the new per-design row
    can never show different text for the same source.
  - `resolveDesignGarment(designSkus, childResolutions)` — picks a design's representative
    resolution as the first of its SKUs present in the already-fetched per-child array (same "first
    SKU is representative" convention `perDesignEntries` already uses for title/bullets/description).
  - `buildDesignAssignmentRequests` / `buildDesignClearRequests` — pure functions building the
    `{scope:'child', key, style_code}` PUT bodies / `{scope:'child', key}` DELETE bodies for every
    SKU in a design.
- **`src/lib/fba/blankAssignmentImpact.ts`** — added `resolveChildFallback(sku, parentAsin, hay,
  catalog, childCodeBySku, familyCodeByAsin)`: what one SKU would resolve to with only its own
  child assignment excluded (family assignment / legacy / other children unaffected). Reuses
  `resolveFamily` unchanged.
- **`src/app/api/fba/blank-assignment/route.ts`** — GET now also computes and returns
  `children[].fallback` per SKU via `resolveChildFallback`. No change to PUT/DELETE — the per-design
  control reuses that contract by calling it once per SKU in the design.
- **`src/components/fba/PerDesignCard.tsx`** — new Garment block in the card body, mirroring the
  family Garment row's exact markup/copy ("Changes what the generator believes — no live copy
  rewrite, no Amazon push." / "Assigned — stored copy unchanged. Regenerate to apply."): style-code
  chip, source badge, assign `<select>`, and a **Clear** control gated behind an inline confirm
  strip that renders `designGarment.fallback` (style code + source badge) before a second click
  fires the actual clear.
- **`src/app/fba/listing/[asin]/page.tsx`** — wires `resolveDesignGarment` into the `designGroups`
  render loop, and adds `assignDesignBlank`/`clearDesignBlank` handlers that loop the existing
  PUT/DELETE endpoint over `buildDesignAssignmentRequests`/`buildDesignClearRequests`. (Caught and
  fixed a self-inflicted TDZ ordering bug during implementation — these two `useCallback`s
  originally referenced `designGroups` before its `useMemo` declaration; relocated below it.)

## Multi-SKU designs — decision

**Write to every SKU in the design, not per-SKU rows in the UI.** One `<select>`/`Clear` pair per
design, fanning out to N `PUT`/`DELETE` calls (one per SKU) against the unmodified single-key
route contract. Chosen because: (1) it matches how this exact card already broadcasts
title/bullets/description to every SKU in the design — a design is already the unit of editing on
this surface; (2) a per-SKU row grid already exists (Variant Breakdown tab) for anyone who wants
SKU granularity, so duplicating it here would be a second, confusing control for the same data;
(3) Business B*tch (1 SKU) and an 8-SKU sibling both need to end up in a single, internally
consistent state — "assign this design's garment" is the mental model the PO already has when
looking at a wrong title. Display uses the same "first SKU is representative" rule already used for
title/bullets/description, so if a design's SKUs were ever in a mixed state (pre-dating this
feature), the badge shows the first SKU's resolution — consistent with existing per-design display
conventions elsewhere in this card, not a new convention.

## Clear action — what it shows before confirming

Clicking **Clear** never deletes immediately. It flips to an inline amber strip reading "Falls back
to `<styleCode>` (`<source label>`)" — sourced from `designGarment.fallback`, which the GET route
now computes server-side via `resolveChildFallback` (the representative SKU's child assignment
excluded, family assignment/legacy/SKU-code from other children unaffected) — with **Confirm
clear** / **Cancel** buttons. Only a second, explicit click fires the DELETE fan-out. For
BB64000XL-BK-FBA specifically this preview reads "Falls back to `64000` (from SKU code)" — the
wrong Tee code that motivated the original bad assignment — so the PO sees exactly what they'd be
walking back into before it happens.

## Baseline vs final tests

- Baseline (`main`, `npx vitest run --no-cache`, run in this worktree before any edits): **99 test
  files passed, 1907 tests passed + 4 expected fail (1911 total)**.
- Final (same command, after all changes): **101 test files passed, 1938 tests passed + 4 expected
  fail (1942 total)**. Zero regressions — the only deltas are the two new test files plus additions
  to `blankAssignmentImpact.test.ts`.
- `npx tsc --noEmit -p tsconfig.json`: clean (0 errors), before and after.
- `npx eslint` on every changed/new file: 0 new warnings/errors. The one pre-existing ESLint
  **error** in `PerDesignCard.tsx` (`setState` inside a `useEffect`, the design-name-editor's
  `nameDraft` reset) is unrelated to this change — confirmed present, same rule, same code, on
  `main` before any edit. `next build` is not blocked by it today (repo's own CI runs `pnpm run
  lint` as an explicit `continue-on-error: true` step, separately from the blocking build/test
  steps), so it was left untouched (out of scope for this task).
- Local `next build` (with the CI's placeholder Supabase env vars) fails with Turbopack's "Symlink
  [project]/node_modules is invalid, it points out of the filesystem root" — this worktree's
  `node_modules` is a junction to the main checkout's (to avoid a full reinstall), which Turbopack's
  project-root resolution rejects. This is exactly the worktree-only artifact the task brief called
  out in advance, not a defect in this change; the real gate is the pushed PR's CI build (clean
  `pnpm install --frozen-lockfile` checkout, no symlink), reported separately below.

## Brief assumptions that were WRONG

- The brief's own precedence-source labels ("child assignment" / "SKU style code" / "family
  assignment" / "legacy match") are prose paraphrases; the actual `ResolutionSource` values in code
  are hyphenated (`'child-assignment' | 'sku-code' | 'family-assignment' | 'legacy'`) and the
  existing `SOURCE_LABEL` display strings are `"assignment" / "from SKU code" / "family default" /
  "guessed from title"`. Followed the code's actual values/strings throughout, not the brief's
  paraphrase.
- The brief frames this as pure greenfield ("the PO had no way to SEE or CHANGE" any child
  assignment). In fact the read+write API contract (GET returning per-child resolutions, PUT/DELETE
  accepting `scope='child'`) was already fully built and already had a UI surface — just the wrong
  one (per-SKU Variant Breakdown, not per-design). The actual gap was narrower than "build a whole
  new read+write surface": it was "wire the per-design card to the data and contract that already
  exist." No API route reshaping was needed beyond adding the `fallback` field to GET's response.
