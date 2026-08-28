# Catalog-color-source — implementation report

## Status
Implemented, tested, pushed. PR open (see below). NOT merged, NOT deployed. Worktree only touched
`C:\Users\Admin\AppData\Local\Temp\fba-wt-color`; `/tmp/fba-portal` and sibling worktrees untouched.
Amazon: READ ONLY throughout (getCatalogItem only — no PATCH/PUT/POST anywhere in the new code).

## Branch base
Local `main` in `/tmp/fba-portal` was 2 commits behind `origin/main` (missing migration 071, which
this brief itself cites as "highest, applied"). Worktree was created from `origin/main` (693ab2b)
instead of local `main` (61f5cbd) so the branch and migration 072 build on the real HEAD without
touching `/tmp/fba-portal`'s checkout to fast-forward it.

## What shipped
- `supabase/migrations/072_child_catalog_color.sql` — `listing_content.color text`, idempotent,
  commented, `NOTIFY pgrst`. NOT YET APPLIED (PO applies by hand, per repo convention).
- `src/lib/amazon/catalogColor.ts` — `fetchCatalogColor(asin, token)`, READ ONLY.
- `src/lib/fba/spApiRateLimiter.ts` — new `spApiCatalogReadBucket` (2 rps / burst 2).
- `src/lib/fba/childColorResolver.ts` — `resolveChildColor({asin, sku, title, storedColor})`,
  precedence catalog → decodeSkuColor → null, returns `{color, source}`.
- `src/lib/fba/skuColorCodes.ts` — comment-only pointer to the new resolver; `decodeSkuColor`
  logic untouched.
- `src/lib/fba/listingPipeline.ts` — `backendOutputProblems` given `export` only (visibility for
  testing); zero logic change.
- `src/app/api/fba/listing-optimizer/ai-recommendations/route.ts` — `color` added to `contentCols`
  + `ChildRow` (column-safe retry ladder for pre-migration DBs); `extractColor` now calls
  `resolveChildColor`; both call sites pass `asin`/`storedColor`; new best-effort colour-source
  diagnostic log line.
- `src/app/api/fba/admin/backfill-child-color/route.ts` — dry-run/execute, batched (≤50),
  idempotent, READ-ONLY against Amazon.
- Tests: `childColorResolver.test.ts` (8 tests), `childColorDegradeGate.test.ts` (2 tests, proves
  the gate stops firing against the real `backendOutputProblems`).

## SP-API field used for colour
`ItemSummaryByMarketplace.color` (`summaries[].color`) from `getCatalogItem(asin, [marketplaceId],
{includedData: ['summaries']})` — a direct, documented, per-marketplace string field ("The color
that is associated with the Amazon catalog item"), confirmed against the installed
`@sp-api-sdk/catalog-items-api-2022-04-01@4.2.12` type model. NOT `attributes` (untyped,
product-type-schema-dependent bag) — `summaries` is the cheaper, typed, directly-named field.

## Rate-limit choice
Dedicated `spApiCatalogReadBucket` (2 requests/sec, burst 2) in `spApiRateLimiter.ts`, gated inside
`fetchCatalogColor`. This is NOT shared with the existing `spApiReadBucket` (5/5, calibrated to
`getListingsItem`): the installed SDK's own type doc states `getCatalogItem`'s usage plan is
"2 | 2" — a THIRD of the 5/5 plan — and `syncParentAsins.ts`'s existing comment independently
confirms "2 requests/sec for searchCatalogItems" (same Catalog Items API family). Sharing the 5/5
bucket would let a Catalog Items burst exceed what Amazon actually grants this operation — the
exact class of concurrent-call 429 `spApiRateLimiter.ts`'s own header names as the reason it exists
(task #23). The backfill route needs no extra external `sleep()` — the bucket is acquired inside
`fetchCatalogColor` itself, so pacing holds regardless of caller.

## Test numbers
- Baseline (`origin/main` 693ab2b, `npx vitest run --no-cache`, placeholder env matching
  `build.yml`): **92 test files passed (92) / 1757 tests passed | 4 expected fail (1761 total)**.
- Final (same command, after all changes): **94 test files passed (94) / 1767 tests passed | 4
  expected fail (1771 total)**. Delta: +2 files, +10 tests, **zero regressions**, same 4
  pre-existing expected failures.
- `npx tsc --noEmit`: clean before and after.
- Lint: 6 pre-existing warnings/1 pre-existing error in `listingPipeline.ts` /
  `ai-recommendations/route.ts`, all outside my diff (verified via `git diff 693ab2b`) — CI lint
  step is non-blocking (`continue-on-error: true`) regardless.

## Brief lines that were WRONG (or needed adjustment)
1. **Worktree base**: brief said branch from `main`; local `main` was stale (2 commits behind
   `origin/main`, missing migration 071). Branched from `origin/main` instead — noted above.
2. **`resolveChildColor({ asin, sku, title })` signature**: the brief's shown signature has no way
   to receive the stored catalog colour, which is required for the precedence rule to mean
   anything. Added a `storedColor` field and kept the resolver a PURE, synchronous function fed
   from the ONE query the route already runs (`listing_content.color`), rather than having the
   resolver do its own per-child Supabase lookup (which would be an N+1 query per family per
   regen — against this file's own repeated "ONE query for the whole batch, not one per row"
   doctrine). `asin` is kept in the signature for caller/log/test traceability as shown, but the
   precedence logic itself depends only on `sku`/`title`/`storedColor`.
2b. **`syncParentAsins.ts:184`**: the `listing_content` write is actually at line 195 in the
   current file (11-line drift), but the claim itself — `listing_content` is the per-child table
   the optimizer reads/writes, keyed by child `asin` — is CORRECT and confirmed directly against
   `ai-recommendations/route.ts`'s own query.
3. **`productDetailAttrs.ts:119`**: EXACT — `'color': { spApiKey: 'color', scope: 'per-variant' }`
   is verbatim at line 119 in the current file. This one line reference was correct.
4. **`sp-api-client.ts:121` `getCatalogItemsClient()`**: exists as described, but has ZERO
   existing callers anywhere in the repo. Its `getCatalogItem` wraps a SEPARATE credential-loading
   path (`SellingPartnerApiAuth`) that duplicates `auth.ts`'s `getAccessToken()`, which EVERY other
   Catalog Items read in this repo already uses via plain `fetch()` (`catalogImage.ts`,
   `syncListingContent.ts`'s `fetchImageCount`/`fetchListingContent`). Used the proven raw-fetch
   pattern instead (`catalogColor.ts` mirrors `catalogImage.ts` exactly), for consistency with the
   90%-established convention rather than the zero-caller SDK path the brief pointed at. The field
   itself (`ItemSummaryByMarketplace.color`) is unaffected by this choice — same REST response
   either way.
5. **Migration 071 "highest applied"**: correct and independently confirmed via
   `ls supabase/migrations/` — 072 was the right next number.
6. Everything else checked (the degrade-gate message text/shape in `listingPipeline.ts:~840`, the
   `decodeSkuColor` fallback chain in `skuColorCodes.ts`, migration 011's SKU-parsing precedent,
   the single external caller of `decodeSkuColor`) matched the brief as written.

## Known follow-up (not in scope, flagged not fixed)
`listingPipeline.ts`'s per-color backend BYTE-BUDGET sizing (`KNOWN_COLOR_NAMES`/`tailColors`
around line 5343) checks a resolved `.color` value against `SKU_COLOR_CODES`'s value list OR
`BASIC_COLOR_WORD_RE` before deciding whether to reserve tail bytes. It does NOT gate the degrade
check (untouched, still reads `.color` directly) but a catalog colour whose exact wording doesn't
match either list (e.g. an unusual Amazon-side colour string) could under-size the byte budget.
Out of scope for this task (orthogonal to the degrade-gate freeze) and not touched, per
KARPATHY-surgical / no-scope-creep.
