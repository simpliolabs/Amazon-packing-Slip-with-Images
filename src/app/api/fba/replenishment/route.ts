/**
 * FBA Replenishment API
 * GET  /api/fba/replenishment  — returns full replenishment report (+ optional format=csv|shipment)
 * POST /api/fba/replenishment  — triggers sync in background, returns immediately with status
 * GET  /api/fba/replenishment?status=1  — returns sync status (is it running?)
 */

export const maxDuration = 300
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateReplenishmentReport, generateTeamCSV, generateAmazonShipmentCSV } from '@/lib/fba/replenishment'
import { syncCatalogAndInventory } from '@/lib/sync/syncCatalog'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Simple in-memory sync state (works for single-instance deployment)
let syncRunning = false
let lastSyncResult: { completedAt: string; result: unknown } | null = null

// GET — return current replenishment report from stored data
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const format = searchParams.get('format') // 'json' | 'csv' | 'shipment'
  const statusCheck = searchParams.get('status')

  // Status check endpoint
  if (statusCheck) {
    return NextResponse.json({
      syncRunning,
      lastSync: lastSyncResult,
    })
  }

  try {
    const report = await generateReplenishmentReport()

    if (format === 'csv') {
      const csv = generateTeamCSV(report)
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="fba-replenishment-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      })
    }

    if (format === 'shipment') {
      const csv = generateAmazonShipmentCSV(report)
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="amazon-shipment-${new Date().toISOString().split('T')[0]}.csv"`,
        },
      })
    }

    // Summary stats
    const summary = {
      total: report.length,
      critical: report.filter(r => r.status === 'critical').length,
      stocked_out: report.filter(r => r.status === 'stocked_out').length,
      replenish: report.filter(r => r.status === 'replenish').length,
      new_candidates: report.filter(r => r.status === 'new_candidate').length,
      watch: report.filter(r => r.status === 'watch').length,
      healthy: report.filter(r => r.status === 'healthy').length,
      overstocked: report.filter(r => r.status === 'overstocked').length,
    }

    return NextResponse.json({ report, summary })
  } catch (err) {
    console.error('[FBA API] Error generating report:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate report' },
      { status: 500 }
    )
  }
}

// POST — fire-and-forget sync, return immediately
export async function POST(req: NextRequest) {
  if (syncRunning) {
    return NextResponse.json({
      message: 'Sync already in progress — please wait.',
      syncRunning: true,
    })
  }

  // Start sync in background (fire and forget)
  syncRunning = true
  const syncPromise = (async () => {
    try {
      console.log('[FBA API] Background sync starting...')
      const syncResult = await syncCatalogAndInventory()
      console.log('[FBA API] Background sync complete:', syncResult)
      lastSyncResult = { completedAt: new Date().toISOString(), result: syncResult }
    } catch (err) {
      console.error('[FBA API] Background sync error:', err)
      lastSyncResult = { completedAt: new Date().toISOString(), result: { error: String(err) } }
    } finally {
      syncRunning = false
    }
  })()

  // Wait up to 55 seconds for the sync to complete (within proxy timeout)
  // If it finishes in time, return the full report. Otherwise return partial.
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 55000))
  const raceResult = await Promise.race([syncPromise.then(() => 'done' as const), timeout])

  if (raceResult === 'done') {
    // Sync finished within 55s — return full report
    try {
      const report = await generateReplenishmentReport()
      const summary = {
        total: report.length,
        critical: report.filter(r => r.status === 'critical').length,
        stocked_out: report.filter(r => r.status === 'stocked_out').length,
        replenish: report.filter(r => r.status === 'replenish').length,
        new_candidates: report.filter(r => r.status === 'new_candidate').length,
        watch: report.filter(r => r.status === 'watch').length,
        healthy: report.filter(r => r.status === 'healthy').length,
        overstocked: report.filter(r => r.status === 'overstocked').length,
      }
      return NextResponse.json({
        sync: lastSyncResult?.result,
        report,
        summary,
      })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to generate report after sync' },
        { status: 500 }
      )
    }
  } else {
    // Sync still running — return partial response so the frontend doesn't get a 502
    return NextResponse.json({
      message: 'Sync started — still running in background. Data will update shortly. Refresh in 30 seconds.',
      syncRunning: true,
      partial: true,
    })
  }
}
