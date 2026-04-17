/**
 * Amazon SP-API Orders Integration
 * Uses Orders API v0 to fetch FBM orders
 */

import { getAccessToken } from './auth'

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
}

/**
 * Fetch FBM orders created after a given date
 * Uses Orders API v0
 */
export async function fetchFBMOrders(createdAfter: Date): Promise<AmazonOrder[]> {
  const orders: AmazonOrder[] = []
  let nextToken: string | undefined

  do {
    const params = new URLSearchParams({
      MarketplaceIds: MARKETPLACE_ID,
      FulfillmentChannels: 'MFN',
      CreatedAfter: createdAfter.toISOString(),
      OrderStatuses: 'Unshipped',
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
 * Fetch product image from Catalog Items API v2022-04-01
 * Returns the first available medium image URL
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

    // Find MAIN image variant
    for (const imageGroup of images) {
      const variants = imageGroup.images || []
      const mainImage = variants.find(
        (v: { variant: string; link: string }) => v.variant === 'MAIN'
      )
      if (mainImage?.link) return mainImage.link

      // Fallback to first image
      if (variants[0]?.link) return variants[0].link
    }

    return null
  } catch {
    return null
  }
}
