-- Migration 041: Manual multi-design classification override
-- Lets the seller force single/multi-design when auto-detection (SKU structure) gets it wrong.
-- NULL = auto-detect (current behavior), true = force multi, false = force single.

ALTER TABLE listing_seo_scores
  ADD COLUMN IF NOT EXISTS is_multi_design_override boolean DEFAULT NULL;
