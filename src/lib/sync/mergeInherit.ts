/**
 * mergeInherit.ts — the ONE field-level inherit rule for the SQP-wins keyword merge
 * (Item 3 "Rank column empty" + adversarial MEDIUM, 2026-08-08).
 *
 * CONTRACT (one-directional, SQP wins everything else): SQP rows NEVER carry the four
 * JS-measured fields (engine.ts normalizeSQPRow hardcodes organicRank null, and SQP has no native
 * market metrics), so whole-row SQP precedence silently nulled — for every keyword present in BOTH
 * sources — exactly the values only the JS research path can produce:
 *   - organicRank        (Phase 4b measurement; the original Item-3 fix)
 *   - jsEaseOfRanking    (migration 055 natives — without this inherit the null persisted STICKY:
 *   - jsRelevancyScore    nativeCols' prior-carry had nothing to carry on the first research, and
 *   - marketOpportunity   needsNativeBackfill can never fire once ANY row has the metric, so the
 *                          highest-value dual-source keywords showed the ~gap fallback FOREVER)
 * A field is inherited ONLY when the SQP row has null/undefined and the JS row has a value —
 * SQP keeps winning every other field.
 *
 * PURE + dependency-free so the rule is unit-testable without the sync module's supabase client.
 */

export interface JsMeasuredFields {
  organicRank?: number | null;
  jsEaseOfRanking?: number | null;
  jsRelevancyScore?: number | null;
  marketOpportunity?: number | null;
}

const INHERITED_KEYS = ['organicRank', 'jsEaseOfRanking', 'jsRelevancyScore', 'marketOpportunity'] as const;

/** Returns `existing` (same reference) when nothing inherits; otherwise a copy of `existing` with
 *  ONLY the null-in-existing / non-null-in-js measured fields filled from `js`. */
export function inheritJsMeasurements<T extends JsMeasuredFields>(existing: T, js: JsMeasuredFields): T {
  let out: T | null = null;
  for (const key of INHERITED_KEYS) {
    if (existing[key] == null && js[key] != null) {
      out ??= { ...existing };
      // Write through the supertype view: T[key] may be declared non-optional (`number | null`),
      // but the guard above proves js[key] is a number here.
      (out as JsMeasuredFields)[key] = js[key];
    }
  }
  return out ?? existing;
}
