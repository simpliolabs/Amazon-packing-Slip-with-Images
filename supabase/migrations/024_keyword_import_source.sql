-- 024_keyword_import_source.sql
-- Allow data_source = 'import' on keyword_analysis: competitor-proven keywords imported from
-- a Helium 10 Cerebro/Xray CSV (POST /api/fba/keywords/import). Honest provenance — the native
-- sources (sqp / jungle_scout) only query OUR ASIN and can never discover the keywords
-- competitors rank on (the self-referential keyword trap, PO 2026-06-11).
--
-- The inline CHECK from migration 013 gets Postgres' default name. Idempotent.

ALTER TABLE keyword_analysis DROP CONSTRAINT IF EXISTS keyword_analysis_data_source_check;
ALTER TABLE keyword_analysis
  ADD CONSTRAINT keyword_analysis_data_source_check
  CHECK (data_source IN ('sqp', 'jungle_scout', 'inherited', 'import'));
