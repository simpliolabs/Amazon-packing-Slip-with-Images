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
import { isWithinBudget } from '@/lib/keyword-engine/cacheService'
import { makeCoverageChecker } from '@/lib/keyword-engine/coverage'
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
  opportunityScore: number
  actionType: ActionType
  youCover: boolean
  coveredIn: string[]                 // ['title','bullets','description','backend'] or ['(live content)']
  contentAction: string               // what CONTENT can do — sanitize()-clamped, never "rank #1"
  nonContentReality: string           // '' unless competition ran AND a real lever applies
  topCompetitorBrand: string | null   // SOV winner brand; null if not run / empty-string brand
  theirShare: number | null           // 0..100 — SHARE AMONG TOP RETURNED LISTINGS (not market share)
  sellerVisible: boolean | null       // in this keyword's top returned listings; null = not measured
  sovStatus: SovStatus
  priority: number                    // 1..N (deterministic fallback: opportunity desc)
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

function contentActionFor(actionType: ActionType, youCover: boolean, inTitle: boolean): string {
  // IRRELEVANT first — the keyword was classified as off-product (different niche, e.g. Star Wars
  // father's-day terms surfacing under a retirement-tee research). Adding it dilutes relevance.
  // (PO 2026-06-14: the previous "OPTIONAL — weave into bullets/backend if natural" fallback was
  // telling the seller to ADD off-product keywords — exactly the opposite of correct advice.)
  // Cast to string: 'IRRELEVANT' is a runtime actionType (used in page.tsx + audit pipeline) but
  // not yet in the ActionType union here; extending the union is a wider refactor not needed for
  // this user-facing copy fix.
  if ((actionType as string) === 'IRRELEVANT') return 'SKIP — off-product (different niche). Do NOT add — it would dilute your relevance.'
  if (actionType === 'CRITICAL' && !youCover) return 'ADD — high-opportunity term not yet in your copy'
  if (actionType === 'UPGRADE' && !inTitle) return 'PROMOTE — present, pull into the title (higher weight)'
  if (actionType === 'DEFENDED') return "DEFEND — you're covered here; hold it"
  if (youCover) return 'COVERED — content job done here; rank now depends on non-content levers'
  return 'OPTIONAL — lower-opportunity; weave into bullets/backend if natural'
}

export function buildBaselineVerdict(covered: number, total: number, criticalGaps: number): RankVerdict {
  // Denominator is the real row count, never a hard-coded "/10" (spec D2 fix).
  return {
    headline: sanitize(`Content makes you indexed & competitive on ${covered} of ${total} top terms. Reaching the top ALSO needs reviews, conversion, sales velocity, and price — levers this tool can't change.`),
    contentCanDo: CONTENT_CAN_DO,
    contentCannotDo: CONTENT_CANNOT_DO,
    honestNote: HONEST_NOTE,
    indexedCoverage: `${covered} of ${total} top keywords covered`,
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

/** sha1 of the live copy — the staleness key persisted with a cached analysis (cheap: 1 query + hash). */
export async function contentFingerprint(parentAsin: string | null, childAsin: string, supabase: AdminClient): Promise<string> {
  return createHash('sha1').update(await buildHaystack(parentAsin, childAsin, supabase)).digest('hex')
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
  const fingerprint = createHash('sha1').update(haystack).digest('hex')

  let kws = await getStoredAnalysis(childAsin, 100)
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

  const check = makeCoverageChecker(haystack)

  // Outcome loop (#89): per-keyword SQP share movement since the last monthly snapshot. Best-effort — {} (so
  // every shareSignal is null) until ≥2 months of history accrue or if the snapshots table isn't migrated.
  const signals = await computeOutcomeSignals(childAsin, supabase).catch(() => ({}))

  const rows: RankPlaybookRow[] = kws.map((k) => {
    const flagCover = ([k.inTitle && 'title', k.inBullets && 'bullets', k.inDescription && 'description', k.inBackend && 'backend'].filter(Boolean)) as string[]
    let youCover = flagCover.length > 0
    let coveredIn = flagCover
    // Stale-flag fallback: presence flags are a snapshot; if all false, trust the LIVE token check.
    if (!youCover && check(k.keyword)) { youCover = true; coveredIn = ['(live content)'] }
    const actionType = k.actionType as ActionType
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
      opportunityScore: k.opportunityScore,
      actionType,
      youCover,
      coveredIn,
      contentAction: sanitize(contentActionFor(actionType, youCover, k.inTitle)),
      nonContentReality: '',
      topCompetitorBrand: null,
      theirShare: null,
      sellerVisible: null,
      sovStatus: 'not_run' as SovStatus,
      priority: 0,
      shareSignal,
    }
  })

  // Top-10 by opportunity desc; among near-equal opportunity, prefer uncovered (winnable) — but a
  // low-opportunity-uncovered term never displaces a high-opportunity one (spec D3 fix).
  const top10 = [...rows].sort((a, b) => (b.opportunityScore - a.opportunityScore) || (Number(!a.youCover) - Number(!b.youCover))).slice(0, 10)

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
    return `${i + 1}. "${r.keyword}" — opportunity ${r.opportunityScore}, ${r.actionType}, ${cov}${comp}`
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
