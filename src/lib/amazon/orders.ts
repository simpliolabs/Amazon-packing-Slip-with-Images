/**
 * Amazon SP-API Orders Integration
 * Uses Orders API v0 to fetch FBM orders
 */

import { getAccessToken, getRestrictedDataToken } from './auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

// Rate limiting: 1 request per 2 seconds
let lastRequestTime = 0
async function rateLimit() {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < 2000) {
    await new Promise((r) => setTimeout(r, 2000 - elapsed))
  }
  lastRequestTime = Date.now()
}

async function spApiRequest(path: string, method = 'GET', body?: unknown) {
  await rateLimit()
  const accessToken = await getAccessToken()

  const url = `${ENDPOINT}${path}`
  const response = await fetch(url, {
    method,
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`SP-API error ${response.status} for ${path}: ${errorText}`)
  }

  return response.json()
}

export interface AmazonOrder {
  AmazonOrderId: string
  PurchaseDate: string
  BuyerInfo?: {
    BuyerName?: string
    BuyerEmail?: string
  }
  ShippingAddress?: {
    Name?: string
    AddressLine1?: string
    AddressLine2?: string
    City?: string
    StateOrRegion?: string
    PostalCode?: string
    CountryCode?: string
    Phone?: string
  }
  OrderStatus: string
  FulfillmentChannel: string
  NumberOfItemsShipped?: number
  NumberOfItemsUnshipped?: number
  OrderTotal?: {
    CurrencyCode: string
    Amount: string
  }
}

export interface AmazonOrderItem {
  ASIN: string
  SellerSKU: string
  Title: string
  QuantityOrdered: number
  QuantityShipped: number
  ItemPrice?: {
    CurrencyCode: string
    Amount: string
  }
  OrderItemId: string
  BuyerInfo?: {
    BuyerCustomizedInfo?: {
      CustomizedURL?: string
    }
  }
}

/**
 * Fetch FBM orders created after a given date.
 * Fetches Unshipped, PartiallyShipped, and Shipped statuses
 * so that order status updates are reflected in the app.
 * Uses Orders API v0.
 */
export async function fetchFBMOrders(createdAfter: Date): Promise<AmazonOrder[]> {
  const orders: AmazonOrder[] = []
  let nextToken: string | undefined

  do {
    const params = new URLSearchParams({
      MarketplaceIds: MARKETPLACE_ID,
      FulfillmentChannels: 'MFN',
      CreatedAfter: createdAfter.toISOString(),
      OrderStatuses: 'Unshipped,PartiallyShipped,Shipped',
    })

    if (nextToken) {
      params.set('NextToken', nextToken)
    }

    const data = await spApiRequest(
      `/orders/v0/orders?${params.toString()}`
    )

    const payload = data.payload || data
    const ordersList = payload.Orders || []
    orders.push(...ordersList)
    nextToken = payload.NextToken
  } while (nextToken)

  return orders
}

/**
 * Fetch items for a specific order
 */
export async function fetchOrderItems(orderId: string): Promise<AmazonOrderItem[]> {
  const items: AmazonOrderItem[] = []
  let nextToken: string | undefined

  do {
    const params = nextToken ? `?NextToken=${encodeURIComponent(nextToken)}` : ''
    const data = await spApiRequest(
      `/orders/v0/orders/${orderId}/orderItems${params}`
    )

    const payload = data.payload || data
    items.push(...(payload.OrderItems || []))
    nextToken = payload.NextToken
  } while (nextToken)

  return items
}

/**
 * Fetch full shipping address for a specific order using RDT.
 * Returns null if PII access is not available.
 */
export async function fetchOrderAddress(
  orderId: string
): Promise<AmazonOrder['ShippingAddress'] | null> {
  try {
    const rdt = await getRestrictedDataToken([
      {
        method: 'GET',
        path: `/orders/v0/orders/${orderId}`,
        dataElements: ['buyerInfo', 'shippingAddress'],
      },
    ])

    if (!rdt) return null

    await rateLimit()
    const url = `${ENDPOINT}/orders/v0/orders/${orderId}`
    const response = await fetch(url, {
      headers: {
        'x-amz-access-token': rdt,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) return null

    const data = await response.json()
    const order = data.payload || data
    return order.ShippingAddress || null
  } catch (err) {
    console.warn(`Failed to fetch address for order ${orderId}:`, err)
    return null
  }
}

/**
 * Fetch buyer info for a specific order using RDT.
 * Returns null if PII access is not available.
 */
export async function fetchOrderBuyerInfo(
  orderId: string
): Promise<AmazonOrder['BuyerInfo'] | null> {
  try {
    const rdt = await getRestrictedDataToken([
      {
        method: 'GET',
        path: `/orders/v0/orders/${orderId}/buyerInfo`,
        dataElements: ['buyerInfo'],
      },
    ])

    if (!rdt) return null

    await rateLimit()
    const url = `${ENDPOINT}/orders/v0/orders/${orderId}/buyerInfo`
    const response = await fetch(url, {
      headers: {
        'x-amz-access-token': rdt,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) return null

    const data = await response.json()
    const payload = data.payload || data
    return {
      BuyerName: payload.BuyerName,
      BuyerEmail: payload.BuyerEmail,
    }
  } catch (err) {
    console.warn(`Failed to fetch buyer info for order ${orderId}:`, err)
    return null
  }
}

/**
 * Fetch order items WITH buyer customization info.
 * Uses TWO endpoints:
 *   1. getOrderItems → /orders/v0/orders/{orderId}/orderItems (product details)
 *   2. getOrderItemsBuyerInfo → /orders/v0/orders/{orderId}/orderItems/buyerInfo (customization)
 * Merges BuyerCustomizedInfo from endpoint 2 into items from endpoint 1.
 */
export async function fetchOrderItemsWithBuyerInfo(
  orderId: string
): Promise<AmazonOrderItem[]> {
  // First, get the regular order items (product details, SKU, ASIN, etc.)
  const items = await fetchOrderItems(orderId)

  // Then, try to get buyer info (customization) from the separate endpoint
  try {
    // Try without dataElements first (the /orderItems/buyerInfo endpoint
    // is a separate deprecated endpoint that may not need dataElements)
    let rdt = await getRestrictedDataToken([
      {
        method: 'GET',
        path: `/orders/v0/orders/${orderId}/orderItems/buyerInfo`,
      },
    ])

    // If that fails, try with dataElements (requires Tax remittance/invoicing role)
    if (!rdt) {
      console.log(`[Customization] Trying with dataElements for ${orderId}`)
      rdt = await getRestrictedDataToken([
        {
          method: 'GET',
          path: `/orders/v0/orders/${orderId}/orderItems/buyerInfo`,
          dataElements: ['buyerInfo'],
        },
      ])
    }

    if (!rdt) {
      console.warn(`No RDT for orderItems/buyerInfo on ${orderId}`)
      return items
    }

    await rateLimit()
    const url = `${ENDPOINT}/orders/v0/orders/${orderId}/orderItems/buyerInfo`
    const response = await fetch(url, {
      headers: {
        'x-amz-access-token': rdt,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      const errText = await response.text()
      console.warn(`orderItems/buyerInfo fetch failed (${response.status}) for ${orderId}: ${errText}`)
      return items
    }

    const data = await response.json()
    const payload = data.payload || data
    const buyerInfoItems = payload.OrderItems || []

    // Merge BuyerCustomizedInfo into the main items by OrderItemId
    for (const biItem of buyerInfoItems) {
      const match = items.find(i => i.OrderItemId === biItem.OrderItemId)
      if (match && biItem.BuyerCustomizedInfo) {
        match.BuyerInfo = {
          BuyerCustomizedInfo: biItem.BuyerCustomizedInfo,
        }
        console.log(`[Customization] Found CustomizedURL for item ${match.OrderItemId} on order ${orderId}`)
      }
    }

    return items
  } catch (err) {
    console.warn(`Failed to fetch orderItems/buyerInfo for ${orderId}:`, err)
    return items
  }
}

/**
 * Download and parse the customization ZIP from Amazon's CustomizedURL.
 * Returns parsed customization data or null if unavailable.
 */
export async function fetchCustomizationFromZip(
  customizedUrl: string
): Promise<import('@/types/database').CustomizationData | null> {
  try {
    if (!customizedUrl) return null

    const response = await fetch(customizedUrl)
    if (!response.ok) {
      console.warn(`Failed to download customization ZIP: ${response.status}`)
      return null
    }

    const buffer = await response.arrayBuffer()
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(buffer)

    // Find JSON files in the ZIP
    const jsonFiles = Object.keys(zip.files).filter(
      (name) => name.endsWith('.json') && !zip.files[name].dir
    )

    if (jsonFiles.length === 0) {
      // Try to find any text file
      const textFiles = Object.keys(zip.files).filter(
        (name) => !zip.files[name].dir
      )
      if (textFiles.length === 0) return null

      const content = await zip.files[textFiles[0]].async('string')
      try {
        const parsed = JSON.parse(content)
        return parseCustomizationJson(parsed)
      } catch {
        console.warn('Customization file is not valid JSON')
        return null
      }
    }

    // Parse the first JSON file
    const content = await zip.files[jsonFiles[0]].async('string')
    const parsed = JSON.parse(content)
    return parseCustomizationJson(parsed)
  } catch (err) {
    console.warn('Error parsing customization ZIP:', err)
    return null
  }
}

/**
 * Parse the raw customization JSON into our structured format.
 * Amazon's format varies, so we handle multiple structures.
 */
function parseCustomizationJson(
  data: Record<string, unknown>
): import('@/types/database').CustomizationData {
  const surfaces: import('@/types/database').CustomizationSurface[] = []

  // Format 1: { version: "3.0", surfaces: [{ name, areas: [{ customizationType, ... }] }] }
  if (data.version && Array.isArray(data.surfaces)) {
    for (const surface of data.surfaces as Array<Record<string, unknown>>) {
      const options: Record<string, string> = {}
      const areas = (surface.areas || surface.customizations || []) as Array<Record<string, unknown>>

      for (const area of areas) {
        const type = String(area.customizationType || area.type || '')
        if (area.text) options['Text'] = String(area.text)
        if (area.fontFamily) options['Font Text'] = String(area.fontFamily)
        if (area.fontColor || area.color) {
          const color = String(area.fontColor || area.color || '')
          options['Text Color'] = color
        }
        if (area.name && area.value) {
          options[String(area.name)] = String(area.value)
        }
        if (type && !options['Type']) options['Type'] = type
      }

      if (Object.keys(options).length > 0) {
        surfaces.push({
          label: String(surface.name || surface.label || `Surface ${surfaces.length + 1}`),
          options,
        })
      }
    }
  }

  // Metadata keys that should never appear in customization display
  const METADATA_KEYS = new Set([
    'version', 'customizationId', 'ASIN', 'asin',
    'TITLE', 'title', 'ORDERID', 'orderId', 'OrderId',
    'QUANTITY', 'quantity', 'Quantity',
    'MERCHANTID', 'merchantId', 'MerchantId',
    'ORDERITEMID', 'orderItemId', 'OrderItemId',
    'MARKETPLACEID', 'marketplaceId', 'MarketplaceId',
    'SKU', 'sku', 'FNSKU', 'fnsku',
  ])

  // Format 2: Flat key-value pairs
  if (surfaces.length === 0) {
    const options: Record<string, string> = {}
    for (const [key, value] of Object.entries(data)) {
      if (METADATA_KEYS.has(key)) continue
      if (typeof value === 'string' || typeof value === 'number') {
        options[key] = String(value)
      }
    }
    if (Object.keys(options).length > 0) {
      surfaces.push({ label: 'Customization', options })
    }
  }

  return { surfaces, raw: data }
}

/**
 * Fetch product image from Catalog Items API v2022-04-01
 * Returns the largest available MAIN image URL (prefers 1000px+)
 */
export async function fetchProductImage(asin: string): Promise<string | null> {
  try {
    await rateLimit()
    const accessToken = await getAccessToken()

    const params = new URLSearchParams({
      marketplaceIds: MARKETPLACE_ID,
      includedData: 'images',
    })

    const url = `${ENDPOINT}/catalog/2022-04-01/items/${asin}?${params.toString()}`
    const response = await fetch(url, {
      headers: {
        'x-amz-access-token': accessToken,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) return null

    const data = await response.json()
    const images = data.images || []

    // Find the largest MAIN image variant
    for (const imageGroup of images) {
      const variants = imageGroup.images || []
      // Filter to MAIN variants and sort by size (largest first)
      const mainImages = variants
        .filter((v: { variant: string; link: string; height?: number; width?: number }) => v.variant === 'MAIN')
        .sort((a: { height?: number }, b: { height?: number }) => (b.height || 0) - (a.height || 0))

      if (mainImages.length > 0 && mainImages[0].link) return mainImages[0].link

      // Fallback: pick the largest image of any variant
      const sorted = [...variants].sort(
        (a: { height?: number }, b: { height?: number }) => (b.height || 0) - (a.height || 0)
      )
      if (sorted[0]?.link) return sorted[0].link
    }

    return null
  } catch {
    return null
  }
}
