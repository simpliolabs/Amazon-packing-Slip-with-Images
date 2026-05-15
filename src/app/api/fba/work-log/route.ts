/**
 * Warehouse Work Log API
 *
 * GET  /api/fba/work-log?asin=B0FKL8X35G
 *   Returns all log entries for the given ASIN, ordered newest first.
 *   Also returns sum of qty_planned for that ASIN.
 *
 * POST /api/fba/work-log
 *   Body: { asin, sku, qty_planned, note? }
 *   Creates a new print-intent log entry for the authenticated user.
 *
 * PATCH /api/fba/work-log
 *   Body: { id, qty_planned?, note? }
 *   Edits an existing entry. Saves previous values to edit_history jsonb.
 *   Admins can edit any entry; packers can only edit their own.
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/** Resolve the authenticated user from the Authorization header */
async function getAuthUser(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.replace('Bearer ', '').trim()
  if (!token) return null

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null
  return user
}

/** Get the role of a user from user_profiles */
async function getUserRole(userId: string): Promise<string | null> {
  const admin = getAdminSupabase()
  const { data } = await admin
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .single()
  return data?.role ?? null
}

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const asin = searchParams.get('asin')

  if (!asin) {
    return NextResponse.json({ error: 'asin query param required' }, { status: 400 })
  }

  const admin = getAdminSupabase()

  // Fetch all log entries for this ASIN, newest first
  const { data: entries, error } = await admin
    .from('fba_work_log')
    .select(`
      id,
      asin,
      sku,
      qty_planned,
      note,
      logged_by,
      logged_at,
      edited_at,
      edited_by,
      edit_history
    `)
    .eq('asin', asin)
    .order('logged_at', { ascending: false })

  if (error) {
    console.error('[work-log GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Resolve user emails for display
  const userIds = [
    ...new Set([
      ...(entries ?? []).map((e) => e.logged_by).filter(Boolean),
      ...(entries ?? []).map((e) => e.edited_by).filter(Boolean),
    ])
  ] as string[]

  const emailMap: Record<string, string> = {}
  if (userIds.length > 0) {
    const { data: profiles } = await admin
      .from('user_profiles')
      .select('id, email, full_name')
      .in('id', userIds)
    for (const p of profiles ?? []) {
      emailMap[p.id] = p.full_name || p.email || p.id
    }
  }

  const enriched = (entries ?? []).map((e) => ({
    ...e,
    logged_by_name: e.logged_by ? (emailMap[e.logged_by] ?? e.logged_by) : null,
    edited_by_name: e.edited_by ? (emailMap[e.edited_by] ?? e.edited_by) : null,
  }))

  const total_planned = enriched.reduce((sum, e) => sum + (e.qty_planned ?? 0), 0)

  return NextResponse.json({ entries: enriched, total_planned })
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = await getUserRole(user.id)
  if (!role || !['admin', 'packer'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { asin?: string; sku?: string; qty_planned?: number; note?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { asin, sku, qty_planned, note } = body

  if (!asin || !sku || !qty_planned || qty_planned < 1) {
    return NextResponse.json(
      { error: 'asin, sku, and qty_planned (>0) are required' },
      { status: 400 }
    )
  }

  const admin = getAdminSupabase()

  const { data, error } = await admin
    .from('fba_work_log')
    .insert({
      asin,
      sku,
      qty_planned,
      note: note ?? null,
      logged_by: user.id,
      logged_at: new Date().toISOString(),
      edit_history: [],
    })
    .select()
    .single()

  if (error) {
    console.error('[work-log POST]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ entry: data }, { status: 201 })
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const role = await getUserRole(user.id)
  if (!role || !['admin', 'packer'].includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: { id?: string; qty_planned?: number; note?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { id, qty_planned, note } = body

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }
  if (qty_planned !== undefined && qty_planned < 1) {
    return NextResponse.json({ error: 'qty_planned must be > 0' }, { status: 400 })
  }

  const admin = getAdminSupabase()

  // Fetch the existing entry to build audit trail
  const { data: existing, error: fetchErr } = await admin
    .from('fba_work_log')
    .select('*')
    .eq('id', id)
    .single()

  if (fetchErr || !existing) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  }

  // Packers can only edit their own entries; admins can edit any
  if (role !== 'admin' && existing.logged_by !== user.id) {
    return NextResponse.json({ error: 'Forbidden — can only edit your own entries' }, { status: 403 })
  }

  // Build the audit trail entry
  const historyEntry = {
    prev_qty_planned: existing.qty_planned,
    prev_note: existing.note,
    edited_by: user.id,
    edited_at: new Date().toISOString(),
  }

  const updatedHistory = Array.isArray(existing.edit_history)
    ? [...existing.edit_history, historyEntry]
    : [historyEntry]

  const updates: Record<string, unknown> = {
    edited_at: new Date().toISOString(),
    edited_by: user.id,
    edit_history: updatedHistory,
  }
  if (qty_planned !== undefined) updates.qty_planned = qty_planned
  if (note !== undefined) updates.note = note

  const { data: updated, error: updateErr } = await admin
    .from('fba_work_log')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (updateErr) {
    console.error('[work-log PATCH]', updateErr)
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  return NextResponse.json({ entry: updated })
}
