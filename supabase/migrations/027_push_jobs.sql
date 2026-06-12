-- Migration 027: server-side push queue (PO 2026-06-11: "I Want the full server-side push
-- queue (survives tab close + deploys, global status bar)"). A push job is one push-content
-- execution (one field or one detail field for one parent) run on the SERVER, so closing the
-- tab — or even a Coolify deploy killing the container — never loses track of it:
--   • queued      → accepted, waiting for the in-process runner (jobs run ONE at a time,
--                   keeping total SP-API patch rate identical to the streaming path)
--   • running     → heartbeat_at refreshed every few SKUs while the loop works
--   • done/failed → finished_at set; accepted/failed counts are final
--   • interrupted → set by the READ-side watchdog when a running job's heartbeat goes stale
--                   (container restarted mid-push). Already-accepted SKUs stayed pushed —
--                   Verify on Amazon → "Push just the stale" recovers the rest.
-- payload = the exact push-content POST body (minus confirm), replayed by the runner.
-- progress = the tail of the NDJSON event stream (same events the modal shows).

CREATE TABLE IF NOT EXISTS push_jobs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_asin   TEXT        NOT NULL,
  field         TEXT,
  detail_field  TEXT,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed','interrupted')),
  total         INTEGER     NOT NULL DEFAULT 0,
  accepted      INTEGER     NOT NULL DEFAULT 0,
  failed        INTEGER     NOT NULL DEFAULT 0,
  progress      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  message       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  heartbeat_at  TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_push_jobs_parent ON push_jobs (parent_asin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_jobs_status ON push_jobs (status, created_at);

ALTER TABLE push_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_push_jobs" ON push_jobs;
CREATE POLICY "service_role_push_jobs" ON push_jobs FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
