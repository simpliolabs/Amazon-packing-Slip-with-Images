/**
 * FBA Replenishment Scoring Engine
 *
 * Data sources (all from Supabase — no live API calls at report time):
 * - orders table: FBM velocity, customization flags, product titles/SKUs
 * - fba_inventory table: current FBA stock (populated by sync)
 * - sku_sales_analytics table: FBA sales data (from All Orders report)
 * - listing_health table: ALL listings including FBA SKUs (from All Listings report)
 *
 * Matching strategy (in priority order):
 * 1. Direct ASIN match — FBM and FBA share the same ASIN
 * 2. Base-SKU match — FBM SKU "DAR-CCG-M-IVY" → FBA SKU "DAR-CCG-M-IVY-FBA"
 *    (loads ALL fba_inventory rows, not just the ones matching order ASINs)
 * 3. listing_health SKU suffix — if a SKU ending in -FBA exists in listing_health,
 *    the ASIN has an FBA listing even if stocked out and not in fba_inventory
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
  fba_sku: string | null
  sku: string
  title: string

  // FBM velocity (from orders table)
  fbm_units_30d: number
  fbm_velocity_per_day: number

  // FBA data (from fba_inventory table, populated by sync)
  fba_qty_available: number
  fba_qty_inbound: number
  fba_qty_total: number
  fba_units_sold_30d: number
  fba_buy_box_pct: number

  // Scoring
  weeks_of_cover: number | null
  status: ReplenishmentStatus
  status_label: string

  // Recommendation
  recommended_send_qty: number
  send_rationale: string

  // Flags
  has_customization: boolean
  is_fba_only: boolean

  // Label/Shipment tracking
  label_created_at: string | null
  shipment_status: string | null

  // Meta
  last_fba_sync: string | null
}

const STATUS_LABELS: Record<ReplenishmentStatus, string> = {
  healthy:       'FBA Covered',
  watch:         'Monitor',
  replenish:     'Send Now',
  critical:      'Send Urgently',
  stocked_out:   'FBA Stocked Out',
  new_candidate: 'Start Selling on FBA',
  overstocked:   'Pause Shipments',
  no_data:       'No Data',
}

/**
 * Strip the -FBA (or _FBA) suffix from a SKU to get the base SKU.
 * e.g. "DAR-CCG-M-IVY-FBA" → "DAR-CCG-M-IVY"
 */
function getBaseSku(sku: string): string {
  return sku.replace(/[-_]FBA$/i, '').trim()
}

interface FBAInvRow {
  asin: string
  sku: string
  quantity_available: number
  quantity_inbound: number
  quantity_total: number
  units_sold_30d: number
  buy_box_percentage: number
  label_created_at: string | null
  shipment_status: string | null
  last_synced_at: string | null
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

  // ── 2. Load ALL FBA inventory from Supabase ──────────────────────────────
  // We load ALL rows (not just order ASINs) so we can match FBA-suffixed SKUs
  // that may have a different ASIN than the FBM listing.
  const { data: invRows } = await supabase
    .from('fba_inventory')
    .select('asin, sku, quantity_available, quantity_reserved, quantity_inbound, quantity_total, units_sold_30d, buy_box_percentage, label_created_at, shipment_status, last_synced_at')

  // ── 2b. Load FBA SKUs from sku_sales_analytics as secondary source ────────
  // This catches FBA listings that are stocked out and no longer returned by
  // the FBA Inventory Summaries API but DID have sales via the All Orders report.
  const { data: fbaSalesRows } = await supabase
    .from('sku_sales_analytics')
    .select('asin, sku, units_sold_30d, fulfillment_channel')
    .eq('fulfillment_channel', 'Amazon')

  // ── 2b2. Load ALL Merchant-channel sales for velocity cross-reference ──────
  // The orders table may have incomplete history (only synced orders), while
  // sku_sales_analytics has the full All Orders report. We use the HIGHER of
  // the two velocity sources to avoid undercounting demand.
  const { data: fbmSalesRows } = await supabase
    .from('sku_sales_analytics')
    .select('asin, sku, units_sold_30d, avg_daily_units')
    .eq('fulfillment_channel', 'Merchant')

  // Build FBM sales velocity map by ASIN (aggregate all Merchant SKUs per ASIN)
  const fbmSalesVelocityByAsin = new Map<string, { units30d: number; velocityPerDay: number }>()
  for (const row of fbmSalesRows || []) {
    if (!row.asin) continue
    const existing = fbmSalesVelocityByAsin.get(row.asin)
    const units = row.units_sold_30d || 0
    const velocity = row.avg_daily_units || units / 30
    if (!existing) {
      fbmSalesVelocityByAsin.set(row.asin, { units30d: units, velocityPerDay: velocity })
    } else {
      existing.units30d += units
      existing.velocityPerDay += velocity
    }
  }

  // ── 2c. Load FBA SKUs from listing_health as THIRD source ─────────────────
  // listing_health has ALL 10k+ listings. FBA SKUs are identified by the -FBA
  // suffix in the SKU field (fulfillment_channel may show 'DEFAULT' for all rows
  // due to the report type). This catches FBA listings that:
  // - Are stocked out (not in fba_inventory)
  // - Had zero or negligible sales (not in sku_sales_analytics Amazon channel)
  // - But DO exist as active listings on Amazon
  const { data: listingFbaRows } = await supabase
    .from('listing_health')
    .select('asin, sku, product_name')
    .ilike('sku', '%-FBA')

  // Also get rows with _FBA suffix
  const { data: listingFbaRows2 } = await supabase
    .from('listing_health')
    .select('asin, sku, product_name')
    .ilike('sku', '%\\_FBA')

  // Combine both FBA listing patterns
  const allListingFbaRows = [...(listingFbaRows || []), ...(listingFbaRows2 || [])]
  // Deduplicate by SKU
  const seenListingSkus = new Set<string>()
  const dedupedListingFbaRows = allListingFbaRows.filter(r => {
    if (seenListingSkus.has(r.sku)) return false
    seenListingSkus.add(r.sku)
    return true
  })

  console.log(`[Replenishment] Data sources loaded: fba_inventory=${(invRows || []).length}, sku_sales_analytics(Amazon)=${(fbaSalesRows || []).length}, listing_health(FBA SKUs)=${dedupedListingFbaRows.length}`)

  // ── 3. Build lookup maps ──────────────────────────────────────────────────

  // Map A: ASIN → aggregated FBA inventory (for direct ASIN match)
  const fbaByAsin = new Map<string, FBAInvRow>()

  // Map B: base SKU → FBA inventory row (for SKU-based match)
  // e.g. "DAR-CCG-M-IVY" → row with sku "DAR-CCG-M-IVY-FBA"
  const fbaByBaseSku = new Map<string, FBAInvRow>()

  // Build a set of ASINs already in fba_inventory so we don't double-count
  const fbaInvAsins = new Set<string>()
  for (const inv of invRows || []) {
    if (inv.asin) fbaInvAsins.add(inv.asin)
  }

  // Add FBA sales rows as synthetic inventory entries (qty=0) for ASINs NOT
  // already in fba_inventory. This ensures items with FBA listings that are
  // stocked out still get matched as "has FBA" instead of "new_candidate".
  for (const sale of fbaSalesRows || []) {
    if (!sale.asin || fbaInvAsins.has(sale.asin)) continue
    // Only add if the SKU looks like an FBA SKU (ends in -FBA) or channel is Amazon
    const syntheticRow: FBAInvRow = {
      asin: sale.asin,
      sku: sale.sku || '',
      quantity_available: 0,
      quantity_inbound: 0,
      quantity_total: 0,
      units_sold_30d: sale.units_sold_30d || 0,
      buy_box_percentage: 0,
      label_created_at: null,
      shipment_status: null,
      last_synced_at: null,
    }
    // Add to ASIN map
    if (!fbaByAsin.has(sale.asin)) {
      fbaByAsin.set(sale.asin, { ...syntheticRow })
    }
    // Add to base-SKU map
    if (sale.sku && /[-_]FBA$/i.test(sale.sku)) {
      const baseSku = getBaseSku(sale.sku)
      if (baseSku && !fbaByBaseSku.has(baseSku)) {
        fbaByBaseSku.set(baseSku, { ...syntheticRow })
      }
    }
    if (sale.sku && !fbaByBaseSku.has(sale.sku)) {
      fbaByBaseSku.set(sale.sku, { ...syntheticRow })
    }
    fbaInvAsins.add(sale.asin) // prevent duplicates
  }

  // ── 2c continued: Add listing_health FBA rows as synthetic entries ────────
  // These are FBA SKUs that exist as listings but may have zero inventory AND
  // zero sales in the analytics table. They prove the FBA listing EXISTS.
  for (const listing of dedupedListingFbaRows) {
    if (!listing.asin) continue
    // Skip if already found via fba_inventory or sku_sales_analytics
    if (fbaInvAsins.has(listing.asin)) continue

    const syntheticRow: FBAInvRow = {
      asin: listing.asin,
      sku: listing.sku || '',
      quantity_available: 0,
      quantity_inbound: 0,
      quantity_total: 0,
      units_sold_30d: 0,
      buy_box_percentage: 0,
      label_created_at: null,
      shipment_status: null,
      last_synced_at: null,
    }

    // Add to ASIN map
    if (!fbaByAsin.has(listing.asin)) {
      fbaByAsin.set(listing.asin, { ...syntheticRow })
      console.log(`[Replenishment] listing_health FBA detected: ASIN ${listing.asin} via SKU ${listing.sku}`)
    }

    // Add to base-SKU map (strip -FBA suffix → base SKU)
    const baseSku = getBaseSku(listing.sku)
    if (baseSku && !fbaByBaseSku.has(baseSku)) {
      fbaByBaseSku.set(baseSku, { ...syntheticRow })
    }

    fbaInvAsins.add(listing.asin) // prevent duplicates
  }

  // Now process actual fba_inventory rows (these override synthetic entries)
  for (const inv of invRows || []) {
    const row: FBAInvRow = {
      asin: inv.asin,
      sku: inv.sku || '',
      quantity_available: inv.quantity_available || 0,
      quantity_inbound: inv.quantity_inbound || 0,
      quantity_total: inv.quantity_total || 0,
      units_sold_30d: inv.units_sold_30d || 0,
      buy_box_percentage: inv.buy_box_percentage || 0,
      label_created_at: inv.label_created_at || null,
      shipment_status: inv.shipment_status || null,
      last_synced_at: inv.last_synced_at,
    }

    // Map A: aggregate by ASIN (multiple SKUs for same ASIN get summed)
    const existing = fbaByAsin.get(inv.asin)
    if (!existing) {
      fbaByAsin.set(inv.asin, { ...row })
    } else {
      existing.quantity_available += row.quantity_available
      existing.quantity_inbound += row.quantity_inbound
      existing.quantity_total += row.quantity_total
      existing.units_sold_30d += row.units_sold_30d
      // Keep the most recent sync timestamp
      if (row.last_synced_at && (!existing.last_synced_at || row.last_synced_at > existing.last_synced_at)) {
        existing.last_synced_at = row.last_synced_at
      }
    }

    // Map B: base SKU → row
    // Case 1: FBA-suffixed SKU (DAR-CCG-M-IVY-FBA → key: DAR-CCG-M-IVY)
    if (inv.sku && /[-_]FBA$/i.test(inv.sku)) {
      const baseSku = getBaseSku(inv.sku)
      if (baseSku && !fbaByBaseSku.has(baseSku)) {
        fbaByBaseSku.set(baseSku, { ...row })
      }
    }
    // Case 2: Non-suffixed FBA SKU — store as-is so FBM SKU can match directly
    if (inv.sku && !fbaByBaseSku.has(inv.sku)) {
      fbaByBaseSku.set(inv.sku, { ...row })
    }
  }

  // ── 3b. Sibling SKU inference ─────────────────────────────────────────────
  // If a product family (e.g., DAR-CCG) has most variants with FBA listings,
  // infer that missing variants also have FBA listings that just haven't
  // appeared in the reports yet (e.g., recently created, zero sales, stocked out).
  //
  // Algorithm: group all known FBA base SKUs by their "family prefix" (first 2
  // hyphen-separated segments, e.g., "DAR-CCG"). For each FBM SKU in the
  // velocity map that has NO FBA match, check if its family prefix has ≥50%
  // of siblings with FBA. If so, create a synthetic FBA entry.

  // Build family prefix → { total FBM SKUs, FBA-matched count } map
  const familyStats = new Map<string, { total: number; withFba: number; fbmSkus: string[] }>()

  // Helper: extract family prefix from a SKU (first 2 segments)
  function getFamilyPrefix(sku: string): string | null {
    const parts = sku.split('-')
    if (parts.length < 3) return null // need at least prefix-code-variant
    return parts.slice(0, 2).join('-') // e.g., "DAR-CCG"
  }

  // First pass: count all FBM SKUs per family and how many have FBA matches
  for (const [, fbmData] of velocityMap) {
    const fbmSku = fbmData?.sku || ''
    if (!fbmSku) continue
    const prefix = getFamilyPrefix(fbmSku)
    if (!prefix) continue

    const stats = familyStats.get(prefix) || { total: 0, withFba: 0, fbmSkus: [] }
    stats.total++
    stats.fbmSkus.push(fbmSku)
    if (fbaByBaseSku.has(fbmSku)) {
      stats.withFba++
    }
    familyStats.set(prefix, stats)
  }

  // Second pass: for families where ≥50% have FBA, infer FBA for the rest
  for (const [prefix, stats] of familyStats) {
    if (stats.total < 3) continue // need at least 3 variants to infer
    const fbaRatio = stats.withFba / stats.total
    if (fbaRatio < 0.4) continue // need at least 40% to have FBA

    for (const fbmSku of stats.fbmSkus) {
      if (fbaByBaseSku.has(fbmSku)) continue // already matched

      // Infer FBA SKU as fbmSku + "-FBA"
      const inferredFbaSku = `${fbmSku}-FBA`
      const syntheticRow: FBAInvRow = {
        asin: '', // will be filled during matching
        sku: inferredFbaSku,
        quantity_available: 0,
        quantity_inbound: 0,
        quantity_total: 0,
        units_sold_30d: 0,
        buy_box_percentage: 0,
        label_created_at: null,
        shipment_status: null,
        last_synced_at: null,
      }
      fbaByBaseSku.set(fbmSku, syntheticRow)
      console.log(`[Replenishment] Sibling-inferred FBA: ${fbmSku} → ${inferredFbaSku} (family ${prefix}: ${stats.withFba}/${stats.total} have FBA)`)
    }
  }

  // ── 4. Build recommendations ──────────────────────────────────────────────
  const recommendations: ProductRecommendation[] = []
  const allAsins = new Set(velocityMap.keys())

  // ── 4a. Add FBA-only ASINs (no FBM orders) ────────────────────────────────
  // ASINs that exist in fba_inventory (or were added as synthetic entries from
  // sku_sales_analytics / listing_health) but have ZERO FBM orders will never
  // appear in velocityMap, which is built exclusively from the orders table.
  // We must add them so stocked-out FBA-only products are surfaced in the report.
  // Their fbmUnits30d and fbmVelocityPerDay will be 0; their FBA sales velocity
  // from sku_sales_analytics drives the stocked_out / replenish status.
  for (const [asin] of fbaByAsin) {
    if (!allAsins.has(asin)) {
      allAsins.add(asin)
      console.log(`[Replenishment] FBA-only ASIN added to report: ${asin} (not in orders table)`)
    }
  }

  for (const asin of allAsins) {
    const fbmData = velocityMap.get(asin)
    const fbmSku = fbmData?.sku || ''

    // Look up FBA inventory:
    // Priority 1 — direct ASIN match
    let fbaInv = fbaByAsin.get(asin)
    let matchedFbaAsin: string | null = fbaInv ? asin : null
    let matchedFbaSku: string | null = fbaInv?.sku || null

    // Priority 2 — base-SKU match (FBM SKU "X" → FBA SKU "X-FBA" or exact match)
    if (!fbaInv && fbmSku) {
      const skuMatch = fbaByBaseSku.get(fbmSku)
      if (skuMatch) {
        fbaInv = skuMatch
        matchedFbaAsin = skuMatch.asin || asin // use own ASIN if inferred
        matchedFbaSku = skuMatch.sku
        console.log(`[Replenishment] SKU-paired: FBM ASIN ${asin} (${fbmSku}) → FBA ASIN ${matchedFbaAsin} (${skuMatch.sku})`)
      }
    }

    // Priority 3 — FBM ASIN matches FBA base SKU (FBA SKU "B0FKKSTR12-FBA" → base "B0FKKSTR12")
    if (!fbaInv) {
      const asinSkuMatch = fbaByBaseSku.get(asin)
      if (asinSkuMatch) {
        fbaInv = asinSkuMatch
        matchedFbaAsin = asinSkuMatch.asin || asin
        matchedFbaSku = asinSkuMatch.sku
        console.log(`[Replenishment] ASIN-as-SKU-paired: FBM ASIN ${asin} → FBA ${matchedFbaAsin} (${asinSkuMatch.sku})`)
      }
    }

    // Use the HIGHER velocity between orders table and sku_sales_analytics.
    // The orders table uses 90-day average (units90d/90) which may undercount
    // recent demand spikes. The sales analytics uses the All Orders report
    // which captures ALL orders regardless of sync status.
    const ordersUnits30d = fbmData?.units30d || 0
    const ordersVelocityPerDay = fbmData?.velocityPerDay || 0
    const salesAnalytics = fbmSalesVelocityByAsin.get(asin)
    const salesUnits30d = salesAnalytics?.units30d || 0
    const salesVelocityPerDay = salesAnalytics?.velocityPerDay || 0

    // Take the higher of the two sources for more accurate demand signal
    const fbmUnits30d = Math.max(ordersUnits30d, salesUnits30d)
    const fbmVelocityPerDay = Math.max(ordersVelocityPerDay, salesVelocityPerDay)
    const hasCustomization = fbmData?.hasCustomization || false
    // For FBA-only ASINs (not in orders table), try to get the title from
    // listing_health product_name (most reliable), then fba_inventory SKU,
    // then fall back to the ASIN itself.
    const listingTitle = dedupedListingFbaRows.find(r => r.asin === asin)?.product_name || null
    const fbaInvTitle = fbaInv?.sku ? `SKU: ${fbaInv.sku}` : null
    const title = fbmData?.title || listingTitle || fbaInvTitle || `ASIN: ${asin}`

    const fbaQtyAvailable = fbaInv?.quantity_available ?? 0
    const fbaQtyInbound = fbaInv?.quantity_inbound ?? 0
    const fbaQtyTotal = fbaInv?.quantity_total ?? 0
    const fbaUnitsSold30d = fbaInv?.units_sold_30d ?? 0
    const fbaBuyBoxPct = fbaInv?.buy_box_percentage ?? 0
    const lastFbaSync = fbaInv?.last_synced_at ?? null

    // hasFBAInventory = true only if we found a real synced row
    const hasFBAInventory = fbaInv !== undefined
    const isFBAOnly = hasFBAInventory && fbmUnits30d === 0

    // Use TOTAL velocity (FBM + FBA combined) for weeks-of-cover and send qty.
    // If both channels sell, we need to cover ALL demand, not just one channel.
    // When FBA is stocked out (qty=0, units_sold_30d=0), the FBM velocity alone
    // represents the TOTAL demand (all customers buying via FBM because FBA is out).
    const fbaVelocityPerDay = fbaUnitsSold30d / 30
    const combinedVelocityPerDay = Math.max(
      fbmVelocityPerDay + fbaVelocityPerDay,  // both channels combined
      fbmVelocityPerDay,                       // at minimum, FBM velocity alone
      fbaVelocityPerDay                        // or FBA velocity alone
    )

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
      if (fbmUnits30d >= settings.newFBACandidateMinUnits) {
        status = 'new_candidate'
        // Minimum send qty is the new-candidate threshold, not 1
        const calcQty = Math.ceil(fbmVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
        recommendedSendQty = Math.max(calcQty, settings.newFBACandidateMinUnits, 3) // min 3
        sendRationale = `${fbmUnits30d} units/30d via FBM. No FBA listing found. Initial send covers lead time (${settings.leadTimeDays}d) + buffer (${settings.safetyBufferDays}d).`
      } else {
        status = 'no_data'
        sendRationale = `${fbmUnits30d} units/30d — below ${settings.newFBACandidateMinUnits} unit threshold for FBA recommendation`
      }
    } else if (fbaQtyAvailable === 0 && fbaQtyInbound === 0) {
      status = 'stocked_out'
      // When FBA is stocked out, ALL demand is served by FBM. Use combinedVelocity
      // (which equals fbmVelocityPerDay when fbaUnitsSold30d=0) to calculate send qty.
      const calcQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(calcQty, 3) // HARD RULE: never send fewer than 3 units
      sendRationale = `FBA stocked out. Total demand: ${(combinedVelocityPerDay * 30).toFixed(0)} units/30d. Send to cover lead time (${settings.leadTimeDays}d) + buffer (${settings.safetyBufferDays}d).`
    } else if (weeksOfCover !== null && weeksOfCover < 2) {
      status = 'critical'
      const targetQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(3, targetQty - fbaQtyAvailable - fbaQtyInbound) // min 3
      sendRationale = `Only ${weeksOfCover.toFixed(1)} weeks of cover. FBM is carrying load. Send immediately.`
    } else if (weeksOfCover !== null && weeksOfCover < settings.replenishTriggerWeeks) {
      status = 'replenish'
      const targetQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(3, targetQty - fbaQtyAvailable - fbaQtyInbound) // min 3
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
      fba_asin: matchedFbaAsin,
      fba_sku: matchedFbaSku,
      sku: fbmSku,
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
      label_created_at: fbaInv?.label_created_at ?? null,
      shipment_status: fbaInv?.shipment_status ?? null,
      last_fba_sync: lastFbaSync,
    })
  }

  // Sort: urgent first
  const statusOrder: Record<ReplenishmentStatus, number> = {
    stocked_out:   0,
    critical:      1,
    replenish:     2,
    new_candidate: 3,
    watch:         4,
    healthy:       5,
    overstocked:   6,
    no_data:       7,
  }

  recommendations.sort((a, b) => {
    const orderDiff = statusOrder[a.status] - statusOrder[b.status]
    if (orderDiff !== 0) return orderDiff
    return b.fbm_units_30d - a.fbm_units_30d
  })

  return recommendations
}

/**
 * Generate Team Report CSV
 */
export function generateTeamCSV(report: ProductRecommendation[]): string {
  const headers = [
    'ASIN', 'FBA ASIN', 'FBA SKU', 'FBM SKU', 'Title', 'Status',
    'FBM Units (30d)', 'FBM Velocity/Day',
    'FBA Available', 'FBA Inbound', 'FBA Sold (30d)', 'Buy Box %',
    'Weeks of Cover', 'Recommended Send Qty', 'Rationale',
  ]

  const rows = report
    .filter(r => r.status !== 'no_data')
    .map(r => [
      r.asin,
      r.fba_asin || '',
      r.fba_sku || '',
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
 */
export function generateAmazonShipmentCSV(report: ProductRecommendation[]): string {
  const headers = ['Merchant SKU', 'ASIN', 'Quantity to Ship', 'Condition', 'Notes']

  const rows = report
    .filter(r => r.recommended_send_qty > 0 && ['stocked_out', 'critical', 'replenish', 'new_candidate'].includes(r.status))
    .map(r => [
      r.fba_sku || r.sku || r.asin,
      r.fba_asin || r.asin,
      r.recommended_send_qty,
      'NewItem',
      `"${r.status_label}: ${r.send_rationale.substring(0, 80).replace(/"/g, '""')}"`,
    ])

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
}
