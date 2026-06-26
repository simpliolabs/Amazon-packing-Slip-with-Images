/**
 * GET /api/fba/listing-optimizer/change-log?parent_asin=B0XXXXXXXX
 *   Returns the MERGED, human-readable change-history for one parent listing (spec §4-C / §5
 *   Phase B + Risk R-UX7), newest first. It UNIONS three sources into ONE time-sorted timeline:
 *     1. listing_change_log  — the product-facing feed (edits, AI generate/regenerate, push,
 *                              claim/release/takeover).
 *     2. audit_logs          — the NARROW compliance subset for this listing
 *                              (listing.push / listing.takeover), so the override + write-to-Amazon
 *                              events show with their compliance framing.
 *     3. listing_score_history — score deltas (Phase C table). Queried best-effort: if the table
 *                              does not exist yet (Phase C not shipped) the query errors and we
 *                              simply SKIP it (spec item 3: "from listing_score_history if present,
 *                              else skip"). No 500.
 *
 *   Each merged row is { id, ts, actor, action, summary, source, kind, field?, parent_asin },
 *   where `summary` is a plain-English sentence so the panel reads as sentences, not enum tokens.
 *   `kind` ∈ change_log | audit | score lets the client tint each row by origin. De-duplicated:
 *   a push that exists in BOTH listing_change_log and audit_logs is shown once (change_log wins).
 *
 *   Response: { entries: MergedRow[] }
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

// Plain-English verb per change_log action — the timeline reads as sentences, not enum tokens.
const ACTION_VERB: Record<string, string> = {
  edit:          'edited',
  ai_generate:   'ran an AI audit on',
  ai_regenerate: 'regenerated',
  push:          'pushed to Amazon',
  claim:         'claimed',
  release:       'released',
  takeover:      'took over',
}

// Friendly field labels so "backend_keywords" reads as "backend keywords", etc.
const FIELD_LABEL: Record<string, string> = {
  title: 'the title',
  bullet_1: 'bullet 1', bullet_2: 'bullet 2', bullet_3: 'bullet 3',
  bullet_4: 'bullet 4', bullet_5: 'bullet 5',
  bullets: 'the bullets',
  description: 'the description',
  backend_keywords: 'the backend keywords',
  keywords: 'the keywords',
}
function fieldPhrase(field: string | null): string {
  if (!field) return ''
  if (FIELD_LABEL[field]) return ` ${FIELD_LABEL[field]}`
  if (field.startsWith('from:')) return '' // takeover marker, handled in summary
  return ` ${field.replace(/_/g, ' ')}`
}

type ChangeRow = {
  id: number
  parent_asin: string
  sku: string | null
  field: string | null
  action: string | null
  before_value: string | null
  after_value: string | null
  changed_by: string | null
  changed_by_name: string | null
  changed_at: string
  source: string | null
  submission_id: string | null
}

type AuditRow = {
  id: string
  user_id: string | null
  action: string
  resource_type: string
  resource_id: string | null
  details: Record<string, unknown> | null
  created_at: string
}

type ScoreHistRow = {
  id: number
  overall_score: number | null
  lifecycle_state: string | null
  trigger: string | null
  scored_by_name: string | null
  scored_at: string
}

// One row of the merged, human-readable timeline.
type MergedRow = {
  id: string
  ts: string
  actor: string | null
  action: string | null
  summary: string
  source: string | null
  kind: 'change_log' | 'audit' | 'score'
  field?: string | null
  parent_asin: string
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const parentAsin = (searchParams.get('parent_asin') || '').trim()
  if (!parentAsin) {
    return NextResponse.json({ error: 'parent_asin query param required' }, { status: 400 })
  }

  const limitParam = Number(searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 500) : 150

  const db = admin()

  // ── 1. listing_change_log (product-facing feed) ───────────────────────────────────────────
  const { data: clData, error: clErr } = await db
    .from('listing_change_log')
    .select('id, parent_asin, sku, field, action, before_value, after_value, changed_by, changed_by_name, changed_at, source, submission_id')
    .eq('parent_asin', parentAsin)
    .order('changed_at', { ascending: false })
    .limit(limit)
  if (clErr) {
    console.error('[change-log GET] change_log', clErr)
    return NextResponse.json({ error: clErr.message }, { status: 500 })
  }
  const changeRows = (clData || []) as ChangeRow[]

  // Every accepted push writes BOTH a listing_change_log 'push' row AND an audit_logs 'listing.push'
  // row (pushExecutor). The change_log carries no submission_id link to the audit row and the audit
  // details have no submission_id, so we de-dupe by (actor name + same minute): a change_log push at
  // ~the same time as an audit push is the SAME event → show it once (change_log wins, audit dropped).
  // Legibility is the feature (R-UX7) — we never want the timeline to print every push twice.
  const minuteKey = (iso: string) => Math.floor(Date.parse(iso) / 60000)
  const pushDedupeKeys = new Set(
    changeRows
      .filter((r) => r.action === 'push')
      .map((r) => `${(r.changed_by_name || '').toLowerCase()}@${minuteKey(r.changed_at)}`),
  )

  const merged: MergedRow[] = changeRows.map((e) => {
    const actor = e.changed_by_name || 'Someone'
    const verb = e.action ? (ACTION_VERB[e.action] ?? e.action) : 'changed'
    let summary: string
    if (e.action === 'takeover') {
      // field carries "from:<prev name>" (see claim route); before/after carry the two user ids.
      const from = e.field?.startsWith('from:') ? e.field.slice(5) : null
      summary = from ? `${actor} took over from ${from}` : `${actor} took over the listing`
    } else if (e.action === 'claim') {
      summary = `${actor} claimed the listing`
    } else if (e.action === 'release') {
      summary = `${actor} released the listing`
    } else if (e.action === 'push') {
      summary = `${actor} pushed${fieldPhrase(e.field)} to Amazon${e.sku ? ` (${e.sku})` : ''}`
    } else {
      summary = `${actor} ${verb}${fieldPhrase(e.field)}`
    }
    return {
      id: `cl:${e.id}`,
      ts: e.changed_at,
      actor: e.changed_by_name,
      action: e.action,
      summary,
      source: e.source,
      kind: 'change_log' as const,
      field: e.field,
      parent_asin: e.parent_asin,
    }
  })

  // ── 2. audit_logs — narrow compliance subset for THIS listing (push / takeover) ────────────
  // resource_id is the parent_asin (see pushExecutor logAudit + claim takeover). Best-effort.
  const { data: auData } = await db
    .from('audit_logs')
    .select('id, user_id, action, resource_type, resource_id, details, created_at')
    .eq('resource_id', parentAsin)
    .in('action', ['listing.push', 'listing.takeover'])
    .order('created_at', { ascending: false })
    .limit(limit)
  for (const a of (auData || []) as AuditRow[]) {
    // Actor name lives in details.by (pushExecutor logAudit). De-dupe push rows against the
    // change_log by (actor name + same minute) so a push isn't printed twice (see above).
    const actorName = typeof a.details?.by === 'string' ? a.details.by : null
    if (a.action === 'listing.push') {
      const key = `${(actorName || '').toLowerCase()}@${minuteKey(a.created_at)}`
      if (pushDedupeKeys.has(key)) continue // same event already shown via change_log
    }
    const actor = actorName || 'A teammate'
    const summary = a.action === 'listing.takeover'
      ? `${actor} overrode the claim (compliance-logged)`
      : `${actor} wrote changes to Amazon (compliance-logged)`
    merged.push({
      id: `au:${a.id}`,
      ts: a.created_at,
      actor: actorName,
      action: a.action,
      summary,
      source: 'audit_logs',
      kind: 'audit',
      parent_asin: parentAsin,
    })
  }

  // ── 3. listing_score_history — score deltas (Phase C). SKIP cleanly if the table is absent. ─
  // listing_key = COALESCE(parent_asin, asin); for a parent grain that equals parent_asin.
  try {
    const { data: shData, error: shErr } = await db
      .from('listing_score_history')
      .select('id, overall_score, lifecycle_state, trigger, scored_by_name, scored_at')
      .eq('listing_key', parentAsin)
      .order('scored_at', { ascending: false })
      .limit(limit)
    if (!shErr && shData) {
      const rows = (shData as ScoreHistRow[])
      // Walk oldest→newest to compute deltas, then they're re-sorted with everything else below.
      const chrono = [...rows].sort((a, b) => Date.parse(a.scored_at) - Date.parse(b.scored_at))
      let prev: number | null = null
      for (const s of chrono) {
        const cur = s.overall_score
        const actor = s.scored_by_name || (s.trigger === 'scheduled_sync' ? 'Scheduled sync' : 'The system')
        let summary: string
        if (cur == null) {
          summary = `${actor} re-scored the listing`
        } else if (prev == null) {
          summary = `${actor} scored the listing at ${cur}/100`
        } else if (cur === prev) {
          summary = `${actor} re-scored the listing — still ${cur}/100`
        } else {
          const delta = cur - prev
          summary = `Score ${delta > 0 ? 'rose' : 'fell'} ${prev} → ${cur} (${delta > 0 ? '+' : ''}${delta}) after ${actor.toLowerCase().startsWith('the ') || actor === 'Scheduled sync' ? actor.toLowerCase() : actor}`
        }
        prev = cur ?? prev
        merged.push({
          id: `sh:${s.id}`,
          ts: s.scored_at,
          actor: s.scored_by_name,
          action: 'score',
          summary,
          source: s.trigger,
          kind: 'score',
          parent_asin: parentAsin,
        })
      }
    }
  } catch {
    // Phase C table not present — skip score deltas (spec item 3).
  }

  // ── Merge + time-sort (newest first), cap to limit ─────────────────────────────────────────
  merged.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
  const entries = merged.slice(0, limit)

  return NextResponse.json({ entries })
}
