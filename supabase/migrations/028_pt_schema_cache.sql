-- Migration 028: persistent product-type schema cache (PO 2026-06-12: "schema-cache
-- persistence ... so we always run LEAN"). The in-process _schemaCache (success-only,
-- 100KB-1MB per schema) resets on every Coolify deploy, so the FIRST regen/push after each
-- deploy re-downloads every schema from SP-API (meta call + presigned S3 fetch). This table
-- makes warmup survive deploys: memory miss -> DB (7-day TTL, checked in code) -> live fetch
-- -> write back to BOTH. Best-effort on both sides - a missing table or failed write never
-- breaks a regen or push; VALIDATION_PREVIEW remains the live backstop for any staleness.

CREATE TABLE IF NOT EXISTS pt_schema_cache (
  cache_key   TEXT        PRIMARY KEY,   -- "<productType>|<marketplaceId>"
  schema      JSONB       NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pt_schema_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_pt_schema_cache" ON pt_schema_cache;
CREATE POLICY "service_role_pt_schema_cache" ON pt_schema_cache FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
