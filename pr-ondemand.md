## What & why

The optimizer only scores the **top 50 parents by 30-day sales** (`syncListingContent` reads `parent_asin_rollup ORDER BY total_units_30d LIMIT 50`). Any listing below that — e.g. 0-unit **B0FKDDN44Z** (121 healthy children) and **B0GCPHGN4J** — gets **no `listing_seo_scores` row**, so it's absent from the optimizer index and its `/fba/listing/[asin]` page reads **"not available."**

There was **no no-code remedy**:
- **Regenerate** does `.update()` on `listing_seo_scores` (`ai-recommendations/route.ts:848`) — a no-op when the row doesn't exist.
- **"Sync Now"** (`/api/sync`) only calls `syncOrders()` — it never scores listing content.

## Fix

`ensureListingScored(supabase, parentAsin)` scores ONE parent from the `listing_content` we **already have** — DB only, **no Amazon calls, no Jungle Scout credits** — and upserts its `listing_seo_scores` row (mirrors the sync's upsert fields; representative child + 30d units fall back to the first child / 0 when there's no `parent_asin_rollup` row).

The index `GET` accepts `?ensure=<asin>`: if that asin isn't already in the ranked result, it's scored on the fly and appended. The listing page now passes `&ensure=<asin>`, so opening **any** listing scores it and the lookup resolves — regardless of sales rank.

## Scoped / safe
- `ensure` only runs when the asin is **not already** in the top set → **zero added latency for top sellers**.
- A never-synced listing with **no children** returns `null` → correctly stays absent (a true 0-live-children ghost, which the foundational ghost-filter is meant to exclude).
- DB-only on the page-load path: no SP-API calls, no credit spend.

## Verification
- `tsc --noEmit -p tsconfig.json` → 0 errors.
- Adversarial self-review: re-scores per visit (acceptable — DB-only, cheap, keeps the score fresh); top sellers unaffected; ghost listings stay excluded.
- Confirmed B0FKDDN44Z has 121 live children (verify-push) — the has-children-but-unscored class this fixes. B0GCPHGN4J's child state to be verified post-deploy.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
