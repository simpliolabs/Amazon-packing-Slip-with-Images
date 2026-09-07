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
import { ihFoldWord, IH_INSIGNIFICANT, ihRepeatViolations, GENDER_FOLDS, significantFolded, lineHasSignificantRepeat } from './productDetailAttrs'
import { scrubTrademarks } from './trademarkGuard'
import { type BlankSpec } from './blankSpecs'
import {
  phraseTruthVerdict,
  audienceOfGarmentFamily,
  GARMENT_SURFACE_RE,
  type PhraseTruthCtx,
  type PhraseTruthReason,
  type TruthGarmentFamily,
  type TruthAudienceLean,
} from './contentTruth'

export interface ComposerPoolRow {
  keyword: string
  searchVolume?: number | null
  themeFit?: number | null
}

const MIN_CANDIDATES = 3
/** Rated pools compose themeFit >= 2 ONLY (PO 2026-08-21, B0DQ5YZH38: fit-1 "Band Tees" led a line). */
const MIN_THEME_FIT = 2
/** The pool-phrase loop's own pick cap (was an inline `picked.length >= 7` break). Named ONCE here
 *  (FIX WAVE 2, I-1, 2026-09-06) so `admitCandidate` — shared by the live selection loop and the
 *  reachability shadow — can enforce the identical cap in both places; a hand-copied `7` in the
 *  shadow is exactly how this class of drift (I-1) happened the first time. */
const MAX_PICKED_PHRASES = 7

/** The composer's garment vocabulary: the blank_specs enum UNFOLDED (kids_tee must reach the
 *  audience rule; long_sleeve_tee names its own spec phrase), plus the title-guess values.
 *  ALIAS of the spine's type — the composer's historical name, kept for its callers. */
export type ComposerGarmentFamily = TruthGarmentFamily

/* ─── TRUTH STAGE — now the SHARED spine (contentTruth.ts) ─────────────────────────────────────
 *
 * PROMOTED 2026-08-21. The predicate below used to live here and was wired to this composer ONLY,
 * which is why the same pool that could not compose "hooded fishing shirts" into an Item Highlight
 * shipped "Funny Work Shirts" in a SWEATSHIRT family's TITLE (PO-caught, B0DSCDZC6K). The rules,
 * lexicons and reason codes moved VERBATIM into `contentTruth.ts`; `ihTruthVerdict` is now a thin
 * wrapper that pins this composer's field ('highlights').
 *
 * TASK 5 (2026-09-06, item-highlights-per-design plan): the forced-gender rule ('audience-lean-lie')
 * used to be title-only and this wrapper hardcoded `audienceLean: null` to guarantee it could never
 * fire here. Live sibling complaint on UNISEX family B0DSCDZC6K, "Why is Women repeating Twice?" —
 * the composer had NO audience-lean rule at all, so a unisex design's own scoped pool could carry a
 * bare "for Women"/"for Men" market phrase unchecked. `audienceLean` now flows through from the
 * caller (each design's OWN resolved lean, from `buildItemHighlightsPerDesign` — never a new source),
 * so every existing caller that doesn't pass it (the single-design path) stays byte-identical:
 * `undefined` is not `'unisex'`, so contentTruth.ts's (c2) rule stays a no-op exactly as before. */

/** The Item-Highlight reason set — every spine reason, including `audience-lean-lie` since Task 5. */
export type IhTruthReason = PhraseTruthReason

/** The composer's slice of the spine ctx — no `field` (pinned to 'highlights' below); `audienceLean`
 *  (Task 5) and `designTokens` (per-design name, already on `PhraseTruthCtx`) both flow through. */
export type IhTruthCtx = Omit<PhraseTruthCtx, 'field'>

/** Audience is a property of the BLANK FAMILY (64000B youth tee ⇒ kids), never inferred from a title. */
export const ihAudienceOf = audienceOfGarmentFamily

/**
 * ONE pure truth predicate for a candidate phrase against the family's blank facts. Exported so the
 * pins read as the PO's rulings; applied in the candidate filter beside the shape/legal filters.
 * Thin wrapper over the shared spine — see contentTruth.ts for the rules themselves.
 */
export function ihTruthVerdict(phrase: string, ctx: IhTruthCtx): { ok: true } | { ok: false; reason: IhTruthReason } {
  return phraseTruthVerdict(phrase, { ...ctx, field: 'highlights' })
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

/** FIX WAVE 2 ROUND 2 (F1, controller RULING, 2026-09-06): `GENDER_FOLDS`, `significantFolded` and
 *  `lineHasSignificantRepeat` moved to `productDetailAttrs.ts` (imported above), beside the sibling
 *  Item-Highlight repeat predicate (`ihRepeatViolations`, Amazon's own ≤2 cap) — ONE home for both.
 *  This module used to be the ONLY definition site, and `perDesignItemHighlights.ts` (imported by
 *  the CLIENT page) imported `lineHasSignificantRepeat` from HERE — the generation path (this file
 *  reaches `contentTruth` -> `blankSpecs` -> a lazy supabase client) — so the client page
 *  transitively reached the composer. `productDetailAttrs.ts` is already a leaf the client page
 *  imports directly; this module now imports the three names from there instead of defining them,
 *  and never re-exports them (nothing outside this file imported them from here — verified: the two
 *  test files that reference these names by prose hand-copy their own local fold, they never
 *  `import` it from this module). */

/** TASK 2 (2026-09-06, PO "Why is Women repeating Twice?"): a candidate that adds ONE new token
 *  while repeating others used to outrank a candidate whose tokens are ALL new, merely by sorting
 *  higher on theme-fit/volume — "Fall Sweatshirts for Women" (adds only `fall`) beat "Graphic
 *  Pullover Top" (adds three) to a slot, and the line repeated `sweatshirts`/`women`. Amazon's ≤2
 *  cap let it through because each repeat landed exactly twice. Task 2's own fix ranked in two
 *  tiers — Tier A (every token new) fills before a Tier-B FALLBACK (repeats a used token), engaged
 *  only once Tier A was exhausted below the fill band.
 *
 *  TASK 6 (2026-09-06, PO ruling verbatim "2. No Repeat as per Amazon Ruules" — rejecting the
 *  controller's proposed amendment "no repeat unless the 107 floor cannot otherwise be reached
 *  truthfully"): the Tier-B FALLBACK is gone. A candidate that repeats ANY already-used folded
 *  significant token is REJECTED, full stop, in BOTH selection loops — see the two call sites below,
 *  which now accept only `tier === 'A'` and never iterate a 'B' pass. `classifyTier` itself is
 *  UNCHANGED (still a pure three-way classifier: 'A' / 'B' / `null`) because both call sites still
 *  need to tell "this candidate would have added new content, but only via a repeat" (tier 'B') apart
 *  from "this candidate adds nothing new at all" (`null`) — that distinction is what lets the caller
 *  report the PO-facing `under-floor-no-repeat` hold instead of a generic "pool too thin" reason when
 *  the true cause is the absolute rule, not a starved pool. `classifyTier` plays no part in selection
 *  any more; it is read-only, for that one detection.
 *
 *  Tier A = every significant token is new (zero overlap with `usedFolded`). Tier B = adds at least
 *  one new token but repeats at least one used token (NEVER composes since Task 6). `null` = adds
 *  nothing new — never composes, same as before Task 2.
 *
 *  Shared by BOTH selection loops (pool phrases below, spec-fact pad further down) so the tier rule
 *  lives in exactly one place — the two loops rank different candidate shapes but must never fork
 *  the definition of "new" vs "repeat". */
type CandidateTier = 'A' | 'B' | null
const classifyTier = (folded: readonly string[], usedFolded: ReadonlySet<string>): CandidateTier => {
  const addsNew = folded.some((w) => !usedFolded.has(w))
  if (!addsNew) return null
  return folded.some((w) => usedFolded.has(w)) ? 'B' : 'A'
}

/** FIX WAVE 2 (I-1, 2026-09-06, controller RULING on the final whole-branch review #2): the real
 *  pool loop's own per-candidate ADMISSION decision — tier (the repeat rule; `allowRepeat` picks
 *  which tiers may compose), the named pick cap, the char-budget fit, Amazon's own <=2-per-word cap
 *  (`ihRepeatViolations`), and the "brand appears in at most one picked phrase" rule — extracted into
 *  ONE function so the live selection (`allowRepeat: false`) and the reachability shadow
 *  (`allowRepeat: true`, `shadowRepeatReachesFloor` below) can never drift apart: the shadow walks
 *  the SAME admission gate the real loop enforces and inherits every rule by construction instead of
 *  re-modeling a subset of them (the bug this finding closes — the shadow used to skip both the <=2
 *  cap and the pick cap, so it could report a repeat-permitting selection "reachable" using more
 *  repeats or more picks than the real loop, even with repeats allowed, could ever actually admit).
 *
 *  Deliberately NOT part of admission: garment-surface-variety ordering (the live loop's own
 *  `preferNewGarment` pass). That preference decides which Tier-A candidate goes first among equals
 *  on THIS pass — a candidate it skips now can still be picked on the next pass — so it can never be
 *  the reason a candidate is permanently unreachable, only the reason it lands in a different slot.
 *  Modeling it here would duplicate ordering logic without changing whether 107 chars is reachable.
 *
 *  `picked`/`len` describe the running selection the caller is about to extend; `repeatCheckBase` is
 *  the array `ihRepeatViolations` must see the draft against — the pool loop passes `withBrand(picked)`
 *  because the reserved brand phrase counts toward the repeat cap before it is literally pushed. */
function admitCandidate(
  phrase: string,
  folded: readonly string[],
  tierBasis: ReadonlySet<string>,
  allowRepeat: boolean,
  picked: readonly string[],
  len: number,
  max: number,
  repeatCheckBase: readonly string[],
  brandRe: RegExp | null,
  brandPick: string | null,
): boolean {
  const tier = classifyTier(folded, tierBasis)
  if (tier === null) return false
  if (tier === 'B' && !allowRepeat) return false
  if (picked.length >= MAX_PICKED_PHRASES) return false
  const nextLen = len + (picked.length ? 2 : 0) + phrase.length
  if (nextLen > max) return false
  if (ihRepeatViolations([...repeatCheckBase, phrase].join(', ')).length > 0) return false
  if (brandRe && brandRe.test(phrase) && (brandPick || repeatCheckBase.some((p) => brandRe.test(p)))) return false
  return true
}

export interface ComposerOpts {
  spec?: Pick<BlankSpec, 'brand' | 'weightNote' | 'stretch' | 'material' | 'fit' | 'neck' | 'sleeve' | 'dye' | 'unisex'> | null
  garmentFamily?: ComposerGarmentFamily
  /** The blank brand copy may name (brand_in_copy) — null for Gildan-class blanks. */
  allowedBrand?: string | null
  /** Audience of the BLANK (kids_tee ⇒ kids). Defaults to ihAudienceOf(garmentFamily); a caller
   *  whose garmentFamily is a title GUESS passes null explicitly — audience is never title-inferred. */
  audience?: 'kids' | 'adult' | null
  /** THIS design's own resolved audience lean (Task 5, 2026-09-06) — never a new source: the
   *  per-design caller (`buildItemHighlightsPerDesign`) resolves it via the SAME
   *  `resolveDesignAudienceLean` the title path uses. Absent/undefined (every caller before Task 5,
   *  and the single-design path today) ⇒ the forced-gender rule never fires, byte-identical. */
  audienceLean?: TruthAudienceLean | null
  /** THIS design's own name/identity tokens — the forced-gender rule's design-own-name exemption
   *  (Task 5). NEVER the family-wide union titles/bullets/backend use: a sibling's name must stay
   *  foreign here, the same discipline Task 1's per-design partition already enforces. */
  designTokens?: readonly string[]
}

/** The composer's null stages — the caller maps them to a PO-facing hold reason.
 *  `under-floor-no-repeat` (Task 6, 2026-09-06): the absolute no-repeat rule (not a thin pool) is
 *  why the floor was missed — see `repeatBlocked` at both call sites below. */
export type ComposerNullStage = 'unrated-pool' | 'too-few-candidates' | 'too-few-picked' | 'under-floor-after-pad' | 'under-floor-no-repeat'
export interface ComposerResult {
  line: string | null
  stage: ComposerNullStage | null
}

/** FIX ROUND 1 (#1, PO-controller ruling 2026-09-06): `repeatBlocked` used to fire the instant ANY
 *  Tier-B candidate merely fit the remaining budget — not when a repeat would actually have reached
 *  the floor. Reproduced against unmodified HEAD 7fc05ae: pool ['retro sunset vibes','coastal palm
 *  energy','retro palm','retro cactus'] has exactly one Tier-B candidate that fits budget ('retro
 *  cactus'), so the old flag fired and named `under-floor-no-repeat` — but the best ANY repeat-
 *  permitting selection can reach on that pool is 53 chars, nowhere near the 107 floor. The Task 6
 *  repro pool (crewneck/fall-sweatshirts/…) is the control case: a repeat-permitting selection there
 *  really does reach 122 chars, so `under-floor-no-repeat` is correct for it.
 *
 *  This shadow pass is the fix: one cheap, deterministic greedy walk over the SAME already-filtered
 *  `candidates` (novelty check, truth stage, legal door already applied) plus the spec fact bank,
 *  admitting a candidate through the SAME `admitCandidate` gate the real loop uses, `allowRepeat:
 *  true` (Tier A or B — only "adds nothing new" is excluded, matching Task 2's pre-Task-6 admission
 *  rule). It answers exactly one question — "could a repeat-permitting selection reach MIN?" — and
 *  is discarded immediately after; it never writes to the real `picked`/`usedFolded` and cannot
 *  change a single shipped byte.
 *
 *  FIX WAVE 2 (I-1): now enforces the SAME pick cap, char budget, Amazon ≤2-per-word cap and
 *  brand-once rule as the real loop, via `admitCandidate` — the class of mis-attribution this
 *  finding closes (the shadow used to answer "reachable" using more repeats or more picks than the
 *  real loop, even with repeats permitted, could ever actually admit; see the `summer`/pick-cap pins
 *  in itemHighlightComposer.test.ts). Deliberately STILL excludes garment-surface-variety ordering —
 *  see the note on `admitCandidate` above for why that one is correctly out of scope. */
function shadowRepeatReachesFloor(
  candidates: readonly ComposerPoolRow[],
  basePicked: readonly string[],
  baseUsedFolded: ReadonlySet<string>,
  spec: ComposerOpts['spec'],
  min: number,
  max: number,
  brandRe: RegExp | null,
  brandPick: string | null,
): boolean {
  const picked = [...basePicked]
  const used = new Set(baseUsedFolded)
  let len = picked.reduce((n, p, i) => n + p.length + (i ? 2 : 0), 0)
  const tryAdd = (phrase: string, folded: readonly string[]) => {
    if (len >= min) return
    if (!admitCandidate(phrase, folded, used, true, picked, len, max, picked, brandRe, brandPick)) return
    len += (picked.length ? 2 : 0) + phrase.length
    picked.push(phrase)
    folded.forEach((w) => used.add(w))
  }
  for (const c of candidates) {
    if (len >= min) break
    const phrase = titleCasePhrase(c.keyword)
    if (!basePicked.includes(phrase)) tryAdd(phrase, significantFolded(c.keyword))
  }
  const factFillers = spec ? [
    spec.material || '', spec.fit ? `${spec.fit} Fit` : '', spec.unisex === true ? 'Unisex Fit' : '',
    spec.neck || '', spec.sleeve || '', spec.dye ? `${spec.dye} Fabric` : '',
  ].filter(Boolean) : []
  for (const f of factFillers) tryAdd(titleCasePhrase(f), significantFolded(f))
  return len >= min
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
    // Task 5: both undefined on every pre-Task-5 caller ⇒ the forced-gender rule stays a no-op,
    // byte-identical to before.
    audienceLean: opts?.audienceLean ?? null,
    designTokens: opts?.designTokens,
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
  const why = { pool: pool.length, ratedShare: Math.round(ratedShare * 100), requireFit, needBrand, afterFit: 0, candidates: 0, picked: 0, lineLen: 0, truthDrops, repeatBlocked: false }
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

  // TASK 6 (2026-09-06, PO "No Repeat as per Amazon Ruules"): Task 2's Tier-B FALLBACK pass is
  // DELETED here, not gated behind a constant — only Tier A (every significant token new) ever
  // composes. The existing two-pass order is otherwise unchanged: first prefer candidates
  // introducing a NEW garment surface (the variety craft), then fill remaining budget with any
  // novel candidate. `tierBFitBudgetSeen` is set (never cleared) the moment a candidate that WOULD
  // have fit the budget classifies Tier B — a RAW signal, cheap to compute inline; it plays no part
  // in selection and is NOT itself the hold-reason decision (FIX ROUND 1, #1 below gates it on
  // whether a repeat-permitting selection would actually have reached the floor).
  let tierBFitBudgetSeen = false
  for (const preferNewGarment of [true, false]) {
    for (const c of candidates) {
      if (picked.length >= MAX_PICKED_PHRASES || lineLen() >= AIM) break
      const phrase = titleCasePhrase(c.keyword)
      if (picked.includes(phrase) || phrase === brandPick) continue
      const folded = significantFolded(c.keyword)
      const tier = classifyTier(folded, usedFolded)
      if (tier === 'B' && lineLen() + (picked.length ? 2 : 0) + phrase.length <= MAX) tierBFitBudgetSeen = true
      const gm = c.keyword.match(GARMENT_SURFACE_RE)?.[0]?.toLowerCase().replace(/[-\s]/g, '').replace(/s$/, '')
      if (preferNewGarment && gm && usedGarmentSurfaces.has(gm)) continue
      if (preferNewGarment && !gm) continue
      // FIX WAVE 2 (I-1): the tier/budget/≤2-cap/brand-once checks below used to be hand-copied here
      // AND (incompletely) in the shadow pass — now ONE `admitCandidate` gate for both, `allowRepeat:
      // false` here so only tier 'A' is ever admitted (the absolute rule, unchanged in effect).
      if (!admitCandidate(phrase, folded, usedFolded, false, picked, lineLen(), MAX, withBrand(picked), brandRe, brandPick)) continue
      picked.push(phrase)
      folded.forEach((w) => usedFolded.add(w))
      if (gm) usedGarmentSurfaces.add(gm)
    }
  }
  // A pool-sourced brand phrase IS a pool pick for the viability count; the spec phrase is not.
  // TASK 6 FIX ROUND 1 (#1): when the shortfall is the absolute no-repeat rule rejecting content
  // that would have cleared this gate, name that — not the generic "pool too thin" reason — so the
  // PO sees the true cause. But only when a repeat-permitting selection would ACTUALLY have reached
  // the floor (the shadow pass): `tierBFitBudgetSeen` alone over-fires (Important #1's reproduction —
  // a Tier-B candidate can fit the remaining budget while still leaving the line far under 107).
  if (picked.length + (brandFromPool ? 1 : 0) < MIN_CANDIDATES) {
    why.picked = picked.length
    const repeatBlocked = tierBFitBudgetSeen &&
      shadowRepeatReachesFloor(candidates, withBrand(picked), usedFolded, opts?.spec, CONTENT_CONTRACT.itemHighlights.min, CONTENT_CONTRACT.itemHighlights.max, brandRe, brandPick)
    why.repeatBlocked = repeatBlocked
    return nullOut(repeatBlocked ? 'under-floor-no-repeat' : 'too-few-picked')
  }
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
    // TASK 2: same tier order as the pool loop above — a filler that merely repeats a token the
    // line ALREADY SHOWS (pool phrases / brand / the wear-fact) loses its priority-order slot to a
    // later, non-repeating filler whenever that non-repeating one alone can still reach the floor.
    // Tier is judged against `usedBeforePad` — a SNAPSHOT taken here, before this bank's own picks
    // start accumulating — not the live `usedFolded`. These six facts are independent spec truths,
    // not competing keyword candidates: `fit` ("Relaxed Fit") and `unisex` ("Unisex Fit") share only
    // the literal word "Fit" this bank's own templates append to both, and living off the live set
    // would wrongly read "Unisex Fit" as a repeat OF "Relaxed Fit" the instant this same loop had
    // just added it — demoting a PO-mandated fact (2026-08-06: unisex sizing must be explicit when
    // true) below a lower-priority filler ("Crew Neck") for no reason a customer would recognize as
    // "repetition". A pool phrase repeating pool/brand/wear-fact vocabulary (a real customer-visible
    // repeat) still correctly falls to Tier B against this snapshot.
    const usedBeforePad = new Set(usedFolded)
    // TASK 6: the same absolute rule as the pool loop above — Tier B (vs. the FROZEN `usedBeforePad`
    // snapshot, so the exemption in the comment above is untouched) is deleted, not gated. A spec
    // fact that repeats a POOL token is still rejected outright; `tierBFitBudgetSeen` is the SAME
    // composer-wide raw signal the pool loop sets (one signal, read once below via the shadow pass).
    for (const f of factFillers) {
      if (lineLen() >= MIN) break
      const phrase = titleCasePhrase(f)
      if (picked.includes(phrase)) continue
      const folded = significantFolded(f)
      if (!folded.some((w) => !usedFolded.has(w))) continue           // must add something new (live)
      const tier = classifyTier(folded, usedBeforePad)
      if (tier === 'B' && lineLen() + 2 + phrase.length <= CONTENT_CONTRACT.itemHighlights.max) tierBFitBudgetSeen = true
      if (tier !== 'A') continue                                      // absolute: no repeat, even vs. the pad snapshot
      if (lineLen() + 2 + phrase.length > CONTENT_CONTRACT.itemHighlights.max) continue
      if (ihRepeatViolations([...picked, phrase].join(', ')).length > 0) continue
      picked.push(phrase)
      folded.forEach((w) => usedFolded.add(w))
    }
  }
  why.picked = picked.length; why.lineLen = lineLen()
  // TASK 6 FIX ROUND 1 (#1): same shadow-gated naming as the too-few-picked gate above — the
  // absolute no-repeat rule, not a thin pool/spec, is why the floor was missed, but only when a
  // repeat-permitting selection would ACTUALLY have reached MIN (see shadowRepeatReachesFloor).
  if (lineLen() < MIN) {
    const repeatBlocked = tierBFitBudgetSeen &&
      shadowRepeatReachesFloor(candidates, picked, usedFolded, opts?.spec, MIN, CONTENT_CONTRACT.itemHighlights.max, brandRe, brandPick)
    why.repeatBlocked = repeatBlocked
    return nullOut(repeatBlocked ? 'under-floor-no-repeat' : 'under-floor-after-pad')
  }

  // Trademark door on the final bytes (defense in depth — candidates are already door-clean, but
  // the wear-fact / brand / filler joins and future edits must never reopen it).
  return { line: scrubTrademarks(picked.join(', ')), stage: null }
}
