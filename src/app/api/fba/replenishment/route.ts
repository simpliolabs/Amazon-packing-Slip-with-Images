/**
 * FBA Replenishment API
 * GET  /api/fba/replenishment  — returns full replenishment report
 * POST /api/fba/replenishment  — triggers a catalog + inventory sync then returns report
 */

// Allow up to 5 minutes for the sync (self-hosted, no Vercel limits)
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

async function requireAdmin(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) return false

  const token = authHeader.replace('Bearer ', '')
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return false

  const adminSupabase = getAdminSupabase()
  const { data: profile } = await adminSupabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  return profile?.role === 'admin'
}

// GET — return current replenishment report from stored data
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const format = searchParams.get('format') // 'json' | 'csv' | 'shipment'

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

// POST — trigger a fresh sync then return updated report
export async function POST(req: NextRequest) {
  try {
    console.log('[FBA API] Starting catalog + inventory sync...')
    const syncResult = await syncCatalogAndInventory()
    console.log('[FBA API] Sync complete:', syncResult)

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
      sync: syncResult,
      report,
      summary,
    })
  } catch (err) {
    console.error('[FBA API] Sync error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
