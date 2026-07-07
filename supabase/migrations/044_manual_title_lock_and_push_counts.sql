-- Migration 044: Manual-title lock + push-count columns (B0FRYMM56C).
-- ADDITIVE ONLY (idempotent) — safe to re-run.
--
-- (A) title_source — protects a seller's MANUALLY-pushed title from being silently overwritten by a
--     whole-listing AI Audit/Regenerate. The manual push (pushExecutor) stamps 'manual'; the regen
--     path (ai-recommendations POST) then PRESERVES the seller's title on any whole-listing regen and
--     only replaces it on an explicit "Regenerate title" (which clears the lock back to 'ai').
--       'ai'     = system-generated recommendation (default / current behaviour)
--       'manual' = seller pushed their own title — locked against incidental regeneration.
ALTER TABLE listing_seo_recommendations
  ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'ai';

-- (B) push counts on the product-facing change log so a PARTIAL push is both VISIBLE and legible:
--     "bills pushed the title to 133/148 variants". Previously the push→timeline write only fired on a
--     100%-clean push (failed===0), so a big family's partial push wrote NO row and vanished from the
--     history. Nullable — older rows and non-push actions (claim/release/edit) leave them NULL.
ALTER TABLE listing_change_log
  ADD COLUMN IF NOT EXISTS accepted_count int,
  ADD COLUMN IF NOT EXISTS failed_count   int;
