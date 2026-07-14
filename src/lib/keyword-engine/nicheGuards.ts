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

// ─────────────────────────────────────────────────────────────────────────────
// OFF-NICHE net (B0FRYMM56C, 2026-07-14): golf pegs were only ONE class of the
// researcher's wrong-niche contamination. The same listing's CRITICAL/UPGRADE set
// also carried competitor BLANK brands ("gildan t shirts"), wholesale/blank intent
// ("plain t shirts for women"), off-niche activewear ("oversized workout shirts"),
// a foreign-language duplicate ("grafica tees women"), and a non-apparel goods
// category ("golf accessories") — every one an UNFIXABLE dock: a graphic-tee's copy
// can never (and must never) satisfy them, so they wrongly read as "gaps" and gave
// actively harmful advice ("weave in 'usher and chris brown shirt'"). One predicate,
// consumed by the scorer AND the RANK panel (Invariant 1), scoped per
// [[dont-overgeneralize-specific-failures]]: each class is high-confidence + guarded
// (own-brand kept, real activewear/gear listings keep their terms). The genuinely
// SEMANTIC tail (celebrity merch like "usher and chris brown shirt") is NOT guessed
// here — it belongs to the relevance classifier (keyword_analysis IRRELEVANT tier).
// ─────────────────────────────────────────────────────────────────────────────

/** Blank-apparel wholesale brands a PRINTED graphic tee competes AGAINST, never targets — a shopper
 *  searching "gildan t shirts" wants an unprinted Gildan blank, not our Comfort Colors graphic tee.
 *  Own-brand-guarded by the caller's `context`: if the listing's OWN brand is Gildan, it is kept. */
const COMPETITOR_BLANK_BRANDS = /\b(?:gildan|bella\s*\+?\s*canvas|hanes|jerzees|anvil|tultex|alstyle|fruit\s+of\s+the\s+loom|next\s+level(?:\s+apparel)?|american\s+apparel|port\s*(?:&|and)\s*company|delta\s+apparel)\b/i

/** Wholesale / blank-goods intent — the shopper wants an UNPRINTED shirt, the opposite of a graphic tee. */
const WHOLESALE_INTENT = /\b(?:plain|blank|wholesale|bulk|unprinted)\b/i

/** Activewear / performance niche — a casual garment-dyed cotton graphic tee is NOT athletic wear.
 *  Caller gates on the LISTING itself not being activewear (a genuine gym-tee listing keeps these). */
const ACTIVEWEAR_NICHE = /\b(?:workout|gym|athletic|activewear|jogging|yoga|training|exercise|fitness|dri-?fit|moisture-?wicking|sweat-?wicking|compression)\b/i

/** Foreign-language apparel tokens — an English listing's copy can never satisfy a Spanish/Portuguese
 *  keyword ("grafica tees women", "playeras mujer"); it is a different-market duplicate, not a gap. */
const FOREIGN_APPAREL_TOKENS = /\b(?:gr[aá]fica|playeras?|camisetas?|camisas?|mujer|hombre|ni[nñ][oa]s?|remeras?|franelas?|blusas?|vestidos?)\b/i

/** Physical sport/equipment GOODS categories (not garments): a keyword naming these with NO garment
 *  word is off-niche for an apparel listing ("golf accessories", "golf balls" — gear, not shirts). */
const EQUIPMENT_GOODS_NOUN = /\b(?:accessor(?:y|ies)|balls?|gloves?|clubs?|carts?|towels?|umbrellas?|gadgets?|head\s?covers?|divots?|ball\s+markers?|gift\s+sets?)\b/i

/** Any garment word — presence rescues a keyword from the EQUIPMENT_GOODS_NOUN / wholesale nets. */
const GARMENT_TOKEN = /\b(?:t-?\s?shirts?|tshirts?|shirts?|tees?|tops?|tank|hoodies?|sweat\s?shirts?|apparel|clothing|outfit)\b/i

/**
 * True when an APPAREL listing's keyword is OFF-NICHE — a term this graphic tee competes against or
 * has nothing to do with, that the copy can never (and must never) satisfy, so it is an unfixable
 * dock rather than a real gap. Strict SUPERSET of isEquipmentNicheKeyword (golf pegs); adds
 * competitor-blank brands, wholesale/blank intent, activewear, foreign-language, and non-apparel
 * equipment goods. Does NOT attempt semantic classes (celebrity/band merch) — those are the
 * relevance classifier's job.
 *
 * Callers MUST gate on the listing being apparel (a real gear/activewear listing keeps these terms).
 * `opts.context` = the listing's live copy (haystack), used to (a) NOT exclude the listing's OWN brand,
 * and (b) NOT exclude activewear terms on a genuine activewear listing.
 */
export function isOffNicheKeyword(keyword: string, opts?: { context?: string }): boolean {
  const kw = (keyword || '').toLowerCase()
  if (!kw) return false
  const ctx = (opts?.context || '').toLowerCase()

  if (isEquipmentNicheKeyword(keyword)) return true                       // golf pegs
  if (FOREIGN_APPAREL_TOKENS.test(kw)) return true                        // foreign-language duplicate

  const brand = kw.match(COMPETITOR_BLANK_BRANDS)?.[0]                     // competitor blank brand,
  if (brand && !ctx.includes(brand)) return true                          //   unless it is our OWN brand

  if (WHOLESALE_INTENT.test(kw) && GARMENT_TOKEN.test(kw)) return true     // "plain/blank t shirts"
  if (ACTIVEWEAR_NICHE.test(kw) && !ACTIVEWEAR_NICHE.test(ctx)) return true // activewear (unless we ARE)
  if (EQUIPMENT_GOODS_NOUN.test(kw) && !GARMENT_TOKEN.test(kw)) return true // gear, not a garment

  return false
}
