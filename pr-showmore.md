## Optimize more than your top 10 best-sellers

The dashboard's Listing Optimizer was hard-capped to the **top 10** best-selling parent ASINs — the route fetched 20, filtered ghost parents, and `slice(0, 10)`. You asked to display + optimize more than that.

- **Route**: `GET /api/fba/listing-optimizer?limit=N` (default **25**, clamp 1–200, 2× headroom so ghost-filtering never starves the count) + a `hasMore` flag.
- **Dashboard**: defaults to 25, with a **"Show more sellers (next 25) →"** button that extends the same list. Heading now reads "ranked by 30-day sales · showing N".
- Ranking is unchanged — still by 30-day sales, so the highest-impact listings always lead; "Show more" just reaches further down.

`tsc` exit 0, no migration. Pure additive (default goes 10 → 25, with on-demand more).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
