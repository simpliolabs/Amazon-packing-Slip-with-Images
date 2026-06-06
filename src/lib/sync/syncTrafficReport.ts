/**
 * Traffic & Conversion Intelligence Sync — NON-BLOCKING
 *
 * Fetches GET_SALES_AND_TRAFFIC_REPORT from SP-API (30-day window, CHILD granularity)
 * and writes the results to:
 *   1. asin_traffic — per-child-ASIN traffic/conversion data
 *   2. parent_asin_rollup — pre-computed parent-level aggregates
 *   3. sku_sales_analytics — enriches existing rows with traffic columns
 *   4. listing_health — backfills parent_asin
 *
 * NON-BLOCKING PATTERN (same as syncListings):
 *   - First sync: check for DONE report → if none, request new one → return immediately
 *   - Next sync: check for DONE report → if found, download + parse + write to DB
 *   - No polling. No waiting. Guaranteed to complete within the 55s sync window.
 */
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

export interface TrafficSyncResult {
  asinsSynced: number
  parentRollupsCreated: number
  error: string | null
  pending?: boolean
  durationMs: number
}

interface RawTrafficEntry {
  parentAsin: string
  childAsin: string
  sku: string
  unitsOrdered: number
  orderedRevenue: number
  sessions: number
  pageViews: number
  buyBoxPct: number
  conversionRate: number
  browserSessions: number
  mobileAppSessions: number
  browserPageViews: number
  mobilePageViews: number
}

/**
 * NON-BLOCKING: Get the most recent DONE report document ID.
 * If none exists, request a new one but return immediately.
 */
async function getReportDocumentId(token: string): Promise<{ documentId: string | null; requested: boolean }> {
  // Check for DONE reports in the last 24 hours
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const listUrl =
    `${ENDPOINT}/reports/2021-06-30/reports` +
    `?reportTypes=${REPORT_TYPE}` +
    `&marketplaceIds=${MARKETPLACE_ID}` +
    `&processingStatuses=DONE` +
    `&createdSince=${encodeURIComponent(since24h)}` +
    `&pageSize=1`

  const listResp = await fetch(listUrl, { headers: { 'x-amz-access-token': token } })
  if (listResp.ok) {
    const listJson = await listResp.json()
    const reports: Record<string, string>[] = listJson.reports || []
    if (reports.length > 0 && reports[0].reportDocumentId) {
      console.log(`[Traffic Sync] Using existing DONE report ${reports[0].reportId}`)
      return { documentId: reports[0].reportDocumentId, requested: false }
    }
  }

  // Check for pending reports (IN_QUEUE or IN_PROGRESS)
  const pendingUrl =
    `${ENDPOINT}/reports/2021-06-30/reports` +
    `?reportTypes=${REPORT_TYPE}` +
    `&marketplaceIds=${MARKETPLACE_ID}` +
    `&processingStatuses=IN_QUEUE,IN_PROGRESS` +
    `&pageSize=1`
  const pendingResp = await fetch(pendingUrl, { headers: { 'x-amz-access-token': token } })
  if (pendingResp.ok) {
    const pendingJson = await pendingResp.json()
    const pending: Record<string, string>[] = pendingJson.reports || []
    if (pending.length > 0) {
      console.log(`[Traffic Sync] Report ${pending[0].reportId} still processing — will pick up on next sync`)
      return { documentId: null, requested: true }
    }
  }

  // No DONE or pending reports — request a new one (fire and forget)
  console.log('[Traffic Sync] No recent report — requesting new one (non-blocking)')
  const endDate = new Date()
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const formatDate = (d: Date) => d.toISOString().split('T')[0]

  const reqResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reportType: REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_ID],
      reportOptions: {
        dateGranularity: 'MONTH',
        asinGranularity: 'CHILD',
      },
      dataStartTime: `${formatDate(startDate)}T00:00:00Z`,
      dataEndTime: `${formatDate(endDate)}T23:59:59Z`,
    }),
  })

  if (reqResp.ok) {
    const { reportId } = await reqResp.json()
    console.log(`[Traffic Sync] Requested report ${reportId} — will be ready on next sync`)
  } else {
    const errBody = await reqResp.text()
    console.warn(`[Traffic Sync] Failed to request report (${reqResp.status}):`, errBody)
  }

  return { documentId: null, requested: true }
}

/**
 * Download and optionally decompress the report document.
 */
async function downloadReport(documentId: string, token: string): Promise<string | null> {
  console.log(`[Traffic Sync] Fetching document metadata for ${documentId}`)
  const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${documentId}`, {
    headers: { 'x-amz-access-token': token },
  })
  if (!docResp.ok) {
    console.error(`[Traffic Sync] Document metadata fetch failed: ${docResp.status}`)
    return null
  }
  const docJson = await docResp.json()
  const { url, compressionAlgorithm } = docJson
  if (!url) {
    console.error('[Traffic Sync] No URL in document response')
    return null
  }

  console.log(`[Traffic Sync] Downloading report (compression: ${compressionAlgorithm || 'none'})`)
  const dataResp = await fetch(url)
  if (!dataResp.ok) {
    console.error(`[Traffic Sync] Report download failed: ${dataResp.status}`)
    return null
  }

  if (compressionAlgorithm === 'GZIP') {
    const buffer = Buffer.from(await dataResp.arrayBuffer())
    const decompressed = gunzipSync(buffer).toString('utf-8')
    console.log(`[Traffic Sync] Decompressed ${buffer.length} bytes -> ${decompressed.length} chars`)
    return decompressed
  }

  return await dataResp.text()
}

/**
 * Main entry point: NON-BLOCKING fetch, parse, and persist traffic intelligence.
 */
export async function syncTrafficReport(): Promise<TrafficSyncResult> {
  const start = Date.now()
  const supabase = getAdminSupabase()

  try {
    const token = await getAccessToken()
    const { documentId, requested } = await getReportDocumentId(token)

    if (!documentId) {
      if (requested) {
        console.log('[Traffic Sync] Report requested/pending — will process on next sync')
        return { asinsSynced: 0, parentRollupsCreated: 0, error: null, pending: true, durationMs: Date.now() - start }
      }
      return { asinsSynced: 0, parentRollupsCreated: 0, error: 'Could not obtain report document ID', durationMs: Date.now() - start }
    }

    const rawText = await downloadReport(documentId, token)
    if (!rawText) {
      // Download failed (likely expired URL) — request a fresh report
      console.log('[Traffic Sync] Download failed — requesting fresh report')
      const reqResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
        method: 'POST',
        headers: {
          'x-amz-access-token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reportType: REPORT_TYPE,
          marketplaceIds: [MARKETPLACE_ID],
          reportOptions: {
            dateGranularity: 'MONTH',
            asinGranularity: 'CHILD',
          },
          dataStartTime: `${new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}T00:00:00Z`,
          dataEndTime: `${new Date().toISOString().split('T')[0]}T23:59:59Z`,
        }),
      })
      if (reqResp.ok) {
        const { reportId } = await reqResp.json()
        console.log(`[Traffic Sync] Requested fresh report ${reportId}`)
      }
      return { asinsSynced: 0, parentRollupsCreated: 0, error: null, pending: true, durationMs: Date.now() - start }
    }

    console.log(`[Traffic Sync] Downloaded ${rawText.length} bytes`)

    // ── Parse the JSON report ────────────────────────────────────────────
    let reportData: Record<string, unknown>
    try {
      reportData = JSON.parse(rawText)
    } catch {
      console.error('[Traffic Sync] Failed to parse report JSON. First 500 chars:', rawText.slice(0, 500))
      return { asinsSynced: 0, parentRollupsCreated: 0, error: 'Failed to parse report JSON', durationMs: Date.now() - start }
    }

    // Log top-level keys for debugging
    console.log(`[Traffic Sync] Report top-level keys: ${Object.keys(reportData).join(', ')}`)

    const entries = parseTrafficReport(reportData)
    console.log(`[Traffic Sync] Parsed ${entries.length} ASIN entries`)

    if (entries.length === 0) {
      // Log a sample of the data for debugging
      const sample = JSON.stringify(reportData).slice(0, 1000)
      console.warn(`[Traffic Sync] 0 entries parsed. Report sample: ${sample}`)
      return { asinsSynced: 0, parentRollupsCreated: 0, error: null, durationMs: Date.now() - start }
    }

    // ── Upsert asin_traffic table ────────────────────────────────────────
    const now = new Date().toISOString()
    const endDate = new Date()
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const formatDate = (d: Date) => d.toISOString().split('T')[0]
    const periodStart = formatDate(startDate)
    const periodEnd = formatDate(endDate)

    let asinsSynced = 0
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

      const { data: upsertData, error } = await supabase
        .from('asin_traffic')
        .upsert(rows, { onConflict: 'child_asin' })
        .select('child_asin')

      if (error) {
        console.error(`[Traffic Sync] asin_traffic upsert error (batch ${i}):`, error.message, JSON.stringify(error))
        // Try individual inserts as fallback
        for (const row of rows) {
          const { error: singleErr } = await supabase
            .from('asin_traffic')
            .upsert([row], { onConflict: 'child_asin' })
            .select('child_asin')
          if (singleErr) {
            console.error(`[Traffic Sync] Single upsert failed for ${row.child_asin}:`, singleErr.message)
          } else {
            asinsSynced++
          }
        }
      } else {
        asinsSynced += upsertData?.length || chunk.length
        console.log(`[Traffic Sync] Batch ${i}: upserted ${upsertData?.length || chunk.length} rows`)
      }
    }

    // ── Compute and upsert parent_asin_rollup ────────────────────────────
    // PR #85: load the AUTHORITATIVE child→parent map first. The variation parent from
    // the Catalog API (stored in listing_health.parent_asin by syncParentAsins) is more
    // reliable than the Sales-&-Traffic report's own parentAsin field, which is often
    // blank for variation children mid-resolution. Without this, the line below fell back
    // to `entry.childAsin` and a CHILD became its own rollup parent → the dashboard
    // rendered child ASINs as listing-optimizer cards (live-verified: B0B4STMBS7, a 32GB
    // child, showed as a card because its parent B0GCF11RKL wasn't on the traffic row).
    const knownChildToParent = new Map<string, string>()
    const knownChildAsins = new Set<string>()
    try {
      const { data: lhRows } = await supabase
        .from('listing_health')
        .select('asin, parent_asin')
        .not('parent_asin', 'is', null)
      for (const r of (lhRows ?? []) as { asin: string; parent_asin: string }[]) {
        if (r.asin && r.parent_asin && r.parent_asin !== r.asin) {
          knownChildToParent.set(r.asin, r.parent_asin)
          knownChildAsins.add(r.asin)
        }
      }
    } catch (e) {
      console.warn('[Traffic Sync] could not load child→parent map (rollup may self-parent children):', e instanceof Error ? e.message : e)
    }

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
      // Precedence (PR #85): authoritative Catalog map > traffic-report field > self.
      // Only self-parent when the ASIN is NOT a known child — that's a genuine standalone
      // product (single SKU, no variation family), which legitimately is its own parent.
      const parent = knownChildToParent.get(entry.childAsin)
        || (entry.parentAsin && entry.parentAsin !== entry.childAsin ? entry.parentAsin : '')
        || (knownChildAsins.has(entry.childAsin) ? '' : entry.childAsin)
      if (!parent) continue // known child with no resolved parent yet — don't self-parent it
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

    let parentRollupsCreated = 0
    for (let i = 0; i < parentRows.length; i += 100) {
      const chunk = parentRows.slice(i, i + 100)
      const { error } = await supabase
        .from('parent_asin_rollup')
        .upsert(chunk, { onConflict: 'parent_asin' })

      if (error) {
        console.error(`[Traffic Sync] parent_asin_rollup upsert error (batch ${i}):`, error.message)
      } else {
        parentRollupsCreated += chunk.length
      }
    }

    // ── CLEANUP (PR #85): delete already-corrupted self-parented child rows ──
    // Prior syncs (before this fix) wrote child ASINs into parent_asin_rollup as their own
    // parent. Those stale rows keep rendering as dashboard cards until overwritten. Now
    // that we know which ASINs are children, delete any rollup row keyed on a known child.
    // The legitimate parent already has (or just got) its own correct row above, so the
    // dashboard self-heals on the next load — no need to wait for a clean full re-sync.
    if (knownChildAsins.size > 0) {
      const childList = [...knownChildAsins]
      let deleted = 0
      for (let i = 0; i < childList.length; i += 100) {
        const chunk = childList.slice(i, i + 100)
        const { error: delErr, count } = await supabase
          .from('parent_asin_rollup')
          .delete({ count: 'exact' })
          .in('parent_asin', chunk)
        if (delErr) console.warn('[Traffic Sync] rollup cleanup delete error:', delErr.message)
        else deleted += count ?? 0
      }
      if (deleted > 0) console.log(`[Traffic Sync] Cleaned up ${deleted} self-parented child rows from parent_asin_rollup`)
    }

    // ── Enrich sku_sales_analytics with traffic data ─────────────────────
    for (const entry of entries) {
      if (!entry.childAsin) continue
      const { error } = await supabase
        .from('sku_sales_analytics')
        .update({
          sessions_30d: entry.sessions,
          page_views_30d: entry.pageViews,
          conversion_rate: entry.conversionRate,
          buy_box_pct: entry.buyBoxPct,
        })
        .eq('asin', entry.childAsin)

      if (error && !error.message.includes('0 rows')) {
        // Ignore "no rows matched" — not all traffic ASINs are in sku_sales_analytics
      }
    }

    // ── Backfill parent_asin into listing_health ─────────────────────────
    for (const entry of entries) {
      if (!entry.parentAsin || !entry.childAsin) continue
      await supabase
        .from('listing_health')
        .update({ parent_asin: entry.parentAsin })
        .eq('asin', entry.childAsin)
    }

    console.log(`[Traffic Sync] Complete: ${asinsSynced} ASINs, ${parentRollupsCreated} parent rollups`)
    return { asinsSynced, parentRollupsCreated, error: null, durationMs: Date.now() - start }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Traffic Sync] Fatal error:', msg)
    return { asinsSynced: 0, parentRollupsCreated: 0, error: msg, durationMs: Date.now() - start }
  }
}

/**
 * Parse the raw Sales & Traffic Report JSON into structured entries.
 * Handles multiple possible response formats from Amazon:
 *   - Direct: { salesAndTrafficByAsin: [...] }
 *   - Nested: { reportData: { salesAndTrafficByAsin: [...] } }
 *   - Array wrapper: [{ salesAndTrafficByAsin: [...] }]
 */
function parseTrafficReport(data: Record<string, unknown>): RawTrafficEntry[] {
  const entries: RawTrafficEntry[] = []

  // Try multiple paths to find the salesAndTrafficByAsin array
  let byAsin: Array<Record<string, unknown>> | null = null

  // Path 1: Direct top-level (per official schema)
  if (Array.isArray(data?.salesAndTrafficByAsin)) {
    byAsin = data.salesAndTrafficByAsin as Array<Record<string, unknown>>
    console.log(`[Traffic Sync] Found salesAndTrafficByAsin at top level (${byAsin.length} entries)`)
  }

  // Path 2: Nested under reportData
  if (!byAsin && data?.reportData && typeof data.reportData === 'object') {
    const rd = data.reportData as Record<string, unknown>
    if (Array.isArray(rd.salesAndTrafficByAsin)) {
      byAsin = rd.salesAndTrafficByAsin as Array<Record<string, unknown>>
      console.log(`[Traffic Sync] Found salesAndTrafficByAsin under reportData (${byAsin.length} entries)`)
    }
  }

  // Path 3: Array wrapper
  if (!byAsin && Array.isArray(data)) {
    const first = (data as unknown[])[0] as Record<string, unknown> | undefined
    if (first && Array.isArray(first.salesAndTrafficByAsin)) {
      byAsin = first.salesAndTrafficByAsin as Array<Record<string, unknown>>
      console.log(`[Traffic Sync] Found salesAndTrafficByAsin in array wrapper (${byAsin.length} entries)`)
    }
  }

  if (!byAsin) {
    console.warn('[Traffic Sync] Could not find salesAndTrafficByAsin in report. Keys found:', Object.keys(data))
    return entries
  }

  for (const entry of byAsin) {
    const childAsin = (entry.childAsin as string) || ''
    const parentAsin = (entry.parentAsin as string) || ''
    const sku = (entry.sku as string) || ''

    if (!childAsin) continue

    const sales = (entry.salesByAsin || {}) as Record<string, unknown>
    const traffic = (entry.trafficByAsin || {}) as Record<string, unknown>

    // orderedProductSales can be { amount: number, currencyCode: string } or just a number
    let orderedRevenue = 0
    const ops = sales.orderedProductSales
    if (typeof ops === 'number') {
      orderedRevenue = ops
    } else if (ops && typeof ops === 'object') {
      orderedRevenue = parseFloat(String((ops as Record<string, unknown>).amount || 0))
    }

    entries.push({
      parentAsin,
      childAsin,
      sku,
      unitsOrdered: (sales.unitsOrdered as number) || 0,
      orderedRevenue,
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
