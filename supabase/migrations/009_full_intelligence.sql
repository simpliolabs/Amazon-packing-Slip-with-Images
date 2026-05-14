-- Migration 009: Full FBA Intelligence Variables
-- Adds traffic, conversion, parent ASIN, and page view data to enable
-- intelligent replenishment and FBA conversion scoring.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. New table: asin_traffic — stores per-ASIN traffic & conversion data
--    from GET_SALES_AND_TRAFFIC_REPORT. Separate table because this data
--    is per-ASIN (not per-SKU) and refreshed independently.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS asin_traffic (
  id              BIGSERIAL PRIMARY KEY,
  child_asin      TEXT NOT NULL,
  parent_asin     TEXT,
  sku             TEXT,

  -- Sales metrics (from report)
  units_ordered   INTEGER DEFAULT 0,
  ordered_revenue NUMERIC(12,2) DEFAULT 0,

  -- Traffic metrics (the missing intelligence)
  sessions        INTEGER DEFAULT 0,
  page_views      INTEGER DEFAULT 0,
  buy_box_pct     NUMERIC(6,2) DEFAULT 0,
  conversion_rate NUMERIC(6,2) DEFAULT 0,  -- unitSessionPercentage

  -- Mobile breakdown
  browser_sessions    INTEGER DEFAULT 0,
  mobile_app_sessions INTEGER DEFAULT 0,
  browser_page_views  INTEGER DEFAULT 0,
  mobile_page_views   INTEGER DEFAULT 0,

  -- Metadata
  report_period_start DATE,
  report_period_end   DATE,
  last_synced_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_asin_traffic_child UNIQUE (child_asin)
);

CREATE INDEX IF NOT EXISTS idx_asin_traffic_parent ON asin_traffic(parent_asin);
CREATE INDEX IF NOT EXISTS idx_asin_traffic_sku ON asin_traffic(sku);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. New table: parent_asin_rollup — pre-computed parent-level aggregates
--    so the replenishment engine doesn't have to compute them on every request.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS parent_asin_rollup (
  parent_asin         TEXT PRIMARY KEY,
  child_count         INTEGER DEFAULT 0,
  total_units_30d     INTEGER DEFAULT 0,
  total_revenue_30d   NUMERIC(12,2) DEFAULT 0,
  total_sessions_30d  INTEGER DEFAULT 0,
  total_page_views_30d INTEGER DEFAULT 0,
  avg_conversion_rate NUMERIC(6,2) DEFAULT 0,
  avg_buy_box_pct     NUMERIC(6,2) DEFAULT 0,
  top_child_asin      TEXT,           -- best-selling child
  top_child_units     INTEGER DEFAULT 0,
  last_synced_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Add parent_asin to sku_sales_analytics for cross-reference
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE sku_sales_analytics
  ADD COLUMN IF NOT EXISTS parent_asin TEXT,
  ADD COLUMN IF NOT EXISTS sessions_30d INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS page_views_30d INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS buy_box_pct NUMERIC(6,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conversion_rate NUMERIC(6,2) DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Add parent_asin to listing_health for grouping
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE listing_health
  ADD COLUMN IF NOT EXISTS parent_asin TEXT;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Enable RLS on new tables (match existing pattern)
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE asin_traffic ENABLE ROW LEVEL SECURITY;
ALTER TABLE parent_asin_rollup ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY "service_role_asin_traffic" ON asin_traffic
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "service_role_parent_rollup" ON parent_asin_rollup
  FOR ALL USING (true) WITH CHECK (true);
