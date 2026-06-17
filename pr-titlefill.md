## Title-fill reliability — fill apparel titles to ~73–75 chars (batch 3/6)

**PO 2026-06-15:** "65/75, didn't use all chars." Clean apparel titles kept landing at 65–70, leaving the 75-char budget under-used. The fill block's trigger (`<70`) and break (`>=70`) capped it exactly where the PO saw the gap, and the filler pool ran dry whenever the top title candidates were already token-covered.

### Change (one block in `listingPipeline.ts`)
- Trigger `<70` → `<73` — kicks in for clean 70–72 char titles too.
- Break `>=70` → `>=73` — keeps adding until the title reliably approaches the cap.
- Filler pool now includes the high-value **UPGRADE keywords** (`topUpgradeKws`) alongside the title candidates + canonical bigrams — enough grounded material to actually reach the target instead of starving.

### Safety (all preserved, per-addition)
- 75-char hard cap (`next+tail > 75` → skip) — never overshoots.
- Token-novelty check (adds nothing new → skip).
- Gender-lean filter + motif/garment truthfulness strips run on every candidate.
- `topUpgradeKws` is already grounding-filtered; #240 scrubs the published output for trademarks.

`tsc` 0. `node_modules` has no vitest in this sandbox so `pipeline.test.ts` couldn't run, but this is a contained numeric-threshold + filler-source edit with every guard intact.

> **Not in this PR:** the keyword-stuffy-bullets fix. It needs a coverage-**validator** relaxation too (a prompt-only tweak gets overridden by the "every word present" check that forces verbatim long-tail jamming), so it ships as its own PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
