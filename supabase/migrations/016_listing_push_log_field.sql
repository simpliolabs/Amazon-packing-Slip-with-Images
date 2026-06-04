-- 016_listing_push_log_field.sql
-- Generalize the push audit log from keyword-only to any content field.
-- PR "push-content per-section" lets the seller ship Title (item_name),
-- Bullets (bullet_point), Description (product_description) and Backend
-- keywords (generic_keyword) independently. We tag every push row with which
-- field it wrote so the log/rollback can distinguish them.
--
-- Additive + backward-compatible: existing rows (all keyword pushes) default to
-- 'keywords', so the table name (keyword_push_log) and its history stay intact.

ALTER TABLE keyword_push_log
  ADD COLUMN IF NOT EXISTS field text NOT NULL DEFAULT 'keywords';

-- For per-field history queries (e.g. "show the last title push for this parent").
CREATE INDEX IF NOT EXISTS idx_keyword_push_log_field ON keyword_push_log (parent_asin, field, pushed_at DESC);
