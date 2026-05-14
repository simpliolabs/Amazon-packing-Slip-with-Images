/**
 * FBA Excess Inventory API Route
 *
 * GET  /api/fba/excess          — list all excess inventory items
 * POST /api/fba/excess          — generate AI action plan for a specific item
 * PATCH /api/fba/excess         — update action taken for an item
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateExcessActionPlan, buildExcessContext } from '@/lib/fba/excessActionPlan'
import { generateReplenishmentReport } from '@/lib/fba/replenishment'
import type { InventoryHealthItem } from '@/lib/amazon/catalog'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function requireAuth(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return false

  const token = authHeader.slice(7)
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data: { user } } = await supabase.auth.getUser(token)
  return !!user
}

/**
 * GET /api/fba/excess
 * Returns all excess inventory items with their AI plans and action history.
 */
export async function GET(req: NextRequest) {
  if (!await requireAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminSupabase()
  const { searchParams } = new URL(req.url)
  const status = searchParams.get('status') || 'all'
  const format = searchParams.get('format')

  let query = supabase
    .from('excess_inventory')
    .select('*')
    .order('days_of_supply', { ascending: false })

  if (status !== 'all') {
    query = query.eq('status', status)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let items = data || []

  // ── Auto-populate from replenishment engine when table is empty ──────────
  // The excess_inventory table only gets populated during heavy "Sync FBA Data".
  // If it's empty, we can still show overstocked items from the replenishment engine.
  if (items.length === 0 && format !== 'csv') {
    try {
      const report = await generateReplenishmentReport()
      const overstocked = report.filter(r =>
        r.status === 'overstocked' && r.fba_qty_available > 0
      )

      if (overstocked.length > 0) {
        // Insert overstocked items into excess_inventory
        const inserts = overstocked.map(r => {
          const weeksOfCover = r.weeks_of_cover || 0
          const daysOfSupply = Math.round(weeksOfCover * 7)
          // Estimate excess: anything beyond 12 weeks of cover is excess
          const dailyVelocity = r.fbm_velocity_per_day + (r.fba_units_sold_30d / 30)
          const healthyStock = Math.ceil(dailyVelocity * 90) // 90 days = healthy
          const excessQty = Math.max(0, r.fba_qty_available - healthyStock)

          return {
            asin: r.fba_asin || r.asin,
            sku: r.fba_sku || r.sku,
            product_name: r.title || '',
            qty_available: r.fba_qty_available,
            excess_qty: excessQty,
            days_of_supply: daysOfSupply,
            units_sold_last_30_days: r.fba_units_sold_30d + r.fbm_units_30d,
            your_price: 0, // Will be enriched when Inventory Health Report is synced
            estimated_monthly_storage_fee: 0,
            estimated_storage_cost_per_unit: 0,
            amazon_alert: `Overstocked: ${weeksOfCover.toFixed(0)} weeks of cover (${r.fba_qty_available} units on hand)`,
            status: 'active',
          }
        })

        // Upsert into excess_inventory (on conflict by SKU, update)
        const { error: insertErr } = await supabase
          .from('excess_inventory')
          .upsert(inserts, { onConflict: 'sku' })

        if (!insertErr) {
          // Re-fetch the newly inserted items
          const { data: freshData } = await supabase
            .from('excess_inventory')
            .select('*')
            .order('days_of_supply', { ascending: false })
          items = freshData || []
        } else {
          console.error('[Excess] Auto-populate insert error:', insertErr.message)
        }
      }
    } catch (err) {
      console.error('[Excess] Auto-populate from replenishment error:', err)
    }
  }

  // CSV export
  if (format === 'csv') {
    const csv = generateExcessCSV(items)
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="excess-inventory-${new Date().toISOString().split('T')[0]}.csv"`,
      },
    })
  }

  // Summary counts
  const summary = {
    total: items.length,
    active: items.filter(i => i.status === 'active').length,
    actioned: items.filter(i => i.status === 'actioned').length,
    resolved: items.filter(i => i.status === 'resolved').length,
    escalated: items.filter(i => i.status === 'escalated').length,
    total_excess_units: items.reduce((sum, i) => sum + (i.excess_qty || 0), 0),
    total_monthly_storage_cost: items.reduce((sum, i) => sum + (i.estimated_monthly_storage_fee || 0), 0),
    needs_ai_plan: items.filter(i => !i.ai_action_plan && i.status === 'active').length,
  }

  return NextResponse.json({ items, summary })
}

/**
 * POST /api/fba/excess
 * Generate an AI action plan for a specific excess inventory item.
 * Body: { sku: string, is_reanalysis?: boolean }
 */
export async function POST(req: NextRequest) {
  if (!await requireAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminSupabase()

  let body: { sku?: string; is_reanalysis?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.sku) {
    return NextResponse.json({ error: 'sku is required' }, { status: 400 })
  }

  // Fetch the excess item
  const { data: item, error: fetchErr } = await supabase
    .from('excess_inventory')
    .select('*')
    .eq('sku', body.sku)
    .single()

  if (fetchErr || !item) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 })
  }

  // Build context for the LLM
  // Reconstruct InventoryHealthItem from stored data
  const healthItem: InventoryHealthItem = {
    asin: item.asin,
    sku: item.sku,
    fnsku: item.fnsku || '',
    product_name: item.product_name,
    condition: 'New',
    qty_available: item.qty_available,
    qty_inbound_working: 0,
    qty_inbound_shipped: 0,
    qty_inbound_receiving: 0,
    units_sold_last_30_days: item.units_sold_last_30_days,
    is_excess: true,
    excess_qty: item.excess_qty,
    days_of_supply: item.days_of_supply,
    recommended_action: item.amazon_recommended_action || '',
    estimated_monthly_storage_fee: item.estimated_monthly_storage_fee,
    estimated_storage_cost_per_unit: item.estimated_storage_cost_per_unit,
    your_price: item.your_price,
    sales_price: null,
    alert: item.amazon_alert || 'Excess inventory',
  }

  // Get FBM velocity for this ASIN from orders
  const { data: orderData } = await supabase
    .from('orders')
    .select('order_items')
    .gte('purchase_date', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())

  let fbmUnits30d = 0
  for (const row of orderData || []) {
    const items = row.order_items as Array<{ asin?: string; qty?: number; quantity_ordered?: number }> || []
    for (const orderItem of items) {
      if (orderItem.asin === item.asin) {
        fbmUnits30d += orderItem.qty || orderItem.quantity_ordered || 1
      }
    }
  }

  // Build re-analysis context if applicable
  const isReanalysis = body.is_reanalysis && !!item.action_taken
  const daysSinceAction = item.action_taken_at
    ? Math.floor((Date.now() - new Date(item.action_taken_at).getTime()) / (1000 * 60 * 60 * 24))
    : undefined

  const context = buildExcessContext(healthItem, fbmUnits30d, {
    is_reanalysis: isReanalysis,
    previous_plan: item.ai_action_plan || undefined,
    action_taken: item.action_taken || undefined,
    days_since_action: daysSinceAction,
    // For re-analysis, current state IS the outcome
    outcome_qty: isReanalysis ? item.qty_available : undefined,
    outcome_units_sold_30d: isReanalysis ? item.units_sold_last_30_days : undefined,
    outcome_days_of_supply: isReanalysis ? item.days_of_supply : undefined,
    outcome_excess_qty: isReanalysis ? item.excess_qty : undefined,
  })

  // Generate the AI plan
  const plan = await generateExcessActionPlan(context)

  // Compute recheck date
  const recheckDate = new Date(Date.now() + plan.recheck_days * 24 * 60 * 60 * 1000).toISOString()

  // Determine new status
  let newStatus = item.status
  if (isReanalysis) {
    // After re-analysis, determine if resolved or escalated
    const excessReduced = (item.outcome_excess_qty ?? item.excess_qty) < item.excess_qty * 0.5
    newStatus = excessReduced ? 'resolved' : 'escalated'
  }

  // Update the item with the new plan
  const updateData: Record<string, unknown> = {
    ai_action_plan: plan.plan,
    ai_plan_generated_at: new Date().toISOString(),
    ai_plan_model: plan.model,
    recheck_due_at: recheckDate,
  }

  if (isReanalysis) {
    updateData.recheck_completed_at = new Date().toISOString()
    updateData.recheck_outcome = plan.plan
    updateData.outcome_qty_available = item.qty_available
    updateData.outcome_units_sold_30d = item.units_sold_last_30_days
    updateData.outcome_days_of_supply = item.days_of_supply
    updateData.outcome_excess_qty = item.excess_qty
    updateData.status = newStatus
  }

  const { error: updateErr } = await supabase
    .from('excess_inventory')
    .update(updateData)
    .eq('sku', body.sku)

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  // Create notification for re-analysis completion
  if (isReanalysis) {
    const outcomeEmoji = newStatus === 'resolved' ? '✓' : '⚠'
    await supabase.from('fba_notifications').insert({
      type: 'reanalysis_complete',
      title: `${outcomeEmoji} Re-analysis complete: ${item.product_name.substring(0, 40)}`,
      message: plan.plan.substring(0, 200),
      asin: item.asin,
      sku: item.sku,
      excess_id: item.id,
    })
  }

  return NextResponse.json({
    plan: plan.plan,
    urgency: plan.urgency,
    primary_action: plan.primary_action,
    recheck_days: plan.recheck_days,
    recheck_due_at: recheckDate,
    status: newStatus,
  })
}

/**
 * PATCH /api/fba/excess
 * Update the action taken for an excess inventory item.
 * Body: { sku: string, action: string, notes?: string }
 */
export async function PATCH(req: NextRequest) {
  if (!await requireAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getAdminSupabase()

  let body: { sku?: string; action?: string; notes?: string; dismissed?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.sku) {
    return NextResponse.json({ error: 'sku is required' }, { status: 400 })
  }

  const validActions = ['ran_sale', 'created_outlet_deal', 'removed', 'held', 'pending']

  if (body.dismissed) {
    // Dismiss the item
    const { error } = await supabase
      .from('excess_inventory')
      .update({ status: 'dismissed' })
      .eq('sku', body.sku)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, status: 'dismissed' })
  }

  if (!body.action || !validActions.includes(body.action)) {
    return NextResponse.json({ error: `action must be one of: ${validActions.join(', ')}` }, { status: 400 })
  }

  // Get current item to compute recheck date based on action
  const { data: item } = await supabase
    .from('excess_inventory')
    .select('id, ai_action_plan, recheck_due_at')
    .eq('sku', body.sku)
    .single()

  // Set recheck window based on action taken
  const recheckDays: Record<string, number> = {
    ran_sale: 7,
    created_outlet_deal: 14,
    removed: 30,
    held: 21,
    pending: 7,
  }
  const days = recheckDays[body.action] || 7
  const recheckDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('excess_inventory')
    .update({
      action_taken: body.action,
      action_taken_at: new Date().toISOString(),
      action_notes: body.notes || null,
      status: 'actioned',
      recheck_due_at: recheckDate,
      recheck_completed_at: null, // Reset so auto re-analysis will run
    })
    .eq('sku', body.sku)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Create a reminder notification
  const actionLabels: Record<string, string> = {
    ran_sale: 'ran a sale',
    created_outlet_deal: 'created an Outlet Deal',
    removed: 'initiated removal',
    held: 'decided to hold',
    pending: 'marked as pending',
  }

  await supabase.from('fba_notifications').insert({
    type: 'action_reminder',
    title: `Action logged — re-analysis scheduled in ${days} days`,
    message: `You ${actionLabels[body.action]} on this item. Auto re-analysis will run on ${new Date(recheckDate).toLocaleDateString()}.`,
    asin: item?.id ? undefined : undefined,
    sku: body.sku,
    excess_id: item?.id || null,
  })

  return NextResponse.json({
    success: true,
    action_taken: body.action,
    recheck_due_at: recheckDate,
    status: 'actioned',
  })
}

/**
 * Generate CSV export for excess inventory items.
 */
function generateExcessCSV(items: Record<string, unknown>[]): string {
  const headers = [
    'SKU', 'ASIN', 'Product', 'Status',
    'FBA On-Hand', 'Excess Units', 'Days of Supply',
    'Units Sold (30d)', 'Your Price',
    'Monthly Storage Fee', 'Storage Cost/Unit',
    'Amazon Alert', 'Action Taken',
    'AI Action Plan',
    'Recheck Due',
  ]

  const rows = items.map(i => [
    i.sku,
    i.asin,
    `"${String(i.product_name || '').replace(/"/g, '""')}"`,
    i.status,
    i.qty_available,
    i.excess_qty,
    i.days_of_supply,
    i.units_sold_last_30_days,
    `$${Number(i.your_price || 0).toFixed(2)}`,
    `$${Number(i.estimated_monthly_storage_fee || 0).toFixed(2)}`,
    `$${Number(i.estimated_storage_cost_per_unit || 0).toFixed(2)}`,
    `"${String(i.amazon_alert || '').replace(/"/g, '""')}"`,
    i.action_taken || 'none',
    `"${String(i.ai_action_plan || '').replace(/"/g, '""').substring(0, 200)}"`,
    i.recheck_due_at ? new Date(String(i.recheck_due_at)).toLocaleDateString() : '',
  ])

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
}
