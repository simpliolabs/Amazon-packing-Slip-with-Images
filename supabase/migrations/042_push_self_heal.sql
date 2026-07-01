-- 042_push_self_heal.sql
-- Self-healing push layer (feat/self-healing-push). When a broadcast attribute is MISSING on the
-- non-buyable variation PARENT hub (e.g. Custom-Cup-TS-Parent rejected on every PATCH because
-- shirt_size#?.size_system / size_class are absent on the hub while its CHILDREN carry valid
-- values), the push enqueues a heal task; the cron reads a live child's value and PATCHes it onto
-- the parent (VALIDATION_PREVIEW → LIVE). A learned rule is recorded so future pushes pre-fill.
--
-- ADDITIVE ONLY (idempotent): CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS, safe to re-run.

-- ── LEARNED HEAL RULES ────────────────────────────────────────────────────────────────────────
-- One row per (product_type, attr_key). Records HOW a missing broadcast attribute was resolved so
-- the Tier-2 proactive pre-fill can ship it complete on future pushes without tripping the
-- rejection again. `sub_keys` names the composite sub-fields for a container attr (shirt_size →
-- ["size_system","size_class"]). resolved_value holds a concrete value only when the resolution is
-- schema_default / po_provided; inherit_from_child re-reads a live child at pre-fill time.
CREATE TABLE IF NOT EXISTS push_heal_rules (
  product_type    text NOT NULL,
  attr_key        text NOT NULL,
  -- composite sub-fields for a container attr, e.g. ["size_system","size_class"]; [] for flat attrs
  sub_keys        jsonb,
  resolution      text NOT NULL DEFAULT 'inherit_from_child'
                        CHECK (resolution IN ('inherit_from_child', 'schema_default', 'po_provided')),
  -- concrete value for schema_default / po_provided; NULL for inherit_from_child (re-read at pre-fill)
  resolved_value  jsonb,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  hit_count       int NOT NULL DEFAULT 1,
  PRIMARY KEY (product_type, attr_key)
);

ALTER TABLE push_heal_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS phr_service_all ON push_heal_rules;
CREATE POLICY phr_service_all ON push_heal_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS phr_auth_read ON push_heal_rules;
CREATE POLICY phr_auth_read ON push_heal_rules
  FOR SELECT TO authenticated USING (true);

-- ── HEAL TASKS ride the existing verify queue ───────────────────────────────────────────────────
-- Reuse push_verification_tasks' claim/backoff/attempt/needs_attention machinery for heal tasks.
-- kind='verify' is the existing behavior (default, unchanged); kind='heal' carries a heal_payload
-- { parentSku, productType, missingAttrKeys } the cron hands to healParentAttributes.
ALTER TABLE push_verification_tasks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'verify';
COMMENT ON COLUMN push_verification_tasks.kind IS
  'verify (default, existing behavior) | heal (self-healing-push: cron runs healParentAttributes on heal_payload).';

ALTER TABLE push_verification_tasks
  ADD COLUMN IF NOT EXISTS heal_payload jsonb;
COMMENT ON COLUMN push_verification_tasks.heal_payload IS
  'For kind=heal: { parentSku, productType, missingAttrKeys } handed to healParentAttributes. NULL for verify tasks.';

-- Reload PostgREST's schema cache so the new columns/table are queryable immediately (030–041 precedent).
NOTIFY pgrst, 'reload schema';
