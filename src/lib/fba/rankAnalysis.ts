/**
 * "Rank Top of Amazon" — Competitive Rank Analyst (task #87, B3). Pure orchestration (no Next types).
 * ─────────────────────────────────────────────────────────────────────────────
 * Increment 3: the FREE stored-core (0 JS credits, 0 OpenAI) + the deterministic baseline verdict +
 * the honest-framing constants + the banned-phrase validator. The SOV enrichment (§3) and the full-5
 * council (§4) are added in later increments.
 *
 * HONESTY MODEL: the deterministic baseline verdict + the post-judge `sanitize()` validator — NOT the
 * LLM — are what guarantee nothing over-promises rank. Content relevance is ONE A10 factor; ranking #1
 * also needs reviews / conversion / sales velocity / price, which this tool cannot change.
 */
import type OpenAI from 'openai'
import { createHash } from 'node:crypto'
import { getStoredAnalysis, computeOutcomeSignals } from '@/lib/keyword-engine'
import { selectionMode, isRankingTarget } from '@/lib/keyword-engine/selection-core'
import { readWindow } from '@/lib/keyword-engine/selectionContext'
import { isWithinBudget } from '@/lib/keyword-engine/cacheService'
import { deriveActionType } from '@/lib/keyword-engine/calculateScore'
import { makeCoverageChecker } from '@/lib/keyword-engine/coverage'
// COHERENCE Invariant 2/6: at COVERAGE_CORE=on the RANK panel decides coverage LIVE from the child's
// OWN twin rows via the shared field-agnostic predicate (same one Intelligence + the scorer use) — no
// stale stored-flag OR. =off is byte-identical to today.
import { coverageMode, coverageAcrossRows } from '@/lib/keyword-engine/coverage-core'
import { loadListingRowsForPresence } from '@/lib/keyword-engine/loadListingContent'
import { isOffNicheKeyword } from '@/lib/keyword-engine/nicheGuards'
import { fetchShareOfVoice } from '@/lib/sync/jungleScoutClient'
import { createAdminClient } from '@/lib/supabase/server'

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

// ─── Types (spec §5) ──────────────────────────────────────────────────────────
export type SovStatus = 'not_run' | 'ok' | 'no_data'
export type CompetitionStatus = 'not_run' | 'ok' | 'js_disabled' | 'budget_exhausted' | 'no_sov_data'
export type ActionType = 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED' | 'OPTIMIZED'

export interface RankPlaybookRow {
  keyword: string
  volume: number
  /** Internal gap-amplified placement composite (0-100, engine `coverageGapScore`). Kept on the row
   *  for the composite FALLBACK display only — it swings with our own coverage (52→19 after a push),
   *  so it must never be presented as market data (PO data-truth rule 2026-08-08). */
  coverageGapScore: number
  /** NATIVE market opportunity, 0-10 (poolOpportunityScore from JS fields only) — THE displayed
   *  "opp" number and the top-10 sort key. null = not measured (SQP/import rows, pre-054 rows):
   *  the panel then shows the composite with a `~` prefix so a fabricated number is never
   *  mistaken for market data. */
  marketOpportunity: number | null
  actionType: ActionType
  youCover: boolean
  coveredIn: string[]                 // ['title','bullets','description','backend'] or ['(live content)']
  contentAction: string               // what CONTENT can do — sanitize()-clamped, never "rank #1"
  nonContentReality: string           // '' unless competition ran AND a real lever applies
  topCompetitorBrand: string | null   // SOV winner brand; null if not run / empty-string brand
  theirShare: number | null           // 0..100 — SHARE AMONG TOP RETURNED LISTINGS (not market share)
  sellerVisible: boolean | null       // in this keyword's top returned listings; null = not measured
  sovStatus: SovStatus
  priority: number                    // 1..N (deterministic fallback: rankOpportunityKey desc)
  /** Outcome loop (#89): SQP share movement since the last monthly snapshot. Absent/null until ≥2 months of
   *  history exist (insufficient_data → null). `text` is server-authored + sanitize()-clamped and only ever
   *  asserts correlation ("rose AFTER a change"), NEVER causation. */
  shareSignal?: { direction: 'rose' | 'flat' | 'fell'; text: string } | null
}

export interface RankVerdict {
  headline: string
  contentCanDo: string[]
  contentCannotDo: string[]
  honestNote: string
  indexedCoverage: string
  criticalGaps: number
}

export interface RankAnalysisResult {
  analyzed: boolean
  reason?: 'no_keywords'              // the unresolvable case is an HTTP-404 {error}, NOT a result shape
  asin: string
  parentAsin: string | null
  analyzedAt: string
  competitionRan: boolean
  competitionStatus: CompetitionStatus
  creditsSpent: number
  coverage: { covered: number; total: number }
  rows: RankPlaybookRow[]
  verdict: RankVerdict
  councilFailedOpen: boolean
  stale?: boolean
}

// ─── Canonical honest-framing constants (spec §7) — the floor that ships even with all LLMs down ──
export const CONTENT_CAN_DO = [
  'Get every high-opportunity keyword indexed in your title/bullets/backend',
  'Win relevance on thin-competition long-tail terms',
  'Pull proven UPGRADE keywords into the title (higher ranking weight)',
  'Defend the terms you already cover',
]
export const CONTENT_CANNOT_DO = [
  "Customer reviews — a top ranking factor; copy can't add them",
  'Conversion rate & CTR — driven by images, price, reviews',
  'Sales velocity — the dominant rank driver Amazon rewards',
  'Price competitiveness & retail-readiness (in-stock, Buy Box)',
]
export const HONEST_NOTE = 'This tool optimizes content relevance — one A10 ranking factor. It does not and cannot promise a #1 organic rank.'

// ─── Banned-phrase validator (spec §4) — the REAL honesty guarantee, not the LLM ──────────────────
// Fails CLOSED on the over-promise FAMILY (not an enumerated phrase list). The source is shared but
// kept as TWO regexes: BANNED (non-global) for .test() predicates, BANNED_G (global) for exhaustive
// replace — a global regex's lastIndex is stateful across .test() calls, so they MUST stay separate.
// Sentence-bounded ([^.]{0,N}) so a match never crosses a period.
const BANNED_SRC = [
  '\\brank\\w*\\b[^.]{0,20}\\b(?:#?1|number\\s*one|top|first)\\b',   // "rank #1", "ranking first", "rank you at the top"
  '\\b(?:#?1|number\\s*one|top|first)\\b[^.]{0,20}\\brank\\w*\\b',   // "#1 ranked", "top ranking"
  '\\boutrank\\w*\\b',
  '\\bbeat\\b[^.]{0,20}\\bcompetitor',
  '\\bdominat\\w*\\b',
  '\\btop\\s+of\\s+amazon\\b',
  '\\b(?:page|pg)\\s*(?:one|1)\\b',
  '\\bfirst\\s+page\\b',
  '\\bbest[\\s-]?seller\\b',
  '\\bguarantee\\w*\\b[^.]{0,25}\\b(?:rank|#?1|top|first|page|sell)',
  '\\b(?:top|first)\\s+(?:spot\\s+|position\\s+)?(?:of|on|in)\\s+(?:the\\s+)?(?:search|results|amazon|page)',
].join('|')
const BANNED = new RegExp(BANNED_SRC, 'i')
const BANNED_G = new RegExp(BANNED_SRC, 'gi')

/** True if the string makes ANY rank / page / best-seller over-promise. */
export function isOverPromise(s: string): boolean { return BANNED.test(s) }

/** Strip EVERY over-promise clause (GLOBAL, looped to a fixed point). For copy WE author ourselves
 *  (the deterministic baseline headline + contentAction), which reads cleanly after the strip. */
export function sanitize(s: string): string {
  let out = s
  for (let i = 0; i < 5 && BANNED.test(out); i++) out = out.replace(BANNED_G, 'become indexed & competitive')
  return out
}

/** For LLM-authored copy (judge headline / per-row realities): a substring splice can garble a sentence,
 *  so if the LLM tripped an over-promise we DROP the whole string ('') and let the caller fall back to the
 *  deterministic baseline — fail closed, never show mangled or sneaky copy. */
export function cleanLlm(s: string): string { return isOverPromise(s) ? '' : s.trim() }

/**
 * Top-10 sort key (PO data-truth rule 2026-08-08): NATIVE market opportunity leads; a row without
 * native data falls back to its gap composite. PURE, exported for tests.
 * Scale note: marketOpportunity is 0-10 (JS niche-score model, ~7+ strong) and the composite is
 * 0-100 (~70+ strong) — ×10 puts both on one nominal 0-100 axis so a mixed pool (JS rows + SQP/
 * import rows) still sorts deterministically. The fallback is a display-marked approximation
 * (`~` in the panel), not market data.
 */
export function rankOpportunityKey(r: { marketOpportunity: number | null; coverageGapScore: number }): number {
  return r.marketOpportunity != null ? r.marketOpportunity * 10 : r.coverageGapScore
}

/** Top-10 comparator: market opportunity desc; among equal keys, UNCOVERED first (winnable) — the
 *  2026-08-08 fix: the previous inline tie-break `Number(!a.youCover) - Number(!b.youCover)` sorted
 *  COVERED first, inverted against its own "prefer uncovered" comment. PURE, exported for tests. */
export function rankRowCompare(
  a: { marketOpportunity: number | null; coverageGapScore: number; youCover: boolean },
  b: { marketOpportunity: number | null; coverageGapScore: number; youCover: boolean },
): number {
  return (rankOpportunityKey(b) - rankOpportunityKey(a)) || (Number(!b.youCover) - Number(!a.youCover))
}

// ─── Free core (spec §2) ──────────────────────────────────────────────────────
export interface FreeCore {
  analyzed: boolean
  reason?: 'no_keywords'
  rows: RankPlaybookRow[]
  top10: RankPlaybookRow[]
  coverage: { covered: number; total: number }
  criticalGaps: number
  contentFingerprint: string
  baselineVerdict: RankVerdict
}

// EXPORTED for tests (pure rule). COHERENCE HARDENING (2026-08-08): this function must NEVER assert a
// presence it wasn't handed. `action_type` is a research-time snapshot (and deriveActionType's score>=20
// fallback labels ZERO-presence keywords UPGRADE), so the old "UPGRADE ⇒ present" / "DEFENDED ⇒ covered"
// branches produced the live contradiction "✗ icon + PROMOTE — present" in one table row. `youCover` is
// the ONE coverage decision (the same one that draws the icon) and every presence claim now gates on it.
export function contentActionFor(actionType: ActionType, youCover: boolean, inTitle: boolean, isTarget?: boolean, slot?: string | null): string {
  // IRRELEVANT first — the keyword was classified as off-product (different niche, e.g. Star Wars
  // father's-day terms surfacing under a retirement-tee research). Adding it dilutes relevance.
  // (PO 2026-06-14: the previous "OPTIONAL — weave into bullets/backend if natural" fallback was
  // telling the seller to ADD off-product keywords — exactly the opposite of correct advice.)
  // Cast to string: 'IRRELEVANT' is a runtime actionType (used in page.tsx + audit pipeline) but
  // not yet in the ActionType union here; extending the union is a wider refactor not needed for
  // this user-facing copy fix.
  if ((actionType as string) === 'IRRELEVANT') return 'SKIP — off-product (different niche). Do NOT add — it would dilute your relevance.'
  // KEYWORD_TARGET_SET (#143). Two SKIP branches, both preventing advice the seller cannot act on:
  //   - NOT A TARGET: the selector did not pick this keyword, so telling the seller to add it is
  //     advice against our own ranking plan. The row stays VISIBLE (it is still indexed via backend
  //     bytes) but it is never presented as a gap.
  //   - BACKEND SLOT: a target that is structurally unplaceable in customer-facing copy (an
  //     off-season holiday). An ADD here is a task no regenerate can ever complete — the exact
  //     "regenerate that regeneration can't fix" anti-pattern the scorer was already cured of.
  if (isTarget === false) return 'SKIP — not a ranking target for this design (still indexed via your backend terms)'
  if (slot === 'BACKEND') return 'BACKEND — off-season for this design; it lives in your search terms, not the visible copy'
  if ((actionType === 'CRITICAL' || actionType === 'UPGRADE' || actionType === 'DEFENDED') && !youCover) return 'ADD — high-opportunity term not yet in your copy'
  if (actionType === 'UPGRADE' && !inTitle) return 'PROMOTE — present, pull into the title (higher weight)'
  if (actionType === 'DEFENDED') return "DEFEND — you're covered here; hold it"
  if (youCover) return 'COVERED — content job done here; rank now depends on non-content levers'
  return 'OPTIONAL — lower-opportunity; weave into bullets/backend if natural'
}

/** =on DISPLAY re-derivation (Invariant 6): ONE decision at ONE freshness — the badge re-derives from
 *  the SAME live per-field flags that drew the ✓/✗ icon. Stored action_type stays untouched for the
 *  engine. PURE, exported for tests.
 *   • IRRELEVANT passes through: it is a relevance classification, not a presence one. Relevance
 *     authority lives in the classifier — any re-research/storeAnalysis rewrites action_type from a
 *     fresh classification, at which point this passthrough stops matching. Re-deriving IRRELEVANT
 *     rows from presence would relabel off-product keywords CRITICAL/"ADD" (the #203 / PO-2026-06-14
 *     regression the SKIP branch exists to prevent).
 *   • COVERED-ELSEWHERE guard (adversarial MEDIUM 2026-08-08): the shared ladder has no branch for
 *     "covered only in description/backend" (or covered cross-field with every flag false) — score>=50
 *     there derives CRITICAL, i.e. a red CRITICAL badge beside a green ✓ in the STANDARD post-push
 *     state (backend is the sanctioned keyword home, Invariant 3). Coverage anywhere is coverage
 *     (Invariant 2): a covered keyword is never presented as a gap tier — it maps to DEFENDED
 *     ("hold it"). Guarded at THIS call site only, so the engine's research-time derivation (scorer
 *     docking, generateActions) is untouched.
 *   • KNOWN BIAS (adversarial medium-low, accepted + documented): `score` is the STORED gap-AMPLIFIED
 *     composite — it embeds the research-time usageGapMultiplier (1.0–3.0), and getStoredAnalysis
 *     cannot un-amplify it (the breakdown/rawScore is not persisted). A keyword covered at research
 *     stores ~raw/3, so if the copy later DROPS it, it re-derives UPGRADE (score>=20 fallback), not
 *     CRITICAL — coverage-REGRESSION rows under-tier vs a never-covered twin with identical market
 *     stats. Curing this needs a persisted rawScore (backlog), not a display patch. The inverse is
 *     safe: a stored CRITICAL implies stored score >= 50, which re-derives CRITICAL when live-uncovered.
 *   • SIBLING SURFACE (adversarial medium-low, tracked follow-up): the Intelligence tab still renders
 *     STORED action_type (route summary buckets + page.tsx badges), so RANK (live) and Intelligence
 *     (research-time) can disagree on one keyword until that surface re-derives from the same live
 *     coverageAcrossRows flags. */
export function deriveLiveActionType(
  storedActionType: string,
  score: number,
  cov: { covered: boolean; inTitle: boolean; inBullets: boolean; inDescription: boolean; inBackend: boolean },
): ActionType {
  if (storedActionType === 'IRRELEVANT') return storedActionType as ActionType
  const derived = deriveActionType(score, {
    inTitle: cov.inTitle,
    inBullets: cov.inBullets,
    coverageCount: [cov.inTitle, cov.inBullets, cov.inDescription, cov.inBackend].filter(Boolean).length,
  })
  return derived === 'CRITICAL' && cov.covered ? 'DEFENDED' : derived
}

export function buildBaselineVerdict(covered: number, total: number, criticalGaps: number): RankVerdict {
  // Denominator is the real row count, never a hard-coded "/10" (spec D2 fix).
  return {
    headline: sanitize(`Content makes you indexed & competitive on ${covered} of ${total} top terms. Reaching the top ALSO needs reviews, conversion, sales velocity, and price — levers this tool can't change.`),
    contentCanDo: CONTENT_CAN_DO,
    contentCannotDo: CONTENT_CANNOT_DO,
    honestNote: HONEST_NOTE,
    // SCOPE CUE (2026-08-08): this pill counts the FULL filtered pool; the table shows only the top 10
    // by market opportunity (which skews uncovered). Say "pool" so 48/66 + an all-✗ table reads as two
    // scopes, not a contradiction.
    indexedCoverage: `${covered} of ${total} pool keywords covered`,
    criticalGaps,
  }
}

/** Concatenate the listing family's live copy into one lowercased haystack. Matches `parent_asin = anchor
 *  OR asin = child` so a null/self-parented child (a known condition in this repo — PR #85) still includes
 *  its OWN row instead of producing an empty haystack. For the common non-null case this returns the same
 *  family rows the scorer reads (keyed on parent_asin). */
export async function buildHaystack(parentAsin: string | null, childAsin: string, supabase: AdminClient): Promise<string> {
  const anchor = parentAsin ?? childAsin
  try {
    const { data: rows } = await supabase
      .from('listing_content')
      .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
      .or(`parent_asin.eq.${anchor},asin.eq.${childAsin}`)
    return ((rows ?? []) as Record<string, string | null>[])
      .map((r) => [r.title, r.bullet_1, r.bullet_2, r.bullet_3, r.bullet_4, r.bullet_5, r.description, r.backend_keywords].filter(Boolean).join(' '))
      .join(' ').toLowerCase().replace(/\s+/g, ' ')
  } catch { return '' }
}

/**
 * THE fingerprint recipe. Extracted (#143) because it previously existed TWICE — here and inline in
 * buildFreeCore — under a comment reading "MUST match contentFingerprint()". Two copies of a hash
 * that must agree is a silent-drift hazard: if they diverge, every cached analysis reads stale
 * forever (permanent recompute) or fresh forever (permanently stale advice), and neither shows an error.
 *
 * FORMAT (2026-08-08): TWO sha1 halves joined by ':' — `sha1(coverageMode + haystack)` (the COPY
 * half) + ':' + `sha1(kwpool [+ kts])` (the POOL half). Exact-match staleness compares the whole
 * string; the halves exist so the GET refresh path can tell a POOL-ONLY move (heal restamp /
 * re-research — the old council headline still describes the live copy) from a REAL copy change
 * (headline must reset) — see sameCopyEpoch. KEYWORD_TARGET_SET's kts term is appended to the POOL
 * half ONLY at `on` (theme runs are a pool concern, not a copy one).
 *
 * Why theme_run_id belongs in the hash: without it, flipping the flag leaves every cached playbook
 * intact and the RANK panel keeps advising "ADD art teacher clothes" indefinitely after the selector
 * stopped treating it as a target — confidently and permanently wrong, with nothing to notice it.
 *
 * Why the keyword-POOL term belongs in the hash (2026-08-08, unconditional): the fingerprint used to
 * hash only listing_content, so flows that rewrite keyword_analysis WITHOUT touching the copy — a
 * fresh Intelligence re-research, the #521 market_opportunity heal-on-read backfill, #523 ease/
 * selection restamps — never invalidated a cached playbook: the panel kept serving the old
 * action_type / null marketOpportunity / old top-10 order indefinitely. Adding the term (and the
 * ':' format) changes every existing fingerprint ONCE on deploy — a one-shot 0-credit free-core
 * recompute per listing on its next GET (paid SOV/realities are carried forward by keyword in the
 * refresh path).
 */
async function fingerprintOf(haystack: string, themeRunId: string | null, poolStamp: string): Promise<string> {
  const copyHalf = createHash('sha1').update([coverageMode(), haystack].join('\n')).digest('hex')
  const poolParts = [`kwpool:${poolStamp}`]
  if (selectionMode() === 'on') poolParts.push(`kts:${themeRunId ?? 'none'}`)
  const poolHalf = createHash('sha1').update(poolParts.join('\n')).digest('hex')
  return `${copyHalf}:${poolHalf}`
}

/** True when a stored fingerprint shares the COPY half (coverageMode + haystack) with a fresh one —
 *  i.e. only the keyword-POOL half moved. Drives the council-headline carry in the GET refresh path.
 *  A legacy pre-format fingerprint (no ':') always reads false — failing toward a full reset, never
 *  toward keeping stale copy-describing prose. PURE, exported for tests. */
export function sameCopyEpoch(stored: string | null | undefined, fresh: string): boolean {
  return !!stored && stored.includes(':') && stored.split(':')[0] === fresh.split(':')[0]
}

/** Keyword-POOL staleness term: `count | max(analyzed_at) | count(market_opportunity) | irr:count`
 *  over the ASIN's keyword_analysis rows — moves on re-research (count/analyzed_at), on the #521
 *  market_opportunity backfill (mo count), on pool rewrites, AND on the ai-recommendations
 *  IRRELEVANT ratchet (irr count). The ratchet is the ONE pool rewrite that changes action_type
 *  without touching anything else this stamp hashes — without the irr term, a regen that marked
 *  keywords off-product left the cached playbook advising "ADD — high-opportunity term" on those
 *  same keywords indefinitely (adversarial HIGH 2026-08-08). The ratchet must NOT bump analyzed_at
 *  instead: that would defer the ease-restamp cooldown and interact with the stale-prune.
 *
 *  analyzed_at semantics (the sentence that used to live here claimed the OPPOSITE): every
 *  storeAnalysis — ease-restamp, native backfill, thin-pool promotion, re-research — DOES stamp
 *  `analyzed_at: runTs` on all rows (cacheService, both payload branches; it drives the stale-prune).
 *  That is the INTENDED invalidation channel: those heals change data this panel displays
 *  (marketOpportunity, selection ranks), so the cached playbook must recompute — a 0-credit
 *  free-core pass on the next GET. The GET refresh path keeps the PAID council headline across
 *  pool-only moves via sameCopyEpoch, so heal churn cannot wipe it.
 *
 *  Best-effort: a failed read retries once on the pre-055 projection (no market_opportunity column →
 *  the mo slot reads 'na') so re-research/ratchet detection stays alive on an unmigrated database;
 *  only a terminal failure yields the CONSTANT 'unavailable' (never a perpetual invalidation), and
 *  it warns once per process — a silently frozen stamp disables pool-staleness detection (the
 *  haystack half still invalidates on copy changes), which is exactly the "neither shows an error"
 *  hazard the fingerprint docstring cites. */
let poolStampWarnedOnce = false
async function keywordPoolStamp(childAsin: string, supabase: AdminClient): Promise<string> {
  type StampRow = { analyzed_at?: string | null; market_opportunity?: number | null; action_type?: string | null }
  const summarize = (rows: StampRow[], moMeasured: boolean): string => {
    let maxAt = ''
    let moCount = 0
    let irrCount = 0
    for (const r of rows) {
      if (r.analyzed_at && r.analyzed_at > maxAt) maxAt = r.analyzed_at
      if (r.market_opportunity != null) moCount++
      if (r.action_type === 'IRRELEVANT') irrCount++
    }
    return `${rows.length}|${maxAt || 'none'}|${moMeasured ? moCount : 'na'}|irr:${irrCount}`
  }
  const warnOnce = (detail: unknown) => {
    if (poolStampWarnedOnce) return
    poolStampWarnedOnce = true
    console.warn(`[rank-analysis] keywordPoolStamp unavailable (first seen on ${childAsin}) — pool-staleness detection is FROZEN until keyword_analysis reads recover (copy changes still invalidate):`, detail instanceof Error ? detail.message : detail)
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any   // market_opportunity: migration 055, not in generated types yet
    const { data, error } = await db.from('keyword_analysis').select('analyzed_at, market_opportunity, action_type').eq('asin', childAsin)
    if (!error) return summarize((data ?? []) as StampRow[], true)
    // Pre-055 database: the projection 42703s on market_opportunity on EVERY call. Retry without it
    // so the pool term keeps working there (count/analyzed_at/irr), instead of silently no-oping the
    // entire pool-staleness fix in that environment.
    const retry = await db.from('keyword_analysis').select('analyzed_at, action_type').eq('asin', childAsin)
    if (!retry.error) return summarize((retry.data ?? []) as StampRow[], false)
    warnOnce(retry.error?.message ?? error?.message)
    return 'unavailable'
  } catch (e) {
    warnOnce(e)
    return 'unavailable'
  }
}

/** The ASIN's newest theme_run_id, or null. Best-effort by design: a pre-049 database, a missing
 *  column or an unrated pool all yield null, which simply means the fingerprint carries no rating
 *  generation. Never an error, and never a reason to fail a page load. */
async function newestThemeRunId(childAsin: string, supabase: AdminClient): Promise<string | null> {
  if (selectionMode() !== 'on') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from('keyword_analysis')
      .select('theme_run_id')
      .eq('asin', childAsin)
      .not('theme_run_id', 'is', null)
      .order('theme_run_id', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data as { theme_run_id?: string | null } | null)?.theme_run_id ?? null
  } catch { return null }
}

/** sha1 of the live copy — the staleness key persisted with a cached analysis (cheap: 1 query + hash). */
export async function contentFingerprint(parentAsin: string | null, childAsin: string, supabase: AdminClient): Promise<string> {
  // Tag the fingerprint with the coverage MODE so flipping COVERAGE_CORE invalidates every cached rank
  // analysis: the cached rows were computed under the OLD predicate, so on flip the stored fingerprint
  // mismatches and the GET recomputes live under the new mode (self-healing cutover — no manual
  // "Re-check now" per listing). Rollback (on→off) re-invalidates the same way. KEYWORD_TARGET_SET
  // rides that same mechanism rather than inventing a second one.
  return fingerprintOf(
    await buildHaystack(parentAsin, childAsin, supabase),
    await newestThemeRunId(childAsin, supabase),
    await keywordPoolStamp(childAsin, supabase),
  )
}

/** FREE stored-core: top opportunity keywords × content coverage. 0 credits, 0 OpenAI. */
export async function buildFreeCore(childAsin: string, parentAsin: string | null, supabase: AdminClient): Promise<FreeCore> {
  // Compute the real coverage haystack + fingerprint FIRST, so even a no-keywords result carries a
  // meaningful fingerprint — sha1('') would flag the cached row stale forever (adversarial finding).
  // This APPROXIMATES the scorer's coverage haystack (same columns; parent_asin family + the child's own
  // row). NOTE: the scorer resolves the keyword_analysis ASIN via resolveKeywordAsin — a different 3-step
  // fallback than resolveToChildAsin — so the keyword SET can still differ on edge cases. Unifying those
  // resolvers is a tracked follow-up; this is NOT a byte-for-byte parity guarantee with the scorer.
  const haystack = await buildHaystack(parentAsin, childAsin, supabase)
  // ONE recipe, shared with contentFingerprint() — see fingerprintOf.
  const fingerprint = await fingerprintOf(haystack, await newestThemeRunId(childAsin, supabase), await keywordPoolStamp(childAsin, supabase))

  let kws = await getStoredAnalysis(childAsin, readWindow(100))
  if (!kws || kws.length === 0) {
    return { analyzed: false, reason: 'no_keywords', rows: [], top10: [], coverage: { covered: 0, total: 0 }, criticalGaps: 0, contentFingerprint: fingerprint, baselineVerdict: buildBaselineVerdict(0, 0, 0) }
  }

  // HARD audience lean (#203 symmetry, third site): under a seller-selected Male/Female,
  // the generators REFUSE opposite-gender keywords everywhere — so the rank playbook must
  // not present them as gaps to close. Live failure: the panel told the seller to "weave in"
  // 'mens comfort colors tshirt' and 'plain black tshirt men' on a FEMALE-selected listing —
  // a demand the regen is designed to never satisfy. lean_*/unisex keep both (cross-traffic
  // is the point of lean). KEEP IN SYNC with syncListingContent + listingPipeline regexes.
  try {
    const { data: leanRow } = await supabase
      .from('listing_seo_scores').select('*').eq('parent_asin', parentAsin ?? childAsin).maybeSingle()
    const al = (leanRow as { audience_lean?: string | null } | null)?.audience_lean
    if (al === 'male' || al === 'female') {
      const FEM_RE = /\bwom[ae]ns?\b|\bladies\b|\bfemale\b|\bgirls?\b/i
      const MASC_RE = /\bm[ae]ns?\b|\bmale\b|\bboys?\b/i
      kws = kws.filter((k) => {
        const fem = FEM_RE.test(k.keyword), masc = MASC_RE.test(k.keyword)
        return al === 'female' ? !(masc && !fem) : !(fem && !masc)
      })
      if (kws.length === 0) {
        return { analyzed: false, reason: 'no_keywords', rows: [], top10: [], coverage: { covered: 0, total: 0 }, criticalGaps: 0, contentFingerprint: fingerprint, baselineVerdict: buildBaselineVerdict(0, 0, 0) }
      }
    }
  } catch { /* lean read is best-effort — no filter on failure */ }

  // OFF-NICHE guard (2026-07-14, fourth site of the #203 symmetry): wrong-niche keywords — golf pegs
  // ("martini golf tees"), competitor blanks ("gildan t shirts"), wholesale ("plain t shirts"),
  // activewear ("oversized workout shirts"), foreign-language ("grafica tees women"), non-apparel
  // goods ("golf accessories") — must never appear as "ADD — high-opportunity term" advice on a
  // graphic SHIRT listing; the copy is designed to never satisfy them. Same predicate the scorer
  // skips with (nicheGuards — Invariant 1 discipline); apparel-gated, own-brand/activewear kept via
  // the live haystack as context.
  if (/\b(?:t-?shirts?|tshirts?|shirts?|hoodies?|sweatshirts?|apparel)\b/i.test(haystack)) {
    kws = kws.filter((k) => !isOffNicheKeyword(k.keyword, { context: haystack }))
    if (kws.length === 0) {
      return { analyzed: false, reason: 'no_keywords', rows: [], top10: [], coverage: { covered: 0, total: 0 }, criticalGaps: 0, contentFingerprint: fingerprint, baselineVerdict: buildBaselineVerdict(0, 0, 0) }
    }
  }

  // Legacy baseline check (coverage.ts kwToks over the family haystack): the production verdict at
  // =off and the "old" half of the =shadow diff. At =on it is SKIPPED entirely — the live
  // coverageAcrossRows verdict overwrites it anyway, so running it would be dead work by a second
  // tokenizer (Invariant 1). Delete the import once the flag is retired.
  const covMode = coverageMode()
  const check = covMode !== 'on' ? makeCoverageChecker(haystack) : null
  // At =on/=shadow, load the child's OWN twin rows ONCE and decide coverage LIVE via the shared
  // field-agnostic predicate. =off skips this query entirely (perf no-op).
  const liveRows = covMode !== 'off' ? await loadListingRowsForPresence(supabase, childAsin) : []

  // Outcome loop (#89): per-keyword SQP share movement since the last monthly snapshot. Best-effort — {} (so
  // every shareSignal is null) until ≥2 months of history accrue or if the snapshots table isn't migrated.
  const signals = await computeOutcomeSignals(childAsin, supabase).catch(() => ({}))

  const rows: RankPlaybookRow[] = kws.map((k) => {
    const flagCover = ([k.inTitle && 'title', k.inBullets && 'bullets', k.inDescription && 'description', k.inBackend && 'backend'].filter(Boolean)) as string[]
    let youCover = flagCover.length > 0
    let coveredIn = flagCover
    // Stale-flag fallback: presence flags are a snapshot; if all false, trust the LIVE token check.
    if (!youCover && check && check(k.keyword)) { youCover = true; coveredIn = ['(live content)'] }
    // COVERAGE_CORE (Invariant 2/6): at =on, coverage is decided LIVE from the child's own twin rows via
    // the shared field-agnostic predicate — stored flags are no longer a coverage source (only a cache),
    // and coveredIn becomes true per-field (drops the opaque '(live content)' sentinel). =shadow logs diffs.
    let inTitleLive = k.inTitle
    let actionType = k.actionType as ActionType
    if (covMode !== 'off') {
      const cov = coverageAcrossRows(k.keyword, liveRows)
      if (covMode === 'shadow') {
        if (cov.covered !== youCover) console.log(`[COVERAGE_DIFF] site=rank asin=${childAsin} kw=${JSON.stringify(k.keyword)} old=${youCover} new=${cov.covered}`)
      } else {
        youCover = cov.covered; coveredIn = cov.coveredIn; inTitleLive = cov.inTitle
        // ONE decision at ONE freshness — see deriveLiveActionType for the IRRELEVANT passthrough,
        // the covered-elsewhere guard, and the documented amplified-score bias.
        actionType = deriveLiveActionType(k.actionType as string, k.coverageGapScore, cov)
      }
    }
    // Author the honest share-movement line server-side + sanitize it (correlation only, never causation).
    const sig = (signals as Record<string, { direction: string; shareAfter: number | null; contentChangedBetween: boolean; nonContentBottleneck: boolean }>)[k.keyword.toLowerCase()]
    let shareSignal: RankPlaybookRow['shareSignal'] = null
    if (sig && sig.direction !== 'insufficient_data' && sig.shareAfter != null) {
      const pct = Math.round(sig.shareAfter)
      let text: string
      if (sig.direction === 'rose') {
        text = sig.contentChangedBetween ? `Share rose to ${pct}% after your last content change.` : `Share rose to ${pct}% (no content change in this window).`
      } else if (sig.nonContentBottleneck) {
        text = `Share ${sig.direction === 'fell' ? 'fell to' : 'flat at'} ${pct}% despite your last content change — rank now likely depends on reviews, price, and velocity, not more copy.`
      } else {
        text = `Share ${sig.direction === 'fell' ? 'fell to' : 'flat at'} ${pct}% (no content change in this window).`
      }
      shareSignal = { direction: sig.direction as 'rose' | 'flat' | 'fell', text: sanitize(text) }
    }
    return {
      keyword: k.keyword,
      volume: k.searchVolume,
      coverageGapScore: k.coverageGapScore,
      marketOpportunity: k.marketOpportunity ?? null,
      actionType,
      youCover,
      coveredIn,
      // isTarget is passed as `undefined` at off/shadow so the new SKIP branch cannot fire — the
      // panel's advice is byte-identical until the flag is on.
      contentAction: sanitize(contentActionFor(
        actionType, youCover, inTitleLive,
        selectionMode() === 'on' ? isRankingTarget({ selectionRank: k.selectionRank }) : undefined,
        selectionMode() === 'on' ? (k.selectionSlot ?? null) : null,
      )),
      nonContentReality: '',
      topCompetitorBrand: null,
      theirShare: null,
      sellerVisible: null,
      sovStatus: 'not_run' as SovStatus,
      priority: 0,
      shareSignal,
    }
  })

  // Top-10 by NATIVE market opportunity desc (rankOpportunityKey; composite fallback per-row only
  // when native is absent — PO 2026-08-08); among near-equal, prefer uncovered (winnable) — but a
  // low-opportunity-uncovered term never displaces a high-opportunity one (spec D3 fix).
  const top10 = [...rows].sort(rankRowCompare).slice(0, 10)

  const covered = rows.filter((r) => r.youCover).length
  const total = rows.length
  const criticalGaps = rows.filter((r) => !r.youCover && r.actionType === 'CRITICAL').length

  return { analyzed: true, rows, top10, coverage: { covered, total }, criticalGaps, contentFingerprint: fingerprint, baselineVerdict: buildBaselineVerdict(covered, total, criticalGaps) }
}

/** Map the FREE core (no council, no SOV) into the wire result the GET handler returns on a cache miss. */
export function freeCoreToResult(core: FreeCore, asin: string, parentAsin: string | null, analyzedAt: string): RankAnalysisResult {
  if (!core.analyzed) {
    return {
      analyzed: false, reason: 'no_keywords', asin, parentAsin, analyzedAt,
      competitionRan: false, competitionStatus: 'not_run', creditsSpent: 0,
      coverage: core.coverage, rows: [], verdict: core.baselineVerdict, councilFailedOpen: false, stale: false,
    }
  }
  const rows = core.top10.map((r, i) => ({ ...r, priority: i + 1 }))
  return {
    analyzed: true, asin, parentAsin, analyzedAt,
    competitionRan: false, competitionStatus: 'not_run', creditsSpent: 0,
    coverage: core.coverage, rows, verdict: core.baselineVerdict, councilFailedOpen: false, stale: false,
  }
}

// ─── Council (spec §4) — full-5: 3 analysts → GPT-5 adversary (prose) → GPT-5 judge (json) ──────────
// The council only ENRICHES: a sharper headline + an honest per-keyword "what it takes beyond content".
// The deterministic floor (CONTENT_CANNOT_DO / HONEST_NOTE / the can't-promise-rank guarantee) is
// IMMOVABLE — the LLM cannot weaken it, and sanitize() clamps every string it produces.

export interface RankContext { title: string }
export interface CouncilOutput { headline: string; realities: Record<string, string>; failedOpen: boolean }

/** Robust JSON extraction from an LLM response (mirrors listingPipeline.parseJsonLoose). */
function parseJsonLoose<T>(raw: string): T {
  let cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
  const first = cleaned.indexOf('{'); const last = cleaned.lastIndexOf('}')
  if (first > 0) cleaned = cleaned.slice(first)
  if (last >= 0 && last < cleaned.length - 1) cleaned = cleaned.slice(0, last + 1)
  try { return JSON.parse(cleaned) as T } catch { return JSON.parse(cleaned.replace(/,\s*([}\]])/g, '$1')) as T }
}

const isGpt5 = (m: string): boolean => /^(gpt-5|o\d)/.test(m)

function councilBrief(rows: RankPlaybookRow[], coverage: { covered: number; total: number }, criticalGaps: number, ctx: RankContext): string {
  const lines = rows.map((r, i) => {
    const cov = r.youCover ? `COVERED (${r.coveredIn.join('/')})` : 'NOT covered'
    // Competitor context only appears once SOV actually ran for this row (sovStatus 'ok').
    const comp = r.sovStatus === 'ok' && r.topCompetitorBrand
      ? `; top competitor ${r.topCompetitorBrand} ~${r.theirShare}% of clicks${r.sellerVisible === false ? ', you are NOT in its top listings' : r.sellerVisible ? ', you ARE in its top listings' : ''}`
      : ''
    // Data-truth (PO 2026-08-08): the LLM council must not be told a gap-amplified internal number
    // is "opportunity". Native = market data; fallback is explicitly labeled as our internal priority.
    const opp = r.marketOpportunity != null
      ? `market opportunity ${r.marketOpportunity}/10`
      : `internal gap priority ~${r.coverageGapScore}/100 (not market data)`
    return `${i + 1}. "${r.keyword}" — ${opp}, ${r.actionType}, ${cov}${comp}`
  }).join('\n')
  return `Product (live title): ${ctx.title}\nContent coverage: ${coverage.covered}/${coverage.total} top keywords; ${criticalGaps} high-opportunity gap(s).\n\nTop keyword playbook:\n${lines}`
}

/** Full-5 council. Returns an honest headline + keyword→reality map. Fails OPEN (failedOpen:true,
 *  empty payload) so the caller keeps the deterministic baseline verdict — never a half-built result.
 *  Per-call {timeout, maxRetries:0}; keepalives between stages (Cloudflare ~100s idle window). */
export async function runRankCouncil(openai: OpenAI, rows: RankPlaybookRow[], coverage: { covered: number; total: number }, criticalGaps: number, ctx: RankContext, onProgress?: (m: string) => void): Promise<CouncilOutput> {
  const COUNCIL_MODEL = process.env.RANK_COUNCIL_MODEL || process.env.BULLETS_COUNCIL_MODEL || process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
  const brief = councilBrief(rows, coverage, criticalGaps, ctx)
  const keywords = rows.map((r) => r.keyword)

  const askJson = async (system: string, user: string, temperature: number, model = 'gpt-4.1-mini', timeoutMs = 20_000): Promise<{ headline?: string; rows?: { keyword?: string; reality?: string }[] }> => {
    try {
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
      const r = await openai.chat.completions.create(
        isGpt5(model)
          ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' as const, response_format: { type: 'json_object' as const } }
          : { model, messages, temperature, max_tokens: 1500, response_format: { type: 'json_object' as const } },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      return parseJsonLoose(r.choices[0]?.message?.content || '{}')
    } catch { return {} }
  }
  const askText = async (system: string, user: string, model: string, timeoutMs: number): Promise<string> => {
    try {
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
      const r = await openai.chat.completions.create(
        isGpt5(model)
          ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' as const }
          : { model, messages, temperature: 0.3, max_tokens: 600 },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      return (r.choices[0]?.message?.content || '').trim()
    } catch { return '' }
  }

  const SHAPE = ' Return ONLY JSON: {"headline":"one honest sentence on what content CAN and CANNOT do for this listing\'s rank","rows":[{"keyword":"<exact keyword from the playbook>","reality":"one honest clause on what it takes BEYOND content to win this term"}]}. Cover each listed keyword once. NEVER promise or imply a rank/page/best-seller outcome — banned: "rank #1", "top of Amazon", "outrank", "beat competitors", "page one/first page", "best seller", "guaranteed". State only what content does (indexing, relevance) and name the non-content levers (reviews, sales velocity, conversion, price).'
  const personas: { sys: string; temp: number }[] = [
    { sys: 'You are an Amazon DEMAND analyst. For each keyword, weigh how winnable rank is via content vs how much depends on demand signals (reviews, sales velocity, conversion). Be concrete and honest.', temp: 0.4 },
    { sys: 'You are an Amazon SEO analyst. Separate genuine indexing gaps content can close from saturated terms where indexing is necessary but NOT sufficient. Name the realistic ceiling of content per keyword.', temp: 0.3 },
    { sys: 'You are a CONVERSION analyst. State honestly what BEYOND content (images, price, reviews, retail-readiness) must improve for the listing to convert traffic and earn rank.', temp: 0.4 },
  ]
  const drafts = (await Promise.all(personas.map((p) => askJson(p.sys + SHAPE, brief, p.temp)))).filter((d) => d && (d.headline || (d.rows && d.rows.length)))
  if (drafts.length === 0) return { headline: '', realities: {}, failedOpen: true }    // caller keeps the deterministic baseline

  onProgress?.('Rank council: analyst drafts in, adversary reviewing...')               // keepalive
  const numbered = drafts.map((d, i) => `Draft ${i + 1}: headline="${d.headline || ''}"\n` + (d.rows || []).map((row) => `   - ${row.keyword}: ${row.reality}`).join('\n')).join('\n\n')
  const critique = await askText(
    'You are a ruthless skeptic AND an honest Amazon consultant. Attack each draft for ANY over-promise: claims that content/keywords alone rank #1, "dominate", "outrank", "beat competitors", reach "top of Amazon", "page one/first page", or "best seller"; vague hand-waving; or ignoring that reviews, sales velocity, conversion, and price are the dominant NON-content rank levers. Flag every sentence that overstates what copy can do. Be specific per draft.',
    `${brief}\n\nAnalyst drafts:\n${numbered}\n\nCritique EACH draft, then state the single most honest framing across them.`,
    COUNCIL_MODEL, 60_000,
  )
  onProgress?.('Rank council: judge synthesizing the honest verdict...')                // keepalive
  const judged = await askJson(
    'You are the JUDGE. Synthesize ONE honest assessment that (a) credits what CONTENT can do (indexing, relevance, pulling proven terms into the title) and (b) is explicit that ranking #1 ALSO needs reviews, conversion, sales velocity, and price — which content cannot change.' + SHAPE,
    `${brief}\n\nAnalyst drafts:\n${numbered}\n\nSkeptic critique:\n${critique}\n\nReturn the single most honest synthesis.`,
    0.2, COUNCIL_MODEL, 60_000,
  )

  // LLM copy fails CLOSED: cleanLlm DROPS (returns '') any headline/reality that trips an over-promise
  // rather than splicing a fragment into a broken sentence. A dropped headline → caller falls back to the
  // deterministic baseline; a dropped reality → that row keeps its empty nonContentReality.
  const headline = cleanLlm(judged.headline || '')
  const realities: Record<string, string> = {}
  for (const row of judged.rows || []) {
    if (row && typeof row.keyword === 'string' && typeof row.reality === 'string') {
      // Only accept a reality keyed to an EXACT playbook keyword — the LLM can't inject invented terms.
      const match = keywords.find((k) => k.toLowerCase() === row.keyword!.toLowerCase())
      const reality = cleanLlm(row.reality)
      if (match && reality) realities[match] = reality
    }
  }
  if (!headline && Object.keys(realities).length === 0) {
    console.warn('[rank-council] judge empty or over-promising — failing open to the deterministic baseline')
    return { headline: '', realities: {}, failedOpen: true }
  }
  return { headline, realities, failedOpen: false }
}

// ─── SOV competition enrichment (spec §3) — opt-in, credit-bounded ──────────────────────────────────
export interface SovEnrichment {
  rows: RankPlaybookRow[]
  competitionRan: boolean
  competitionStatus: CompetitionStatus
  creditsSpent: number
}

/** Enrich the top playbook rows with Jungle Scout Share-of-Voice. Credit-safe by construction:
 *   • HARD CLAMP attempts to min(10, callsRemaining) — never exceeds the real remaining budget.
 *   • Re-gates budget BEFORE each call (concurrent usage can't push us over); never early-stops on [].
 *   • creditsSpent is the ACTUALLY-BILLED count (api_usage_this_month delta), bounded by attempts — so a
 *     mid-loop creds flip (fetchShareOfVoice returns [] WITHOUT billing once creds are invalidated) never
 *     reports credits we didn't spend, and competitionStatus follows real billing, not the attempt count.
 *   • theirShare is share of clicks AMONG the returned top listings — NOT market share. */
export async function enrichWithSov(
  rows: RankPlaybookRow[],
  childAsin: string,
  jsEnabled: boolean,
  onProgress?: (m: string) => void,
): Promise<SovEnrichment> {
  if (!jsEnabled) return { rows, competitionRan: false, competitionStatus: 'js_disabled', creditsSpent: 0 }
  const start = await isWithinBudget('jungle_scout')
  if (!start.allowed || start.callsRemaining <= 0) {
    return { rows, competitionRan: false, competitionStatus: 'budget_exhausted', creditsSpent: 0 }
  }
  const maxCalls = Math.min(10, start.callsRemaining)        // hard clamp — spec §3
  const out = rows.map((r) => ({ ...r }))
  let attempts = 0
  let anyData = false
  for (let i = 0; i < out.length && attempts < maxCalls; i++) {
    const b = await isWithinBudget('jungle_scout')           // re-gate per call (defensive vs concurrent use)
    if (!b.allowed) break
    onProgress?.(`Competition: checking "${out[i].keyword}" (${attempts + 1}/${maxCalls})...`)
    const competitors = await fetchShareOfVoice(out[i].keyword)
    attempts++
    if (competitors.length > 0) {
      const top = competitors.reduce((a, c) => (c.clicksShare > a.clicksShare ? c : a))
      out[i].topCompetitorBrand = top.brand || null
      out[i].theirShare = Math.round(top.clicksShare * 100)
      out[i].sellerVisible = competitors.some((c) => c.asin === childAsin)
      out[i].sovStatus = 'ok'
      anyData = true
    } else {
      out[i].sovStatus = 'no_data'                           // the call ran but returned no competitors
    }
  }
  // creditsSpent = ACTUALLY BILLED (real billing source delta), bounded by attempts so concurrent JS use
  // can't inflate it; competitionStatus is derived from real billing, never from the attempt count alone.
  const end = await isWithinBudget('jungle_scout')
  const creditsSpent = Math.min(attempts, Math.max(0, end.callsUsed - start.callsUsed))
  const competitionStatus: CompetitionStatus =
    attempts === 0 ? 'budget_exhausted'
      : creditsSpent === 0 ? 'js_disabled'                   // tried, but nothing billed → JS creds went away
        : anyData ? 'ok'
          : 'no_sov_data'
  return { rows: out, competitionRan: creditsSpent > 0, competitionStatus, creditsSpent }
}

/** Read a prior cached analysis result (for non-destructive free re-runs). null if none / table absent.
 *  Cast — listing_rank_analysis isn't in the generated types yet (migration 021). */
async function loadPriorAnalysis(childAsin: string, supabase: AdminClient): Promise<RankAnalysisResult | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    const { data } = await db.from('listing_rank_analysis').select('result').eq('child_asin', childAsin).maybeSingle()
    const result = data?.result as RankAnalysisResult | undefined
    return result && typeof result === 'object' && Array.isArray(result.rows) ? result : null
  } catch { return null }
}

/** POST orchestrator: free core → (opt-in SOV) → council → merged result. The council only sharpens the
 *  headline + adds per-row realities; the coverage/verdict floor stays deterministic. Returns the result
 *  + fingerprint to persist. */
export async function runCouncilAnalysis(
  openai: OpenAI,
  childAsin: string,
  parentAsin: string | null,
  ctx: RankContext,
  supabase: AdminClient,
  analyzedAt: string,
  opts: { withCompetition: boolean; jsEnabled: boolean; onProgress?: (m: string) => void },
): Promise<{ result: RankAnalysisResult; fingerprint: string }> {
  const { withCompetition, jsEnabled, onProgress } = opts
  const core = await buildFreeCore(childAsin, parentAsin, supabase)
  const base = freeCoreToResult(core, childAsin, parentAsin, analyzedAt)
  if (!core.analyzed) return { result: base, fingerprint: core.contentFingerprint }

  let rows = base.rows
  let competitionRan = false
  let competitionStatus: CompetitionStatus = 'not_run'
  let creditsSpent = 0
  if (withCompetition) {
    const sov = await enrichWithSov(rows, childAsin, jsEnabled, onProgress)
    rows = sov.rows
    competitionRan = sov.competitionRan
    competitionStatus = sov.competitionStatus
    creditsSpent = sov.creditsSpent
  }

  const council = await runRankCouncil(openai, rows, base.coverage, base.verdict.criticalGaps, ctx, onProgress)
  const mergedRows = rows.map((r) => ({ ...r, nonContentReality: council.realities[r.keyword] ?? r.nonContentReality }))
  const verdict = { ...base.verdict, headline: council.headline || base.verdict.headline }

  // BLOCKER fix: a FREE council-only re-run must NOT destroy a prior PAID competition analysis. Re-hydrate
  // the prior per-row SOV fields by keyword AND carry the competition flags forward, so the persisted row
  // (and every later cache read) still surfaces the competitor data the user paid credits for.
  if (!withCompetition) {
    const prior = await loadPriorAnalysis(childAsin, supabase)
    if (prior?.competitionRan) {
      const byKw = new Map(prior.rows.map((r) => [r.keyword, r]))
      for (const row of mergedRows) {
        const p = byKw.get(row.keyword)
        if (p && p.sovStatus !== 'not_run') {
          row.topCompetitorBrand = p.topCompetitorBrand
          row.theirShare = p.theirShare
          row.sellerVisible = p.sellerVisible
          row.sovStatus = p.sovStatus
        }
      }
      competitionRan = prior.competitionRan
      competitionStatus = prior.competitionStatus
      creditsSpent = prior.creditsSpent
    }
  }

  return {
    result: { ...base, rows: mergedRows, verdict, competitionRan, competitionStatus, creditsSpent, councilFailedOpen: council.failedOpen },
    fingerprint: core.contentFingerprint,
  }
}
