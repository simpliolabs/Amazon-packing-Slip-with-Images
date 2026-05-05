/**
 * FBA Replenishment Scoring Engine
 * Computes replenishment status and recommended send quantities per product.
 */

import { createClient } from '@supabase/supabase-js'
import { computeFBMVelocity, getFBASettings } from '@/lib/sync/syncCatalog'
import { pairFBAFBMProducts } from '@/lib/amazon/catalog'
import type { CatalogProduct } from '@/lib/amazon/catalog'

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
  fbm_asin: string
  fba_asin: string | null
  sku: string
  title: string

  // Velocity
  fbm_units_30d: number
  velocity_per_day: number

  // Inventory
  fba_qty_available: number
  fba_qty_inbound: number
  fba_qty_total: number

  // Scoring
  weeks_of_cover: number | null
  status: ReplenishmentStatus
  status_label: string

  // Recommendation
  recommended_send_qty: number
  send_rationale: string

  // Customization flag (never FBA)
  has_customization: boolean

  // Timestamps
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
 * Generate full replenishment recommendations for all FBM products.
 */
export async function generateReplenishmentReport(): Promise<ProductRecommendation[]> {
  const supabase = getAdminSupabase()
  const settings = await getFBASettings()

  // ── 1. Load catalog products ──────────────────────────────────────────
  const { data: catalogRows, error: catErr } = await supabase
    .from('catalog_products')
    .select('*')

  if (catErr) throw new Error(`Failed to load catalog: ${catErr.message}`)
  const catalog = (catalogRows || []) as CatalogProduct[]

  // ── 2. Load FBA inventory ─────────────────────────────────────────────
  const { data: invRows } = await supabase
    .from('fba_inventory')
    .select('*')

  const invByAsin = new Map<string, {
    quantity_available: number
    quantity_inbound: number
    quantity_total: number
    last_synced_at: string
  }>()

  for (const inv of invRows || []) {
    const existing = invByAsin.get(inv.asin)
    if (!existing) {
      invByAsin.set(inv.asin, {
        quantity_available: inv.quantity_available,
        quantity_inbound: inv.quantity_inbound,
        quantity_total: inv.quantity_total,
        last_synced_at: inv.last_synced_at,
      })
    } else {
      // Aggregate multiple SKUs for same ASIN
      invByAsin.set(inv.asin, {
        quantity_available: existing.quantity_available + inv.quantity_available,
        quantity_inbound: existing.quantity_inbound + inv.quantity_inbound,
        quantity_total: existing.quantity_total + inv.quantity_total,
        last_synced_at: inv.last_synced_at,
      })
    }
  }

  // ── 3. Compute FBM velocity from orders ───────────────────────────────
  const velocityMap = await computeFBMVelocity()

  // ── 4. Pair FBA/FBM products ──────────────────────────────────────────
  const pairMap = pairFBAFBMProducts(catalog)

  // ── 5. Detect customized ASINs ────────────────────────────────────────
  const { data: customOrders } = await supabase
    .from('orders')
    .select('order_items')
    .not('order_items', 'is', null)

  const customizedAsins = new Set<string>()
  for (const order of customOrders || []) {
    const items = order.order_items as Array<{ asin: string; customization?: unknown }> || []
    for (const item of items) {
      if (item.customization && item.asin) {
        customizedAsins.add(item.asin)
      }
    }
  }

  // ── 6. Score each FBM product ─────────────────────────────────────────
  const fbmProducts = catalog.filter(p => p.fulfillment_channel === 'MFN')
  const recommendations: ProductRecommendation[] = []

  for (const fbm of fbmProducts) {
    const fbaAsin = pairMap.get(fbm.asin) || null
    const fbmUnits30d = velocityMap.get(fbm.asin) || 0
    const velocityPerDay = fbmUnits30d / 30
    const hasCustomization = customizedAsins.has(fbm.asin)

    const fbaInv = fbaAsin ? invByAsin.get(fbaAsin) : null
    const fbaQtyAvailable = fbaInv?.quantity_available || 0
    const fbaQtyInbound = fbaInv?.quantity_inbound || 0
    const fbaQtyTotal = fbaInv?.quantity_total || 0

    // Compute weeks of cover
    let weeksOfCover: number | null = null
    if (fbaAsin && velocityPerDay > 0) {
      weeksOfCover = fbaQtyAvailable / (velocityPerDay * 7)
    } else if (fbaAsin && fbaQtyAvailable > 0) {
      weeksOfCover = 999 // has stock but no velocity — infinite cover
    }

    // Determine status
    let status: ReplenishmentStatus = 'no_data'
    let recommendedSendQty = 0
    let sendRationale = ''

    if (hasCustomization) {
      // Customized products cannot go to FBA
      status = 'no_data'
      sendRationale = 'Customized product — FBA not applicable'
    } else if (!fbaAsin) {
      // No FBA twin exists
      if (fbmUnits30d >= settings.newFBACandidateMinUnits) {
        status = 'new_candidate'
        // Initial send: velocity × (lead_time + safety_buffer)
        recommendedSendQty = Math.ceil(velocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
        sendRationale = `${fbmUnits30d} units/30d via FBM. No FBA listing exists. Initial send covers lead time (${settings.leadTimeDays}d) + buffer (${settings.safetyBufferDays}d).`
      } else {
        status = 'no_data'
        sendRationale = `Only ${fbmUnits30d} units/30d — below ${settings.newFBACandidateMinUnits} unit threshold for FBA`
      }
    } else if (fbaQtyAvailable === 0 && fbaQtyInbound === 0) {
      status = 'stocked_out'
      recommendedSendQty = Math.ceil(velocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      sendRationale = `FBA stocked out. Send to cover lead time (${settings.leadTimeDays}d) + buffer (${settings.safetyBufferDays}d).`
    } else if (weeksOfCover !== null && weeksOfCover < 2) {
      status = 'critical'
      const targetQty = Math.ceil(velocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(0, targetQty - fbaQtyAvailable - fbaQtyInbound)
      sendRationale = `Only ${weeksOfCover.toFixed(1)} weeks of cover. FBM is carrying load. Send immediately.`
    } else if (weeksOfCover !== null && weeksOfCover < settings.replenishTriggerWeeks) {
      status = 'replenish'
      const targetQty = Math.ceil(velocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(0, targetQty - fbaQtyAvailable - fbaQtyInbound)
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover remaining. Send now to avoid stockout.`
    } else if (weeksOfCover !== null && weeksOfCover < settings.replenishTriggerWeeks * 2) {
      status = 'watch'
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover. Monitor — approaching replenishment threshold.`
    } else if (weeksOfCover !== null && weeksOfCover > settings.replenishTriggerWeeks * 3) {
      status = 'overstocked'
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover. Consider pausing FBA sends.`
    } else if (weeksOfCover !== null) {
      status = 'healthy'
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover. No action needed.`
    } else {
      status = 'no_data'
      sendRationale = 'No velocity data available for this product.'
    }

    recommendations.push({
      fbm_asin: fbm.asin,
      fba_asin: fbaAsin,
      sku: fbm.sku,
      title: fbm.title || fbm.item_name || fbm.asin,
      fbm_units_30d: fbmUnits30d,
      velocity_per_day: Math.round(velocityPerDay * 100) / 100,
      fba_qty_available: fbaQtyAvailable,
      fba_qty_inbound: fbaQtyInbound,
      fba_qty_total: fbaQtyTotal,
      weeks_of_cover: weeksOfCover !== null ? Math.round(weeksOfCover * 10) / 10 : null,
      status,
      status_label: STATUS_LABELS[status],
      recommended_send_qty: recommendedSendQty,
      send_rationale: sendRationale,
      has_customization: hasCustomization,
      last_fba_sync: fbaInv?.last_synced_at || null,
    })
  }

  // Sort: critical/stocked_out first, then replenish, then new_candidate, then watch, then healthy, then overstocked/no_data
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
 * Generate CSV exports for the replenishment report.
 */
export function generateTeamCSV(recommendations: ProductRecommendation[]): string {
  const headers = [
    'Status',
    'Product Title',
    'FBM ASIN',
    'FBA ASIN',
    'SKU',
    'FBM Units (30d)',
    'Velocity/Day',
    'FBA Stock Available',
    'FBA Inbound',
    'Weeks of Cover',
    'Recommended Send Qty',
    'Notes',
  ]

  const rows = recommendations.map(r => [
    r.status_label,
    `"${(r.title || '').replace(/"/g, '""')}"`,
    r.fbm_asin,
    r.fba_asin || 'N/A',
    r.sku,
    r.fbm_units_30d,
    r.velocity_per_day,
    r.fba_qty_available,
    r.fba_qty_inbound,
    r.weeks_of_cover !== null ? r.weeks_of_cover : 'N/A',
    r.recommended_send_qty || '',
    `"${r.send_rationale.replace(/"/g, '""')}"`,
  ])

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
}

/**
 * Generate Amazon Shipment-Ready CSV (for FBA Create Shipment upload).
 * Only includes products that need replenishment.
 */
export function generateAmazonShipmentCSV(recommendations: ProductRecommendation[]): string {
  const actionable = recommendations.filter(r =>
    r.recommended_send_qty > 0 &&
    ['replenish', 'critical', 'stocked_out', 'new_candidate'].includes(r.status)
  )

  const headers = ['MSKU', 'ASIN', 'Quantity']
  const rows = actionable.map(r => [
    r.sku,
    r.fba_asin || r.fbm_asin,
    r.recommended_send_qty,
  ])

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
}
