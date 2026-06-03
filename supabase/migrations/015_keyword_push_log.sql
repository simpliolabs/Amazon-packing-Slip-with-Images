-- 015_keyword_push_log.sql
-- Audit + rollback trail for the "Push backend keywords to Amazon" feature (PR #16).
-- One row per child SKU per push. previous_value enables rollback; submission_id tracks
-- Amazon's async processing; status reflects the lifecycle.
--
-- NOTE: fba_work_log (migration 010) is for warehouse replenishment and is NOT reused
-- here — wrong domain, and it lacks previous_value / submission_id / action columns.

CREATE TABLE IF NOT EXISTS keyword_push_log (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_asin             text NOT NULL,
  sku                     text NOT NULL,
  previous_value          text,                               -- verbatim previous generic_keyword
  new_value               text NOT NULL,                      -- what was written (<=250 bytes)
  submission_id           text,                               -- Amazon submissionId from the PATCH
  status                  text NOT NULL DEFAULT 'pending',    -- pending | accepted | failed | rolled_back
  error_message           text,                               -- populated when status = failed
  pushed_by               uuid REFERENCES auth.users(id),
  pushed_at               timestamptz NOT NULL DEFAULT now(),
  rolled_back_at          timestamptz,
  rollback_submission_id  text
);

CREATE INDEX IF NOT EXISTS idx_keyword_push_log_parent_asin ON keyword_push_log (parent_asin);
CREATE INDEX IF NOT EXISTS idx_keyword_push_log_sku         ON keyword_push_log (sku);
CREATE INDEX IF NOT EXISTS idx_keyword_push_log_pushed_at   ON keyword_push_log (pushed_at DESC);

-- RLS: match the project's tenant pattern (admin/service-role access; authenticated read).
ALTER TABLE keyword_push_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS keyword_push_log_service_all ON keyword_push_log;
CREATE POLICY keyword_push_log_service_all ON keyword_push_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS keyword_push_log_auth_read ON keyword_push_log;
CREATE POLICY keyword_push_log_auth_read ON keyword_push_log
  FOR SELECT TO authenticated USING (true);
