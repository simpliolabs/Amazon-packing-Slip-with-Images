/**
 * GET /api/fba/admin/backfill-child-color            → DRY RUN: report how many listing_content
 *                                                      rows lack a stored catalog colour, and which
 *                                                      child ASINs a run would process.
 * GET /api/fba/admin/backfill-child-color?execute=1  → EXECUTE one batch (default 25, ?limit=N ≤ 50).
 *
 * WHY (2026-08-28, migration 072, PO RULING — family B0DP5H8QBT, 12 children, live). decodeSkuColor
 * (skuColorCodes.ts) derives a child's colour by parsing SKU/title TEXT; on Amazon-generated opaque
 * SKUs (1V-C6WM-US5T, 3A-MINF-4TRD, 4K-WJVI-T618, 5M-0T69-IFXD) no segment is ever a colour code, so
 * every fallback returns null, all children collapse to ONE backend-keywords string, and the degrade
 * gate (listingPipeline.ts's backendOutputProblems) freezes that family's backend forever — the
 * failure is deterministic on the SKU shape, not transient, so the gate's "try again in a minute"
 * banner never resolves itself. resolveChildColor (childColorResolver.ts) now reads a STORED
 * catalog colour FIRST and falls back to decodeSkuColor only when nothing is stored; this route is
 * the one-time (+ resumable) pass that populates that stored value from Amazon's own Catalog Items
 * API (ItemSummaryByMarketplace.color, via src/lib/amazon/catalogColor.ts) for every child ASIN
 * that doesn't have one yet.
 *
 * READ-ONLY AGAINST AMAZON. fetchCatalogColor only ever calls getCatalogItem — no PATCH/PUT/POST,
 * ever, anywhere in this route or the module it calls. Rate-limited via spApiCatalogReadBucket
 * (2 rps / burst 2 — getCatalogItem's own SP-API usage plan; the bucket is acquired INSIDE
 * fetchCatalogColor, so no extra external pacing is needed here).
 *
 * SHAPE: batched (default 25/call, same discipline as backfill-images/backfill-title-truth),
 * dry-run by default, PO-triggered (never cron), idempotent (`.is('color', null)` guard on both
 * the select and the update — a re-run after a partial run or crash is always safe and never
 * clobbers a value a concurrent/prior run already stamped). A child whose catalog genuinely has no
 * stored colour stays NULL and is listed in `noColorFound` rather than retried blindly forever.
 *
 * listing_content carries BOTH an FBA and an FBM row per child ASIN (dual-SKU doctrine — see
 * ai-recommendations/route.ts's dedup-by-ASIN comment); this route dedupes to ONE Catalog Items
 * call per ASIN and the UPDATE (keyed on `asin`, not `sku`) fixes both rows in one statement.
 *
 * AUTH: gated by src/middleware.ts like every /api/fba route (cookie session / CRON_SECRET /
 * Bearer JWT). Trigger it from a logged-in browser tab.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { fetchCatalogColor } from '@/lib/amazon/catalogColor'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams
  const execute = params.get('execute') === '1'
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '25', 10) || 25, 1), 50)

  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  const { data: nullRows, error } = await db
    .from('listing_content')
    .select('asin, parent_asin')
    .is('color', null)
    .order('asin', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (nullRows ?? []) as { asin: string; parent_asin: string | null }[]
  const seen = new Set<string>()
  const uniqueAsins = rows.filter((r) => {
    if (!r.asin || seen.has(r.asin)) return false
    seen.add(r.asin)
    return true
  })
  const batch = uniqueAsins.slice(0, limit)

  if (!execute) {
    return NextResponse.json({
      mode: 'dry-run',
      totalNull: uniqueAsins.length,
      totalNullRows: rows.length,
      wouldProcess: batch.map((r) => r.asin),
      hint: `add ?execute=1 to run this batch of ${batch.length}; repeat until totalNull reaches 0`,
    })
  }

  const token = await getAccessToken()
  const filled: string[] = []
  const noColorFound: string[] = []
  const failed: string[] = []

  for (const row of batch) {
    try {
      const color = await fetchCatalogColor(row.asin, token)
      if (color) {
        const { error: upErr } = await db
          .from('listing_content')
          .update({ color })
          .eq('asin', row.asin)
          .is('color', null) // idempotency guard: never clobber a value a concurrent run already stamped
        if (upErr) failed.push(row.asin)
        else filled.push(row.asin)
      } else {
        noColorFound.push(row.asin)
      }
    } catch {
      failed.push(row.asin)
    }
  }

  return NextResponse.json({
    mode: 'execute',
    processed: batch.length,
    filled: filled.length,
    filledAsins: filled,
    noColorFound,
    failed,
    remainingNull: uniqueAsins.length - filled.length,
    hint: uniqueAsins.length - filled.length > 0
      ? 'call again with ?execute=1 for the next batch'
      : 'done — every child ASIN has a catalog colour or is listed in noColorFound',
  })
}
