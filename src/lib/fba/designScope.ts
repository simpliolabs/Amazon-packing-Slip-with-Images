/**
 * designScope.ts — the ONE cross-design pool partition for multi-design families (pure, no I/O).
 *
 * WHY ONE SEAM. A multi-design family shares ONE keyword pool, but a token unique to ANOTHER
 * design's identity is FOREIGN to this design — the deterministic bullet backstop once appended
 * "argentina" into a Haiti child's bullet, and the Item Highlight composed "Beast Mode Shirt" onto
 * the Don't Quit design (PO 2026-08-21, B0DQ5YZH38). Bullets, descriptions, backend AND the Item
 * Highlight must all answer "is this pool phrase foreign to design X?" with the SAME rule, so the
 * rule lives here and every fan-out calls it. Extracted verbatim from listingPipeline's
 * `foreignToksFor` (parity-audit structural build 2026-07-03) — behavior-preserving.
 *
 * THE RULE. For design X, a token is FOREIGN when it appears in another design's vocabulary
 * (design name + vision identity phrases) and is NOT: (a) in X's own vocabulary, (b) a family
 * NICHE word — present in the family's title text, or frequent in the family keyword pool
 * (>=10% of keywords, min 3), or shared by >=50% of the design NAMES (min 2). Niche words
 * ("fishing") are never foreign; only the other designs' distinguishing words are.
 * TWO MODES: SOFT (default — bullets/description/backend, byte-for-byte the extracted rule) and
 * STRICT NAMES (the Item Highlight): another design's NAME token is never pool-frequency-exempt —
 * a pool harvested on one identity is full of that design, and the ruling is absolute.
 */
import { bulletTokens } from '@/lib/keyword-engine/bulletCoverage'

/** Gender-variant token normalizer for the FILL dedup sets: "mens"/"womens" must count as the
 *  same token as "men"/"women", or a gendered keyphrase gets appended on top of the audience tail
 *  (live B0DMXMH266 parent: "Mens Tees for Men" — "men" three times). bulletTokens already splits
 *  "men's" down to "men", so only the fused plurals need mapping. */
export const genderNormTok = (t: string): string => (t === 'mens' ? 'men' : t === 'womens' ? 'women' : t)

/** Fill-dedup normalizer: gender variants + a light plural fold ("tees"≈"tee", "shirts"≈"shirt")
 *  so the fill never appends a near-duplicate of a word already in the title. Set-membership only —
 *  the folded form is never rendered. */
export const fillNormTok = (t: string): string => {
  const g = genderNormTok(t)
  const p = g.length > 3 ? g.replace(/s$/, '') : g
  // "t-shirt" tokenizes to "shirt" (the 1-char "t" is dropped) but the fused "tshirt" survives
  // whole — fold them together or the fill ships "Graphic T-Shirts, Tshirt" (live B0DMXMH266).
  return p === 'tshirt' ? 'shirt' : p
}

/** The partition's token view of any text: the coverage tokenizer + the fill fold. */
export const designScopeTokens = (s: string): string[] => bulletTokens(s || '').map(fillNormTok)

export interface DesignVocab {
  key: string
  /** The design's resolved NAME ("Don't Quit"). Its tokens are the design's identity proper. */
  name: string
  /** Optional vision identity phrases (designTheme + seedKeywords) — broad vocabulary ("gym",
   *  "motivation") that extends the design's own set; always subject to every niche exemption. */
  identity?: string[]
}

export interface DesignScopeOpts {
  /** Family-level title text (canonical + prior title) — its tokens are niche, never foreign. */
  familyTitleText: string
  /** The family keyword pool — tokens frequent across it are niche, never foreign (SOFT only). */
  poolKeywords: string[]
  /** STRICT NAMES (the Item Highlight truth rule, PO 2026-08-21): another design's NAME tokens are
   *  foreign even when the pool is full of them. A pool harvested on ONE design's identity is
   *  full of that design ("beast mode" in 40% of B0DQ5YZH38's rows) — the pool-frequency exemption
   *  would re-license exactly the lie the ruling forbids. Name tokens stay exempt only via the family
   *  title or ≥50% name-sharing; identity (vision) tokens keep every exemption. Default false = the
   *  bullets/description behavior (review-caught "Fishing Trip" niche-word regression) unchanged. */
  strictNames?: boolean
}

/**
 * Build the per-design FOREIGN-token resolver. `foreignFor(key)` = the set of folded tokens a pool
 * phrase must NOT carry to be composable for design `key`. Keys unknown to the resolver get the
 * union of every vocabulary minus niche (nothing is "own") — callers always pass a real key.
 */
export function buildForeignDesignTokens(designs: DesignVocab[], opts: DesignScopeOpts): (key: string) => Set<string> {
  const nameToks = new Map(designs.map((d) => [d.key, new Set(designScopeTokens(d.name))]))
  const identToks = new Map(designs.map((d) => [d.key, new Set((d.identity ?? []).flatMap((p) => designScopeTokens(p)))]))
  const ownToks = new Map(designs.map((d) => [d.key, new Set([...(nameToks.get(d.key) ?? []), ...(identToks.get(d.key) ?? [])])]))
  // Name-sharing counts use the NAME tokens only (identity seeds are broad and would inflate sharing).
  const nameTokCounts = new Map<string, number>()
  for (const s of nameToks.values()) for (const t of s) nameTokCounts.set(t, (nameTokCounts.get(t) ?? 0) + 1)
  // NICHE-VOCABULARY EXEMPTIONS (review-caught, both directions):
  // - A token unique to ONE design's name can still be the family's niche word ("Fishing Trip" on
  //   a fishing family) — gutting the siblings' pools of it starves them. Tokens frequent in the
  //   FAMILY KEYWORD POOL (>=10% of keywords, min 3) or present in the family's title are niche.
  // - The old ">=2 design names ⇒ niche" rule resurrected the original bug the other way: two
  //   Argentina-variant designs among 12 made "argentina" free for the other 10. Now a token must
  //   appear in >=50% of the design names (min 2) to count as niche BY NAME-SHARING alone.
  const titleToks = new Set<string>(designScopeTokens(opts.familyTitleText))
  const poolToks = new Set<string>()
  {
    const tokKwCount = new Map<string, number>()
    for (const kw of opts.poolKeywords) for (const t of new Set(designScopeTokens(kw))) tokKwCount.set(t, (tokKwCount.get(t) ?? 0) + 1)
    const poolThresh = Math.max(3, Math.ceil(opts.poolKeywords.length * 0.1))
    for (const [t, c] of tokKwCount) if (c >= poolThresh) poolToks.add(t)
  }
  const nameShareThresh = Math.max(2, Math.ceil(nameToks.size * 0.5))
  const cache = new Map<string, Set<string>>()
  return (key: string): Set<string> => {
    const hit = cache.get(key)
    if (hit) return hit
    const own = ownToks.get(key) ?? new Set<string>()
    const foreign = new Set<string>()
    for (const d of designs) {
      if (d.key === key) continue
      for (const t of nameToks.get(d.key) ?? []) {
        if (own.has(t) || titleToks.has(t)) continue
        if ((nameTokCounts.get(t) ?? 0) >= nameShareThresh) continue
        if (!opts.strictNames && poolToks.has(t)) continue
        foreign.add(t)
      }
      for (const t of identToks.get(d.key) ?? []) {
        if (own.has(t) || titleToks.has(t) || poolToks.has(t)) continue
        if ((nameTokCounts.get(t) ?? 0) >= nameShareThresh) continue
        foreign.add(t)
      }
    }
    cache.set(key, foreign)
    return foreign
  }
}

/** TRUE when a pool phrase carries a token foreign to design `key` — i.e. it names ANOTHER design.
 *  A BM line never carries "don't quit" (PO 2026-08-21). */
export function isForeignToDesign(keyword: string, foreign: Set<string>): boolean {
  if (foreign.size === 0) return false
  return designScopeTokens(keyword).some((t) => foreign.has(t))
}

/**
 * RULING Y2 (phase-y1-rulings.md, 2026-09-28). `buildForeignDesignTokens` with `strictNames: true`
 * bans a sibling's NAME at the single-TOKEN level — so ANY keyword sharing even one word with a
 * sibling's name is foreign to every OTHER sibling too. Measured on the six real B0DSCDZC6K names:
 * "entrepreneur" (one token of "Entrepreneur Definition") struck "gifts for entrepreneurs" from
 * every OTHER design's plan; "hustle" (one token of "Hustle Definiton") struck "hustle sweatshirt"
 * even with nothing else contaminated. On a fishing family, "fishing" (one token of "Fishing
 * Trip") struck the family's own niche word from Bass Master and Reel Cool Dad's OWN rows. This is
 * the exact regression designScope.ts:17-19's SOFT-mode doc warns about, now happening on NAMES.
 *
 * THE FIX: a sibling's name is foreign only as a PHRASE — every one of its own tokens must occur
 * TOGETHER in the same keyword. "entrepreneur" alone is not "Entrepreneur Definition"; "hustle
 * sweatshirt" does not carry "Hustle Definiton" (missing "definit"); "fishing gifts for dad" does
 * not carry "Fishing Trip" (missing "trip"). A keyword is short (a search query), so testing it as
 * one unit is well-behaved here in a way it was not for free-form bullet prose (designScope.ts's
 * SOFT/STRICT split is unaffected — this is a THIRD mode, phrase-level, additive to neither).
 *
 * Scope: the keyword-plan scoper (bullets/description/backend) and the title candidate filter —
 * both test discrete KEYWORD STRINGS. The per-child title ship door and the Item Highlight composer
 * are untouched (separate, already-ruled channels — PO 2026-08-21 — that test assembled TITLE
 * SEGMENTS, not a raw keyword pool); identity/vision vocabulary is untouched (it still flows
 * through `buildForeignDesignTokens`, token-level, exactly as designScope.ts's own doc describes).
 *
 * ONE fold, not a lexicon: the censored spelling of a slogan (`b*tch` / `btch` / `bitch`) collapses
 * to a single canonical token so a design's own slogan and a plainly-spelled market keyword compare
 * as the SAME phrase — without this, "business bitch sweatshirt" would stop matching "Business
 * B*tch" once matching moves from any-shared-token to every-token-together (bulletTokens drops the
 * lone "b" and never stems "bitch"/"btch" toward each other on its own).
 */
const foldCensoredSlogan = (s: string): string => (s || '').replace(/b\W?i?\W?tch/gi, 'btch')

/** Per-design NAME token sequence for phrase matching (censor-folded, empty/short tokens dropped).
 *  Never fed through the family-title / pool-frequency niche exemptions — a sibling's own distinct
 *  name is never the family's "niche word" by construction; only a genuinely single shared WORD
 *  (which the phrase-unit test itself already lets through) is. */
export function buildForeignNamePhrases(designs: { key: string; name: string }[]): (key: string) => string[][] {
  const phrases = new Map(designs.map((d) => [d.key, designScopeTokens(foldCensoredSlogan(d.name))] as const))
  const cache = new Map<string, string[][]>()
  return (key: string): string[][] => {
    const hit = cache.get(key)
    if (hit) return hit
    const out = [...phrases.entries()].filter(([k, toks]) => k !== key && toks.length > 0).map(([, toks]) => toks)
    cache.set(key, out)
    return out
  }
}

/** Typo-tolerant token equality. The recorded LIVE design names in this family carry their own
 *  one-letter misspellings ("Billionare Coming Soon", "Hustle Definiton" — K4 fixture), while the
 *  market keyword pool naturally spells them correctly ("billionaire", "definition"). A strict
 *  token-equality phrase test would let a plainly-spelled market keyword for a sibling's own
 *  slogan back through simply because ITS name is misspelled — reopening exactly the leak this
 *  fix exists to close. Two tokens match when equal, or when they share a >=6-char prefix and
 *  differ in length by at most 2 (one inserted/omitted/substituted letter) — long enough to never
 *  fold unrelated short words together ("hustle" vs "husband" shares only 3 chars). */
const typoTolerant = (a: string, b: string): boolean => {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 2) return false
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i >= 6
}

/** TRUE when `keyword` carries ANOTHER design's full name as a token-sequence UNIT — every token of
 *  that name present (typo-tolerant) in the keyword, censor-folded on both sides. A single shared
 *  word is never enough (RULING Y2). */
export function isForeignNamePhrase(keyword: string, namePhrases: string[][]): boolean {
  if (!namePhrases.length) return false
  const kToks = designScopeTokens(foldCensoredSlogan(keyword))
  return namePhrases.some((toks) => toks.every((t) => kToks.some((kt) => typoTolerant(t, kt))))
}
