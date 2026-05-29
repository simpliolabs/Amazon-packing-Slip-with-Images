-- Migration 013: Keyword Intelligence Engine
-- Creates the data layer for Track B (Keyword Intelligence):
--   1. keyword_cache     — raw API responses (Jungle Scout + SQP) with TTL
--   2. keyword_analysis  — scored, categorized keyword actions per ASIN
--   3. api_usage_log     — external API call budget tracking

-- ═══════════════════════════════════════════════════════════════════════
-- 1. keyword_cache — stores raw API responses with 30-day TTL
--    source: 'sqp' | 'jungle_scout'
--    keyword_data: raw JSONB array from the API response
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS keyword_cache (
  id             BIGSERIAL PRIMARY KEY,
  asin           TEXT        NOT NULL,
  source         TEXT        NOT NULL CHECK (source IN ('sqp', 'jungle_scout')),
  keyword_data   JSONB       NOT NULL DEFAULT '[]',
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  CONSTRAINT uq_keyword_cache_asin_source UNIQUE (asin, source)
);

CREATE INDEX IF NOT EXISTS idx_keyword_cache_asin    ON keyword_cache(asin);
CREATE INDEX IF NOT EXISTS idx_keyword_cache_expires ON keyword_cache(expires_at);

-- ═══════════════════════════════════════════════════════════════════════
-- 2. keyword_analysis — scored and categorized keyword actions per ASIN
--    action_type: CRITICAL | UPGRADE | REINFORCE | DEFENDED | OPTIMIZED
--    opportunity_score: 0–100 (higher = bigger opportunity)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS keyword_analysis (
  id                  BIGSERIAL PRIMARY KEY,
  asin                TEXT        NOT NULL,
  keyword             TEXT        NOT NULL,
  opportunity_score   NUMERIC(5,2) NOT NULL DEFAULT 0,
  action_type         TEXT        NOT NULL CHECK (action_type IN ('CRITICAL','UPGRADE','REINFORCE','DEFENDED','OPTIMIZED')),
  action_text         TEXT,
  -- Listing presence flags
  in_title            BOOLEAN     NOT NULL DEFAULT FALSE,
  in_bullets          BOOLEAN     NOT NULL DEFAULT FALSE,
  in_description      BOOLEAN     NOT NULL DEFAULT FALSE,
  in_backend          BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Keyword metrics
  search_volume       INTEGER     DEFAULT 0,
  competing_products  INTEGER     DEFAULT 0,
  keyword_sales       INTEGER     DEFAULT 0,
  -- Source tracking
  data_source         TEXT        NOT NULL DEFAULT 'sqp' CHECK (data_source IN ('sqp', 'jungle_scout', 'inherited')),
  analyzed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_keyword_analysis_asin_keyword UNIQUE (asin, keyword)
);

CREATE INDEX IF NOT EXISTS idx_keyword_analysis_asin  ON keyword_analysis(asin);
CREATE INDEX IF NOT EXISTS idx_keyword_analysis_score ON keyword_analysis(opportunity_score DESC);
CREATE INDEX IF NOT EXISTS idx_keyword_analysis_type  ON keyword_analysis(action_type);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. api_usage_log — tracks external API calls for budget protection
--    provider: 'jungle_scout' | 'sqp'
--    calls_this_month: computed view (see below)
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_usage_log (
  id               BIGSERIAL PRIMARY KEY,
  provider         TEXT        NOT NULL CHECK (provider IN ('jungle_scout', 'sqp')),
  endpoint         TEXT        NOT NULL,
  asins_requested  TEXT[]      NOT NULL DEFAULT '{}',
  response_status  INTEGER,
  called_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_usage_log_provider   ON api_usage_log(provider);
CREATE INDEX IF NOT EXISTS idx_api_usage_log_called_at  ON api_usage_log(called_at);

-- Convenience view: calls used this calendar month per provider
CREATE OR REPLACE VIEW api_usage_this_month AS
SELECT
  provider,
  COUNT(*)::INTEGER AS calls_used,
  DATE_TRUNC('month', NOW()) AS month_start
FROM api_usage_log
WHERE called_at >= DATE_TRUNC('month', NOW())
GROUP BY provider;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. RLS — match existing pattern (service role full access)
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE keyword_cache    ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_log    ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_keyword_cache"    ON keyword_cache    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_keyword_analysis" ON keyword_analysis FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "service_role_api_usage_log"    ON api_usage_log    FOR ALL USING (true) WITH CHECK (true);
