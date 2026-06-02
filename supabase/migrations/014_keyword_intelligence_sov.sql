-- 014_keyword_intelligence_sov.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds Share of Voice (SOV) support to the keyword intelligence pipeline.
-- Changes:
--   1. keyword_cache: relax CHECK constraint to allow 'keyword_research' source
--   2. keyword_cache: add competitor_asin, competitor_brand, sov_percentage columns
--   3. listing_seo_scores: add competitor_brand, competitor_link, sov_percentage columns
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop and recreate the source CHECK constraint to allow 'keyword_research'
ALTER TABLE keyword_cache DROP CONSTRAINT IF EXISTS keyword_cache_source_check;
ALTER TABLE keyword_cache ADD CONSTRAINT keyword_cache_source_check
  CHECK (source IN ('sqp', 'jungle_scout', 'keyword_research'));

-- 2. Add SOV metadata columns to keyword_cache
ALTER TABLE keyword_cache ADD COLUMN IF NOT EXISTS competitor_asin TEXT;
ALTER TABLE keyword_cache ADD COLUMN IF NOT EXISTS competitor_brand TEXT;
ALTER TABLE keyword_cache ADD COLUMN IF NOT EXISTS sov_percentage NUMERIC(5,2);

-- 3. Add competitor metadata columns to listing_seo_scores
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS competitor_brand TEXT;
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS competitor_link TEXT;
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS sov_percentage NUMERIC(5,2);

-- 4. Add index for keyword_research source lookups
CREATE INDEX IF NOT EXISTS idx_keyword_cache_research
  ON keyword_cache (asin, source)
  WHERE source = 'keyword_research';

-- 5. Comment for documentation
COMMENT ON COLUMN keyword_cache.competitor_asin IS 'The #1 competitor ASIN identified via Share of Voice API';
COMMENT ON COLUMN keyword_cache.competitor_brand IS 'Brand name of the #1 competitor';
COMMENT ON COLUMN keyword_cache.sov_percentage IS 'Share of Voice percentage for the #1 competitor (0-100)';
COMMENT ON COLUMN listing_seo_scores.competitor_brand IS 'Brand name of the configured competitor ASIN';
COMMENT ON COLUMN listing_seo_scores.competitor_link IS 'Amazon product URL for the competitor ASIN';
COMMENT ON COLUMN listing_seo_scores.sov_percentage IS 'Share of Voice percentage for the competitor (0-100)';
