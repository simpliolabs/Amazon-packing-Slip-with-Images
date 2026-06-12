-- Migration 026: OUR organic rank per keyword — current value + time series (PO 2026-06-11:
-- "import OUR ranking Keywords and create a column for it that we can track over time").
-- Jungle Scout keywords-by-asin returns our organic rank on every fresh research; the engine
-- was discarding it. With H10 cancelled, this is the portal's rank tracker.
--   • keyword_analysis.organic_rank = the CURRENT rank (NULL = not ranking) → the table column.
--   • keyword_rank_snapshots = the series. snapshot_date = capture DAY (same-day re-runs
--     collapse to one row via UNIQUE + upsert). organic_rank NULL = checked, not ranking —
--     presence of the row still matters (shows when we entered/left the rankings).
-- Capture degrades gracefully if the table is absent (best-effort, never breaks a sync).

ALTER TABLE keyword_analysis ADD COLUMN IF NOT EXISTS organic_rank integer;

CREATE TABLE IF NOT EXISTS keyword_rank_snapshots (
  id             BIGSERIAL   PRIMARY KEY,
  asin           TEXT        NOT NULL,
  keyword        TEXT        NOT NULL,
  snapshot_date  DATE        NOT NULL,
  organic_rank   INTEGER,
  search_volume  INTEGER,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kw_rank_snapshot UNIQUE (asin, keyword, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_kw_rank_snapshot_lookup
  ON keyword_rank_snapshots (asin, keyword, snapshot_date DESC);

ALTER TABLE keyword_rank_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_keyword_rank_snapshots" ON keyword_rank_snapshots;
CREATE POLICY "service_role_keyword_rank_snapshots" ON keyword_rank_snapshots FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
