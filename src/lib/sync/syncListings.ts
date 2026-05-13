/**
 * syncListings.ts
 *
 * Fetches the GET_MERCHANT_LISTINGS_ALL_DATA report from SP-API (GZIP TSV),
 * parses it, and upserts into the listing_health table.
 *
 * NON-BLOCKING: If no DONE report exists, requests one and returns immediately.
 * On the next sync call, the DONE report will be picked up and processed.
 * (Listings reports are always available — 4 DONE reports confirmed in diagnostics.)
 */
import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'
import { gunzipSync } from 'zlib'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
const REPORT_TYPE = 'GET_MERCHANT_LISTINGS_ALL_DATA'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/**
 * NON-BLOCKING: Get the most recent DONE report document ID.
 * If none exists, request a new one but return immediately.
 */
async function getReportDocumentId(token: string): Promise<{ documentId: string | null; requested: boolean }> {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Check for an existing DONE report in the last 7 days
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
      console.log(`[Listings] Using existing DONE report ${reports[0].reportId}`)
      return { documentId: reports[0].reportDocumentId, requested: false }
    }
  }

  // Check for pending reports
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
      console.log(`[Listings] Report ${pending[0].reportId} still processing — will pick up on next sync`)
      return { documentId: null, requested: true }
    }
  }

  // Request a new one (fire and forget — no polling)
  console.log('[Listings] No recent report — requesting new one (non-blocking)')
  const reqResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportType: REPORT_TYPE, marketplaceIds: [MARKETPLACE_ID] }),
  })
  if (reqResp.ok) {
    const { reportId } = await reqResp.json()
    console.log(`[Listings] Requested report ${reportId} — will be ready on next sync`)
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

interface ListingRow {
  'item-name': string
  'item-description': string
  'listing-id': string
  'seller-sku': string
  price: string
  quantity: string
  'open-date': string
  'product-id': string
  'product-id-type': string
  'item-condition': string
  'zshop-shipping-fee': string
  'item-note': string
  'item-is-marketplace': string
  'product-for-sale': string
  'asin1': string
  'asin2': string
  'asin3': string
  'will-ship-internationally': string
  'expedited-shipping': string
  'zshop-boldface': string
  'status': string
  'fulfillment-channel': string
  'merchant-shipping-group': string
  'Business Price': string
  'Quantity Price Type': string
  'Quantity Lower Bound 1': string
  'Quantity Price 1': string
  [key: string]: string
}

function parseTSV(tsv: string): ListingRow[] {
  const lines = tsv.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split('\t').map(h => h.trim())
  const rows: ListingRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim() })
    rows.push(row as ListingRow)
  }
  return rows
}

/**
 * Main export — fetch the All Listings report and upsert listing_health.
 * NON-BLOCKING: returns immediately if report is still generating.
 */
export async function syncListings(): Promise<{ synced: number; error: string | null; pending?: boolean }> {
  console.log('[Listings] Starting sync')
  try {
    const token = await getAccessToken()
    const { documentId, requested } = await getReportDocumentId(token)

    if (!documentId) {
      if (requested) {
        console.log('[Listings] Report requested/pending — will process on next sync')
        return { synced: 0, error: null, pending: true }
      }
      return { synced: 0, error: 'Could not obtain report document ID' }
    }

    const tsv = await downloadReport(documentId, token)
    if (!tsv) {
      return { synced: 0, error: 'Failed to download report content' }
    }

    const rows = parseTSV(tsv)
    console.log(`[Listings] Parsed ${rows.length} listing rows`)

    const supabase = getAdminSupabase()
    const now = new Date().toISOString()
    let synced = 0

    for (const row of rows) {
      const sku = row['seller-sku']
      if (!sku) continue

      const asin = row['asin1'] || row['product-id'] || null
      const price = parseFloat(row['price'] || '0') || null
      const quantity = parseInt(row['quantity'] || '0', 10) || 0
      const status = row['status'] || 'Unknown'
      const fulfillmentChannel = row['fulfillment-channel'] || null
      const openDate = row['open-date'] ? new Date(row['open-date']).toISOString() : null
      const productName = row['item-name'] || null

      const { error } = await supabase
        .from('listing_health')
        .upsert({
          sku,
          asin,
          product_name:        productName,
          price,
          quantity,
          status,
          fulfillment_channel: fulfillmentChannel,
          open_date:           openDate,
          last_synced_at:      now,
        }, { onConflict: 'sku' })

      if (error) {
        console.warn(`[Listings] Upsert error for SKU ${sku}: ${error.message}`)
      } else {
        synced++
      }
    }

    console.log(`[Listings] Synced ${synced} listings`)
    return { synced, error: null }
  } catch (err) {
    const msg = String(err)
    console.error('[Listings] Fatal error:', msg)
    return { synced: 0, error: msg }
  }
}
