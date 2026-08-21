/**
 * stickyDetails.ts — STICKY PRODUCT DETAILS gate (PO 2026-08-08: the accepted-pushed
 * "Round Collar" on B0FKKN8XKV was churned back to "Collarless" by a full regen).
 * ─────────────────────────────────────────────────────────────────────────────
 * PRINCIPLE: an accepted `details:<sp_api_key>` push is a STANDING APPROVAL (the
 * manual-title-lock precedent, migration 044). A regen may re-propose a different
 * value for that attribute ONLY when a deterministic spec-truth source disagrees
 * (`value_source==='spec'`, stamped at the pipeline's blank_specs override sites)
 * or — one narrow pair — when a deterministic PO RULING disagrees
 * (`value_source==='ruling'`, today stamped only by the crew-neckline → "Round
 * Collar" collar mapping, honored ONLY against an accepted "Collarless") — never
 * from LLM churn: the mega-audit + dedicated details fill re-answer EVERY
 * attribute from scratch each run, so "changed recommendation" and "LLM noise" are
 * indistinguishable without provenance. Spec beats LLM; LLM never outranks a push.
 *
 * ONE SEAM (dual-write doctrine, [[ai-recommendations-dual-write-path]]): fresh
 * detail proposals exist ONLY on the full ai-recommendations path — the #79 partial
 * early-return never rebuilds details (listingPipeline sets
 * `product_details_improvements: []` for partials; its only detail write is the
 * deterministic blank-brand IH re-net over the STORED — i.e. already-sticky — row),
 * and the pushExecutor write-through / regenerate-item-highlight routes write
 * truth / PO-requested values by definition. So `applyStickyDetails` runs ONCE on
 * the full path: AFTER enum coercion (sp_api_key is stamped, values are enum-cased),
 * BEFORE the live-score gap count (adversarial LOW 2026-08-08: the Features score
 * must count the SAME rows the next sync will read — the #85 no-flip-flop
 * invariant; a snapped row is not a gap), and BEFORE dbPayload. It REPLACES the PDI provenance
 * carry-forward block (PO 2026-08-04) and preserves its behavior for rows without
 * push evidence: prior `current_value` still carries onto fresh rows that lack one.
 *
 * EVIDENCE (no migration): primary = the latest accepted, non-rolled-back
 * keyword_push_log row per `details:<sp_api_key>` (same rows verify-push treats as
 * ground truth). Fallback when that read fails = the prior stored row's
 * write-through mirror (`current_value === recommended_value`, stamped by
 * pushExecutor on every accepted detail push) — fail-closed like the title lock:
 * unreadable evidence must never let fresh LLM output overwrite a pushed value.
 *
 * ITEM HIGHLIGHTS: same rule — but a sticky-snapped IH was brand-netted against the
 * title that shipped AT PUSH TIME, so the caller MUST re-run the blank-brand
 * waterfall net (which caps) against the titles shipping NOW whenever `ihReverted`
 * is true (order per #523: sticky-keep → waterfall net → caps). The per-field
 * "↻ Regen" button (regenerate-item-highlight route) is the explicit-regen escape,
 * mirroring `regenerate_section==='title'` for the manual-title lock.
 */

import { detailValueToString, isItemHighlightsField } from '@/lib/fba/productDetailAttrs'

export type StickyEvidence = 'push-log' | 'prior-equality'

export interface StickyKeptEntry {
  field: string
  kept: string
  rejectedProposal: string
  evidence: StickyEvidence
}

export interface StickyDetailsResult {
  details: Record<string, unknown>[]
  changed: boolean
  /** TRUE when the Item Highlights row was snapped back to the accepted push — the caller
   *  must re-run the blank-brand waterfall net (+ caps) against the titles shipping NOW. */
  ihReverted: boolean
  kept: StickyKeptEntry[]
}

/** The SAME fold matcher the retired carry-forward block used: "Fabric Type",
 *  "fabric_type" and "fabric-type" all fold to "fabrictype", so sp_api_key and
 *  display field_name match each other without a lookup table. */
export function foldDetailKey(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[\s_-]+/g, '')
}

export interface AcceptedPushRow {
  field?: string | null
  new_value?: string | null
  status?: string | null
  rolled_back_at?: string | null
}

/**
 * keyword_push_log rows (ordered pushed_at DESC by the caller) → folded-key map of the
 * latest accepted, non-rolled-back value per `details:<sp_api_key>`. Gate on
 * rolled_back_at, not only status — verify-push's rollback stamps rolled_back_at while
 * leaving status='accepted' (verify-push/route.ts:236 parity).
 */
export function collectAcceptedDetailPushes(rows: AcceptedPushRow[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of rows) {
    const field = String(r.field ?? '')
    if (!field.startsWith('details:')) continue
    if (r.status !== 'accepted' || r.rolled_back_at) continue
    const key = foldDetailKey(field.slice('details:'.length))
    const val = String(r.new_value ?? '').trim()
    if (!key || !val || out.has(key)) continue // first row per key = latest (DESC order)
    out.set(key, val)
  }
  return out
}

type Row = Record<string, unknown> & {
  field_name?: unknown
  sp_api_key?: string
  current_value?: unknown
  recommended_value?: unknown
  value_source?: string
  per_design?: boolean
}

/** k:/f:-keyed lookup over a prior-row map — sp_api_key first, folded field name second
 *  (identical precedence to the retired carry-forward block). */
function lookupPrior(map: Map<string, string>, row: Row): string | undefined {
  return (row.sp_api_key ? map.get(`k:${foldDetailKey(row.sp_api_key)}`) : undefined)
    ?? map.get(`f:${foldDetailKey(row.field_name)}`)
}

/**
 * The sticky gate. PURE (deterministic, no I/O — the console.log default is injectable).
 *
 * Per fresh row with accepted value V:
 *  - fresh === V                 → keep, stamp current_value=V (the "✓ On Amazon" chip renders)
 *  - fresh ≠ V, value_source='spec' → KEEP THE FRESH SPEC VALUE (blank_specs is the one legit
 *                                  re-propose trigger), carry current_value=V so the panel
 *                                  shows the strikethrough old→new + Push
 *  - fresh ≠ V, value_source='ruling' AND V is "Collarless"
 *                                → KEEP THE FRESH RULING VALUE (the crew-neck → "Round Collar"
 *                                  PO ruling; any OTHER accepted collar value still wins)
 *  - fresh ≠ V, anything else    → SNAP recommended_value=V, current_value=V, enum_valid=true
 *                                  (V passed Amazon validation at push), drop stale
 *                                  normalized_from; loud DETAIL_STICKY log
 *  - no V                        → legacy carry-forward: prior current_value only
 * `acceptedByKey === null` = push-log unreadable → fall back to the prior rows'
 * write-through equality mirror (current_value === recommended_value, non-empty).
 */
export function applyStickyDetails(opts: {
  fresh: unknown
  prior: unknown
  /** Folded sp_api_key → accepted pushed value; null = evidence read failed. */
  acceptedByKey: Map<string, string> | null
  log?: (entry: Record<string, unknown>) => void
}): StickyDetailsResult {
  const log = opts.log ?? ((entry: Record<string, unknown>) => console.log(JSON.stringify(entry)))
  const fresh: Row[] = Array.isArray(opts.fresh) ? (opts.fresh as Row[]) : []
  const prior: Row[] = Array.isArray(opts.prior) ? (opts.prior as Row[]) : []

  // Prior-row maps: carry-forward source (any non-empty current_value) + the fallback
  // evidence mirror (rows the push write-through stamped current_value === recommended_value).
  const priorCur = new Map<string, string>()
  const priorEqual = new Map<string, string>()
  for (const p of prior) {
    const cur = detailValueToString(p.current_value).trim()
    if (!cur) continue
    const rec = detailValueToString(p.recommended_value).trim()
    const keys = [
      p.sp_api_key ? `k:${foldDetailKey(p.sp_api_key)}` : null,
      p.field_name != null ? `f:${foldDetailKey(p.field_name)}` : null,
    ].filter((k): k is string => !!k)
    for (const k of keys) {
      if (!priorCur.has(k)) priorCur.set(k, cur)
      if (cur === rec && !priorEqual.has(k)) priorEqual.set(k, cur)
    }
  }

  const lookupAccepted = (row: Row): { value: string; evidence: StickyEvidence } | null => {
    if (opts.acceptedByKey) {
      const v = (row.sp_api_key ? opts.acceptedByKey.get(foldDetailKey(row.sp_api_key)) : undefined)
        ?? opts.acceptedByKey.get(foldDetailKey(row.field_name))
      return v ? { value: v, evidence: 'push-log' } : null
    }
    const v = lookupPrior(priorEqual, row)
    return v ? { value: v, evidence: 'prior-equality' } : null
  }

  let changed = false
  let ihReverted = false
  const kept: StickyKeptEntry[] = []

  const details = fresh.map((row) => {
    const fieldName = detailValueToString(row.field_name)
    const freshRec = detailValueToString(row.recommended_value).trim()
    // PER-DESIGN ITEM HIGHLIGHT (PO 2026-08-21): on a multi-design family the IH row is a MARKER
    // (recommended_value '' by construction; the lines live in per_child_item_highlights). An
    // accepted push here is ONE design's line — the old broadcast lie, or the latest per-SKU write
    // — and snapping it onto the marker would recreate exactly the design-specific broadcast the
    // ruling forbids. The marker is never snapped, never carried a value.
    if (row.per_design === true && isItemHighlightsField(fieldName, row.sp_api_key)) {
      log({ tag: 'DETAIL_STICKY', decision: 'per-design-marker', field: fieldName })
      return row
    }
    const acc = lookupAccepted(row)
    if (acc) {
      const accepted = acc.value
      const curAlready = detailValueToString(row.current_value).trim() === accepted
      if (freshRec === accepted) {
        if (curAlready) return row
        changed = true
        return { ...row, current_value: accepted }
      }
      if (row.value_source === 'spec') {
        // Deterministic blank_specs truth disagrees with the accepted value — the ONE legit
        // re-propose trigger (the PO edits the blank_specs row; the fix should surface as Push).
        log({ tag: 'DETAIL_STICKY', decision: 'spec-repropose', field: fieldName, accepted, proposal: freshRec, evidence: acc.evidence })
        if (curAlready) return row
        changed = true
        return { ...row, current_value: accepted }
      }
      if (row.value_source === 'ruling' && /collarless/i.test(accepted)) {
        // NARROW PO-RULING RE-PROPOSE (adversarial MEDIUM 2026-08-08): 'ruling' is stamped by ONE
        // deterministic site — the crew-neckline → "Round Collar" collar mapping (listingPipeline
        // #161 root fix) when the neck truth came from the AUDIT rather than blank_specs — and is
        // honored ONLY when the accepted value it disagrees with is itself the PO-rejected
        // "Collarless". Without this, a blankSpec=NULL family (the exact class the hoisted mapping
        // exists for) with an accepted "Collarless" push — a real PO workflow via bulk Auto Push of
        // the pre-fix audit — would snap the correction back FOREVER: the row can never earn a
        // 'spec' stamp there. An accepted push of any OTHER collar value (e.g. "Henley") still
        // outranks the LLM-derived neck and takes the normal snap below.
        log({ tag: 'DETAIL_STICKY', decision: 'ruling-repropose', field: fieldName, accepted, proposal: freshRec, evidence: acc.evidence })
        if (curAlready) return row
        changed = true
        return { ...row, current_value: accepted }
      }
      // LLM churn (or the stale audience-selector map) NEVER outranks an accepted push.
      kept.push({ field: fieldName, kept: accepted, rejectedProposal: freshRec, evidence: acc.evidence })
      log({ tag: 'DETAIL_STICKY', field: fieldName, kept: accepted, rejectedProposal: freshRec, evidence: acc.evidence })
      changed = true
      if (isItemHighlightsField(fieldName, row.sp_api_key)) ihReverted = true
      const snapped: Row = { ...row, recommended_value: accepted, current_value: accepted, enum_valid: true }
      delete snapped.normalized_from // described the rejected proposal, not the kept value
      return snapped
    }
    // No accepted evidence → the retired carry-forward behavior, byte-for-byte:
    // prior current_value (live-Amazon cache) carries onto a fresh row that lacks one.
    if (!detailValueToString(row.current_value).trim()) {
      const cur = lookupPrior(priorCur, row)
      if (cur) {
        changed = true
        return { ...row, current_value: cur }
      }
    }
    return row
  })

  return { details, changed, ihReverted, kept }
}
