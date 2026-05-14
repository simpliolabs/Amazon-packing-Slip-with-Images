/**
 * Debug route — dumps the raw Inventory Health Report TSV headers
 * and specific rows for diagnosis.
 * GET /api/fba/debug-health-report?sku=DAFEI-482-64G.-FBA
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { gunzipSync } from 'zlib'

const ENDPOINT = 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

export async function GET(request: NextRequest) {
  const searchSku = request.nextUrl.searchParams.get('sku') || ''

  try {
    const token = await getAccessToken()

    // 1. Find the latest DONE inventory planning report
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const listUrl =
      `${ENDPOINT}/reports/2021-06-30/reports` +
      `?reportTypes=GET_FBA_INVENTORY_PLANNING_DATA` +
      `&marketplaceIds=${MARKETPLACE_ID}` +
      `&createdSince=${encodeURIComponent(since7d)}` +
      `&pageSize=5`

    const listResp = await fetch(listUrl, { headers: { 'x-amz-access-token': token } })
    if (!listResp.ok) {
      return NextResponse.json({ error: `List reports failed: ${listResp.status}` })
    }

    const listJson = await listResp.json()
    const reports = listJson.reports || []
    const doneReport = reports.find(
      (r: Record<string, unknown>) => r.processingStatus === 'DONE' && r.reportDocumentId
    )

    if (!doneReport) {
      return NextResponse.json({ error: 'No DONE report found in last 7 days', reports })
    }

    // 2. Download the report document
    const docResp = await fetch(
      `${ENDPOINT}/reports/2021-06-30/documents/${doneReport.reportDocumentId}`,
      { headers: { 'x-amz-access-token': token } }
    )
    const docJson = await docResp.json()
    const { url, compressionAlgorithm } = docJson

    const dataResp = await fetch(url)
    let rawText: string

    if (compressionAlgorithm === 'GZIP') {
      const buffer = Buffer.from(await dataResp.arrayBuffer())
      rawText = gunzipSync(buffer).toString('utf-8')
    } else {
      rawText = await dataResp.text()
    }

    // 3. Parse headers
    const lines = rawText.split('\n').filter(l => l.trim())
    const headers = lines[0].split('\t').map(h => h.trim())
    const headersLower = headers.map(h => h.toLowerCase())

    // 4. Build column index map
    const columnMap: Record<string, number> = {}
    headers.forEach((h, i) => { columnMap[h] = i })

    // 5. Find the specific SKU row
    const iSku = headersLower.indexOf('sku')
    const iAsin = headersLower.indexOf('asin')
    const matchingRows: Record<string, string>[] = []

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t')
      const sku = cols[iSku]?.trim() || ''
      const asin = cols[iAsin]?.trim() || ''

      if (searchSku && (sku.includes(searchSku) || asin.includes(searchSku))) {
        const row: Record<string, string> = {}
        headers.forEach((h, idx) => {
          row[h] = cols[idx]?.trim() || ''
        })
        matchingRows.push(row)
      }
    }

    // 6. Also find the key excess-related column indices
    const keyColumns = [
      'estimated-excess-quantity',
      'excess-units',
      'estimated-excess-units',
      'days-of-supply',
      'available',
      'afn-fulfillable-quantity',
      'alert',
      'recommended-action',
      'fba-inventory-level-health-status',
      'inv-age-0-to-90-days',
      'weeks-of-cover-t30',
      'weeks-of-cover-t90',
      'estimated-storage-cost-next-month',
      'units-shipped-t30',
      'units-shipped-t90',
      'historical-days-of-supply',
    ]

    const columnIndices: Record<string, number> = {}
    keyColumns.forEach(name => {
      columnIndices[name] = headersLower.indexOf(name)
    })

    return NextResponse.json({
      report_id: doneReport.reportId,
      created_time: doneReport.createdTime,
      compression: compressionAlgorithm || 'none',
      total_lines: lines.length,
      total_columns: headers.length,
      headers_raw: headers,
      key_column_indices: columnIndices,
      search_sku: searchSku,
      matching_rows: matchingRows,
      // Also show first data row as reference
      first_row_sample: (() => {
        if (lines.length < 2) return null
        const cols = lines[1].split('\t')
        const row: Record<string, string> = {}
        headers.forEach((h, idx) => {
          row[h] = cols[idx]?.trim() || ''
        })
        return row
      })(),
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) })
  }
}
