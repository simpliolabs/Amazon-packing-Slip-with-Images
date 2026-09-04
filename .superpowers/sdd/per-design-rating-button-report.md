# Per-design rating button — report

Branch: `feat/per-design-rating-button` (worktree `C:\Users\Admin\AppData\Local\Temp\fba-wt-rerate`)

## The gap (verified against code, not the brief's line numbers)

Branched from `main`, but the local `main` ref was 2 commits stale (missing #665 and #666,
merged today). Reset the worktree branch to `origin/main` (`7b2dcc5`) before touching anything —
otherwise this PR would have based off a main that no longer matched production and conflicted
with #665's own per-design work.

The "Held" badge + its instructive tooltip live in
`src/app/fba/listing/[asin]/page.tsx`, inside the `product_details_improvements` panel's
per-design Item Highlights block — **line 4538 today** (the brief said ~4412; two PRs landed
lines above it since the brief was written — verified by grepping the exact tooltip string, only
one occurrence exists). It fires when a `PerDesignIhRow.hold === 'designs-unrated'`
(`src/lib/fba/perDesignItemHighlights.ts`, sourced from `IhHoldReason` in `listingPipeline.ts`).
`POST /api/fba/keyword-pool/rerate { parent_asin, per_design: true }` — confirmed POST-only,
confirmed body key is `parent_asin` (snake_case; the route does
`body.parent_asin?.trim().toUpperCase()`), confirmed no GET handler, confirmed no other endpoint
does this.

## What was built

**`src/lib/fba/themeRerateControl.ts`** (new, client-safe — zero import from
`themeRatingRun.ts`/`@supabase/supabase-js`, even type-only, for the same "deliberately separate"
reason `garmentPerDesign.ts` gives for staying out of `blankAssignmentImpact.ts`'s import graph):
- `buildThemeRerateRequestBody(parentAsin)` → `{ parent_asin, per_design: true }` — the one place
  the exact body shape is constructed.
- `classifyThemeRerateResponse(status, body)` — a pure classifier turning one HTTP response into a
  discriminated `ThemeRerateOutcome` (`success | empty | not-multi-design | cooldown | no-card |
  failed | error`), matching the route's actual status/body shapes read directly from
  `route.ts`/`themeRatingRun.ts` (404 empty, 409 all-cooldown, 422 not-multi-design **or** 422
  all-no-card — discriminated by the `noCard` key's presence, since both are 422 — 502 failed,
  200 success carrying `rated`/`total`/`groups`).
- `runThemeRerate(parentAsin, busy, { fetchImpl, headers })` — the one orchestration seam the page
  calls. Returns `null` (no fetch fired) when `busy` is true — the guard is INSIDE this function,
  not just a disabled DOM attribute, so a race can't double-fire a billable rating pass. Never
  throws; a network failure classifies as `{ kind: 'error' }`.

**`src/app/fba/listing/[asin]/page.tsx`**:
- `themeRerateBusy` / `themeRerateOutcome` state + `onRateDesignsAgainstPool` handler (mirrors the
  existing `onRegenerateItemHighlight` pattern exactly: `getToken()` → Bearer header → `fetch` →
  swap local state; same file, same idiom).
- The control renders **inside the same per-design Item Highlights block as the Held badge**,
  directly above the row list, and **only when at least one row is actually held on
  `designs-unrated`** (`ihRows.some((row) => !row.line && row.hold === 'designs-unrated')`) — no
  clutter when nothing needs it. Button label: "Rate designs against pool" / busy: "Rating
  designs… (can take minutes)", `disabled={themeRerateBusy}`. Its `title` attribute states plainly
  that this is an AI pass over the CACHED pool — zero Jungle Scout calls, no research credits —
  and that designs are rated sequentially and can take minutes.
- A result panel renders `themeRerateOutcome.message` (built by the classifier) with per-kind
  color and per-kind extra detail (retry-in-minutes for cooldown, the specific design keys for
  no-card/failed). Success renders "Rated N of M design groups against the pool. Click Regen to
  compose the Item Highlight." — the "then Regen" instruction from the original tooltip is
  repeated in the success state, per the brief.

Chose the single "per-family" trigger over a per-row button because ONE call rates every design
group in the family (sequential inside the route) — a button per Held row would just be N buttons
firing the identical family-wide call, which is confusing and invites the exact double-fire the
busy-gate exists to prevent.

## How each route outcome renders

| Route response | Classifier `kind` | UI rendering |
|---|---|---|
| 200, `rated > 0` | `success` | Emerald panel: "Rated N of M design group(s) against the pool. Click Regen to compose the Item Highlight." |
| 404 `empty` | `empty` | Slate panel, route's own message ("…nothing to re-rate (run research first)") |
| 422 not-multi-design (no `noCard` key) | `not-multi-design` | Slate panel, route's own message ("…use the family rating") |
| 409 all-cooldown | `cooldown` | Amber panel, route's message + "Retry in ~N min." (from `retryAfterMs`) |
| 422 all-no-card (has `noCard` key) | `no-card` | Amber panel, route's message + "No identity for: d1, d2." |
| 502 failed | `failed` | Rose panel, route's message + "Failed: d3." |
| anything else (e.g. 500) | `error` | Rose panel, route's `error` string or a generic fallback |

## Red-first verification (done AFTER an initial write-together pass, per the coordinator's
correction — recorded honestly, not glossed over)

The implementation and its test file were written in the same pass, not strict red-green-refactor.
Before committing, retroactively proved the tests are load-bearing: backed up
`themeRerateControl.ts`, replaced it with a deliberately wrong stub (camelCase `parentAsin` body
key, `classifyThemeRerateResponse` always returning `{ kind: 'error' }`, `runThemeRerate` always
returning `null`), and re-ran `themeRerateControl.test.ts`:

**13 of 14 tests failed** against the broken stub, including the load-bearing camelCase-body
assertion. The 1 test that still passed (`does NOT call fetch when already busy`) is legitimately
satisfied by any no-op — its paired test (`POSTs the exact snake_case body… ` — asserts `fetchImpl`
WAS called once when not busy) failed against the same stub, so the busy-gate is still fully
proven by the pair. Restored the real implementation from the backup (`diff` confirmed
byte-identical), re-ran: 14/14 green.

## Baseline vs final tests

- Baseline (`main` at `origin/main` `7b2dcc5`, `npx vitest run --no-cache`, this worktree, before
  any edits — first run failed on missing `node_modules`/`@supabase/supabase-js`/`next/server`
  because a fresh worktree has no install; `pnpm install --frozen-lockfile` fixed it): **106 test
  files passed, 1974 tests passed + 4 expected fail (1978 total)**.
- Final (same command, after all changes, after the red-first restore): **107 test files passed,
  1988 tests passed + 4 expected fail (1992 total)**. Delta is exactly the one new test file (14
  tests) — zero regressions.
- `npx tsc --noEmit`: clean before and after (one type error surfaced mid-build in the test file
  itself — an unsafe `as Record<string, unknown>` cast — fixed by routing through `unknown` first;
  confirmed clean again after).
- `npx eslint` on every touched/new file: zero new warnings/errors. `page.tsx` has 43 pre-existing
  lint **errors** (all `react-hooks/refs` — accessing `.current` during render in unrelated bulk-push
  progress UI, lines 5644-6436) confirmed present on `origin/main` before this change, unrelated to
  anything touched here; lint is `continue-on-error: true` in CI regardless.
- Local `next build` was not attempted — the brief pre-warned this worktree fails it with a
  Turbopack symlink error unrelated to the change; the pushed PR's CI build is the real gate,
  reported below.

## Other "instructed action with no control" instances found (report only — NOT fixed)

1. **`POST /api/fba/intelligence/scan-identity { parent_asin, per_design: true }`** — one level
   upstream of the control just built. When per-design rating's `no-card` outcome fires (no cached
   per-design vision identity), the route's own error message says: *"Run POST
   /api/fba/intelligence/scan-identity { parent_asin, per_design: true } first, then re-rate."*
   Grepped the entire `src/app/fba` + `src/components/fba` tree for any UI reference to
   `scan-identity` — zero hits outside route/lib code and comments. There is no button anywhere
   that fires this route; a seller who hits the `no-card` outcome from the control built here (now
   rendered plainly, not buried in a 422 in DevTools) hits the identical class one step later. Not
   fixed — out of this task's scope (it is a different route with its own semantics, a `force`
   flag, and its own vision-scan cost profile that wasn't investigated).

2. **Single-design (broadcast) Item Highlights holds are silently dropped, not just uncontrolled.**
   `listingPipeline.ts:11843` calls `buildItemHighlights(...)` for the single-design/broadcast path
   and destructures **only** `{ value: hl }` — the `hold` reason is discarded, and when `hl` is
   falsy (held) **no row is pushed to `pdiFinal` at all** (contrast with the multi-design branch a
   few lines above, which does carry `built.shared.hold` through to `per_child_item_highlights` —
   that's the exact plumbing this task's control reads). Net effect: a single-design family whose
   Item Highlight holds on `unrated-pool` / `thin-candidates` / `under-floor` / `no-spec` shows
   **no Item Highlights row and no explanation at all** in `product_details_improvements` — not
   even the "instructed but no button" pattern, a step worse (no instruction surfaces). This is
   adjacent to, but a different class from, the brief's target pattern, so left unfixed and only
   reported per the brief's instruction to report-not-fix anything found while searching.

A broader grep across `page.tsx` and `src/components/fba/*.tsx` for other tooltip/title strings
naming a route or "run X first" turned up nothing beyond the two above and the one this task
fixed.

## Brief assumptions that were WRONG

- **Line number drift**: the brief's `page.tsx ~:4412` is `~4538` on current `main` (two PRs, #665
  and #666, landed between when the brief was written and when this branch was created). Verified
  by grepping the exact tooltip string (`'The pool is not rated against every design yet…'`) —
  only one occurrence exists, so the target line was unambiguous despite the drift.
- **Local `main` was stale**: `git worktree add ... main` used a local `main` ref 2 commits behind
  `origin/main` (missing #665 "per-design Garment control" and #666, both merged earlier today).
  Reset to `origin/main` before writing any code — building on the stale base would have produced
  a PR that conflicts with #665's already-merged per-design work and reverted #666.
- **No node_modules in a fresh worktree**: the brief's CI-trap note covers env vars but not that a
  brand-new `git worktree add` has no `node_modules` at all — the very first baseline test run
  failed outright on missing `@supabase/supabase-js`/`next/server`, not from a real regression.
  `pnpm install --frozen-lockfile` (same command CI runs) fixed it in ~18s.
- Everything else in the brief (route being POST-only, body key being `parent_asin` snake_case,
  `maxDuration = 300`, sequential per-design rating, the five documented outcomes, credit-free via
  cached `keyword_analysis`, zero Jungle Scout calls) checked out exactly against the code.
