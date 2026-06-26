-- Migration 036: Listing work-queue collaboration — PHASE B, part 1: SOFT-LOCK CLAIMS.
-- Spec: docs/lifecycle-collab-spec.md §4-B + §5 Phase B. ADDITIVE ONLY (idempotent):
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP+CREATE POLICY, safe to re-run.
--
-- WHAT THIS UNLOCKS:
--   A per-parent soft-lock so 5 people never silently double-work the same listing. Mirrors the
--   push_jobs heartbeat/watchdog shape (027): the row PERSISTS after release (released_at set), so
--   the claim itself is a single ATOMIC conditional UPDATE whose WHERE encodes "freeness"
--   (released | never-claimed | stale-heartbeat), and the route checks rowCount to detect a 409.
--   Staleness is computed at READ time too (now()-last_heartbeat > CLAIM_TTL) so a dead browser
--   tab never holds a listing hostage — the watchdog lives on the read path, not just on release.
--
-- parent_asin is the PRIMARY KEY (= listing_key grain; standalones self-parent), so there is at
-- most ONE claim row per listing and the "first-ever claim" path is an INSERT … ON CONFLICT
-- (parent_asin) DO UPDATE … WHERE (same staleness predicate).

CREATE TABLE IF NOT EXISTS listing_claims (
  parent_asin     TEXT        PRIMARY KEY,                       -- = listing_key (self-parent for standalones)
  claimed_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  claimed_by_name TEXT,                                          -- denormalized full_name/email for chip render
  claimed_at      TIMESTAMPTZ,
  last_heartbeat  TIMESTAMPTZ,                                   -- refreshed by heartbeat + every mutating call
  released_at     TIMESTAMPTZ,                                   -- set on release/push/takeover; row persists
  release_reason  TEXT        CHECK (release_reason IN ('manual','push','timeout','takeover','done')),
  intent          TEXT                                           -- optional free-text "what I'm doing"
);

-- Watchdog/read queries scan by released_at + heartbeat staleness; parent_asin is already the PK.
CREATE INDEX IF NOT EXISTS idx_listing_claims_active
  ON listing_claims (released_at, last_heartbeat DESC);

-- RLS: mirror keyword_push_log (015) — service_role full access (server routes run as service_role
-- via createAdminClient), authenticated users may read (chips render client-side via the GET join).
ALTER TABLE listing_claims ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_claims_service_all ON listing_claims;
CREATE POLICY listing_claims_service_all ON listing_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS listing_claims_auth_read ON listing_claims;
CREATE POLICY listing_claims_auth_read ON listing_claims
  FOR SELECT TO authenticated USING (true);

-- ── ATOMIC CLAIM (Risk R4) ───────────────────────────────────────────────────────────────────
-- supabase-js cannot express a conditional "INSERT … ON CONFLICT DO UPDATE … WHERE (free)" in one
-- round-trip, so the route calls this SECURITY DEFINER function via .rpc(). The whole claim is a
-- SINGLE statement: on first-ever claim it INSERTs; on a re-claim it UPDATEs ONLY when the existing
-- row is FREE (released | never-claimed | stale heartbeat). If a LIVE claim is held by someone
-- else, the WHERE fails, 0 rows change, and the function returns NULL → the route answers 409.
-- The freeness predicate here is the SQL twin of isClaimStale() in src/lib/fba/claims.ts —
-- p_ttl_ms MUST match CLAIM_TTL_MS (default 15min) so write-time and read-time staleness agree.
CREATE OR REPLACE FUNCTION claim_listing(
  p_parent_asin TEXT,
  p_user        uuid,
  p_user_name   TEXT,
  p_intent      TEXT DEFAULT NULL,
  p_ttl_ms      bigint DEFAULT 900000   -- 15*60*1000; keep in sync with CLAIM_TTL_MS
) RETURNS SETOF listing_claims
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO listing_claims AS lc (
    parent_asin, claimed_by, claimed_by_name, claimed_at, last_heartbeat,
    released_at, release_reason, intent
  )
  VALUES (
    p_parent_asin, p_user, p_user_name, now(), now(),
    NULL, NULL, p_intent
  )
  ON CONFLICT (parent_asin) DO UPDATE SET
    claimed_by      = EXCLUDED.claimed_by,
    claimed_by_name = EXCLUDED.claimed_by_name,
    claimed_at      = EXCLUDED.claimed_at,
    last_heartbeat  = EXCLUDED.last_heartbeat,
    released_at     = NULL,
    release_reason  = NULL,
    intent          = EXCLUDED.intent
  WHERE
    lc.released_at IS NOT NULL
    OR lc.claimed_by IS NULL
    OR lc.last_heartbeat IS NULL
    OR (now() - lc.last_heartbeat) > make_interval(secs => p_ttl_ms / 1000.0)
  RETURNING lc.*;
$$;

-- Reload PostgREST's schema cache so the new table + function are queryable immediately
-- (027/034/035 precedent).
NOTIFY pgrst, 'reload schema';
