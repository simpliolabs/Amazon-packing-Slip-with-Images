-- 046_kw_ref_fingerprint.sql
-- H follow-up (2026-07-16): the keyword universe (keyword_analysis) is a separate, credit-gated step
-- from a plain "Regenerate AI Audit", so a listing whose competitor/design was entered AFTER its last
-- research kept serving the stale, off-niche pool ("0 fishing keywords" on B0DMXMH266). This column
-- records the reference signals the current universe was researched with; the ai-recommendations route
-- compares it to the live (competitor_asin, design_name_override) and forces a re-research when they
-- differ — then stamps the new fingerprint so it doesn't re-research on every regen.
ALTER TABLE listing_seo_scores ADD COLUMN IF NOT EXISTS kw_ref_fingerprint text;
COMMENT ON COLUMN listing_seo_scores.kw_ref_fingerprint IS
  'Fingerprint "competitor_asin|design_name_override" the current keyword_analysis universe was researched with. Drives the recs-route re-research trigger when the seller changes a reference signal.';
