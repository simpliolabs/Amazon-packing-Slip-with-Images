/**
 * Order Sync Service
 * Fetches FBM orders from Amazon SP-API and stores them in Supabase
 * Handles image caching in Supabase Storage
 */

import { createClient } from '@supabase/supabase-js'
import { fetchFBMOrders, fetchOrderItems, fetchOrderItemsWithBuyerInfo, fetchCustomizationFromZip, fetchProductImage, fetchOrderAddress, fetchOrderBuyerInfo } from '@/lib/amazon/orders'
import { batchDetectColors } from '@/lib/ai/detectColor'
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

    // Always download the latest image from Amazon and upsert it.
    // This ensures cached images stay up-to-date if Amazon changes
    // the product image (e.g. wrong variant was initially returned).
    const imgResponse = await fetch(imageUrl)
    if (!imgResponse.ok) {
      // If download fails, fall back to existing cached image if available
      const { data: existing } = await supabase.storage
        .from('product-images')
        .list('', { search: asin })

      if (existing && existing.length > 0) {
        const { data: urlData } = supabase.storage
          .from('product-images')
          .getPublicUrl(filePath)
        return urlData.publicUrl
      }
      console.warn(`Failed to download image for ${asin}, using direct URL`)
      return imageUrl
    }

    const imgBuffer = await imgResponse.arrayBuffer()

    // Delete existing image first (if any) to avoid stale cache
    await supabase.storage
      .from('product-images')
      .remove([filePath])

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
 * Extract a design key from a SKU for image sharing.
 * Items with the same design key are the same product in different sizes,
 * so they should share the same image.
 *
 * Examples:
 *   640002XL-WH-Soccer-Cup-TS-Germany  →  WH-Soccer-Cup-TS-Germany
 *   64000XL-WH-Soccer-Cup-TS-Germany   →  WH-Soccer-Cup-TS-Germany
 *   BTFFTW64000XL-WH                   →  BTFFTW-WH
 *   TCEO-Later-Gator-LS-L-MOS          →  TCEO-Later-Gator-MOS
 *
 * Strategy: strip size codes (XS,S,M,L,XL,2XL,...,6XL,LS,SS) and
 * embedded numeric+size patterns (e.g. 64000XL, 640002XL) to get a
 * stable key that is identical across sizes of the same design.
 */
function extractDesignKey(sku: string): string {
  if (!sku) return ''

  // Remove embedded numeric+size patterns like 640002XL, 64000XL, 64000L, 3001C etc.
  let key = sku.replace(/\d{3,}(?:2XL|3XL|4XL|5XL|6XL|XL|XS|L|M|S)/gi, '')

  // Split by dash and filter out standalone size tokens
  const sizeTokens = new Set(['XS','S','M','L','XL','2XL','3XL','4XL','5XL','6XL','LS','SS'])
  const parts = key.split('-').filter(p => !sizeTokens.has(p.toUpperCase()) && p !== '')

  return parts.join('-').toUpperCase()
}

/**
 * Main sync function — fetches all FBM orders from last 7 days
 * and upserts them into Supabase.
 *
 * Optimization: For orders that already exist in the DB and are now
 * Shipped on Amazon, we only update the status field (no need to
 * re-fetch items, images, PII). Full processing is only done for
 * new orders or orders whose status changed to something other than
 * what we already have.
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

    // Fetch existing orders from DB to determine which need full processing
    const orderIds = amazonOrders.map(o => o.AmazonOrderId)
    const { data: existingOrders } = await supabase
      .from('orders')
      .select('id, order_status')
      .in('id', orderIds)

    const existingMap = new Map<string, string>()
    if (existingOrders) {
      for (const eo of existingOrders) {
        existingMap.set(eo.id, eo.order_status || '')
      }
    }

    for (const order of amazonOrders) {
      try {
        const existingStatus = existingMap.get(order.AmazonOrderId)

        // If the order already exists and the status hasn't changed, skip entirely
        if (existingStatus === order.OrderStatus) {
          continue
        }

        // If the order already exists but status changed (e.g. Unshipped → Shipped),
        // just update the status and raw_data — no need to re-fetch items/images/PII
        if (existingStatus !== undefined) {
          const sanitizedRawData = { ...order } as Record<string, unknown>
          delete sanitizedRawData.ShippingAddress
          delete sanitizedRawData.BuyerInfo
          delete sanitizedRawData.BuyerName
          delete sanitizedRawData.BuyerEmail
          delete sanitizedRawData.DefaultShipFromLocationAddress

          const { error } = await supabase
            .from('orders')
            .update({
              order_status: order.OrderStatus,
              raw_data: sanitizedRawData,
              synced_at: new Date().toISOString(),
            })
            .eq('id', order.AmazonOrderId)

          if (!error) ordersInserted++
          continue
        }

        // New order — full processing: fetch items (with customization), images, PII
        const items = await fetchOrderItemsWithBuyerInfo(order.AmazonOrderId)

        // Fetch and cache product images
        const orderItems: OrderItem[] = await Promise.all(
          items.map(async (item) => {
            let imageUrl: string | null = null

            // Try to get image from Amazon Catalog API
            const fetchedUrl = await fetchProductImage(item.ASIN)
            if (fetchedUrl) {
              imageUrl = await cacheProductImage(supabase, item.ASIN, fetchedUrl)
            }

            // Fetch customization data if this is a custom order
            let customization = null
            const customizedUrl = item.BuyerInfo?.BuyerCustomizedInfo?.CustomizedURL
            if (customizedUrl) {
              try {
                customization = await fetchCustomizationFromZip(customizedUrl)
                if (customization) {
                  console.log(`[Customization] Fetched for ${item.ASIN} on order ${order.AmazonOrderId}`)
                }
              } catch (custErr) {
                console.warn(`[Customization] Failed for ${item.ASIN}:`, custErr)
              }
            }

            return {
              asin: item.ASIN,
              sku: item.SellerSKU || '',
              title: item.Title || 'Unknown Product',
              qty: item.QuantityOrdered,
              image_url: imageUrl,
              price: item.ItemPrice?.Amount,
              order_item_id: item.OrderItemId,
              customization,
            }
          })
        )

        // SKU-based image sharing: if multiple items share the same
        // design key (same product, different sizes), propagate the
        // first available image to all items with that design.
        const designImageMap = new Map<string, string>()
        for (const item of orderItems) {
          const dk = extractDesignKey(item.sku)
          if (dk && item.image_url && !designImageMap.has(dk)) {
            designImageMap.set(dk, item.image_url)
          }
        }
        for (const item of orderItems) {
          if (!item.image_url) {
            const dk = extractDesignKey(item.sku)
            if (dk && designImageMap.has(dk)) {
              item.image_url = designImageMap.get(dk)!
            }
          }
        }

        // AI Color Detection (Layer 2)
        // Runs after images are cached and shared. Detects garment color
        // from product images using GPT-4.1-mini vision.
        // Only calls the API for items that have an image and no cached color.
        try {
          await batchDetectColors(orderItems)
        } catch (aiError) {
          console.warn('AI color detection failed, continuing without:', aiError)
        }

        // Try to get full address via RDT (PII access)
        // Falls back to partial address from list endpoint if RDT unavailable
        let fullAddress = order.ShippingAddress
        let buyerInfo = order.BuyerInfo

        const rdtAddress = await fetchOrderAddress(order.AmazonOrderId)
        if (rdtAddress) {
          fullAddress = rdtAddress
        }

        const rdtBuyer = await fetchOrderBuyerInfo(order.AmazonOrderId)
        if (rdtBuyer) {
          buyerInfo = rdtBuyer
        }

        // Build ship_to address
        const addr = fullAddress
        const shipTo: ShipTo | null = addr
          ? {
              name: addr.Name || buyerInfo?.BuyerName || 'Customer',
              addressLine1: addr.AddressLine1 || '',
              addressLine2: addr.AddressLine2,
              city: addr.City || '',
              stateOrRegion: addr.StateOrRegion || '',
              postalCode: addr.PostalCode || '',
              countryCode: addr.CountryCode || 'US',
              phone: addr.Phone,
            }
          : null

        // Strip PII from raw_data before storage (DPP compliance)
        const sanitizedRawData = { ...order } as Record<string, unknown>
        delete sanitizedRawData.ShippingAddress
        delete sanitizedRawData.BuyerInfo
        delete sanitizedRawData.BuyerName
        delete sanitizedRawData.BuyerEmail
        delete sanitizedRawData.DefaultShipFromLocationAddress

        // ── Customization preservation guard ────────────────────────────
        // Before writing order_items, check if the order already exists in DB
        // and has customization data stored. If so, merge it into the freshly-
        // fetched items so we never overwrite existing customization with null.
        const { data: existingOrderData } = await supabase
          .from('orders')
          .select('order_items')
          .eq('id', order.AmazonOrderId)
          .single()

        if (existingOrderData?.order_items) {
          const existingItems = existingOrderData.order_items as (OrderItem & { customization_checked?: boolean | number })[]
          for (const freshItem of orderItems) {
            const existingItem = existingItems.find(
              (ei) => ei.order_item_id === freshItem.order_item_id || ei.asin === freshItem.asin
            )
            // Preserve customization if fresh fetch didn't get it but DB has it
            if (existingItem?.customization && !freshItem.customization) {
              freshItem.customization = existingItem.customization
              console.log(`[Customization Guard] Preserved customization for ${freshItem.asin} on order ${order.AmazonOrderId}`)
            }
            // Preserve customization_checked flag
            if (existingItem && 'customization_checked' in existingItem && !('customization_checked' in freshItem)) {
              ;(freshItem as OrderItem & { customization_checked?: boolean | number }).customization_checked = existingItem.customization_checked
            }
            // Preserve ai_detected_color if fresh fetch didn't get it
            if (existingItem?.ai_detected_color && !freshItem.ai_detected_color) {
              freshItem.ai_detected_color = existingItem.ai_detected_color
            }
          }
        }

        // Upsert order into Supabase
        const { error } = await supabase.from('orders').upsert(
          {
            id: order.AmazonOrderId,
            purchase_date: order.PurchaseDate,
            buyer_name: buyerInfo?.BuyerName || null,
            buyer_email: buyerInfo?.BuyerEmail || null,
            ship_to: shipTo,
            order_items: orderItems,
            fulfillment_channel: order.FulfillmentChannel,
            order_status: order.OrderStatus,
            ship_service_level: order.ShipmentServiceLevelCategory || null,
            is_prime: order.IsPrime || false,
            raw_data: sanitizedRawData,
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'id' }
        )

        if (!error) {
          ordersInserted++
          // Trigger urgent-shipping notification for Priority / Overnight / SameDay orders
          const urgentLevels = ['Priority', 'NextDay', 'SameDay', 'SecondDay']
          const svcLevel = order.ShipmentServiceLevelCategory || ''
          if (urgentLevels.some(u => svcLevel.toLowerCase().includes(u.toLowerCase()))) {
            await supabase.from('fba_notifications').insert({
              type: 'urgent_shipping',
              title: `URGENT: ${svcLevel} order received`,
              message: `Order ${order.AmazonOrderId} requires ${svcLevel} shipping. Ship immediately.`,
              metadata: { order_id: order.AmazonOrderId, ship_service_level: svcLevel },
              is_read: false,
            })
          }
        }
      } catch (itemError) {
        console.error(`Error processing order ${order.AmazonOrderId}:`, itemError)
      }
    }

    // ── AI Color Backfill ──────────────────────────────────────────────
    // For existing orders that were synced before AI detection was added,
    // detect colors for items that have images but no ai_detected_color.
    // Process up to 10 orders per sync to avoid long sync times.
    try {
      const { data: ordersNeedingColor } = await supabase
        .from('orders')
        .select('id, order_items')
        .not('order_items', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50)

      if (ordersNeedingColor) {
        let backfillCount = 0
        const MAX_BACKFILL = 10

        for (const order of ordersNeedingColor) {
          if (backfillCount >= MAX_BACKFILL) break

          const items = order.order_items as OrderItem[]
          if (!items || items.length === 0) continue

          // Check if any item needs AI color detection
          const needsDetection = items.some(
            (item) => item.image_url && !item.ai_detected_color
          )
          if (!needsDetection) continue

          try {
            await batchDetectColors(items)

            // Re-read the latest order_items from DB before writing back.
            // This prevents a race where the customization backfill ran between
            // our read and this write, which would cause us to overwrite the
            // freshly-stored customization with the stale items array we read earlier.
            const { data: latestOrder } = await supabase
              .from('orders')
              .select('order_items')
              .eq('id', order.id)
              .single()

            let itemsToWrite = items
            if (latestOrder?.order_items) {
              const latestItems = latestOrder.order_items as (OrderItem & { customization_checked?: boolean | number })[]
              itemsToWrite = items.map((item) => {
                const latestItem = latestItems.find(
                  (li) => li.order_item_id === item.order_item_id || li.asin === item.asin
                )
                // Preserve any customization that was added to DB since we read
                if (latestItem?.customization && !item.customization) {
                  item.customization = latestItem.customization
                }
                if (latestItem && 'customization_checked' in latestItem && !('customization_checked' in item)) {
                  ;(item as OrderItem & { customization_checked?: boolean | number }).customization_checked = latestItem.customization_checked
                }
                return item
              })
            }

            // Update the order with AI-detected colors (customization preserved)
            await supabase
              .from('orders')
              .update({ order_items: itemsToWrite as unknown as Record<string, unknown>[] })
              .eq('id', order.id)

            backfillCount++
            console.log(`[AI Color Backfill] Updated ${order.id} (${backfillCount}/${MAX_BACKFILL})`)
          } catch (err) {
            console.warn(`[AI Color Backfill] Failed for ${order.id}:`, err)
          }
        }

        if (backfillCount > 0) {
          console.log(`[AI Color Backfill] Completed ${backfillCount} orders`)
        }
      }
    } catch (backfillError) {
      console.warn('[AI Color Backfill] Error during backfill:', backfillError)
    }

    // ── Customization Backfill ─────────────────────────────────────────
    // For existing orders, check the /orderItems/buyerInfo endpoint for
    // BuyerCustomizedInfo. Items checked and found to have no customization
    // get marked with customization_checked = 2 (v2 = correct endpoint).
    // Items with customization_checked = true (v1 = wrong endpoint) get re-checked.
    // Also re-check items with personalized SKUs (containing "Custom") that were
    // previously checked but had no customization (pre-RDT-approval scenario).
    // Process up to 10 RDT calls per sync to avoid long sync times.
    try {
      const { data: ordersNeedingCustomization } = await supabase
        .from('orders')
        .select('id, order_items')
        .not('order_items', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50)

      if (ordersNeedingCustomization) {
        let custApiCalls = 0
        const MAX_CUST_API_CALLS = 10

        // SKU patterns that indicate a personalized/custom product
        const isPersonalizedSku = (sku: string) => {
          const lower = sku.toLowerCase()
          return lower.includes('custom') || lower.includes('personali')
        }

        for (const order of ordersNeedingCustomization) {
          if (custApiCalls >= MAX_CUST_API_CALLS) break

          const items = order.order_items as (OrderItem & { customization_checked?: boolean | number })[]
          if (!items || items.length === 0) continue

          // Check if any item needs customization fetch:
          // 1. Not yet checked (no customization and not checked with v2)
          // 2. Previously checked with v1 (customization_checked === true)
          // 3. Has a personalized SKU but no customization (pre-RDT-approval re-check)
          const needsCheck = items.some(
            (item) => (
              (!item.customization && item.customization_checked !== 2) ||
              (!item.customization && item.customization_checked === 2 && isPersonalizedSku(item.sku || ''))
            )
          )
          if (!needsCheck) continue

          try {
            // Re-fetch order items with RDT to get BuyerCustomizedInfo
            const freshItems = await fetchOrderItemsWithBuyerInfo(order.id)
            custApiCalls++
            let hasCustomization = false

            for (const item of items) {
              // Skip items that already have customization data
              if (item.customization) continue
              // Skip items already checked UNLESS they have a personalized SKU (pre-approval re-check)
              if (item.customization_checked === 2 && !isPersonalizedSku(item.sku || '')) continue

              // Find matching fresh item by order_item_id or ASIN
              const freshItem = freshItems.find(
                (fi) => fi.OrderItemId === item.order_item_id || fi.ASIN === item.asin
              )

              const customizedUrl = freshItem?.BuyerInfo?.BuyerCustomizedInfo?.CustomizedURL
              if (customizedUrl) {
                try {
                  const customization = await fetchCustomizationFromZip(customizedUrl)
                  if (customization) {
                    item.customization = customization
                    hasCustomization = true
                    console.log(`[Customization Backfill] Fetched for ${item.asin} on order ${order.id}`)
                  }
                } catch (custErr) {
                  console.warn(`[Customization Backfill] ZIP fetch failed for ${item.asin}:`, custErr)
                }
              }

              // Mark as checked with v2 — for personalized SKUs that still have no
              // customization after re-check, upgrade to customization_checked = 3
              // ("re-checked after approval, confirmed no customization")
              if (!item.customization) {
                item.customization_checked = isPersonalizedSku(item.sku || '') ? 3 : 2
              }
            }

            // Re-read the latest order_items from DB before writing back.
            // This prevents a race where the AI color backfill ran between
            // our read and this write, which would cause us to overwrite
            // freshly-detected colors with the stale items array we read earlier.
            const { data: latestCustOrder } = await supabase
              .from('orders')
              .select('order_items')
              .eq('id', order.id)
              .single()

            let custItemsToWrite = items as (OrderItem & { customization_checked?: boolean | number })[]
            if (latestCustOrder?.order_items) {
              const latestCustItems = latestCustOrder.order_items as (OrderItem & { customization_checked?: boolean | number })[]
              custItemsToWrite = items.map((item) => {
                const latestItem = latestCustItems.find(
                  (li) => li.order_item_id === item.order_item_id || li.asin === item.asin
                )
                // Preserve ai_detected_color added by color backfill since we read
                if (latestItem?.ai_detected_color && !item.ai_detected_color) {
                  item.ai_detected_color = latestItem.ai_detected_color
                }
                // NEVER overwrite existing customization with null
                if (latestItem?.customization && !item.customization) {
                  item.customization = latestItem.customization
                }
                return item
              })
            }

            // Always update — either with customization data or with checked flags
            await supabase
              .from('orders')
              .update({ order_items: custItemsToWrite as unknown as Record<string, unknown>[] })
              .eq('id', order.id)

            if (hasCustomization) {
              console.log(`[Customization Backfill] Found customization for ${order.id}`)
            } else {
              console.log(`[Customization Backfill] No customization found for ${order.id}, marked as checked`)
            }
          } catch (err) {
            console.warn(`[Customization Backfill] Failed for ${order.id}:`, err)
          }
        }

        if (custApiCalls > 0) {
          console.log(`[Customization Backfill] Checked ${custApiCalls} orders via RDT`)
        }
      }
    } catch (custBackfillError) {
      console.warn('[Customization Backfill] Error during backfill:', custBackfillError)
    }

    // ── PII Backfill (Address & Buyer Name) ───────────────────────────
    // For existing orders that were synced before PII access was approved,
    // re-fetch shipping address and buyer info via RDT.
    // Process up to 10 orders per sync to stay within rate limits.
    try {
      const { data: ordersNeedingPII } = await supabase
        .from('orders')
        .select('id, ship_to, buyer_name')
        .or('ship_to.is.null,buyer_name.is.null')
        .order('created_at', { ascending: false })
        .limit(50)

      if (ordersNeedingPII) {
        let piiBackfillCount = 0
        const MAX_PII_BACKFILL = 5

        for (const order of ordersNeedingPII) {
          if (piiBackfillCount >= MAX_PII_BACKFILL) break

          try {
            // Throttle: wait 2 seconds between orders to avoid SP-API rate limits (429)
            if (piiBackfillCount > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000))
            }

            // Fetch full address via RDT
            const rdtAddress = await fetchOrderAddress(order.id)
            // Wait 1 second between RDT calls for the same order
            await new Promise(resolve => setTimeout(resolve, 1000))
            const rdtBuyer = await fetchOrderBuyerInfo(order.id)

            // Only count as a backfill if we actually got data
            if (!rdtAddress && !rdtBuyer) {
              // RDT still not working for this order, skip
              continue
            }

            const updateData: Record<string, unknown> = {}

            if (rdtAddress) {
              const shipTo: ShipTo = {
                name: rdtAddress.Name || rdtBuyer?.BuyerName || 'Customer',
                addressLine1: rdtAddress.AddressLine1 || '',
                addressLine2: rdtAddress.AddressLine2,
                city: rdtAddress.City || '',
                stateOrRegion: rdtAddress.StateOrRegion || '',
                postalCode: rdtAddress.PostalCode || '',
                countryCode: rdtAddress.CountryCode || 'US',
                phone: rdtAddress.Phone || undefined,
              }
              updateData.ship_to = shipTo
            }

            if (rdtBuyer?.BuyerName) {
              updateData.buyer_name = rdtBuyer.BuyerName
            }
            if (rdtBuyer?.BuyerEmail) {
              updateData.buyer_email = rdtBuyer.BuyerEmail
            }

            if (Object.keys(updateData).length > 0) {
              await supabase
                .from('orders')
                .update(updateData)
                .eq('id', order.id)

              piiBackfillCount++
              console.log(`[PII Backfill] Updated ${order.id} (${piiBackfillCount}/${MAX_PII_BACKFILL})`)
            }
          } catch (err) {
            console.warn(`[PII Backfill] Failed for ${order.id}:`, err)
          }
        }

        if (piiBackfillCount > 0) {
          console.log(`[PII Backfill] Completed ${piiBackfillCount} orders`)
        }
      }
    } catch (piiBackfillError) {
      console.warn('[PII Backfill] Error during backfill:', piiBackfillError)
    }

    // ── Stale Order Cancellation Cleanup ────────────────────────────────
    // After syncing, any order in our DB that is still 'Unshipped' or
    // 'PartiallyShipped' but was NOT returned by Amazon in this sync
    // window has been cancelled (or otherwise removed) on Amazon's side.
    //
    // Why this happens: fetchFBMOrders() only requests Unshipped,
    // PartiallyShipped, and Shipped orders. When Amazon cancels an order
    // it stops appearing in those results — so without this cleanup the
    // order stays stuck as Unshipped in our DB forever.
    //
    // Logic:
    //   1. Fetch all Unshipped/PartiallyShipped orders from DB within
    //      the same 7-day window we synced from Amazon.
    //   2. Any DB order whose ID was NOT in the Amazon response set is
    //      marked Cancelled with a note in raw_data.
    try {
      const windowStart = new Date()
      windowStart.setDate(windowStart.getDate() - 7)

      const { data: openDbOrders } = await supabase
        .from('orders')
        .select('id, order_status')
        .in('order_status', ['Unshipped', 'PartiallyShipped'])
        .gte('purchase_date', windowStart.toISOString())

      if (openDbOrders && openDbOrders.length > 0) {
        // Build a set of all order IDs Amazon returned in this sync
        const returnedByAmazon = new Set(amazonOrders.map(o => o.AmazonOrderId))

        const staleOrders = openDbOrders.filter(o => !returnedByAmazon.has(o.id))

        if (staleOrders.length > 0) {
          console.log(`[Stale Cleanup] ${staleOrders.length} order(s) not returned by Amazon — marking Cancelled: ${staleOrders.map(o => o.id).join(', ')}`)

          for (const stale of staleOrders) {
            // Only update order_status and synced_at.
            // order_items, ship_to, raw_data are intentionally NOT updated
            // so packing slip history is preserved for reference.
            await supabase
              .from('orders')
              .update({
                order_status: 'Cancelled',
                synced_at: new Date().toISOString(),
              })
              .eq('id', stale.id)
          }

          console.log(`[Stale Cleanup] Marked ${staleOrders.length} order(s) as Cancelled`)
        }
      }
    } catch (staleCleanupError) {
      // Non-fatal: log and continue so sync log still records success
      console.warn('[Stale Cleanup] Error during stale order cleanup:', staleCleanupError)
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
