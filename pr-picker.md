## "I can't choose/change any of the other values if I want, WHY?" — now you can. The accepted-values chips are a picker on every detail push, not just on validation failures.

### What was happening
The seller-picker (Part 2b) only activated when the audit's value FAILED enum validation. When the value was valid, the "AMAZON ACCEPTS" chips were display-only — you could see "Long Sleeve" but not choose it. The override plumbing (`detail_value_override`) already existed end-to-end for the invalid case; the valid case just never offered it.

### Now
- **Every accepted-value chip is clickable.** Click "Long Sleeve" → the Confirm button becomes *"Confirm & Ship Sleeve = "Long Sleeve" to all SKUs"* and that's what ships. Click the recommended value to clear your override.
- Your pick is **re-validated server-side** (the same coercion + enum gate as always — a junk override still blocks), the label is coerced to Amazon's API token ("Long Sleeve" → `long_sleeve`), and **every SKU is re-compared against the chosen value at push time** — so a "0 currently differ" preview can't block a deliberate change, and the counts can't mislead.
- The current value's chip is highlighted correctly now (squash-compare: the `short_sleeve` token highlights the "Short Sleeve" chip — the old lowercase compare matched nothing, which is why no chip looked selected in your screenshot).
- The "NEW SLEEVE — ALL 163 SKUS" box shows the human label ("Short Sleeve", not `short_sleeve`) — the one spot #204's prettify missed.
- **Write-through records what you actually pushed**: after an override (or an enum coercion), `recommended_value` updates to the pushed value — previously the panel kept showing the stale audit value forever and the "✓ On Amazon" badge could never light up after an override push.

Queue-in-background honors the override identically. The invalid-value picker (amber) is unchanged.

`tsc` exit 0. Two files, no migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
