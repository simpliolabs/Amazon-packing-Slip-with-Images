/**
 * syncSalesReport.ts
 *
 * Fetches the GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL report from SP-API,
 * parses the TSV, aggregates sales velocity per SKU (7d / 30d / 90d), and upserts
 * into the sku_sales_analytics table.
 *
 * NON-BLOCKING: If no DONE report exists, requests one and returns immediately.
 * On the next sync call, the DONE report will be picked up and processed.
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
 * Request a fresh All Orders report covering the last 90 days.
 * Returns the report ID (fire-and-forget).
 */
async function requestOrdersReport(token: string): Promise<string | null> {
  const dataStartTime = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const dataEndTime = new Date().toISOString()
  const resp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reportType: REPORT_TYPE,
      marketplaceIds: [MARKETPLACE_ID],
      dataStartTime,
      dataEndTime,
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
 * NON-BLOCKING: Find the most recent DONE report. If none exists, request a new one
 * but return null immediately (don't poll). The next sync will pick it up.
 */
async function getReportDocumentId(token: string): Promise<{ documentId: string | null; requested: boolean }> {
  // Check for an existing DONE report in the last 7 days (recent enough to be useful)
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const listUrl =
    `${ENDPOINT}/reports/2021-06-30/reports` +
    `?reportTypes=${REPORT_TYPE}` +
    `&marketplaceIds=${MARKETPLACE_ID}` +
    `&processingStatuses=DONE` +
    `&createdSince=${encodeURIComponent(since7d)}` +
    `&pageSize=1`
  const listResp = await fetch(listUrl, { headers: { 'x-amz-access-token': token } })
  if (listResp.ok) {
    const listJson = await listResp.json()
    const reports: Record<string, string>[] = listJson.reports || []
    if (reports.length > 0 && reports[0].reportDocumentId) {
      console.log(`[SalesReport] Using existing DONE report ${reports[0].reportId}`)
      return { documentId: reports[0].reportDocumentId, requested: false }
    }
  }

  // Also check for IN_QUEUE or IN_PROGRESS reports (already requested, still processing)
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
      console.log(`[SalesReport] Report ${pending[0].reportId} still processing — will pick up on next sync`)
      return { documentId: null, requested: true }
    }
  }

  // No DONE or pending report — request a new one (fire and forget)
  console.log('[SalesReport] No recent report found — requesting new one (non-blocking)')
  const reportId = await requestOrdersReport(token)
  if (reportId) {
    console.log(`[SalesReport] Requested report ${reportId} — will be ready on next sync`)
  }
  return { documentId: null, requested: true }
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

  const map = new Map<string, ReturnType<typeof aggregateOrders> extends Map<string, infer V> ? V : never>()

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
 * Main export — fetch the All Orders report and upsert sku_sales_analytics.
 * NON-BLOCKING: returns immediately if report is still generating.
 */
export async function syncSalesReport(): Promise<{ synced: number; error: string | null; pending?: boolean }> {
  console.log('[SalesReport] Starting sync')
  try {
    const token = await getAccessToken()
    const { documentId, requested } = await getReportDocumentId(token)

    if (!documentId) {
      if (requested) {
        console.log('[SalesReport] Report requested/pending — will process on next sync')
        return { synced: 0, error: null, pending: true }
      }
      return { synced: 0, error: 'Could not obtain report document ID' }
    }

    const tsv = await downloadReport(documentId, token)
    if (!tsv) {
      return { synced: 0, error: 'Failed to download report content' }
    }

    const rows = parseTSV(tsv)
    console.log(`[SalesReport] Parsed ${rows.length} order rows`)

    const aggregated = aggregateOrders(rows)
    console.log(`[SalesReport] Aggregated ${aggregated.size} unique SKUs`)

    const supabase = getAdminSupabase()
    const now = new Date().toISOString()
    let synced = 0

    for (const entry of aggregated.values()) {
      const avgDaily = entry.units30d > 0 ? +(entry.units30d / 30).toFixed(4) : 0
      const { error } = await supabase
        .from('sku_sales_analytics')
        .upsert({
          sku:                  entry.sku,
          asin:                 entry.asin || null,
          product_name:         entry.productName || null,
          units_sold_7d:        entry.units7d,
          units_sold_30d:       entry.units30d,
          units_sold_90d:       entry.units90d,
          revenue_30d:          +entry.revenue30d.toFixed(2),
          avg_daily_units:      avgDaily,
          fulfillment_channel:  entry.fulfillmentChannel || null,
          last_order_date:      entry.lastOrderDate?.toISOString() || null,
          last_synced_at:       now,
        }, { onConflict: 'sku' })
      if (error) {
        console.warn(`[SalesReport] Upsert error for SKU ${entry.sku}: ${error.message}`)
      } else {
        synced++
      }
    }

    console.log(`[SalesReport] Synced ${synced} SKUs`)
    return { synced, error: null }
  } catch (err) {
    const msg = String(err)
    console.error('[SalesReport] Fatal error:', msg)
    return { synced: 0, error: msg }
  }
}
