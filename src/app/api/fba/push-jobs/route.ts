/**
 * /api/fba/push-jobs — server-side push queue (PR #184)
 * ─────────────────────────────────────────────────────────────────────────────
 * POST { parent_asin, field|detail_field, …, confirm:true }
 *   → insert a queued push_jobs row (payload = the push-content body) and kick the
 *     in-process runner. Returns { id } immediately — the browser is free to go.
 *
 * GET  ?active=1 | ?parent_asin=
 *   → list jobs for the global status bar / listing page. EVERY poll also runs:
 *     • markStaleJobs()  — running + stale heartbeat → 'interrupted' (deploy killed it)
 *     • kickQueuedJobs() — nothing running but queued rows exist → restart the queue
 *     This is the Cloud-Run watchdog-on-READ pattern: the status bar's own polling
 *     is what heals the queue after a restart; no cron needed.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { enqueueJobRun, markStaleJobs, kickQueuedJobs, type PushJobRow } from '@/lib/fba/pushJobs'
import { isPushField } from '@/lib/fba/pushFields'
import { SYSTEM_ACTOR, type PushParams, type PushActor } from '@/lib/fba/pushExecutor'
import { getBearerUser, resolveUserName } from '@/lib/fba/claims'

const MISSING_TABLE_HINT =
  'push_jobs table not found — run supabase/migrations/027_push_jobs.sql in the Supabase SQL editor (it is in the PR body), then retry.'

function isMissingTable(err: { code?: string; message?: string } | null): boolean {
  return !!err && (err.code === '42P01' || /push_jobs/.test(err.message ?? '') && /not exist|schema cache/i.test(err.message ?? ''))
}

export async function POST(req: NextRequest) {
  let body: { parent_asin?: string; confirm?: boolean; field?: string; detail_field?: string; skus?: string[]; title_override?: string; detail_value_override?: string }
  try { body = (await req.json().catch(() => ({}))) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  const { parent_asin, confirm, field, detail_field, skus, title_override, detail_value_override } = body
  if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  if (confirm !== true) {
    return NextResponse.json({ error: 'Refusing to queue a write without explicit confirm:true.' }, { status: 400 })
  }
  // Same gate as push-content's POST: details need a detail_field, everything else
  // must be a known push field. Catch it here so a bad job never reaches the queue.
  if (field === 'details') {
    if (!detail_field) return NextResponse.json({ error: 'detail_field is required for field=details' }, { status: 400 })
  } else if (!isPushField(field ?? '')) {
    return NextResponse.json({ error: `unknown field "${field}"` }, { status: 400 })
  }

  // Resolve WHO queued this from the Bearer JWT (spec §5 Phase B) and PERSIST it in the payload, so
  // the in-process runner — which may replay job.payload in a fresh container after a deploy — keeps
  // attribution. Falls back to SYSTEM_ACTOR when unauthenticated so a row never carries a NULL name.
  const bearer = await getBearerUser(req)
  const actor: PushActor = bearer
    ? { id: bearer.id, name: await resolveUserName(bearer.id, bearer.email) }
    : SYSTEM_ACTOR
  const payload: PushParams = { parent_asin, field, detail_field, skus, title_override, detail_value_override, actor }
  const supabase = await createAdminClient()
  const { data, error } = await supabase
    .from('push_jobs')
    .insert({
      parent_asin,
      field: field ?? null,
      detail_field: detail_field ?? null,
      payload,
      status: 'queued',
      message: 'Queued…',
    } as never)
    .select('id')
  if (error) {
    return NextResponse.json({ error: isMissingTable(error) ? MISSING_TABLE_HINT : error.message }, { status: 500 })
  }
  const id = (data as { id: string }[] | null)?.[0]?.id
  if (!id) return NextResponse.json({ error: 'Failed to create job' }, { status: 500 })

  enqueueJobRun(id)
  return NextResponse.json({ id, status: 'queued' })
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const activeOnly = url.searchParams.get('active') === '1'
  const parentAsin = url.searchParams.get('parent_asin')

  // Watchdog + self-heal ride every poll (best-effort — listing must still work
  // if the table is missing or the update races another instance of itself).
  try { await markStaleJobs() } catch { /* best-effort */ }
  try { await kickQueuedJobs() } catch { /* best-effort */ }

  const supabase = await createAdminClient()
  let q = supabase
    .from('push_jobs')
    .select('id, parent_asin, field, detail_field, status, total, accepted, failed, message, created_at, started_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(20)
  if (activeOnly) {
    // Active = anything in flight, plus jobs that finished in the last 2 minutes so
    // the status bar can show the final state briefly before the entry fades.
    const recentCutoff = new Date(Date.now() - 2 * 60_000).toISOString()
    q = q.or(`status.in.(queued,running),finished_at.gte.${recentCutoff}`)
  }
  if (parentAsin) q = q.eq('parent_asin', parentAsin)

  const { data, error } = await q
  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ jobs: [], missing_table: true })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ jobs: (data ?? []) as Partial<PushJobRow>[] })
}
