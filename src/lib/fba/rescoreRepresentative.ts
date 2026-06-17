/**
 * Picks the representative row + scored row-set for a POST-PUSH re-score.
 *
 * Why this exists: pushExecutor drops the variation PARENT ("hub") row from the push diff — Amazon
 * rejects content writes to the non-buyable hub (see pushExecutor.ts, the `parentDropped` filter) — so
 * after a successful push only the CHILD rows are write-through-updated and the parent's listing_content
 * row is STALE. scoreListingContent() prefers `parentContent` as its representative, so for any family
 * whose parent has its own listing_content row AND whose children can't reconstruct the title via
 * longest-common-prefix (a 1-child family, or one with divergent child titles) the re-score would score
 * the PRE-push title/bullets/description — a successful push that doesn't move the score.
 *
 * Fix: when a parent-own row is present, return the FRESH top-child as the representative and drop the
 * stale parent from the scored set. When no parent-own row exists (the common variation family, where
 * listing_content holds only child rows), return the inputs UNCHANGED so the scorer's own freshest-child
 * fallback is preserved — i.e. zero behavior change for normal families.
 *
 * Pure + dependency-free on purpose: the three post-push re-score call sites in pushExecutor.ts share
 * this one tested decision (so they can't drift apart), and the verify script imports it directly.
 */
export function pickRescoreRepresentative<T extends { asin?: unknown }>(
  rows: T[],
  parentAsin: string,
  topChildAsin: string | null,
): { representative: T | null; scoredRows: T[] } {
  const parentRow = rows.find((r) => r.asin === parentAsin) ?? null
  // Common case: no hub row in the set → leave selection to the scorer's own freshest-child fallback.
  if (!parentRow) return { representative: null, scoredRows: rows }

  const childRows = rows.filter((r) => r.asin !== parentAsin)
  // Defensive: a push only re-scores when ≥1 non-parent SKU was accepted, so childRows is normally
  // non-empty. If only the (stale) parent row exists, fall back to prior behavior rather than score
  // an empty set.
  if (childRows.length === 0) return { representative: parentRow, scoredRows: rows }

  // Prefer the top child (the row the display title + scoring context already key on); else the first
  // child. Searching within childRows means a top_child_asin that points at the dropped parent can
  // never re-select the stale parent.
  const representative = (topChildAsin ? childRows.find((r) => r.asin === topChildAsin) : null) ?? childRows[0]
  return { representative, scoredRows: childRows }
}
