/**
 * FBA Intelligence Sync Service — Reports-API-Free
 *
 * Strategy (no Reports role required):
 * 1. Extract unique ASINs + product titles from the orders table
 * 2. Fetch ALL FBA inventory via FBA Inventory Summaries API (already authorized)
 * 3. Store FBA inventory rows keyed by (asin, sku)
 * 4. Compute 30/60/90-day sales velocity from the orders table directly
 * 5. Update fba_inventory rows with computed velocity
 * 6. Detect excess inventory: DoS > 90 days → flag as excess, upsert into excess_inventory
 *
 * This bypasses GET_FBA_INVENTORY_PLANNING_DATA and GET_SALES_AND_TRAFFIC_REPORT
 * entirely — both require the Reports role which may not be approved.
 */
import { createClient } from '@supabase/supabase-js'
import { fetchFBAInventoryForAsins } from '@/lib/amazon/catalog'
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

// Standard FBA storage fee per unit estimate (apparel/standard size)
// Used only when Amazon's report is unavailable
const ESTIMATED_MONTHLY_STORAGE_FEE_PER_UNIT = 0.87 // $/unit/month (rough estimate)
const EXCESS_DAYS_OF_SUPPLY_THRESHOLD = 90 // > 90 days = excess

/**
 * Orders-driven FBA sync — no Reports API required.
 */
export async function syncCatalogAndInventory(): Promise<SyncCatalogResult> {
  const start = Date.now()
  const supabase = getAdminSupabase()
  const errors: string[] = []
  let inventoryUpserted = 0
  let salesReportAsins = 0
  let excessItemsFound = 0

  // ── 1. Extract unique ASINs + product titles from orders table ──────────
  const { data: orderItems, error: ordErr } = await supabase
    .from('orders')
    .select('order_items')
    .not('order_items', 'is', null)

  if (ordErr) {
    errors.push(`Failed to read orders: ${ordErr.message}`)
    return { asinsFromOrders: 0, inventoryUpserted: 0, salesReportAsins: 0, excessItemsFound: 0, errors, durationMs: Date.now() - start }
  }

  // Build ASIN → title map from order items
  const asinTitleMap = new Map<string, string>()
  for (const row of orderItems || []) {
    const items = row.order_items as Array<{ asin?: string; title?: string }> || []
    for (const item of items) {
      if (item.asin && !asinTitleMap.has(item.asin)) {
        asinTitleMap.set(item.asin, item.title || '')
      }
    }
  }

  const asins = Array.from(asinTitleMap.keys())
  console.log(`[FBA Sync] Found ${asins.length} unique ASINs from orders`)

  if (asins.length === 0) {
    return { asinsFromOrders: 0, inventoryUpserted: 0, salesReportAsins: 0, excessItemsFound: 0, errors, durationMs: Date.now() - start }
  }

  // ── 2. Fetch FBA inventory from SP-API ──────────────────────────────────
  let inventory: FBAInventoryItem[] = []
  try {
    inventory = await fetchFBAInventoryForAsins(asins)
    console.log(`[FBA Sync] Fetched ${inventory.length} FBA inventory records`)
  } catch (err) {
    errors.push(`FBA inventory fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── 3. Upsert fba_inventory rows ────────────────────────────────────────
  if (inventory.length > 0) {
    const now = new Date().toISOString()
    const invRows = inventory.map((i: FBAInventoryItem) => ({
      asin: i.asin,
      sku: i.sku || '',
      fnsku: i.fnsku || null,
      condition_type: i.condition_type || 'NewItem',
      quantity_available: i.quantity_available || 0,
      quantity_reserved: i.quantity_reserved || 0,
      quantity_inbound: i.quantity_inbound || 0,
      quantity_total: i.quantity_total || 0,
      last_synced_at: now,
    }))

    for (let i = 0; i < invRows.length; i += 100) {
      const chunk = invRows.slice(i, i + 100)
      const { error } = await supabase
        .from('fba_inventory')
        .upsert(chunk, { onConflict: 'asin,sku' })

      if (error) {
        errors.push(`Inventory upsert error (batch ${i}): ${error.message}`)
      } else {
        inventoryUpserted += chunk.length
      }
    }
    console.log(`[FBA Sync] Upserted ${inventoryUpserted} inventory records`)
  }

  // ── 4. Compute velocity from orders table ───────────────────────────────
  // We compute 30d, 60d, 90d velocity directly from stored orders — no Reports API needed.
  const velocityMap = await computeVelocityFromOrders()
  salesReportAsins = velocityMap.size
  console.log(`[FBA Sync] Computed velocity for ${salesReportAsins} ASINs from orders`)

  // Update fba_inventory rows with computed velocity
  if (velocityMap.size > 0) {
    for (const [asin, vel] of velocityMap) {
      const { error } = await supabase
        .from('fba_inventory')
        .update({
          units_sold_30d: vel.units30d,
          sessions_30d: 0, // not available without Reports API
          buy_box_percentage: 0, // not available without Reports API
        })
        .eq('asin', asin)
        .neq('sku', '')

      if (error && !error.message.includes('column') && !error.message.includes('does not exist')) {
        errors.push(`Velocity update for ${asin}: ${error.message}`)
      }
    }
  }

  // ── 5. Detect and upsert excess inventory ───────────────────────────────
  // For each FBA inventory row, compute days of supply and flag excess.
  // DoS = qty_available / (units_sold_30d / 30)
  // Excess = DoS > 90 days AND qty_available > 0
  try {
    const now = new Date().toISOString()
    const excessCandidates: Array<{
      asin: string
      sku: string
      fnsku: string | null
      product_name: string
      qty_available: number
      excess_qty: number
      days_of_supply: number
      units_sold_last_30_days: number
      your_price: number
      estimated_monthly_storage_fee: number
      estimated_storage_cost_per_unit: number
    }> = []

    for (const inv of inventory) {
      if (!inv.asin || inv.quantity_available <= 0) continue

      // HARD RULE: If Amazon has inbound units for this ASIN, Amazon itself wants
      // more stock sent — this product is NOT excess, skip it unconditionally.
      if ((inv.quantity_inbound || 0) > 0) {
        console.log(`[Excess] Skipping ${inv.asin} — has ${inv.quantity_inbound} inbound units (Amazon wants more stock)`)
        continue
      }

      const vel = velocityMap.get(inv.asin)
      const units30d = vel?.units30d || 0
      const units90d = vel?.units90d || 0
      const dailyRate = units30d / 30

      // HARD RULE: If we have NO order history for this ASIN in our orders table,
      // it likely sells exclusively via FBA (FBA orders aren't in our orders table).
      // We cannot compute accurate velocity — skip to avoid false positives.
      // Only flag if we have at least 3 orders in 90 days to establish a real pattern.
      if (units90d < 3 && inv.quantity_available < 20) {
        console.log(`[Excess] Skipping ${inv.asin} — insufficient order history (${units90d} orders/90d, likely FBA-only seller)`)
        continue
      }

      // Skip if selling fast enough (DoS <= threshold)
      if (dailyRate === 0) {
        // Zero velocity AND no inbound — only flag if substantial stock (> 20 units)
        // to avoid noise from products that just haven't had orders synced yet
        if (inv.quantity_available < 20) continue
      }

      const daysOfSupply = dailyRate > 0
        ? Math.round(inv.quantity_available / dailyRate)
        : 999 // infinite supply

      if (daysOfSupply <= EXCESS_DAYS_OF_SUPPLY_THRESHOLD) continue

      // Compute excess quantity (units above 90-day supply)
      const idealQty = Math.ceil(dailyRate * EXCESS_DAYS_OF_SUPPLY_THRESHOLD)
      const excessQty = Math.max(0, inv.quantity_available - idealQty)

      if (excessQty <= 0) continue

      // Estimate storage fee (rough — $0.87/unit/month for standard apparel)
      const monthlyStorageFee = parseFloat((excessQty * ESTIMATED_MONTHLY_STORAGE_FEE_PER_UNIT).toFixed(2))
      const storagePerUnit = ESTIMATED_MONTHLY_STORAGE_FEE_PER_UNIT

      const productName = asinTitleMap.get(inv.asin) || `ASIN: ${inv.asin}`

      excessCandidates.push({
        asin: inv.asin,
        sku: inv.sku || '',
        fnsku: inv.fnsku || null,
        product_name: productName,
        qty_available: inv.quantity_available,
        excess_qty: excessQty,
        days_of_supply: daysOfSupply > 999 ? 999 : daysOfSupply,
        units_sold_last_30_days: units30d,
        your_price: 0, // not available without catalog API
        estimated_monthly_storage_fee: monthlyStorageFee,
        estimated_storage_cost_per_unit: storagePerUnit,
      })
    }

    excessItemsFound = excessCandidates.length
    console.log(`[FBA Sync] Detected ${excessItemsFound} excess items (DoS > ${EXCESS_DAYS_OF_SUPPLY_THRESHOLD} days)`)

    for (const item of excessCandidates) {
      // Check if already tracked
      const { data: existing } = await supabase
        .from('excess_inventory')
        .select('id, status, ai_action_plan, action_taken, recheck_due_at')
        .eq('sku', item.sku)
        .single()

      const upsertData = {
        asin: item.asin,
        sku: item.sku,
        fnsku: item.fnsku,
        product_name: item.product_name,
        qty_available: item.qty_available,
        excess_qty: item.excess_qty,
        days_of_supply: item.days_of_supply,
        units_sold_last_30_days: item.units_sold_last_30_days,
        your_price: item.your_price,
        estimated_monthly_storage_fee: item.estimated_monthly_storage_fee,
        estimated_storage_cost_per_unit: item.estimated_storage_cost_per_unit,
        amazon_recommended_action: null,
        amazon_alert: null,
        last_synced_at: now,
        ...((!existing || existing.status === 'dismissed') ? { status: 'active' } : {}),
      }

      const { error: upsertErr } = await supabase
        .from('excess_inventory')
        .upsert(upsertData, { onConflict: 'sku' })

      if (upsertErr) {
        errors.push(`Excess upsert error for SKU ${item.sku}: ${upsertErr.message}`)
      }
    }

    // ── AUTO-CLEANUP: Remove stale excess records that no longer qualify ──────
    // After every sync, any excess_inventory row whose SKU is NOT in the current
    // excess candidates list should be auto-resolved. This means the item either:
    //   - Sold down (DoS is now healthy)
    //   - Has inbound units (Amazon wants more stock)
    //   - Was a false positive (FBA-only product with no order history)
    // We only auto-remove rows with status 'active' — rows with action_taken
    // or ai_action_plan are moved to 'resolved' so history is preserved.
    try {
      const currentExcessSkus = new Set(excessCandidates.map(c => c.sku))

      const { data: allTracked } = await supabase
        .from('excess_inventory')
        .select('id, sku, status, action_taken, ai_action_plan')
        .in('status', ['active', 'needs_action'])

      for (const tracked of allTracked || []) {
        if (currentExcessSkus.has(tracked.sku)) continue // still excess, keep it

        const hasHistory = tracked.action_taken || tracked.ai_action_plan

        if (hasHistory) {
          // Preserve history — mark as resolved with a note
          await supabase
            .from('excess_inventory')
            .update({ status: 'resolved', last_synced_at: now })
            .eq('id', tracked.id)
          console.log(`[Excess Cleanup] Resolved ${tracked.sku} — no longer excess`)
        } else {
          // No history — safe to delete (was a false positive or already cleared)
          await supabase
            .from('excess_inventory')
            .delete()
            .eq('id', tracked.id)
          console.log(`[Excess Cleanup] Deleted stale record for ${tracked.sku} — no longer excess`)
        }
      }
    } catch (cleanupErr) {
      errors.push(`Excess cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`)
    }

    // Fire notification if new excess items found
    if (excessCandidates.length > 0) {
      await supabase.from('fba_notifications').insert({
        type: 'excess_detected',
        title: `${excessCandidates.length} excess FBA item${excessCandidates.length !== 1 ? 's' : ''} detected`,
        message: `${excessCandidates.length} item${excessCandidates.length !== 1 ? 's have' : ' has'} more than ${EXCESS_DAYS_OF_SUPPLY_THRESHOLD} days of supply. Review the Clear FBA Stock tab for AI-powered action plans.`,
      }).then(() => {})
    }
  } catch (err) {
    errors.push(`Excess inventory detection failed: ${err instanceof Error ? err.message : String(err)}`)
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
 * Compute 30-day, 60-day, and 90-day sales velocity per ASIN from the orders table.
 * This replaces the Sales & Traffic Report — no Reports API role required.
 */
export async function computeVelocityFromOrders(): Promise<Map<string, {
  units30d: number
  units60d: number
  units90d: number
  velocityPerDay: number
  title: string
  sku: string
  hasCustomization: boolean
}>> {
  const supabase = getAdminSupabase()
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: orders, error } = await supabase
    .from('orders')
    .select('order_items, purchase_date, fulfillment_channel')
    .gte('purchase_date', ninetyDaysAgo)

  if (error) {
    console.error('[Velocity] Failed to fetch orders:', error.message)
    return new Map()
  }

  const velocityMap = new Map<string, {
    units30d: number
    units60d: number
    units90d: number
    velocityPerDay: number
    title: string
    sku: string
    hasCustomization: boolean
  }>()

  for (const order of orders || []) {
    const purchaseDate = order.purchase_date
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
      const existing = velocityMap.get(item.asin) || {
        units30d: 0, units60d: 0, units90d: 0,
        velocityPerDay: 0,
        title: item.title || '',
        sku: item.sku || '',
        hasCustomization: false,
      }

      // Count in each window
      if (purchaseDate >= thirtyDaysAgo) existing.units30d += qty
      if (purchaseDate >= sixtyDaysAgo) existing.units60d += qty
      existing.units90d += qty // all orders are within 90 days

      if (item.customization) existing.hasCustomization = true
      if (!existing.title && item.title) existing.title = item.title
      if (!existing.sku && item.sku) existing.sku = item.sku

      velocityMap.set(item.asin, existing)
    }
  }

  // Compute daily velocity using 90-day average for stability
  for (const [, data] of velocityMap) {
    data.velocityPerDay = data.units90d / 90
  }

  return velocityMap
}

/**
 * Alias for backward compatibility — used by replenishment engine.
 */
export async function computeFBMVelocity(): Promise<Map<string, {
  units30d: number
  velocityPerDay: number
  title: string
  sku: string
  hasCustomization: boolean
}>> {
  const full = await computeVelocityFromOrders()
  const result = new Map<string, {
    units30d: number
    velocityPerDay: number
    title: string
    sku: string
    hasCustomization: boolean
  }>()
  for (const [asin, data] of full) {
    result.set(asin, {
      units30d: data.units30d,
      velocityPerDay: data.velocityPerDay,
      title: data.title,
      sku: data.sku,
      hasCustomization: data.hasCustomization,
    })
  }
  return result
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
