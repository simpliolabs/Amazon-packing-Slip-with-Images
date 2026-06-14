-- 030_push_verification_tasks.sql
-- Automatic post-push verify + retry queue (PO directive 2026-06-13: "Shipping Verification
-- Should be an Automatic Cron JOB — I should not be checking manually, the system should
-- verify via cron and re-push until it is 100% done — only notify on major flags").
--
-- Lifecycle: a successful push enqueues a task → a cron (every ~5 min) picks DUE tasks
-- (next_check_at <= now), atomically claims pending → running, runs verify-push live,
-- and either marks complete (matched===total), enqueues a re-push of the stale SKUs and
-- bumps attempts (linear backoff), or marks needs_attention after max_attempts.
--
-- ONE active task per (parent_asin, field): the seller's next push REPLACES the previous
-- task (their newer value supersedes), so we don't retry against a stale expected_value.
-- The composite UNIQUE constraint guarantees this.
--
-- Idempotent: CREATE ... IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS push_verification_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_asin           text NOT NULL,
  -- 'title' | 'bullets' | 'description' | 'keywords' | 'details:<spApiKey>'
  field                 text NOT NULL,
  -- friendly name for details ("Sleeve", "Neck") — null for the four standard fields
  detail_field          text,
  -- what we pushed: for broadcast fields a single string; for keywords (per-child) the
  -- comparison happens server-side via the recommendation row, so this is informational.
  expected_value        text,
  status                text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'completed', 'needs_attention', 'abandoned')),
  attempts              int  NOT NULL DEFAULT 0,
  max_attempts          int  NOT NULL DEFAULT 5,
  next_check_at         timestamptz NOT NULL,
  last_verified_at      timestamptz,
  last_matched_count    int,
  last_total_count      int,
  -- the last verify's stale SKUs the re-push will target on the next attempt
  last_stale_skus       jsonb,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- One active task per (parent, field): a new push REPLACES the old task (UPSERT).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pvt_active
  ON push_verification_tasks (parent_asin, field)
  WHERE status IN ('pending', 'running');

-- The cron's "due tasks" query.
CREATE INDEX IF NOT EXISTS idx_pvt_status_next ON push_verification_tasks (status, next_check_at);
-- Status counts per parent (drives the listing-page banner).
CREATE INDEX IF NOT EXISTS idx_pvt_parent_status ON push_verification_tasks (parent_asin, status);

ALTER TABLE push_verification_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pvt_service_all ON push_verification_tasks;
CREATE POLICY pvt_service_all ON push_verification_tasks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pvt_auth_read ON push_verification_tasks;
CREATE POLICY pvt_auth_read ON push_verification_tasks
  FOR SELECT TO authenticated USING (true);
