-- Migration 038: Listing work-queue lifecycle — PHASE C, part 1: APPEND-ONLY SCORE TREND.
-- Spec: docs/lifecycle-collab-spec.md §4-D + §5 Phase C. ADDITIVE ONLY (idempotent):
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP+CREATE POLICY, safe to re-run.
--
-- WHAT THIS UNLOCKS:
--   A per-listing, append-only score time-series powering the detail-page sparkline + the merged
--   change-history timeline (score deltas). One row per score CHANGE-POINT (overall_score OR
--   content_fingerprint moved vs the latest row) — NOT one per re-score, so the top-50-per-sync
--   re-scores at syncListingContent.ts:1445 do NOT bloat the table. The append is CONDITIONAL and
--   happens in application code via the explicit, greppable appendScoreHistory() helper
--   (src/lib/fba/scoreHistory.ts) called at all listing_seo_scores write sites — the spec's D-1
--   alternative to a DB trigger, chosen because supabase-js/ssr goes through PostgREST (no raw pg
--   conn — src/lib/supabase/server.ts, client.ts) so a transaction-local set_config GUC carrier
--   could never reach a pooled trigger, and the helper demonstrably carries the acting user id.
--
--   content_fingerprint REUSES fingerprintOf() VERBATIM (src/lib/keyword-engine/shareSnapshots.ts:
--   sha1 of title+5 bullets+description+backend_keywords, lowercased, space-collapsed) so a history
--   row JOINs keyword_share_snapshots.content_fingerprint by value — the two series share one epoch.
--
-- listing_key = COALESCE(parent_asin, asin) — standalones self-parent (matches the §4 grain rule).

CREATE TABLE IF NOT EXISTS listing_score_history (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_key         TEXT        NOT NULL,                       -- = COALESCE(parent_asin, asin); the trend grain
  parent_asin         TEXT,                                       -- nullable: standalones have no catalog parent
  overall_score       INTEGER,
  -- the 6 sub-scores (mirror listing_seo_scores columns)
  title_score         INTEGER,
  bullet_score        INTEGER,
  keyword_score       INTEGER,
  aplus_score         INTEGER,
  description_score   INTEGER,
  features_score      INTEGER,
  issues_count        INTEGER,                                    -- length of listing_seo_scores.issues at capture
  content_fingerprint TEXT,                                       -- fingerprintOf() VERBATIM → JOINs keyword_share_snapshots
  lifecycle_state     TEXT,                                       -- the lifecycle_state at capture (denormalized snapshot)
  trigger             TEXT        CHECK (trigger IN ('scheduled_sync','on_demand','push','outcome_resurface','manual')),
  scored_by           uuid        REFERENCES auth.users(id) ON DELETE SET NULL,  -- null for service-role/cron appends
  scored_by_name      TEXT,                                       -- denormalized display string for the timeline
  scored_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Newest-first reads per listing are the hot path (sparkline + GET /score-history + change-history union).
CREATE INDEX IF NOT EXISTS idx_listing_score_history_key_scored
  ON listing_score_history (listing_key, scored_at DESC);

-- RLS: mirror listing_change_log (037) — service_role full access (server appends run as service_role
-- via createAdminClient), authenticated users may read (sparkline/timeline render client-side).
ALTER TABLE listing_score_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_score_history_service_all ON listing_score_history;
CREATE POLICY listing_score_history_service_all ON listing_score_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_score_history_auth_read ON listing_score_history;
CREATE POLICY listing_score_history_auth_read ON listing_score_history
  FOR SELECT TO authenticated USING (true);

-- Reload PostgREST's schema cache so the new table is queryable immediately (027/034/035/036/037 precedent).
NOTIFY pgrst, 'reload schema';
