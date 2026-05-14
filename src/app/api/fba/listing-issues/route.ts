/**
 * Listing Issues API
 *
 * Cross-references listing_health + fba_inventory + sku_sales_analytics to surface
 * ONLY actionable problems — not a data dump of all 10k+ listings.
 *
 * Issue categories:
 * 1. suppressed        — Amazon explicitly blocked the listing (status = 'Suppressed')
 * 2. zero_price        — Listing is Active but has $0 price (broken)
 * 3. fba_no_stock      — FBA listing is Active but qty = 0, with proven sales velocity
 * 4. fba_stockout      — FBA listing is Inactive due to 0 stock (needs restock, not suppressed)
 * 5. inactive_no_stock — Listing is Inactive with no stock anywhere (FBA + FBM both 0)
 * 6. fbm_no_fba        — High-velocity FBM listing with no FBA counterpart (opportunity)
 *
 * Key fix (v2): status = 'Inactive' is NOT the same as 'Suppressed'.
 *   - 'Suppressed' = Amazon blocked it (requires Seller Central fix)
 *   - 'Inactive'   = listing exists but is not buyable (could be 0 stock, FBA taking over, etc.)
 *   FBM listings go Inactive when the FBA counterpart wins the Buy Box — this is NORMAL and
 *   should NOT be flagged as suppressed.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface ListingIssue {
  sku: string
  asin: string | null
  product_name: string | null
  issue_type: 'suppressed' | 'zero_price' | 'fba_no_stock' | 'fba_stockout' | 'inactive_no_stock' | 'fbm_no_fba'
  issue_label: string
  severity: 'critical' | 'warning' | 'opportunity'
  detail: string
  price: number | null
  quantity: number
  fulfillment_channel: string | null
  units_sold_30d: number
  estimated_lost_revenue_30d: number | null
}

const ISSUE_LABELS: Record<string, string> = {
  suppressed:        'Listing Suppressed',
  zero_price:        'Price Missing ($0)',
  fba_no_stock:      'FBA Active — No Stock',
  fba_stockout:      'FBA Stocked Out',
  inactive_no_stock: 'Inactive — No Stock',
  fbm_no_fba:        'High Velocity — No FBA',
}

const ISSUE_SEVERITY: Record<string, 'critical' | 'warning' | 'opportunity'> = {
  suppressed:        'critical',
  zero_price:        'critical',
  fba_no_stock:      'warning',
  fba_stockout:      'warning',
  inactive_no_stock: 'warning',
  fbm_no_fba:        'opportunity',
}

// Helper: fetch ALL rows from a table, paginating in chunks of 1000
// Supabase defaults to 1000-row limit; this ensures we get everything.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAll<T>(supabase: any, table: string, select: string): Promise<T[]> {
  const PAGE_SIZE = 1000
  const allRows: T[] = []
  let offset = 0
  let hasMore = true
  while (hasMore) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) {
      console.error(`[ListingIssues] Error fetching ${table} at offset ${offset}:`, error.message)
      break
    }
    if (data && data.length > 0) {
      allRows.push(...(data as T[]))
      offset += data.length
      hasMore = data.length === PAGE_SIZE
    } else {
      hasMore = false
    }
  }
  return allRows
}

export async function GET(req: NextRequest) {
  const supabase = getAdminSupabase()
  const issues: ListingIssue[] = []

  // ── 1. Load ALL listing health data (paginated — table has 10k+ rows) ──────
  const listings = await fetchAll<{
    sku: string; asin: string | null; product_name: string | null;
    price: number | null; quantity: number | null; status: string | null;
    fulfillment_channel: string | null;
  }>(supabase, 'listing_health', 'sku, asin, product_name, price, quantity, status, fulfillment_channel')

  // ── 2. Load FBA inventory data (real-time stock + shipment status) ──────────
  const { data: fbaInvData, error: fbaInvErr } = await supabase
    .from('fba_inventory')
    .select('asin, sku, quantity_available, quantity_inbound, shipment_status, label_created_at')
  if (fbaInvErr) {
    console.error('[ListingIssues] fba_inventory query error:', fbaInvErr.message)
  }

  // Build FBA stock maps — by ASIN and by SKU
  const fbaStockByAsin = new Map<string, number>()
  const fbaStockBySku  = new Map<string, number>()
  // Track ASINs with a recently-created shipment label (in-transit, not truly stocked out)
  const asinShipmentInProgress = new Set<string>()
  const skuShipmentInProgress  = new Set<string>()

  for (const inv of fbaInvData || []) {
    const qty = (inv.quantity_available || 0) + (inv.quantity_inbound || 0)
    if (inv.asin) {
      fbaStockByAsin.set(inv.asin, (fbaStockByAsin.get(inv.asin) || 0) + qty)
    }
    if (inv.sku) {
      fbaStockBySku.set(inv.sku, (fbaStockBySku.get(inv.sku) || 0) + qty)
    }
    // If a label was created in the last 30 days OR shipment_status is label_created/shipped,
    // treat this as "shipment in progress" — don't flag as a critical stockout
    const recentLabel = inv.label_created_at
      ? (Date.now() - new Date(inv.label_created_at).getTime()) < 30 * 24 * 60 * 60 * 1000
      : false
    const activeShipment = inv.shipment_status === 'label_created' || inv.shipment_status === 'shipped'
    if (recentLabel || activeShipment) {
      if (inv.asin) asinShipmentInProgress.add(inv.asin)
      if (inv.sku)  skuShipmentInProgress.add(inv.sku)
    }
  }

  // ── 3. Load ALL sales analytics for cross-reference ─────────────────────────
  const salesData = await fetchAll<{
    sku: string; asin: string | null; product_name: string | null;
    units_sold_30d: number | null; revenue_30d: number | null;
    fulfillment_channel: string | null;
  }>(supabase, 'sku_sales_analytics', 'sku, asin, product_name, units_sold_30d, revenue_30d, fulfillment_channel')

  // Build sales lookup by SKU and ASIN
  const salesBySku = new Map<string, { units_sold_30d: number; revenue_30d: number; channel: string }>()
  const salesByAsin = new Map<string, { units_sold_30d: number; revenue_30d: number; channel: string; sku: string }>()
  const fbaAsinSet = new Set<string>()

  for (const s of salesData || []) {
    salesBySku.set(s.sku, {
      units_sold_30d: s.units_sold_30d || 0,
      revenue_30d:    s.revenue_30d    || 0,
      channel:        s.fulfillment_channel || '',
    })
    if (s.asin) {
      const existing = salesByAsin.get(s.asin)
      if (!existing || (s.units_sold_30d || 0) > existing.units_sold_30d) {
        salesByAsin.set(s.asin, {
          units_sold_30d: s.units_sold_30d || 0,
          revenue_30d:    s.revenue_30d    || 0,
          channel:        s.fulfillment_channel || '',
          sku:            s.sku,
        })
      }
      if (s.fulfillment_channel === 'Amazon') {
        fbaAsinSet.add(s.asin)
      }
    }
  }

  // ── 4. Build FBA listing sets ─────────────────────────────────────────────
  // Track ASINs that have FBA listings — use SKU suffix pattern as primary detection
  // (fulfillment_channel in listing_health may show 'DEFAULT' for all rows due to report type)
  const fbaListingAsins = new Set<string>()
  // Also build a set of base SKUs that have FBA counterparts
  // e.g. if DAR-CCG-S-IVY-FBA exists, base SKU is DAR-CCG-S-IVY
  const fbaBaseSkus = new Set<string>()
  for (const l of listings || []) {
    if (l.fulfillment_channel === 'AMAZON_NA' || l.fulfillment_channel === 'AMAZON_EU' ||
        (l.sku && /[-_]FBA$/i.test(l.sku))) {
      if (l.asin) fbaListingAsins.add(l.asin)
      if (l.sku && /[-_]FBA$/i.test(l.sku)) {
        const baseSku = l.sku.replace(/[-_]FBA$/i, '')
        fbaBaseSkus.add(baseSku)
      }
    }
  }
  for (const s of salesData || []) {
    if (s.fulfillment_channel === 'Amazon' && s.sku && /[-_]FBA$/i.test(s.sku)) {
      const baseSku = s.sku.replace(/[-_]FBA$/i, '')
      fbaBaseSkus.add(baseSku)
    }
    if (s.fulfillment_channel === 'Amazon' && s.asin) {
      fbaAsinSet.add(s.asin)
    }
  }

  // ── 5. Build ASIN → valid price map ──────────────────────────────────────
  // If ANY SKU for an ASIN has a valid price, all $0 variants are report artifacts
  const asinHasValidPrice = new Set<string>()
  for (const l of listings || []) {
    if (l.asin && l.price && l.price > 0) {
      asinHasValidPrice.add(l.asin)
    }
  }

  // ── 6. Build product name lookup ─────────────────────────────────────────
  const productNameByAsin = new Map<string, string>()
  const productNameBySku  = new Map<string, string>()
  for (const l of listings || []) {
    if (l.product_name) {
      if (l.asin) productNameByAsin.set(l.asin, l.product_name)
      if (l.sku)  productNameBySku.set(l.sku, l.product_name)
    }
  }
  for (const s of salesData || []) {
    if (s.product_name) {
      if (s.asin && !productNameByAsin.has(s.asin)) productNameByAsin.set(s.asin, s.product_name)
      if (s.sku  && !productNameBySku.has(s.sku))   productNameBySku.set(s.sku, s.product_name)
    }
  }

  // ── 7. Main listing scan ──────────────────────────────────────────────────
  for (const listing of listings || []) {
    const sales     = salesBySku.get(listing.sku)
    const asinSales = listing.asin ? salesByAsin.get(listing.asin) : null
    const unitsSold = sales?.units_sold_30d || 0

    const isFbaSku = listing.sku && /[-_]FBA$/i.test(listing.sku)

    // ── Issue 1: TRULY Suppressed listing ──────────────────────────────────
    // ONLY flag status = 'Suppressed' — Amazon explicitly blocked this listing.
    // Do NOT flag 'Inactive' here — Inactive is a separate category below.
    if (listing.status === 'Suppressed') {
      issues.push({
        sku:           listing.sku,
        asin:          listing.asin,
        product_name:  listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
        issue_type:    'suppressed',
        issue_label:   ISSUE_LABELS.suppressed,
        severity:      ISSUE_SEVERITY.suppressed,
        detail:        `Amazon has suppressed this listing. It is not visible to buyers. Fix in Seller Central → Manage Inventory → Suppressed.`,
        price:         listing.price,
        quantity:      listing.quantity || 0,
        fulfillment_channel: listing.fulfillment_channel,
        units_sold_30d: unitsSold,
        estimated_lost_revenue_30d: asinSales ? asinSales.revenue_30d : null,
      })
      continue
    }

    // ── Issue 2: Inactive listing ──────────────────────────────────────────
    // 'Inactive' means the listing exists but is not currently buyable.
    // This has multiple causes — we need to distinguish them carefully.
    if (listing.status === 'Inactive') {
      const actualFbaStock = (fbaStockBySku.get(listing.sku) || 0) ||
        (listing.asin ? (fbaStockByAsin.get(listing.asin) || 0) : 0)

      if (isFbaSku) {
        // FBA SKU is Inactive — this means 0 FBA stock (not suppressed)
        // Check if a shipment is already in progress
        const shipmentPending = skuShipmentInProgress.has(listing.sku) ||
          (listing.asin ? asinShipmentInProgress.has(listing.asin) : false)

        const asinVelocity = asinSales?.units_sold_30d || unitsSold
        if (shipmentPending) {
          // Shipment label created recently — not a critical issue, just informational
          // Skip flagging — the user already knows and is acting on it
          continue
        }
        // Flag as fba_stockout (not suppressed)
        const avgPrice = listing.price || (asinSales?.revenue_30d && asinSales.units_sold_30d
          ? asinSales.revenue_30d / asinSales.units_sold_30d : 0)
        issues.push({
          sku:           listing.sku,
          asin:          listing.asin,
          product_name:  listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
          issue_type:    'fba_stockout',
          issue_label:   ISSUE_LABELS.fba_stockout,
          severity:      ISSUE_SEVERITY.fba_stockout,
          detail:        `FBA listing is Inactive due to 0 stock. ${asinVelocity > 0 ? `This ASIN sold ${asinVelocity} units in 30d — send a restock shipment now.` : 'Send a restock shipment to reactivate.'}`,
          price:         listing.price,
          quantity:      0,
          fulfillment_channel: listing.fulfillment_channel,
          units_sold_30d: asinVelocity,
          estimated_lost_revenue_30d: avgPrice > 0 && asinVelocity > 0
            ? Math.round(avgPrice * asinVelocity * 0.5) : null,
        })
        continue
      }

      // FBM SKU is Inactive
      // CRITICAL FIX: If this ASIN has FBA stock in fba_inventory, the FBM listing
      // going Inactive is NORMAL — FBA is handling the sales. Do NOT flag this.
      if (actualFbaStock > 0) {
        // FBA is active and has stock for this ASIN — FBM Inactive is expected behaviour
        continue
      }

      // Also check: does this ASIN have an FBA listing at all (even if currently 0 stock)?
      const asinHasFbaListing = listing.asin
        ? (fbaListingAsins.has(listing.asin) || fbaAsinSet.has(listing.asin))
        : false
      const baseSkuHasFba = fbaBaseSkus.has(listing.sku)

      if (asinHasFbaListing || baseSkuHasFba) {
        // FBA listing exists for this ASIN — FBM Inactive is likely because FBA is active
        // or FBA is also stocked out (the FBA SKU will be flagged separately)
        continue
      }

      // Genuinely inactive with no FBA anywhere — flag as inactive_no_stock
      issues.push({
        sku:           listing.sku,
        asin:          listing.asin,
        product_name:  listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
        issue_type:    'inactive_no_stock',
        issue_label:   ISSUE_LABELS.inactive_no_stock,
        severity:      ISSUE_SEVERITY.inactive_no_stock,
        detail:        `Listing is Inactive with no FBA stock and no FBM quantity. Reactivate by adding stock or creating an FBA shipment.`,
        price:         listing.price,
        quantity:      listing.quantity || 0,
        fulfillment_channel: listing.fulfillment_channel,
        units_sold_30d: unitsSold,
        estimated_lost_revenue_30d: asinSales ? Math.round(asinSales.revenue_30d * 0.5) : null,
      })
      continue
    }

    // ── Issue 3: $0 price (broken listing) ────────────────────────────────
    // The All Listings Report often has blank/null prices for FBA listings
    // or listings where Amazon controls the price. If the listing has recent sales
    // (proving it IS purchasable), or if another SKU for the ASIN has a valid price,
    // it's NOT truly broken — skip the false positive.
    if (listing.status === 'Active' && (!listing.price || listing.price <= 0)) {
      const hasSalesRevenue = (sales?.revenue_30d && sales.revenue_30d > 0) ||
        (asinSales?.revenue_30d && asinSales.revenue_30d > 0)
      const hasAnySales = unitsSold > 0 || (asinSales?.units_sold_30d && asinSales.units_sold_30d > 0)
      const asinHasPrice = listing.asin ? asinHasValidPrice.has(listing.asin) : false

      if (hasSalesRevenue || (isFbaSku && hasAnySales) || asinHasPrice) {
        continue // Not a real issue — price exists on Amazon, just missing from the report
      }

      issues.push({
        sku:           listing.sku,
        asin:          listing.asin,
        product_name:  listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
        issue_type:    'zero_price',
        issue_label:   ISSUE_LABELS.zero_price,
        severity:      ISSUE_SEVERITY.zero_price,
        detail:        `Listing is active but has no price set. Buyers cannot purchase. Update price immediately in Seller Central.`,
        price:         0,
        quantity:      listing.quantity || 0,
        fulfillment_channel: listing.fulfillment_channel,
        units_sold_30d: unitsSold,
        estimated_lost_revenue_30d: null,
      })
      continue
    }

    // ── Issue 4: FBA listing Active but 0 stock, with proven velocity ─────
    // This is an Active FBA listing that will soon go Inactive — catch it early.
    if (isFbaSku && listing.status === 'Active' && (listing.quantity === 0 || listing.quantity === null)) {
      // Cross-reference with fba_inventory for ACTUAL stock levels
      const actualFbaStock = (fbaStockBySku.get(listing.sku) || 0) ||
        (listing.asin ? (fbaStockByAsin.get(listing.asin) || 0) : 0)
      if (actualFbaStock > 0) {
        continue // FBA inventory exists — not a "no stock" issue
      }

      // Check if a shipment is already in progress
      const shipmentPending = skuShipmentInProgress.has(listing.sku) ||
        (listing.asin ? asinShipmentInProgress.has(listing.asin) : false)
      if (shipmentPending) continue

      const asinVelocity = asinSales?.units_sold_30d || unitsSold
      if (asinVelocity > 0) {
        const avgPrice = listing.price || (asinSales?.revenue_30d && asinSales.units_sold_30d
          ? asinSales.revenue_30d / asinSales.units_sold_30d : 0)
        issues.push({
          sku:           listing.sku,
          asin:          listing.asin,
          product_name:  listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
          issue_type:    'fba_no_stock',
          issue_label:   ISSUE_LABELS.fba_no_stock,
          severity:      ISSUE_SEVERITY.fba_no_stock,
          detail:        `FBA listing is live but has 0 units in FBA. This ASIN sold ${asinVelocity} units in 30d. Send a restock shipment before it goes Inactive.`,
          price:         listing.price,
          quantity:      0,
          fulfillment_channel: listing.fulfillment_channel,
          units_sold_30d: asinVelocity,
          estimated_lost_revenue_30d: avgPrice > 0 ? Math.round(avgPrice * asinVelocity * 0.5) : null,
        })
      }
      continue
    }
  }

  // ── 8. Sibling SKU inference ──────────────────────────────────────────────
  // If a product family (e.g., DAR-CCG) has most variants with FBA listings,
  // infer that missing variants also have FBA (just not in reports yet).
  // This prevents false "No FBA" alerts for products that clearly have FBA.
  const familyFbaStats = new Map<string, { total: number; withFba: number; skus: string[] }>()
  for (const s of salesData || []) {
    if (s.fulfillment_channel !== 'Merchant' || !s.sku) continue
    const parts = s.sku.split('-')
    if (parts.length < 3) continue
    const prefix = parts.slice(0, 2).join('-')
    const stats = familyFbaStats.get(prefix) || { total: 0, withFba: 0, skus: [] }
    stats.total++
    stats.skus.push(s.sku)
    if (fbaBaseSkus.has(s.sku) || (s.asin && (fbaAsinSet.has(s.asin) || fbaListingAsins.has(s.asin)))) {
      stats.withFba++
    }
    familyFbaStats.set(prefix, stats)
  }
  // For families where ≥40% have FBA, add remaining SKUs to fbaBaseSkus
  for (const [prefix, stats] of familyFbaStats) {
    if (stats.total < 3 || stats.withFba / stats.total < 0.4) continue
    for (const sku of stats.skus) {
      if (!fbaBaseSkus.has(sku)) {
        fbaBaseSkus.add(sku)
        console.log(`[ListingIssues] Sibling-inferred FBA for ${sku} (family ${prefix}: ${stats.withFba}/${stats.total})`)
      }
    }
  }

  // ── 9. Issue 6: High-velocity FBM-only ASINs with no FBA counterpart ─────
  const processedAsins = new Set<string>()
  for (const s of salesData || []) {
    if (!s.asin || processedAsins.has(s.asin)) continue
    if (s.fulfillment_channel !== 'Merchant') continue
    if (fbaAsinSet.has(s.asin) || fbaListingAsins.has(s.asin) || fbaBaseSkus.has(s.sku)) continue
    if ((s.units_sold_30d || 0) < 10) continue

    processedAsins.add(s.asin)

    const resolvedName = s.product_name
      || productNameByAsin.get(s.asin)
      || productNameBySku.get(s.sku)
      || null

    issues.push({
      sku:           s.sku,
      asin:          s.asin,
      product_name:  resolvedName,
      issue_type:    'fbm_no_fba',
      issue_label:   ISSUE_LABELS.fbm_no_fba,
      severity:      ISSUE_SEVERITY.fbm_no_fba,
      detail:        `Selling ${s.units_sold_30d} units/30d via FBM only. No FBA listing exists. Creating an FBA listing could increase sales and reduce your shipping workload.`,
      price:         null,
      quantity:      0,
      fulfillment_channel: 'Merchant',
      units_sold_30d: s.units_sold_30d || 0,
      estimated_lost_revenue_30d: Math.round((s.revenue_30d || 0) * 0.3),
    })
  }

  // ── 10. Final enrichment: fill any remaining null product_names ───────────
  for (const issue of issues) {
    if (!issue.product_name) {
      if (issue.asin) issue.product_name = productNameByAsin.get(issue.asin) || null
      if (!issue.product_name && issue.sku) issue.product_name = productNameBySku.get(issue.sku) || null
    }
  }

  // ── 11. Sort: critical first, then by lost revenue ────────────────────────
  const severityOrder = { critical: 0, warning: 1, opportunity: 2 }
  issues.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity]
    if (sevDiff !== 0) return sevDiff
    return (b.estimated_lost_revenue_30d || 0) - (a.estimated_lost_revenue_30d || 0)
  })

  // ── 12. Summary ───────────────────────────────────────────────────────────
  const summary = {
    total:              issues.length,
    critical:           issues.filter(i => i.severity === 'critical').length,
    warning:            issues.filter(i => i.severity === 'warning').length,
    opportunity:        issues.filter(i => i.severity === 'opportunity').length,
    total_lost_revenue: issues.reduce((sum, i) => sum + (i.estimated_lost_revenue_30d || 0), 0),
  }

  return NextResponse.json({ issues, summary }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
