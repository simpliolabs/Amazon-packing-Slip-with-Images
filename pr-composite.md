## Neck/Closure "empty with warnings in the Amazon editor" — the pushes were accepted, then silently dropped. Root cause found and fixed.

### From-fact diagnosis (live reads, all 89 SKUs)
- `verify-push` live read **hours after** the accepted 157-SKU Neck push: **0/89 SKUs carry `neck` or `closure`** — every single one empty, while `lastUpdatedDate` moved to today (Amazon processed the submissions, the values vanished). This was never application lag.
- The live SHIRT schema (157 properties) has **no** `neck_style` / `closure_type` / `sleeve_type` top-level attributes. The real keys are the **composite containers** `neck`, `closure`, `sleeve` — the Seller Central form's "Neck Style", "Closure Type", "Sleeve Type" fields are *sub-fields inside them*.
- Our patch sent the flat `[{value, marketplace_id, language_tag}]` shape into those containers. Amazon's VALIDATION_PREVIEW **passes it**, the live PATCH returns **ACCEPTED**, and the processor then drops the value — the worst failure mode: green everywhere on our side, empty on Amazon. Your editor warnings were the truth.

### The fix — schema-derived value shape
- New `getDetailValueShape()`: walks the attribute's own subschema (same traversal preference the enum coercion uses) and derives the value path, e.g. `neck → [neck_style, value]`. The patch is built along it:
  `neck: [{ neck_style: { value: "Crew Neck", language_tag }, marketplace_id }]`
- **Flat attributes are untouched**: the shape getter returns null for plain `[value]` attributes (Fit Type, Model Number, Package Quantity…), keeping the battle-tested legacy builder byte-identical. Zero regression surface on everything that already works.
- **Reads fixed too**: `currentDetailValue` now deep-reads nested entries — without this, verify showed 0/89 even for genuinely-applied composite values, forever.
- `?debug=1` now resolves dynamic names ("Neck" → `neck`) and returns the derived `valueShape` + a sample patch entry — I'll verify the exact write shape **read-only after deploy, before you re-push**.

### "Short_sleeve should be Short Sleeve" (display)
`short_sleeve` IS the API token the schema demands for `sleeve` — pushing it is correct; showing it to you isn't. Cards, Copy, and the Ship modal now display the schema's human label ("Short Sleeve") via the row's stored accepted-labels list; the push keeps the raw token. (Neck/Closure enums happen to use display-like tokens, which is why only Sleeve looked broken.)

### Verification
- 20/20 unit tests against the compiled real code (composite path derivation incl. reordered/noise sub-fields, nested+flat patch builds, deep reads incl. plumbing-only entries, display labels incl. "3/4 Sleeve" squash-matching).
- `tsc` exit 0. No migration. Stored recommendations need **no regen** — the fix re-shapes the same stored values at push time.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
