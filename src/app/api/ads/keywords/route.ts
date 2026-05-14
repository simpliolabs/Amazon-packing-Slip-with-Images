/**
 * GET  /api/ads/keywords?campaignId=xxx
 * PATCH /api/ads/keywords — update keyword bid
 *
 * GET returns keywords with their 30-day performance for a campaign.
 * PATCH updates a keyword bid via the Amazon Ads API and syncs to Supabase.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adsApiFetch } from '@/lib/amazon/ads-auth'

export const dynamic = 'force-dynamic'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const campaignId = searchParams.get('campaignId')

  const supabase = getAdminSupabase()

  let query = supabase
    .from('ads_keywords')
    .select('*')
    .eq('state', 'enabled')
    .order('bid', { ascending: false })

  if (campaignId) {
    query = query.eq('campaign_id', campaignId)
  }

  const { data: keywords, error } = await query.limit(500)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Fetch 30-day performance for these keywords
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const dateStr = thirtyDaysAgo.toISOString().split('T')[0]

  const keywordIds = (keywords || []).map(k => k.keyword_id)
  const { data: perfData } = await supabase
    .from('ads_keyword_perf')
    .select('keyword_id, impressions, clicks, cost, attributed_sales_7d, attributed_units_7d, acos_7d')
    .gte('report_date', dateStr)
    .in('keyword_id', keywordIds)

  const perfByKeyword = new Map<string, {
    impressions: number; clicks: number; cost: number; sales: number; units: number
  }>()
  for (const p of perfData || []) {
    const existing = perfByKeyword.get(p.keyword_id) || {
      impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0
    }
    perfByKeyword.set(p.keyword_id, {
      impressions: existing.impressions + (p.impressions || 0),
      clicks:      existing.clicks      + (p.clicks      || 0),
      cost:        existing.cost        + (p.cost        || 0),
      sales:       existing.sales       + (p.attributed_sales_7d || 0),
      units:       existing.units       + (p.attributed_units_7d || 0),
    })
  }

  const enriched = (keywords || []).map(kw => {
    const perf  = perfByKeyword.get(kw.keyword_id)
    const cost  = perf?.cost  || 0
    const sales = perf?.sales || 0
    return {
      ...kw,
      perf_30d: {
        impressions: perf?.impressions || 0,
        clicks:      perf?.clicks      || 0,
        cost:        Math.round(cost  * 100) / 100,
        sales:       Math.round(sales * 100) / 100,
        units:       perf?.units || 0,
        acos:        sales > 0 ? Math.round((cost / sales) * 10000) / 100 : null,
        cpc:         perf?.clicks && perf.clicks > 0
          ? Math.round((cost / perf.clicks) * 100) / 100 : null,
      },
    }
  })

  return NextResponse.json({ keywords: enriched }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const { keyword_id, bid } = body

  if (!keyword_id || bid === undefined || bid === null) {
    return NextResponse.json({ error: 'keyword_id and bid are required' }, { status: 400 })
  }

  const newBid = parseFloat(bid)
  if (isNaN(newBid) || newBid < 0.02 || newBid > 1000) {
    return NextResponse.json({ error: 'bid must be between $0.02 and $1000' }, { status: 400 })
  }

  // Update via Amazon Ads API
  const resp = await adsApiFetch('/sp/keywords', {
    method: 'PUT',
    body: JSON.stringify([{
      keywordId: keyword_id,
      bid:       newBid,
      state:     'ENABLED',
    }]),
  })

  if (!resp) {
    return NextResponse.json({ error: 'Ads API credentials not configured' }, { status: 503 })
  }

  if (!resp.ok) {
    const errText = await resp.text()
    return NextResponse.json({ error: `Amazon Ads API error: ${errText}` }, { status: resp.status })
  }

  // Sync to Supabase
  const supabase = getAdminSupabase()
  const { error: dbErr } = await supabase
    .from('ads_keywords')
    .update({ bid: newBid, updated_at: new Date().toISOString() })
    .eq('keyword_id', keyword_id)

  if (dbErr) {
    console.error('[AdsKeywords] DB update error:', dbErr.message)
  }

  return NextResponse.json({ success: true, keyword_id, bid: newBid })
}
