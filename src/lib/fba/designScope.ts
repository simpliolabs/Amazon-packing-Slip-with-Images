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
  /** U2 (Round U, cross-design leak) — DEFAULT ON (opt-OUT, not opt-in: the mandated acceptance
   *  probes call `buildForeignDesignTokens` with no other change and require the phrase behavior,
   *  so it must be what an unset option means). A MULTI-word name's SURVIVING (non-niche) tokens
   *  must appear as one contiguous ORDERED PHRASE, never any bare one of them alone — "hustle",
   *  "mother", "definition" etc. are ordinary English words this family's OWN copy legitimately
   *  uses; single-token matching convicted every one of them (measured, cost1/cost3.probe.test.ts).
   *  Pass `false` explicitly to keep the ORIGINAL per-token bag-of-words behavior byte-for-byte —
   *  used ONLY by the Item Highlight composer (`buildItemHighlightsPerDesign`), whose own
   *  pad-budget tests are pinned to specific composed strings under the old semantics and are OUT
   *  of this round's scope (the ruling fences `itemHighlightWriter.ts`; this keeps that composer's
   *  INPUT-side scoping byte-identical too). */
  phraseNames?: boolean
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
  // U2 (Round U, cross-design leak) — ORDERED per-design name tokens, kept alongside the Set so a
  // multi-word name can be required to match as a whole PHRASE (see the build loop below).
  const nameToksOrdered = new Map(designs.map((d) => [d.key, designScopeTokens(d.name)]))
  const nameToks = new Map(designs.map((d) => [d.key, new Set(nameToksOrdered.get(d.key) ?? [])]))
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
    const tokExempt = (t: string): boolean => {
      if (own.has(t) || titleToks.has(t)) return true
      if ((nameTokCounts.get(t) ?? 0) >= nameShareThresh) return true
      if (!opts.strictNames && poolToks.has(t)) return true
      return false
    }
    for (const d of designs) {
      if (d.key === key) continue
      /* U2 (Round U, cross-design leak) — a sibling's NAME is foreign only as a whole ORDERED
       * PHRASE, never one bare token. "hustle", "mother", "definition", "coming", "soon", "quit"
       * are ordinary English words this family's OWN copy legitimately uses; single-token
       * matching convicted every one of them — measured (cost1/cost3.probe.test.ts): the design
       * that genuinely owns "Business B*tch" lost its OWN identity bullet because that sentence
       * also used the word "hustle", a bare token of sibling "Hustle Definiton", and four more
       * healthy families each lost 1-2 of their five on-brand bullets the same way.
       *
       * The exemptions (own/title/name-share/pool) still apply PER TOKEN first — a name can be
       * "Fishing Trip" on a family whose OWN title/niche is fishing, where "fishing" is the
       * family's shared word and "trip" is the design's real distinguishing one (review-caught,
       * titleTruthNetGate.test.ts): pruning the whole phrase on any one exempt token would let
       * "trip" straight through as a niche word too. So: prune the EXEMPT tokens out first, in
       * the name's own order. What SURVIVES is the design's actual distinguishing vocabulary —
       * zero survivors, the name is pure niche and never foreign; exactly ONE survivor (e.g.
       * "trip", or a single-word name), that one token alone is enough, same as before; TWO OR
       * MORE survivors (e.g. "hustle"+"definiton", neither exempt), `isForeignToDesign` requires
       * that exact run to appear CONTIGUOUSLY — so a bullet using "hustle" alone never matches
       * "hustle definiton" and a bullet using "mother" alone never matches "mother hustler", but
       * the full phrase, quoted, still does. */
      const ordered = nameToksOrdered.get(d.key) ?? []
      const surviving = ordered.filter((t) => !tokExempt(t))
      if (opts.phraseNames === false) {
        // Explicit opt-OUT: ORIGINAL per-token bag-of-words, byte-for-byte (the Item Highlight
        // composer only — see the option's doc comment).
        for (const t of surviving) foreign.add(t)
      } else if (surviving.length === 1) foreign.add(surviving[0])
      else if (surviving.length > 1) foreign.add(surviving.join(' '))
      // Identity (vision) tokens stay SOFT bag-of-words, every exemption, byte-for-byte — broad
      // vocabulary extensions ("gym", "motivation"), never a design's own distinguishing NAME.
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

/** TRUE when a pool phrase carries a token — or, for a multi-word design name (U2), the WHOLE
 *  ordered phrase, contiguously — foreign to design `key`, i.e. it names ANOTHER design. A BM line
 *  never carries "don't quit" (PO 2026-08-21); an HDG line using the ordinary word "hustle" alone
 *  no longer convicts it of "Mother Hustler" or "Hustle Definiton" (PO 2026-09-24, Round U). Each
 *  entry in `foreign` is a space-joined run of one or more normalized tokens; matching it against a
 *  space-padded, space-joined haystack turns "does this ordered phrase occur contiguously?" into a
 *  substring check with no risk of a partial-token false match (every token is already atomic). */
export function isForeignToDesign(keyword: string, foreign: Set<string>): boolean {
  if (foreign.size === 0) return false
  const hay = ` ${designScopeTokens(keyword).join(' ')} `
  for (const phrase of foreign) if (hay.includes(` ${phrase} `)) return true
  return false
}

/**
 * ROUND S (2026-09-24, B0DSCDZC6K) — S1/S2. Two children advertised a THIRD design's slogan in
 * shopper-facing bullets because `per_child_bullets`/`per_child_descriptions` reached Amazon
 * through `scrubPub` alone (a trademark/celebrity scrub, blind to a sibling's name) while
 * `per_child_titles` already had `isForeignToDesign` at its ship door. These two functions give
 * bullets and descriptions the SAME rejector, through the SAME predicate, so "is this foreign to
 * design X?" has one answer everywhere a per-child field ships.
 */

/** The per-child BULLETS ship door (U1, Round U). `bullets` are THIS child's own scrubbed
 *  candidates; `foreign` is a per-design foreign-phrase set built the same way the title door
 *  builds its own (`buildForeignDesignTokens(..., { familyTitleText: '', strictNames: true })` —
 *  see listingPipeline.ts's `perChildDesignScope`, reused verbatim rather than a second scope).
 *
 *  U1 REPLACES the old per-bullet edit with an ALL-OR-NOTHING verdict for the whole row: a
 *  SUBTRACTIVE net with no additive producer will always ship something short (this repo's own
 *  rule: it once made true 29-49c titles against a 70-75 band — #630/#631, reverted live). Here the
 *  old per-bullet drop-and-splice made 4-bullet rows against this family's five-bullet contract,
 *  and on the PO's OWN click convicted the design that genuinely OWNS a sibling's shared word
 *  ("hustle") of naming that sibling — measured, cost1/cost3.probe.test.ts. So there is no partial
 *  edit any more: if ANY candidate bullet names a sibling design, the WHOLE row is refused — an
 *  empty array, which `pushFields.resolveProposed` (bullets case) treats as "nothing to push", so
 *  the child's CURRENTLY LIVE bullets on Amazon stand untouched rather than being overwritten by a
 *  short or lossy array. A refusal is logged loudly, never silent. Byte-identical no-op when
 *  `foreign` is empty (the overwhelming majority of families) or when nothing leaks. */
export function rejectForeignBullets(
  bullets: readonly string[],
  foreign: Set<string>,
): string[] {
  const cleaned = bullets.map((b) => (b ?? '').trim()).filter(Boolean)
  if (!foreign.size) return cleaned
  const leaking = cleaned.filter((b) => isForeignToDesign(b, foreign))
  if (leaking.length === 0) return cleaned
  console.warn(JSON.stringify({
    tag: 'DESIGN_SCOPE_REFUSED', field: 'bullets',
    reason: `${leaking.length}/${cleaned.length} candidate bullet(s) name a sibling design`,
    leaking,
  }))
  return []
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

/** The per-child DESCRIPTION ship door (U1, Round U). Whole-string fast path (byte-identical no-op
 *  on the healthy majority — most descriptions carry no foreign mention at all). U1 REPLACES the
 *  old block-level strip (`stripForeignHtmlBlocks`, still exported below for direct callers) with
 *  an ALL-OR-NOTHING verdict: removing only the offending `<p>`/`<li>` block is a SUBTRACTIVE edit
 *  with no additive producer, and it silently deleted a child's OWN legitimate closing paragraph
 *  whenever that paragraph happened to share an ordinary word with a sibling's name (measured,
 *  cost2.probe.test.ts — a −34% description on 4 of 6 children). When ANY foreign mention is
 *  found, refuse the WHOLE description to `''` — `pushFields.resolveProposed` (description case)
 *  treats an empty string as "nothing to push", so the child's CURRENTLY LIVE description stands
 *  untouched rather than being overwritten by a shortened one. Logged loudly, never silent. */
export function rejectForeignDescription(description: string, foreign: Set<string>): string {
  if (!foreign.size || !description || !isForeignToDesign(description, foreign)) return description
  console.warn(JSON.stringify({ tag: 'DESIGN_SCOPE_REFUSED', field: 'description', reason: 'description names a sibling design' }))
  return ''
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
