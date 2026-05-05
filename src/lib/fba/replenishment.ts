/**
 * FBA Replenishment Scoring Engine
 *
 * Data sources (all from Supabase — no live API calls at report time):
 * - orders table: FBM velocity, customization flags, product titles/SKUs
 * - fba_inventory table: current FBA stock (populated by sync)
 */

import { createClient } from '@supabase/supabase-js'
import { computeFBMVelocity, getFBASettings } from '@/lib/sync/syncCatalog'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export type ReplenishmentStatus =
  | 'healthy'        // FBA weeks of cover > trigger threshold
  | 'watch'          // FBA weeks of cover between 50%-100% of trigger
  | 'replenish'      // FBA weeks of cover below trigger — send now
  | 'critical'       // FBA weeks of cover < 2 weeks — FBM carrying load
  | 'stocked_out'    // FBA qty = 0
  | 'new_candidate'  // No FBA twin, FBM velocity >= threshold
  | 'overstocked'    // FBA weeks of cover > 3x trigger
  | 'no_data'        // Not enough data to score

export interface ProductRecommendation {
  // Identity
  asin: string
  fba_asin: string | null
  sku: string
  title: string

  // FBM velocity (from orders table)
  fbm_units_30d: number
  fbm_velocity_per_day: number

  // FBA data (from fba_inventory table, populated by sync)
  fba_qty_available: number
  fba_qty_inbound: number
  fba_qty_total: number
  fba_units_sold_30d: number      // From Sales & Traffic Report (if synced)
  fba_buy_box_pct: number         // Buy Box % (if synced)

  // Scoring
  weeks_of_cover: number | null
  status: ReplenishmentStatus
  status_label: string

  // Recommendation
  recommended_send_qty: number
  send_rationale: string

  // Flags
  has_customization: boolean
  is_fba_only: boolean            // Has FBA inventory but no FBM orders (pure FBA product)

  // Meta
  last_fba_sync: string | null
}

const STATUS_LABELS: Record<ReplenishmentStatus, string> = {
  healthy: 'Healthy',
  watch: 'Watch',
  replenish: 'Replenish Now',
  critical: 'Critical',
  stocked_out: 'Stocked Out',
  new_candidate: 'Create FBA Listing',
  overstocked: 'Overstocked',
  no_data: 'No Data',
}

/**
 * Generate full replenishment recommendations.
 * Uses only data already in Supabase — no live API calls.
 */
export async function generateReplenishmentReport(): Promise<ProductRecommendation[]> {
  const supabase = getAdminSupabase()
  const settings = await getFBASettings()

  // ── 1. Compute FBM velocity from orders ──────────────────────────────────
  const velocityMap = await computeFBMVelocity()

  // ── 2. Load FBA inventory from Supabase ──────────────────────────────────
  const { data: invRows } = await supabase
    .from('fba_inventory')
    .select('*')

  // Build FBA inventory map: ASIN → aggregated inventory
  const fbaInvMap = new Map<string, {
    quantity_available: number
    quantity_inbound: number
    quantity_total: number
    units_sold_30d: number
    buy_box_percentage: number
    last_synced_at: string | null
  }>()

  for (const inv of invRows || []) {
    const existing = fbaInvMap.get(inv.asin)
    if (!existing) {
      fbaInvMap.set(inv.asin, {
        quantity_available: inv.quantity_available || 0,
        quantity_inbound: inv.quantity_inbound || 0,
        quantity_total: inv.quantity_total || 0,
        units_sold_30d: inv.units_sold_30d || 0,
        buy_box_percentage: inv.buy_box_percentage || 0,
        last_synced_at: inv.last_synced_at || null,
      })
    } else {
      // Aggregate multiple SKUs for same ASIN
      existing.quantity_available += inv.quantity_available || 0
      existing.quantity_inbound += inv.quantity_inbound || 0
      existing.quantity_total += inv.quantity_total || 0
      existing.units_sold_30d += inv.units_sold_30d || 0
    }
  }

  // ── 3. Build recommendations ──────────────────────────────────────────────
  const recommendations: ProductRecommendation[] = []

  // All ASINs we know about = union of FBM orders + FBA inventory
  const allAsins = new Set([
    ...velocityMap.keys(),
    ...fbaInvMap.keys(),
  ])

  for (const asin of allAsins) {
    const fbmData = velocityMap.get(asin)
    const fbaInv = fbaInvMap.get(asin)

    const fbmUnits30d = fbmData?.units30d || 0
    const fbmVelocityPerDay = fbmData?.velocityPerDay || 0
    const hasCustomization = fbmData?.hasCustomization || false
    const title = fbmData?.title || `ASIN: ${asin}`
    const sku = fbmData?.sku || ''

    const fbaQtyAvailable = fbaInv?.quantity_available || 0
    const fbaQtyInbound = fbaInv?.quantity_inbound || 0
    const fbaQtyTotal = fbaInv?.quantity_total || 0
    const fbaUnitsSold30d = fbaInv?.units_sold_30d || 0
    const fbaBuyBoxPct = fbaInv?.buy_box_percentage || 0
    const lastFbaSync = fbaInv?.last_synced_at || null

    const hasFBAInventory = fbaInv !== undefined
    const isFBAOnly = hasFBAInventory && fbmUnits30d === 0

    // Use combined velocity (FBM + FBA) for weeks-of-cover calculation
    // FBA velocity from report is more accurate than FBM alone
    const combinedVelocityPerDay = fbaUnitsSold30d > 0
      ? (fbaUnitsSold30d / 30)
      : fbmVelocityPerDay

    // Compute weeks of cover
    let weeksOfCover: number | null = null
    if (hasFBAInventory && combinedVelocityPerDay > 0) {
      weeksOfCover = fbaQtyAvailable / (combinedVelocityPerDay * 7)
    } else if (hasFBAInventory && fbaQtyAvailable > 0) {
      weeksOfCover = 999 // has stock but no velocity — treat as infinite
    }

    // Determine status
    let status: ReplenishmentStatus = 'no_data'
    let recommendedSendQty = 0
    let sendRationale = ''

    if (hasCustomization) {
      status = 'no_data'
      sendRationale = 'Customized product — FBA not applicable'
    } else if (!hasFBAInventory) {
      // No FBA record at all — check if it's a new candidate
      if (fbmUnits30d >= settings.newFBACandidateMinUnits) {
        status = 'new_candidate'
        recommendedSendQty = Math.ceil(fbmVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
        sendRationale = `${fbmUnits30d} units/30d via FBM. No FBA listing found. Initial send covers lead time (${settings.leadTimeDays}d) + buffer (${settings.safetyBufferDays}d).`
      } else {
        status = 'no_data'
        sendRationale = `${fbmUnits30d} units/30d — below ${settings.newFBACandidateMinUnits} unit threshold for FBA recommendation`
      }
    } else if (fbaQtyAvailable === 0 && fbaQtyInbound === 0) {
      status = 'stocked_out'
      recommendedSendQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      sendRationale = `FBA stocked out. Send to cover lead time (${settings.leadTimeDays}d) + buffer (${settings.safetyBufferDays}d).`
    } else if (weeksOfCover !== null && weeksOfCover < 2) {
      status = 'critical'
      const targetQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(0, targetQty - fbaQtyAvailable - fbaQtyInbound)
      sendRationale = `Only ${weeksOfCover.toFixed(1)} weeks of cover. FBM is carrying load. Send immediately.`
    } else if (weeksOfCover !== null && weeksOfCover < settings.replenishTriggerWeeks) {
      status = 'replenish'
      const targetQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(0, targetQty - fbaQtyAvailable - fbaQtyInbound)
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover remaining. Send now to avoid stockout.`
    } else if (weeksOfCover !== null && weeksOfCover < settings.replenishTriggerWeeks * 2) {
      status = 'watch'
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover. Monitor — approaching replenishment threshold.`
    } else if (weeksOfCover !== null && weeksOfCover > settings.replenishTriggerWeeks * 3) {
      status = 'overstocked'
      sendRationale = `${weeksOfCover === 999 ? 'No recent sales' : `${weeksOfCover.toFixed(0)} weeks`} of cover. Consider pausing FBA shipments.`
    } else if (weeksOfCover !== null) {
      status = 'healthy'
      sendRationale = `${weeksOfCover === 999 ? 'Sufficient' : `${weeksOfCover.toFixed(1)} weeks`} of FBA cover. No action needed.`
    }

    recommendations.push({
      asin,
      fba_asin: hasFBAInventory ? asin : null,
      sku,
      title,
      fbm_units_30d: fbmUnits30d,
      fbm_velocity_per_day: fbmVelocityPerDay,
      fba_qty_available: fbaQtyAvailable,
      fba_qty_inbound: fbaQtyInbound,
      fba_qty_total: fbaQtyTotal,
      fba_units_sold_30d: fbaUnitsSold30d,
      fba_buy_box_pct: fbaBuyBoxPct,
      weeks_of_cover: weeksOfCover === 999 ? null : weeksOfCover,
      status,
      status_label: STATUS_LABELS[status],
      recommended_send_qty: recommendedSendQty,
      send_rationale: sendRationale,
      has_customization: hasCustomization,
      is_fba_only: isFBAOnly,
      last_fba_sync: lastFbaSync,
    })
  }

  // Sort: urgent first (stocked_out → critical → replenish → new_candidate → watch → healthy → overstocked → no_data)
  const statusOrder: Record<ReplenishmentStatus, number> = {
    stocked_out: 0,
    critical: 1,
    replenish: 2,
    new_candidate: 3,
    watch: 4,
    healthy: 5,
    overstocked: 6,
    no_data: 7,
  }

  recommendations.sort((a, b) => {
    const orderDiff = statusOrder[a.status] - statusOrder[b.status]
    if (orderDiff !== 0) return orderDiff
    return b.fbm_units_30d - a.fbm_units_30d // within same status, sort by volume
  })

  return recommendations
}

/**
 * Generate Team Report CSV
 */
export function generateTeamCSV(report: ProductRecommendation[]): string {
  const headers = [
    'ASIN', 'SKU', 'Title', 'Status',
    'FBM Units (30d)', 'FBM Velocity/Day',
    'FBA Available', 'FBA Inbound', 'FBA Sold (30d)', 'Buy Box %',
    'Weeks of Cover', 'Recommended Send Qty', 'Rationale',
  ]

  const rows = report
    .filter(r => r.status !== 'no_data')
    .map(r => [
      r.asin,
      r.sku,
      `"${r.title.replace(/"/g, '""')}"`,
      r.status_label,
      r.fbm_units_30d,
      r.fbm_velocity_per_day.toFixed(2),
      r.fba_qty_available,
      r.fba_qty_inbound,
      r.fba_units_sold_30d,
      r.fba_buy_box_pct > 0 ? `${r.fba_buy_box_pct.toFixed(1)}%` : 'N/A',
      r.weeks_of_cover !== null ? r.weeks_of_cover.toFixed(1) : 'N/A',
      r.recommended_send_qty,
      `"${r.send_rationale.replace(/"/g, '""')}"`,
    ])

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
}

/**
 * Generate Amazon Shipment-Ready CSV
 * Format: MSKU, ASIN, Quantity — ready for Amazon FBA Create Shipment bulk upload
 */
export function generateAmazonShipmentCSV(report: ProductRecommendation[]): string {
  const headers = ['Merchant SKU', 'ASIN', 'Quantity to Ship', 'Condition', 'Notes']

  const rows = report
    .filter(r => r.recommended_send_qty > 0 && ['stocked_out', 'critical', 'replenish', 'new_candidate'].includes(r.status))
    .map(r => [
      r.sku || r.asin,
      r.asin,
      r.recommended_send_qty,
      'NewItem',
      `"${r.status_label}: ${r.send_rationale.substring(0, 80).replace(/"/g, '""')}"`,
    ])

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
}
