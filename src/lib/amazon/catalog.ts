/**
 * Amazon SP-API FBA Intelligence Data Fetchers
 *
 * Orders-driven approach:
 * 1. Get unique ASINs from existing orders (no full catalog dump)
 * 2. Fetch FBA inventory ONLY for those ASINs
 * 3. Fetch Sales & Traffic Report for FBA sales data
 * 4. Fetch Inventory Health Report for excess/storage data
 */

import { getAccessToken } from './auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

export interface FBAInventoryItem {
  asin: string
  sku: string
  fnsku: string | null
  condition_type: string
  quantity_available: number
  quantity_reserved: number
  quantity_inbound: number
  quantity_total: number
}

export interface ASINSalesData {
  asin: string
  units_ordered_fba: number        // FBA units sold in report period
  units_ordered_fbm: number        // FBM units sold (from orders table, passed in)
  ordered_product_sales: number    // Revenue
  sessions: number                 // Page views
  buy_box_percentage: number       // Buy Box win %
  unit_session_percentage: number  // Conversion rate
}

export interface CatalogProduct {
  asin: string
  sku: string
  title: string
  fulfillment_channel: 'AFN' | 'MFN'
  status: string
  parent_asin: string | null
  item_name: string | null
  price: number | null
  quantity: number
  image_url: string | null
  raw_data: Record<string, unknown>
}

/**
 * Inventory Health item — from GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA report.
 * Contains excess flags, days of supply, and storage cost data from Amazon.
 */
export interface InventoryHealthItem {
  asin: string
  sku: string
  fnsku: string
  product_name: string
  condition: string
  // Inventory quantities
  qty_available: number
  qty_inbound_working: number
  qty_inbound_shipped: number
  qty_inbound_receiving: number
  // Sales velocity
  units_sold_last_30_days: number
  // Excess / overstock data
  is_excess: boolean
  excess_qty: number
  days_of_supply: number           // How many days of stock on hand
  recommended_action: string       // Amazon's raw recommendation string
  // Storage costs (from Amazon's report)
  estimated_monthly_storage_fee: number   // USD
  estimated_storage_cost_per_unit: number // USD per unit
  // Pricing
  your_price: number
  sales_price: number | null
  // Flags
  alert: string                    // e.g. "Excess inventory", "Low inventory", etc.
}

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Fetch with retry on 429 (QuotaExceeded) — exponential backoff.
 */
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
  let delay = 2000 // start at 2s
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, options)
    if (resp.status !== 429) return resp
    if (attempt === maxRetries) return resp
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '0', 10)
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : delay
    console.warn(`[SP-API] 429 QuotaExceeded — waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`)
    await sleep(waitMs)
    delay = Math.min(delay * 2, 30000) // cap at 30s
  }
  return fetch(url, options) // final attempt
}

/**
 * Poll for a report to complete and return its document ID.
 * Shared helper used by multiple report fetchers.
 */
async function pollReportUntilDone(
  reportId: string,
  token: string,
  label: string,
  maxWaitMs = 300000 // 5 minutes
): Promise<string | null> {
  const pollInterval = 5000
  const maxAttempts = Math.ceil(maxWaitMs / pollInterval)

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(pollInterval)

    const statusResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports/${reportId}`, {
      headers: { 'x-amz-access-token': token },
    })

    if (!statusResp.ok) continue

    const status = await statusResp.json()
    console.log(`[${label}] Status: ${status.processingStatus}`)

    if (status.processingStatus === 'DONE') {
      return status.reportDocumentId
    }
    if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
      console.warn(`[${label}] Report failed: ${status.processingStatus}`)
      return null
    }
  }

  console.warn(`[${label}] Timed out waiting for report`)
  return null
}

/**
 * Download a report document by its document ID.
 * Returns the raw text content.
 */
async function downloadReportDocument(documentId: string, token: string, label: string): Promise<string | null> {
  const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${documentId}`, {
    headers: { 'x-amz-access-token': token },
  })

  if (!docResp.ok) {
    console.warn(`[${label}] Failed to get document URL (${docResp.status})`)
    return null
  }

  const { url } = await docResp.json()
  const dataResp = await fetch(url)

  if (!dataResp.ok) {
    console.warn(`[${label}] Failed to download report data`)
    return null
  }

  return await dataResp.text()
}

/**
 * Fetch ALL FBA inventory from Amazon.
 * Returns every item in FBA inventory (not filtered by ASIN list).
 * The `asins` parameter is accepted for backward compatibility but no longer used for filtering.
 */
export async function fetchFBAInventoryForAsins(asins: string[]): Promise<FBAInventoryItem[]> {
  const token = await getAccessToken()
  const items: FBAInventoryItem[] = []
  let nextToken: string | undefined

  do {
    const params = new URLSearchParams({
      granularityType: 'Marketplace',
      granularityId: MARKETPLACE_ID,
      marketplaceIds: MARKETPLACE_ID,
      details: 'true',
    })
    if (nextToken) params.set('nextToken', nextToken)

    const resp = await fetchWithRetry(`${ENDPOINT}/fba/inventory/v1/summaries?${params}`, {
      headers: { 'x-amz-access-token': token },
    })

    if (!resp.ok) {
      const err = await resp.text()
      if (resp.status === 403 || resp.status === 404) {
        console.warn('[FBA Inventory] No access or no inventory:', err)
        return []
      }
      if (resp.status === 429) {
        throw new Error(`FBA Inventory API rate limit exceeded after retries. Try again in a few minutes.`)
      }
      throw new Error(`FBA inventory API error (${resp.status}): ${err}`)
    }

    const data = await resp.json()
    const summaries = data?.payload?.inventorySummaries || []

    for (const item of summaries) {
      const inv = item.inventoryDetails || {}
      const fulfillable = inv.fulfillableQuantity || 0
      const reserved = inv.reservedQuantity?.totalReservedQuantity || 0
      const inbound =
        (inv.inboundWorkingQuantity || 0) +
        (inv.inboundShippedQuantity || 0) +
        (inv.inboundReceivingQuantity || 0)

      items.push({
        asin: item.asin || '',
        sku: item.sellerSku || '',
        fnsku: item.fnSku || null,
        condition_type: item.condition || 'NewItem',
        quantity_available: fulfillable,
        quantity_reserved: reserved,
        quantity_inbound: inbound,
        quantity_total: fulfillable + reserved,
      })
    }

    nextToken = data?.pagination?.nextToken
  } while (nextToken)

  console.log(`[FBA Inventory] Fetched ${items.length} total FBA inventory records (${asins.length} ASINs in products table)`)
  return items
}

/**
 * Fetch the FBA Manage Inventory Health Report (GET_FBA_INVENTORY_PLANNING_DATA).
 *
 * Strategy (avoids the 4-hour daily report wait):
 * 1. First check if Amazon already has a recent DONE report (last 24 hours)
 * 2. If yes → download it immediately (no wait)
 * 3. If no → request a new report and poll up to 5 minutes
 *
 * Returns a map of SKU → InventoryHealthItem for easy lookup.
 */
export async function fetchInventoryHealthReport(): Promise<Map<string, InventoryHealthItem>> {
  const token = await getAccessToken()
  const result = new Map<string, InventoryHealthItem>()

  // ── Step 1: Check for an existing recent report ─────────────────────────
  // Amazon keeps completed reports for 90 days. We look for any DONE report
  // from the last 24 hours to avoid requesting a new daily report unnecessarily.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const listUrl = `${ENDPOINT}/reports/2021-06-30/reports?reportTypes=GET_FBA_INVENTORY_PLANNING_DATA&processingStatuses=DONE&marketplaceIds=${MARKETPLACE_ID}&createdSince=${encodeURIComponent(since)}&pageSize=1`

  let documentId: string | null = null

  try {
    const listResp = await fetch(listUrl, {
      headers: { 'x-amz-access-token': token },
    })

    if (listResp.ok) {
      const listJson = await listResp.json()
      const reports: Array<{ reportId: string; reportDocumentId?: string; processingStatus: string; createdTime: string }> =
        listJson.reports || []

      if (reports.length > 0 && reports[0].reportDocumentId) {
        documentId = reports[0].reportDocumentId
        console.log(`[Inventory Health] Using existing report from ${reports[0].createdTime} (documentId: ${documentId})`)
      } else {
        console.log(`[Inventory Health] No recent DONE report found — will request a new one`)
      }
    } else {
      console.warn(`[Inventory Health] Could not list reports (${listResp.status}) — will request a new one`)
    }
  } catch (err) {
    console.warn('[Inventory Health] Error listing reports:', err)
  }

  // ── Step 2: If no existing report, request a new one ────────────────────
  if (!documentId) {
    const reportResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
      method: 'POST',
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reportType: 'GET_FBA_INVENTORY_PLANNING_DATA',
        marketplaceIds: [MARKETPLACE_ID],
      }),
    })

    if (!reportResp.ok) {
      const errBody = await reportResp.text()
      console.warn(`[Inventory Health] Failed to request report (${reportResp.status}):`, errBody)
      if (reportResp.status === 403) {
        console.warn('[Inventory Health] 403 Forbidden — ensure "Reports" scope is enabled in your SP-API app')
      }
      return result
    }

    const reportRespJson = await reportResp.json()
    const reportId = reportRespJson.reportId
    if (!reportId) {
      console.warn('[Inventory Health] No reportId in response:', JSON.stringify(reportRespJson))
      return result
    }
    console.log(`[Inventory Health] Requested new report: ${reportId}`)

    // Poll up to 5 minutes for the new report to complete
    documentId = await pollReportUntilDone(reportId, token, 'Inventory Health')
    if (!documentId) {
      console.warn('[Inventory Health] New report did not complete within 5 minutes — try syncing again in a few hours')
      return result
    }
  }

  // ── Step 3: Download and parse the report ───────────────────────────────
  const rawText = await downloadReportDocument(documentId, token, 'Inventory Health')
  if (!rawText) return result

  console.log(`[Inventory Health] Downloaded ${rawText.length} bytes`)
  parseInventoryHealthTSV(rawText, result)
  console.log(`[Inventory Health] Parsed ${result.size} inventory health records`)

  return result
}

/**
 * Parse the GET_FBA_INVENTORY_PLANNING_DATA tab-delimited report.
 *
 * Column reference (Amazon's standard column names):
 * sku, fnsku, asin, product-name, condition, your-price, mfn-listing-exists,
 * mfn-fulfillable-quantity, afn-listing-exists, afn-warehouse-quantity,
 * afn-fulfillable-quantity, afn-unsellable-quantity, afn-reserved-quantity,
 * afn-total-quantity, per-unit-volume, afn-inbound-working-quantity,
 * afn-inbound-shipped-quantity, afn-inbound-receiving-quantity,
 * afn-researching-quantity, afn-reserved-future-supply, afn-future-supply-buyable,
 * units-shipped-t7, units-shipped-t30, units-shipped-t90, units-shipped-t180,
 * alert, your-30-day-units-sold, your-30-day-revenue, your-ltsf-12-mo,
 * your-ltsf-6-mo, inv-age-0-to-90-days, inv-age-91-to-180-days,
 * inv-age-181-to-270-days, inv-age-271-to-365-days, inv-age-365-plus-days,
 * estimated-excess-quantity, weeks-of-cover-t30, weeks-of-cover-t90,
 * recommended-action, healthy-inventory-level, recommended-removal-quantity,
 * estimated-monthly-storage-fee, estimated-storage-cost-per-unit,
 * sales-price
 */
function parseInventoryHealthTSV(
  rawText: string,
  result: Map<string, InventoryHealthItem>
): void {
  const lines = rawText.split('\n').filter(l => l.trim())
  if (lines.length < 2) return

  // Parse header row — Amazon uses tab-delimited with hyphenated column names
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase())

  const col = (name: string) => headers.indexOf(name)

  // Map column indices
  const iSku = col('sku')
  const iFnsku = col('fnsku')
  const iAsin = col('asin')
  const iProductName = col('product-name')
  const iCondition = col('condition')
  const iYourPrice = col('your-price')
  const iSalesPrice = col('sales-price')
  const iAfnFulfillable = col('afn-fulfillable-quantity')
  const iAfnInboundWorking = col('afn-inbound-working-quantity')
  const iAfnInboundShipped = col('afn-inbound-shipped-quantity')
  const iAfnInboundReceiving = col('afn-inbound-receiving-quantity')
  const iUnits30d = col('your-30-day-units-sold')
  const iAlert = col('alert')
  const iExcessQty = col('estimated-excess-quantity')
  const iWeeksCoverT30 = col('weeks-of-cover-t30')
  const iRecommendedAction = col('recommended-action')
  const iEstMonthlyStorageFee = col('estimated-monthly-storage-fee')
  const iEstStorageCostPerUnit = col('estimated-storage-cost-per-unit')

  const parseNum = (val: string | undefined): number => {
    if (!val || val === '' || val === '--') return 0
    return parseFloat(val.replace(/[,$]/g, '')) || 0
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 3) continue

    const sku = cols[iSku]?.trim()
    const asin = cols[iAsin]?.trim()
    if (!sku || !asin) continue

    const excessQty = parseNum(cols[iExcessQty])
    const alertText = cols[iAlert]?.trim() || ''
    const recommendedAction = cols[iRecommendedAction]?.trim() || ''

    // Determine if this item is flagged as excess by Amazon
    const isExcess = excessQty > 0 ||
      alertText.toLowerCase().includes('excess') ||
      recommendedAction.toLowerCase().includes('sale') ||
      recommendedAction.toLowerCase().includes('outlet') ||
      recommendedAction.toLowerCase().includes('remov')

    const weeksOfCoverRaw = parseNum(cols[iWeeksCoverT30])
    // Convert weeks of cover to days of supply
    const daysOfSupply = weeksOfCoverRaw > 0 ? Math.round(weeksOfCoverRaw * 7) : 0

    const item: InventoryHealthItem = {
      asin,
      sku,
      fnsku: cols[iFnsku]?.trim() || '',
      product_name: cols[iProductName]?.trim() || '',
      condition: cols[iCondition]?.trim() || 'New',
      qty_available: parseNum(cols[iAfnFulfillable]),
      qty_inbound_working: parseNum(cols[iAfnInboundWorking]),
      qty_inbound_shipped: parseNum(cols[iAfnInboundShipped]),
      qty_inbound_receiving: parseNum(cols[iAfnInboundReceiving]),
      units_sold_last_30_days: parseNum(cols[iUnits30d]),
      is_excess: isExcess,
      excess_qty: excessQty,
      days_of_supply: daysOfSupply,
      recommended_action: recommendedAction,
      estimated_monthly_storage_fee: parseNum(cols[iEstMonthlyStorageFee]),
      estimated_storage_cost_per_unit: parseNum(cols[iEstStorageCostPerUnit]),
      your_price: parseNum(cols[iYourPrice]),
      sales_price: iSalesPrice >= 0 ? parseNum(cols[iSalesPrice]) : null,
      alert: alertText,
    }

    result.set(sku, item)
  }
}

/**
 * Fetch Sales & Traffic Report (GET_SALES_AND_TRAFFIC_REPORT) for the last 30 days.
 * Returns per-ASIN FBA sales data including units, revenue, Buy Box %, conversion.
 */
export async function fetchSalesAndTrafficReport(asins: string[]): Promise<Map<string, ASINSalesData>> {
  if (asins.length === 0) return new Map()

  const token = await getAccessToken()

  const endDate = new Date()
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const formatDate = (d: Date) => d.toISOString().split('T')[0]

  // Request the report
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
    console.warn(`[Sales Report] Failed to request report (${reportResp.status}):`, errBody)
    if (reportResp.status === 403) {
      console.warn('[Sales Report] 403 Forbidden — ensure "Reports" scope is enabled in your SP-API app at solutionproviderportal.amazon.com')
    }
    return new Map()
  }

  const reportRespJson = await reportResp.json()
  const reportId = reportRespJson.reportId
  if (!reportId) {
    console.warn('[Sales Report] No reportId in response:', JSON.stringify(reportRespJson))
    return new Map()
  }
  console.log(`[Sales Report] Requested report: ${reportId}`)

  // Poll for completion
  const documentId = await pollReportUntilDone(reportId, token, 'Sales Report')
  if (!documentId) return new Map()

  // Download the report
  const rawText = await downloadReportDocument(documentId, token, 'Sales Report')
  if (!rawText) return new Map()

  console.log(`[Sales Report] Downloaded ${rawText.length} bytes`)

  let reportData: Record<string, unknown>
  try {
    reportData = JSON.parse(rawText)
  } catch {
    console.warn('[Sales Report] Failed to parse JSON, first 500 chars:', rawText.substring(0, 500))
    return new Map()
  }

  console.log('[Sales Report] Top-level keys:', Object.keys(reportData))

  const result = parseSalesAndTrafficReport(reportData, new Set(asins))
  console.log(`[Sales Report] Parsed ${result.size} ASINs from report`)
  return result
}

/**
 * Parse the Sales & Traffic JSON report into a map of ASIN → sales data.
 */
function parseSalesAndTrafficReport(
  data: Record<string, unknown>,
  asinFilter: Set<string>
): Map<string, ASINSalesData> {
  const result = new Map<string, ASINSalesData>()

  const byAsin = (
    (data?.salesAndTrafficByAsin as Array<Record<string, unknown>>) ||
    ((data?.salesAndTrafficByDate as Record<string, unknown>)?.salesAndTrafficByAsin as Array<Record<string, unknown>>) ||
    []
  )

  console.log(`[Sales Report] Found ${byAsin.length} ASIN entries in report`)

  for (const entry of byAsin) {
    const asin = (entry.childAsin as string) || (entry.parentAsin as string) || ''
    if (!asin || (asinFilter.size > 0 && !asinFilter.has(asin))) continue

    const sales = (entry.salesByAsin || {}) as Record<string, unknown>
    const traffic = (entry.trafficByAsin || {}) as Record<string, unknown>

    const existing = result.get(asin)
    const unitsOrdered = (sales.unitsOrdered as number) || 0
    const revenue = parseFloat(String((sales.orderedProductSales as Record<string, unknown>)?.amount || 0))
    const sessions = (traffic.sessions as number) || 0
    const buyBox = parseFloat(String(traffic.buyBoxPercentage || 0))
    const conversion = parseFloat(String(traffic.unitSessionPercentage || 0))

    if (existing) {
      existing.units_ordered_fba += unitsOrdered
      existing.ordered_product_sales += revenue
      existing.sessions += sessions
    } else {
      result.set(asin, {
        asin,
        units_ordered_fba: unitsOrdered,
        units_ordered_fbm: 0,
        ordered_product_sales: revenue,
        sessions,
        buy_box_percentage: buyBox,
        unit_session_percentage: conversion,
      })
    }
  }

  console.log(`[Sales Report] Parsed ${result.size} ASIN records`)
  return result
}

/**
 * Pair FBA and FBM ASINs by matching parent ASIN or SKU base pattern.
 * Returns a map of FBM ASIN → FBA ASIN (or null if no FBA twin exists).
 */
export function pairFBAFBMProducts(products: CatalogProduct[]): Map<string, string | null> {
  const fbmProducts = products.filter(p => p.fulfillment_channel === 'MFN')
  const fbaProducts = products.filter(p => p.fulfillment_channel === 'AFN')

  const pairMap = new Map<string, string | null>()

  for (const fbm of fbmProducts) {
    let fbaMatch: CatalogProduct | undefined

    // Method 1: Match by parent ASIN
    if (fbm.parent_asin) {
      fbaMatch = fbaProducts.find(f => f.parent_asin === fbm.parent_asin)
    }

    // Method 2: Match by SKU base (strip channel suffix like -FBA, -MFN, etc.)
    if (!fbaMatch) {
      const skuBase = fbm.sku.replace(/[-_](FBA|MFN|AFN|FBM|PRIME|AMZ)$/i, '').toLowerCase()
      fbaMatch = fbaProducts.find(f => {
        const fbaBase = f.sku.replace(/[-_](FBA|MFN|AFN|FBM|PRIME|AMZ)$/i, '').toLowerCase()
        return fbaBase === skuBase && fbaBase.length > 3
      })
    }

    // Method 3: Match by ASIN directly (same ASIN, different fulfillment channel)
    if (!fbaMatch) {
      fbaMatch = fbaProducts.find(f => f.asin === fbm.asin)
    }

    pairMap.set(fbm.asin, fbaMatch?.asin || null)
  }

  return pairMap
}

/**
 * Legacy full-catalog fetch — kept for compatibility but not used in FBA Intelligence.
 * @deprecated Use fetchFBAInventoryForAsins instead.
 */
export async function fetchFBAInventory(): Promise<FBAInventoryItem[]> {
  return fetchFBAInventoryForAsins([])
}
