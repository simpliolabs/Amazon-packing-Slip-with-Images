/**
 * Lightweight report sync endpoint — syncs Sales Report + Listings + Inactive Listings + FBA Inventory.
 * FBA Inventory sync is what populates the ON WAY (quantity_inbound) column.
 * GET /api/fba/sync-reports               — triggers report syncs and returns results
 * GET /api/fba/sync-reports?force=listings — forces a fresh listings report, bypassing the 2-hour cache
 * GET /api/fba/sync-reports?force=sales    — forces fresh sales reports, bypassing the 6-hour cache
 */
export const dynamic = 'force-dynamic'

import { NextResponse, NextRequest } from 'next/server'
import { syncSalesReport } from '@/lib/sync/syncSalesReport'
import { syncListings } from '@/lib/sync/syncListings'
import { syncInactiveListings } from '@/lib/sync/syncInactiveListings'
import { syncFbaInventory } from '@/lib/sync/syncFbaInventory'

export async function GET(request: NextRequest) {
  const start = Date.now()
  const results: Record<string, unknown> = {}

  // ?force=listings bypasses the 2-hour cached report so a fresh one is always requested
  // ?force=sales    bypasses the 6-hour sales report cache and requests fresh Amazon reports
  const forceParam = request.nextUrl.searchParams.get('force')
  const forceListings = forceParam === 'listings'
  const forceSales = forceParam === 'sales'

  // Run all four in parallel — FBA inventory sync is the source of ON WAY data
  // syncInactiveListings runs alongside syncListings to populate status_message
  // (Missing offer, Detail page removed, Search suppressed, etc.)
  const [salesResult, listingsResult, inactiveListingsResult, fbaInvResult] = await Promise.allSettled([
    syncSalesReport(forceSales),
    syncListings(forceListings),
    syncInactiveListings(forceListings),
    syncFbaInventory(),
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

  if (inactiveListingsResult.status === 'fulfilled') {
    results.inactiveListings = inactiveListingsResult.value
  } else {
    results.inactiveListings = { error: String(inactiveListingsResult.reason) }
  }

  if (fbaInvResult.status === 'fulfilled') {
    results.fbaInventory = fbaInvResult.value
  } else {
    results.fbaInventory = { error: String(fbaInvResult.reason) }
  }

  results.durationMs = Date.now() - start
  return NextResponse.json(results)
}
