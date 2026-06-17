## What & why

**#260 was over-strict via `parent_asin`. #262 was over-strict via `status='Active'`.** Both rejected healthy listings whose status string isn't the literal `'Active'`. Despite #262 deploying live (Coolify commit `33f08f7`, 2026-06-16 19:44 UTC), `B0FKDDN44Z` Ship Bullets still reported *"Pushed 0/0 variants, 121 skipped"*.

## Root cause (verified)

`listing_health.status` is the **verbatim value from GET_MERCHANT_LISTINGS_ALL_DATA** (syncListings.ts:216):
```ts
const status = row['status'] || 'Unknown'
```

Amazon classifies:
- **Print-on-demand qty=0 children → `'Inactive'`** (still real, PATCH-able)
- **Freshly-created variations → `'Unknown'`** (the fallback fires when Amazon's report carries an empty status)
- Genuinely broken → `'Suppressed' / 'Missing Offer' / 'Incomplete' / 'Missing Information'`

Both 'Inactive' and 'Unknown' are **healthy from Amazon's PATCH perspective**, but `.eq('status', 'Active')` rejected them. Live ground truth: verify-push (Listings API direct) confirmed all 121 children of `B0FKDDN44Z` are real readable Amazon listings (total=121, matched=107, stale=14, parentSkipped=1).

## Fix

Drop `.eq('status', 'Active')`. Gate by **presence** in `listing_health` + a **deny-list** of the app's own canonical "broken" statuses (the same list `listing-issues` enumerates):

```ts
const NON_PUSHABLE_STATUSES = ['Suppressed', 'Missing Offer', 'MissingOffer', 'No Offer', 'Incomplete', 'Missing Information', 'MissingInformation']
.in('sku', targetSkus)
.not('status', 'in', `(${NON_PUSHABLE_STATUSES.map((s) => `"${s}"`).join(',')})`)
```

`'Inactive'` is **NOT** in the deny-list — POD qty=0 listings remain real and pushable. The actionable Inactive sub-cases (suppressed / detail page removed / etc.) are demuxed by `status_message` from the separate inactive-listings report.

## Phantom protection — counter-checked

The original `B0GHH4MQ7N` phantom vector: `familyReconcile` (pre-#260) seeded blank `listing_content` rows for offerless catalog children. Those SKUs never had a live offer → never appeared in GET_MERCHANT_LISTINGS_ALL_DATA → **never got a `listing_health` row**. With presence-only gating, they're still absent from `activeSkus` → still `notLive` → still skipped. Vector remains closed.

Belt-and-suspenders: `familyReconcile`'s offer-gate (added in #260) refuses to seed offerless rows on the WRITE side too.

## Honest accounting — third patch on the same gate

I missed this in adversarial review for both #260 and #262. The pattern (over-restricting beyond the actual phantom-protection need) is now in memory and the new predicate matches the app's own existing taxonomy from `listing-issues` — convergent with how the rest of the codebase already defines "not pushable".

## Verification
- `tsc --noEmit` → 0 errors
- 1 file, +21/-8 surgical
- Phantom case (B0GHH4MQ7N XS-RED/XS-GRY/XS-DKG): no listing_health row → still rejected ✓
- POD Inactive (B0FKDDN44Z TCEO-HIHSM-*): has row, status NOT in deny-list → matched → pushable ✓
- Suppressed/Missing Offer: has row, status IN deny-list → not matched → skipped ✓

## Test plan
- [ ] Ship a field (bullets/title) on `B0FKDDN44Z` post-deploy → should push ~121 variants
- [ ] Ship on `B0F6QZ34B1` (the multi-design fishing tee family) → 22 variants push
- [ ] Re-verify `B0GHH4MQ7N` post-deploy → 3 still-incomplete children (S-PNK/S-LIL/S-GRY) still correctly skipped until offers completed

🤖 Generated with [Claude Code](https://claude.com/claude-code)
