-- 043_heal_delete_resolution.sql
-- Heal v2: delete-partial-container (LIVE evidence 2026-07-02). Every composite heal attempt's
-- VALIDATION_PREVIEW failed with Amazon's CONDITIONAL requirement: "the field '"size"' for the
-- attribute 'Shirt Size' does not have enough values" — the parent hub carries a PARTIAL shirt_size
-- container (size_system/size_class present, per-variant `size` absent, which a parent can never
-- carry), so RE-writing system/class (strategy 1's verbatim mirror) re-trips the rule forever.
-- Strategy 2 DELETES the partial container from the parent hub instead; this migration lets the
-- learned rule record that resolution ('delete_partial_container', resolved_value {"action":"delete"}).
--
-- Postgres cannot ALTER a CHECK constraint in place. The constraint was defined INLINE in 042
-- (resolution ... CHECK (resolution IN (...))), so Postgres auto-named it
-- push_heal_rules_resolution_check ({table}_{column}_check). DROP IF EXISTS + ADD under the same
-- name — idempotent: safe to re-run (a second run drops the new constraint and re-adds it).

ALTER TABLE push_heal_rules
  DROP CONSTRAINT IF EXISTS push_heal_rules_resolution_check;

ALTER TABLE push_heal_rules
  ADD CONSTRAINT push_heal_rules_resolution_check
  CHECK (resolution IN ('inherit_from_child', 'schema_default', 'po_provided', 'delete_partial_container'));

-- Reload PostgREST's schema cache (030-042 precedent).
NOTIFY pgrst, 'reload schema';
