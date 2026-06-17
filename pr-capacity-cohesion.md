## Capacity-family titles stay per-child in Variant Cohesion

**Bug (B0GCF11RKL — an SD-card 128/64/32 GB family):** the Variant Cohesion panel showed TITLE as **"should match → 3 need update"** and recommended **"Update all 3 variants to:"** a single **64GB** title — which would stamp 64GB onto the 128GB and 32GB variants.

**Root cause (NOT a recent regression):** the panel was born broadcast-only (built for a 46-variant *apparel* example) and never adopted the `isCapacityFamily` gate (`per_child_titles.length > 1`) that every *other* title surface already honors — the header, the per-child title card, and the push. (Confirmed PR #154 / rank-analysis did **not** cause it.)

**This is a display / count / copy fix — the actual Ship push was already correct** (it resolves per-SKU titles via `pushFields.resolveProposed`).

### Changes (`src/app/fba/listing/[asin]/page.tsx`, cohesion panel)
- `fieldCohesion()` takes an optional per-child target resolver; for a capacity family the title row compares each child to **its own** per-child title (so the legitimately-divergent 128/32 GB titles stop reading as "need update").
- The title row renders **"unique each"** + a **per-variant list** (each SKU's own-capacity title) instead of "should match" + "Update all N to: \<one 64GB title\>".
- **Capacity-families-only:** apparel / single-capacity keep the broadcast path **unchanged**. Bullets & description stay broadcast (pipeline validators strip hardcoded GB from shared bullets/desc).

### Verification
- Root-caused via a 4-way parallel investigation.
- **Adversarial review: CLEAN** — scoping is capacity-only (apparel untouched), SKU matching resolves every FBA variant (dedup logic is byte-identical on both sides), `needUpdate` correct, Ship routes per-SKU, no crash paths.
- `tsc --noEmit` clean.
- **Live-verify after deploy:** B0GCF11RKL → Apply tab → Title shows "unique each" + per-variant titles, no "update all to 64GB".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
