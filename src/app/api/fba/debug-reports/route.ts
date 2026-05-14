/**
 * Debug route — tests SP-API report access across all key report types.
 * GET /api/fba/debug-reports
 *
 * Tests:
 *   - GET_FBA_INVENTORY_PLANNING_DATA        (inventory health, days of supply, recommended reorder)
 *   - GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL  (all orders flat file)
 *   - GET_SALES_AND_TRAFFIC_REPORT           (sales/traffic by ASIN)
 *   - GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA (FBA managed inventory)
 *   - GET_MERCHANT_LISTINGS_ALL_DATA         (all listings — Product Listing role)
 *   - GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA    (FBA fee estimates)
 *   - GET_FBA_REIMBURSEMENTS_DATA            (reimbursements)
 *   - GET_STRANDED_INVENTORY_UI_DATA         (stranded inventory)
 *
 * For each type: lists existing reports, downloads sample if DONE, or requests a new one.
 */
import { NextResponse } from 'next/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

const REPORT_TYPES = [
  { key: 'inventory_planning',    type: 'GET_FBA_INVENTORY_PLANNING_DATA' },
  { key: 'all_orders',            type: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL' },
  { key: 'sales_traffic',         type: 'GET_SALES_AND_TRAFFIC_REPORT' },
  { key: 'fba_managed_inventory', type: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA' },
  { key: 'all_listings',          type: 'GET_MERCHANT_LISTINGS_ALL_DATA' },
  { key: 'fba_fees',              type: 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA' },
  { key: 'reimbursements',        type: 'GET_FBA_REIMBURSEMENTS_DATA' },
  { key: 'stranded_inventory',    type: 'GET_STRANDED_INVENTORY_UI_DATA' },
]

async function downloadSample(
  token: string,
  reportDocumentId: string
): Promise<{ sample: string; compression: string }> {
  const docResp = await fetch(
    `${ENDPOINT}/reports/2021-06-30/documents/${reportDocumentId}`,
    { headers: { 'x-amz-access-token': token } }
  )
  if (!docResp.ok) {
    return { sample: `doc fetch failed: ${docResp.status}`, compression: 'unknown' }
  }
  const docJson = await docResp.json()
  const { url, compressionAlgorithm } = docJson
  if (!url) return { sample: 'no url in document response', compression: 'none' }
  const dataResp = await fetch(url)
  if (!dataResp.ok) {
    return { sample: `data fetch failed: ${dataResp.status}`, compression: compressionAlgorithm || 'none' }
  }
  if (compressionAlgorithm === 'GZIP') {
    return { sample: '[GZIP compressed — will be decompressed in production]', compression: 'GZIP' }
  }
  const text = await dataResp.text()
  return { sample: text.substring(0, 3000), compression: compressionAlgorithm || 'none' }
}

export async function GET() {
  const results: Record<string, unknown> = {}
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  try {
    const token = await getAccessToken()
    results._token_ok = true

    for (const { key, type } of REPORT_TYPES) {
      try {
        // 1. List existing reports in the last 7 days
        const listUrl =
          `${ENDPOINT}/reports/2021-06-30/reports` +
          `?reportTypes=${type}` +
          `&marketplaceIds=${MARKETPLACE_ID}` +
          `&createdSince=${encodeURIComponent(since7d)}` +
          `&pageSize=5`

        const listResp = await fetch(listUrl, { headers: { 'x-amz-access-token': token } })

        if (!listResp.ok) {
          const errText = await listResp.text()
          results[key] = {
            accessible: false,
            http_status: listResp.status,
            error: errText.substring(0, 500),
          }
          continue
        }

        const listJson = await listResp.json()
        const reports: Record<string, unknown>[] = listJson.reports || []
        const doneReport = reports.find(
          r => r.processingStatus === 'DONE' && r.reportDocumentId
        )
        const inProgressReport = reports.find(
          r => r.processingStatus === 'IN_PROGRESS' || r.processingStatus === 'IN_QUEUE'
        )

        const entry: Record<string, unknown> = {
          accessible: true,
          report_count_last_7d: reports.length,
          statuses: reports.map(r => r.processingStatus),
        }

        // 2. Download sample if DONE report exists
        if (doneReport) {
          entry.has_done_report = true
          entry.report_id = doneReport.reportId
          entry.created_time = doneReport.createdTime
          try {
            const { sample, compression } = await downloadSample(
              token,
              doneReport.reportDocumentId as string
            )
            entry.sample = sample
            entry.compression = compression
          } catch (dlErr) {
            entry.download_error = String(dlErr)
          }
        } else if (inProgressReport) {
          entry.has_done_report = false
          entry.in_progress = true
          entry.report_id = inProgressReport.reportId
          entry.note = 'Report is processing — check back in a few minutes'
        } else {
          // 3. No recent report — request one now
          entry.has_done_report = false
          entry.requesting_new = true
          try {
            const reqBody: Record<string, unknown> = {
              reportType: type,
              marketplaceIds: [MARKETPLACE_ID],
            }
            // Sales & Traffic requires a date range and options
            if (type === 'GET_SALES_AND_TRAFFIC_REPORT') {
              reqBody.reportOptions = { dateGranularity: 'DAY', asinGranularity: 'CHILD' }
              reqBody.dataStartTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
              reqBody.dataEndTime = new Date().toISOString()
            }
            // Orders report needs a date range too
            if (type === 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL') {
              reqBody.dataStartTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
              reqBody.dataEndTime = new Date().toISOString()
            }
            const reqResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
              method: 'POST',
              headers: {
                'x-amz-access-token': token,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(reqBody),
            })
            if (reqResp.ok) {
              const reqJson = await reqResp.json()
              entry.new_report_id = reqJson.reportId
              entry.note = 'Report requested — check /api/fba/debug-reports again in 1-5 minutes'
            } else {
              const reqErr = await reqResp.text()
              entry.request_error = `${reqResp.status}: ${reqErr.substring(0, 400)}`
            }
          } catch (reqErr) {
            entry.request_error = String(reqErr)
          }
        }

        results[key] = entry
      } catch (err) {
        results[key] = { accessible: false, error: String(err) }
      }
    }

    // Test Fulfillment Inbound API v2024 (listInboundPlans)
    try {
      const inboundUrl = `${ENDPOINT}/inbound/fba/2024-03-20/inboundPlans?pageSize=5&status=ACTIVE`
      const inboundResp = await fetch(inboundUrl, {
        headers: { 'x-amz-access-token': token },
      })
      if (inboundResp.ok) {
        const inboundJson = await inboundResp.json()
        results._inbound_api_v2024 = {
          accessible: true,
          plan_count: inboundJson.inboundPlans?.length || 0,
          sample: JSON.stringify(inboundJson).substring(0, 2000),
        }
      } else {
        const errText = await inboundResp.text()
        results._inbound_api_v2024 = {
          accessible: false,
          http_status: inboundResp.status,
          error: errText.substring(0, 500),
        }
      }
    } catch (err) {
      results._inbound_api_v2024 = { accessible: false, error: String(err) }
    }

    // Test old Fulfillment Inbound Shipments API v0 (getShipments)
    try {
      const shipmentsUrl = `${ENDPOINT}/fba/inbound/v0/shipments?ShipmentStatusList=WORKING,READY_TO_SHIP,SHIPPED,IN_TRANSIT,RECEIVING,CHECKED_IN&MarketplaceId=${MARKETPLACE_ID}&QueryType=SHIPMENT`
      const shipmentsResp = await fetch(shipmentsUrl, {
        headers: { 'x-amz-access-token': token },
      })
      if (shipmentsResp.ok) {
        const shipmentsJson = await shipmentsResp.json()
        const shipments = shipmentsJson.payload?.ShipmentData || []
        results._inbound_shipments_v0 = {
          accessible: true,
          shipment_count: shipments.length,
          sample: JSON.stringify(shipmentsJson).substring(0, 3000),
        }
      } else {
        const errText = await shipmentsResp.text()
        results._inbound_shipments_v0 = {
          accessible: false,
          http_status: shipmentsResp.status,
          error: errText.substring(0, 500),
        }
      }
    } catch (err) {
      results._inbound_shipments_v0 = { accessible: false, error: String(err) }
    }

    // Also check fba_inventory table health
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
      )
      const { data: invRows, error: invErr } = await supabase
        .from('fba_inventory')
        .select('asin, sku, quantity_available, quantity_inbound, last_synced_at')
        .order('last_synced_at', { ascending: false })
        .limit(5)
      results._fba_inventory_table = {
        error: invErr?.message || null,
        row_count_sample: invRows?.length || 0,
        sample_rows: invRows || [],
      }
    } catch (dbErr) {
      results._fba_inventory_table = { error: String(dbErr) }
    }

  } catch (err) {
    results._token_error = String(err)
  }

  return NextResponse.json(results, { status: 200 })
}
