-- Migration 032: Cross-listing keyword seed pool
-- PO 2026-06-17: "query the pool before calling JS — many of our shirts share a niche; the pool
-- stays fresh for 14 days." The niche keyword universe (Jungle Scout Phases 2–4: keyword universe
-- + competitors) is NICHE-level, not listing-level, so listings that resolve to the same normalized
-- seed should share ONE research instead of each spending 3–5 JS credits.
--
-- Split rationale: per-ASIN organic rank (Phase 4b) is NEVER stored here — it stays per-listing in
-- keyword_analysis. Only the shareable niche/competitor data lives in this table.
--
-- keyword_cache (per-ASIN fast-path) is unchanged; this table is additive.

CREATE TABLE IF NOT EXISTS keyword_seed_pool (
  seed_key          TEXT        PRIMARY KEY,          -- normalized niche seed, e.g. "fishing t shirt"
  keyword_data      JSONB       NOT NULL DEFAULT '[]', -- shared niche pool (JungleScoutKeywordRow[]), organicRank stripped
  competitor_asin   TEXT,                              -- #1 SOV competitor for the niche
  competitor_brand  TEXT,
  sov_percentage    NUMERIC,
  seed_source       TEXT,                              -- vision | title | manual | category | agent | rules
  contributor_asins TEXT[]      NOT NULL DEFAULT '{}', -- ASINs that have researched/reused this seed (dashboard + debug)
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days')
);

CREATE INDEX IF NOT EXISTS idx_keyword_seed_pool_expires ON keyword_seed_pool(expires_at);

-- RLS — match the keyword_cache pattern (service role full access)
ALTER TABLE keyword_seed_pool ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'keyword_seed_pool' AND policyname = 'service_role_keyword_seed_pool'
  ) THEN
    CREATE POLICY "service_role_keyword_seed_pool" ON keyword_seed_pool FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
