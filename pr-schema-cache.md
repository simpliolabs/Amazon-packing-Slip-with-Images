## Schema-cache persistence (your LEAN ask, part 1)

The in-process schema cache (100KB–1MB per product type) resets on every deploy, so the **first regen/push after each deploy** re-downloaded every schema from SP-API. Now: memory miss → `pt_schema_cache` DB (7-day TTL) → live fetch → written back to both tiers.

Strictly best-effort: a missing table or any DB error falls through to the live fetch exactly as before, and VALIDATION_PREVIEW remains the live backstop for any staleness. Success-only caching preserved (no null poisoning).

### ⚠️ Migration (run in Supabase SQL editor — skipping it is safe, everything keeps working as today):

```sql
CREATE TABLE IF NOT EXISTS pt_schema_cache (
  cache_key   TEXT        PRIMARY KEY,
  schema      JSONB       NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE pt_schema_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_pt_schema_cache" ON pt_schema_cache;
CREATE POLICY "service_role_pt_schema_cache" ON pt_schema_cache FOR ALL USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
```

`tsc` exit 0.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
