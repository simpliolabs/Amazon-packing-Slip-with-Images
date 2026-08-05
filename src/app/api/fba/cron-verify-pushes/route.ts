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
import { executePush, healParentAttributes, healParentComposite, healChildTwinComposite, checkHealFamilyIntegrity, SYSTEM_ACTOR } from '@/lib/fba/pushExecutor'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

const MAX_PER_RUN = 10
const BUDGET_MS = 4 * 60 * 1000
/** STUCK-RUNNING WATCHDOG threshold (adversarial review 2026-07-02, fix 4b): a task claimed
 *  pending→running by a cron invocation that died mid-task (deploy, OOM, serverless kill) is stranded
 *  at 'running' FOREVER — nothing else ever touches running rows. 15 min comfortably exceeds the
 *  route's own lifetime (maxDuration 600s), so anything older is provably orphaned. */
const STUCK_RUNNING_MS = 15 * 60 * 1000

interface VerifyResult {
  matched: number
  stale: number
  total: number
  results: { sku: string; matches: boolean; isParent?: boolean }[]
  error?: string
}

/** Call verify-push internally and return the parsed counts + per-SKU matches. */
async function runVerify(origin: string, parent_asin: string, field: string, detailKey: string | null): Promise<VerifyResult> {
  // LOUD single-cause failure (adversarial): without CRON_SECRET the self-fetch below can't
  // authenticate against the middleware gate — fail with one diagnosable error instead of
  // burning task attempts on per-task "verify HTTP 401"s.
  if (!process.env.CRON_SECRET) return { matched: 0, stale: 0, total: 0, results: [], error: 'CRON_SECRET not configured — internal verify self-fetch cannot authenticate' }
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
  // x-cron-secret (2026-07-08): the middleware API gate now 401s credential-less requests —
  // this internal self-fetch goes over real HTTP, so it must present the cron credential or
  // every verify task soft-fails ("verify HTTP 401") and the auto-verify + self-heal loop dies.
  const resp = await fetch(url.toString(), { cache: 'no-store', headers: { 'x-cron-secret': process.env.CRON_SECRET ?? '' } })
  if (!resp.ok) return { matched: 0, stale: 0, total: 0, results: [], error: `verify HTTP ${resp.status}` }
  const j = await resp.json() as { matched?: number; stale?: number; total?: number; results?: { sku: string; matches: boolean }[]; error?: string }
  if (j.error) return { matched: 0, stale: 0, total: 0, results: [], error: j.error }
  return {
    matched: j.matched ?? 0, stale: j.stale ?? 0, total: j.total ?? 0,
    results: j.results ?? [],
  }
}

/** STRUCTURAL error classifier (2026-07-20, PO family-split incident). Errors that no amount of retrying
 *  can fix — the underlying CONDITION (a too-long live title; a pre-launch attribute) must change first.
 *  When EVERY failing SKU in a re-push carries one of these, the cron circuit-breaks to needs_attention
 *  instead of rescheduling; otherwise the cron hammers Amazon every ~25 min for a full day (24h+ of
 *  identical "N/N variants (X failed)" seen on B0DQ5YZH38 + B0FKKN8XKV) and — evidence from the split
 *  incident — may contribute to Amazon detaching the problem SKUs into a new variation family.
 *
 *  Kept intentionally NARROW: only patterns we KNOW cannot be fixed by a plain retry. Transient errors
 *  (429, 5xx, connection resets) do NOT match and stay on the normal reschedule path. */
function isStructuralError(err: string | null | undefined): boolean {
  if (!err) return false
  return /\b100476\b/.test(err)                                       // "provide an Item Name that is 75 characters or less"
    || /75 characters? or less/i.test(err)                            // paraphrased 100476
    || /currently unsupported/i.test(err)                             // Item Highlights pre-launch API wall
    || /Amazon hasn't opened API writes/i.test(err)                   // our friendly wrapper of the same
    || /rejected every known write form/i.test(err)                   // composite write-form calibration exhausted
}

/** Re-push ONLY the stale SKUs for this task (selective push via the existing skus[]
 *  parameter). Returns the accept/fail counts plus per-SKU errors so the caller can circuit-break
 *  when every failure is structural (see isStructuralError). */
async function rePushStale(task: PushVerificationTask, staleSkus: string[]): Promise<{
  pushed: number; failed: number; perSkuErrors: { sku: string; error: string }[]; error?: string
}> {
  if (staleSkus.length === 0) return { pushed: 0, failed: 0, perSkuErrors: [] }
  let pushed = 0
  let failed = 0
  let error: string | undefined
  const perSkuErrors: { sku: string; error: string }[] = []
  const captureEvt = (evt: unknown) => {
    const e = evt as { type?: string; status?: string; sku?: string; error?: string; pushed?: number; failed?: number }
    if (e.type === 'result') { pushed = e.pushed ?? 0; failed = e.failed ?? 0 }
    else if (e.type === 'error') { error = e.error }
    else if (e.type === 'progress' && e.status === 'failed' && e.sku && e.error) {
      perSkuErrors.push({ sku: e.sku, error: e.error })
    }
  }
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
      }, captureEvt)
    } else {
      // Regular field (title/bullets/description/keywords) — selective re-push via skus[].
      await executePush({
        parent_asin: task.parent_asin,
        field: task.field,
        skus: staleSkus,
        actor: SYSTEM_ACTOR,  // cron/verify-initiated re-push (spec §5 Phase B attribution)
      }, captureEvt)
    }
  } catch (e) { error = e instanceof Error ? e.message : String(e) }
  return { pushed, failed, perSkuErrors, error }
}

/** Run a SELF-HEAL task (kind='heal'): inherit the parent hub's missing BROADCAST attributes from a
 *  live child (VALIDATION_PREVIEW → LIVE inside healParentAttributes). "Converged" means everything
 *  eligible either healed or was safely abstained (child disagreement / none carries it — nothing we
 *  can deterministically do), with NOTHING left in the failed bucket. A `failed` entry rides the
 *  queue's attempts/backoff and eventually needs_attention (the caller decides). Best-effort. */
async function runHeal(task: PushVerificationTask): Promise<{ converged: boolean; healed: string[]; abstained: string[]; failed: string[]; error?: string; errors?: Record<string, string> }> {
  const payload = (task.heal_payload ?? null) as HealPayload | null
  if (!payload?.parentSku || !payload.productType || !(payload.missingAttrKeys?.length)) {
    return { converged: true, healed: [], abstained: [], failed: [] }  // nothing actionable → don't retry forever
  }
  try {
    const db = await createAdminClient()
    // COMPOSITE heal (self-healing composite): a rejection naming a composite container (shirt_size) rides
    // the SAME queue/backoff but dispatches to the purpose-built verbatim-mirror + read-back path, NOT the
    // flat healParentAttributes. Absent `composite` → the existing flat path, behavior unchanged.
    const res = payload.twin && payload.composite
      // TWIN heal (2026-08-05, the Later-Gator FBM-block incident): CHILD SKUs whose own composite
      // (shirt_size) is incomplete reject EVERY content write. Mirror the container verbatim from
      // the same-ASIN twin (which is the same size/color by definition) — not from the parent path.
      ? await healChildTwinComposite(db, {
          parent_asin: task.parent_asin,
          productType: payload.productType,
          containerKey: payload.composite.containerKey,
          subKeys: payload.composite.subKeys,
          skus: payload.twin.skus,
        })
      : payload.composite
      ? await healParentComposite(db, {
          parent_asin: task.parent_asin,
          parentSku: payload.parentSku,
          productType: payload.productType,
          containerKey: payload.composite.containerKey,
          subKeys: payload.composite.subKeys,
          // FIX 1 (adversarial review 2026-07-02): thread the queue task's attempts counter through so
          // the strategy-3 complete-write escalation can require PERSISTENCE (2nd+ attempt) — the
          // recorded evidence for it was a persistent internal-error verdict, never a single occurrence.
          attemptNumber: task.attempts,
        })
      : await healParentAttributes(db, {
          parent_asin: task.parent_asin,
          parentSku: payload.parentSku,
          productType: payload.productType,
          missingAttrKeys: payload.missingAttrKeys ?? [],
        })
    return { converged: res.failed.length === 0, healed: res.healed, abstained: res.abstained, failed: res.failed, errors: res.errors }
  } catch (e) {
    return { converged: false, healed: [], abstained: [], failed: payload.missingAttrKeys ?? [], error: e instanceof Error ? e.message : String(e) }
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

  // STUCK-RUNNING WATCHDOG (fix 4b): before claiming, flip tasks stranded at status='running' for
  // longer than STUCK_RUNNING_MS back to 'pending' so the queue self-heals from a killed invocation
  // (the Cloud-Run/serverless void-async lesson: the watchdog lives on the READ path, not just the
  // trigger). Bounded by the status + age filters; race-safe because claimDueTasks' pending→running
  // flip is atomic; best-effort + logged — a watchdog failure never blocks the normal claim.
  try {
    const wdDb = await createAdminClient()
    const cutoff = new Date(Date.now() - STUCK_RUNNING_MS).toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: revived } = await (wdDb as any).from('push_verification_tasks')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('status', 'running')
      .lt('updated_at', cutoff)
      .select('id')
    const revivedCount = ((revived ?? []) as { id: string }[]).length
    if (revivedCount > 0) {
      console.warn(`[cron-verify-pushes] watchdog: reset ${revivedCount} stuck-running task(s) (updated_at < ${cutoff}) back to pending`)
    }
  } catch (e) {
    console.warn('[cron-verify-pushes] stuck-running watchdog failed (non-fatal):', e instanceof Error ? e.message : e)
  }

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
      // 0a) DELAYED FAMILY-INTEGRITY CHECK (adversarial review 2026-07-02, fix 3): a confirmed
      //     strategy-3 complete write enqueues this ONE-SHOT task (field 'heal:family-check',
      //     now+6h, max_attempts 1) because variation DE-LINKING caused by a per-variant `size` on
      //     the hub only manifests on Amazon's 15min-6hr catalog lag — invisible to the heal's own
      //     read-back. Re-read the live relationships: family gone/shrunk → needs_attention with a
      //     clear seller message; intact → complete. A failed GET soft-fails (OUR read, not a
      //     verdict) so the next tick re-checks without consuming the single attempt. This branch
      //     runs BEFORE runHeal — a familyCheck payload has no missingAttrKeys and must never fall
      //     into the heal dispatch. Best-effort, non-throwing (checkHealFamilyIntegrity never throws).
      const healPayload = (task.heal_payload ?? null) as HealPayload | null
      if (healPayload?.familyCheck) {
        const fc = await checkHealFamilyIntegrity({
          parentSku: healPayload.parentSku,
          recordedChildCount: healPayload.familyCheck.childCount,
        })
        if (fc.fetchFailed) {
          await softFailTask(task.id, `family-integrity check could not read the live record: ${fc.detail}`)
          processed.push({ id: task.id, field: task.field, result: 'family_check_soft_fail', matched: 0, total: 0 })
        } else if (!fc.intact) {
          await flagNeedsAttention(task.id, 0, 1, [], `family integrity changed after complete-write heal - verify variation family in Seller Central (${healPayload.familyCheck.containerKey}: ${fc.detail})`)
          processed.push({ id: task.id, field: task.field, result: 'family_check_needs_attention', matched: 0, total: 1 })
        } else {
          await completeTask(task.id, 1, 1)
          processed.push({ id: task.id, field: task.field, result: 'family_check_ok', matched: 1, total: 1 })
        }
        continue
      }
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
        // COMPOSITE heal terminal copy (heal v3/v4): when the strategy-3 complete-write fallback ran
        // (its error strings carry the 'complete-write fallback' marker set by pushExecutor), say the
        // automated strategies were tried so the dead-end doesn't read like a single-path give-up —
        // and when the strategy-4 preview negotiation ALSO ran (marker 'negotiation iter'), name it too.
        const triedNegotiation = Object.values(heal.errors ?? {}).some((v) => v.includes('negotiation iter'))
        const triedBoth = Object.values(heal.errors ?? {}).some((v) => v.includes('complete-write fallback'))
        const strategiesNote = triedNegotiation
          ? ' All automated strategies (delete-partial-container, complete-write, and iterative preview negotiation) were tried.'
          : triedBoth ? ' Both automated strategies (delete-partial-container and complete-write) were tried.' : ''
        await flagNeedsAttention(task.id, heal.healed.length, heal.healed.length + heal.failed.length, heal.failed, (heal.error || `Could not heal ${heal.failed.join(', ')} after ${task.attempts + 1} attempts — complete it in Seller Central.`) + strategiesNote + why)
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
    // CIRCUIT BREAKER (2026-07-20, PO family-split incident): if the re-push ACCEPTED nothing AND every
    // failing SKU came back with a STRUCTURAL error (title too long / attribute pre-launch / all write-
    // forms rejected), retrying cannot fix the condition — flag needs_attention NOW instead of scheduling
    // another 25-min-later retry that will fail identically. Kept narrow: requires (a) 0 accepts, (b) EITHER
    // per-SKU errors that ALL match isStructuralError, OR a top-level executor error that itself is
    // structural (composite calibration-exhausted "rejected every known write form" — pushExecutor emits it
    // as an executor 'error' event BEFORE any per-SKU push runs, so it never populates perSkuErrors; the
    // workflow verifier caught this dead pattern on 2026-07-20). A single transient error (429/5xx) in the
    // mix keeps the task on the normal reschedule path.
    const perSkuAllStructural = re.pushed === 0
      && re.perSkuErrors.length > 0
      && re.perSkuErrors.every((e) => isStructuralError(e.error))
    const executorStructural = re.pushed === 0
      && re.perSkuErrors.length === 0
      && isStructuralError(re.error)
    const allStructural = perSkuAllStructural || executorStructural
    if (allStructural) {
      const sample = perSkuAllStructural
        ? re.perSkuErrors[0].error.slice(0, 200)
        : (re.error ?? '').slice(0, 200)
      const source = perSkuAllStructural
        ? `all ${re.perSkuErrors.length} SKU(s) with the same structural error`
        : 'the executor with a structural error (e.g. composite calibration exhausted) before per-SKU push began'
      const reason = `Amazon rejected ${source} — retrying cannot fix this. First error: "${sample}". Address the underlying condition (shorten the live item_name, wait for the Amazon attribute to launch, etc.) and re-push manually.`
      await flagNeedsAttention(task.id, verify.matched, verify.total, staleSkus, reason)
      processed.push({ id: task.id, field: task.field, result: 'needs_attention_structural', matched: verify.matched, total: verify.total })
      continue
    }
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
