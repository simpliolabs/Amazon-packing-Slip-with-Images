-- 062_blank_assignments.sql — ONE table for PO-stated blank identity (PO ruling 2026-08-22).
--
-- WHY A NEW LEVEL EXISTS AT ALL. The repo's blank identity rule is SKU-FIRST (PO 2026-08-21,
-- SELLER_PROFILE "Blank identity is stated in the CHILD SKU"; migration 058): the style code in a
-- child SKU's leading token names the blank, and it beats every brand word inferred from copy. That
-- rule assumed the SKU is always RIGHT. It is not.
--
-- THE SPECIMEN: B0DSG4T5BR, SKU `BB64000XL-BK-FBA`, a child of B0DSCDZC6K. Three sources disagree:
--     the SKU style code says   Gildan 64000        (adult short-sleeve tee)
--     the Amazon listing title says "Sweatshirt"
--     the PO says               Comfort Colors 6014 (adult LONG SLEEVE tee)  <- the truth
-- The "64000" in that SKU is a typo, and there is no way to correct ONE child without renaming the
-- SKU on Amazon (which destroys the offer's history). `blank_family_overrides` cannot help: it is
-- keyed on PARENT and would restate the whole 34-SKU family as a long sleeve tee.
--
-- WHY ONE TABLE AND NOT TWO. The obvious shape was a second table, `blank_child_overrides`, beside
-- the existing family one. The PO vetoed it: two tables for ONE concept — "the PO has stated which
-- blank this is" — is exactly how this codebase grew SEVEN definitions of "covered" and FOUR
-- keyword-pool key resolvers. A second table means a second loader, a second cache, a second
-- fail-open path and, eventually, two answers to one question. `blank_assignments` is the single
-- home; SCOPE is a column, not a table name.
--
-- RESOLUTION PRECEDENCE (unchanged in shape, now sourced from one table):
--     1. blank_assignments  scope='child'   (SKU)          -> source 'child-assignment'
--     2. the SKU's own style code                          -> source 'sku-code'
--     3. blank_assignments  scope='family'  (parent ASIN)   -> source 'family-assignment'
--     4. the legacy match_pattern regex over the hay       -> source 'legacy'
-- Those four strings are API SURFACE: the portal renders the winning source as a badge, so they are
-- exported as `BlankSource` in src/lib/fba/blankSpecs.ts and must not be renamed casually.
--
-- AN ASSIGNMENT IS A STATEMENT, NOT AN INFERENCE, and that is why it also changes the garment
-- CONFLICT gate: `resolveFamilyBlank` refuses to NULL a resolution in which every conflicting row
-- was PO-stated. The mislabeled child's own design group therefore resolves to a long_sleeve_tee
-- even though its stored Amazon title still says "Sweatshirt" — while at FAMILY scope that row is
-- still a non-dominant minority (1 of 34), so it loses its vote on the family's facts and
-- GARMENT_UNION_DOMINANCE keeps the family union at sweatshirt+hoodie. The parent title never says
-- "shirt"; that one child truthfully may.
--
-- `blank_family_overrides` IS DEPRECATED BY THIS MIGRATION BUT DELIBERATELY NOT DROPPED. A DROP is
-- irreversible and would take the PO's existing rows with it if anything here needed rolling back;
-- the rows are BACKFILLED below and the reader prefers `blank_assignments`, so the old table simply
-- goes quiet. Drop it in a later migration once the new table has been live through a full regen.

CREATE TABLE IF NOT EXISTS blank_assignments (
  scope       text NOT NULL CHECK (scope IN ('family','child')),
  key         text NOT NULL,          -- family: parent_asin · child: sku
  style_code  text NOT NULL,
  note        text,
  set_by      text,
  set_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

ALTER TABLE blank_assignments ENABLE ROW LEVEL SECURITY;
-- Service-role only (mirrors blank_specs / blank_family_overrides: the pipeline reads with the
-- service key; there is no anon or end-user surface for the blank catalog).

COMMENT ON TABLE blank_assignments IS
  'PO-stated blank identity, both scopes in ONE table. scope=''family'' keys on parent_asin and names the blank for families whose child SKUs carry no style code (MAHATS*, AJK-*, Amazon-opaque SKUs). scope=''child'' keys on a single SKU and exists because a SKU style code can be WRONG — a mislabeled SKU that cannot be renamed on Amazon without losing the offer (B0DSG4T5BR / BB64000XL-BK-FBA is a Comfort Colors 6014 long sleeve whose SKU says 64000). style_code must match a blank_specs.style_code. Precedence: child assignment -> SKU style code -> family assignment -> legacy match_pattern. Supersedes blank_family_overrides (deprecated, backfilled, not yet dropped). PO-EDITABLE, no deploy (reader caches 5 min, fail-open).';

COMMENT ON COLUMN blank_assignments.scope IS
  '''family'' (key = parent_asin) or ''child'' (key = the exact listing_content.sku). Child scope wins over every other source, including the SKU''s own code.';
COMMENT ON COLUMN blank_assignments.key IS
  'parent ASIN for scope=''family'', child SKU for scope=''child''. Matched case-insensitively on read.';
COMMENT ON COLUMN blank_assignments.style_code IS
  'The blank this thing ACTUALLY is — must exist as blank_specs.style_code, or the assignment resolves nothing (fail-open to the next precedence level).';

-- ── BACKFILL: every existing family override becomes a scope='family' assignment ─────────────────
-- Idempotent, and it never clobbers a row already written to the new table.
INSERT INTO blank_assignments (scope, key, style_code, note, set_by, set_at)
SELECT 'family', o.parent_asin, o.style_code, o.notes, 'migration-062-backfill', COALESCE(o.created_at, now())
  FROM blank_family_overrides o
ON CONFLICT (scope, key) DO NOTHING;

-- ── THE CHILD ASSIGNMENT that motivated this table ──────────────────────────────────────────────
INSERT INTO blank_assignments (scope, key, style_code, note, set_by) VALUES
  ('child', 'BB64000XL-BK-FBA', '6014', 'PO 2026-08-22: Comfort Colors long sleeve; the 64000 in the SKU is a mistake', 'PO')
ON CONFLICT (scope, key) DO NOTHING;
-- ON CONFLICT DO NOTHING = idempotent re-run safety AND never clobbers a PO edit to an existing row.

NOTIFY pgrst, 'reload schema';
