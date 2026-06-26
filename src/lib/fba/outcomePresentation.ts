/**
 * outcomePresentation.ts — PHASE C UI, the SINGLE source of verdict copy + color (spec §5 Phase C).
 *
 * The dashboard verdict CHIP (src/app/fba/page.tsx), the Needs-Attention tab filter, and the detail
 * Outcome PANEL (src/app/fba/listing/[asin]/page.tsx) all read from here so the label, the Tailwind
 * tint, and the "STOP rewriting" lever message never drift between the two surfaces. It is a PURE
 * presentation map over the listing_outcome_state ledger fields the GET LEFT-JOINs onto each row
 * (Risk R-MIG7: the verdict is JOINed at read, never mirrored — this file just renders it).
 *
 * The verdict strings MUST match the listing_outcome_state.outcome_verdict CHECK constraint
 * (039_listing_outcome_state.sql): measuring | insufficient_data | won | resurface_regression |
 * non_copy_bottleneck | headroom_rewrite | measurement_stalled.
 */

/** The outcome ledger fields the optimizer GET LEFT-JOINs onto a score row (low-cardinality). */
export interface OutcomeChip {
  verdict: OutcomeVerdict | null
  /** "n" in "Measuring n/2" — COUNT(DISTINCT post-epoch same-fingerprint snapshot_date). */
  snapshots_since_push: number | null
  /** Cron's human-readable "why" + contributing keywords. */
  verdict_reason: string | null
  /** Named lever for a non_copy_bottleneck (reviews/price/ads/velocity); null otherwise. */
  non_copy_lever: NonCopyLever | null
  /** overall_score at the epoch — baseline for the detail panel's "baseline vs current". */
  baseline_overall_score: number | null
  push_epoch_at: string | null
  last_evaluated_at: string | null
}

export type OutcomeVerdict =
  | 'measuring'
  | 'insufficient_data'
  | 'won'
  | 'resurface_regression'
  | 'non_copy_bottleneck'
  | 'headroom_rewrite'
  | 'measurement_stalled'

export type NonCopyLever = 'reviews' | 'price' | 'ads' | 'velocity'

/** Distinct post-epoch same-fingerprint snapshots required before the gate opens (mirrors
 *  outcomeForListing.MIN_POST_EPOCH_SNAPSHOTS — the "2" in "Measuring n/2"). */
export const MEASURE_TARGET = 2

/** The verdicts the Needs-Attention tab surfaces (spec §5: regressed + non_copy_bottleneck + drift).
 *  drift_resurface lives on the lifecycle axis, not the outcome ledger, so the outcome-driven members
 *  are these two; the dashboard's coarse ghost/stale bucket still feeds the rest of the tab. */
export const NEEDS_ATTENTION_VERDICTS: OutcomeVerdict[] = ['resurface_regression', 'non_copy_bottleneck']

export interface VerdictPresentation {
  /** Short chip label, e.g. "Measuring 1/2", "Won", "Non-copy: reviews". */
  label: string
  /** Tailwind chip classes (bg + text), matching the FBA card palette. */
  chipClass: string
  /** Tailwind dot/accent color for the detail panel header. */
  accentClass: string
  /** One-line plain-English meaning for the detail panel. */
  blurb: string
  /** TRUE for the blue non_copy_bottleneck "STOP rewriting" treatment. */
  isNonCopy: boolean
  /** TRUE when this verdict belongs in the Needs-Attention tab. */
  needsAttention: boolean
}

/** The explicit "STOP rewriting — the lever is X" line for a non_copy_bottleneck (spec §5 Phase C). */
export function stopRewritingMessage(lever: NonCopyLever | null): string {
  const l = lever || 'reviews'
  return `STOP rewriting — the lever is ${l}. The copy already shipped and share didn't move; more title/bullet/keyword edits won't help. Work ${l} instead.`
}

/**
 * Map a ledger row → chip + panel presentation. Returns null when there is nothing to show
 * (no verdict yet AND no measuring epoch) so callers can render nothing for un-pushed listings.
 */
export function presentOutcome(o: OutcomeChip | null | undefined): VerdictPresentation | null {
  if (!o) return null
  const v = o.verdict
  const n = o.snapshots_since_push ?? 0

  // No terminal verdict yet but an epoch is stamped → it's measuring (chip shows n/2 progress).
  if (!v || v === 'measuring' || v === 'insufficient_data') {
    if (!o.push_epoch_at && !v) return null // never pushed → no outcome surface
    return {
      label: `Measuring ${Math.min(n, MEASURE_TARGET)}/${MEASURE_TARGET}`,
      chipClass: 'bg-sky-100 text-sky-700',
      accentClass: 'bg-sky-400',
      blurb: `Measuring outcome — ${n}/${MEASURE_TARGET} post-push SQP snapshots collected (real warm-up is ~2-3 months).`,
      isNonCopy: false,
      needsAttention: false,
    }
  }

  switch (v) {
    case 'won':
      return {
        label: 'Won',
        chipClass: 'bg-emerald-100 text-emerald-700',
        accentClass: 'bg-emerald-500',
        blurb: 'Won — keyword share rose since the pushed copy went live (beat the cohort baseline).',
        isNonCopy: false,
        needsAttention: false,
      }
    case 'resurface_regression':
      return {
        label: 'Regressed',
        chipClass: 'bg-red-100 text-red-700',
        accentClass: 'bg-red-500',
        blurb: 'Regressed — share fell since the push across consecutive evaluations (debounce met). Re-work the copy.',
        isNonCopy: false,
        needsAttention: true,
      }
    case 'non_copy_bottleneck':
      return {
        label: `Non-copy lever: ${o.non_copy_lever || 'reviews'}`,
        chipClass: 'bg-blue-100 text-blue-700',
        accentClass: 'bg-blue-500',
        blurb: stopRewritingMessage(o.non_copy_lever),
        isNonCopy: true,
        needsAttention: true,
      }
    case 'headroom_rewrite':
      return {
        label: 'Headroom',
        chipClass: 'bg-amber-100 text-amber-700',
        accentClass: 'bg-amber-500',
        blurb: 'Headroom — share stayed flat under unchanged copy. Stronger copy can still help; routed back to Needs Work.',
        isNonCopy: false,
        needsAttention: false,
      }
    case 'measurement_stalled':
      return {
        label: 'Measuring stalled',
        chipClass: 'bg-slate-100 text-slate-600',
        accentClass: 'bg-slate-400',
        blurb: 'Measuring stalled — no 2nd post-push SQP month materialized in time. Confirm the keyword sync is running for this listing.',
        isNonCopy: false,
        needsAttention: false,
      }
    default:
      return null
  }
}
