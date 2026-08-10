/**
 * GET /api/fba/pool-census
 * ─────────────────────────────────────────────────────────────────────────────
 * POOL-HEALTH CENSUS — the gate that sequences the catalog regen into WAVES
 * (PO ruling 2026-08-10, "B: OK" to waves rather than a blanket sweep).
 *
 * WHY THIS EXISTS. A regen is only as good as the keyword pool it reads. On
 * 2026-08-09/10 we proved three ways a pool can be silently unfit while every
 * screen reports success:
 *   - UNRATED — `theme_fit` NULL on every row, so `effectiveBand` reads the same
 *     default for all of them, the band multiplier cancels out of `targetScore`,
 *     and the target set degrades to pure market/volume ordering with no error.
 *     (The dead wire that caused it is fixed; pools rated BEFORE the fix are
 *     still sitting in the table.)
 *   - UNSCORED — no `market_opportunity`, so the money-tail selector refuses to
 *     pick (correctly) and the title ships without one.
 *   - STALE — research older than the 14-day TTL: the market has moved and, for
 *     anything harvested before the seed-scrub fix, the design's own cluster was
 *     never harvested at all.
 * Regenerating a family in any of those states bakes the defect into its copy.
 * Doing it across the whole catalog multiplies it. So: census first, then waves.
 *
 * READ-ONLY. Counts rows; writes nothing; spends no Jungle Scout credits and
 * makes no model calls. Safe to hit repeatedly.
 *
 * Grades a parent into exactly one WAVE:
 *   1  READY      — rated, scored, fresh. Regenerate now.
 *   2  RESCORE    — rated but missing market data, or aging. Cheap to fix (the
 *                   0-credit backfill/promotion path), then it joins wave 1.
 *   3  RERESEARCH — unrated or stale or empty. Needs a real harvest FIRST; a
 *                   regen here would ship the volume-ordered failure above.
 */
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/** Matches the TTL the research layer uses, so "stale" here means the same thing it means there. */
const RESEARCH_TTL_DAYS = 14
/** A pool is only "rated" if MOST of it carries a band. A handful of rated rows on a big pool is the
 *  partial-write shape, not a healthy pool — grading it READY is how a bad target set reaches copy. */
const RATED_SHARE_FLOOR = 0.8
/** Same reasoning for market data: the money-tail selector needs real supply, not one scored row. */
const SCORED_SHARE_FLOOR = 0.5

type Row = {
  asin: string | null
  parent_asin: string | null
  theme_fit: number | null
  market_opportunity: number | null
  selection_rank: number | null
  analyzed_at: string | null
}

interface Census {
  parentAsin: string
  rows: number
  rated: number
  scored: number
  ranked: number
  ratedShare: number
  scoredShare: number
  ageDays: number | null
  wave: 1 | 2 | 3
  reason: string
}

export async function GET() {
  try {
    const supabase = await createAdminClient()

    // Page the whole table — a single .select() caps at 1000 rows and would silently census a
    // fraction of the catalog while looking complete. That exact shape (an unpaginated evidence
    // read smaller than one bulk push) was an adversarial finding on the reconcile loop.
    const PAGE = 1000
    const rows: Row[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('keyword_analysis')
        .select('asin, parent_asin, theme_fit, market_opportunity, selection_rank, analyzed_at')
        .range(from, from + PAGE - 1)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      const batch = (data ?? []) as Row[]
      rows.push(...batch)
      if (batch.length < PAGE) break
    }

    const byParent = new Map<string, Row[]>()
    for (const r of rows) {
      const key = r.parent_asin || r.asin
      if (!key) continue
      const list = byParent.get(key)
      if (list) list.push(r)
      else byParent.set(key, [r])
    }

    const now = Date.now()
    const census: Census[] = []
    for (const [parentAsin, list] of byParent) {
      const rated = list.filter((r) => typeof r.theme_fit === 'number').length
      const scored = list.filter((r) => typeof r.market_opportunity === 'number').length
      const ranked = list.filter((r) => typeof r.selection_rank === 'number').length
      const stamps = list.map((r) => (r.analyzed_at ? Date.parse(r.analyzed_at) : NaN)).filter((n) => !Number.isNaN(n))
      const newest = stamps.length ? Math.max(...stamps) : null
      const ageDays = newest === null ? null : Math.floor((now - newest) / 86_400_000)
      const ratedShare = list.length ? rated / list.length : 0
      const scoredShare = list.length ? scored / list.length : 0

      let wave: 1 | 2 | 3
      let reason: string
      if (list.length === 0) { wave = 3; reason = 'empty pool' }
      else if (ageDays === null || ageDays > RESEARCH_TTL_DAYS) { wave = 3; reason = `research ${ageDays ?? '?'}d old (TTL ${RESEARCH_TTL_DAYS}d) — re-harvest before regen` }
      else if (ratedShare < RATED_SHARE_FLOOR) { wave = 3; reason = `only ${rated}/${list.length} rows carry a theme band — target set would order on market alone` }
      else if (scoredShare < SCORED_SHARE_FLOOR) { wave = 2; reason = `${scored}/${list.length} rows carry market_opportunity — 0-credit rescore, then wave 1` }
      else if (ageDays > RESEARCH_TTL_DAYS - 4) { wave = 2; reason = `rated + scored but ${ageDays}d old — refresh before regen` }
      else { wave = 1; reason = 'rated, scored, fresh — regenerate now' }

      census.push({ parentAsin, rows: list.length, rated, scored, ranked,
        ratedShare: Math.round(ratedShare * 100) / 100, scoredShare: Math.round(scoredShare * 100) / 100,
        ageDays, wave, reason })
    }

    // Biggest first inside each wave — a 170-child parent is worth more attention than a 2-child one.
    census.sort((a, b) => a.wave - b.wave || b.rows - a.rows)

    const summary = {
      parents: census.length,
      keywordRows: rows.length,
      wave1_ready: census.filter((c) => c.wave === 1).length,
      wave2_rescore: census.filter((c) => c.wave === 2).length,
      wave3_reresearch: census.filter((c) => c.wave === 3).length,
      thresholds: { researchTtlDays: RESEARCH_TTL_DAYS, ratedShareFloor: RATED_SHARE_FLOOR, scoredShareFloor: SCORED_SHARE_FLOOR },
      backendByteCap: CONTENT_CONTRACT.keywords.byteCap,
      note: 'READ-ONLY census. Wave 1 regenerates now; wave 2 needs a 0-credit rescore; wave 3 needs a real re-harvest first (a regen there ships a volume-ordered target set).',
    }

    return NextResponse.json({ summary, census })
  } catch (e) {
    return NextResponse.json({ error: 'census failed', details: String(e) }, { status: 500 })
  }
}
