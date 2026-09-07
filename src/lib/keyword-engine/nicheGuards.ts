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

// Task 7 (2026-09-06): the ONE adult-gender-word core, shared with the title/Item-Highlights truth
// predicate (contentTruth.ts's phraseTruthVerdict rule (c2)) — see the LEAN_FEM_RE/LEAN_MASC_RE
// composition below. contentTruth.ts is a leaf module (verified no import cycle before this task).
import { LEAN_FEM_CORE, LEAN_MASC_CORE } from '@/lib/fba/contentTruth'

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

/** RETAIL apparel brands — a different class from the BLANK brands above, and the gap that let
 *  `nike shirts women` (23,353/mo) and the token pair `grunt`+`style` into a wedding vow-renewal
 *  tee's pool (B0GR22ZHBW, measured 2026-07-30). A shopper searching "nike shirts women" wants
 *  Nike, full stop: we can never rank for it, our copy must never claim it, and spending backend
 *  bytes on it is both wasted indexing and trademark-adjacent. The blank-brand list above only
 *  covers manufacturers you PRINT ON (Gildan, Hanes) — it was never meant to catch the brands you
 *  COMPETE WITH at retail, and nothing else did.
 *  Own-brand-guarded by the caller's `context`, exactly like COMPETITOR_BLANK_BRANDS: a seller whose
 *  own brand appears here keeps its own terms. Deliberately a SHORT, high-confidence list of major
 *  apparel houses — not a general trademark oracle (that is trademarkGuard's job) and not an excuse
 *  to blanket-ban every proper noun ([[dont-overgeneralize-specific-failures]]). */
const COMPETITOR_RETAIL_BRANDS = /\b(?:nike|adidas|puma|reebok|under\s*armou?r|lululemon|patagonia|the\s+north\s+face|columbia\s+sportswear|carhartt|dickies|levi'?s|tommy\s+hilfiger|ralph\s+lauren|calvin\s+klein|champion\s+(?:hoodie|shirt|tee)|grunt\s*style|savage\s+barbell|rothco)\b/i

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
const EQUIPMENT_GOODS_NOUN = /\b(?:accessor(?:y|ies)|balls?|bal[oó]n|balones|pelotas?|gloves?|clubs?|carts?|towels?|umbrellas?|gadgets?|head\s?covers?|divots?|ball\s+markers?|gift\s+sets?)\b/i

/** Any garment word — presence rescues a keyword from the EQUIPMENT_GOODS_NOUN / wholesale nets. */
const GARMENT_TOKEN = /\b(?:t-?\s?shirts?|tshirts?|shirts?|tees?|tops?|tank|hoodies?|sweat\s?shirts?|apparel|clothing|outfit)\b/i

/** Wrong garment CUT / silhouette — a keyword whose shopper wants a DIFFERENT garment shape than this
 *  listing's ("sleeveless printed jerseys" on a short-sleeve tee; B0H7L6KNNX). Caller gates on the
 *  listing itself not being that cut, so a genuinely sleeveless/long-sleeve/cropped listing keeps them. */
const WRONG_GARMENT_CUT = /\b(?:sleeveless|tank\s*tops?|racerback|long[\s-]?sleeves?|crop\s*tops?|cropped)\b/i
/** The listing is a plain short-sleeve tee (so the cuts above are genuinely wrong for it). */
const SHORT_SLEEVE_TEE = /\b(?:t-?\s?shirts?|tshirts?|tees?)\b/i

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
// USA-250 rule pieces — ONE source for both the per-keyword test (isOffNicheKeyword) and the
// whole-soup test (hasDatedEventContamination). Splitting them was how the preserve seam stayed blind.
const USA_250_TOKEN = /\b250(?:th)?\b/
const USA_250_SIGNAL = /\b(?:usa|america(?:n)?|1776|patriotic)\b/
const USA_250_CTX_ESCAPE = /\b(?:250th?|usa|america(?:n)?|patriotic|1776|semiquincentennial)\b/

/** USA-250 dated-event test that also works on a backend token SOUP (a stored recommended_keywords
 *  string), not just a single keyword phrase. Added for the route's preserve seam: live 2026-07-31,
 *  the FRESH backend string came out CLEAN at 214 bytes, the census degrade-marked it for the 220
 *  floor, and the preserve re-persisted the CONTAMINATED 246-byte prior — the two protections were
 *  fighting, and byte-count "better" kept the dirty string forever. A contaminated prior is never
 *  "better". Same context escape: a genuinely patriotic listing keeps its terms. */
export function hasDatedEventContamination(text: string, opts?: { context?: string }): boolean {
  const s = (text || '').toLowerCase()
  if (!s) return false
  const ctx = (opts?.context || '').toLowerCase()
  const hit = (USA_250_TOKEN.test(s) && USA_250_SIGNAL.test(s)) || /\bsemiquincentennial\b/.test(s)
  return hit && !USA_250_CTX_ESCAPE.test(ctx)
}

export function isOffNicheKeyword(keyword: string, opts?: { context?: string }): boolean {
  const kw = (keyword || '').toLowerCase()
  if (!kw) return false
  const ctx = (opts?.context || '').toLowerCase()

  if (isEquipmentNicheKeyword(keyword)) return true                       // golf pegs
  if (FOREIGN_APPAREL_TOKENS.test(kw)) return true                        // foreign-language duplicate

  const brand = kw.match(COMPETITOR_BLANK_BRANDS)?.[0]                     // competitor blank brand,
  if (brand && !ctx.includes(brand)) return true                          //   unless it is our OWN brand

  // Competitor RETAIL brand (Nike, Grunt Style, …) — same own-brand escape hatch, same shape as the
  // blank-brand test above. Split from it because the two are different competitive relationships:
  // a blank brand is what we PRINT ON, a retail brand is who we COMPETE WITH. Only the first was
  // ever guarded, which is how "nike shirts women" reached a vow-renewal tee's keyword pool.
  const retail = kw.match(COMPETITOR_RETAIL_BRANDS)?.[0]
  if (retail && !ctx.includes(retail)) return true

  // America-250 / semiquincentennial (live 2026-07-31, B0GR22ZHBW): "250th anniversary usa shirt"
  // (50K+/mo, the 2026 event spike) seated as CRITICAL on a vow-renewal WEDDING-anniversary tee —
  // it entered while the LLM relevance gate was dead (json-word 400, PR #460) and the CRITICAL
  // protection then shielded it from the revived gate. A dated PUBLIC-EVENT niche is not the
  // wearer's own anniversary. Same context-escape shape as the brand tests above: a genuinely
  // patriotic USA-250 design carries usa/america/250th/1776 in its own copy and KEEPS these terms.
  if (hasDatedEventContamination(kw, opts)) return true

  if (WHOLESALE_INTENT.test(kw) && GARMENT_TOKEN.test(kw)) return true     // "plain/blank t shirts"
  if (ACTIVEWEAR_NICHE.test(kw) && !ACTIVEWEAR_NICHE.test(ctx)) return true // activewear (unless we ARE)
  if (EQUIPMENT_GOODS_NOUN.test(kw) && !GARMENT_TOKEN.test(kw)) return true // gear, not a garment
  // Wrong garment cut — only when THIS listing is a plain short-sleeve tee (a real sleeveless/
  // long-sleeve/cropped listing has that word in its own copy, so it's kept).
  if (WRONG_GARMENT_CUT.test(kw) && SHORT_SLEEVE_TEE.test(ctx) && !WRONG_GARMENT_CUT.test(ctx)) return true

  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// FOREIGN-LANGUAGE net (universe de-contamination, 2026-07-17): the #280 broad-category
// universes ("graphic tees for women") are researched via keywords_by_keyword, whose related-term
// expansion drags in Spanish/Portuguese duplicates ("camisas para hombres", "ropa de hombre").
// `fromUniverse` EXEMPTS a term from the token-overlap relevance gate (it is a deliberate on-product
// category angle the gate would wrongly strip as "generic") — but that exemption is for GENERICNESS,
// never for CONTAMINATION. An English listing's copy can never index a Spanish keyword, so it is a
// different-market duplicate, not a coverable gap. This net is applied to universe AND niche terms
// alike at the pool-entry seams. Deterministic, and language-agnostic on the KEEP side.
// ─────────────────────────────────────────────────────────────────────────────

/** Accented Latin letters (Spanish/Portuguese/French/German) — an English apparel keyword never carries them. */
const NON_ASCII_LETTER = /[áàâãäåéèêëíìîïóòôõöøúùûüñçß]/i

/** Spanish/Portuguese function + shopper words with negligible English collision as WHOLE tokens
 *  ("para hombre", "ropa de mujer", "regalos divertidos"). Deliberately EXCLUDES ambiguous tokens that
 *  appear in English place/event names ("con" in comic con, "los" in los angeles, "las" in las vegas).
 *  The garment nouns + mujer/hombre/niño are already carried by FOREIGN_APPAREL_TOKENS. */
const FOREIGN_FUNCTION_WORDS = /\b(?:para|ropa|regalos?|divertid[oa]s?)\b/i

/**
 * True when a keyword is predominantly non-English — a foreign-market duplicate an English listing's copy
 * can never index for, so it reads as an unfixable "gap" rather than a real one. Deterministic union of:
 * accented characters, the apparel-specific foreign nouns (FOREIGN_APPAREL_TOKENS), and low-collision
 * Spanish/Portuguese function words. Category-agnostic (a foreign keyword is off-niche for ANY listing).
 * The KEEP side is conservative: an all-ASCII English phrase ("mens graphic t-shirts") returns false.
 */
export function isForeignKeyword(keyword: string): boolean {
  const kw = (keyword || '').toLowerCase()
  if (!kw) return false
  if (NON_ASCII_LETTER.test(kw)) return true            // accented → foreign
  if (FOREIGN_APPAREL_TOKENS.test(kw)) return true       // playeras/camisas/mujer/hombre/… (garment nouns)
  if (FOREIGN_FUNCTION_WORDS.test(kw)) return true       // para/ropa/regalos/divertidas (function/shopper words)
  return false
}

/* ── AUDIENCE LEAN ────────────────────────────────────────────────────────────────────────────── */

/** COMPOSED (Task 7, PO ruling 2026-09-06 "1. Extend") from `contentTruth.ts`'s exported
 *  `LEAN_FEM_CORE`/`LEAN_MASC_CORE` — the ONE canonical adult-gender-word lexicon, shared with the
 *  title/Item-Highlights truth predicate (`phraseTruthVerdict`'s rule (c2)) — plus this module's OWN
 *  extra axis words (`female`, `girls?`, `boys?`) that the shared core deliberately does NOT carry:
 *  `girls`/`boys` are the KIDS audience axis there (double-classifying them here would fight that
 *  rule), but THIS predicate's job is broader (any hard-lean keyword exclusion, not a kids/adult
 *  split), so they stay on this module's own extra-word side, same as before.
 *  ⚠️ Composing onto the core (not hand-copying it) is what stops this file's copy from drifting the
 *  way it already had (this file used to carry `female`/`girls?` that `contentTruth.ts` never did —
 *  exactly the class of drift this task ends). `syncListingContent.ts` (~:382) composes the same way.
 *  `listingPipeline.ts` and `rankAnalysis.ts` still carry their OWN independent copies — out of scope
 *  for Task 7 (M1 fix, 2026-09-06: cites the brief's "ONE lexicon, not four" paragraph and the
 *  controller's pre-stage ruling — both name only these two consumers + the core; a prior version
 *  of this comment cited a "task-7-brief.md's Code Organization" section that does not exist, caught
 *  by task-7-review-findings.md M1). Every remaining copy is now enumerated and classified in
 *  `contentTruth.ts`'s sibling test `genderLexiconSingleSource.test.ts`'s `ALLOWLIST`. */
const LEAN_FEM_RE = new RegExp(`\\b(?:${LEAN_FEM_CORE})\\b|\\bfemale\\b|\\bgirls?\\b`, 'i')
const LEAN_MASC_RE = new RegExp(`\\b(?:${LEAN_MASC_CORE})\\b|\\bmale\\b|\\bboys?\\b`, 'i')

/**
 * A HARD audience lean ('male' | 'female' exactly — soft leans like 'lean_female' pass everything)
 * excludes keywords that name ONLY the opposite audience: on a hard-female listing "comfort colors
 * tshirt men" can never convert, so it must never hold a ranking-target seat. Keywords naming both
 * audiences ("mens and womens tee") or neither are kept — cross-gender gift traffic is real.
 */
export function leanExcludesKeyword(keyword: string, hardLean: string | null | undefined): boolean {
  if (hardLean !== 'male' && hardLean !== 'female') return false
  return hardLean === 'female'
    ? LEAN_MASC_RE.test(keyword) && !LEAN_FEM_RE.test(keyword)
    : LEAN_FEM_RE.test(keyword) && !LEAN_MASC_RE.test(keyword)
}
