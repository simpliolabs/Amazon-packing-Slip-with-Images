/**
 * PURE decision helpers for the composite parent-hub heal (strategies 2/3 in pushExecutor.ts).
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY DEPENDENCY-FREE (no imports, no env, no I/O): these functions decide WHETHER a
 * destructive/escalating action is allowed — the adversarial-review discipline requires smoking them
 * standalone, and a pure module is the only shape a sandbox without DB/API keys can exercise.
 * pushExecutor.ts (SP-API writes) and verificationQueue.ts (queue rows) import from here; this module
 * imports from NOWHERE.
 */

/** One item of a composite attribute container (e.g. one shirt_size entry). */
export type CompositeItem = Record<string, unknown>

/** Does this composite item carry a NON-EMPTY value for `field`? (empty string / empty array = no). */
export function compositeItemCarries(it: CompositeItem, field: string): boolean {
  const v = it[field]
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

/**
 * TOLERANT SUBSET deep-compare for the composite read-back (adversarial review): Amazon can NORMALIZE
 * what we wrote (inject a default language_tag, add/omit marketplace_id, reorder keys) so a byte-exact
 * JSON.stringify compare FALSE-FAILS a value that actually persisted. This returns true iff every LEAF
 * present in `written` is present and equal in `got` — EXTRA keys `got` carries that `written` lacks are
 * ignored (Amazon's own defaults don't count as a drop). A genuinely missing/dropped sub-key still fails
 * (absent in `got`). Objects recurse key-by-key; arrays require same length + element-wise subset; strings
 * compare trimmed; other primitives compare by ===.
 */
export function subsetDeepEqual(written: unknown, got: unknown): boolean {
  if (Array.isArray(written)) {
    if (!Array.isArray(got) || got.length !== written.length) return false
    return written.every((w, i) => subsetDeepEqual(w, got[i]))
  }
  if (written !== null && typeof written === 'object') {
    if (got === null || typeof got !== 'object' || Array.isArray(got)) return false
    const g = got as Record<string, unknown>
    return Object.entries(written as Record<string, unknown>).every(
      ([k, w]) => k in g && subsetDeepEqual(w, g[k]),
    )
  }
  if (typeof written === 'string') {
    return typeof got === 'string' && written.trim() === got.trim()
  }
  return written === got
}

// ── FIX 1 (adversarial review 2026-07-02): strategy-3 trigger classification ─────────────────────

/** The three possible outcomes of a failed delete-preview inside strategy 2. */
export type DeletePreviewFailureAction =
  /** Structured Amazon internal error, PERSISTENT (2nd+ attempt) → strategy-3 complete-write. */
  | 'escalate-complete-write'
  /** Structured Amazon internal error, FIRST attempt → failed bucket; the queue retries the
   *  cleaner delete once before any escalation (the live evidence for strategy 3 was a PERSISTENT
   *  verdict — 3x over 40 min — never a single occurrence). */
  | 'retry-delete'
  /** Anything else (real validation verdict, HTTP transport failure) → plain failed bucket. */
  | 'fail'

/**
 * Does the delete preview's failure carry Amazon's STRUCTURED "internal error" validator verdict?
 * TIGHTENED (adversarial review 2026-07-02, fix 1 — trigger too broad): the old `/internal error/i`
 * test on preview.error ALSO matched HTTP-prefixed transport bodies — patchSkuMulti returns
 * 'HTTP 500: {...}' with NO structured issues for a non-ok response, and a proxy/body echo containing
 * the words "internal error" would have escalated a transport blip straight to a LIVE composite write.
 * The live evidence (2026-07-02, 19:41/19:49/20:17) was a STRUCTURED issues[] verdict with no HTTP
 * prefix. So require BOTH: (a) at least one STRUCTURED issue whose message matches, and (b) the joined
 * error string NOT being an HTTP transport wrapper (belt + braces — an HTTP failure never carries
 * issues[] in the current patchSkuMulti, but this guard survives a future refactor that adds them).
 */
export function deletePreviewSignalsAmazonInternalError(
  preview: { error?: string | null; issues?: { message?: string }[] | null },
): boolean {
  if (/^HTTP \d+:/.test(preview.error ?? '')) return false
  return (preview.issues ?? []).some((i) => /internal error/i.test(i.message ?? ''))
}

/**
 * FULL strategy-3 trigger decision (fix 1): structured internal error AND persistence.
 * attemptNumber is the queue task's `attempts` counter (0 on the first heal attempt): only a 2nd+
 * attempt (attemptNumber >= 1) may escalate — one clean delete retry is always burned first, matching
 * the persistence bar of the original evidence (3 consecutive occurrences over 40 min).
 */
export function classifyDeletePreviewFailure(
  preview: { error?: string | null; issues?: { message?: string }[] | null },
  attemptNumber: number,
): DeletePreviewFailureAction {
  if (!deletePreviewSignalsAmazonInternalError(preview)) return 'fail'
  return attemptNumber >= 1 ? 'escalate-complete-write' : 'retry-delete'
}

// ── FIX 2 (adversarial review 2026-07-02): bounded complete-write convergence evidence ───────────

/** Evidence rows older than this NEVER prove convergence — an eternal accepted row must not mask
 *  every FUTURE different rejection as "healed forever". 7 days comfortably covers the queue's
 *  full retry horizon (3 attempts x 30 min backoff) plus a long cron outage. */
export const HEAL_EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Query-side cap for the evidence scan (ordered pushed_at DESC, so these are the newest rows). */
export const HEAL_EVIDENCE_MAX_ROWS = 20

/** A keyword_push_log heal:complete:<container> row as selected by the convergence check. */
export interface CompleteWriteEvidenceRow {
  id?: string
  new_value?: string | null
  status?: string
  pushed_at?: string | null
}

/**
 * Scan our own heal:complete intent/accept rows for one that PROVES the live container is OUR
 * strategy-3 write (retry-after-crash convergence). Replaces the old unbounded `.limit(1)` pick
 * (adversarial review 2026-07-02, fix 2):
 *  (a) ANY matching row wins — the caller feeds rows ordered pushed_at DESC, not one arbitrary row;
 *  (b) rows outside HEAL_EVIDENCE_WINDOW_MS are ignored (re-checked here even though the caller's
 *      query is also bounded — defense in depth against a caller/query drift);
 *  (c) VACUOUS payloads never converge: the parsed written item must carry EVERY invariant subKey
 *      AND the per-variant field (an empty/partial payload proving nothing must not read as proof);
 *  (d) the match itself is the tolerant subsetDeepEqual of every written sub-key (marketplace_id
 *      excluded — Amazon returns its own) against the LIVE first container item.
 * Returns the matched row's {id, status} so the caller can flip a still-'attempted' intent row to
 * 'accepted' (the audit trail must stop reading as a crash once convergence is confirmed), or null.
 */
export function findCompleteWriteEvidence(
  rows: CompleteWriteEvidenceRow[],
  liveFirstItem: CompositeItem,
  spec: { subKeys: string[]; perVariantField: string },
  nowMs: number = Date.now(),
): { id?: string; status?: string } | null {
  for (const row of rows) {
    // (b) recency bound — stale or untimestamped evidence never converges.
    const ts = row.pushed_at ? Date.parse(row.pushed_at) : NaN
    if (!Number.isFinite(ts) || nowMs - ts > HEAL_EVIDENCE_WINDOW_MS) continue
    if (!row.new_value) continue
    let written: CompositeItem
    try {
      const parsed = JSON.parse(row.new_value) as unknown
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      written = parsed as CompositeItem
    } catch { continue }
    // (c) vacuous-payload guard — the written item must cover the FULL complete-container shape.
    if (![...spec.subKeys, spec.perVariantField].every((k) => compositeItemCarries(written, k))) continue
    // (d) every written sub-key must subset-match the live item.
    const matches = Object.keys(written).filter((k) => k !== 'marketplace_id').every((k) => {
      const got = liveFirstItem[k]
      if (got === undefined || got === null) return false
      return subsetDeepEqual(written[k], got)
    })
    if (matches) return { id: row.id, status: row.status }
  }
  return null
}

// ── STRATEGY 4 (heal v4, LIVE evidence 2026-07-02): iterative preview negotiation ────────────────
// Strategy 3's complete-write preview on Custom-Cup-TS-Parent (SHIRT) was rejected with a NEW class
// of issue: "Based on the data from '[shirt_size#?.size_system, age_range_description.value,
// shirt_size#?.size_class]', the field '"body_type"' for the attribute 'Shirt Body Type' is not
// allowed. Expected at most '0' of field '"body_type"' ..." (identically for Shirt Height Type).
// The complete shirt_size SATISFIED the size rule, but the record ALSO carries shirt_body_type +
// shirt_height_type attributes DISALLOWED ("at most 0") under this data combination. The record is a
// CONDITIONAL WEB: fixing one rule arms another, so no fixed per-error strategy can converge. Amazon's
// VALIDATION_PREVIEW is free/synchronous — so strategy 4 NEGOTIATES: preview, parse the issues, add
// the narrowest safe op per issue, preview again (max NEGOTIATION_MAX_ITERATIONS), and only a fully
// GREEN preview earns the one LIVE write. The loop core lives HERE (dependency-free, preview injected
// as a callback) so the sandbox can smoke the full control flow standalone; pushExecutor.ts wires the
// real SP-API preview/LIVE/read-back around it.

/** Amazon's DISALLOWED-attribute signature: the named field/attribute "is not allowed. Expected at
 *  most '0'" under the record's current data combination. Tolerant of Amazon's mixed quoting and an
 *  optional period, same discipline as conditionalRequirementRegex. */
export const NOT_ALLOWED_AT_MOST_ZERO_RE = /is not allowed\.?\s*Expected at most '?0'?/i

/** Attribute keys the negotiation may NEVER delete, no matter what a preview issue names: the
 *  seller-facing content the push engine exists to manage, the identifiers that anchor the listing,
 *  and EVERYTHING that shapes the variation family (child_ / parent prefixes — deleting those is the
 *  de-linking disaster the family-integrity check exists to catch). Checked via
 *  isNegotiationProtectedAttr, which also blocks the child_/parent prefixes. */
export const NEGOTIATION_PROTECTED_ATTRS = new Set<string>([
  'item_name', 'brand', 'bullet_point', 'product_description', 'generic_keyword',
  'child_parent_sku_relationship', 'parentage_level', 'variation_theme',
  'externally_assigned_product_identifier', 'merchant_suggested_asin',
])

/** Is `key` off-limits for a negotiation delete op? Set membership OR the child_/parent prefixes
 *  (parentage_level, parent_sku, any future parent* key). */
export function isNegotiationProtectedAttr(key: string): boolean {
  return NEGOTIATION_PROTECTED_ATTRS.has(key) || key.startsWith('child_') || key.startsWith('parent')
}

/**
 * Extract candidate snake_case attribute keys from ONE not-allowed issue message, in preference order:
 *  (1) the display name from "for the attribute '<Display Name>'" — lowercase, spaces -> underscores
 *      ('Shirt Body Type' -> 'shirt_body_type'); discarded if the result is not a clean snake_case key;
 *  (2) the field token from "the field '"body_type"'" prefixed with the container FAMILY (the
 *      containerKey's first underscore segment: 'shirt_size' -> 'shirt' -> 'shirt_body_type').
 * Candidates are HYPOTHESES ONLY — the caller must resolve them DEFENSIVELY against the parent's LIVE
 * attributes map (planNotAllowedDeletes) before any delete op exists.
 */
export function candidateKeysFromNotAllowedIssue(message: string, containerKey: string): string[] {
  const out: string[] = []
  const display = /for the attribute\s+'([^']+)'/i.exec(message)?.[1]
  if (display) {
    const key = display.trim().toLowerCase().replace(/\s+/g, '_')
    if (/^[a-z0-9_]+$/.test(key)) out.push(key)
  }
  const field = /the field\s+'"?([a-z0-9_]+)"?'/i.exec(message)?.[1]
  if (field) {
    const family = containerKey.split('_')[0]
    if (family) out.push(`${family}_${field}`)
  }
  return [...new Set(out)]
}

/** One iteration's delete plan: the guardrail-passing keys to delete, plus every issue the planner
 *  could NOT act on (with the reason — observability for the abort message). */
export interface NotAllowedDeletePlan {
  deleteKeys: string[]
  skipped: { message: string; reason: string }[]
}

/**
 * Plan the delete ops for ONE negotiation iteration from the preview's structured issues.
 * A delete op is planned ONLY for a key that passes EVERY guardrail:
 *  (i)  EXISTS on the parent's LIVE attributes map (fetched once by the caller) — a candidate name
 *       Amazon mentions but the record does not carry gets NO op (deleting a ghost proves nothing and
 *       a wrong guess could name a different real attribute);
 *  (ii) is NOT protected (isNegotiationProtectedAttr);
 *  (iii) is NOT the container being written (`containerKey`);
 *  (iv) was not already planned in an earlier iteration (`alreadyPlanned` — a re-named key means the
 *       delete did not clear the issue; re-adding it is no progress and must trip the abort).
 * Resolution is DEFENSIVE: of the issue's candidate keys (display-name form first), the FIRST that
 * exists live is THE attribute the issue names — guardrails then apply to that key alone; a guardrail
 * failure skips the ISSUE (never falls through to a weaker candidate — that would be guess-deleting).
 * `liveParentAttrs` null/unavailable -> every not-allowed issue is skipped (cannot verify safety).
 */
export function planNotAllowedDeletes(
  issues: { message?: string }[],
  liveParentAttrs: Record<string, unknown> | null,
  containerKey: string,
  alreadyPlanned: ReadonlySet<string>,
): NotAllowedDeletePlan {
  const plan: NotAllowedDeletePlan = { deleteKeys: [], skipped: [] }
  const planned = new Set<string>()
  for (const issue of issues) {
    const msg = issue.message ?? ''
    if (!NOT_ALLOWED_AT_MOST_ZERO_RE.test(msg)) {
      plan.skipped.push({ message: msg, reason: 'not a disallowed-attribute (at most 0) issue' })
      continue
    }
    const candidates = candidateKeysFromNotAllowedIssue(msg, containerKey)
    if (candidates.length === 0) {
      plan.skipped.push({ message: msg, reason: 'no attribute key extractable from the message' })
      continue
    }
    // OWN-property check (adversarial self-review): plain-index reads would let a prototype-
    // inherited name ('constructor', 'toString') pass the "exists on the live record" gate for a
    // DELETE op. The attributes map is JSON-parsed, so own-enumerable is the only truth.
    const exists = (k: string) => liveParentAttrs != null &&
      Object.prototype.hasOwnProperty.call(liveParentAttrs, k) &&
      liveParentAttrs[k] !== undefined && liveParentAttrs[k] !== null
    const key = candidates.find(exists)
    if (!key) {
      plan.skipped.push({ message: msg, reason: `no candidate key (${candidates.join(', ')}) exists on the live parent record` })
      continue
    }
    if (isNegotiationProtectedAttr(key)) {
      plan.skipped.push({ message: msg, reason: `attribute '${key}' is protected - never deleted by negotiation` })
      continue
    }
    if (key === containerKey) {
      plan.skipped.push({ message: msg, reason: `attribute '${key}' is the container being written - not deletable` })
      continue
    }
    if (alreadyPlanned.has(key) || planned.has(key)) continue   // no NEW op — progress is judged by the caller
    planned.add(key)
    plan.deleteKeys.push(key)
  }
  return plan
}

/** The exact op shapes patchSkuMulti accepts — a delete op REQUIRES a marketplace-selector value
 *  (a value-less delete is rejected with HTTP 400 InvalidInput; recorded live 2026-07-02). */
export type NegotiationOp =
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'delete'; path: string; value?: unknown }

/** A VALIDATION_PREVIEW verdict as the loop consumes it (structural subset of PatchResult). */
export interface NegotiationPreviewResult {
  ok: boolean
  error?: string | null
  issues?: { message?: string }[] | null
}

/** Preview iterations are hard-capped: the loop converges in 2 on the recorded live evidence; a web
 *  that four free previews cannot untangle needs a human, not more previews. */
export const NEGOTIATION_MAX_ITERATIONS = 4

/** How one negotiation ended. 'converged' is the ONLY outcome that permits a LIVE write.
 *  'no-progress' = an iteration added no new op (unrecognized/protected/absent issues) — durable
 *  dead-end, flag a human. 'exhausted' = still failing after the max preview iterations — same.
 *  'transport' = a preview failed with NO structured issues (HTTP-level) — transient, retry via
 *  the queue, no flag. */
export interface NegotiationLoopOutcome {
  kind: 'converged' | 'no-progress' | 'exhausted' | 'transport'
  iterations: number
  finalOps: NegotiationOp[]
  deletedKeys: string[]
  /** kind !== 'converged': stage-prefixed 'negotiation iter N: ...' detail carrying ALL issue texts. */
  failureDetail?: string
}

/**
 * The strategy-4 negotiation LOOP CORE — dependency-free by design (the preview is an injected
 * callback) so the sandbox smokes the full control flow standalone. Starts from strategy 3's op set
 * and its ALREADY-FAILED preview (iteration 1 — no duplicate SP-API call), then per iteration:
 * parse issues -> plan the narrowest safe ops (planNotAllowedDeletes + the caller's optional
 * `extraOpsForSkippedIssue` extension for ANOTHER registered composite's conditional-requirement)
 * -> add them -> preview again. NO progress or iteration cap -> abort (the caller flags). NOTHING
 * here writes: the caller LIVE-writes finalOps only on kind === 'converged'.
 */
export async function runNegotiationLoop(args: {
  initialOps: NegotiationOp[]
  /** Strategy 3's failed preview — consumed as iteration 1's verdict. */
  initialPreview: NegotiationPreviewResult
  containerKey: string
  marketplaceId: string
  /** The parent's LIVE attributes map, fetched ONCE by the caller (null = unavailable -> no deletes). */
  liveParentAttrs: Record<string, unknown> | null
  preview: (ops: NegotiationOp[]) => Promise<NegotiationPreviewResult>
  /** Extension point for issues the delete planner skipped: return replace ops for ANOTHER known
   *  composite container (donor mirror), or null/[] for none. Kept OUT of this module so the
   *  registry stays in pushExecutor.ts; the loop dedupes whatever comes back by (op, path). */
  extraOpsForSkippedIssue?: (message: string) => NegotiationOp[] | null
}): Promise<NegotiationLoopOutcome> {
  const ops: NegotiationOp[] = [...args.initialOps]
  const deleted = new Set<string>()
  let preview = args.initialPreview
  let lastIssueTexts: string[] = []
  for (let iter = 1; iter <= NEGOTIATION_MAX_ITERATIONS; iter++) {
    if (iter > 1) preview = await args.preview(ops)
    if (preview.ok) return { kind: 'converged', iterations: iter, finalOps: ops, deletedKeys: [...deleted] }
    const issues = preview.issues ?? []
    lastIssueTexts = issues.map((i) => i.message ?? '').filter(Boolean)
    if (issues.length === 0) {
      return {
        kind: 'transport', iterations: iter, finalOps: ops, deletedKeys: [...deleted],
        failureDetail: `negotiation iter ${iter}: preview failed without structured issues (transport-level): ${preview.error ?? 'unknown'}`,
      }
    }
    const plan = planNotAllowedDeletes(issues, args.liveParentAttrs, args.containerKey, deleted)
    const newOps: NegotiationOp[] = plan.deleteKeys.map((k) => (
      { op: 'delete' as const, path: `/attributes/${k}`, value: [{ marketplace_id: args.marketplaceId }] }
    ))
    if (args.extraOpsForSkippedIssue) {
      for (const s of plan.skipped) {
        const extra = args.extraOpsForSkippedIssue(s.message)
        if (extra && extra.length > 0) newOps.push(...extra)
      }
    }
    const fresh = newOps.filter((n) => !ops.some((o) => o.op === n.op && o.path === n.path))
    if (fresh.length === 0) {
      const skippedDetail = plan.skipped.map((s) => `[${s.reason}] ${s.message}`).join(' | ')
      return {
        kind: 'no-progress', iterations: iter, finalOps: ops, deletedKeys: [...deleted],
        failureDetail: `negotiation iter ${iter}: no actionable fix for the remaining issue(s) - ${skippedDetail || lastIssueTexts.join(' | ')}`,
      }
    }
    for (const k of plan.deleteKeys) deleted.add(k)
    ops.push(...fresh)
  }
  return {
    kind: 'exhausted', iterations: NEGOTIATION_MAX_ITERATIONS, finalOps: ops, deletedKeys: [...deleted],
    failureDetail: `negotiation iter ${NEGOTIATION_MAX_ITERATIONS}: preview still failing after the maximum ${NEGOTIATION_MAX_ITERATIONS} iterations - ${lastIssueTexts.join(' | ') || 'no issue texts'}`,
  }
}

/**
 * READ-BACK verifier for a converged negotiation's LIVE write:
 *  (i)  the container's written sub-keys all persisted on the hub's first container item — tolerant
 *       subsetDeepEqual (Amazon may normalize/enrich), marketplace_id excluded (Amazon returns its own);
 *  (ii) EVERY deleted attribute is now ABSENT (undefined/null/empty array).
 * Pure: the caller re-fetches the live attributes and feeds them in. Any failure names the offending
 * key(s) so the task row is diagnosable.
 */
export function verifyNegotiationReadBack(
  liveAttrs: Record<string, unknown>,
  containerKey: string,
  writtenItem: CompositeItem,
  deletedKeys: string[],
): { ok: boolean; detail: string } {
  const raw = liveAttrs[containerKey]
  const first = Array.isArray(raw) && raw.length > 0 && raw[0] != null && typeof raw[0] === 'object' && !Array.isArray(raw[0])
    ? (raw[0] as Record<string, unknown>)
    : null
  if (!first) return { ok: false, detail: `container ${containerKey} is absent or uninspectable on read-back` }
  const writtenKeys = Object.keys(writtenItem).filter((k) => k !== 'marketplace_id')
  const dropped = writtenKeys.filter((k) => {
    const got = first[k]
    if (got === undefined || got === null) return true
    return !subsetDeepEqual(writtenItem[k], got)
  })
  if (dropped.length > 0) return { ok: false, detail: `container sub-key(s) dropped on read-back: ${dropped.join(', ')}` }
  const stillPresent = deletedKeys.filter((k) => {
    const v = liveAttrs[k]
    return !(v === undefined || v === null || (Array.isArray(v) && v.length === 0))
  })
  if (stillPresent.length > 0) return { ok: false, detail: `deleted attribute(s) still present on read-back: ${stillPresent.join(', ')}` }
  return { ok: true, detail: `container ${containerKey} persisted (${writtenKeys.length} sub-keys) and ${deletedKeys.length} deleted attribute(s) confirmed absent` }
}

// ── FIX 3 (adversarial review 2026-07-02): delayed family-integrity check task ───────────────────

/** Queue field for the ONE-SHOT delayed family-integrity check (distinct from 'heal',
 *  'heal:composite' and 'heal:manual' so it never collides on the (parent_asin, field) slot). */
export const FAMILY_CHECK_FIELD = 'heal:family-check'

/** 6 h — past the far edge of Amazon's 15min-6hr catalog-relationship lag, where a variation
 *  de-link caused by the complete write would finally be visible to a relationships read. */
export const FAMILY_CHECK_DELAY_MS = 6 * 60 * 60 * 1000

/**
 * Build the push_verification_tasks row for the one-shot delayed family-integrity check that a
 * CONFIRMED strategy-3 complete write enqueues (fix 3 — the feared harm of a per-variant `size` on
 * the hub is variation DE-LINKING, which manifests on Amazon's 15min-6hr catalog lag and is invisible
 * to the heal's own preview/read-back). max_attempts=1: it is a check, not a retry loop.
 * `childCount` is the live variation child count recorded AT heal time — the shrink baseline.
 */
export function buildFamilyIntegrityTaskRow(
  parent_asin: string,
  args: { parentSku: string; productType: string; childCount: number; containerKey: string },
  nowMs: number = Date.now(),
): {
  parent_asin: string
  field: string
  kind: 'heal'
  heal_payload: {
    parentSku: string
    productType: string
    familyCheck: { childCount: number; containerKey: string }
  }
  status: 'pending'
  attempts: 0
  max_attempts: 1
  next_check_at: string
} {
  return {
    parent_asin,
    field: FAMILY_CHECK_FIELD,
    kind: 'heal',
    heal_payload: {
      parentSku: args.parentSku,
      productType: args.productType,
      familyCheck: { childCount: args.childCount, containerKey: args.containerKey },
    },
    status: 'pending',
    attempts: 0,
    max_attempts: 1,
    next_check_at: new Date(nowMs + FAMILY_CHECK_DELAY_MS).toISOString(),
  }
}
