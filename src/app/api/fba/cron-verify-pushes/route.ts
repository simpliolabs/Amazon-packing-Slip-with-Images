/**
 * GET /api/fba/cron-verify-pushes
 * ─────────────────────────────────────────────────────────────────────────────
 * Auto-verify + retry loop for shipped content/details (PO: "Shipping Verification
 * Should be an Automatic Cron JOB"). Picks DUE tasks from push_verification_tasks,
 * runs the live verify, and either completes them or re-pushes the stale SKUs and
 * reschedules — until 100% matched OR max_attempts is hit (needs_attention).
 *
 * Auth: Authorization: Bearer <CRON_SECRET>  OR  x-cron-secret: <CRON_SECRET>
 * (mirrors /api/fba/cron-keyword-sync — Coolify/external scheduler hits this every ~5 min).
 *
 * Time-budgeted: pulls up to MAX_PER_RUN tasks and stops a new one once BUDGET_MS is up,
 * so a single slow verify can't blow past Coolify's maxDuration. Next run picks up the rest.
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  claimDueTasks, completeTask, rescheduleTask, flagNeedsAttention, softFailTask,
  enqueueVerification, type PushVerificationTask, type HealPayload,
} from '@/lib/fba/verificationQueue'
import { executePush, healParentAttributes, healParentComposite, SYSTEM_ACTOR } from '@/lib/fba/pushExecutor'
import { createAdminClient } from '@/lib/supabase/server'

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

/** Call verify-push internally and return the parsed counts + per-SKU matches. */
async function runVerify(origin: string, parent_asin: string, field: string, detailKey: string | null): Promise<VerifyResult> {
  // The verify endpoint expects 'details' (not 'details:<key>') + a friendly detail_field.
  // Our task.field stores 'details:<spApiKey>' so split it.
  let queryField = field
  let detail = ''
  if (field.startsWith('details:')) {
    queryField = 'details'
    // We don't store the friendly name here — but task.detail_field carries it; verify-push
    // also accepts the friendly name. The caller passes detailKey = task.detail_field.
    detail = detailKey ?? ''
  }
  const url = new URL(`${origin}/api/fba/listing-optimizer/verify-push`)
  url.searchParams.set('parent_asin', parent_asin)
  url.searchParams.set('field', queryField)
  if (detail) url.searchParams.set('detail_field', detail)
  const resp = await fetch(url.toString(), { cache: 'no-store' })
  if (!resp.ok) return { matched: 0, stale: 0, total: 0, results: [], error: `verify HTTP ${resp.status}` }
  const j = await resp.json() as { matched?: number; stale?: number; total?: number; results?: { sku: string; matches: boolean }[]; error?: string }
  if (j.error) return { matched: 0, stale: 0, total: 0, results: [], error: j.error }
  return {
    matched: j.matched ?? 0, stale: j.stale ?? 0, total: j.total ?? 0,
    results: j.results ?? [],
  }
}

/** Re-push ONLY the stale SKUs for this task (selective push via the existing skus[]
 *  parameter). Returns true if the executor signalled at least one accept. */
async function rePushStale(task: PushVerificationTask, staleSkus: string[]): Promise<{ pushed: number; failed: number; error?: string }> {
  if (staleSkus.length === 0) return { pushed: 0, failed: 0 }
  let pushed = 0
  let failed = 0
  let error: string | undefined
  try {
    if (task.field.startsWith('details:')) {
      // details branch — needs detail_field (friendly name) + value override (task.expected_value).
      await executePush({
        parent_asin: task.parent_asin,
        field: 'details',
        detail_field: task.detail_field ?? '',
        detail_value_override: task.expected_value ?? undefined,
        skus: staleSkus,
        actor: SYSTEM_ACTOR,  // cron/verify-initiated re-push (spec §5 Phase B attribution)
      }, (evt) => {
        if ((evt as { type?: string }).type === 'result') {
          const r = evt as { pushed?: number; failed?: number; message?: string }
          pushed = r.pushed ?? 0; failed = r.failed ?? 0
        } else if ((evt as { type?: string }).type === 'error') {
          error = (evt as { error?: string }).error
        }
      })
    } else {
      // Regular field (title/bullets/description/keywords) — selective re-push via skus[].
      await executePush({
        parent_asin: task.parent_asin,
        field: task.field,
        skus: staleSkus,
        actor: SYSTEM_ACTOR,  // cron/verify-initiated re-push (spec §5 Phase B attribution)
      }, (evt) => {
        if ((evt as { type?: string }).type === 'result') {
          const r = evt as { pushed?: number; failed?: number }
          pushed = r.pushed ?? 0; failed = r.failed ?? 0
        } else if ((evt as { type?: string }).type === 'error') {
          error = (evt as { error?: string }).error
        }
      })
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  return { pushed, failed, error }
}

/** Run a SELF-HEAL task (kind='heal'): inherit the parent hub's missing BROADCAST attributes from a
 *  live child (VALIDATION_PREVIEW → LIVE inside healParentAttributes). "Converged" means everything
 *  eligible either healed or was safely abstained (child disagreement / none carries it — nothing we
 *  can deterministically do), with NOTHING left in the failed bucket. A `failed` entry rides the
 *  queue's attempts/backoff and eventually needs_attention (the caller decides). Best-effort. */
async function runHeal(task: PushVerificationTask): Promise<{ converged: boolean; healed: string[]; abstained: string[]; failed: string[]; error?: string }> {
  const payload = (task.heal_payload ?? null) as HealPayload | null
  if (!payload?.parentSku || !payload.productType || !(payload.missingAttrKeys?.length)) {
    return { converged: true, healed: [], abstained: [], failed: [] }  // nothing actionable → don't retry forever
  }
  try {
    const db = await createAdminClient()
    // COMPOSITE heal (self-healing composite): a rejection naming a composite container (shirt_size) rides
    // the SAME queue/backoff but dispatches to the purpose-built verbatim-mirror + read-back path, NOT the
    // flat healParentAttributes. Absent `composite` → the existing flat path, behavior unchanged.
    const res = payload.composite
      ? await healParentComposite(db, {
          parent_asin: task.parent_asin,
          parentSku: payload.parentSku,
          productType: payload.productType,
          containerKey: payload.composite.containerKey,
          subKeys: payload.composite.subKeys,
        })
      : await healParentAttributes(db, {
          parent_asin: task.parent_asin,
          parentSku: payload.parentSku,
          productType: payload.productType,
          missingAttrKeys: payload.missingAttrKeys,
        })
    return { converged: res.failed.length === 0, healed: res.healed, abstained: res.abstained, failed: res.failed }
  } catch (e) {
    return { converged: false, healed: [], abstained: [], failed: payload.missingAttrKeys, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authed =
    request.headers.get('authorization') === `Bearer ${cronSecret}` ||
    request.headers.get('x-cron-secret') === cronSecret
  if (!cronSecret || !authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = Date.now()
  const origin = new URL(request.url).origin
  const processed: { id: string; field: string; result: string; matched: number; total: number }[] = []

  // Claim up to MAX_PER_RUN due tasks atomically.
  const claimed = await claimDueTasks(MAX_PER_RUN)
  if (claimed.length === 0) {
    return NextResponse.json({ ok: true, triggered_at: new Date(start).toISOString(), elapsed_ms: Date.now() - start, due: 0, processed: [] })
  }

  for (const task of claimed) {
    if (Date.now() - start > BUDGET_MS) {
      // Time's up — un-claim the remaining tasks so the next cron picks them up. softFail
      // keeps them on the same attempt count (no penalty for OUR budget running out).
      await softFailTask(task.id, 'cron budget exceeded — picked up next tick')
      processed.push({ id: task.id, field: task.field, result: 'deferred_budget', matched: task.last_matched_count ?? 0, total: task.last_total_count ?? 0 })
      continue
    }

    // 0) SELF-HEAL task (kind='heal') — inherit the parent hub's missing broadcast attributes from a
    //    live child, riding the SAME attempts/backoff/max_attempts machinery as verify. On converge,
    //    complete + enqueue a normal content verify so the family's re-push (now that the hub accepts
    //    the PATCH) is confirmed. On residual failure, reschedule (backoff) until max_attempts → flag.
    if (task.kind === 'heal') {
      const heal = await runHeal(task)
      if (heal.converged) {
        await completeTask(task.id, heal.healed.length, heal.healed.length + heal.abstained.length)
        // Now that the hub accepts the PATCH, re-verify the parent's title so the cron re-pushes/
        // confirms it (best-effort; a missed enqueue just means the seller re-pushes manually).
        try { await enqueueVerification({ parent_asin: task.parent_asin, field: 'title' }) } catch { /* non-fatal */ }
        processed.push({ id: task.id, field: task.field, result: `healed:${heal.healed.join(',') || 'none'}`, matched: heal.healed.length, total: heal.healed.length + heal.abstained.length })
      } else if (task.attempts + 1 >= task.max_attempts) {
        // Observability: carry the per-key failure reasons (Amazon preview/live error, read-back detail)
        // into the terminal message so the dead-end names its cause, not just "could not heal".
        const why = heal.errors ? ' Reasons: ' + Object.entries(heal.errors).map(([k, v]) => `${k}: ${v}`).join(' | ') : ''
        await flagNeedsAttention(task.id, heal.healed.length, heal.healed.length + heal.failed.length, heal.failed, (heal.error || `Could not heal ${heal.failed.join(', ')} after ${task.attempts + 1} attempts — complete it in Seller Central.`) + why)
        processed.push({ id: task.id, field: task.field, result: 'heal_needs_attention', matched: heal.healed.length, total: heal.healed.length + heal.failed.length })
      } else {
        // Observability (heal E2E 2026-07-02): persist WHY this attempt failed onto the task row —
        // a rescheduled heal previously left last_error NULL, so the failure was invisible outside
        // the server console and undiagnosable from the DB.
        const note = `attempt ${task.attempts + 1} failed [${heal.failed.join(', ')}]` +
          (heal.errors ? ' - ' + Object.entries(heal.errors).map(([k, v]) => `${k}: ${v}`).join(' | ') : (heal.error ? ` - ${heal.error}` : ''))
        await rescheduleTask(task.id, heal.healed.length, heal.healed.length + heal.failed.length, heal.failed, note)
        processed.push({ id: task.id, field: task.field, result: 'heal_rescheduled', matched: heal.healed.length, total: heal.healed.length + heal.failed.length })
      }
      continue
    }

    // 1) Live verify.
    const verify = await runVerify(origin, task.parent_asin, task.field, task.detail_field)
    if (verify.error || verify.total === 0) {
      await softFailTask(task.id, verify.error || 'verify returned total=0')
      processed.push({ id: task.id, field: task.field, result: 'verify_soft_fail', matched: 0, total: 0 })
      continue
    }

    // 2) 100% matched → done.
    if (verify.matched === verify.total) {
      await completeTask(task.id, verify.matched, verify.total)
      processed.push({ id: task.id, field: task.field, result: 'completed', matched: verify.matched, total: verify.total })
      continue
    }

    // 3) Still stale — out of attempts? Flag for the seller.
    // Never re-push the variation parent — it's a non-buyable hub the executor skips anyway (#244/
    // #245), and verify-push now excludes it from counts; guarding here avoids a wasted no-op patch.
    const staleSkus = verify.results.filter((r) => !r.matches && !r.isParent).map((r) => r.sku)
    if (task.attempts + 1 >= task.max_attempts) {
      await flagNeedsAttention(task.id, verify.matched, verify.total, staleSkus, `Still stale on ${staleSkus.length} SKU(s) after ${task.attempts + 1} attempts.`)
      processed.push({ id: task.id, field: task.field, result: 'needs_attention', matched: verify.matched, total: verify.total })
      continue
    }

    // 4) Have attempts left — re-push the stale SKUs and reschedule the next verify.
    const re = await rePushStale(task, staleSkus)
    void re   // pushed/failed are logged server-side via keyword_push_log; we just bump attempts
    await rescheduleTask(task.id, verify.matched, verify.total, staleSkus)
    processed.push({ id: task.id, field: task.field, result: 'rescheduled', matched: verify.matched, total: verify.total })
  }

  return NextResponse.json({
    ok: true,
    triggered_at: new Date(start).toISOString(),
    elapsed_ms: Date.now() - start,
    due: claimed.length,
    processed,
  })
}
