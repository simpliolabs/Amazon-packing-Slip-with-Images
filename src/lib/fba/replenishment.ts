/**
 * FBA Replenishment Scoring Engine v2 — Full Intelligence
 *
 * Data sources (all from Supabase — no live API calls at report time):
 * - orders table: FBM velocity, customization flags, product titles/SKUs
 * - fba_inventory table: current FBA stock (populated by sync)
 * - sku_sales_analytics table: FBA sales data (from All Orders report)
 * - listing_health table: ALL listings including FBA SKUs (from All Listings report)
 * - asin_traffic table: sessions, page views, buy box %, conversion rate (from Sales & Traffic Report)
 * - parent_asin_rollup table: parent-level aggregated demand signals
 *
 * Scoring model:
 * 1. Products with parent demand + traffic but 0 child sales → REPLENISH (parent proves demand)
 * 2. Products with high sessions but 0 sales → FBA CONVERSION CANDIDATE (traffic proves demand)
 * 3. Products with 0 sessions + 0 parent demand → IGNORE (truly dead)
 * 4. Standard velocity-based scoring for everything else
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

/**
 * Fetch ALL rows from a Supabase table, paginating past the 1000-row default limit.
 * Uses range-based pagination with 1000-row pages.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllRows(table: string, select: string, filterFn?: (q: any) => any): Promise<any[]> {
  const supabase = getAdminSupabase()
  const PAGE_SIZE = 1000
  const allRows: any[] = []
  let from = 0
  let hasMore = true

  while (hasMore) {
    let query = supabase.from(table).select(select).range(from, from + PAGE_SIZE - 1)
    if (filterFn) {
      query = filterFn(query)
    }
    const { data, error } = await query
    if (error) {
      console.error(`[fetchAllRows] Error fetching ${table} (offset ${from}):`, error.message)
      break
    }
    if (data && data.length > 0) {
      allRows.push(...data)
      from += data.length
      hasMore = data.length === PAGE_SIZE
    } else {
      hasMore = false
    }
  }

  return allRows
}

export type ReplenishmentStatus =
  | 'healthy'        // FBA weeks of cover > trigger threshold
  | 'watch'          // FBA weeks of cover between 50%-100% of trigger
  | 'replenish'      // FBA weeks of cover below trigger — send now
  | 'critical'       // FBA weeks of cover < 2 weeks — FBM carrying load
  | 'stocked_out'    // FBA qty = 0
  | 'new_candidate'  // No FBA twin, FBM velocity >= threshold OR high traffic FBM
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

  // Traffic intelligence (from asin_traffic table)
  sessions_30d: number
  page_views_30d: number
  conversion_rate: number

  // Parent demand context (from parent_asin_rollup table)
  parent_asin: string | null
  parent_units_30d: number
  parent_sessions_30d: number
  sibling_count: number

  // Scoring
  weeks_of_cover: number | null
  status: ReplenishmentStatus
  status_label: string
  intelligence_score: number  // 0-100 composite score

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

interface TrafficData {
  sessions: number
  pageViews: number
  buyBoxPct: number
  conversionRate: number
  parentAsin: string | null
}

interface ParentRollup {
  childCount: number
  totalUnits30d: number
  totalSessions30d: number
  totalPageViews30d: number
  avgConversionRate: number
  avgBuyBoxPct: number
  topChildAsin: string | null
  topChildUnits: number
}

/**
 * Compute an intelligence score (0-100) that combines all signals.
 * Higher = more urgent / more confident to replenish.
 */
function computeIntelligenceScore(
  childSales30d: number,
  sessions30d: number,
  conversionRate: number,
  buyBoxPct: number,
  parentUnits30d: number,
  parentSessions30d: number,
  fbaQtyAvailable: number,
  fbaQtyInbound: number,
): number {
  let score = 0

  // ── Child demand signal (0-30 points) ──
  if (childSales30d >= 50) score += 30
  else if (childSales30d >= 20) score += 25
  else if (childSales30d >= 10) score += 20
  else if (childSales30d >= 5) score += 15
  else if (childSales30d >= 1) score += 10
  else score += 0

  // ── Traffic signal (0-25 points) ──
  // High sessions with 0 sales = suppressed demand (FBA stockout)
  if (sessions30d >= 500) score += 25
  else if (sessions30d >= 200) score += 20
  else if (sessions30d >= 100) score += 15
  else if (sessions30d >= 50) score += 10
  else if (sessions30d >= 20) score += 5

  // ── Parent demand signal (0-25 points) ──
  if (parentUnits30d >= 1000) score += 25
  else if (parentUnits30d >= 500) score += 20
  else if (parentUnits30d >= 100) score += 15
  else if (parentUnits30d >= 30) score += 10
  else if (parentUnits30d >= 10) score += 5

  // ── Conversion context (0-10 points) ──
  // Low conversion + high traffic = FBA stockout suppressing conversion
  if (conversionRate > 0 && conversionRate < 3 && sessions30d > 50) {
    score += 10 // conversion is being killed — likely by FBA stockout
  } else if (conversionRate >= 10) {
    score += 8 // great conversion — product converts well
  } else if (conversionRate >= 5) {
    score += 5
  }

  // ── Urgency boost (0-10 points) ──
  if (fbaQtyAvailable === 0 && fbaQtyInbound === 0) {
    score += 10 // completely out of stock, nothing coming
  } else if (fbaQtyAvailable === 0 && fbaQtyInbound > 0) {
    score += 3 // out but shipment coming
  }

  return Math.min(100, score)
}

/**
 * Determine if an ASIN qualifies for the replenishment report.
 * This is the GATE that prevents 1,984 dead listings from flooding the report.
 *
 * An ASIN qualifies if ANY of these are true:
 * 1. It has FBM orders in the last 90 days (in velocityMap)
 * 2. It has FBA sales > 0 (in sku_sales_analytics Amazon channel)
 * 3. It has FBA stock > 0 or inbound > 0
 * 4. It has sessions > 50 in the last 30 days (traffic proves demand even with 0 sales)
 * 5. Its parent ASIN has > 30 units sold in 30 days (sibling demand proves family value)
 */
function qualifiesForReport(
  asin: string,
  fbmUnits30d: number,
  fbaUnits30d: number,
  fbaQtyAvailable: number,
  fbaQtyInbound: number,
  sessions30d: number,
  parentUnits30d: number,
): boolean {
  if (fbmUnits30d > 0) return true
  if (fbaUnits30d > 0) return true
  if (fbaQtyAvailable > 0 || fbaQtyInbound > 0) return true
  if (sessions30d >= 50) return true
  if (parentUnits30d >= 30) return true
  return false
}

/**
 * Generate full replenishment recommendations with traffic intelligence.
 */
export async function generateReplenishmentReport(): Promise<ProductRecommendation[]> {
  const supabase = getAdminSupabase()
  const settings = await getFBASettings()

  // ── 1. Compute FBM velocity from orders ──────────────────────────────────
  const velocityMap = await computeFBMVelocity()

  // ── 2. Load ALL FBA inventory from Supabase (paginated — table has 2000+ rows) ──
  const invRows = await fetchAllRows(
    'fba_inventory',
    'asin, sku, quantity_available, quantity_reserved, quantity_inbound, quantity_total, units_sold_30d, buy_box_percentage, label_created_at, shipment_status, last_synced_at'
  )
  console.log(`[Replenishment] Loaded ${invRows.length} fba_inventory rows`)

  // ── 2b. Load FBA SKUs from sku_sales_analytics ────────────────────────────
  const { data: fbaSalesRows } = await supabase
    .from('sku_sales_analytics')
    .select('asin, sku, units_sold_30d, fulfillment_channel')
    .eq('fulfillment_channel', 'Amazon')

  // ── 2b2. Load Merchant-channel sales ──────────────────────────────────────
  const { data: fbmSalesRows } = await supabase
    .from('sku_sales_analytics')
    .select('asin, sku, units_sold_30d, avg_daily_units')
    .eq('fulfillment_channel', 'Merchant')

  // ── 2c. Load FBA SKUs from listing_health (paginated — table has 15000+ rows) ──
  const listingFbaRows = await fetchAllRows(
    'listing_health',
    'asin, sku, product_name',
    (q: any) => q.ilike('sku', '%-FBA')
  )

  const listingFbaRows2 = await fetchAllRows(
    'listing_health',
    'asin, sku, product_name',
    (q: any) => q.ilike('sku', '%\_FBA')
  )

  const allListingFbaRows = [...(listingFbaRows || []), ...(listingFbaRows2 || [])]
  const seenListingSkus = new Set<string>()
  const dedupedListingFbaRows = allListingFbaRows.filter(r => {
    if (seenListingSkus.has(r.sku)) return false
    seenListingSkus.add(r.sku)
    return true
  })

  // ── 3. Load TRAFFIC INTELLIGENCE ──────────────────────────────────────────
  const { data: trafficRows } = await supabase
    .from('asin_traffic')
    .select('child_asin, parent_asin, sessions, page_views, buy_box_pct, conversion_rate')

  const trafficByAsin = new Map<string, TrafficData>()
  for (const row of trafficRows || []) {
    trafficByAsin.set(row.child_asin, {
      sessions: row.sessions || 0,
      pageViews: row.page_views || 0,
      buyBoxPct: parseFloat(String(row.buy_box_pct || 0)),
      conversionRate: parseFloat(String(row.conversion_rate || 0)),
      parentAsin: row.parent_asin || null,
    })
  }

  // ── 3b. Load parent_asin from listing_health (covers more ASINs than traffic) ──
  const lhParentRows = await fetchAllRows(
    'listing_health',
    'asin, parent_asin',
    (q: any) => q.not('parent_asin', 'is', null)
  )

  const listingHealthParentMap = new Map<string, string>()
  for (const row of lhParentRows || []) {
    if (row.asin && row.parent_asin) {
      listingHealthParentMap.set(row.asin, row.parent_asin)
    }
  }

  console.log(`[Replenishment] Parent sources: asin_traffic=${trafficByAsin.size}, listing_health=${listingHealthParentMap.size}`)

  // ── 4. Load PARENT DEMAND ROLLUPS ─────────────────────────────────────────
  const { data: parentRows } = await supabase
    .from('parent_asin_rollup')
    .select('parent_asin, child_count, total_units_30d, total_sessions_30d, total_page_views_30d, avg_conversion_rate, avg_buy_box_pct, top_child_asin, top_child_units')

  const parentRollupMap = new Map<string, ParentRollup>()
  for (const row of parentRows || []) {
    parentRollupMap.set(row.parent_asin, {
      childCount: row.child_count || 0,
      totalUnits30d: row.total_units_30d || 0,
      totalSessions30d: row.total_sessions_30d || 0,
      totalPageViews30d: row.total_page_views_30d || 0,
      avgConversionRate: parseFloat(String(row.avg_conversion_rate || 0)),
      avgBuyBoxPct: parseFloat(String(row.avg_buy_box_pct || 0)),
      topChildAsin: row.top_child_asin || null,
      topChildUnits: row.top_child_units || 0,
    })
  }

  console.log(`[Replenishment] Data sources: fba_inventory=${(invRows || []).length}, fbaSales=${(fbaSalesRows || []).length}, listingFBA=${dedupedListingFbaRows.length}, traffic=${trafficByAsin.size}, parentRollups=${parentRollupMap.size}`)

  // ── 5. Build velocity maps ────────────────────────────────────────────────
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

  const fbaSalesVelocityByAsin = new Map<string, { units30d: number; velocityPerDay: number }>()
  for (const row of fbaSalesRows || []) {
    if (!row.asin) continue
    const existing = fbaSalesVelocityByAsin.get(row.asin)
    const units = row.units_sold_30d || 0
    const velocity = units / 30
    if (!existing) {
      fbaSalesVelocityByAsin.set(row.asin, { units30d: units, velocityPerDay: velocity })
    } else {
      existing.units30d += units
      existing.velocityPerDay += velocity
    }
  }

  // ── 6. Build FBA inventory lookup maps ────────────────────────────────────
  const fbaByAsin = new Map<string, FBAInvRow>()
  const fbaByBaseSku = new Map<string, FBAInvRow>()
  const fbaInvAsins = new Set<string>()

  for (const inv of invRows || []) {
    if (inv.asin) fbaInvAsins.add(inv.asin)
  }

  // Add FBA sales rows as synthetic inventory entries for stocked-out ASINs
  for (const sale of fbaSalesRows || []) {
    if (!sale.asin || fbaInvAsins.has(sale.asin)) continue
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
    if (!fbaByAsin.has(sale.asin)) fbaByAsin.set(sale.asin, { ...syntheticRow })
    if (sale.sku && /[-_]FBA$/i.test(sale.sku)) {
      const baseSku = getBaseSku(sale.sku)
      if (baseSku && !fbaByBaseSku.has(baseSku)) fbaByBaseSku.set(baseSku, { ...syntheticRow })
    }
    if (sale.sku && !fbaByBaseSku.has(sale.sku)) fbaByBaseSku.set(sale.sku, { ...syntheticRow })
    fbaInvAsins.add(sale.asin)
  }

  // Add listing_health FBA rows as synthetic entries
  for (const listing of dedupedListingFbaRows) {
    if (!listing.asin || fbaInvAsins.has(listing.asin)) continue
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
    if (!fbaByAsin.has(listing.asin)) fbaByAsin.set(listing.asin, { ...syntheticRow })
    const baseSku = getBaseSku(listing.sku)
    if (baseSku && !fbaByBaseSku.has(baseSku)) fbaByBaseSku.set(baseSku, { ...syntheticRow })
    fbaInvAsins.add(listing.asin)
  }

  // Process actual fba_inventory rows (override synthetic entries).
  //
  // IMPORTANT: The fba_inventory table contains rows for BOTH FBA SKUs (e.g. DAR-CCG-L-IVY-FBA)
  // and FBM SKUs (e.g. DAR-CCG-L-IVY) because Amazon's FBA Inventory API returns every SKU
  // that has ever had FBA inventory, including FBM variants with 0 qty.
  //
  // Bug fix: When building fbaByAsin we must ONLY sum FBA-channel SKUs (ending in -FBA or _FBA).
  // FBM SKUs for the same ASIN must NOT be summed in — they would dilute the SKU name shown in
  // the portal and could cause incorrect 0-qty entries to overwrite real FBA data.
  //
  // Two-pass approach:
  //   Pass 1: Process all -FBA SKUs and build the primary fbaByAsin map.
  //   Pass 2: For any ASIN not yet seen (no -FBA SKU in inventory), fall back to non-FBA rows.
  const fbaSkuRows = (invRows || []).filter(inv => inv.sku && /[-_]FBA$/i.test(inv.sku))
  const nonFbaSkuRows = (invRows || []).filter(inv => !inv.sku || !/[-_]FBA$/i.test(inv.sku))

  for (const inv of fbaSkuRows) {
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

    // Always prefer the FBA SKU row — overwrite any synthetic entry for this ASIN
    const existing = fbaByAsin.get(inv.asin)
    if (!existing) {
      fbaByAsin.set(inv.asin, { ...row })
    } else {
      // If existing entry was a synthetic (qty=0) or another FBA SKU, sum the quantities
      // (handles rare cases where one ASIN has two separate FBA SKUs)
      existing.quantity_available += row.quantity_available
      existing.quantity_inbound += row.quantity_inbound
      existing.quantity_total += row.quantity_total
      existing.units_sold_30d += row.units_sold_30d
      // Prefer the FBA SKU name over any previously stored name
      if (/[-_]FBA$/i.test(row.sku)) existing.sku = row.sku
      if (row.last_synced_at && (!existing.last_synced_at || row.last_synced_at > existing.last_synced_at)) {
        existing.last_synced_at = row.last_synced_at
      }
    }

    const baseSku = getBaseSku(inv.sku)
    if (baseSku && !fbaByBaseSku.has(baseSku)) fbaByBaseSku.set(baseSku, { ...row })
    if (!fbaByBaseSku.has(inv.sku)) fbaByBaseSku.set(inv.sku, { ...row })
  }

  // Pass 2: For ASINs with no -FBA SKU in fba_inventory, fall back to non-FBA rows
  // (e.g. FBM-only products that were previously enrolled in FBA)
  for (const inv of nonFbaSkuRows) {
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

    // Only use non-FBA row if no FBA-SKU row already covers this ASIN
    if (!fbaByAsin.has(inv.asin)) {
      fbaByAsin.set(inv.asin, { ...row })
    }

    if (inv.sku && !fbaByBaseSku.has(inv.sku)) fbaByBaseSku.set(inv.sku, { ...row })
  }

  // ── 7. Sibling SKU inference ──────────────────────────────────────────────
  function getFamilyPrefix(sku: string): string | null {
    const parts = sku.split('-')
    if (parts.length < 3) return null
    return parts.slice(0, 2).join('-')
  }

  const familyStats = new Map<string, { total: number; withFba: number; fbmSkus: string[] }>()
  for (const [, fbmData] of velocityMap) {
    const fbmSku = fbmData?.sku || ''
    if (!fbmSku) continue
    const prefix = getFamilyPrefix(fbmSku)
    if (!prefix) continue
    const stats = familyStats.get(prefix) || { total: 0, withFba: 0, fbmSkus: [] }
    stats.total++
    stats.fbmSkus.push(fbmSku)
    if (fbaByBaseSku.has(fbmSku)) stats.withFba++
    familyStats.set(prefix, stats)
  }

  for (const [prefix, stats] of familyStats) {
    if (stats.total < 3) continue
    const fbaRatio = stats.withFba / stats.total
    if (fbaRatio < 0.4) continue
    for (const fbmSku of stats.fbmSkus) {
      if (fbaByBaseSku.has(fbmSku)) continue
      const inferredFbaSku = `${fbmSku}-FBA`
      const syntheticRow: FBAInvRow = {
        asin: '',
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
    }
  }

  // ── 8. Build recommendations with FULL INTELLIGENCE ───────────────────────
  const recommendations: ProductRecommendation[] = []
  const allAsins = new Set(velocityMap.keys())

  // Add FBA-only ASINs that pass the qualification gate
  for (const [asin] of fbaByAsin) {
    if (allAsins.has(asin)) continue

    const fbaVel = fbaSalesVelocityByAsin.get(asin)
    const traffic = trafficByAsin.get(asin)
    const parentAsin = traffic?.parentAsin || null
    const parentRollup = parentAsin ? parentRollupMap.get(parentAsin) : null
    const fbaInv = fbaByAsin.get(asin)

    if (qualifiesForReport(
      asin,
      0, // no FBM orders
      fbaVel?.units30d || 0,
      fbaInv?.quantity_available || 0,
      fbaInv?.quantity_inbound || 0,
      traffic?.sessions || 0,
      parentRollup?.totalUnits30d || 0,
    )) {
      allAsins.add(asin)
    }
  }

  for (const asin of allAsins) {
    const fbmData = velocityMap.get(asin)
    const fbmSku = fbmData?.sku || ''

    // Look up FBA inventory (same 3-priority matching as before)
    let fbaInv = fbaByAsin.get(asin)
    let matchedFbaAsin: string | null = fbaInv ? asin : null
    let matchedFbaSku: string | null = fbaInv?.sku || null

    if (!fbaInv && fbmSku) {
      const skuMatch = fbaByBaseSku.get(fbmSku)
      if (skuMatch) {
        fbaInv = skuMatch
        matchedFbaAsin = skuMatch.asin || asin
        matchedFbaSku = skuMatch.sku
      }
    }

    if (!fbaInv) {
      const asinSkuMatch = fbaByBaseSku.get(asin)
      if (asinSkuMatch) {
        fbaInv = asinSkuMatch
        matchedFbaAsin = asinSkuMatch.asin || asin
        matchedFbaSku = asinSkuMatch.sku
      }
    }

    // ── Velocity from multiple sources ──
    const ordersUnits30d = fbmData?.units30d || 0
    const ordersVelocityPerDay = fbmData?.velocityPerDay || 0
    const salesAnalytics = fbmSalesVelocityByAsin.get(asin)
    const salesUnits30d = salesAnalytics?.units30d || 0
    const salesVelocityPerDay = salesAnalytics?.velocityPerDay || 0
    const fbmUnits30d = Math.max(ordersUnits30d, salesUnits30d)
    const fbmVelocityPerDay = Math.max(ordersVelocityPerDay, salesVelocityPerDay)
    const hasCustomization = fbmData?.hasCustomization || false

    // ── Traffic intelligence ──
    const traffic = trafficByAsin.get(asin)
    const sessions30d = traffic?.sessions || 0
    const pageViews30d = traffic?.pageViews || 0
    const conversionRate = traffic?.conversionRate || 0
    const buyBoxPct = traffic?.buyBoxPct || 0
    // Parent ASIN: check traffic table first, then listing_health fallback
    const parentAsin = traffic?.parentAsin || listingHealthParentMap.get(asin) || null

    // ── Parent demand ──
    const parentRollup = parentAsin ? parentRollupMap.get(parentAsin) : null
    const parentUnits30d = parentRollup?.totalUnits30d || 0
    const parentSessions30d = parentRollup?.totalSessions30d || 0
    const siblingCount = parentRollup?.childCount || 0

    // ── Title resolution ──
    const listingTitle = dedupedListingFbaRows.find(r => r.asin === asin)?.product_name || null
    const fbaInvTitle = fbaInv?.sku ? `SKU: ${fbaInv.sku}` : null
    const title = fbmData?.title || listingTitle || fbaInvTitle || `ASIN: ${asin}`

    // ── FBA inventory data ──
    const fbaQtyAvailable = fbaInv?.quantity_available ?? 0
    const fbaQtyInbound = fbaInv?.quantity_inbound ?? 0
    const fbaQtyTotal = fbaInv?.quantity_total ?? 0
    const fbaSalesAnalytics = fbaSalesVelocityByAsin.get(asin)
    const fbaUnitsSold30d = fbaSalesAnalytics?.units30d ?? fbaInv?.units_sold_30d ?? 0
    const lastFbaSync = fbaInv?.last_synced_at ?? null
    const hasFBAInventory = fbaInv !== undefined
    const isFBAOnly = hasFBAInventory && fbmUnits30d === 0

    // ── Combined velocity ──
    const fbaVelocityPerDay = fbaSalesAnalytics?.velocityPerDay ?? (fbaUnitsSold30d / 30)
    const combinedVelocityPerDay = Math.max(
      fbmVelocityPerDay + fbaVelocityPerDay,
      fbmVelocityPerDay,
      fbaVelocityPerDay,
    )

    // ── Intelligence score ──
    const totalChildSales = fbmUnits30d + fbaUnitsSold30d
    const intelligenceScore = computeIntelligenceScore(
      totalChildSales,
      sessions30d,
      conversionRate,
      buyBoxPct,
      parentUnits30d,
      parentSessions30d,
      fbaQtyAvailable,
      fbaQtyInbound,
    )

    // ── QUALIFICATION GATE (final check) ──
    // Skip products that don't qualify — this is the filter that prevents 1300+ items
    if (!qualifiesForReport(asin, fbmUnits30d, fbaUnitsSold30d, fbaQtyAvailable, fbaQtyInbound, sessions30d, parentUnits30d)) {
      continue
    }

    // ── Weeks of cover (includes inbound units already on the way) ──
    let weeksOfCover: number | null = null
    const effectiveStock = fbaQtyAvailable + fbaQtyInbound
    if (hasFBAInventory && combinedVelocityPerDay > 0) {
      weeksOfCover = effectiveStock / (combinedVelocityPerDay * 7)
    } else if (hasFBAInventory && effectiveStock > 0) {
      weeksOfCover = 999
    }

    // ── Status determination (with intelligence) ──
    let status: ReplenishmentStatus = 'no_data'
    let recommendedSendQty = 0
    let sendRationale = ''

    if (hasCustomization) {
      status = 'no_data'
      sendRationale = 'Customized product — FBA not applicable'
    } else if (!hasFBAInventory) {
      // ── NEW CANDIDATE LOGIC (enhanced with traffic intelligence) ──
      // Old: only looked at fbmUnits30d >= threshold
      // New: also considers sessions, parent demand, and conversion context
      const hasDirectDemand = fbmUnits30d >= settings.newFBACandidateMinUnits
      const hasTrafficDemand = sessions30d >= 100 && fbmUnits30d >= 1
      const hasParentDemand = parentUnits30d >= 50 && sessions30d >= 20
      const hasHighTrafficLowConversion = sessions30d >= 200 && conversionRate < 5

      if (hasDirectDemand || hasTrafficDemand || hasParentDemand || hasHighTrafficLowConversion) {
        status = 'new_candidate'
        const calcQty = Math.ceil(fbmVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
        recommendedSendQty = Math.max(calcQty, settings.newFBACandidateMinUnits, 3)

        // Build intelligent rationale
        const reasons: string[] = []
        if (hasDirectDemand) reasons.push(`${fbmUnits30d} FBM units/30d`)
        if (sessions30d > 0) reasons.push(`${sessions30d} sessions`)
        if (parentUnits30d > 0) reasons.push(`parent sells ${parentUnits30d} units/30d`)
        if (hasHighTrafficLowConversion) reasons.push(`${conversionRate.toFixed(1)}% conversion (low — FBA would boost)`)
        sendRationale = `${reasons.join(', ')}. No FBA listing found. Initial send covers ${settings.leadTimeDays}d lead + ${settings.safetyBufferDays}d buffer.`
      } else {
        status = 'no_data'
        const reasons: string[] = []
        reasons.push(`${fbmUnits30d} FBM units/30d`)
        if (sessions30d > 0) reasons.push(`${sessions30d} sessions`)
        if (parentUnits30d > 0) reasons.push(`parent: ${parentUnits30d} units`)
        sendRationale = `${reasons.join(', ')} — below thresholds for FBA recommendation`
      }
    } else if (fbaQtyAvailable === 0 && fbaQtyInbound === 0) {
      status = 'stocked_out'
      const calcQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(calcQty, 3)

      // Build intelligent rationale with context
      const reasons: string[] = []
      reasons.push(`Total demand: ${(combinedVelocityPerDay * 30).toFixed(0)} units/30d`)
      if (sessions30d > 0) reasons.push(`${sessions30d} sessions (traffic still coming)`)
      if (parentUnits30d > 0) reasons.push(`parent family: ${parentUnits30d} units/30d`)
      if (conversionRate > 0 && conversionRate < 5) reasons.push(`conversion dropped to ${conversionRate.toFixed(1)}% (stockout impact)`)
      sendRationale = `FBA stocked out. ${reasons.join('. ')}. Send ${recommendedSendQty} to cover ${settings.leadTimeDays}d lead + ${settings.safetyBufferDays}d buffer.`
    } else if (weeksOfCover !== null && weeksOfCover < 2) {
      status = 'critical'
      const targetQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(3, targetQty - fbaQtyAvailable - fbaQtyInbound)
      sendRationale = `Only ${weeksOfCover.toFixed(1)} weeks of cover. ${sessions30d > 0 ? `${sessions30d} sessions still driving traffic.` : ''} Send immediately.`
    } else if (weeksOfCover !== null && weeksOfCover < settings.replenishTriggerWeeks) {
      status = 'replenish'
      const targetQty = Math.ceil(combinedVelocityPerDay * (settings.leadTimeDays + settings.safetyBufferDays))
      recommendedSendQty = Math.max(3, targetQty - fbaQtyAvailable - fbaQtyInbound)
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover remaining. ${sessions30d > 0 ? `${sessions30d} sessions/30d.` : ''} Send now to avoid stockout.`
    } else if (weeksOfCover !== null && weeksOfCover < settings.replenishTriggerWeeks * 2) {
      status = 'watch'
      sendRationale = `${weeksOfCover.toFixed(1)} weeks of cover. ${sessions30d > 0 ? `${sessions30d} sessions.` : ''} Monitor — approaching threshold.`
    } else if (weeksOfCover !== null && weeksOfCover > settings.replenishTriggerWeeks * 3) {
      status = 'overstocked'
      sendRationale = `${weeksOfCover === 999 ? 'No recent sales' : `${weeksOfCover.toFixed(0)} weeks`} of cover. ${sessions30d > 0 ? `Still getting ${sessions30d} sessions — may recover.` : 'Low traffic.'} Consider pausing shipments.`
    } else if (weeksOfCover !== null) {
      status = 'healthy'
      sendRationale = `${weeksOfCover === 999 ? 'Sufficient' : `${weeksOfCover.toFixed(1)} weeks`} of FBA cover. ${sessions30d > 0 ? `${sessions30d} sessions, ${conversionRate.toFixed(1)}% conversion.` : ''} No action needed.`
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
      fba_buy_box_pct: buyBoxPct > 0 ? buyBoxPct : (fbaInv?.buy_box_percentage ?? 0),
      sessions_30d: sessions30d,
      page_views_30d: pageViews30d,
      conversion_rate: conversionRate,
      parent_asin: parentAsin,
      parent_units_30d: parentUnits30d,
      parent_sessions_30d: parentSessions30d,
      sibling_count: siblingCount,
      weeks_of_cover: weeksOfCover === 999 ? null : weeksOfCover,
      status,
      status_label: STATUS_LABELS[status],
      intelligence_score: intelligenceScore,
      recommended_send_qty: recommendedSendQty,
      send_rationale: sendRationale,
      has_customization: hasCustomization,
      is_fba_only: isFBAOnly,
      label_created_at: fbaInv?.label_created_at ?? null,
      shipment_status: fbaInv?.shipment_status ?? null,
      last_fba_sync: lastFbaSync,
    })
  }

  // ── FILTER: Only show ACTIONABLE items ──
  // Remove healthy (FBA Covered), watch (Monitor), overstocked (Pause Shipments)
  // These statuses mean "no action needed" — they don't belong in a replenishment list
  const actionableStatuses: ReplenishmentStatus[] = ['stocked_out', 'critical', 'replenish', 'new_candidate']
  const actionable = recommendations.filter(r =>
    actionableStatuses.includes(r.status) || (r.status === 'no_data' && r.recommended_send_qty > 0)
  )

  // ── SORT: By recommended send quantity descending ──
  // The items that need the most units sent go to the top
  actionable.sort((a, b) => {
    // Primary: send qty descending (most needed at top)
    if (b.recommended_send_qty !== a.recommended_send_qty) {
      return b.recommended_send_qty - a.recommended_send_qty
    }
    // Secondary: intelligence score descending (tie-breaker)
    return b.intelligence_score - a.intelligence_score
  })

  return actionable
}

/**
 * Escape a value for RFC 4180 CSV.
 * Always wraps in double-quotes and escapes internal double-quotes by doubling them.
 * This ensures Excel correctly splits columns even when values contain commas.
 */
function csvCell(value: string | number | null | undefined): string {
  const str = value == null ? '' : String(value)
  // Always quote — safest for Excel compatibility
  return '"' + str.replace(/"/g, '""') + '"'
}

/**
 * Generate Team Report CSV
 * UTF-8 BOM prefix ensures Excel opens the file with correct encoding and column splitting.
 */
export function generateTeamCSV(report: ProductRecommendation[]): string {
  const BOM = '\uFEFF'
  const headers = [
    'ASIN', 'FBA ASIN', 'FBA SKU', 'FBM SKU', 'Title', 'Status', 'Score',
    'FBM Units (30d)', 'FBM Velocity/Day',
    'FBA Available', 'FBA Inbound', 'FBA Sold (30d)', 'Buy Box %',
    'Sessions (30d)', 'Conversion %', 'Parent ASIN', 'Parent Units (30d)', 'Siblings',
    'Weeks of Cover', 'Recommended Send Qty', 'Rationale',
  ]

  const rows = report
    .filter(r => r.status !== 'no_data')
    .map(r => [
      csvCell(r.asin),
      csvCell(r.fba_asin),
      csvCell(r.fba_sku),
      csvCell(r.sku),
      csvCell(r.title),
      csvCell(r.status_label),
      csvCell(r.intelligence_score),
      csvCell(r.fbm_units_30d),
      csvCell(r.fbm_velocity_per_day.toFixed(2)),
      csvCell(r.fba_qty_available),
      csvCell(r.fba_qty_inbound),
      csvCell(r.fba_units_sold_30d),
      csvCell(r.fba_buy_box_pct > 0 ? `${r.fba_buy_box_pct.toFixed(1)}%` : 'N/A'),
      csvCell(r.sessions_30d),
      csvCell(r.conversion_rate > 0 ? `${r.conversion_rate.toFixed(1)}%` : 'N/A'),
      csvCell(r.parent_asin),
      csvCell(r.parent_units_30d),
      csvCell(r.sibling_count),
      csvCell(r.weeks_of_cover !== null ? r.weeks_of_cover.toFixed(1) : 'N/A'),
      csvCell(r.recommended_send_qty),
      csvCell(r.send_rationale),
    ])

  return BOM + [headers.map(h => csvCell(h)).join(','), ...rows.map(r => r.join(','))].join('\r\n')
}

/**
 * Generate Amazon Shipment-Ready CSV
 * UTF-8 BOM prefix ensures Excel opens the file with correct encoding and column splitting.
 */
export function generateAmazonShipmentCSV(report: ProductRecommendation[]): string {
  const BOM = '\uFEFF'
  // Split the old combined Notes column into discrete, spreadsheet-friendly columns:
  //   Action          — the urgency label only (e.g. "Send Urgently", "Send Now", "FBA Stocked Out")
  //   Weeks of Cover  — numeric weeks remaining (or blank if N/A)
  //   Sessions/30d    — session count from traffic data (or blank if 0)
  //   Notes           — the full rationale sentence for reference
  const headers = [
    'Merchant SKU',
    'ASIN',
    'Quantity to Ship',
    'Condition',
    'Action',
    'Weeks of Cover',
    'Sessions / 30d',
    'Notes',
  ]

  const rows = report
    .filter(r => r.recommended_send_qty > 0 && ['stocked_out', 'critical', 'replenish', 'new_candidate'].includes(r.status))
    .map(r => [
      csvCell(r.fba_sku || r.sku || r.asin),
      csvCell(r.fba_asin || r.asin),
      csvCell(r.recommended_send_qty),
      csvCell('NewItem'),
      csvCell(r.status_label),
      csvCell(r.weeks_of_cover !== null && r.weeks_of_cover !== undefined ? r.weeks_of_cover.toFixed(1) : ''),
      csvCell(r.sessions_30d > 0 ? r.sessions_30d : ''),
      csvCell(r.send_rationale),
    ])

  return BOM + [headers.map(h => csvCell(h)).join(','), ...rows.map(r => r.join(','))].join('\r\n')
}
