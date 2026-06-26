/**
 * GET  /api/fba/listing-optimizer  — Phase A unified work-queue (spec §5 Phase A)
 *   Returns score rows for the work-queue tabs, ranked by 30d sales (or recency), with:
 *     ?status=   needs_work | optimized | in_progress | needs_attention | all   (default: all)
 *     ?search=   ASIN exact OR product_title/title ILIKE (trigram); unscored title matches
 *                come back as lightweight {asin,title,stub:true} — NEVER synchronously scored.
 *     ?sort=     sales (default, total_units_30d DESC) | recent (created_at DESC)
 *     ?cursor=   opaque keyset cursor on the STABLE tuple (sort-key DESC, parent_asin ASC).
 *     ?limit=    page size, default 25, clamp 1..200.
 *     ?ensure=   (unchanged) on-demand-score ONE asin from existing listing_content.
 *   THRESHOLD is 90 (was a hard <100): >=90 == optimized, <90 == needs_work.
 *   Response: { scores, counts, nextCursor, hasMore, stubs?, lastSyncedAt }.
 *
 * POST /api/fba/listing-optimizer
 *   Triggers a fresh syncListingContent run for the top 50 parents.
 *   Returns { status: 'syncing' } immediately; the sync runs in the background.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { syncListingContent, ensureListingScored } from '@/lib/sync/syncListingContent'
import { isClaimStale, type ClaimRow } from '@/lib/fba/claims'

// ── Shared shapes ───────────────────────────────────────────────────────────────────────

type ScoreRow = {
  parent_asin: string; title_score: number; bullet_score: number; keyword_score: number
  aplus_score: number; overall_score: number; issues: unknown[]; child_count: number
  child_override_count: number; top_child_asin: string | null; product_title: string | null
  image_url: string | null; total_units_30d: number; scored_at: string; created_at: string | null
}

type ChildRow = {
  sku: string; asin: string; parent_asin: string | null; title: string | null
  bullet_1: string | null; bullet_2: string | null; bullet_3: string | null
  bullet_4: string | null; bullet_5: string | null
  description: string | null; backend_keywords: string | null; image_count: number
  has_aplus: boolean; aplus_module_count: number; aplus_has_brand_story: boolean
  aplus_has_headline: boolean; aplus_images_missing_alt: number; content_synced_at: string
}

const CHILD_COLS =
  'sku, asin, parent_asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt, content_synced_at'

// Phase B collaboration chips attached per card by enrichWithCollab() (spec §5 Phase B):
//   claim         — { claimed_by_name, claimed_at, stale } when an ACTIVE (non-released) claim row
//                   exists; null otherwise. `stale` is computed at READ time (now()-last_heartbeat
//                   > CLAIM_TTL) so a dead tab never shows as "held" (Watchdog-on-READ).
//   last_touched  — newest listing_change_log row for the parent, surfaced as
//                   { changed_by_name, changed_at, action } for the "last touched by NAME" chip.
type ClaimChip = { claimed_by_name: string | null; claimed_at: string | null; stale: boolean } | null
type LastTouched = { changed_by_name: string | null; changed_at: string; action: string | null } | null

// Phase A "Optimized" threshold. Spec §5: >=90 is READY/PUSHED/MEASURING (never "Done"); <90 is
// Needs Work. Replaces the legacy hard `.lt('overall_score', 100)`.
const OPTIMIZED_THRESHOLD = 90

type StatusFilter = 'needs_work' | 'optimized' | 'in_progress' | 'needs_attention' | 'all'
type SortKey = 'sales' | 'recent'

// ── Keyset cursor on the STABLE tuple (sort-key DESC, parent_asin ASC) (Risk R-MIG3) ─────
// Never units/created_at alone — many 0-sales ties. parent_asin (PK of both listing_seo_scores
// and parent_asin_rollup) is the stable tiebreaker so paging never skips/repeats a row.
type Cursor = { v: number | string | null; pa: string }

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url')
}
function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (c && typeof c.pa === 'string') return c as Cursor
  } catch { /* malformed cursor → treat as no cursor */ }
  return null
}

// ── Status → DB predicate over overall_score. in_progress is EMPTY in Phase A (Risk R-UX3):
// claims don't exist yet, and the recommendations-row proxy falsely marks "ever audited" as
// "someone is on it now" — so we ship In Progress as an explicitly-empty tab until Phase B.
function applyStatusFilter<T extends { lt: Function; gte: Function }>(q: T, status: StatusFilter): T {
  if (status === 'needs_work')      return q.lt('overall_score', OPTIMIZED_THRESHOLD)
  if (status === 'optimized')       return q.gte('overall_score', OPTIMIZED_THRESHOLD)
  // needs_attention: coarse ghost/stale bucket in Phase A. The rich verdicts (regressed /
  // non_copy_bottleneck / drift) arrive with the outcome ledger in Phase C; here we just keep
  // the tab in the universe (no extra score predicate) and let the ghost filter + counts shape it.
  return q // 'all' and 'needs_attention' → no overall_score predicate
}

// Assemble a batch of score rows into work-queue cards: attach live children (widened for
// standalones — parent_asin=id OR asin=id), the latest push timestamp (measuring chip), drop
// GHOSTS (0 live children), and dedup across batches via `seenPa`. Called PER BATCH by the keyset
// loop so the ghost filter can never silently shrink a page below `limit` (Risk R-MIG3).
async function assembleSurvivors(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  scoredRows: ScoreRow[],
  seenPa: Set<string>,
): Promise<(ScoreRow & { children: ChildRow[]; last_pushed_at: string | null })[]> {
  const ids = scoredRows.map((s) => s.parent_asin)
  if (ids.length === 0) return []

  // Child join (Risk R5/R-MIG2: standalone reach). We do NOT mutate listing_content.parent_asin
  // (syncParentAsins reconciles it back to NULL).
  const childMap: Record<string, ChildRow[]> = {}
  const orFilter = ids.map((id) => `parent_asin.eq.${id},asin.eq.${id}`).join(',')
  const { data: childContent } = await supabase
    .from('listing_content').select(CHILD_COLS).or(orFilter).order('sku', { ascending: true })
  const idSet = new Set(ids)
  for (const row of (childContent || []) as ChildRow[]) {
    const key = (row.parent_asin && idSet.has(row.parent_asin)) ? row.parent_asin
              : (idSet.has(row.asin) ? row.asin : null)
    if (!key) continue
    if (!childMap[key]) childMap[key] = []
    childMap[key]!.push(row)
  }

  // Measuring chip source (Risk R8): latest keyword_push_log.pushed_at per parent.
  const lastPushedMap: Record<string, string> = {}
  const { data: pushRows } = await supabase
    .from('keyword_push_log').select('parent_asin, pushed_at')
    .in('parent_asin', ids).order('pushed_at', { ascending: false })
  for (const row of (pushRows || []) as { parent_asin: string; pushed_at: string }[]) {
    if (!lastPushedMap[row.parent_asin]) lastPushedMap[row.parent_asin] = row.pushed_at // first = latest (DESC)
  }

  // Ghost filter (>=1 live child = FOUNDATIONAL INVARIANT; child_count lies) + cross-batch dedup.
  const out: (ScoreRow & { children: ChildRow[]; last_pushed_at: string | null })[] = []
  for (const score of scoredRows) {
    if (seenPa.has(score.parent_asin)) continue
    const children = childMap[score.parent_asin] || []
    if (children.length === 0) continue
    seenPa.add(score.parent_asin)
    out.push({ ...score, children, last_pushed_at: lastPushedMap[score.parent_asin] || null })
  }
  return out
}

// ── Phase B collaboration enrichment (spec §5 Phase B) ────────────────────────────────────────
// ONE batched lookup of listing_claims + the latest listing_change_log per parent for the rows on
// THIS page → attaches { claim, last_touched } to each. Two `.in()` queries, no per-card fetch, so
// it adds a fixed couple of round-trips regardless of page size. Does NOT touch any Phase A field.
// Mutates rows in place (cheap) and returns the same array typed with the new fields.
async function enrichWithCollab<T extends { parent_asin: string }>(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  rows: T[],
): Promise<(T & { claim: ClaimChip; last_touched: LastTouched })[]> {
  const out = rows as (T & { claim: ClaimChip; last_touched: LastTouched })[]
  if (rows.length === 0) return out
  const ids = rows.map((r) => r.parent_asin)

  // Active claims (not released) for the page. Stale is derived at read time via isClaimStale().
  const claimByParent: Record<string, ClaimRow> = {}
  const { data: claims } = await supabase
    .from('listing_claims')
    .select('parent_asin, claimed_by, claimed_by_name, claimed_at, last_heartbeat, released_at, release_reason, intent')
    .in('parent_asin', ids)
    .is('released_at', null)
  for (const c of (claims || []) as ClaimRow[]) claimByParent[c.parent_asin] = c

  // Latest change-log row per parent. PostgREST has no per-group LIMIT, so we pull the recent
  // window for these parents (ordered DESC) and keep the FIRST seen per parent = the newest.
  // Bounded so the scan never grows unbounded with the change-log table; the DESC window covers
  // recently-active parents (a parent whose last activity is older than the window just shows no
  // chip — acceptable degradation for an informational "last touched" label).
  const lastTouchedByParent: Record<string, LastTouched> = {}
  const { data: log } = await supabase
    .from('listing_change_log')
    .select('parent_asin, changed_by_name, changed_at, action')
    .in('parent_asin', ids)
    .order('changed_at', { ascending: false })
    .limit(1000)
  for (const r of (log || []) as { parent_asin: string; changed_by_name: string | null; changed_at: string; action: string | null }[]) {
    if (lastTouchedByParent[r.parent_asin]) continue // first = newest (DESC)
    lastTouchedByParent[r.parent_asin] = { changed_by_name: r.changed_by_name, changed_at: r.changed_at, action: r.action }
  }

  const now = Date.now()
  for (const row of out) {
    const c = claimByParent[row.parent_asin]
    row.claim = c
      ? { claimed_by_name: c.claimed_by_name, claimed_at: c.claimed_at, stale: isClaimStale(c, now) }
      : null
    row.last_touched = lastTouchedByParent[row.parent_asin] ?? null
  }
  return out
}

// ── In Progress tab: ACTIVE (non-stale) CLAIMS → cards (Phase B) ───────────────────────────
// Starts from the (tiny) set of un-released claim rows, drops stale ones at READ time
// (Watchdog-on-READ), then reuses assembleSurvivors (ghost filter + children) and
// enrichWithCollab (so the card carries its own claim/last_touched chip like every other tab).
async function fetchClaimedCards(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  search: string,
): Promise<(ScoreRow & { children: ChildRow[]; last_pushed_at: string | null; claim: ClaimChip; last_touched: LastTouched })[]> {
  // Live (un-released) claims; staleness filtered in JS so the rule matches isClaimStale() exactly.
  const { data: claimRows } = await supabase
    .from('listing_claims')
    .select('parent_asin, claimed_by, claimed_by_name, claimed_at, last_heartbeat, released_at, release_reason, intent')
    .is('released_at', null)
    .order('claimed_at', { ascending: false })
  const now = Date.now()
  const liveParents = ((claimRows || []) as ClaimRow[])
    .filter((c) => !isClaimStale(c, now))
    .map((c) => c.parent_asin)
  if (liveParents.length === 0) return []

  // Score rows for the claimed parents (chunk the .in() to keep it bounded).
  const scoreRows: ScoreRow[] = []
  const CHUNK = 100
  for (let i = 0; i < liveParents.length; i += CHUNK) {
    const slice = liveParents.slice(i, i + CHUNK)
    const { data } = await supabase.from('listing_seo_scores').select('*').in('parent_asin', slice)
    scoreRows.push(...((data || []) as ScoreRow[]))
  }

  // Optional search narrowing (ASIN exact or product_title contains) — mirror the other branches.
  let filtered = scoreRows
  if (search) {
    const isAsin = /^B0[A-Z0-9]{8}$/i.test(search)
    const q = search.toLowerCase()
    filtered = scoreRows.filter((s) =>
      isAsin
        ? s.parent_asin === search || s.top_child_asin === search
        : (s.product_title || '').toLowerCase().includes(q),
    )
  }

  const survivors = await assembleSurvivors(supabase, filtered, new Set())
  return enrichWithCollab(supabase, survivors)
}

// ── GET ───────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const supabase = await createAdminClient()
    const url = new URL(req.url)
    const params = url.searchParams

    const limitParam = Number(params.get('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 200) : 25

    const status = ((): StatusFilter => {
      const s = (params.get('status') || 'all').toLowerCase()
      return (['needs_work', 'optimized', 'in_progress', 'needs_attention', 'all'] as const).includes(s as StatusFilter)
        ? (s as StatusFilter)
        : 'all'
    })()

    const sort: SortKey = params.get('sort') === 'recent' ? 'recent' : 'sales'
    const search = (params.get('search') || '').trim()
    const cursor = decodeCursor(params.get('cursor'))
    const ensureAsin = params.get('ensure')

    // ── in_progress: CLAIMED listings (Phase B). Phase A shipped this tab empty (Risk R-UX3) ──
    // because no real soft-lock existed yet; now it lists the parents with an ACTIVE, non-stale
    // claim. We start from the live claim rows (a tiny set — at most one per person on the team),
    // fetch their score rows, run them through the SAME ghost filter + collab enrichment as the
    // normal branch, then keep only the ones whose claim is still live at READ time (Watchdog-on-
    // READ: a dead tab's stale claim must NOT keep a listing pinned to In Progress).
    if (status === 'in_progress') {
      const counts = await computeCounts(supabase, search)
      const latestSync = await fetchLastSyncedAt(supabase)
      const inProgress = await fetchClaimedCards(supabase, search)
      return NextResponse.json({
        scores: inProgress,
        counts,
        nextCursor: null,
        hasMore: false,
        lastSyncedAt: latestSync,
      })
    }

    // ── SEARCH branch: ASIN exact OR title ILIKE (trigram). ───────────────────────────────
    // Scored matches render full cards (with children); UNSCORED title matches come back as
    // lightweight stubs from listing_content — never synchronously scored (Risk R-UX6).
    let scoredRows: ScoreRow[] = []
    let stubs: { asin: string; title: string | null; stub: true }[] | undefined
    let pageRows: (ScoreRow & { children: ChildRow[]; last_pushed_at: string | null })[] = []
    let nextCursor: string | null = null

    if (search) {
      const isAsin = /^B0[A-Z0-9]{8}$/i.test(search)
      const like = `%${search}%`

      // Scored matches: ASIN exact (parent_asin OR top_child_asin) OR product_title ILIKE.
      let sQ = supabase.from('listing_seo_scores').select('*')
      sQ = applyStatusFilter(sQ as never, status) as typeof sQ
      if (isAsin) {
        sQ = sQ.or(`parent_asin.eq.${search},top_child_asin.eq.${search}`)
      } else {
        sQ = sQ.ilike('product_title', like)
      }
      const { data: sData, error: sErr } = await sQ
        .order('total_units_30d', { ascending: false })
        .order('parent_asin', { ascending: true })
        .limit(limit)
      if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
      scoredRows = (sData || []) as ScoreRow[]

      // Unscored title/ASIN matches in listing_content that have NO score row yet → stubs.
      const scoredKeys = new Set(scoredRows.map(r => r.parent_asin))
      let cQ = supabase.from('listing_content').select('asin, parent_asin, title')
      if (isAsin) {
        cQ = cQ.or(`asin.eq.${search},parent_asin.eq.${search}`)
      } else {
        cQ = cQ.ilike('title', like)
      }
      const { data: cData } = await cQ.limit(limit * 4)
      const stubSeen = new Set<string>()
      stubs = []
      for (const row of (cData || []) as { asin: string; parent_asin: string | null; title: string | null }[]) {
        const key = row.parent_asin || row.asin // self-parent for standalones
        if (scoredKeys.has(key) || stubSeen.has(row.asin)) continue
        stubSeen.add(row.asin)
        stubs.push({ asin: row.asin, title: row.title, stub: true })
        if (stubs.length >= limit) break
      }
      pageRows = await assembleSurvivors(supabase, scoredRows, new Set())
    } else {
      // ── NORMAL paged branch: BOUNDED KEYSET LOOP. The ghost filter drops 0-live-child rows, and
      // this data is ghost-heavy, so a single fixed over-fetch (the old limit+1) would shrink the
      // page below `limit` and kill "Show next", hiding everything beyond it (Risk R-MIG3). Instead
      // keep paging the stable (sort-key DESC, parent_asin ASC) tuple, accumulating POST-ghost-filter
      // survivors until we have > limit (or the table is exhausted / a safety cap is hit).
      const seenPa = new Set<string>()
      const survivors: (ScoreRow & { children: ChildRow[]; last_pushed_at: string | null })[] = []
      const PAGE = Math.max(limit + 1, 50)        // raw rows per DB round-trip
      const MAX_FETCH = Math.max(limit * 20, 600) // safety cap vs a pathologically ghost-heavy tail
      let rawCursor: Cursor | null = cursor
      let exhausted = false
      let fetched = 0
      while (survivors.length <= limit && !exhausted && fetched < MAX_FETCH) {
        let q = supabase.from('listing_seo_scores').select('*')
        q = applyStatusFilter(q as never, status) as typeof q
        if (sort === 'recent') {
          q = q.order('created_at', { ascending: false }).order('parent_asin', { ascending: true })
          if (rawCursor) {
            const cv = rawCursor.v ?? ''
            q = q.or(`created_at.lt.${cv},and(created_at.eq.${cv},parent_asin.gt.${rawCursor.pa})`)
          }
        } else {
          q = q.order('total_units_30d', { ascending: false }).order('parent_asin', { ascending: true })
          if (rawCursor) {
            const cv = Number(rawCursor.v ?? 0)
            q = q.or(`total_units_30d.lt.${cv},and(total_units_30d.eq.${cv},parent_asin.gt.${rawCursor.pa})`)
          }
        }
        const { data: sData, error: sErr } = await q.limit(PAGE)
        if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 })
        const batch = (sData || []) as ScoreRow[]
        fetched += batch.length
        if (batch.length < PAGE) exhausted = true
        if (batch.length === 0) break
        // Advance the DB cursor on the LAST RAW row's tuple (NOT the last survivor) so the next
        // iteration continues past every row we already scanned, ghosts included — no re-scan, no skip.
        const lastRaw = batch[batch.length - 1]
        rawCursor = { v: sort === 'recent' ? (lastRaw.created_at ?? '') : (lastRaw.total_units_30d ?? 0), pa: lastRaw.parent_asin }
        survivors.push(...await assembleSurvivors(supabase, batch, seenPa))
      }
      pageRows = survivors.slice(0, limit)
      if (survivors.length > limit) {
        const last = pageRows[pageRows.length - 1]
        nextCursor = encodeCursor({ v: sort === 'recent' ? (last.created_at ?? null) : (last.total_units_30d ?? 0), pa: last.parent_asin })
      } else if (!exhausted) {
        // Stopped at the MAX_FETCH safety cap (not the table end) — keep paging from the raw scan
        // position so deep survivors past a ghost-heavy stretch stay reachable.
        nextCursor = rawCursor ? encodeCursor(rawCursor) : null
      }
    }

    // ── Counts + hasMore AFTER the ghost filter (Risk R-MIG3) ─────────────────────────────
    const counts = await computeCounts(supabase, search)
    const hasMore = search ? false : nextCursor !== null

    // ── ?ensure= (PRESERVED): on-demand score ONE asin, widened for standalones ───────────
    // Synchronous scoring stays ONLY here (never on ?search=). Widened (parent_asin=id OR asin=id)
    // so a standalone's children attach and it survives the ghost filter (Risk R5/R-MIG2).
    if (ensureAsin && !pageRows.some(r => r.parent_asin === ensureAsin)) {
      try {
        const scored = await ensureListingScored(supabase, ensureAsin)
        if (scored) {
          const { data: sr } = await supabase
            .from('listing_seo_scores').select('*').eq('parent_asin', ensureAsin).single()
          const { data: ek } = await supabase
            .from('listing_content')
            .select(CHILD_COLS)
            .or(`parent_asin.eq.${ensureAsin},asin.eq.${ensureAsin}`)
            .order('sku', { ascending: true })
          const ensuredKids = (ek || []) as ChildRow[]
          if (sr && ensuredKids.length > 0) {
            const { data: epRows } = await supabase
              .from('keyword_push_log')
              .select('pushed_at')
              .eq('parent_asin', ensureAsin)
              .order('pushed_at', { ascending: false })
              .limit(1)
            const lastPushed = ((epRows || []) as { pushed_at: string }[])[0]?.pushed_at || null
            pageRows.unshift({ ...(sr as ScoreRow), children: ensuredKids, last_pushed_at: lastPushed })
          }
        }
      } catch (e) { console.warn('[listing-optimizer] ensure-score failed:', e instanceof Error ? e.message : e) }
    }

    const latestSync = await fetchLastSyncedAt(supabase)

    // Phase B: attach { claim, last_touched } chips to the final page (after ?ensure= may have
    // unshifted a row). One batched pair of lookups; Phase A fields are untouched.
    const enrichedRows = await enrichWithCollab(supabase, pageRows)

    return NextResponse.json({
      scores: enrichedRows,
      counts,
      nextCursor,
      hasMore,
      lastSyncedAt: latestSync,
      ...(stubs ? { stubs } : {}),
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ── Counts: per-tab badges, computed POST-ghost-filter (Risk R-MIG3) ──────────────────────
// The ghost filter requires a live-child join, which COUNT(*) can't express in one PostgREST
// call. We fetch the lightweight (parent_asin, overall_score) universe + the set of parent_asins
// that have >=1 live child (from listing_content's distinct parent/asin ids), intersect, then
// bucket — so every count reflects exactly what the card grid can reach. Bounded columns only.
async function computeCounts(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  search: string,
): Promise<{ needs_work: number; optimized: number; in_progress: number; needs_attention: number; all: number }> {
  // Lightweight score universe (id + score + push presence proxy via product_title not needed here).
  let baseQ = supabase.from('listing_seo_scores').select('parent_asin, overall_score, total_units_30d')
  if (search) {
    const isAsin = /^B0[A-Z0-9]{8}$/i.test(search)
    baseQ = isAsin
      ? baseQ.or(`parent_asin.eq.${search},top_child_asin.eq.${search}`)
      : baseQ.ilike('product_title', `%${search}%`)
  }
  const { data: scoreUniverse } = await baseQ
  const rows = (scoreUniverse || []) as { parent_asin: string; overall_score: number }[]
  if (rows.length === 0) {
    return { needs_work: 0, optimized: 0, in_progress: 0, needs_attention: 0, all: 0 }
  }

  // Which of those parents have >=1 live child? (ghost filter, applied to the count universe).
  const ids = rows.map(r => r.parent_asin)
  const liveParents = new Set<string>()
  // Chunk the OR filter to keep the URL bounded.
  const CHUNK = 100
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const orFilter = slice.map(id => `parent_asin.eq.${id},asin.eq.${id}`).join(',')
    const { data: kids } = await supabase
      .from('listing_content')
      .select('parent_asin, asin')
      .or(orFilter)
    const sliceSet = new Set(slice)
    for (const k of (kids || []) as { parent_asin: string | null; asin: string }[]) {
      if (k.parent_asin && sliceSet.has(k.parent_asin)) liveParents.add(k.parent_asin)
      else if (sliceSet.has(k.asin)) liveParents.add(k.asin)
    }
  }

  const live = rows.filter(r => liveParents.has(r.parent_asin))
  const needs_work = live.filter(r => r.overall_score < OPTIMIZED_THRESHOLD).length
  const optimized  = live.filter(r => r.overall_score >= OPTIMIZED_THRESHOLD).length

  // in_progress (Phase B): parents with an ACTIVE, non-stale claim that also survive the ghost
  // filter (>=1 live child). Read-time staleness uses isClaimStale() so this count agrees with the
  // In Progress tab AND with the per-card chip. needs_attention is the coarse ghost/stale bucket —
  // in Phase A we have no per-row verdict, so it surfaces the full live set as candidates (the rich
  // client orphan-check still narrows it on the card). all = live total.
  const liveSet = new Set(live.map(r => r.parent_asin))
  const { data: claimRows } = await supabase
    .from('listing_claims')
    .select('parent_asin, claimed_by, last_heartbeat, released_at')
    .is('released_at', null)
  const now = Date.now()
  const in_progress = ((claimRows || []) as Pick<ClaimRow, 'parent_asin' | 'claimed_by' | 'last_heartbeat' | 'released_at'>[])
    .filter(c => !isClaimStale(c, now) && liveSet.has(c.parent_asin))
    .length

  return {
    needs_work,
    optimized,
    in_progress,
    needs_attention: live.length,
    all: live.length,
  }
}

async function fetchLastSyncedAt(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
): Promise<string | null> {
  const { data } = await supabase
    .from('listing_seo_scores')
    .select('scored_at')
    .order('scored_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { scored_at: string } | null)?.scored_at || null
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
