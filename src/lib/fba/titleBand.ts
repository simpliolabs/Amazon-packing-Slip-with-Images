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
// The shared content truth spine. No cycle: contentTruth imports only blankSpecs, which imports
// productDetailAttrs + contentContract and never this module.
import {
  applyTitleTruthNet, phraseTruthVerdict, dominantGarmentGroup, garmentGroupsIn, hasRedundantGarmentMention,
  titleAssertsYouthAudience, type PhraseTruthCtx,
} from './contentTruth'
// Both are zero-import leaves (designName imports nothing; trademarkGuard imports nothing), so this
// file stays cycle-free and unit-testable in isolation.
import { BASIC_COLOR_WORDS } from './designName'
import { classifyTail } from './poGoldCorpus'
import { hasTrademark } from './trademarkGuard'

/** ONE source per bound — never a new magic number (generation-invariants INVARIANT 5). */
export const TITLE_BAND_LO = CONTENT_CONTRACT.title.goldenBandLo // 70
export const TITLE_BAND_HI = CONTENT_CONTRACT.title.hardCap //      75

/**
 * TITLE_RULING_OVER_FLOOR — off | on. Default off ⇒ byte-identical to today.
 *
 * THE TWO BOUNDS ARE NOT THE SAME KIND OF THING, and treating them as one tier let an unrelated
 * spec-table cell silently reverse a seller ruling.
 *
 *   TITLE_BAND_HI = 75  — Amazon's, externally enforced (Amazon rewrites a longer title; error 100476)
 *   TITLE_BAND_LO = 70  — OURS, `scoreTitleQuality`'s golden band, enforced by nothing outside this repo
 *
 * The three PO-ruling removal guards below (`enforceInclusiveAudience`, `stripVariantColorWords`,
 * `stripTitleWasteVocabulary`) each re-pad after removing and then veto on BOTH bounds — so our own
 * scorer's preference can outrank a seller ruling. Measured on B0GVV3XL4T (2026-08-10): removing the
 * banned word "Unisex" left 54 chars; the facts pad's ENTIRE vocabulary for that Gildan blank topped
 * out at 69, because the one candidate that reached band ("Classic Fit Shirt", 74) is itself banned
 * by the SAME ruling. 69 < 70 ⇒ refused byte-identical ⇒ **the banned word shipped**.
 *
 * The proof that this is arbitrary rather than principled: change only `blank_specs.fit` from
 * "Classic" to "Relaxed" and the identical removal is PERMITTED, landing 74. Whether a seller's
 * editorial ruling is honoured depended on an unrelated cell in a spec table.
 *
 * At `on`, a removal may ship a title UNDER our preferred floor but never over Amazon's cap. An
 * honest 69-char title beats a 73-char one carrying a word the seller banned — which is the seller's
 * own ruling ("crew neck can go on highlights"), now costed openly: `scoreTitleQuality` will fall on
 * those listings until a money keyword is available to fill the space properly.
 */
const rulingOverFloor = (): boolean => (process.env.TITLE_RULING_OVER_FLOOR || 'on').toLowerCase() !== 'off'

/**
 * May a PO editorial removal ship at this post-pad length? ONE predicate for all three guards — they
 * carried three byte-identical copies of the bound check, which is how the next edit lands on two of
 * them. PURE apart from the flag read.
 */
export function removalPermitted(paddedLen: number): { ok: boolean; why: string } {
  if (paddedLen > TITLE_BAND_HI) {
    return { ok: false, why: `${paddedLen} chars is over Amazon's ${TITLE_BAND_HI} cap` }
  }
  // THE ABSOLUTE FLOOR, both arms. The first cut of this function removed the lower bound ENTIRELY
  // at 'on' rather than lowering it — `removalPermitted(1)` returned ok — because the only floor in
  // the predicate was the one being relaxed. The realistic way that bites is not a contrived input:
  // `blank_specs` fails OPEN when a blank has no row (task #159), so `candidateSegments` yields
  // nothing, the pad cannot add a character, and the incident title ships at 54 rather than the
  // "60s" this change quotes to the seller as its honest cost. 50 is CONTENT_CONTRACT.title.floor —
  // validateTitle's own under-length trigger, already the source of the two bounds above, so this
  // introduces no new number.
  if (paddedLen < CONTENT_CONTRACT.title.floor) {
    return { ok: false, why: `${paddedLen} chars is under the absolute ${CONTENT_CONTRACT.title.floor} floor` }
  }
  if (!rulingOverFloor() && paddedLen < TITLE_BAND_LO) {
    return { ok: false, why: `${paddedLen} chars is under our ${TITLE_BAND_LO} preferred floor (TITLE_RULING_OVER_FLOOR=off)` }
  }
  return { ok: true, why: '' }
}

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
  /** THE FAMILY'S OWN GARMENT VOCABULARY (2026-08-21, live B0DSCDZC6K). Product facts the caller
   *  derives from the RESOLVED BLANKS — the garment surface forms of every garment_family in the
   *  family's own union ("Sweatshirt", "Crewneck", "Pullover", "Hooded Sweatshirt"), Title-Cased.
   *  NEVER a market/search phrase: these are what the blanks ARE. Ordered weakest-signal-last by
   *  the caller; every entry still passes `truthOk` and `alreadyStates` below.
   *
   *  WHY THIS EXISTS: a MIXED-blank family agrees on almost nothing, so the spec facts intersect
   *  away and `garmentBrand` is empty whenever the blank forbids its name in copy (every Gildan
   *  row). That left exactly ONE pad candidate — a single garment form — and a title the terminal
   *  truth net had shortened could not get back into the band with it. */
  factSegments?: readonly string[]
  /** The content truth spine's verdict for THIS family, so the pad can never re-mint the very lie
   *  the terminal truth net just removed (a SHIRT productType on a sweatshirt family resolves
   *  `garmentSecond` to "Shirt"). Absent ⇒ every candidate passes, i.e. today's behavior. */
  truthOk?: (segment: string) => boolean
  /**
   * TRUTHFUL POOL PHRASES — the pad's THIRD and last fact bank (PO 2026-08-22, after PR #630/#631
   * were reverted off production).
   *
   * WHY THIS EXISTS, and why the previous build was wrong to omit it. #631 gave the pad the
   * family's own garment vocabulary and it was still not enough: on B0DSCDZC6K the terminal truth
   * net correctly deleted "Funny Work Shirts" and "for Women", and the pad — restricted BY DOCTRINE
   * to BLANK_SPECS facts — could only reach 29-49 chars against the 70-75 band. The titles were
   * TRUE and unrankable, so a copy defect became a worse ranking defect and the whole spine came
   * off production. THE LESSON, now standing: truth and band are ONE contract, and a subtractive
   * net is only safe when paired with an additive producer that can restore the invariant.
   *
   * THE DOCTRINE WAS ALREADY INCOHERENT. "The pad is facts-only, never a search term" sat beside
   * `enforceMoneyTail`, which installs a POOL KEYWORD in the title's money position on the very
   * same door pass. The title has always carried pool vocabulary; only the PAD pretended otherwise.
   * What actually matters is not WHERE a phrase came from but whether it is TRUE of this product —
   * which is exactly the question `truthOk` asks, and it is asked of these segments too.
   *
   * ORDERED AFTER the spec facts and the garment vocabulary, so spec-grounding still beats coverage
   * (SELLER_PROFILE §2) and a family with a real fact bank pads identically to today. The CALLER
   * supplies phrases already filtered for truth, design scope and off-niche; every one is still
   * re-gated here by `truthOk`, the waste vocabulary, `alreadyStates` and `wordsAreNew`. */
  poolSegments?: readonly string[]
  /** THE YOUTH MARKER (defect 1, PO 2026-08-23, live B0DP5H8QBT) — 'Kids'/'Youth'/'Boys'/'Girls',
   *  derived by the CALLER from the resolved blank's garment_family + the seller's audience lean
   *  (`youthMarkerFor` in contentTruth.ts), NEVER guessed here. null/absent for a non-kids family —
   *  the pad adds nothing and every adult title is byte-unchanged. Pushed FIRST (ahead of every other
   *  fact): asserting the audience the family truthfully claims is a correctness requirement, not an
   *  opportunistic pad, so it gets first refusal on the search's limited depth/budget. */
  youthMarker?: string | null
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

const bandWords = (s: string): string[] => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean)

/**
 * CONCEPT-level distinctness — the SPACING twin of `collapseRepeatedWords`.
 *
 * THE DEFECT, caught by the full-title gate and invisible to every word-level check: a title
 * already ending "…Fall Crewneck" was padded with the blank's `neck` fact "Crew Neck", shipping
 * "| Long Sleeve Fall Crewneck Crew Neck". No word repeats — "crewneck" and "crew"+"neck" are
 * different tokens — so `collapseRepeatedWords`, `alreadyStates` and `wordsAreNew` all pass it. But
 * Amazon indexes the concept ONCE, so the second spelling spends 10 of 75 characters on nothing.
 *
 * The test is flattening: every 1-to-3-word window of the title, letters only, spaces removed. A
 * candidate whose own flattened form is already in that set is the same concept re-spelled, in
 * either direction ("Crew Neck" against "Crewneck", and "Crewneck" against "Crew Neck").
 */
function titleConcepts(title: string): Set<string> {
  const w = bandWords(title).filter((x) => !TITLE_CONNECTORS.has(x))
  const out = new Set<string>()
  for (let i = 0; i < w.length; i++) {
    for (let n = 1; n <= 3 && i + n <= w.length; n++) out.add(w.slice(i, i + n).join(''))
  }
  return out
}
function conceptIsNew(title: string, phrase: string): boolean {
  const flat = bandWords(phrase).filter((x) => !TITLE_CONNECTORS.has(x)).join('')
  return flat.length === 0 || !titleConcepts(title).has(flat)
}

/** Word-level distinctness: TRUE when no significant word of `phrase` already appears in `title`.
 *  `alreadyStates` only catches the whole phrase; this is the same discipline
 *  `pickDistinctGarmentForm` applies to a single garment form, generalised to multi-word facts. */
function wordsAreNew(title: string, phrase: string): boolean {
  const have = new Set(bandWords(title))
  const w = bandWords(phrase)
  return w.length > 0 && w.every((x) => TITLE_CONNECTORS.has(x) || !have.has(x))
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
  // ONE GARMENT CLASS (defect 3, PO 2026-08-22, live B0DSCDZC6K: the pad itself re-introduced a
  // SECOND class — "Hooded" onto a title that already committed to "Sweatshirt" — because every
  // gate above judges TRUTH, and a mixed family's hoodie facts are perfectly true. The pad is the
  // LAST writer, so `applyTitleTruthNet`'s own single-class rule (contentTruth.ts) cannot reach a
  // class it introduces after the net already ran. Computed ONCE, from the title as this door
  // received it — the SAME money-phrase-priority doctrine the net's `scrubMoneyPhrase` uses. */
  const committedClass = dominantGarmentGroup(title)
  const push = (v?: string | null): void => {
    const s = (v ?? '').trim()
    // TITLE-ONLY WASTE VOCABULARY (PO ruling 2026-08-09, §3 gold rule 4). "Classic Fit" is a REAL
    // Gildan 64000 spec fact — `titleBandCtx` composes it straight from `blank_specs.fit` — but the
    // PO ruled it is not a TITLE word. Without this check the pad would re-install the exact phrase
    // `stripTitleWasteVocabulary` just removed (the two nets compose inside one door pass), which is
    // both a live oscillation and a broken idempotence claim. The fact itself is untouched
    // everywhere else: bullets, description and the Product Detail attributes still read the spec.
    if (!s || isTitleWasteVocabulary(s)) return
    // TRUTH GATE (2026-08-21). The pad is the LAST writer in the door, downstream of the terminal
    // truth net — so an untrue candidate here is a lie nothing else can catch. A sweatshirt family
    // listed under an Amazon SHIRT productType resolves `garmentSecond` to "Shirt"; without this
    // the pad would weld back exactly the "Shirts" the net had just dropped.
    if (ctx.truthOk && !ctx.truthOk(s)) return
    // ONE CLASS (defect 3) — a candidate naming a DIFFERENT garment class than the title already
    // committed to is skipped, same as an untrue one. Both classes may be individually true
    // (sweatshirt + hoodie); the title still may not name both.
    if (committedClass) {
      const segClass = dominantGarmentGroup(s)
      if (segClass && segClass !== committedClass) return
    }
    // CONCEPT GATE (2026-08-22): "Crew Neck" onto a title already saying "Crewneck" is the same
    // concept re-spelled — indexed once, and 10 characters of the 75 spent on nothing. Applies to
    // EVERY candidate, spec facts included, because the blank's `neck` fact is where it came from.
    if (!conceptIsNew(title, s)) return
    if (!alreadyStates(title, s) && !out.includes(s)) out.push(s)
  }
  // THE YOUTH MARKER (defect 1) leads even "Personalized" — a kids family's title asserting its own
  // audience is a truth requirement `verdictForAssembledTitle` now enforces, not a nice-to-have pad.
  if (ctx.youthMarker) push(ctx.youthMarker)
  // Amazon Custom (2026-07-31, PO): "Personalized" leads the fact list — on an enrolled listing it
  // is both a verified product fact AND the highest-intent search modifier available. Never pushed
  // when the listing is not enrolled (the flag defaults false; a false claim is worse than a short title).
  if (ctx.customizable) push('Personalized')
  push(ctx.garmentBrand)
  push(ctx.spec?.fit)
  push(ctx.spec?.sleeve)
  push(ctx.spec?.neck)
  const attributeCount = out.length          // everything above is a product ATTRIBUTE, not a noun
  push(ctx.garmentSecond)
  /* THE FAMILY'S OWN GARMENT VOCABULARY (2026-08-21) — the resolved blanks' surface forms, e.g.
   * Sweatshirt / Crewneck / Pullover / Hooded Sweatshirt / Hoodie on a mixed 18000+18500 family.
   * Last among the singles because a spec attribute is a stronger product signal than a second noun
   * for the same garment; but these are the facts that keep a MIXED-blank family — whose attributes
   * intersect away to almost nothing — from having no pad bank at all.
   *
   * WORD-DISTINCT, like `garmentSecond` already is. `alreadyStates` only rejects the whole phrase,
   * so a title ending "…Sweatshirt" would otherwise be padded "| Crewneck Sweatshirt" — a repeated
   * word `collapseRepeatedWords` has already run past by the time the pad fires. */
  for (const f of ctx.factSegments ?? []) if (wordsAreNew(title, f)) push(f)
  const garmentFacts = out.slice(attributeCount)   // garmentSecond + the family's own vocabulary
  const attributeFacts = out.slice(0, attributeCount)
  // Pairs, so a single thin fact can still carry the title into band without inventing anything.
  // These two stay FIRST and unchanged: on a family that HAS a copy-legal brand they are today's
  // chosen pads, and reordering them would rewrite healthy titles for no reason.
  if (ctx.garmentBrand && ctx.garmentSecond) push(`${ctx.garmentBrand.trim()} ${ctx.garmentSecond.trim()}`)
  if (ctx.spec?.fit && ctx.garmentSecond) push(`${ctx.spec.fit.trim()} ${ctx.garmentSecond.trim()}`)
  /* GENERIC PAIRS (2026-08-21) — the reach a MIXED-blank family needs.
   *
   * The two pairs above are both keyed on `garmentBrand`/`spec.fit`, and B0DSCDZC6K has NEITHER:
   * every Gildan row is `brand_in_copy=false` (so `garmentBrand` is '') and "Classic Fit" is title
   * waste vocabulary. The bank was therefore ONE ~8-char garment form against a 16-char gap, so
   * `enforceTitleBand` returned 'facts-exhausted' ~11 chars short — the live 54/61/64 titles.
   *
   * ALWAYS <attribute> <garment noun>, never attribute+attribute. That is the PO's gold shape
   * ("… | Long Sleeve Comfort Colors Shirt") and it is also a REGRESSION GUARD: an unrestricted
   * product would mint "Comfort Colors Relaxed Fit" — a pure spec stack in the money position, the
   * exact tail class the seller has shipped zero times and the reason `dropSpecOnlyTail` exists. */
  for (const a of attributeFacts) {
    for (const g of garmentFacts) {
      if (alreadyStates(a, g) || alreadyStates(g, a)) continue   // "Sweatshirt" + "Crewneck Sweatshirt"
      push(`${a} ${g}`)
    }
  }
  /* TRUTHFUL POOL PHRASES — LAST, and only what the product's own facts could not reach.
   *
   * Every entry passes the SAME four gates a spec fact does (`push` applies the waste check, the
   * truth predicate and `alreadyStates`), plus `wordsAreNew` so a pool phrase can never re-state a
   * word the title already spends. Being last means a family with a healthy fact bank pads exactly
   * as it does today: `enforceTitleBand` returns on the FIRST candidate that lands in band, so
   * these are only ever reached when the facts genuinely ran out — which is the starvation case
   * that took the truth spine off production. */
  for (const p of ctx.poolSegments ?? []) if (wordsAreNew(title, p)) push(p)
  return out
}

/** OBSERVABILITY ONLY — how many product-fact segments the pad has available for this title.
 *  `TITLE_UNDER_BAND` reports it, so "the pad is mis-wired" and "the pad had nothing to say" are
 *  distinguishable from one log line instead of from a code reading. Pure; mutates nothing. */
export function candidateFactCount(title: string, ctx: TitleBandCtx): number {
  return candidateSegments(title, ctx).length
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
  const lastSigIndex = new Map<string, number>()   // significant-word index of each token's last use
  const firstSeg = new Map<string, number>()       // the segment a token first appeared in
  const echoed = new Set<string>()                 // tokens already granted their one design echo
  let sigCount = 0
  let segment = 0
  const isGarment = (bare: string): boolean => MONEY_GARMENT_FAMILY.has(moneyNormTok(bare))
  const kept: string[] = []
  const removed: string[] = []

  for (const w of words) {
    // SEGMENT ADVANCES ON ANY SEPARATOR, NOT ONLY A PIPE (2026-08-11, round-2 adversarial pass).
    // This counter only incremented on a literal '|', so on a COMMA-joined title every word lived
    // in segment 0 and the cross-separator garment allowance below could never fire. Measured on
    // the seller's own canonical gold #1:
    //   in  "THE CEO Later Alligator Long Sleeve Shirt, Later Gator Comfort Colors Shirt" (75)
    //   out "THE CEO Later Alligator Long Sleeve Shirt, Gator Comfort Colors"            (63)
    // — it deleted their design echo ("Later") AND the mandated second garment noun ("Shirt"),
    // ending on a bare brand. FOUR of the nine golds are non-pipe and the rebuilt brief now teaches
    // that shape, so this was damaging the spec itself on the most likely output form.
    if (w === '|') { segment++; kept.push(w); continue }
    // A word ENDING in a comma closes its segment AFTER it is processed — advancing early (and
    // `continue`-ing) skipped the dedupe for that word entirely and let "Tshirt, Tshirt" back
    // through, re-opening defect #148. The separator is a boundary, not an exemption.
    const closesSegment = /[,;]$/.test(w)
    // Compare on letters only, so "Tshirt," and "Tshirt" are the same word and punctuation never
    // hides a duplicate. The ORIGINAL token (with its punctuation) is what gets kept.
    const bare = w.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!bare || TITLE_CONNECTORS.has(bare)) { kept.push(w); if (closesSegment) segment++; continue }
    if (seen.has(bare)) {
      const segs = garmentSegs.get(bare)
      const prevSig = lastSigIndex.get(bare)
      const apart = prevSig !== undefined && sigCount - prevSig >= 2
      // The cross-segment garment allowance now also requires DISTANCE. Commas advance the segment
      // (so the seller's comma-joined golds are measured correctly), which without this would let
      // the adjacent "Tshirt, Tshirt" stutter of defect #148 back through on a technicality.
      if (segs && apart && !segs.has(segment) && segs.size < 2) {  // the golds' one cross-separator repeat
        segs.add(segment)
        lastSigIndex.set(bare, sigCount)
        sigCount++
        kept.push(w)
        if (closesSegment) segment++
        continue
      }
      // DESIGN ECHO (2026-08-11): the seller's gold #1 deliberately repeats its design word across
      // the separator — "…Later Alligator Long Sleeve Shirt, LATER Gator Comfort Colors Shirt". The
      // global one-and-only rule deleted that echo and left the title 6 chars shorter and weaker.
      // A repeat is allowed once when it is in a DIFFERENT segment AND at least two significant words away, so it reads as
      // structure rather than a stutter; #148's adjacent "Tshirt, Tshirt" stays removed because the
      // occurrences are neighbours. Distance is measured in kept significant words.
      const prev = lastSigIndex.get(bare)
      const farApart = prev !== undefined && sigCount - prev >= 2
      if (!echoed.has(bare) && !segs && farApart && firstSeg.get(bare) !== segment) {
        echoed.add(bare)
        lastSigIndex.set(bare, sigCount)
        sigCount++
        kept.push(w)
        if (closesSegment) segment++
        continue
      }
      removed.push(w)                                             // repeat of a significant word
      if (closesSegment) segment++
      continue
    }
    seen.add(bare)
    lastSigIndex.set(bare, sigCount)
    firstSeg.set(bare, segment)
    sigCount++
    if (isGarment(bare)) garmentSegs.set(bare, new Set([segment]))
    kept.push(w)
    if (closesSegment) segment++
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

/**
 * THE CENSOR-STAR TWIN of `fixApostropheCase` (PO 2026-08-21, live B0DSCDZC6K: "Business B*Tch").
 *
 * A star is a NON-WORD character, so `\b` fires on both sides of it and the repo's Title-Case pass
 * (`s.replace(/\b\w/g, c => c.toUpperCase())`) capitalises the letter that FOLLOWS it — turning the
 * seller's own design name "Business B*tch" into "Business B*Tch" mid-word. The star is a censor,
 * not a word break, and the design name must ship verbatim.
 *
 * PURE, TOTAL, IDEMPOTENT (an already-correct "B*tch" has a lowercase letter and is returned
 * byte-identical) and LENGTH-NEUTRAL, so it may run beside `fixApostropheCase` in the ship door
 * without a band guard.
 *
 * WHAT MUST NOT BREAK: a deliberately ALL-CAPS censored word ("F*CK", "SH*T", "WTF*", "B*TCH" typed
 * that way by the seller) keeps every capital — the letters around the star are inspected as ONE
 * token and an all-caps token is never touched.
 */
export function fixCensorStarCase(title: string): string {
  const t = title || ''
  if (!t.includes('*')) return title // fast path: the overwhelming majority of titles
  return t.replace(/([A-Za-z]+)\*([A-Za-z])([A-Za-z]*)/g, (m, pre: string, first: string, rest: string) => {
    if (first === first.toLowerCase()) return m                        // already correct — idempotence
    const word = `${pre}${first}${rest}`
    if (word === word.toUpperCase()) return m                          // "F*CK", "B*TCH" — deliberate
    return `${pre}*${first.toLowerCase()}${rest}`
  })
}

/**
 * THE repo's ONE Title-Case pass for title text. Every producer used to inline
 * `fixApostropheCase(s.replace(/\b\w/g, c => c.toUpperCase()))` — six copies, and the star artifact
 * had to be fixed in all six or in none. Both artifacts of the `\b\w` caser (the apostrophe and the
 * censor star) are repaired here, so a caser added tomorrow inherits both by using this function.
 */
export function titleCasePhrase(s: string): string {
  return fixCensorStarCase(fixApostropheCase((s || '').replace(/\b\w/g, (c) => c.toUpperCase())))
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
 *   truth-lie       — the market keyword itself fails the content truth spine (defect 1, PO
 *                     2026-08-22, live B0DSCDZC6K parent: "mind your business tshirt for men" — a
 *                     wrong garment noun AND a forced gender on a unisex family, both baked into ONE
 *                     candidate keyword this derivation's filters never asked the truth spine about).
 *                     `ctx.truth` absent ⇒ this never fires (fail-open, byte-identical to today).
 *   applied         — the gold-shape tail shipped  ← the only outcome that changes bytes */
export type MoneyTailDecision =
  | 'empty' | 'no-kw' | 'non-apparel' | 'already-covered' | 'cross-gender'
  | 'word-repeat' | 'design-right' | 'brand-tail' | 'no-tail' | 'spec-conflict' | 'no-fit' | 'applied'
  | 'truth-lie'

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
  /** THE CONTENT TRUTH SPINE (defect 1, PO 2026-08-22). This derivation's own filters check
   *  off-niche, season, color-neutrality, word count and cross-gender vs. hard/soft LEANS — never
   *  the family's blank-grounded truth, and never `audience-lean-lie` (which only fires on an
   *  explicit `unisex`, a value the lean checks above never veto on). A candidate that fails it is
   *  skipped per-keyword ('truth-lie'), same as every other per-candidate veto. null/undefined ⇒ no
   *  ground truth to judge against ⇒ this never fires (fail-open, matches every other truth-ctx
   *  consumer in the pipeline). */
  truth?: PhraseTruthCtx | null
  /** Sibling design name tokens this candidate must never carry (per-child exits only) — the SAME
   *  whole-string verify `settleTruthBand`'s search runs on every candidate it assembles, applied
   *  here too so a market keyword cannot win the money slot by carrying another design's identity. */
  foreignTokens?: ReadonlySet<string>
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
  // THE TRUTH SPINE (defect 1) — BEFORE every other veto, same discipline as the cross-gender check
  // just below: a candidate that lies about the garment or forces a gender on a unisex family never
  // gets a chance to win the slot, no matter how it scores on volume/opportunity upstream.
  if (ctx.truth && !phraseTruthVerdict(kw0, ctx.truth).ok) return { title: t0, decision: 'truth-lie', note: `"${kw0}" fails the content truth spine` }

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

  // THE WHOLE-STRING VERIFY (2026-08-22 rewrite). A market keyword can be individually true
  // (`ctx.truth` already checked `kw0` above) and STILL make the ASSEMBLED title lie: a second
  // garment class this money position welds on ("… Sweatshirt | … Pullover Hoodie"), a concept
  // already stated on the left in a different spelling, or — per-child scope — a sibling design's
  // name the keyword derivation's own off-niche filters never modeled. Same predicate the additive
  // search uses; a candidate that fails it never wins the slot, no matter how it scored upstream.
  const verdict = verdictForAssembledTitle(cand, { truth: ctx.truth ?? null, protect: ctx.protect ?? '', foreignTokens: ctx.foreignTokens })
  if (!verdict.ok) {
    return { title: t0, decision: 'truth-lie', note: `assembled candidate fails whole-title verification (${verdict.reason})` }
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
  // The pad is deliberately UNCONSTRAINED here: its job is to reach the band from product facts.
  // Whether the money position it produces is worth ranking for is judged ONCE, terminally, by
  // `dropSpecOnlyTail` at the door — after this pad, so there is exactly one place that owns the
  // rule instead of a guard inside every operation that can touch a separator.

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
 * THE ONE NET — TRUTH AND BAND ARE ONE CONTRACT (PO 2026-08-22).
 *
 * WHAT WENT WRONG THE FIRST TIME, measured live on B0DSCDZC6K and not theorised. PRs #630/#631
 * shipped the shared truth spine and its live-gate fixes, and the truth rules WORKED: no "shirts"
 * on a sweatshirt family, no forced gender on a unisex lean, no mid-phrase fragments. The titles
 * came out at 29-49 characters against the 70-75 band (the parent at 37). Both commits were
 * reverted off production, because a truthful title nobody can find is a worse defect than the
 * untruthful one it replaced.
 *
 * THE CAUSE IS STRUCTURAL, NOT A TUNING MISS. The truth net only SUBTRACTS. The band pad, which is
 * the only thing that can add, was restricted BY DOCTRINE to BLANK_SPECS facts — and a MIXED-blank
 * family intersects its facts away to almost nothing. So the system had a subtractive net with no
 * additive counterpart, and the arithmetic could only ever go one way.
 *
 * THE RULE THIS ENCODES: a net may only ship a title it has shortened if it can re-fill that title
 * to the band FROM TRUE MATERIAL. Truth and band are not two nets that run in sequence and hope;
 * they are ONE exit condition — `truthful AND in band` — and a title that cannot satisfy both is a
 * REFUSAL, never a stub. The operator sees the refusal and the listing keeps what it already has,
 * which is the same abort-and-preserve discipline the repo already applies to an empty AI response.
 *
 * PURE and SYNCHRONOUS: the caller owns every log line and every hold it raises, so this function
 * can be pinned directly against real strings.
 */
/** Refill passes the additive producer may take before it gives up. Each pass adds at most one
 *  product fact (`enforceTitleBand` appends one segment), so this bounds the widest gap the pad can
 *  close: a title the truth net cut in half needs several ~10-char facts, never one. A pass that
 *  adds nothing exits the loop immediately, so this ceiling is a guard, not the normal exit. */
export const MAX_REFILL_PASSES = 4
/** Candidate expansions the refill search may evaluate before giving up. Deterministic and cheap:
 *  a title within one fact of the band exits on the first branch, and this only binds on a family
 *  whose facts genuinely cannot span the gap — where the answer is a refusal either way. */
export const REFILL_NODE_BUDGET = 600

/** Append ONE segment the way `enforceTitleBand` does — inserting BEFORE the audience tail, and
 *  extending the pipe-right rather than opening a second pipe once one exists. Extracted so the
 *  band pad and the refill search compose segments identically; two copies of this would let the
 *  greedy pad and the search disagree about what a title even looks like. */
function appendBandSegment(title: string, seg: string): string {
  const m = AUDIENCE_TAIL_RE.exec(title)
  const head = (m ? title.slice(0, m.index) : title).trim()
  const tail = m ? title.slice(m.index) : ''
  const joiner = head.includes(' | ') ? ' ' : ' | '
  return `${head}${joiner}${seg}${tail}`.replace(/\s{2,}/g, ' ').trim()
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE WHOLE-STRING VERIFY — the rewrite's central seam (handoff/TITLE_SETTLE_REWRITE.md §3.3).
 *
 * FOUR live defects shipped through four consecutive "fixes" (#630/#632/#634/#637) because every
 * check up to this point judges a SEGMENT or a CANDIDATE PHRASE in isolation: `phraseTruthVerdict`
 * asks "is this one phrase true?", `candidateSegments`'s gates ask "is this one candidate safe to
 * offer?". None of them can see the ASSEMBLED STRING, so a title built from individually-true pieces
 * can still be a false WHOLE — "Long Sleeve" + "Longsleeve Tee" is two true fragments and one lying
 * title (`Long Sleeve Longsleeve Tee`), naming a garment class the family is not.
 *
 * `verdictForAssembledTitle` is the ONE function that judges the WHOLE title, and it is the predicate
 * the additive search (`settleTruthBand`) and the money-tail installer (`enforceMoneyTail`) now both
 * call before accepting ANY candidate — filtering and filling are the SAME decision, not "filter,
 * then fill, then hope". It reuses `applyTitleTruthNet`'s own idempotence as the truth+foreign-name
 * probe (a title that net would still edit is not yet clean — no second rulebook), and adds the two
 * checks a per-segment predicate structurally cannot express: one garment class for the WHOLE title,
 * and no concept restated in two spellings across the WHOLE title (`Crewneck` + `Crew Neck`).
 */
export interface AssembledTitleCtx {
  /** The family's blank-grounded truth. Absent ⇒ no ground truth to judge against — the truth/foreign
   *  name half is skipped (fail-open, matching every other truth-ctx consumer in this file); the two
   *  ctx-free checks below (duplicate concept, punctuation) still run unconditionally. */
  truth: PhraseTruthCtx | null
  /** Design words that must survive verbatim — same meaning as `applyTitleTruthNet`'s `protectHay`. */
  protect?: string
  /** Sibling design name tokens this title may never carry (per-child exits only). */
  foreignTokens?: ReadonlySet<string>
  /** The whole-phrase sibling-name rejector (per-child exits only) — same partition `foreignTokens`
   *  is built from, at the segment-drop granularity `applyTitleTruthNet.rejectSegment` takes. */
  reject?: (seg: string) => boolean
  /** BROADCAST/parent titles only — see `applyTitleTruthNet`'s doc on the same option. */
  scrubProtectedOverlap?: boolean
}

export type AssembledTitleVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Does a candidate SIBLING span dispute this title — 2 or 3 word window `w`, or a bare word already
 * present — re-state a concept spelled a different way ("Crewneck" vs "Crew Neck")? Self-check twin
 * of `conceptIsNew` (which tests a NEW candidate against an EXISTING title): this tests the ASSEMBLED
 * string against itself, because a combination the additive search built one segment at a time can
 * restate a concept the search never directly compared the two occurrences of. Windows built from a
 * very short (<2 char) word are skipped — not enough signal to avoid a coincidental collision.
 */
export function titleHasDuplicateConcept(title: string): boolean {
  const w = bandWords(title).filter((x) => !TITLE_CONNECTORS.has(x))
  const singles = new Set(w.filter((x) => x.length >= 4))
  const multiSeen = new Set<string>()
  for (let i = 0; i < w.length; i++) {
    for (let n = 2; n <= 3 && i + n <= w.length; n++) {
      const chunk = w.slice(i, i + n)
      if (chunk.some((x) => x.length < 2)) continue
      const flat = chunk.join('')
      // the SAME multi-word concept twice, or a multi-word window spelling out a bare word already
      // present elsewhere ("crew" + "neck" against a standalone "crewneck") — either direction.
      if (multiSeen.has(flat) || singles.has(flat)) return true
      multiSeen.add(flat)
    }
  }
  // THE SAME GARMENT NAMED THREE WAYS (defect 2, PO 2026-08-23, live B0DP5H8QBT). The original
  // specimen — "T-Shirt Graphic Tee Shirt | Short Sleeve" — named the tee class three times before
  // ANY separator; "T-Shirt", "Tee" and "Shirt" all name the SAME class and the window-flattening
  // check above cannot see it: none of these three spellings concatenate to match another, because
  // they are three GENUINELY DIFFERENT spellings, not one concept split across a word boundary.
  // `hasRedundantGarmentMention` (contentTruth.ts) reuses the coverage-token-style garment grouping
  // every other truth check in this file already shares — no second vocabulary.
  //
  // PIPE-DELIMITED, NOT COMMA-DELIMITED (2026-08-23 correction, live B0DP5H8QBT: "T-Shirt, Graphic
  // Tees | Kids Toddler Tee" shipped with THREE tee-class mentions — this loop split on `,` as well
  // as `|` and so checked "T-Shirt", "Graphic Tees" and "Kids Toddler Tee" as three SEPARATE
  // segments, each with only one mention, and missed it). The PO's own sanctioned noun-×2 gold shape
  // ("Tee Shirt | … TShirt", one compound mention before the pipe plus one bare mention after it) is
  // a claim about the PIPE — "once per side of the pipe" — never about a comma clause; a comma inside
  // one side is ordinary coordination ("T-Shirt, Graphic Tees" reads as two design descriptors), not
  // a second side the noun is entitled to. Splitting on `|` alone makes the redundant-mention check
  // whole-CLAUSE instead of comma-fragmented: "T-Shirt, Graphic Tees" is now ONE segment, so its two
  // non-adjacent tee-class mentions are caught by `hasRedundantGarmentMention`'s existing ≥2-groups
  // rule — no new threshold, no new vocabulary — while the gold shape (exactly one mention on each
  // side of the ONE pipe) still resolves to one group per segment and stays untouched.
  for (const seg of title.split(/\s*\|\s*/)) {
    if (hasRedundantGarmentMention(seg)) return true
  }
  return false
}

/**
 * Punctuation integrity on the WHOLE title — the live specimen is "Entrepreneur, |" (a comma directly
 * against a pipe). Every one of these is residue a mid-string removal can leave behind when a repair
 * chain misses a case; a per-segment check cannot see it because the defect straddles the separator.
 */
export function titleHasPunctuationDefect(title: string): boolean {
  if (!title) return false
  return /,\s*\|/.test(title)              // ", |" — the exact live specimen
    || /\|\s*,/.test(title)                // "| ,"
    || /,\s*,/.test(title)                 // ",,"
    || /\|\s*\|/.test(title)               // "||"
    || /[,|]\s*$/.test(title)              // trailing separator
    || /^\s*[,|]/.test(title)              // leading separator
    || /\s{2,}/.test(title)                // doubled space
    || /,\s+(?:for|and)\b/i.test(title)    // dangling comma before a connector
}

/**
 * THE ONE PREDICATE for an ASSEMBLED title. `ok:false` means this exact string may never ship,
 * however it was built. Reused by the additive search (per candidate it is about to accept) and by
 * `enforceMoneyTail` (on the candidate it is about to install) — the SAME question, asked the SAME
 * way, everywhere a title could be chosen. Pure.
 */
export function verdictForAssembledTitle(title: string, ctx: AssembledTitleCtx): AssembledTitleVerdict {
  const t = (title || '').trim()
  if (!t) return { ok: true }
  if (ctx.truth) {
    // Idempotence IS the truth+foreign-name probe: a title `applyTitleTruthNet` would still edit is
    // not yet clean — no second rulebook duplicating what that net already knows how to judge.
    const netted = applyTitleTruthNet(t, ctx.truth, ctx.protect ?? '', {
      rejectSegment: ctx.reject,
      foreignTokens: ctx.foreignTokens,
      scrubProtectedOverlap: ctx.scrubProtectedOverlap,
    })
    if (netted !== t) return { ok: false, reason: 'untrue-or-foreign-segment-present' }
    if (garmentGroupsIn(t).size > 1) return { ok: false, reason: 'two-garment-classes' }
    /* UNSPEC'D ATTRIBUTE CLAIM (PO 2026-08-23). `scrubUnspecdGarmentClaims` owned this rule as a
     * pipeline STAGE running BEFORE the pad, so the pad re-added from the pool exactly what the
     * stage removed ("Oversized" on a Classic-fit Gildan 64000B, live 2026-08-23). Expressed HERE
     * it is inadmissible, not merely deleted. Idempotence IS the probe, exactly as the truth net
     * above: a title that scrub would still edit carries a claim the blank does not support. */
    const scrubbed = scrubUnspecdGarmentClaims(t, ctx.truth.spec ?? null)
    if (scrubbed.title !== t) return { ok: false, reason: 'unspecd-attribute-claim' }
    // THE KIDS IDENTITY MUST BE ASSERTED, NOT MERELY NOT-DENIED (defect 1, PO 2026-08-23, live
    // B0DP5H8QBT). Removing an adult claim (#642) is necessary but not sufficient: a kids_tee family's
    // title that never says Kids/Youth/Boys/Girls reads as adult by default. `youthMarkerFor` derives
    // the expected word from the BLANK-grounded ctx alone (never the title or the pool); this checks
    // only for PRESENCE of any youth marker, so a design that already carries one under a different
    // word (or the family's own gendered lean) is never double-counted or contradicted.
    if (ctx.truth.audience === 'kids' && !titleAssertsYouthAudience(t)) {
      return { ok: false, reason: 'missing-youth-marker' }
    }
  }
  if (titleHasDuplicateConcept(t)) return { ok: false, reason: 'duplicate-concept' }
  if (titleHasPunctuationDefect(t)) return { ok: false, reason: 'punctuation-defect' }
  return { ok: true }
}

export type TruthBandDecision =
  /** The run did not produce a title (a bullets/keywords regen passes the prior through). */
  | 'not-produced'
  /** Non-apparel titles are legitimately short — the band is an apparel invariant. */
  | 'non-apparel'
  /** Already OVER the 75 cap on arrival — `capTitle75` owns the ceiling and runs upstream, so this
   *  should be unreachable; named rather than mislabelled 'in-band' if it ever is not. */
  | 'over-cap'
  /** Already 70-75 and truthful. The common, healthy case; returned byte-identical. */
  | 'in-band'
  /** Was short, and TRUE material carried it back into the band. The outcome that proves the
   *  additive producer works — and the one thing #630/#631 could never reach. */
  | 'refilled'
  /** Could NOT reach the band from true material, so the PRIOR title is kept and a hold is raised.
   *  Nothing ships; the operator decides. */
  | 'refused-kept-prior'
  /** Could not reach the band and there is NO prior to preserve (a listing with no live title).
   *  The truthful short title ships — this is the ONLY path on which a sub-band title exits, and it
   *  still raises a hold. */
  | 'unreachable-no-prior'
  /** Could NOT reach the band from true material AND the prior itself fails `verdictForAssembledTitle`
   *  (a sibling design's name, a forced gender on a unisex family, or any other whole-string lie).
   *  PO ruling 2026-08-23: "a hold may keep the prior title ONLY IF the prior title is TRUE." A hold
   *  is a fallback, not a licence to ship a known lie just because it happens to be in band — so this
   *  is the SECOND path (with `unreachable-no-prior`) on which a sub-band title exits deliberately,
   *  and it still raises a hold so the operator sees it. */
  | 'shipped-truthful-under-band'

export interface TruthBandResult {
  title: string
  decision: TruthBandDecision
  /** Length of the returned title. */
  len: number
  /** The product-fact and truthful-pool segments the pad had available — so a hold distinguishes
   *  "the pad is mis-wired" from "the pad had nothing true left to say" from ONE log line. */
  tried: string[]
  reason: string
  /** TRUE when the operator must see this — the caller raises the hold and logs
   *  TITLE_BAND_UNREACHABLE. Never true on a healthy exit. */
  hold: boolean
}

/**
 * THE terminal truth+band exit. Runs LAST, on the bytes that ship, after every other net including
 * the facts pad and the money-position gate.
 *
 * `prior` is the title that is live on Amazon today. It is what a refusal PREFERS to preserve — but
 * (PO ruling 2026-08-23) only when the prior is itself TRUE: swapping a live title for a shorter
 * truthful one is a real trade-off (the #630/#631 revert), but keeping an in-band LIE over a
 * truthful short title is not a trade-off at all, it is the inverted priority this ruling exists to
 * fix. So the prior IS re-judged here, by the same `verdictForAssembledTitle` predicate every
 * candidate the search assembles is judged by — see the refusal branch below. A prior that fails
 * truth still surfaces as a hold with the operator (nothing ships silently either way); it just does
 * not get to be the thing that ships.
 */
export function settleTruthBand(args: {
  produced: string
  prior?: string | null
  apparel: boolean
  band: TitleBandCtx
  /** THE WHOLE-STRING VERIFY CTX (2026-08-22 rewrite). Threaded through so the additive search can
   *  re-judge every candidate it is about to accept — SEARCH and VERIFY are one step, not two.
   *  Optional/undefined ⇒ the search falls back to a LENGTH-only accept (every caller in this repo
   *  now supplies it via `enforceTitleTruthBand`; left optional only so a future direct caller with
   *  no truth ctx fails open exactly like every other truth-ctx consumer here, never a hard error). */
  truth?: PhraseTruthCtx | null
  protect?: string
  foreignTokens?: ReadonlySet<string>
  reject?: (seg: string) => boolean
  scrubProtectedOverlap?: boolean
}): TruthBandResult {
  const produced = (args.produced || '').replace(/\s{2,}/g, ' ').trim()
  const prior = (args.prior || '').replace(/\s{2,}/g, ' ').trim()
  const done = (title: string, decision: TruthBandDecision, reason: string, tried: string[] = [], hold = false): TruthBandResult =>
    ({ title, decision, len: title.length, tried, reason, hold })

  if (!produced) return done(args.produced || '', 'not-produced', 'no title produced this run')
  if (!args.apparel) return done(produced, 'non-apparel', 'band is an apparel invariant')
  // OVER-CAP IS NOT "IN BAND". `capTitle75` owns the ceiling and runs upstream, so this should be
  // unreachable — but a terminal net that blessed an 80-char title as in-band would hide exactly
  // the Amazon 100476 rejection it exists to prevent. Named, not silently folded into 'in-band'.
  if (produced.length > TITLE_BAND_HI) return done(produced, 'over-cap', `${produced.length} chars — capTitle75 owns the ceiling`)

  /** THE WHOLE-STRING VERIFY CTX, bound once — moved ahead of the in-band fast path (PO 2026-08-23,
   *  live B0DP5H8QBT). Before this move only the additive search below ever consulted it, so a title
   *  that arrived from the producer ALREADY 70-75 chars shipped on length alone — the exact gap that
   *  let "T-Shirt Graphic Tee Shirt | Short Sleeve" (a duplicate-concept AND missing-youth-marker
   *  title, both whole-string properties `verdictForAssembledTitle` exists to catch) through
   *  untouched. Every exit from here on is judged the SAME way, in-band arrival or not. */
  const verifyCtx: AssembledTitleCtx = {
    truth: args.truth ?? null, protect: args.protect, foreignTokens: args.foreignTokens,
    reject: args.reject, scrubProtectedOverlap: args.scrubProtectedOverlap,
  }
  if (produced.length >= TITLE_BAND_LO && verdictForAssembledTitle(produced, verifyCtx).ok) {
    return done(produced, 'in-band', `${produced.length} chars`)
  }

  /* THE ADDITIVE HALF, AND IT MUST ITERATE — this is the second half of why #630/#631 could not
   * reach the band, and it is invisible from any single-leaf test.
   *
   * `enforceTitleBand` appends exactly ONE segment: it returns the first candidate that lands in
   * band, and otherwise keeps the single longest improvement and stops. A title the truth net cut
   * to 37 characters needs ~35 more, and NO single product fact is 35 characters long — so the pad
   * would add one ~10-char fact, report 'facts-exhausted' at 47, and the band was structurally
   * unreachable no matter how rich the fact bank was. Enlarging the bank alone (#631) could never
   * have fixed it.
   *
   * So the refill runs to a FIXED POINT. Each pass re-derives its candidates against the CURRENT
   * title, so `alreadyStates` / `wordsAreNew` exclude everything already spent and no fact can be
   * added twice; `enforceTitleBand` is monotone (never shortens, never exceeds the cap), so the
   * loop is strictly increasing and terminates. `MAX_REFILL_PASSES` bounds it regardless — a pass
   * that adds nothing breaks out immediately, which is the normal exit. */
  const tried = candidateSegments(produced, args.band)
  const band = args.band

  /* WHY THIS IS A SEARCH AND NOT A LOOP — the third and last reason the band was unreachable, and
   * the one only a full-title gate could have found.
   *
   * `enforceTitleBand` is GREEDY: it returns the first candidate that lands in band, and otherwise
   * keeps the LONGEST improvement. Greedy-longest walks into dead ends. Measured on this family's
   * "Billionare Coming Soon" design: the head is 41 chars, no single fact spans the 29-char gap, so
   * greedy took the longest available (a 25-char pool phrase) and landed on 69 — ONE character
   * under the floor, with every remaining candidate now too long to fit under the 75 cap. Stuck at
   * 69 forever, while `41 + "Mind Your Business" + "Long Sleeve"` = 74 was sitting right there.
   *
   * So the refill explores COMBINATIONS, depth-first in candidate order, and returns the first that
   * lands inside the band. Bounded twice over — by depth and by a node budget — so it stays
   * deterministic and cheap; a title within one fact of the band exits on the first branch.
   *
   * POOL PHRASES OUTRANK GARMENT NOUNS AFTER THE FIRST SEGMENT. Spec-grounding beats coverage for
   * the segment that names the product (`candidateSegments` order, unchanged). Once the title has
   * stated its garment, a SECOND garment noun buys nothing — Amazon indexes a token once — while a
   * truthful pool phrase indexes a query a shopper actually types. Without this the pad produced
   * "| Long Sleeve Pullover Hoodie Crewneck": four garment nouns, all true, all worthless. */
  const poolSet = new Set(band.poolSegments ?? [])
  let budget = REFILL_NODE_BUDGET
  let best = produced
  const search = (t: string, depth: number): string | null => {
    if (t.length >= TITLE_BAND_LO && t.length <= TITLE_BAND_HI) {
      const v = verdictForAssembledTitle(t, verifyCtx)
      if (v.ok) return t
      // Already in band — but "in band" is not "settled". Every whole-string defect EXCEPT
      // missing-youth-marker is a dead end here exactly as before 2026-08-23: the search can only
      // APPEND, never repair a lie already present (a duplicate concept, a foreign name, a second
      // garment class, stray punctuation). Scoping the one exception this narrowly — by REASON, not
      // merely "verdict failed" — keeps the search's DFS traversal byte-identical for every family
      // that never lacks a youth marker (i.e. every non-kids family, and a kids family that already
      // asserts one): widening this to "keep trying on ANY failure" was tried first and changed which
      // combination a healthy sweatshirt/hoodie fixture landed on (truthBandGate.test.ts's pinned
      // broadcast string), even though the new string was itself truthful — an unrelated behavior
      // change this fix must not cause.
      if (v.reason !== 'missing-youth-marker') return null
      // fall through: a missing marker IS additively fixable, so keep trying to append it even though
      // `t` is already 70+ chars.
    }
    if (depth >= MAX_REFILL_PASSES || budget <= 0) return null
    const cands = candidateSegments(t, band)
    const ordered = depth === 0
      ? cands
      : [...cands.filter((c) => poolSet.has(c)), ...cands.filter((c) => !poolSet.has(c))]
    for (const seg of ordered) {
      if (budget-- <= 0) return null
      const cand = appendBandSegment(t, seg)
      if (cand.length > TITLE_BAND_HI || cand.length <= t.length) continue
      // VERIFY THE WHOLE ASSEMBLED STRING before taking this branch. A candidate that individually
      // passed `candidateSegments`'s per-phrase gates can still make the ASSEMBLED title untrue: a
      // second garment class, a concept restated in two spellings, a sibling name reached only in
      // combination. On failure: drop this segment (never take it) and try the next one — the search
      // itself already backtracks via the surrounding loop and recursion, so "drop the last appended
      // segment and continue" falls out of `continue` here rather than needing a separate undo step.
      if (!verdictForAssembledTitle(cand, verifyCtx).ok) continue
      if (cand.length > best.length) best = cand          // the honest partial, for the refusal note
      const hit = search(cand, depth + 1)
      if (hit) return hit
    }
    return null
  }
  const found = search(produced, 0)
  if (found) {
    return done(found, 'refilled', `re-filled ${produced.length} → ${found.length} from true material`, tried)
  }

  /* THE REFUSAL. Every true segment has been tried and the floor is still out of reach. Shipping
   * the stub is precisely what got the first build reverted, so it does not happen: the live title
   * stays, and the operator is told.
   *
   * THE PRIOR MUST ITSELF BE SHIPPABLE. A refusal returns the prior as this run's recommendation —
   * so an over-cap prior would hand the door a string it is the door's whole job to prevent (>75 is
   * the Amazon 100476 rejection class, and `capTitle75` already ran on the PRODUCED title, never on
   * this one). An over-cap or empty prior is therefore not a preservable value: the hold still
   * fires, and the truthful text is what exits, which is the only honest remaining option. */
  if (prior && prior.length <= TITLE_BAND_HI) {
    /* THE INVARIANT (PO ruling 2026-08-23): "a hold may keep the prior title ONLY IF the prior title
     * is TRUE." Truth is a correctness constraint; the 70-75 band is a quality target — an in-band
     * LIE must never outrank a truthful short title. Judge the prior with the SAME whole-string
     * predicate (`verdictForAssembledTitle`) the search above just verified every candidate against —
     * no second rulebook for "is this true", per this file's own doctrine. */
    const priorVerdict = verdictForAssembledTitle(prior, verifyCtx)
    if (priorVerdict.ok) {
      return done(prior, 'refused-kept-prior',
        `truthful title reached only ${best.length}/${TITLE_BAND_LO} from true material — prior title kept, nothing shipped`,
        tried, true)
    }
    // THE PRIOR FAILS TRUTH — it carries a sibling design's name, a forced gender on a unisex family,
    // a second garment class, or some other whole-string lie `verdictForAssembledTitle` just caught.
    // Keeping it is not a safe fallback, it is shipping a KNOWN lie because it happens to be in band.
    // Ship the truthful short title instead — `best`, the honest partial the search already built —
    // under a DISTINCT decision value so this never silently reads as an ordinary band-unreachable
    // hold. The hold still fires (`done(..., true)`) so the operator sees it.
    return done(best, 'shipped-truthful-under-band',
      `truthful title reached only ${best.length}/${TITLE_BAND_LO} from true material, and the prior title fails truth (${priorVerdict.reason}) — shipping the truthful short title rather than keep a lie`,
      tried, true)
  }
  if (prior) {
    return done(best, 'unreachable-no-prior',
      `truthful title reached only ${best.length}/${TITLE_BAND_LO} from true material and the prior title is ${prior.length} chars — over the ${TITLE_BAND_HI} cap, so it cannot be preserved`,
      tried, true)
  }
  return done(best, 'unreachable-no-prior',
    `truthful title reached only ${best.length}/${TITLE_BAND_LO} from true material and there is no prior title to preserve`,
    tried, true)
}

/**
 * DROP ORPHAN POOL FRAGMENTS — the "Mind" class, enforced TERMINALLY on the bytes that ship.
 *
 * THE LIVE DEFECT: `…Fall Crewneck, Mind` — a title fill appended the pool phrase "mind your
 * business" WORD BY WORD until it ran out of characters, leaving a dangling ", Mind". #630 cured
 * the PRODUCER (`pooledNovelFragment` harvests contiguous runs with provenance, so a phrase that
 * cannot fit WHOLE is skipped whole) and that cure stands. But a producer-side cure cannot reach a
 * title that arrived from somewhere else — a PO-locked prior, a stored title from before the fix,
 * or a council draft — and this repo's own doctrine is that a measurable invariant gets a
 * deterministic net on the SHIPPED bytes, not a promise from whoever wrote them.
 *
 * THE TEST IS PROVENANCE, NOT A WORD LIST. A segment is an orphan when it is a strict PREFIX of a
 * pool phrase and is not a whole pool phrase itself: "Mind" out of "mind your business" is an
 * orphan; "Fall Crewneck" is the whole phrase and is not. That is exactly the harvester's own rule,
 * applied in the opposite direction, so the two cannot disagree.
 *
 * SAFETY RAILS, the same three the truth net uses: segment 0 is never dropped (it carries brand +
 * design + noun), a segment carrying a design word that survives nowhere else is never dropped, and
 * a segment of 3+ words is never dropped (a long segment is a phrase in its own right, whatever it
 * is a prefix of). Pure, idempotent, and it only ever SHORTENS — the band pad downstream re-fills.
 */
export function dropOrphanPoolFragments(title: string, pool: readonly string[], protectHay = ''): string {
  const t = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!t || pool.length === 0) return title
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const words = (s: string): string[] => norm(s).split(' ').filter(Boolean)
  const poolNorm = pool.map(norm).filter(Boolean)
  const protectedWords = new Set(words(protectHay).filter((w) => w.length > 2))

  const isOrphan = (seg: string): boolean => {
    const n = norm(seg)
    if (!n) return false
    const w = words(seg)
    if (w.length === 0 || w.length > 2) return false          // a 3+ word segment stands on its own
    if (poolNorm.includes(n)) return false                     // it IS a whole pool phrase — keep
    return poolNorm.some((p) => p.startsWith(`${n} `))         // a strict prefix of one — orphan
  }

  const parts = t.split(/\s*([|,])\s*/)
  if (parts.length <= 1) return title
  const kept: string[] = [parts[0]]
  let carried: string | null = null
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const sep = parts[i]
    const seg = parts[i + 1]
    if (sep === undefined || seg === undefined || !seg.trim()) continue
    if (isOrphan(seg)) {
      const rest = [parts[0], ...kept.slice(1), ...parts.slice(i + 2)].join(' ')
      const restWords = new Set(words(rest))
      const solelyCarriesDesign = words(seg).some((w) => protectedWords.has(w) && !restWords.has(w))
      if (!solelyCarriesDesign) {
        carried = carried === '|' || sep === '|' ? '|' : (carried ?? sep)
        continue
      }
    }
    const useSep = carried === '|' || sep === '|' ? '|' : sep
    carried = null
    kept.push(useSep === '|' ? ` | ${seg}` : `, ${seg}`)
  }
  return kept.join('').replace(/\s{2,}/g, ' ').replace(/[\s,|]+$/g, '').trim()
}

/**
 * THE ONE TERMINAL NET FOR THE TITLE — truth and band enforced together, on the final bytes.
 *
 * THE HOLE THIS CLOSES, and it is not hypothetical. The ship door runs the truth net EARLY (before
 * the waste, money-tail, colour and inclusive-audience nets) because removing a lie frees characters
 * the pad can then spend. But three of those later stages ADD text, and one of them —
 * `enforceMoneyTail` — installs a POOL KEYWORD into the money position. Its candidates are filtered
 * for off-niche and nothing else, so on a sweatshirt family a keyword like "funny work shirts" could
 * be welded into the title AFTER the only stage that would have judged it. The truth net ran, and
 * then the title changed underneath it.
 *
 * So the contract is enforced TERMINALLY, on the bytes that ship:
 *   1. the truth net once more (idempotent by construction — a second pass finds nothing left to
 *      drop — so this is free on a title no later stage touched, and a cure when one did);
 *   2. the additive producer, re-filling from TRUE material only;
 *   3. `settleTruthBand`, which refuses to ship anything that is not truthful AND in band.
 *
 * Truth and band are ONE contract with ONE exit condition; this is the function that owns it.
 * PURE — the caller logs the decision and raises the hold.
 */
export function enforceTitleTruthBand(args: {
  produced: string
  prior?: string | null
  apparel: boolean
  band: TitleBandCtx
  /** The design's (or family's) blank-grounded truth context. null ⇒ no ground truth to judge
   *  against, and a guessed rule is worse than none — the net half is skipped, the band half is not. */
  truth: PhraseTruthCtx | null
  protect?: string
  reject?: (segment: string) => boolean
  /** Same partition `reject` is built from — lets `applyTitleTruthNet` strike a foreign design name
   *  out of segment 0 word by word (2026-08-22 defect 2 fix; see its doc for why `reject` alone,
   *  a whole-phrase predicate, cannot reach segment 0). */
  foreignTokens?: ReadonlySet<string>
  /** BROADCAST/parent titles only — see `applyTitleTruthNet`'s doc on the same option. */
  scrubProtectedOverlap?: boolean
  /** The pool the ORPHAN-FRAGMENT guard tests provenance against (see `dropOrphanPoolFragments`).
   *  Defaults to the band's own truthful pool segments, which is the same material any fill could
   *  have harvested a fragment from. */
  orphanPool?: readonly string[]
}): TruthBandResult & { netted: string } {
  const truthed = args.truth
    ? applyTitleTruthNet(args.produced, args.truth, args.protect ?? '', {
        rejectSegment: args.reject,
        foreignTokens: args.foreignTokens,
        scrubProtectedOverlap: args.scrubProtectedOverlap,
      })
    : args.produced
  // Orphan guard BEFORE the band, so the characters a dangling fragment was wasting are available
  // to the pad — the same reason the truth net runs before the pad and not after it.
  const netted = dropOrphanPoolFragments(truthed, args.orphanPool ?? args.band.poolSegments ?? [], args.protect ?? '')
  const settled = settleTruthBand({
    produced: netted, prior: args.prior, apparel: args.apparel, band: args.band,
    // THE WHOLE-STRING VERIFY, threaded through so the additive search inside `settleTruthBand`
    // judges every candidate as an assembled title, not by length alone (2026-08-22 rewrite).
    truth: args.truth, protect: args.protect, foreignTokens: args.foreignTokens, reject: args.reject,
    scrubProtectedOverlap: args.scrubProtectedOverlap,
  })
  /* THE CASING FIXES, TERMINALLY. Both are LENGTH-NEUTRAL and IDEMPOTENT, so they can run after the
   * band without moving a title across it — which is exactly why they belong here as well as at the
   * top of the door. The seller's design name "Business B*tch" must ship verbatim, and the door is
   * no longer the last writer: the refill above appends segments AFTER the door's opening casing
   * pass, and a prior title preserved by a refusal never went through that pass at all. A guarantee
   * about shipped bytes has to be made by whatever writes them last. */
  const finalTitle = fixCensorStarCase(fixApostropheCase(settled.title))
  /* THE FINAL GATE — nothing may leave this function unverified, ever, however it got here.
   *
   * `settleTruthBand`'s own search already verifies every candidate it assembles (the primary fix),
   * and this is DEFENSE IN DEPTH for the one case that search cannot see: a hold this function is
   * ABOUT to raise still names the offending string as `settled.title`, which is fine (a hold ships
   * the PRIOR, never `settled.title`) — but a NON-hold exit (`in-band` / `refilled`) must itself pass
   * the identical whole-title predicate before it is trusted, because the casing pass just above runs
   * after the search and — however provably case-only it is today — a future writer added here by
   * mistake is exactly the bug class this rewrite exists to make structurally impossible. Four live
   * defects shipped through nets that were each correct in isolation; this is the one place that
   * refuses to ship ANYTHING it has not itself just re-judged as a whole.
   */
  if (!settled.hold) {
    const verdict = verdictForAssembledTitle(finalTitle, {
      truth: args.truth, protect: args.protect, foreignTokens: args.foreignTokens, reject: args.reject,
      scrubProtectedOverlap: args.scrubProtectedOverlap,
    })
    if (!verdict.ok) {
      const priorTrim = (args.prior || '').trim()
      const keep = priorTrim && priorTrim.length <= TITLE_BAND_HI ? priorTrim : netted
      return {
        title: keep, decision: 'refused-kept-prior', len: keep.length, tried: settled.tried,
        reason: `final whole-title verification failed (${verdict.reason}) on "${finalTitle}" — kept ${priorTrim ? 'the prior title' : 'the truthful net result'} rather than ship`,
        hold: true, netted,
      }
    }
  }
  return { ...settled, netted, title: finalTitle }
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
/*
 * AUDIENCE SPANS — replaces the closed gender-PAIR regex (2026-08-11, adversarial pass).
 *
 * WHY THE PAIR REGEX WAS THE WRONG SHAPE. It required two gender nouns from a closed lexicon,
 * ADJACENT, joined by and/&/+/comma/space. Every confirmed attack beat it with one substitution:
 *   "for Men or Women"      — the conjunction "or" was not in the join set
 *   "for Guys and Girls"    — "guys"/"girls" were not in the lexicon
 *   "for Him and Her"       — pronouns were not in the lexicon
 *   "for Adults and Kids"   — a non-gender demographic axis
 *   "…for Men Tee Shirt | Fan Shirt for Women" — the two halves 24 characters apart
 * And because PR #557 consolidated the producer, the judge and the door onto this ONE predicate,
 * a single miss blinded all three layers at once. Consolidation removed the drift and removed the
 * redundancy with it; the answer is not to re-fork the predicate but to make it measure SPANS
 * instead of matching a pair.
 *
 * ADMISSIBILITY COMES FROM THE CORPUS, not a hand-typed allowlist. Across the nine golds the ONLY
 * attested audience vocabulary is the single-gender closure {men, mens, men's, women, womens,
 * women's, ladies}, and the only attested DUAL form is gold #7's juxtaposed, title-terminal
 * "for Men Women". Everything else is unattested and strips.
 *
 * PRONOUNS AND SOFT NOUNS ("him", "her", "girls", "boys", "family", "both") count ONLY inside a
 * `for …` run. That is what protects gold #4, "I Will Praise Him in Every Season Tee | Christian
 * Shirts for Women" — a devotional "Him" mid-title is not an audience claim.
 */
const AUD_ATTESTED = new Set(['men', 'mens', "men's", "men’s", 'women', 'womens', "women's", "women’s", 'ladies'])
const AUD_HARD = new Set([...AUD_ATTESTED, 'guys', 'gals', 'dudes', 'unisex', 'kids', 'youth', 'teens', 'adults'])
const AUD_SOFT = new Set(['him', 'her', 'them', 'girls', 'boys', 'family', 'both', 'everyone', 'everybody', 'genders', 'ages', 'adult', 'teen', 'kid'])
const AUD_JOIN = new Set(['and', '&', '+', 'or', ',', 'the', 'whole', 'all', 'any', 'every'])
const audValue = (w: string): 'M' | 'F' | 'X' =>
  /^(men|mens|men['’]s|guys|dudes|boys|him|his)$/.test(w) ? 'M'
    : /^(women|womens|women['’]s|ladies|gals|girls|her)$/.test(w) ? 'F' : 'X'

export interface AudienceSpan {
  start: number; end: number; text: string
  values: string[]        // 'M' | 'F' | 'X'
  attested: boolean       // every token inside the seller's single-gender closure
  led: boolean            // introduced by "for"
  terminal: boolean       // ends the title
}

/** Every audience claim in the title, with the facts needed to judge admissibility. PURE. */
export function audienceSpans(text: string): AudienceSpan[] {
  const t = (text || '')
  const out: AudienceSpan[] = []
  const re = /[A-Za-z''’&+,]+/g
  const toks: { w: string; lo: string; i: number; j: number }[] = []
  for (const m of t.matchAll(re)) toks.push({ w: m[0], lo: m[0].toLowerCase(), i: m.index ?? 0, j: (m.index ?? 0) + m[0].length })
  for (let k = 0; k < toks.length; k++) {
    const led = toks[k].lo === 'for'
    let p = led ? k + 1 : k
    // only a `for …` run may admit the soft lexicon; bare hard tokens still count anywhere
    if (!led && !AUD_HARD.has(toks[p]?.lo ?? '')) continue
    if (led && !(AUD_HARD.has(toks[p]?.lo ?? '') || AUD_SOFT.has(toks[p]?.lo ?? '') || AUD_JOIN.has(toks[p]?.lo ?? ''))) continue
    // Skip determiners/quantifiers that lead a `for …` run ("for THE WHOLE family", "for ALL men").
    // Without this the run terminates before collecting a word and "for the Whole Family" survives —
    // found by the adversarial pass, and exactly the kind of seam a pair-regex could never express.
    if (led) while (p < toks.length && AUD_JOIN.has(toks[p].lo) && !AUD_HARD.has(toks[p].lo)) p++
    const words: string[] = []
    let q = p
    while (q < toks.length) {
      const lo = toks[q].lo
      const isAud = AUD_HARD.has(lo) || (led && AUD_SOFT.has(lo))
      const isJoin = AUD_JOIN.has(lo) && words.length > 0 && q + 1 < toks.length
        && (AUD_HARD.has(toks[q + 1].lo) || (led && AUD_SOFT.has(toks[q + 1].lo)) || AUD_JOIN.has(toks[q + 1].lo))
      if (!isAud && !isJoin) break
      if (isAud) words.push(lo)
      q++
    }
    if (words.length === 0) { continue }
    const start = led ? toks[k].i : toks[p].i
    const end = toks[q - 1].j
    out.push({
      start, end, text: t.slice(start, end),
      values: [...new Set(words.map(audValue))],
      attested: words.every((w) => AUD_ATTESTED.has(w)),
      led,
      terminal: t.slice(end).trim().replace(/^[.,;|\s]+/, '') === '',
    })
    k = q - 1
  }
  return out
}

/** Which spans must go. The seller's rule, expressed as corpus facts rather than a phrase list. */
function inadmissibleSpans(text: string): AudienceSpan[] {
  const spans = audienceSpans(text)
  if (spans.length === 0) return []
  const bad: AudienceSpan[] = []
  for (const s of spans) {
    // (a) unattested vocabulary — guys / kids / him / everyone / family never appear in the golds
    if (!s.attested) { bad.push(s); continue }
    // (b) a DUAL-gender span is admissible only in gold #7's exact attested form: juxtaposed
    //     (no conjunction) AND title-terminal. Any conjoined dual — "and", "&", "+", "or" — is the
    //     construct the seller banned outright.
    if (s.values.includes('M') && s.values.includes('F')) {
      const conjoined = /\b(and|or)\b|[&+,]/i.test(s.text)
      if (conjoined || !s.terminal) bad.push(s)
    }
  }
  // (c) two spans naming DIFFERENT genders = the title addresses both in pieces. Keep the terminal
  //     one, delete the rest. This is the headline attack ("…for Men Tee | Fan Shirt for Women"),
  //     and gold #9's two same-value {M} spans are untouched by construction.
  const kept = spans.filter((s) => !bad.includes(s))
  const vals = new Set(kept.flatMap((s) => s.values.filter((v) => v !== 'X')))
  if (vals.size > 1) {
    const terminal = kept.filter((s) => s.terminal).pop()
    for (const s of kept) if (s !== terminal) bad.push(s)
  }
  return bad
}

/** EXPORTED: one predicate for the council net, the judge dock and the door net. */
export function hasInclusiveAudience(text: string): boolean {
  return inadmissibleSpans(text).length > 0
}
/** Remove every INADMISSIBLE audience span, plus ONE trailing generic-wearer noun the phrase drags
 *  along ("… for Men & Women Fans"). Closed class: an open \w+ would eat a real word mid-title. */
export function stripInclusiveAudience(text: string): string {
  const t = text || ''
  const bad = inadmissibleSpans(t)
  if (bad.length === 0) return t
  let out = ''
  let cursor = 0
  for (const s of [...bad].sort((a, b2) => a.start - b2.start)) {
    out += t.slice(cursor, s.start)
    cursor = s.end
    const trail = t.slice(cursor).match(/^\s+(?:fans?|lovers?|shoppers?|buyers?|enthusiasts?)\b/i)
    if (trail) cursor += trail[0].length
    out += ' '
  }
  out += t.slice(cursor)
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;.])/g, '$1')          // tighten punctuation, but NOT the pipe: ' | ' is the
    .replace(/\s*\|\s*/g, ' | ')           // separator's canonical spaced form and must survive
    .replace(/\s*\|\s*$/, '')              // a separator left with nothing after it is not a separator
    .replace(/[,;]\s*$/, '')
    .trim()
}

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
  const verdict = removalPermitted(padded.length)
  if (!verdict.ok) {
    return {
      title: t0,
      decision: 'band-guard',
      note: `removal would land ${padded.length} chars — ${verdict.why}, even after the facts pad — refused, byte-identical`,
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
  const verdict = removalPermitted(padded.length)
  if (!verdict.ok) {
    return {
      title: t0,
      decision: 'band-guard',
      note: `removing ${removed.join(', ')} would land ${padded.length} chars — ${verdict.why}, even after the facts pad — refused, byte-identical`,
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
/**
 * DROP a money position that is not worth ranking for.
 *
 * THE HOLE THIS CLOSES (2026-08-11, third live rejection). Every guard so far constrained what the
 * PAD may write into the money slot. None of them touched a weak tail the COUNCIL wrote itself —
 * so "| Short Sleeve" and "| Shirt" walked straight through the door on titles the pad never
 * touched. `classifyTail` already knows the answer: the seller has shipped ZERO spec-only tails and
 * ZERO bare-garment-noun tails across nine golds.
 *
 * The rule: if the money position holds nothing a shopper would type, it is not a money position —
 * drop it and the separator with it. An honest shorter title is the seller's own stated preference
 * ("crew neck can go on highlights"). This runs AFTER `enforceMoneyTail` has had its chance, so a
 * real keyword always wins the slot first; this only fires when nothing better was available.
 *
 * PURE, IDEMPOTENT (a dropped result has no separator, so it re-enters as 'no-tail'), FAIL-OPEN.
 */
export type SpecTailDecision = 'no-tail' | 'kept' | 'dropped' | 'non-apparel'
export function dropSpecOnlyTail(
  title: string,
  opts: { apparel: boolean; specValues?: readonly string[] },
): { title: string; decision: SpecTailDecision; note: string } {
  const t0 = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (!opts.apparel) return { title: t0, decision: 'non-apparel', note: '' }
  const i = t0.indexOf(' | ')
  if (i < 0) return { title: t0, decision: 'no-tail', note: '' }
  const tail = t0.slice(i + 3).trim()
  const cls = classifyTail(tail, opts.specValues ?? [])
  if (cls !== 'specOnly') return { title: t0, decision: 'kept', note: `money position is ${cls}` }
  const dropped = t0.slice(0, i).trim().replace(/[,;|]+$/, '').trim()
  return {
    title: dropped,
    decision: 'dropped',
    note: `"| ${tail}" is not a search phrase — 0 of the seller's gold tails are spec-only; dropped (${t0.length} → ${dropped.length} chars)`,
  }
}

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

  // ARM 2 — the removal happens, and the facts pad re-fills what it honestly can.
  //
  // UNCONDITIONAL AS OF 2026-08-11, and this reverses the original guard deliberately. The seller's
  // ruling was first written as a TRADE ("strip only when the removal frees space for a keyword, or
  // the title still lands in the band"), so the strip had to win an arithmetic argument to apply.
  // It lost that argument three times in a row, and each time the seller rejected the result:
  //   "Unisex Classic Fit Fan Shirt | Short Sleeve"      → "STILL BAD"
  //   "…Tee for Men and Women Fans | Short Sleeve"       → "Still Bad after regen"
  //   "…Unisex Tee for Men & Women Fans | Shirt"         → "EVEN WORSE"
  // Their corpus is the tiebreaker: "unisex" and "classic fit" appear in ZERO of their nine golds.
  // An editorial ruling with zero corpus counter-examples is not a preference to be balanced against
  // length — it is a fact about their voice. A short clean title is the correct output; the length
  // cure belongs upstream (a real money keyword), never in keeping a word they banned.
  const padded = enforceTitleBand(reduced, ctx.band).title
  const final = padded.length <= TITLE_BAND_HI ? padded : reduced   // Amazon's cap is still absolute
  return {
    title: final,
    decision: 'stripped',
    note: `${what}; ${t0.length} → ${final.length} chars${final.length < TITLE_BAND_LO ? ' (under the preferred floor — an honest short title beats a banned word)' : ''}`,
  }
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * settleTitle — THE ONE DOOR (handoff/TITLE_SETTLE_REWRITE.md, PO approval 2026-08-22).
 *
 * Everything above this point in this file is a LEAF: individually correct, individually testable —
 * and, before this rewrite, individually WIRED, nine separate times, into `listingPipeline.ts`'s
 * `bandTitle` closure. That was the structural cause of four consecutive live failures on B0DSCDZC6K
 * (#630 → #632 → #634 → #637): every patch fixed the ONE stage it targeted, and a stage that ran
 * AFTER it was free to write back the very lie the fixed stage had just removed. The band refill was
 * always the last writer, and it appended from the raw pool after the truth verification had already
 * run — filtering and filling were treated as two decisions instead of one.
 *
 * `settleTitle` is the fix: ONE function, called from the ONE door every title producer already
 * passes through (`scrubPublished` in listingPipeline.ts), that owns the full pipeline end to end and
 * ends on `enforceTitleTruthBand`'s terminal whole-string verify (`verdictForAssembledTitle`, defined
 * above). Every append candidate — pool phrase, spec fact, garment word, money-tail keyword — is
 * pre-filtered by `phraseTruthVerdict` AND re-judged as part of the WHOLE assembled string before it
 * may win a slot (`settleTruthBand`'s search, `enforceMoneyTail`, both updated by this rewrite).
 * Nothing runs after this function returns; nothing may write to the string it hands back.
 *
 * `listingPipeline.ts`'s own `bandTitle` is now a THIN ADAPTER: it resolves the pipeline-local values
 * this function needs (the blank spec, the money keywords, the per-exit design scope) into
 * `SettleTitleCtx` and returns exactly what this function returns, plus its own hold/v4-diff
 * bookkeeping. That is what makes the door testable OFFLINE: `truthBandHarness.ts` calls THIS
 * function, not a leaf three stages upstream of what the route actually ships.
 */
let SETTLE_SEQ = 0

export interface SettleTitleCtx {
  /** Mirrors the door's own guard: a bullets/keywords-only regen passes the PRIOR title through
   *  unproduced, and a net that edits a field the run did not produce is a silent unrequested
   *  rewrite. `false` short-circuits every stage below and returns the input byte-identical. */
  produced: boolean
  /** Non-apparel titles are legitimately short; every stage below is apparel-gated. */
  apparel: boolean
  /** Recompute the band context for the CURRENT draft title. Cannot be a static object: `garmentSecond`
   *  (`pickDistinctGarmentForm`) depends on what the title already says, so this is called fresh
   *  before every stage that pads or judges against product facts — the SAME discipline the original
   *  door's `titleBandCtx(title, scope)` closure already followed. */
  bandCtxFor: (title: string) => TitleBandCtx
  /** TITLE_MONEY_TAIL candidate keywords, opportunity-ordered. Empty/null on a per-child exit
   *  (group-scoped derivation is a later phase in listingPipeline.ts). */
  moneyKws: readonly string[] | null
  /** 'off' | 'shadow' | 'on' (TITLE_MONEY_TAIL). Shadow logs the would-be title and ships unchanged. */
  moneyTailMode: string
  /** The money-tail context — built once by the caller so the waste-vocabulary probe and the money-
   *  tail loop itself agree on exactly what they are about to try. */
  moneyCtx: MoneyTailCtx
  /** Feeds `scrubUnspecdGarmentClaims` — a market phrase must not re-leak a weight/fit claim the
   *  blank does not back. */
  spec: { fit?: string | null; weightNote?: string | null } | null | undefined
  /** Amazon's 75-char hard cap + adjacent-phrase dedupe. Lives in listingPipeline.ts (it needs nothing
   *  from this module) and is passed in so this file stays a zero-import leaf. */
  capTitle75: (title: string) => string
  /** Design vocabulary the color-strip net must never remove (DEFECT B) — this exit's design name(s),
   *  so "Black Cat" survives even though "Black" is a variant color word. */
  colorProtect: string | null
  /** Seller-declared audience lean, for the inclusive-audience net. */
  lean?: MoneyTailCtx['lean']
  /** TITLE_V4=on: the facts pad is deleted by policy ("never ship short — always ask me") — UNLESS
   *  `prior` fails `verdictForAssembledTitle`, in which case the pad runs anyway (PO ruling
   *  2026-08-23; see step 9 inside `settleTitle`). The refusal this flag asks for is only sound when
   *  the fallback it refuses INTO is itself true. */
  v4NoPad: boolean
  /** 'off' | 'shadow' | 'on' (TITLE_V4) — drives the shadow-measurement log/diff only; the pad itself
   *  is gated by `v4NoPad` above. */
  v4Mode: string
  /** The blank's own fact tokens, for the money-position gate (`dropSpecOnlyTail`). */
  specFactTokens: readonly string[]
  /** THIS exit's blank-grounded truth ctx — null when the family's blank is unresolved (no ground
   *  truth to judge against). The SAME object the money-tail ctx and the band ctx must agree on. */
  truth: PhraseTruthCtx | null
  /** Design phrase(s) in scope for THIS title, space-joined — the broadcast title protects every
   *  design in the family; a per-child title protects only its own. */
  protect: string
  /** Per-child sibling-name rejector (whole-segment) and its token set (word-level) — undefined on
   *  the broadcast/parent title, which is answerable to every design in the family. */
  reject?: (seg: string) => boolean
  foreignTokens?: ReadonlySet<string>
  /** BROADCAST ONLY — see `applyTitleTruthNet`'s doc on `scrubProtectedOverlap`. */
  scrubProtectedOverlap: boolean
  /** What is LIVE on Amazon today — what a truth+band refusal preserves. */
  prior: string | null
  /** Observability only: which exit this is ('broadcast' or a design key/SKU) and the parent ASIN,
   *  threaded onto every log line and hold entry so a live grep can tell titles apart. */
  holdScope: string
  parentAsin: string | null
}

export interface SettleTitleHold {
  scope: string
  parent: string | null
  len: number
  tried: string[]
  reason: string
  kept: string
}

export interface SettleTitleV4Diff {
  mode: string
  shipped: string
  shippedLen: number
  withoutPad: string
  withoutPadLen: number
  padManufactured: boolean
  wouldRefuse: boolean
  floor: number
}

export interface SettleTitleResult {
  /** THE VERIFIED STRING. Nothing may write to this after `settleTitle` returns it — pinned by
   *  `truthBandGate.test.ts`'s assertion that the caller's returned title is byte-identical to it. */
  title: string
  decision: TruthBandDecision
  hold: boolean
  reason: string
  tried: string[]
  /** Present only when `hold` is true — what the caller pushes onto its operator-visible hold list
   *  (`debug.titleHolds` in listingPipeline.ts). */
  holdEntry?: SettleTitleHold
  /** Present only when TITLE_V4 is shadow/on — what the caller pushes onto `debug.v4`. */
  v4Diff?: SettleTitleV4Diff
}

/**
 * THE ONE ENTRY. `raw` is the producer's title exactly as scrubbed for trademarks/celebrity names,
 * competitor-blank brand words and the initial truth pass (the door's own pre-pass in
 * listingPipeline.ts — `scrubPub` → `titleTruthDoor` — unchanged by this rewrite: those are cross-
 * field concerns, not the truth+band contract this function owns). Everything from here to the
 * returned string is this function's job, and nothing else may touch the title after it returns.
 */
export function settleTitle(raw: string, ctx: SettleTitleCtx): SettleTitleResult {
  if (!ctx.produced || !raw) {
    return { title: raw, decision: 'not-produced', hold: false, reason: 'no title produced this run', tried: [] }
  }
  const traceId = `${ctx.parentAsin ?? 'na'}#${++SETTLE_SEQ}`
  let title = raw

  // 1-2. CASING FIRST — both length-neutral and idempotent, so every stage below reads clean bytes.
  const cased = fixApostropheCase(title)
  if (cased !== title) console.log(JSON.stringify({ tag: 'SHIP_APOSTROPHE_CASE', field: 'title', from: title, to: cased }))
  title = cased
  const starred = fixCensorStarCase(title)
  if (starred !== title) console.log(JSON.stringify({ tag: 'SHIP_CENSOR_STAR_CASE', field: 'title', from: title, to: starred }))
  title = starred

  // 3. SPEC TRUTH — remove fabric-weight/fit claims the blank does not back, before the band pass.
  const truthClaims = scrubUnspecdGarmentClaims(title, ctx.spec)
  if (truthClaims.removed.length > 0) {
    console.log(JSON.stringify({ tag: 'SHIP_SPEC_TRUTH', field: 'title', removed: truthClaims.removed, from: title.length, to: truthClaims.title.length }))
  }
  title = truthClaims.title

  // 4. CAP + DEDUPE — cap first (this door runs after trademark substitutions, which LENGTHEN);
  //    dedupe adjacent AND non-adjacent repeats before the band pass so freed chars are available to it.
  const deduped = collapseRepeatedWords(ctx.capTitle75(title))
  if (deduped.removed.length > 0) {
    console.log(JSON.stringify({ tag: 'SHIP_WORD_DEDUPE', field: 'title', removed: deduped.removed, from: title.length, to: deduped.title.length }))
  }
  if (deduped.refusedForTrademark) {
    console.log(JSON.stringify({ tag: 'SHIP_WORD_DEDUPE', field: 'title', decision: 'refused-trademark-resurrection', title }))
  }
  const capped = deduped.title

  // 5. WASTE VOCABULARY — "Unisex"/"Classic Fit" are not title words (PO ruling). Before the money
  //    tail: this frees characters on the LEFT, useful to the keyword only if free before it is
  //    measured against the band.
  const waste = stripTitleWasteVocabulary(capped, {
    apparel: ctx.apparel,
    band: ctx.bandCtxFor(capped),
    moneyKws: ctx.moneyTailMode === 'on' ? (ctx.moneyKws ?? null) : null,
    money: ctx.moneyCtx,
  })
  console.log(JSON.stringify({ tag: 'SHIP_TITLE_WASTE', decision: waste.decision, from: capped.length, to: waste.title.length, changed: waste.title !== capped, note: waste.note }))
  let moneyed = waste.title

  // 6. MONEY TAIL — the PO gold pipe-right. Wire order spec-truth → cap → dedupe → waste →
  //    enforceMoneyTail → facts pad: when the gold tail lands the title is already in band and the
  //    pad below never fires. Every candidate is truth+whole-string verified INSIDE `enforceMoneyTail`
  //    itself (2026-08-22 rewrite) before it may win the slot.
  const mtRun = tryMoneyTail(moneyed, ctx.moneyKws, ctx.moneyCtx)
  for (const a of mtRun.attempts) {
    console.log(JSON.stringify({ tag: 'SHIP_MONEY_TAIL', mode: ctx.moneyTailMode, decision: a.decision, kw: a.kw, from: moneyed.length, to: a.title.length, note: a.note }))
  }
  if (mtRun.applied) {
    if (ctx.moneyTailMode === 'on') moneyed = mtRun.title
    else console.log(JSON.stringify({ tag: 'MONEY_TAIL_DIFF', kw: mtRun.attempts[mtRun.attempts.length - 1]?.kw ?? '', current: moneyed, would: mtRun.title }))
  }

  // 7. COLOR STRIP — §5: shared copy carries no color word; colors rank per-child via the backend tail.
  const colorNet = stripVariantColorWords(moneyed, { apparel: ctx.apparel, protect: ctx.colorProtect, band: ctx.bandCtxFor(moneyed) })
  console.log(JSON.stringify({ tag: 'SHIP_COLOR_STRIP', decision: colorNet.decision, from: moneyed.length, to: colorNet.title.length, changed: colorNet.title !== moneyed, note: colorNet.note }))
  moneyed = colorNet.title

  // 8. INCLUSIVE AUDIENCE — "for Men and Women" is character waste (§4). After the money tail: it
  //    already had first refusal on the same tail region.
  const inc = enforceInclusiveAudience(moneyed, { apparel: ctx.apparel, lean: ctx.lean, band: ctx.bandCtxFor(moneyed) })
  console.log(JSON.stringify({ tag: 'SHIP_INCLUSIVE_AUDIENCE', decision: inc.decision, from: moneyed.length, to: inc.title.length, changed: inc.title !== moneyed, note: inc.note }))
  moneyed = inc.title

  // 9. FACTS PAD — suppressed at TITLE_V4=on ("never ship short — always ask me"), UNLESS the prior
  //    this run would otherwise fall back to is itself a LIE (PO ruling 2026-08-23: "a hold may keep
  //    the prior title ONLY IF the prior title is TRUE"). V4's premise — "short is a refusal, not a
  //    hole to fill" — only holds when the thing a refusal falls back to is clean; when the fallback
  //    is a sibling design's name or a forced gender on a unisex family, refusing to pad does not
  //    avoid manufacturing text, it just manufactures a WORSE outcome (a shipped lie) by omission.
  //    Judged with the SAME predicate every candidate this door assembles is judged by — no second
  //    "is this true" rulebook.
  const priorForV4 = (ctx.prior || '').trim()
  const priorFailsTruthForV4 = !!priorForV4 && !verdictForAssembledTitle(priorForV4, {
    truth: ctx.truth, protect: ctx.protect, foreignTokens: ctx.foreignTokens, reject: ctx.reject,
    scrubProtectedOverlap: ctx.scrubProtectedOverlap,
  }).ok
  const padSuppressed = ctx.v4NoPad && !priorFailsTruthForV4
  if (ctx.v4NoPad && priorFailsTruthForV4) {
    console.warn(JSON.stringify({
      tag: 'TITLE_V4_PAD_OVERRIDE', field: 'title', parent: ctx.parentAsin, scope: ctx.holdScope,
      prior: priorForV4, reason: 'TITLE_V4=on but the prior fails truth — facts pad allowed so a truthful title can reach the band instead of falling back to the lie',
    }))
  }
  const v = padSuppressed
    ? { title: moneyed, decision: 'v4-no-pad' as const, notes: ['TITLE_V4=on — the facts pad is deleted; short is a refusal, not a hole to fill'] as string[] }
    : enforceTitleBand(moneyed, ctx.bandCtxFor(moneyed))
  console.log(JSON.stringify({
    tag: 'SHIP_BAND_DECISION', field: 'title', mode: 'on', decision: v.decision,
    from: raw.length, to: v.title.length, changed: v.title !== moneyed, capped: capped.length !== raw.length, note: v.notes[0] ?? '',
  }))
  const banded = v.title === moneyed ? moneyed : v.title
  if (v.title !== moneyed) console.log(JSON.stringify({ tag: 'SHIP_BAND_NET', field: 'title', from: raw.length, to: v.title.length, note: v.notes[0] ?? '' }))

  // 10. MONEY-POSITION GATE — a pipe-right holding nothing a shopper would type is not a money
  //     position; drop it and the separator with it. Runs AFTER the money tail, so a real keyword
  //     always wins the slot first.
  const drop = dropSpecOnlyTail(banded, { apparel: ctx.apparel, specValues: ctx.specFactTokens })
  console.log(JSON.stringify({ tag: 'SHIP_MONEY_POSITION', decision: drop.decision, from: banded.length, to: drop.title.length, note: drop.note }))

  // V4 SHADOW MEASUREMENT — the number the seller asked for before anything changes. `moneyed` is the
  // title as it stood BEFORE the facts pad; `drop.title` is what would ship today.
  let v4Diff: SettleTitleV4Diff | undefined
  if (ctx.v4Mode !== 'off') {
    const CORPUS_FLOOR = 68 // the seller's shortest gold after their 2026-08-12 revision
    v4Diff = {
      mode: ctx.v4Mode, shipped: drop.title, shippedLen: drop.title.length,
      withoutPad: moneyed, withoutPadLen: moneyed.length,
      padManufactured: drop.title !== moneyed,
      wouldRefuse: moneyed.length < CORPUS_FLOOR, floor: CORPUS_FLOOR,
    }
    console.log(JSON.stringify({ tag: 'TITLE_V4_DIFF', ...v4Diff }))
  }

  // 11. THE NAMED REFUSAL PRE-CHECK — logs which fact bank ran dry, ahead of the terminal net's own
  //     (possibly different) reason, so "the pad is mis-wired" and "the pad had nothing to say" stay
  //     distinguishable from one line.
  if (ctx.apparel && drop.title.length < TITLE_BAND_LO) {
    console.warn(JSON.stringify({
      tag: 'TITLE_UNDER_BAND', parent: ctx.parentAsin, len: drop.title.length,
      reason: v.decision === 'padded' || v.decision === 'in-band' ? 'post-pad-short' : v.decision,
      band: TITLE_BAND_LO, facts: candidateFactCount(moneyed, ctx.bandCtxFor(moneyed)), note: v.notes[0] ?? '',
    }))
  }

  // 12. TRUTH AND BAND SETTLE TOGETHER — the ONE net. JUDGE (truth), SEARCH (bounded DFS, verified
  //     candidate by candidate), VERIFY (the whole assembled string, again, terminally). Everything
  //     above this line may only shorten or propose; this is the single place that decides whether a
  //     shortened or lengthened title is allowed to leave the door at all.
  const settled = enforceTitleTruthBand({
    produced: drop.title, prior: ctx.prior, apparel: ctx.apparel, band: ctx.bandCtxFor(drop.title),
    truth: ctx.truth, protect: ctx.protect, reject: ctx.reject, foreignTokens: ctx.foreignTokens,
    scrubProtectedOverlap: ctx.scrubProtectedOverlap,
  })
  console.log(JSON.stringify({
    tag: 'TITLE_TRUTH_BAND', scope: ctx.holdScope, parent: ctx.parentAsin, decision: settled.decision,
    from: drop.title.length, netted: settled.netted.length, to: settled.len,
    changed: settled.title !== drop.title, reason: settled.reason,
  }))
  if (settled.netted !== drop.title) {
    console.warn(JSON.stringify({ tag: 'TITLE_TERMINAL_TRUTH_CATCH', scope: ctx.holdScope, parent: ctx.parentAsin, from: drop.title, to: settled.netted }))
  }
  let holdEntry: SettleTitleHold | undefined
  if (settled.hold) {
    console.warn(JSON.stringify({
      tag: 'TITLE_BAND_UNREACHABLE', parent: ctx.parentAsin, scope: ctx.holdScope, len: settled.len,
      band: TITLE_BAND_LO, tried: settled.tried, reason: settled.reason, decision: settled.decision,
      produced: drop.title, kept: settled.title,
    }))
    holdEntry = { scope: ctx.holdScope, parent: ctx.parentAsin, len: settled.len, tried: settled.tried, reason: settled.reason, kept: settled.title }
  }
  console.log(JSON.stringify({ tag: 'TITLE_DOOR_TRACE', id: traceId, in: raw, out: settled.title }))

  return { title: settled.title, decision: settled.decision, hold: settled.hold, reason: settled.reason, tried: settled.tried, holdEntry, v4Diff }
}
