-- 052: Amazon Custom flag on listing_content (2026-07-31).
-- PO: "WHERE is the Personalize/Customized For couples?" — B0GR22ZHBW is enrolled in Amazon Custom
-- ("Customizations: 1 text input" on the live PDP) but the system had no way to know: the flag lives
-- in the listing's own SP-API attributes (is_customizable), which the sync fetches and discarded.
-- Additive + idempotent. Sync writes it column-safely (retries without the column pre-migration).
ALTER TABLE listing_content ADD COLUMN IF NOT EXISTS is_customizable boolean;
COMMENT ON COLUMN listing_content.is_customizable IS 'Amazon Custom enrollment from SP-API attributes.is_customizable — unlocks Personalized/Custom in generated copy (2026-07-31)';
NOTIFY pgrst, 'reload schema';
