-- Migration 055: native Jungle Scout market metrics on keyword_analysis (PO data-truth rule 2026-08-08)
--
-- WHY. keyword_analysis.opportunity_score is the GAP-AMPLIFIED placement composite
-- (rawScore x usageGapMultiplier / 3 — calculateScore.ts). It swings with OUR OWN coverage
-- (the PO's 52->19 on "christian shirts for women"), so it must never be displayed as market
-- data. The JS Keywords API has no single native "opportunity" score (that lives in Opportunity
-- Finder, a different product — see poolOpportunity.ts:4-6), so the durable native metrics are:
--   * ease_of_ranking_score + relevancy_score  — raw per-keyword JS fields, and
--   * poolOpportunityScore                     — the deterministic 0-10 demand x winnability
--     synthesis from ONLY native fields, already live on the /fba/keywords pool dashboard.
-- The JSON caches that hold these (keyword_cache 30d, keyword_seed_pool 14d) EXPIRE, while
-- keyword_analysis persists indefinitely and is the one store every consumer reads — hence
-- real columns. Code fails open when these columns are absent (blank_specs precedent):
-- cacheService.storeAnalysis strips them on 42703/PGRST204 and retries.

ALTER TABLE keyword_analysis
  ADD COLUMN IF NOT EXISTS js_ease_of_ranking INTEGER,      -- JS ease_of_ranking_score, native 0-100, higher = easier to rank
  ADD COLUMN IF NOT EXISTS js_relevancy_score INTEGER,      -- JS relevancy_score, native (can exceed 100)
  ADD COLUMN IF NOT EXISTS market_opportunity NUMERIC(4,1); -- coverage-INDEPENDENT 0-10 (poolOpportunityScore: demand x winnability from native fields only)

COMMENT ON COLUMN keyword_analysis.market_opportunity IS
  'Market-only opportunity (0-10, poolOpportunityScore): search volume x (ease_of_ranking + low competition). NEVER amplified by our usage gap — stable across our own content changes. RANK panel display metric per PO rule 2026-08-08; opportunity_score remains the internal gap-amplified placement composite (coverageGapScore in code).';

NOTIFY pgrst, 'reload schema';
