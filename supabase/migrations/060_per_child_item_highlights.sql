-- 060_per_child_item_highlights.sql
-- Storage for per-DESIGN Item Highlights on multi-design POD families (PO ruling 2026-08-21).
-- PO on B0DQ5YZH38 (designs BD/BM/DQ/RIACG/RK): "is a multi design product, needs a highlight per
-- design?" — yes. Titles (017 / per_child_titles), bullets + descriptions (033 / per_child_*) already
-- fan out per design; the Item Highlight was ONE broadcast line composed from ONE design's identity
-- ("Beast Mode Shirt, …"), false on four of five designs. Same model, same shape:
--
--   per_child_item_highlights  jsonb array of
--     { sku, asin, item_highlight: string, designName?, designKey?, hold?: string|null, pushed_value?: string|null }
--
--   item_highlight  = the design's composed line ('' when the design HOLDS — see `hold`)
--   hold            = the composer's named hold reason for that design (unrated-pool / thin-candidates /
--                     under-floor / no-spec), null when a line exists
--   pushed_value    = write-through mirror of the last ACCEPTED push of that line (the per-design
--                     "✓ On Amazon" signal — the broadcast row's current_value cannot carry N lines)
--
-- NULL/empty for single-design + non-apparel families — those keep the broadcast Item Highlight row in
-- product_details_improvements (unchanged behavior). On a multi-design family that row becomes a
-- per-design MARKER ({ per_design: true, recommended_value: '' }) so a broadcast Ship can never push one
-- design's line to every SKU; the push resolves each SKU's own line from this array and SKIPS a SKU whose
-- design has no line ('no-line-for-design').

ALTER TABLE listing_seo_recommendations
  ADD COLUMN IF NOT EXISTS per_child_item_highlights jsonb;

COMMENT ON COLUMN listing_seo_recommendations.per_child_item_highlights IS
  'Per-design Item Highlights for multi-design POD families. Each entry: {sku, asin, item_highlight, designName?, designKey?, hold?, pushed_value?}. NULL for single-design/non-apparel (they use the broadcast Item Highlight row in product_details_improvements).';

-- Tell PostgREST to pick up the new column immediately (the app reads via supabase-js → PostgREST;
-- without this the new column 404s against the schema cache until the next auto-reload). Matches 033.
NOTIFY pgrst, 'reload schema';
