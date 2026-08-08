/**
 * CONTENT-RECONCILE LOOP (PO decision 2026-08-08, SELLER_PROFILE.md §10).
 * ─────────────────────────────────────────────────────────────────────────────
 * After a regen PERSISTS changed core content, every core field (title/bullets/
 * description/keywords) that (a) actually changed in this persist, (b) has a prior
 * ACCEPTED push for this parent (keyword_push_log evidence), and (c) was NOT
 * degrade-preserved this run gets auto-pushed through the SAME queue pathway the
 * Ship-all-core click uses (push_jobs 'core_bulk' → executeBulkCorePush), so
 * verify/heal/needs_attention downstream is identical to a manual Ship.
 *
 * Rollout (adversarial review 2026-08-08 — house off→shadow→on doctrine): UNSET
 * defaults to SHADOW (full decision + evidence + dedupe, loud would-enqueue logs,
 * NO insert). Soak the shadow logs, then set CONTENT_RECONCILE_ENABLED=on in
 * Coolify for the live flip; later retire the flag as-on once the loop has earned
 * trust. /api/health echoes the EFFECTIVE mode ('shadow (default)' when unset).
 *
 * Constraints this module encodes:
 *  - ONE implementation, TWO call sites (the full dbPayload upsert AND the #79
 *    partial early-return in ai-recommendations — the dual-write-path doctrine).
 *  - The decision (decideReconcileFields) is PURE and unit-tested; the enqueue is
 *    best-effort and NEVER throws into the regen stream.
 *  - Value resolution stays in the executor (loadDiff/resolveProposed at run time):
 *    this module never snapshots content, so a manual-title lock or a newer regen
 *    can't be bypassed — plus an explicit titleLocked skip, belt-and-suspenders.
 *    An UNREADABLE lock/prior state fails CLOSED at the call sites (the full path
 *    skips the hook entirely; resolveTitleLocked treats unknown as locked).
 *  - Evidence miss fails SAFE (legacy NULL-field keyword_push_log rows → treated as
 *    first-time → stays behind the manual review gate, never auto-pushed).
 *  - Coalesces the family's changed fields into ONE core_bulk job (serialized queue,
 *    30-min ceiling — never 4 single-field jobs), dedupes against open push_jobs
 *    rows for the same (parent, field), and skips fields with push-log activity in
 *    the last 10 minutes (streamed single-field Ships create no push_jobs row until
 *    task #23 lands, so recency is the only signal an in-flight manual push exists).
 *  - NO dedupe against push_verification_tasks (adversarial review 2026-08-08): a
 *    pending verify task verifies the OLD pushed bytes (verify-push reads expected
 *    from keyword_push_log.new_value), so skipping here would silently DROP the
 *    updated content forever. Double-shipping is already structurally prevented:
 *    the executor's loadDiff drops rows where rec == live cache, and its post-push
 *    enqueueVerification abandons any open task for the same (parent, field).
 */
import { PUSH_FIELDS, type PushField } from '@/lib/fba/pushFields'
// Type-only (erased at runtime): the executor VALUE deps stay dynamic imports below so this
// module remains an env-free leaf the unit tests can import.
import type { PushParams } from '@/lib/fba/pushExecutor'

/** One core field's outcome in the persist that just completed. `changed` must key on
 *  "the persisted value actually differs" (full path: prior-vs-written compare, broadcast
 *  AND per-child; partial path: the section's column landed in the update AND its bytes
 *  differ — absence-of-write = unchanged). */
export interface ReconcileCandidate {
  field: PushField
  changed: boolean
  /** This run kept the prior via a degrade-preserve (kwPreserved / descPreserved /
   *  degradedSections swap) — the prior is better; re-pushing it is pure churn. */
  degradePreserved: boolean
}

export type ContentReconcileMode = 'off' | 'shadow' | 'on'

/** CONTENT_RECONCILE_ENABLED semantics (house flag vocabulary, adversarial review 2026-08-08):
 *  - explicit disable ('0'|'false'|'off'|'no'|'disabled', case-insensitive) → 'off'
 *  - explicit truthy ('1'|'true'|'on'|'yes') → 'on' (live enqueue)
 *  - 'shadow', UNSET, or ANY unrecognized value → 'shadow' (full decision + loud
 *    would-enqueue logs, no insert — a typo can never mean live autonomous writes).
 *  Raw value is a parameter so the rule is unit-testable without mutating process.env. */
export function contentReconcileMode(
  raw: string | undefined = process.env.CONTENT_RECONCILE_ENABLED,
): ContentReconcileMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (/^(0|false|off|no|disabled)$/.test(v)) return 'off'
  if (/^(1|true|on|yes)$/.test(v)) return 'on'
  return 'shadow'
}

/** /api/health echo: the EFFECTIVE mode string. For every other flag `null` reads as
 *  "unset → module default off"; for this one unset means SHADOW, so the census must
 *  say so explicitly — 'shadow (default)' — instead of echoing a misleading null. */
export function describeContentReconcileMode(
  raw: string | undefined = process.env.CONTENT_RECONCILE_ENABLED,
): string {
  const unset = raw == null || raw.trim() === ''
  const mode = contentReconcileMode(raw)
  return unset ? `${mode} (default)` : mode
}

/** Canonical JSON compare for JSONB-shaped values (bullets arrays, per_child_* payloads).
 *  null and undefined fold together (both "no value stored"). */
export function jsonChanged(next: unknown, prior: unknown): boolean {
  return JSON.stringify(next ?? null) !== JSON.stringify(prior ?? null)
}

/** Per-child twin compare with the partial path's absence-of-write semantics:
 *  `next === undefined` means the column did NOT land in this persist (either the section
 *  regen had no per-child output, or the missing-column retry deleted it) → the per-child
 *  half reads UNCHANGED. An explicit null IS a written value and compares normally. */
export function perChildChanged(next: unknown, prior: unknown): boolean {
  if (next === undefined) return false
  return jsonChanged(next, prior)
}

/** Fail-CLOSED lock resolution (adversarial review 2026-08-08 BLOCKER): when the stored
 *  row's lock state could not be READ, unknown must mean LOCKED — never 'ai'. A transient
 *  select failure on a manually-titled family must not let the reconcile auto-push a fresh
 *  AI title over the seller's hand-typed one. */
export function resolveTitleLocked(
  titleSource: string | null | undefined,
  lockReadFailed: boolean,
): boolean {
  return lockReadFailed || titleSource === 'manual'
}

/** PURE decision: which core fields auto-reconcile this persist.
 *  field ships ⇔ changed ∧ previouslyShipped ∧ ¬degradePreserved ∧ ¬(title ∧ titleLocked).
 *  Output is normalized to PUSH_FIELDS order (stable core_fields payload). */
export function decideReconcileFields(opts: {
  candidates: ReconcileCandidate[]
  /** Fields with an ACCEPTED keyword_push_log row for this parent. */
  shippedFields: Iterable<string>
  /** listing_seo_recommendations.title_source === 'manual' (migration 044), OR the lock
   *  state was unreadable (resolveTitleLocked — fail closed). */
  titleLocked: boolean
}): PushField[] {
  const shipped = new Set(opts.shippedFields)
  const byField = new Map(opts.candidates.map((c) => [c.field, c]))
  return PUSH_FIELDS.filter((f) => {
    const c = byField.get(f)
    if (!c || !c.changed || c.degradePreserved) return false
    if (!shipped.has(f)) return false
    if (f === 'title' && opts.titleLocked) return false
    return true
  })
}

/** Streamed single-field pushes create no push_jobs row (task #23), so recent push-log
 *  activity is the only overlap signal. 10 minutes comfortably covers a streaming session. */
const RECENT_PUSH_WINDOW_MS = 10 * 60 * 1000

/** Best-effort enqueue of the reconcile push. Called from BOTH ai-recommendations write
 *  paths AFTER the persist SUCCEEDED (the full path additionally skips this entirely when
 *  the prior/lock read failed — fail closed). Never throws — a reconcile failure must not
 *  break the regen response. `db` is the plain supabase-js ADMIN client the route already
 *  holds (never a cookies()-bound client — this runs inside a streaming response). */
export async function maybeEnqueueContentReconcile(opts: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
  parentAsin: string
  candidates: ReconcileCandidate[]
  titleLocked: boolean
}): Promise<void> {
  const { db, parentAsin, candidates, titleLocked } = opts
  try {
    const mode = contentReconcileMode()
    if (mode === 'off') return
    // Cheap pre-filter before any DB work: only changed + not-preserved (+ unlocked) fields
    // can possibly ship, so only those need an evidence lookup.
    const viable = candidates.filter(
      (c) => c.changed && !c.degradePreserved && !(c.field === 'title' && titleLocked),
    )
    if (viable.length === 0) return

    // (b) prior-ship evidence, per field: one ACCEPTED keyword_push_log row for (parent, field).
    // Core fields log UNPREFIXED ('title'|'bullets'|'description'|'keywords'); heal machinery
    // uses 'heal:*' (incl. the Strategy-5 feeds title rider 'heal:feeds-title') and details
    // 'details:*', so the eq() can't false-positive on a push the PO never shipped. A query
    // error reads as no-evidence → fail-safe (field stays behind the manual review gate).
    const shipped: string[] = []
    await Promise.all(viable.map(async (c) => {
      const { data } = await db
        .from('keyword_push_log')
        .select('field')
        .eq('parent_asin', parentAsin)
        .eq('field', c.field)
        .eq('status', 'accepted')
        .limit(1)
      if (((data ?? []) as unknown[]).length > 0) shipped.push(c.field)
    }))

    let fields = decideReconcileFields({ candidates, shippedFields: shipped, titleLocked })
    if (fields.length === 0) return

    // STREAMED-PUSH RECENCY GUARD (adversarial review 2026-08-08): a single-field Ship streams
    // /api/fba/listing-optimizer/push-content directly — no push_jobs row, no verification task
    // until it finishes — so the open-jobs dedupe below cannot see it, and a reconcile job could
    // interleave with an in-flight manual push (worst case: transiently re-PATCHing an old AI
    // title over a just-typed manual one). ANY keyword_push_log row (any status) for this parent
    // in the last 10 minutes marks the field as recently-in-flight → skip it this round; the
    // next regen or the verify cron re-covers it. Best-effort: on a query error the GUARD is
    // skipped (loudly logged), never the enqueue — but never silently.
    try {
      const sinceIso = new Date(Date.now() - RECENT_PUSH_WINDOW_MS).toISOString()
      const { data: recent, error: recentErr } = await db
        .from('keyword_push_log')
        .select('field')
        .eq('parent_asin', parentAsin)
        .in('field', fields)
        .gte('pushed_at', sinceIso)
        .limit(1000)
      if (recentErr) throw new Error(recentErr.message ?? String(recentErr))
      const recentFields = new Set(((recent ?? []) as { field?: string }[]).map((r) => r.field))
      fields = fields.filter((f) => {
        if (recentFields.has(f)) console.log(`[CONTENT_RECONCILE] parent=${parentAsin} field=${f} skipped=recent-push-activity(<10m)`)
        return !recentFields.has(f)
      })
    } catch (e) {
      console.warn(`[CONTENT_RECONCILE] parent=${parentAsin} recency-guard query FAILED — proceeding without the guard:`, e instanceof Error ? e.message : e)
    }

    // Double-push dedupe (best-effort, fail-open — the executor's already-equal skip is the
    // real idempotence net): drop fields already covered by a queued/running push_jobs row.
    // (No verification-task dedupe — see the module docstring: a pending task verifies the
    // OLD bytes, so skipping here would silently drop the updated content; the executor's
    // loadDiff changed-filter + enqueueVerification's abandon-then-insert already prevent
    // double-shipping.)
    try {
      const { data: openJobs } = await db
        .from('push_jobs')
        .select('field, payload')
        .eq('parent_asin', parentAsin)
        .in('status', ['queued', 'running'])
      const jobs = (openJobs ?? []) as { field?: string | null; payload?: { core_fields?: string[] } | null }[]
      fields = fields.filter((f) => {
        const covered = jobs.some((j) =>
          j.field === f
          || (j.field === 'core_bulk' && (!j.payload?.core_fields?.length || j.payload.core_fields.includes(f))))
        if (covered) console.log(`[CONTENT_RECONCILE] parent=${parentAsin} field=${f} skipped=open-push-job`)
        return !covered
      })
    } catch { /* dedupe is advisory */ }
    if (fields.length === 0) return

    // SHADOW: everything above ran for real — log the exact decision, insert nothing.
    if (mode === 'shadow') {
      console.log(`[CONTENT_RECONCILE] would-enqueue parent=${parentAsin} fields=${fields.join(',')} (shadow mode — no insert)`)
      return
    }

    // ONE coalesced core_bulk job through the queue Ship-all-core uses. Executor deps are
    // dynamic imports so the pure helpers above stay a testable leaf (no env at import time).
    // NOTE (accepted risk): the open-jobs SELECT above and this INSERT are not atomic, so two
    // concurrent regens of the same parent can stack a duplicate row — bounded to queue churn
    // by the module-level serialized job chain (pushJobs.ts) + the second job's loadDiff
    // finding live already equal → 'Nothing to ship' no-op.
    const { randomUUID } = await import('node:crypto')
    const { SYSTEM_ACTOR } = await import('@/lib/fba/pushExecutor')
    const { enqueueJobRun } = await import('@/lib/fba/pushJobs')
    const payload: PushParams = {
      parent_asin: parentAsin,
      field: 'core_bulk',
      core_fields: fields,
      cancel_token: randomUUID(),
      actor: SYSTEM_ACTOR,
    }
    const { data: ins, error: insErr } = await db
      .from('push_jobs')
      .insert({
        parent_asin: parentAsin,
        field: 'core_bulk',
        detail_field: null,
        payload,
        status: 'queued',
        message: 'Queued (auto-reconcile)…',
      } as never)
      .select('id')
    if (insErr) {
      console.warn(`[CONTENT_RECONCILE] parent=${parentAsin} enqueue failed (non-fatal): ${insErr.message}`)
      return
    }
    const id = (ins as { id: string }[] | null)?.[0]?.id
    if (!id) return
    for (const f of fields) {
      console.log(`[CONTENT_RECONCILE] parent=${parentAsin} field=${f} reason=changed+previously-shipped`)
    }
    enqueueJobRun(id)
  } catch (e) {
    console.warn(`[CONTENT_RECONCILE] parent=${parentAsin} skipped (non-fatal):`, e instanceof Error ? e.message : e)
  }
}
