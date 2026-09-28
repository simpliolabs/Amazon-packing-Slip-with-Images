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
 * ROUND V (2026-09-24, cross-design leak controller ruling) — V1/V2. Rounds S, T and U each built,
 * armed and re-shaped a SUBTRACTIVE ship door (`rejectForeignBullets`/`rejectForeignDescription`)
 * that EDITED or EMPTIED a per-child bullets/description row on a name match. Measured outcome
 * across all three shapes: S was inert on the section-regen path and deleted a child's own copy on
 * an unknown key; T stripped healthy copy (HDG 5→3, BCSG 5→3) and cost BB its own identity bullet to
 * the ordinary word "hustle"; U refused the WHOLE row — BB's five healthy bullets → 0, because one
 * read "...mother, hustler..." — while an `<em>` inside a sibling's slogan, or an alternate spelling,
 * shipped anyway (7 of 16 leak forms the pre-U rule caught started passing). A subtractive net with
 * no additive producer always ships something short (this repo's own rule, #630/#631), and detecting
 * "this sentence names a sibling" well enough to EDIT on is a spelling problem this repo's own
 * memory says a lexicon cannot solve. V1 deletes the door entirely: nothing here may edit or empty a
 * per-child bullets/description row on the strength of a name match. This file's job on this exit is
 * REPORTING, never editing: `detectForeignBullets`/`detectForeignDescription` below answer "does this
 * row still name a sibling?" without touching a byte, so a false positive costs nothing but a log
 * line and an operator surface, never a shopper-facing bullet.
 *
 * ROUND W (2026-09-28) — W2. V4/V5 tried to move the cure upstream into a brief sanitizer
 * (`sanitizeReferenceTitle`) and, separately, had this REPORT reuse `isForeignToDesign`'s per-TOKEN
 * scope (`perChildDesignScope`) — the same bag-of-words rule the title door needs (a single bare
 * word IS enough to flag a title). On the report, that rule convicted 5 of 6 healthy designs in one
 * family on ORDINARY vocabulary overlap (a shared word like "hustle"), which made the operator
 * surface worthless — a report wrong 5 times in 6 is worse than none. Both the sanitizer and the
 * per-token report are deleted this round (the fix moves fully operational: regenerate the titles,
 * push, then regenerate bullets/description against a now-clean stored title — see the runbook).
 * What replaces the report is the SIMPLEST thing that is actually true: does this child's copy
 * contain ANOTHER design's stored name as a normalised WHOLE-STRING substring? No token bag (a
 * shared word alone never convicts), no niche exemption, no own-vocabulary exemption — `siblingName`
 * is checked in full, in its own word order. The ONE normalisation this round allows folds a
 * censored spelling onto its plain form ("B*tch"/"Btch"/"Bitch" all → "btch") by (a) collapsing an
 * in-WORD censor mark — a punctuation character with a letter on BOTH sides and no surrounding
 * space, e.g. the "*" in "B*tch" or the "'" in "don't" — and then (b) dropping vowels from what's
 * left. Punctuation that separates two WORDS (a comma, a full stop) is never folded away, so an
 * ordinary list ("...the mother, hustler or boss mom...") is not mistaken for the unbroken phrase
 * "Mother Hustler" sitting right next to it — only real, unbroken adjacency matches.
 */

/** Case-fold + the one censored-spelling fold W2 allows: an in-WORD punctuation mark (letter on
 *  both sides, no space) collapses away, then vowels drop, so "B*tch"/"Btch"/"Bitch" converge on
 *  ONE token ("btch") while a comma or full stop between two separate WORDS is left alone — it is
 *  the only thing telling "Mother Hustler" (unbroken) apart from "...mother, hustler..." (a list). */
export const normalizeForNameMatch = (s: string): string =>
  (s || '')
    .toLowerCase()
    .replace(/([a-z0-9])[^a-z0-9\s]+(?=[a-z0-9])/g, '$1')
    .replace(/[aeiou]/g, '')

/** TRUE when `text` contains `siblingName` as a normalised whole-string substring. A floor on the
 *  normalised needle (not a word list, not a niche list — just a minimum length) keeps a degraded
 *  2-letter stored-name label ("Bb") from matching ordinary prose by accident; it does not exempt
 *  any real design name. */
export function containsSiblingName(text: string, siblingName: string): boolean {
  const needle = normalizeForNameMatch(siblingName)
  if (needle.length < 4) return false
  const hay = normalizeForNameMatch(text)
  return hay.includes(needle)
}

/** Read-only report for the per-child BULLETS exit (V2, Round V; predicate replaced W2, Round W).
 *  Never edits `bullets` — the caller ships them byte-identical regardless of the verdict.
 *  `leakingBullets` names the exact candidate(s) that carried a sibling's full stored name, for the
 *  log line and the operator surface. Over-reporting is acceptable (per the ruling); editing on
 *  this signal is not. Byte-identical read on an empty `siblingNames` list (the overwhelming
 *  majority of families, and every single-design one). */
export function detectForeignBullets(
  bullets: readonly string[],
  siblingNames: readonly string[],
): { leaking: boolean; leakingBullets: string[] } {
  if (!siblingNames.length) return { leaking: false, leakingBullets: [] }
  const leakingBullets = bullets
    .map((b) => (b ?? '').trim())
    .filter((b) => b && siblingNames.some((n) => containsSiblingName(b, n)))
  return { leaking: leakingBullets.length > 0, leakingBullets }
}

/** Drop whole `<p>…</p>` / `<li>…</li>` blocks (matched as WHOLE tag pairs, never mid-tag) whose
 *  text carries a foreign mention. `isForeign` receives each block's raw markup; tag names never
 *  collide with a design-name token (`bulletTokens` only extracts `[a-z0-9]+` runs). Cleans an
 *  emptied `<ul></ul>` and collapses the whitespace a removed block leaves behind. Idempotent; a
 *  no-op on HTML with no `<p>`/`<li>` blocks at all (falls through unmatched, unlike a whole-string
 *  blank). Kept as a general-purpose HTML utility — not called by the per-child description exit
 *  any more (Round V deleted the last caller that edited on this signal; see the block comment
 *  above `detectForeignBullets`), available for a caller that needs a segment-level split. */
export function stripForeignHtmlBlocks(html: string, isForeign: (segment: string) => boolean): string {
  if (!html || !html.trim()) return html
  let out = html.replace(/<(p|li)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) => (isForeign(block) ? '' : block))
  out = out.replace(/<ul\b[^>]*>\s*<\/ul>/gi, '')
  out = out.replace(/\s{2,}/g, ' ').trim()
  return out
}

/** Read-only report for the per-child DESCRIPTION exit (V2, Round V; predicate replaced W2, Round
 *  W). Never edits `description` — see `detectForeignBullets` above for why. Byte-identical read
 *  on an empty `siblingNames` list or an empty description. */
export function detectForeignDescription(description: string, siblingNames: readonly string[]): { leaking: boolean } {
  if (!siblingNames.length || !description) return { leaking: false }
  return { leaking: siblingNames.some((n) => containsSiblingName(description, n)) }
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
