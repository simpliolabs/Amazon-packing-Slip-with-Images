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

/**
 * THE SAME measure, but CLAMPED to the contract byte cap — and this clamp is the whole point.
 *
 * THE RATCHET (live incident, B0GVV3XL4T, diagnosed 2026-08-10). `shouldPreserveKeywords` compares
 * raw worst-child bytes. A stored prior can be OVER the 250 cap, because `scrubPub`
 * (listingPipeline.ts:8260, applied to per_child_keywords at :8278) runs AFTER the fill's 250-byte
 * cap and `scrubTrademarks` LENGTHENS what it rewrites ("world cup" -> "world soccer cup"). Every
 * FRESH string, by contrast, is hard-capped at 250 (listingPipeline.ts:596/641,
 * CONTENT_CONTRACT.keywords.byteCap).
 *
 * So a 251-byte prior satisfies `prior > fresh` against EVERY POSSIBLE fresh output, for ever. The
 * family's backend freezes at whatever it held the day it went over cap, and each later regen
 * silently rewrites the row with the prior bytes — generated_at advances, the content does not.
 * Measured: B0GVV3XL4T's 98 children were byte-identical across a full regen even though the
 * keyword pool had changed completely (0 -> 15+ world-cup rows, band-3 2 -> 25).
 *
 * Clamping BOTH sides at the cap makes the comparison answer the question it was always meant to
 * ask — "is the prior better INDEXED?" — instead of rewarding a prior for the one byte Amazon will
 * never accept anyway (the push boundary re-caps at 250: pushFields.ts:101/:162/:431).
 * A prior that is genuinely longer WITHIN the cap still wins, which is the rule's real purpose.
 */
export function cappedMinKeywordBytes(rows: { keywords?: string }[] | null | undefined): number {
  return Math.min(minKeywordBytes(rows), CONTENT_CONTRACT.keywords.byteCap)
}

/** Better-than-prior preserve decision for a DEGRADE-MARKED keywords regen (2026-07-31 amendment:
 *  preserve only when the prior is STRICTLY better — a fresh 214B must beat a dirty/short prior).
 *  `contaminatedPrior` lets the caller run its contamination predicate (hasDatedEventContamination)
 *  without this leaf module importing the keyword-engine — a contaminated prior NEVER wins
 *  (the contamination-ratchet fix, PR #470). */
/**
 * Is the PRIOR itself broken? (2026-08-10 — the fix the byte clamp should have been.)
 *
 * THE DEFECT THE CLAMP DID NOT REACH. "This run's output is degraded" was wired straight to
 * "therefore re-persist the prior verbatim", and the prior was never judged by ANY standard. So a
 * fossil could win for ever on a technicality:
 *   - B0GVV3XL4T's stored backend is 251 bytes on 97 of 98 children, all carrying the SAME
 *     "navy blue royal" colour tail on black/grey/green SKUs, unchanged since June. Every regen
 *     re-persisted it, because the only question ever asked was "is the prior LONGER?".
 * Clamping the byte compare (my first attempt) narrowed the ratchet's tolerance and left the ratchet:
 * the preserve is only reachable when the fresh run is degrade-marked, and the byte-based degrade
 * marks require worst-child < 220, which is below any clamped prior — so the fossil still won.
 *
 * The cure is SYMMETRY: judge the prior by the same standards the fresh output is being judged by.
 * A prior that is over cap, or that has collapsed to one broadcast string across a differentiated
 * family, is not "the safe option" — it IS the defect, and preserving it is how the defect became
 * permanent. PURE; the caller owns contamination + logging.
 */
export function priorIsUnhealthy(prior: { keywords: string }[] | null | undefined): false | string {
  const rows = (prior ?? []).filter((p) => (p?.keywords ?? '').trim())
  if (rows.length === 0) return false
  const over = rows.filter((p) => new TextEncoder().encode(p.keywords).length > CONTENT_CONTRACT.keywords.byteCap)
  if (over.length > 0) return `prior is over the ${CONTENT_CONTRACT.keywords.byteCap}-byte cap on ${over.length}/${rows.length} rows`
  if (rows.length > 1) {
    const counts = new Map<string, number>()
    for (const p of rows) counts.set(p.keywords, (counts.get(p.keywords) ?? 0) + 1)
    const modal = Math.max(...counts.values())
    // Same MAJORITY threshold the fresh-output collapse detector uses, so the two cannot disagree
    // about what "collapsed" means — one rulebook, both sides of the compare.
    if (modal / rows.length > 0.5) return `prior has collapsed: ${modal}/${rows.length} children share one identical string`
  }
  return false
}

export function shouldPreserveKeywords(opts: {
  prior: { keywords: string }[] | null
  fresh: { keywords?: string }[] | null | undefined
  contaminatedPrior: boolean
}): boolean {
  if (!opts.prior || opts.prior.length === 0) return false
  if (opts.contaminatedPrior) return false
  // THE PRIOR MUST CLEAR THE SAME BAR IT IS BEING TRUSTED OVER (2026-08-10). Without this the
  // preserve is a one-way ratchet: once a bad value is stored, every later regen restores it and the
  // family can never heal. A degraded fresh run is a reason to look at the prior, never a reason to
  // trust it unconditionally.
  //
  // The catastrophic floor still protects us in the genuinely-both-bad case: this only lets the FRESH
  // value through, and a fresh value under BACKEND_MIN_LEGACY was already degrade-marked and is
  // handled by the caller's abort-and-preserve, which is a different decision from this one.
  if (priorIsUnhealthy(opts.prior)) return false
  // CLAMPED on both sides — see cappedMinKeywordBytes. Comparing RAW bytes let a prior stored over
  // the 250 cap beat every possible fresh output for ever; the extra byte is one Amazon never
  // receives anyway (pushFields re-caps at 250).
  return cappedMinKeywordBytes(opts.prior) > cappedMinKeywordBytes(opts.fresh)
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
