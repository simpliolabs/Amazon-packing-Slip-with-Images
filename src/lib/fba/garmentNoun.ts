/**
 * garmentNoun.ts — ONE shared garment-noun resolver (PO 2026-07-21, workflow w6728l4wz).
 *
 * WHY: the FBA pipeline branches apparel vs non-apparel (looksApparel), but WITHIN apparel it
 * assumed every garment is a SHIRT — ~17 seams across keywordResearcher.ts + listingPipeline.ts
 * defaulted the garment noun to 'shirt'/'tshirt'. So a HAT (B0H85M81PG) got seeded "cashflow
 * tshirt" → a t-shirt keyword universe, a shirt-framed title, and shirt item-highlights. This is
 * the leaf module every seam imports so the garment noun is derived ONCE from the authoritative
 * SP-API productType, with the listing title allowed to UPGRADE within the same family only
 * (hat → "snapback cap") — never cross it (a shirt-templated hat title can never flip back to
 * 'shirt').
 *
 * BLANK FIRST (PO 2026-08-21, SELLER_PROFILE.md "Keyword universe follows the BLANK"): for keyword
 * seeding, the resolved blank's garment_family (blank_specs, SKU-first) OUTRANKS the productType —
 * `resolveGarment` below. The productType path stays byte-identical as the fallback.
 *
 * DEPENDENCY-SAFE: this is a leaf — imports nothing from listingPipeline/keywordResearcher, so
 * both (and syncKeywordIntelligence) can import it with zero cycle risk.
 *
 * ZERO SHIRT REGRESSION (the load-bearing guarantee): for family='shirt' AND for the
 * null/''/PRODUCT/unknown default, EVERY field returns the exact legacy literal each call site
 * currently defaults to — verified against the code 2026-07-21:
 *   seedNoun     'tshirt'                 (keywordResearcher buildSeedFromTitle default)
 *   noun         'shirt'                  (buildFallbackSeed / garmentBrandSeed / highlights default)
 *   ptWord       't-shirt'                (listingPipeline expandDesignNiche /SHIRT|TEE/ branch)
 *   display      'Tee Shirt'              (title humanizer shirt display)
 *   categoryHead 'graphic tees for {aud}' (broadCategorySeed literal)
 * Shirts are ~95% of the catalog; only non-shirt productTypes (HAT/SWEATSHIRT/DRESS/…) — the
 * currently-broken minority — resolve to anything new. GARMENT_SHIRT_FROZEN documents the tuple
 * a live [GARMENT_DIFF] shadow log (and any future golden test) asserts against.
 */

/** Amazon Listings-Items productTypes that ARE clothing/worn-on-body. Moved here (was
 *  listingPipeline.ts:1002) so the apparel gate and the noun resolver read ONE source. Re-exported
 *  from listingPipeline for back-compat. Matched on _-delimited tokens so SWEATSHIRT hits but
 *  MEMORY_CARD never can. */
export const APPAREL_PRODUCT_TYPES = /(?:^|_)(SHIRT|SWEATSHIRT|SWEATER|HOODIE|DRESS|SKIRT|PANTS|SHORTS|SOCKS|HAT|COAT|JACKET|UNDERPANTS|UNDERWEAR|BRA|PAJAMAS|SLEEPWEAR|SWIMWEAR|LEOTARD|TIGHTS|LEGGINGS|BODYSUIT|ONESIE|ROMPER|BLOUSE|CARDIGAN|VEST|ROBE|COSTUME|OUTFIT|TRACKSUIT|OVERALLS|SUIT|KURTA|SAREE|SALWAR_SUIT_SET|APPAREL)(?:_|$)/

/** Which truth fixed a garment family (see resolveGarment). */
export type GarmentSource = 'blank' | 'productType'

export interface GarmentNoun {
  /** canonical group key: shirt | headwear | sweatshirt | hoodie | tank | dress | ... */
  family: string
  /** prose singular ('shirt', 'hat', 'sweatshirt') — buildFallbackSeed/garmentBrandSeed/highlights default */
  noun: string
  /** JS-seed append word, no hyphen ('tshirt', 'cap', 'hat') — buildSeedFromTitle default */
  seedNoun: string
  /** hyphenated search form ('t-shirt', 'cap', 'hat') — expandDesignNiche ptWord */
  ptWord: string
  /** Title-cased display for LLM briefs ('Tee Shirt', 'Snapback Cap', 'Hoodie') */
  display: string
  /** same-family words the title may upgrade the noun to — NEVER cross-family */
  aliases: string[]
  /** broadCategorySeed replacement; {aud} filled at call ('graphic tees for women') */
  categoryHead: (aud: string) => string
  /** Which truth fixed the family. Absent on SHIRT_BASE / the productType path; 'blank' when
   *  blank_specs.garment_family did (resolveGarment) — PROOF of the garment, so consumers whose
   *  legacy guard was "only if the title says tee" may trust the family instead. */
  source?: GarmentSource
}

/** The FROZEN shirt/default tuple — byte-identical to every current call-site literal.
 *  When GARMENT_NOUN is off, consumers use THIS for every product (100% current behavior). */
export const SHIRT_BASE: GarmentNoun = {
  family: 'shirt',
  noun: 'shirt',
  seedNoun: 'tshirt',
  ptWord: 't-shirt',
  display: 'Tee Shirt',
  aliases: ['shirt', 't-shirt', 'tshirt', 'tee', 'graphic tee'],
  categoryHead: (aud) => `graphic tees for ${aud}`,
}
export const GARMENT_SHIRT_FROZEN = Object.freeze({ ...SHIRT_BASE, categoryHead: 'graphic tees for {aud}' })

// Ordered mapping: first matching productType regex wins. Each entry is the family base BEFORE
// the title-aware overlay (which only sets seedNoun/ptWord/display from an in-family alias found
// in the title). Additive — the shirt/default base is the fallthrough, never rewritten.
type FamilyBase = Omit<GarmentNoun, 'seedNoun' | 'ptWord' | 'display'> & {
  defaultSeed: string
  defaultDisplay: string
  /** The title phrases that may UPGRADE seedNoun/ptWord/display. Defaults to `aliases`. A blank-
   *  sourced family narrows this so the title can refine WITHIN the blank's truth ("long sleeve
   *  tee") but never erase it (a bare "tee" in the title must not demote a 6014 to a short-sleeve
   *  seed). `aliases` stays the full membership list for the head-noun scans. */
  overlay?: string[]
}
// Named so the BLANK path below can reuse the SAME objects (a blank-sourced sweatshirt is
// byte-identical to a productType-sourced one except for `source`).
const HOODIE_BASE: FamilyBase = { family: 'hoodie', noun: 'hoodie', aliases: ['pullover hoodie', 'hooded sweatshirt', 'hoodie'], defaultSeed: 'hoodie', defaultDisplay: 'Hoodie', categoryHead: (aud) => `graphic hoodies for ${aud}` }
const SWEATSHIRT_BASE: FamilyBase = { family: 'sweatshirt', noun: 'sweatshirt', aliases: ['crewneck sweatshirt', 'crew neck sweatshirt', 'pullover', 'crewneck', 'sweatshirt'], defaultSeed: 'sweatshirt', defaultDisplay: 'Sweatshirt', categoryHead: (aud) => `graphic sweatshirts for ${aud}` }
const FAMILY_TABLE: { test: RegExp; base: FamilyBase }[] = [
  { test: /(?:^|_)(HAT|CAP|VISOR)(?:_|$)/, base: { family: 'headwear', noun: 'hat', aliases: ['snapback cap', 'dad hat', 'trucker hat', 'bucket hat', 'baseball cap', 'snapback', 'cap', 'visor', 'hat'], defaultSeed: 'hat', defaultDisplay: 'Hat', categoryHead: (aud) => `hats for ${aud}` } },
  { test: /(?:^|_)(BEANIE|KNIT_CAP)(?:_|$)/, base: { family: 'beanie', noun: 'beanie', aliases: ['knit beanie', 'winter hat', 'knit hat', 'knit cap', 'beanie'], defaultSeed: 'beanie', defaultDisplay: 'Beanie', categoryHead: (aud) => `beanies for ${aud}` } },
  { test: /(?:^|_)(HOODIE)(?:_|$)/, base: HOODIE_BASE },
  { test: /(?:^|_)(SWEATSHIRT|SWEATER)(?:_|$)/, base: SWEATSHIRT_BASE },
  { test: /(?:^|_)(POLO)(?:_|$)/, base: { family: 'polo', noun: 'polo shirt', aliases: ['polo shirt', 'polo'], defaultSeed: 'polo shirt', defaultDisplay: 'Polo Shirt', categoryHead: (aud) => `polo shirts for ${aud}` } },
  { test: /(?:^|_)(TANK_TOP|TANK)(?:_|$)/, base: { family: 'tank', noun: 'tank top', aliases: ['muscle tank', 'muscle tee', 'tank top', 'tank'], defaultSeed: 'tank top', defaultDisplay: 'Tank Top', categoryHead: (aud) => `tank tops for ${aud}` } },
  { test: /(?:^|_)(DRESS)(?:_|$)/, base: { family: 'dress', noun: 'dress', aliases: ['t-shirt dress', 'sundress', 'dress'], defaultSeed: 'dress', defaultDisplay: 'Dress', categoryHead: (aud) => `dresses for ${aud}` } },
  { test: /(?:^|_)(LEGGINGS|TIGHTS)(?:_|$)/, base: { family: 'leggings', noun: 'leggings', aliases: ['leggings', 'tights'], defaultSeed: 'leggings', defaultDisplay: 'Leggings', categoryHead: (aud) => `leggings for ${aud}` } },
  { test: /(?:^|_)(SOCKS|SOCK)(?:_|$)/, base: { family: 'socks', noun: 'socks', aliases: ['crew socks', 'novelty socks', 'socks'], defaultSeed: 'socks', defaultDisplay: 'Socks', categoryHead: (aud) => `novelty socks for ${aud}` } },
  { test: /(?:^|_)(JACKET|COAT)(?:_|$)/, base: { family: 'jacket', noun: 'jacket', aliases: ['windbreaker', 'jacket', 'coat'], defaultSeed: 'jacket', defaultDisplay: 'Jacket', categoryHead: (aud) => `jackets for ${aud}` } },
  { test: /(?:^|_)(PAJAMAS|SLEEPWEAR)(?:_|$)/, base: { family: 'pajamas', noun: 'pajamas', aliases: ['pajama set', 'pjs', 'pajamas'], defaultSeed: 'pajamas', defaultDisplay: 'Pajamas', categoryHead: (aud) => `pajamas for ${aud}` } },
  { test: /(?:^|_)(APRON)(?:_|$)/, base: { family: 'apron', noun: 'apron', aliases: ['kitchen apron', 'apron'], defaultSeed: 'apron', defaultDisplay: 'Apron', categoryHead: (aud) => `aprons for ${aud}` } },
]

/** Single-token garment HEAD NOUNS only — words that BY THEMSELVES name a garment. Deliberately
 *  excludes the modifier halves of multi-word aliases (dad/trucker/bucket/baseball/knit/winter/
 *  hooded/crew/neck/muscle/novelty/set/kitchen/graphic): task #156 — the old
 *  ALL_GARMENT_ALIAS_WORDS `.split()` union made those "apparel words" for EVERY listing, so
 *  "Best Dad Ever Shirt" seeded as "best ever dad" and "<Design> Graphic Tee" as "<design>
 *  graphic", poisoning the shared keyword_seed_pool. Token scans must use THIS list (or
 *  familyScanWords below); multi-word aliases are matched as whole phrases via `.includes()` the
 *  way garmentNounFor already does. */
export const GARMENT_HEAD_WORDS: ReadonlySet<string> = new Set([
  'shirt', 'shirts', 't-shirt', 'tshirt', 'tshirts', 'tee', 'tees',
  'hat', 'cap', 'snapback', 'beanie', 'visor',
  'hoodie', 'sweatshirt', 'crewneck', 'pullover',
  'polo', 'tank', 'top', 'tops',
  // `jersey` names a garment BY ITSELF and belongs in this list on the docstring's own terms. It is
  // added for the title's product-type strike (PO ruling 2026-08-13: title words describe the design,
  // they do not chase a DIFFERENT product's searches — a shopper who wants a real jersey will not buy
  // a graphic tee). It carries the same place-name ambiguity this list already accepts for `cap` /
  // `top` / `dress` ("Graduation Cap", "Over the Top", "Dress to Impress"); consumers resolve it by
  // HEAD NOUN and by design-vocabulary fallback, so "New Jersey Girl Shirt" is about a shirt and a
  // design genuinely about New Jersey keeps its own word.
  'jersey', 'jerseys',
  'dress', 'sundress', 'leggings', 'tights', 'socks',
  'jacket', 'coat', 'windbreaker',
  'pajamas', 'pajama', 'pjs', 'apron',
])

/** The garment tokens a TITLE SCAN may recognize for THIS listing: the resolved family's alias
 *  tokens plus the shirt words, filtered to head nouns. Family-scoped on purpose — a shirt listing
 *  must never pick up 'cap'/'coat'/'dress' from its design phrase ("Graduation Cap…", "Coat of
 *  Arms…"), and no listing may treat a modifier ('dad', 'graphic') as a garment word. For
 *  g=SHIRT_BASE this is a subset of the historical shirt-only literal, so shirt behavior is
 *  byte-identical in every flag mode. */
export function familyScanWords(g: GarmentNoun): Set<string> {
  const out = new Set<string>()
  for (const alias of [...g.aliases, ...SHIRT_BASE.aliases, g.noun, g.seedNoun]) {
    for (const tok of (alias ?? '').toLowerCase().split(/\s+/)) {
      if (GARMENT_HEAD_WORDS.has(tok)) out.add(tok)
    }
  }
  return out
}

/** The head nouns of THIS family only, stemmed. Deliberately NOT familyScanWords: that one always
 *  unions the shirt words (so a hat listing could never treat `tee` as another product) and holds no
 *  plurals (so `oversized tshirts` read as foreign on a shirt listing). Both were caught by the tests
 *  below before this shipped. */
export function ownHeadNouns(g: GarmentNoun): Set<string> {
  const out = new Set<string>()
  for (const alias of [...g.aliases, g.noun, g.seedNoun]) {
    for (const tok of (alias ?? '').toLowerCase().split(/\s+/)) {
      if (GARMENT_HEAD_WORDS.has(tok)) out.add(tok.replace(/s$/, ''))
    }
  }
  return out
}

/**
 * The keyword's HEAD NOUN, when it names a garment this listing does NOT sell.
 *
 * Returns the stemmed head noun to strike on, or null when the phrase is about this listing's own
 * garment or about no garment at all. English noun phrases put the head LAST, which is the whole
 * safety property: `usa jersey` is about a jersey (foreign -> "jersey"), while `new jersey girl
 * shirt` is about a shirt (in-family -> null). Scanning for ANY occurrence instead of the head would
 * strike the second one and cost a New Jersey design its own word.
 *
 * Callers decide what a foreign head MEANS. The title's grounding filter falls back to the design
 * vocabulary, so a design genuinely about New Jersey still keeps "jersey" (PO ruling 2026-08-13:
 * title words describe the design; they do not chase a different product's searches).
 *
 * Pure/total.
 */
export function foreignHeadNoun(keyword: string, g: GarmentNoun): string | null {
  const own = ownHeadNouns(g)
  const toks = (keyword ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  for (let i = toks.length - 1; i >= 0; i--) {
    if (!GARMENT_HEAD_WORDS.has(toks[i])) continue
    const stem = toks[i].replace(/s$/, '')
    return own.has(stem) ? null : stem
  }
  return null
}

/**
 * Resolve the garment noun for a productType + optional title. productType fixes the FAMILY; the
 * title may upgrade seedNoun/ptWord/display to an in-family alias present in the title text
 * (e.g. HAT + "Snapback Cap" title → seedNoun 'snapback cap', display 'Snapback Cap'). Pure/total.
 *
 * NOTE: this ALWAYS resolves correctly — the GARMENT_NOUN feature flag is applied by consumers
 * (they use SHIRT_BASE when the flag is off, so shirts + the not-yet-flipped catalog stay 100%
 * byte-identical to today). Keeping the flag OUT of this function keeps it pure + testable.
 */
export function garmentNounFor(productType?: string | null, title?: string | null): GarmentNoun {
  const pt = (productType ?? '').trim().toUpperCase()
  const base = pt ? FAMILY_TABLE.find((f) => f.test.test(pt))?.base : undefined
  if (!base) return shirtFor(title)
  return fromBase(base, title)
}

/** shirt/null/PRODUCT/unknown → the frozen shirt base, title-aware only for tee vs t-shirt. */
function shirtFor(title?: string | null): GarmentNoun {
  const t = (title ?? '').toLowerCase()
  const teeInTitle = /\btees?\b/.test(t) && !/\bt-?shirts?\b/.test(t)
  return teeInTitle
    ? { ...SHIRT_BASE, seedNoun: 'tee', ptWord: 'tee' }
    : SHIRT_BASE
}

/** Title-aware overlay: first in-family overlay phrase present in the title wins (longest first so
 *  "snapback cap" beats "cap"). Else the family default. */
function fromBase(base: FamilyBase, title?: string | null): GarmentNoun {
  const t = (title ?? '').toLowerCase()
  const sorted = [...(base.overlay ?? base.aliases)].sort((a, b) => b.length - a.length)
  const found = sorted.find((a) => t.includes(a))
  const seedNoun = found ?? base.defaultSeed
  const display = found
    ? found.replace(/\b\w/g, (c) => c.toUpperCase())
    : base.defaultDisplay
  return {
    family: base.family,
    noun: base.noun,
    seedNoun,
    ptWord: seedNoun,
    display,
    aliases: base.aliases,
    categoryHead: base.categoryHead,
  }
}

// ─── BLANK-FIRST RESOLUTION (PO ruling 2026-08-21, SELLER_PROFILE.md "Keyword universe follows the
// BLANK, not Amazon's productType") ─────────────────────────────────────────────────────────────
//
// B0GQ6PGR2N is a Comfort Colors 6014 long-sleeve TEE whose Amazon productType is SWEATSHIRT.
// garmentNounFor(productType) fixed the family from that productType, so the keyword seeding
// emitted a sweatshirt universe ("graphic sweatshirts for women" head, "<design> sweatshirt"
// niche head) onto a tee — 47 of its 52 harvested keywords were sweatshirt vocabulary. The
// resolved blank (blank_specs.garment_family, SKU-first — the PO's own rule) is the product
// truth; Amazon's productType is the FALLBACK when no blank resolves. This table maps each
// garment_family to the GarmentNoun shape every seed builder already consumes, so the cure is
// one input swap at the seed-derivation site, not a new vocabulary.

export interface GarmentResolution extends GarmentNoun {
  /** 'blank' = blank_specs.garment_family drove the family; 'productType' = the legacy path. */
  source: GarmentSource
  /** The garment_family that drove a 'blank' resolution; null on the productType path. */
  blankFamily: string | null
}

/** SLEEVE-LENGTH CLASSIFICATION of SHIRT_BASE's own aliases (garment-family alias-inheritance
 *  class, PO ruling 2026-09-03, live B0DSCDZC6K: "...Long Sleeve Cotton Polyester Tshirt" — a
 *  LONG-SLEEVE blank's title calling itself a Tshirt). 'tshirt'/'t-shirt'/'tee'/'graphic tee'
 *  specifically name the short-sleeve tee silhouette (unqualified, "tee"/"tshirt" reads as
 *  short-sleeve by convention — the long-sleeve FORM always spells it out: "long sleeve tee").
 *  Bare 'shirt' is silhouette-NEUTRAL (a shirt may be any sleeve length) and stays available to
 *  every family. Named and exported so a family base is built by FILTERING this set, never by
 *  hand-picking which one word to drop — any future sleeve-specific family (a 3/4-sleeve base,
 *  say) reuses the same filter and is correct by construction instead of by memory. */
export const SHORT_SLEEVE_IMPLYING_ALIASES: ReadonlySet<string> = new Set(['tshirt', 't-shirt', 'tee', 'graphic tee'])
/** SHIRT_BASE's aliases with every short-sleeve-implying word removed — "these words assert the
 *  WRONG sleeve length on a long-sleeve family" derived structurally from SHIRT_BASE itself (the
 *  short-sleeve default family), not retyped. */
const SHIRT_BASE_SLEEVE_NEUTRAL_ALIASES = SHIRT_BASE.aliases.filter((a) => !SHORT_SLEEVE_IMPLYING_ALIASES.has(a))

/** Long-sleeve tee = the SHIRT family (same head nouns, same scans, same niche-head namespace as
 *  its short-sleeve siblings — the design niche is shared) with a long-sleeve seed + category
 *  head so the universe carries long-sleeve vocabulary instead of sweatshirt vocabulary. The
 *  overlay is long-sleeve phrases ONLY: the title may refine to "long sleeve tee" but a bare
 *  "tee"/"shirt" in the title can never drop the sleeve.
 *
 *  ALIASES EXCLUDE SHORT_SLEEVE_IMPLYING_ALIASES (PO ruling 2026-09-03): this list used to spread
 *  `...SHIRT_BASE.aliases` WHOLESALE, handing 'tshirt'/'t-shirt'/'tee'/'graphic tee' to every
 *  consumer of `.aliases` (listingPipeline.ts's `garmentFactSegments`, which title-cases every
 *  alias into a candidate title-pad segment) as if they were true of a LONG-SLEEVE blank — the
 *  live defect. `SHIRT_BASE_SLEEVE_NEUTRAL_ALIASES` keeps only the sleeve-neutral remainder
 *  ('shirt'), so any future consumer of `.aliases` is correct by construction, not by a
 *  hand-picked exception for this one family. */
const LONG_SLEEVE_OVERLAY = ['long sleeve t-shirt', 'long sleeve tshirt', 'long sleeve tee', 'long sleeve shirt', 'longsleeve shirt', 'longsleeve tee']
const LONG_SLEEVE_TEE_BASE: FamilyBase = {
  family: 'shirt',
  noun: 'shirt',
  aliases: [...LONG_SLEEVE_OVERLAY, 'long sleeve', ...SHIRT_BASE_SLEEVE_NEUTRAL_ALIASES],
  overlay: LONG_SLEEVE_OVERLAY,
  defaultSeed: 'long sleeve shirt',
  defaultDisplay: 'Long Sleeve Shirt',
  categoryHead: (aud) => `long sleeve shirts for ${aud}`,
}
/** Kids tee = the SHIRT family with a kids/youth audience head. The category head ignores the
 *  title-inferred adult audience (a kids family never seeds "for women" — SELLER_PROFILE IH truth
 *  ruling 2026-08-21).
 *
 *  UNFILTERED `...SHIRT_BASE.aliases` IS CORRECT HERE (verified 2026-09-03, the same pass that
 *  fixed LONG_SLEEVE_TEE_BASE above): migration 058's 64000B row states `sleeve: 'Short Sleeve'`,
 *  so 'tshirt'/'t-shirt'/'tee' are TRUE of this family — spreading them wholesale asserts no wrong
 *  sleeve length. This is the inverse-direction check the alias-bleed class calls for: a
 *  short-sleeve family inheriting short-sleeve words is not the bug; only a family inheriting a
 *  WRONG-sleeve word (LONG_SLEEVE_TEE_BASE inheriting SHORT-sleeve words) was. */
const KIDS_OVERLAY = ['toddler shirt', 'toddler tee', 'youth shirt', 'youth tee', 'kids shirt', 'kids tee', 'boys shirt', 'girls shirt']
const KIDS_TEE_BASE: FamilyBase = {
  family: 'shirt',
  noun: 'kids shirt',
  aliases: [...KIDS_OVERLAY, ...SHIRT_BASE.aliases],
  overlay: KIDS_OVERLAY,
  defaultSeed: 'kids shirt',
  defaultDisplay: 'Kids Tee Shirt',
  categoryHead: () => 'graphic tees for kids',
}

/** blank_specs.garment_family → the family base. 'shirt' = the frozen SHIRT_BASE path (tee vs
 *  t-shirt title overlay), byte-identical to the no-blank shirt resolution. Unknown values (a
 *  future family the catalog gains before this table does) fall through to the productType path
 *  — fail-open, never a guess. */
const BLANK_FAMILY_BASES: Readonly<Record<string, FamilyBase | 'shirt'>> = {
  tee: 'shirt',
  long_sleeve_tee: LONG_SLEEVE_TEE_BASE,
  kids_tee: KIDS_TEE_BASE,
  sweatshirt: SWEATSHIRT_BASE,
  hoodie: HOODIE_BASE,
}

/**
 * THE garment resolver for keyword seeding: the resolved blank's garment_family when one resolved
 * for the family, else Amazon's productType + title exactly as garmentNounFor (byte-identical —
 * the no-blank path IS garmentNounFor). Pure/total; the GARMENT_NOUN flag stays with the consumer.
 */
export function resolveGarment(opts: { productType?: string | null; title?: string | null; blankFamily?: string | null }): GarmentResolution {
  const bf = (opts.blankFamily ?? '').trim().toLowerCase()
  const base = bf ? BLANK_FAMILY_BASES[bf] : undefined
  if (base) {
    const g = base === 'shirt' ? shirtFor(opts.title) : fromBase(base, opts.title)
    return { ...g, source: 'blank', blankFamily: bf }
  }
  return { ...garmentNounFor(opts.productType, opts.title), source: 'productType', blankFamily: null }
}
