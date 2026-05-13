/**
 * Lightweight report sync endpoint — only syncs Sales Report + Listings
 * Does NOT do the heavy FBA inventory fetch or velocity computation.
 * GET /api/fba/sync-reports — triggers report syncs and returns results
 */
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { syncSalesReport } from '@/lib/sync/syncSalesReport'
import { syncListings } from '@/lib/sync/syncListings'

export async function GET() {
  const start = Date.now()
  const results: Record<string, unknown> = {}

  // Run both in parallel
  const [salesResult, listingsResult] = await Promise.allSettled([
    syncSalesReport(),
    syncListings(),
  ])

  if (salesResult.status === 'fulfilled') {
    results.sales = salesResult.value
  } else {
    results.sales = { error: String(salesResult.reason) }
  }

  if (listingsResult.status === 'fulfilled') {
    results.listings = listingsResult.value
  } else {
    results.listings = { error: String(listingsResult.reason) }
  }

  results.durationMs = Date.now() - start
  return NextResponse.json(results)
}
