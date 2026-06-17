## Rank verdict atop the Apply tab — Integration A, increment 1

You asked to bake the rank insight **into** the suggestions, not a side tab. This surfaces the honest **"Rank Top of Amazon"** verdict as a collapsible banner at the **top of the Apply Changes flow** — so *"what content can and can't do for rank"* reaches the seller exactly where they act.

### What it does
- Adds a **0-cost** `GET /api/fba/rank-analysis/[asin]` co-fetch (mirrors the existing `aiRecs`/`kwData` fetches — 0 JS credits, 0 OpenAI; resolves parent→child server-side).
- Renders a **collapsible** banner — collapsed: headline + coverage pill + high-opportunity-gap count; expanded: **Content CAN do** / **Content CAN'T do** + the honest note.
- **Renders ONLY server-authored, validator-clamped strings** (`verdict.*`) — no new client rank copy, no new server fields, no migration → **no new over-promise risk** (the server's banned-phrase validator still governs every rank claim).
- Clears on ASIN change (cancelled-guard) so it can't flash the previous listing's verdict; defensive `?? []`; renders nothing for no-keyword listings.
- The standalone Intelligence-tab panel is **unchanged** (it stays the competition/SOV + full-playbook drill-down).

### ⚠️ Scope note — per-suggestion chips deferred (deliberately)
The design council proposed per-suggestion "content-winnable / content-done" chips. The think-before-coding pass caught that the mechanism is **ill-defined**: it maps via `row.coveredIn`, but an *uncovered* keyword (the winnable case) has **empty `coveredIn`** — so the winnable chip can never fire and "done-here" fires spuriously. The winnable/done signal is **content-level (global)** and already conveyed by the verdict. A *correct* per-suggestion design (the `keyword_reconciliation.placed_in` join, or the #89 per-keyword data) is a tracked follow-up — better than shipping a broken chip.

### Verification
- Adversarially self-reviewed; `tsc --noEmit` clean.
- **Live-verify after deploy:** B0G884ZJ27 → Apply tab → the banner shows the same headline/coverage the GET JSON carries (no UI-composed copy), expands to the can/can't lists, and is absent on no-keyword listings.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
