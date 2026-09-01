/**
 * GET /api/fba/admin/backfill-child-color            → DRY RUN: report how many listing_content
 *                                                      rows lack a stored catalog colour, and which
 *                                                      child ASINs a run would process.
 * GET /api/fba/admin/backfill-child-color?execute=1  → EXECUTE one batch (default 25, ?limit=N ≤ 50).
 * GET ...&parent_asin=B0XXXXXXXX                     → scope either mode to ONE family (10-char ASIN;
 *                                                      validated, 400 on a malformed value). Omitted =
 *                                                      today's catalog-wide behaviour, unchanged.
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
 * COUNTS (fixed 2026-09-01 — DEFECT: `remainingNull` wasn't the remaining count). The batch-select
 * below has no `.limit()`, so PostgREST applies its own default max-rows cap to it; the array it
 * produces is a CAPPED WINDOW, never a total. The old response reported `remainingNull` as
 * `uniqueAsins.length - filled.length` — arithmetic on that same capped window — so as low-ASIN rows
 * got filled, the window slid forward and pulled in rows previously beyond the cap, and two
 * consecutive real runs that each filled 49 children reported the "remaining" count dropping by only
 * 5 (812 -> 807). The backfill itself was always correct; only that number lied. `countNullChildren`
 * below replaces it with the TRUE outstanding state, queried fresh (in execute mode, AFTER the batch
 * is applied): `trueNullRows` from a `count:'exact', head:true` query (Postgres counts server-side —
 * no row cap applies to a head request), and `trueNullAsins` — the distinct-ASIN count, since
 * listing_content can hold more than one row per ASIN (see below) — from an explicit `.range()` page
 * loop that keeps paging until it has seen every row `trueNullRows` reported, so it is never subject
 * to the same silent cap that produced the original bug. The dry-run window fields are kept but
 * renamed (`windowNullAsins`/`windowNullRows`) so a reader can never mistake the window for a total.
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

const PAGE_SIZE = 1000
const ASIN_RE = /^[A-Z0-9]{10}$/

/** True if `candidate` (already trimmed/upper-cased by the caller) looks like an Amazon ASIN. */
export function isValidParentAsin(candidate: string): boolean {
  return ASIN_RE.test(candidate)
}

/**
 * TRUE outstanding null-colour counts for `listing_content`, optionally scoped to one
 * `parent_asin` family. See the file-header COUNTS note for why this exists and replaces the old
 * capped-window arithmetic. Never trusts an unbounded `.select()`: the row count comes from a
 * `count:'exact', head:true` query, and the distinct-ASIN count comes from an explicit `.range()`
 * page loop bounded by that same row count.
 */
export async function countNullChildren(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  parentAsin: string | null
): Promise<{ error: string | null; trueNullRows: number; trueNullAsins: number }> {
  let headQuery = db.from('listing_content').select('asin', { count: 'exact', head: true }).is('color', null)
  if (parentAsin) headQuery = headQuery.eq('parent_asin', parentAsin)
  const { count, error: countErr } = await headQuery
  if (countErr) return { error: countErr.message, trueNullRows: 0, trueNullAsins: 0 }
  const trueNullRows = count ?? 0

  const asinSet = new Set<string>()
  let offset = 0
  let fetchedRows = 0
  while (fetchedRows < trueNullRows) {
    let pageQuery = db.from('listing_content').select('asin').is('color', null)
    if (parentAsin) pageQuery = pageQuery.eq('parent_asin', parentAsin)
    const { data, error: pageErr } = await pageQuery.range(offset, offset + PAGE_SIZE - 1)
    if (pageErr) return { error: pageErr.message, trueNullRows: 0, trueNullAsins: 0 }
    const page = (data ?? []) as { asin: string }[]
    for (const r of page) if (r.asin) asinSet.add(r.asin)
    fetchedRows += page.length
    offset += PAGE_SIZE
    if (page.length === 0) break // defensive: never loop forever if a page comes back short of count
  }

  return { error: null, trueNullRows, trueNullAsins: asinSet.size }
}

export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams
  const execute = params.get('execute') === '1'
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '25', 10) || 25, 1), 50)

  const parentAsinRaw = params.get('parent_asin')
  let parentAsin: string | null = null
  if (parentAsinRaw) {
    const candidate = parentAsinRaw.trim().toUpperCase()
    if (!isValidParentAsin(candidate)) {
      return NextResponse.json(
        { error: `parent_asin must look like an ASIN (10 alphanumeric characters); got "${parentAsinRaw}"` },
        { status: 400 }
      )
    }
    parentAsin = candidate
  }
  const scope = parentAsin ?? 'all'

  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  let selectQuery = db
    .from('listing_content')
    .select('asin, parent_asin')
    .is('color', null)
    .order('asin', { ascending: true })
  if (parentAsin) selectQuery = selectQuery.eq('parent_asin', parentAsin)
  const { data: nullRows, error } = await selectQuery
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
    const counts = await countNullChildren(db, parentAsin)
    if (counts.error) return NextResponse.json({ error: counts.error }, { status: 500 })
    return NextResponse.json({
      mode: 'dry-run',
      scope,
      windowNullAsins: uniqueAsins.length, // distinct ASINs in THIS capped fetch window — NOT a total
      windowNullRows: rows.length, // rows in THIS capped fetch window — NOT a total
      trueNullRows: counts.trueNullRows, // real outstanding row count, uncapped
      trueNullAsins: counts.trueNullAsins, // real outstanding distinct-ASIN count, uncapped
      wouldProcess: batch.map((r) => r.asin),
      hint:
        counts.trueNullRows > 0
          ? `add ?execute=1 to run this batch of ${batch.length}; ${counts.trueNullAsins} distinct ASIN(s) / ${counts.trueNullRows} row(s) still lack a colour${parentAsin ? ` in ${parentAsin}` : ''}`
          : `no null rows found${parentAsin ? ` for ${parentAsin}` : ''}`,
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

  // TRUE outstanding state, queried fresh AFTER the batch above — never derived from the capped
  // window (see file-header COUNTS note).
  const counts = await countNullChildren(db, parentAsin)
  if (counts.error) return NextResponse.json({ error: counts.error }, { status: 500 })

  return NextResponse.json({
    mode: 'execute',
    scope,
    processed: batch.length,
    filled: filled.length,
    filledAsins: filled,
    noColorFound,
    failed,
    trueNullRows: counts.trueNullRows, // real outstanding row count AFTER this batch, uncapped
    trueNullAsins: counts.trueNullAsins, // real outstanding distinct-ASIN count AFTER this batch
    hint:
      counts.trueNullRows > 0
        ? 'call again with ?execute=1 for the next batch'
        : `done — every child ASIN${parentAsin ? ` in ${parentAsin}` : ''} has a catalog colour or is listed in noColorFound`,
  })
}
