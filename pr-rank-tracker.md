## The rank tracker — your H10 Keyword-Tracker replacement, JS-only

> PO: "I am cancelling the account so JS is the only one you should rely on. Why don't you also import OUR ranking Keywords and create a column for it that we can track over time?"

Jungle Scout measures our organic rank per keyword — the engine was **discarding it**. Now it's a column you can watch move.

### What ships
- **Phase 4b** in the research pipeline: `keywords_by_asin` on **OUR ASIN** (+1 credit → research = 4 total). Adversarial self-catch during build: the existing Phase-4 rows carry the **competitor's** ranks and niche rows carry none — snapshotting those as ours would have been false data. Ranks now overlay by keyword (competitor ranks explicitly cleared), and **our-only ranked keywords join the pool** — which is literally "import OUR ranking keywords". Since JS returns *every* keyword an ASIN ranks for, absence after the overlay genuinely means "not ranking".
- **Migration 026**: `keyword_analysis.organic_rank` (current value) + `keyword_rank_snapshots` (daily series; `NULL` = checked-but-not-ranking, so the history shows when you enter/leave the rankings). Same best-effort contract as the share snapshots — a missing table never breaks a sync.
- **"Rank" column** in the Intelligence tab: `#12 ▲6` (green = improved vs the previous check), `▼` red when dropped, **`new`** badge when newly ranking, `— (was #8)` when dropped out, `—` never ranked. Trend comes from the snapshots via the intelligence GET (one bounded query, best-effort).
- Engine/storage plumbing end-to-end (normalizers, `AnalyzedKeyword.organicRank`, store/read, missing-column retry guard now covers both 025 and 026 columns).
- Re-research button + tooltips updated to **4 JS credits**.

### Requires
Run `supabase/migrations/026_keyword_rank_tracking.sql` (idempotent — column + snapshots table + RLS).

`tsc` exit 0.

### How it accrues
Every **Re-research** (4 credits) snapshots that day's ranks. Run it weekly per priority family and the arrows + history build themselves — rank movement after each content ship becomes visible right in the keyword table.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
