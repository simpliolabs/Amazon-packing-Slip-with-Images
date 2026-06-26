-- Migration 040: Listing work-queue lifecycle — PHASE C, part 3: outcome regression DEBOUNCE +
-- the guarded autonomous push→verify→reship loop's per-listing opt-in + per-child bound.
-- Spec: docs/lifecycle-collab-spec.md §5 Phase C (Risk R9 debounce) + PO H1 (autonomous reship).
-- ADDITIVE ONLY (idempotent): ADD COLUMN IF NOT EXISTS only, safe to re-run.
--
-- WHAT THIS UNLOCKS
--   1. consecutive_fell_evals on listing_outcome_state — the cron's regression DEBOUNCE counter
--      (Risk R9 / D-13): a single 'fell' eval does NOT resurface as a regression; only N=2 CONSECUTIVE
--      fell evals flip the verdict to 'resurface_regression'. A 'won'/'flat' eval resets the counter to 0.
--      The cron is still the ONLY writer (Risk R6); this is just its memory across runs.
--
--   2. The autonomous reship loop's HARD SAFETY columns on push_verification_tasks:
--        - auto_reship_enabled  : per-listing OPT-IN (default FALSE). The loop is a NO-OP unless BOTH
--                                 this is TRUE *and* the env AUTO_RESHIP_ENABLED kill-switch is set —
--                                 belt-and-suspenders opt-in (PO H1 safety a).
--        - reship_attempts      : per-CHILD bounded counter (PO H1 safety b: max 3, then needs_attention).
--                                 Distinct from `attempts` (the existing per-TASK verify-cycle counter) so
--                                 the autonomous re-delivery bound is independent of the manual verify loop.
--        - origin_submission_id : the user's ORIGINAL approved push submission (SAME-CONTENT provenance,
--                                 PO H1 safety d) — the loop re-pushes the content tied to THIS id, never
--                                 a freshly generated value.
--      These default off/zero so existing rows and the existing verify cron are completely unaffected.

ALTER TABLE listing_outcome_state
  ADD COLUMN IF NOT EXISTS consecutive_fell_evals INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN listing_outcome_state.consecutive_fell_evals IS
  'Regression debounce (Risk R9/D-13): count of CONSECUTIVE cron evals that read net-fell. resurface_regression fires only at >=2; any non-fell eval resets to 0. Cron is the only writer.';

ALTER TABLE push_verification_tasks
  ADD COLUMN IF NOT EXISTS auto_reship_enabled BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN push_verification_tasks.auto_reship_enabled IS
  'Per-listing OPT-IN for the autonomous push→verify→reship loop (PO H1 safety a). The loop is a NO-OP unless BOTH this is TRUE and env AUTO_RESHIP_ENABLED is set. Default FALSE.';

ALTER TABLE push_verification_tasks
  ADD COLUMN IF NOT EXISTS reship_attempts INTEGER NOT NULL DEFAULT 0;
COMMENT ON COLUMN push_verification_tasks.reship_attempts IS
  'Per-child autonomous re-delivery bound (PO H1 safety b): max 3 reships per task, then flag needs_attention + stop. Distinct from `attempts` (manual verify-cycle counter).';

ALTER TABLE push_verification_tasks
  ADD COLUMN IF NOT EXISTS origin_submission_id TEXT;
COMMENT ON COLUMN push_verification_tasks.origin_submission_id IS
  'The user''s ORIGINAL approved push submission id (PO H1 safety d: SAME-CONTENT only). The autonomous loop re-pushes the content tied to this id, never a freshly generated value.';

-- Reload PostgREST's schema cache so the new columns are queryable immediately (035–039 precedent).
NOTIFY pgrst, 'reload schema';
