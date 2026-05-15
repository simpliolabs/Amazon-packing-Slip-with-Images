import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MissingInventoryGap {
  sku: string
  asin: string
  product_name: string
  quantity: number
  status: string
  family: string
  size_token: string
  color_token: string
  total_colors_for_size: number
  stocked_colors: number
  max_qty_in_sibling: number
  family_total_colors: number
  severity: 'critical' | 'warning'
  last_synced_at: string | null
}

export interface MissingInventorySummary {
  family: string
  total_gaps: number
  critical_gaps: number
  warning_gaps: number
  sizes_affected: number
  colors_affected: number
  missing_sizes: string[]
  last_synced_at: string | null
}

export interface MissingInventoryResponse {
  summary: MissingInventorySummary[]
  gaps: MissingInventoryGap[]
  totals: {
    total_gaps: number
    critical_gaps: number
    warning_gaps: number
    families_affected: number
  }
  last_synced_at: string | null
}

// ─── GET /api/fba/missing-inventory ──────────────────────────────────────────
// Query params:
//   family   — filter to a specific family prefix
//   severity — filter to 'critical' | 'warning'
//   limit    — max gaps to return (default 200)

export async function GET(req: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(req.url)
    const familyFilter   = searchParams.get('family') || ''
    const severityFilter = searchParams.get('severity') || ''
    const limitParam     = parseInt(searchParams.get('limit') || '300', 10)

    // ── Fetch summary ──────────────────────────────────────────────────────
    const { data: summaryData, error: summaryErr } = await supabase
      .from('v_missing_inventory_summary')
      .select('*')
      .order('critical_gaps', { ascending: false })
      .limit(200)

    if (summaryErr) throw summaryErr

    // ── Fetch gaps ─────────────────────────────────────────────────────────
    let gapsQuery = supabase
      .from('v_missing_inventory')
      .select('*')
      .limit(limitParam)

    if (familyFilter) {
      gapsQuery = gapsQuery.eq('family', familyFilter)
    }
    if (severityFilter === 'critical' || severityFilter === 'warning') {
      gapsQuery = gapsQuery.eq('severity', severityFilter)
    }

    const { data: gapsData, error: gapsErr } = await gapsQuery
    if (gapsErr) throw gapsErr

    // ── Compute totals ─────────────────────────────────────────────────────
    const allSummary = summaryData as MissingInventorySummary[]
    const totals = {
      total_gaps:        allSummary.reduce((s, r) => s + r.total_gaps, 0),
      critical_gaps:     allSummary.reduce((s, r) => s + r.critical_gaps, 0),
      warning_gaps:      allSummary.reduce((s, r) => s + r.warning_gaps, 0),
      families_affected: allSummary.length,
    }

    const lastSynced = (gapsData as MissingInventoryGap[]).reduce<string | null>(
      (best, g) => {
        if (!g.last_synced_at) return best
        if (!best) return g.last_synced_at
        return g.last_synced_at > best ? g.last_synced_at : best
      },
      null
    )

    const response: MissingInventoryResponse = {
      summary:        allSummary,
      gaps:           gapsData as MissingInventoryGap[],
      totals,
      last_synced_at: lastSynced,
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('[missing-inventory] GET error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
