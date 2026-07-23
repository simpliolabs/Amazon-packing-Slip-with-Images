/**
 * Audience-relational compound seed helper (Fix C, 2026-07-23).
 *
 * Given a design phrase like "He's Golfing" + lean=lean_female + productType=SHIRT, returns compound
 * seeds like ["golf widow shirt", "golf widow tee", "golf wife shirt", "golf wife tee"] that Persona 2
 * (V3.1a) will read from input.nicheSeeds and lead with under its compound-niche-first precedence.
 *
 * Deterministic — no LLM. Returns [] when the pattern doesn't fire (skip token lists documented inline).
 *
 * WHY THIS MODULE EXISTS SEPARATELY: listingPipeline.ts pulls in a broken transitive dep chain locally
 * (iceberg-js), so a vitest test that imports from listingPipeline.ts cannot run in the local env.
 * A small standalone module with the pure helper is testable in isolation and gives the CI + shadow
 * runbook a fast feedback loop on this deterministic detector.
 */

export type AudienceLean = 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null | undefined

/** DESIGN-PHRASE PRONOUN/IMPLICATION HINTS — signal "the design is ABOUT someone of gender X". Distinct
 *  from 7.1a's narrow wearer-identity closed lexicon {wife,girlfriend/husband,boyfriend}; those signal
 *  wearer-identity, these signal spouse-identity so we can name the wearer's SPOUSE as the niche.
 *
 *  Deliberately conservative: contraction/possessive/relational forms ONLY. Bare pronouns "he"/"she"/
 *  "him" are TOO COMMON in generic phrases ("The Way He Loves Me", "She Told Me So") to be reliable
 *  spouse-of-wearer signals. Widen based on shadow data if the false-negative rate on real golf-widow
 *  designs proves problematic. */
export const DESIGN_PHRASE_MALE_HINTS = new Set(["he's", 'hes', 'his', 'hubby', 'husbands'])
export const DESIGN_PHRASE_FEMALE_HINTS = new Set(["she's", 'shes', 'her', 'hers', 'wifey', 'mamas'])

/** Relational carriers that mean "the design already names a spouse" — Fix C skips these (gift-SKU
 *  territory; the seller already put the widow noun in the phrase, so the compound is discoverable). */
export const DESIGN_PHRASE_HAS_RELATIONAL = new Set([
  'widow', 'widower', 'wife', 'husband', 'girlfriend', 'boyfriend', 'wifey', 'hubby',
])

const CONNECTORS = new Set(['a', 'an', 'the', 'is', 'am', 'are', 'was', 'be', 'been', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'at', 'with'])
const GARMENT = new Set(['shirt', 'shirts', 't-shirt', 'tshirt', 'tee', 'tees', 'hoodie', 'sweatshirt', 'tank', 'cap', 'hat'])

/** Extract the primary theme token from a design phrase. Returns root-normalized string ("golfing" →
 *  "golf"), skipping pronoun hints, connectors, garment words, tokens shorter than 3 chars. */
function extractPrimaryTheme(rawToks: string[]): string | null {
  const HINTS = new Set([...DESIGN_PHRASE_MALE_HINTS, ...DESIGN_PHRASE_FEMALE_HINTS])
  for (const t of rawToks) {
    const norm = t.replace(/['’]s?$/, '')
    if (HINTS.has(norm) || HINTS.has(t)) continue
    if (CONNECTORS.has(norm)) continue
    if (GARMENT.has(norm)) continue
    if (norm.length < 3) continue
    // Root-normalize: strip -ing gerund, then collapse doubled-consonant-before-ing (shopping → shop,
    // running → run, sitting → sit), then -er agent and singular -s. Bag-of-words matching already
    // lives in the coverage core; the important part is the root token is a real English word.
    let root = norm.replace(/ing$/, '')
    if (root.length >= 3
        && root[root.length - 1] === root[root.length - 2]
        && /[bcdfghjklmnpqrstvwxyz]/i.test(root[root.length - 1])) {
      root = root.slice(0, -1)
    }
    root = root.replace(/er$/, '').replace(/s$/, '')
    if (root.length < 3) continue
    return root
  }
  return null
}

/** Choose the garment noun used inside compound seeds. Kept minimal so this module has no dependency
 *  on garmentNounFor (which lives in keyword-engine and would drag imports into this pure helper). */
function garmentNounForCompound(productType: string | null): string {
  return /T_SHIRT|SHIRT|TEE/i.test(productType ?? '') ? 'shirt' : 'shirt'
}

/** Fix C main helper. See module doc + inline conditions. */
export function deriveAudienceRelationalCompounds(
  designName: string,
  lean: AudienceLean,
  productType: string | null,
): string[] {
  if (!lean || lean === 'unisex') return []
  const name = (designName || '').toLowerCase().trim()
  if (!name) return []
  const rawToks = name.replace(/[^a-z0-9\s'’]/g, ' ').split(/\s+/).filter(Boolean)
  const normToks = rawToks.map((t) => t.replace(/['’]s?$/, ''))
  // Gift-SKU skip: the seller has already put a relational noun in the design phrase; the widow-style
  // compound is already discoverable via the design phrase itself. Do not double-emit.
  if (normToks.some((t) => DESIGN_PHRASE_HAS_RELATIONAL.has(t))) return []
  // Fire condition: SPOUSE gender = OPPOSITE of wearer's lean. Wearer=female → look for a male hint in
  // the design phrase (widow-of-a-male niche). Symmetric for wearer=male + female hint (widower/husband).
  const wantFemaleWidow = lean === 'female' || lean === 'lean_female'
  const wantMaleWidow = lean === 'male' || lean === 'lean_male'
  const hasMaleHint = rawToks.some((t) =>
    DESIGN_PHRASE_MALE_HINTS.has(t) || DESIGN_PHRASE_MALE_HINTS.has(t.replace(/['’]s?$/, '')),
  )
  const hasFemaleHint = rawToks.some((t) =>
    DESIGN_PHRASE_FEMALE_HINTS.has(t) || DESIGN_PHRASE_FEMALE_HINTS.has(t.replace(/['’]s?$/, '')),
  )
  const fires = (wantFemaleWidow && hasMaleHint) || (wantMaleWidow && hasFemaleHint)
  if (!fires) return []
  const theme = extractPrimaryTheme(rawToks)
  if (!theme) return []
  const ptWord = garmentNounForCompound(productType)
  const rel = wantFemaleWidow ? ['widow', 'wife'] : ['husband', 'boyfriend']
  const seeds: string[] = []
  for (const r of rel) {
    seeds.push(`${theme} ${r} ${ptWord}`)
    seeds.push(`${theme} ${r} tee`)
  }
  // Cap at 4 seeds; dedup + trim.
  return [...new Set(seeds.map((s) => s.trim()).filter(Boolean))].slice(0, 4)
}
