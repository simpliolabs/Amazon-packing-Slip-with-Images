# Backfill-color-counter — implementation report

## Status
Implemented, tested, pushed. PR open, CI green. NOT merged, NOT deployed. Worktree-only change
(`C:\Users\Admin\AppData\Local\Temp\fba-wt-backfill`); `/tmp/fba-portal` and sibling worktrees
(including the ones actively editing `titleBand.ts`, `listingPipeline.ts`, `contentContract.ts`,
`poGoldCorpus.ts`) untouched. SP-API: read-only throughout — `fetchCatalogColor` itself was not
touched, and the new tests mock it and `@/lib/amazon/auth` entirely, so no network call to Amazon
was even possible during verification.

## PR / commit
- PR: https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/pull/657
- Commit: `3cd840f54f6d9de05035ec01b7c656a485ca0874` on branch `fix/backfill-color-counter`
- CI (`gh pr checks 657`): `build  pass  1m42s`

## Baseline vs final tests
- Baseline (`main`, `npx vitest run --no-cache`): **94 test files, 1767 passed, 4 expected fail
  (1771 total)**.
- Final (worktree, same command): **95 test files, 1780 passed, 4 expected fail (1784 total)**.
  Delta is exactly the 1 new file / 13 new tests — zero regressions elsewhere.
- `tsc --noEmit`: clean.
- `eslint` on both changed files: 0 errors, 1 harmless warning (`_table` unused param, intentional
  underscore prefix, in the test's fake query builder).

## DEFECT 1 — remainingNull was not the remaining count
Confirmed against the actual code (line numbers matched the brief for the select and the
`remainingNull` line; see "Brief vs code" below). Root cause: the top-level select
(`.from('listing_content').select('asin, parent_asin').is('color', null).order(...)`) has no
`.limit()`, so PostgREST silently applies its own default max-rows cap. The resulting
`uniqueAsins` array is a CAPPED WINDOW, not a total. `remainingNull` was
`uniqueAsins.length - filled.length` — arithmetic on that same capped window — so as low-ASIN rows
got filled, the window slid forward and absorbed rows that had been beyond the cap, masking real
progress (live: 812 -> 807 after two 49-fill batches).

Fix: `countNullChildren(db, parentAsin)` — a new exported helper —
1. Gets the TRUE row count via `.select('asin', { count: 'exact', head: true }).is('color', null)`
   (+ `.eq('parent_asin', ...)` when scoped). A `head:true` count is computed server-side by
   Postgres and is never subject to a row cap.
2. Gets the TRUE distinct-ASIN count by paging with explicit `.range(offset, offset+999)` calls
   (PAGE_SIZE = 1000) until it has seen every row the head-count reported, accumulating into a
   `Set<string>`. `listing_content` can hold an FBA row AND an FBM row per child ASIN, so this is
   reported separately from the row count rather than assumed equal to it.

Called AFTER the batch loop in execute mode (so the reported numbers reflect real post-batch
state) and BEFORE any work in dry-run mode. The dry-run response's old `totalNull`/`totalNullRows`
fields had the identical mislabeling bug (same capped-window value, called a "total") and are
renamed to `windowNullAsins`/`windowNullRows` for the same reason — a reader must never be able to
mistake a window for a total.

## DEFECT 2 — parent_asin scoping
Added optional `?parent_asin=` query param. Validated with `isValidParentAsin()` (10 alphanumeric
characters, case-insensitive input, upper-cased before use) — a malformed value returns
`400 { error: "parent_asin must look like an ASIN..." }` before any DB query runs. When present,
scopes the top-level select and both `countNullChildren` queries via `.eq('parent_asin', ...)`.
Absent = unchanged catalog-wide behaviour (verified by a dedicated test). Both dry-run and execute
responses carry `scope` (`parent_asin` value or `'all'`) so a caller can confirm which branch ran.

## New response shape
Dry-run:
```json
{
  "mode": "dry-run",
  "scope": "all | <PARENT_ASIN>",
  "windowNullAsins": 0,   // distinct ASINs in the capped fetch window — NOT a total
  "windowNullRows": 0,    // rows in the capped fetch window — NOT a total
  "trueNullRows": 0,      // real outstanding row count, uncapped (count:'exact', head:true)
  "trueNullAsins": 0,     // real outstanding distinct-ASIN count, uncapped (paginated)
  "wouldProcess": ["B0..."],
  "hint": "..."
}
```
Execute:
```json
{
  "mode": "execute",
  "scope": "all | <PARENT_ASIN>",
  "processed": 0,
  "filled": 0,
  "filledAsins": ["B0..."],
  "noColorFound": ["B0..."],
  "failed": ["B0..."],
  "trueNullRows": 0,      // real outstanding row count AFTER this batch, uncapped
  "trueNullAsins": 0,     // real outstanding distinct-ASIN count AFTER this batch, uncapped
  "hint": "..."
}
```
`remainingNull`, `totalNull`, `totalNullRows` are removed. Grepped the repo for other consumers of
this route's JSON shape (`backfill-child-color`) — none found outside this route file, the 072
migration comment, `childColorResolver.ts`'s doc comment, and this report; the route is
PO-triggered manually (curl / browser tab), so the rename is safe.

## Tests (13 new, `route.test.ts`)
- `isValidParentAsin`: valid ASIN, too-short/too-long/non-alphanumeric, lowercase-rejected (caller
  upper-cases first).
- `countNullChildren`: 1200 distinct null ASINs / 1500 rows (300 FBA+FBM twins) — more than
  PAGE_SIZE (1000) — proves `trueNullRows`/`trueNullAsins` survive paging past the cap; scoped vs
  unscoped counts on a 2-family fixture; zero-row fixture short-circuits with no page queries.
- `GET` handler: dry-run reports `mode`/`scope`/true counts and writes nothing (asserted on the
  underlying fixture rows, not just the response); a dedicated window-vs-true divergence test
  (1200 null ASINs, asserts `windowNullAsins === 1000` and `trueNullAsins === 1200` in the SAME
  response); `parent_asin` scopes `wouldProcess` to one family; absent `parent_asin` behaves as
  today; malformed `parent_asin` → 400; execute mode scoped by `parent_asin`, true counts computed
  after the batch, out-of-scope family proven untouched; a spy on `.update()` proving dry-run never
  calls it.
- **Falsification check**: temporarily reintroduced the OLD capped-window formula into
  `countNullChildren` (single unranged select, `trueNullRows = rows.length`), reran the suite —
  exactly the 2 tests targeting DEFECT 1 failed (`1000` vs expected `1200`/`1500`), all 11 others
  stayed green — then restored the fix and reconfirmed 13/13 pass. This is direct evidence the new
  tests actually detect the regression rather than passing vacuously.
- The in-memory fake Supabase query builder used by the tests reproduces PostgREST's real default
  max-rows cap (1000) on any select that never calls `.range()` — matching the mechanism that
  caused DEFECT 1 in production — so the "no `.limit()`" bug pattern is faithfully exercised rather
  than assumed away by the mock.

## Environment notes
- This worktree started with no `node_modules` (git worktrees don't share it); ran
  `pnpm install --frozen-lockfile` (39s, reused the shared pnpm store) before any test/tsc command
  would run.
- CI trap avoided at the root: `@/lib/supabase/server`, `@/lib/amazon/auth`, and
  `@/lib/amazon/catalogColor` are `vi.mock`'d entirely in `route.test.ts`, so the lazy Supabase
  client this repo's other tests worry about (real ~4s network attempt under `build.yml`'s
  placeholder env) never constructs. Supabase env vars are still nulled in `beforeAll` / restored
  in `afterAll` to match the established per-file hygiene pattern (`parentLockScope.test.ts`), even
  though it's provably redundant here.
- Did not attempt `next build` in this worktree per the brief's note that it fails on a Turbopack
  symlink error that's a worktree artifact, not a defect; `gh pr checks` (real CI, which does run
  the "build" step, and "Test (blocking)") is the actual gate and it passed.

## Brief vs code — line numbers checked
- `:54-58` (top-level select, `.is('color', null)` + `.order('asin')`, no `.limit()`) — **correct**,
  matched exactly.
- `:62-67` (dedup to `uniqueAsins`) — **correct**, matched exactly.
- `:111` (`remainingNull: uniqueAsins.length - filled.length`) — **correct**, matched exactly.
- `:93` (`.is('color', null)` idempotency guard on the update) — **correct**, matched exactly.
- `:90-94` (the update statement) — **slightly off by one**: the actual update statement (the
  `const { error: upErr } = await db...update...eq...is` block) spans lines 89-93; line 94 is the
  `if (upErr) failed.push(...)` that follows it, not part of the statement. Followed the code (kept
  the guard exactly where it was, on the actual `.is('color', null)` line) and note the discrepancy
  here per the brief's own instruction.

Everything else in the brief (defect descriptions, the 812→807 live evidence, the fix approach,
the constraints, and the test requirements) matched the code and was implementable as written.
