/**
 * DEBUG ENDPOINT: Runs the traffic sync and returns detailed diagnostics.
 * This is temporary — remove after fixing the traffic sync issue.
 * GET /api/fba/debug-traffic
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'
import { gunzipSync } from 'zlib'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
const REPORT_TYPE = 'GET_SALES_AND_TRAFFIC_REPORT'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET() {
  const log: string[] = []
  const addLog = (msg: string) => { log.push(`[${new Date().toISOString()}] ${msg}`) }

  try {
    addLog('Starting traffic sync debug')
    const token = await getAccessToken()
    addLog(`Got access token (${token.slice(0, 10)}...)`)

    // Step 1: Check for DONE reports
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const listUrl =
      `${ENDPOINT}/reports/2021-06-30/reports` +
      `?reportTypes=${REPORT_TYPE}` +
      `&marketplaceIds=${MARKETPLACE_ID}` +
      `&processingStatuses=DONE` +
      `&createdSince=${encodeURIComponent(since24h)}` +
      `&pageSize=5`

    const listResp = await fetch(listUrl, { headers: { 'x-amz-access-token': token } })
    const listJson = await listResp.json()
    addLog(`DONE reports response (${listResp.status}): ${JSON.stringify(listJson).slice(0, 500)}`)

    const reports = listJson.reports || []
    if (reports.length === 0) {
      // Check pending
      const pendingUrl =
        `${ENDPOINT}/reports/2021-06-30/reports` +
        `?reportTypes=${REPORT_TYPE}` +
        `&marketplaceIds=${MARKETPLACE_ID}` +
        `&processingStatuses=IN_QUEUE,IN_PROGRESS` +
        `&pageSize=5`
      const pendingResp = await fetch(pendingUrl, { headers: { 'x-amz-access-token': token } })
      const pendingJson = await pendingResp.json()
      addLog(`Pending reports: ${JSON.stringify(pendingJson).slice(0, 500)}`)

      // Request a new report
      const endDate = new Date()
      const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const formatDate = (d: Date) => d.toISOString().split('T')[0]

      const reqResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
        method: 'POST',
        headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reportType: REPORT_TYPE,
          marketplaceIds: [MARKETPLACE_ID],
          reportOptions: { dateGranularity: 'MONTH', asinGranularity: 'CHILD' },
          dataStartTime: `${formatDate(startDate)}T00:00:00Z`,
          dataEndTime: `${formatDate(endDate)}T23:59:59Z`,
        }),
      })
      const reqJson = await reqResp.json()
      addLog(`Requested new report (${reqResp.status}): ${JSON.stringify(reqJson)}`)

      return NextResponse.json({ status: 'no_done_report', log })
    }

    // Step 2: Download the report
    const reportDocId = reports[0].reportDocumentId
    addLog(`Using report document: ${reportDocId}`)

    const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${reportDocId}`, {
      headers: { 'x-amz-access-token': token },
    })
    const docJson = await docResp.json()
    addLog(`Document metadata (${docResp.status}): url=${docJson.url ? 'present' : 'MISSING'}, compression=${docJson.compressionAlgorithm || 'none'}`)

    if (!docJson.url) {
      return NextResponse.json({ status: 'no_url', docJson, log })
    }

    const dataResp = await fetch(docJson.url)
    let rawText: string
    if (docJson.compressionAlgorithm === 'GZIP') {
      const buffer = Buffer.from(await dataResp.arrayBuffer())
      rawText = gunzipSync(buffer).toString('utf-8')
      addLog(`Decompressed: ${buffer.length} -> ${rawText.length} chars`)
    } else {
      rawText = await dataResp.text()
      addLog(`Raw text: ${rawText.length} chars`)
    }

    // Step 3: Parse the JSON
    let reportData: Record<string, unknown>
    try {
      reportData = JSON.parse(rawText)
    } catch {
      addLog(`JSON parse failed. First 500 chars: ${rawText.slice(0, 500)}`)
      return NextResponse.json({ status: 'parse_error', sample: rawText.slice(0, 1000), log })
    }

    const topKeys = Object.keys(reportData)
    addLog(`Top-level keys: ${topKeys.join(', ')}`)

    // Try to find salesAndTrafficByAsin
    let byAsin: unknown[] | null = null
    if (Array.isArray(reportData.salesAndTrafficByAsin)) {
      byAsin = reportData.salesAndTrafficByAsin
      addLog(`Found at top level: ${byAsin.length} entries`)
    } else if (reportData.reportData && typeof reportData.reportData === 'object') {
      const rd = reportData.reportData as Record<string, unknown>
      if (Array.isArray(rd.salesAndTrafficByAsin)) {
        byAsin = rd.salesAndTrafficByAsin
        addLog(`Found under reportData: ${byAsin.length} entries`)
      }
    }

    if (!byAsin) {
      // Log all keys at every level
      const deepKeys: Record<string, string[]> = {}
      for (const [k, v] of Object.entries(reportData)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          deepKeys[k] = Object.keys(v as Record<string, unknown>)
        } else if (Array.isArray(v)) {
          deepKeys[k] = [`Array(${v.length})`]
          if (v.length > 0 && typeof v[0] === 'object') {
            deepKeys[`${k}[0]`] = Object.keys(v[0] as Record<string, unknown>)
          }
        }
      }
      addLog(`Deep keys: ${JSON.stringify(deepKeys)}`)
      return NextResponse.json({ status: 'no_asin_data', topKeys, deepKeys, sample: JSON.stringify(reportData).slice(0, 2000), log })
    }

    // Step 4: Show first entry structure
    const firstEntry = byAsin[0] as Record<string, unknown>
    addLog(`First entry keys: ${Object.keys(firstEntry).join(', ')}`)
    addLog(`First entry sample: ${JSON.stringify(firstEntry).slice(0, 500)}`)

    // Step 5: Try a single upsert
    const supabase = getAdminSupabase()
    const testRow = {
      child_asin: (firstEntry.childAsin as string) || 'UNKNOWN',
      parent_asin: (firstEntry.parentAsin as string) || null,
      sku: (firstEntry.sku as string) || null,
      units_ordered: 0,
      ordered_revenue: 0,
      sessions: 0,
      page_views: 0,
      buy_box_pct: 0,
      conversion_rate: 0,
      browser_sessions: 0,
      mobile_app_sessions: 0,
      browser_page_views: 0,
      mobile_page_views: 0,
      report_period_start: '2026-04-14',
      report_period_end: '2026-05-14',
      last_synced_at: new Date().toISOString(),
    }
    addLog(`Test row: ${JSON.stringify(testRow)}`)

    const { data: upsertData, error: upsertError } = await supabase
      .from('asin_traffic')
      .upsert([testRow], { onConflict: 'child_asin' })
      .select()

    if (upsertError) {
      addLog(`UPSERT ERROR: ${JSON.stringify(upsertError)}`)
    } else {
      addLog(`UPSERT SUCCESS: ${JSON.stringify(upsertData)}`)
    }

    // Now do the FULL sync — write all entries to asin_traffic
    addLog(`Starting full sync of ${byAsin.length} entries`)
    let totalSynced = 0
    const errors: string[] = []

    for (const rawEntry of byAsin) {
      const entry = rawEntry as Record<string, unknown>
      const childAsin = (entry.childAsin as string) || ''
      const parentAsin = (entry.parentAsin as string) || ''
      if (!childAsin) continue

      const sales = (entry.salesByAsin || {}) as Record<string, unknown>
      const traffic = (entry.trafficByAsin || {}) as Record<string, unknown>

      let orderedRevenue = 0
      const ops = sales.orderedProductSales
      if (typeof ops === 'number') orderedRevenue = ops
      else if (ops && typeof ops === 'object') orderedRevenue = parseFloat(String((ops as Record<string, unknown>).amount || 0))

      const row = {
        child_asin: childAsin,
        parent_asin: parentAsin || null,
        sku: (entry.sku as string) || null,
        units_ordered: (sales.unitsOrdered as number) || 0,
        ordered_revenue: orderedRevenue,
        sessions: (traffic.sessions as number) || 0,
        page_views: (traffic.pageViews as number) || 0,
        buy_box_pct: parseFloat(String(traffic.buyBoxPercentage || 0)),
        conversion_rate: parseFloat(String(traffic.unitSessionPercentage || 0)),
        browser_sessions: (traffic.browserSessions as number) || 0,
        mobile_app_sessions: (traffic.mobileAppSessions as number) || 0,
        browser_page_views: (traffic.browserPageViews as number) || 0,
        mobile_page_views: (traffic.mobileAppPageViews as number) || 0,
        report_period_start: '2026-04-14',
        report_period_end: '2026-05-14',
        last_synced_at: new Date().toISOString(),
      }

      const { error: rowErr } = await supabase
        .from('asin_traffic')
        .upsert([row], { onConflict: 'child_asin' })
        .select('child_asin')

      if (rowErr) {
        errors.push(`${childAsin}: ${rowErr.message}`)
      } else {
        totalSynced++
      }

      // Also backfill parent_asin into listing_health
      if (parentAsin) {
        await supabase.from('listing_health').update({ parent_asin: parentAsin }).eq('asin', childAsin)
      }
    }

    addLog(`Full sync complete: ${totalSynced} synced, ${errors.length} errors`)
    if (errors.length > 0) addLog(`Errors: ${errors.slice(0, 5).join('; ')}`)

    return NextResponse.json({
      status: 'full_sync_complete',
      reportEntries: byAsin.length,
      totalSynced,
      errors: errors.slice(0, 10),
      firstEntryKeys: Object.keys(firstEntry),
      upsertTestError: upsertError ? JSON.stringify(upsertError) : null,
      log,
    })

  } catch (err) {
    addLog(`FATAL: ${err instanceof Error ? err.message : String(err)}`)
    return NextResponse.json({ status: 'error', error: String(err), log })
  }
}
