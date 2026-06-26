/**
 * GET /api/fba/score-history?listing_key=B0XXXXXXXX[&limit=12]
 * ─────────────────────────────────────────────────────────────────────────────
 * PHASE C (spec §5 Phase C): the append-only score TREND that powers the 12-point SVG sparkline on
 * the dashboard card + the detail Outcome panel. Reads listing_score_history NEWEST-FIRST, capped to
 * `limit` (default 12 — the sparkline width), then returns the points OLDEST-FIRST so the caller can
 * draw left→right without re-sorting.
 *
 *   listing_key = COALESCE(parent_asin, asin) — standalones self-parent (spec §4 grain rule). For a
 *   parent-grain card that equals parent_asin; the dashboard passes parent_asin directly.
 *
 * Append-only series written by appendScoreHistory() (src/lib/fba/scoreHistory.ts) at every
 * listing_seo_scores write site + the Phase C cron's outcome-resurface row. CHANGE-POINTS only
 * (score or content_fingerprint moved), so 12 rows already cover a long, meaningful trend.
 *
 * Best-effort: if the 038 migration isn't applied yet the query errors and we return an EMPTY series
 * (200, points:[]) — the sparkline simply doesn't render. Never a 500 over a missing-table.
 *
 * Response: { listing_key, points: ScorePoint[], latest, baseline, trend }
 *   points  — oldest→newest [{ scored_at, overall_score, lifecycle_state, trigger }]
 *   latest  — most-recent overall_score (number | null)
 *   baseline— first point's overall_score in the window (number | null)
 *   trend   — 'up' | 'down' | 'flat' | null  (latest vs baseline)
 */
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

interface ScoreHistRow {
  overall_score: number | null
  lifecycle_state: string | null
  trigger: string | null
  scored_by_name: string | null
  scored_at: string
}

export interface ScorePoint {
  scored_at: string
  overall_score: number | null
  lifecycle_state: string | null
  trigger: string | null
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const listingKey = (searchParams.get('listing_key') || '').trim()
  if (!listingKey) {
    return NextResponse.json({ error: 'listing_key query param required' }, { status: 400 })
  }

  const limitParam = Number(searchParams.get('limit'))
  // Default 12 = the sparkline width; clamp 2..60.
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.max(Math.floor(limitParam), 2), 60) : 12

  const db = admin()

  // Newest-first so `limit` keeps the MOST RECENT N change-points, then reverse to oldest→newest.
  const { data, error } = await db
    .from('listing_score_history')
    .select('overall_score, lifecycle_state, trigger, scored_by_name, scored_at')
    .eq('listing_key', listingKey)
    .order('scored_at', { ascending: false })
    .limit(limit)

  if (error) {
    // 038 not applied (or transient) — degrade to an empty series so the sparkline just hides.
    console.warn('[score-history GET] non-fatal:', error.message)
    return NextResponse.json({ listing_key: listingKey, points: [], latest: null, baseline: null, trend: null })
  }

  const newestFirst = (data || []) as ScoreHistRow[]
  const points: ScorePoint[] = [...newestFirst]
    .reverse() // oldest → newest for left→right drawing
    .map((r) => ({
      scored_at: r.scored_at,
      overall_score: r.overall_score,
      lifecycle_state: r.lifecycle_state,
      trigger: r.trigger,
    }))

  const scored = points.filter((p) => p.overall_score != null) as (ScorePoint & { overall_score: number })[]
  const baseline = scored.length > 0 ? scored[0].overall_score : null
  const latest = scored.length > 0 ? scored[scored.length - 1].overall_score : null
  const trend: 'up' | 'down' | 'flat' | null =
    baseline == null || latest == null ? null
    : latest > baseline ? 'up'
    : latest < baseline ? 'down'
    : 'flat'

  return NextResponse.json({ listing_key: listingKey, points, latest, baseline, trend })
}
