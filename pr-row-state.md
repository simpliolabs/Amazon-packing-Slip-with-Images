## PO: "product features do not show any notice after PUSH, DONE, Verify or etc"

True — a detail row looked byte-identical before and after a successful push: same green **Push →**, no state, nothing DONE.

## Fix

- **"✓ On Amazon" chip per row**: when `current_value === recommended_value` (which is exactly what the push write-through sets server-side since #164), the card gets a green chip + deeper border, and the button becomes **Verify / Re-push** (opens the same modal where per-SKU Verify lives). Equality IS the on-Amazon signal — zero new endpoints; rows that were already correct before any push honestly show it too. Tooltip notes Amazon's 15min–6hr PDP propagation.
- **Instant flip**: the single-field modal push now mirrors its server write-through locally (`current_value` = pushed value, seller's override carried, `enum_valid` → true) — the same mirror Auto Push (#170) already did. The chip appears the moment the push completes.
- Consistency for free: Auto Push eligibility already excludes up-to-date rows, so **"Auto Push all ready (N)"** counts down as rows flip.

`tsc` exit 0. UI-only.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
