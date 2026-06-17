## Per-suggestion rank chips on the Apply tab — Integration A, increment 1b

Builds the per-suggestion tags **correctly** — the design council's `coveredIn`-only mapping was ill-defined (an *uncovered* keyword has empty `coveredIn`, so coverage alone can't say which section it belongs to). Each content suggestion in the Apply tab now carries its honest rank context.

### What it does
Tags the **Variant Cohesion** title/bullets rows + the **Backend** row with:
- **Content-winnable** (violet) — a genuinely-uncovered high-opportunity keyword is *planned* for that section.
- **Content done here** (slate) — the section's top keywords are covered; rank now depends on reviews/price/velocity, not more copy.
- *(no chip)* — when the data is ambiguous (bias-to-show; a false "done" can never appear).

### The correct mechanism
Combines the **rank coverage truth** (`rankData.rows`: `youCover` + `coveredIn`) with the AI's **placement plan** (`keyword_reconciliation`: `placed_in` + `action_type`). `placed_in` is what says *where an uncovered keyword should go* — exactly what the coverage-only mapping couldn't do. The winnable check is **cross-checked against rank coverage**, so an already-covered keyword is never tagged.

### Safety
- The chip is a header **sibling** — it can never hide or disable Ship / Copy / the "N need update" count.
- **Honesty:** both new strings are asserted in `scripts/verify-rank-honesty.mjs` → `10/10 honest phrases pass, 0 over-promises`.
- **Adversarially reviewed: CLEAN** on the honesty-critical *no-false-"done"* direction. Fixed the 2 minor edges it found (guard a missing LLM-authored `kr.keyword`; normalize whitespace on the cross-check).
- `tsc` clean. **No server change, no migration.**

### Verification
- **Live-verify after deploy:** B0G884ZJ27 → Apply tab → a section with a planned uncovered keyword shows "Content-winnable"; a fully-covered section shows "Content done here"; Ship/Copy stay enabled on both.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
