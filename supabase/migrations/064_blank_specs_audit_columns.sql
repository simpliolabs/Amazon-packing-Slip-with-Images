-- 064_blank_specs_audit_columns.sql
-- 061_theme_fit_by_design.sql is the highest applied before this on main. Migrations 062/063 belong
-- to a CONCURRENT agent's blank_assignments work (handoff/BLANKS_IN_PORTAL_DESIGN.md §5.1 — the ONE
-- unified assignment table, decision A) — this migration does NOT create or touch that table, and
-- does not renumber around it. Apply BY HAND in the Supabase SQL editor, in any order relative to
-- 062/063 (no shared columns). IDEMPOTENT: every statement is IF NOT EXISTS, so a re-run is a no-op
-- and never clobbers a PO edit.
--
-- WHY: the Settings → Blanks CRUD (src/app/api/fba/blanks/route.ts, PO decision D 2026-08-22 —
-- "any signed-in user may edit blanks... but always record set_by for accountability") needs a place
-- to stamp WHO created/last-touched a blank_specs row — blank_specs had no audit columns at all.
-- The usage-count query (GET /api/fba/blanks "used by N families", POST /api/fba/blanks/impact —
-- src/lib/fba/blankAssignmentImpact.ts) also benefits from an index on the column it filters/groups
-- by (active style codes) — the table is small today, but the index is cheap and future-proofs it.

ALTER TABLE blank_specs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by text,
  ADD COLUMN IF NOT EXISTS created_by text;

COMMENT ON COLUMN blank_specs.updated_by IS
  'full_name || email of the signed-in user who last created/edited this row (PO decision D, 2026-08-22: any signed-in user may edit blanks, but every write is attributed — never admin-only).';
COMMENT ON COLUMN blank_specs.created_by IS
  'full_name || email of the signed-in user who created this row.';

CREATE INDEX IF NOT EXISTS idx_blank_specs_style_code_active
  ON blank_specs (style_code)
  WHERE active = true;

NOTIFY pgrst, 'reload schema';
