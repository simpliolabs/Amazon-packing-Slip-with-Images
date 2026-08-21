-- 058_blank_specs_style_codes.sql
-- 057_rekey_keyword_pool_to_parent.sql is the highest applied. Apply BY HAND in the Supabase SQL
-- editor. IDEMPOTENT: every statement is IF NOT EXISTS / WHERE NOT EXISTS / ON CONFLICT DO NOTHING,
-- so a re-run is a no-op and never clobbers a PO edit. Code is fail-open either way: deployed
-- before this runs, the reader sees no style_code/garment_family columns → legacy regex behaviour.
--
-- PO RULING 2026-08-21 (handoff/SELLER_PROFILE.md "Blank identity is stated in the CHILD SKU"):
-- the garment blank is "as stated in Children SKU" — the STYLE CODE in the child SKU (1717 CC tee,
-- 6014 CC long sleeve, 64000 Gildan Softstyle, 64000B Gildan YOUTH Softstyle, G64400 Gildan long
-- sleeve, 1800x/18000 Gildan crewneck sweatshirt, 18500 Gildan hoodie, BC3001 Bella+Canvas 3001),
-- never inferred from a title brand word. Families whose SKUs carry no style code get an explicit
-- PO-maintained override (blank_family_overrides). Mixed-blank families use the INTERSECTION of
-- facts (a fact that differs between children — sleeve, neck, brand — is never claimed).
--
-- WHY: resolveBlankRowForNet matched only `comfort colors` / `gildan|64000` over ONE joined hay and
-- took the FIRST row by id — fourteen families resolved to NULL (no brand word in the title; codes
-- 1717/6014/64400/18000/18500/3001 unknown), so their Item Highlights had no spec filler bank and
-- could never reach the 107-char floor; and the looksShirt gate nulled every sweatshirt/hoodie
-- family because no sweatshirt blank existed.
--
-- Column semantics (mirror rowToSpec / resolveFamilyBlank in src/lib/fba/blankSpecs.ts):
--   style_code      the manufacturer style code as it appears in the child SKU's leading token.
--                   Extraction strips a letter prefix and tolerates a glued size
--                   (ADWF64000, 640002XL, G644002XL, BCSG18002X, HDG18500M, BC3001XL, 17172XL).
--                   Codes are matched LONGEST-FIRST (64000B beats 64000; 18500 never reads as 1800).
--                   A trailing-zero elision is accepted ONLY when a size token is glued on
--                   (EDG1800L / BCSG18002X → 18000, the PO's "1800x").
--   garment_family  tee | long_sleeve_tee | sweatshirt | hoodie | kids_tee. Drives the
--                   garment-compatibility gate (a tee family never inherits a sweatshirt row and
--                   vice-versa) and the Item-Highlight composer's garment vocabulary.
--   brand_in_copy   false for EVERY Gildan row (SELLER_PROFILE §5 "NEVER Gildan") and — conservative
--                   default, PO may flip — for Bella+Canvas. true (default) only for Comfort Colors.
--   All fact columns are TRUE public spec-sheet facts only. NULL = the blank does not claim it.

ALTER TABLE blank_specs
  ADD COLUMN IF NOT EXISTS style_code     text,
  ADD COLUMN IF NOT EXISTS garment_family text;

COMMENT ON COLUMN blank_specs.style_code IS
  'Manufacturer style code as stated in the child SKU leading token (1717, 6014, 64000, 64000B, 64400, 18000, 18500, 3001). SKU-first resolution: per-child extraction → blank_family_overrides → legacy match_pattern regex.';
COMMENT ON COLUMN blank_specs.garment_family IS
  'tee | long_sleeve_tee | sweatshirt | hoodie | kids_tee — garment-compatibility gate + Item Highlights composer vocabulary.';

-- ── 1. Stamp the two migration-053 seed rows (lowest id per brand; only while still unstamped) ──
UPDATE blank_specs SET style_code = '1717', garment_family = 'tee'
 WHERE id = (SELECT min(id) FROM blank_specs WHERE brand = 'Comfort Colors')
   AND style_code IS NULL;

UPDATE blank_specs SET style_code = '64000', garment_family = 'tee'
 WHERE id = (SELECT min(id) FROM blank_specs WHERE brand = 'Gildan')
   AND style_code IS NULL;

-- ── 2. New blank rows (one INSERT per style code; WHERE NOT EXISTS on style_code = idempotent) ──
-- Comfort Colors 6014 — Adult Heavyweight Long Sleeve Tee (6.1 oz, 100% ring-spun, garment-dyed).
INSERT INTO blank_specs (match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, dye, stretch, fit_to_size, style_code, garment_family, notes)
SELECT '\b6014', 'Comfort Colors', true, 'Relaxed', 'Long Sleeve', 'Crew Neck', 'midweight 6.1 oz garment-dyed', '100% Ring-Spun Cotton', 'Garment-Dyed', 'Low Stretch', 'Runs Slightly Small', '6014', 'long_sleeve_tee', 'PO 2026-08-21 SKU rule: CC long sleeve (B0GR6VGCBJ, B0GQ6PGR2N)'
WHERE NOT EXISTS (SELECT 1 FROM blank_specs WHERE style_code = '6014');

-- Gildan 64400 — Softstyle Long Sleeve T-Shirt (4.5 oz ring-spun).
INSERT INTO blank_specs (match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, style_code, garment_family, notes)
SELECT 'g?64400', 'Gildan', false, 'Classic', 'Long Sleeve', 'Crew Neck', 'lightweight 4.5 oz ring-spun', 'Ring-Spun Cotton', '64400', 'long_sleeve_tee', 'PO 2026-08-21 SKU rule: Gildan LS (B0GW9V8SLK; B0DQ5YZH38 LS subset)'
WHERE NOT EXISTS (SELECT 1 FROM blank_specs WHERE style_code = '64400');

-- Gildan 18000 — Heavy Blend Crewneck Sweatshirt (8.0 oz, 50/50 cotton/polyester fleece).
-- SKU tokens glue 1800 + size (BCSG18002X, EDG1800L): the regex accepts 1800 / 18000 at a word
-- start; the SKU extractor accepts the elided zero when a size token follows.
INSERT INTO blank_specs (match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, style_code, garment_family, notes)
SELECT '\b1800(?:0)?(?=\D|$)|\b18000', 'Gildan', false, 'Classic', 'Long Sleeve', 'Crew Neck', 'heavyweight 8.0 oz fleece', '50% Cotton / 50% Polyester', '18000', 'sweatshirt', 'PO 2026-08-21 SKU rule: Gildan crewneck sweatshirt (B0DSCDZC6K)'
WHERE NOT EXISTS (SELECT 1 FROM blank_specs WHERE style_code = '18000');

-- Gildan 18500 — Heavy Blend Hooded Sweatshirt (same fleece; hooded).
INSERT INTO blank_specs (match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, style_code, garment_family, notes)
SELECT '\b18500', 'Gildan', false, 'Classic', 'Long Sleeve', 'Hooded', 'heavyweight 8.0 oz fleece', '50% Cotton / 50% Polyester', '18500', 'hoodie', 'PO 2026-08-21 SKU rule: Gildan hoodie (B0DSCDZC6K hoodie subset)'
WHERE NOT EXISTS (SELECT 1 FROM blank_specs WHERE style_code = '18500');

-- Bella+Canvas 3001 — Unisex Jersey Short Sleeve Tee (4.2 oz Airlume combed ring-spun, retail fit).
-- fit is the bare adjective 'Retail' (catalog convention: consumers render "<fit> Fit", like
-- 'Relaxed'/'Classic'). brand_in_copy false = conservative default (PO may flip with one UPDATE).
INSERT INTO blank_specs (match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, style_code, garment_family, notes)
SELECT '\bbc3001|\b3001(?=\D|$)', 'Bella+Canvas', false, 'Retail', 'Short Sleeve', 'Crew Neck', 'lightweight 4.2 oz combed ring-spun', '100% Airlume Combed Ring-Spun Cotton', '3001', 'tee', 'PO 2026-08-21 SKU rule: BC3001 (B0GR1K3TXF subset, mixed with 64000)'
WHERE NOT EXISTS (SELECT 1 FROM blank_specs WHERE style_code = '3001');

-- Gildan 64000B — YOUTH Softstyle T-Shirt (4.5 oz ring-spun). PO 2026-08-21: B0DP5H8QBT is 64000B.
-- The trailing B IS part of the code: extraction prefers '64000B' over '64000' when the SKU carries
-- the B followed by a size token; the kids row is never the adult 64000 row. (Legacy-regex hay only:
-- the adult '64000' (\b64000) row is earlier by id and would win there — B0DP5H8QBT resolves by override.)
INSERT INTO blank_specs (match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, style_code, garment_family, notes)
SELECT '\b64000b', 'Gildan', false, 'Classic', 'Short Sleeve', 'Crew Neck', 'lightweight 4.5 oz ring-spun', 'Ring-Spun Cotton', '64000B', 'kids_tee', 'PO 2026-08-21: Gildan youth Softstyle (B0DP5H8QBT by override)'
WHERE NOT EXISTS (SELECT 1 FROM blank_specs WHERE style_code = '64000B');

-- ── 3. PO-maintained family overrides (families whose SKUs carry NO style code) ──────────────────
CREATE TABLE IF NOT EXISTS blank_family_overrides (
  parent_asin text PRIMARY KEY,
  style_code  text NOT NULL,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE blank_family_overrides ENABLE ROW LEVEL SECURITY;
-- Service-role only (mirrors blank_specs: the pipeline reads with the service key; no anon/user surface).

COMMENT ON TABLE blank_family_overrides IS
  'PO-maintained blank identity for families whose child SKUs carry no style code (MAHATS*, AJK-*, Amazon-opaque SKUs). style_code must match a blank_specs.style_code. Consulted ONLY when no child SKU resolves a style code. PO-EDITABLE, no deploy (reader caches 5 min).';

INSERT INTO blank_family_overrides (parent_asin, style_code, notes) VALUES
  ('B0FC8R484P', '64000',  'MAHATS SKUs carry no style code'),
  ('B0FC9BQZT2', '64000',  'MAHATS2 — sibling of B0FC8R484P'),
  ('B0FKFHSCS9', '1717',   'AJK SKUs carry no style code'),
  ('B0DP5H8QBT', '64000B', 'Amazon-opaque SKUs; PO: Gildan youth 64000B')
ON CONFLICT (parent_asin) DO NOTHING;
-- ON CONFLICT DO NOTHING = idempotent re-run safety AND never clobbers a PO edit to an existing row.

NOTIFY pgrst, 'reload schema';
