-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 051 — the competitor SOV columns keywordResearcher has been writing to for weeks, which no
--       migration ever created
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- LIVE FAILURE (2026-07-30 19:26, B0GR22ZHBW research): every research run logs
--   [keywordResearcher] Failed to store competitor meta: Could not find the
--   'competitor_sov_clicks' column of 'listing_seo_scores' in the schema cache
-- storeCompetitorMeta (keywordResearcher.ts:1050-1060) updates five columns on listing_seo_scores;
-- competitor_asin / competitor_brand / competitor_link exist, but competitor_sov_clicks and
-- competitor_sov_conversions were never migrated — migration 014 added SOV columns to
-- keyword_cache, not to listing_seo_scores. The write fails wholesale (one UPDATE, five columns),
-- so ALL five values are silently lost on every research, including the three whose columns exist.
--
-- Non-fatal by design (the error is caught and logged), which is exactly why it survived: research
-- completes, nothing surfaces, and the competitor share-of-voice data the UI could show is simply
-- never there.

ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS competitor_sov_clicks NUMERIC;
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS competitor_sov_conversions NUMERIC;

COMMENT ON COLUMN listing_seo_scores.competitor_sov_clicks IS
  'Share-of-voice click share of the #1 competitor (Jungle Scout SOV API), written by '
  'keywordResearcher.storeCompetitorMeta on each research. Migration 051 — the code wrote this '
  'column for weeks before it existed; the single UPDATE failed wholesale and silently dropped '
  'all five competitor meta values.';
COMMENT ON COLUMN listing_seo_scores.competitor_sov_conversions IS
  'Share-of-voice conversion share of the #1 competitor. See competitor_sov_clicks (migration 051).';

NOTIFY pgrst, 'reload schema';
