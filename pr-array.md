## Neck push: the sub-field is an ARRAY, not an object. Read straight from Amazon's schema.

### Ground truth (from the raw subschema #210 now exposes)
`?debug=1` on SHIRT `neck` returned the real structure:
```
neck: [ { neck_style: [ { value, language_tag } ], marketplace_id } ]
         └─ neck_style is type:"array" ──┘
```
My shape derivation walked the path `neck_style → value` correctly but never recorded that **`neck_style` itself is an array** — so it built `neck_style: { value, … }` (object) when Amazon requires `neck_style: [ { value, … } ]` (array). All three calibration variants inherited that same object-vs-array mistake → "InvalidInput: The provided payload is invalid" on every form. (The #210 calibration safety did its job: one clean refusal, zero bad writes — exactly the design.)

### Fix — array-awareness, schema-driven
- `DetailValueShape` gains `isArrayAt[]` (index-aligned with `path`): a segment whose schema node is `type:"array"`/has `items` must wrap its content in `[ ]`.
- `analyzeDetailValueShape` records it while walking; `buildShapedDetailValue` honours it. The derived payload now equals Amazon's schema **byte-for-byte**:
  `[{ neck_style: [{ value: "Crew Neck", language_tag: "en_US" }], marketplace_id }]`
- Calibration keeps probing on the first SKU, but now "shaped" is the correct array form and validates immediately. Added a `no-array` fallback variant (the old object form, ranked last) so a product type whose sub-field genuinely is a plain object still calibrates.
- Flat attributes (Fit Type, Model Number…) are unchanged — `value` sits directly in the array item, `isArrayAt:[false]`, still bypassed to the legacy builder. Verified by the #204 regression suite (20/20).

### Verification
11/11 new tests fed the EXACT SHIRT `neck` subschema Amazon returned: derived `isArrayAt:[true,false]`, payload matches the schema, variant ordering correct (array form first, old object form last), flat-attr bypass intact. `tsc` exit 0. One file, no migration.

This is the same array nesting Closure (`type`) and Sleeve (`length_description`) use — so all three composites are fixed by this one structural correction.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
