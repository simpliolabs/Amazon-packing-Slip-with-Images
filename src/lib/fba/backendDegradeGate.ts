/**
 * Backend degrade rules (Task #103 → #157). ONE home for the byte floors and the preserve
 * decisions both write paths share — the dual-write-path invariant module (the B0H9VDCBZJ class:
 * fresh 70B backend shipped over the prior 207B because the partial path had no preserve).
 *
 * HISTORY — BACKEND_DEGRADE_STRICT flag RETIRED 2026-08-03 (#157 Step 2, per the recorded
 * doctrine): its ON mode (220 producing floor + whole-run throw) was live but strictly worse than
 * the successor — the ship census measures the POST-AUDIT bytes at 220 unconditionally and
 * degrade-marks, routing BOTH write paths into the better-than-prior preserve (PR #480), which
 * keeps the healthy sections instead of throwing away all six. The producing gate keeps the cheap
 * catastrophic 190 floor (BACKEND_MIN_LEGACY); census owns the doctrine 220 (BACKEND_MIN_STRICT).
 *
 * Related: memory fba-backend-degrade-gate-silent-preserve, ai-recommendations-dual-write-path,
 * fba-generation-invariants INVARIANT 2/3.
 */
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'

/** Catastrophic producing-gate floor (the generator-side cheap check). */
export const BACKEND_MIN_LEGACY = CONTENT_CONTRACT.keywords.minLegacy
/** Doctrine floor per fba-generation-invariants — the golden band is 240-250, floor is 220.
 *  Enforced by the ship census on the post-audit bytes, not by the producing gate. */
export const BACKEND_MIN_STRICT = CONTENT_CONTRACT.keywords.minStrict

/** Attempt to preserve prior per-child keyword rows over a degraded fresh regen. Returns the
 *  parsed prior list or null. Kept side-effect free so the callers own their own logging + audit.
 *  The parse rules mirror the full path preserve at ai-recommendations/route.ts:1246-1258:
 *   - JSON.parse the priorKwJson;
 *   - accept only a non-empty array;
 *   - require at least one row with a non-empty keywords string;
 *   - anything else → null (caller decides: throw, persist-degraded, or emit warning). */
export function tryParsePriorKeywords(priorKwJson: string | null | undefined): { sku: string; asin: string; keywords: string }[] | null {
  if (!priorKwJson) return null
  try {
    const prior = JSON.parse(priorKwJson) as { sku: string; asin: string; keywords: string }[]
    if (Array.isArray(prior) && prior.length > 0 && prior.some((p) => (p?.keywords ?? '').trim())) return prior
    return null
  } catch {
    return null
  }
}

/** Worst-child byte length across per-child keyword rows (0 when no non-empty row). This is THE
 *  preserve comparator: a family is only as indexed as its thinnest child. Extracted from the
 *  full-path inline (route.ts Phase-3 block) so the partial section-regen path shares the SAME
 *  rule — the dual-write-path invariant this module exists for. */
export function minKeywordBytes(rows: { keywords?: string }[] | null | undefined): number {
  const lens = (rows ?? []).map((p) => new TextEncoder().encode(p?.keywords ?? '').length).filter((n) => n > 0)
  return lens.length ? Math.min(...lens) : 0
}

/** Better-than-prior preserve decision for a DEGRADE-MARKED keywords regen (2026-07-31 amendment:
 *  preserve only when the prior is STRICTLY better — a fresh 214B must beat a dirty/short prior).
 *  `contaminatedPrior` lets the caller run its contamination predicate (hasDatedEventContamination)
 *  without this leaf module importing the keyword-engine — a contaminated prior NEVER wins
 *  (the contamination-ratchet fix, PR #470). */
export function shouldPreserveKeywords(opts: {
  prior: { keywords: string }[] | null
  fresh: { keywords?: string }[] | null | undefined
  contaminatedPrior: boolean
}): boolean {
  if (!opts.prior || opts.prior.length === 0) return false
  if (opts.contaminatedPrior) return false
  return minKeywordBytes(opts.prior) > minKeywordBytes(opts.fresh)
}

/** Visible-character length of an HTML description (tags stripped) — the ONE measurer both
 *  write paths use for the description preserve compare. */
export function descriptionVisibleLength(html: string | null | undefined): number {
  return (html ?? '').replace(/<[^>]*>/g, '').length
}

/** Better-than-prior preserve decision for a DEGRADE-MARKED description regen: keep the prior only
 *  when it is strictly longer in VISIBLE chars (an under-floor fresh 898 still beats a prior 719 —
 *  the PR #468 inversion fix). */
export function shouldPreserveDescription(prior: string | null | undefined, fresh: string | null | undefined): boolean {
  if (!(prior ?? '').trim()) return false
  return descriptionVisibleLength(prior) > descriptionVisibleLength(fresh)
}
