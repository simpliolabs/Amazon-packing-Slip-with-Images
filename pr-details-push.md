## Details push: fix HTTP-400 on invalid attrs + write-through/re-score (+ role-word & rank fixes)

The "A: GO" fix bundle plus the live **HTTP 400** you hit pushing Department to B0F86LPSHZ. No migration.

### 1. Live bug — "the provided attribute path is not valid" (0/10 pushed)
B0F86LPSHZ is **sticky notes** — `department` (a clothing attribute) doesn't exist in that product type's schema, so every PATCH 400s.
- new `attributeExistsInSchema()` (checks the live schema's `properties`; **fail-open** — never blocks a valid push on a fetch error)
- **push guard**: before any PATCH, if the attribute isn't in the schema → one clear "not a valid attribute for this product type" message instead of N failed writes
- **regen drop** (root fix): schema-absent broadcast attributes are removed from the recommendations, so they're never suggested, **never counted as an unfillable Features gap**, and never pushed

### 2. Features "8 → 12/12" — the details push now actually moves the score
The straight answer to your question: 10/12 is correct (8 genuinely-empty fields), **but** I found the details push had **no write-through and no re-score** — so it would *not* have moved the score (RED stays RED). Fixed: on a successful push it sets `current_value` + `enum_valid` so `productDetailsGaps` drops, then re-scores — Features rises immediately, the same ship→rise the bullets proved (11/18 → 18/18).

### 3. "Teacher" backend dead-end (your screenshot: "Regenerate to weave it in" did nothing)
The backend keyword **core** was stripping role words, so the regen could never add "later gator teacher shirt" to backend → the keyword gap was permanently unclosable and the work-list button a false promise. Role words are now **kept in the backend core** (real SQP queries; `generic_keyword` is invisible indexing, not a customer claim). Bullets/title still strip them; the LLM-fill still strips model-invented ones.

### 4. Rank work-list stale guard
Returns `[]` when the rank analysis is **stale**, so it stops showing "Ship — draft already covers them" off outdated coverage (you saw it suggest re-shipping bullets you'd just pushed). Falls back to the honest "re-check in Intelligence".

### Review & verification
Adversarial pass over all 6 changes → **sound** (applied its one hardening note: `normalizeFieldName` on the write-through match). `tsc` exit 0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
