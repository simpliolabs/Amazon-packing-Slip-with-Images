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

import { randomUUID } from 'node:crypto'
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
  let body: { parent_asin?: string; confirm?: boolean; field?: string; detail_field?: string; skus?: string[]; title_override?: string; detail_value_override?: string; detail_fields?: string[]; detail_overrides?: Record<string, string>; core_fields?: string[]; action?: string; id?: string }
  try { body = (await req.json().catch(() => ({}))) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  // DURABLE CANCEL: {action:'cancel', id}. Flag the row (the running runner's heartbeat reads
  // cancel_requested → requestPushCancel → the SKU loop stops between SKUs); a still-QUEUED job never
  // starts, so also flip it terminal immediately so it leaves the queue. Already-accepted SKUs stay
  // pushed (they're Amazon's now). Works for background jobs and survives a deploy (flag lives on the row).
  if (body.action === 'cancel' && typeof body.id === 'string' && body.id) {
    const supabase = await createAdminClient()
    await supabase.from('push_jobs').update({ cancel_requested: true, message: 'Cancelling…' } as never)
      .eq('id', body.id).in('status', ['queued', 'running'])
    await supabase.from('push_jobs').update({ status: 'failed', message: 'Cancelled before it started.', finished_at: new Date().toISOString() } as never)
      .eq('id', body.id).eq('status', 'queued')
    return NextResponse.json({ ok: true })
  }

  const { parent_asin, confirm, field, detail_field, skus, title_override, detail_value_override, detail_fields, detail_overrides, core_fields } = body
  if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  if (confirm !== true) {
    return NextResponse.json({ error: 'Refusing to queue a write without explicit confirm:true.' }, { status: 400 })
  }
  // Same gate as push-content's POST: details need a detail_field, everything else
  // must be a known push field. Catch it here so a bad job never reaches the queue.
  if (field === 'details') {
    if (!detail_field) return NextResponse.json({ error: 'detail_field is required for field=details' }, { status: 400 })
  } else if (field === 'details_bulk') {
    // Bulk Auto Push — needs at least one detail field selected.
    if (!detail_fields?.length) return NextResponse.json({ error: 'detail_fields is required for field=details_bulk' }, { status: 400 })
  } else if (field === 'core_bulk') {
    // Ship-all-core — core_fields optional; the executor defaults to every core field that has a diff.
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
  // A server-generated cancel token, PERSISTED in the payload so the durable cancel (a cancel_requested
  // flag on the row, read by the runner) can translate into the executors' existing pushCancelled() check.
  const cancel_token = randomUUID()
  const payload: PushParams = { parent_asin, field, detail_field, skus, title_override, detail_value_override, detail_fields, detail_overrides, core_fields: core_fields as PushParams['core_fields'], cancel_token, actor }
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

/** RUNTIME queue switch (2026-07-19). Read on the SERVER, per request.
 *
 *  WHY: the old gate was `NEXT_PUBLIC_PUSH_QUEUE_ALL`, and Next.js inlines NEXT_PUBLIC_* at BUILD time.
 *  On Coolify with "Use Docker Build Secrets" enabled, build-time values are delivered as mounted secret
 *  FILES rather than environment variables, so `next build` never saw it, folded `=== 'on'` to false and
 *  dead-code-eliminated the entire queue branch. Live proof: the var was set WITH "Available at Buildtime"
 *  ticked, yet B0FKKN8XKV had ZERO push_jobs rows and the Auto Push still died on the streaming path at
 *  58/151 SKUs. Reading it here makes it a RESTART-only toggle that cannot silently deactivate, and lets
 *  the client ask at click time (no build, no race). NEXT_PUBLIC_ is still honoured so that if a build DID
 *  inline it, nothing regresses. */
export function pushQueueAllEnabled(): boolean {
  return process.env.PUSH_QUEUE_ALL === 'on' || process.env.NEXT_PUBLIC_PUSH_QUEUE_ALL === 'on'
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  // Cheap config probe — the client calls this right before a bulk push to decide queue vs stream.
  // Answered BEFORE any DB work so it stays a few-ms call even when push_jobs is missing/slow.
  if (url.searchParams.get('config') === '1') {
    return NextResponse.json({ queue_all: pushQueueAllEnabled() })
  }
  const activeOnly = url.searchParams.get('active') === '1'
  const parentAsin = url.searchParams.get('parent_asin')

  // Watchdog + self-heal ride every poll (best-effort — listing must still work
  // if the table is missing or the update races another instance of itself).
  try { await markStaleJobs() } catch { /* best-effort */ }
  try { await kickQueuedJobs() } catch { /* best-effort */ }

  const jobId = url.searchParams.get('id')
  const supabase = await createAdminClient()
  let q = supabase
    .from('push_jobs')
    // `progress` carries the tail events incl. the bulk 'result' (per-field accepted/failed) that the
    // flag-on modal poll maps back onto the field rows — without it a rejected field renders green.
    .select('id, parent_asin, field, detail_field, status, total, accepted, failed, message, progress, created_at, started_at, finished_at')
    .order('created_at', { ascending: false })
    .limit(20)
  // Poll-by-id (the modal): match the exact job regardless of how many newer rows exist for the parent
  // (a parent-only, newest-20 filter would drop the target once ≥20 newer jobs appear → an infinite poll).
  if (jobId) q = q.eq('id', jobId)
  if (activeOnly) {
    // Active = anything in flight, plus jobs that finished in the last 2 minutes so
    // the status bar can show the final state briefly before the entry fades.
    const recentCutoff = new Date(Date.now() - 2 * 60_000).toISOString()
    q = q.or(`status.in.(queued,running),finished_at.gte.${recentCutoff}`)
  }
  if (parentAsin) q = q.eq('parent_asin', parentAsin)

  const { data, error } = await q
  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ jobs: [], missing_table: true, queue_all: pushQueueAllEnabled() })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ jobs: (data ?? []) as Partial<PushJobRow>[], queue_all: pushQueueAllEnabled() })
}
