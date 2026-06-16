/**
 * GET  /api/fba/listing-optimizer
 *   Returns the top 10 parent ASINs (by 30d sales) with overall_score < 100,
 *   plus their issues array and child content details.
 *
 * POST /api/fba/listing-optimizer
 *   Triggers a fresh syncListingContent run for the top 50 parents.
 *   Returns { status: 'syncing' } immediately; the sync runs in the background.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { syncListingContent, ensureListingScored } from '@/lib/sync/syncListingContent'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const supabase = await createAdminClient()

    // How many best-selling parents to return (PO: "display + optimize more than 10 top sellers").
    // Default 25; clamp 1..200. The card grid is ranked by 30d sales so the highest-impact
    // listings always lead — "Show more" just extends the same ranked list.
    const limitParam = Number(new URL(req.url).searchParams.get('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 200) : 25

    // Ranked by 30d sales. Fetch HEADROOM (2× the requested count) because some top rows are
    // GHOSTS — stale score rows whose children have moved/been removed (0 live children). Those
    // are filtered out below, then we slice to the requested count.
    const { data: scores, error: scoresErr } = await supabase
      .from('listing_seo_scores')
      .select('*')
      .lt('overall_score', 100)
      .order('total_units_30d', { ascending: false })
      .limit(Math.min(limit * 2, 400))

    if (scoresErr) {
      return NextResponse.json({ error: scoresErr.message }, { status: 500 })
    }

    if (!scores || scores.length === 0) {
      return NextResponse.json({ scores: [], lastSyncedAt: null })
    }

    // For each parent, fetch the child content breakdown
    const parentAsins = (scores as ScoreRow[]).map(s => s.parent_asin)

    const { data: childContent } = await supabase
      .from('listing_content')
      .select('sku, asin, parent_asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt, content_synced_at')
      .in('parent_asin', parentAsins)
      .order('sku', { ascending: true })

    // Group child content by parent_asin
    type ChildRow = {
      sku: string; asin: string; parent_asin: string; title: string | null
      bullet_1: string | null; bullet_2: string | null; bullet_3: string | null
      bullet_4: string | null; bullet_5: string | null
      description: string | null; backend_keywords: string | null; image_count: number
      has_aplus: boolean; aplus_module_count: number; aplus_has_brand_story: boolean
      aplus_has_headline: boolean; aplus_images_missing_alt: number; content_synced_at: string
    }
    const childMap: Record<string, ChildRow[]> = {}
    for (const row of (childContent || []) as ChildRow[]) {
      if (!childMap[row.parent_asin]) childMap[row.parent_asin] = []
      childMap[row.parent_asin]!.push(row)
    }

    // Get the most recent sync timestamp
    const { data: latestSyncRaw } = await supabase
      .from('listing_seo_scores')
      .select('scored_at')
      .order('scored_at', { ascending: false })
      .limit(1)
      .single()
    const latestSync = latestSyncRaw as { scored_at: string } | null

    type ScoreRow = {
      parent_asin: string; title_score: number; bullet_score: number; keyword_score: number
      aplus_score: number; overall_score: number; issues: unknown[]; child_count: number
      child_override_count: number; top_child_asin: string | null; product_title: string | null
      image_url: string | null; total_units_30d: number; scored_at: string
    }
    const result = (scores as ScoreRow[])
      .map(score => ({
        ...score,
        children: childMap[score.parent_asin] || [],
      }))
      // ── FOUNDATIONAL INVARIANT: a parent card requires >=1 LIVE child ──────────────
      // A "parent" with zero live children (no listing_content row points to it) is a GHOST:
      // an old/merged parent ASIN whose variations moved away, leaving a stale score row with
      // historical sales (e.g. B0F8WYNVPJ: child_count=3 but 0 live children, 965 stale units →
      // ranked #1 → rendered a card that dead-ends at /fba/listing/B0F8WYNVPJ). The live
      // `listing_content` join is the ground truth; the `child_count` column is stale and lies.
      // Excluding empty-children rows HERE — at the single source that feeds the card grid — is
      // the authoritative fix. It replaces the racy client-side hide/redirect heuristics (#89/#90)
      // that depended on a per-parent orphan-check which often hadn't resolved before the click.
      .filter(r => r.children.length > 0)
      .slice(0, limit)

    // ON-DEMAND SCORING: the optimizer only auto-scores the top-50-by-sales (syncListingContent), so a
    // low-traffic listing has no listing_seo_scores row and is absent here → its page reads "not
    // available". When the page asks for a specific asin (?ensure=), score it on the fly from existing
    // listing_content (DB only — no Amazon / Jungle Scout calls) so it renders + joins the grid.
    // Best-effort: a failure (or a never-synced listing with no children) just leaves it absent.
    const ensureAsin = new URL(req.url).searchParams.get('ensure')
    if (ensureAsin && !result.some(r => r.parent_asin === ensureAsin)) {
      try {
        const scored = await ensureListingScored(supabase, ensureAsin)
        if (scored) {
          const { data: sr } = await supabase
            .from('listing_seo_scores').select('*').eq('parent_asin', ensureAsin).single()
          const { data: ek } = await supabase
            .from('listing_content')
            .select('sku, asin, parent_asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt, content_synced_at')
            .eq('parent_asin', ensureAsin)
            .order('sku', { ascending: true })
          const ensuredKids = (ek || []) as ChildRow[]
          if (sr && ensuredKids.length > 0) result.unshift({ ...(sr as ScoreRow), children: ensuredKids })
        }
      } catch (e) { console.warn('[listing-optimizer] ensure-score failed:', e instanceof Error ? e.message : e) }
    }

    // hasMore: a full headroom fetch that still filled the requested count means there are
    // likely more sellers below — drives the dashboard's "Show more" affordance.
    const hasMore = (scores as ScoreRow[]).length >= Math.min(limit * 2, 400) && result.length >= limit

    return NextResponse.json({
      scores: result,
      lastSyncedAt: latestSync?.scored_at || null,
      hasMore,
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    // Kick off the sync in the background (don't await)
    // The sync can take several minutes due to Amazon API rate limits
    const syncPromise = syncListingContent(50)

    // We can't truly background in Next.js serverless, so we await but with a
    // generous timeout. For production, consider a cron job instead.
    const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), 25000))

    const result = await Promise.race([syncPromise, timeoutPromise])

    if (result === null) {
      // Timed out — sync is still running
      return NextResponse.json({
        status: 'syncing',
        message: 'Sync started — this may take 2-5 minutes due to Amazon API rate limits. Refresh in a few minutes.',
      })
    }

    return NextResponse.json({
      status: 'done',
      parentsSynced: result.parentsSynced,
      skusSynced:    result.skusSynced,
      parentsScored: result.parentsScored,
      durationMs:    result.durationMs,
      error:         result.error,
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
