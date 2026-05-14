/**
 * GET /api/ads/campaigns
 *
 * Returns all campaigns with their 30-day performance metrics.
 * Data is sourced from the local Supabase tables (synced from Amazon Ads API).
 *
 * Returns:
 *   {
 *     campaigns: Campaign[],
 *     summary: { totalSpend, totalSales, avgAcos, activeCampaigns },
 *     credentialsConfigured: boolean,
 *     lastSynced: string | null
 *   }
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAdsCredentials } from '@/lib/amazon/ads-auth'

export const dynamic = 'force-dynamic'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET() {
  const supabase = getAdminSupabase()

  // Check if credentials are configured
  const creds = await getAdsCredentials()
  const credentialsConfigured = !!creds

  // Fetch campaigns
  const { data: campaigns, error: campaignErr } = await supabase
    .from('ads_campaigns')
    .select('*')
    .order('state', { ascending: true })
    .order('name',  { ascending: true })

  if (campaignErr) {
    return NextResponse.json({ error: campaignErr.message }, { status: 500 })
  }

  // Fetch 30-day performance aggregated per campaign
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
  const dateStr = thirtyDaysAgo.toISOString().split('T')[0]

  const { data: perfData } = await supabase
    .from('ads_performance')
    .select('campaign_id, impressions, clicks, cost, attributed_sales_30d, attributed_units_30d')
    .gte('report_date', dateStr)

  // Aggregate performance by campaign_id
  const perfByCampaign = new Map<string, {
    impressions: number; clicks: number; cost: number;
    sales: number; units: number
  }>()

  for (const p of perfData || []) {
    const existing = perfByCampaign.get(p.campaign_id) || {
      impressions: 0, clicks: 0, cost: 0, sales: 0, units: 0
    }
    perfByCampaign.set(p.campaign_id, {
      impressions: existing.impressions + (p.impressions || 0),
      clicks:      existing.clicks      + (p.clicks      || 0),
      cost:        existing.cost        + (p.cost        || 0),
      sales:       existing.sales       + (p.attributed_sales_30d || 0),
      units:       existing.units       + (p.attributed_units_30d || 0),
    })
  }

  // Enrich campaigns with performance
  const enriched = (campaigns || []).map(c => {
    const perf = perfByCampaign.get(c.campaign_id)
    const cost  = perf?.cost  || 0
    const sales = perf?.sales || 0
    return {
      ...c,
      perf_30d: {
        impressions: perf?.impressions || 0,
        clicks:      perf?.clicks      || 0,
        cost:        Math.round(cost  * 100) / 100,
        sales:       Math.round(sales * 100) / 100,
        units:       perf?.units       || 0,
        acos:        sales > 0 ? Math.round((cost / sales) * 10000) / 100 : null,
        roas:        cost  > 0 ? Math.round((sales / cost) * 100) / 100   : null,
        ctr:         perf?.impressions && perf.impressions > 0
          ? Math.round((perf.clicks / perf.impressions) * 10000) / 100 : null,
        cpc:         perf?.clicks && perf.clicks > 0
          ? Math.round((cost / perf.clicks) * 100) / 100 : null,
      },
    }
  })

  // Summary
  const activeCampaigns = enriched.filter(c => c.state === 'enabled').length
  const totalSpend  = enriched.reduce((s, c) => s + (c.perf_30d.cost  || 0), 0)
  const totalSales  = enriched.reduce((s, c) => s + (c.perf_30d.sales || 0), 0)
  const avgAcos     = totalSales > 0 ? Math.round((totalSpend / totalSales) * 10000) / 100 : null

  // Last synced
  const lastSynced = campaigns && campaigns.length > 0
    ? campaigns.reduce((latest, c) => {
        if (!c.last_synced_at) return latest
        return !latest || c.last_synced_at > latest ? c.last_synced_at : latest
      }, null as string | null)
    : null

  return NextResponse.json({
    campaigns: enriched,
    summary: {
      totalSpend:       Math.round(totalSpend  * 100) / 100,
      totalSales:       Math.round(totalSales  * 100) / 100,
      avgAcos,
      activeCampaigns,
      totalCampaigns:   enriched.length,
    },
    credentialsConfigured,
    lastSynced,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
