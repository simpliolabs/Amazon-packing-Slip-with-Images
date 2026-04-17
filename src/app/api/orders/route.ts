import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/orders
 * Returns paginated orders with optional search/filter.
 *
 * Query params:
 *   tab      – "active" (default) | "shipped" | "all"
 *   search   – free-text search across id, buyer_name, buyer_email
 *   status   – exact status filter (overrides tab when set)
 *   dateFrom – ISO date lower bound
 *   dateTo   – ISO date upper bound
 *   page     – page number (1-indexed)
 *   limit    – page size (default 50)
 *
 * Behaviour:
 *   • "active"  tab → Unshipped + PartiallyShipped, last 7 days
 *   • "shipped" tab → Shipped only, last 7 days
 *   • "all"     tab → every status, last 7 days (unless date filters override)
 *   • Date filters always override the 7-day default
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const searchParams = request.nextUrl.searchParams
  const tab = searchParams.get('tab') || 'active'
  const search = searchParams.get('search') || ''
  const status = searchParams.get('status') || ''
  const dateFrom = searchParams.get('dateFrom') || ''
  const dateTo = searchParams.get('dateTo') || ''
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')
  const offset = (page - 1) * limit

  let query = supabase
    .from('orders')
    .select('*', { count: 'exact' })
    .order('purchase_date', { ascending: false })
    .range(offset, offset + limit - 1)

  // ── Search ──
  if (search) {
    query = query.or(
      `id.ilike.%${search}%,buyer_name.ilike.%${search}%,buyer_email.ilike.%${search}%`
    )
  }

  // ── Status filter (explicit status overrides tab) ──
  if (status) {
    query = query.eq('order_status', status)
  } else {
    switch (tab) {
      case 'active':
        query = query.in('order_status', ['Unshipped', 'PartiallyShipped', 'Pending'])
        break
      case 'shipped':
        query = query.eq('order_status', 'Shipped')
        break
      // "all" → no status filter
    }
  }

  // ── Date range ──
  // If user provides explicit date filters, use them.
  // Otherwise default to last 7 days.
  if (dateFrom) {
    query = query.gte('purchase_date', dateFrom)
  } else {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
    query = query.gte('purchase_date', sevenDaysAgo.toISOString())
  }

  if (dateTo) {
    query = query.lte('purchase_date', dateTo + 'T23:59:59Z')
  }

  const { data: orders, error, count } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    orders: orders || [],
    total: count || 0,
    page,
    limit,
    totalPages: Math.ceil((count || 0) / limit),
  })
}
