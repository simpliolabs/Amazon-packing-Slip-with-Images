-- 018_relink_log.sql
-- Audit log + duplicate-submission guard for the "Re-link orphan to parent" feature.
-- One row per successful SP-API submission. Amazon's response is ACCEPTED-not-applied — this
-- row lets the UI show "submitted N min ago, Amazon processing" instead of letting the seller
-- accidentally submit the same change twice. status transitions:
--   pending  → freshly submitted, awaiting Amazon
--   applied  → the orphan-check now reports a healthy parent link (we confirmed live)
--   failed   → Amazon returned a terminal error or 24h elapsed with no apply

CREATE TABLE IF NOT EXISTS relink_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_sku           text NOT NULL,                       -- the SKU we patched
  child_asin          text NOT NULL,                       -- its ASIN at submission time
  target_parent_sku   text NOT NULL,                       -- the parent SKU we asked for
  target_parent_asin  text,                                -- optional — the parent ASIN we believed at submission
  submission_id       text,                                -- Amazon's submissionId from the PATCH response
  status              text NOT NULL DEFAULT 'pending',     -- pending | applied | failed
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  applied_at          timestamptz,
  last_checked_at     timestamptz,
  error_message       text,
  pushed_by           uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_relink_log_child_sku   ON relink_log (child_sku);
CREATE INDEX IF NOT EXISTS idx_relink_log_status      ON relink_log (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_relink_log_target      ON relink_log (target_parent_sku);
CREATE INDEX IF NOT EXISTS idx_relink_log_submitted   ON relink_log (submitted_at DESC);

ALTER TABLE relink_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS relink_log_service_all ON relink_log;
CREATE POLICY relink_log_service_all ON relink_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS relink_log_auth_read ON relink_log;
CREATE POLICY relink_log_auth_read ON relink_log
  FOR SELECT TO authenticated USING (true);
