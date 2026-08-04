-- 053_blank_specs.sql
-- 052_listing_content_is_customizable.sql is the highest applied. Apply BY HAND in the Supabase SQL
-- editor, BEFORE the deploy (fail-open makes ordering safe either way: code deployed first just
-- logs "[blankSpecs] catalog load failed (fail-open to seeds)" and behaves byte-identically).
--
-- THE BLANK CATALOG LEAVES THE CODE. blank facts are THE proven title lever (adding the Gildan
-- 64000 row moved B0GR22ZHBW's title 63→70 with zero other changes), but the catalog lived as a
-- hardcoded const inside listingPipeline.ts, so every new blank was a code deploy. This table is
-- now the AUTHORITATIVE catalog: the PO adds or corrects a blank with one INSERT/UPDATE — no
-- deploy — and affected listings heal on their next plain regen (reader caches 5 min).
--
-- The two seed rows are BYTE-IDENTICAL to the historical hardcoded table (and to
-- DEFAULT_BLANK_SPECS in src/lib/fba/blankSpecs.ts, which is the fail-open floor when this table
-- is unreachable or empty — the seeds are a floor, never an alternate behavior path).
--
-- Column semantics (must mirror rowToSpec in src/lib/fba/blankSpecs.ts):
--   match_pattern  case-insensitive REGEX over the listing hay (title/attributes/productType/SKUs).
--                  NOTE '\b64000' has NO trailing boundary ON PURPOSE — SKU-glued style numbers
--                  like "640002XL" must match. An invalid regex row is SKIPPED with a warn, it
--                  never breaks the catalog.
--   brand          AUTHORITATIVE display casing (spec-vs-search grounding: facts come from HERE,
--                  never the search pool).
--   brand_in_copy  false = facts decorate copy but the brand NAME never appears in customer-facing
--                  text (the Gildan rule). Default true. Only explicit FALSE materializes in code.
--   NULL fact columns = the blank does not claim that fact (absent, not empty string).
--   active         false = soft-delete; the reader only loads active rows.

CREATE TABLE IF NOT EXISTS blank_specs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_pattern text NOT NULL,
  brand         text,
  brand_in_copy boolean NOT NULL DEFAULT true,
  fit           text,
  sleeve        text,
  neck          text,
  weight_note   text,
  material      text,
  dye           text,
  stretch       text,
  fit_to_size   text,
  active        boolean NOT NULL DEFAULT true,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE blank_specs ENABLE ROW LEVEL SECURITY;
-- Service-role only (the pipeline reads with the service key; no anon/user surface).

COMMENT ON TABLE blank_specs IS
  'Garment-blank fact catalog (spec-vs-search grounding). First matching active row wins, in id order. PO-EDITABLE: INSERT/UPDATE here adds/corrects a blank with NO deploy; the pipeline reader (src/lib/fba/blankSpecs.ts) caches 5 min and fails open to the two in-code seed rows if this table is unreachable or empty.';
COMMENT ON COLUMN blank_specs.match_pattern IS
  'Case-insensitive regex over the listing hay (title + pinned attribute + productType + SKU haystack). Keep \b64000-style patterns WITHOUT a trailing boundary so SKU-glued style numbers ("640002XL") match.';
COMMENT ON COLUMN blank_specs.brand_in_copy IS
  'false = the Gildan rule: facts (weight/material/fit) ground the copy but the brand NAME never appears in customer-facing text.';

-- Seeds — byte-identical to the historical hardcoded rows. brand_in_copy: CC row historically
-- OMITS the field (= true); Gildan row is the explicit false.
INSERT INTO blank_specs (match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, dye, stretch, fit_to_size)
SELECT * FROM (VALUES
  ('\bcomfort\s*colors?\b', 'Comfort Colors', true,  'Relaxed', 'Short Sleeve', 'Crew Neck', 'midweight 6.1 oz garment-dyed', '100% Ring-Spun Cotton', 'Garment-Dyed', 'Low Stretch', 'Runs Slightly Small'),
  ('\bgildan\b|\b64000',    'Gildan',         false, 'Classic', 'Short Sleeve', 'Crew Neck', 'lightweight 4.5 oz ring-spun', 'Ring-Spun Cotton',      NULL,           NULL,          NULL)
) AS seed(match_pattern, brand, brand_in_copy, fit, sleeve, neck, weight_note, material, dye, stretch, fit_to_size)
WHERE NOT EXISTS (SELECT 1 FROM blank_specs);
-- WHERE NOT EXISTS = idempotent re-run safety AND never clobbers PO edits to the seeded rows.

NOTIFY pgrst, 'reload schema';
