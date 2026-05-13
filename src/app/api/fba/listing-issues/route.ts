/**
 * Listing Issues API
 *
 * Cross-references listing_health + sku_sales_analytics to surface ONLY
 * actionable problems — not a data dump of all 10k+ listings.
 *
 * Issue categories:
 * 1. suppressed    — Amazon blocked the listing (status != 'Active')
 * 2. zero_price    — Listing has $0 price (broken)
 * 3. fba_no_stock  — FBA listing is active but qty = 0, with proven sales velocity
 * 4. fbm_no_fba    — High-velocity FBM listing with no FBA counterpart (opportunity)
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
  issue_type: 'suppressed' | 'zero_price' | 'fba_no_stock' | 'fbm_no_fba'
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
  fba_no_stock: 'FBA Active — No Stock',
  fbm_no_fba: 'High Velocity — No FBA',
}

const ISSUE_SEVERITY: Record<string, 'critical' | 'warning' | 'opportunity'> = {
  suppressed: 'critical',
  zero_price: 'critical',
  fba_no_stock: 'warning',
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
      hasMore = data.length === PAGE_SIZE // if we got a full page, there might be more
    } else {
      hasMore = false
    }
  }
  return allRows
}

export async function GET(req: NextRequest) {
  const supabase = getAdminSupabase()
  const issues: ListingIssue[] = []

  // Load ALL listing health data (paginated — table has 10k+ rows)
  const listings = await fetchAll<{
    sku: string; asin: string | null; product_name: string | null;
    price: number | null; quantity: number | null; status: string | null;
    fulfillment_channel: string | null;
  }>(supabase, 'listing_health', 'sku, asin, product_name, price, quantity, status, fulfillment_channel')

  // Load ALL sales analytics for cross-reference
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
      revenue_30d: s.revenue_30d || 0,
      channel: s.fulfillment_channel || '',
    })
    if (s.asin) {
      // Aggregate by ASIN (sum all SKU variants)
      const existing = salesByAsin.get(s.asin)
      if (!existing || (s.units_sold_30d || 0) > existing.units_sold_30d) {
        salesByAsin.set(s.asin, {
          units_sold_30d: s.units_sold_30d || 0,
          revenue_30d: s.revenue_30d || 0,
          channel: s.fulfillment_channel || '',
          sku: s.sku,
        })
      }
      if (s.fulfillment_channel === 'Amazon') {
        fbaAsinSet.add(s.asin)
      }
    }
  }

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
      // Extract base SKU (strip -FBA or _FBA suffix)
      if (l.sku && /[-_]FBA$/i.test(l.sku)) {
        const baseSku = l.sku.replace(/[-_]FBA$/i, '')
        fbaBaseSkus.add(baseSku)
      }
    }
  }
  // Also add base SKUs from sku_sales_analytics Amazon channel
  for (const s of salesData || []) {
    if (s.fulfillment_channel === 'Amazon' && s.sku && /[-_]FBA$/i.test(s.sku)) {
      const baseSku = s.sku.replace(/[-_]FBA$/i, '')
      fbaBaseSkus.add(baseSku)
    }
    // Also check by ASIN for Amazon channel (direct ASIN match)
    if (s.fulfillment_channel === 'Amazon' && s.asin) {
      fbaAsinSet.add(s.asin)
    }
  }

  // Build product name lookup from BOTH listing_health and sku_sales_analytics
  // This ensures we can always resolve a product name for any ASIN
  const productNameByAsin = new Map<string, string>()
  const productNameBySku = new Map<string, string>()
  for (const l of listings || []) {
    if (l.product_name) {
      if (l.asin) productNameByAsin.set(l.asin, l.product_name)
      if (l.sku) productNameBySku.set(l.sku, l.product_name)
    }
  }
  for (const s of salesData || []) {
    if (s.product_name) {
      if (s.asin && !productNameByAsin.has(s.asin)) {
        productNameByAsin.set(s.asin, s.product_name)
      }
      if (s.sku && !productNameBySku.has(s.sku)) {
        productNameBySku.set(s.sku, s.product_name)
      }
    }
  }

  for (const listing of listings || []) {
    const sales = salesBySku.get(listing.sku)
    const asinSales = listing.asin ? salesByAsin.get(listing.asin) : null
    const unitsSold = sales?.units_sold_30d || 0

    // Issue 1: Suppressed / Inactive listing
    if (listing.status && listing.status !== 'Active' && listing.status !== 'Incomplete') {
      issues.push({
        sku: listing.sku,
        asin: listing.asin,
        product_name: listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
        issue_type: 'suppressed',
        issue_label: ISSUE_LABELS.suppressed,
        severity: ISSUE_SEVERITY.suppressed,
        detail: `Status: "${listing.status}". This listing is not visible to buyers. Fix in Seller Central → Manage Inventory → Suppressed.`,
        price: listing.price,
        quantity: listing.quantity || 0,
        fulfillment_channel: listing.fulfillment_channel,
        units_sold_30d: unitsSold,
        estimated_lost_revenue_30d: asinSales ? asinSales.revenue_30d : null,
      })
      continue // Don't double-flag
    }

    // Issue 2: $0 price (broken listing)
    // BUT: The All Listings Report often has blank/null prices for FBA listings
    // or listings where Amazon controls the price. If the listing has recent sales
    // (proving it IS purchasable), or if we can find a price from sales analytics,
    // it's NOT truly broken — skip the false positive.
    if (listing.status === 'Active' && (!listing.price || listing.price <= 0)) {
      // Check if this listing has sales revenue (proves price exists on Amazon)
      const hasSalesRevenue = (sales?.revenue_30d && sales.revenue_30d > 0) ||
        (asinSales?.revenue_30d && asinSales.revenue_30d > 0)
      // Check if this is an FBA SKU (FBA prices are often missing from All Listings Report)
      const isFbaListing = listing.sku && /[-_]FBA$/i.test(listing.sku)
      // Check if the ASIN has any sales at all (even via other SKUs)
      const hasAnySales = unitsSold > 0 || (asinSales?.units_sold_30d && asinSales.units_sold_30d > 0)

      // Skip false positives: FBA listings with sales, or any listing with proven revenue
      if (hasSalesRevenue || (isFbaListing && hasAnySales)) {
        // Not a real issue — price exists on Amazon, just missing from the report
        continue
      }

      issues.push({
        sku: listing.sku,
        asin: listing.asin,
        product_name: listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
        issue_type: 'zero_price',
        issue_label: ISSUE_LABELS.zero_price,
        severity: ISSUE_SEVERITY.zero_price,
        detail: `Listing is active but has no price set. Buyers cannot purchase. Update price immediately.`,
        price: 0,
        quantity: listing.quantity || 0,
        fulfillment_channel: listing.fulfillment_channel,
        units_sold_30d: unitsSold,
        estimated_lost_revenue_30d: null,
      })
      continue
    }

    // Issue 3: FBA listing active but 0 stock, with proven velocity
    const isFbaSku = listing.sku && /[-_]FBA$/i.test(listing.sku)
    if (isFbaSku && listing.status === 'Active' && (listing.quantity || 0) === 0) {
      // Check if this ASIN has sales velocity
      const asinVelocity = asinSales?.units_sold_30d || unitsSold
      if (asinVelocity > 0) {
        const avgPrice = listing.price || (asinSales?.revenue_30d ? asinSales.revenue_30d / asinSales.units_sold_30d : 0)
        issues.push({
          sku: listing.sku,
          asin: listing.asin,
          product_name: listing.product_name || (listing.asin ? productNameByAsin.get(listing.asin) : null) || null,
          issue_type: 'fba_no_stock',
          issue_label: ISSUE_LABELS.fba_no_stock,
          severity: ISSUE_SEVERITY.fba_no_stock,
          detail: `FBA listing is live but has 0 units in FBA. This ASIN sold ${asinVelocity} units in 30d. You're losing FBA sales every day.`,
          price: listing.price,
          quantity: 0,
          fulfillment_channel: listing.fulfillment_channel,
          units_sold_30d: asinVelocity,
          estimated_lost_revenue_30d: avgPrice > 0 ? Math.round(avgPrice * asinVelocity * 0.5) : null, // estimate 50% could be FBA
        })
      }
      continue
    }
  }

  // Issue 4: High-velocity FBM-only ASINs with no FBA counterpart
  // (Only from sales data — these are ASINs selling well via Merchant with no FBA listing)
  const processedAsins = new Set<string>()
  for (const s of salesData || []) {
    if (!s.asin || processedAsins.has(s.asin)) continue
    if (s.fulfillment_channel !== 'Merchant') continue
    // Check if this ASIN already has FBA via:
    // 1. Direct ASIN match in sku_sales_analytics Amazon channel
    // 2. Direct ASIN match in listing_health FBA listings
    // 3. Base-SKU match (FBM SKU "X" has FBA counterpart "X-FBA" in listing_health or sales)
    if (fbaAsinSet.has(s.asin) || fbaListingAsins.has(s.asin) || fbaBaseSkus.has(s.sku)) continue // already has FBA
    if ((s.units_sold_30d || 0) < 10) continue // only flag if selling 10+/month

    processedAsins.add(s.asin)

    // Resolve product name from multiple sources
    const resolvedName = s.product_name
      || productNameByAsin.get(s.asin)
      || productNameBySku.get(s.sku)
      || null

    issues.push({
      sku: s.sku,
      asin: s.asin,
      product_name: resolvedName,
      issue_type: 'fbm_no_fba',
      issue_label: ISSUE_LABELS.fbm_no_fba,
      severity: ISSUE_SEVERITY.fbm_no_fba,
      detail: `Selling ${s.units_sold_30d} units/30d via FBM only. No FBA listing exists. Creating an FBA listing could increase sales and reduce your shipping workload.`,
      price: null,
      quantity: 0,
      fulfillment_channel: 'Merchant',
      units_sold_30d: s.units_sold_30d || 0,
      estimated_lost_revenue_30d: Math.round((s.revenue_30d || 0) * 0.3), // estimate 30% uplift from FBA
    })
  }

  // Final enrichment pass: fill any remaining null product_names
  for (const issue of issues) {
    if (!issue.product_name) {
      if (issue.asin) {
        issue.product_name = productNameByAsin.get(issue.asin) || null
      }
      if (!issue.product_name && issue.sku) {
        issue.product_name = productNameBySku.get(issue.sku) || null
      }
    }
  }

  // Sort: critical first, then by lost revenue
  const severityOrder = { critical: 0, warning: 1, opportunity: 2 }
  issues.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity]
    if (sevDiff !== 0) return sevDiff
    return (b.estimated_lost_revenue_30d || 0) - (a.estimated_lost_revenue_30d || 0)
  })

  // Summary
  const summary = {
    total: issues.length,
    critical: issues.filter(i => i.severity === 'critical').length,
    warning: issues.filter(i => i.severity === 'warning').length,
    opportunity: issues.filter(i => i.severity === 'opportunity').length,
    total_lost_revenue: issues.reduce((sum, i) => sum + (i.estimated_lost_revenue_30d || 0), 0),
  }

  return NextResponse.json({ issues, summary }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  })
}
