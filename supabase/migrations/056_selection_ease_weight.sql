-- 056_selection_ease_weight.sql
-- Stamp the KEYWORD_EASE_WEIGHT a row's persisted selection was computed under
-- (PO 2026-08-08 ease-aware priority; PR #522 deliberately excluded the weight from
-- ctxSha, so staleness must be detected by THIS stamp instead).
-- NULL = row written before this column existed (pre-ease era) -> the intelligence GET
-- self-heal treats NULL as "weight 0" and recomputes selection ONCE, then stamps.
ALTER TABLE keyword_analysis
  ADD COLUMN IF NOT EXISTS selection_ease_weight numeric;

COMMENT ON COLUMN keyword_analysis.selection_ease_weight IS
  'KEYWORD_EASE_WEIGHT in force when selection_rank/selection_slot/selection_reason were computed (0 = ease term inert). NULL = pre-056 row; heal-on-read restamps. Written ONLY by the storeAnalysis merge branch; the legacy branch omits it (sticky with the ranks it describes).';
