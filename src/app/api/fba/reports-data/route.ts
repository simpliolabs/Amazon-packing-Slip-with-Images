/**
 * FBA Reports Data API Route
 *
 * GET /api/fba/reports-data?type=sales|listings
 * Returns data from sku_sales_analytics or listing_health tables
 * Uses service_role key to bypass RLS
 *
 * Sales query filters out Amazon gift-wrap SKUs (amzn.gr.*) which are internal
 * order-routing SKUs and should not appear in the analytics table.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const revalidate = 0

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get('type') || 'sales'
  const supabase = getAdminSupabase()

  if (type === 'sales') {
    // Filter out Amazon internal gift-wrap SKUs (amzn.gr.*) and the trailing-dot
    // duplicate SKUs (e.g. "DAFEI-482-32G.") that appear in the orders report.
    // These are not real seller SKUs and inflate/distort the analytics table.
    const { data, error } = await supabase
      .from('sku_sales_analytics')
      .select('*')
      .not('sku', 'like', 'amzn.gr.%')
      .not('sku', 'like', '%.') // trailing-dot duplicates
      .order('units_sold_30d', { ascending: false })
      .limit(1000)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  }

  if (type === 'listings') {
    const { data, error } = await supabase
      .from('listing_health')
      .select('*')
      .order('status', { ascending: true })
      .limit(500)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  }

  return NextResponse.json({ error: 'Invalid type parameter' }, { status: 400 })
}
