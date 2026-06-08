-- ═══════════════════════════════════════════════════════════════════════
-- 019 — Allow 'IRRELEVANT' as a keyword action_type (noise filter, Stage 2)
-- ═══════════════════════════════════════════════════════════════════════
-- The keyword relevance gate drops off-product keywords (competitor brands,
-- trademarks, or a DIFFERENT product like "sim card for camera" on an SD-memory
-- -card listing) from the AI rewrite. The regen route marks those same rows
-- action_type = 'IRRELEVANT' so the SCORER stops docking the listing for not
-- ranking on a different product (the scorer only counts CRITICAL/UPGRADE).
--
-- Migration 013 created keyword_analysis.action_type with a CHECK constraint
-- that did NOT include 'IRRELEVANT', so every such UPDATE was rejected by
-- Postgres (returned as a PostgREST error, not thrown) — the filter reported
-- success while changing 0 rows. This extends the allowed set.
--
-- Idempotent: drops the existing inline CHECK (auto-named by Postgres) and
-- re-adds it with 'IRRELEVANT' included. Safe to re-run.

ALTER TABLE keyword_analysis
  DROP CONSTRAINT IF EXISTS keyword_analysis_action_type_check;

ALTER TABLE keyword_analysis
  ADD CONSTRAINT keyword_analysis_action_type_check
  CHECK (action_type IN ('CRITICAL','UPGRADE','REINFORCE','DEFENDED','OPTIMIZED','IRRELEVANT'));

-- Tell PostgREST to reload its schema cache so the new constraint is picked up.
NOTIFY pgrst, 'reload schema';
