/**
 * GET /api/fba/admin/backfill-images            → DRY RUN: report how many score rows lack an
 *                                                 image and which parents a run would process.
 * GET /api/fba/admin/backfill-images?execute=1  → EXECUTE one batch (default 25, ?limit=N ≤ 50).
 *
 * WHY (2026-08-18, PO chose "proactive backfill"): 77 of 80 apparel parents have
 * `listing_seo_scores.image_url` NULL, which starves the vision scanner (DB-only,
 * visionScanner.ts:150-175) and with it the whole design-identity pipeline. PR #574 heals
 * image_url on VIEW; this route heals the un-viewed remainder on demand.
 *
 * COST: SP-API Catalog Items only — rate-limited, NOT credit-metered. ZERO Jungle Scout
 * involvement by construction (nothing in this route touches keyword code). Filling image_url
 * does not itself trigger a vision scan (that runs inside a regen), and when vision later fills
 * for the first time, the fingerprint FIRST-POPULATION GUARD (ai-recommendations/route.ts, PR
 * #574) keeps that from forcing a billable Jungle Scout re-harvest.
 *
 * SHAPE: batched (default 25/call) so a run stays well under gateway timeouts — the 2026-08-09
 * incident ([[retry-guard-armed-by-completion]]) was an unbounded job on a request path; this
 * route is bounded, idempotent (selects only NULL rows), PO-triggered (never cron), and paced
 * (500ms between catalog calls). Rows whose catalog genuinely has no image stay NULL and are
 * listed in `noImageFound` rather than retried blindly.
 *
 * AUTH: gated by src/middleware.ts like every /api/fba route (cookie session / CRON_SECRET /
 * Bearer JWT). Trigger it from a logged-in browser tab.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { fetchCatalogImageUrl } from '@/lib/amazon/catalogImage'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams
  const execute = params.get('execute') === '1'
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '25', 10) || 25, 1), 50)

  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  const { data: nullRows, error } = await db
    .from('listing_seo_scores')
    .select('parent_asin, top_child_asin')
    .is('image_url', null)
    .order('parent_asin', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (nullRows ?? []) as { parent_asin: string; top_child_asin: string | null }[]
  const batch = rows.slice(0, limit)

  if (!execute) {
    return NextResponse.json({
      mode: 'dry-run',
      totalNull: rows.length,
      wouldProcess: batch.map((r) => r.parent_asin),
      hint: `add ?execute=1 to run this batch of ${batch.length}; repeat until totalNull reaches 0`,
    })
  }

  const token = await getAccessToken()
  const filled: string[] = []
  const noImageFound: string[] = []
  const failed: string[] = []

  for (const row of batch) {
    try {
      // Same lookup order the listing page uses (page.tsx:836): best-seller child first — child
      // ASINs are the buyable items and reliably carry images — then the parent as fallback.
      const link =
        (row.top_child_asin ? await fetchCatalogImageUrl(row.top_child_asin, token) : null) ??
        (await fetchCatalogImageUrl(row.parent_asin, token))
      if (link) {
        const { error: upErr } = await db
          .from('listing_seo_scores')
          .update({ image_url: link })
          .eq('parent_asin', row.parent_asin)
          .is('image_url', null)
        if (upErr) failed.push(row.parent_asin)
        else filled.push(row.parent_asin)
      } else {
        noImageFound.push(row.parent_asin)
      }
    } catch {
      failed.push(row.parent_asin)
    }
    await sleep(500)
  }

  return NextResponse.json({
    mode: 'execute',
    processed: batch.length,
    filled: filled.length,
    filledAsins: filled,
    noImageFound,
    failed,
    remainingNull: rows.length - filled.length,
    hint: rows.length - filled.length > 0 ? 'call again with ?execute=1 for the next batch' : 'done — all rows have an image or are listed in noImageFound',
  })
}
