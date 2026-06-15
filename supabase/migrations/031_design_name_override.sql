-- 031_design_name_override.sql
-- Seller-controlled design name override (PO directive 2026-06-14: "how do we prevent stuck
-- design again"). When set, the pipeline uses this verbatim as the design name — no LLM
-- extraction, no apostrophe traps, no keyword-pool guessing. Deterministic.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.

ALTER TABLE listing_seo_scores
  ADD COLUMN IF NOT EXISTS design_name_override text;
