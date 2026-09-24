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
 * phrase must NOT carry to be composable for design `key`. T2 (Round T, cross-design leak): a key
 * UNKNOWN to the resolver (not one of `designs`) gets an EMPTY set — nothing is foreign, a
 * byte-identical pass-through. It used to get the UNION of every OTHER vocabulary (nothing is
 * "own"), the single most dangerous answer for exactly the caller this guards against: one that
 * failed to resolve a real key and fell back to something else (a SKU), where the union then made
 * that row's OWN name/words look foreign to itself.
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
  const knownKeys = new Set(designs.map((d) => d.key))
  const cache = new Map<string, Set<string>>()
  return (key: string): Set<string> => {
    // T2 (Round T, cross-design leak) — an UNKNOWN key (never in `designs`) used to fall through to
    // `own = new Set()`, which made the loop below treat NOTHING as this key's own vocabulary and
    // return the UNION of every design's foreign tokens — the most dangerous possible answer for a
    // caller that failed to resolve a real key. Measured (unknownkey.probe.test.ts): a
    // per_child_bullets row whose `designKey` is unset falls back to its SKU, a key this resolver was
    // never built with, and `isForeignToDesign("Hustle Definiton", foreign)` came back TRUE against
    // ITS OWN name — 3 bullets in, 2 shipped, the identity bullet dropped, and `pushFields.ts` then
    // pushes that short array over the live five. An unrecognized key gets EMPTY (nothing is foreign)
    // — the doc comment above ("callers always pass a real key") was aspirational, not enforced; this
    // makes the failure mode fail-OPEN (byte-identical pass-through) instead of fail-DANGEROUS.
    if (!knownKeys.has(key)) return new Set<string>()
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
 * ROUND S (2026-09-24, B0DSCDZC6K) — S1/S2. Two children advertised a THIRD design's slogan in
 * shopper-facing bullets because `per_child_bullets`/`per_child_descriptions` reached Amazon
 * through `scrubPub` alone (a trademark/celebrity scrub, blind to a sibling's name) while
 * `per_child_titles` already had `isForeignToDesign` at its ship door. These two functions give
 * bullets and descriptions the SAME rejector, through the SAME predicate, so "is this foreign to
 * design X?" has one answer everywhere a per-child field ships.
 */

/** The per-child BULLETS ship-door rejector (S2). `bullets` are THIS child's own scrubbed
 *  candidates; `foreign` is a per-design foreign-token set built the same way the title door builds
 *  its own (`buildForeignDesignTokens(..., { familyTitleText: '', strictNames: true })` — see
 *  listingPipeline.ts's `perChildDesignScope`, reused verbatim rather than a second scope). A bullet
 *  naming a sibling design is refused: restored from `priorBullets` at the SAME index when that
 *  prior is itself clean, else DROPPED — never replaced with the sibling's slogan, and never with a
 *  blank placeholder in its place (a shorter true array beats a longer false one). Idempotent and a
 *  byte-identical no-op when `foreign` is empty (the overwhelming majority of families). */
export function rejectForeignBullets(
  bullets: readonly string[],
  foreign: Set<string>,
  priorBullets: readonly string[] = [],
): string[] {
  if (!foreign.size) return bullets.map((b) => (b ?? '').trim()).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < bullets.length; i++) {
    const b = (bullets[i] ?? '').trim()
    if (!b) continue
    if (!isForeignToDesign(b, foreign)) { out.push(b); continue }
    const prior = (priorBullets[i] ?? '').trim()
    if (prior && !isForeignToDesign(prior, foreign)) out.push(prior)
    // else: drop this ONE bullet. Never ship a sibling's slogan; never pad the gap with ''.
  }
  return out
}

/** Drop whole `<p>…</p>` / `<li>…</li>` blocks (matched as WHOLE tag pairs, never mid-tag) whose
 *  text carries a foreign mention — the description door's segment-level reject, HTML-shaped the
 *  way the title door's phrase sweep is text-shaped. `isForeign` receives each block's raw markup;
 *  tag names never collide with a design-name token (`bulletTokens` only extracts `[a-z0-9]+`
 *  runs). Cleans an emptied `<ul></ul>` and collapses the whitespace a removed block leaves behind.
 *  Idempotent; a no-op on HTML with no `<p>`/`<li>` blocks at all (falls through unmatched, unlike a
 *  whole-string blank). */
export function stripForeignHtmlBlocks(html: string, isForeign: (segment: string) => boolean): string {
  if (!html || !html.trim()) return html
  let out = html.replace(/<(p|li)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) => (isForeign(block) ? '' : block))
  out = out.replace(/<ul\b[^>]*>\s*<\/ul>/gi, '')
  out = out.replace(/\s{2,}/g, ' ').trim()
  return out
}

/** The per-child DESCRIPTION ship-door rejector (S2). Whole-string fast path (byte-identical
 *  no-op on the healthy majority); only when the FULL description carries a foreign mention does it
 *  pay for the block-level split. Falls back to `''` only when EVERY block names a sibling — which
 *  the push resolver (`pushFields.resolveProposed`) already treats as "nothing to push" rather than
 *  a broadcast fallback, so the worst case is a refusal, never a shipped lie. */
export function rejectForeignDescription(description: string, foreign: Set<string>): string {
  if (!foreign.size || !description || !isForeignToDesign(description, foreign)) return description
  return stripForeignHtmlBlocks(description, (seg) => isForeignToDesign(seg, foreign))
}

/** S4 — the identity ratchet. TRUE when `name` carries EVERY token of one of `siblingNames` (a
 *  full-name subset match, not a loose word overlap — two unrelated slogans sharing one common word
 *  must not false-positive). Used to refuse a resolved/stored design identity that is actually
 *  another design's name, at BOTH the fresh LLM/vision/heuristic chain (`extractDesignName`'s
 *  `accept()`) and the seller-override verbatim short-circuit, and at the section-regen rebuild that
 *  re-feeds a STORED `designName` with no resolver call at all. */
export function nameMatchesSibling(name: string, siblingNames: readonly string[]): boolean {
  const nameToks = new Set(designScopeTokens(name))
  if (nameToks.size === 0) return false
  for (const sib of siblingNames) {
    const sibToks = designScopeTokens(sib)
    if (sibToks.length === 0) continue
    if (sibToks.every((t) => nameToks.has(t))) return true
  }
  return false
}
