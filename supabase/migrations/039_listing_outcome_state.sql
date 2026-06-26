-- Migration 039: Listing work-queue lifecycle — PHASE C, part 2: THE OUTCOME LEDGER (replaces the timer).
-- Spec: docs/lifecycle-collab-spec.md §4-E + §5 Phase C. ADDITIVE ONLY (idempotent).
--
-- WHAT THIS UNLOCKS:
--   The single source of truth for "did the pushed copy actually move share/rank/sales" — the
--   data-readiness-gated OUTCOME axis that REPLACES the legacy fixed 7-day cooling timer
--   (ai-recommendations/route.ts:890). One row per listing_key.
--
--   The push-completion full-accept hinge in pushExecutor (failed===0 && !cancelled && accepted>0,
--   the SAME hinge Phase B stamps attribution at) upserts {push_epoch_at, push_epoch_fingerprint,
--   baseline_overall_score, outcome_verdict='measuring'} — best-effort, NEVER blocks the push
--   (spec Risk R3: stamped here, where parent_asin + the just-pushed content/fingerprint are in
--   scope, NOT in verificationQueue.completeTask which has no parent_asin and non-100% exit paths).
--
--   The Phase C cron is the ONLY writer of the terminal verdicts (won / resurface_regression /
--   non_copy_bottleneck / headroom_rewrite / measurement_stalled). It gates on >=2 keyword_share_
--   snapshots that are BOTH snapshot_date > push_epoch_at AND content_fingerprint == push_epoch_
--   fingerprint (the push-epoch-aware wrapper, src/lib/keyword-engine/outcomeForListing.ts), then
--   delegates the rose/flat/fell math to computeOutcomeSignals.
--
--   READ-PATH RULE (spec Risk R-MIG7): the dashboard GET LEFT-JOINs this ledger (low cardinality,
--   ~25 rows/page) — the verdict is NEVER mirrored back onto listing_seo_scores, so we do not
--   create another cached aggregate that can drift (the "cached counts lie" ghost-card lesson).
--
-- listing_key = COALESCE(parent_asin, asin) — standalones self-parent (matches the §4 grain rule).

CREATE TABLE IF NOT EXISTS listing_outcome_state (
  listing_key             TEXT        PRIMARY KEY,                 -- = COALESCE(parent_asin, asin)
  parent_asin             TEXT,                                    -- nullable: standalones have no catalog parent
  push_epoch_at           TIMESTAMPTZ,                             -- when the measured copy went live (full-accept push)
  push_epoch_fingerprint  TEXT,                                   -- fingerprintOf() of the just-pushed content (epoch anchor)
  baseline_overall_score  INTEGER,                                -- overall_score at the moment of the epoch
  snapshots_since_push    INTEGER     NOT NULL DEFAULT 0,         -- COUNT(DISTINCT post-epoch same-fingerprint snapshot_date)
  outcome_verdict         TEXT        CHECK (outcome_verdict IN (
                            'measuring','insufficient_data','won','resurface_regression',
                            'non_copy_bottleneck','headroom_rewrite','measurement_stalled')),
  verdict_reason          TEXT,                                    -- human-readable "why" + contributing keywords
  non_copy_lever          TEXT        CHECK (non_copy_lever IN ('reviews','price','ads','velocity')),
  last_evaluated_at       TIMESTAMPTZ,                             -- when the cron last ran the wrapper for this listing
  next_evaluable_at       TIMESTAMPTZ,                             -- earliest the gate could open (SQP cadence estimate)
  resurfaced_at           TIMESTAMPTZ                              -- when a verdict routed it back into a work tab
);

-- The cron scans listings due for evaluation; the dashboard joins by listing_key (already the PK).
CREATE INDEX IF NOT EXISTS idx_listing_outcome_state_next_eval
  ON listing_outcome_state (next_evaluable_at);

-- RLS: mirror listing_claims (036) / listing_change_log (037) — service_role full access (the cron +
-- push hinge run as service_role via createAdminClient), authenticated users may read (verdict chips
-- render client-side via the GET LEFT JOIN).
ALTER TABLE listing_outcome_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_outcome_state_service_all ON listing_outcome_state;
CREATE POLICY listing_outcome_state_service_all ON listing_outcome_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_outcome_state_auth_read ON listing_outcome_state;
CREATE POLICY listing_outcome_state_auth_read ON listing_outcome_state
  FOR SELECT TO authenticated USING (true);

-- Reload PostgREST's schema cache so the new table is queryable immediately (027/034/035/036/037/038 precedent).
NOTIFY pgrst, 'reload schema';
