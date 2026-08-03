/**
 * Backend degrade gate (Task #103, PO 2026-07-22). Centralizes the threshold + preserve helper so
 * (a) the full-regen and partial keywords section-regen paths use the SAME rule, closing the
 * dual-write-path invariant break the workflow trace caught on B0H9VDCBZJ (fresh 70B backend
 * shipped over the prior 207B because the partial path had NO preserve gate), and (b) the doctrine
 * 220B floor is a single toggle away from the legacy 190B.
 *
 * Flag: BACKEND_DEGRADE_STRICT = off (default) | shadow | on.
 *   off    — 190B floor, legacy behavior. Byte-identical to today on the full-regen path.
 *   shadow — 190B floor still, but log a [BACKEND_STRICT_DIFF] line when a fresh regen lands
 *            between 190 and 219 bytes so we can see how many listings the ON flip would affect.
 *   on     — 220B floor + throw-on-degrade in full-regen path + preserve gate active on partial
 *            keywords section-regen path (mirrors full path's :1246 block).
 *
 * NOT-A-FLAG note: the partial path's preserve block is a plain missing feature (dual-write-path
 * invariant break, memory ai-recommendations-dual-write-path). We still gate it on the flag for the
 * safest possible rollout — off keeps the missing-feature legacy behavior; on adds the preserve.
 * That way the flip is completely reversible.
 *
 * Related: memory fba-backend-degrade-gate-silent-preserve, fba-generation-invariants INVARIANT 2/3.
 */
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'

const MODE = (process.env.BACKEND_DEGRADE_STRICT || 'off').toLowerCase()
export const BACKEND_DEGRADE_STRICT_ON = MODE === 'on'
export const BACKEND_DEGRADE_STRICT_SHADOW = MODE === 'shadow'

/** Legacy floor — kept as the default so flag=off is byte-identical. */
export const BACKEND_MIN_LEGACY = CONTENT_CONTRACT.keywords.minLegacy
/** Doctrine floor per fba-generation-invariants — the golden band is 240-250, floor is 220. */
export const BACKEND_MIN_STRICT = CONTENT_CONTRACT.keywords.minStrict

/** Effective minimum-byte threshold — 220 when flag on, 190 otherwise (legacy + shadow). */
export function backendMinBytesFloor(): number {
  return BACKEND_DEGRADE_STRICT_ON ? BACKEND_MIN_STRICT : BACKEND_MIN_LEGACY
}

/** Log a would-preserve breadcrumb from shadow mode. Called from backendOutputProblems in
 *  listingPipeline.ts (the shared helper that runs for full-regen, keywords-only partial, and
 *  per-design branches — so path attribution isn't distinguishable here, only the family width).
 *  One line per event so logs stay clean. ctx is a caller-supplied label; today the only caller
 *  passes 'generator-output'. */
export function logShadowDiff(ctx: string, minBytes: number, extra?: Record<string, string | number>): void {
  if (!BACKEND_DEGRADE_STRICT_SHADOW) return
  if (minBytes >= BACKEND_MIN_STRICT) return   // healthy under strict too — nothing to report
  if (minBytes < BACKEND_MIN_LEGACY) return    // already caught by legacy floor — already degraded
  // Only interesting range is 190-219: the flag flip would REPRESERVE these instead of persisting.
  const extras = extra ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ') : ''
  console.log(`[BACKEND_STRICT_DIFF] ${ctx} minBytes=${minBytes} would-preserve-under-strict floor=${BACKEND_MIN_STRICT}${extras}`)
}

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
