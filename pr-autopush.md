## Auto Push resilience + the missing backend-regen button

### 1. "Verify what is going on when pushing ALL Features at once" — diagnosed from fact
Your sequence: **Neck ✓ 157/157** (accepted before the restart) → **Sleeve ✗ stream died** → **Closure + Item Highlight ✗ 502** — the classic signature of the **#201 deploy restarting the container mid-sequence** (you merged ~1 minute before pushing). The runner kept hammering a restarting server, burning every remaining field.

- **Now**: a gateway-class failure (502 / dead stream / dropped connection) **stops the sequence** and marks the remaining fields *"Held — server restart detected (likely a deploy). Re-run Auto Push in ~3 minutes; fields already accepted stay pushed."*
- **Live state verified**: Neck shows 0 applied / 89 stale on a live read — that's **Amazon's normal 15 min–6 hr application lag**, not loss (157 submissions are ACCEPTED and queued inside Amazon). Sleeve/Closure need a re-run once this deploys.
- The long error text no longer paints across the row labels (wraps in its own column).

### 2. Item Highlight removed from Auto Push until July 27
Amazon write-blocks it everywhere until launch (error 100476) — including it guaranteed one failed row every run. It's excluded from the eligibility list until **2026-07-27** (the single-field card keeps showing it for planning/copy).

### 3. "I don't see a way to regenerate just keywords"
The ↻ button only lived on the action-plan card. It's now ALSO in the **Edit Per Variant** header — right next to "82 of 82 need update", where the per-variant strings actually display.

`tsc` exit 0. UI-only, one file, no migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
