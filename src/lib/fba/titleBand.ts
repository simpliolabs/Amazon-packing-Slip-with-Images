/**
 * titleBand.ts — THE deterministic title band net (task #147).
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * A live regen on B0GF49RLDL (2026-07-29 21:03) shipped a 66-char title —
 * "THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women" — against a 70-75 golden
 * band, with no ` | ` separator. An earlier run the same day produced 73 WITH the pipe, and the only
 * thing that changed between them was the keyword pool. That is the diagnosis: the single-design
 * branch (`buildTitleFor` → `runTitleAgent`) has only a soft feel-pad and a deterministic fill that
 * STARVES when the pool shifts, while the ENFORCED 70-75 retry lives solely in the multi-design
 * `buildNicheParentTitle`. Title has ~42 prior same-class fix commits; per the generation-invariants
 * circuit breaker this is the shared-seam rebuild, not patch 43.
 *
 * WHY A LEAF MODULE. Zero imports from listingPipeline (which is ~9,400 lines and holds the LLM
 * calls), so this is unit-testable in isolation and cannot be accidentally coupled to a branch. The
 * pipeline calls it from `scrubPublished` — the ONE choke point every exit passes through
 * (`:8292` title · `:8609` bullets · `:8964` keywords · `:9010` description · `:9400` full, because
 * `partialResult` is DEFINED as a scrubPublished wrapper at `:7784`). Installing here is opt-OUT by
 * construction: a future early-return cannot bypass it without deleting the wrapper.
 *
 * WHAT IT WILL AND WILL NOT DO. It pads ONLY from product FACTS the caller passes — the garment
 * blank's brand (`BLANK_SPECS.brand`), its fit/sleeve/neck, and a distinct garment surface form. It
 * NEVER invents marketing adjectives and never pulls from the search pool, because a title is a
 * product claim: spec-grounding beats coverage (see the spec-vs-search-grounding rule). If the facts
 * are too thin to reach 70, it returns the best it achieved and SAYS SO in `notes` — an honest short
 * title beats a padded false one.
 */

import { CONTENT_CONTRACT } from './contentContract'
// Both are zero-import leaves (designName imports nothing; trademarkGuard imports nothing), so this
// file stays cycle-free and unit-testable in isolation.
import { BASIC_COLOR_WORDS } from './designName'
import { hasTrademark } from './trademarkGuard'

/** ONE source per bound — never a new magic number (generation-invariants INVARIANT 5). */
export const TITLE_BAND_LO = CONTENT_CONTRACT.title.goldenBandLo // 70
export const TITLE_BAND_HI = CONTENT_CONTRACT.title.hardCap //      75

/**
 * WHY the verdict is returned even when nothing changed (Phase 0 of the ship-door plan).
 *
 * The net used to be silent on a no-op, which made three very different situations indistinguishable
 * in production: the net working, the net never firing, and the net firing but achieving nothing. On
 * the first live run after deploy the title came back at 75 chars with NO log line at all, and the
 * only honest thing that could be said was "unknown". A net whose success cannot be told apart from
 * its absence is not verifiable, and an unverifiable net is where dead code hides — this file already
 * shipped one (see `pickDistinctGarmentForm`'s docstring). So every pass now reports WHY.
 *
 *   empty        — blank input; the degrade gate owns that case, never this net
 *   non-apparel  — deliberately skipped; a short non-apparel title is legitimately short
 *   over-cap     — already >75; capping belongs to capTitle75, not here
 *   in-band      — already 70-75; returned byte-identical (this is the common, healthy case)
 *   padded       — raised INTO the band from a product fact  ← the only outcome that proves it works
 *   facts-exhausted — improved but still short; honest partial
 *   no-facts     — nothing available to pad with; unchanged and SAID so
 */
export type TitleBandDecision =
  | 'empty' | 'non-apparel' | 'over-cap' | 'in-band' | 'padded' | 'facts-exhausted' | 'no-facts'

/** Facts only. Every field is a resolved product attribute or a BLANK_SPECS value — never a
 *  search-pool term. All optional: a missing fact contributes NO segment rather than a literal
 *  default, or a short-sleeve blank would ship "Long Sleeve". */
export interface TitleBandCtx {
  /** Non-apparel titles are legitimately short; every existing length guard is apparel-gated. */
  apparel: boolean
  /** BLANK_SPECS.brand, canonically cased (e.g. "Comfort Colors"). */
  garmentBrand?: string | null
  /** BLANK_SPECS attributes. Only pass what the blank actually is. */
  spec?: { fit?: string | null; sleeve?: string | null; neck?: string | null } | null
  /** A garment surface form DISTINCT from the one already in the title (title says "Shirt" ⇒ "Tee").
   *  Amazon's golden format keeps both tokens; the caller derives this from `garmentFor`. */
  garmentSecond?: string | null
  /** Amazon Custom enrollment (listing_content.is_customizable, migration 052) — TRUE makes
   *  "Personalized" a verified fact segment; false/absent keeps it banned (false claim otherwise). */
  customizable?: boolean
}

/** The audience tail the pipeline's own fillers recognise — kept byte-identical to the regexes at
 *  listingPipeline.ts:6014 / :6149 / :6191 so a segment is inserted BEFORE "for Women", never after. */
const AUDIENCE_TAIL_RE = /\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?|her|him|kids)\s*$/i

/** Case/space-insensitive containment, so we never append a fact the title already states. */
function alreadyStates(title: string, phrase: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  const t = ` ${norm(title)} `
  const p = norm(phrase)
  return p.length > 0 && t.includes(` ${p} `)
}

/**
 * Pick a garment surface form whose COVERAGE TOKEN is genuinely new for this title.
 *
 * LIVES HERE, NOT IN THE PIPELINE, and that is the point. The first version of this was six inline
 * lines inside listingPipeline.ts (~9,400 lines) and shipped two invisible escaping bugs that CI,
 * tsc and 15 green tests all missed: `` new RegExp(`\b${w}\b`) `` — a SINGLE backslash inside a
 * template literal, so `\b` was U+0008 BACKSPACE rather than a word boundary — plus a literal
 * backspace byte in a `.replace()` regex that `git diff` renders invisibly. Net effect: the filter
 * was dead code, every title got `shirt`, the leaf rejected it as already-present, and the net
 * silently did NOTHING on the exact 66-char case it was written for. Inline regexes in a huge file
 * are unreviewable; here it is one exported function with tests that would have failed instantly.
 *
 * `t-shirt`/`tshirt` fold to the same coverage token as `shirt` (coverage-core's foldGarment), so on
 * a title already saying "Shirt" they buy no indexing. Only a form whose letters neither contain nor
 * are contained by an already-present garment word is worth a slot. Returns Title Case, or null.
 */
export function pickDistinctGarmentForm(title: string, aliases: readonly string[]): string | null {
  const bare = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]/g, '')
  const hay = ` ${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `
  // Whole-word containment via padded spaces — no RegExp, so no escaping to get wrong, and a fact
  // containing regex metacharacters can never throw.
  const present = (w: string): boolean => hay.includes(` ${w.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `)
  const presentBare = aliases.filter((al) => present(al)).map(bare)
  const pick = aliases.find((al) => {
    if (al.includes(' ') || present(al)) return false
    const b = bare(al)
    return b.length > 0 && !presentBare.some((p) => b.includes(p) || p.includes(b))
  })
  return pick ? pick.replace(/(^|[\s-])(\w)/g, (_m, sep: string, c: string) => sep + c.toUpperCase()) : null
}

/** Ordered candidates, strongest product signal first. The garment BRAND leads because it is the
 *  highest-intent fact a shopper filters on ("comfort colors tshirt" is this listing's rank-1
 *  keyword and a genuine attribute of the blank). */
function candidateSegments(title: string, ctx: TitleBandCtx): string[] {
  const out: string[] = []
  const push = (v?: string | null): void => {
    const s = (v ?? '').trim()
    // TITLE-ONLY WASTE VOCABULARY (PO ruling 2026-08-09, §3 gold rule 4). "Classic Fit" is a REAL
    // Gildan 64000 spec fact — `titleBandCtx` composes it straight from `blank_specs.fit` — but the
    // PO ruled it is not a TITLE word. Without this check the pad would re-install the exact phrase
    // `stripTitleWasteVocabulary` just removed (the two nets compose inside one door pass), which is
    // both a live oscillation and a broken idempotence claim. The fact itself is untouched
    // everywhere else: bullets, description and the Product Detail attributes still read the spec.
    if (!s || isTitleWasteVocabulary(s)) return
    if (!alreadyStates(title, s) && !out.includes(s)) out.push(s)
  }
  // Amazon Custom (2026-07-31, PO): "Personalized" leads the fact list — on an enrolled listing it
  // is both a verified product fact AND the highest-intent search modifier available. Never pushed
  // when the listing is not enrolled (the flag defaults false; a false claim is worse than a short title).
  if (ctx.customizable) push('Personalized')
  push(ctx.garmentBrand)
  push(ctx.spec?.fit)
  push(ctx.spec?.sleeve)
  push(ctx.spec?.neck)
  push(ctx.garmentSecond)
  // Pairs, so a single thin fact can still carry the title into band without inventing anything.
  if (ctx.garmentBrand && ctx.garmentSecond) push(`${ctx.garmentBrand.trim()} ${ctx.garmentSecond.trim()}`)
  if (ctx.spec?.fit && ctx.garmentSecond) push(`${ctx.spec.fit.trim()} ${ctx.garmentSecond.trim()}`)
  return out
}

/** Trivial connectors that may legitimately repeat. Everything else is a "significant word" and is
 *  allowed once. Mirrors HIGHLIGHT_STOPWORDS (listingPipeline.ts:1627), where men/women/cotton are
 *  deliberately ABSENT — they count as real words. */
const TITLE_CONNECTORS = new Set(['for', 'and', 'the', 'a', 'an', 'of', 'with', 'in', 'to', 'or', 'by', '&', '|'])

/* NO GARMENT-COUNT CAP, deliberately — and this reversed my first implementation.
 *
 * I initially capped garment surface forms at two, reading the PO's "variety" decision as "exactly
 * two". Two tests immediately falsified it: on the live defect it dropped BOTH `Tshirt`s (Tee and
 * Shirt had already taken the two slots), and it MUTATED a clean title. The reason is that the
 * repo's own gold pattern carries THREE surfaces —
 *   THE CEO <niche> Tee Shirt | Comfort Colors TShirt for Women
 * — because "Tee Shirt" reads as one compound garment and "TShirt" is a second, genuinely
 * differently-typed search. Capping the raw count breaks the shape we are trying to produce.
 *
 * So this net does ONE thing: remove a repeat of the SAME significant word. That is exactly the
 * live defect ("Tshirt, Tshirt") and nothing more. Surface VARIETY is not repetition, and the
 * distinction is the whole of the PO's decision. */

/**
 * Remove repeated significant words — globally for ordinary words, PER ` | ` SEGMENT for the garment
 * noun family, because the PO golds deliberately spend the noun once on each side of the pipe.
 *
 * THE LIVE DEFECT (B0GF49RLDL, 2026-07-29 21:03, verified in the shipped recommendation):
 *   "THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt, Tshirt for Women"  (75 chars)
 * "Tshirt" twice. Amazon indexes a token ONCE, so the repeat bought zero extra indexing while
 * consuming 8 of the 75 characters — measured against that listing's own target set, those 8
 * characters could have carried "graphic", newly covering `graphic t shirts` (50,962/mo).
 *
 * WHY EXISTING CODE MISSED IT: `deduplicatePhrases` (listingPipeline.ts:1600-1613) compares each
 * 2-3 word window against the window IMMEDIATELY FOLLOWING it, so it only ever catches ADJACENT
 * repeats. A word repeated at non-adjacent positions is invisible to it. Item Highlights has had a
 * repeat gate for months (capItemHighlightRepeats); titles never did.
 *
 * PO DECISION (binding, recorded in handoff/FOUNDATION_SHIP_DOOR_PLAN.md §3.4-ANSWERED): "variety".
 * Two garment nouns is the DESIRED shape — `Shirt` + `Tee` — so this must never fold to one. What it
 * removes is a repeat of the SAME surface form, and any THIRD garment form beyond the two.
 *
 * Pure, deterministic, idempotent. Keeps the FIRST occurrence (title order is ranking order — the
 * earliest position is the most valuable, so a later duplicate is always the one to lose).
 */
export function collapseRepeatedWords(
  title: string,
): { title: string; removed: string[]; refusedForTrademark?: boolean } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, removed: [] }

  const words = t0.split(' ')
  const seen = new Set<string>()
  /* THE GOLDS' NOUN ×2 ACROSS THE PIPE (defect found 2026-08-09 while pinning the third PO gold as a
   * fixture, and it was live). This function was deleting the second garment noun from TWO of the
   * three golds:
   *   THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt   72 → 66 ("Shirt")
   *   THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee   72 → 68 ("Tee")
   * Gold #2 survived only by luck of spelling ("Tee" + "Shirts" are different letters). The pattern
   * is not a defect, it is THE SHAPE: SELLER_PROFILE §3 "Product noun ×2", and the B0GVV3XL4T
   * ruling names it outright — "the noun ×2 pattern (Tee Shirt … Tee) carries the garment".
   * `enforceMoneyTail` has always known this ("at most ONE garment-family repeat — the golds repeat
   * the noun"); this net did not, so the door installed the gold tail and then deleted half of it.
   * The distinction that separates the golds from the live "Tshirt, Tshirt" defect is WHICH SIDE OF
   * THE PIPE each occurrence sits on: the golds spend the noun once per segment, the defect spends
   * it twice in one. So garment-family words are deduped PER SEGMENT (max two segments, i.e. still
   * "×2"); every other significant word keeps the global one-and-only rule. */
  const garmentSegs = new Map<string, Set<number>>()
  let segment = 0
  const isGarment = (bare: string): boolean => MONEY_GARMENT_FAMILY.has(moneyNormTok(bare))
  const kept: string[] = []
  const removed: string[] = []

  for (const w of words) {
    if (w === '|') { segment++; kept.push(w); continue }
    // Compare on letters only, so "Tshirt," and "Tshirt" are the same word and punctuation never
    // hides a duplicate. The ORIGINAL token (with its punctuation) is what gets kept.
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!bare || TITLE_CONNECTORS.has(bare)) { kept.push(w); continue }
    if (seen.has(bare)) {
      const segs = garmentSegs.get(bare)
      if (segs && !segs.has(segment) && segs.size < 2) {          // the golds' one cross-pipe repeat
        segs.add(segment)
        kept.push(w)
        continue
      }
      removed.push(w)                                             // repeat of a significant word
      continue
    }
    seen.add(bare)
    if (isGarment(bare)) garmentSegs.set(bare, new Set([segment]))
    kept.push(w)
  }

  if (removed.length === 0) return { title: t0, removed: [] }

  // Repair what the removal left behind: doubled spaces, a comma with nothing after it, a dangling
  // separator, or a trailing connector ("… Comfort Colors ,  for Women" → "… Comfort Colors for Women").
  const out = kept.join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;:])/g, '$1')            // " ," -> ","
    .replace(/([,;:])\s*(?=[,;:])/g, '')     // ",," -> ","
    // A comma that USED to introduce the removed word now sits in front of a connector
    // ("… Tshirt, for Women"). Drop it — this is the exact residue of the live defect's repair.
    .replace(/[,;:]\s+(?=(?:for|and|with|in|to|or|by)\b)/gi, ' ')
    .replace(/\|\s*(?=[,;:])/g, '|')
    .replace(/\s+\|\s+(?=(?:for|and)\b)/i, ' ') // dangling separator before the audience tail
    .replace(/[\s,;:|]+$/g, '')              // nothing trailing, ever
    .replace(/\s{2,}/g, ' ')
    .trim()

  /* TRADEMARK RESURRECTION GUARD (live defect B0GVVY5TS9, 2026-08-09) — the OTHER half of the
   * "Futbol World Futbol Cup" loop. `scrubTrademarks` turns "Futbol World Cup" into a string whose
   * safe substitution reprints a token the design already used; this dedupe then deletes the repeat
   * and hands back a bare "World Cup" — the protected mark, restored — which the route's
   * scrub-on-serve re-substitutes on the way out. trademarkGuard's absorb pass cures the ADJACENT
   * shape at the source; a non-adjacent one ("Futbol Shirt World Cup" → "Futbol Shirt World Futbol
   * Cup") can still reach here, and no dedupe may ever be the thing that republishes a mark. So:
   * if the removal would introduce a mark the input did not carry, refuse the whole pass and return
   * byte-identical. Fail-open by construction — an un-deduped title is a quality miss; a
   * resurrected trademark is a suppression/IP risk. Costs nothing on every other title (a
   * mark-free input short-circuits on the first probe). */
  if (!hasTrademark(t0) && hasTrademark(out)) {
    return { title: t0, removed: [], refusedForTrademark: true }
  }

  return { title: out, removed }
}

/** The weight classes a title can CLAIM. A claim is allowed only when the blank's own weightNote
 *  contains that word; with no spec the rule is "claim NO weight" (SELLER_PROFILE §2). */
const WEIGHT_CLAIM_RE = /\b(heavyweight|midweight|lightweight)\b/gi
/** Fit claims as the explicit "<X> Fit" phrase (both orders are covered by the pad side; the claim
 *  surface the LLM emits is "<X> Fit"). Bare "classic"/"relaxed" are NOT matched — "Classic Car
 *  Shirt" is a design, not a fit claim. Standalone "oversized" IS matched: §2's rule is that it
 *  never appears in visible copy unless the blank is actually oversized. */
const FIT_CLAIM_RE = /\b(relaxed|classic|slim|regular|oversized|boxy)\s+fit\b|\boversized\b/gi

/**
 * SPEC-TRUTH NET (2026-08-04). Remove garment fabric-weight and fit CLAIMS that the blank spec does
 * not back. LIVE DEFECT that forced this: the first fresh title regen after the POOL_STRATA flip on
 * B0GF49RLDL shipped "THE CEO Cupid Valentine Women's Heavyweight Cotton T-Shirt Classic Fit Crew" —
 * "Heavyweight" arrived FROM THE SEARCH POOL ("comfort colors heavyweight t shirt" is a live pool
 * row: the market calls Comfort Colors heavyweight, but the PO-confirmed spec says MIDWEIGHT
 * 6.1 oz) and "Classic Fit" contradicts the blank's Relaxed fit. The pad half of this module was
 * already facts-only; this is the missing REMOVAL half of the same rule, so a pool-leaked or
 * hallucinated claim cannot survive to the shipped bytes. Chars freed here are re-fillable by
 * enforceTitleBand's facts-only pad, which runs after.
 *
 * Pure, deterministic, idempotent. `spec` null/absent = claim nothing (all weight/fit claims go).
 */
export function scrubUnspecdGarmentClaims(
  title: string,
  spec: { fit?: string | null; weightNote?: string | null } | null | undefined,
): { title: string; removed: string[] } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, removed: [] }
  const weightOk = (w: string): boolean => !!spec?.weightNote && spec.weightNote.toLowerCase().includes(w.toLowerCase())
  const fitOk = (f: string): boolean => !!spec?.fit && spec.fit.toLowerCase() === f.toLowerCase()

  const removed: string[] = []
  let out = t0.replace(WEIGHT_CLAIM_RE, (m) => {
    if (weightOk(m)) return m
    removed.push(m)
    return ''
  })
  out = out.replace(FIT_CLAIM_RE, (m, fitWord: string | undefined) => {
    const claim = fitWord ?? 'oversized' // the alternation's bare-"oversized" branch has no group
    if (fitOk(claim)) return m
    removed.push(m)
    return ''
  })
  if (removed.length === 0) return { title: t0, removed: [] }

  out = repairRemovalResidue(out)
  return { title: out, removed }
}

/**
 * Repair the punctuation residue a mid-string REMOVAL leaves behind: doubled spaces, a space before
 * a comma, doubled commas, a comma that used to introduce the removed words and now sits in front of
 * a connector ("… Tshirt, for Women"), a dangling ` | ` before the audience tail, and any leading or
 * trailing separator. Extracted verbatim from `scrubUnspecdGarmentClaims` so the removal nets that
 * came after it repair IDENTICALLY rather than each growing its own near-copy (INVARIANT 5: one
 * source per rule). `collapseRepeatedWords` deliberately keeps its own inline chain — it is the one
 * variant WITHOUT the leading strip, and it is behavior-frozen by its own tests.
 */
function repairRemovalResidue(s: string): string {
  return s
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;:])/g, '$1')
    .replace(/([,;:])\s*(?=[,;:])/g, '')
    .replace(/[,;:]\s+(?=(?:for|and|with|in|to|or|by)\b)/gi, ' ')
    .replace(/\|\s*(?=[,;:])/g, '|')
    .replace(/\s+\|\s+(?=(?:for|and)\b)/i, ' ')
    .replace(/^[\s,;:|]+/g, '')
    .replace(/[\s,;:|]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT 2 — THE TITLE-CASE APOSTROPHE ARTIFACT (PO ruling 2026-08-09, SELLER_PROFILE §4).
 *
 * THE LIVE SPECIMEN is the PO's own locked title:
 *   THE CEO World Soccer Cup Soccer T-Shirt, Women'S T-Shirts for Men and Women
 * "Women'S" — a capital S after the apostrophe. It is not an LLM typo; it is MANUFACTURED by our own
 * Title-Case passes. Four of them case a phrase with `s.replace(/\b\w/g, c => c.toUpperCase())`, and
 * in JavaScript an apostrophe is a NON-word character, so `\b` fires between "women'" and "s" and
 * the possessive gets capitalised. The pool phrase that fed it — "women's t shirts" — is a perfectly
 * good market keyword; we corrupt it on the way in (listingPipeline.ts :5447 design-name caser,
 * :6012 single-design fill, :6426 family-niche anchor, :6542 multi-design parent fill).
 *
 * WHY BOTH A SOURCE FIX AND A TERMINAL NET. The four casers are fixed at the source (they now route
 * through this function), but the artifact can also arrive from a council/LLM title, a stored prior,
 * or a caser added tomorrow — so the same rule ALSO runs as a terminal net inside `bandTitle`, on
 * the bytes that ship. Same function, both ends: one rule, no drift (INVARIANT 2 + INVARIANT 5).
 *
 * WHAT MUST NOT BREAK (the PO's own caveats):
 *   - legitimate ALL-CAPS tokens: "THE CEO", "USB", "CEO'S" — never touched
 *   - "TShirt" / "T-Shirt" — no apostrophe, structurally out of scope
 *   - a genuine capitalised word start after an apostrophe: "O'Brien", "L'Oreal", "D'Angelo",
 *     "O'Neill", "Rock'N'Roll" — never lowercased
 * TWO INDEPENDENT DISCRIMINATORS make that safe, and BOTH must hold before a letter is lowered:
 *   1. the letter run AFTER the apostrophe is a known English enclitic (s/t/re/ll/ve/m/d) AND ends
 *      the word. This alone disposes of every surname: "Brien"/"Neill"/"Angelo"/"Oreal"/"Roll" are
 *      not enclitics, and "o'clock" has a 5-letter run that can never match the {1,2} run.
 *   2. the word BEFORE the apostrophe is not a multi-letter ALL-CAPS token, which protects "CEO'S"
 *      and "USA'S". Note this is a TOKEN test, not a character test: an earlier draft rejected any
 *      uppercase character before the apostrophe and a test caught it immediately — that also
 *      rejects "I'Ll"/"I'M"/"I'Ve", where the capital is the English pronoun and the fix is wanted.
 */
const APOSTROPHE_ENCLITICS = new Set(['s', 't', 're', 'll', 've', 'm', 'd'])

/**
 * Lowercase the letter(s) a Title-Case pass wrongly capitalised after an apostrophe.
 * "Women'S T-Shirts" → "Women's T-Shirts" · "Dad'S" → "Dad's" · "Don'T" → "Don't".
 *
 * PURE, TOTAL, IDEMPOTENT (an already-correct "Women's" has a lowercase run and is returned
 * byte-identical), and LENGTH-NEUTRAL — it can never move a title across the 70-75 band, which is
 * why it may run first in the door without a band guard.
 */
export function fixApostropheCase(title: string): string {
  const t = title || ''
  if (!/['’]/.test(t)) return title // fast path: the overwhelming majority of titles
  return t.replace(/([A-Za-z]+)(['’])([A-Za-z]{1,2})(?![A-Za-z])/g, (m, pre: string, apo: string, run: string) => {
    if (run === run.toLowerCase()) return m                        // already correct — idempotence
    if (!APOSTROPHE_ENCLITICS.has(run.toLowerCase())) return m     // "O'Brien", "Rock'N'Roll"
    if (pre.length > 1 && pre === pre.toUpperCase()) return m      // "CEO'S", "USA'S" — all-caps token
    return `${pre}${apo}${run.toLowerCase()}`
  })
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * MONEY TAIL (#147 title half, TITLE_MONEY_TAIL). The PO's LOCKED gold shape for a single-design
 * apparel title is
 *   THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women
 * i.e. `Brand + design + noun | <ONE high-volume category money keyword>`. Six stacked pipeline
 * leaks kept that pipe tail from ever shipping (the 4-word pin drop, the advisory mustLine, the
 * design-grounding strip, the gap-sort burial, Pattern A's fact-only pipe-right, and the fact-only
 * terminal pads) — so per the generation-invariants doctrine the shape is enforced HERE, by a
 * deterministic terminal net on the shipped bytes, never by prompts.
 *
 * DELIBERATELY SEPARATE from enforceTitleBand: that net is BY DOCTRINE facts-only (spec-vs-search
 * grounding — it pads from BLANK_SPECS, never the pool). The money keyword is the ONE search-
 * grounded slot the gold grants, so it lives in its own stage, runs BEFORE the fact pad, and when
 * it lands (in band) the fact pad simply no-ops. When it skips, today's bytes are byte-identical.
 */

/** Why the net did (or did not) fire — every pass reports, per Phase-0 observability.
 *   empty / no-kw / non-apparel — structural skips (no keyword derived ⇒ zero behavior change)
 *   already-covered — every significant keyword token is in the title (also the idempotence path)
 *   cross-gender    — keyword fights the seller lean / the title's audience tail
 *   word-repeat     — keyword would re-print a significant left-side word (one garment-family
 *                     repeat is allowed — the golds repeat the noun: "…Tee | … Shirts …")
 *   design-right    — the pipe's right side carries the protected design phrase (or no design
 *                     name resolved, so the right side CANNOT be proven replaceable); never replaced
 *   brand-tail      — the pipe's right side carries the garment BRAND (the gold-#2
 *                     "… | Long Sleeve Comfort Colors Shirt" shape). PO RULING 2026-08-09
 *                     (SELLER_PROFILE §3, B0GVV3XL4T gold) NARROWED this from the old 'fact-tail':
 *                     a BRAND-carrying tail stays protected (§2: the Comfort Colors name IS a
 *                     selling point), but a tail carrying ONLY spec facts is now REPLACEABLE — the
 *                     pipe-right is the MONEY position and a fact there wastes it.
 *   no-tail         — the title has neither a ` | ` pipe nor a bare trailing audience tail. The net
 *                     only ever REPLACES a tail; it never APPENDS where none existed (conservative
 *                     reading of the design-led doctrine — the B0FKKN8XKV gold's pre-lock title
 *                     ended "for Women", i.e. had a replaceable tail).
 *   spec-conflict   — the market phrase would re-leak a spec claim the blank doesn't back
 *   no-fit          — the candidate cannot land inside [70,75] without truncating the keyword
 *   applied         — the gold-shape tail shipped  ← the only outcome that changes bytes */
export type MoneyTailDecision =
  | 'empty' | 'no-kw' | 'non-apparel' | 'already-covered' | 'cross-gender'
  | 'word-repeat' | 'design-right' | 'brand-tail' | 'no-tail' | 'spec-conflict' | 'no-fit' | 'applied'

/** The skips that are IDENTICAL for every candidate keyword, so trying the next one is pointless:
 *  they are properties of the TITLE (or of the slot already being satisfied), not of the keyword.
 *  Owned here rather than inline at the call site — `stripTitleWasteVocabulary` probes the same
 *  loop to answer "does removing this waste free space for a keyword?", and two copies of the stop
 *  set is exactly how the probe and the door would drift apart (INVARIANT 5: one source per rule). */
export const MONEY_TAIL_STRUCTURAL_SKIPS: ReadonlySet<MoneyTailDecision> = new Set<MoneyTailDecision>([
  'already-covered', 'no-tail', 'design-right', 'brand-tail', 'empty', 'non-apparel',
])

export interface MoneyTailCtx {
  /** Non-apparel never gets the garment money tail. */
  apparel: boolean
  /** Seller audience lean — the cross-gender veto twin of listingPipeline.ts:6031-6034. Soft leans
   *  veto too (stricter than the fill): a wrong veto is a no-op, a wrong ship is a regression. */
  lean?: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null
  /** Blank spec — feeds scrubUnspecdGarmentClaims (a market phrase like "heavyweight shirts" must
   *  not re-leak a weight/fit claim the blank doesn't back). It NO LONGER protects a pipe tail:
   *  the PO ruling 2026-08-09 makes a pure spec-fact tail replaceable by the money keyword. */
  spec?: { fit?: string | null; sleeve?: string | null; neck?: string | null; weightNote?: string | null } | null
  /** The design phrase. On a piped title the right side is replaceable only when it can be PROVEN
   *  not to carry the design — if it shares a distinctive token with the design (Pattern-B-ish
   *  "… | I Will Praise Him …"), or no design name resolved at all (nothing to prove against),
   *  the net must never delete the right side. */
  protect?: string | null
  /** The garment blank's brand in canonical casing (BLANK_SPECS, e.g. "Comfort Colors"). A
   *  pipe-right carrying ALL of its tokens is a protected BRAND tail (gold #2's shape) — the
   *  brand-tail guard skips rather than evict it. */
  garmentBrand?: string | null
  /**
   * May the net APPEND a money tail where none existed? (PO ruling 2026-08-10.)
   *
   * The net was replace-only by an explicit conservative choice. Measured consequence on
   * B0GVV3XL4T: the council produced a pipe-less 61-char title, this door returned 'no-tail' and
   * abstained, and `enforceTitleBand`'s pad — which runs AFTER — appended " | Crew Neck", a
   * BLANK_SPECS neck value, to reach the length band. A SPEC FACT took the money position because
   * the money door declined to. The PO's objection was exact: "WHY did we need the filler CREW NECK
   * there? crew neck can go on highlights."
   *
   * Appending can only ever REPLACE what the pad would otherwise invent: the band check still
   * rejects any candidate that cannot land inside [70,75] ('no-fit'), and when nothing fits the
   * title simply stays shorter — which the same ruling says is the right outcome.
   */
  allowAppend?: boolean
}

/**
 * Garment BRANDS whose presence in a pipe tail keeps that tail protected even when the caller could
 * not resolve `ctx.garmentBrand` (an unmatched blank row, a partial regen, a stale cache).
 *
 * WHY A LEXICON AT ALL, when the caller normally passes the brand. Gold #2 —
 *   THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt
 * — must be byte-identical under ANY attack keyword, and SELLER_PROFILE §3 protects it as a FIXTURE,
 * not as "protected when the blank happened to resolve". Before the PO ruling the spec lexicon
 * ('sleeve', 'fit', …) covered that hole incidentally; the ruling deletes the spec half, so the hole
 * has to be closed on the BRAND axis explicitly or the gold becomes attackable whenever
 * `garmentBrand` is null. Protect-direction only: a false positive costs one skipped money tail
 * (today's behaviour), never a mangled gold.
 *
 * Mirrors the only `blank_specs` row with `brand_in_copy` TRUE (SELLER_PROFILE §2: "Comfort Colors …
 * The name IS a selling point"; Gildan is brand_in_copy=false and never appears in copy at all, so
 * it can never BE a tail). Kept as a literal rather than an import because this file is a leaf by
 * construction — `blankSpecs.ts` pulls in supabase-js and productDetailAttrs, which would make this
 * net un-unit-testable in isolation. Add a phrase here when a new brand_in_copy blank is confirmed.
 */
const MONEY_BRAND_TAIL_PHRASES: readonly string[] = ['comfort colors']

/** Twin of listingPipeline's fillNormTok (gender fold + light plural fold + tshirt→shirt), kept
 *  local so this leaf stays import-free from the 9,400-line pipeline. Set-membership only. */
const moneyNormTok = (t: string): string => {
  const g = t === 'mens' ? 'men' : t === 'womens' ? 'women' : t
  const p = g.length > 3 ? g.replace(/s$/, '') : g
  return p === 'tshirt' ? 'shirt' : p
}
/** Significant, normalized tokens of a phrase (connectors dropped). */
const moneySigToks = (s: string): string[] =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 0 && !TITLE_CONNECTORS.has(w))
    .map(moneyNormTok)

/** Garment-noun family (post-fold): the ONE significant repeat the golds allow ("…Tee Shirt | …
 *  Tshirt…"). shirt/shirts/t-shirt/tshirt fold to `shirt`; tee/tees fold to `tee`. */
const MONEY_GARMENT_FAMILY = new Set(['shirt', 'tee'])
/** Audience words (post-fold) — a repeat of these is resolvable by dropping the keyword's own
 *  "for women/men" SUFFIX (never by truncating mid-phrase). 'ladie' is 'ladies' post-fold. */
const MONEY_AUDIENCE_TOKS = new Set(['men', 'women', 'ladie'])
/** Byte-for-byte twins of the fill's gender probes (listingPipeline.ts:6011-6012). */
const MONEY_FEM_RE = /\bwom[ae]ns?\b|\bladies\b/i
const MONEY_MASC_RE = /\bm[ae]ns?\b/i

/** Title Case for the money keyword ("christian shirts for women" → "Christian Shirts for Women");
 *  connectors stay lower unless leading, matching the gold's casing. */
const moneyTitleCase = (s: string): string =>
  s.split(' ').map((w, i) => {
    const lw = w.toLowerCase()
    if (i > 0 && TITLE_CONNECTORS.has(lw)) return lw
    return lw.charAt(0).toUpperCase() + lw.slice(1)
  }).join(' ')

/**
 * Install the PO gold money tail: `<protected left> | <Title-Cased money keyword>`.
 *
 * PURE, SYNCHRONOUS, DETERMINISTIC, IDEMPOTENT (an applied result re-enters as 'already-covered').
 * The LEFT side (brand + design + noun — the protected money phrase, same doctrine as the
 * runTitleAgent tail-dedup at listingPipeline.ts:3459) is kept VERBATIM.
 *
 * SCOPE (narrowed by the PO ruling 2026-08-09, SELLER_PROFILE §3): the net only ever REPLACES an
 * existing tail — a pipe-right or a bare trailing audience tail — and never APPENDS to a tail-less
 * title ('no-tail'). A pipe-right is replaceable only when it can be PROVEN to carry neither the
 * design ('design-right', which also fires when no design name resolved) nor the garment BRAND
 * ('brand-tail' — the protection that keeps gold #2 "… | Long Sleeve Comfort Colors Shirt"
 * byte-identical under ANY keyword). A tail of pure SPEC FACTS is no longer protected: the PO
 * ruled the pipe-right is the MONEY position and "| Classic Fit" wastes it. The audience survives
 * either inside the keyword itself ("… for Women") or re-appended verbatim after it. The keyword is
 * NEVER truncated mid-phrase — the only permitted trim is its own "for women/men" suffix, and only
 * when the audience already lives on the left. Anything that cannot land inside
 * [TITLE_BAND_LO, TITLE_BAND_HI] skips, byte-identical (fail-open).
 */
export function enforceMoneyTail(
  title: string,
  moneyKw: string | null | undefined,
  ctx: MoneyTailCtx,
): { title: string; decision: MoneyTailDecision; note: string } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, decision: 'empty', note: '' }
  const kw0 = (moneyKw || '').replace(/\s{2,}/g, ' ').trim().toLowerCase()
  if (!kw0) return { title: t0, decision: 'no-kw', note: '' }
  if (!ctx.apparel) return { title: t0, decision: 'non-apparel', note: '' }

  const kwFem = MONEY_FEM_RE.test(kw0)
  const kwMasc = MONEY_MASC_RE.test(kw0)

  // Idempotence / no-op: every significant keyword token already indexes from the title.
  const titleToks = new Set(moneySigToks(t0))
  const kwSig = moneySigToks(kw0)
  if (kwSig.length === 0) return { title: t0, decision: 'no-kw', note: '' }
  if (kwSig.every((tok) => titleToks.has(tok))) return { title: t0, decision: 'already-covered', note: '' }
  // An intra-keyword duplicate would ship a repeated word no later net removes (collapseRepeated
  // Words runs BEFORE this stage by wire order) — refuse rather than mutate the keyword.
  if (new Set(kwSig).size !== kwSig.length) return { title: t0, decision: 'word-repeat', note: 'intra-keyword repeat' }

  // Cross-gender veto — the seller lean half of listingPipeline.ts:6031-6034 (soft leans included:
  // stricter here is fail-open, a skip is a no-op).
  const lean = ctx.lean
  if ((lean === 'female' || lean === 'lean_female') && kwMasc && !kwFem) return { title: t0, decision: 'cross-gender', note: `lean=${lean}` }
  if ((lean === 'male' || lean === 'lean_male') && kwFem && !kwMasc) return { title: t0, decision: 'cross-gender', note: `lean=${lean}` }

  // Split: protect the left side verbatim. A piped title's right side is the replaceable fact
  // tail; an unpiped title's replaceable part is only its bare trailing audience tail.
  const pipeIdx = t0.indexOf(' | ')
  const tailM = AUDIENCE_TAIL_RE.exec(t0)
  const tailStr = tailM ? t0.slice(tailM.index) : ''            // e.g. " for Women" (leading space kept)
  const left = pipeIdx >= 0
    ? t0.slice(0, pipeIdx).trim()
    : (tailM ? t0.slice(0, tailM.index).trim() : t0)

  /* APPEND WHEN THERE IS ROOM (PO ruling 2026-08-10, superseding the replace-only conservatism).
   *
   * WAS: "replace-only, never append — a title with neither a pipe nor a bare trailing audience tail
   * has no replaceable tail region, skip rather than graft one on." That was a conservative reading
   * taken when the reference gold happened to ALREADY have a replaceable tail.
   *
   * WHAT IT ACTUALLY DID (measured, B0GVV3XL4T 2026-08-10): the council hands this door a pipe-less
   * 61-char title, so it returned 'no-tail' and skipped — and `enforceTitleBand`'s pad, which runs
   * AFTER, then appended " | Crew Neck" (a BLANK_SPECS neck value) to reach the length band. The
   * money door abstained and a SPEC FACT took the highest-value position in the title. The PO's
   * verbatim objection: "WHY did we need the filler CREW NECK there? crew neck can go on highlights."
   *
   * So: when there is no tail to replace but the title has ROOM for one, APPEND it. The band check
   * downstream is unchanged — a candidate that cannot land inside the band still returns 'no-fit',
   * so this can only ever put a keyword where the pad would otherwise have put filler. If no keyword
   * fits, we still return 'no-tail' and the title simply stays shorter, which per the same ruling is
   * the correct outcome: a shorter title beats a fact welded into the money slot. */
  const canAppend = pipeIdx < 0 && !tailM
  if (canAppend && !ctx.allowAppend) {
    return { title: t0, decision: 'no-tail', note: 'no pipe and no trailing audience tail to replace (append disabled)' }
  }

  // The tailGender half of the :6031-6034 veto: never put a masc-only keyword on a "for Women" title.
  const tailFem = MONEY_FEM_RE.test(tailStr) || /\bher\b/i.test(tailStr)
  const tailMasc = MONEY_MASC_RE.test(tailStr) || /\bhim\b/i.test(tailStr)
  if (tailFem && !tailMasc && kwMasc && !kwFem) return { title: t0, decision: 'cross-gender', note: 'tail=women' }
  if (tailMasc && !tailFem && kwFem && !kwMasc) return { title: t0, decision: 'cross-gender', note: 'tail=men' }

  if (pipeIdx >= 0) {
    const rightToks = new Set(moneySigToks(t0.slice(pipeIdx + 3)))
    // Never replace a pipe-right that carries the DESIGN. Fail-open direction (adversarial LOW,
    // 2026-08-09): when NO design name resolved, the right side cannot be PROVEN design-free, so
    // guard-off would be exactly wrong — treat unprovable as protected.
    const designToks = moneySigToks(ctx.protect ?? '')
      .filter((tok) => !MONEY_GARMENT_FAMILY.has(tok) && !MONEY_AUDIENCE_TOKS.has(tok))
    if (designToks.length === 0) {
      return { title: t0, decision: 'design-right', note: 'no resolvable design name — pipe right cannot be proven replaceable' }
    }
    if (designToks.some((tok) => rightToks.has(tok))) {
      return { title: t0, decision: 'design-right', note: 'pipe right side carries the design phrase' }
    }
    /* BRAND TAIL — the ONE pipe-right this net still refuses to touch.
     *
     * PO RULING 2026-08-09 (SELLER_PROFILE §3, the B0GVV3XL4T gold) resolved the open scope question
     * this guard was parked on, and it resolved it AGAINST the old fact half:
     *   AI:  THE CEO 2026 World Soccer Cup USA Mexico Canada Unisex Tee | Classic Fit
     *   PO:  THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee
     * "the pipe-right is the MONEY position … a tail carrying only spec FACTS (`| Classic Fit`,
     * `| Unisex Tee`, a bare sleeve/fit/weight phrase) is REPLACEABLE by the top market-opportunity
     * keyword — facts belong in bullets/description, never in the highest-value real estate."
     * So the spec-fact half of this guard is GONE (that is the entire behaviour change), and what
     * remains is the BRAND half: §2 says the Comfort Colors NAME is itself a selling point, and
     * gold #2 "… | Long Sleeve Comfort Colors Shirt" stays a protected fixture.
     *
     * ALL brand tokens must be present, not any one of them — "Comfort" alone is ordinary copy
     * vocabulary, "Comfort Colors" is the brand. Tighter than the old any-token probe on purpose:
     * the guard now carries the whole protection load, so it must protect the brand and nothing else. */
    const brandCarried = (brand: string): boolean => {
      const toks = moneySigToks(brand)
      return toks.length > 0 && toks.every((tok) => rightToks.has(tok))
    }
    const brandHit = [ctx.garmentBrand ?? '', ...MONEY_BRAND_TAIL_PHRASES]
      .map((b) => b.trim())
      .find((b) => b.length > 0 && brandCarried(b))
    if (brandHit) {
      return { title: t0, decision: 'brand-tail', note: `pipe right side carries the garment brand "${brandHit}" — protected` }
    }
  }

  // Repeat guard vs the PROTECTED left side: at most ONE garment-family repeat (the golds repeat
  // the noun); an audience repeat is resolvable ONLY by dropping the keyword's own "for women/men"
  // suffix (the audience already lives on the left); anything else skips.
  const leftSet = new Set(moneySigToks(left))
  let kwFinal = kw0
  const offenders = (kws: string): string[] => {
    let garmentRepeatUsed = false
    const out: string[] = []
    for (const tok of new Set(moneySigToks(kws))) {
      if (!leftSet.has(tok)) continue
      if (MONEY_GARMENT_FAMILY.has(tok) && !garmentRepeatUsed) { garmentRepeatUsed = true; continue }
      out.push(tok)
    }
    return out
  }
  let off = offenders(kwFinal)
  const AUD_SUFFIX_RE = /\s+for\s+(?:women|men)\s*$/i
  if (off.length > 0 && off.every((tok) => MONEY_AUDIENCE_TOKS.has(tok)) && AUD_SUFFIX_RE.test(kwFinal)) {
    kwFinal = kwFinal.replace(AUD_SUFFIX_RE, '').trim()
    off = offenders(kwFinal)
  }
  if (off.length > 0) return { title: t0, decision: 'word-repeat', note: `repeats: ${off.join(', ')}` }

  // Assemble. The audience survives: inside the keyword itself when it carries one, else the
  // original bare tail is re-appended VERBATIM (a lean listing must never lose its tail here).
  const kwCarriesAudience = MONEY_FEM_RE.test(kwFinal) || MONEY_MASC_RE.test(kwFinal)
  const reTail = tailStr && !kwCarriesAudience ? tailStr : ''
  let cand = `${left} | ${moneyTitleCase(kwFinal)}${reTail}`.replace(/\s{2,}/g, ' ').trim()

  // Spec truth: a market phrase must not re-leak a weight/fit claim the blank doesn't back.
  const scrubbed = scrubUnspecdGarmentClaims(cand, ctx.spec)
  if (scrubbed.removed.length > 0) {
    return { title: t0, decision: 'spec-conflict', note: `spec-truth would remove: ${scrubbed.removed.join(', ')}` }
  }

  // Band fit. Over the cap the ONLY permitted trim is the keyword's own audience suffix, and only
  // when that audience already appears on the left — never truncate the keyword itself.
  if (cand.length > TITLE_BAND_HI && AUD_SUFFIX_RE.test(kwFinal) && !reTail) {
    const audTok = /women\s*$/i.test(kwFinal) ? 'women' : 'men'
    if (leftSet.has(audTok)) {
      kwFinal = kwFinal.replace(AUD_SUFFIX_RE, '').trim()
      cand = `${left} | ${moneyTitleCase(kwFinal)}`.replace(/\s{2,}/g, ' ').trim()
    }
  }
  if (cand.length > TITLE_BAND_HI || cand.length < TITLE_BAND_LO) {
    return { title: t0, decision: 'no-fit', note: `candidate ${cand.length} chars outside [${TITLE_BAND_LO},${TITLE_BAND_HI}]` }
  }

  return { title: cand, decision: 'applied', note: `money tail "${moneyTitleCase(kwFinal)}" → ${cand.length} chars` }
}

/** One candidate's verdict, so the caller can log every attempt (Phase-0 observability). */
export interface MoneyTailAttempt { kw: string; decision: MoneyTailDecision; note: string; title: string }

/**
 * Run the money-tail CANDIDATE LOOP: try each derived keyword in order, stop at the first 'applied',
 * and stop early on a skip that is structural (identical for every candidate — see
 * MONEY_TAIL_STRUCTURAL_SKIPS). Per-keyword skips (cross-gender / word-repeat / spec-conflict /
 * no-fit) fall through to the next candidate instead of burning the slot.
 *
 * EXTRACTED FROM THE DOOR so there is exactly ONE loop. `stripTitleWasteVocabulary` has to answer
 * "would removing this waste word free space for the money keyword?", and the only trustworthy way
 * to answer it is to run the identical loop the door is about to run on the identical context — a
 * second, slightly-different copy inside the waste net is precisely how a "deterministic" pair of
 * nets starts disagreeing with each other. Pure and side-effect free; the caller owns the logging
 * and the shadow/on decision.
 */
export function tryMoneyTail(
  title: string,
  kws: readonly string[] | null | undefined,
  ctx: MoneyTailCtx,
): { title: string; applied: boolean; attempts: MoneyTailAttempt[] } {
  const attempts: MoneyTailAttempt[] = []
  for (const kw of kws ?? []) {
    const mt = enforceMoneyTail(title, kw, ctx)
    attempts.push({ kw, decision: mt.decision, note: mt.note, title: mt.title })
    if (mt.decision === 'applied') return { title: mt.title, applied: true, attempts }
    if (MONEY_TAIL_STRUCTURAL_SKIPS.has(mt.decision)) break
  }
  return { title, applied: false, attempts }
}

/**
 * Raise a short apparel title into the 70-75 band using product facts, inserting a ` | ` separator
 * before the audience tail. PURE, SYNCHRONOUS, TOTAL, IDEMPOTENT, MONOTONE:
 *   - never returns shorter than the input, and never exceeds TITLE_BAND_HI
 *   - a title already in band is returned byte-identical (so re-running is free)
 *   - a title ALREADY over the cap is returned untouched — capping is capTitle75's job, and doing
 *     both here would fight it
 *   - never emits a dangling separator
 */
export function enforceTitleBand(title: string, ctx: TitleBandCtx): { title: string; notes: string[]; decision: TitleBandDecision } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, notes: [], decision: 'empty' } // empty is the degrade gate's call, never the net's
  if (!ctx.apparel) return { title: t0, notes: [], decision: 'non-apparel' }
  if (t0.length > TITLE_BAND_HI) return { title: t0, notes: [], decision: 'over-cap' }
  if (t0.length >= TITLE_BAND_LO) return { title: t0, notes: [], decision: 'in-band' }

  const m = AUDIENCE_TAIL_RE.exec(t0)
  const head = (m ? t0.slice(0, m.index) : t0).trim()
  const tail = m ? t0.slice(m.index) : ''
  const joiner = head.includes(' | ') ? ' ' : ' | '

  let best = t0
  for (const seg of candidateSegments(t0, ctx)) {
    const cand = `${head}${joiner}${seg}${tail}`.replace(/\s{2,}/g, ' ').trim()
    if (cand.length > TITLE_BAND_HI) continue
    if (cand.length >= TITLE_BAND_LO) {
      // First candidate that lands IN band wins — ordered by product-signal strength, so this is
      // deterministic and explainable rather than "whichever happened to fit".
      return { title: cand, notes: [`band net: +"${seg}" → ${cand.length} chars`], decision: 'padded' }
    }
    if (cand.length > best.length) best = cand // monotone improvement, keep hunting
  }

  if (best !== t0) {
    return { title: best, notes: [`band net: padded to ${best.length} chars — facts exhausted below ${TITLE_BAND_LO}`], decision: 'facts-exhausted' }
  }
  return { title: t0, notes: [`band net: ${t0.length} chars, NO product facts available to reach ${TITLE_BAND_LO}`], decision: 'no-facts' }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT 1 — "for Men and Women" IS CHARACTER WASTE (PO ruling 2026-08-09, SELLER_PROFILE §4).
 *
 * THE PO'S VERDICT on their OWN locked title, verbatim: "TERRIBLE and Wasting MEN, WOMEN" —
 *   THE CEO World Soccer Cup Soccer T-Shirt, Women'S T-Shirts for Men and Women
 * The inclusive tail spends ~18 of 75 characters to say nothing, and here it says nothing TWICE: the
 * title already claims "Women's T-Shirts" and then offers the product to men. That self-contradiction
 * is not new — `validateTitle` (listingPipeline.ts:1953-1959) has DOCKED the gender-word-twice shape
 * for months ("state the audience ONCE"). Docking is advisory: it asks the retry loop to fix the
 * title and the retry loop is free to fail, so the defect shipped anyway. Per INVARIANT 2 a
 * measurable invariant gets a deterministic net on the SHIPPED bytes, never a prompt or a score dock.
 *
 * THE THREE RULES, and where each is enforced:
 *   (a) the inclusive phrase must NEVER co-occur with a gendered noun elsewhere → enforced HERE
 *       (delete the phrase; the audience is already stated once, by the noun)
 *   (b) on a LEANED listing it is already banned by §4 → enforced HERE, by NARROWING it to the
 *       leaned gender rather than deleting it. §4's other half is positive — "Lean set → the title
 *       MUST carry the matching tail" — so a bare delete would cure one §4 violation by creating
 *       another. "for Men and Women" on a female-lean becomes "for Women": 9 chars freed, audience
 *       kept, lean honoured. (When rule (a) also fires the noun already carries the audience, so
 *       deletion wins and no second gender word is introduced.)
 *   (c) on a UNIVERSAL design it is allowed ONLY when no money keyword fits that space → already
 *       enforced UPSTREAM by `enforceMoneyTail`, which was built to treat a bare trailing audience
 *       tail as the replaceable region and whose AUDIENCE_TAIL_RE explicitly covers
 *       `men and women` / `women and men`. VERIFIED, not assumed: on the PO's own title it returns
 *       'no-fit' (it reached the band-fit stage, i.e. it DID claim the tail region — a title with no
 *       replaceable tail returns 'no-tail' instead), and on a universal title it replaces the tail
 *       outright: "…Dink Responsibly Tee for Men and Women" → "…Dink Responsibly Tee | Funny Graphic
 *       Tees for Women" (70). So this net runs AFTER the money tail and simply honours its verdict:
 *       if the keyword took the space the phrase is gone; if it declined, 'universal-allowed' keeps
 *       the phrase, which is exactly "allowed only when nothing better fits".
 *
 * FAIL-OPEN. A removal that cannot be re-filled back into 70-75 from product facts is REFUSED and
 * the title returns byte-identical, logged — trading a wasteful in-band title for a clean out-of-band
 * one is not an improvement Amazon rewards.
 */
export type InclusiveAudienceDecision =
  | 'empty' | 'non-apparel' | 'no-phrase' | 'universal-allowed' | 'band-guard' | 'narrowed' | 'stripped'

export interface InclusiveAudienceCtx {
  /** Non-apparel titles never carry a garment audience tail. */
  apparel: boolean
  /** Seller audience lean — same union `enforceMoneyTail` takes, so the door passes ONE value. */
  lean?: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null
  /** The facts the band pad may re-fill freed characters with. Safe to compute from the PRE-removal
   *  title: this net only ever deletes AUDIENCE words, never a garment noun, so `garmentSecond`
   *  (`pickDistinctGarmentForm`) resolves identically before and after. */
  band: TitleBandCtx
}

/** Both genders, in either order, joined by "and"/"&"/","/nothing, with an optional leading "for" —
 *  i.e. every equivalent the PO named: "for Men and Women", "for Men & Women", "Men's and Women's",
 *  "Mens Womens". Built fresh per call: a shared /g/ regex carries `lastIndex` state across calls,
 *  which is exactly how a "deterministic" net stops being deterministic. */
const INCLUSIVE_MASC = String.raw`(?:men|mens|men['’]s)`
const INCLUSIVE_FEM = String.raw`(?:women|womens|women['’]s|ladies|ladies['’])`
const INCLUSIVE_JOIN = String.raw`(?:\s*(?:and|&|\+|,)\s*|\s+)`
const inclusiveAudienceRe = (): RegExp => new RegExp(
  String.raw`(?:\bfor\s+)?\b(?:${INCLUSIVE_MASC}${INCLUSIVE_JOIN}${INCLUSIVE_FEM}|${INCLUSIVE_FEM}${INCLUSIVE_JOIN}${INCLUSIVE_MASC})\b`,
  'gi',
)

/** Gendered NOUNS whose presence makes an inclusive audience claim self-contradicting.
 *
 *  A false positive here DELETES a tail that rule (c) would have ALLOWED, so this lexicon contains
 *  only words that can essentially ONLY be an audience claim on an apparel title. Deliberately
 *  EXCLUDED, each for a concrete reason:
 *    - `him`/`her`/`his` — PO gold #1 is "…I Will Praise Him in Every Season Tee | Christian Shirts
 *      for Women". "Him" there is devotional, not an audience.
 *    - singular `man`/`woman`/`girl`/`boy` — design vocabulary ("Man Cave", "Girl Dad").
 *    - plural `girls`/`boys` — same trap one step up: "Girls Trip", "Boys Night Out" are designs
 *      this seller plausibly prints, and a youth-audience listing is not what this ruling is about.
 *  What remains is the adult audience-noun set the PO's own specimen used. */
const GENDERED_NOUN_RE = /\b(?:men|mens|men['’]s|women|womens|women['’]s|ladies)\b/i

/**
 * Enforce the PO's inclusive-audience ruling on a title's shipped bytes.
 *
 * PURE, SYNCHRONOUS, DETERMINISTIC, IDEMPOTENT (an applied result contains no inclusive phrase and
 * re-enters as 'no-phrase', byte-identical). Never lengthens the audience claim, never invents a
 * gender the listing did not already state, and never returns a title outside [70,75] that the input
 * was not already outside.
 */
export function enforceInclusiveAudience(
  title: string,
  ctx: InclusiveAudienceCtx,
): { title: string; decision: InclusiveAudienceDecision; note: string } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, decision: 'empty', note: '' }
  if (!ctx.apparel) return { title: t0, decision: 'non-apparel', note: '' }

  const matches = [...t0.matchAll(inclusiveAudienceRe())]
  if (matches.length === 0) return { title: t0, decision: 'no-phrase', note: '' }

  // Rule (a): probe the title with EVERY inclusive phrase masked out, so the phrase's own "Men"/
  // "Women" can never be mistaken for the gendered noun that contradicts it.
  const masked = t0.replace(inclusiveAudienceRe(), ' ')
  const genderedElsewhere = GENDERED_NOUN_RE.exec(masked)?.[0] ?? null

  // Rule (b): a lean NARROWS the tail to the leaned gender; a soft lean counts (SELLER_PROFILE §4
  // draws no distinction — "'for Men and Women' is never correct on a leaned listing").
  const narrowTo = (ctx.lean === 'female' || ctx.lean === 'lean_female') ? 'Women'
    : (ctx.lean === 'male' || ctx.lean === 'lean_male') ? 'Men'
      : null

  // Rule (c): universal design, no contradicting noun — the money tail already had first refusal on
  // this space upstream and declined, which is precisely the condition under which §4 allows it.
  if (!narrowTo && !genderedElsewhere) {
    return { title: t0, decision: 'universal-allowed', note: 'universal design, no gendered noun, money tail declined the space' }
  }

  /* EXACTLY ONE match may be narrowed, and only when rule (a) is silent. Narrowing every match of
   * "Mens Womens Tee for Men and Women" would ship "Womens Tee for Women" — the gender-word-twice
   * shape :1953-1959 docks, i.e. we would have cured the waste by re-creating the contradiction.
   * The trailing tail wins the slot when there is one (it is the audience's natural home); otherwise
   * the first match keeps the lean in its stacked-adjective position. Every other match is deleted.
   * When rule (a) fires, `narrowIdx` is -1 and ALL matches go: the gendered noun already states the
   * audience once, which is the whole point of the rule. */
  const trailingIdx = matches.findIndex((m) => t0.slice((m.index ?? 0) + m[0].length).trim().length === 0)
  const narrowIdx = (narrowTo && !genderedElsewhere) ? (trailingIdx >= 0 ? trailingIdx : 0) : -1

  let out = ''
  let cursor = 0
  let narrowed = false
  let deleted = 0
  matches.forEach((m, i) => {
    const start = m.index ?? 0
    const end = start + m[0].length
    out += t0.slice(cursor, start)
    if (i === narrowIdx) {
      // Position decides the FORM: a trailing tail reads "for Women"; a mid-title occurrence is the
      // stacked-adjective slot ("Mens Womens Graphic Tee") and reads "Womens". Both keep §4's
      // positive half — a leaned title MUST still carry its matching audience word.
      out += (i === trailingIdx) ? ` for ${narrowTo}` : ` ${narrowTo === 'Women' ? 'Womens' : 'Mens'}`
      narrowed = true
    } else {
      out += ' '
      deleted++
    }
    cursor = end
  })
  out += t0.slice(cursor)
  const reduced = repairRemovalResidue(out)

  // Re-fill the freed characters from PRODUCT FACTS (never the pool — spec-vs-search grounding), then
  // judge the FINAL bytes. This is why the guard lives here and not in the caller: the removal and
  // the re-fill are one decision, and only their composition can be checked against the band.
  const padded = enforceTitleBand(reduced, ctx.band).title
  if (padded.length < TITLE_BAND_LO || padded.length > TITLE_BAND_HI) {
    return {
      title: t0,
      decision: 'band-guard',
      note: `removal would land ${padded.length} chars, outside [${TITLE_BAND_LO},${TITLE_BAND_HI}] even after the facts pad — refused, byte-identical`,
    }
  }

  const why = genderedElsewhere ? `contradicts gendered noun "${genderedElsewhere}"` : `lean=${ctx.lean}`
  return {
    title: padded,
    decision: narrowed ? 'narrowed' : 'stripped',
    note: `${narrowed ? `narrowed to the ${narrowTo} lean${deleted > 0 ? ` (+${deleted} deleted)` : ''}` : `removed ${deleted} inclusive phrase(s)`} — ${why}; ${t0.length} → ${padded.length} chars`,
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT B — A COLOR WORD IN SHARED COPY (SELLER_PROFILE §5, live B0GVVY5TS9 2026-08-09).
 *
 * §5, verbatim: "Colors: shared title/bullets carry NO color word; colors rank per-child via each
 * child's own backend tail." §3 says the same thing from the other side: "no variant attributes
 * (size/color)". A shared title is broadcast to every SKU in the family, so a color word in it
 * mis-describes every variant that is not that color — and buys nothing, because each child already
 * indexes its own shade through its own backend string.
 *
 * THE SHIPPED SPECIMEN, verbatim:
 *   THE CEO Futbol World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve
 * "Black" in the BROADCAST title. Nothing in the code enforced §5 on shipped bytes: the rule existed
 * only upstream, as a POOL filter (`colorNeutralFamily` + BASIC_COLOR_RE at listingPipeline :7621 /
 * :7661 / :7697 / :7890 / :9072 / :9158) — which keeps a color KEYWORD out of the candidate pool but
 * cannot touch a color word an LLM council wrote, a stored prior carried, or a fill composed. Per
 * INVARIANT 2 a measurable invariant gets a deterministic net on the shipped bytes.
 *
 * SAME VOCABULARY, NO NEW PREDICATE. BASIC_COLOR_WORDS (designName.ts) is the base 28-word list the
 * pool filters already use — this net does not invent one, and the compound-colorway extensions
 * ('forest', 'sky', 'wine', 'gold', …) are deliberately excluded there because they are ordinary
 * design vocabulary.
 *
 * DESIGN CARVE-OUT. A color word that belongs to the DESIGN ("Black Cat", "Pink Ribbon") is not a
 * variant attribute and is never removed — the same distinction listingPipeline :829 already draws
 * ("A design name containing a color is unaffected — it flows via the verbatim design-name anchor,
 * not the keyword pool"). The caller passes every design phrase in scope (family design name plus
 * each per-child design name), so a multi-design broadcast title is protected against ALL of its
 * designs' vocabulary.
 *
 * SCOPE — BROADCAST *AND* PER-CHILD, and that is correct here rather than a hazard. Colour is never
 * a per-child TITLE axis in this codebase: `per_child_titles` are produced in exactly two places,
 * per DESIGN GROUP for multi-design apparel (listingPipeline :8312 — every SKU in the group, across
 * all its colors, gets the SAME string) and per CAPACITY for non-apparel families (:8595, gated
 * `!apparelProduct`). There is no path where a child's title states that child's own color, so the
 * net can run on every title the door sees. Non-apparel is skipped outright: a color there is a
 * product fact, not a variant attribute.
 */

/** Why the net did (or did not) fire — every pass reports, per Phase-0 observability.
 *   empty / non-apparel — structural skips
 *   no-color      — no base color word present (also the idempotence path: an applied result
 *                   contains no removable color and re-enters here byte-identical)
 *   design-color  — every color word present belongs to the design phrase; protected, untouched
 *   band-guard    — removal could not land back inside [70,75] even after the facts pad → refused
 *   stripped      — a variant color word left the shipped bytes  ← the only outcome that changes them */
export type VariantColorDecision =
  | 'empty' | 'non-apparel' | 'no-color' | 'design-color' | 'band-guard' | 'stripped'

export interface VariantColorCtx {
  /** Non-apparel color words are product facts, not variant attributes — skipped. */
  apparel: boolean
  /** Every design phrase in scope, space-joined. A color word appearing here is DESIGN vocabulary
   *  and is never removed. Empty/absent = no design vocabulary to protect (the removal proceeds —
   *  a color word that no design claims is a variant attribute by elimination). */
  protect?: string | null
  /** The facts the band pad may re-fill freed characters with. Safe to compute from the PRE-removal
   *  title: this net only ever deletes COLOR words, never a garment noun, so `garmentSecond`
   *  (`pickDistinctGarmentForm`) resolves identically before and after. */
  band: TitleBandCtx
}

/** Built fresh per call — a shared /g/ regex carries `lastIndex` across calls, which is exactly how
 *  a "deterministic" net stops being deterministic (same reason as `inclusiveAudienceRe`). */
const variantColorRe = (): RegExp => new RegExp(`\\b(?:${BASIC_COLOR_WORDS.join('|')})\\b`, 'gi')

/**
 * Remove garment-color words from a SHARED title's shipped bytes, re-pad from product facts, and
 * refuse any removal that cannot land back inside the band.
 *
 * PURE, SYNCHRONOUS, DETERMINISTIC, IDEMPOTENT (an applied result carries no removable color word
 * and re-enters as 'no-color', byte-identical). Never adds a word — the re-fill is `enforceTitleBand`,
 * which pads only from BLANK_SPECS facts, never the search pool (spec-vs-search grounding), and can
 * never emit a color. FAIL-OPEN: a refusal returns the input byte-identical with the reason.
 */
export function stripVariantColorWords(
  title: string,
  ctx: VariantColorCtx,
): { title: string; decision: VariantColorDecision; note: string } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, decision: 'empty', note: '' }
  if (!ctx.apparel) return { title: t0, decision: 'non-apparel', note: '' }

  const matches = [...t0.matchAll(variantColorRe())]
  if (matches.length === 0) return { title: t0, decision: 'no-color', note: '' }

  // Design carve-out. Compared on bare lowercase WORDS so "Black-Cat" and "black cat" protect alike.
  const protectedWords = new Set(
    (ctx.protect ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean),
  )
  const removable = matches.filter((m) => !protectedWords.has(m[0].toLowerCase()))
  if (removable.length === 0) {
    return { title: t0, decision: 'design-color', note: `color word(s) belong to the design "${ctx.protect}" — protected` }
  }

  let out = ''
  let cursor = 0
  const removed: string[] = []
  for (const m of removable) {
    const start = m.index ?? 0
    out += `${t0.slice(cursor, start)} `
    removed.push(m[0])
    cursor = start + m[0].length
  }
  out += t0.slice(cursor)
  const reduced = repairRemovalResidue(out)

  // Re-fill the freed characters from PRODUCT FACTS, then judge the FINAL bytes — the removal and the
  // re-fill are ONE decision (same reasoning as enforceInclusiveAudience's guard).
  const padded = enforceTitleBand(reduced, ctx.band).title
  if (padded.length < TITLE_BAND_LO || padded.length > TITLE_BAND_HI) {
    return {
      title: t0,
      decision: 'band-guard',
      note: `removing ${removed.join(', ')} would land ${padded.length} chars, outside [${TITLE_BAND_LO},${TITLE_BAND_HI}] even after the facts pad — refused, byte-identical`,
    }
  }

  const kept = matches.length - removable.length
  return {
    title: padded,
    decision: 'stripped',
    note: `removed variant color word(s) ${removed.join(', ')}${kept > 0 ? ` (${kept} kept as design vocabulary)` : ''}; ${t0.length} → ${padded.length} chars`,
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * TITLE WASTE VOCABULARY — "Unisex" and "Classic Fit" (PO ruling 2026-08-09, SELLER_PROFILE §3
 * gold rule 4 + the §8 unisex rule).
 *
 * THE SPECIMEN is the PO's own rewrite of the AI's B0GVV3XL4T title:
 *   AI:  THE CEO 2026 World Soccer Cup USA Mexico Canada Unisex Tee | Classic Fit   (72)
 *   PO:  THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee   (72)
 * Same 72 characters; the PO spent 19 of them on a money keyword instead of two product facts.
 * §3: '"Unisex"/"Classic Fit" are NOT title words (they belong in bullets/description per the unisex
 * rule §8) — the noun ×2 pattern (Tee Shirt … Tee) carries the garment instead.' §8 is even more
 * explicit and is the older of the two rulings: the unisex fit MUST be stated, "but ONLY in Bullets,
 * Description, and Features/Item Highlights. NEVER in the Title".
 *
 * TITLE-ONLY, and that word is doing real work. Neither phrase is FALSE — the blanks genuinely are
 * unisex (`blank_specs.unisex`) and the Gildan 64000 genuinely is a classic fit (`blank_specs.fit`).
 * Nothing here touches those facts anywhere else: `applyTerminalNets` still guarantees the unisex
 * sizing clause in the bullets and the description note, the Item Highlights still carry the fit,
 * and the Product Detail attributes still push Fit Type. This net removes them from ONE field,
 * because in a 75-character budget they cost a money keyword.
 *
 * WHY DETERMINISTIC AND HERE. Identical reasoning to the three nets above: `validateTitle` can dock
 * and prompts can ask, but a dock is advisory and the retry loop is free to fail — the AI title
 * shipped with BOTH phrases. Per INVARIANT 2 a measurable invariant gets a terminal net on the
 * SHIPPED bytes, at the one shared `bandTitle` seam every exit passes through.
 *
 * THE PO'S OWN GUARD, verbatim: strip "only when removal frees space for a keyword or the title
 * still lands in 70-75". Both arms are implemented below, in that order — the money keyword gets
 * first claim on the freed characters (that is the whole point of the ruling), and the facts pad
 * only inherits the space when no keyword fits. A removal that satisfies neither arm is REFUSED,
 * byte-identical: a wasteful in-band title beats a clean out-of-band one, because Amazon rewrites
 * the second one.
 */

/** The two phrases, and nothing else. A blocklist that grows by vibes is how a net starts eating
 *  genuine copy; each entry here is a phrase the PO named in the ruling. `unisex` is a single word
 *  wherever it appears; `classic fit` is matched as the two-word CLAIM only, so a design called
 *  "Classic Car Shirt" is untouched — the same distinction FIT_CLAIM_RE already draws above. */
const TITLE_WASTE_SOURCE = String.raw`\bunisex\b|\bclassic\s+fit\b`
/** Built fresh per call — a shared /g/ regex carries `lastIndex` across calls, which is exactly how
 *  a "deterministic" net stops being deterministic (same reason as `inclusiveAudienceRe`). */
const titleWasteRe = (): RegExp => new RegExp(TITLE_WASTE_SOURCE, 'gi')
/** Non-global twin for predicate use, so no `lastIndex` state can leak between probes. */
const TITLE_WASTE_TEST_RE = new RegExp(TITLE_WASTE_SOURCE, 'i')

/** Does this phrase consist of / contain TITLE-only waste vocabulary? Exported because the facts
 *  pad must refuse to ADD what this net removes — one predicate, both ends (INVARIANT 5). */
export function isTitleWasteVocabulary(phrase: string): boolean {
  return TITLE_WASTE_TEST_RE.test(phrase || '')
}

/** Why the net did (or did not) fire — every pass reports, per Phase-0 observability.
 *   empty / non-apparel — structural skips
 *   no-waste        — no waste phrase present (also the idempotence path: a stripped result carries
 *                     none and re-enters here byte-identical)
 *   money-tail-owns — the ONLY waste sits in a pipe-right that is ENTIRELY waste ("… | Classic
 *                     Fit"). Deleting it here would delete the pipe, and `enforceMoneyTail` returns
 *                     'no-tail' on a tail-less title — i.e. the removal would destroy the very slot
 *                     the ruling wants the money keyword to take. Hand the region to the money tail
 *                     instead (post-ruling it is replaceable). If the money tail also declines, the
 *                     phrase survives — which is the same answer the band guard would give anyway,
 *                     since a bare "…Unisex Tee" left over is ~13 chars under the band.
 *   band-guard      — neither arm of the PO's guard held → refused, byte-identical
 *   stripped        — waste left the shipped bytes  ← the only outcome that changes them */
export type TitleWasteDecision =
  | 'empty' | 'non-apparel' | 'no-waste' | 'money-tail-owns' | 'band-guard' | 'stripped'

export interface TitleWasteCtx {
  /** Non-apparel: "unisex"/"classic fit" are not garment waste there, and §8 is an apparel rule. */
  apparel: boolean
  /** The facts the band pad may re-fill freed characters with (arm 2 of the PO's guard). Safe to
   *  compute from the PRE-removal title: this net only ever deletes waste vocabulary, never a
   *  garment noun, so `garmentSecond` (`pickDistinctGarmentForm`) resolves identically either side. */
  band: TitleBandCtx
  /** Arm 1 of the PO's guard — "removal frees space for a keyword". The money-keyword CANDIDATES the
   *  door is about to try, and the context it will try them with. Pass null unless the money tail is
   *  actually LIVE (`TITLE_MONEY_TAIL=on`): at off/shadow the door ships the title unchanged, so a
   *  removal justified by a keyword that never lands would leave a short title and nothing to fill
   *  it. Absent ⇒ arm 1 is simply unavailable and arm 2 (the facts pad) decides alone. */
  moneyKws?: readonly string[] | null
  money?: MoneyTailCtx | null
}

/**
 * Remove TITLE-only waste vocabulary from a title's shipped bytes, under the PO's two-arm guard.
 *
 * PURE, SYNCHRONOUS, DETERMINISTIC, IDEMPOTENT (a stripped result carries no waste phrase and
 * re-enters as 'no-waste', byte-identical). Never adds a word of its own: arm 1 hands the freed
 * characters to `enforceMoneyTail` (the door installs the keyword in the very next stage), arm 2 to
 * `enforceTitleBand`, which pads only from BLANK_SPECS facts and is itself now barred from
 * re-adding this vocabulary. FAIL-OPEN: a refusal returns the input byte-identical with the reason.
 *
 * RUNS BEFORE THE MONEY TAIL in the door, deliberately — the opposite of the color and
 * inclusive-audience nets. Those two compete with the keyword for the SAME tail region, so the
 * keyword gets first refusal and they clean up after. This one mostly frees characters on the LEFT
 * ("…Canada Unisex Tee"), and those characters are only useful to the keyword if they are free
 * BEFORE it is measured against the band. The one case where it WOULD collide with the tail region
 * is carved out above as 'money-tail-owns'.
 */
export function stripTitleWasteVocabulary(
  title: string,
  ctx: TitleWasteCtx,
): { title: string; decision: TitleWasteDecision; note: string } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, decision: 'empty', note: '' }
  if (!ctx.apparel) return { title: t0, decision: 'non-apparel', note: '' }

  const matches = [...t0.matchAll(titleWasteRe())]
  if (matches.length === 0) return { title: t0, decision: 'no-waste', note: '' }

  // The carve-out: a pipe-right made of NOTHING but waste is the money tail's region, not ours.
  const pipeIdx = t0.indexOf(' | ')
  const rightStart = pipeIdx >= 0 ? pipeIdx + 3 : -1
  const rightIsAllWaste = rightStart >= 0
    && t0.slice(rightStart).replace(titleWasteRe(), ' ').replace(/[^A-Za-z0-9]+/g, ' ').trim().length === 0
  const removable = matches.filter((m) => !(rightIsAllWaste && (m.index ?? 0) >= rightStart))
  if (removable.length === 0) {
    return { title: t0, decision: 'money-tail-owns', note: `pipe right "${t0.slice(rightStart)}" is pure waste — handed to enforceMoneyTail, which may replace it wholesale` }
  }

  let out = ''
  let cursor = 0
  const removed: string[] = []
  for (const m of removable) {
    const start = m.index ?? 0
    out += `${t0.slice(cursor, start)} `
    removed.push(m[0])
    cursor = start + m[0].length
  }
  out += t0.slice(cursor)
  const reduced = repairRemovalResidue(out)
  const what = `removed ${removed.join(', ')}`

  // ARM 1 — "removal frees space for a keyword". The PO's ruling is explicitly a PRIORITY ruling
  // (money beats facts in the pipe-right), so the keyword is offered the freed characters FIRST.
  // The title is returned UN-padded: padding it here would hand the space to a fact and could even
  // put the garment BRAND into the pipe-right, which the brand-tail guard would then protect —
  // the fact pad locking out the very keyword this removal was justified by.
  if (ctx.moneyKws && ctx.moneyKws.length > 0 && ctx.money) {
    const after = tryMoneyTail(reduced, ctx.moneyKws, ctx.money)
    if (after.applied) {
      const won = after.attempts[after.attempts.length - 1]?.kw ?? ''
      return { title: reduced, decision: 'stripped', note: `${what}; freed ${t0.length - reduced.length} chars for money keyword "${won}" (${t0.length} → ${reduced.length}, keyword lands it at ${after.title.length})` }
    }
  }

  // ARM 2 — "or the title still lands in 70-75", judged on the FINAL bytes after the facts pad,
  // because the removal and the re-fill are ONE decision (same reasoning as the two nets above).
  const padded = enforceTitleBand(reduced, ctx.band).title
  if (padded.length >= TITLE_BAND_LO && padded.length <= TITLE_BAND_HI) {
    return { title: padded, decision: 'stripped', note: `${what}; ${t0.length} → ${padded.length} chars` }
  }

  return {
    title: t0,
    decision: 'band-guard',
    note: `${what} would land ${padded.length} chars, outside [${TITLE_BAND_LO},${TITLE_BAND_HI}] and no money keyword fits the freed space — refused, byte-identical`,
  }
}
