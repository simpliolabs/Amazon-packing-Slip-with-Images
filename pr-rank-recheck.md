## PO: "NOTHING is actionable here and doesn't tell me what the 1 high-opportunity gap is"

Two causes found:
1. The #164 stale-guard (correct in itself — stale coverage must never drive Ship/Regenerate buttons) suppressed the **entire actionable work-list** when content changed, leaving only the generic CAN/CAN'T-do bullets.
2. The "N high-opportunity gaps" chip **never named the keywords**.

## Fix

- **`GET /api/fba/rank-analysis/[asin]?refresh=free`** — recomputes the FREE coverage core live (**0 Jungle Scout credits, 0 OpenAI** — pure DB + coverage math), carries forward prior **paid** per-keyword SOV + council realities by keyword (the same merge `runCouncilAnalysis` does — a free re-check never wipes paid competition data), persists with the fresh fingerprint, returns `stale:false`. A `no_keywords` result is never persisted (won't cache-mask newly-synced keywords).
- **The stale chip is now a button**: `Content changed — Re-check now (free)` → coverage refreshes inline → the per-gap **Ship / Regenerate** work-list (from #160) returns immediately.
- **Gap keywords are named** in the expanded panel even while stale (labeled "as of last check") — the count chip is never a mystery again.

`tsc` exit 0. Self-adversarial: full upsert supplies every column (no DEFAULT-reset of paid data — the #154 trap); cache-read failure → fail-open to fresh core; concurrent re-checks idempotent; nested-interactive chip uses stopPropagation (noted tradeoff in commit).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
