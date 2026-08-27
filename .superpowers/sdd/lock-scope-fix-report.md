# Parent-lock-freezes-children fix — report

## Status

Code complete, committed, pushed. PR open.

## The defect (verified against the actual code, not re-derived)

`src/app/api/fba/listing-optimizer/ai-recommendations/route.ts` — every brief line number checked
out exact against the checked-out `main` (61f5cbd): the build at `:1614-1620`, the stored-row select
at `:1663`, the `locked` check at `:1676-1677`, the overwrite at `:1704-1705`, the persist at
`:1864`, the `:1829-1830` comment, the `:1822`/`:1831` downstream reads, and the `lockCheckFailed`
sibling at `~:1729-1731`/`~:1861-1865` — all matched the brief verbatim (line numbers shifted by the
extraction below, but the pre-fix text was identical). `listingPipeline.ts:2337` and `:11697` and
`lockedTitleTruth.ts:4-10` also confirmed as cited (read-only — that file is off-limits this branch).

`lock-title/route.ts` writes only `{title_source, recommended_title}` — the manual lock is
PARENT-scoped. The full-regen path's manual-lock guard nonetheless overwrote the freshly-computed
`rec.per_child_titles` with the STORED (prior-run) array whenever the parent was locked, on every
regen, forever — `generated_at` still advanced so the row looked fresh while per-child bytes were a
straight copy-back.

## The fix

One behavioral line removed, one line added in its place:

```diff
-              if (Array.isArray(keptPct) && keptPct.length) rec.per_child_titles = keptPct as typeof rec.per_child_titles
+              rec.per_child_titles = resolveLockedFullRegenPerChildTitles(keptPct, rec.per_child_titles) as typeof rec.per_child_titles
```

`resolveLockedFullRegenPerChildTitles` (new, top-level, exported) is an unconditional pass-through of
the fresh array — `keptPct` (the stored array) is now unused by the decision, retained only as an
input name for documentation/testability. Everything else in the guard block (the parent
`recommended_title` scrub-and-keep, `titleSourceOut = 'manual'`) is untouched. The block-level doc
comment above the guard and the `lockCheckFailed` dbPayload-omission comment were both updated to
state the current, correct scope — the old comments described the bug as if it were intended
behavior.

The log line was reworded from "kept the seller's title" (ambiguous — implied children too) to
"kept the seller's PARENT recommended_title ... (lock is parent-scoped only; per_child_titles
refresh from this run's pipeline output)".

Function is exported ONLY for direct unit testing (Next.js's route convention ignores exports that
aren't its reserved handler names, so this costs nothing in production) — the same "export the
producer, don't mock the whole call graph" doctrine `parentTitleValidateRetry.test.ts` already
established in this repo for testing a route-embedded decision in isolation.

## Downstream-read check (requested in the brief)

Grepped every `per_child_titles` reference in the file. Two reads between the guard and the persist:

- `:1822` `shipTitles` (builds the persist-boundary Item-Highlight re-net's title list from
  `rec.per_child_titles`) — this net's whole purpose is to key Item Highlights against "the titles
  that actually ship." Post-fix, `rec.per_child_titles` IS what ships (fresh), so this net becomes
  MORE correct, not divergent — pre-fix it was netting against stale titles that also happened to be
  what shipped (self-consistent then, self-consistent now, just against different bytes).
- `:1831` `applyBlankBrandNetPerDesign(rec.per_child_item_highlights, rec.per_child_titles, blankRow)`
  — same reasoning; its own adjacent comment already anticipated `rec.per_child_titles` could be
  either the prior or this run's array ("the lock-preserve above may have restored the PRIOR
  per_child_titles over this run's").

Neither depends on the STORED array specifically — both key off "whatever is about to ship," and the
fix makes "about to ship" correct. No divergence found; safe to remove the overwrite.

One additional effect found and verified safe: `contentReconcile.ts`'s `decideReconcileFields`
already special-cases `if (f === 'title' && opts.titleLocked) return false` — auto-push of the title
field is blocked whenever `titleLocked` is true, REGARDLESS of the `changed` flag computed at
`:1973` (`jsonChanged(dbPayload.per_child_titles ?? null, priorPerChildTitles)`). So even though
`per_child_titles` now legitimately reads as "changed" on every regen of a locked family, no new
auto-push is enqueued — the reconcile hook's own lock gate already covers this.

## `lockCheckFailed` sibling path — decision + reasoning

Left AS-IS (fail-safe / touch nothing when the lock/prior read errors), now with an explicit comment
documenting it as a deliberate choice, not an accident of the original conflation:

- `per_child_titles` was never actually governed by the lock (that conflation IS the bug just fixed),
  so gating it behind `lockCheckFailed` is a narrower, rarer version of the same false coupling.
- But: an unreadable lock/prior read is a transient failure (DB blip) that self-heals on the very
  next successful regen — unlike the main bug, which froze every locked family's children on EVERY
  regen, forever, with no self-heal.
- Widening this in the same PR as the primary fix would be a second, untested behavior change with
  no live repro of this specific branch, against the surgical/minimal-diff mandate.
- Verdict: leave it fail-closed. Revisit if a live case of `lockCheckFailed` freezing children is
  ever observed (it would now be a MUCH rarer trigger than before — the common path is fixed).

## Tests

New file: `src/app/api/fba/listing-optimizer/ai-recommendations/parentLockScope.test.ts` (11 tests).

**TDD proof (real, not reconstructed):** the function was written FIRST as an unconditional
pass-through (the fix), then TEMPORARILY reverted to the exact pre-fix conditional
(`if (Array.isArray(storedPerChildTitles) && storedPerChildTitles.length) return storedPerChildTitles`
— verbatim mirror of the removed `route.ts` line) to capture real failing output, then restored.

**Failing output BEFORE the fix** (2 of 3 core tests failed, run against the reverted function body):

```
 ❯ src/app/api/fba/listing-optimizer/ai-recommendations/parentLockScope.test.ts (3 tests | 2 failed) 9ms
     × a full regen on a locked-parent family persists the FRESH per-child titles, not the stale stored ones
     × the fresh family-unisex title no longer carries the stale "for Men" assertion

AssertionError: expected [ { sku: 'SKU-A-M', …(2) }, …(1) ] to deeply equal [ { sku: 'SKU-A-M', …(2) }, …(1) ]
-     "title": "THE CEO Later Gator Graphic Tee | Comfort Colors Alligator Shirt Unisex",
+     "title": "THE CEO Later Gator Graphic Tee | Comfort Colors Alligator Shirt for Men",

AssertionError: expected 'the ceo later gator graphic tee | com…' not to contain 'for men'
Expected: "for men"
Received: "the ceo later gator graphic tee | comfort colors alligator shirt for men"

 Test Files  1 failed (1)
      Tests  2 failed | 1 passed (3)
```

**After the fix — full new-file run:**

```
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Test coverage, matching every brief requirement:
1. Regression: fresh per-child titles persist over stale stored ones (reproduces B0DSCDZC6K shape —
   family unisex lean drops "for Men", a per-design female lean adds "for Women").
2. Content assertion beyond bytes: no stale "for Men" survives; LENGTH `>= 65` asserted on every
   title (brief: "three live failures this week passed content-only acceptance").
3. Genuine pass-through proof (null/empty/undefined stored array — decision never branches on it).
4. Parent-lock-still-works: the exact `scrubCelebrityNames(scrubTrademarks(...))` composition the
   guard runs on `recommended_title`, proving a clean locked title survives byte-identical and
   `title_source` stays `'manual'` — mirrors `lockTitleShipDoor.test.ts`'s established idiom for this
   composition (not duplicated; that file doesn't cover per-child titles).
5. Title-section path unchanged: encodes the exact, untouched gating expression
   `locked && regenerate_section !== 'title'` and proves it still holds for full/bullets/description
   regens and still excludes an explicit title regen.
6. Wiring / "prove the branch ran" (source-pin idiom, precedented by `councilGarmentTruth.test.ts`,
   since a full OpenAI+Supabase+pipeline-mocked `POST()` call is out of proportion to what a source
   pin already proves): asserts the real `route.ts` source calls the tested function at the real call
   site, asserts the OLD bare-overwrite line is GONE (not shadowed), asserts the updated HELD log
   line's actual text, and asserts the lock-hold condition itself is byte-identical to before.

CI-trap hygiene: `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
nulled in `beforeAll`, restored in `afterAll` — matches this repo's established per-file pattern
(`gatePerChildMultiDesign.integration.test.ts`, `parentTitleValidateRetry.test.ts`) for importing a
module that transitively pulls in `listingPipeline.ts`'s lazy-Proxy Supabase clients.

## Baseline vs final

Baseline, `main` (61f5cbd), `npx vitest run --no-cache`, run in the UNMODIFIED `/tmp/fba-portal`
checkout:

```
 Test Files  89 passed (89)
      Tests  1708 passed | 4 expected fail (1712)
```

Final, this branch, `npx vitest run --no-cache`:

```
 Test Files  90 passed (90)
      Tests  1719 passed | 4 expected fail (1723)
```

Delta: +1 file, +11 tests (exactly the new file), 0 change to the "expected fail" count, 0
regressions. `npx tsc --noEmit`: clean (no output). `npx eslint` on both changed files: 2
pre-existing warnings at `route.ts:304` and `:678` (`emptyMsg`, `brandAnchorKeyword` unused) —
confirmed present on `main` too (at `:304`/`:658`, before the +20-line insertion shifted the second
one), unrelated to this change, zero new warnings.

## Files touched

- `C:\Users\Admin\AppData\Local\Temp\fba-wt-lockscope\src\app\api\fba\listing-optimizer\ai-recommendations\route.ts`
- `C:\Users\Admin\AppData\Local\Temp\fba-wt-lockscope\src\app\api\fba\listing-optimizer\ai-recommendations\parentLockScope.test.ts` (new)

Untouched (confirmed by `git status --short` before commit): `titleBand.ts`, `contentTruth.ts`,
`listingPipeline.ts`, `blankSpecs.ts` — nothing outside the two files above changed.

## Brief line numbers — accuracy check

All cited line numbers (`:1614-1620`, `:1663`, `:1676-1677`, `:1704-1705`, `:1864`, `:1829-1830`,
`:1822`, `:1831`, `lockCheckFailed` `~:1729-1731`/`~:1861-1865`, `listingPipeline.ts:2337`, and
`lockedTitleTruth.ts:4-10`) matched the actual code on `main` exactly. `listingPipeline.ts:11697` was
off by ~1-3 lines (the cited comment text lands at approximately `:11695-11698`, same paragraph,
same file) — a rounding difference, not a wrong citation. No brief line number was substantively
wrong this time.
