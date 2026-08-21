/**
 * themeRatingRun.ts — the ONE seam between the theme rater and the writers.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * LIVE FINDING (2026-08-21). B0DQ5YZH38 (103 kw), B0F6VTY79T (44), B0DSCDZC6K (3): every
 * keyword_analysis row carried a theme_run_id and NOT ONE carried a theme_fit. The rating "ran",
 * produced nothing, and was recorded as a completed run; the Item Highlights composer then held
 * all three families as `unrated-pool` — and a plain Regenerate can never repair them, because the
 * ai-recommendations fingerprint gate only re-runs the sync (the rater's ONLY caller) when the pool
 * is EMPTY or a reference signal changed (ai-recommendations/route.ts:546-561).
 *
 * Before this module the seam was one expression in syncKeywordIntelligence.ts:455-456:
 *     ratings: ratings.size > 0 ? ratings : null,  themeRunId: ratings.size > 0 ? newThemeRunId() : null
 * i.e. ONE rated keyword out of 103 was a "run". Everything below that — an all-chunks-dead rater,
 * a key mismatch between what was asked and what was written, a no-card family — landed as a run
 * with no warning, and `storeAnalysis` then stamped the `kt_unrated` sentinel over every row.
 *
 * THE CONTRACT NOW. A rating result is a RUN only when it rated >= THEME_RATE_MIN_SHARE of what it
 * asked; otherwise it is a FAILURE: no run id is minted, `ratings` is null, the writer carries every
 * row's prior band forward untouched, and ONE `THEME_RATE_FAILED` line says why. One bounded retry
 * (same card, only the still-unrated keywords) runs before failure is declared.
 *
 * Two callers, one function (`rateFamilyThemeFit`): the sync's relevance gate and the credit-free
 * `rerateFromCache` path. Neither builds a card of its own — card logic stays in themeRater.ts and
 * the design signals come from loadSelectionContextWithSources, exactly as the sync always did.
 * A third path, `rerateFromCachePerDesign` (PO 2026-08-21), rates the SAME pool once PER DESIGN of a
 * multi-design family into theme_fit_by_design (migration 061) — same rateWithRetry contract, same
 * guard shape keyed per (pool, design), family theme_fit untouched.
 *
 * CREDIT SAFETY. Nothing in this file imports or calls researchKeywords, the Jungle Scout client,
 * or keyword_cache. The only network calls are the existing OpenAI card + rater calls.
 */
import type OpenAI from 'openai'
import {
  buildThemeCard,
  rateThemeFit,
  newThemeRunId,
  themeRatingKey,
  type RaterContext,
  type ThemeRating,
  type ThemeCardContext,
} from './themeRater'
import { loadSelectionContextWithSources, type DesignSeasonSources } from './selectionContext'
import type { SelectionContext } from './selection-core'
import { resolveKeywordPoolKey, type PoolKey } from './poolKey'
import { readDesignGroupIdentity, type DesignGroupIdentity, type DesignGroupLike } from '@/lib/fba/designGroupIdentity'
import type { FamilyDesignGroups } from '@/lib/fba/familyDesignGroups'

/* ── CONSTANTS (one home each) ───────────────────────────────────────────────────────────────── */

/** A result that rated fewer than this share of what it asked is a FAILURE, not a run. 0.3 is the
 *  composer's own `ratedShare >= 0.3` threshold (itemHighlightComposer.ts): a run below it would be
 *  recorded and still held as unrated downstream — a run id with no consequence. */
export const THEME_RATE_MIN_SHARE = 0.3

/** One call plus ONE bounded retry. Never more: a rater outage must cost two attempts, not a loop. */
export const THEME_RATE_MAX_ATTEMPTS = 2

/** rerateFromCache refuses while a rating for the pool was armed or completed inside this window. */
export const THEME_RERATE_COOLDOWN_MS = 10 * 60 * 1000

/** app_settings key carrying the rerate guard stamp for a pool (value = ISO time it was ARMED). */
export const rerateGuardKey = (poolKey: string): string => `theme_rerate_guard:${poolKey}`
/** The per-(pool, design) guard — one design's rating never blocks or releases another's. */
export const rerateDesignGuardKey = (poolKey: string, designKey: string): string => `theme_rerate_guard:${poolKey}:${designKey}`

/* ── TYPES ───────────────────────────────────────────────────────────────────────────────────── */

export type ThemeRatings = ReadonlyMap<string, ThemeRating>
export type Rater = (keywords: readonly string[], card: string | null | undefined, ctx: RaterContext) => Promise<Map<string, ThemeRating>>

export type ThemeRateFailure = 'no-keywords' | 'no-card' | 'below-threshold'

export interface ThemeRateVerdict {
  /** null ⇒ FAILURE: the writer must carry prior bands forward and stamp no run id. */
  ratings: ThemeRatings | null
  themeRunId: string | null
  asked: number
  rated: number
  attempts: number
  reason: ThemeRateFailure | null
}

/** The score-row columns both callers already select. */
export interface ThemeScoreRow {
  product_title?: string | null
  design_name_override?: string | null
  design_name_overrides?: Record<string, string> | null
  audience_lean?: string | null
}

export interface FamilyRatingInput {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  /** The ASIN the pool is keyed on (the sync passes its pool key; rerate passes the resolved one). */
  asin: string
  parentAsin: string
  scoreRow: ThemeScoreRow | null
  /** product_title + every listing title, in that order — the selection haystack and the rater's
   *  "current title" (first non-blank), exactly the sync's apparelCtx. */
  titles: readonly (string | null | undefined)[]
  keywords: readonly string[]
  site: string
  openai?: OpenAI
  /** Test seam only. */
  rate?: Rater
}

export interface FamilyRatingResult extends ThemeRateVerdict {
  ctx: SelectionContext
  sources: DesignSeasonSources
  card: string | null
}

/* ── PURE ────────────────────────────────────────────────────────────────────────────────────── */

/** The run-vs-failure predicate. Pure so the threshold is testable without a rater. */
export function themeRatingAccepted(asked: number, rated: number): boolean {
  return asked > 0 && rated > 0 && rated / asked >= THEME_RATE_MIN_SHARE
}

/** Epoch ms encoded in a REAL run id (`kt_<epoch>_<rand>`); 0 for null / the `kt_unrated` sentinel. */
export function themeRunEpoch(runId: string | null | undefined): number {
  const m = /^kt_(\d{10,})_[a-z0-9]+$/.exec(runId || '')
  return m ? Number(m[1]) : 0
}

/* ── RATE WITH RETRY ─────────────────────────────────────────────────────────────────────────── */

/**
 * rateThemeFit + the acceptance contract + ONE retry. The retry asks only for the keywords the first
 * attempt left unrated (same card, same ctx) and merges; acceptance is judged on the merged map.
 * Never throws on a rater failure (rateThemeFit is fail-open by construction); a thrown rater is a
 * programming error and propagates to the caller's existing catch.
 */
export async function rateWithRetry(
  keywords: readonly string[],
  card: string | null,
  ctx: RaterContext,
  rate: Rater = rateThemeFit,
): Promise<ThemeRateVerdict> {
  const asin = ctx.asin ?? null
  const askedKeys = new Set(keywords.map(themeRatingKey).filter(Boolean))
  const asked = askedKeys.size
  const fail = (reason: ThemeRateFailure, rated: number, attempts: number): ThemeRateVerdict => {
    console.warn(JSON.stringify({ tag: 'THEME_RATE_FAILED', asin, asked, rated, reason, attempts, minShare: THEME_RATE_MIN_SHARE }))
    return { ratings: null, themeRunId: null, asked, rated, attempts, reason }
  }
  if (asked === 0) return { ratings: null, themeRunId: null, asked, rated: 0, attempts: 0, reason: 'no-keywords' }
  if (!card) return fail('no-card', 0, 0)

  const out = new Map<string, ThemeRating>()
  let attempts = 0
  let pending: readonly string[] = keywords
  while (attempts < THEME_RATE_MAX_ATTEMPTS) {
    attempts++
    const got = await rate(pending, card, ctx)
    for (const [k, r] of got) if (askedKeys.has(k) && !out.has(k)) out.set(k, r)
    if (themeRatingAccepted(asked, out.size)) break
    pending = keywords.filter((k) => !out.has(themeRatingKey(k)))
    if (attempts < THEME_RATE_MAX_ATTEMPTS) {
      console.warn(`[THEME_RATE_RETRY] asin=${asin ?? '?'} attempt ${attempts} rated ${out.size}/${asked} (< ${THEME_RATE_MIN_SHARE * 100}%) — retrying ${pending.length} unrated keyword(s) once, same card`)
    }
  }

  const accepted = themeRatingAccepted(asked, out.size)
  const themeRunId = accepted ? newThemeRunId() : null
  console.log(JSON.stringify({ tag: 'THEME_RATE_RESULT', asin, asked, rated: out.size, nullCount: asked - out.size, runId: themeRunId, attempts }))
  if (!accepted) return fail('below-threshold', out.size, attempts)
  return { ratings: out, themeRunId, asked, rated: out.size, attempts, reason: null }
}

/* ── THE SHARED FAMILY RATING (card + ctx + rate) ────────────────────────────────────────────── */

/**
 * ONE load, TWO consumers (the 2026-08-09 cure, now the only copy): the selection context and the
 * theme card are built from the SAME four design signals. Both the sync gate and rerateFromCache
 * call this — neither re-derives a card from a narrower read.
 */
export async function rateFamilyThemeFit(input: FamilyRatingInput): Promise<FamilyRatingResult> {
  const { supabase, asin, parentAsin, scoreRow } = input
  const titles = input.titles.filter((t): t is string => !!t && !!t.trim())
  const { ctx, sources } = await loadSelectionContextWithSources({
    supabase,
    childAsin: asin,
    parentAsin,
    scoreRow,
    haystack: titles.join(' '),
    site: input.site,
  })
  const card = await buildThemeCard({
    asin,
    parentAsin,
    designNameOverride: sources.designNameOverride ?? null,
    designNameOverrides: sources.designNameOverridesByKey ?? null,
    visionDesignTheme: sources.visionDesign?.designTheme ?? null,
    resolvedDesignName: sources.resolvedDesignName ?? null,
    audienceLean: scoreRow?.audience_lean ?? null,
    supabase,
    openai: input.openai,
  })
  const verdict = await rateWithRetry(
    input.keywords,
    card,
    { asin, currentTitle: scoreRow?.product_title || titles[0] || null, audienceLean: scoreRow?.audience_lean ?? null, openai: input.openai },
    input.rate,
  )
  return { ctx, sources, card, ...verdict }
}

/* ── CREDIT-FREE RE-RATE FROM THE STORED POOL ────────────────────────────────────────────────── */

export type RerateStatus = 'rated' | 'failed' | 'cooldown' | 'empty'
export interface RerateResult {
  poolKey: PoolKey
  status: RerateStatus
  asked: number
  rated: number
  runId: string | null
  /** cooldown only: how long until the guard releases. */
  retryAfterMs?: number
  /** failed only. */
  reason?: ThemeRateFailure
}

export interface RerateDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  openai?: OpenAI
  /** Test seams. */
  rateFamily?: (input: FamilyRatingInput) => Promise<ThemeRateVerdict>
  now?: () => number
}

/**
 * Re-rate a family's EXISTING keyword_analysis rows against its theme card and write theme_fit /
 * theme_about / a NEW theme_run_id for the rows it rated — nothing else.
 *
 * NEVER: researchKeywords, Jungle Scout, keyword_cache, kw_ref_fingerprint, selection recompute.
 * The rows are read from keyword_analysis under the ONE pool key and written back by UPDATE on the
 * exact stored (asin, keyword) — an unrated row is not touched, an existing numeric fit is never
 * overwritten with null (a rated map only ever carries 0-3).
 *
 * GUARD ORDER (retry-guard-armed-by-completion): the cooldown is read AND ARMED before the first
 * OpenAI call, so a request the gateway kills mid-rating still leaves its stamp and the next click
 * is refused for the remainder of the window. Completion evidence is read from the rows themselves
 * (the epoch inside a real `kt_<epoch>_` run id), so a sync that rated this pool minutes ago also
 * refuses — the guard has no second source of truth to drift from.
 */
export async function rerateFromCache(parentAsin: string, deps: RerateDeps): Promise<RerateResult> {
  const db = deps.supabase
  const now = deps.now ?? Date.now
  const poolKey = await resolveKeywordPoolKey(parentAsin, db)

  // 1. The stored pool — the ONLY keyword source this function has.
  const { data: rowsRaw, error: rowsErr } = await db
    .from('keyword_analysis')
    .select('keyword, theme_fit, theme_run_id')
    .eq('asin', poolKey)
  if (rowsErr) throw new Error(`keyword_analysis read failed for ${poolKey}: ${rowsErr.message}`)
  const rows = ((rowsRaw ?? []) as { keyword: string; theme_fit: number | null; theme_run_id: string | null }[])
    .filter((r) => typeof r.keyword === 'string' && r.keyword.trim().length > 0)
  if (rows.length === 0) return { poolKey, status: 'empty', asked: 0, rated: 0, runId: null }

  // 2. Guard — BEFORE anything billable. Newest of: the armed stamp, the newest real run id.
  const guardKey = rerateGuardKey(poolKey)
  const { data: guardRow } = await db.from('app_settings').select('value').eq('key', guardKey).maybeSingle()
  const armedAt = Date.parse((guardRow as { value?: string | null } | null)?.value || '') || 0
  const lastRun = rows.reduce((mx, r) => Math.max(mx, themeRunEpoch(r.theme_run_id)), 0)
  const lastRatedAt = Math.max(armedAt, lastRun)
  const age = now() - lastRatedAt
  if (lastRatedAt > 0 && age < THEME_RERATE_COOLDOWN_MS) {
    console.warn(`[THEME_RERATE] parent=${poolKey} refused — a rating was armed/completed ${Math.round(age / 1000)}s ago (cooldown ${THEME_RERATE_COOLDOWN_MS / 1000}s)`)
    return { poolKey, status: 'cooldown', asked: rows.length, rated: 0, runId: null, retryAfterMs: THEME_RERATE_COOLDOWN_MS - age }
  }

  // 3. ARM. A failed arm is a refusal: never rate unguarded.
  const { error: armErr } = await db
    .from('app_settings')
    .upsert({ key: guardKey, value: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() }, { onConflict: 'key' })
  if (armErr) throw new Error(`rerate guard could not be armed for ${poolKey}: ${armErr.message}`)

  // 4. Context — the same columns the sync gate selects (syncKeywordIntelligence.ts:393).
  const { data: scoreRow } = await db
    .from('listing_seo_scores')
    .select('product_title, design_name_override, design_name_overrides, audience_lean')
    .eq('parent_asin', poolKey)
    .maybeSingle()
  const { data: titleRows } = await db
    .from('listing_content')
    .select('title')
    .or(`asin.eq.${poolKey},parent_asin.eq.${poolKey}`)
    .limit(20)
  const titles = [
    (scoreRow as ThemeScoreRow | null)?.product_title,
    ...((titleRows ?? []) as { title?: string | null }[]).map((r) => r.title),
  ]

  // 5. Rate (card + ctx + rater with retry — the shared function).
  const rateFamily = deps.rateFamily ?? rateFamilyThemeFit
  const verdict = await rateFamily({
    supabase: db,
    asin: poolKey,
    parentAsin: poolKey,
    scoreRow: (scoreRow as ThemeScoreRow | null) ?? null,
    titles,
    keywords: rows.map((r) => r.keyword),
    site: 'rerateFromCache',
    openai: deps.openai,
  })
  if (!verdict.ratings || !verdict.themeRunId) {
    console.warn(JSON.stringify({ tag: 'THEME_RERATE', parent: poolKey, asked: verdict.asked, rated: verdict.rated, status: 'failed', reason: verdict.reason }))
    return { poolKey, status: 'failed', asked: verdict.asked, rated: verdict.rated, runId: null, reason: verdict.reason ?? 'below-threshold' }
  }

  // 6. Write ONLY the rows that were rated, by their exact stored keyword. Grouped by identical
  //    (band, about) so a 100-row pool is a handful of UPDATEs, each an exact-keyword IN list.
  //    UPDATE, not upsert: keyword_analysis.action_type is NOT NULL with no default, so a partial
  //    upsert payload would be rejected before the conflict path is ever reached.
  const groups = new Map<string, { band: number; about: string; keywords: string[] }>()
  for (const r of rows) {
    const rating = verdict.ratings.get(themeRatingKey(r.keyword))
    if (!rating) continue
    const gk = `${rating.band} ${rating.about}`
    const g = groups.get(gk) ?? { band: rating.band, about: rating.about, keywords: [] }
    g.keywords.push(r.keyword)
    groups.set(gk, g)
  }
  let written = 0
  for (const g of groups.values()) {
    for (let i = 0; i < g.keywords.length; i += 100) {
      const slice = g.keywords.slice(i, i + 100)
      const { error } = await db
        .from('keyword_analysis')
        .update({ theme_fit: g.band, theme_about: g.about, theme_run_id: verdict.themeRunId })
        .eq('asin', poolKey)
        .in('keyword', slice)
      if (error) throw new Error(`keyword_analysis theme write failed for ${poolKey}: ${error.message}`)
      written += slice.length
    }
  }

  // 7. Completion stamp (the guard now also covers the 10 minutes AFTER a finished run) + the line.
  await db.from('app_settings').upsert({ key: guardKey, value: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() }, { onConflict: 'key' })
  console.log(JSON.stringify({ tag: 'THEME_RERATE', parent: poolKey, asked: verdict.asked, rated: verdict.rated, written, runId: verdict.themeRunId, attempts: verdict.attempts }))
  return { poolKey, status: 'rated', asked: verdict.asked, rated: verdict.rated, runId: verdict.themeRunId }
}

/* ── PER-DESIGN RE-RATE (PO 2026-08-21: ONE shared line, true for EVERY design) ──────────────── */

export type DesignRerateStatus = 'rated' | 'failed' | 'cooldown' | 'no-card'
export interface DesignRerateResult {
  designKey: string
  designName: string | null
  /** The child whose cached vision identity built the card (null ⇒ no-card). */
  repAsin: string | null
  status: DesignRerateStatus
  asked: number
  rated: number
  /** Rows the merge function reported updated (rated only). */
  written: number
  runId: string | null
  /** failed / no-card only. */
  reason?: ThemeRateFailure
  /** cooldown only. */
  retryAfterMs?: number
}
export interface PerDesignRerateResult {
  poolKey: PoolKey
  /** 'rated' ⇒ at least one design rated; 'none-rated' ⇒ groups ran but none produced a run. */
  status: 'rated' | 'none-rated' | 'empty' | 'not-multi-design'
  groups: DesignRerateResult[]
}

export interface PerDesignRerateDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  openai?: OpenAI
  /** Test seams — production wires the defaults (familyDesignGroups / designGroupIdentity /
   *  themeRater). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadGroups?: (poolKey: string, db: any) => Promise<FamilyDesignGroups>
  readIdentity?: (group: DesignGroupLike) => Promise<DesignGroupIdentity>
  buildCard?: (ctx: ThemeCardContext) => Promise<string | null>
  rate?: Rater
  now?: () => number
}

/**
 * Rate a multi-design family's EXISTING keyword_analysis rows against EACH design's OWN card and
 * merge theme_fit_by_design[designKey] / theme_run_by_design[designKey] for the rows each design
 * rated — nothing else (migration 061). The family-level theme_fit is never read or written here.
 *
 * PER DESIGN: groups = detectDesignGroups over the child SKUs (the per_child_* keys); the card is
 * built from the design's PER-DESIGN vision identity (designGroupIdentity, READ ONLY — never a
 * scan) plus its seller / resolved name. A group with NO cached identity is reported `no-card` and
 * SKIPPED — never guessed from a sibling, never rated against the family card. Per-design cards are
 * not persisted (listing_seo_scores.theme_card is the FAMILY card and must not be clobbered), so
 * each run costs one gpt-4.1-mini card call + the raters per design — all OpenAI, zero credits.
 *
 * GUARD: the SAME 10-minute cooldown as rerateFromCache, keyed per (pool, designKey): armed BEFORE
 * the design's first OpenAI call, completion evidence = the epoch inside theme_run_by_design[key].
 * Designs run SEQUENTIALLY (each is already 3 parallel raters per chunk).
 *
 * NEVER: researchKeywords, Jungle Scout, keyword_cache, kw_ref_fingerprint, selection recompute.
 */
export async function rerateFromCachePerDesign(parentAsin: string, deps: PerDesignRerateDeps): Promise<PerDesignRerateResult> {
  const db = deps.supabase
  const now = deps.now ?? Date.now
  const poolKey = await resolveKeywordPoolKey(parentAsin, db)

  // 1. The stored pool — keyword + the per-design run map (the completion evidence).
  const { data: rowsRaw, error: rowsErr } = await db
    .from('keyword_analysis')
    .select('keyword, theme_run_by_design')
    .eq('asin', poolKey)
  if (rowsErr) {
    const missing = rowsErr.code === '42703' || rowsErr.code === 'PGRST204' || /theme_run_by_design|theme_fit_by_design/i.test(rowsErr.message ?? '')
    throw new Error(missing
      ? `keyword_analysis.theme_run_by_design is missing for ${poolKey} — apply migration 061 (theme_fit_by_design) first: ${rowsErr.message}`
      : `keyword_analysis read failed for ${poolKey}: ${rowsErr.message}`)
  }
  const rows = ((rowsRaw ?? []) as { keyword: string; theme_run_by_design: Record<string, string> | null }[])
    .filter((r) => typeof r.keyword === 'string' && r.keyword.trim().length > 0)
  if (rows.length === 0) return { poolKey, status: 'empty', groups: [] }

  // 2. The design groups (ONE grouping) + their name signals.
  const loadGroups = deps.loadGroups ?? (await import('@/lib/fba/familyDesignGroups')).loadFamilyDesignGroups
  const fam = await loadGroups(poolKey, db)
  if (!fam.isMultiDesign || fam.groups.length < 2) {
    console.warn(JSON.stringify({ tag: 'THEME_RERATE_DESIGN', parent: poolKey, status: 'not-multi-design', groups: fam.groups.map((g) => g.key) }))
    return { poolKey, status: 'not-multi-design', groups: [] }
  }
  const readIdentity = deps.readIdentity ?? readDesignGroupIdentity
  const buildCard = deps.buildCard ?? buildThemeCard
  const keywords = rows.map((r) => r.keyword)
  const stamp = async (key: string) => {
    const { error } = await db
      .from('app_settings')
      .upsert({ key, value: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString() }, { onConflict: 'key' })
    return error as { message: string } | null
  }

  const out: DesignRerateResult[] = []
  for (const g of fam.groups) {
    const designName = g.sellerName || g.resolvedName || null
    const base = { designKey: g.key, designName, asked: rows.length, written: 0 }

    // 3. Guard per (pool, design) — BEFORE anything billable. Newest of: the armed stamp, the
    //    newest run id this design ever wrote into the rows.
    const guardKey = rerateDesignGuardKey(poolKey, g.key)
    const { data: guardRow } = await db.from('app_settings').select('value').eq('key', guardKey).maybeSingle()
    const armedAt = Date.parse((guardRow as { value?: string | null } | null)?.value || '') || 0
    const lastRun = rows.reduce((mx, r) => Math.max(mx, themeRunEpoch(r.theme_run_by_design?.[g.key])), 0)
    const lastRatedAt = Math.max(armedAt, lastRun)
    const age = now() - lastRatedAt
    if (lastRatedAt > 0 && age < THEME_RERATE_COOLDOWN_MS) {
      console.warn(`[THEME_RERATE_DESIGN] parent=${poolKey} design=${g.key} refused — a rating was armed/completed ${Math.round(age / 1000)}s ago (cooldown ${THEME_RERATE_COOLDOWN_MS / 1000}s)`)
      out.push({ ...base, repAsin: null, status: 'cooldown', rated: 0, runId: null, retryAfterMs: THEME_RERATE_COOLDOWN_MS - age })
      continue
    }

    // 4. The design's OWN identity (READ ONLY). None ⇒ no-card, zero OpenAI calls, nothing armed.
    const gi = await readIdentity(g).catch(() => null)
    if (!gi?.identity) {
      console.warn(JSON.stringify({ tag: 'THEME_RERATE_DESIGN', parent: poolKey, designKey: g.key, status: 'no-card', reason: 'no-identity', asked: rows.length, rated: 0 }))
      out.push({ ...base, repAsin: gi?.repAsin ?? null, status: 'no-card', rated: 0, runId: null, reason: 'no-card' })
      continue
    }

    // 5. ARM, then the card (one mini call) and the raters (with the shared retry contract).
    const armErr = await stamp(guardKey)
    if (armErr) throw new Error(`rerate guard could not be armed for ${poolKey}:${g.key}: ${armErr.message}`)
    const tag = `${poolKey}:${g.key}`
    const card = await buildCard({
      asin: tag,
      parentAsin: null,
      designNameOverride: g.sellerName,
      designNameOverrides: null,
      resolvedDesignName: g.resolvedName,
      visionDesignTheme: gi.identity.designTheme ?? null,
      audienceLean: fam.audienceLean,
      supabase: null,             // NEVER the family card row — per-design cards are not persisted
      openai: deps.openai,
    })
    const verdict = await rateWithRetry(
      keywords,
      card,
      { asin: tag, currentTitle: g.titles[0] || fam.productTitle || null, audienceLean: fam.audienceLean, openai: deps.openai },
      deps.rate,
    )
    if (!verdict.ratings || !verdict.themeRunId) {
      const status: DesignRerateStatus = verdict.reason === 'no-card' ? 'no-card' : 'failed'
      console.warn(JSON.stringify({ tag: 'THEME_RERATE_DESIGN', parent: poolKey, designKey: g.key, status, reason: verdict.reason, asked: verdict.asked, rated: verdict.rated }))
      out.push({ ...base, repAsin: gi.repAsin, status, rated: verdict.rated, runId: null, reason: verdict.reason ?? 'below-threshold' })
      continue
    }

    // 6. Merge ONLY the rated rows, by exact stored keyword, through the ONE merge function.
    const patch: Record<string, { fit: number; about: string }> = {}
    for (const r of rows) {
      const rating = verdict.ratings.get(themeRatingKey(r.keyword))
      if (rating) patch[r.keyword] = { fit: rating.band, about: rating.about }
    }
    const { data: written, error: mergeErr } = await db.rpc('merge_theme_fit_by_design', {
      p_asin: poolKey, p_design_key: g.key, p_run_id: verdict.themeRunId, p_ratings: patch,
    })
    if (mergeErr) throw new Error(`theme_fit_by_design merge failed for ${poolKey}:${g.key} (migration 061 applied?): ${mergeErr.message}`)

    // 7. Completion stamp + the line.
    await stamp(guardKey)
    const n = typeof written === 'number' ? written : Object.keys(patch).length
    console.log(JSON.stringify({ tag: 'THEME_RERATE_DESIGN', parent: poolKey, designKey: g.key, asked: verdict.asked, rated: verdict.rated, written: n, runId: verdict.themeRunId, attempts: verdict.attempts }))
    out.push({ ...base, repAsin: gi.repAsin, status: 'rated', rated: verdict.rated, written: n, runId: verdict.themeRunId })
  }
  return { poolKey, status: out.some((r) => r.status === 'rated') ? 'rated' : 'none-rated', groups: out }
}
