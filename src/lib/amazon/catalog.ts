/**
 * Amazon SP-API FBA Intelligence Data Fetchers
 *
 * Orders-driven approach:
 * 1. Get unique ASINs from existing orders (no full catalog dump)
 * 2. Fetch FBA inventory ONLY for those ASINs
 * 3. Fetch Sales & Traffic Report for FBA sales data
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
 * Fetch FBA inventory ONLY for the given list of ASINs.
 * Much more targeted than fetching the full catalog.
 */
export async function fetchFBAInventoryForAsins(asins: string[]): Promise<FBAInventoryItem[]> {
  if (asins.length === 0) return []

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

    const resp = await fetch(`${ENDPOINT}/fba/inventory/v1/summaries?${params}`, {
      headers: { 'x-amz-access-token': token },
    })

    if (!resp.ok) {
      const err = await resp.text()
      if (resp.status === 403 || resp.status === 404) {
        console.warn('[FBA Inventory] No access or no inventory:', err)
        return []
      }
      throw new Error(`FBA inventory API error (${resp.status}): ${err}`)
    }

    const data = await resp.json()
    const summaries = data?.payload?.inventorySummaries || []

    // Filter to only the ASINs we care about
    const asinSet = new Set(asins)
    for (const item of summaries) {
      if (!asinSet.has(item.asin)) continue

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

  console.log(`[FBA Inventory] Fetched ${items.length} records for ${asins.length} requested ASINs`)
  return items
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
    const err = await reportResp.text()
    console.warn('[Sales Report] Failed to request report:', err)
    return new Map()
  }

  const { reportId } = await reportResp.json()
  console.log(`[Sales Report] Requested report: ${reportId}`)

  // Poll for completion (max 4 minutes, 5s intervals)
  let reportDocumentId: string | null = null
  for (let i = 0; i < 48; i++) {
    await new Promise(r => setTimeout(r, 5000))

    const statusResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports/${reportId}`, {
      headers: { 'x-amz-access-token': token },
    })

    if (!statusResp.ok) continue

    const status = await statusResp.json()
    console.log(`[Sales Report] Status: ${status.processingStatus}`)

    if (status.processingStatus === 'DONE') {
      reportDocumentId = status.reportDocumentId
      break
    }
    if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
      console.warn(`[Sales Report] Report failed: ${status.processingStatus}`)
      return new Map()
    }
  }

  if (!reportDocumentId) {
    console.warn('[Sales Report] Timed out waiting for report')
    return new Map()
  }

  // Get document URL
  const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${reportDocumentId}`, {
    headers: { 'x-amz-access-token': token },
  })

  if (!docResp.ok) {
    console.warn('[Sales Report] Failed to get document URL')
    return new Map()
  }

  const { url } = await docResp.json()

  // Download and parse the JSON report
  const dataResp = await fetch(url)
  if (!dataResp.ok) {
    console.warn('[Sales Report] Failed to download report data')
    return new Map()
  }

  const reportData = await dataResp.json()
  return parseSalesAndTrafficReport(reportData, new Set(asins))
}

/**
 * Parse the Sales & Traffic JSON report into a map of ASIN → sales data.
 */
function parseSalesAndTrafficReport(
  data: Record<string, unknown>,
  asinFilter: Set<string>
): Map<string, ASINSalesData> {
  const result = new Map<string, ASINSalesData>()

  // The report has salesAndTrafficByAsin array
  const byAsin = (data?.salesAndTrafficByAsin as Array<Record<string, unknown>>) || []

  for (const entry of byAsin) {
    const asin = entry.parentAsin as string || entry.childAsin as string || ''
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
      // Aggregate multiple entries for same ASIN
      existing.units_ordered_fba += unitsOrdered
      existing.ordered_product_sales += revenue
      existing.sessions += sessions
    } else {
      result.set(asin, {
        asin,
        units_ordered_fba: unitsOrdered,
        units_ordered_fbm: 0, // filled in by caller from orders table
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
