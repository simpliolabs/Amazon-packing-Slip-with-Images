## E — Part 2b of 2 (completes E)
Architecture A; uncoercible → seller-picks (PO-approved). Builds on Part 1 (#151) + Part 2a (#152).

## What — the seller-picker
An uncoercible enum (`Material "100% ring-spun cotton"` when Amazon wants `Cotton`) no longer hard-blocks. `loadDetailContext` now **flags `enumInvalid`** instead of erroring, so the push **preview** shows Amazon's accepted values as **clickable chips**; the seller picks the correct one and the push writes that exact member. The push still **blocks** if no valid value is chosen — never writes a non-member.
- **push-content:** `loadDetailContext(parentAsin, detailField, valueOverride?)` + `enumInvalid`; GET preview returns `enum_invalid`; POST parses `detail_value_override` + blocks on `ctx.enumInvalid`.
- **page.tsx:** clickable accepted-chips picker in the modal, `detailOverride` state, Confirm gated on a pick, `confirmPush` sends the override (passed as an **arg** — no stale closure).

## Coercion improvement
`coerceToEnum` now also does **whole-word substring** matching (`"Unisex relaxed fit" → "Relaxed"` — the gap found in the 2a live-verify), **unambiguous-only** (>1 match → picker). Plus the `enum_*` types on the 3 `ProductDetailImprovement` interfaces.

## Adversarial review (subagent, live-write path) — found + FIXED before commit
- **BLOCKER:** the override was written **verbatim with no membership check** — a direct POST (not the UI) could push junk; the only backstop was `VALIDATION_PREVIEW`. **Fix:** the override now **replaces the audit value but still passes the enum validation** — a non-member override → `enumInvalid` → blocked. It skips the audit value, never the validation.
- **MAJOR:** prefix-coercion had no ambiguity guard (`"Cotton Blended"` silently → `"Cotton Blend"`). **Fix:** auto-coerce only when the prefix match is **unambiguous**, else → picker.
- **MAJOR:** the details/override path had no length cap. **Fix:** 1000-char cap.
- **MINOR (noted):** a transient schema-fetch failure degrades a known-enum to a raw push (pre-existing best-effort; lower risk now productType is cached).

## Test
- `npm run build` green.
- **Not yet live-verified** — after merge+deploy on B0G884ZJ27: Material preview shows `enum_invalid` + chips; a valid pick (`Cotton`) pushes; a **bogus override is blocked**; `"Unisex relaxed fit"` auto-coerces to `Relaxed`. I'll verify each from fact.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
