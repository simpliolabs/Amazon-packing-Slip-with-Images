-- Per-design seller name override for multi-design POD families. {designKey: name} JSONB map on
-- the parent's score row, parallel to migration 031's single-value design_name_override (which the
-- multi-design path ignores). Idempotent. PostgREST reload so the new column is queryable at once.
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS design_name_overrides jsonb;
COMMENT ON COLUMN listing_seo_scores.design_name_overrides IS 'Per-design seller name overrides for multi-design families: {designKey: name}. Seeds the next regen (override > Amazon Color attr) + relabels the per-design cards. NULL/absent = auto-detect.';
NOTIFY pgrst, 'reload schema';
