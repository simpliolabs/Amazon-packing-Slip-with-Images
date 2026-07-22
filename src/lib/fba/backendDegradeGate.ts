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

const MODE = (process.env.BACKEND_DEGRADE_STRICT || 'off').toLowerCase()
export const BACKEND_DEGRADE_STRICT_ON = MODE === 'on'
export const BACKEND_DEGRADE_STRICT_SHADOW = MODE === 'shadow'

/** Legacy floor — kept as the default so flag=off is byte-identical. */
export const BACKEND_MIN_LEGACY = 190
/** Doctrine floor per fba-generation-invariants — the golden band is 240-250, floor is 220. */
export const BACKEND_MIN_STRICT = 220

/** Effective minimum-byte threshold — 220 when flag on, 190 otherwise (legacy + shadow). */
export function backendMinBytesFloor(): number {
  return BACKEND_DEGRADE_STRICT_ON ? BACKEND_MIN_STRICT : BACKEND_MIN_LEGACY
}

/** Log a would-preserve breadcrumb from shadow mode. Called from backendOutputProblems and from the
 *  partial keywords section-regen preserve check. One line per event so logs stay clean.
 *  ctx = 'full' | 'partial' | 'per-design'. */
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
