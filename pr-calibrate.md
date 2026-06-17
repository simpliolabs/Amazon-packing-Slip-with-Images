## Three fixes: the Neck rejections (write-form calibration against Amazon's own validator), "weave in MEN" on a Female listing, and "why only 4 extra values?"

### 1. Neck still failing — it was never shipping the word "neck"
The value was "Crew Neck" with the correct SHIRT type (#209 worked). What's wrong is the **write form**: my schema-derived nested shape `{neck_style: {value, language_tag}}` is one of several ways Amazon expresses composite sub-fields (objects, bare enum strings, oneOf unions of both) — and the static read guessed wrong for `neck`. Reading schemas and guessing is a losing game, so the push now **calibrates**:
- On the FIRST SKU it probes the known write-forms in VALIDATION_PREVIEW (**no write happens in preview**): `{neck_style:{value,language_tag}}` → `{neck_style:{value}}` → `{neck_style:"Crew Neck"}`. Whichever Amazon validates is used for the whole family, and the winner is cached per (productType, attribute).
- The flat legacy form is deliberately NOT a candidate for composites — it validates and then silently no-ops (the #204 discovery), the one failure mode calibration must never pick.
- If Amazon rejects every form: **one** clean refusal with Amazon's full message — never another 82-row failure cascade.
- `?debug=1` now also returns the RAW subschema + every calibration variant, so shape disputes are settled by evidence.

### 2. "Why is it asking me to WEAVE in MEN?"
The Rank-Top-of-Amazon playbook (`buildFreeCore`) read the raw keyword pool with no audience filter — it demanded "mens comfort colors tshirt" and "plain black tshirt men" as gaps on your FEMALE-selected listing, gaps the generator is *designed to never close* (the #203 trap-class, third code path). Under hard Male/Female, opposite-gender keywords are now excluded from the playbook rows, coverage counts, and critical-gap list. Lean/unisex unchanged.

### 3. "Why only 4 extra values? Are there no extra features that help us rank?"
There are — the menu just never showed them. The audit's attribute menu was "first 14 keys in SCHEMA order", and on SHIRT (157 properties) that spent slots on **voltage/wattage** while `occasion`, `theme`, `pattern`, `special_feature`, `lifestyle`, `collar_style`, `top_style` landed 15th+ and were never offered. Now: 26-slot menu, SEO-bearing attributes first, compliance/electrical noise last. The unit test caught a real precedence trap here (`compliance_age_range` matching the SEO pattern via "age_range") — noise is tested first. **Run a full Regenerate AI Audit after this deploys** and expect a substantially richer Product Details panel.

### Verification
15/15 tests (all three calibration variants byte-exact incl. dedupe and index stability; the two live "weave in" offenders excluded while neutral/female/both-gender keywords survive; menu banding incl. the compliance_age_range trap). `tsc` exit 0. No migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
