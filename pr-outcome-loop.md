## Outcome loop (#89) — per-keyword SQP share time-series → next-regen signal

> ⚠️ **REQUIRED before deploy:** apply `supabase/migrations/023_keyword_share_snapshots.sql` (same step as 021/022). The capture/read degrade gracefully if the table is absent, but the loop only starts accruing history once it exists.

The **SQP-primary** outcome loop, built in one sweep as requested. It captures per-keyword impression-share over time, derives a **rose/flat/fell** signal anchored to content changes, feeds it as a **conservative tiebreak** into title-candidate selection, and surfaces an honest line in the rank panel.

| Phase | What it does |
|---|---|
| **Capture** | `migration 023` (`keyword_share_snapshots`, one row per keyword per SQP data-month) + `shareSnapshots.ts`. Snapshots each report's normalized 0–100 share + a content fingerprint. SQP-only (inherited/JS share=0 skipped); **fresh-fetch-only** (a cache hit would mislabel a stale-month report); best-effort. |
| **Signal** | `outcomeSignals.ts` → rose/flat/fell, with the **insufficient-data guard** (`<2` monthly snapshots OR `<100` volume → no signal) and the **non-content-bottleneck** rule (content changed but share didn't move → reviews/price/velocity, not more copy). |
| **Feedback** | A **tiebreak** in `selectTitleCandidates` — reinforce rising keywords, de-prioritize stalled ones. Secondary to `opportunityScore`: only reorders ties, never across tiers, never drops a keyword. **Strict no-op** when signals are empty. |
| **UI** | Rank panel shows a server-authored, `sanitize()`-clamped line. Renders nothing until history exists. |

### The honest reality (must be said)
This is the **machinery**. It produces **zero signal until ~2 monthly SQP snapshots accrue across a content change** (SQP is monthly). The insufficient-data guard guarantees nothing misleading shows before then. What ships now **starts the clock**.

### Honesty
Strings only assert correlation (*"rose AFTER a change"*), never causation, and pass the existing over-promise validator (no "rank #1" / "outrank" / "best seller" / "page one"). Verified in `verify-outcome-signals.mjs` (incl. a negative control).

### Adversarial review → 2 findings, both fixed before push
- **(med)** a month-boundary cache hit could mislabel a stale-month report under a new-month `snapshot_date` → capture now fires **only on a fresh SQP fetch**.
- **(low)** a non-deterministic sibling-content fallback could flip the fingerprint → the sibling query is now **ordered** (deterministic), so the fingerprint is stable.

### Verification
- `tsc` exit 0 · `verify-outcome-signals.mjs` **13/13** · `verify-rank-honesty` + `verify-bullet-coverage` still green.

### Deferred (intentional)
A scheduled monthly SQP-refresh cron — a cron adds **no** history within a month (SQP is monthly), so v1 relies on manual / Intelligence-tab syncs to accrue the series. A monthly batch cron can be added later.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
