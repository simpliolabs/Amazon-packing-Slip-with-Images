/**
 * Listing Issues API
 *
 * Cross-references listing_health + fba_inventory + sku_sales_analytics to surface
 * ONLY actionable LISTING problems — not inventory/replenishment concerns.
 *
 * Issue categories:
 * 1. suppressed   — Amazon explicitly blocked the listing (status = 'Suppressed')
 * 2. zero_price   — Listing is Active but has $0 price (broken)
 * 3. fbm_no_fba   — High-velocity FBM listing with no FBA counterpart (opportunity)
 *
 * IMPORTANT: Stock-related issues (FBA stocked out, FBA no stock, Inactive due to
 * 0 inventory) are NOT listing issues — they are REPLENISHMENT issues and belong
 * exclusively in the Replenishment tab. This route does NOT surface them.
 *
 * Key fix (v3): Removed fba_stockout, fba_no_stock, and inactive_no_stock.
 *   - 'Suppressed' = Amazon blocked it (requires Seller Central fix) → LISTING issue
 *   - 'Inactive'   = listing not buyable due to stock → REPLENISHMENT issue
 *   - '$0 price'   = pricing error → LISTING issue
 *   - 'FBM only'   = opportunity to create FBA listing → LISTING opportunity
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
  issue_type: 'suppressed' | 'zero_price' | 'fbm_no_fba'
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
  suppressed: 'Listing Suppressed',
  zero_price: 'Price Missing ($0)',
  fbm_no_fba: 'High Velocity — No FBA',
}

const ISSUE_SEVERITY: Record<string, 'critical' | 'warning' | 'opportunity'> = {
  suppressed: 'critical',
  zero_price: 'critical',
  fbm_no_fba: 'opportunity',
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

  // ── 2. Load ALL sales analytics for cross-reference ─────────────────────────
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

  // ── 3. Build FBA listing sets ─────────────────────────────────────────────
  // Track ASINs that have FBA listings — use SKU suffix pattern as primary detection
  const fbaListingAsins = new Set<string>()
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

  // ── 4. Build ASIN → valid price map ──────────────────────────────────────
  // If ANY SKU for an ASIN has a valid price, all $0 variants are report artifacts
  const asinHasValidPrice = new Set<string>()
  for (const l of listings || []) {
    if (l.asin && l.price && l.price > 0) {
      asinHasValidPrice.add(l.asin)
    }
  }

  // ── 5. Build product name lookup ─────────────────────────────────────────
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

  // ── 6. Main listing scan ──────────────────────────────────────────────────
  for (const listing of listings || []) {
    const sales     = salesBySku.get(listing.sku)
    const asinSales = listing.asin ? salesByAsin.get(listing.asin) : null
    const unitsSold = sales?.units_sold_30d || 0

    const isFbaSku = listing.sku && /[-_]FBA$/i.test(listing.sku)

    // ── Issue 1: TRULY Suppressed listing ──────────────────────────────────
    // ONLY flag status = 'Suppressed' — Amazon explicitly blocked this listing.
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

    // ── Inactive listings: SKIP entirely ──────────────────────────────────
    // Inactive = stock/inventory issue → belongs in Replenishment tab, not here.
    if (listing.status === 'Inactive') {
      continue
    }

    // ── Issue 2: $0 price (broken listing) ────────────────────────────────
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
  }

  // ── 7. Sibling SKU inference ──────────────────────────────────────────────
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
  for (const [prefix, stats] of familyFbaStats) {
    if (stats.total < 3 || stats.withFba / stats.total < 0.4) continue
    for (const sku of stats.skus) {
      if (!fbaBaseSkus.has(sku)) {
        fbaBaseSkus.add(sku)
        console.log(`[ListingIssues] Sibling-inferred FBA for ${sku} (family ${prefix}: ${stats.withFba}/${stats.total})`)
      }
    }
  }

  // ── 8. Issue 3: High-velocity FBM-only ASINs with no FBA counterpart ─────
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

  // ── 9. Final enrichment: fill any remaining null product_names ───────────
  for (const issue of issues) {
    if (!issue.product_name) {
      if (issue.asin) issue.product_name = productNameByAsin.get(issue.asin) || null
      if (!issue.product_name && issue.sku) issue.product_name = productNameBySku.get(issue.sku) || null
    }
  }

  // ── 10. Sort: critical first, then by lost revenue ────────────────────────
  const severityOrder = { critical: 0, warning: 1, opportunity: 2 }
  issues.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity]
    if (sevDiff !== 0) return sevDiff
    return (b.estimated_lost_revenue_30d || 0) - (a.estimated_lost_revenue_30d || 0)
  })

  // ── 11. Summary ───────────────────────────────────────────────────────────
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
