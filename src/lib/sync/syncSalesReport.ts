/**
 * syncSalesReport.ts
 *
 * Fetches the GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL report from SP-API,
 * parses the TSV, aggregates sales velocity per SKU (7d / 30d / 90d), and upserts
 * into the sku_sales_analytics table.
 *
 * IMPORTANT: Amazon limits this report type to a maximum 30-day date range per request.
 * To get accurate 90-day data, we request THREE reports covering:
 *   - Last 30 days (days 0–30)
 *   - Days 30–60
 *   - Days 60–90
 * Each report is requested/processed independently. The aggregation combines all
 * available data into the correct 7d/30d/90d buckets.
 *
 * NON-BLOCKING: If reports are still generating, returns immediately.
 * On the next sync call, completed reports will be picked up and processed.
 */
import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'
import { gunzipSync } from 'zlib'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
const REPORT_TYPE = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface OrderRow {
  'amazon-order-id': string
  'purchase-date': string
  'order-status': string
  'fulfillment-channel': string
  'product-name': string
  sku: string
  asin: string
  quantity: string
  'item-price': string
}

/**
 * Request a fresh All Orders report for a specific date range.
 * Amazon limits this report to max 30 days per request.
 */
async function requestOrdersReport(token: string, startDate: Date, endDate: Date): Promise<string | null> {
  const resp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportType: REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_ID],
      dataStartTime: startDate.toISOString(),
      dataEndTime: endDate.toISOString(),
    }),
  })
  if (!resp.ok) {
    console.warn(`[SalesReport] Failed to request report: ${resp.status}`)
    return null
  }
  const json = await resp.json()
  return json.reportId || null
}

/**
 * Find the most recent DONE report created after a given time.
 * Returns the document ID or null.
 */
async function findDoneReport(token: string, createdSince: Date): Promise<string | null> {
  const listUrl =
    `${ENDPOINT}/reports/2021-06-30/reports` +
    `?reportTypes=${REPORT_TYPE}` +
    `&marketplaceIds=${MARKETPLACE_ID}` +
    `&processingStatuses=DONE` +
    `&createdSince=${encodeURIComponent(createdSince.toISOString())}` +
    `&pageSize=10`
  const listResp = await fetch(listUrl, { headers: { 'x-amz-access-token': token } })
  if (!listResp.ok) return null
  const listJson = await listResp.json()
  const reports: Record<string, string>[] = listJson.reports || []
  // Return the most recent one
  if (reports.length > 0 && reports[0].reportDocumentId) {
    return reports[0].reportDocumentId
  }
  return null
}

/**
 * Check if there's a pending (IN_QUEUE or IN_PROGRESS) report.
 */
async function hasPendingReport(token: string): Promise<boolean> {
  const pendingUrl =
    `${ENDPOINT}/reports/2021-06-30/reports` +
    `?reportTypes=${REPORT_TYPE}` +
    `&marketplaceIds=${MARKETPLACE_ID}` +
    `&processingStatuses=IN_QUEUE,IN_PROGRESS` +
    `&pageSize=1`
  const pendingResp = await fetch(pendingUrl, { headers: { 'x-amz-access-token': token } })
  if (!pendingResp.ok) return false
  const pendingJson = await pendingResp.json()
  const pending: Record<string, string>[] = pendingJson.reports || []
  return pending.length > 0
}

/**
 * Download and decompress the report document.
 */
async function downloadReport(documentId: string, token: string): Promise<string | null> {
  const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${documentId}`, {
    headers: { 'x-amz-access-token': token },
  })
  if (!docResp.ok) return null
  const { url, compressionAlgorithm } = await docResp.json()
  if (!url) return null
  const dataResp = await fetch(url)
  if (!dataResp.ok) return null
  if (compressionAlgorithm === 'GZIP') {
    const buffer = Buffer.from(await dataResp.arrayBuffer())
    return gunzipSync(buffer).toString('utf-8')
  }
  return await dataResp.text()
}

/**
 * Parse the TSV flat file into an array of order rows.
 */
function parseTSV(tsv: string): OrderRow[] {
  const lines = tsv.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split('\t').map(h => h.trim())
  const rows: OrderRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim() })
    rows.push(row as unknown as OrderRow)
  }
  return rows
}

/**
 * Aggregate orders into per-SKU sales analytics.
 * Uses the actual purchase dates to bucket into 7d/30d/90d windows.
 */
function aggregateOrders(rows: OrderRow[]): Map<string, {
  sku: string
  asin: string
  productName: string
  fulfillmentChannel: string
  units7d: number
  units30d: number
  units90d: number
  revenue30d: number
  lastOrderDate: Date | null
}> {
  const now = Date.now()
  const cutoff7d  = now - 7  * 24 * 60 * 60 * 1000
  const cutoff30d = now - 30 * 24 * 60 * 60 * 1000
  const cutoff90d = now - 90 * 24 * 60 * 60 * 1000

  const map = new Map<string, {
    sku: string
    asin: string
    productName: string
    fulfillmentChannel: string
    units7d: number
    units30d: number
    units90d: number
    revenue30d: number
    lastOrderDate: Date | null
  }>()

  for (const row of rows) {
    const sku = row.sku
    if (!sku || sku === '-') continue
    // Only count Shipped / Unshipped (not Cancelled / Pending)
    const status = (row['order-status'] || '').toLowerCase()
    if (status === 'cancelled' || status === 'pending') continue

    const purchaseDate = new Date(row['purchase-date'])
    if (isNaN(purchaseDate.getTime())) continue
    const ts = purchaseDate.getTime()
    if (ts < cutoff90d) continue

    const qty = parseInt(row.quantity || '1', 10) || 1
    const price = parseFloat(row['item-price'] || '0') || 0

    if (!map.has(sku)) {
      map.set(sku, {
        sku,
        asin: row.asin || '',
        productName: row['product-name'] || '',
        fulfillmentChannel: row['fulfillment-channel'] || '',
        units7d: 0,
        units30d: 0,
        units90d: 0,
        revenue30d: 0,
        lastOrderDate: null,
      })
    }
    const entry = map.get(sku)!
    entry.units90d += qty
    if (ts >= cutoff30d) {
      entry.units30d += qty
      entry.revenue30d += price
    }
    if (ts >= cutoff7d) entry.units7d += qty
    if (!entry.lastOrderDate || purchaseDate > entry.lastOrderDate) {
      entry.lastOrderDate = purchaseDate
    }
    // Keep most recent product name / channel
    if (row['product-name']) entry.productName = row['product-name']
    if (row['fulfillment-channel']) entry.fulfillmentChannel = row['fulfillment-channel']
  }

  return map
}

/**
 * Main export — fetch All Orders reports covering the full 90-day window and upsert sku_sales_analytics.
 *
 * Strategy: Amazon limits reports to 30 days max. We need 3 reports:
 *   Report A: days 0–30 (most recent)
 *   Report B: days 30–60
 *   Report C: days 60–90
 *
 * On each sync call:
 *   1. Try to find/download all 3 DONE reports from the last 6 hours
 *   2. If any are missing, request them (non-blocking)
 *   3. Process whatever reports are available — even partial data is better than stale data
 *   4. Combine all order rows and aggregate into 7d/30d/90d buckets
 *
 * NON-BLOCKING: returns immediately if reports are still generating.
 */
export async function syncSalesReport(force = false): Promise<{ synced: number; error: string | null; pending?: boolean }> {
  console.log(`[SalesReport] Starting sync (3-window strategy for full 90-day coverage)${force ? ' [FORCE]' : ''}`)
  try {
    const token = await getAccessToken()
    const now = new Date()

    // Define the 3 date windows (each ≤ 30 days)
    const windows = [
      { label: '0-30d',  start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now },
      { label: '30-60d', start: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000), end: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
      { label: '60-90d', start: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), end: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000) },
    ]

    // When force=true, skip cached reports and always request fresh ones
    // Otherwise try to find DONE reports from the last 6 hours
    const lookbackTime = force
      ? new Date(now.getTime() - 5 * 60 * 1000)  // only look back 5 min — effectively forces new requests
      : new Date(now.getTime() - 6 * 60 * 60 * 1000)
    const documentId = await findDoneReport(token, lookbackTime)

    // If we have at least one DONE report, download and process it
    // For the multi-window approach, we'll request all 3 but process whatever is available
    let allOrderRows: OrderRow[] = []
    let anyPending = false
    let reportsProcessed = 0

    if (documentId) {
      // Download the most recent report (covers the most recent 30-day window)
      const tsv = await downloadReport(documentId, token)
      if (tsv) {
        const rows = parseTSV(tsv)
        console.log(`[SalesReport] Downloaded report with ${rows.length} order rows`)
        allOrderRows.push(...rows)
        reportsProcessed++
      }
    }

    // Check for additional DONE reports (Amazon keeps multiple)
    // We search for all DONE reports in the last 24 hours to find the 30-60d and 60-90d reports
    const lookback24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const allReportsUrl =
      `${ENDPOINT}/reports/2021-06-30/reports` +
      `?reportTypes=${REPORT_TYPE}` +
      `&marketplaceIds=${MARKETPLACE_ID}` +
      `&processingStatuses=DONE` +
      `&createdSince=${encodeURIComponent(lookback24h.toISOString())}` +
      `&pageSize=10`
    const allReportsResp = await fetch(allReportsUrl, { headers: { 'x-amz-access-token': token } })
    if (allReportsResp.ok) {
      const allReportsJson = await allReportsResp.json()
      const doneReports: Record<string, string>[] = allReportsJson.reports || []
      
      // Download all available DONE reports (skip the first one if already downloaded)
      for (const report of doneReports) {
        if (report.reportDocumentId && report.reportDocumentId !== documentId) {
          const tsv = await downloadReport(report.reportDocumentId, token)
          if (tsv) {
            const rows = parseTSV(tsv)
            console.log(`[SalesReport] Additional report ${report.reportId}: ${rows.length} rows`)
            allOrderRows.push(...rows)
            reportsProcessed++
          }
        }
      }
    }

    // If we got fewer than 3 reports, request the missing windows
    if (reportsProcessed < 3) {
      // Check if there's already a pending report
      const pending = await hasPendingReport(token)
      if (!pending) {
        // Request reports for all 3 windows (Amazon will process them)
        // We request the oldest window first since the recent one likely already exists
        for (const window of windows.reverse()) {
          const reportId = await requestOrdersReport(token, window.start, window.end)
          if (reportId) {
            console.log(`[SalesReport] Requested report for ${window.label} (ID: ${reportId})`)
          }
          // Small delay to avoid throttling
          await new Promise(r => setTimeout(r, 500))
        }
        anyPending = true
      } else {
        console.log('[SalesReport] Reports still pending — will pick up on next sync')
        anyPending = true
      }
    }

    // If we have no data at all, return pending
    if (allOrderRows.length === 0) {
      if (anyPending) {
        return { synced: 0, error: null, pending: true }
      }
      return { synced: 0, error: 'No report data available' }
    }

    // Deduplicate orders by order-id + sku (in case reports overlap)
    const seen = new Set<string>()
    const dedupedRows: OrderRow[] = []
    for (const row of allOrderRows) {
      const key = `${row['amazon-order-id']}|${row.sku}|${row.quantity}`
      if (!seen.has(key)) {
        seen.add(key)
        dedupedRows.push(row)
      }
    }
    console.log(`[SalesReport] After dedup: ${dedupedRows.length} unique order rows (from ${allOrderRows.length} total)`)

    // Aggregate into per-SKU analytics
    const aggregated = aggregateOrders(dedupedRows)
    console.log(`[SalesReport] Aggregated ${aggregated.size} unique SKUs`)

    const supabase = getAdminSupabase()
    const syncTime = new Date().toISOString()
    let synced = 0

    // Batch upsert in chunks of 50 for performance
    const entries = Array.from(aggregated.values())
    const BATCH_SIZE = 50
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE).map(entry => ({
        sku:                  entry.sku,
        asin:                 entry.asin || null,
        product_name:         entry.productName || null,
        units_sold_7d:        entry.units7d,
        units_sold_30d:       entry.units30d,
        units_sold_90d:       entry.units90d,
        revenue_30d:          +entry.revenue30d.toFixed(2),
        avg_daily_units:      entry.units30d > 0 ? +(entry.units30d / 30).toFixed(4) : 0,
        fulfillment_channel:  entry.fulfillmentChannel || null,
        last_order_date:      entry.lastOrderDate?.toISOString() || null,
        last_synced_at:       syncTime,
      }))

      const { error } = await supabase
        .from('sku_sales_analytics')
        .upsert(batch, { onConflict: 'sku' })

      if (error) {
        console.warn(`[SalesReport] Batch upsert error (offset ${i}): ${error.message}`)
      } else {
        synced += batch.length
      }
    }

    console.log(`[SalesReport] Synced ${synced} SKUs (${reportsProcessed} reports processed)`)
    return { synced, error: null, pending: anyPending }
  } catch (err) {
    const msg = String(err)
    console.error('[SalesReport] Fatal error:', msg)
    return { synced: 0, error: msg }
  }
}
