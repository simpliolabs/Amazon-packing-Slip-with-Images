/**
 * Server-side push jobs (PR #184) — "survives tab close + deploys, global status bar".
 * ─────────────────────────────────────────────────────────────────────────────
 * A push job is one executePush() run (one field / detail field for one parent),
 * persisted in push_jobs and executed by THIS module inside the long-lived node
 * container. The browser only creates the row and polls — closing the tab changes
 * nothing on the server.
 *
 * Concurrency: jobs run strictly ONE at a time via a module-level promise chain.
 * The streaming path already throttles 200ms/SKU for Amazon's 5 rps limit; running
 * two job loops in parallel would double the patch rate, so we serialize instead.
 * (Coolify runs a single node process — a module singleton is sufficient here.)
 *
 * Deploy survival is the WATCHDOG's job, not the runner's: a deploy kills this
 * process mid-loop, the row stays 'running' with a stale heartbeat, and the
 * read-side watchdog (markStaleJobs, called from the poll endpoint — the
 * Cloud-Run-watchdog-on-READ pattern) flips it to 'interrupted' with recovery
 * guidance. kickQueuedJobs() then restarts any still-queued work in the new
 * container, again from the read path: polling is the heartbeat of the system.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { executePush, executeBulkDetailsPush, executeBulkCorePush, requestPushCancel, type PushParams } from '@/lib/fba/pushExecutor'

export interface PushJobRow {
  id: string
  parent_asin: string
  field: string | null
  detail_field: string | null
  payload: PushParams
  status: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'
  total: number
  accepted: number
  failed: number
  progress: Record<string, unknown>[]
  message: string | null
  created_at: string
  started_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
}

/** Heartbeats older than this on a 'running' job mean the container died mid-push. */
export const STALE_RUNNING_MS = 120_000

// One-at-a-time execution. Each enqueue appends to the chain; the catch keeps a
// crashed job from wedging every job behind it.
let chain: Promise<void> = Promise.resolve()

/** Fire-and-forget: append a job to the in-process run queue. Safe to call twice
 *  for the same id — runJob's atomic queued→running claim makes the second a no-op. */
export function enqueueJobRun(jobId: string): void {
  console.log(`[push-jobs] enqueueJobRun ${jobId} — appending to chain`)
  chain = chain.then(() => runJob(jobId)).catch((e) => {
    console.error('[push-jobs] runner crashed (chain preserved):', e)
  })
}

async function runJob(jobId: string): Promise<void> {
  const supabase = await createAdminClient()

  // Atomic claim: only queued→running transitions win. A duplicate kick (POST + poll
  // self-heal racing) or an already-finished job matches 0 rows and we walk away.
  const nowIso = new Date().toISOString()
  console.log(`[push-jobs] runJob ${jobId} — attempting claim`)
  const { data: claimed, error: claimErr } = await supabase
    .from('push_jobs')
    .update({ status: 'running', started_at: nowIso, heartbeat_at: nowIso } as never)
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('*')
  // 2026-08-20: 15 jobs sat queued for 80+ minutes with ZERO log output — the claim's error was
  // discarded and a no-claim walked away silently. A silent runner is indistinguishable from a
  // dead one; every branch now says which it is.
  if (claimErr) { console.error(`[push-jobs] runJob ${jobId} — CLAIM FAILED: ${claimErr.message}`); return }
  const job = (claimed as PushJobRow[] | null)?.[0]
  if (!job) { console.log(`[push-jobs] runJob ${jobId} — no claim (already running/finished elsewhere)`); return }
  console.log(`[push-jobs] runJob ${jobId} — CLAIMED (${job.payload?.field ?? '?'} for ${job.parent_asin ?? '?'})`)

  // Heartbeat on an interval, not just on events: executePush has quiet stretches
  // (initial diff load, the post-push re-score) where no events fire for a while —
  // without this the watchdog could call a healthy slow job "interrupted".
  // Heartbeat doubles as the DURABLE-CANCEL poll: each tick stamps heartbeat_at AND reads back
  // cancel_requested (set by POST {action:'cancel', id}). When true, translate it into the executors'
  // existing in-memory cancel via requestPushCancel(cancel_token) — the SKU loops check pushCancelled()
  // between SKUs and stop, leaving already-accepted SKUs on Amazon. Living on the ROW (not an in-memory
  // Set) is what makes cancel work for a background job and survive a deploy.
  let cancelSignalled = false
  const beat = setInterval(() => {
    void (async () => {
      const { data } = await supabase.from('push_jobs')
        .update({ heartbeat_at: new Date().toISOString() } as never)
        .eq('id', jobId).select('cancel_requested')
      const cr = (data as { cancel_requested?: boolean }[] | null)?.[0]?.cancel_requested
      if (cr && !cancelSignalled && job.payload.cancel_token) { cancelSignalled = true; requestPushCancel(job.payload.cancel_token) }
    })()
  }, 30_000)

  const events: Record<string, unknown>[] = []
  let total = 0, accepted = 0, failed = 0, skipped = 0
  const isBulk = job.payload.field === 'details_bulk' || job.payload.field === 'core_bulk'
  let message: string | null = null
  let sawResult = false
  let lastFlush = 0
  let finished = false

  const flush = async (force = false) => {
    if (finished) return // never let a late throttled write trample the final row
    const now = Date.now()
    if (!force && now - lastFlush < 2_500) return
    lastFlush = now
    await supabase.from('push_jobs').update({
      total, accepted, failed, message,
      progress: events.slice(-60), // tail only — counts/message carry the summary
      heartbeat_at: new Date().toISOString(),
    } as never).eq('id', jobId)
  }

  // Same event vocabulary as the streaming modal (see executePush docblock).
  const emit = (obj: Record<string, unknown>) => {
    events.push(obj)
    const t = obj.type
    if (t === 'started') {
      total = Number(obj.total ?? 0) || total
      message = `Pushing ${String(obj.detail_field ?? obj.field ?? '')}…`
    } else if (t === 'progress') {
      // One progress event per SKU. Single-field emits accepted|failed; BULK also emits
      // partial (some of the SKU's fields wrote) and skipped (nothing to change) — count all four
      // toward the processed tally so the "N/total SKUs" bar actually reaches total for a bulk job.
      if (obj.status === 'accepted' || obj.status === 'partial') accepted++
      else if (obj.status === 'failed') failed++
      else if (obj.status === 'skipped') skipped++
      message = `${accepted + failed + skipped}/${total || '?'} SKUs (${accepted} accepted${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''})`
    } else if (t === 'rescore') {
      message = String(obj.message ?? 'Re-scoring…')
    } else if (t === 'result') {
      sawResult = true
      // Single-field result is SKU-grained (pushed/failed/total per SKU) → adopt it. BULK result is
      // FIELD×SKU grained (pushed = sum over fields of per-field accepts) against a SKU total, so copying
      // it would render accepted>total in the status bar — keep the per-SKU-counted values above and use
      // the bulk result only for its human message.
      if (!isBulk) {
        accepted = Number(obj.pushed ?? accepted)
        failed = Number(obj.failed ?? failed)
        total = Number(obj.total ?? total)
      }
      message = String(obj.message ?? message ?? '')
    } else if (t === 'error') {
      message = String(obj.error ?? 'Push failed')
    }
    void flush() // throttled, fire-and-forget — the loop never waits on bookkeeping
  }

  // Absolute ceiling: the interval heartbeat above would keep a HUNG push looking
  // healthy forever (the watchdog only catches process death), wedging the serialized
  // chain. 30min is several times the longest real push (147 SKUs ≈ 5-8min); past it
  // we declare the job failed and let the chain move on. (The abandoned loop may keep
  // running harmlessly — `finished` below blocks any further writes from it.)
  let ceiling: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      // Dispatch by kind (2026-07-19): bulk Auto Push / Ship-all-core now run through the SAME durable
      // queue as single-field pushes, so concurrent multi-employee pushes serialize (one at a time =
      // global 5 rps) and survive tab-close + deploys. All three executors share the PushEmit vocabulary
      // runJob.emit consumes, so the ceiling/heartbeat/terminal-status logic below is unchanged.
      job.payload.field === 'details_bulk' ? executeBulkDetailsPush(job.payload, emit)
        : job.payload.field === 'core_bulk' ? executeBulkCorePush(job.payload, emit)
        : executePush(job.payload, emit),
      new Promise<void>((resolve) => {
        ceiling = setTimeout(() => {
          emit({ type: 'error', error: 'Push exceeded the 30-minute job ceiling and was abandoned. Already-accepted SKUs stayed pushed — Verify on Amazon, then push just the stale.' })
          resolve()
        }, 30 * 60_000)
      }),
    ])
  } finally {
    clearInterval(beat)
    if (ceiling) clearTimeout(ceiling)
  }

  // Terminal status mirrors the modal's semantics: a 'result' event = the loop ran to
  // completion (even with some failed SKUs — they're counted and listed); no result
  // means executePush ended on a terminal 'error' instead.
  finished = true
  const status = sawResult ? 'done' : 'failed'
  await supabase.from('push_jobs').update({
    status,
    total, accepted, failed, message,
    progress: events.slice(-60),
    heartbeat_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  } as never).eq('id', jobId)
}

/** READ-side watchdog: any 'running' job whose heartbeat is older than the threshold was
 *  killed mid-push (deploy/restart). Flip it to 'interrupted' with recovery guidance —
 *  already-accepted SKUs stayed pushed; Verify → "Push just the stale" recovers the rest. */
export async function markStaleJobs(): Promise<void> {
  const supabase = await createAdminClient()
  const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString()
  await supabase
    .from('push_jobs')
    .update({
      status: 'interrupted',
      message: 'Interrupted by a server restart/deploy. Already-accepted SKUs stayed pushed — open the field\'s Ship modal → Verify on Amazon → "Push just the stale".',
      finished_at: new Date().toISOString(),
    } as never)
    .eq('status', 'running')
    .lt('heartbeat_at', cutoff)
}

/** READ-side self-heal: after a deploy the new process has an empty in-memory chain while
 *  queued rows wait in the table. If nothing is genuinely running, kick the oldest queued
 *  job. Called from the poll endpoint, so the status bar's own polling restarts the queue. */
export async function kickQueuedJobs(): Promise<void> {
  const supabase = await createAdminClient()
  const { data: running } = await supabase
    .from('push_jobs').select('id').eq('status', 'running').limit(1)
  if ((running as { id: string }[] | null)?.length) return
  const { data: queued } = await supabase
    .from('push_jobs').select('id').eq('status', 'queued')
    .order('created_at', { ascending: true }).limit(1)
  const next = (queued as { id: string }[] | null)?.[0]
  if (next) enqueueJobRun(next.id)
}
