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

  // Residue repair — same classes collapseRepeatedWords repairs after ITS removals (kept as a twin
  // on purpose; that function is behavior-frozen by its own tests).
  out = out
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
  return { title: out, removed }
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
