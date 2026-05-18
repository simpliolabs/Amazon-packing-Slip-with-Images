/**
 * Lightweight report sync endpoint — syncs Sales Report + Listings + FBA Inventory.
 * FBA Inventory sync is what populates the ON WAY (quantity_inbound) column.
 * GET /api/fba/sync-reports — triggers report syncs and returns results
 */
export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { syncSalesReport } from '@/lib/sync/syncSalesReport'
import { syncListings } from '@/lib/sync/syncListings'
import { syncFbaInventory } from '@/lib/sync/syncFbaInventory'

export async function GET() {
  const start = Date.now()
  const results: Record<string, unknown> = {}

  // Run all three in parallel — FBA inventory sync is the source of ON WAY data
  const [salesResult, listingsResult, fbaInvResult] = await Promise.allSettled([
    syncSalesReport(),
    syncListings(),
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

  if (fbaInvResult.status === 'fulfilled') {
    results.fbaInventory = fbaInvResult.value
  } else {
    results.fbaInventory = { error: String(fbaInvResult.reason) }
  }

  results.durationMs = Date.now() - start
  return NextResponse.json(results)
}
