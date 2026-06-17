## Guarantee the design name in backend search terms ("Later Gator", recurring)

**The "And Again" bug:** the seller's design name keeps dropping out of the **backend** search terms. Root cause (confirmed in code): `designName` was wired into the **title** agent only. The backend agent never received it, and its `excludeWords` set — built from the title — **deliberately strips title words**, so "later"/"gator" got deleted. The title is reliable only because it has a *deterministic* design-name lead (#91/#92); backend had no equivalent must-include, so it dropped silently.

### Fix (`runBackendAgent` — mirrors the title's deterministic anchor)
1. Thread `designName` into `runBackendAgent` (+ the call site).
2. **Exempt** the design tokens from `excludeWords` so the fill/dedup can't strip them.
3. **Deterministically lead** the exact design phrase — `corePhrases.unshift("later gator")` — so it survives the 228-byte cap and lands in **every** child's backend string. The adjacency dup-check skips only when "later gator" is *already adjacent*; the tokens existing separately across other phrases ("…see you later alligator … gator after while…") still trigger the lead.

### Safety
- **Capacity / non-apparel:** `extractDesignName` returns `''` there → all three parts no-op, and a capacity family + a design phrase are mutually exclusive. No interaction with the capacity backstop.
- **Adversarially reviewed: CLEAN** — verified it lands in every child, survives the cap, the regex is injection-proof, and `excludeWords.delete` only re-admits the design tokens. `tsc` clean.

### Verification
- **Live-verify after deploy:** regenerate B0G884ZJ27 → its backend string now **leads with "later gator"** for every SKU. I'll run this and show you the actual string.

> This is step 1 of the holistic plan. The **bullets** design-name guarantee + the full cross-section keyword coverage (which absorbs the bullets 9/18 fix) come next, per your "holistic, not in isolation."

🤖 Generated with [Claude Code](https://claude.com/claude-code)
