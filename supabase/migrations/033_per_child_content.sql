-- 033_per_child_content.sql
-- Storage for per-DESIGN bullets + description on multi-design POD families (Commit 2 follow-up).
-- Commit 2 (migration 017 / per_child_titles) gave each design group its own TITLE; bullets and
-- description were still ONE broadcast set for the whole family. PO 2026-06-17: each design should
-- get its OWN bullets + description (e.g. B0F6QZ34B1's FHOSH / FRAF / OF fishing designs).
--
-- Shape mirrors per_child_titles:
--   per_child_bullets       jsonb array of { sku, asin, bullets: string[] }
--   per_child_descriptions  jsonb array of { sku, asin, description: string }
-- NULL/empty for single-design + non-apparel families — those keep the broadcast
-- recommended_bullets / recommended_description (unchanged behavior). PLANNED (PR3): the push route
-- will resolve a child's value here first (same precedence as per_child_titles), else fall back to
-- broadcast. Until PR3 wires pushExecutor/resolveProposed, these are persisted-only — the push still
-- sends the broadcast bullets/description to every SKU.

ALTER TABLE listing_seo_recommendations
  ADD COLUMN IF NOT EXISTS per_child_bullets jsonb;

ALTER TABLE listing_seo_recommendations
  ADD COLUMN IF NOT EXISTS per_child_descriptions jsonb;

COMMENT ON COLUMN listing_seo_recommendations.per_child_bullets IS
  'Per-design bullets for multi-design POD families. Each entry: {sku, asin, bullets:string[]}. NULL for single-design/non-apparel (they use the broadcast recommended_bullets).';
COMMENT ON COLUMN listing_seo_recommendations.per_child_descriptions IS
  'Per-design description for multi-design POD families. Each entry: {sku, asin, description}. NULL for single-design/non-apparel (they use the broadcast recommended_description).';

-- Tell PostgREST to pick up the new columns immediately (the app reads via supabase-js → PostgREST;
-- without this the new columns 404 against the schema cache until the next auto-reload). Matches 032.
NOTIFY pgrst, 'reload schema';
