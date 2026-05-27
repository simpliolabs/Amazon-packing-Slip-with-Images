/**
 * syncInactiveListings.ts
 *
 * Fetches the GET_MERCHANT_LISTINGS_INACTIVE_DATA report from SP-API.
 * This report includes a "Status Message" column with values like:
 *   - "Missing offer"
 *   - "Detail page removed"
 *   - "Search suppressed"
 *   - "Blocked"
 *   - "Out of stock" (FBM stockout)
 *   - "Inactive" (generic)
 *
 * We store the status_message in listing_health so the listing-issues
 * route can accurately detect each issue type.
 *
 * NON-BLOCKING: If no DONE report exists, requests one and returns immediately.
 */
import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'
import { gunzipSync } from 'zlib'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
const REPORT_TYPE = 'GET_MERCHANT_LISTINGS_INACTIVE_DATA'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function getReportDocumentId(token: string, force = false): Promise<{ documentId: string | null; requested: boolean }> {
  const since2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

  if (!force) {
    const listUrl =
      `${ENDPOINT}/reports/2021-06-30/reports` +
      `?reportTypes=${REPORT_TYPE}` +
      `&marketplaceIds=${MARKETPLACE_ID}` +
      `&processingStatuses=DONE` +
      `&createdSince=${encodeURIComponent(since2h)}` +
      `&pageSize=1`

    const listResp = await fetch(listUrl, { headers: { 'x-amz-access-token': token } })
    if (listResp.ok) {
      const listJson = await listResp.json()
      const reports: Record<string, string>[] = listJson.reports || []
      if (reports.length > 0 && reports[0].reportDocumentId) {
        console.log(`[InactiveListings] Using existing DONE report ${reports[0].reportId}`)
        return { documentId: reports[0].reportDocumentId, requested: false }
      }
    }
  } else {
    console.log('[InactiveListings] force=true — skipping cached report, requesting fresh one')
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
      console.log(`[InactiveListings] Report ${pending[0].reportId} still processing`)
      return { documentId: null, requested: true }
    }
  }

  // Request a new one
  console.log('[InactiveListings] No recent report — requesting new one (non-blocking)')
  const reqResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reportType: REPORT_TYPE, marketplaceIds: [MARKETPLACE_ID] }),
  })
  if (reqResp.ok) {
    const { reportId } = await reqResp.json()
    console.log(`[InactiveListings] Requested report ${reportId}`)
  }
  return { documentId: null, requested: true }
}

async function downloadReport(documentId: string, token: string): Promise<string | null> {
  const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${documentId}`, {
    headers: { 'x-amz-access-token': token },
  })
  if (!docResp.ok) return null
  const docJson = await docResp.json()
  const { url, compressionAlgorithm } = docJson
  if (!url) return null
  const dataResp = await fetch(url)
  if (!dataResp.ok) return null
  if (compressionAlgorithm === 'GZIP') {
    const buffer = Buffer.from(await dataResp.arrayBuffer())
    return gunzipSync(buffer).toString('utf-8')
  }
  return await dataResp.text()
}

function parseTSV(tsv: string): Record<string, string>[] {
  const lines = tsv.split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split('\t').map(h => h.trim())
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim() })
    rows.push(row)
  }
  return rows
}

/**
 * Normalize Amazon's "Status Message" values to canonical strings.
 * Amazon uses inconsistent casing and phrasing across report versions.
 */
function normalizeStatusMessage(raw: string): string {
  const lower = raw.toLowerCase().trim()
  if (lower.includes('missing offer') || lower.includes('no offer'))           return 'Missing offer'
  if (lower.includes('detail page removed') || lower.includes('page removed')) return 'Detail page removed'
  if (lower.includes('search suppressed') || lower.includes('suppressed'))     return 'Search suppressed'
  if (lower.includes('blocked'))                                                return 'Blocked'
  if (lower.includes('out of stock') || lower.includes('stockout'))            return 'Out of stock'
  if (lower.includes('inactive'))                                               return 'Inactive'
  return raw.trim() || 'Inactive'
}

export async function syncInactiveListings(force = false): Promise<{ synced: number; error: string | null; pending?: boolean }> {
  console.log(`[InactiveListings] Starting sync${force ? ' (force=true)' : ''}`)
  try {
    const token = await getAccessToken()
    const { documentId, requested } = await getReportDocumentId(token, force)

    if (!documentId) {
      if (requested) {
        console.log('[InactiveListings] Report requested/pending — will process on next sync')
        return { synced: 0, error: null, pending: true }
      }
      return { synced: 0, error: 'Could not obtain report document ID' }
    }

    const tsv = await downloadReport(documentId, token)
    if (!tsv) {
      // Download failed — request a fresh report
      const reqResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
        method: 'POST',
        headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType: REPORT_TYPE, marketplaceIds: [MARKETPLACE_ID] }),
      })
      if (reqResp.ok) {
        const { reportId } = await reqResp.json()
        console.log(`[InactiveListings] Requested fresh report ${reportId}`)
      }
      return { synced: 0, error: null, pending: true }
    }

    const rows = parseTSV(tsv)
    console.log(`[InactiveListings] Parsed ${rows.length} inactive listing rows`)

    // Log the headers from the first row to understand the report structure
    if (rows.length > 0) {
      console.log(`[InactiveListings] Report columns: ${Object.keys(rows[0]).join(', ')}`)
    }

    const supabase = getAdminSupabase()
    const now = new Date().toISOString()
    let synced = 0

    for (const row of rows) {
      // The inactive listings report uses "seller-sku" or "sku" depending on version
      const sku = row['seller-sku'] || row['sku'] || row['SKU'] || ''
      if (!sku) continue

      // Status Message column — may be "Status Message", "status-message", or "Reason"
      const rawStatusMsg = row['Status Message'] || row['status-message'] || row['Reason'] || row['reason'] || ''
      const statusMessage = rawStatusMsg ? normalizeStatusMessage(rawStatusMsg) : null

      if (!statusMessage) continue // No status message — skip (we only care about the message)

      // Update only the status_message column for this SKU
      const { error } = await supabase
        .from('listing_health')
        .update({ status_message: statusMessage, last_synced_at: now })
        .eq('sku', sku)

      if (error) {
        console.warn(`[InactiveListings] Update error for SKU ${sku}: ${error.message}`)
      } else {
        synced++
      }
    }

    console.log(`[InactiveListings] Updated status_message for ${synced} listings`)
    return { synced, error: null }
  } catch (err) {
    const msg = String(err)
    console.error('[InactiveListings] Fatal error:', msg)
    return { synced: 0, error: msg }
  }
}
