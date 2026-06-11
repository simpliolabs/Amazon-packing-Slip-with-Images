-- Migration 023: per-keyword SQP share time-series (the "outcome loop", task #89)
-- ═══════════════════════════════════════════════════════════════════════
-- SQP impression/click/purchase SHARE is only available at sync time (the engine drops it
-- before storage — getStoredAnalysis returns share=0). This table is the ONLY persistent
-- record of a keyword's share over time, so the loop can answer "did share rise AFTER a
-- content change?" (correlation, never causation).
--   • snapshot_date = the SQP report's last-full-calendar-month end date, so two syncs in the
--     same data-month collapse to ONE row (UNIQUE asin,keyword,snapshot_date + upsert). The
--     series therefore advances ~once per month — matching Amazon's SQP cadence.
--   • content_fingerprint = sha1 of the live copy at capture time → lets the signal detect a
--     content change between two snapshots (a "flat-despite-change" keyword = non-content
--     bottleneck: reviews/price/velocity, not more copy).
-- The capture write degrades gracefully if this table is absent (best-effort, never breaks a
-- keyword sync), so the code is safe to deploy before this migration runs.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS keyword_share_snapshots (
  id                  BIGSERIAL   PRIMARY KEY,
  asin                TEXT        NOT NULL,
  keyword             TEXT        NOT NULL,
  snapshot_date       DATE        NOT NULL,
  impression_share    NUMERIC(7,3),   -- 0-100 (engine-normalized asinImpressionShare) — the PRIMARY metric
  click_share         NUMERIC(7,3),
  purchase_share      NUMERIC(7,3),
  search_volume       INTEGER,
  content_fingerprint TEXT,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_kw_share_snapshot UNIQUE (asin, keyword, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_kw_share_snapshot_lookup
  ON keyword_share_snapshots (asin, keyword, snapshot_date DESC);

-- RLS — match every other table (service role full access)
ALTER TABLE keyword_share_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_keyword_share_snapshots" ON keyword_share_snapshots FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
