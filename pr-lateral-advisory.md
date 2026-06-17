## What
An **advisory-only** "mostly lateral" hint in the Ship Backend Keywords modal. When the recommended backend keywords are ~the same as what is already live (and the field is already full), it tells the seller the push is unlikely to move their keyword score — **without ever hiding or disabling the Confirm button.**

## Why
The PO repeatedly hit a 100+-SKU keyword push prompt for a ~95%-identical rewrite and asked *"is this overkill? how is this a score improvement?"* Per the scorer (`syncListingContent`), a backend swap only raises the keyword score when it (a) fills a short field (length / byte / comma deductions) or (b) covers a previously-missing top keyword. A swap between two already-full, near-identical strings does neither — it is lateral churn.

## How (client-side, keyword Ship modal)
Shows the hint only when **every** changing child is already at full strength (≥200 chars, ≤250 bytes, comma-free) **and** every child's recommended terms overlap ≥70% with its live terms. Copy is hedged (*"unlikely… push only if a major missing keyword is being added"*) and redirects the real lever to title/bullets.

## Why advisory, not an auto-DONE gate
An earlier auto-suppress attempt (Option C v1) was caught by adversarial review: it assumed the keyword score moves **only** via missing-keyword coverage and ignored the length / byte / comma / title-overlap deductions — so it would have falsely marked a short-backend listing "done" and hidden a real **+4–8** gain. Auto-hiding a push needs a faithful before/after re-score; a soft hint does not. This ships the safe half.

## Adversarial pass
- False reassurance bounded by `allMaxed` (no string penalty left to fix) + ≥70% overlap + soft language + the Confirm button staying enabled.
- Null-safe, no divide-by-zero, does not touch the Confirm button logic.
- Fires for the exact case the PO flagged (~75–78% overlap on a full field).

## Test
- `npm run build` green (Compiled successfully + Finished TypeScript).
- Not yet live-verified (needs deploy). Will confirm on a real ASIN post-merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
