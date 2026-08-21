-- 059_sku_offer_liveness.sql
-- 057_rekey_keyword_pool_to_parent.sql is the highest applied. Apply BY HAND in the Supabase SQL
-- editor. Ordering vs the deploy is safe either way: the writer (src/lib/fba/offerLiveness.ts) and
-- the reader (variantDeathAlarm.ts loadOfferLiveness) are both FAIL-OPEN — code deployed before
-- this table exists just logs "[offerLiveness] ... (fail-open)" and behaves byte-identically to
-- before (the alarm's offer_dead prong simply has no gate verdicts to read yet).
--
-- THE PUSH GATE'S OWN TRUTH, PERSISTED. Every push / verify already asks Amazon's Listings-Items
-- API which seller SKUs are live under each child ASIN (pushExecutor discoverSkusForAsin) and
-- every family reconcile already reads each missing child's offers[] (familyReconcile). Both
-- decide "live" vs "offerless" per SKU — and then threw the verdict away. Meanwhile the
-- VARIANT-DEATH ALARM read two PROXIES (content-sync lag, listing_health status) that BOTH said
-- "healthy" for the Later Gator family's dead Orchid offers (parent B0GML5V7KZ, SKUs like
-- 6014XL-ORC-Later-Gator-LS-TS) while the gate was skipping those exact SKUs as offerless on
-- every push. This table is the ONE place that verdict lands, so the alarm can read what the
-- gate already knows. No new Amazon calls, no cron: rows are written only when an existing
-- truth site runs.
--
-- Row semantics (must mirror mergeLivenessObservation in src/lib/fba/offerLiveness.ts):
--   offer_live            the most recent verdict (true = Amazon listed the SKU as a live seller
--                         listing / returned a non-empty offers[]; false = confirmed offerless).
--   last_checked_at       when that verdict was observed.
--   source                which truth site wrote it ('push_gate', 'details_gate',
--                         'family_reconcile', 'ih_probe').
--   detail                free-text evidence ("ASIN search returned 0 seller SKUs", "offers[] empty").
--   offer_seen_live_at    last time ANY site saw the SKU live (null = never seen live by a gate).
--   offer_missing_since   FIRST time the SKU was seen dead in the CURRENT dead streak. It STICKS
--                         across repeated dead observations (COALESCE(existing, now)) and is reset
--                         to NULL the moment a live observation arrives. The alarm's offer_dead
--                         prong fires when this is older than its grace window (24h) — so a
--                         single transient empty result never alarms; a SKU dead since June does.
--   asin / parent_asin    the family key. parent_asin lets the detector load a family's WHOLE
--                         persisted roster (FBA+FBM twins the push discovered live but that were
--                         never synced into listing_content) by one indexed read.

CREATE TABLE IF NOT EXISTS sku_offer_liveness (
  sku                  text PRIMARY KEY,
  asin                 text,
  parent_asin          text,
  last_checked_at      timestamptz NOT NULL,
  offer_live           boolean NOT NULL,
  source               text NOT NULL,
  detail               text,
  offer_seen_live_at   timestamptz,
  offer_missing_since  timestamptz
);

CREATE INDEX IF NOT EXISTS sku_offer_liveness_parent_asin_idx ON sku_offer_liveness (parent_asin);

ALTER TABLE sku_offer_liveness ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sol_service_all ON sku_offer_liveness;
CREATE POLICY sol_service_all ON sku_offer_liveness
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sol_auth_read ON sku_offer_liveness;
CREATE POLICY sol_auth_read ON sku_offer_liveness
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE sku_offer_liveness IS
  'Persisted per-SKU live-offer verdicts from the push gate / details gate / family reconcile (the Listings-Items ground truth the push already computes). ONE writer: src/lib/fba/offerLiveness.ts recordOfferLiveness. Read by the VARIANT-DEATH ALARM (variantDeathAlarm.ts) as the authoritative offer_dead evidence and as the persisted family roster.';
COMMENT ON COLUMN sku_offer_liveness.offer_missing_since IS
  'First dead observation of the CURRENT dead streak. Sticks across repeated dead observations; reset to NULL by any live observation. The alarm fires when this is older than OFFER_LIVENESS_GRACE_MS (24h).';
COMMENT ON COLUMN sku_offer_liveness.offer_seen_live_at IS
  'Most recent live observation by any truth site (null = never seen live by a gate).';
