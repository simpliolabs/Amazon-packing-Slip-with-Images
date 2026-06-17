/**
 * GET /api/fba/keywords
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only feed for the Keyword Seed Pool dashboard (/fba/keywords). Surfaces the
 * cross-listing niche pools stored in keyword_seed_pool (migration 032): each seed_key
 * is one niche researched ONCE and reused by every same-niche listing for 14 days.
 *
 * Returns a LEAN payload (per-pool counts + top-5 keywords only) — the full keyword_data
 * JSONB stays server-side. Mirrors the reports-data route: service-role client (bypasses
 * RLS, gated by middleware + the /fba layout), force-dynamic, no-store.
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' }

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

type SeedKeyword = { keyword?: string; searchVolume?: number }
type SeedPoolRow = {
  seed_key: string
  keyword_data: SeedKeyword[] | null
  competitor_asin: string | null
  competitor_brand: string | null
  sov_percentage: number | null
  seed_source: string | null
  contributor_asins: string[] | null
  fetched_at: string
  expires_at: string | null
}

function emptyTotals() {
  return { seeds: 0, freshSeeds: 0, listingsServed: 0, totalReuses: 0, estCreditsSaved: 0 }
}

export async function GET() {
  const supabase = getAdminSupabase()
  const { data, error } = await supabase
    .from('keyword_seed_pool')
    .select(
      'seed_key, keyword_data, competitor_asin, competitor_brand, sov_percentage, seed_source, contributor_asins, fetched_at, expires_at',
    )
    .order('fetched_at', { ascending: false })
    .limit(500)

  // Table absent (pre-migration) or query error → empty, not a 500, so the page renders its
  // empty state instead of an error toast. (Migration 032 is applied in prod; this is defensive.)
  if (error) {
    return NextResponse.json({ pools: [], totals: emptyTotals(), note: error.message }, { headers: NO_STORE })
  }

  const now = Date.now()
  const pools = ((data ?? []) as SeedPoolRow[]).map((row) => {
    const kws = Array.isArray(row.keyword_data) ? row.keyword_data : []
    const contributors = Array.isArray(row.contributor_asins) ? row.contributor_asins : []
    const topKeywords = [...kws]
      .filter((k) => k && typeof k.keyword === 'string')
      .sort((a, b) => (b.searchVolume ?? 0) - (a.searchVolume ?? 0))
      .slice(0, 5)
      .map((k) => ({ keyword: k.keyword as string, searchVolume: k.searchVolume ?? 0 }))
    const expiresMs = row.expires_at ? new Date(row.expires_at).getTime() : null
    const fresh = expiresMs ? expiresMs > now : false
    const daysLeft = expiresMs ? Math.max(0, Math.round((expiresMs - now) / 86_400_000)) : null
    return {
      seedKey: row.seed_key,
      keywordCount: kws.length,
      contributorCount: contributors.length,
      contributorAsins: contributors,
      reuseCount: Math.max(0, contributors.length - 1), // first contributor = originator; rest reused
      competitorBrand: row.competitor_brand,
      competitorAsin: row.competitor_asin,
      sovPercentage: row.sov_percentage,
      seedSource: row.seed_source,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      fresh,
      daysLeft,
      topKeywords,
    }
  })

  const totalReuses = pools.reduce((s, p) => s + p.reuseCount, 0)
  const totals = {
    seeds: pools.length,
    freshSeeds: pools.filter((p) => p.fresh).length,
    listingsServed: pools.reduce((s, p) => s + p.contributorCount, 0),
    totalReuses,
    // ~estimate: each reuse skips the ~3-4 niche-research credits (Phases 2-4); Phase 4b's 1
    // per-ASIN rank credit is still spent. Conservative 3/reuse. Labeled "~" in the UI.
    estCreditsSaved: totalReuses * 3,
  }

  return NextResponse.json({ pools, totals }, { headers: NO_STORE })
}
