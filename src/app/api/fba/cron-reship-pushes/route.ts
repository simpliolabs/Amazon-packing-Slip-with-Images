/**
 * GET /api/fba/cron-reship-pushes
 * ─────────────────────────────────────────────────────────────────────────────
 * GUARDED AUTONOMOUS PUSH→VERIFY→RESHIP LOOP (PO H1). For a push the USER explicitly initiated, this
 * cron VERIFIES which child SKUs/ASINs actually landed on Amazon and RE-PUSHES ONLY the SAME
 * already-approved content for the children that did NOT — looping until all are confirmed or a bound
 * is hit. It NEVER generates new content and NEVER auto-initiates a new push; it only retries DELIVERY
 * of the user's approved content.
 *
 * THIS IS A SEPARATE CRON from cron-verify-pushes (which is the manual-style verify+retry that runs for
 * EVERY push). The autonomous loop is intentionally isolated so its HARD SAFETY gates are obvious and so
 * the default-on verify path is completely unaffected. The autonomous loop only ever touches tasks that
 * EXPLICITLY opted in (auto_reship_enabled=true), and only while the env kill-switch is on.
 *
 * ── HARD SAFETY GATES (all REQUIRED — PO H1) ─────────────────────────────────────────────────────
 *   (a) OPT-IN          : env AUTO_RESHIP_ENABLED must be truthy AND the task must have
 *                         auto_reship_enabled=true (per-listing). Either off ⇒ the whole cron is a NO-OP.
 *   (b) BOUNDED         : max MAX_RESHIP_ATTEMPTS (3) reships per child; then flag needs_attention + STOP.
 *   (c) VERIFY-FIRST /  : we read live verify state BEFORE any re-push and never touch a child already
 *       IDEMPOTENT        confirmed live (the executor itself also skips already-equal SKUs).
 *   (d) SAME-CONTENT    : re-pushes the EXACT content from the user's original approved push — the
 *       ONLY               executor reads the stored recommendation/listing_content for (field, skus),
 *                          which IS the approved content; we pass NO new value and NEVER regenerate.
 *   (e) KILL SWITCH +   : env AUTO_RESHIP_ENABLED is the global kill switch; every reship is LOUD-logged
 *       LOUD LOGGING       ([RESHIP] lines with parent/field/skus/attempt) so every autonomous write is
 *                          auditable.
 *   (f) EPOCH ON        : the outcome epoch is stamped ONLY once the loop CONVERGES (100% confirmed),
 *       CONVERGENCE        via stampOutcomeEpochOnConvergence — never on a partial reship.
 *
 * Attribution: every reship uses SYSTEM_ACTOR (server-initiated re-delivery), recorded on
 * keyword_push_log.pushed_by like the existing verify cron.
 *
 * Auth/shape MIRROR cron-keyword-sync / cron-verify-pushes: Bearer <CRON_SECRET> OR x-cron-secret,
 * BUDGET_MS, MAX_PER_RUN, force-dynamic, maxDuration.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  claimDueReshipTasks, recordReshipAttempt, completeReshipTask, flagNeedsAttention, softFailTask,
  MAX_RESHIP_ATTEMPTS, type PushVerificationTask,
} from '@/lib/fba/verificationQueue'
import { executePush, stampOutcomeEpochOnConvergence, SYSTEM_ACTOR } from '@/lib/fba/pushExecutor'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_PER_RUN = 10
const BUDGET_MS = 4 * 60 * 1000

interface VerifyResult {
  matched: number
  stale: number
  total: number
  results: { sku: string; matches: boolean; isParent?: boolean }[]
  error?: string
}

/** Call verify-push internally and return the parsed counts + per-SKU matches (same as the verify cron). */
async function runVerify(origin: string, parent_asin: string, field: string, detailKey: string | null): Promise<VerifyResult> {
  let queryField = field
  let detail = ''
  if (field.startsWith('details:')) {
    queryField = 'details'
    detail = detailKey ?? ''
  }
  const url = new URL(`${origin}/api/fba/listing-optimizer/verify-push`)
  url.searchParams.set('parent_asin', parent_asin)
  url.searchParams.set('field', queryField)
  if (detail) url.searchParams.set('detail_field', detail)
  const resp = await fetch(url.toString(), { cache: 'no-store' })
  if (!resp.ok) return { matched: 0, stale: 0, total: 0, results: [], error: `verify HTTP ${resp.status}` }
  const j = await resp.json() as { matched?: number; stale?: number; total?: number; results?: { sku: string; matches: boolean; isParent?: boolean }[]; error?: string }
  if (j.error) return { matched: 0, stale: 0, total: 0, results: [], error: j.error }
  return { matched: j.matched ?? 0, stale: j.stale ?? 0, total: j.total ?? 0, results: j.results ?? [] }
}

/** Re-push ONLY the stale SKUs with the SAME approved content (safety c/d). The executor reads the
 *  stored recommendation/listing_content for (field, skus) — that IS the user's approved content — and
 *  skips any SKU already equal to live (idempotent). We pass NO new value. SYSTEM_ACTOR attribution. */
async function rePushStale(task: PushVerificationTask, staleSkus: string[]): Promise<{ pushed: number; failed: number; error?: string }> {
  if (staleSkus.length === 0) return { pushed: 0, failed: 0 }
  let pushed = 0, failed = 0
  let error: string | undefined
  try {
    if (task.field.startsWith('details:')) {
      await executePush({
        parent_asin: task.parent_asin,
        field: 'details',
        detail_field: task.detail_field ?? '',
        detail_value_override: task.expected_value ?? undefined,  // the originally-approved value, not a new one
        skus: staleSkus,
        actor: SYSTEM_ACTOR,
      }, (evt) => {
        if ((evt as { type?: string }).type === 'result') { const r = evt as { pushed?: number; failed?: number }; pushed = r.pushed ?? 0; failed = r.failed ?? 0 }
        else if ((evt as { type?: string }).type === 'error') { error = (evt as { error?: string }).error }
      })
    } else {
      await executePush({
        parent_asin: task.parent_asin,
        field: task.field,
        skus: staleSkus,
        actor: SYSTEM_ACTOR,
      }, (evt) => {
        if ((evt as { type?: string }).type === 'result') { const r = evt as { pushed?: number; failed?: number }; pushed = r.pushed ?? 0; failed = r.failed ?? 0 }
        else if ((evt as { type?: string }).type === 'error') { error = (evt as { error?: string }).error }
      })
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  return { pushed, failed, error }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authed =
    request.headers.get('authorization') === `Bearer ${cronSecret}` ||
    request.headers.get('x-cron-secret') === cronSecret
  if (!cronSecret || !authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // ── SAFETY (a) — GLOBAL KILL SWITCH (safety e). When off, the entire loop is a NO-OP regardless of
  //    any per-listing opt-in. Default OFF: only an explicit truthy env turns it on. ──
  const KILL_SWITCH_ON = /^(1|true|yes|on)$/i.test(process.env.AUTO_RESHIP_ENABLED ?? '')
  if (!KILL_SWITCH_ON) {
    return NextResponse.json({
      ok: true, disabled: true,
      reason: 'AUTO_RESHIP_ENABLED is off — autonomous reship loop is a no-op (kill switch).',
    })
  }

  const start = Date.now()
  const origin = new URL(request.url).origin
  const processed: { id: string; parent_asin: string; field: string; result: string; matched: number; total: number; reship_attempt?: number }[] = []

  // Claim DUE tasks that OPTED IN and are under the per-child bound (safety a + b enforced in the query).
  const claimed = await claimDueReshipTasks(MAX_PER_RUN)
  if (claimed.length === 0) {
    return NextResponse.json({ ok: true, triggered_at: new Date(start).toISOString(), elapsed_ms: Date.now() - start, due: 0, processed: [] })
  }

  for (const task of claimed) {
    if (Date.now() - start > BUDGET_MS) {
      await softFailTask(task.id, 'reship cron budget exceeded — picked up next tick')
      processed.push({ id: task.id, parent_asin: task.parent_asin, field: task.field, result: 'deferred_budget', matched: task.last_matched_count ?? 0, total: task.last_total_count ?? 0 })
      continue
    }

    // 1) VERIFY-FIRST (safety c): read live state before touching anything.
    const verify = await runVerify(origin, task.parent_asin, task.field, task.detail_field)
    if (verify.error || verify.total === 0) {
      await softFailTask(task.id, verify.error || 'verify returned total=0')
      processed.push({ id: task.id, parent_asin: task.parent_asin, field: task.field, result: 'verify_soft_fail', matched: 0, total: 0 })
      continue
    }

    // 2) CONVERGED — all children confirmed live (idempotent: nothing to re-push). Complete + stamp the
    //    outcome epoch ONCE (safety f). The parent hub is excluded from convergence the same way the
    //    executor/verify exclude it (#244/#245).
    if (verify.matched === verify.total) {
      await completeReshipTask(task.id, verify.matched, verify.total)
      const stamped = await stampOutcomeEpochOnConvergence(task.parent_asin)
      console.log(`[RESHIP] CONVERGED parent=${task.parent_asin} field=${task.field} ${verify.matched}/${verify.total} — epoch ${stamped ? 'stamped' : 'stamp-skipped'} (safety f)`)
      processed.push({ id: task.id, parent_asin: task.parent_asin, field: task.field, result: 'converged', matched: verify.matched, total: verify.total })
      continue
    }

    // 3) Still stale. BOUNDED (safety b): already did MAX_RESHIP_ATTEMPTS reships → flag needs_attention
    //    + STOP. (claimDueReshipTasks claims tasks with reship_attempts <= MAX so this at-bound task gets
    //    a final verify pass; if it converged we already returned above at step 2, so reaching here at the
    //    bound means it is genuinely still stale.)
    const staleSkus = verify.results.filter((r) => !r.matches && !r.isParent).map((r) => r.sku)
    const currentReshipAttempts = task.reship_attempts ?? 0
    if (currentReshipAttempts >= MAX_RESHIP_ATTEMPTS) {
      await flagNeedsAttention(task.id, verify.matched, verify.total, staleSkus, `Autonomous reship bound (${MAX_RESHIP_ATTEMPTS}) reached — still stale on ${staleSkus.length} SKU(s). Stopped; needs human attention.`)
      console.warn(`[RESHIP] BOUND-REACHED parent=${task.parent_asin} field=${task.field} stale=${staleSkus.length} — flagged needs_attention + STOP (safety b)`)
      processed.push({ id: task.id, parent_asin: task.parent_asin, field: task.field, result: 'needs_attention_bound', matched: verify.matched, total: verify.total, reship_attempt: currentReshipAttempts })
      continue
    }

    // 3b) SAFETY (d) HARD GATE — same-approved-content is only PROVABLE for `details` fields, where
    //    expected_value pins the originally-approved value. Regular fields (title/bullets/description/
    //    keywords) make the executor RE-READ the live listing_seo_recommendations, which a regen between
    //    the user's approved push and this reship could have DRIFTED — so auto-reshipping them risks
    //    delivering UN-approved copy under the "same content" label. Until origin_submission_id pins the
    //    approved per-SKU values end-to-end, regular-field tasks are NOT auto-reshipped: flag for a human.
    //    (Adversarial-review blocker; the loop is dormant today — not scheduled + env off + no opt-in writer.)
    if (!task.field.startsWith('details:')) {
      await flagNeedsAttention(task.id, verify.matched, verify.total, staleSkus, `Autonomous reship is details-only for now (same-content pinning pending for "${task.field}"). ${staleSkus.length} SKU(s) still stale — needs a manual re-push.`)
      console.warn(`[RESHIP] SKIP-REGULAR-FIELD parent=${task.parent_asin} field=${task.field} — regular-field auto-reship disabled pending origin_submission_id same-content pinning (safety d)`)
      processed.push({ id: task.id, parent_asin: task.parent_asin, field: task.field, result: 'needs_attention_regular_field_unpinned', matched: verify.matched, total: verify.total })
      continue
    }

    // 4) Under the bound — RE-PUSH the SAME approved content for the stale SKUs only (safety c/d), bump
    //    the per-child reship counter, and reschedule the next verify. LOUD logging (safety e).
    console.log(`[RESHIP] attempt ${currentReshipAttempts + 1}/${MAX_RESHIP_ATTEMPTS} parent=${task.parent_asin} field=${task.field} stale=[${staleSkus.join(', ')}] — re-pushing SAME approved content (actor=${SYSTEM_ACTOR.name})`)
    const re = await rePushStale(task, staleSkus)
    if (re.error) console.warn(`[RESHIP] re-push error parent=${task.parent_asin} field=${task.field}: ${re.error}`)
    const newCount = await recordReshipAttempt(task.id, verify.matched, verify.total, staleSkus)
    console.log(`[RESHIP] re-pushed parent=${task.parent_asin} field=${task.field} pushed=${re.pushed} failed=${re.failed} — reship_attempts now ${newCount}/${MAX_RESHIP_ATTEMPTS}`)
    processed.push({ id: task.id, parent_asin: task.parent_asin, field: task.field, result: 'reshipped', matched: verify.matched, total: verify.total, reship_attempt: newCount })
  }

  return NextResponse.json({
    ok: true,
    triggered_at: new Date(start).toISOString(),
    elapsed_ms: Date.now() - start,
    due: claimed.length,
    processed,
  })
}
