# Blanks in the Portal — design + plan

**PO ask (2026-08-22):** *"maybe a Section to ADD BLANKS ON THE PORTAL, AND THEN EACH PRODUCT WILL HAVE A DROPDOWN TO SELECT?"* — with deep integration.
**Method:** `/karpathy-dev-principles` — assumptions stated, alternatives named, simplest thing that solves the real problem, verification per step.

---

## 1. The problem, stated plainly

`blank_specs` is **already** the product-truth record. What is missing is a **human surface** and an **explicit per-product assignment**. Today the system *guesses* which blank a product is, from a style code embedded in the SKU name — and that guess has now been proven wrong in production:

- `BB64000XL-BK-FBA` (B0DSG4T5BR) resolves to Gildan 64000 because "64000" is in the SKU. The PO states the product is a **Comfort Colors 6014 long sleeve**. Its own Amazon listing calls it a **Sweatshirt**. Three sources, three answers.
- Correcting one child today costs a migration + a deploy (that is what 062 exists for).
- Adding a blank costs a migration (058 added six).

**Goal:** one place a human states what a garment IS; everything downstream derives from it, and the human never needs SQL again.

## 2. Success criteria (verifiable, not vibes)

1. PO adds a blank in the portal — no deploy, no SQL — and it participates in resolution immediately.
2. PO sets a product's blank from a dropdown; per-child too.
3. `BB64000XL-BK-FBA` → CC 6014 by the PO alone in under a minute.
4. Every product shows **which blank it resolved to and why** (assignment / SKU code / family / legacy guess).
5. No blank edit can silently re-point other families — the blast radius is shown *before* save.
6. The blank drives copy facts, truth rules, the keyword garment universe, and the pushed Amazon attributes — with no second source of truth introduced.

## 3. Facts (verified in code this session, not recalled)

- `blank_specs` (053 / 054 / 058): `match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, dye, stretch, fit_to_size, unisex, style_code, garment_family, active, notes`.
- Overrides: `blank_family_overrides` (parent_asin → style_code). `blank_child_overrides` (sku → style_code) is *pending*, unapplied.
- Resolution: child override → SKU style code → family override → legacy regex; garment-compatibility gate; mixed families intersect facts; 5-minute cache; fail-open to in-code seeds.
- Consumers **today**: Item-Highlight composer (spec facts, garment family, allowed brand), title band pad + truth rules, bullets/description spine ctx, backend fill, keyword garment universe (#625), **and the pushed Amazon detail attributes** — `fit`, `sleeve`, `neck`, `fit_to_size` are overridden from the blank and stamped `value_source='spec'`, which `stickyDetails` treats as the one legitimate re-proposer.

That last point is the deep integration: **the blank already decides what we tell Amazon the product is.** A wrong blank is not a copy problem, it is a catalog-data problem.

## 4. Approaches considered

| | Approach | Verdict |
|---|---|---|
| **A** | Portal-managed blanks + explicit per-product assignment | **CHOSEN** |
| B | Keep SQL-only; portal shows the resolved blank read-only | Rejected — does not remove the human bottleneck; the mislabeled SKU stays wrong until a deploy |
| C | Infer the blank from the live Amazon attributes (fabric / sleeve / type) | Rejected — the listing is precisely what is wrong here (it calls a long-sleeve shirt a sweatshirt). Inference from a lie is a lie. |

## 5. Chosen design

### 5.1 Data — ONE assignment table, not two

Two override tables for one concept is how this repo grew seven definitions of "covered". Before `blank_child_overrides` ever ships, fold both into:

```
blank_assignments (
  scope       text  not null check (scope in ('family','child')),
  key         text  not null,        -- family: parent_asin · child: sku
  style_code  text  not null references-by-convention blank_specs.style_code,
  note        text,
  set_by      text,
  set_at      timestamptz not null default now(),
  primary key (scope, key)
)
```

Backfill the four existing `blank_family_overrides` rows; add `('child','BB64000XL-BK-FBA','6014')`. One table, one resolver, one UI, one mental model.

### 5.2 Resolution — same shape, one honest level added

```
child assignment → child SKU style code → family assignment → legacy regex → null (fail-open)
```

Every resolution returns **why**: `{ source: 'child-assignment' | 'sku-code' | 'family-assignment' | 'legacy', styleCode, blankId }`. That string is what the UI badge renders — no second derivation.

### 5.3 UI

1. **`/fba/blanks`** — the blanks table: style code, brand, brand-in-copy, garment family, full spec, unisex, active, and **"used by N families"**. Add / Edit / **Deactivate (never delete)** — deleting a blank silently re-points every family that resolved to it.
2. **Listing page → "Garment" card** — the resolved blank, a **source badge** (assignment / SKU code / family / legacy guess), and a dropdown to assign. Per-child rows get the same control, shown only where a child differs from its family.
3. **Blast-radius modal** on any save that can change resolution: *"N families resolve to this blank today"*, and for a new style code *"N families' SKUs contain this code and would now resolve here"*, with sample ASINs.

### 5.4 What an assignment does — and does not — do

An assignment changes **what the generator believes**. It does **not** rewrite already-stored copy, and it never pushes. The card states this and offers "Regenerate to apply", listing which surfaces are now stale (title facts, Item Highlight fillers, detail attributes). `CONTENT_RECONCILE_ENABLED` is `shadow` during generator work, so nothing reaches Amazon without an explicit push.

## 6. Plan — each step with its verification

| # | Step | Verify |
|---|---|---|
| 1 | Migration: `blank_assignments` + backfill from `blank_family_overrides` (+ the BB64000 child row). Supersedes the unapplied 062. | `SELECT * FROM blank_assignments` shows 4 family rows + 1 child row |
| 2 | Resolver reads assignments (both scopes) and returns `source` | Unit test per precedence level; live `BLANK_RESOLVE` shows `source:'child-assignment'` for `BB64000XL-BK-FBA` |
| 3 | Read API + `/fba/blanks` list (read-only first) | Page counts match a hand-run SQL count |
| 4 | Write API (admin-gated) + Add / Edit / Deactivate + blast radius | A bogus style code shows 0 families; editing `1717`'s pattern shows N + sample ASINs before save |
| 5 | Listing-page Garment card + family dropdown, then per-child | Assign `BB64000XL-BK-FBA` → 6014; `BLANK_RESOLVE` flips; a regen yields Long-Sleeve facts and no "Sweatshirt" claim for that child |
| 6 | Staleness hint + "Regenerate to apply" | Assigning marks the family's copy stale; no push is ever enqueued |

## 7. Risks and the guard for each

| Risk | Guard |
|---|---|
| A blank edit is global | Blast radius before save; deactivate, never delete |
| 5-minute cache hides a change | Bust the cache on write |
| Assignment ≠ regenerated copy | Explicit "Regenerate to apply"; never auto-push |
| Wrong blank ships wrong Amazon attributes | Same guard as copy — regen + review; `value_source='spec'` already routes through sticky-details review |
| Anyone edits product truth | Admin-gated writes, `set_by` recorded |

## 8. Open decisions for the PO

1. **Unify the two override tables into one `blank_assignments`?** (recommended — `blank_child_overrides` is not applied yet, so it is free to fold now)
2. **Where does the Blanks section live** — top-level nav, or under Settings?
3. **Should assigning a blank auto-queue a regenerate** for that family (never a push), or stay a manual click?
4. **Who may edit blanks** — admin only, or any signed-in user?
