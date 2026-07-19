-- 048 — durable cancel for push_jobs (2026-07-19)
-- The push queue's cancel was an in-memory Set keyed by cancel_token (pushExecutor _cancelledPushes),
-- reachable only via the streaming route — so a QUEUED/background job could not be cancelled and cancel
-- never survived a deploy. Move the cancel signal onto the row: the runner reads this flag between SKUs
-- and translates it into the existing requestPushCancel, so cancel works for queued/running jobs and
-- survives restarts. Additive + defaulted → old bundles ignore it (rollback-safe).
ALTER TABLE push_jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
