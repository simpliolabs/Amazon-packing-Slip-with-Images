/**
 * selection-core.ts — THE one ranking-target membership predicate (KEYWORD_TARGET_SET).
 * ─────────────────────────────────────────────────────────────────────────────────────
 * ROOT CAUSE THIS EXISTS TO FIX (B0GF49RLDL, 2026-07-23). Tier membership is pure arithmetic on
 * `opportunityScore` (engine.ts:310-325), and `opportunityScore` is PRESENCE-AMPLIFIED:
 *
 *     opportunityScore = rawScore × presence.usageGapMultiplier ÷ 3.0     (calculateScore.ts:176-179)
 *
 * The gap multiplier pays a permanent up-to-3× premium for keywords we do NOT cover. So on a
 * Valentine/Cupid tee, "art teacher clothes" (5,331/mo) scores 53 and lands CRITICAL, while
 * "comfort colors tshirt" (306,496/mo) scores 14 and sits in DEFENDED — the model systematically
 * ranks irrelevance ABOVE relevance. No relevance classifier can out-argue that arithmetic, which
 * is mechanically why RELEVANCE_THEME_V2 (PRs #441/#442) caught ZERO on a live forced re-research.
 *
 * THE SPLIT OF RESPONSIBILITY (project doctrine: LLMs judge, code measures):
 *   - An LLM rater assigns each keyword ONE ordinal `themeFit` 0-3 against a persisted theme card.
 *     That is a JUDGMENT and it lives in themeRater.ts.
 *   - `selectRankingTargets` is a PURE, SYNCHRONOUS, TOTAL function. Zero I/O, zero LLM, zero
 *     network, zero clock, zero randomness, zero env reads, no mutation of its input. Same input ⇒
 *     byte-identical output, forever. Membership, counts, quotas and ordering are MEASURABLE, so
 *     code decides them. The env flag and the logging live at the `resolveRankingTargets` boundary.
 *
 * WHY `targetScore` IS NOT `opportunityScore`: it is rebuilt from RAW MARKET MATH with the usage-gap
 * multiplier structurally ABSENT — see the deliberate omissions in `TargetInput` below. That absence
 * is the whole fix, and it is enforced by the TYPE SYSTEM rather than by a comment somebody can
 * later "helpfully" undo.
 *
 * NO CYCLES: imports only pure leaf helpers (two scoring curves, two niche predicates, one seasonal
 * predicate). Must NEVER import from listingPipeline, cacheService, or any route.
 */

import { logNorm, competitionScore } from './calculateScore'
import { isForeignKeyword, isOffNicheKeyword } from './nicheGuards'
import { seasonRelation } from './seasonalTerms'

/* ── CONSTANTS (ONE home per budget — Invariant 5, no magic numbers at call sites) ────────────── */

/** How many ranking targets a listing gets. PO-locked 2026-07-23 ("selects 30 it can scale").
 *
 *  READ THIS BEFORE ASSUMING 30 CUSTOMER-FACING TARGETS — the 24-vs-30 confusion has bitten twice.
 *  `TARGET_SLOTS.BACKEND` (6) is RING-FENCED for off-season terms whenever any exist, because those
 *  terms can live nowhere but backend bytes. So on a listing WITH off-season supply the visible-copy
 *  budget is 30 − 6 = 24; with none, all 30 are customer-facing. That is the intended trade, not a
 *  shortfall. */
export const RANKING_TARGET_COUNT = 30

/** How many stored rows every consumer must READ so all 30 targets are always inside its window.
 *  Callers historically used 50/100/150 — four different LIMITs meant four different truths. Since
 *  targets sort FIRST and |targets| ≤ 30 ≤ this, every caller sees all 30.
 *
 *  THIS IS A CONVENTION, NOT AN ENFORCED CONTRACT — there is no runtime assertion, and an earlier
 *  draft of this comment claimed otherwise. It is load-bearing: `persistedIsComplete`'s saturation
 *  test is sound ONLY because targets sort first. A caller that orders by something else (say
 *  `opportunity_score`) and happens to catch rank 1 but not 2..N passes both contiguity and
 *  saturation, and ships a one-keyword target set. So every call site MUST use
 *  `.order('selection_rank', { ascending: true, nullsFirst: false })` and a limit of at least this
 *  constant. Pinned by `§P PRECONDITION` in the test suite. */
export const RANKING_CANDIDATE_POOL = 120

/** Slot quotas. PO-locked 14/10/6.
 *  CORE     = the design's own subject/occasion — what the shopper is actually buying.
 *  CATEGORY = universal-to-the-garment revenue (garment nouns, fit/fabric, "graphic tees for women").
 *  BACKEND  = structurally unplaceable in customer-facing copy (seasonal), backend bytes only. */
export const TARGET_SLOTS = { CORE: 14, CATEGORY: 10, BACKEND: 6 } as const

/** Ordinal band → score weight. Band 0 is 0.00 but is ALSO hard-gated, so the weight is belt-and-braces. */
export const THEME_BAND_WEIGHT: readonly number[] = [0.0, 0.45, 0.85, 1.0]

/** Applied to an incumbent target BEFORE the band multiplier, so incumbency can never rescue an
 *  off-theme keyword (band 0 zeroes it) but does damp churn among genuine near-ties. */
export const INCUMBENCY_BONUS = 2.0

/** ABSOLUTE-VOLUME BACKSTOP. The top N keywords by RAW search volume that survive the DETERMINISTIC
 *  nets are ALWAYS targets — computed BEFORE the band gate, so a rater run that flatlines every row
 *  to band 0 (the AI-quota-outage shape) still cannot cost the listing its biggest legitimate
 *  traffic. A deterministic net enforcing a measurable property, per doctrine.
 *  It guarantees MEMBERSHIP, never POSITION — ranks always reflect targetScore. */
export const RANKING_VOLUME_BACKSTOP = 8

/** PROVEN-PERFORMER FLOOR. A keyword this ASIN already ranks for is relevant BY EVIDENCE.
 *  Applied 1→2 ONLY, never 0→2 — see `effectiveBand`. */
export const PROVEN_RANK_FLOOR = 30

// Fail fast at import time if the quotas ever drift from the target count.
if (TARGET_SLOTS.CORE + TARGET_SLOTS.CATEGORY + TARGET_SLOTS.BACKEND !== RANKING_TARGET_COUNT) {
  throw new Error(
    `[selection-core] TARGET_SLOTS must sum to RANKING_TARGET_COUNT (${RANKING_TARGET_COUNT}); got ` +
      `${TARGET_SLOTS.CORE + TARGET_SLOTS.CATEGORY + TARGET_SLOTS.BACKEND}`,
  )
}

/* ── TYPES ───────────────────────────────────────────────────────────────────────────────────── */

/** 3 CORE · 2 CATEGORY-UNIVERSAL · 1 GENERIC · 0 OFF-PRODUCT. An ordinal BAND, not a float:
 *  a median over bands is stable run-to-run, a median over floats is not. */
export type ThemeBand = 0 | 1 | 2 | 3

export type TargetSlot = 'CORE' | 'CATEGORY' | 'BACKEND'

export type SelectionMode = 'off' | 'shadow' | 'on'

/** Why the selector produced a degenerate verdict. `null` = a real selection ran.
 *  ANY non-null guard makes `resolveRankingTargets` fail OPEN to the call site's legacy list. */
export type TargetGuard = null | 'empty-input' | 'no-eligible'

/**
 * NOTE WHAT IS DELIBERATELY ABSENT — this is the fix, expressed as a type:
 *   - NO `inTitle` / `inBullets` / `inDescription` / `inBackend` / `usageGapMultiplier`
 *   - NO `opportunityScore`
 * The selector CANNOT see the usage-gap multiplier, so it cannot reward us for NOT covering a
 * keyword — which is the entire fix.
 *
 * HONEST SCOPE OF THE INVARIANCE (do not overstate this in review): `actionType` IS a presence
 * signal in disguise — `deriveActionType` returns DEFENDED iff `inTitle && inBullets`
 * (calculateScore.ts:236) — and it is admitted for exactly ONE narrow use, the 1→2 proven floor.
 * So the guarantee is precisely:
 *   - GUARANTEED: covering a keyword can never make it a target. A band-0 row stays band 0 for ever,
 *     so the self-reinforcing "we cover it ⇒ it's a target ⇒ keep covering it" loop is closed.
 *   - NOT GUARANTEED: a band-1 row we newly cover in BOTH title and bullets becomes DEFENDED and is
 *     floored 1→2 (weight 0.45→0.85), which can move its rank and, at the margin, its membership.
 *     That is a deliberate trade: a GENERIC-looking keyword we demonstrably rank for and cover
 *     deserves category treatment. It is bounded, one-directional, and cannot manufacture an
 *     off-theme target.
 *
 * `keywordSales` is DELIBERATELY NOT evidence of our performance: engine.ts:153 sets it from SQP
 * `totalPurchaseCount` — market-wide purchases across ALL ASINs — and engine.ts:194 sets the
 * Jungle Scout proxy from `relevancyScore / 5`. It is a MARKET statistic (35 of the 100 points of
 * `marketScore`) and is nearly always > 0, so using it as a proven-performer signal would floor
 * essentially every row to band 2 and silently disable the band-0 gate entirely.
 */
export interface TargetInput {
  keyword: string
  searchVolume: number
  /** MARKET-wide sales for the keyword. Feeds `marketScore` ONLY — never the proven floor. */
  keywordSales: number
  competingProducts: number
  /** THIS ASIN's organic rank. Feeds the 1→2 proven floor only. */
  organicRank: number | null
  /** Read ONLY by the 1→2 proven floor (DEFENDED). Never rewritten by this module. */
  actionType: string
  themeFit: ThemeBand | null
  themeAbout: string | null
  /** Previous selection_rank, for the incumbency damper only. */
  prevSelectionRank: number | null | undefined
}

/** Listing-level context. `haystack` and `isApparel` are REQUIRED because `isOffNicheKeyword`
 *  documents that callers MUST gate on apparel and SHOULD pass the listing copy — without them the
 *  predicate's own escape hatches invert (a genuine activewear listing loses all its activewear
 *  terms; a listing whose own brand is Gildan loses all its own-brand terms). Omitting them would
 *  make this module a THIRD, stricter definition of off-niche than the scorer and the RANK panel. */
export interface SelectionContext {
  /** Listing copy used for the own-brand / activewear / own-cut rescues. Pass '' only if genuinely unknown. */
  haystack: string
  /** When false, the apparel-only niche nets are skipped entirely. */
  isApparel: boolean
  /**
   * Canonical occasions this DESIGN is itself about — `seasonsIn(themeCard)`. Drives the on-season
   * vs off-season split (PO 2026-07-23):
   *   - A Valentine design's own `valentine*` keywords are ON-season ⇒ classified CORE/CATEGORY and
   *     placeable in customer-facing copy. This is what fixes "Valentine not in the description".
   *   - `christmas shirt` on that same design is OFF-season ⇒ BACKEND, exactly as before.
   * EMPTY ARRAY = the design has no seasonal theme ⇒ every seasonal keyword is off-season, which is
   * the historical blanket-strip behaviour preserved byte-for-byte.
   */
  designSeasons: readonly string[]
}

export interface TargetVerdict<T extends TargetInput> {
  source: 'selector'
  targets: T[]
  rankOf: ReadonlyMap<string, number>
  /** The CLASSIFIED slot (what the keyword IS), never the quota bucket it happened to land in. */
  slotOf: ReadonlyMap<string, TargetSlot>
  reasonOf: ReadonlyMap<string, string>
  /** Stable content hash of the ORDERED target keyword list — the parity oracle across all sites. */
  sha: string
  guard: TargetGuard
  slotCounts: Record<TargetSlot, number>
  bands: { b0: number; b1: number; b2: number; b3: number }
  eligibleCount: number
  /** How many net-survivors the volume backstop covered (≤ RANKING_VOLUME_BACKSTOP). Nearly always
   *  saturated, so it is a health check, not a signal. */
  backstopCount: number
  /** How many band-0 rows the backstop OVERRODE — i.e. rows the gate would otherwise have dropped.
   *  THIS is the number that answers "is the backstop doing real work in production, or is it
   *  inert?", because it is non-zero only when the deterministic net contradicted the raters. */
  rescuedCount: number
}

/* ── FLAG (call-time env read — coverage-core.ts:157 pattern) ─────────────────────────────────── */

/** Read at CALL TIME, server-side, so a Coolify env change + restart flips behaviour with no
 *  rebuild. Never module scope (a module-scope read freezes at import), never NEXT_PUBLIC_
 *  (commit 8581e63: a build-time-inlined flag reads ON in the UI while dead-code-eliminated in the
 *  bundle). Unknown/unset ⇒ 'off' ⇒ production byte-identical to today.
 *
 *  SERVER-ONLY BY CONSTRUCTION. `process.env.KEYWORD_TARGET_SET` is not NEXT_PUBLIC_, so in a
 *  client bundle it is undefined and this returns 'off' — which is why the CLIENT MUST NEVER call
 *  it. The client renders membership from the server-computed `selectionRank` on the row via
 *  `isRankingTarget`, which needs no env at all. */
export function selectionMode(): SelectionMode {
  const v = (typeof process === 'undefined' ? '' : process.env.KEYWORD_TARGET_SET || '').toLowerCase()
  return v === 'on' || v === 'shadow' ? v : 'off'
}

/** THE membership predicate — safe on server AND client, because it reads only the row.
 *  Ranks are 1-based and dense; 0, NaN, negatives and non-integers are all NOT targets, so a
 *  consumer that carelessly writes `if (row.selection_rank)` can never disagree with this. */
export function isRankingTarget(r: { selectionRank?: number | null }): boolean {
  const n = r.selectionRank
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= RANKING_TARGET_COUNT
}

/* ── PURE HELPERS ────────────────────────────────────────────────────────────────────────────── */

/** Separator for the sha input. An explicit \u0000 escape, NOT a literal control byte: a literal
 *  NUL in source is invisible to every reviewer and any formatter that normalises control
 *  characters would rewrite it, changing every sha at once and making the parity oracle — whose one
 *  job is detecting mismatch — report a permanent FALSE mismatch. It must be a character that
 *  cannot occur inside a keyword, so a space would collide (keywords contain spaces). */
const SHA_SEP = '\u0000'

/** Stable 32-bit FNV-1a of the ordered keyword list, as 8 lowercase hex. Pure and isomorphic on
 *  purpose (no node:crypto) so this module stays safe to import from a client component.
 *  Used only to ask "did two call sites produce the SAME ordered list?" within one request. */
export function selectionSha(keywords: readonly string[]): string {
  let h = 0x811c9dc5
  const s = keywords.join(SHA_SEP)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Coerce anything non-finite to 0. TargetInput's `number` types are compile-time only; a NULL
 *  column, a JSON `null`, or a failed parse all arrive as NaN at runtime and NaN poisons both the
 *  score and the comparators. */
function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

/**
 * Raw market attractiveness, 0-100. This is calculateScore's `rawScore` with the jungle_scout
 * weight profile (wV 45 / wS 35 / wC 20) and — critically — WITHOUT `presence.usageGapMultiplier`.
 * The two curves are IMPORTED from calculateScore, never re-implemented: a second copy of the
 * volume curve is exactly how this repo grew seven disagreeing definitions of "covered".
 *
 * Why the JS weight profile for every row: rank-momentum (wR) is SQP-only and is a PRESENCE signal
 * in disguise (it measures the impressions/clicks this ASIN already gets). Including it would
 * re-introduce through the back door the very presence-amplification this module exists to remove,
 * and would make SQP-instrumented listings select a different target set than JS-only ones.
 */
export function marketScore(k: Pick<TargetInput, 'searchVolume' | 'keywordSales' | 'competingProducts'>): number {
  return (
    logNorm(num(k.searchVolume), 6) * 45 +
    logNorm(num(k.keywordSales), 4) * 35 +
    competitionScore(num(k.competingProducts)) * 20
  )
}

/**
 * Resolve the effective band.
 *   - unrated (null) ⇒ 2. Unrated is NOT off-theme.
 *   - band 0 is returned UNTOUCHED. The proven floor deliberately cannot lift 0→2: `actionType`
 *     DEFENDED means `inTitle && inBullets` (calculateScore.ts:236), i.e. pure presence, so a 0→2
 *     rescue would let our own copy re-admit an off-theme keyword, which would then instruct the
 *     generators to keep covering it — a self-reinforcing loop through the one channel
 *     `TargetInput` swears is closed.
 *   - band 1 ⇒ 2 when this ASIN already ranks for it, or it is DEFENDED. That is evidence, and a
 *     GENERIC-looking keyword we demonstrably rank for deserves category treatment.
 */
export function effectiveBand(k: TargetInput): ThemeBand {
  const raw: ThemeBand = k.themeFit ?? 2
  if (raw === 0) return 0
  const rank = k.organicRank
  const proven =
    (typeof rank === 'number' && Number.isFinite(rank) && rank > 0 && rank <= PROVEN_RANK_FLOOR) ||
    k.actionType === 'DEFENDED'
  return proven && raw < 2 ? 2 : raw
}

/** Final ranking score. Incumbency is added BEFORE the band multiplier so it can damp churn among
 *  near-ties without ever rescuing an off-theme keyword (band 0 multiplies the whole thing to 0). */
export function targetScore(k: TargetInput): number {
  const incumbent = typeof k.prevSelectionRank === 'number' && Number.isFinite(k.prevSelectionRank)
  const base = marketScore(k) + (incumbent ? INCUMBENCY_BONUS : 0)
  return base * (THEME_BAND_WEIGHT[effectiveBand(k)] ?? 0)
}

/** Total order. V8's sort is not guaranteed stable across engines and equal scores are dense at the
 *  tail, so every comparison falls through to the keyword itself. The `Number.isFinite` guard
 *  matters: `NaN !== 0` is TRUE, so returning a NaN difference would skip the tiebreak and let the
 *  engine coerce it to +0 — silently reinstating input-array order. */
function byScoreThenKeyword(a: TargetInput, b: TargetInput): number {
  const d = targetScore(b) - targetScore(a)
  if (Number.isFinite(d) && d !== 0) return d
  return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0
}

function byVolumeThenKeyword(a: TargetInput, b: TargetInput): number {
  const d = num(b.searchVolume) - num(a.searchVolume)
  if (Number.isFinite(d) && d !== 0) return d
  return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0
}

/**
 * CLASSIFICATION, not placement.
 *
 * OFF-SEASON first: a holiday that is NOT this design's own is stripped from customer-facing copy
 * by six of seven generators, so treating it as customer-facing manufactures a dock no regenerate
 * can clear. ON-SEASON terms — a Valentine design's own `valentine*` keywords — classify normally
 * and ARE placeable; that is the PO-approved fix for "Valentine not in the description".
 *
 * Computed from the SHARED `seasonRelation` so the selector and the generators cannot drift.
 */
function slotFor(keyword: string, band: ThemeBand, designSeasons: readonly string[]): TargetSlot {
  if (seasonRelation(keyword, designSeasons) === 'off-season') return 'BACKEND'
  return band === 3 ? 'CORE' : 'CATEGORY'
}

/* ── THE SELECTOR ────────────────────────────────────────────────────────────────────────────── */

/**
 * Pick the ranking targets. PURE, SYNCHRONOUS, TOTAL. Does not read env. Does not mutate `rows`.
 *
 * Order of operations (each step independently unit-tested):
 *   1. deterministic nets  — foreign / off-niche (apparel-gated, context-aware) ⇒ ineligible
 *   2. volume backstop     — top N by RAW volume among net-survivors, computed BEFORE the band gate
 *                            so a flatlined rater run still cannot strip the listing's best traffic
 *   3. band resolve        — themeFit ?? 2, then the 1→2 proven floor (never 0→2)
 *   4. band gate           — band 0 ⇒ ineligible, UNLESS the row is a backstop member
 *   5. classify slot       — OFF-season ⇒ BACKEND · band 3 ⇒ CORE · else CATEGORY. An ON-season row
 *                            (the design's OWN occasion) classifies CORE/CATEGORY and is placeable.
 *   6. quota fill          — by targetScore desc with a lexicographic tiebreak; backstop members are
 *                            guaranteed MEMBERSHIP but never a better POSITION than their score earns
 *   7. reason              — deterministic prose from the path actually taken
 */
export function selectRankingTargets<T extends TargetInput>(
  rows: readonly T[],
  ctx: SelectionContext,
): TargetVerdict<T> {
  const bands = { b0: 0, b1: 0, b2: 0, b3: 0 }
  const reasonOf = new Map<string, string>()
  const rankOf = new Map<string, number>()
  const slotOf = new Map<string, TargetSlot>()
  const slotCounts: Record<TargetSlot, number> = { CORE: 0, CATEGORY: 0, BACKEND: 0 }

  const degenerate = (guard: TargetGuard): TargetVerdict<T> => ({
    source: 'selector', targets: [], rankOf, slotOf, reasonOf,
    sha: selectionSha([]), guard, slotCounts, bands, eligibleCount: 0,
    backstopCount: 0, rescuedCount: 0,
  })

  if (!rows || rows.length === 0) return degenerate('empty-input')

  // ── step 1: deterministic nets (the LLM proposes, the filter disposes) ──
  const survivors: T[] = []
  for (const row of rows) {
    if (isForeignKeyword(row.keyword)) {
      reasonOf.set(row.keyword, 'foreign-language duplicate — not a ranking target')
      continue
    }
    // nicheGuards documents that callers MUST gate on apparel and SHOULD pass the listing copy;
    // without both, its own-brand / activewear / own-cut rescues invert.
    if (ctx.isApparel && isOffNicheKeyword(row.keyword, { context: ctx.haystack })) {
      reasonOf.set(row.keyword, 'off-niche (equipment / wholesale / competitor blank) — not a ranking target')
      continue
    }
    survivors.push(row)
  }
  if (survivors.length === 0) return degenerate('no-eligible')

  // ── step 2: volume backstop — BEFORE the band gate, which is the whole point ──
  const backstop = new Set<string>(
    survivors.slice().sort(byVolumeThenKeyword).slice(0, RANKING_VOLUME_BACKSTOP).map((r) => r.keyword),
  )

  // ── steps 3-5: band, gate, classify ──
  const eligible: { row: T; band: ThemeBand; slot: TargetSlot; rescued: boolean }[] = []
  for (const row of survivors) {
    const band = effectiveBand(row)
    bands[`b${band}` as 'b0' | 'b1' | 'b2' | 'b3']++
    const rescued = band === 0 && backstop.has(row.keyword)
    if (band === 0 && !rescued) {
      const about = row.themeAbout ? `: ${row.themeAbout}` : ''
      reasonOf.set(row.keyword, `off-theme${about} — pooled for backend indexing, not a ranking target`)
      continue
    }
    eligible.push({ row, band, slot: slotFor(row.keyword, band, ctx.designSeasons), rescued })
  }
  if (eligible.length === 0) return degenerate('no-eligible')

  // ── step 6: quota fill ──
  // The bucket a row CONSUMES is an internal counter; the slot we PERSIST is always the CLASSIFIED
  // slot from `slotFor`. So the label always tells the truth: BACKEND means "off-season — this
  // keyword can only ever live in backend bytes", and migration 049 keys the dock exemption and the
  // RANK-panel ADD suppression off exactly that meaning.
  const remaining: Record<TargetSlot, number> = { ...TARGET_SLOTS }
  // ASYMMETRIC BY DESIGN, one way only:
  //   - A customer-facing row MAY consume a spare BACKEND bucket. Without this the 6 BACKEND buckets
  //     would be reachable only by off-season rows and an ordinary listing would be hard-capped at
  //     24 targets while the constant promises 30.
  //   - An OFF-SEASON row may NEVER consume a CORE/CATEGORY bucket. Six of seven generators strip
  //     off-season terms from customer-facing copy, so an unbounded off-season set would manufacture
  //     a dock no regenerate can clear. It does not fit ⇒ it is simply not selected.
  const CASCADE: Record<TargetSlot, TargetSlot[]> = {
    CORE: ['CORE', 'CATEGORY', 'BACKEND'],
    CATEGORY: ['CATEGORY', 'CORE', 'BACKEND'],
    BACKEND: ['BACKEND'],
  }

  const taken = new Set<string>()
  const chosen: { row: T; slot: TargetSlot; rescued: boolean }[] = []

  const place = (e: { row: T; band: ThemeBand; slot: TargetSlot; rescued: boolean }): void => {
    if (taken.has(e.row.keyword) || chosen.length >= RANKING_TARGET_COUNT) return
    for (const bucket of CASCADE[e.slot]) {
      if (remaining[bucket] > 0) {
        remaining[bucket]--
        taken.add(e.row.keyword)
        chosen.push({ row: e.row, slot: e.slot, rescued: e.rescued }) // CLASSIFIED slot, not `bucket`
        return
      }
    }
  }

  // RESERVATION PASS. Off-season rows claim their BACKEND buckets BEFORE customer-facing rows may
  // cascade into them. Without this, a listing with >24 strong customer-facing keywords consumes all
  // 6 BACKEND buckets on score alone and ends up with ZERO off-season targets — trading the only
  // slots those terms can ever occupy for a 25th keyword that is already eligible for title and
  // bullets. Reservation is bounded by TARGET_SLOTS.BACKEND, so it cannot starve the visible copy.
  const offSeasonByScore = eligible
    .filter((e) => e.slot === 'BACKEND')
    .sort((a, b) => byScoreThenKeyword(a.row, b.row))
  for (const e of offSeasonByScore) place(e)

  // Backstop members claim membership first so a misfiring rater run cannot cost the listing its
  // biggest legitimate traffic — but `chosen` is re-sorted by score below, so claiming membership
  // early never buys a better RANK than the score earns.
  const ordered = eligible.slice().sort((a, b) => byScoreThenKeyword(a.row, b.row))
  for (const e of ordered) if (backstop.has(e.row.keyword)) place(e)
  for (const e of ordered) place(e)

  // ── step 7: rank by score (membership ≠ position), then slot + deterministic reason ──
  chosen.sort((a, b) => byScoreThenKeyword(a.row, b.row))

  const targets: T[] = []
  chosen.forEach((c, i) => {
    const rank = i + 1
    targets.push(c.row)
    rankOf.set(c.row.keyword, rank)
    slotOf.set(c.row.keyword, c.slot)
    slotCounts[c.slot]++
    reasonOf.set(
      c.row.keyword,
      c.rescued
        ? `volume backstop (${num(c.row.searchVolume).toLocaleString('en-US')}/mo) — rated off-theme but too large to abandon · ${c.slot} rank ${rank}/${RANKING_TARGET_COUNT}`
        : `${c.slot} rank ${rank}/${RANKING_TARGET_COUNT} — market ${marketScore(c.row).toFixed(1)} × theme ${(THEME_BAND_WEIGHT[effectiveBand(c.row)] ?? 0).toFixed(2)}`,
    )
  })

  // Eligible-but-not-selected rows get an honest reason too, so the Intelligence tab can always
  // explain itself. "We ran out of slots" is a very different message from "off-theme".
  // Distinguish the two very different ways a row can miss: the overall budget was spent, or its
  // OWN slot filled while budget remained. An off-season term that lost a 6-wide bucket is nowhere near
  // rank 30, and telling the seller it "ranked outside the top 30" would be simply false.
  for (const e of eligible) {
    if (taken.has(e.row.keyword)) continue
    const slotFull = remaining[e.slot] === 0
    reasonOf.set(
      e.row.keyword,
      slotFull && chosen.length < RANKING_TARGET_COUNT
        ? `eligible (${e.slot}) but the ${e.slot} quota of ${TARGET_SLOTS[e.slot]} was already full — still indexed via backend terms`
        : `eligible (${e.slot}) but outside the top ${RANKING_TARGET_COUNT} — still indexed via backend terms`,
    )
  }

  return {
    source: 'selector',
    targets,
    rankOf,
    slotOf,
    reasonOf,
    sha: selectionSha(targets.map((t) => t.keyword)),
    guard: null,
    slotCounts,
    bands,
    eligibleCount: eligible.length,
    backstopCount: backstop.size,
    rescuedCount: eligible.filter((e) => e.rescued).length,
  }
}

/* ── LEGACY PARITY ───────────────────────────────────────────────────────────────────────────── */

/**
 * VERBATIM behavioural copy of the four-bucket concat that is today's `topOpportunities`.
 *
 * SCOPE — this rule is used at exactly TWO sites, verified line by line:
 *   - engine.ts:310-325
 *   - app/api/fba/intelligence/[asin]/route.ts:156-169   (a literal copy-paste twin)
 * It is NOT the rule at syncKeywordIntelligence.ts:173/258 (`slice(0, 25)` over merge order) or
 * :464. Those sites keep their own thunks; substituting this one there would BREAK `off`
 * byte-identity at two of the highest-traffic write paths.
 *
 * Deliberately a DIFFERENT generic constraint from TargetInput: it needs `opportunityScore`, which
 * TargetInput does not have and must never have.
 */
export function legacyTierBuckets<T extends { actionType: string; opportunityScore: number }>(
  analyzed: readonly T[],
): T[] {
  const criticalAll = analyzed
    .filter((a) => a.actionType === 'CRITICAL')
    .slice()
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
  const criticalCapped =
    criticalAll.length <= 5
      ? criticalAll
      : criticalAll.filter((a) => a.opportunityScore >= 50).slice(0, 10).length >= 5
        ? criticalAll.filter((a) => a.opportunityScore >= 50).slice(0, 10)
        : criticalAll.slice(0, 5)

  const top = (t: string) =>
    analyzed.filter((a) => a.actionType === t).slice().sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10)

  return [...criticalCapped, ...top('UPGRADE'), ...top('REINFORCE'), ...top('DEFENDED')]
}

/* ── THE RESOLVER (the impure boundary: env, logging, fail-open) ──────────────────────────────── */

/**
 * Is a persisted selection trustworthy? A truncated read window must never win over a recompute.
 *
 * The test is CONTIGUITY FROM 1, not a count against `RANKING_TARGET_COUNT`. Ranks are written dense
 * 1..N, so `[1..N]` present with no gaps and no duplicates proves we are holding the WHOLE set —
 * whatever N the writer legitimately produced. Comparing against the raw constant instead would
 * reject every complete-but-smaller selection (a thin pool, or a listing whose seasonal supply caps
 * the BACKEND bucket) and silently fall back to recomputing over each caller's own LIMIT window —
 * exactly the write/read disagreement this branch exists to prevent.
 */
function persistedIsComplete(ranks: readonly number[], poolSize: number): boolean {
  if (ranks.length === 0) return false
  if (ranks.length > RANKING_TARGET_COUNT) return false
  if (!ranks.every((r) => Number.isInteger(r) && r >= 1 && r <= RANKING_TARGET_COUNT)) return false
  const sorted = ranks.slice().sort((a, b) => a - b)
  if (!sorted.every((r, i) => r === i + 1)) return false
  // PREFIX-TRUNCATION GUARD. Contiguity alone is not enough: targets sort FIRST, so a caller whose
  // LIMIT lands below the target count sees exactly ranks 1..k — perfectly contiguous, silently a
  // partial set.
  //
  // The test is SATURATION, not window size. Because targets sort first, the window can only have
  // cut into the target block if EVERY row it returned is a target. Conversely, the presence of a
  // single NON-target row proves the reader got past the whole block and is therefore holding all
  // of it — whatever N the writer produced.
  //
  // Window size cannot decide this in either direction, which is why it is not used here: a caller
  // reading 120 rows cannot truncate a ≤30-row block at all, while the callers that historically
  // read 50 or 100 are exactly the ones that can. And a large pool may legitimately yield far fewer
  // than 30 targets (thin visible supply + heavy off-season supply), so "short set in a big window"
  // is not evidence of truncation either.
  //
  // Fully-saturated windows recompute. That is cheap (the pool is by definition tiny) and safe.
  return ranks.length < poolSize
}

/**
 * The ONE resolver every consumer calls. At `off`/`shadow` it returns the call site's OWN legacy
 * verdict (passed in, so each site keeps its exact today-baseline); at `on` it returns the targets.
 *
 * FAIL-OPEN IS ABSOLUTE. Any degenerate verdict — empty input, nothing eligible, or a persisted
 * selection that fails validation and a recompute that also comes back degenerate — returns LEGACY,
 * never an empty list. This is the anti-shape of the incident where an AI-quota outage silently
 * persisted an EMPTY pool over approved copy.
 *
 * Emits the parity-oracle line at every site in every mode INCLUDING `on` — deliberately unlike
 * TITLE_COUNCIL_V3, which early-returns at listingPipeline.ts:2668 and goes dark after the flip,
 * making post-flip regression unmeasurable.
 */
export function resolveRankingTargets<T extends TargetInput & { selectionRank?: number | null }>(
  rows: readonly T[],
  opts: {
    legacy: (r: readonly T[]) => T[]
    site: string
    ctx: SelectionContext
    inputAsin?: string
    resolvedAsin?: string
  },
): T[] {
  const mode = selectionMode()
  // Defensive copies: `readonly T[]` is erased at runtime and the four legacy thunks being replaced
  // are sort-heavy. An in-place sort inside a thunk would otherwise permanently reorder the
  // caller's array — and the selector would then see a different input than the legacy path did.
  const legacy = opts.legacy(rows.slice())
  if (mode === 'off') return legacy

  // Prefer the PERSISTED selection (written by storeAnalysis over the FULL pool) when it is
  // complete. Recomputing here would run over whatever LIMIT window this caller happens to have and
  // could disagree with the write-time verdict.
  const persisted = rows.filter((r) => isRankingTarget(r))
  const persistedRanks = persisted.map((r) => r.selectionRank as number)
  const usePersisted = persistedIsComplete(persistedRanks, rows.length)

  let next: T[]
  let guard: TargetGuard = null
  // Both counters describe the RECOMPUTE path only — a persisted read runs no selection, so they
  // stay 0 when `persisted:true`. Any dashboard must filter on `persisted:false` or it will read
  // "backstop inert" from rows where the backstop simply never ran.
  let backstopCount = 0
  let rescuedCount = 0
  if (usePersisted) {
    next = persisted.slice().sort((a, b) => {
      const d = (a.selectionRank as number) - (b.selectionRank as number)
      if (Number.isFinite(d) && d !== 0) return d
      return a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0
    })
  } else {
    const v = selectRankingTargets(rows.slice(), opts.ctx)
    next = v.targets
    guard = v.guard
    backstopCount = v.backstopCount
    rescuedCount = v.rescuedCount
  }

  const failOpen = guard !== null || next.length === 0

  console.log(
    JSON.stringify({
      tag: 'KW_TARGET_SET',
      site: opts.site,
      inputAsin: opts.inputAsin ?? null,
      resolvedAsin: opts.resolvedAsin ?? null,
      mode,
      persisted: usePersisted,
      guard,
      failOpen,
      nPool: rows.length,
      nLegacy: legacy.length,
      nNext: next.length,
      // COVERAGE figure, not a signal: it is min(RANKING_VOLUME_BACKSTOP, survivors), so it reads 8
      // on essentially every real pool. It says the backstop RAN, never that it MATTERED.
      nBackstopCovered: backstopCount,
      // The meaningful one: band-0 ratings the backstop OVERRODE. Non-zero only when the
      // deterministic net contradicted the raters. NOTE it is 0 for a merely mis-rated band-1 row —
      // the backstop can be load-bearing with nRescued === 0, so do not read it as "backstop idle".
      nRescued: rescuedCount,
      shaLegacy: selectionSha(legacy.map((r) => r.keyword)),
      shaNext: selectionSha(next.map((r) => r.keyword)),
    }),
  )

  if (failOpen) return legacy
  return mode === 'on' ? next : legacy
}
