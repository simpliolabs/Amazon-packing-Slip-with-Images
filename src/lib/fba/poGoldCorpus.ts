/**
 * poGoldCorpus.ts — the seller's OWN titles as the council's few-shot corpus.
 *
 * PO 2026-08-10: "I gave you about 70 title recommendations in the last 2 months (all fixes were
 * pushed to repos) that should be a strong signal for the council/judge how to put these together."
 *
 * THE GAP THIS CLOSES. `PO_GOLD_TITLES` (listingPipeline.ts) is EIGHT hand-copied strings, and the
 * comment above it has promised since July that a "future auto-miner over listing_change_log title
 * edits" was the intended design. It was never built. So every title-quality problem has been chased
 * with another deterministic net, while dozens of worked examples of the answer sat in the database
 * and in commit history — including golds the seller had already ruled on.
 *
 * WHAT COUNTS AS A GOLD, and why this source is trustworthy. When the seller writes a title by hand
 * the pipeline stamps `listing_seo_recommendations.title_source = 'manual'` and stores their text in
 * `recommended_title` (migration 044). A manual row is therefore a gold BY DEFINITION: the seller's
 * own words, on their own product, deliberately locked against the AI. No heuristic, no scoring, no
 * guess about intent — the lock IS the endorsement.
 *
 * SELF-GROWING, which is the point. Because the corpus is READ at generation time rather than
 * hardcoded, every future correction the seller makes becomes training data automatically, with no
 * commit and no deploy. That is the standing "self-heal + self-learn IN the system" directive applied
 * to title quality instead of to error handling.
 *
 * FAIL-OPEN: any DB problem, or an empty table, returns the curated seed list. The council must never
 * lose its few-shots because a query failed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * SEED GOLDS — the floor, used when the DB read fails or returns nothing.
 *
 * THE SELLER'S OWN CANONICAL LIST, handed verbatim on 2026-08-11 ("Gold:" — five titles). This
 * supersedes the previous 3-item seed that was inferred from commit-history citation counts. Two
 * rulings are embedded in the list itself and must not be "corrected" away:
 *
 *   1. The alligator gold RESTRUCTURES the old x20-cited version. Old:
 *        "THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt"
 *      New: "Long Sleeve" moved INTO the left as a garment attribute, and the second segment became
 *      design + garment brand + noun. So the money position holds SEARCH language (design phrase /
 *      brand / audience); a bare spec phrase no longer LEADS it — while the garment BRAND in the
 *      tail stays fully legitimate (see the fifth gold).
 *   2. The comma is a first-class separator (first gold, ", " at a full 75 chars) — alongside the
 *      pipe (3 of 5) and plain join (the Espana gold). No shape rule may require the pipe.
 *
 * Everything else comes from the live table; this list stays the seller's floor, not a rulebook.
 */
export const SEED_GOLD_TITLES: readonly string[] = [
  'THE CEO Later Alligator Long Sleeve Shirt, Later Gator Comfort Colors Shirt',    // 75 — comma join
  'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup',    // 75 — plain join
  'THE CEO Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men',       // 72 — 4w left
  'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women',     // 74 — 10w left
  'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women',      // 73 — 6w left
  'THE CEO Cupid Valentine Tee Shirt | Comfort Colors Graphic Tshirt for Women',    // 75 — 6w left
  'THE CEO I Could Be Meaner Tee Shirt | Funny Comfort Colors Shirt for Men Women', // 78 — OVER Amazon's 75; kept verbatim (see note)
  "THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women, Rodeo Shirt",     // 74 — DOUBLE comma, three segments
  'THE CEO The Rod Father T-Shirt Funny Fishing Mens Graphic Tee for Men',          // 69 — UNDER our 70 floor (see note)
] as const

/*
 * WHAT THE NINE THEMSELVES OVERRULE (measured 2026-08-11, not asserted):
 *   - The corpus spans 69–78 chars. 69 breaks OUR 70 floor; 78 breaks AMAZON'S 75 cap. So the
 *     hand-written 70-75 "hard goal" is the seller's PREFERENCE ZONE, not their law — the floor has
 *     no authority over a gold, and the one over-cap gold is kept verbatim as taste even though
 *     Amazon may rewrite it on ship (capTitle75 still governs what we PUSH; the corpus governs what
 *     we LEARN).
 *   - "Funny" appears in TWO golds ("| Funny Comfort Colors Shirt…", "Funny Fishing Mens…") while
 *     TITLE_V2_BANNED_MODIFIERS still docks it outside a hardcoded attribute-pair list. A ban list
 *     that docks the seller's own golds is fighting their taste — brief-rebuild input, not a rule to
 *     re-teach.
 *   - Separators: 5 pipe / 2 comma (one THREE-segment) / 2 plain. Nothing may require the pipe.
 */

/** How many golds the brief carries. Enough to teach the shape; small enough to leave prompt budget
 *  for the design's own context. Newest first — the seller's taste is allowed to move. */
export const GOLD_BRIEF_LIMIT = 12

export interface GoldShape {
  /** Median title length across the corpus — what the seller actually ships. */
  medianLen: number
  /** Median words LEFT of the pipe (brand + design + garment noun). */
  medianLeftWords: number
  /** Largest left-segment word count observed — the ceiling, not an invented cap. */
  maxLeftWords: number
  /** Share of golds that use a ` | ` pipe at all. */
  pipedShare: number
  count: number
  /** How many titles the LEFT-segment stats were measured over. Published because the piped subset
   *  is small (live corpus n=23 at pipedShare 0.30 ⇒ ~7 titles), and a ceiling quoted to the council
   *  as the seller's own number should carry its sample size rather than imply a firm law. */
  leftWordsFrom: number
  /** Shortest / longest gold. Published because BOTH ends break a hand-typed rule at HEAD: the
   *  corpus spans 69–78 — one gold under OUR 70 floor, one over AMAZON'S 75 cap. Any length
   *  pressure must be derived from these, never from the literal "70-75". */
  lenMin: number
  lenMax: number
  /** Separator counts over the WHOLE corpus, printed as "N of count" so the number always carries
   *  its denominator. This is the line that stops the pipe from ever being mandatory. */
  sepMix: { pipe: number; comma: number; plain: number }
  /** Every pipe-right VERBATIM — the strongest few-shot signal available, at zero prompt cost
   *  beyond the golds already printed. */
  tails: string[]
  /** classifyTail() over `tails`. `specOnly: 0` at HEAD is the measured fact that rules out
   *  "| Short Sleeve" — the seller has never once shipped a spec-only tail. */
  tailClass: { search: number; brand: number; specOnly: number }
  /** Adjacency-collapsed garment-noun mentions ("Tee Shirt" = ONE). The current judge's regex
   *  double-counts it and passes the Espana gold only by accident. */
  garment: { twice: number; once: number }
  /** "for Men Women" (gold #7) is NOT the banned "for Men and Women" — never fold them. */
  audienceMix: { gendered: number; inclusive: number; none: number }
  /** VOCAB_PROBES split by the corpus: attested terms are the seller's voice (funny, graphic,
   *  long sleeve at HEAD); unattested terms appear in ZERO golds and are inadmissible. The judge
   *  reads THESE — never a hand-typed ban list — so the scorer can never dock the seller's words. */
  vocabAttested: string[]
  vocabUnattested: string[]
}

/*
 * ── GARMENT-SPEC VOCABULARY, TWO LAYERS ─────────────────────────────────────────────
 *
 * WHY THIS EXISTS (adversarial break, 2026-08-11): an attacker wrote
 *   "THE CEO 2026 Soccer Cup Garment Dyed Crew Neck Tee | Comfort Colors Shirt"
 * — spec-stuffed garbage — and it scored 100/100 with zero recorded problems, because NO predicate
 * in the repo recognised "crew neck" / "garment dyed" / "short sleeve" as spec vocabulary
 * (`isTitleWasteVocabulary` is literally two phrases). Every rule scoped to "the money position"
 * was bypassable by relocation. This is the missing predicate.
 *
 * LAYER 1 (here): closed-class ENGLISH garment-spec vocabulary — linguistic categories, not catalog
 * data, so a static list is legitimate. Ambiguous words ("classic", "crew", "short") are matched
 * only in their spec COLLOCATION ("classic fit", "crew neck", "short sleeve") — the same distinction
 * the door's FIT_CLAIM_RE already draws, so "Classic Car Shirt" and "Short Story Tee" stay clean.
 * LAYER 2 (parameter): the resolved blank's own VALUES via blankSpecFactTokens(blankSpec), passed IN
 * by the caller — catalog data stays in the DB, and this module keeps zero pipeline imports.
 */
const SPEC_CLAIM_RES: readonly RegExp[] = [
  /\b(?:classic|relaxed|regular|slim|modern|athletic|loose|oversized)\s+fit\b/gi,
  /\b(?:short|long|three\s?quarter|3\/4|raglan)\s+sleeved?\b/gi,
  /\b(?:crew|v|scoop|boat|mock)\s?-?\s?neck(?:line)?\b/gi,
  /\bgarment\s?-?\s?dyed?\b/gi,
  /\bring\s?-?\s?spun\b/gi,
  /\bdouble\s?-?\s?needle\b/gi,
  /\b\d+(?:\.\d+)?\s?oz\b/gi,
]
const SPEC_ALWAYS_WORDS = new Set([
  'sleeveless', 'unisex', 'heavyweight', 'midweight', 'lightweight',
  'preshrunk', 'tagless', 'seamless', 'polyester', 'spandex', 'elastane',
])

/** All garment-spec claims present in `text`: collocation matches + always-words + any
 *  caller-supplied blank VALUES (layer 2). Returns matched phrases lowercased, deduped. PURE. */
export function specClaimSpans(text: string, specValues: readonly string[] = []): string[] {
  const t = (text || '').toLowerCase()
  const out: string[] = []
  for (const re of SPEC_CLAIM_RES) {
    for (const m of t.matchAll(new RegExp(re.source, 'gi'))) out.push(m[0].replace(/\s+/g, ' ').trim())
  }
  for (const w of t.split(/[^a-z0-9]+/)) if (SPEC_ALWAYS_WORDS.has(w)) out.push(w)
  for (const v of specValues) {
    const vv = (v || '').toLowerCase().trim()
    if (vv && t.includes(vv)) out.push(vv)
  }
  return [...new Set(out)]
}

/** The judge's garment-noun list (TITLE_V2 nounRegex membership, verbatim). Lives HERE so the judge
 *  can import it — listingPipeline already imports this module; the reverse would be a cycle.
 *  'jersey' is deliberately absent: the seller's Espana gold counts 'Tee Shirt' as its single
 *  garment mention, and adding 'jersey' would silently reclassify their own fixture. */
export const GARMENT_NOUNS = new Set([
  'shirt', 'shirts', 'tshirt', 'tshirts', 't-shirt', 't-shirts', 'tee', 'tees',
  'cap', 'hat', 'hoodie', 'sweatshirt', 'tank', 'polo', 'dress', 'jacket', 'beanie',
])

/** Adjacency-collapsed garment mentions: a RUN of consecutive garment nouns ("Tee Shirt",
 *  "TShirt Tee") is ONE mention — that is how the seller uses them (noun + variant as a unit).
 *  Measured over the nine golds: twice in 8, once in 1 (Espana). PURE. */
export function countGarmentMentions(title: string): number {
  const toks = (title || '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean)
  let runs = 0
  let inRun = false
  for (const tk of toks) {
    const isNoun = GARMENT_NOUNS.has(tk)
    if (isNoun && !inRun) runs++
    inRun = isNoun
  }
  return runs
}

export type TailClass = 'search' | 'brand' | 'specOnly'
/** Garment brands whose presence makes a tail BRAND-carrying. The seller's §2 ruling: the Comfort
 *  Colors name IS a selling point; 5 of the 9 canonical gold tails carry it. */
const TAIL_BRAND_RES: readonly RegExp[] = [/\bcomfort\s+colors?\b/i, /\bbella\s*\+?\s*canvas\b/i, /\bgildan\b/i]

/** Classify a separator-right. `specOnly` = EVERY significant token is spec vocabulary — the class
 *  the seller has shipped ZERO times (measured), and the class the band-pad kept manufacturing. */
export function classifyTail(tail: string, specValues: readonly string[] = []): TailClass {
  const t = (tail || '').trim()
  if (!t) return 'search'
  if (TAIL_BRAND_RES.some((re) => re.test(t))) return 'brand'
  const claims = specClaimSpans(t, specValues)
  let residue = t.toLowerCase()
  for (const c of claims) residue = residue.split(c).join(' ')
  // AUDIENCE WORDS DO NOT RESCUE A SPEC TAIL (2026-08-11): "| Short Sleeve for Women" is a spec
  // fact plus a demographic, and the seller has shipped ZERO of those. Their audience tails always
  // ride a real phrase ("Christian Shirts for Women"), never a bare spec. Treated as connectors so
  // the residue test sees what is actually left after the spec claim is removed.
  const STOP = new Set(['for', 'and', 'the', 'a', 'an', 'of', 'with', '&',
    'men', 'mens', 'women', 'womens', 'ladies', 'unisex', 'kids', 'youth', 'adult', 'adults'])
  const left = residue.split(/[^a-z0-9-]+/).filter((w) => w && w.length > 1 && !STOP.has(w))
  if (left.length === 0 && claims.length > 0) return 'specOnly'
  // A BARE GARMENT NOUN IS NOT A MONEY PHRASE. Live 2026-08-11: the pad minted "| Shirt" and every
  // spec-only guard passed it, because "shirt" is not a spec claim. Nobody searches the word "shirt"
  // alone as a purchase intent, and ZERO of the seller's tails are a bare noun — every one carries a
  // design phrase, a garment brand, or an audience. Classified with specOnly so ONE predicate covers
  // "the money position holds nothing worth ranking for".
  if (left.length > 0 && left.every((w) => GARMENT_NOUNS.has(w))) return 'specOnly'
  return 'search'
}

/** For each term: the seller's own verbatim collocations containing it (±2 words of context), or
 *  none. A term with ZERO attestation is not the seller's vocabulary; a term WITH attestation is
 *  admissible exactly in the shapes shown. This is what replaces every hand-typed ban list. PURE. */
export function attestedUse(titles: readonly string[], terms: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const term of terms) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const re = new RegExp('(?:\\S+\\s+){0,2}' + esc + '(?:\\s+\\S+){0,2}', 'gi')
    const hits: string[] = []
    for (const title of titles) for (const m of title.matchAll(re)) hits.push(m[0])
    out.set(term.toLowerCase(), hits)
  }
  return out
}

/**
 * GENUINE seller rejections — before-title, the seller's words, and the gold they wrote instead.
 * All three are the B0GVV3XL4T incident (2026-08-09..11), quoted from the session record.
 *
 * NEVER add a REVISED gold here (e.g. the old alligator gold): the seller improving their own title
 * is not a rejection, and fabricating a rejection event falsifies their ground truth — that exact
 * mistake was caught by adversarial review before it shipped.
 */
export const SEED_REJECT_PAIRS: readonly { before: string; sellerSaid: string; after: string }[] = [
  {
    before: 'THE CEO 2026 World Soccer Cup USA Mexico Canada Unisex Tee | Classic Fit',
    sellerSaid: 'Main money or design word needs to be short and sweet, up to 6-7 words, not entire 65 characters',
    after: 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee',
  },
  {
    before: 'THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee | Crew Neck',
    sellerSaid: 'WAY off from my recommended title. WHY did we need the filler CREW NECK there? crew neck can go on highlights',
    after: 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee',
  },
  {
    before: 'THE CEO 2026 World Soccer Cup Unisex Classic Fit Fan Shirt | Short Sleeve',
    sellerSaid: 'STILL BAD',
    after: 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee',
  },
  {
    before: 'THE CEO 2026 World Soccer Cup Tee for Men and Women Fans | Short Sleeve',
    sellerSaid: 'Still Bad after regen',
    after: 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee',
  },
] as const

/** The negative few-shot block: what this system wrote, what the seller said, what they wrote
 *  instead. Empty string when no pairs — the brief degrades, it never fabricates. */
export function rejectPairBlock(pairs: readonly { before: string; sellerSaid: string; after: string }[]): string {
  if (!pairs.length) return ''
  const lines: string[] = [
    'TITLES THIS SYSTEM WROTE THAT THE SELLER REJECTED — with their words. Do not fail the way a ✗ fails.',
    '',
  ]
  for (const p of pairs) {
    lines.push(`  ✗ ${p.before}`)
    lines.push(`      seller: "${p.sellerSaid}"`)
    lines.push(`  ✓ ${p.after}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** Probe list for the vocabulary table: the historically banned modifiers + the door's waste
 *  phrases + the spec collocations the attack titles used. The corpus decides which side of the
 *  table each lands on — nothing here is a ban, it is a QUESTION the golds answer. */
const VOCAB_PROBES: readonly string[] = [
  'funny', 'novelty', 'graphic', 'retro', 'cute', 'vintage',
  'unisex', 'classic fit', 'relaxed fit', 'crew neck', 'short sleeve', 'long sleeve', 'garment dyed',
]

/**
 * The gold-corpus block for the council brief — REPLACES goldBriefBlock. Every sentence is a
 * measurement; the only prose is what the numbers mean. This is the cure for the 2026-08-11
 * regression, where a hand-written PATTERN A template sat below the golds defining the money
 * position as "[Variant/Attribute]" — the council obeyed the template over the examples, and
 * shipped "| Short Sleeve".
 */
export function goldSpecBlock(titles: readonly string[], shape: GoldShape): string {
  if (titles.length === 0) return ''
  const att = attestedUse(titles, VOCAB_PROBES)
  const attested: string[] = []
  const unattested: string[] = []
  for (const [term, hits] of att) {
    if (hits.length > 0) attested.push(`"${term}" ×${hits.length} (e.g. "${hits[0]}")`)
    else unattested.push(`"${term}"`)
  }
  const m = shape.sepMix
  const tc = shape.tailClass
  return [
    `SELLER-APPROVED TITLES (${shape.count}) — written or locked by hand by this seller, newest first.`,
    'These are the specification. Do what they do; do not do what they never do.',
    '',
    ...titles.map((t) => `  ${t}`),
    '',
    'MEASURED ACROSS THEM — every number computed from the titles above, none typed:',
    `  • length ${shape.lenMin}-${shape.lenMax} characters, median ${shape.medianLen}`,
    `  • separators: ${m.pipe} of ${shape.count} use " | ", ${m.comma} join with a comma, ${m.plain} run straight through — all three are correct`,
    `  • identity segment (before a " | "): median ${shape.medianLeftWords} words, never more than ${shape.maxLeftWords} (measured over ${shape.leftWordsFrom})`,
    `  • the garment noun appears twice (as a pair like "Tee Shirt", or once per position) in ${shape.garment.twice} of ${shape.count}`,
    `  • audience tails: ${shape.audienceMix.gendered} gendered, ${shape.audienceMix.none} none, ${shape.audienceMix.inclusive} universal`,
    '',
    `EVERY " | " TAIL THE SELLER HAS SHIPPED, verbatim — ${tc.search} search-phrase, ${tc.brand} garment-brand, ${tc.specOnly} spec-only:`,
    ...shape.tails.map((t) => `  | ${t}`),
    '',
    'THE SELLER\'S VOCABULARY, measured over the titles above:',
    attested.length ? `  their words, in their collocations: ${attested.join(', ')}` : null,
    unattested.length ? `  never once used: ${unattested.join(', ')} — not their voice; do not introduce these` : null,
    // null (not '') marks a dropped conditional line — '' entries are DELIBERATE blank spacers
    // between sections and must survive the filter.
  ].filter((l): l is string => l !== null).join('\n')
}


const wc = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const leftOf = (t: string) => { const i = t.indexOf(' | '); return i >= 0 ? t.slice(0, i).trim() : t }
const median = (ns: number[]) => (ns.length ? [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)] : 0)

/** PURE. Measures the shape of a corpus so the brief can quote the seller's OWN numbers rather than
 *  a figure someone inferred from one example — the 2026-08-10 lesson, where "6-7 words" was written
 *  into the profile from a single gold while the measured median across the corpus was 8. */
export function measureGoldShape(titles: readonly string[]): GoldShape {
  const list = titles.filter((t) => t.trim().length > 0)
  const piped = list.filter((t) => t.includes(' | '))
  // LEFT-SEGMENT STATS COME FROM THE PIPED SUBSET ONLY. An unpiped title HAS no left segment —
  // `leftOf` returns the whole string — so including one contributes its FULL word count as though
  // it were a left segment, inflating the ceiling the brief then quotes as the seller's own law.
  // This is not hypothetical: the live corpus is ~70% unpiped (pipedShare 0.30, n=23), so the
  // inflated population is the MAJORITY. `/api/fba/title-golds` (route.ts:102-104) already measures
  // it this way; this brings the brief's copy into line with the analysis endpoint's.
  //
  // FALLBACK TO THE WHOLE LIST, NEVER TO ZERO — AND NEVER TO A SAMPLE OF ONE.
  //
  // `loadPoGoldTitles` takes only the newest 12 manual rows, so at the live pipedShare of 0.30 the
  // piped subset of a window can easily be 1 or 2 titles. `goldBriefBlock` states the ceiling to the
  // council as a hard law ("never more than N"), so a one-title sample would let a single atypical
  // lock — say a 4-word left segment — become a rule applied to every design. The first cut of this
  // function guarded only the ZERO case and would have shipped exactly that.
  //
  // Three is the smallest n that cannot be moved wholesale by one row, and it is also the size of
  // SEED_GOLD_TITLES, so the seed path (all piped) always qualifies. Below it, fall back to the
  // whole list: a mildly inflated ceiling is a far cheaper error than a fabricated-precise one.
  const MIN_PIPED_SAMPLE = 3
  const measured = piped.length >= MIN_PIPED_SAMPLE ? piped : list
  const lefts = measured.map((t) => wc(leftOf(t)))
  // TRIMMED MAX: with n this small, ONE atypical lock can raise the ceiling for the whole catalog
  // with no deploy (loadPoGoldTitles reads the newest 12 rows). If the largest left exceeds the
  // runner-up by more than 2 words, treat it as the outlier it is and use the runner-up.
  const sortedLefts = [...lefts].sort((a, b) => b - a)
  const trimmedMax = sortedLefts.length >= 4 && sortedLefts[0] > sortedLefts[1] + 2 ? sortedLefts[1] : (sortedLefts[0] ?? 0)
  const lens = list.map((t) => t.length)

  // Separator classification, priority pipe > comma > plain: a piped title may legitimately carry a
  // LIST comma inside a segment ("USA, Mexico & Canada"), so the pipe decides first.
  const commaJoined = list.filter((t) => !t.includes(' | ') && t.includes(', '))

  // Tails = the pipe-rights, verbatim. Printed to the council as-is: the strongest few-shot signal
  // available, and it costs nothing — the strings are already on screen inside the golds.
  const tails = piped.map((t) => t.slice(t.indexOf(' | ') + 3).trim())
  const tc = { search: 0, brand: 0, specOnly: 0 }
  for (const tail of tails) tc[classifyTail(tail)]++

  const mentions = list.map((t) => countGarmentMentions(t))
  const att = attestedUse(list, VOCAB_PROBES)
  const vocabA: string[] = []
  const vocabU: string[] = []
  for (const [term, hits] of att) (hits.length > 0 ? vocabA : vocabU).push(term)
  const audience = { gendered: 0, inclusive: 0, none: 0 }
  for (const t of list) {
    // "for Men and Women" is the seller-banned universal tail; "for Men Women" (gold #7) is NOT
    // that string and counts as gendered — the seller shipped it, so folding them would misreport
    // the corpus to the council.
    if (/\bfor\s+men\s+and\s+women\b/i.test(t)) audience.inclusive++
    else if (/\bfor\s+(?:men|women)\b/i.test(t)) audience.gendered++
    else audience.none++
  }

  return {
    medianLen: median(lens),
    medianLeftWords: median(lefts),
    maxLeftWords: trimmedMax,
    pipedShare: list.length ? +(piped.length / list.length).toFixed(2) : 0,
    count: list.length,
    leftWordsFrom: measured.length,
    lenMin: lens.length ? Math.min(...lens) : 0,
    lenMax: lens.length ? Math.max(...lens) : 0,
    sepMix: { pipe: piped.length, comma: commaJoined.length, plain: list.length - piped.length - commaJoined.length },
    tails,
    tailClass: tc,
    garment: { twice: mentions.filter((m) => m >= 2).length, once: mentions.filter((m) => m === 1).length },
    audienceMix: audience,
    vocabAttested: vocabA,
    vocabUnattested: vocabU,
  }
}

/**
 * Load the seller's locked titles, newest first, deduped. Falls back to SEED_GOLD_TITLES.
 *
 * `supabase` is passed IN and must be a plain service client — never the cookies()-bound one, which
 * throws outside a request scope and would make this silently return the seed list inside a
 * streaming continuation (the failure mode recorded in cookies-scoped-client-in-streams).
 */
export async function loadPoGoldTitles(
  supabase: SupabaseClient | null | undefined,
  limit = GOLD_BRIEF_LIMIT,
): Promise<{ titles: string[]; shape: GoldShape; source: 'db' | 'seed' }> {
  const seed = () => ({ titles: [...SEED_GOLD_TITLES], shape: measureGoldShape(SEED_GOLD_TITLES), source: 'seed' as const })
  if (!supabase) return seed()
  try {
    const { data, error } = await supabase
      .from('listing_seo_recommendations')
      .select('recommended_title, generated_at')
      .eq('title_source', 'manual')
      .order('generated_at', { ascending: false })
      .limit(400)
    if (error || !data) return seed()

    const seen = new Set<string>()
    const titles: string[] = []
    for (const r of data as { recommended_title: string | null }[]) {
      const t = (r.recommended_title ?? '').trim()
      // A gold must look like a shipped title: brand-front and inside the band. A truncated or
      // placeholder row would teach the council a shape the seller never chose. Brand-front is
      // required literally: every canonical gold opens with the brand, and a row that does not is
      // either a fragment or another surface's copy — admitting it would let one bad row move the
      // measured ceiling for the whole catalog with no deploy.
      if (t.length < 40 || t.length > 80) continue
      if (!/^the ceo\b/i.test(t)) continue
      const k = t.toLowerCase()
      if (seen.has(k)) continue          // one gold locked across many children is ONE example
      seen.add(k)
      titles.push(t)
      if (titles.length >= limit) break
    }
    if (titles.length === 0) return seed()
    // Union with the seed: the three highest-confidence examples always survive, even if the newest
    // locks happen to be atypical. Dedupe keeps them from appearing twice.
    for (const s of SEED_GOLD_TITLES) if (!seen.has(s.toLowerCase())) titles.push(s)
    return { titles, shape: measureGoldShape(titles), source: 'db' }
  } catch {
    return seed()
  }
}

