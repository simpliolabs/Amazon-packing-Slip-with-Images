import { NextRequest, NextResponse } from 'next/server'
import { syncOrders } from '@/lib/sync/syncOrders'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/sync
 * Triggers an order sync. Accepts both:
 * - Authenticated user requests (manual "Sync Now" button)
 * - Cron requests with CRON_SECRET header
 */
export async function POST(request: NextRequest) {
  // Allow cron job with secret header
  const cronSecret = request.headers.get('x-cron-secret')
  if (cronSecret === process.env.CRON_SECRET) {
    const result = await syncOrders()
    return NextResponse.json(result)
  }

  // Otherwise require authenticated admin user
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check admin role
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null }

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: Admin only' }, { status: 403 })
  }

  const result = await syncOrders()
  return NextResponse.json(result)
}

/**
 * GET /api/sync
 * Returns the last sync status
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: lastSync } = await supabase
    .from('sync_logs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(1)
    .single()

  return NextResponse.json({ lastSync })
}
