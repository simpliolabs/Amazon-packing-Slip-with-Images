-- ═══════════════════════════════════════════════════════════════════════
-- 020 — Description & Features get their own score columns
-- ═══════════════════════════════════════════════════════════════════════
-- Description quality used to be deducted from keyword_score, and product-detail
-- (Features) completeness from aplus_score — so the seller was penalized for them
-- but never saw a card. scoreListingContent now returns description_score and
-- features_score as standalone /25 sub-scores, and overall_score is normalized to
-- a 0-100 percentage across all six sections.
--
-- Columns are nullable: existing rows stay NULL until the next sync / regen / push
-- re-scores them (the listing page shows the two new cards once they're populated).

ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS description_score NUMERIC(3,0);
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS features_score    NUMERIC(3,0);

NOTIFY pgrst, 'reload schema';
