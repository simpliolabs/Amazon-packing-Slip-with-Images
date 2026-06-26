-- Migration 037: Listing work-queue collaboration — PHASE B, part 2: PRODUCT-FACING CHANGE LOG.
-- Spec: docs/lifecycle-collab-spec.md §4-C + §5 Phase B. ADDITIVE ONLY (idempotent).
--
-- WHAT THIS UNLOCKS:
--   A parent-grain, product-facing timeline of WHO did WHAT to a listing: manual edits, AI
--   generate/regenerate, pushes, and the collaboration events (claim/release/takeover). This is
--   DISTINCT from:
--     • keyword_push_log (015) — push-to-Amazon, SKU-grain, has submission_id/rollback.
--     • audit_logs (003) — narrow compliance ledger; we route only a sensitive subset there
--       (listing.push as a write-to-Amazon event, listing.takeover as an override).
--   The change log is the human-readable "what happened to this listing" feed surfaced in the
--   detail panel and by GET /change-log?parent_asin=.
--
-- Attribution carrier: routes resolve the acting user server-side from the Authorization: Bearer
-- JWT (work-log getAuthUser pattern) and write changed_by + a denormalized changed_by_name, so a
-- row always renders even if the auth.users row is later deleted (ON DELETE SET NULL).

CREATE TABLE IF NOT EXISTS listing_change_log (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_asin     TEXT        NOT NULL,                          -- = listing_key grain (self-parent for standalones)
  sku             TEXT,                                          -- nullable: parent-grain events (claim/release) have no sku
  field           TEXT,                                          -- e.g. 'title','bullet_1','description','backend_keywords','(claim)'
  action          TEXT        CHECK (action IN ('edit','ai_generate','ai_regenerate','push','claim','release','takeover')),
  before_value    TEXT,
  after_value     TEXT,
  changed_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  changed_by_name TEXT,                                          -- denormalized full_name/email for timeline render
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT        CHECK (source IN ('manual_edit','ai','push_executor','background_job')),
  submission_id   TEXT                                           -- links a push row back to keyword_push_log.submission_id
);

-- Newest-first reads per parent are the hot path (detail panel + GET /change-log + the optimizer
-- "last_touched" lateral lookup).
CREATE INDEX IF NOT EXISTS idx_listing_change_log_parent_changed
  ON listing_change_log (parent_asin, changed_at DESC);

-- RLS: mirror keyword_push_log (015) / listing_claims (036).
ALTER TABLE listing_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_change_log_service_all ON listing_change_log;
CREATE POLICY listing_change_log_service_all ON listing_change_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_change_log_auth_read ON listing_change_log;
CREATE POLICY listing_change_log_auth_read ON listing_change_log
  FOR SELECT TO authenticated USING (true);

-- Reload PostgREST's schema cache so the new table is queryable immediately (027/034/035 precedent).
NOTIFY pgrst, 'reload schema';
