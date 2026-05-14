-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 008: Amazon Ads API Tables
--
-- Scaffolds the data layer for Amazon Advertising API integration.
-- Tables are created now; data will populate once Ads API credentials are
-- configured in app_settings (ads_client_id, ads_client_secret,
-- ads_refresh_token, ads_profile_id).
--
-- Covers:
--   ads_campaigns       — Sponsored Products / Brands / Display campaigns
--   ads_ad_groups       — Ad groups within campaigns
--   ads_keywords        — Keywords with match type and bid
--   ads_performance     — Daily performance metrics per campaign
--   ads_keyword_perf    — Daily performance metrics per keyword
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Campaigns ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads_campaigns (
  id                  BIGSERIAL PRIMARY KEY,
  campaign_id         TEXT        NOT NULL UNIQUE,  -- Amazon's campaignId
  name                TEXT        NOT NULL,
  campaign_type       TEXT        NOT NULL,          -- sponsoredProducts | sponsoredBrands | sponsoredDisplay
  targeting_type      TEXT,                          -- manual | auto
  state               TEXT        NOT NULL,          -- enabled | paused | archived
  daily_budget        NUMERIC(10,2),
  start_date          DATE,
  end_date            DATE,
  portfolio_id        TEXT,
  bidding_strategy    TEXT,                          -- legacyForSales | autoForSales | manual
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ads_campaigns_state ON ads_campaigns(state);
CREATE INDEX IF NOT EXISTS idx_ads_campaigns_type  ON ads_campaigns(campaign_type);

-- ── Ad Groups ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads_ad_groups (
  id              BIGSERIAL PRIMARY KEY,
  ad_group_id     TEXT        NOT NULL UNIQUE,
  campaign_id     TEXT        NOT NULL REFERENCES ads_campaigns(campaign_id) ON DELETE CASCADE,
  name            TEXT        NOT NULL,
  state           TEXT        NOT NULL,              -- enabled | paused | archived
  default_bid     NUMERIC(8,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_ad_groups_campaign ON ads_ad_groups(campaign_id);

-- ── Keywords ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads_keywords (
  id              BIGSERIAL PRIMARY KEY,
  keyword_id      TEXT        NOT NULL UNIQUE,
  ad_group_id     TEXT        NOT NULL REFERENCES ads_ad_groups(ad_group_id) ON DELETE CASCADE,
  campaign_id     TEXT        NOT NULL,
  keyword_text    TEXT        NOT NULL,
  match_type      TEXT        NOT NULL,              -- broad | phrase | exact
  state           TEXT        NOT NULL,              -- enabled | paused | archived
  bid             NUMERIC(8,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_keywords_campaign  ON ads_keywords(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ads_keywords_ad_group  ON ads_keywords(ad_group_id);
CREATE INDEX IF NOT EXISTS idx_ads_keywords_text       ON ads_keywords(keyword_text);

-- ── Campaign Performance (daily) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads_performance (
  id                  BIGSERIAL PRIMARY KEY,
  campaign_id         TEXT        NOT NULL,
  report_date         DATE        NOT NULL,
  impressions         INTEGER     NOT NULL DEFAULT 0,
  clicks              INTEGER     NOT NULL DEFAULT 0,
  cost                NUMERIC(10,2) NOT NULL DEFAULT 0,   -- total ad spend
  attributed_sales_7d NUMERIC(10,2) DEFAULT 0,
  attributed_sales_14d NUMERIC(10,2) DEFAULT 0,
  attributed_sales_30d NUMERIC(10,2) DEFAULT 0,
  attributed_units_7d  INTEGER DEFAULT 0,
  attributed_units_14d INTEGER DEFAULT 0,
  attributed_units_30d INTEGER DEFAULT 0,
  acos_7d             NUMERIC(6,4) DEFAULT 0,             -- ACoS = cost / sales
  roas_7d             NUMERIC(8,4) DEFAULT 0,             -- RoAS = sales / cost
  ctr                 NUMERIC(6,4) DEFAULT 0,             -- CTR  = clicks / impressions
  cpc                 NUMERIC(8,4) DEFAULT 0,             -- CPC  = cost / clicks
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campaign_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_ads_performance_campaign ON ads_performance(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ads_performance_date     ON ads_performance(report_date DESC);

-- ── Keyword Performance (daily) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads_keyword_perf (
  id                  BIGSERIAL PRIMARY KEY,
  keyword_id          TEXT        NOT NULL,
  campaign_id         TEXT        NOT NULL,
  report_date         DATE        NOT NULL,
  impressions         INTEGER     NOT NULL DEFAULT 0,
  clicks              INTEGER     NOT NULL DEFAULT 0,
  cost                NUMERIC(10,2) NOT NULL DEFAULT 0,
  attributed_sales_7d NUMERIC(10,2) DEFAULT 0,
  attributed_units_7d INTEGER DEFAULT 0,
  acos_7d             NUMERIC(6,4) DEFAULT 0,
  ctr                 NUMERIC(6,4) DEFAULT 0,
  cpc                 NUMERIC(8,4) DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(keyword_id, report_date)
);

CREATE INDEX IF NOT EXISTS idx_ads_kw_perf_keyword  ON ads_keyword_perf(keyword_id);
CREATE INDEX IF NOT EXISTS idx_ads_kw_perf_campaign ON ads_keyword_perf(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ads_kw_perf_date     ON ads_keyword_perf(report_date DESC);

-- ── App Settings keys for Ads API credentials ─────────────────────────────────
-- These rows will be populated by the user via Settings UI.
-- Using INSERT ... ON CONFLICT DO NOTHING to avoid overwriting existing values.
INSERT INTO app_settings (key, value) VALUES
  ('ads_client_id',     ''),
  ('ads_client_secret', ''),
  ('ads_refresh_token', ''),
  ('ads_profile_id',    ''),
  ('ads_region',        'NA')
ON CONFLICT (key) DO NOTHING;

-- ── Updated_at trigger (reuse existing pattern) ───────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ads_campaigns_updated_at') THEN
    CREATE TRIGGER ads_campaigns_updated_at
      BEFORE UPDATE ON ads_campaigns
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ads_ad_groups_updated_at') THEN
    CREATE TRIGGER ads_ad_groups_updated_at
      BEFORE UPDATE ON ads_ad_groups
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ads_keywords_updated_at') THEN
    CREATE TRIGGER ads_keywords_updated_at
      BEFORE UPDATE ON ads_keywords
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END
$$;
