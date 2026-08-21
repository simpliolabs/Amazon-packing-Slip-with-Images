/**
 * themeFitByDesign.ts — the ONE seam for PER-DESIGN theme fit (pure, no I/O).
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * PO RULING 2026-08-21 (B0DQ5YZH38 BD/BM/DQ/RIACG/RK, refining the per-design IH ruling): a
 * multi-design family's Item Highlight is ONE shared line — design names stripped (each child's
 * title already carries its design) — and every phrase in it must be TRUE FOR EVERY DESIGN. The
 * family card names all five designs at once, so "Motivational Shirts Women" passed under it for the
 * Real King graffiti tee. So the pool is rated against EACH design's card (zero credits — the
 * existing OpenAI raters only) and a phrase composes only when its fit is >= MIN_THEME_FIT under
 * EVERY design: the MIN over designs.
 *
 * STORAGE (migration 061): keyword_analysis.theme_fit_by_design = {"<designKey>": {fit, about}},
 * theme_run_by_design = {"<designKey>": "<runId>"}. Keys are the design keys detectDesignGroups
 * derives from the child SKUs — the same keys per_child_titles / per_child_item_highlights carry.
 *
 * THE TWO RULES (both here so the composer, the route and the tests share one definition):
 *   1. A design is RATED for a pool when >= DESIGN_RATED_MIN_SHARE of the rows carry its fit — the
 *      same 30% the rater uses to accept a run (THEME_RATE_MIN_SHARE) and the composer uses to hold
 *      an unrated pool. Below that there is no judgment to trust for that design.
 *   2. A row's SHARED fit = min over every design; a row missing the fit for ANY design is null
 *      (⇒ excluded by the composer's fit gate). Composition never runs while any design is
 *      unrated — the caller HOLDS with the missing keys named (never a partial judgment).
 */
import type { ThemeBand } from './selection-core'

export interface DesignThemeFit { fit: ThemeBand; about?: string | null }
/** keyword_analysis.theme_fit_by_design as read: designKey → {fit, about}. */
export type ThemeFitByDesign = Record<string, DesignThemeFit>

/** A design counts as RATED for a pool when this share of the rows carry its fit. Pinned equal to
 *  THEME_RATE_MIN_SHARE (themeRatingRun.ts) and the composer's ratedShare gate (0.3) by test. */
export const DESIGN_RATED_MIN_SHARE = 0.3

const isBand = (v: unknown): v is ThemeBand => v === 0 || v === 1 || v === 2 || v === 3

/** Parse the stored jsonb defensively: only well-formed {fit: 0-3} entries survive. */
export function parseThemeFitByDesign(raw: unknown): ThemeFitByDesign | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: ThemeFitByDesign = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || !v || typeof v !== 'object') continue
    const fit = (v as { fit?: unknown }).fit
    if (!isBand(fit)) continue
    const about = (v as { about?: unknown }).about
    out[k] = { fit, about: typeof about === 'string' ? about : null }
  }
  return Object.keys(out).length ? out : null
}

export interface RowWithDesignFit { themeFitByDesign?: ThemeFitByDesign | null }

/** The fit of ONE row under ONE design; null when never rated under it. */
export function designFitOf(row: RowWithDesignFit, designKey: string): ThemeBand | null {
  const e = row.themeFitByDesign?.[designKey]
  return e && isBand(e.fit) ? e.fit : null
}

/** Share of `pool` rows carrying a fit under `designKey` (0 for an empty pool). */
export function ratedShareForDesign(pool: readonly RowWithDesignFit[], designKey: string): number {
  if (pool.length === 0) return 0
  return pool.filter((r) => designFitOf(r, designKey) !== null).length / pool.length
}

/** The design keys whose rating the pool does NOT carry (share < DESIGN_RATED_MIN_SHARE), in the
 *  caller's order. Empty ⇒ every design is rated and the shared line may compose. */
export function unratedDesignKeys(pool: readonly RowWithDesignFit[], designKeys: readonly string[]): string[] {
  return designKeys.filter((k) => ratedShareForDesign(pool, k) < DESIGN_RATED_MIN_SHARE)
}

/** MIN-OVER-DESIGNS: the row's fit under the WORST design; null when any design's fit is missing
 *  (a phrase never judged under a design cannot be claimed true for it). */
export function minFitOverDesigns(row: RowWithDesignFit, designKeys: readonly string[]): ThemeBand | null {
  if (designKeys.length === 0) return null
  let min: ThemeBand | null = null
  for (const k of designKeys) {
    const f = designFitOf(row, k)
    if (f === null) return null
    if (min === null || f < min) min = f
  }
  return min
}
