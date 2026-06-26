/**
 * Shared helpers for the listing soft-lock CLAIMS subsystem (spec §4-B / §5 Phase B).
 *
 * Centralizes the bits the claim route AND the optimizer GET must agree on:
 *   • CLAIM_TTL          — how long a claim survives without a heartbeat before it is "stale"
 *                          and freely takeover-able. PO-tunable (a single named const).
 *   • getBearerUser()    — resolve the acting user server-side from the Authorization: Bearer JWT
 *                          (reuse of the verified work-log getAuthUser pattern, work-log/route.ts:31-43).
 *   • resolveUserName()  — full_name || email || id, from user_profiles (matches work-log GET).
 *   • isClaimStale()     — the SINGLE staleness rule, computed identically at write time (the claim
 *                          WHERE predicate) and at read time (the dashboard chip), so a card never
 *                          says "held" while the claim route would let someone take it over.
 */
import { createClient } from '@supabase/supabase-js'

// 15 minutes. CLAIM_TTL >> heartbeat (≈30s) so 20+ missed beats elapse before a steal (spec §5 B
// "Watchdog-on-READ"). PO may tune this one constant.
export const CLAIM_TTL_MS = 15 * 60 * 1000

/** A live claim row (the shape both the route and the GET join read). */
export type ClaimRow = {
  parent_asin: string
  claimed_by: string | null
  claimed_by_name: string | null
  claimed_at: string | null
  last_heartbeat: string | null
  released_at: string | null
  release_reason: string | null
  intent: string | null
}

/**
 * Is this claim free to (re)claim? TRUE when released, never-claimed, or the heartbeat is older
 * than CLAIM_TTL. This is the JS mirror of the SQL freeness predicate used in the atomic claim
 * UPDATE — keep the two in lockstep (spec Risk R4 / R5).
 */
export function isClaimStale(claim: Pick<ClaimRow, 'released_at' | 'claimed_by' | 'last_heartbeat'> | null, now = Date.now()): boolean {
  if (!claim) return true
  if (claim.released_at) return true
  if (!claim.claimed_by) return true
  if (!claim.last_heartbeat) return true
  return now - new Date(claim.last_heartbeat).getTime() > CLAIM_TTL_MS
}

// NOTE: the SQL twin of isClaimStale() lives in the migration's claim_listing() function
// (036_listing_claims.sql) — the freeness predicate in its ON CONFLICT … DO UPDATE … WHERE.
// p_ttl_ms there (default 900000) MUST equal CLAIM_TTL_MS so write-time and read-time staleness agree.

/** Anon client used ONLY to verify a Bearer JWT (never to query under RLS). */
function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

/** Resolve the authenticated user from the Authorization header (work-log getAuthUser pattern). */
export async function getBearerUser(req: Request): Promise<{ id: string; email: string | null } | null> {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return null
  const { data, error } = await anonClient().auth.getUser(token)
  if (error || !data.user) return null
  return { id: data.user.id, email: data.user.email ?? null }
}

/** Service-role client for resolving display names (reads user_profiles). */
function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

/** full_name || email || id — the SAME display rule as work-log GET (route.ts:106). */
export async function resolveUserName(userId: string, fallbackEmail: string | null = null): Promise<string> {
  const { data } = await adminClient()
    .from('user_profiles')
    .select('full_name, email')
    .eq('id', userId)
    .maybeSingle()
  const p = data as { full_name: string | null; email: string | null } | null
  return p?.full_name || p?.email || fallbackEmail || userId
}
