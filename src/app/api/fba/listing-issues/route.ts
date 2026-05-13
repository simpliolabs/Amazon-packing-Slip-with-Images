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

export async function GET(req: NextRequest) {
  const supabase = getAdminSupabase()
  const issues: ListingIssue[] = []

  // Load listing health data
  const { data: listings } = await supabase
    .from('listing_health')
    .select('sku, asin, product_name, price, quantity, status, fulfillment_channel')

  // Load sales analytics for cross-reference
  const { data: salesData } = await supabase
    .from('sku_sales_analytics')
    .select('sku, asin, units_sold_30d, revenue_30d, fulfillment_channel')

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
      if (!existing || s.units_sold_30d > existing.units_sold_30d) {
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

  // Track ASINs that have FBA listings (from listing_health)
  const fbaListingAsins = new Set<string>()
  for (const l of listings || []) {
    if (l.fulfillment_channel === 'AMAZON_NA' || l.fulfillment_channel === 'AMAZON_EU' ||
        (l.sku && /[-_]FBA$/i.test(l.sku))) {
      if (l.asin) fbaListingAsins.add(l.asin)
    }
  }

  for (const listing of listings || []) {
    const sales = salesBySku.get(listing.sku)
    const asinSales = listing.asin ? salesByAsin.get(listing.asin) : null
    const unitsSold = sales?.units_sold_30d || 0
    const revenue = sales?.revenue_30d || 0

    // Issue 1: Suppressed / Inactive listing
    if (listing.status && listing.status !== 'Active' && listing.status !== 'Incomplete') {
      issues.push({
        sku: listing.sku,
        asin: listing.asin,
        product_name: listing.product_name,
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
    if (listing.status === 'Active' && (!listing.price || listing.price <= 0)) {
      issues.push({
        sku: listing.sku,
        asin: listing.asin,
        product_name: listing.product_name,
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
          product_name: listing.product_name,
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
    if (fbaAsinSet.has(s.asin) || fbaListingAsins.has(s.asin)) continue // already has FBA
    if ((s.units_sold_30d || 0) < 10) continue // only flag if selling 10+/month

    processedAsins.add(s.asin)
    issues.push({
      sku: s.sku,
      asin: s.asin,
      product_name: null, // will be enriched from listing_health if available
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

  // Enrich product names for fbm_no_fba issues from listing_health
  const listingsByAsin = new Map<string, string>()
  for (const l of listings || []) {
    if (l.asin && l.product_name) listingsByAsin.set(l.asin, l.product_name)
  }
  for (const issue of issues) {
    if (!issue.product_name && issue.asin) {
      issue.product_name = listingsByAsin.get(issue.asin) || null
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
