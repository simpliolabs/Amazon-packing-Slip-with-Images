/**
 * FBA Intelligence Sync Service — Orders-Driven
 *
 * Strategy:
 * 1. Extract unique ASINs from the orders table (only products we actually sell)
 * 2. Fetch FBA inventory ONLY for those ASINs (targeted, not full catalog)
 * 3. Fetch Sales & Traffic Report for FBA sales data
 * 4. Fetch Inventory Health Report for excess/storage data
 * 5. Store results in Supabase for the replenishment engine
 */

import { createClient } from '@supabase/supabase-js'
import {
  fetchFBAInventoryForAsins,
  fetchSalesAndTrafficReport,
  fetchInventoryHealthReport,
} from '@/lib/amazon/catalog'
import type { FBAInventoryItem } from '@/lib/amazon/catalog'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export interface SyncCatalogResult {
  asinsFromOrders: number
  inventoryUpserted: number
  salesReportAsins: number
  excessItemsFound: number
  errors: string[]
  durationMs: number
}

/**
 * Orders-driven FBA sync:
 * - Extracts unique ASINs from orders table
 * - Fetches FBA inventory for only those ASINs
 * - Fetches Sales & Traffic Report for FBA sales data
 * - Fetches Inventory Health Report for excess/storage data
 * - Stores results in Supabase
 */
export async function syncCatalogAndInventory(): Promise<SyncCatalogResult> {
  const start = Date.now()
  const supabase = getAdminSupabase()
  const errors: string[] = []
  let inventoryUpserted = 0
  let salesReportAsins = 0
  let excessItemsFound = 0

  // ── 1. Extract unique ASINs from orders table ───────────────────────────
  const { data: orderItems, error: ordErr } = await supabase
    .from('orders')
    .select('order_items')
    .not('order_items', 'is', null)

  if (ordErr) {
    errors.push(`Failed to read orders: ${ordErr.message}`)
    return { asinsFromOrders: 0, inventoryUpserted: 0, salesReportAsins: 0, excessItemsFound: 0, errors, durationMs: Date.now() - start }
  }

  const asinSet = new Set<string>()
  for (const row of orderItems || []) {
    const items = row.order_items as Array<{ asin?: string }> || []
    for (const item of items) {
      if (item.asin) asinSet.add(item.asin)
    }
  }

  const asins = Array.from(asinSet)
  console.log(`[FBA Sync] Found ${asins.length} unique ASINs from orders`)

  if (asins.length === 0) {
    return { asinsFromOrders: 0, inventoryUpserted: 0, salesReportAsins: 0, excessItemsFound: 0, errors, durationMs: Date.now() - start }
  }

  // ── 2. Fetch FBA inventory for those ASINs ──────────────────────────────
  let inventory: FBAInventoryItem[] = []
  try {
    inventory = await fetchFBAInventoryForAsins(asins)
  } catch (err) {
    errors.push(`FBA inventory fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 3. Upsert fba_inventory ─────────────────────────────────────────────
  if (inventory.length > 0) {
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
        errors.push(`Inventory upsert error: ${error.message}`)
      } else {
        inventoryUpserted += chunk.length
      }
    }
  }

  // ── 4. Fetch Sales & Traffic Report ────────────────────────────────────
  try {
    const salesMap = await fetchSalesAndTrafficReport(asins)
    salesReportAsins = salesMap.size

    if (salesMap.size > 0) {
      for (const [asin, salesData] of salesMap) {
        await supabase
          .from('fba_inventory')
          .upsert({
            asin,
            sku: '',
            quantity_available: 0,
            quantity_reserved: 0,
            quantity_inbound: 0,
            quantity_total: 0,
            units_sold_30d: salesData.units_ordered_fba,
            buy_box_percentage: salesData.buy_box_percentage,
            sessions_30d: salesData.sessions,
            last_synced_at: new Date().toISOString(),
          }, { onConflict: 'asin,sku', ignoreDuplicates: false })
      }
    }
  } catch (err) {
    errors.push(`Sales & Traffic Report fetch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 5. Fetch Inventory Health Report (excess/storage data) ─────────────
  try {
    const healthMap = await fetchInventoryHealthReport()

    if (healthMap.size > 0) {
      // Compute FBM velocity for context in AI plans
      const velocityMap = await computeFBMVelocity()

      const now = new Date().toISOString()
      const excessItems = Array.from(healthMap.values()).filter(item => item.is_excess)
      excessItemsFound = excessItems.length

      console.log(`[FBA Sync] Found ${excessItems.length} excess items from Inventory Health report`)

      for (const item of excessItems) {
        const fbmData = velocityMap.get(item.asin)
        const fbmUnits30d = fbmData?.units30d || 0

        // Check if this item already has an active record
        const { data: existing } = await supabase
          .from('excess_inventory')
          .select('id, status, ai_action_plan, action_taken, recheck_due_at')
          .eq('sku', item.sku)
          .single()

        const upsertData = {
          asin: item.asin,
          sku: item.sku,
          fnsku: item.fnsku,
          product_name: item.product_name || `ASIN: ${item.asin}`,
          qty_available: item.qty_available,
          excess_qty: item.excess_qty,
          days_of_supply: item.days_of_supply,
          units_sold_last_30_days: item.units_sold_last_30_days,
          your_price: item.your_price,
          estimated_monthly_storage_fee: item.estimated_monthly_storage_fee,
          estimated_storage_cost_per_unit: item.estimated_storage_cost_per_unit,
          amazon_recommended_action: item.recommended_action,
          amazon_alert: item.alert,
          last_synced_at: now,
          // Only update status to 'active' if it was previously 'dismissed' or doesn't exist
          // Don't overwrite 'actioned' or 'resolved' statuses
          ...((!existing || existing.status === 'dismissed') ? { status: 'active' } : {}),
        }

        const { error: upsertErr } = await supabase
          .from('excess_inventory')
          .upsert(upsertData, { onConflict: 'sku' })

        if (upsertErr) {
          errors.push(`Excess inventory upsert error for SKU ${item.sku}: ${upsertErr.message}`)
        }
      }

      // Create notification for new excess items detected
      if (excessItems.length > 0) {
        const newExcessCount = excessItems.filter(item => {
          // Count items that don't have an existing active record
          return true // We'll refine this — for now notify on every sync
        }).length

        if (newExcessCount > 0) {
          await supabase.from('fba_notifications').insert({
            type: 'excess_detected',
            title: `${excessItems.length} excess FBA item${excessItems.length !== 1 ? 's' : ''} detected`,
            message: `Amazon's Inventory Health report flagged ${excessItems.length} item${excessItems.length !== 1 ? 's' : ''} as excess. Review the Clear FBA Stock tab for AI-powered action plans.`,
          })
        }
      }
    }
  } catch (err) {
    errors.push(`Inventory Health Report fetch failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    asinsFromOrders: asins.length,
    inventoryUpserted,
    salesReportAsins,
    excessItemsFound,
    errors,
    durationMs: Date.now() - start,
  }
}

/**
 * Compute 30-day FBM velocity per ASIN from the orders table.
 * Returns a map of ASIN → { units30d, velocityPerDay, title, sku, hasCustomization }
 */
export async function computeFBMVelocity(): Promise<Map<string, {
  units30d: number
  velocityPerDay: number
  title: string
  sku: string
  hasCustomization: boolean
}>> {
  const supabase = getAdminSupabase()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: orders, error } = await supabase
    .from('orders')
    .select('order_items, purchase_date, fulfillment_channel')
    .gte('purchase_date', thirtyDaysAgo)

  if (error) {
    console.error('[Velocity] Failed to fetch orders:', error.message)
    return new Map()
  }

  const velocityMap = new Map<string, {
    units30d: number
    velocityPerDay: number
    title: string
    sku: string
    hasCustomization: boolean
  }>()

  for (const order of orders || []) {
    const isFBM = !order.fulfillment_channel || order.fulfillment_channel === 'MFN'
    const items = order.order_items as Array<{
      asin?: string
      title?: string
      sku?: string
      qty?: number
      quantity_ordered?: number
      customization?: unknown
    }> || []

    for (const item of items) {
      if (!item.asin) continue
      const qty = item.qty || item.quantity_ordered || 1
      const existing = velocityMap.get(item.asin)

      if (existing) {
        if (isFBM) existing.units30d += qty
        if (item.customization) existing.hasCustomization = true
        if (!existing.title && item.title) existing.title = item.title
        if (!existing.sku && item.sku) existing.sku = item.sku
      } else {
        velocityMap.set(item.asin, {
          units30d: isFBM ? qty : 0,
          velocityPerDay: 0,
          title: item.title || '',
          sku: item.sku || '',
          hasCustomization: !!item.customization,
        })
      }
    }
  }

  for (const [, data] of velocityMap) {
    data.velocityPerDay = data.units30d / 30
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
