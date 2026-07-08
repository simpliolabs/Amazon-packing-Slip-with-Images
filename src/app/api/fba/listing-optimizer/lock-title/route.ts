/**
 * POST /api/fba/listing-optimizer/lock-title — the seller's GOLD-TITLE authority.
 *
 * Body: { parent_asin: string, action: 'lock' | 'unlock', title?: string }
 *   action=lock   — set recommended_title = the seller's title (when provided, non-empty) AND
 *                   title_source='manual'. A whole-listing AI Audit / Regenerate then PRESERVES this
 *                   title (see the lock guard in ai-recommendations POST) instead of overwriting it.
 *                   This is the DISCOVERABLE lock the seller asked for — it stores their exact title
 *                   WITHOUT any Amazon push (a push corrupts the lock if the Ship modal seeded the AI
 *                   title, as happened on B0FRYMM56C: the modal seeded the AI rewrite, the seller
 *                   pushed it, and pushExecutor locked the AI title as 'manual').
 *   action=unlock — set title_source='ai' so the next Regenerate is free to rewrite the title.
 *
 * The acting user is resolved server-side from the Authorization: Bearer JWT (same as claim/route.ts).
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getBearerUser, resolveUserName } from '@/lib/fba/claims'

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

export async function POST(req: NextRequest) {
  const user = await getBearerUser(req)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { parent_asin?: string; action?: string; title?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parentAsin = (body.parent_asin || '').trim()
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  const action = body.action === 'unlock' ? 'unlock' : 'lock'
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''

  const db = admin()

  // Read the current recommended_title so we can log the before/after and only overwrite on an actual change.
  const { data: cur, error: readErr } = await db
    .from('listing_seo_recommendations')
    .select('recommended_title, title_source')
    .eq('parent_asin', parentAsin)
    .maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!cur) return NextResponse.json({ error: 'No recommendation row for this parent_asin' }, { status: 404 })
  const before = (cur as { recommended_title?: string }).recommended_title ?? ''

  // Build the update. LOCK: stamp 'manual' + (if the seller typed a title) make it the recommendation so
  // the modal, cohesion, and every future regen use HIS title. UNLOCK: release to 'ai'.
  const update: { title_source: string; recommended_title?: string } =
    action === 'unlock' ? { title_source: 'ai' } : { title_source: 'manual', ...(title ? { recommended_title: title } : {}) }

  const { error: upErr } = await db
    .from('listing_seo_recommendations')
    .update(update)
    .eq('parent_asin', parentAsin)
  if (upErr) {
    // The lock column is migration 044. If it is not applied, FAIL LOUDLY (do not silently pretend the
    // lock saved — that is exactly the silent-fallback bug that dropped the lock on B0FRYMM56C).
    console.error('[lock-title] update failed (migration 044 applied?):', upErr.message)
    return NextResponse.json({ error: `Lock write failed: ${upErr.message}. Confirm migration 044 (title_source) is applied.` }, { status: 500 })
  }

  // Best-effort audit-log row (never blocks the response).
  try {
    const myName = await resolveUserName(user.id, user.email)
    // action MUST be one of the listing_change_log CHECK set (037: edit/ai_generate/ai_regenerate/push/
    // claim/release/takeover) — 'lock'/'unlock' would violate the constraint and be silently swallowed, so
    // we log it as 'edit' and encode lock vs unlock in the field label so the timeline still reads clearly.
    await db.from('listing_change_log').insert({
      parent_asin: parentAsin, sku: null, field: action === 'lock' ? 'title (locked)' : 'title (unlocked)', action: 'edit',
      before_value: before, after_value: action === 'lock' && title ? title : before,
      changed_by: user.id, changed_by_name: myName, source: 'manual_edit',
    })
  } catch (e) { console.warn('[lock-title] change-log insert failed:', e instanceof Error ? e.message : e) }

  return NextResponse.json({
    ok: true,
    title_source: update.title_source,
    recommended_title: action === 'lock' && title ? title : before,
  })
}
