-- Migration 021: "Rank Top of Amazon" — Competitive Rank Analysis cache
-- ═══════════════════════════════════════════════════════════════════════
-- Caches the per-CHILD rank analysis shown in the listing-page Intelligence tab.
-- One row per child ASIN.
--   • The FREE stored-core (top keywords × content coverage) is recomputed cheaply on
--     every GET, so it is NOT what this table caches. This table caches the EXPENSIVE
--     work a POST triggers: the council run (OpenAI) + optional Share-of-Voice
--     enrichment (Jungle Scout credits).
--   • content_fingerprint is a sha1 of the listing family's concatenated live copy; the
--     GET handler recomputes it to flag a cached analysis as STALE when the copy changed.
--   • run_lock_at guards a double-spend: a second POST inside the lock window is rejected
--     while one analysis is already running.
-- Keyed on child_asin (NOT parent) so a re-parent never clobbers a sibling's analysis.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS listing_rank_analysis (
  child_asin          TEXT        PRIMARY KEY,
  parent_asin         TEXT,
  analyzed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  competition_ran     BOOLEAN     NOT NULL DEFAULT FALSE,
  credits_spent       INTEGER     NOT NULL DEFAULT 0,
  content_fingerprint TEXT        NOT NULL DEFAULT '',
  result              JSONB       NOT NULL DEFAULT '{}',
  run_lock_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_listing_rank_analysis_parent ON listing_rank_analysis(parent_asin);

-- RLS — match existing pattern (service role full access)
ALTER TABLE listing_rank_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_listing_rank_analysis" ON listing_rank_analysis FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
