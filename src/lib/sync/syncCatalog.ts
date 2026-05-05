/**
 * FBA Intelligence Sync Service
 * Syncs merchant catalog listings and FBA inventory into Supabase.
 * Computes 30-day velocity per ASIN from existing orders data.
 */

import { createClient } from '@supabase/supabase-js'
import { fetchMerchantListings, fetchFBAInventory, pairFBAFBMProducts } from '@/lib/amazon/catalog'
import type { CatalogProduct, FBAInventoryItem } from '@/lib/amazon/catalog'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export interface SyncCatalogResult {
  catalogUpserted: number
  inventoryUpserted: number
  errors: string[]
  durationMs: number
}

/**
 * Full catalog + FBA inventory sync.
 * Fetches from SP-API and upserts into Supabase.
 */
export async function syncCatalogAndInventory(): Promise<SyncCatalogResult> {
  const start = Date.now()
  const supabase = getAdminSupabase()
  const errors: string[] = []
  let catalogUpserted = 0
  let inventoryUpserted = 0

  // ── 1. Fetch merchant listings ──────────────────────────────────────────
  let listings: CatalogProduct[] = []
  try {
    listings = await fetchMerchantListings()
  } catch (err) {
    errors.push(`Catalog fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 2. Upsert catalog_products ──────────────────────────────────────────
  if (listings.length > 0) {
    const rows = listings.map(p => ({
      asin: p.asin,
      sku: p.sku,
      title: p.title,
      fulfillment_channel: p.fulfillment_channel,
      status: p.status,
      parent_asin: p.parent_asin,
      item_name: p.item_name,
      price: p.price,
      quantity: p.quantity,
      image_url: p.image_url,
      raw_data: p.raw_data,
      last_synced_at: new Date().toISOString(),
    }))

    // Batch upsert in chunks of 100
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100)
      const { error } = await supabase
        .from('catalog_products')
        .upsert(chunk, { onConflict: 'asin' })

      if (error) {
        errors.push(`Catalog upsert error (chunk ${i}): ${error.message}`)
      } else {
        catalogUpserted += chunk.length
      }
    }
  }

  // ── 3. Fetch FBA inventory ──────────────────────────────────────────────
  let inventory: FBAInventoryItem[] = []
  try {
    inventory = await fetchFBAInventory()
  } catch (err) {
    errors.push(`FBA inventory fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 4. Upsert fba_inventory ─────────────────────────────────────────────
  if (inventory.length > 0) {
    // First ensure all ASINs exist in catalog_products (insert unknown FBA ASINs)
    const knownAsins = new Set(listings.map(p => p.asin))
    const unknownFBAAsins = inventory.filter(i => !knownAsins.has(i.asin))

    if (unknownFBAAsins.length > 0) {
      const placeholders = unknownFBAAsins.map(i => ({
        asin: i.asin,
        sku: i.sku,
        title: `FBA Product (${i.asin})`,
        fulfillment_channel: 'AFN' as const,
        status: 'Active',
        last_synced_at: new Date().toISOString(),
      }))
      await supabase.from('catalog_products').upsert(placeholders, { onConflict: 'asin' })
    }

    const invRows = inventory.map(i => ({
      asin: i.asin,
      sku: i.sku,
      fnsku: i.fnsku,
      condition_type: i.condition_type,
      quantity_available: i.quantity_available,
      quantity_reserved: i.quantity_reserved,
      quantity_inbound: i.quantity_inbound,
      quantity_total: i.quantity_total,
      last_synced_at: new Date().toISOString(),
    }))

    for (let i = 0; i < invRows.length; i += 100) {
      const chunk = invRows.slice(i, i + 100)
      const { error } = await supabase
        .from('fba_inventory')
        .upsert(chunk, { onConflict: 'asin,sku' })

      if (error) {
        errors.push(`Inventory upsert error (chunk ${i}): ${error.message}`)
      } else {
        inventoryUpserted += chunk.length
      }
    }
  }

  return {
    catalogUpserted,
    inventoryUpserted,
    errors,
    durationMs: Date.now() - start,
  }
}

/**
 * Compute 30-day FBM velocity per ASIN from the orders table.
 * Returns a map of ASIN → units sold in last 30 days.
 */
export async function computeFBMVelocity(): Promise<Map<string, number>> {
  const supabase = getAdminSupabase()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: orders, error } = await supabase
    .from('orders')
    .select('order_items, purchase_date')
    .gte('purchase_date', thirtyDaysAgo)
    .eq('fulfillment_channel', 'MFN')

  if (error) {
    console.error('[Velocity] Failed to fetch orders:', error.message)
    return new Map()
  }

  const velocityMap = new Map<string, number>()

  for (const order of orders || []) {
    const items = order.order_items as Array<{ asin: string; qty: number }> || []
    for (const item of items) {
      if (!item.asin) continue
      velocityMap.set(item.asin, (velocityMap.get(item.asin) || 0) + (item.qty || 1))
    }
  }

  return velocityMap
}

/**
 * Get FBA settings from app_settings table with defaults.
 */
export async function getFBASettings(): Promise<{
  leadTimeDays: number
  safetyBufferDays: number
  replenishTriggerWeeks: number
  newFBACandidateMinUnits: number
}> {
  const supabase = getAdminSupabase()

  const { data } = await supabase
    .from('app_settings')
    .select('key, value')
    .in('key', [
      'fba_lead_time_days',
      'fba_safety_buffer_days',
      'fba_replenish_trigger_weeks',
      'fba_new_candidate_min_units',
    ])

  const map: Record<string, string> = {}
  for (const row of data || []) {
    map[row.key] = row.value || ''
  }

  return {
    leadTimeDays: parseInt(map['fba_lead_time_days'] || '14', 10),
    safetyBufferDays: parseInt(map['fba_safety_buffer_days'] || '15', 10),
    replenishTriggerWeeks: parseFloat(map['fba_replenish_trigger_weeks'] || '4'),
    newFBACandidateMinUnits: parseInt(map['fba_new_candidate_min_units'] || '5', 10),
  }
}
