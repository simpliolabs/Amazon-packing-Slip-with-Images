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
