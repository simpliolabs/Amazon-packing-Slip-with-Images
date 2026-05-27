import { NextRequest, NextResponse } from 'next/server'
import { syncOrders } from '@/lib/sync/syncOrders'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit } from '@/lib/rateLimit'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/sync
 * Triggers an order sync. Accepts both:
 * - Authenticated user requests (manual "Sync Now" button)
 * - Cron requests with CRON_SECRET header
 * Rate limited to 3 manual syncs per 5 minutes.
 */
export async function POST(request: NextRequest) {
  // Allow cron job with secret header (no rate limit for cron)
  const cronSecret = request.headers.get('x-cron-secret')
  if (cronSecret === process.env.CRON_SECRET) {
    await logAudit({
      userId: null,
      action: 'sync.trigger_cron',
      resourceType: 'sync',
      details: { trigger: 'cron' },
    })
    const result = await syncOrders()
    return NextResponse.json(result)
  }

  // Otherwise require authenticated admin user
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limit: 3 syncs per 5 minutes per user
  const { allowed, remaining, resetInSeconds } = checkRateLimit(
    `sync:${user.id}`,
    3,
    5 * 60 * 1000
  )
  if (!allowed) {
    return NextResponse.json(
      { error: `Rate limited. Try again in ${resetInSeconds} seconds.` },
      {
        status: 429,
        headers: {
          'Retry-After': String(resetInSeconds),
          'X-RateLimit-Remaining': '0',
        },
      }
    )
  }

  // Check authenticated role (admin and packer can sync)
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null }

  if (!profile || !['admin', 'packer'].includes(profile.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Audit log for manual sync
  await logAudit({
    userId: user.id,
    action: 'sync.trigger_manual',
    resourceType: 'sync',
    ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  })

  const result = await syncOrders()

  const response = NextResponse.json(result)
  response.headers.set('X-RateLimit-Remaining', String(remaining))
  return response
}

/**
 * GET /api/sync
 * - Vercel Cron: triggers order sync when Authorization: Bearer <CRON_SECRET> is present
 * - Authenticated users: returns the last sync status
 */
export async function GET(request: NextRequest) {
  // Allow Vercel Cron (sends Authorization: Bearer <CRON_SECRET>)
  const authHeader = request.headers.get('authorization')
  const secret = process.env.CRON_SECRET
  if (secret && authHeader === `Bearer ${secret}`) {
    await logAudit({
      userId: null,
      action: 'sync.trigger_cron',
      resourceType: 'sync',
      details: { trigger: 'vercel_cron' },
    })
    const result = await syncOrders()
    return NextResponse.json(result)
  }

  // Otherwise return last sync status for authenticated users
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
