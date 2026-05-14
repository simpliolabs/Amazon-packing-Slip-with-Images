/**
 * FBA Auto Re-Analysis Cron Route
 *
 * POST /api/fba/reanalyze
 * - Protected by CRON_SECRET header
 * - Finds all excess_inventory items where recheck_due_at <= NOW() and recheck_completed_at IS NULL
 * - Re-syncs FBA inventory for those specific ASINs
 * - Runs AI re-analysis for each item
 * - Creates notifications with outcomes
 *
 * Intended to be called by a cron job (e.g., daily at 8am via Coolify cron or external scheduler).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fetchFBAInventoryForAsins, fetchInventoryHealthReport } from '@/lib/amazon/catalog'
import { generateExcessActionPlan, buildExcessContext } from '@/lib/fba/excessActionPlan'
import type { InventoryHealthItem } from '@/lib/amazon/catalog'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(req: NextRequest) {
  // Protect with CRON_SECRET
  const secret = req.headers.get('x-cron-secret') || req.headers.get('authorization')?.replace('Bearer ', '')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminSupabase()
  const results: { sku: string; outcome: string; status: string }[] = []
  const errors: string[] = []

  // Find items due for re-analysis
  const { data: dueItems, error: fetchErr } = await supabase
    .from('excess_inventory')
    .select('*')
    .lte('recheck_due_at', new Date().toISOString())
    .is('recheck_completed_at', null)
    .in('status', ['actioned', 'active'])

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }

  if (!dueItems || dueItems.length === 0) {
    return NextResponse.json({ message: 'No items due for re-analysis', processed: 0 })
  }

  console.log(`[Re-analysis] ${dueItems.length} items due for re-analysis`)

  // Re-fetch inventory health for these ASINs
  let freshHealthMap = new Map<string, InventoryHealthItem>()
  try {
    freshHealthMap = await fetchInventoryHealthReport()
  } catch (err) {
    errors.push(`Failed to fetch fresh inventory health: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Also re-fetch FBA inventory quantities
  const asinsToCheck = [...new Set(dueItems.map(i => i.asin))]
  let freshInventory: Awaited<ReturnType<typeof fetchFBAInventoryForAsins>> = []
  try {
    freshInventory = await fetchFBAInventoryForAsins(asinsToCheck)
  } catch (err) {
    errors.push(`Failed to fetch fresh FBA inventory: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Build fresh inventory map by ASIN
  const freshInvMap = new Map<string, { qty_available: number; units_sold_30d: number }>()
  for (const inv of freshInventory) {
    const existing = freshInvMap.get(inv.asin)
    if (!existing) {
      freshInvMap.set(inv.asin, { qty_available: inv.quantity_available, units_sold_30d: 0 })
    } else {
      existing.qty_available += inv.quantity_available
    }
  }

  // Get FBM velocity for context
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: orderData } = await supabase
    .from('orders')
    .select('order_items')
    .gte('purchase_date', thirtyDaysAgo)

  const fbmVelocityMap = new Map<string, number>()
  for (const row of orderData || []) {
    const items = row.order_items as Array<{ asin?: string; qty?: number; quantity_ordered?: number }> || []
    for (const item of items) {
      if (!item.asin) continue
      const qty = item.qty || item.quantity_ordered || 1
      fbmVelocityMap.set(item.asin, (fbmVelocityMap.get(item.asin) || 0) + qty)
    }
  }

  // Process each due item
  for (const item of dueItems) {
    try {
      // Get fresh health data for this SKU
      const freshHealth = freshHealthMap.get(item.sku)
      const freshInv = freshInvMap.get(item.asin)

      // Build current state — use fresh data if available, fall back to stored
      const currentQty = freshInv?.qty_available ?? item.qty_available
      const currentExcessQty = freshHealth?.excess_qty ?? item.excess_qty
      const currentDaysOfSupply = freshHealth?.days_of_supply ?? item.days_of_supply
      const currentUnitsSold30d = freshHealth?.units_sold_last_30_days ?? item.units_sold_last_30_days

      // Update the stored record with fresh data
      await supabase
        .from('excess_inventory')
        .update({
          qty_available: currentQty,
          excess_qty: currentExcessQty,
          days_of_supply: currentDaysOfSupply,
          units_sold_last_30_days: currentUnitsSold30d,
          last_synced_at: new Date().toISOString(),
        })
        .eq('sku', item.sku)

      // Build the health item for AI context
      const healthItem: InventoryHealthItem = {
        asin: item.asin,
        sku: item.sku,
        fnsku: item.fnsku || '',
        product_name: item.product_name,
        condition: 'New',
        qty_available: currentQty,
        qty_inbound_working: 0,
        qty_inbound_shipped: 0,
        qty_inbound_receiving: 0,
        qty_inbound_total: 0,
        qty_reserved: 0,
        units_sold_last_7_days: 0,
        units_sold_last_30_days: currentUnitsSold30d,
        units_sold_last_60_days: 0,
        units_sold_last_90_days: 0,
        is_excess: currentExcessQty > 0,
        excess_qty: currentExcessQty,
        days_of_supply: currentDaysOfSupply,
        days_of_supply_with_inbound: 0,
        historical_days_of_supply: 0,
        weeks_of_cover_t30: 0,
        weeks_of_cover_t90: 0,
        recommended_action: item.amazon_recommended_action || '',
        estimated_monthly_storage_fee: item.estimated_monthly_storage_fee,
        estimated_storage_cost_per_unit: item.estimated_storage_cost_per_unit,
        your_price: item.your_price,
        sales_price: null,
        featured_offer_price: 0,
        fba_inventory_level_health: '',
        alert: item.amazon_alert || 'Excess inventory',
        inv_age_0_to_90: 0,
        inv_age_91_to_180: 0,
        inv_age_181_to_270: 0,
        inv_age_271_to_365: 0,
        inv_age_366_plus: 0,
      }

      const fbmUnits30d = fbmVelocityMap.get(item.asin) || 0
      const daysSinceAction = item.action_taken_at
        ? Math.floor((Date.now() - new Date(item.action_taken_at).getTime()) / (1000 * 60 * 60 * 24))
        : undefined

      const context = buildExcessContext(healthItem, fbmUnits30d, {
        is_reanalysis: true,
        previous_plan: item.ai_action_plan || undefined,
        action_taken: item.action_taken || undefined,
        days_since_action: daysSinceAction,
        outcome_qty: currentQty,
        outcome_units_sold_30d: currentUnitsSold30d,
        outcome_days_of_supply: currentDaysOfSupply,
        outcome_excess_qty: currentExcessQty,
      })

      // Generate re-analysis plan
      const plan = await generateExcessActionPlan(context)

      // Determine outcome status
      const originalExcess = item.excess_qty || 1
      const excessReduced = currentExcessQty < originalExcess * 0.5
      const fullyCleared = currentExcessQty === 0
      const newStatus = fullyCleared ? 'resolved' : excessReduced ? 'resolved' : 'escalated'

      // Compute next recheck date
      const nextRecheckDate = new Date(Date.now() + plan.recheck_days * 24 * 60 * 60 * 1000).toISOString()

      // Update the item
      await supabase
        .from('excess_inventory')
        .update({
          ai_action_plan: plan.plan,
          ai_plan_generated_at: new Date().toISOString(),
          ai_plan_model: plan.model,
          recheck_completed_at: new Date().toISOString(),
          recheck_outcome: plan.plan,
          outcome_qty_available: currentQty,
          outcome_units_sold_30d: currentUnitsSold30d,
          outcome_days_of_supply: currentDaysOfSupply,
          outcome_excess_qty: currentExcessQty,
          status: newStatus,
          // Schedule next recheck if still not resolved
          recheck_due_at: newStatus !== 'resolved' ? nextRecheckDate : null,
        })
        .eq('sku', item.sku)

      // Create notification
      const emoji = fullyCleared ? '✅' : excessReduced ? '📉' : '⚠️'
      const outcomeText = fullyCleared
        ? 'Excess fully cleared!'
        : excessReduced
        ? `Excess reduced from ${item.excess_qty} → ${currentExcessQty} units`
        : `Still ${currentExcessQty} excess units — escalated recommendation`

      await supabase.from('fba_notifications').insert({
        type: 'reanalysis_complete',
        title: `${emoji} Re-analysis: ${item.product_name.substring(0, 45)}`,
        message: `${outcomeText}. ${plan.plan.substring(0, 150)}`,
        asin: item.asin,
        sku: item.sku,
        excess_id: item.id,
      })

      results.push({ sku: item.sku, outcome: outcomeText, status: newStatus })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      errors.push(`Re-analysis failed for SKU ${item.sku}: ${errMsg}`)
      results.push({ sku: item.sku, outcome: 'error', status: 'error' })
    }
  }

  return NextResponse.json({
    processed: dueItems.length,
    results,
    errors,
  })
}
