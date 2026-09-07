/**
 * contentTruth.ts — THE shared content truth spine (PO-approved 2026-08-21, after four live defects
 * on B0DSCDZC6K, a Gildan 18000 sweatshirt + 18500 hoodie family stored `audience_lean='unisex'`).
 *
 * WHAT WENT WRONG. The Item Highlights composer already had a truth stage: ONE pure predicate every
 * candidate phrase had to pass before it could be composed (garment-noun truth, capability claims,
 * kids/adult audience, competitor blanks, weight class). It was wired to the Item Highlight composer
 * and NOWHERE ELSE. Meanwhile:
 *   (a) the TITLE fill appended pool phrases WORD BY WORD with no provenance check, so "mind your
 *       business" shipped as a dangling ", Mind";
 *   (b) the TITLE said "Funny Work Shirts" on a SWEATSHIRT/HOODIE family, because the only garment
 *       net on the title path (`stripContradictedGarments`) grounds in a haystack DERIVED FROM THE
 *       TITLE — when the title carries the lie, the net agrees with it;
 *   (c) the TITLE said "for Women" on a family whose stored audience_lean is 'unisex' — nothing
 *       mapped audience_lean onto any fill;
 *   (d) competitor blank brands were stripped from bullets and description but NOT the title.
 *
 * THE CURE IS ONE SEAM, NOT FOUR NETS. This module owns the predicate; every field's deterministic
 * fill asks it the same question about the same phrase. The rules are BLANK-GROUNDED (resolveFamilyBlank
 * → garment_family / BlankSpec), never title-derived — that is the whole point: a title cannot vouch
 * for itself. `ihTruthVerdict` is re-exported from itemHighlightComposer.ts as a thin wrapper so the
 * composer and its pins are untouched byte-for-byte.
 *
 * FIELD-AGNOSTIC BY DEFAULT. Every rule applies to every field except ONE: `audience-lean-lie`
 * (PO gold pattern "no forced gender"). A unisex family's TITLE is a product claim and may not
 * assert a single gender; its bullets/description/backend carry MARKET vocabulary where a gendered
 * phrase is legitimate shopper language. That asymmetry is the ONLY thing `ctx.field` decides.
 *
 * Pure data + pure functions. No side effects; imports only blankSpecs and designScope's pure token
 * folder (no cycle: designScope imports neither of this module's exports) — safe to import anywhere.
 */
import { trueWeightClass, PERFORMANCE_CLAIM_RE, type BlankSpec, type GarmentFamily } from './blankSpecs'
import { designScopeTokens } from './designScope'

/** The truth stage's garment vocabulary: the blank_specs enum UNFOLDED (kids_tee must reach the
 *  audience rule; long_sleeve_tee names its own spec phrase), plus the title-guess values. */
export type TruthGarmentFamily = GarmentFamily | 'hat' | 'none' | null

/** The content surfaces the spine gates. Only `audience-lean-lie` reads this; see the header.
 *  Task 5 (2026-09-06, item-highlights-per-design plan): `audience-lean-lie` now ALSO reads this on
 *  'highlights' — the Item Highlights composer had no audience-lean rule at all before this task, so
 *  a unisex design's own scoped pool could carry a market "for Women"/"for Men" phrase unchecked
 *  (live: "Why is Women repeating Twice?" on UNISEX family B0DSCDZC6K). */
export type ContentField = 'title' | 'bullets' | 'description' | 'backend' | 'highlights'

export type PhraseTruthReason =
  | 'wrong-garment-noun'            // names a garment the family is not (jersey/hooded on a tee…)
  | 'garment-vocab-on-non-apparel'  // any garment word on a 'none' (Electronics) family
  | 'capability-claim'              // sun protection / UPF / moisture-wicking… — no blank states it
  | 'audience-adult-on-kids'        // women/men/ladies/plus-size on a kids_tee family
  | 'audience-kids-on-adult'        // kids/toddler/youth/boys/girls/baby on an adult family
  | 'competitor-brand'              // another blank maker (Pro Club, Gildan…) unless it is the family's own
  | 'weight-class-lie'              // light/mid/heavyweight that the blank's weightNote does not back
  | 'fit-claim-lie'                 // relaxed/classic/slim/regular/oversized/fitted/boxy that spec.fit does not back
  | 'audience-lean-lie'             // a single gender asserted on a unisex-lean family's TITLE or Item Highlight

/** The seller's declared audience lean, normalized to what the truth rule needs. */
export type TruthAudienceLean = 'unisex' | 'women' | 'men' | null

export interface PhraseTruthCtx {
  garmentFamily: TruthGarmentFamily | undefined
  /** BlankSpec has no capability field today, so the capability rule is unconditional; weightNote
   *  backs the weight-class rule. fit/sleeve/neck/material/unisex are NOT read by the predicate
   *  below — they are widened here (2026-08-22) purely so a PROMPT built from this ctx (the council
   *  brief's garment-truth line) can state the product's real facts without a second resolver call;
   *  every caller already assigns the FULL resolved BlankSpec here, so this costs nothing. */
  spec: Pick<BlankSpec, 'weightNote' | 'fit' | 'sleeve' | 'neck' | 'material' | 'unisex'> | null | undefined
  allowedBrand: string | null | undefined
  audience: 'kids' | 'adult' | null
  /** EVERY garment family present in a MIXED variation family (B0DSCDZC6K ships Gildan 18000
   *  sweatshirts AND 18500 hoodies under one parent). `resolveFamilyBlank` reports a single
   *  DOMINANT family, so judging a hoodie noun against the sweatshirt row alone would call a true
   *  word a lie. When present, the allowed garment classes are the UNION over these families.
   *  Absent/empty ⇒ exactly `garmentFamily` alone (the Item-Highlight contract, unchanged). */
  mixedFamilies?: readonly TruthGarmentFamily[]
  /** THE FAMILY'S OWN DESIGN-NAME TOKENS (2026-08-21, coordinator amendment). A "Baby Shark" or
   *  "Girl Dad" ADULT tee legitimately needs 'baby' / 'girl' vocabulary in its bullets and backend:
   *  those words name the DESIGN, they do not claim the garment is for toddlers. Without this the
   *  kids/adult rules blanket-strip the healthy majority's own design vocabulary to cure a defect
   *  none of them have — the standing "don't over-generalize a specific failure" directive.
   *  Absent/empty ⇒ every audience hit is foreign, i.e. EXACTLY the pre-amendment behavior (which is
   *  what every Item-Highlight caller passed before Task 5; the single-design IH path still does).
   *  Task 5 (2026-09-06): the PER-DESIGN Item Highlights path (`buildItemHighlightsPerDesign`) now
   *  passes THIS design's own name here — never the family-wide union titles/bullets/backend use —
   *  so a sibling's name is never accidentally exempted (that cross-design leak is exactly what
   *  Task 1's foreign-token partition exists to prevent). Read by rule (c) AND (c2) below. */
  designTokens?: readonly string[]
  /** Seller-declared lean. Only 'unisex' can trigger a rule, on the TITLE or (Task 5) Item Highlight. */
  audienceLean?: TruthAudienceLean
  /** Which surface is asking. Field-agnostic for every rule except `audience-lean-lie`. */
  field: ContentField
}

export type PhraseTruthVerdict = { ok: true } | { ok: false; reason: PhraseTruthReason }

/* ─── LEXICONS (moved verbatim from itemHighlightComposer.ts — behavior byte-identical) ────────── */

/** Competitor blank/apparel makers — never composable unless the family's own allowed brand.
 *  The trademark lexicon covers franchises/marks, not blanks (the Darlin' pool composed
 *  "Pro Club Shirts" straight through it).
 *  FISHING / OUTDOOR APPAREL (2026-08-21, seen in live pools: "huk shirts for men", "magellan
 *  fishing shirts"): a shopper typing a maker's name wants THAT maker — never this blank. Scoped to
 *  the truth stage only: "columbia" / "magellan" double as place/design words elsewhere
 *  (listingPipeline.ts:968), and declining to PLACE a phrase is a hold, not a publish. */
export const APPAREL_BRAND_RE = /\b(?:pro\s?club|gild[ae]n|guildan|softstyle|heavy\s?cotton\s?brand|hanes|fruit\s+of\s+the\s+loom|next\s+level|bella\s?canvas|american\s+apparel|champion|carhartt|comfort\s+colors|huk|bassdash|columbia|under\s*armou?r|magellan|simms|aftco|pelagic)\b/i

export const GARMENT_SURFACE_RE = /\b(?:t[-\s]?shirts?|tees?|tshirts?|shirts?|apparel|tops?|clothing|hoodies?|sweatshirts?|garments?)\b/i

/** Every garment noun the lexicon knows; longer multi-word forms FIRST so "hooded sweatshirt" /
 *  "tank top" / "tee shirt" match as one noun. `crewnecks?` is the one-word sweatshirt noun ("crew
 *  neck" two words is a neck style and not a noun).
 *
 *  `tee[\s-]?shirts?` (garment-repetition defect class, 2026-09-02): "Tee Shirt" is the two-WORD
 *  spelling of the tee noun — SELLER_PROFILE §3's pinned "noun ×2" gold ("Tee Shirt | … TShirt") —
 *  and belongs in this table exactly like "tank top" and "hooded sweatshirt" already do: a genuine
 *  single lexical item gets ONE regex alternative, matched as ONE token, not left for a downstream
 *  heuristic to guess at. Previously "Tee"+"Shirt" were TWO separate matches that `hasRedundantGarmentMention`
 *  merged back into one mention via an adjacency proxy ("same class, ≤1 char apart ⇒ compound") —
 *  a heuristic that cannot tell a real two-word noun from an ACCIDENTAL collision of two distinct
 *  same-class words ("Shirts Shirt", "Top Tshirt" — both shipped live, see that function's doc).
 *  Structurally recognizing the one genuine compound here is what lets that proxy be deleted. */
export const GARMENT_NOUN_RE = /\b(?:hooded[\s-]?sweatshirts?|tank[\s-]?tops?|t[\s-]?shirts?|tshirts?|tee[\s-]?shirts?|tees?|shirts?|tops?|sweatshirts?|crewnecks?|pullovers?|hoodies?|hoodys?|hooded|jerseys?|tanks?|polos?|dress(?:es)?|sweaters?|jackets?|onesies?|bodysuits?|rompers?|leggings)\b/gi

/** A matched noun → its garment class. `crewneck` is its own class: a crew neck contradicts a hood.
 *  `teeshirts?` folds the new "Tee Shirt" compound match (flattened, no space/hyphen) onto the SAME
 *  'tee' class every other tee spelling already resolves to. */
export const garmentNounClass = (m: string): string => {
  const k = m.toLowerCase().replace(/[\s-]+/g, '')
  if (/^(?:t?shirts?|tees?|tops?|teeshirts?)$/.test(k)) return 'tee'
  if (/^(?:sweatshirts?|pullovers?)$/.test(k)) return 'sweatshirt'
  if (/^crewnecks?$/.test(k)) return 'crewneck'
  if (/^(?:hoodies?|hoodys?|hooded|hoodedsweatshirts?)$/.test(k)) return 'hoodie'
  return k.replace(/s$/, '')
}

/**
 * THE VOCABULARY, AS DATA — every concrete surface form `GARMENT_NOUN_RE`/`garmentNounClass` is
 * claimed to fold onto one garment CLASS, keyed by that class. NOT the same table as
 * `CLASS_DISPLAY_NOUNS` below (that one is prompt copy — singular, minimal, LLM-facing); this one
 * exists so the fold's OWN CLAIM is machine-checkable rather than merely asserted in a comment.
 *
 * THIS IS THE EXTENSION POINT (garment-repetition defect class, 2026-09-02). A future alias — a new
 * plural, a hyphenated or glued spelling, a brand-new synonym — gets added HERE, once. Two things
 * happen automatically the moment it lands, both in `garmentRepetitionClass.test.ts`, neither
 * hand-maintained:
 *   1. a RECOGNITION check confirms `GARMENT_NOUN_RE` actually matches it and `garmentNounClass`
 *      folds it to the class this table claims — so an alias added here without also updating the
 *      regex/fold fails LOUDLY instead of silently not-matching;
 *   2. an ENUMERATION check builds every ORDERED PAIR of distinct aliases within a class, drops the
 *      pair into one title segment (adjacent and separated), and asserts `hasRedundantGarmentMention`
 *      catches it — so a same-class alias pair can never again ship as an unflagged repeat, the way
 *      "Funny Work Shirts" + "Shirt" and "Top" + "Tshirt" both did in production on 2026-09-02.
 *
 * Every entry must be a string `GARMENT_NOUN_RE` matches whole-word today; that is itself asserted
 * (recognition check 1 above), so this table can never silently drift out of sync with the regex.
 */
export const GARMENT_NOUN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  tee: ['Shirt', 'Shirts', 'Tee', 'Tees', 'Top', 'Tops', 'Tshirt', 'Tshirts', 'T-Shirt', 'T Shirt', 'Tee Shirt', 'Tee-Shirt', 'TeeShirt'],
  sweatshirt: ['Sweatshirt', 'Sweatshirts', 'Pullover', 'Pullovers'],
  crewneck: ['Crewneck', 'Crewnecks'],
  hoodie: ['Hoodie', 'Hoodies', 'Hoody', 'Hoodys', 'Hooded', 'Hooded Sweatshirt', 'Hooded-Sweatshirt'],
}
const TEE_CLASSES: ReadonlySet<string> = new Set(['tee'])
const SWEATSHIRT_CLASSES: ReadonlySet<string> = new Set(['sweatshirt', 'crewneck'])
const HOODIE_CLASSES: ReadonlySet<string> = new Set(['hoodie', 'sweatshirt'])

/** Which GARMENT (not which noun) a class names, for the "one class per title" rule (defect 3) —
 *  narrower than `garmentNounClass`. `crewneck` is its own NOUN CLASS (a crew neck contradicts a
 *  hood, so `phraseTruthVerdict` must keep telling them apart), but it is not a different GARMENT
 *  from `sweatshirt` — "Sweatshirt … Fall Crewneck" is the SAME product named twice, the PO's own
 *  gold pattern, and must never be read as "two garment classes in one title". Every other class
 *  (tee / sweatshirt / hoodie / …) names a materially different garment and is its own group. */
const garmentGroup = (cls: string): string => (cls === 'crewneck' ? 'sweatshirt' : cls)

/** The garment classes ONE family may name. A hoodie IS a hooded sweatshirt (coordinator ruling
 *  2026-08-21): hoodie families accept hoodie / hooded sweatshirt / sweatshirt / pullover — only
 *  tee nouns (and a crew neck) are foreign to them. null = no noun rule (unresolved blank / hat). */
const classesForFamily = (gf: TruthGarmentFamily | undefined): ReadonlySet<string> | null => {
  if (gf === 'tee' || gf === 'long_sleeve_tee' || gf === 'kids_tee') return TEE_CLASSES
  if (gf === 'sweatshirt') return SWEATSHIRT_CLASSES
  if (gf === 'hoodie') return HOODIE_CLASSES
  return null
}

/** The allowed set for the whole VARIATION family: the union over every blank present. An empty
 *  `mixedFamilies` (the default, and every Item-Highlight caller) reduces to `classesForFamily`. */
const allowedGarmentClasses = (ctx: PhraseTruthCtx): ReadonlySet<string> | null => {
  const families = ctx.mixedFamilies && ctx.mixedFamilies.length ? ctx.mixedFamilies : [ctx.garmentFamily]
  const sets = families.map(classesForFamily)
  if (sets.some((s) => s === null)) return null          // any unresolved member ⇒ no noun rule
  const union = new Set<string>()
  for (const s of sets) for (const c of s as ReadonlySet<string>) union.add(c)
  return union.size ? union : null
}

/** Human-readable display nouns per garment CLASS (prompt copy only — the predicate itself keys
 *  off `garmentNounClass`/`GARMENT_NOUN_RE` above and is untouched by this table). */
const CLASS_DISPLAY_NOUNS: Record<string, string[]> = {
  tee: ['shirt', 'tee', 't-shirt', 'top'],
  sweatshirt: ['sweatshirt'],
  crewneck: ['crewneck'],
  hoodie: ['hoodie'],
}
const ALL_GARMENT_CLASSES = Object.keys(CLASS_DISPLAY_NOUNS)

/**
 * THE GARMENT NOUNS a family may truthfully use, and the ones it may NEVER use — derived from the
 * SAME class table `phraseTruthVerdict`'s wrong-garment-noun rule gates with (`classesForFamily` /
 * `allowedGarmentClasses`), so a prompt line built from this can never disagree with what the #632
 * terminal net (`applyTitleTruthNet`) would delete. One source, two views: the predicate and the
 * producer-facing constraint copy read the identical class union.
 *
 * PO 2026-08-22 ("Council/Judges can read the garment field"): councils were writing the garment
 * lie and burning candidate slots on it because they never saw this constraint — only the terminal
 * net, after the fact, ever asked the question. This lets a brief/judge ask it BEFORE generation.
 *
 * Empty `forbidden` ⇒ no rule (unresolved blank / non-apparel family) — caller must no-op exactly
 * like `phraseTruthVerdict` fails open when `allowedGarmentClasses` returns null.
 */
export function garmentNounConstraint(ctx: PhraseTruthCtx): { allowed: string[]; forbidden: string[] } {
  if (!ctx.garmentFamily || ctx.garmentFamily === 'none') return { allowed: [], forbidden: [] }
  const allowedClasses = allowedGarmentClasses(ctx)
  if (!allowedClasses) return { allowed: [], forbidden: [] }
  const allowed = [...new Set([...allowedClasses].flatMap((c) => CLASS_DISPLAY_NOUNS[c] ?? [c]))]
  const forbidden = [...new Set(ALL_GARMENT_CLASSES.filter((c) => !allowedClasses.has(c)).flatMap((c) => CLASS_DISPLAY_NOUNS[c] ?? [c]))]
  return { allowed, forbidden }
}

// `womans`/`mans`/`lady` added 2026-08-21: "Womans Shirts" composed onto the kids family B0DP5H8QBT.
// GLOBAL since 2026-08-21 so the rule can ask WHICH audience words a phrase asserts, not merely
// whether it asserts one — the design-token exemption below needs the individual hits. `matchAll`
// does not mutate the source regex's lastIndex, so these stay safe to share.
// ADULT_AUDIENCE_RE moved below LEAN_FEM_CORE/LEAN_MASC_CORE (FIX WAVE 2, M-2, 2026-09-06) — its
// gender half is now DERIVED from that same core rather than hand-copied; see the comment there.
const KIDS_AUDIENCE_RE = /\b(?:kids?|toddlers?|youth|boys|girls|baby)\b/gi

/** The family's design words, plural-folded so a "Girl Dad" design also owns "girls". */
const designWordSet = (tokens: readonly string[] | undefined): ReadonlySet<string> => {
  const s = new Set<string>()
  for (const t of tokens ?? []) {
    for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) { s.add(w); s.add(w.replace(/s$/, '')) }
  }
  return s
}
/** Is every word of this audience hit part of the family's OWN design name? */
const isDesignOwnWord = (hit: string, design: ReadonlySet<string>): boolean => {
  const parts = hit.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return parts.length > 0 && parts.every((w) => design.has(w) || design.has(w.replace(/s$/, '')))
}
/**
 * The audience words a phrase asserts that the DESIGN'S OWN NAME does not explain.
 *
 * THE RULE IS ABOUT THE CLAIM, NOT THE VOCABULARY. "baby shark shirt" on a "Baby Shark" ADULT tee
 * asserts no audience — 'baby' is the design. "toddler tee" on the same family does, and still
 * dies. "baby shark shirts for kids" does too: ONE foreign hit ('kids') is enough. An empty design
 * set makes every hit foreign, which is the historical behavior exactly.
 */
const foreignAudienceHits = (phrase: string, re: RegExp, design: ReadonlySet<string>): string[] =>
  [...phrase.matchAll(re)].map((m) => m[0]).filter((h) => !isDesignOwnWord(h, design))

/** The two halves of the FORCED-GENDER rule, as pattern STRINGS (not compiled RegExp) — the
 *  canonical, exported core. Adult gender words only — kids words are the kids/adult audience
 *  rule's business, and a phrase naming BOTH halves is INCLUSIVE, not forced.
 *  EXTENDED (Task 7, PO ruling 2026-09-06 "1. Extend", live: six unisex designs shipped "Novelty
 *  Shirts for Guys" because `guys` was invisible to the old masculine-only lexicon) with `gals`
 *  (feminine) and `guys|guy|dudes|dude|bros|bro|gents|gent` (masculine) — ADULT gender words only.
 *  `girls`/`boys` deliberately stay OFF this lexicon and on the kids axis (KIDS_AUDIENCE_RE above):
 *  adding them here would double-classify a kids family's correct "shirts for girls" as a forced-
 *  gender lie under rule (c2) below (the controller's pre-stage ruling, see task-7-brief.md).
 *  EXPORTED as strings — not a compiled RegExp — so the two other module-private copies of this
 *  lexicon (nicheGuards.ts, syncListingContent.ts; both already independently drifted, carrying
 *  `female`/`girls?` this file never had) COMPOSE their own extra axis words onto this SAME core
 *  instead of hand-copying it — the class of drift this task exists to end.
 *  FIX WAVE 2 (M-1, 2026-09-06, controller RULING — final whole-branch review #2): `gal` (singular)
 *  joins `gals` — the masculine half already carried BOTH `guys|guy`; the feminine half was missing
 *  its own singular, an asymmetry the review recorded as byte-exact-as-ruled but still worth closing
 *  ("DO fix"). Word-boundary discipline (the `\b…\b` wrapper every consumer applies) already keeps
 *  `galaxy`/`gallery`/`regal` from matching — `\bgal\b` requires a non-word character (or string
 *  edge) on both sides, which none of those three offer. */
export const LEAN_FEM_CORE = `wom[ae]n['’]?s?|ladies|lady|gals|gal`
export const LEAN_MASC_CORE = `m[ae]n['’]?s?|guys|guy|dudes|dude|bros|bro|gents|gent`
const LEAN_FEM_RE = new RegExp(`\\b(?:${LEAN_FEM_CORE})\\b`, 'i')
const LEAN_MASC_RE = new RegExp(`\\b(?:${LEAN_MASC_CORE})\\b`, 'i')

/** FIX WAVE 2 (M-2, 2026-09-06, controller RULING — final whole-branch review #2): rule (c)'s
 *  adult-on-kids half used to hand-copy `women|woman|womens|womans|ladies|lady|men|mens|mans` —
 *  the SAME one-lexicon drift Task 7 closed for rule (c2), just on the other axis, and the review
 *  found it live: "for Guys"/"for Gals"/"for Dudes"/"for Gents" on a kids family with no declared
 *  lean read as OK (a gap) because those words were invisible here. Now DERIVED from the SAME
 *  `LEAN_FEM_CORE`/`LEAN_MASC_CORE` rule (c2) tests against — never a second hand-copy — plus the
 *  two words that are this rule's OWN business, not the forced-gender rule's: `adults?` and
 *  `plus[\s-]?size`. `girls`/`boys` stay OFF (they are `KIDS_AUDIENCE_RE`'s words, Task 7's
 *  pre-stage ruling, unchanged). Declared AFTER the two CORE strings (temporal-dead-zone: a `const`
 *  cannot be read before its own declaration executes) — this module's only ordering constraint.
 *  The core adds bare `man` (via `m[ae]n['’]?s?`, previously ONLY `men|mens|mans` were adult-axis
 *  words here) — the design-token exemption at rule (c)'s call site (`designWordSet`/
 *  `foreignAudienceHits`, unchanged by this fix) already exempts a kids design's OWN name (e.g.
 *  "Spider Man", "Little Man") from any hit, adult or kids, so a bare "man" a design NAMES itself
 *  after is not newly rejected — pinned in contentTruthSpine.test.ts. GLOBAL (`matchAll`, never
 *  `.test()`) for the same reason the pre-existing regex was: the design-token exemption needs
 *  every individual hit, not merely whether one exists. */
const ADULT_AUDIENCE_RE = new RegExp(`\\b(?:${LEAN_FEM_CORE}|${LEAN_MASC_CORE}|adults?|plus[\\s-]?size)\\b`, 'gi')
/** GLOBAL twins of the two regexes above, for Item Highlights only (Task 5) — `foreignAudienceHits`
 *  needs every match (`matchAll`), not merely whether one exists, so it can tell a phrase's OWN
 *  gendered hit (the design's own name — exempt) from a foreign one (a market audience claim —
 *  still forced-gender). Kept SEPARATE from the two above rather than adding 'g' to them: those stay
 *  single-shot `.test()` calls on the TITLE branch, and a shared global instance's mutable
 *  `lastIndex` would make repeated `.test()` calls silently skip matches (the same gotcha
 *  `ADULT_AUDIENCE_RE`/`KIDS_AUDIENCE_RE` above avoid by never being `.test()`'d).
 *  FIX ROUND (final fix wave, 2026-09-06, T5-d): derived from `LEAN_FEM_RE`/`LEAN_MASC_RE`'s own
 *  `.source` instead of re-typing the lexicon literally — a second hand-copied word list is exactly
 *  how the title and highlight branches could drift (the fold-word lexicons in this file already
 *  learned this lesson once). The separate-CONST reason above (shared `lastIndex`) is satisfied
 *  either way; only the SOURCE of the word list changes, not the flags/behavior. */
const LEAN_FEM_RE_G = new RegExp(LEAN_FEM_RE.source, 'gi')
const LEAN_MASC_RE_G = new RegExp(LEAN_MASC_RE.source, 'gi')

/** Rule (b)'s STRIP halves (fix round 1, 2026-09-06, controller ruling on B1) — built from the SAME
 *  `LEAN_FEM_CORE`/`LEAN_MASC_CORE` the DETECTOR (`LEAN_FEM_RE`/`LEAN_MASC_RE` above) tests against,
 *  reusing the rule (b2) idiom one rule below ("reuses the EXACT helpers the predicate gates on ...
 *  so this can never structurally disagree"). Before this fix rule (b) detected with the widened
 *  core but REMOVED with a hand-copied `wom[ae]n['’]?s?` / `m[ae]n['’]?s?` literal that was never
 *  widened for the nine new adult-slang words — so `applyTitleTruthNet` left "for Guys"/"for Gals"/
 *  "for Dudes"/"for Bros"/"for Gents" byte-identical, `verdictForAssembledTitle`'s net-idempotence
 *  ship gate read the untouched string as CLEAN, and the PO's exact live specimen
 *  ("…Novelty Shirts for Guys") shipped on the title path while its "for Men" twin was blocked
 *  (task-7-review-findings.md, B1). Hoisted to module scope, never rebuilt per call — a fresh
 *  `new RegExp` on every `scrubMoneyPhrase` invocation would just be the same bug in a new shape
 *  (a second, independently-maintained copy that could silently stop tracking the core). Global so
 *  `.replace()` removes every offending mention in the phrase, not just the first. */
const LEAN_FEM_STRIP_RE = new RegExp(`\\b(?:for\\s+)?(?:${LEAN_FEM_CORE})\\b`, 'gi')
const LEAN_MASC_STRIP_RE = new RegExp(`\\b(?:for\\s+)?(?:${LEAN_MASC_CORE})\\b`, 'gi')

/** PipelineInput.audienceLean → the truth rule's view. `lean_male`/`lean_female` are SOFT
 *  re-weightings (cross-gender traffic is the point of a lean), so they are NOT unisex and never
 *  trigger the forced-gender rule. */
export function normalizeAudienceLean(
  lean: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null | undefined,
): TruthAudienceLean {
  if (lean === 'unisex') return 'unisex'
  if (lean === 'female' || lean === 'lean_female') return 'women'
  if (lean === 'male' || lean === 'lean_male') return 'men'
  return null
}

/* ─── THE AGE PRODUCER (PO ruling 2026-08-27, migration 071) ────────────────────────────────────
 *
 * "The garment should touch everything from title to Product Detail values" (PO 2026-08-22)
 * reached title/bullets/description/backend but NOT Amazon's Product Detail attributes.
 * `age_range_description` had ZERO deterministic producers (LLM-only, guessing from the listing's
 * OWN EXISTING COPY); `department`/`target_gender`'s one deterministic producer — the per-lean
 * 3-way map at listingPipeline.ts's product-detail block — is the FAMILY GENDER SELECTOR, whose
 * vocabulary (male|female|lean_male|lean_female|unisex) structurally cannot say "kids": a 12-child
 * Gildan 64000B YOUTH-tee family ships Department="Unisex", a LEGAL enum member, so the push
 * reports SUCCESS while the listing is filed as adult (B0DP5H8QBT).
 *
 * PO RULING: blank-derived garment truth MAY re-propose over a PO-accepted PUSHED value — but ONLY
 * when the blank itself STATES the fact. A guess never overrides the PO; a selector-derived value
 * (the lean map above) never overrides the PO either. This resolver is the ONE seam that decides
 * "did the blank state it" — every Product Detail call site asks it the same question the same way,
 * exactly like `phraseTruthVerdict` is the one seam for garment-noun/audience truth.
 */

/** blank_specs.age_class (migration 071) — orthogonal to garment_family's SILHOUETTE enum (058):
 *  any garment_family may pair with any age_class. NEVER defaulted to 'adult' anywhere — DDL, this
 *  resolver, or the settings UI — a default that is also a legal value would hide total failure
 *  exactly the way Department="Unisex" already does. */
export type AgeClass = 'newborn' | 'infant' | 'toddler' | 'kids' | 'adult'

/** How `resolveGarmentAudience` decided — mirrors `BlankSource`'s "how was this blank decided" API
 *  surface (blankSpecs.ts): a contract the caller's provenance stamp reads, not an internal label. */
export type GarmentAudienceSource = 'blank-column' | 'garment-family' | 'none'

export interface GarmentAudienceFacts {
  garmentFamily: TruthGarmentFamily | undefined
  /** The blank's OWN stated age_class column. Absent/null = "the blank does not state its age" —
   *  never pass 'adult' as a stand-in default; only forward a REAL column value. */
  ageClass?: AgeClass | null
  /** RAW seller-declared lean (same shape `normalizeAudienceLean` takes) — used only to pick
   *  Girls/Boys over the neutral default once the family is already known to be non-adult. */
  audienceLean?: Parameters<typeof normalizeAudienceLean>[0]
  /** LIVE accepted[] for this product type's age_range_description attribute
   *  (`detailAttributeMenu[].accepted`) — how `ageRangeCandidate` is resolved against the real
   *  enum instead of a hardcoded label (PO ruling 2026-09-02). Undefined/null = no live list
   *  available (menu not loaded yet, or this product type's schema has no such key) — degrades to
   *  the single best-guess label, byte-identical to this resolver's behavior before that ruling. */
  ageRangeAccepted?: readonly string[] | null
}

export interface GarmentAudienceResolution {
  ageClass: AgeClass | null
  audience: 'kids' | 'adult' | null
  source: GarmentAudienceSource
  /** Human department string to COMPOSE with an existing dept string ('Unisex Kids') — the caller
   *  hands this to the live-schema enum coercion (`coerceGenderToEnum`), never writes it raw. */
  departmentQualifier: string | null
  /** Candidate value for the age_range_description attribute — the caller matches this against the
   *  LIVE enum (`detailAttributeMenu[].accepted`) before ever proposing it; a schema with no such
   *  key makes appending it a structural no-op. */
  ageRangeCandidate: string | null
  /** Same neutral/gendered marker `youthMarkerFor` derives for the TITLE — Kids by default,
   *  Girls/Boys only when the seller declared a lean. null when the audience isn't kids. */
  youthMarker: string | null
}

const AGE_RANGE_LABEL: Record<AgeClass, string> = {
  newborn: 'Newborn', infant: 'Infant', toddler: 'Toddler', kids: 'Kids', adult: 'Adult',
}

/*
 * AGE_RANGE_PREFERENCE — PO ruling 2026-09-02: "kids -> Big Kid" (Gildan 64000B youth runs
 * XS(4-5)-XL(14-16); Amazon's Little Kid tops out ~7, so most of the run is Big Kid; the PO
 * separately named the target as "Big Kids, Youth, Teens", corroborating the band).
 *
 * THE DEFECT THIS CLOSES: `AGE_RANGE_LABEL.kids = 'Kids'` is a HAND-TYPED LABEL NEVER CHECKED
 * against the live accepted enum (`detailAttributeMenu[].accepted`), and Amazon's real
 * age_range_description enum for this product type — read live from the DB 2026-09-02 — is
 * exactly {Adult, Big Kid, Infant, Little Kid, Toddler}. No "Kid"/"Kids"/"Youth"/"Newborn" member
 * exists at all, so the deterministic producer could NEVER validate; PR #661's validity-outranks-
 * provenance guard correctly refused it every time, and the field silently fell through to
 * whatever the LLM happened to guess.
 *
 * THE CURE IS DERIVED, NOT REMEMBERED: an ORDERED PREFERENCE per age class, resolved against the
 * LIVE `accepted[]` at runtime by `resolveAgeRangeLabel` below — the first member PRESENT wins.
 * A different product type with a different enum works with zero code change (e.g. an enum of
 * just {Youth, Adult} still resolves 'kids' -> 'Youth', the first preference entry it carries).
 * Verify before extending: these lists are the PO's stated ruling plus adjacent, plausible Amazon
 * vocabulary — not exhaustively confirmed against every product type's live schema.
 */
const AGE_RANGE_PREFERENCE: Record<AgeClass, readonly string[]> = {
  newborn: ['Newborn', 'Infant', 'Baby'],
  infant: ['Infant', 'Newborn', 'Baby'],
  toddler: ['Toddler', 'Little Kid'],
  kids: ['Big Kid', 'Little Kid', 'Kid', 'Youth', 'Kids'],
  adult: ['Adult'],
}

/** Resolve the age-range candidate for `ageClass` against the live `accepted` enum — first
 *  `AGE_RANGE_PREFERENCE` member present in `accepted` wins (case-insensitive, exact). PURE.
 *
 *  `accepted` undefined/null/empty = no live enum available — degrades to the single fixed label
 *  (`AGE_RANGE_LABEL`), exactly this resolver's behavior before the 2026-09-02 ruling.
 *  `accepted` a real, non-matching list = a genuine schema mismatch: returns `matched:false` and
 *  a null label — the caller must NEVER invent a member and must skip the row entirely. */
function resolveAgeRangeLabel(
  ageClass: AgeClass,
  accepted: readonly string[] | null | undefined,
): { label: string | null; matched: boolean } {
  if (!accepted || accepted.length === 0) return { label: AGE_RANGE_LABEL[ageClass], matched: true }
  const acceptedSet = new Set(accepted.map((a) => (a || '').trim().toLowerCase()))
  const hit = AGE_RANGE_PREFERENCE[ageClass].find((p) => acceptedSet.has(p.toLowerCase()))
  return hit ? { label: hit, matched: true } : { label: null, matched: false }
}

/** Girls/Boys/Kids — the ONE gendered-marker picker, shared by `youthMarkerFor` (title, legacy
 *  normalized ctx.audienceLean) and `resolveGarmentAudience` (Product Detail, raw seller lean) so
 *  the two surfaces can never pick different words for the same family. */
function pickYouthWord(lean: TruthAudienceLean): string {
  if (lean === 'women') return 'Girls'
  if (lean === 'men') return 'Boys'
  return 'Kids'
}

/**
 * ONE resolver for garment age/audience facts. Every Product Detail call site asks this and
 * nothing else — no inline `if (kids) dept = 'Unisex Kids'` anywhere else in the pipeline.
 *
 * PRECEDENCE — exactly these two rules, nothing else:
 *   1. A STATED `facts.ageClass` wins outright.                        source: 'blank-column'
 *   2. Else `facts.garmentFamily === 'kids_tee'` resolves 'kids' — the  source: 'garment-family'
 *      ONE age fact the silhouette enum (058) already encodes.
 * Every other combination (no stated ageClass, not kids_tee) yields ageClass:null, audience:null,
 * source:'none'. 'adult' is NEVER INFERRED — it is returned ONLY when `facts.ageClass` arrives
 * LITERALLY 'adult' (a real stated column value; the DB column has no default and nothing in this
 * codebase ever synthesizes 'adult'). `tee → adult` is exactly the inference this resolver refuses
 * to make: it would mislabel every future kids blank of a non-kids_tee silhouette (a kids hoodie,
 * a toddler onesie) the moment one exists.
 *
 * Pure — no DB, no I/O.
 */
export function resolveGarmentAudience(facts: GarmentAudienceFacts): GarmentAudienceResolution {
  let ageClass: AgeClass | null = facts.ageClass ?? null
  let source: GarmentAudienceSource = ageClass ? 'blank-column' : 'none'
  if (!ageClass && facts.garmentFamily === 'kids_tee') {
    ageClass = 'kids'
    source = 'garment-family'
  }
  const audience: 'kids' | 'adult' | null = ageClass === null ? null : ageClass === 'adult' ? 'adult' : 'kids'
  const isKidsBucket = audience === 'kids'
  const lean = normalizeAudienceLean(facts.audienceLean)
  const youthMarker = isKidsBucket ? pickYouthWord(lean) : null
  const departmentQualifier = isKidsBucket
    ? (lean === 'women' ? 'Girls' : lean === 'men' ? 'Boys' : `Unisex ${AGE_RANGE_LABEL[ageClass as AgeClass]}`)
    : null
  let ageRangeCandidate: string | null = null
  if (ageClass) {
    const resolved = resolveAgeRangeLabel(ageClass, facts.ageRangeAccepted)
    ageRangeCandidate = resolved.label
    // LOUD, GREPPABLE, NEVER SILENT: a real accepted[] was supplied and NOTHING on the ordered
    // preference matched it — this product type's schema genuinely does not carry any member this
    // family could truthfully claim. Never invent one; log so the gap is visible instead of a
    // silently-missing Product Detail row.
    if (!resolved.matched) {
      console.warn(JSON.stringify({
        tag: 'AGE_RANGE_LABEL_NO_MATCH', ageClass, preference: AGE_RANGE_PREFERENCE[ageClass],
        accepted: facts.ageRangeAccepted ?? null,
      }))
    }
  }
  return { ageClass, audience, source, departmentQualifier, ageRangeCandidate, youthMarker }
}

/** Audience is a property of the BLANK FAMILY (64000B youth tee ⇒ kids), never inferred from a
 *  title. THIN WRAPPER (2026-08-27) over `resolveGarmentAudience`'s garment-family rule so the two
 *  can never disagree about which families are kids — the 'adult' branch is untouched (that
 *  resolver deliberately never infers 'adult' from silhouette; this function's own callers have
 *  relied on it doing exactly that since before this resolver existed, so it stays, unchanged). */
export function audienceOfGarmentFamily(gf: TruthGarmentFamily | undefined): 'kids' | 'adult' | null {
  if (resolveGarmentAudience({ garmentFamily: gf }).audience === 'kids') return 'kids'
  if (gf === 'tee' || gf === 'long_sleeve_tee' || gf === 'sweatshirt' || gf === 'hoodie' || gf === 'hat') return 'adult'
  return null
}

/* ─── THE YOUTH MARKER (PO 2026-08-23, live B0DP5H8QBT) ─────────────────────────────────────────────
 * PR #642 cured the SUBTRACTIVE half of the kids-audience defect (an adult clause like "for Men &
 * Women" no longer survives on a kids_tee family) but left the ADDITIVE half undone: the title never
 * POSITIVELY says it is a children's garment, so a shopper searching "kids <design> shirt" cannot
 * find it and a shopper reading the title reasonably assumes it is adult. "Removed the lie" is not
 * "stated the truth" — the exact "subtractive net without an additive producer" class this repo keeps
 * re-learning (see `settleTruthBand`'s own header on the #630/#631 revert). */

/** Does TITLE assert ANY youth/kids audience marker? Reuses `KIDS_AUDIENCE_RE` — the SAME regex the
 *  audience-truth rule (c) above matches against — so this can never disagree with what that rule
 *  considers a "kids" word. `matchAll`, not `.test`, so the shared GLOBAL regex's `lastIndex` is never
 *  mutated between calls (the same gotcha `foreignAudienceHits` above already avoids). */
export function titleAssertsYouthAudience(title: string): boolean {
  return [...(title ?? '').matchAll(KIDS_AUDIENCE_RE)].length > 0
}

/**
 * The youth marker a KIDS family's title should assert, derived ONLY from the BLANK-GROUNDED ctx —
 * never from the title text or the keyword pool (the PO's own ruling: "the garment should touch
 * everything from title to Product Detail values"). A seller-declared gender lean picks the matching
 * word; the default — unisex, or no lean declared — is the NEUTRAL 'Kids', never a guessed Boys/Girls
 * (this repo's standing "don't over-generalize a specific failure" directive). `null` for a non-kids
 * family (nothing to assert) or an unresolved ctx (no ground truth to derive from). Pure.
 */
export function youthMarkerFor(ctx: PhraseTruthCtx | null | undefined): string | null {
  if (!ctx || ctx.audience !== 'kids') return null
  // THIN WRAPPER (2026-08-27): shares `pickYouthWord` with `resolveGarmentAudience` so the title
  // marker and the Product Detail department qualifier can never pick different words for the
  // same family. ctx.audienceLean is already the NORMALIZED TruthAudienceLean (unlike
  // resolveGarmentAudience's raw seller-lean parameter) — pickYouthWord takes that shape directly.
  return pickYouthWord(ctx.audienceLean ?? null)
}

/* ─── ONE CTX BUILDER (PO 2026-08-23, live B0DP5H8QBT) ──────────────────────────────────────────── */

/**
 * The blank-grounded FACTS `buildPhraseTruthCtx` needs to assemble a `PhraseTruthCtx` — what a
 * caller already has once it has resolved a family's blank, not yet shaped into the ctx object
 * every field-specific fill reads.
 */
export interface PhraseTruthFacts {
  garmentFamily: TruthGarmentFamily | undefined
  /** The FULL set of garment families present (a mixed-blank family) — pass the raw union, never
   *  pre-collapsed; a length ≤1 array collapses to `undefined` inside, same as every existing caller
   *  already did by hand. */
  mixedFamilies?: readonly TruthGarmentFamily[]
  spec: PhraseTruthCtx['spec']
  allowedBrand: string | null | undefined
  designTokens?: readonly string[]
  /** RAW seller-declared lean — this normalizes it, same as every existing caller already did inline. */
  audienceLean?: Parameters<typeof normalizeAudienceLean>[0]
}

/**
 * ONE ctx builder for the whole content-truth spine. Generation (`listingPipeline.ts`'s
 * `truthCtxFor`) and the locked-title READ path (`lockedTitleTruth.ts`'s
 * `resolveLockedTitleTruthCtx`) used to duplicate this assembly by hand — and had already drifted:
 * the read path hardcoded `designTokens: []` while generation threaded the family's real design
 * names, so a "Girl Dad"/"Baby Shark"-style family could get a TRUE verdict on one path and a FALSE
 * one on the other for the exact same phrase. Every OTHER field (spec, allowedBrand, audience,
 * audienceLean, mixedFamilies collapsing) is now structurally impossible to drift, because both
 * callers build the SAME shape through the SAME function.
 *
 * Pure — no DB, no new resolver; both callers still do their own blank resolution and hand the
 * result here. Fail-open, same doctrine as every blank-truth site in this repo: no resolved garment
 * family ⇒ no ground truth ⇒ `null` (nothing to judge against).
 */
export function buildPhraseTruthCtx(facts: PhraseTruthFacts, field: ContentField): PhraseTruthCtx | null {
  if (!facts.garmentFamily) return null
  return {
    garmentFamily: facts.garmentFamily,
    mixedFamilies: facts.mixedFamilies && facts.mixedFamilies.length > 1 ? facts.mixedFamilies : undefined,
    spec: facts.spec,
    allowedBrand: facts.allowedBrand,
    audience: audienceOfGarmentFamily(facts.garmentFamily),
    designTokens: facts.designTokens ?? [],
    audienceLean: normalizeAudienceLean(facts.audienceLean),
    field,
  }
}

/**
 * FIT/CUT CLAIM VOCABULARY (Task 4, 2026-09-06 — live B0DSCDZC6K: "relaxed unisex fit" shipped for a
 * Gildan 18000, whose blank_specs.fit is Classic; a false product claim, indexed by Google). Mirrors
 * titleBand.ts's FIT_CLAIM_SUFFIX_WORDS/FIT_CLAIM_BARE_WORDS (an INDEPENDENT copy, not imported —
 * titleBand.ts already imports THIS module for `phraseTruthVerdict`, so importing back would cycle;
 * this repo's own convention for a shared word class is a local copy per module, exactly how
 * blankSpecs.ts's WEIGHT_CLASS_RE and this file's own weight-class rule (e) below each keep their own
 * "light/mid/heavy" regex rather than cross-importing). SUFFIX words double as ordinary English/
 * design vocabulary ("Classic Car Shirt", "Relaxed Weekend") — matched ONLY as a "<word> ... Fit"
 * claim (the fit word and the literal word "fit" appearing TOGETHER, in either order of proximity,
 * anywhere in the same comma-delimited segment — never bare), so a genuine design phrase is never
 * mistaken for a spec assertion, and a fit word in one Item-Highlight segment cannot bind to an
 * unrelated "fit" sitting in a different segment. BARE words are unambiguous garment cut/fit terms —
 * matched standalone. Exactly the seven words the PO named live, PLUS `oversize` (final fix wave,
 * T4-b — the informal spelling of the already-approved `oversized`, not an eighth word); not
 * invented, not the fuller title-only list (loose/cropped/crop/baggy/tapered/taper stay title-only —
 * this predicate is scoped to `field:'highlights'` only (Important #1) and a broader list here would
 * widen that one field's fill/filter, which is outside what this task was asked to close).
 *
 * NOT CAUGHT, ON PURPOSE (fix-round-1 self-review, 2026-09-06): a bare suffix word with no "fit"
 * anywhere in its segment — plain "Classic Rock Shirt", or "relaxed" with `spec: null` and no "fit"
 * beside it — is ordinary vocabulary, not a claim, and must keep passing even when `spec` is absent;
 * only a WORD PAIRED WITH "fit" is fail-closed. Do not "fix" this into bare-word matching — the
 * suffix/bare split exists precisely to keep it out.
 *
 * FIX ROUND 1 (2026-09-06): the ORIGINAL suffix pattern (`\s+fit\b`) required the claim word
 * IMMEDIATELY adjacent to "fit", so it never matched the live string itself — "relaxed unisex fit"
 * (a word sits between them) — nor "relaxed-fit" (hyphen, not whitespace). Fixed by letting the span
 * between the claim word and "fit" be ANY run of non-comma characters (lazy, so it stops at the
 * nearest "fit" and never crosses into a different comma segment) instead of a single `\s+`.
 *
 * FIX ROUND 2 (final fix wave, 2026-09-06, Important #2): fix-round-1's lazy span could still cross
 * OVER a second claim word to reach a "fit" that truthfully belongs to the FIRST word, laundering the
 * second — "relaxed oversized fit tee" on a Relaxed blank matched suffix "relaxed" all the way through
 * to "fit", swallowing the bare word "oversized" INSIDE that one match so it was never independently
 * judged (`relaxed oversized fit tee` => `{ok:true}` even though "oversized" is a false claim on a
 * Relaxed blank). The span now also refuses to cross any OTHER recognized claim word (suffix or bare),
 * so "oversized" breaks the "relaxed ... fit" match and is left to be caught on its own by the bare
 * alternative — all three orderings (`relaxed oversized fit`, `relaxed fit oversized`, `oversized
 * relaxed fit`) now agree.
 */
const FIT_CLAIM_SUFFIX_WORDS = ['relaxed', 'classic', 'slim', 'regular'] as const
/** FIX ROUND 2 (final fix wave, 2026-09-06, T4-b): `oversize` added alongside the already-approved
 *  `oversized` — the SAME word, the informal spelling, not an eighth word (the seven the PO named
 *  live are unchanged); without it `FIT_WORD_CANON` below has nothing to normalize, since a claim
 *  spelled "oversize" never reached rule (f) at all. */
const FIT_CLAIM_BARE_WORDS = ['oversized', 'oversize', 'fitted', 'boxy'] as const
const FIT_CLAIM_RE = new RegExp(
  `\\b(${FIT_CLAIM_SUFFIX_WORDS.join('|')})\\b(?:(?!,)(?!\\b(?:${[...FIT_CLAIM_SUFFIX_WORDS, ...FIT_CLAIM_BARE_WORDS].join('|')})\\b).)*?\\bfit\\b|\\b(${FIT_CLAIM_BARE_WORDS.join('|')})\\b`, 'gi',
)
/** Spelling variants normalize to the canonical class word BEFORE the spec-containment check, so a
 *  blank whose `fit` states "Oversized" still backs a claim spelled "oversize" (final fix wave,
 *  2026-09-06, T4-b). MIRRORS titleBand.ts:758's `FIT_WORD_CANON` verbatim — a local copy, not an
 *  import (same cross-cycle reason as the word lists above). `crop`/`taper` are inert here today:
 *  IH's own vocabulary has no `cropped`/`tapered` claim words to canonicalize (title-only, see the
 *  vocabulary doc above) — kept for byte-parity with titleBand's map so the two never drift apart if
 *  IH's vocabulary ever widens to match. */
const FIT_WORD_CANON: Readonly<Record<string, string>> = { oversize: 'oversized', crop: 'cropped', taper: 'tapered' }

/* ─── THE PREDICATE ───────────────────────────────────────────────────────────────────────────── */

/**
 * ONE pure truth predicate for a candidate phrase against the family's BLANK facts. Every
 * deterministic fill in the pipeline — title, bullets, description, backend, item highlights —
 * asks this and nothing else. Exported so the pins read as the PO's rulings.
 */
export function phraseTruthVerdict(phrase: string, ctx: PhraseTruthCtx): PhraseTruthVerdict {
  const gf = ctx.garmentFamily
  // (a) garment-noun truth — 'none' = NON-APPAREL (PO 2026-08-21: B0GCF11RKL is Electronics — the
  // composer put "T Shirts for Women" on a memory card); otherwise a phrase naming a garment class
  // the family is not (a tee is never a jersey/hoodie/sweatshirt; hooded ⇒ hoodie only).
  if (gf === 'none') {
    if (GARMENT_SURFACE_RE.test(phrase)) return { ok: false, reason: 'garment-vocab-on-non-apparel' }
  } else {
    const allowed = allowedGarmentClasses(ctx)
    if (allowed) {
      for (const m of phrase.matchAll(GARMENT_NOUN_RE)) {
        if (!allowed.has(garmentNounClass(m[0]))) return { ok: false, reason: 'wrong-garment-noun' }
      }
    }
  }
  // (b) capability claims — BlankSpec states no capability today ⇒ every such claim is unverifiable.
  if (PERFORMANCE_CLAIM_RE.test(phrase)) return { ok: false, reason: 'capability-claim' }
  // (c) audience truth — derived from the blank family, never a title. A phrase is rejected only
  // when it asserts an audience this family is NOT, INDEPENDENTLY of the design's own name: the
  // design-token exemption keeps a "Baby Shark" adult family's own vocabulary in its bullets and
  // backend. It can NEVER license a garment lie — rule (a) runs first and never reads designTokens.
  if (ctx.audience === 'kids' || ctx.audience === 'adult') {
    const designWords = designWordSet(ctx.designTokens)
    const re = ctx.audience === 'kids' ? ADULT_AUDIENCE_RE : KIDS_AUDIENCE_RE
    if (foreignAudienceHits(phrase, re, designWords).length > 0) {
      return { ok: false, reason: ctx.audience === 'kids' ? 'audience-adult-on-kids' : 'audience-kids-on-adult' }
    }
  }
  // (c2) FORCED GENDER — TITLE + ITEM HIGHLIGHTS (PO gold pattern "no forced gender", live
  // B0DSCDZC6K: the title said "for Women" while the family's stored audience_lean is 'unisex').
  // The title is a PRODUCT CLAIM; bullets/description/backend still carry MARKET vocabulary, where a
  // gendered shopper phrase is legitimate and indexes real traffic. Item Highlights (Task 5,
  // 2026-09-06 item-highlights-per-design plan) joins the title's side of that line rather than
  // bullets'/backend's: it is a customer-facing product-fact field the PO reads as a claim about
  // THIS design, not a keyword-research surface — and the composer had NO audience-lean rule at all
  // before this task, so a unisex design's own scoped pool could carry the identical bare-gender lie
  // unchecked (the live complaint this task exists for: "Why is Women repeating Twice?").
  // A phrase naming BOTH genders ("for men and women") is inclusive, not forced.
  if ((ctx.field === 'title' || ctx.field === 'highlights') && ctx.audienceLean === 'unisex') {
    if (ctx.field === 'highlights') {
      // ITEM HIGHLIGHTS ONLY gets the design-own-name exemption (Task 5): a design whose OWN name
      // itself carries the gender (e.g. "Mother Hustler") keeps it — reusing the SAME "claim vs.
      // vocabulary" idiom rule (c) above already applies for kids/adult (`designWordSet` +
      // `foreignAudienceHits`), never a second copy. TITLE is deliberately left untouched below (no
      // exemption there): its own `designTokens` is the FAMILY-WIDE union (every sibling's name, per
      // `buildGroupTruthCtx` in listingPipeline.ts), and widening THIS rule to read it would risk an
      // untested behavior change on a path this task must not touch.
      const designWords = designWordSet(ctx.designTokens)
      const fem = foreignAudienceHits(phrase, LEAN_FEM_RE_G, designWords).length > 0
      const masc = foreignAudienceHits(phrase, LEAN_MASC_RE_G, designWords).length > 0
      if (fem !== masc) return { ok: false, reason: 'audience-lean-lie' }
    } else {
      const fem = LEAN_FEM_RE.test(phrase)
      const masc = LEAN_MASC_RE.test(phrase)
      if (fem !== masc) return { ok: false, reason: 'audience-lean-lie' }
    }
  }
  // (d) competitor APPAREL brands — outside the trademark lexicon (it covers franchises, not blanks):
  // a pool row naming another maker never ships. The family's own allowed blank brand
  // (brand_in_copy, e.g. Comfort Colors) is exempted by name.
  const bm = phrase.match(APPAREL_BRAND_RE)
  if (bm && bm[0].toLowerCase() !== (ctx.allowedBrand ?? '').toLowerCase()) return { ok: false, reason: 'competitor-brand' }
  // (e) fabric-class truth — a weight-class word must match the blank (unknown blank ⇒ none).
  const wm = phrase.match(/\b(light|mid|middle|heavy)[\s-]?weight\b/i)
  if (wm) {
    const wt = trueWeightClass(ctx.spec)
    if (!wt || !wt.startsWith(wm[1].toLowerCase().slice(0, 3))) return { ok: false, reason: 'weight-class-lie' }
  }
  // (f) fit-claim truth (Task 4, live B0DSCDZC6K: "relaxed unisex fit" on a Gildan 18000/Classic
  // blank) — a phrase asserting a FIT must match the blank's OWN spec.fit, case-insensitive
  // containment (a multi-word spec value, e.g. "Super Relaxed", still backs a single claimed word —
  // the same containment rule (e) above already uses for weight class). FAIL CLOSED: an unconfirmed
  // blank (no spec.fit at all) backs no fit claim — a fit claim with nothing behind it is exactly how
  // the live lie shipped. The spec-fact PAD's own `${spec.fit} Fit` / `Unisex Fit` fillers never reach
  // this predicate (the composer pushes them straight onto its picks, pre-truth-stage) so they are
  // unaffected regardless; "unisex" also carries no fit-claim word.
  // FIX ROUND 1 (2026-09-06): FIT_CLAIM_RE now carries 'g' and every match is examined — a phrase
  // can assert MORE THAN ONE fit/cut claim ("relaxed fit oversized tee": "relaxed fit" true, bare
  // "oversized" false) and the first true match must never launder a later false one.
  // FIX ROUND 2 (final fix wave, 2026-09-06, Important #1): ITEM HIGHLIGHTS ONLY. This rule used to be
  // field-agnostic, so it reached the TITLE and BACKEND paths the plan forbade touching — and it is a
  // SECOND fit oracle there, provably disagreeing with the title path's own (titleBand.ts:747-753
  // `scrubUnspecdGarmentClaims`, which accepts "oversize"/"cropped"/"baggy"/"tapered"/"loose" this
  // rule has never known about — Probe, spec.fit='Oversize': rule (f) rejected a true "oversized"
  // while `scrubUnspecdGarmentClaims` would accept it). Gated exactly like rule (c2) above: the title
  // path keeps its own fit oracle; unifying the two oracles into one is Phase 4 of the title
  // programme, not this task. `highlights` is the ONE field that had NO fit oracle at all before
  // Task 4 — this rule exists for it.
  if (ctx.field === 'highlights') {
    const fit = ctx.spec?.fit?.toLowerCase()
    for (const fm of phrase.matchAll(FIT_CLAIM_RE)) {
      const claim = (fm[1] ?? fm[2] ?? '').toLowerCase()
      // T4-b: normalize a spelling variant (e.g. "oversize") to the canonical class word before the
      // containment check — mirrors titleBand.ts's `fitOk`, so a blank spelled "Oversized" still
      // backs a claim spelled "oversize".
      const canonClaim = FIT_WORD_CANON[claim] ?? claim
      if (!fit || !fit.includes(canonClaim)) return { ok: false, reason: 'fit-claim-lie' }
    }
  }
  return { ok: true }
}

/** Convenience for the fills: `true` = the phrase may ship. */
export const phraseIsTrue = (phrase: string, ctx: PhraseTruthCtx): boolean => phraseTruthVerdict(phrase, ctx).ok

/* ─── THE TITLE TERMINAL NET ──────────────────────────────────────────────────────────────────── */

/**
 * The reasons the TITLE net may act on by DELETING a phrase from copy an LLM wrote.
 *
 * A candidate FILTER can reject anything for free — a rejected pool phrase costs nothing. A NET
 * deletes shipped bytes, so it only carries the reasons whose false-positive cost is bounded:
 *   • wrong-garment-noun / garment-vocab-on-non-apparel — defect (b). Blank-grounded, and the whole
 *     reason the title path had no truthful judge.
 *   • audience-lean-lie — defect (c). Fires only on an explicit seller-declared 'unisex'.
 * DELIBERATELY EXCLUDED:
 *   • competitor-brand — `stripCompetitorBlanks` already owns it on the title path and removes the
 *     BRAND WORD (keeping the rest of the phrase) with the family's own blank exempted by name.
 *     A whole-segment drop here would be strictly worse.
 *   • audience-adult-on-kids / audience-kids-on-adult — a DESIGN name legitimately carries these
 *     words ("Baby Shark", "Boys Trip"). `ctx.designTokens` exempts the family's OWN name, but only
 *     when the name RESOLVED; on an unresolved-name family the title would still be a
 *     false-positive factory, and the title is the one field where a wrong deletion is most
 *     visible. The candidate filter still rejects a genuinely foreign audience claim from the FILL,
 *     which is where the pool leaks them in.
 *   • capability-claim / weight-class-lie — `stripCapabilityClaims` and `enforceFabricTruth` are the
 *     existing owners of those two invariants; a second net would be the eighth rulebook.
 */
export const TITLE_NET_REASONS: ReadonlySet<PhraseTruthReason> = new Set<PhraseTruthReason>([
  'wrong-garment-noun',
  'garment-vocab-on-non-apparel',
  'audience-lean-lie',
])

/**
 * Makes the allowlist's own precondition executable (PO 2026-08-23, live B0DP5H8QBT: 12 kids-tee
 * children, `audience-adult-on-kids` convicted on the READ path via `phraseTruthVerdict` directly
 * but stayed silent on the TITLE terminal net because `TITLE_NET_REASONS` excludes it unconditionally
 * — the doc above states WHY (an unresolved design name is a false-positive factory) but nothing
 * ever tested for that precondition). `ctx.designTokens` non-empty is exactly "the name resolved" —
 * the same signal `familyDesignNames`/`pushDesignName` already populate before any title ctx is
 * built. TITLE_NET_REASONS itself is untouched (tests reference it by name); this is the ONE gate
 * every act-point in the net now shares — the tail match, the segment sweep, AND `scrubMoneyPhrase`'s
 * segment-0 word-level scrub (its own kids/adult branch below) — so a design name that never
 * resolved cannot become a false-positive factory at ANY granularity, not just the whole-segment one.
 */
export function titleNetActsOn(reason: PhraseTruthReason, ctx: PhraseTruthCtx): boolean {
  if (TITLE_NET_REASONS.has(reason)) return true
  if (reason === 'audience-adult-on-kids' || reason === 'audience-kids-on-adult') {
    return (ctx.designTokens?.length ?? 0) > 0
  }
  return false
}

/** The trailing audience clause every title producer can emit. Derived from the SAME
 *  `LEAN_FEM_CORE`/`LEAN_MASC_CORE` the forced-gender rule's detector and (fix round 1) strip regex
 *  use — the core already carries the `['’]?s?` apostrophe/plural forms for men/women, so this needed
 *  no separate handling for those. Before this fix this was a hand-copied `(?:men|women)` literal
 *  that pre-dated Task 7's lexicon widening entirely: its ONE caller (below, `applyTitleTruthNet`'s
 *  step 1) never recognised "for Guys"/"for Gals"/"for Dudes"/"for Bros"/"for Gents" as an audience
 *  tail at all — and, pre-existing even before Task 7, never recognised "for Ladies" either (the
 *  "orphan set" B1 names: `ladies`/`lady` were detector-only from the day rule (c2) first shipped).
 *  A tail this regex cannot see falls through to the coarser segment-sweep/whole-string scrub below,
 *  which drops the WHOLE segment or (pre-fix) leaves the word untouched entirely — the length
 *  collapse task-7-review-findings.md's B1 measured on the segmented case (47c -> 22c instead of the
 *  `for Men` twin's 46c -> 38c, clause-only). Deriving this fixes BOTH gaps at the ONE call site that
 *  decides tail-vs-segment granularity, at once. */
const AUDIENCE_TAIL_RE = new RegExp(`\\s*[,|]?\\s+for\\s+(?:${LEAN_FEM_CORE}|${LEAN_MASC_CORE})\\s*$`, 'i')

/**
 * WORD-LEVEL scrub for the title's MONEY PHRASE — segment 0 (brand + design + noun), and the whole
 * string when a title carries no separator at all. Segment 0 is never DROPPED (see the net's own
 * doctrine below), but that must not mean it is exempt from truth: PR #632/#634 wired garment-truth
 * INTO the brief/judge, yet the live parent title on B0DSCDZC6K still shipped
 * "THE CEO Motivational Entrepreneur Tee" and a per-child title shipped "Sweatshirt Business B*tch"
 * — both lies the segment sweep below can only ever catch AFTER the first separator. This is that
 * seam: it removes the OFFENDING TOKENS (a forbidden garment noun, a forced gender on a unisex
 * title, another design's name) and leaves everything true — including the brand and this design's
 * own name — exactly where it was. `primaryClass` is threaded out so `enforceSingleGarmentClass`
 * below knows which class the money phrase already committed to, without re-scanning it.
 */
function scrubMoneyPhrase(
  seg: string,
  ctx: PhraseTruthCtx,
  protectedWords: ReadonlySet<string>,
  foreignTokens?: ReadonlySet<string>,
): { text: string; primaryClass: string | null } {
  if (!seg.trim()) return { text: seg, primaryClass: null }
  let s = seg
  let primaryClass: string | null = null
  const words = (x: string): string[] => x.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const isProtected = (m: string): boolean => words(m).some((w) => protectedWords.has(w))
  // (a) wrong-garment-noun, noun by noun — the phrase-level rule (a) can only reject or accept the
  // WHOLE segment; this rejects one noun at a time so "Funny Work Shirt Sweatshirt" loses only the
  // tee-class word and keeps the truthful sweatshirt one. A protected (design-name) token is never
  // touched, same fail-open the phrase-level rule already gives the segment sweep.
  if (ctx.garmentFamily === 'none') {
    s = s.replace(GARMENT_SURFACE_RE, (m) => (isProtected(m) ? m : ''))
  } else if (ctx.garmentFamily) {
    const allowed = allowedGarmentClasses(ctx)
    if (allowed) {
      // Tracks every NOUN CLASS already kept, and the end offset of its last kept mention, so a
      // SECOND, non-adjacent mention of the SAME class ("T-Shirt … Tee Shirt", both class 'tee') can
      // be told apart from a compound noun's own second word ("Tee" immediately followed by "Shirt"
      // — one mention) AND from the PO's sanctioned noun-x2 VARIETY across DIFFERENT classes in the
      // same allowed group ("Sweatshirt … Fall Crewneck" — 'sweatshirt' and 'crewneck' are different
      // classes that fold to the same group below, never a repeat). The money-phrase half of defect 2
      // (PO 2026-08-23, live B0DP5H8QBT: "T-Shirt Graphic Tee Shirt" names the tee class three times
      // in one segment). `offset` is the callback's own match-position argument (no capture groups in
      // `GARMENT_NOUN_RE`, so the signature is exactly `(match, offset, string)`).
      const seenClasses = new Set<string>()
      let lastClass: string | null = null
      let lastEnd = -1
      s = s.replace(GARMENT_NOUN_RE, (m: string, offset: number) => {
        const cls = garmentNounClass(m)
        if (!allowed.has(cls)) return isProtected(m) ? m : ''
        // First ALLOWED class this money phrase names wins the slot; a title commits to ONE class
        // (defect 3, PO 2026-08-22) even when the family union would truthfully permit both. Grouped
        // ("crewneck" folds into "sweatshirt") so "Sweatshirt … Fall Crewneck" is not read as two.
        const grp = garmentGroup(cls)
        if (primaryClass === null) primaryClass = grp
        else if (grp !== primaryClass) return isProtected(m) ? m : ''
        // SAME group as the committed slot — now the finer, per-CLASS redundancy check: keep a repeat
        // of the SAME class only when it is ADJACENT to its own last mention (a compound noun's second
        // word); a non-adjacent repeat of a class already seen restates the same concept a second time
        // and is redundant. A DIFFERENT class in the same group (Crewneck after Sweatshirt) is not a
        // repeat at all and always survives — that pairing is the sanctioned variety, not a defect.
        const adjacent = cls === lastClass && offset - lastEnd <= 1
        if (!adjacent && seenClasses.has(cls)) return isProtected(m) ? m : ''
        seenClasses.add(cls)
        lastClass = cls
        lastEnd = offset + m.length
        return m
      })
    }
  }
  // (b) forced gender — TITLE + unisex only, and only when the phrase names ONE gender (never an
  // inclusive "for Men and Women", which `LEAN_FEM_RE`/`LEAN_MASC_RE` both match and so cancel out).
  // STRIPS with `LEAN_FEM_STRIP_RE`/`LEAN_MASC_STRIP_RE` — built from the SAME core the detector
  // just tested against (fix round 1, B1) — never a hand-copied literal that can silently stop
  // tracking the detector's own widened word list (see the strip-regex doc above `LEAN_FEM_RE_G`).
  if (ctx.field === 'title' && ctx.audienceLean === 'unisex') {
    const fem = LEAN_FEM_RE.test(s)
    const masc = LEAN_MASC_RE.test(s)
    if (fem !== masc) {
      const re = fem ? LEAN_FEM_STRIP_RE : LEAN_MASC_STRIP_RE
      s = s.replace(re, (m) => (isProtected(m) ? m : ''))
    }
  }
  // (b2) kids/adult AUDIENCE — segment 0's twin of rule (c) in `phraseTruthVerdict` (live
  // B0DP5H8QBT: "THE CEO Don't Quit Motivational T-Shirt for Men & Women | Short Sleeve" on a KIDS
  // family — the audience lie sits BEFORE the first separator, where the tail/segment sweep below
  // never looks). The predicate can only reject the WHOLE money phrase; this strips just the
  // offending CLAUSE — one or more adjacent audience words plus their connectors ("for"/"&"/"and"/
  // ","), so "for Men & Women" goes as ONE unit and never leaves a dangling "for" or "&" behind.
  // Reuses the EXACT helpers the predicate gates on (`designWordSet`, `foreignAudienceHits`, the
  // SAME ADULT/KIDS regexes) so this can never structurally disagree with rule (c) — a design's own
  // audience word ("Baby Shark", "Girl Dad") still survives, same exemption; `isProtected` is the
  // second safety rail, same as every other branch here. Gated by `titleNetActsOn` — the SAME
  // precondition (the design name RESOLVED) the tail/segment-sweep act-points already require, so a
  // "Baby Shark" family with no resolved name is not turned into a false-positive factory at the
  // WORD level either (the exact regression an early version of this branch caused — pinned by
  // contentTruthSpine.test.ts's "DELIBERATELY leaves kids/adult words alone" case).
  if (ctx.audience === 'kids' || ctx.audience === 'adult') {
    const reason: PhraseTruthReason = ctx.audience === 'kids' ? 'audience-adult-on-kids' : 'audience-kids-on-adult'
    if (titleNetActsOn(reason, ctx)) {
      const designWords = designWordSet(ctx.designTokens)
      const re = ctx.audience === 'kids' ? ADULT_AUDIENCE_RE : KIDS_AUDIENCE_RE
      const clauseRe = new RegExp(`(?:\\bfor\\s+)?${re.source}(?:\\s*(?:,|&|\\band\\b)\\s*${re.source})*`, 'gi')
      s = s.replace(clauseRe, (m) => {
        if (foreignAudienceHits(m, re, designWords).length === 0) return m
        return isProtected(m) ? m : ''
      })
    }
  }
  // (c) another design's name — a maximal per-WORD strike (not a whole-segment drop: this phrase is
  // never dropped). `foreignTokens` is the SAME per-design set `isForeignToDesign` checks elsewhere
  // (designScope.ts's STRICT-NAMES partition); tokenizing each chunk with `designScopeTokens` keeps
  // the two in agreement (a "Business B*tch" foreign entry folds to the tokens that "Business" and
  // "B*tch" each resolve to, so both chunks strike even though "b*tch" splits on the star).
  if (foreignTokens && foreignTokens.size) {
    s = s.split(/(\s+)/).map((chunk) => {
      if (!chunk.trim()) return chunk
      const toks = designScopeTokens(chunk)
      if (toks.length === 0) return chunk
      const foreign = toks.some((t) => foreignTokens.has(t))
      const protectedTok = toks.some((t) => protectedWords.has(t))
      return foreign && !protectedTok ? '' : chunk
    }).join('')
  }
  return { text: s.replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim(), primaryClass }
}

/**
 * The garment GROUP (see `garmentGroup`) a text names FIRST, reading left to right — no allowed-set
 * filter, so this also answers "what has the title already committed to?" for a caller (the title
 * BAND PAD, `titleBand.ts`'s `candidateSegments`) that only has plain strings, not a `PhraseTruthCtx`.
 * Exported for exactly that seam: defect 3 (one garment class per title) must hold even when the
 * SECOND class is proposed by the pad AFTER the net already settled on the first one — the pad is
 * the LAST writer, so a gate that only ran inside `applyTitleTruthNet` could not reach it. Pure.
 */
export function dominantGarmentGroup(text: string): string | null {
  for (const m of text.matchAll(GARMENT_NOUN_RE)) return garmentGroup(garmentNounClass(m[0]))
  return null
}

/**
 * EVERY garment GROUP (see `garmentGroup`) a text names, not just the first — the whole-string twin
 * of `dominantGarmentGroup`. This is the ONE-GARMENT-CLASS-PER-TITLE check applied to an ASSEMBLED
 * string as a whole (the title-settle rewrite, 2026-08-22): `enforceSingleGarmentClass` prevents a
 * SECOND class from being ADDED once one is committed, but a caller that wants to VERIFY an already-
 * assembled candidate (the additive search, a money-tail candidate) needs the plain fact "how many
 * DISTINCT classes does this text name", independent of which one came first. A family union may
 * truthfully permit more than one class (sweatshirt + hoodie); a single title still may not name two
 * — "Sweatshirt … Fall Crewneck" is ONE group (crewneck folds into sweatshirt), "Shirt … Sweatshirt"
 * is two. Pure.
 */
export function garmentGroupsIn(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(GARMENT_NOUN_RE)) out.add(garmentGroup(garmentNounClass(m[0])))
  return out
}

/**
 * Does TEXT restate the SAME garment NOUN CLASS via more than one mention (live B0DP5H8QBT,
 * 2026-08-23: "T-Shirt Graphic Tee Shirt" names the tee class three times in one segment; live
 * B0DSCDZC6K, 2026-09-02: "Funny Work Shirts Shirt" and "Graphic Top Tshirt" each name it twice)?
 *
 * NO ADJACENCY EXEMPTION (garment-repetition defect class, 2026-09-02 — this function's own PRIOR
 * version had one: "same class, ≤1 char apart ⇒ collapse to one mention", meant to let "Tee"+"Shirt"
 * read as the single compound "Tee Shirt"). That heuristic was a POSITION proxy standing in for a
 * VOCABULARY fact, and a proxy cannot tell a genuine two-word noun from an ACCIDENTAL collision of
 * two distinct same-class words that simply happen to sit next to each other: "Funny Work Shirts
 * Shirt" (plural then singular of the SAME word) and "Graphic Top Tshirt" (two DIFFERENT tee-class
 * nouns) both shipped live because both are "same class, adjacent" exactly like "Tee Shirt" is. The
 * cure moves the compound recognition to where it structurally belongs: `GARMENT_NOUN_RE` now has
 * `tee[\s-]?shirts?` as its own multi-word alternative (the same tier as `tank[\s-]?tops?` and
 * `hooded[\s-]?sweatshirts?`), so "Tee Shirt" is captured as ONE regex match, not two — this
 * function never sees it as two mentions to begin with, and needs no position-based exemption for
 * it. With the one true compound handled at the tokenizer, ANY two SEPARATE matches of the same
 * class — adjacent or not, a plural-of-the-same-word or a different alias entirely — are what they
 * plainly are: two mentions of one concept. Every surface variant this repo's vocabulary knows
 * (plural, hyphen, glued, alias) is caught by construction, because it is caught by the SAME fold
 * `phraseTruthVerdict`'s wrong-garment-noun rule (a) and every other truth check in this file share
 * — no second table, and nothing to keep in sync by hand when a new alias is added to it.
 *
 * DELIBERATELY `garmentNounClass`, NOT the coarser `garmentGroup` — "Pullover" and "Crewneck" fold to
 * the SAME group (`garmentGroup('crewneck') === 'sweatshirt'`) for the UNRELATED one-class-per-title
 * rule, but they are the PO's own sanctioned noun-x2 VARIETY, not a repeat ("Long Sleeve Pullover Fall
 * Crewneck" is a pinned gold pattern — see `truthBandGate.test.ts`'s seven strings). `garmentNounClass`
 * keeps them apart (`'sweatshirt'` vs `'crewneck'`) while still collapsing every true respelling of the
 * SAME word ("T-Shirt"/"TShirt"/"Tee"/"Tee Shirt"/"Shirt"/"Top" all → `'tee'`).
 *
 * SAME VOCABULARY, NO SECOND TABLE: this reuses `GARMENT_NOUN_RE`/`garmentNounClass` — the exact
 * per-noun classification `phraseTruthVerdict`'s wrong-garment-noun rule (a) already keys off — so
 * every spelling folds here exactly as it does everywhere else in this file. Pure.
 */
export function hasRedundantGarmentMention(text: string): boolean {
  const matches = [...(text ?? '').matchAll(GARMENT_NOUN_RE)]
  if (matches.length < 2) return false
  const seenClasses = new Set<string>()
  for (const m of matches) {
    const cls = garmentNounClass(m[0])
    if (seenClasses.has(cls)) return true
    seenClasses.add(cls)
  }
  return false
}

/** Which allowed garment GROUP (see `garmentGroup`) a text names FIRST, reading left to right. Pure. */
function firstGarmentClass(text: string, allowed: ReadonlySet<string>): string | null {
  for (const m of text.matchAll(GARMENT_NOUN_RE)) {
    const cls = garmentNounClass(m[0])
    if (allowed.has(cls)) return garmentGroup(cls)
  }
  return null
}

/**
 * ONE GARMENT CLASS PER TITLE (defect 3, PO 2026-08-22, live B0DSCDZC6K:
 * "… Sweatshirt Long Sleeve Tee | …"). The family union may truthfully permit MORE than one class
 * (sweatshirt + hoodie) — that is what `mixedFamilies` is for — but a single title still commits to
 * ONE of them; naming two, even two both-true classes, is not a garment LIE `phraseTruthVerdict`
 * catches (each noun is individually true of the family) and so survives the sweep above untouched.
 * The class named FIRST wins (money-phrase priority, the same doctrine segment 0 itself follows);
 * every later mention of a DIFFERENT allowed class is removed — word-level where it already scrubbed
 * segment 0 (via `primaryClassHint`, so this never re-decides what that pass already committed to),
 * whole-segment after it, reusing the exact safety rails the sweep above uses (a sole surviving
 * design word is kept, a dropped separator is inherited).
 */
function enforceSingleGarmentClass(
  title: string,
  ctx: PhraseTruthCtx,
  protectHay: string,
  primaryClassHint: string | null,
): string {
  if (!title || !title.trim() || !ctx.garmentFamily || ctx.garmentFamily === 'none') return title
  const allowed = allowedGarmentClasses(ctx)
  if (!allowed || allowed.size <= 1) return title
  const t = title.trim()
  const primary = primaryClassHint ?? firstGarmentClass(t, allowed)
  if (!primary) return t
  const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const protectedWords = new Set(words(protectHay).filter((w) => w.length > 2))
  const otherClassPresent = (seg: string): boolean => {
    for (const m of seg.matchAll(GARMENT_NOUN_RE)) {
      const cls = garmentNounClass(m[0])
      if (allowed.has(cls) && garmentGroup(cls) !== primary) return true
    }
    return false
  }
  const stripOtherClass = (seg: string): string => seg.replace(GARMENT_NOUN_RE, (m) => {
    const cls = garmentNounClass(m)
    return (!allowed.has(cls) || garmentGroup(cls) === primary || words(m).some((w) => protectedWords.has(w))) ? m : ''
  }).replace(/\s{2,}/g, ' ').trim()

  const parts = t.split(/\s*([|,])\s*/)
  if (parts.length <= 1) return otherClassPresent(t) ? stripOtherClass(t) : t
  const kept: string[] = [otherClassPresent(parts[0]) ? stripOtherClass(parts[0]) : parts[0]]
  let carried: string | null = null
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const sep = parts[i]
    const seg = parts[i + 1]
    if (sep === undefined || seg === undefined || !seg.trim()) continue
    if (otherClassPresent(seg)) {
      const rest = [parts[0], ...kept.slice(1), ...parts.slice(i + 2)].join(' ')
      const restWords = new Set(words(rest))
      const solelyDesign = words(seg).some((w) => protectedWords.has(w) && !restWords.has(w))
      if (!solelyDesign) {
        carried = carried === '|' || sep === '|' ? '|' : (carried ?? sep)
        continue
      }
    }
    const useSep = carried === '|' || sep === '|' ? '|' : sep
    carried = null
    kept.push(useSep === '|' ? ` | ${seg}` : `, ${seg}`)
  }
  return kept.join('').replace(/\s{2,}/g, ' ').replace(/[\s,|]+$/g, '').trim()
}

/**
 * COLLAPSE A REDUNDANT SAME-CLASS MENTION, ONE PIPE SIDE AT A TIME (defect 2, PO 2026-08-23, live
 * B0DP5H8QBT: "T-Shirt, Graphic Tees | Kids Toddler Tee" names the tee class THREE times —
 * "T-Shirt", "Tees" and "Tee" — and shipped that way because nothing upstream of the terminal gate
 * ACTIVELY repairs this; `titleHasDuplicateConcept`/`hasRedundantGarmentMention` only ever DETECTED
 * it, at the ship door, where a whole-string verify can only accept or refuse a candidate — never
 * repair one already in hand). `enforceSingleGarmentClass` above cures a DIFFERENT garment class
 * appearing a second time; this cures the SAME class appearing a THIRD (or more) time.
 *
 * THE PO'S OWN SANCTIONED NOUN-×2 SHAPE — one mention on EACH side of the ONE pipe ("Tee Shirt | …
 * TShirt") — is a claim about the PIPE, never about a comma clause inside one side ("T-Shirt,
 * Graphic Tees" is ordinary comma coordination, not a second side the noun is entitled to). So this
 * walks PIPE sides independently and never touches a side that only ever names a class once — which
 * is every clean title, and the gold shape itself: `hasRedundantGarmentMention` (the SAME predicate
 * the gate uses, no second vocabulary) is the guard, so a side this function edits is, by
 * construction, exactly the side the gate would have refused.
 *
 * WITHIN A REDUNDANT SIDE: the FIRST mention-group of a class wins (reading order —
 * `collapseRepeatedWords`'s own "earliest position is most valuable" doctrine, applied here to a
 * concept instead of a literal word) and the SECOND is removed together with its ENCLOSING
 * comma-delimited clause, not just the bare noun — "do not blindly delete the last if that leaves a
 * dangling fragment": stripping only "Tees" out of "Graphic Tees" would leave an orphan "Graphic"
 * exactly like the "Mind" class `dropOrphanPoolFragments` exists to prevent, so the whole clause goes
 * together, the same drop-a-clause-not-a-word granularity `applyTitleTruthNet`'s own segment sweep
 * uses. A protected design word that survives NOWHERE else in the title is never collateral damage —
 * the same rail `enforceSingleGarmentClass` applies, reused rather than re-derived.
 *
 * Shortens only (never adds words) — the band pad downstream re-fills from true material, exactly
 * the doctrine every other net in this file follows. Pure, and a no-op on any side that never
 * restates a class.
 */
function collapseRedundantGarmentMention(title: string, protectHay: string): string {
  if (!title || !title.trim()) return title
  const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const protectedWords = new Set(words(protectHay).filter((w) => w.length > 2))
  const collapseSide = (side: string): string => {
    let s = side
    // Bounded loop: each pass removes AT MOST one redundant clause. Re-scanning (rather than
    // computing every redundant span up front) keeps the index math trivial — after a removal every
    // later offset would otherwise need re-basing — and a title naming one class three-plus times is
    // already an extreme outlier, so the bound is generous without being unbounded.
    for (let guard = 0; guard < 4; guard++) {
      if (!hasRedundantGarmentMention(s)) break
      const seen = new Set<string>()
      let lastClass: string | null = null
      let lastEnd = -1
      let redundant: { start: number; end: number } | null = null
      for (const m of s.matchAll(GARMENT_NOUN_RE)) {
        const cls = garmentNounClass(m[0])
        const start = m.index ?? 0
        const adjacent = cls === lastClass && start - lastEnd <= 1
        if (!adjacent) {
          if (seen.has(cls)) { redundant = { start, end: start + m[0].length }; break }
          seen.add(cls)
        }
        lastClass = cls
        lastEnd = start + m[0].length
      }
      if (!redundant) break
      // Expand to the enclosing comma-delimited clause — never past a comma on either side, never
      // past the side's own boundary (there is no pipe inside `side` by construction).
      const before = s.slice(0, redundant.start)
      const after = s.slice(redundant.end)
      const clauseStart = before.lastIndexOf(',')
      const commaAfterRel = after.indexOf(',')
      const spanStart = clauseStart >= 0 ? clauseStart : 0
      const spanEnd = commaAfterRel >= 0 ? redundant.end + commaAfterRel : s.length
      const clause = s.slice(spanStart, spanEnd)
      const withoutClause = (s.slice(0, spanStart) + s.slice(spanEnd)).trim()
      // DESIGN-WORD SAFETY RAIL (same rail `enforceSingleGarmentClass` applies): never delete a
      // protected word that would survive nowhere else in this side.
      const restWords = new Set(words(withoutClause))
      const solelyDesign = words(clause).some((w) => protectedWords.has(w) && !restWords.has(w))
      if (solelyDesign) break
      s = withoutClause
    }
    return s.replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim()
  }
  return title.split(/\s*\|\s*/).map(collapseSide).join(' | ')
}

/**
 * TERMINAL title truth net — the ONE deterministic net that removes an UNTRUE phrase from a shipped
 * title, on every producer and every path (installed at `scrubPublished`, the single choke point
 * both `recommended_title` and `per_child_titles` pass through).
 *
 * WHY SEGMENTS ARE SAFE HERE AND NOT IN PROSE: an Amazon title is a phrase LIST — "BRAND Design
 * Noun | Keyphrase, Keyphrase, Keyphrase" — so dropping one segment leaves a grammatical title.
 * The FIRST segment is never DROPPED WHOLESALE: it carries brand + design name + product noun (the
 * money phrase), and destroying it is strictly worse than the lie it might contain. But "never
 * dropped" is not "never judged" (live B0DSCDZC6K, 2026-08-22: the parent title's own segment 0 said
 * "Tee" on a sweatshirt/hoodie family, and BCS/DQ's said "Sweatshirt Business B*tch" — a sibling's
 * name — and both survived every prior version of this net because segment 0 was skipped entirely).
 * `scrubMoneyPhrase` above judges it WORD BY WORD instead: a forbidden garment noun, a forced gender,
 * or a foreign design-name token is removed; the brand, this design's own name, and every true word
 * stay exactly where they were. Shortening is the only edit this makes; the band net downstream
 * re-pads from SPEC facts, never from the pool.
 *
 * `protectHay` (the family's design names) is the second safety rail: a segment is KEPT whenever
 * dropping it would delete a design word that survives NOWHERE ELSE in the title. A design name may
 * legitimately contain a comma ("See You Later, Alligator"), which would otherwise put half of it in
 * a droppable segment — and losing the seller's design is strictly worse than keeping a lie beside
 * it. A phrase that merely RESTATES design words already present elsewhere is still droppable.
 *
 * `opts.rejectSegment` is the SECOND droppable predicate (2026-08-21, live B0DSCDZC6K): a phrase
 * that is perfectly TRUE of the product but belongs to ANOTHER DESIGN in the family. The caller
 * supplies it (the per-child exit passes designScope's STRICT-NAMES partition — the same seam the
 * Item Highlight uses; the broadcast/parent title passes none, because a family hub title is
 * answerable to every design in the family). It reuses this net's segment machinery rather than
 * adding a second net: same never-drop-segment-0 rule, same separator inheritance, same
 * design-protection rail — and on a per-child title `protectHay` is THAT design's own name only,
 * so a sibling design's name is droppable instead of protected. `opts.foreignTokens` is the SAME
 * partition's token set (not just the phrase predicate), so `scrubMoneyPhrase` can strike a sibling's
 * name WORD BY WORD out of segment 0 too — the phrase predicate alone cannot, since it answers
 * "drop the whole phrase?" and segment 0 is never wholly dropped.
 *
 * LAST, `enforceSingleGarmentClass` folds in defect 3: even after every noun left standing is
 * individually true, at most ONE garment class may appear in the finished title. Then
 * `collapseRedundantGarmentMention` folds in defect 2's cross-segment half (PO 2026-08-23): even
 * within the one class the title committed to, it may not name that class a third time by restating
 * it in a comma clause on the SAME side of the pipe.
 *
 * Idempotent (a second pass finds nothing left to drop) and a no-op when `ctx` names no blank.
 */
export function applyTitleTruthNet(
  title: string,
  ctx: PhraseTruthCtx,
  protectHay = '',
  opts?: {
    rejectSegment?: (seg: string) => boolean
    foreignTokens?: ReadonlySet<string>
    /** BROADCAST/parent titles only (PO 2026-08-22, live B0DSCDZC6K parent): `protectHay` there is
     *  the UNION of every sibling's name, so a plain word that happens to ALSO be one sibling's
     *  name token ("business", from "Business B*tch") can coincidentally "protect" an unrelated
     *  market phrase ("mind your business tshirt") that is not about any design at all — and
     *  `carriesSoleDesignWord` then keeps the whole lie rather than dropping the segment. When true,
     *  a segment blocked from a whole-segment drop this way is word-scrubbed instead of kept
     *  verbatim. DEFAULT FALSE — a per-child exit's `protectHay` is THAT design's own name, where a
     *  match is a genuine design-identity hit ("See You Later, Alligator Tee" — the design survives
     *  WITH its "Tee" attached, PO ruling: losing the design is worse than the lie beside it) and
     *  must keep the existing verbatim-preservation behavior byte-for-byte. */
    scrubProtectedOverlap?: boolean
  },
): string {
  if (!title || !title.trim()) return title
  let t = title.trim()
  const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const protectedWords = new Set(words(protectHay).filter((w) => w.length > 2))
  /** Would dropping `seg` erase a design word the rest of the title no longer carries? */
  const carriesSoleDesignWord = (seg: string, rest: string): boolean => {
    const restWords = new Set(words(rest))
    return words(seg).some((w) => protectedWords.has(w) && !restWords.has(w))
  }

  // 1. The audience tail is its own phrase — judge and drop it WITHOUT taking its segment's content
  //    with it ("… Fall Crewneck for Women" must lose only " for Women").
  const tailMatch = t.match(AUDIENCE_TAIL_RE)
  if (tailMatch) {
    const verdict = phraseTruthVerdict(tailMatch[0], ctx)
    if (!verdict.ok && titleNetActsOn(verdict.reason, ctx)) {
      t = t.slice(0, t.length - tailMatch[0].length).replace(/[\s,|]+$/g, '').trim()
    }
  }

  // 2. Segment sweep. Split KEEPING the separators so the survivors rejoin exactly as written.
  const parts = t.split(/\s*([|,])\s*/)
  if (parts.length <= 1) {
    // No separator at all — this whole string IS the money phrase. Word-scrub it (2b below still
    // runs on the result via enforceSingleGarmentClass at the bottom of this function).
    return scrubMoneyPhrase(t, ctx, protectedWords, opts?.foreignTokens).text
  }
  // segment 0 = the money phrase: judged word-by-word above, never dropped as a whole.
  const seg0 = scrubMoneyPhrase(parts[0], ctx, protectedWords, opts?.foreignTokens)
  const kept: string[] = [seg0.text]
  // A dropped segment's separator is INHERITED by the next survivor. Dropping the phrase after the
  // pipe must not demote the title from the PO's gold "BRAND Design Noun | keyphrase" shape to a
  // comma list — the lie goes, the structure stays.
  let carried: string | null = null
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const sep = parts[i]
    let seg = parts[i + 1]
    if (sep === undefined || seg === undefined || !seg.trim()) continue
    const verdict = phraseTruthVerdict(seg, ctx)
    const untrue = !verdict.ok && titleNetActsOn(verdict.reason, ctx)
    if (untrue || opts?.rejectSegment?.(seg) === true) {
      // Everything that would remain if this segment went — segment 0 + the kept tail + the segments
      // still ahead. The design must survive the net; a redundant restatement need not.
      const rest = [parts[0], ...kept.slice(1), ...parts.slice(i + 2)].join(' ')
      if (!carriesSoleDesignWord(seg, rest)) {
        carried = carried === '|' || sep === '|' ? '|' : (carried ?? sep)
        continue                                                          // drop the untrue phrase
      }
      // A protected design word survives NOWHERE ELSE, so the whole segment stays verbatim — UNLESS
      // the caller has told us that protection is family-wide (the broadcast title), where a bare
      // word collision is not a genuine design mention (see `scrubProtectedOverlap`'s doc above).
      if (opts?.scrubProtectedOverlap) seg = scrubMoneyPhrase(seg, ctx, protectedWords, opts?.foreignTokens).text || seg
    }
    // Rejoin in the shape the producers write: " | " around a pipe, ", " after a comma.
    const useSep = carried === '|' || sep === '|' ? '|' : sep
    carried = null
    kept.push(useSep === '|' ? ` | ${seg}` : `, ${seg}`)
  }
  const swept = kept.join('').replace(/\s{2,}/g, ' ').replace(/[\s,|]+$/g, '').trim()
  // 3. ONE garment class for the whole title (defect 3) — primed with the class segment 0 already
  //    committed to, so this never re-litigates what `scrubMoneyPhrase` just decided.
  return collapseRedundantGarmentMention(enforceSingleGarmentClass(swept, ctx, protectHay, seg0.primaryClass), protectHay)
}
