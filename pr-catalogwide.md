## Catalog-wide child completion ("A") — scheduler-gated cron (batch 6/6)

#242 fixed the *"only 11 of 34 variants recognized"* bug **on-open** (reconcile the live family + backfill missing children when the seller opens a listing). **"A"** makes that proactive across the **whole catalog**, so families are complete *before* the seller opens them.

### Three parts
1. **Extract** the reconcile → `src/lib/fba/familyReconcile.ts :: reconcileFamilyChildren()`. Verbatim move of #242's logic (live VARIATION childAsins → re-attach stale-parent rows → backfill a minimal row per childAsin with no row, resolving childAsin→SKU via Listings Items). Self-sufficient; borrows a sibling's title as the placeholder so cron-created rows aren't blank-titled.
2. **Refactor** the #242 on-open path (`ai-recommendations`) to call the shared function — behavior preserved (same reconcile, same log lines). The on-open path and the cron now share **one** reconcile, so they can't drift (the two-paths asymmetry to avoid).
3. **New cron** `GET /api/fba/cron-complete-children`, mirroring `cron-verify-pushes` (#226): `CRON_SECRET` auth, `maxDuration=600`, a **4-min budget** that defers overflow to the next tick (reported, not silently dropped), parents from `listing_seo_scores` (one row/parent).

### Safe by design (you chose "build now, safe-by-default")
| Property | Guarantee |
|---|---|
| **Additive** | Only UPSERTs placeholder rows for genuinely-missing children — never overwrites/deletes content. Same upsert as the confirmed-working #242 path (a missing child's SKU resolves to its own ASIN → would already be a known row → can only CREATE). |
| **No credits** | SP-API only (Catalog Items + Listings Items) — zero Jungle Scout credits. |
| **Scheduler-gated** | **Not** in `vercel.json` (like `cron-verify-pushes`) → **OFF until you wire Coolify**. Merging runs nothing. |
| **Idempotent + budgeted** | A throttled/unreached parent is safely re-covered next tick. |

### ⚠️ Verification gap + canary
`tsc` **0** (extraction, route refactor, cron, `SupabaseClient` type all compile). **`node_modules` has no vitest in this sandbox**, so the prescribed vitest baseline could not run here — and this is the highest-blast-radius item. Before enabling the schedule, **canary it by hand** (read + additive-upsert only, safe):

```bash
curl -s -H "x-cron-secret: $CRON_SECRET" "https://slip.theceo.store/api/fba/cron-complete-children"
```

Confirm `children_backfilled` / `families_completed` look sane, **then** point the Coolify scheduler at it.

> **Follow-ups (noted, not blocking):** `last_reconciled_at` column for fair rotation on very large catalogs (v1 covers a typical POD catalog in one tick); SP-API 429 backoff (a throttled parent currently reads as 0-children in the summary).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
