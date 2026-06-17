## Six PO catches, one clarity pass

1. **"If I close the pop-up mid-send, does it stop?"** — The ✕ was already a silent no-op while sending; now it's **visibly disabled** with a tooltip, and a note under the spinner states the honest semantics: already-ACCEPTED SKUs stay pushed if the connection drops (refresh/navigation); the stream stops where it was.
2. **"Can I come back to Verify?"** — Yes, always: re-open the same Push/Ship modal → **Verify on Amazon** reads the live values per SKU (works even after a regen replaced the recommendation, via the #172 push-history fallback) → **Push just the stale N** finishes stragglers. The new note says exactly this.
3. **"Present In seems stale / unexplained"** — header tooltip now spells out **T=Title, B=Bullets, D=Description, K=Backend** and that the flags are a **snapshot from the last Intelligence sync/Re-research**; every chip + the "nowhere" marker carry their own titles.
4. **"Refresh analysis doesn't state what it does"** — tooltip: rebuilds the rank playbook from your CURRENT content + runs the AI analyst council; **no Jungle Scout credits** (OpenAI, ~a cent).
5. **"Analyze competition doesn't state what it does"** — tooltip now says what you GET (per-keyword Share-of-Voice: which competitor owns the clicks, their %, whether YOU appear in top listings) alongside the credit cost; the caption contrasts both buttons in one line.
6. **"Says 'hit Re-check above' but no button"** — the **Re-check now (free)** button now lives inside the gap box itself.

`tsc` exit 0. UI-only, two files.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
