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
  qty_inbound_total: number          // Sum of all inbound
  qty_reserved: number               // Total reserved quantity
  // Sales velocity
  units_sold_last_7_days: number
  units_sold_last_30_days: number
  units_sold_last_60_days: number
  units_sold_last_90_days: number
  // Excess / overstock data
  is_excess: boolean
  excess_qty: number
  days_of_supply: number             // Amazon's direct days-of-supply
  days_of_supply_with_inbound: number // Including open shipments
  historical_days_of_supply: number
  weeks_of_cover_t30: number
  weeks_of_cover_t90: number
  recommended_action: string         // Amazon's raw recommendation string
  // Storage costs (from Amazon's report)
  estimated_monthly_storage_fee: number   // USD
  estimated_storage_cost_per_unit: number // USD per unit
  // Pricing
  your_price: number
  sales_price: number | null
  featured_offer_price: number
  // Inventory health
  fba_inventory_level_health: string // Healthy, Excess, etc.
  // Flags
  alert: string                      // e.g. "Excess inventory", "Low traffic", etc.
  // Age breakdown
  inv_age_0_to_90: number
  inv_age_91_to_180: number
  inv_age_181_to_270: number
  inv_age_271_to_365: number
  inv_age_366_plus: number
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

  // Map column indices — using exact column names from GET_FBA_INVENTORY_PLANNING_DATA
  const iSku = col('sku')
  const iFnsku = col('fnsku')
  const iAsin = col('asin')
  const iProductName = col('product-name')
  const iCondition = col('condition')
  const iYourPrice = col('your-price')
  const iSalesPrice = col('sales-price')
  const iFeaturedOfferPrice = col('featuredoffer-price')
  // Inventory quantities — report uses 'available' (not afn-fulfillable-quantity)
  const iAvailable = col('available')
  const iInboundQuantity = col('inbound-quantity')
  const iInboundWorking = col('inbound-working')
  const iInboundShipped = col('inbound-shipped')
  const iInboundReceived = col('inbound-received')
  const iReserved = col('total reserved quantity')
  // Sales velocity — report uses units-shipped-tN columns
  const iUnits7d = col('units-shipped-t7')
  const iUnits30d = col('units-shipped-t30')
  const iUnits60d = col('units-shipped-t60')
  const iUnits90d = col('units-shipped-t90')
  // Also check sales-shipped columns (alternate names)
  const iSales7d = col('sales-shipped-last-7-days')
  const iSales30d = col('sales-shipped-last-30-days')
  const iSales60d = col('sales-shipped-last-60-days')
  const iSales90d = col('sales-shipped-last-90-days')
  // Excess / overstock
  const iAlert = col('alert')
  const iExcessQty = col('estimated-excess-quantity')
  const iDaysOfSupply = col('days-of-supply')
  const iTotalDaysOfSupply = col('total days of supply (including units from open shipments)')
  const iHistoricalDaysOfSupply = col('historical-days-of-supply')
  const iWeeksCoverT30 = col('weeks-of-cover-t30')
  const iWeeksCoverT90 = col('weeks-of-cover-t90')
  const iRecommendedAction = col('recommended-action')
  const iHealthStatus = col('fba-inventory-level-health-status')
  // Storage costs
  const iEstMonthlyStorage = col('estimated-storage-cost-next-month')
  // Age breakdown
  const iAge0to90 = col('inv-age-0-to-90-days')
  const iAge91to180 = col('inv-age-91-to-180-days')
  const iAge181to270 = col('inv-age-181-to-270-days')
  const iAge271to365 = col('inv-age-271-to-365-days')
  const iAge366to455 = col('inv-age-366-to-455-days')
  const iAge456plus = col('inv-age-456-plus-days')

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
      alertText.toLowerCase().includes('overstock') ||
      recommendedAction.toLowerCase().includes('sale') ||
      recommendedAction.toLowerCase().includes('outlet') ||
      recommendedAction.toLowerCase().includes('remov')

    // Use Amazon's direct days-of-supply (preferred) or fall back to weeks-of-cover * 7
    const directDaysOfSupply = parseNum(cols[iDaysOfSupply])
    const weeksOfCoverT30 = parseNum(cols[iWeeksCoverT30])
    const daysOfSupply = directDaysOfSupply > 0
      ? directDaysOfSupply
      : (weeksOfCoverT30 > 0 ? Math.round(weeksOfCoverT30 * 7) : 0)

    const qtyAvailable = parseNum(cols[iAvailable])
    const inboundWorking = parseNum(cols[iInboundWorking])
    const inboundShipped = parseNum(cols[iInboundShipped])
    const inboundReceived = parseNum(cols[iInboundReceived])
    const inboundTotal = parseNum(cols[iInboundQuantity]) || (inboundWorking + inboundShipped + inboundReceived)

    // Units sold — try units-shipped-tN first, then sales-shipped-last-N-days
    const unitsSold7d = parseNum(cols[iUnits7d]) || parseNum(cols[iSales7d])
    const unitsSold30d = parseNum(cols[iUnits30d]) || parseNum(cols[iSales30d])
    const unitsSold60d = parseNum(cols[iUnits60d]) || parseNum(cols[iSales60d])
    const unitsSold90d = parseNum(cols[iUnits90d]) || parseNum(cols[iSales90d])

    // Storage cost per unit estimate
    const monthlyStorage = parseNum(cols[iEstMonthlyStorage])
    const storageCostPerUnit = qtyAvailable > 0 ? monthlyStorage / qtyAvailable : 0

    // Age breakdown
    const age0to90 = parseNum(cols[iAge0to90])
    const age91to180 = parseNum(cols[iAge91to180])
    const age181to270 = parseNum(cols[iAge181to270])
    const age271to365 = parseNum(cols[iAge271to365])
    const age366plus = parseNum(cols[iAge366to455]) + parseNum(cols[iAge456plus])

    const item: InventoryHealthItem = {
      asin,
      sku,
      fnsku: cols[iFnsku]?.trim() || '',
      product_name: cols[iProductName]?.trim() || '',
      condition: cols[iCondition]?.trim() || 'New',
      qty_available: qtyAvailable,
      qty_inbound_working: inboundWorking,
      qty_inbound_shipped: inboundShipped,
      qty_inbound_receiving: inboundReceived,
      qty_inbound_total: inboundTotal,
      qty_reserved: parseNum(cols[iReserved]),
      units_sold_last_7_days: unitsSold7d,
      units_sold_last_30_days: unitsSold30d,
      units_sold_last_60_days: unitsSold60d,
      units_sold_last_90_days: unitsSold90d,
      is_excess: isExcess,
      excess_qty: excessQty,
      days_of_supply: daysOfSupply,
      days_of_supply_with_inbound: parseNum(cols[iTotalDaysOfSupply]),
      historical_days_of_supply: parseNum(cols[iHistoricalDaysOfSupply]),
      weeks_of_cover_t30: weeksOfCoverT30,
      weeks_of_cover_t90: parseNum(cols[iWeeksCoverT90]),
      recommended_action: recommendedAction,
      estimated_monthly_storage_fee: monthlyStorage,
      estimated_storage_cost_per_unit: storageCostPerUnit,
      your_price: parseNum(cols[iYourPrice]),
      sales_price: iSalesPrice >= 0 ? parseNum(cols[iSalesPrice]) : null,
      featured_offer_price: parseNum(cols[iFeaturedOfferPrice]),
      fba_inventory_level_health: cols[iHealthStatus]?.trim() || '',
      alert: alertText,
      inv_age_0_to_90: age0to90,
      inv_age_91_to_180: age91to180,
      inv_age_181_to_270: age181to270,
      inv_age_271_to_365: age271to365,
      inv_age_366_plus: age366plus,
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
