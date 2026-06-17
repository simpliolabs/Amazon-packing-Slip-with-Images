## What & why

A title push to the **established** family `B0GHH4MQ7N` created **6 brand-new incomplete "Missing offer" ASINs** on the live Amazon account — top of Seller Central's *Date Created: New to Old*, orphaned (no parent link). The PO caught it.

**Root cause:** the family backfill (`familyReconcile`, #242/#250, runs on every open/regen) inserts blank `listing_content` rows for **offerless** catalog-variation children, and the push PATCHes every `listing_content` row with no "is this a live listing?" check. A `patchListingsItem` to a SKU with no offer is treated by Amazon as *create-or-match*, so it **mints a junk listing** (and returns *"…not complete enough to find a matching ASIN or create a new one"*).

## Fix — two guards, scoped to the offerless case (healthy children unaffected)

1. **Push is UPDATE-ONLY.** `loadDiff` tags any row whose SKU is not `Active` in `listing_health` — the *same* predicate `syncListingContent` uses to enumerate children — as `notLive`. `executePush` skips them on **both** the full and selective paths and reports them (`"N skipped — not a live listing yet; complete the offer, then re-push"`) instead of creating. The variation parent is exempt (its push is intentional; `summarizePush` already treats a parent rejection as a non-blocking note). On a DB error `activeSkus` is `null` → no over-skip (push availability preserved); guard 2 backstops. Also stops the FBM-twin enrichment from probing non-live ASINs so a phantom-adjacent twin can't slip back in untagged.
2. **Backfill is OFFER-GATED.** `familyReconcile` requests `includedData=offers` and skips children with no live offer, so offerless rows are never seeded into `listing_content` in the first place.

Net: structurally impossible for a content push to create an Amazon listing, regardless of what is in `listing_content`.

## Verification
- `tsc --noEmit -p tsconfig.json` → 0 errors.
- Adversarial review caught + fixed a twin-probe leak (the FBM-twin enrichment was probing every ASIN incl. non-live ones; discovered twins are added untagged).
- The gate reuses the existing `Active` predicate, so it can only drop rogue backfilled rows — never a normally-synced child (those are sourced from `listing_health` Active).

## Follow-up (not in this PR)
- One-off DB purge of the 3 deleted phantom rows for `B0GHH4MQ7N` (`TCEO-GEN X-TS-XS-RED/-XS-GRY/-XS-DKG`) — handed to the operator.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
