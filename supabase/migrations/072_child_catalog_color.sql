-- 072: per-child catalog colour on listing_content (2026-08-28).
-- 071_blank_specs_age_class.sql is the highest applied. Apply BY HAND in the Supabase SQL editor.
--
-- PO RULING 2026-08-28 (family B0DP5H8QBT, 12 children, live). decodeSkuColor (skuColorCodes.ts)
-- derives a child's colour by parsing TEXT — the last '-'-separated SKU segment, any single
-- unambiguous segment, or the child's own title's trailing "- Color - Size". For this family the
-- SKUs are Amazon-generated opaque strings (1V-C6WM-US5T, 3A-MINF-4TRD, 4K-WJVI-T618,
-- 5M-0T69-IFXD) — no segment is a colour code and none ever will be, so every fallback returns
-- null, all 12 children collapse to ONE identical backend-keywords string, and the degrade gate
-- (listingPipeline.ts's backendOutputProblems) refuses to persist — correctly, but PERMANENTLY:
-- the failure is deterministic on the SKU shape, so every retry the banner invites fails
-- identically. Same shape as the parent-lock bug fixed the day before (a protective mechanism
-- turning a permanent failure into an invisible freeze).
--
-- Amazon already knows each child's colour (productDetailAttrs.ts's ATTR_MAP already declares
-- 'color' as an SP-API attribute, scope 'per-variant') and the code never asked. This column is
-- the STORED per-child answer, populated by the Catalog Items API (ItemSummaryByMarketplace.color
-- — see src/lib/amazon/catalogColor.ts) via the backfill route and consulted FIRST by
-- resolveChildColor (childColorResolver.ts), which falls back to decodeSkuColor only when this is
-- NULL. decodeSkuColor itself is unchanged — it stays the fallback for children Amazon hasn't
-- been asked about yet.
--
-- NULL means "not fetched / unknown" ONLY — never a colour, and never inferred. No DEFAULT: a
-- default that is also a legal colour value would hide total failure exactly the way
-- Department='Unisex' did for age_class (071's lesson). Every existing row starts NULL; the
-- backfill route (/api/fba/admin/backfill-child-color) fills them in READ-ONLY, batched,
-- resumable passes. Additive + idempotent: a re-run of this migration is a no-op, and the
-- listing_content upsert in syncListingContent.ts never sets this column (column-absent-from-
-- payload upserts leave existing values untouched), so a routine sync can never clobber it.

ALTER TABLE listing_content
  ADD COLUMN IF NOT EXISTS color text;

COMMENT ON COLUMN listing_content.color IS
  'Per-CHILD-ASIN colour from Amazon''s own Catalog Items API (ItemSummaryByMarketplace.color via getCatalogItem, includedData=summaries) — READ ONLY, never written back to Amazon. NULL = not fetched / unknown, never a colour. Populated by /api/fba/admin/backfill-child-color (batched, resumable) and read FIRST by resolveChildColor (childColorResolver.ts), which falls back to decodeSkuColor (skuColorCodes.ts, text-parsed from the SKU/title) only when this is NULL. Migration 072, PO ruling 2026-08-28 (family B0DP5H8QBT: opaque Amazon-generated SKUs where no text fallback can ever succeed).';

NOTIFY pgrst, 'reload schema';
