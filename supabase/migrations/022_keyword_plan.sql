-- Migration 022: KeywordPlan column on listing_seo_recommendations (#92 / #93)
-- ═══════════════════════════════════════════════════════════════════════
-- Stores, per regen, the generator's ACTUAL bullet opportunity set + the real design name:
--   { "bullets": string[], "designName": string }
-- The scorer (scoreListingContent / fetchScoringContext) reads this so that:
--   • #93 — it docks bullets against the SAME keyword set the generator targeted
--     (topOpportunityKwsForBullets), closing the source/relevance-gate/title-exclusion
--     divergence the shared coverage predicate alone couldn't reach; and
--   • #92 — it can enforce cross-section design-name cohesion off the REAL design name
--     (not a capacity-unsafe title heuristic).
-- Nullable + JSONB: existing rows have no plan → the scorer falls back to legacy behavior.
-- The regen route also degrades gracefully (minimal-payload upsert) if this column is absent,
-- so the code is safe to deploy before this migration runs.
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE listing_seo_recommendations
  ADD COLUMN IF NOT EXISTS keyword_plan JSONB;

COMMENT ON COLUMN listing_seo_recommendations.keyword_plan IS
  'KeywordPlan {bullets:string[],designName:string} — generator''s bullet opportunity set + real design name, read by the scorer (#92/#93).';

NOTIFY pgrst, 'reload schema';
