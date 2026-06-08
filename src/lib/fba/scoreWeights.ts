/**
 * Importance weights for the six listing sub-scores.
 *
 * Each section is scored 0-25 internally (its own quality). Its contribution to the
 * overall is (score / 25) * weight. The weights SUM TO 100, so a perfect listing scores
 * exactly 100 — there is no 150 ceiling, and weaker-but-less-important sections cost less.
 *
 * Single source of truth for BOTH the stored overall_score (scoreListingContent) and the
 * KPI cards on the listing page. Re-tune by importance here and everything follows.
 */
export const SECTION_WEIGHTS = {
  title:       22,  // #1 ranking factor + biggest CTR driver
  keyword:     20,  // backend + keyword-intelligence coverage = what you actually rank for
  bullets:     18,  // above-the-fold conversion + secondary keyword indexing
  aplus:       16,  // conversion lift (3-10%); body copy is NOT a confirmed ranking field
  description: 12,  // indexed, but A+ usually replaces the description slot
  features:    12,  // structured specs — power Amazon's filtered search + comparison tables
} as const // sum = 100

/** A section's weighted contribution: its raw 0-25 score scaled to its importance weight. */
export function weightedPoints(score25: number, weight: number): number {
  const clamped = Math.max(0, Math.min(25, score25))
  return Math.round((clamped / 25) * weight)
}
