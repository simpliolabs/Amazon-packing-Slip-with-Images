-- 017_per_child_titles.sql
-- Storage for per-child capacity titles (the SD card 64/128/256GB case).
-- For non-apparel families whose children span >=2 distinct capacities, the optimizer emits
-- one title per child carrying that child's own capacity. This column persists them so the UI
-- can render the Title section per-child, and the push route can target each child's SKU.
--
-- Shape: jsonb array of { sku: string, asin: string, title: string } — same pattern as the
-- existing per_child_keywords (which is stored as a JSON string in recommended_keywords).
-- Null/empty for apparel and single-capacity products — those keep the broadcast title in
-- recommended_title (unchanged behavior).

ALTER TABLE listing_seo_recommendations
  ADD COLUMN IF NOT EXISTS per_child_titles jsonb;

COMMENT ON COLUMN listing_seo_recommendations.per_child_titles IS
  'Per-child title list for capacity/spec variation families. Each entry: {sku, asin, title}. NULL for apparel and single-capacity products (they use the broadcast recommended_title).';
