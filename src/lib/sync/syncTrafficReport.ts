/**
 * Traffic & Conversion Intelligence Sync
 *
 * Fetches GET_SALES_AND_TRAFFIC_REPORT from SP-API (30-day window, CHILD granularity)
 * and writes the results to:
 *   1. asin_traffic — per-child-ASIN traffic/conversion data
 *   2. parent_asin_rollup — pre-computed parent-level aggregates
 *   3. sku_sales_analytics — enriches existing rows with traffic columns
 *   4. listing_health — backfills parent_asin
 *
 * This is the MISSING LINK that gives the replenishment engine:
 *   - Sessions (demand signal even when 0 sales)
 *   - Buy Box % (are we winning?)
 *   - Conversion Rate (unitSessionPercentage)
 *   - Parent ASIN grouping (sibling demand context)
 */
import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface TrafficSyncResult {
  asinsSynced: number
  parentRollupsCreated: number
  error: string | null
  durationMs: number
}

interface RawTrafficEntry {
  parentAsin: string
  childAsin: string
  sku: string
  // Sales
  unitsOrdered: number
  orderedRevenue: number
  // Traffic
  sessions: number
  pageViews: number
  buyBoxPct: number
  conversionRate: number
  // Mobile breakdown
  browserSessions: number
  mobileAppSessions: number
  browserPageViews: number
  mobilePageViews: number
}

/**
 * Main entry point: fetch, parse, and persist traffic intelligence.
 */
export async function syncTrafficReport(): Promise<TrafficSyncResult> {
  const start = Date.now()
  const supabase = getAdminSupabase()

  try {
    const token = await getAccessToken()

    const endDate = new Date()
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const formatDate = (d: Date) => d.toISOString().split('T')[0]

    // ── 1. Check for existing DONE report (avoid re-requesting) ─────────
    const recentReportsResp = await fetch(
      `${ENDPOINT}/reports/2021-06-30/reports` +
      `?reportTypes=GET_SALES_AND_TRAFFIC_REPORT` +
      `&processingStatuses=DONE` +
      `&marketplaceIds=${MARKETPLACE_ID}` +
      `&createdSince=${encodeURIComponent(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())}` +
      `&pageSize=1`,
      { headers: { 'x-amz-access-token': token } }
    )

    let documentId: string | null = null

    if (recentReportsResp.ok) {
      const recentData = await recentReportsResp.json()
      const reports = recentData.reports || []
      if (reports.length > 0 && reports[0].reportDocumentId) {
        documentId = reports[0].reportDocumentId
        console.log(`[Traffic Sync] Reusing existing DONE report: ${reports[0].reportId}`)
      }
    }

    // ── 2. If no recent report, request a new one ───────────────────────
    if (!documentId) {
      const reportResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
        method: 'POST',
        headers: {
          'x-amz-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
          marketplaceIds: [MARKETPLACE_ID],
          reportOptions: {
            dateGranularity: 'MONTH',
            asinGranularity: 'CHILD',
          },
          dataStartTime: `${formatDate(startDate)}T00:00:00Z`,
          dataEndTime: `${formatDate(endDate)}T23:59:59Z`,
        }),
      })

      if (!reportResp.ok) {
        const errBody = await reportResp.text()
        console.warn(`[Traffic Sync] Failed to request report (${reportResp.status}):`, errBody)
        return { asinsSynced: 0, parentRollupsCreated: 0, error: `Report request failed: ${reportResp.status}`, durationMs: Date.now() - start }
      }

      const reportJson = await reportResp.json()
      const reportId = reportJson.reportId
      if (!reportId) {
        return { asinsSynced: 0, parentRollupsCreated: 0, error: 'No reportId returned', durationMs: Date.now() - start }
      }

      console.log(`[Traffic Sync] Requested new report: ${reportId}`)

      // Poll for completion (up to 5 minutes)
      const maxAttempts = 60
      for (let i = 0; i < maxAttempts; i++) {
        await sleep(5000)
        const statusResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports/${reportId}`, {
          headers: { 'x-amz-access-token': token },
        })
        if (!statusResp.ok) continue
        const status = await statusResp.json()
        console.log(`[Traffic Sync] Poll ${i + 1}: ${status.processingStatus}`)

        if (status.processingStatus === 'DONE') {
          documentId = status.reportDocumentId
          break
        }
        if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
          return { asinsSynced: 0, parentRollupsCreated: 0, error: `Report ${status.processingStatus}`, durationMs: Date.now() - start }
        }
      }

      if (!documentId) {
        return { asinsSynced: 0, parentRollupsCreated: 0, error: 'Report timed out after 5 minutes', durationMs: Date.now() - start }
      }
    }

    // ── 3. Download the report document ─────────────────────────────────
    const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${documentId}`, {
      headers: { 'x-amz-access-token': token },
    })
    if (!docResp.ok) {
      return { asinsSynced: 0, parentRollupsCreated: 0, error: `Failed to get document URL (${docResp.status})`, durationMs: Date.now() - start }
    }
    const { url } = await docResp.json()
    const dataResp = await fetch(url)
    if (!dataResp.ok) {
      return { asinsSynced: 0, parentRollupsCreated: 0, error: 'Failed to download report data', durationMs: Date.now() - start }
    }
    const rawText = await dataResp.text()
    console.log(`[Traffic Sync] Downloaded ${rawText.length} bytes`)

    // ── 4. Parse the JSON report ────────────────────────────────────────
    let reportData: Record<string, unknown>
    try {
      reportData = JSON.parse(rawText)
    } catch {
      return { asinsSynced: 0, parentRollupsCreated: 0, error: 'Failed to parse report JSON', durationMs: Date.now() - start }
    }

    const entries = parseTrafficReport(reportData)
    console.log(`[Traffic Sync] Parsed ${entries.length} ASIN entries`)

    if (entries.length === 0) {
      return { asinsSynced: 0, parentRollupsCreated: 0, error: null, durationMs: Date.now() - start }
    }

    // ── 5. Upsert asin_traffic table ────────────────────────────────────
    const now = new Date().toISOString()
    const periodStart = formatDate(startDate)
    const periodEnd = formatDate(endDate)

    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100)
      const rows = chunk.map(e => ({
        child_asin: e.childAsin,
        parent_asin: e.parentAsin || null,
        sku: e.sku || null,
        units_ordered: e.unitsOrdered,
        ordered_revenue: e.orderedRevenue,
        sessions: e.sessions,
        page_views: e.pageViews,
        buy_box_pct: e.buyBoxPct,
        conversion_rate: e.conversionRate,
        browser_sessions: e.browserSessions,
        mobile_app_sessions: e.mobileAppSessions,
        browser_page_views: e.browserPageViews,
        mobile_page_views: e.mobilePageViews,
        report_period_start: periodStart,
        report_period_end: periodEnd,
        last_synced_at: now,
      }))

      const { error } = await supabase
        .from('asin_traffic')
        .upsert(rows, { onConflict: 'child_asin' })

      if (error) {
        console.error(`[Traffic Sync] Upsert error (batch ${i}):`, error.message)
      }
    }

    // ── 6. Compute and upsert parent_asin_rollup ────────────────────────
    const parentMap = new Map<string, {
      children: RawTrafficEntry[]
      totalUnits: number
      totalRevenue: number
      totalSessions: number
      totalPageViews: number
      sumConversion: number
      sumBuyBox: number
      countWithConversion: number
      countWithBuyBox: number
      topChild: string
      topChildUnits: number
    }>()

    for (const entry of entries) {
      const parent = entry.parentAsin || entry.childAsin // self-parent if no parent
      const existing = parentMap.get(parent) || {
        children: [],
        totalUnits: 0,
        totalRevenue: 0,
        totalSessions: 0,
        totalPageViews: 0,
        sumConversion: 0,
        sumBuyBox: 0,
        countWithConversion: 0,
        countWithBuyBox: 0,
        topChild: '',
        topChildUnits: 0,
      }

      existing.children.push(entry)
      existing.totalUnits += entry.unitsOrdered
      existing.totalRevenue += entry.orderedRevenue
      existing.totalSessions += entry.sessions
      existing.totalPageViews += entry.pageViews

      if (entry.conversionRate > 0) {
        existing.sumConversion += entry.conversionRate
        existing.countWithConversion++
      }
      if (entry.buyBoxPct > 0) {
        existing.sumBuyBox += entry.buyBoxPct
        existing.countWithBuyBox++
      }
      if (entry.unitsOrdered > existing.topChildUnits) {
        existing.topChild = entry.childAsin
        existing.topChildUnits = entry.unitsOrdered
      }

      parentMap.set(parent, existing)
    }

    const parentRows = Array.from(parentMap.entries()).map(([parentAsin, data]) => ({
      parent_asin: parentAsin,
      child_count: data.children.length,
      total_units_30d: data.totalUnits,
      total_revenue_30d: data.totalRevenue,
      total_sessions_30d: data.totalSessions,
      total_page_views_30d: data.totalPageViews,
      avg_conversion_rate: data.countWithConversion > 0
        ? parseFloat((data.sumConversion / data.countWithConversion).toFixed(2))
        : 0,
      avg_buy_box_pct: data.countWithBuyBox > 0
        ? parseFloat((data.sumBuyBox / data.countWithBuyBox).toFixed(2))
        : 0,
      top_child_asin: data.topChild || null,
      top_child_units: data.topChildUnits,
      last_synced_at: now,
    }))

    for (let i = 0; i < parentRows.length; i += 100) {
      const chunk = parentRows.slice(i, i + 100)
      const { error } = await supabase
        .from('parent_asin_rollup')
        .upsert(chunk, { onConflict: 'parent_asin' })

      if (error) {
        console.error(`[Traffic Sync] Parent rollup upsert error (batch ${i}):`, error.message)
      }
    }

    // ── 7. Enrich sku_sales_analytics with traffic data ─────────────────
    // Update rows that match by ASIN with the new traffic columns
    for (const entry of entries) {
      if (!entry.childAsin) continue
      const { error } = await supabase
        .from('sku_sales_analytics')
        .update({
          parent_asin: entry.parentAsin || null,
          sessions_30d: entry.sessions,
          page_views_30d: entry.pageViews,
          buy_box_pct: entry.buyBoxPct,
          conversion_rate: entry.conversionRate,
        })
        .eq('asin', entry.childAsin)

      if (error && !error.message.includes('0 rows')) {
        // Silently skip — not all ASINs in traffic report have sku_sales_analytics rows
      }
    }

    // ── 8. Backfill parent_asin into listing_health ─────────────────────
    for (const entry of entries) {
      if (!entry.parentAsin || !entry.childAsin) continue
      await supabase
        .from('listing_health')
        .update({ parent_asin: entry.parentAsin })
        .eq('asin', entry.childAsin)
    }

    console.log(`[Traffic Sync] Complete: ${entries.length} ASINs, ${parentRows.length} parent rollups`)

    return {
      asinsSynced: entries.length,
      parentRollupsCreated: parentRows.length,
      error: null,
      durationMs: Date.now() - start,
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Traffic Sync] Fatal error:', msg)
    return { asinsSynced: 0, parentRollupsCreated: 0, error: msg, durationMs: Date.now() - start }
  }
}

/**
 * Parse the raw Sales & Traffic Report JSON into structured entries.
 * Handles both flat and nested response formats from Amazon.
 */
function parseTrafficReport(data: Record<string, unknown>): RawTrafficEntry[] {
  const entries: RawTrafficEntry[] = []

  // The report can have salesAndTrafficByAsin at the top level or nested
  const byAsin = (
    (data?.salesAndTrafficByAsin as Array<Record<string, unknown>>) ||
    []
  )

  for (const entry of byAsin) {
    const childAsin = (entry.childAsin as string) || ''
    const parentAsin = (entry.parentAsin as string) || ''
    const sku = (entry.sku as string) || ''

    if (!childAsin) continue

    const sales = (entry.salesByAsin || {}) as Record<string, unknown>
    const traffic = (entry.trafficByAsin || {}) as Record<string, unknown>

    entries.push({
      parentAsin,
      childAsin,
      sku,
      unitsOrdered: (sales.unitsOrdered as number) || 0,
      orderedRevenue: parseFloat(String((sales.orderedProductSales as Record<string, unknown>)?.amount || 0)),
      sessions: (traffic.sessions as number) || 0,
      pageViews: (traffic.pageViews as number) || 0,
      buyBoxPct: parseFloat(String(traffic.buyBoxPercentage || 0)),
      conversionRate: parseFloat(String(traffic.unitSessionPercentage || 0)),
      browserSessions: (traffic.browserSessions as number) || 0,
      mobileAppSessions: (traffic.mobileAppSessions as number) || 0,
      browserPageViews: (traffic.browserPageViews as number) || 0,
      mobilePageViews: (traffic.mobileAppPageViews as number) || 0,
    })
  }

  return entries
}
