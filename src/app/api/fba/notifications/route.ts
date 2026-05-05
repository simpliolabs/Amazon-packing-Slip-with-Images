/**
 * FBA Notifications API Route
 *
 * GET  /api/fba/notifications          — list notifications (unread first)
 * PATCH /api/fba/notifications         — mark notifications as read
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function requireAuth(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return false
  const token = authHeader.slice(7)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data: { user } } = await supabase.auth.getUser(token)
  return !!user
}

/**
 * GET /api/fba/notifications
 * Returns recent FBA notifications, unread first.
 */
export async function GET(req: NextRequest) {
  if (!await requireAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminSupabase()
  const { searchParams } = new URL(req.url)
  const unreadOnly = searchParams.get('unread') === 'true'

  let query = supabase
    .from('fba_notifications')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  if (unreadOnly) {
    query = query.eq('is_read', false)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const notifications = data || []
  const unreadCount = notifications.filter(n => !n.is_read).length

  return NextResponse.json({ notifications, unreadCount })
}

/**
 * PATCH /api/fba/notifications
 * Mark notifications as read.
 * Body: { ids?: string[], all?: boolean }
 */
export async function PATCH(req: NextRequest) {
  if (!await requireAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminSupabase()

  let body: { ids?: string[]; all?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.all) {
    const { error } = await supabase
      .from('fba_notifications')
      .update({ is_read: true })
      .eq('is_read', false)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, marked: 'all' })
  }

  if (body.ids && body.ids.length > 0) {
    const { error } = await supabase
      .from('fba_notifications')
      .update({ is_read: true })
      .in('id', body.ids)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, marked: body.ids.length })
  }

  return NextResponse.json({ error: 'Provide ids or all:true' }, { status: 400 })
}
