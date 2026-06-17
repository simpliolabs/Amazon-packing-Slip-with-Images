## Bullets role-word plan gap + outcome-loop monthly refresh cron

Two small post-sweep follow-ups — one correctness gap the bug audit surfaced, one the requested cron.

### 1. Bullets role-word plan gap (fixes a "can't reach max" residual)
`topOpportunityKwsForBullets` (= `keyword_plan.bullets`, which the scorer reads per #161) had **no role-word filter**. So a keyword like **"later gator teacher shirt"** stayed in the *bullet* plan → the scorer **docked bullets** for it, but the bullet agent's role-leak strip + the coverage backstop's `safeKw` both correctly **refuse** to put a profession word ("teacher") in a bullet → the bullets could **never** carry it → bullet score could never reach max. This is the residual behind "bullets still can't hit perfect" after #160/#161.

**Fix:** role-word keywords (whose role token isn't in the title) are dropped from the bullet plan and rank via the **backend** pool instead — so the plan equals what the generator can actually place. Verified live earlier: "later gator teacher shirt" was in the post-#161 bullets miss-list; it will now route to backend.

### 2. Outcome-loop refresh cron (the requested #89 cron)
New `/api/fba/cron-keyword-sync`: refreshes ASINs whose SQP cache is stale (>30d) → fresh fetch → a new `keyword_share_snapshots` row. Time-budgeted (a single SQP report is 5–8 min), auth mirrors `cron-sync` (`Bearer CRON_SECRET` or `x-cron-secret`), `maxDuration 800`.

**Why monthly cadence (answering your question):** Amazon publishes SQP **once per month**, so the rose/flat/fell **signal can't update faster than monthly** — a weekly fetch re-pulls the *same* report and the snapshot dedups (`UNIQUE asin,keyword,snapshot_date`). The cron runs **frequently anyway** (`0 */3 3-9 * *` — every 3 h on days 3–9, after Amazon publishes prior-month data) **only to spread the slow per-ASIN fetches** across the early-month window, since one invocation can't fetch a whole catalog. **More frequency = faster catalog coverage, not a faster signal.** If you want genuinely *faster directional* feedback, that's the Jungle-Scout organic-rank co-signal (separate, costs credits) — say the word.

> **Platform note:** `vercel.json` crons fire on Vercel. **On Coolify**, wire a scheduled task / external cron (e.g. cron-job.org) to GET this endpoint with the `x-cron-secret` header — same dependency as the existing `cron-sync`. Requires `CRON_SECRET` set.

### Verification
`tsc` exit 0 · `verify-bullet-coverage` 9/9 · `verify-outcome-signals` 13/13 · `verify-rank-honesty` 21/21+10/10.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
