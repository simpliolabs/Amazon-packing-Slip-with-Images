## What & why

**[#260](https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/pull/260)'s update-only gate is over-skipping every 0-unit listing.** Ship Bullets on `B0FKDDN44Z` reported *"Pushed 0/0 variants, 121 skipped (Missing offer/incomplete)"* — but verify-push had already confirmed all 121 children are **readable live** on Amazon. The gate was wrong.

## Root cause

#260 filtered `listing_health` by BOTH `sku-target-set` AND `.eq('parent_asin', parentAsin)`. But `listing_health.parent_asin` is backfilled separately by `syncTrafficReport` from the Sales-&-Traffic report. A **0-unit listing has no rows in that traffic report**, so its `listing_health.parent_asin` stays `NULL`. The gate's parent_asin filter then matched **zero** SKUs → every child flagged `notLive` → every child skipped, even though all 121 are real Active listings.

## Fix

Drop the redundant `.eq('parent_asin', parentAsin)`. Gate by `.in('sku', targetSkus)` + `.eq('status', 'Active')` only. The push targets **already** came from `listing_content WHERE parent_asin=X` — the parent linkage is established at that layer. The gate's job is "is this SKU a real live Amazon listing?", which the SKU-keyed query answers correctly regardless of whether the stale `parent_asin` column has caught up.

Original intent (phantom-protection via SKU liveness) is preserved exactly:
- Empty target list → short-circuits without a query.
- DB error → `activeSkus=null` → no over-skip (push availability preserved).
- True phantom (no `listing_health` entry, e.g. from `familyReconcile` backfill of an offerless SKU) → still correctly `notLive`.
- Parent SKU exempt — unchanged.
- Inactive/suspended listings — still skipped (same as #260).

## Why this happened
This is the `dont-overgeneralize-specific-failures` pattern from memory: #260 added a redundant defense (parent_asin filter on top of the SKU set) that ended up blanket-disabling pushes for the entire 0-unit listings cohort — exactly the rule that was supposed to catch this kind of overreach. My adversarial review missed it because I tested only the phantom-creation case, not the 0-unit pushability case. Scope tightened to exactly the original intent.

## Verification
- `tsc --noEmit -p tsconfig.json` → 0 errors.
- Surgical: 1 file, +20/-8.
- Affects only the gate predicate — no change to push semantics, error paths, or the parent's broadcast row.

## Test plan after deploy
- [ ] Ship a field (bullets/title) on `B0FKDDN44Z` (0-unit, 121 children) — should now push ~121 variants instead of skipping them.
- [ ] Ship a field on `B0F6QZ34B1` (39 units, 22 children, top-50 ranked) — must still work as before.
- [ ] Re-verify `B0GHH4MQ7N` — should still correctly skip the 3 not-yet-live children (S-PNK/S-LIL/S-GRY) until you complete their offers.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
