/**
 * itemHighlightComposer.ts — Architecture A (PO sign-off 2026-08-20): the pool-first Item
 * Highlights composer. DETERMINISTIC, no LLM.
 *
 * WHY. The PO rejected the brief-driven batch outright ("THESE ARE TERRIBLE!!!"): the LLM led
 * every family with beige filler ("Casual Apparel"), followed one template skeleton, mashed specs
 * ("Cotton Relaxed Unisex Fit") and used ONE pool phrase where the pool held five. The endorsed
 * competitor line is the family's TOP RANKING KEYWORDS arranged with variety — an ALLOCATION the
 * pool's own measured data already decides. So code composes: the line is verbatim pool phrases BY
 * CONSTRUCTION and beige is structurally impossible (there is no slot for invented classes).
 *
 * SELECTION: theme-fit first (3 → 0, null last), then volume; only phrases the shipping TITLES do
 * not already cover (the repo's ONE coverage predicate); each pick must add a new folded
 * significant token (near-dupes can't stack); garment-noun surface variety is rewarded (shirts /
 * tees / apparel / top as DISTINCT indexed tokens — the competitor craft); the running line
 * respects Amazon's ≤2 per-word rule and the 125-char contract budget, aiming into the 110-125
 * fill band. The PO's wear-style fact "Can be worn as Oversized" (ruling 2026-08-20, narrowed
 * 2026-08-21 "A: comfort colors") joins ONLY when the blank is Comfort Colors (Relaxed fit), the
 * pool shows oversized demand, and budget allows.
 *
 * TRUTH STAGE (PO-approved build 2026-08-21, after the 14-family regen): the composer is a faithful
 * mirror of the pool, so a rotten pool composes lies — "France Soccer Jersey" on a tee, "Hooded
 * Fishing Shirts … Sun Protection" on a crew tee, "Shirts Women … Plus Size" on a kids family.
 * `ihTruthVerdict` is ONE pure predicate every candidate passes BEFORE ranking: garment-noun truth,
 * capability claims, audience truth, competitor blanks, weight class. The brand waterfall is
 * satisfied INSIDE the line (one brand-bearing phrase) so no post-net ever rewrites the composer.
 *
 * UNRATED pools (ratedShare < 0.3) return null BEFORE selection (PO ruling 2026-08-21: volume
 * order with no judgment is the "Disney World Shirts" drift class — hold, never improvise); thin
 * pools return null after it. The caller HOLDS the field with a named reason (the LLM fallback is
 * RETIRED). Downstream nets (repeat cap, blank-brand net) still run on the returned
 * string as defense in depth; this module never re-implements them.
 */
import { CONTENT_CONTRACT } from './contentContract'
import { makeCoverageChecker } from '@/lib/keyword-engine/coverage-core'
import { ihFoldWord, IH_INSIGNIFICANT, ihRepeatViolations } from './productDetailAttrs'
import { scrubTrademarks } from './trademarkGuard'
import { trueWeightClass, PERFORMANCE_CLAIM_RE, type BlankSpec, type GarmentFamily } from './blankSpecs'

export interface ComposerPoolRow {
  keyword: string
  searchVolume?: number | null
  themeFit?: number | null
}

/** Competitor blank/apparel makers — never composable unless the family's own allowed brand.
 *  The trademark lexicon covers franchises/marks, not blanks (the Darlin' pool composed
 *  "Pro Club Shirts" straight through it).
 *  FISHING / OUTDOOR APPAREL (2026-08-21, seen in live pools: "huk shirts for men", "magellan
 *  fishing shirts"): a shopper typing a maker's name wants THAT maker — never this blank. Scoped to
 *  the composer's truth stage only: "columbia" / "magellan" double as place/design words elsewhere
 *  (listingPipeline.ts:968), and declining to COMPOSE a phrase is a hold, not a publish. */
const APPAREL_BRAND_RE = /\b(?:pro\s?club|gild[ae]n|guildan|softstyle|heavy\s?cotton\s?brand|hanes|fruit\s+of\s+the\s+loom|next\s+level|bella\s?canvas|american\s+apparel|champion|carhartt|comfort\s+colors|huk|bassdash|columbia|under\s*armou?r|magellan|simms|aftco|pelagic)\b/i
const MIN_CANDIDATES = 3
/** Rated pools compose themeFit >= 2 ONLY (PO 2026-08-21, B0DQ5YZH38: fit-1 "Band Tees" led a line). */
const MIN_THEME_FIT = 2
const GARMENT_SURFACE_RE = /\b(?:t[-\s]?shirts?|tees?|tshirts?|shirts?|apparel|tops?|clothing|hoodies?|sweatshirts?|garments?)\b/i

/** The composer's garment vocabulary: the blank_specs enum UNFOLDED (kids_tee must reach the
 *  audience rule; long_sleeve_tee names its own spec phrase), plus the title-guess values. */
export type ComposerGarmentFamily = GarmentFamily | 'hat' | 'none' | null

/* ─── TRUTH STAGE ─────────────────────────────────────────────────────────────────────────────── */

export type IhTruthReason =
  | 'wrong-garment-noun'            // names a garment the family is not (jersey/hooded on a tee…)
  | 'garment-vocab-on-non-apparel'  // any garment word on a 'none' (Electronics) family
  | 'capability-claim'              // sun protection / UPF / moisture-wicking… — no blank states it
  | 'audience-adult-on-kids'        // women/men/ladies/plus-size on a kids_tee family
  | 'audience-kids-on-adult'        // kids/toddler/youth/boys/girls/baby on an adult family
  | 'competitor-brand'              // another blank maker (Pro Club, Gildan…) unless it is the family's own
  | 'weight-class-lie'              // light/mid/heavyweight that the blank's weightNote does not back

export interface IhTruthCtx {
  garmentFamily: ComposerGarmentFamily | undefined
  /** BlankSpec has no capability field today, so the capability rule is unconditional; weightNote
   *  backs the weight-class rule. */
  spec: Pick<BlankSpec, 'weightNote'> | null | undefined
  allowedBrand: string | null | undefined
  audience: 'kids' | 'adult' | null
}

/** Audience is a property of the BLANK FAMILY (64000B youth tee ⇒ kids), never inferred from a title. */
export function ihAudienceOf(gf: ComposerGarmentFamily | undefined): 'kids' | 'adult' | null {
  if (gf === 'kids_tee') return 'kids'
  if (gf === 'tee' || gf === 'long_sleeve_tee' || gf === 'sweatshirt' || gf === 'hoodie' || gf === 'hat') return 'adult'
  return null
}

/** Every garment noun the lexicon knows; longer multi-word forms FIRST so "hooded sweatshirt" /
 *  "tank top" match as one noun. `crewnecks?` is the one-word sweatshirt noun ("crew neck" two
 *  words is a neck style and not a noun). */
const GARMENT_NOUN_RE = /\b(?:hooded[\s-]?sweatshirts?|tank[\s-]?tops?|t[\s-]?shirts?|tshirts?|tees?|shirts?|tops?|sweatshirts?|crewnecks?|pullovers?|hoodies?|hoodys?|hooded|jerseys?|tanks?|polos?|dress(?:es)?|sweaters?|jackets?|onesies?|bodysuits?|rompers?|leggings)\b/gi
/** A matched noun → its garment class. `crewneck` is its own class: a crew neck contradicts a hood. */
const garmentNounClass = (m: string): string => {
  const k = m.toLowerCase().replace(/[\s-]+/g, '')
  if (/^(?:t?shirts?|tees?|tops?)$/.test(k)) return 'tee'
  if (/^(?:sweatshirts?|pullovers?)$/.test(k)) return 'sweatshirt'
  if (/^crewnecks?$/.test(k)) return 'crewneck'
  if (/^(?:hoodies?|hoodys?|hooded|hoodedsweatshirts?)$/.test(k)) return 'hoodie'
  return k.replace(/s$/, '')
}
const TEE_CLASSES: ReadonlySet<string> = new Set(['tee'])
const SWEATSHIRT_CLASSES: ReadonlySet<string> = new Set(['sweatshirt', 'crewneck'])
const HOODIE_CLASSES: ReadonlySet<string> = new Set(['hoodie', 'sweatshirt'])
/** The garment classes each family may name. A hoodie IS a hooded sweatshirt (coordinator ruling
 *  2026-08-21): hoodie families accept hoodie / hooded sweatshirt / sweatshirt / pullover — only
 *  tee nouns (and a crew neck) are foreign to them. null = no noun rule (unresolved blank / hat). */
const allowedGarmentClasses = (gf: ComposerGarmentFamily | undefined): ReadonlySet<string> | null => {
  if (gf === 'tee' || gf === 'long_sleeve_tee' || gf === 'kids_tee') return TEE_CLASSES
  if (gf === 'sweatshirt') return SWEATSHIRT_CLASSES
  if (gf === 'hoodie') return HOODIE_CLASSES
  return null
}

// `womans`/`mans`/`lady` added 2026-08-21: "Womans Shirts" composed onto the kids family B0DP5H8QBT.
const ADULT_AUDIENCE_RE = /\b(?:women|woman|womens|womans|ladies|lady|men|mens|mans|adults?|plus[\s-]?size)\b/i
const KIDS_AUDIENCE_RE = /\b(?:kids?|toddlers?|youth|boys|girls|baby)\b/i

/**
 * ONE pure truth predicate for a candidate phrase against the family's blank facts. Exported so the
 * pins read as the PO's rulings; applied in the candidate filter beside the shape/legal filters.
 */
export function ihTruthVerdict(phrase: string, ctx: IhTruthCtx): { ok: true } | { ok: false; reason: IhTruthReason } {
  const gf = ctx.garmentFamily
  // (a) garment-noun truth — 'none' = NON-APPAREL (PO 2026-08-21: B0GCF11RKL is Electronics — the
  // composer put "T Shirts for Women" on a memory card); otherwise a phrase naming a garment class
  // the family is not (a tee is never a jersey/hoodie/sweatshirt; hooded ⇒ hoodie only).
  if (gf === 'none') {
    if (GARMENT_SURFACE_RE.test(phrase)) return { ok: false, reason: 'garment-vocab-on-non-apparel' }
  } else {
    const allowed = allowedGarmentClasses(gf)
    if (allowed) {
      for (const m of phrase.matchAll(GARMENT_NOUN_RE)) {
        if (!allowed.has(garmentNounClass(m[0]))) return { ok: false, reason: 'wrong-garment-noun' }
      }
    }
  }
  // (b) capability claims — BlankSpec states no capability today ⇒ every such claim is unverifiable.
  if (PERFORMANCE_CLAIM_RE.test(phrase)) return { ok: false, reason: 'capability-claim' }
  // (c) audience truth — derived from the blank family, never a title.
  if (ctx.audience === 'kids' && ADULT_AUDIENCE_RE.test(phrase)) return { ok: false, reason: 'audience-adult-on-kids' }
  if (ctx.audience === 'adult' && KIDS_AUDIENCE_RE.test(phrase)) return { ok: false, reason: 'audience-kids-on-adult' }
  // (d) competitor APPAREL brands — outside the trademark lexicon (it covers franchises, not blanks):
  // a pool row naming another maker never composes. The family's own allowed blank brand
  // (brand_in_copy, e.g. Comfort Colors) is exempted by name.
  const bm = phrase.match(APPAREL_BRAND_RE)
  if (bm && bm[0].toLowerCase() !== (ctx.allowedBrand ?? '').toLowerCase()) return { ok: false, reason: 'competitor-brand' }
  // (e) fabric-class truth — a weight-class word must match the blank (unknown blank ⇒ none).
  const wm = phrase.match(/\b(light|mid|middle|heavy)[\s-]?weight\b/i)
  if (wm) {
    const wt = trueWeightClass(ctx.spec)
    if (!wt || !wt.startsWith(wm[1].toLowerCase().slice(0, 3))) return { ok: false, reason: 'weight-class-lie' }
  }
  return { ok: true }
}

/** The deterministic brand phrase when no pool candidate carries the brand: "<Brand> <garment noun>". */
const brandSpecPhrase = (brand: string, gf: ComposerGarmentFamily | undefined): string => {
  const noun = gf === 'long_sleeve_tee' ? 'Long Sleeve Shirt'
    : gf === 'sweatshirt' ? 'Sweatshirt'
      : gf === 'hoodie' ? 'Hoodie'
        : gf === 'hat' ? 'Hat'
          : 'Tee'
  return `${brand.trim()} ${noun}`
}

/** Acronyms/initialisms keep their canonical ALL-CAPS form — "Sd Card 32gb" and "Usa Soccer"
 *  read amateur on a customer-facing line (found on the Electronics family, 2026-08-21). */
const ACRONYM_CASE: Record<string, string> = {
  sd: 'SD', sdhc: 'SDHC', sdxc: 'SDXC', microsd: 'MicroSD', usb: 'USB', hdmi: 'HDMI',
  usa: 'USA', uk: 'UK', led: 'LED', hd: 'HD', tv: 'TV', gps: 'GPS', diy: 'DIY',
}
/** Title Case a pool phrase without disturbing its wording (the token sequence is what ranks).
 *  THE customer-facing IH caser (acronym caps included). Length-preserving. */
export const titleCasePhrase = (p: string): string =>
  p.split(/\s+/).map((w) => {
    const lower = w.toLowerCase()
    if (ACRONYM_CASE[lower]) return ACRONYM_CASE[lower]
    const unit = lower.match(/^(\d+)(gb|tb|mb|k)$/)          // 32gb → 32GB, 4k → 4K
    if (unit) return unit[1] + unit[2].toUpperCase()
    return IH_INSIGNIFICANT.has(lower) ? lower : w.charAt(0).toUpperCase() + w.slice(1)
  }).join(' ')
    .replace(/^./, (c) => c.toUpperCase())

/** Gender/audience irregular plurals fold together (woman≡women, ladies≡lady, man≡men) — without
 *  this, "alligator shirt women" + "alligator shirts woman" both pass novelty and the line becomes
 *  the exact permutation-spam the PO rejected. */
const GENDER_FOLDS: Record<string, string> = { women: 'woman', men: 'man', ladies: 'lady', gals: 'gal' }
const significantFolded = (phrase: string): string[] =>
  phrase.toLowerCase().split(/\s+/)
    .map((w) => { const f = ihFoldWord(w); return GENDER_FOLDS[f] ?? f })
    .filter((w) => w && !IH_INSIGNIFICANT.has(w))

export interface ComposerOpts {
  spec?: Pick<BlankSpec, 'brand' | 'weightNote' | 'stretch' | 'material' | 'fit' | 'neck' | 'sleeve' | 'dye' | 'unisex'> | null
  garmentFamily?: ComposerGarmentFamily
  /** The blank brand copy may name (brand_in_copy) — null for Gildan-class blanks. */
  allowedBrand?: string | null
  /** Audience of the BLANK (kids_tee ⇒ kids). Defaults to ihAudienceOf(garmentFamily); a caller
   *  whose garmentFamily is a title GUESS passes null explicitly — audience is never title-inferred. */
  audience?: 'kids' | 'adult' | null
}

/** The composer's null stages — the caller maps them to a PO-facing hold reason. */
export type ComposerNullStage = 'unrated-pool' | 'too-few-candidates' | 'too-few-picked' | 'under-floor-after-pad'
export interface ComposerResult {
  line: string | null
  stage: ComposerNullStage | null
}

/**
 * Compose the Item Highlights line from the rated pool. Returns null when the pool cannot carry
 * the structure (the caller HOLDS the field). `titles` = every title the shipped IH will sit beside.
 * Thin wrapper over the detailed form — the historical signature for tests and line-only readers.
 */
export function composeItemHighlight(pool: ComposerPoolRow[], titles: string[], opts?: ComposerOpts): string | null {
  return composeItemHighlightDetailed(pool, titles, opts).line
}

export function composeItemHighlightDetailed(
  pool: ComposerPoolRow[],
  titles: string[],
  opts?: ComposerOpts,
): ComposerResult {
  const titleCovers = makeCoverageChecker(titles.filter(Boolean).join(' '))
  const truthCtx: IhTruthCtx = {
    garmentFamily: opts?.garmentFamily,
    spec: opts?.spec,
    allowedBrand: opts?.allowedBrand,
    audience: opts?.audience !== undefined ? opts.audience : ihAudienceOf(opts?.garmentFamily),
  }
  const flatten = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const brandRe = opts?.allowedBrand
    ? new RegExp('\\b' + opts.allowedBrand.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*') + '\\b', 'i')
    : null
  const carriesBrand = (s: string): boolean =>
    !!brandRe && !!opts?.allowedBrand && (brandRe.test(s) || flatten(s).includes(flatten(opts.allowedBrand)))

  // The PO wear-style fact reserves its budget UP FRONT when eligible — otherwise the greedy fill
  // reaches the band first and the fact never fits (test-caught design gap).
  // PO RULING 2026-08-21 ("A: comfort colors"): the fact is a COMFORT COLORS (Relaxed-fit) fact
  // ONLY — never Gildan 64000/64400 (Classic) or any other blank; unisex alone no longer qualifies.
  // A mixed-blank intersection drops `brand`, so a CC+Gildan family is correctly ineligible.
  const OVERSIZED_FACT = 'Can be worn as Oversized'
  const isComfortColors = /^comfort\s*colors?$/i.test((opts?.spec?.brand ?? '').trim())
  const factEligible = isComfortColors && pool.some((r) => /\bover[\s-]?sized?\b/i.test(r.keyword))
  // BRAND WATERFALL INSIDE THE COMPOSER (PO 2026-08-21, B0FKFHSCS9: the post-net rewrote a good
  // 125-char line to "authentic Comfort Colors blank, …" and truncated the tail). Same trigger as
  // the net (every shipped title must carry the brand — a multi-design child whose title lacks it
  // would show the brand nowhere): when any title lacks it, the line carries exactly ONE
  // brand-bearing phrase, budget reserved up front.
  const namedTitles = titles.filter((t) => !!t && !!t.trim())
  const needBrand = !!opts?.allowedBrand && !(namedTitles.length > 0 && namedTitles.every(carriesBrand))

  // FIT GATE (2026-08-20, the "Disney World Shirts"/"Band Tees" drift): candidates must carry
  // themeFit >= MIN_THEME_FIT (2 since 2026-08-21: a fit-1 phrase is "plausible", not on-design),
  // so off-design harvest noise (high-volume, unrated or fit-0/1) cannot compose.
  // UNRATED POOLS HOLD (PO ruling 2026-08-21): when the rater has judged under 30% of the pool
  // there is no judgment to trust — volume-ordered composition IS the drift class — so the pool
  // returns null here, before selection; the caller holds with "needs research / theme rating".
  const ratedShare = pool.length ? pool.filter((r) => typeof r.themeFit === 'number').length / pool.length : 0
  const requireFit = ratedShare >= 0.3

  // Candidates: 2-5 word pool phrases the titles don't cover, ranked theme-fit DESC then volume DESC.
  // 2026-08-21: every null branch below names itself — two 6014 families returned null WITH a full
  // spec available and nobody could say which filter starved them. A silent null is a guess factory.
  const truthDrops: Partial<Record<IhTruthReason, number>> = {}
  const why = { pool: pool.length, ratedShare: Math.round(ratedShare * 100), requireFit, needBrand, afterFit: 0, candidates: 0, picked: 0, lineLen: 0, truthDrops }
  const nullOut = (stage: ComposerNullStage): ComposerResult => {
    console.log(JSON.stringify({ tag: 'IH_COMPOSER_NULL', stage, ...why }))
    return { line: null, stage }
  }
  if (!requireFit) return nullOut('unrated-pool')
  const candidates = pool
    .filter((r) => !!r.keyword)
    .filter((r) => typeof r.themeFit === 'number' && r.themeFit >= MIN_THEME_FIT)
    .map((r) => { why.afterFit++; return { ...r, keyword: r.keyword.trim() } })
    .filter((r) => {
      const words = r.keyword.split(/\s+/).length
      // PO ruling 2026-08-20: a bare "Oversized <garment>" pool phrase is a CUT claim — excluded
      // here always; oversized demand surfaces only as the sanctioned wear-style fact below.
      if (/\bover[\s-]?sized?\b/i.test(r.keyword)) return false
      // LEGAL FILTER: third-party marks — the trademark door must pass the phrase byte-identical.
      if (scrubTrademarks(r.keyword) !== r.keyword) return false
      // TRUTH STAGE (2026-08-20 Darlin' F-grade → 2026-08-21 14-family review): the composer is a
      // mirror; ONE predicate keeps a rotten pool from composing lies (see ihTruthVerdict).
      const verdict = ihTruthVerdict(r.keyword, truthCtx)
      if (!verdict.ok) { truthDrops[verdict.reason] = (truthDrops[verdict.reason] ?? 0) + 1; return false }
      return words >= 2 && words <= 5 && !titleCovers(r.keyword)
    })
    .sort((a, b) => {
      const tf = (x: ComposerPoolRow) => (typeof x.themeFit === 'number' ? x.themeFit : -1)
      if (tf(b) !== tf(a)) return tf(b) - tf(a)
      return (b.searchVolume ?? 0) - (a.searchVolume ?? 0)
    })
  why.candidates = candidates.length
  if (candidates.length < MIN_CANDIDATES) return nullOut('too-few-candidates')

  // THE brand phrase (waterfall): prefer the best pool candidate carrying the brand (themeFit >= 2,
  // already truth-clean and not title-covered — candidates are sorted fit DESC / volume DESC), else
  // the deterministic spec phrase "<Brand> <garment noun>". It is rendered AFTER the pool picks but
  // counts toward budget, novelty and the repeat cap from the start, so the line always has room
  // for it and the brand-once rule holds by construction (every other brand-bearing candidate is
  // excluded from the pick loop while the waterfall is live).
  const brandFromPool = needBrand
    ? candidates.find((c) => typeof c.themeFit === 'number' && c.themeFit >= MIN_THEME_FIT && carriesBrand(c.keyword))?.keyword ?? null
    : null
  const brandPick: string | null = needBrand
    ? titleCasePhrase(brandFromPool ?? brandSpecPhrase(opts!.allowedBrand!, opts?.garmentFamily))
    : null
  const RESERVE = (factEligible ? OVERSIZED_FACT.length + 2 : 0) + (brandPick ? brandPick.length + 2 : 0)
  const MAX = CONTENT_CONTRACT.itemHighlights.max - RESERVE
  const AIM = CONTENT_CONTRACT.itemHighlights.fillTarget - RESERVE

  const picked: string[] = []
  const usedFolded = new Set<string>()
  const usedGarmentSurfaces = new Set<string>()
  const lineLen = () => picked.reduce((n, p, i) => n + p.length + (i ? 2 : 0), 0)
  /** The phrases a repeat/novelty check must see — the reserved brand phrase is already "in". */
  const withBrand = (arr: string[]): string[] => (brandPick ? [...arr, brandPick] : arr)
  if (brandPick) {
    significantFolded(brandPick).forEach((w) => usedFolded.add(w))
    const gm = brandPick.match(GARMENT_SURFACE_RE)?.[0]?.toLowerCase().replace(/[-\s]/g, '').replace(/s$/, '')
    if (gm) usedGarmentSurfaces.add(gm)
  }

  // Two passes: first prefer candidates introducing a NEW garment surface (the variety craft),
  // then fill remaining budget with any novel candidate.
  for (const preferNewGarment of [true, false]) {
    for (const c of candidates) {
      if (picked.length >= 7 || lineLen() >= AIM) break
      const phrase = titleCasePhrase(c.keyword)
      if (picked.includes(phrase) || phrase === brandPick) continue
      const folded = significantFolded(c.keyword)
      if (!folded.some((w) => !usedFolded.has(w))) continue            // must add something new
      const gm = c.keyword.match(GARMENT_SURFACE_RE)?.[0]?.toLowerCase().replace(/[-\s]/g, '').replace(/s$/, '')
      if (preferNewGarment && gm && usedGarmentSurfaces.has(gm)) continue
      if (preferNewGarment && !gm) continue
      const nextLen = lineLen() + (picked.length ? 2 : 0) + phrase.length
      if (nextLen > MAX) continue
      const draft = withBrand([...picked, phrase]).join(', ')
      if (ihRepeatViolations(draft).length > 0) continue               // Amazon's ≤2 per-word rule
      // PO ruling 2026-08-21 (B0GWFFK1W7 "comfort colors tshirt, comfort colors graphic tee…" —
      // "repeating CC 2 times"): the blank brand appears in AT MOST ONE picked phrase. Amazon's
      // ≤2-per-word cap allows two; the PO does not. The reserved waterfall phrase counts as it.
      if (brandRe && brandRe.test(phrase) && (brandPick || picked.some((pp) => brandRe.test(pp)))) continue
      picked.push(phrase)
      folded.forEach((w) => usedFolded.add(w))
      if (gm) usedGarmentSurfaces.add(gm)
    }
  }
  // A pool-sourced brand phrase IS a pool pick for the viability count; the spec phrase is not.
  if (picked.length + (brandFromPool ? 1 : 0) < MIN_CANDIDATES) { why.picked = picked.length; return nullOut('too-few-picked') }
  if (brandPick) picked.push(brandPick)
  why.picked = picked.length

  // PO ruling 2026-08-20/21: the wear-style FACT for Comfort Colors (budget reserved above).
  // Never bare "Oversized <garment>" from here — cut claims are blank_specs territory and such
  // pool phrases are excluded in the candidate filter.
  if (
    factEligible &&
    !usedFolded.has(ihFoldWord('oversized')) &&
    ihRepeatViolations([...picked, OVERSIZED_FACT].join(', ')).length === 0
  ) {
    picked.push(OVERSIZED_FACT)
  }

  // PO RULING 2026-08-21, verbatim "44 is NEVER approved, MIN 85% of MAX 125": an under-min line
  // never ships. Pad toward the floor with TRUE spec facts (blank_specs values — never invented),
  // each passing the same novelty + repeat gates as pool phrases. "Unisex Fit" joins the bank when
  // blank_specs.unisex is TRUE (PO 2026-08-06: unisex sizing explicit in features/highlights,
  // never the title) — a mixed-blank intersection carries it only when every blank claims it. A family that cannot truthfully
  // reach the floor returns NOT-READY (null) — the caller's fallback/hold path decides, but a
  // short line is not a shippable outcome from here.
  const MIN = CONTENT_CONTRACT.itemHighlights.min
  if (lineLen() < MIN && opts?.spec) {
    const sp = opts.spec
    const factFillers = [
      sp.material || '',
      sp.fit ? `${sp.fit} Fit` : '',
      sp.unisex === true ? 'Unisex Fit' : '',
      sp.neck || '',
      sp.sleeve || '',
      sp.dye ? `${sp.dye} Fabric` : '',
    ].filter(Boolean)
    for (const f of factFillers) {
      if (lineLen() >= MIN) break
      const phrase = titleCasePhrase(f)
      if (picked.includes(phrase)) continue
      const folded = significantFolded(f)
      if (!folded.some((w) => !usedFolded.has(w))) continue
      if (lineLen() + 2 + phrase.length > CONTENT_CONTRACT.itemHighlights.max) continue
      if (ihRepeatViolations([...picked, phrase].join(', ')).length > 0) continue
      picked.push(phrase)
      folded.forEach((w) => usedFolded.add(w))
    }
  }
  why.picked = picked.length; why.lineLen = lineLen()
  if (lineLen() < MIN) return nullOut('under-floor-after-pad')

  // Trademark door on the final bytes (defense in depth — candidates are already door-clean, but
  // the wear-fact / brand / filler joins and future edits must never reopen it).
  return { line: scrubTrademarks(picked.join(', ')), stage: null }
}
