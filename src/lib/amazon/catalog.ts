/**
 * Amazon SP-API Catalog & FBA Inventory Sync
 * Fetches merchant listings and FBA inventory data.
 */

import { getAccessToken } from './auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

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

/**
 * Fetch all merchant listings (both AFN and MFN) using the Reports API.
 * Uses GET_MERCHANT_LISTINGS_ALL_DATA report type.
 */
export async function fetchMerchantListings(): Promise<CatalogProduct[]> {
  const token = await getAccessToken()

  // Step 1: Request the report
  const reportResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports`, {
    method: 'POST',
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
      marketplaceIds: [MARKETPLACE_ID],
    }),
  })

  if (!reportResp.ok) {
    const err = await reportResp.text()
    throw new Error(`Failed to request merchant listings report: ${err}`)
  }

  const { reportId } = await reportResp.json()
  console.log(`[Catalog] Requested report: ${reportId}`)

  // Step 2: Poll for report completion (max 3 minutes)
  let reportDocumentId: string | null = null
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 5000)) // wait 5s between polls

    const statusResp = await fetch(`${ENDPOINT}/reports/2021-06-30/reports/${reportId}`, {
      headers: { 'x-amz-access-token': token },
    })

    if (!statusResp.ok) continue

    const status = await statusResp.json()
    console.log(`[Catalog] Report status: ${status.processingStatus}`)

    if (status.processingStatus === 'DONE') {
      reportDocumentId = status.reportDocumentId
      break
    }
    if (status.processingStatus === 'FATAL' || status.processingStatus === 'CANCELLED') {
      throw new Error(`Report failed with status: ${status.processingStatus}`)
    }
  }

  if (!reportDocumentId) {
    throw new Error('Merchant listings report timed out after 3 minutes')
  }

  // Step 3: Get the report document URL
  const docResp = await fetch(`${ENDPOINT}/reports/2021-06-30/documents/${reportDocumentId}`, {
    headers: { 'x-amz-access-token': token },
  })

  if (!docResp.ok) {
    throw new Error(`Failed to get report document: ${await docResp.text()}`)
  }

  const { url } = await docResp.json()

  // Step 4: Download the report (tab-delimited text)
  const dataResp = await fetch(url)
  if (!dataResp.ok) {
    throw new Error(`Failed to download report data`)
  }

  const tsv = await dataResp.text()
  return parseMerchantListingsTSV(tsv)
}

/**
 * Parse the GET_MERCHANT_LISTINGS_ALL_DATA TSV report into CatalogProduct objects.
 */
function parseMerchantListingsTSV(tsv: string): CatalogProduct[] {
  const lines = tsv.trim().split('\n')
  if (lines.length < 2) return []

  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'))
  const products: CatalogProduct[] = []

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim() })

    // Skip rows without ASIN
    const asin = row['asin1'] || row['asin'] || ''
    if (!asin) continue

    const channel = (row['fulfillment_channel'] || '').toUpperCase()
    const fulfillment_channel: 'AFN' | 'MFN' = channel === 'AMAZON' || channel === 'AFN' ? 'AFN' : 'MFN'

    const priceStr = row['price'] || row['your_price'] || ''
    const price = priceStr ? parseFloat(priceStr) : null

    const qtyStr = row['quantity'] || row['available_quantity'] || '0'
    const quantity = parseInt(qtyStr, 10) || 0

    products.push({
      asin,
      sku: row['seller_sku'] || row['sku'] || '',
      title: row['item_name'] || row['item_description'] || '',
      fulfillment_channel,
      status: row['status'] || 'Active',
      parent_asin: row['parent_asin'] || null,
      item_name: row['item_name'] || null,
      price: isNaN(price as number) ? null : price,
      quantity,
      image_url: row['image_url'] || null,
      raw_data: row as unknown as Record<string, unknown>,
    })
  }

  console.log(`[Catalog] Parsed ${products.length} listings (${products.filter(p => p.fulfillment_channel === 'AFN').length} FBA, ${products.filter(p => p.fulfillment_channel === 'MFN').length} FBM)`)
  return products
}

/**
 * Fetch FBA inventory summary using the FBA Inventory API.
 */
export async function fetchFBAInventory(): Promise<FBAInventoryItem[]> {
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
      // 403 means no FBA inventory — return empty
      if (resp.status === 403 || resp.status === 404) {
        console.warn('[FBA Inventory] No access or no inventory:', err)
        return []
      }
      throw new Error(`FBA inventory API error: ${err}`)
    }

    const data = await resp.json()
    const summaries = data?.payload?.inventorySummaries || []

    for (const item of summaries) {
      const inv = item.inventoryDetails || {}
      const fulfillable = inv.fulfillableQuantity || 0
      const reserved = (inv.reservedQuantity?.totalReservedQuantity) || 0
      const inbound = (inv.inboundWorkingQuantity || 0) + (inv.inboundShippedQuantity || 0) + (inv.inboundReceivingQuantity || 0)

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

  console.log(`[FBA Inventory] Fetched ${items.length} FBA inventory records`)
  return items
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
