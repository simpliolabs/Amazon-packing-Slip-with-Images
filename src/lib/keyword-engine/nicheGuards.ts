/**
 * nicheGuards.ts — deterministic wrong-niche keyword detection for APPAREL listings.
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT CAUSE (B0FRYMM56C, 2026-07-14): the keyword researcher pulled "martini golf tees",
 * "golf tees plastic", "golf tees wood" into a golf-themed SHIRT's CRITICAL/UPGRADE set —
 * those are GOLF PEGS (equipment), not garments. "golf tee(s)" is lexically identical to
 * the garment word, so the LLM relevance gate misses it, and the scorer then docks the
 * listing (-8 description, part of -10 kwgap) for not covering keywords the copy must
 * NEVER contain — a dock no regenerate or ship can clear (the "unfixable dock" anti-pattern).
 *
 * Deterministic net, per [[self-healing-system-directive]] + [[fba-ai-vs-rules-map]]: a
 * systematic, enumerable failure gets a RULE, not another LLM prompt. Scoped TIGHT to the
 * observed class per [[dont-overgeneralize-specific-failures]]: only "golf tee(s)" phrases
 * that carry an EQUIPMENT signal are flagged — "golf tee shirt", "golf tees for women",
 * "funny golf tee" stay valid garment keywords.
 *
 * ONE shared predicate (coherence Invariant 1 discipline): consumed by the scorer
 * (fetchScoringContext) AND the RANK panel (buildFreeCore) so the score docks and the
 * "add this keyword" advice can never disagree about what's on-niche.
 */

/** Equipment-context words that, next to "golf tee(s)", mean the PEG not the SHIRT.
 *  Material/pack/brand/spec words a garment keyword never carries. */
const GOLF_TEE_EQUIPMENT_SIGNALS = new RegExp(
  [
    '\\bplastic\\b', '\\bwood(?:en)?\\b', '\\bbamboo\\b', '\\brubber\\b',
    '\\bbulk\\b', '\\bpack\\b', '\\bcount\\b', '\\bpcs\\b', '\\bpieces\\b',
    '\\bmartini\\b', '\\bcastle\\b', '\\bbrush\\b', '\\bzero\\s*friction\\b', '\\bpride\\b',
    '\\bunbreakable\\b', '\\bbiodegradable\\b', '\\bstep\\s*down\\b',
    '\\b\\d\\s*(?:1/4|3/4|1/2)\\b', '\\b(?:2|3|4)\\s*(?:inch|in)\\b', '\\b\\d{2,4}\\s*mm\\b',
    '\\bholder\\b', '\\bdispenser\\b',
  ].join('|'),
  'i',
)

/** Garment-context words that rescue a "golf tee" keyword back to the shirt niche even if an
 *  ambiguous word co-occurs (defensive: "wooden" + "shirt" is still a shirt search). */
const GARMENT_CONTEXT = /\b(?:shirts?|t-?shirts?|tshirts?|apparel|clothing|outfit|top|tank|hoodie|sweatshirt|wom[ae]ns?|m[ae]ns?|ladies|wife|husband|widow|funny|graphic|vintage|gift)\b/i

/**
 * True when an APPAREL listing's keyword is actually a golf-EQUIPMENT search ("golf tees plastic",
 * "martini golf tees") — the peg, not the shirt. Callers must gate on the listing being apparel;
 * on a genuine golf-accessories listing these keywords are the RIGHT niche.
 */
export function isEquipmentNicheKeyword(keyword: string): boolean {
  const kw = (keyword || '').toLowerCase()
  if (!/\bgolf\s+tees?\b/.test(kw)) return false          // only the observed ambiguous stem
  if (GARMENT_CONTEXT.test(kw)) return false              // garment context wins ("golf tee shirt for women")
  return GOLF_TEE_EQUIPMENT_SIGNALS.test(kw)              // equipment signal → it's the peg
}
