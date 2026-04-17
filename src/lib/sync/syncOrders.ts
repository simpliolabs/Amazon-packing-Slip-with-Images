/**
 * Order Sync Service
 * Fetches FBM orders from Amazon SP-API and stores them in Supabase
 * Handles image caching in Supabase Storage
 */

import { createClient } from '@supabase/supabase-js'
import { fetchFBMOrders, fetchOrderItems, fetchProductImage } from '@/lib/amazon/orders'
import type { OrderItem, ShipTo } from '@/types/database'

// Use service role for sync operations (bypasses RLS)
function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/**
 * Cache a product image in Supabase Storage
 * Returns the cached URL or the original URL as fallback
 */
async function cacheProductImage(
  supabase: ReturnType<typeof getAdminSupabase>,
  asin: string,
  imageUrl: string
): Promise<string> {
  try {
    const filePath = `${asin}.jpg`

    // Check if already cached
    const { data: existing } = await supabase.storage
      .from('product-images')
      .list('', { search: asin })

    if (existing && existing.length > 0) {
      const { data: urlData } = supabase.storage
        .from('product-images')
        .getPublicUrl(filePath)
      return urlData.publicUrl
    }

    // Download and cache the image
    const imgResponse = await fetch(imageUrl)
    if (!imgResponse.ok) {
      console.warn(`Failed to download image for ${asin}, using direct URL`)
      return imageUrl
    }

    const imgBuffer = await imgResponse.arrayBuffer()
    const { error } = await supabase.storage
      .from('product-images')
      .upload(filePath, imgBuffer, {
        contentType: 'image/jpeg',
        upsert: true,
      })

    if (error) {
      console.warn(`Failed to cache image for ${asin}: ${error.message}, using direct URL`)
      return imageUrl
    }

    const { data: urlData } = supabase.storage
      .from('product-images')
      .getPublicUrl(filePath)

    return urlData.publicUrl
  } catch (err) {
    console.warn(`Image caching error for ${asin}:`, err)
    return imageUrl
  }
}

export interface SyncResult {
  success: boolean
  ordersProcessed: number
  ordersInserted: number
  error?: string
}

/**
 * Main sync function — fetches all FBM orders from last 7 days
 * and upserts them into Supabase
 */
export async function syncOrders(): Promise<SyncResult> {
  const supabase = getAdminSupabase()
  let syncLogId: string | undefined

  try {
    // Create sync log entry
    const { data: syncLog } = await supabase
      .from('sync_logs')
      .insert({ status: 'running' })
      .select('id')
      .single()

    syncLogId = syncLog?.id

    // Fetch orders from last 7 days
    const createdAfter = new Date()
    createdAfter.setDate(createdAfter.getDate() - 7)

    const amazonOrders = await fetchFBMOrders(createdAfter)
    let ordersInserted = 0

    for (const order of amazonOrders) {
      try {
        // Fetch order items
        const items = await fetchOrderItems(order.AmazonOrderId)

        // Fetch and cache product images
        const orderItems: OrderItem[] = await Promise.all(
          items.map(async (item) => {
            let imageUrl: string | null = null

            // Try to get image from Amazon Catalog API
            const fetchedUrl = await fetchProductImage(item.ASIN)
            if (fetchedUrl) {
              imageUrl = await cacheProductImage(supabase, item.ASIN, fetchedUrl)
            }

            return {
              asin: item.ASIN,
              sku: item.SellerSKU || '',
              title: item.Title || 'Unknown Product',
              qty: item.QuantityOrdered,
              image_url: imageUrl,
              price: item.ItemPrice?.Amount,
              order_item_id: item.OrderItemId,
            }
          })
        )

        // Build ship_to address
        const addr = order.ShippingAddress
        const shipTo: ShipTo | null = addr
          ? {
              name: addr.Name || order.BuyerInfo?.BuyerName || 'Customer',
              addressLine1: addr.AddressLine1 || '',
              addressLine2: addr.AddressLine2,
              city: addr.City || '',
              stateOrRegion: addr.StateOrRegion || '',
              postalCode: addr.PostalCode || '',
              countryCode: addr.CountryCode || 'US',
              phone: addr.Phone,
            }
          : null

        // Upsert order into Supabase
        const { error } = await supabase.from('orders').upsert(
          {
            id: order.AmazonOrderId,
            purchase_date: order.PurchaseDate,
            buyer_name: order.BuyerInfo?.BuyerName || null,
            buyer_email: order.BuyerInfo?.BuyerEmail || null,
            ship_to: shipTo,
            order_items: orderItems,
            fulfillment_channel: order.FulfillmentChannel,
            order_status: order.OrderStatus,
            raw_data: order as unknown as Record<string, unknown>,
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        )

        if (!error) ordersInserted++
      } catch (itemError) {
        console.error(`Error processing order ${order.AmazonOrderId}:`, itemError)
      }
    }

    // Update sync log as success
    if (syncLogId) {
      await supabase
        .from('sync_logs')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
          orders_synced: ordersInserted,
        })
        .eq('id', syncLogId)
    }

    return {
      success: true,
      ordersProcessed: amazonOrders.length,
      ordersInserted,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    // Update sync log as error
    if (syncLogId) {
      const supabase = getAdminSupabase()
      await supabase
        .from('sync_logs')
        .update({
          status: 'error',
          completed_at: new Date().toISOString(),
          error_message: errorMessage,
        })
        .eq('id', syncLogId)
    }

    return {
      success: false,
      ordersProcessed: 0,
      ordersInserted: 0,
      error: errorMessage,
    }
  }
}
