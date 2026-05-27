/**
 * GET /api/fba/cron-sync
 * Automatic FBA data sync — runs every 6 hours via Vercel Cron.
 * Syncs: FBA inventory, sales reports, listings, inactive listings.
 * This keeps the portal data fresh without any manual action.
 *
 * Vercel Cron automatically sends Authorization: Bearer <CRON_SECRET>
 * We also accept x-cron-secret header for backward compatibility.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes max

import { NextRequest, NextResponse } from 'next/server'
import { syncFbaInventory } from '@/lib/sync/syncFbaInventory'
import { syncSalesReport } from '@/lib/sync/syncSalesReport'
import { syncListings } from '@/lib/sync/syncListings'
import { syncInactiveListings } from '@/lib/sync/syncInactiveListings'

export async function GET(request: NextRequest) {
  // Verify this is a legitimate cron call
  const authHeader = request.headers.get('authorization')
  const cronHeader = request.headers.get('x-cron-secret')
  const cronSecret = process.env.CRON_SECRET

  const isVercelCron = authHeader === `Bearer ${cronSecret}`
  const isLegacyCron = cronHeader === cronSecret

  if (!isVercelCron && !isLegacyCron) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const start = Date.now()
  const results: Record<string, unknown> = {
    triggered_at: new Date().toISOString(),
    trigger: 'vercel_cron',
  }

  console.log('[FBA Cron] Starting automatic FBA sync...')

  // Run all syncs in parallel
  const [fbaInvResult, salesResult, listingsResult, inactiveResult] = await Promise.allSettled([
    syncFbaInventory(),
    syncSalesReport(false),
    syncListings(false),
    syncInactiveListings(false),
  ])

  results.fbaInventory = fbaInvResult.status === 'fulfilled'
    ? fbaInvResult.value
    : { error: String(fbaInvResult.reason) }

  results.sales = salesResult.status === 'fulfilled'
    ? salesResult.value
    : { error: String(salesResult.reason) }

  results.listings = listingsResult.status === 'fulfilled'
    ? listingsResult.value
    : { error: String(listingsResult.reason) }

  results.inactiveListings = inactiveResult.status === 'fulfilled'
    ? inactiveResult.value
    : { error: String(inactiveResult.reason) }

  results.durationMs = Date.now() - start

  console.log(`[FBA Cron] Completed in ${results.durationMs}ms`)

  return NextResponse.json(results)
}
