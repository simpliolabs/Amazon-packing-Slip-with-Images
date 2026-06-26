/**
 * Auto-verify + retry queue for content/detail pushes (migration 030, PO directive
 * 2026-06-13: "Shipping Verification Should be an Automatic Cron JOB").
 *
 * After every accepted push, enqueueVerification() registers a follow-up task with
 * next_check_at = now + ~20 min (within Amazon's typical 15-30 min application window).
 * The cron at /api/fba/cron-verify-pushes claims due tasks, runs verify-push, and either
 * marks complete (matched===total), re-pushes the stale SKUs and bumps attempts, or
 * marks needs_attention after max_attempts (5 × 30 min ≈ 2.5 hrs of trying).
 *
 * One ACTIVE task per (parent_asin, field) — guaranteed by a partial UNIQUE index. A
 * new push for the same field UPSERTs over the previous task (the seller's newer value
 * supersedes), so we never retry against a stale expected_value.
 */
import { createAdminClient } from '@/lib/supabase/server'

/** ~20 min — sits inside Amazon's 15-30 min window so the first verify isn't too early
 *  (everything looks stale) or too late (the seller has been staring at "Pushed" with no
 *  signal). Subsequent attempts use +30 min linear backoff. */
const INITIAL_DELAY_MS = 20 * 60 * 1000
const RETRY_DELAY_MS = 30 * 60 * 1000

/** Standard field id used everywhere in this module:
 *  - 'title' | 'bullets' | 'description' | 'keywords' (the four push-content fields), or
 *  - `details:<spApiKey>` for product-detail attributes (matches keyword_push_log.field). */
export type VerificationField = string

export interface EnqueueArgs {
  parent_asin: string
  field: VerificationField
  /** Friendly name for details ("Sleeve", "Neck") — null for the four standard fields. */
  detail_field?: string | null
  /** What we pushed: a short string for display + a sanity check on the next verify. */
  expected_value?: string | null
  /** Override the default delay (used by the cron when scheduling a retry). */
  delay_ms?: number
  /** Override the default 5 attempts (e.g. 1 for "just one follow-up verify"). */
  max_attempts?: number
}

/** Register a verify-and-retry task for a single (parent, field). UPSERTs over any
 *  active task for the same (parent, field) — the seller's newer push supersedes. */
export async function enqueueVerification(args: EnqueueArgs): Promise<void> {
  const { parent_asin, field, detail_field, expected_value } = args
  if (!parent_asin || !field) return
  const next = new Date(Date.now() + (args.delay_ms ?? INITIAL_DELAY_MS)).toISOString()
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    // First, abandon any existing active task for this (parent, field) — the new push's
    // expected_value supersedes the old one. (We can't simply UPSERT on the partial unique
    // index because the conflict target isn't a real constraint; an explicit abandon is
    // the clearest, race-safe path.)
    await db.from('push_verification_tasks')
      .update({ status: 'abandoned', updated_at: new Date().toISOString() })
      .eq('parent_asin', parent_asin)
      .eq('field', field)
      .in('status', ['pending', 'running'])
    await db.from('push_verification_tasks').insert({
      parent_asin,
      field,
      detail_field: detail_field ?? null,
      expected_value: expected_value ?? null,
      status: 'pending',
      attempts: 0,
      max_attempts: args.max_attempts ?? 5,
      next_check_at: next,
    })
  } catch (e) {
    // Non-fatal: the push itself succeeded. A missed enqueue just means no auto-verify
    // for THAT push; the seller can still trigger Verify manually. The most common cause
    // here is migration 030 not yet applied — the optimizer just doesn't enqueue.
    console.warn('[verification-queue] enqueue failed (migration 030 applied?):', e instanceof Error ? e.message : e)
  }
}

/** Pick up to `limit` tasks that are DUE and atomically flip pending → running so two
 *  concurrent cron invocations never double-process the same task. Returns the claimed
 *  rows; an unclaimed row stays pending for the next cron tick. */
export async function claimDueTasks(limit: number): Promise<PushVerificationTask[]> {
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    // Read the candidates, then UPDATE only the ones still pending — Postgres returns the
    // rows that actually transitioned, so a parallel claim from another invocation drops
    // out cleanly (no double-process).
    const { data: due } = await db.from('push_verification_tasks')
      .select('id')
      .eq('status', 'pending')
      .lte('next_check_at', new Date().toISOString())
      .order('next_check_at', { ascending: true })
      .limit(limit)
    const ids = ((due ?? []) as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) return []
    const { data: claimed } = await db.from('push_verification_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .in('id', ids)
      .eq('status', 'pending')   // the atomic guard
      .select('*')
    return (claimed ?? []) as PushVerificationTask[]
  } catch (e) {
    console.warn('[verification-queue] claim failed:', e instanceof Error ? e.message : e)
    return []
  }
}

export interface PushVerificationTask {
  id: string
  parent_asin: string
  field: string
  detail_field: string | null
  expected_value: string | null
  status: string
  attempts: number
  max_attempts: number
  next_check_at: string
  last_verified_at: string | null
  last_matched_count: number | null
  last_total_count: number | null
  last_stale_skus: string[] | null
  last_error: string | null
  // ── Autonomous push→verify→reship loop (migration 040, PO H1) — all default off/zero, so the
  //    existing manual verify cron is unaffected. ──
  /** Per-listing OPT-IN (safety a): the autonomous loop is a NO-OP unless this is TRUE *and* the env
   *  AUTO_RESHIP_ENABLED kill-switch is set. */
  auto_reship_enabled?: boolean | null
  /** Per-CHILD autonomous re-delivery bound (safety b): max MAX_RESHIP_ATTEMPTS, then needs_attention. */
  reship_attempts?: number | null
  /** The user's ORIGINAL approved push submission id (safety d: SAME-CONTENT provenance). */
  origin_submission_id?: string | null
}

/** Mark a task as complete (100% applied on Amazon). */
export async function completeTask(id: string, matched: number, total: number): Promise<void> {
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('push_verification_tasks')
      .update({
        status: 'completed', last_verified_at: new Date().toISOString(),
        last_matched_count: matched, last_total_count: total, updated_at: new Date().toISOString(),
      }).eq('id', id)
  } catch (e) { console.warn('[verification-queue] complete failed:', e instanceof Error ? e.message : e) }
}

/** Schedule another verify (still stale, but more attempts left) — linear backoff. */
export async function rescheduleTask(id: string, matched: number, total: number, staleSkus: string[]): Promise<void> {
  try {
    const supabase = await createAdminClient()
    const next = new Date(Date.now() + RETRY_DELAY_MS).toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.rpc?.('increment')  // no-op; we use a direct UPDATE below
    // Need to read attempts to increment — small race window OK; the cron is the only writer.
    const { data: row } = await db.from('push_verification_tasks').select('attempts').eq('id', id).single()
    const attempts = (row as { attempts?: number } | null)?.attempts ?? 0
    await db.from('push_verification_tasks')
      .update({
        status: 'pending', attempts: attempts + 1, next_check_at: next,
        last_verified_at: new Date().toISOString(),
        last_matched_count: matched, last_total_count: total,
        last_stale_skus: staleSkus, updated_at: new Date().toISOString(),
      }).eq('id', id)
  } catch (e) { console.warn('[verification-queue] reschedule failed:', e instanceof Error ? e.message : e) }
}

/** Out of attempts — surface to the seller. */
export async function flagNeedsAttention(id: string, matched: number, total: number, staleSkus: string[], errorMsg?: string): Promise<void> {
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('push_verification_tasks')
      .update({
        status: 'needs_attention', last_verified_at: new Date().toISOString(),
        last_matched_count: matched, last_total_count: total, last_stale_skus: staleSkus,
        last_error: errorMsg ?? null, updated_at: new Date().toISOString(),
      }).eq('id', id)
  } catch (e) { console.warn('[verification-queue] flag failed:', e instanceof Error ? e.message : e) }
}

/** ── Autonomous push→verify→reship loop helpers (migration 040, PO H1) ───────────────────────────
 *  Per-CHILD bound (safety b): max 3 autonomous reships per task, then needs_attention + STOP. This
 *  counter (`reship_attempts`) is DISTINCT from `attempts` (the manual verify-cycle counter) so the
 *  autonomous re-delivery bound is independent of the existing verify loop. */
export const MAX_RESHIP_ATTEMPTS = 3

/** Claim DUE tasks that have OPTED IN to the autonomous reship loop. The filter is `<=
 *  MAX_RESHIP_ATTEMPTS` (NOT `<`) on purpose: a task that has already done its 3 reships still gets ONE
 *  final claim so the cron can VERIFY it (it may have converged on the last try) and, if still stale,
 *  explicitly flag it needs_attention + STOP — rather than the bound silently stranding it at pending
 *  forever. The cron's own `>= MAX_RESHIP_ATTEMPTS` check is the actual stop (safety b). Mirrors
 *  claimDueTasks' atomic pending→running flip so two cron invocations never double-ship. Returns [] when
 *  the loop has nothing to do (the common case — opt-in defaults FALSE). */
export async function claimDueReshipTasks(limit: number): Promise<PushVerificationTask[]> {
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    const { data: due } = await db.from('push_verification_tasks')
      .select('id')
      .eq('status', 'pending')
      .eq('auto_reship_enabled', true)                 // safety a: per-listing opt-in
      .lte('reship_attempts', MAX_RESHIP_ATTEMPTS)     // safety b: one final claim AT the bound to flag+stop
      .lte('next_check_at', new Date().toISOString())
      .order('next_check_at', { ascending: true })
      .limit(limit)
    const ids = ((due ?? []) as { id: string }[]).map((r) => r.id)
    if (ids.length === 0) return []
    const { data: claimed } = await db.from('push_verification_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .in('id', ids)
      .eq('status', 'pending')   // the atomic guard
      .select('*')
    return (claimed ?? []) as PushVerificationTask[]
  } catch (e) {
    console.warn('[verification-queue] reship-claim failed:', e instanceof Error ? e.message : e)
    return []
  }
}

/** Bump the per-child reship counter and reschedule the next verify (the loop converges or hits the
 *  bound). Returns the new reship_attempts so the caller can log it loudly (safety e). */
export async function recordReshipAttempt(id: string, matched: number, total: number, staleSkus: string[]): Promise<number> {
  try {
    const supabase = await createAdminClient()
    const next = new Date(Date.now() + RETRY_DELAY_MS).toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    const { data: row } = await db.from('push_verification_tasks').select('reship_attempts').eq('id', id).single()
    const prev = (row as { reship_attempts?: number } | null)?.reship_attempts ?? 0
    const nextCount = prev + 1
    await db.from('push_verification_tasks')
      .update({
        status: 'pending', reship_attempts: nextCount, next_check_at: next,
        last_verified_at: new Date().toISOString(),
        last_matched_count: matched, last_total_count: total,
        last_stale_skus: staleSkus, updated_at: new Date().toISOString(),
      }).eq('id', id)
    return nextCount
  } catch (e) {
    console.warn('[verification-queue] record-reship failed:', e instanceof Error ? e.message : e)
    return MAX_RESHIP_ATTEMPTS // fail safe: treat as bound-reached so we STOP rather than loop unbounded
  }
}

/** The autonomous loop CONVERGED (100% confirmed). Mark complete — the cron then stamps the outcome
 *  epoch (safety f: epoch stamps only once the loop converges, not on every partial reship). */
export async function completeReshipTask(id: string, matched: number, total: number): Promise<void> {
  await completeTask(id, matched, total)
}

/** Transient failure (verify call errored) — keep status running? No: bump next_check_at
 *  forward and put it back to pending so the next cron picks it up without consuming an
 *  attempt (the FAILURE wasn't Amazon rejecting the push — it was OUR call failing). */
export async function softFailTask(id: string, errorMsg: string): Promise<void> {
  try {
    const supabase = await createAdminClient()
    const next = new Date(Date.now() + RETRY_DELAY_MS).toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('push_verification_tasks')
      .update({
        status: 'pending', next_check_at: next, last_error: errorMsg,
        updated_at: new Date().toISOString(),
      }).eq('id', id)
  } catch (e) { console.warn('[verification-queue] soft-fail failed:', e instanceof Error ? e.message : e) }
}
