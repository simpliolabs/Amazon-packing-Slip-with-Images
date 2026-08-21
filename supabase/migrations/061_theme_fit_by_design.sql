-- 061_theme_fit_by_design.sql
-- PER-DESIGN theme fit for multi-design POD families (PO ruling 2026-08-21, refining the per-design
-- Item Highlight ruling). Idempotent — safe to re-run. Apply BY HAND in the Supabase SQL editor.
--
-- WHY. A multi-design family (B0DQ5YZH38: BD Boss Definition / BM Beast Mode / DQ Don't Quit /
-- RIACG Relax I'm a CEO / RK Real King graffiti) shares ONE keyword pool, and `theme_fit` (049) is
-- ONE judgment against the FAMILY card — a card that names every design at once, so "Motivational
-- Shirts Women" passed for the Real King graffiti tee. PO ruling: the family's Item Highlight is ONE
-- shared line (each child's title already carries its design name) and every phrase in it must be
-- TRUE FOR EVERY DESIGN — the pool is rated against EACH design's card and a phrase composes only
-- when its fit is >= 2 under EVERY design (min-over-designs).
--
-- SHAPE (both keyed by the design key detectDesignGroups derives from the child SKUs — the SAME key
-- per_child_titles / per_child_item_highlights carry):
--
--   theme_fit_by_design  jsonb  { "<designKey>": { "fit": 0-3, "about": "<1-3 words>" }, ... }
--   theme_run_by_design  jsonb  { "<designKey>": "kt_<epoch>_<rand>", ... }
--
-- A design key ABSENT from a row = that row was never rated under that design (the composer treats
-- it as null ⇒ the phrase cannot compose). The family-level theme_fit / theme_about / theme_run_id
-- are UNTOUCHED by this migration and by the per-design rater — the single-design path is
-- byte-identical. Written ONLY by keyword-pool/rerate { per_design: true } through the merge function
-- below; storeAnalysis omits both columns so a research sync preserves them (PostgREST upsert keeps
-- omitted columns) — a row the stale-prune deletes takes its per-design fits with it, as it should.

ALTER TABLE keyword_analysis ADD COLUMN IF NOT EXISTS theme_fit_by_design jsonb;
ALTER TABLE keyword_analysis ADD COLUMN IF NOT EXISTS theme_run_by_design jsonb;

COMMENT ON COLUMN keyword_analysis.theme_fit_by_design IS
  'PER-DESIGN theme fit for multi-design families: {"<designKey>": {"fit": 0-3, "about": "..."}}. Rated against EACH design''s own card (keyword-pool/rerate {per_design:true}, zero Jungle Scout credits). The shared Item Highlight composes a phrase only when min(fit over every design) >= 2. A missing key = never rated under that design. Family-level theme_fit is separate and untouched.';
COMMENT ON COLUMN keyword_analysis.theme_run_by_design IS
  'Per-design rater run ids: {"<designKey>": "kt_<epoch>_<rand>"}. The epoch inside a run id is the per-(pool, design) rerate guard''s completion evidence (10-minute cooldown). Written together with theme_fit_by_design, for the rated rows only.';

-- ONE merge seam: PostgREST cannot express `jsonb || jsonb` in an UPDATE payload, and a per-row
-- UPDATE loop would be ~100 round trips per design. This function merges ONE design's ratings into
-- the rows it names (exact stored keyword), leaving every other design's entry and every unrated row
-- untouched. p_ratings = {"<stored keyword>": {"fit": n, "about": "..."}}. Returns rows updated.
CREATE OR REPLACE FUNCTION merge_theme_fit_by_design(
  p_asin text,
  p_design_key text,
  p_run_id text,
  p_ratings jsonb
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE keyword_analysis ka
     SET theme_fit_by_design = COALESCE(ka.theme_fit_by_design, '{}'::jsonb) || jsonb_build_object(p_design_key, r.value),
         theme_run_by_design = COALESCE(ka.theme_run_by_design, '{}'::jsonb) || jsonb_build_object(p_design_key, to_jsonb(p_run_id))
    FROM jsonb_each(p_ratings) AS r(key, value)
   WHERE ka.asin = p_asin
     AND ka.keyword = r.key;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMENT ON FUNCTION merge_theme_fit_by_design(text, text, text, jsonb) IS
  'Merge one design''s theme ratings into keyword_analysis.theme_fit_by_design / theme_run_by_design for the named (asin, keyword) rows only. Called by keyword-pool/rerate {per_design:true}. Never touches family-level theme_fit.';

-- Tell PostgREST to pick up the new columns + function immediately (matches 033 / 060).
NOTIFY pgrst, 'reload schema';
