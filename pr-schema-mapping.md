## The bug you saw (sticky notes titled "…T-Shirt, Graphic Tee for Men and Women")

Two stacked hardcodes:

1. `ai-recommendations/route.ts` set **`category: 'Clothing, Shoes & Jewelry > … > Clothing > Novelty'` for EVERY product** — and that string feeds every agent's prompt AND the apparel gate.
2. `looksApparel()` text-sniffs `category + title` (`\bclothing\b` matches) → **everything was apparel** unless rescued by a *second* hardcoded noun list (memory cards, mugs, …) that didn't know "sticky notes". B0F86LPSHZ (SELF_STICK_NOTE) fell through → full apparel treatment in title, bullets, and description.

## The fix — the live SP-API productType decides (zero new hardcodes)

- **Route**: resolve `productType` ONCE **before** the pipeline (it was already being fetched — but only *after*, for enum validation). Pass it into `PipelineInput`. The prompt `category` becomes the humanized PT ("Self Stick Note"); the old clothing string survives only as the fallback when the PT lookup fails.
- **`looksApparel(category, repTitle, productType?)`**: when PT is known it is **authoritative both directions** (`APPAREL_PRODUCT_TYPES` token-boundary regex: SHIRT, SWEATSHIRT, DRESS, …). This kills the poisoned-category bug **and** the feedback loop where a previously contaminated live title ("…T-Shirt" on an office product) would keep flipping it back to apparel forever. All 8 call sites pass it; PT unknown → the existing heuristic, byte-identical.

## "Offer up to 10 values, dynamic per product category" (your ask)

- New `listPushableSchemaAttributes()` enumerates the **live product-type schema**: broadcast attributes with their real display titles + accepted enum values (identity/structural/variation/image keys excluded).
- The audit agent now receives that as an **AMAZON ATTRIBUTE MENU** and must recommend Product Details **only from it** — exact names, enum values verbatim, the 5-10 highest-impact. Every recommendation is born mapped to a real attribute of THIS category:
  - sticky notes → adhesive/ruling/sheet-count style attrs; **Department can never be invented again**
  - apparel → the real SHIRT schema menu (Department included, since it exists there)
- Menu unavailable (schema fetch error) → legacy prompt unchanged.

## Wiring completion (schema-detail mapping, the #164 direction)

- Regen persists `sp_api_key` / `attr_scope` / `pushable` per detail row (schema-resolved: static map → dynamic title-match).
- Enum validation now runs for **all** categories (the "this product is definitely not 'thick paper'" accuracy fix) and reuses the hoisted PT context (no duplicate SP-API fetch).
- `page.tsx`: Push-vs-Manual gates on the stored `pushable` (legacy rows fall back to the static map); per-variant rows get an accurate "set it on each child SKU" hint.
- `verify-push` + `push-content`: prefer the regen-stored `sp_api_key` — verification and pushing now work for ANY category's attributes.

## Verification

- `tsc --noEmit` exit 0.
- Adversarial pass (subagents 529'd twice — performed inline, angle-by-angle): apparel families (SHIRT/SWEATSHIRT) verified unchanged at all 8 gate sites; all failure paths fail-open to today's exact behavior; menu titles round-trip exactly through `resolveSpApiKeyFromTitle` step-1; enum lists truncate at prompt-build (12/attr, 14 attrs max).
- Known minor (intended): a design-led non-apparel PT outside the old rescue list (e.g. a printed tote) now gets generic keyword-led framing instead of apparel framing — safe, never "T-Shirt" nonsense.

## After merge (PO)

1. Coolify deploys (~3 min).
2. **Regenerate on B0F86LPSHZ** — flushes the poisoned T-shirt recommendations; I'll verify the new title/bullets are sticky-note-true + the detail menu shows real SELF_STICK_NOTE attributes before calling it green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
