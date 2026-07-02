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
