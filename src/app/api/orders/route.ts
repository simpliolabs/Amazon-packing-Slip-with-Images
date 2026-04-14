import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/orders
 * Returns paginated orders with optional search/filter
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const searchParams = request.nextUrl.searchParams
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

  if (search) {
    query = query.or(
      `id.ilike.%${search}%,buyer_name.ilike.%${search}%,buyer_email.ilike.%${search}%`
    )
  }

  if (status) {
    query = query.eq('order_status', status)
  }

  if (dateFrom) {
    query = query.gte('purchase_date', dateFrom)
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
