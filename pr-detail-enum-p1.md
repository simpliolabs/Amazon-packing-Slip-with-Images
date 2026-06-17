## E — Part 1 of 2 (planned + approved via the karpathy ritual)
Architecture **A** (validate-at-regen) approved; uncoercible dropdown → **seller-picks-from-exact-list** approved. This PR lands the **shared validator + the push-side guard**. Part 2 = validate-at-regen storage + the seller-pick panel.

## What
- **`coerceDetailValue(productType, spApiKey, raw, opts)`** (new, `productTypeDefinitions.ts`) — the single source of truth for validating a product-detail value against the **live** product-type schema:
  - **dropdown (enum)** → coerce to an **exact accepted member** (`Unisex Adult → Unisex`); a value that can't map returns `valid:false` + the accepted list.
  - **free-text** → pass through (push `VALIDATION_PREVIEW` guards byte-length/pattern).
  - Now also **excludes `enumDeprecated`** values (Amazon retires these — found via the SP-API meta-schema).
- **`loadDetailContext`** (push-content) refactored onto it + an **exact-value guard**: a dropdown the value can't map to is now **blocked** (was pushed raw → Amazon-rejected) with the accepted list surfaced, so the push **never writes a non-member**. Coercible + free-text behavior unchanged.

## Why this is safe (push/write path)
The guard **blocks** invalid writes — the failure direction is a false-block, never a bad write. Best-effort: a schema-fetch failure falls back to raw (prior behavior; `VALIDATION_PREVIEW` still guards). One noted low-risk: a mis-parsed schema enum could false-block a valid value (pre-existing `extractEnum` heuristic) — the seller sees the accepted list and can set it in Seller Central.

## Internet research
SP-API Product Type Definitions: `enum` + `enumNames` (index-aligned), **`enumDeprecated`** (must be replaced), `maxUtf8ByteLength`/`pattern` (free-text — preview-guarded).

## Test
- `npm run build` green.
- **Not yet live-verified** — after merge+deploy: push a coercible detail (`Department: Unisex Adult → Unisex`) and an uncoercible one (`Fit Type: Unisex`) — the latter must block with the accepted list.

## Part 2 (next PR)
Validate-at-regen (store the exact value + accepted list on the recommendation, so the panel shows confirmed values) + the seller-pick panel (accepted-chips picker for the rare uncoercible dropdown).

**Sources:** [PTD API](https://developer-docs.amazon.com/sp-api/docs/product-type-definitions-api) · [meta-schema (enumDeprecated/maxUtf8ByteLength)](https://developer-docs.amazon.com/sp-api/docs/product-type-definition-meta-schema)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
