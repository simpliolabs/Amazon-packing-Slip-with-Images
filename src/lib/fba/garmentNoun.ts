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
type FamilyBase = Omit<GarmentNoun, 'seedNoun' | 'ptWord' | 'display'> & { defaultSeed: string; defaultDisplay: string }
const FAMILY_TABLE: { test: RegExp; base: FamilyBase }[] = [
  { test: /(?:^|_)(HAT|CAP|VISOR)(?:_|$)/, base: { family: 'headwear', noun: 'hat', aliases: ['snapback cap', 'dad hat', 'trucker hat', 'bucket hat', 'baseball cap', 'snapback', 'cap', 'visor', 'hat'], defaultSeed: 'hat', defaultDisplay: 'Hat', categoryHead: (aud) => `hats for ${aud}` } },
  { test: /(?:^|_)(BEANIE|KNIT_CAP)(?:_|$)/, base: { family: 'beanie', noun: 'beanie', aliases: ['knit beanie', 'winter hat', 'knit hat', 'knit cap', 'beanie'], defaultSeed: 'beanie', defaultDisplay: 'Beanie', categoryHead: (aud) => `beanies for ${aud}` } },
  { test: /(?:^|_)(HOODIE)(?:_|$)/, base: { family: 'hoodie', noun: 'hoodie', aliases: ['pullover hoodie', 'hooded sweatshirt', 'hoodie'], defaultSeed: 'hoodie', defaultDisplay: 'Hoodie', categoryHead: (aud) => `graphic hoodies for ${aud}` } },
  { test: /(?:^|_)(SWEATSHIRT|SWEATER)(?:_|$)/, base: { family: 'sweatshirt', noun: 'sweatshirt', aliases: ['crewneck sweatshirt', 'crew neck sweatshirt', 'pullover', 'crewneck', 'sweatshirt'], defaultSeed: 'sweatshirt', defaultDisplay: 'Sweatshirt', categoryHead: (aud) => `graphic sweatshirts for ${aud}` } },
  { test: /(?:^|_)(POLO)(?:_|$)/, base: { family: 'polo', noun: 'polo shirt', aliases: ['polo shirt', 'polo'], defaultSeed: 'polo shirt', defaultDisplay: 'Polo Shirt', categoryHead: (aud) => `polo shirts for ${aud}` } },
  { test: /(?:^|_)(TANK_TOP|TANK)(?:_|$)/, base: { family: 'tank', noun: 'tank top', aliases: ['muscle tank', 'muscle tee', 'tank top', 'tank'], defaultSeed: 'tank top', defaultDisplay: 'Tank Top', categoryHead: (aud) => `tank tops for ${aud}` } },
  { test: /(?:^|_)(DRESS)(?:_|$)/, base: { family: 'dress', noun: 'dress', aliases: ['t-shirt dress', 'sundress', 'dress'], defaultSeed: 'dress', defaultDisplay: 'Dress', categoryHead: (aud) => `dresses for ${aud}` } },
  { test: /(?:^|_)(LEGGINGS|TIGHTS)(?:_|$)/, base: { family: 'leggings', noun: 'leggings', aliases: ['leggings', 'tights'], defaultSeed: 'leggings', defaultDisplay: 'Leggings', categoryHead: (aud) => `leggings for ${aud}` } },
  { test: /(?:^|_)(SOCKS|SOCK)(?:_|$)/, base: { family: 'socks', noun: 'socks', aliases: ['crew socks', 'novelty socks', 'socks'], defaultSeed: 'socks', defaultDisplay: 'Socks', categoryHead: (aud) => `novelty socks for ${aud}` } },
  { test: /(?:^|_)(JACKET|COAT)(?:_|$)/, base: { family: 'jacket', noun: 'jacket', aliases: ['windbreaker', 'jacket', 'coat'], defaultSeed: 'jacket', defaultDisplay: 'Jacket', categoryHead: (aud) => `jackets for ${aud}` } },
  { test: /(?:^|_)(PAJAMAS|SLEEPWEAR)(?:_|$)/, base: { family: 'pajamas', noun: 'pajamas', aliases: ['pajama set', 'pjs', 'pajamas'], defaultSeed: 'pajamas', defaultDisplay: 'Pajamas', categoryHead: (aud) => `pajamas for ${aud}` } },
  { test: /(?:^|_)(APRON)(?:_|$)/, base: { family: 'apron', noun: 'apron', aliases: ['kitchen apron', 'apron'], defaultSeed: 'apron', defaultDisplay: 'Apron', categoryHead: (aud) => `aprons for ${aud}` } },
]

/** Which garment families' alias vocabularies are recognized in a title — the union of all
 *  non-shirt family aliases plus the shirt words. Consumers extend their own APPAREL_WORDS scans
 *  with this so "find the garment word in the title" stops missing cap/snapback/hoodie/etc. */
export const ALL_GARMENT_ALIAS_WORDS: string[] = Array.from(new Set([
  ...SHIRT_BASE.aliases,
  ...FAMILY_TABLE.flatMap((f) => f.base.aliases),
  // single-word forms so token scans match
  'hat', 'cap', 'snapback', 'beanie', 'hoodie', 'sweatshirt', 'crewneck', 'polo', 'tank', 'dress', 'leggings', 'socks', 'jacket', 'coat', 'pajamas', 'apron', 'visor',
]))

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
  if (!base) {
    // shirt/null/PRODUCT/unknown → the frozen shirt base, title-aware only for tee vs t-shirt.
    const t = (title ?? '').toLowerCase()
    const teeInTitle = /\btees?\b/.test(t) && !/\bt-?shirts?\b/.test(t)
    return teeInTitle
      ? { ...SHIRT_BASE, seedNoun: 'tee', ptWord: 'tee' }
      : SHIRT_BASE
  }
  // Title-aware overlay: first in-family alias present in the title wins (longest aliases first
  // so "snapback cap" beats "cap"). Else the family default.
  const t = (title ?? '').toLowerCase()
  const sortedAliases = [...base.aliases].sort((a, b) => b.length - a.length)
  const found = sortedAliases.find((a) => t.includes(a))
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
