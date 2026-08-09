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
    if (s && !alreadyStates(title, s) && !out.includes(s)) out.push(s)
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
 * Remove repeated significant words, then cap garment surface forms at two DISTINCT ones.
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
export function collapseRepeatedWords(title: string): { title: string; removed: string[] } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t0) return { title, removed: [] }

  const words = t0.split(' ')
  const seen = new Set<string>()
  const kept: string[] = []
  const removed: string[] = []

  for (const w of words) {
    // Compare on letters only, so "Tshirt," and "Tshirt" are the same word and punctuation never
    // hides a duplicate. The ORIGINAL token (with its punctuation) is what gets kept.
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!bare || TITLE_CONNECTORS.has(bare) || w === '|') { kept.push(w); continue }
    if (seen.has(bare)) { removed.push(w); continue }              // repeat of a significant word
    seen.add(bare)
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
 *   fact-tail       — the pipe's right side carries the garment BRAND or a SPEC FACT (the gold-#2
 *                     "… | Long Sleeve Comfort Colors Shirt" shape). CONSERVATIVE SKIP pending the
 *                     PO scope ruling: SELLER_PROFILE §3 protects the golds as fixtures and bans
 *                     pool terms outside the ONE money slot, so this net never evicts a brand/fact
 *                     tail — whether a high-value money keyword may EVER outrank one is an open PO
 *                     question recorded in §3.
 *   no-tail         — the title has neither a ` | ` pipe nor a bare trailing audience tail. The net
 *                     only ever REPLACES a tail; it never APPENDS where none existed (conservative
 *                     reading of the design-led doctrine — the B0FKKN8XKV gold's pre-lock title
 *                     ended "for Women", i.e. had a replaceable tail).
 *   spec-conflict   — the market phrase would re-leak a spec claim the blank doesn't back
 *   no-fit          — the candidate cannot land inside [70,75] without truncating the keyword
 *   applied         — the gold-shape tail shipped  ← the only outcome that changes bytes */
export type MoneyTailDecision =
  | 'empty' | 'no-kw' | 'non-apparel' | 'already-covered' | 'cross-gender'
  | 'word-repeat' | 'design-right' | 'fact-tail' | 'no-tail' | 'spec-conflict' | 'no-fit' | 'applied'

export interface MoneyTailCtx {
  /** Non-apparel never gets the garment money tail. */
  apparel: boolean
  /** Seller audience lean — the cross-gender veto twin of listingPipeline.ts:6031-6034. Soft leans
   *  veto too (stricter than the fill): a wrong veto is a no-op, a wrong ship is a regression. */
  lean?: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null
  /** Blank spec — feeds scrubUnspecdGarmentClaims (a market phrase like "heavyweight shirts" must
   *  not re-leak a weight/fit claim the blank doesn't back) AND the fact-tail guard (a pipe-right
   *  stating the blank's fit/sleeve/neck is a protected fact tail, never evicted). */
  spec?: { fit?: string | null; sleeve?: string | null; neck?: string | null; weightNote?: string | null } | null
  /** The design phrase. On a piped title the right side is replaceable only when it can be PROVEN
   *  not to carry the design — if it shares a distinctive token with the design (Pattern-B-ish
   *  "… | I Will Praise Him …"), or no design name resolved at all (nothing to prove against),
   *  the net must never delete the right side. */
  protect?: string | null
  /** The garment blank's brand in canonical casing (BLANK_SPECS, e.g. "Comfort Colors"). A
   *  pipe-right carrying its tokens is a protected brand/fact tail (gold #2's shape) — the
   *  fact-tail guard skips rather than evict it. */
  garmentBrand?: string | null
}

/** Spec-fact vocabulary (post-moneyNormTok fold) that only ever appears in a FACT pipe tail —
 *  the deterministic half of the fact-tail guard for when the blank spec is unresolved (null
 *  spec must still protect "… | Long Sleeve Comfort Colors Shirt"). Deliberately tight: each
 *  word is garment-attribute vocabulary, not design vocabulary. */
const MONEY_FACT_TAIL_LEXICON = new Set([
  'sleeve', 'fit', 'neck', 'crew', 'heavyweight', 'midweight', 'lightweight', 'cotton', 'personalized',
])

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
 * CONSERVATIVE SCOPE (2026-08-09 adversarial verdicts — pending the PO's explicit scope ruling,
 * recorded in SELLER_PROFILE §3): the net only ever REPLACES an existing tail — a pipe-right or a
 * bare trailing audience tail — and never APPENDS to a tail-less title ('no-tail'). A pipe-right
 * is replaceable only when it can be PROVEN to carry neither the design ('design-right', which
 * also fires when no design name resolved), nor the garment brand, nor a spec fact ('fact-tail' —
 * the protection that keeps gold #2 "… | Long Sleeve Comfort Colors Shirt" byte-identical under
 * ANY keyword; the probe that forced this showed the pre-guard net deleting "Long Sleeve" and
 * evicting "Comfort Colors" for an opp-floor-less keyword). The audience survives either inside
 * the keyword itself ("… for Women") or re-appended verbatim after it. The keyword is NEVER
 * truncated mid-phrase — the only permitted trim is its own "for women/men" suffix, and only when
 * the audience already lives on the left. Anything that cannot land inside
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

  // CONSERVATIVE: replace-only, never append. A title with neither a pipe nor a bare trailing
  // audience tail has no replaceable tail region — skip rather than graft one on.
  if (pipeIdx < 0 && !tailM) return { title: t0, decision: 'no-tail', note: 'no pipe and no trailing audience tail to replace' }

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
    // Never replace a pipe-right that carries the garment BRAND or a SPEC FACT — the gold-#2
    // "… | Long Sleeve Comfort Colors Shirt" shape is a PO gold ("Protected as test fixtures —
    // no net may alter them", SELLER_PROFILE §3). Whether a money keyword may ever outrank a
    // brand/fact tail (and above what value floor) is an OPEN PO question; until ruled, skip.
    const factToks = new Set([
      ...moneySigToks(ctx.garmentBrand ?? ''),
      ...moneySigToks([ctx.spec?.fit, ctx.spec?.sleeve, ctx.spec?.neck].filter(Boolean).join(' ')),
    ])
    const factHit = [...rightToks].find((tok) =>
      (factToks.has(tok) || MONEY_FACT_TAIL_LEXICON.has(tok)) && !MONEY_GARMENT_FAMILY.has(tok) && !MONEY_AUDIENCE_TOKS.has(tok))
    if (factHit) {
      return { title: t0, decision: 'fact-tail', note: `pipe right side carries brand/spec fact "${factHit}" — protected` }
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
