/**
 * POST /api/fba/listing-optimizer/claim — listing soft-lock CLAIMS (spec §4-B / §5 Phase B).
 *
 * Body: { parent_asin: string, action?: 'claim'|'release'|'heartbeat'|'takeover', intent?: string }
 *   action=claim     (default) ATOMICALLY claim a free/stale/released/never-claimed listing.
 *                    Single conditional INSERT … ON CONFLICT(parent_asin) DO UPDATE … WHERE
 *                    (freeness predicate); 0 affected rows ⇒ held ⇒ 409 { held_by_name }.
 *   action=heartbeat refresh last_heartbeat ONLY WHERE claimed_by = me (keeps a live tab's lock warm;
 *                    a steal that already happened is NOT clobbered).
 *   action=release   release my own claim (released_at=now, release_reason='manual').
 *   action=takeover  FORCE-reassign to me regardless of holder; writes a listing_change_log row
 *                    (action='takeover') recording BOTH the previous and the new user id.
 *
 * The acting user is resolved server-side from the Authorization: Bearer JWT (work-log getAuthUser
 * pattern). Staleness uses the shared CLAIM_TTL so the dashboard chip and this route never disagree.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getBearerUser, resolveUserName, type ClaimRow } from '@/lib/fba/claims'

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

type Action = 'claim' | 'release' | 'heartbeat' | 'takeover'

export async function POST(req: NextRequest) {
  const user = await getBearerUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { parent_asin?: string; action?: string; intent?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parentAsin = (body.parent_asin || '').trim()
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })

  const action = (body.action || 'claim') as Action
  if (!['claim', 'release', 'heartbeat', 'takeover'].includes(action)) {
    return NextResponse.json({ error: `unknown action '${action}'` }, { status: 400 })
  }

  const db = admin()
  const myName = await resolveUserName(user.id, user.email)
  const now = new Date().toISOString()

  // ── HEARTBEAT — refresh ONLY my own live claim. A steal that already happened is left alone. ──
  if (action === 'heartbeat') {
    const { data, error } = await db
      .from('listing_claims')
      .update({ last_heartbeat: now })
      .eq('parent_asin', parentAsin)
      .eq('claimed_by', user.id)
      .is('released_at', null)
      .select('parent_asin')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    // 0 rows ⇒ I no longer hold it (released or stolen). Tell the client so it can re-claim/refresh.
    if (!data || data.length === 0) {
      return NextResponse.json({ ok: false, lost: true }, { status: 409 })
    }
    return NextResponse.json({ ok: true })
  }

  // ── RELEASE — drop my own claim (manual). Idempotent: no-op if I don't hold it. ──────────────
  if (action === 'release') {
    const { data, error } = await db
      .from('listing_claims')
      .update({ released_at: now, release_reason: 'manual', last_heartbeat: now })
      .eq('parent_asin', parentAsin)
      .eq('claimed_by', user.id)
      .is('released_at', null)
      .select('parent_asin')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await logChange(db, {
      parent_asin: parentAsin, action: 'release', changed_by: user.id, changed_by_name: myName,
    })
    return NextResponse.json({ ok: true, released: (data?.length ?? 0) > 0 })
  }

  // ── TAKEOVER — force-reassign to me regardless of holder; record BOTH user ids. ──────────────
  if (action === 'takeover') {
    // Read the prior holder first so the change-log row carries both ids (best-effort snapshot).
    const { data: prior } = await db
      .from('listing_claims')
      .select('claimed_by, claimed_by_name')
      .eq('parent_asin', parentAsin)
      .maybeSingle()
    const prev = (prior as { claimed_by: string | null; claimed_by_name: string | null } | null)

    const claimPayload = {
      parent_asin: parentAsin,
      claimed_by: user.id,
      claimed_by_name: myName,
      claimed_at: now,
      last_heartbeat: now,
      released_at: null,
      release_reason: null,
      intent: body.intent ?? null,
    }
    // Unconditional upsert — takeover deliberately ignores the freeness predicate.
    const { error } = await db
      .from('listing_claims')
      .upsert(claimPayload, { onConflict: 'parent_asin' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    await logChange(db, {
      parent_asin: parentAsin,
      action: 'takeover',
      changed_by: user.id,
      changed_by_name: myName,
      // before/after carry the two user ids so the timeline reads "NAME took over from PREV".
      before_value: prev?.claimed_by ?? null,
      after_value: user.id,
      field: prev?.claimed_by_name ? `from:${prev.claimed_by_name}` : null,
    })
    return NextResponse.json({ ok: true, claim: claimPayload })
  }

  // ── CLAIM — ATOMIC. INSERT … ON CONFLICT(parent_asin) DO UPDATE … WHERE (freeness). ──────────
  // supabase-js cannot express a conditional ON-CONFLICT WHERE, so we go through an RPC-free path:
  // a single SQL statement via the PostgREST `rpc`-style is unavailable; instead we use the
  // documented two-statement-free approach — a raw UPSERT guarded by a follow-up conditional read
  // is racy, so we use a Postgres function. The function `claim_listing` runs the atomic
  // INSERT…ON CONFLICT…WHERE and returns the winning row (or NULL ⇒ held).
  const { data, error } = await db.rpc('claim_listing', {
    p_parent_asin: parentAsin,
    p_user: user.id,
    p_user_name: myName,
    p_intent: body.intent ?? null,
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const won = (data as ClaimRow[] | null)?.[0] ?? null
  if (!won) {
    // 0 rows ⇒ a live (non-stale) claim is held by someone else → 409 with the holder's name.
    const { data: holder } = await db
      .from('listing_claims')
      .select('claimed_by_name, claimed_at')
      .eq('parent_asin', parentAsin)
      .maybeSingle()
    const h = holder as { claimed_by_name: string | null; claimed_at: string | null } | null
    return NextResponse.json(
      { error: 'Listing is being worked on', held_by_name: h?.claimed_by_name ?? null, held_since: h?.claimed_at ?? null },
      { status: 409 },
    )
  }

  await logChange(db, {
    parent_asin: parentAsin, action: 'claim', changed_by: user.id, changed_by_name: myName,
  })
  return NextResponse.json({ ok: true, claim: won })
}

// ── change-log helper (best-effort; never blocks the claim response) ─────────────────────────
async function logChange(
  db: ReturnType<typeof admin>,
  row: {
    parent_asin: string
    action: 'claim' | 'release' | 'takeover'
    changed_by: string
    changed_by_name: string
    field?: string | null
    before_value?: string | null
    after_value?: string | null
  },
) {
  try {
    await db.from('listing_change_log').insert({
      parent_asin: row.parent_asin,
      sku: null,
      field: row.field ?? null,
      action: row.action,
      before_value: row.before_value ?? null,
      after_value: row.after_value ?? null,
      changed_by: row.changed_by,
      changed_by_name: row.changed_by_name,
      source: 'manual_edit',
    })
  } catch (e) {
    console.warn('[claim] change-log insert failed:', e instanceof Error ? e.message : e)
  }
}
