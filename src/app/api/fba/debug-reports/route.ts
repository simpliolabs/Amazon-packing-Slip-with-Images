/**
 * Debug route — tests SP-API report access and returns raw diagnostic info.
 * GET /api/fba/debug-reports
 *
 * Returns:
 * - Whether we can list existing reports
 * - The most recent report of each type and its status
 * - Raw first 2000 chars of the report content if available
 */

import { NextResponse } from 'next/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

export async function GET() {
  const results: Record<string, unknown> = {}

  try {
    const token = await getAccessToken()
    results.token_obtained = true

    // ── Test 1: List recent Inventory Health reports ─────────────────────────
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const since7d  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    for (const [label, reportType] of [
      ['inventory_health', 'GET_FBA_INVENTORY_PLANNING_DATA'],
      ['sales_traffic',    'GET_SALES_AND_TRAFFIC_REPORT'],
    ] as const) {
      try {
        // Check last 7 days for any status
        const listUrl = `${ENDPOINT}/reports/2021-06-30/reports?reportTypes=${reportType}&marketplaceIds=${MARKETPLACE_ID}&createdSince=${encodeURIComponent(since7d)}&pageSize=5`
        const listResp = await fetch(listUrl, {
          headers: { 'x-amz-access-token': token },
        })
        const listStatus = listResp.status

        if (!listResp.ok) {
          const errText = await listResp.text()
          results[label] = { list_status: listStatus, error: errText }
          continue
        }

        const listJson = await listResp.json()
        const reports = listJson.reports || []

        results[label] = {
          list_status: listStatus,
          report_count_last_7d: reports.length,
          reports: reports.map((r: Record<string, unknown>) => ({
            reportId: r.reportId,
            processingStatus: r.processingStatus,
            createdTime: r.createdTime,
            reportDocumentId: r.reportDocumentId || null,
          })),
        }

        // If there's a DONE report, try to download a sample
        const doneReport = reports.find((r: Record<string, unknown>) => r.processingStatus === 'DONE' && r.reportDocumentId)
        if (doneReport) {
          try {
            // Get the document URL
            const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${doneReport.reportDocumentId}`, {
              headers: { 'x-amz-access-token': token },
            })
            if (docResp.ok) {
              const docJson = await docResp.json()
              const downloadUrl = docJson.url
              const compressionAlgorithm = docJson.compressionAlgorithm

              if (downloadUrl) {
                const dataResp = await fetch(downloadUrl)
                if (dataResp.ok) {
                  let rawText: string
                  if (compressionAlgorithm === 'GZIP') {
                    // Can't decompress in edge runtime easily — just note it
                    rawText = '[GZIP compressed — cannot preview in debug mode]'
                  } else {
                    const text = await dataResp.text()
                    rawText = text.substring(0, 2000)
                  }
                  ;(results[label] as Record<string, unknown>).sample_content = rawText
                  ;(results[label] as Record<string, unknown>).compression = compressionAlgorithm || 'none'
                }
              }
            }
          } catch (dlErr) {
            ;(results[label] as Record<string, unknown>).download_error = String(dlErr)
          }
        }
      } catch (err) {
        results[label] = { error: String(err) }
      }
    }

    // ── Test 2: Check fba_inventory table ────────────────────────────────────
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
        .limit(10)

      results.fba_inventory_table = {
        error: invErr?.message || null,
        row_count_sample: invRows?.length || 0,
        sample_rows: invRows?.slice(0, 5) || [],
      }
    } catch (dbErr) {
      results.fba_inventory_table = { error: String(dbErr) }
    }

  } catch (err) {
    results.token_error = String(err)
  }

  return NextResponse.json(results, { status: 200 })
}
