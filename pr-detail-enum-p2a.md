## E — Part 2a of 2 (Architecture A, approved)
Builds on Part 1 (PR #151: shared `coerceDetailValue` + push guard). This delivers **validate-at-regen** (confirmed values before recommending) + the **productType-cache consistency fix** found during the Part-1 live verify.

## What
1. **`src/lib/amazon/productType.ts` (new)** — `getProductType` extracted from push-content + a **process-lifetime cache** of *successful* resolutions (the `PRODUCT` fallback is never cached). The Part-1 live verify on B0G884ZJ27 found enum resolution was **intermittent** (an attribute's enum resolved on one call, fell back to free-text on the next) because `getProductType` occasionally hit the fallback — caching makes it **consistent**. push-content now imports the shared version.
2. **Validate-at-regen** (ai-recommendations) — after the audit produces `product_details_improvements`, each pushable **broadcast** detail is coerced to an **exact accepted enum member before being stored**:
   - coercible → `recommended_value` overwritten with the exact value (+ `normalized_from`). The panel now shows **confirmed Amazon values** (`Fit Type "Relaxed Unisex Fit" → "Relaxed"`) instead of the raw audit guess.
   - uncoercible (`Material "100% Cotton"`) → raw value kept + `enum_valid:false` + `enum_accepted` stored (for the Part-2b picker); the Part-1 push guard still blocks it.
   - free-text / per-variant / unmapped → skipped.
   - Best-effort: any SP-API failure leaves raw values (push `VALIDATION_PREVIEW` is the final backstop). productType is now cached, so this adds ~1 token + 1 (cached) schema fetch per regen.

## Adversarial pass (self-critique)
Best-effort wrapped (regen never breaks); reuses the Part-1-**verified** `coerceDetailValue`; doesn't touch the write path (push still guards); cache fixes the live intermittency. `getSellerId` duplicated per the existing codebase pattern.

## Test
- `npm run build` green.
- **Not yet live-verified** — after merge+deploy, regen B0G884ZJ27 and confirm stored details are coerced to exact members + Material carries `enum_valid:false` + `enum_accepted`.

## Part 2b (next)
Panel reads `enum_valid`/`enum_accepted` → **accepted-chips seller-picker** for uncoercible dropdowns + a push **value-override** so the seller's pick is what gets written.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
