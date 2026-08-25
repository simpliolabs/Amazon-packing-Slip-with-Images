/**
 * titleLearningMiner.ts — mines `listing_change_log` title edits into TWO existing, previously-
 * unwired consumers: poGoldCorpus's few-shot GOLD corpus (`loadPoGoldTitles`) and the title council's
 * REJECT-PAIR block (`rejectPairBlock`, listingPipeline.ts's `buildApparelTitleBrief`).
 *
 * THE GAP THIS CLOSES (PO-approved design, feat/title-learning-loop). `loadPoGoldTitles` reads ONE
 * column — `listing_seo_recommendations.recommended_title WHERE title_source='manual'` — keyed on
 * `parent_asin` only. `lock-title/route.ts` always writes `sku: null`, so at most ONE title per
 * family can ever become a teaching example, and a 6-design family's 6 per-design titles never do.
 * `listing_change_log` (037) already stores every locked/edited title as a `sku`-attributable
 * before/after pair — three files said a miner over it was "the intended design" and never built it
 * (poGoldCorpus.ts:7-10, title-golds/route.ts:11, titleIdiomExpander.ts:19). This module is that miner.
 *
 * TRUTH-VETTING IS NOT THIS MODULE'S JOB. A seller-typed title can itself lie (a real case: a
 * kids_tee family locked as "...Crewneck for Kids & Adults" — Crewneck is a sweatshirt noun, not a
 * tee noun). Vetting requires resolving the family's blank (a real DB read), which is EXPENSIVE and
 * must happen ONCE, at ingestion — never inside a pure function called at every corpus load. So
 * `mineTitleGolds` below trusts an ALREADY-STAMPED `title_truth_ok` column (migration 065) and admits
 * only rows where it is strictly `true`; the stamping itself (`computeTitleTruthVerdict`, DB-touching)
 * is called at write time by `lock-title/route.ts` and by the one-time backfill
 * (`/api/fba/admin/backfill-title-truth`) for pre-migration history.
 *
 * NO NEW DEFINITION OF TRUTH: `computeTitleTruthVerdict` calls the SAME `resolveLockedTitleTruthCtx`
 * (lockedTitleTruth.ts) the read-time "locked title truth" warning already uses to resolve a family's
 * blank, and the SAME `verdictForAssembledTitle` (titleBand.ts) the additive title search judges every
 * candidate against. This module adds zero new predicate logic.
 *
 * PURE MINING FUNCTIONS ONLY BELOW THE DB HELPERS. `mineTitleGolds` / `mineTitleRejectPairs` take a
 * plain array of rows and return a plain array — no I/O, so every rule (last-word-only, truth filter,
 * dedup, reject-pair extraction) is unit-testable over fixtures without a database.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { verdictForAssembledTitle, type AssembledTitleCtx } from './titleBand'
import { resolveLockedTitleTruthCtx } from './lockedTitleTruth'

// NOTE: deliberately no import of poGoldCorpus.ts's GOLD_BRIEF_LIMIT here — poGoldCorpus.ts imports
// THIS module (to union mined golds into loadPoGoldTitles), so importing it back would be a cycle.
// Every gold-count default below is a REQUIRED param instead; poGoldCorpus.ts's caller supplies
// GOLD_BRIEF_LIMIT explicitly (see loadPoGoldTitles).

/** The `listing_change_log` columns the miner reads (a subset of the full row — see 037 + 065). */
export interface ChangeLogTitleRow {
  parent_asin: string
  /** Nullable: `lock-title/route.ts` writes `sku: null` today (parent-grain lock only) — the miner
   *  still threads it through so a FUTURE per-design lock write path needs no change here. */
  sku: string | null
  field: string | null
  action: string | null
  source: string | null
  before_value: string | null
  after_value: string | null
  /** ISO timestamp (`listing_change_log.changed_at`). */
  changed_at: string
  /** Migration 065. `true` = passed `verdictForAssembledTitle` at ingestion. `null` = not yet vetted
   *  (pre-migration row, a non-title row, or the backfill has not reached it yet) — NEVER treated as
   *  true; a row must be POSITIVELY vetted to become a gold. */
  title_truth_ok?: boolean | null
  title_truth_reason?: string | null
}

/** A gold ready to feed `poGoldCorpus.loadPoGoldTitles`'s existing shape/trademark admission gates. */
export interface MinedGold {
  parent_asin: string
  sku: string | null
  title: string
  changed_at: string
}

/** Shape-compatible with `poGoldCorpus.SEED_REJECT_PAIRS` / `rejectPairBlock`. `sellerSaid` is
 *  synthesized (the change log stores before/after text, not a verbatim quote) — the before→after
 *  CONTRAST is the signal `rejectPairBlock` prints; the label just orients the reader. */
export interface MinedRejectPair {
  before: string
  sellerSaid: string
  after: string
}

/** How many reject pairs the council brief carries — mirrors GOLD_BRIEF_LIMIT's role for golds, sized
 *  down because `SEED_REJECT_PAIRS` (4 items) already showed a handful is enough prompt signal. */
export const REJECT_PAIR_BRIEF_LIMIT = 8

/** field IN ('title', 'title (locked)') — 'title (unlocked)' is DELIBERATELY excluded: an unlock
 *  writes `after_value = before` (no new title chosen, see lock-title/route.ts), so it is neither a
 *  gold candidate nor a real before→after edit. `'title'` (bare) has no current writer in this repo
 *  (verified: the only `source='manual_edit'` writers are lock-title and claim/route.ts, and claim
 *  never touches `field`), kept for forward compatibility with a future direct-edit UI. */
const TITLE_EDIT_FIELDS = new Set(['title', 'title (locked)'])

function isTitleEditRow(r: ChangeLogTitleRow): boolean {
  return !!r.field && TITLE_EDIT_FIELDS.has(r.field) && r.action === 'edit' && r.source === 'manual_edit'
}

const normTitle = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
const ts = (iso: string): number => { const n = new Date(iso).getTime(); return Number.isFinite(n) ? n : 0 }

/**
 * GOLD SELECTION — last-word-only, truth-clean, per (parent_asin, sku) "family/design".
 *
 * PO ruling: a title becomes GOLD only if it was the seller's LAST WORD on that family/design (no
 * later edit superseding it). So for each (parent_asin, sku) key, only the NEWEST truth-clean
 * candidate survives — an earlier lock on the same key is superseded and drops out of the gold set
 * (it may still be reject-pair material; see `mineTitleRejectPairs`, which reads every row
 * independently and does not share this gate).
 *
 * Newest-first output, deduped by normalized title text (loadPoGoldTitles's own existing rule: "one
 * gold locked across many children is ONE example"), capped at `limit`. Pure.
 */
export function mineTitleGolds(
  rows: readonly ChangeLogTitleRow[],
  limit: number,
): MinedGold[] {
  const candidates = rows.filter((r) => {
    if (!isTitleEditRow(r)) return false
    if (!(r.after_value ?? '').trim()) return false
    return r.title_truth_ok === true // strict: null (unvetted) and false (lying) are both excluded
  })

  const newestPerKey = new Map<string, ChangeLogTitleRow>()
  for (const r of candidates) {
    const key = `${r.parent_asin}::${r.sku ?? ''}`
    const cur = newestPerKey.get(key)
    if (!cur || ts(r.changed_at) > ts(cur.changed_at)) newestPerKey.set(key, r)
  }

  const sorted = [...newestPerKey.values()].sort((a, b) => ts(b.changed_at) - ts(a.changed_at))
  const seen = new Set<string>()
  const out: MinedGold[] = []
  for (const r of sorted) {
    const title = (r.after_value ?? '').trim()
    const k = normTitle(title)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ parent_asin: r.parent_asin, sku: r.sku ?? null, title, changed_at: r.changed_at })
    if (out.length >= limit) break
  }
  return out
}

/**
 * REJECT-PAIR EXTRACTION — ALL genuine before→after pairs, including SUPERSEDED ones.
 *
 * PO ruling: "ALL before→after pairs are eligible as REJECT signal, even superseded ones — a
 * superseded edit still teaches what the AI got wrong." So this reads every title-edit row
 * independently, with NO last-word gate and NO truth gate on `after` — the CONTRAST (what the AI
 * proposed vs what the seller changed it to) is the signal being taught, not an endorsement of
 * `after` as a new gold (`mineTitleGolds`, above, is the only place truth-vetted golds come from).
 *
 * Newest-first, deduped by the exact (before, after) pair. Pure.
 */
export function mineTitleRejectPairs(
  rows: readonly ChangeLogTitleRow[],
  limit: number = REJECT_PAIR_BRIEF_LIMIT,
): MinedRejectPair[] {
  const sorted = [...rows].filter(isTitleEditRow).sort((a, b) => ts(b.changed_at) - ts(a.changed_at))
  const seen = new Set<string>()
  const out: MinedRejectPair[] = []
  for (const r of sorted) {
    const before = (r.before_value ?? '').trim()
    const after = (r.after_value ?? '').trim()
    if (!before || !after) continue
    if (normTitle(before) === normTitle(after)) continue
    const key = `${normTitle(before)}→${normTitle(after)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ before, sellerSaid: 'rewrote this title by hand', after })
    if (out.length >= limit) break
  }
  return out
}

/* ─── INGESTION-TIME TRUTH STAMPING (DB-touching) ────────────────────────────────────────────────── */

/**
 * The verdict to stamp on a `listing_change_log` row at the moment a title is locked/edited (or, for
 * the one-time backfill, on pre-existing history). Reuses `resolveLockedTitleTruthCtx` (the exact
 * function the read-time "locked title truth" warning already calls) to resolve the family's blank,
 * then judges the WHOLE assembled title with `verdictForAssembledTitle` — the same predicate the
 * additive title search judges every candidate against. No new rule logic.
 *
 * Fail-open, same doctrine as every truth-ctx site in this repo: an unresolved blank makes
 * `resolveLockedTitleTruthCtx` return `{ ctx: null }` (it fails open internally), and
 * `verdictForAssembledTitle` with `truth: null` skips the blank-grounded checks but still runs the
 * two ctx-free ones (duplicate-concept, punctuation-defect) — so an unresolved family can still
 * exclude a structurally broken title, it just cannot exclude a garment/audience lie it has no ground
 * truth to judge. An empty title is trivially `ok: true` (nothing to judge — never reachable via the
 * lock route, which requires a non-empty title, but kept defensive for the backfill).
 */
export async function computeTitleTruthVerdict(
  db: SupabaseClient,
  parentAsin: string,
  title: string,
  audienceLean?: string | null,
): Promise<{ ok: boolean; reason: string | null }> {
  const t = (title || '').trim()
  if (!t) return { ok: true, reason: null }
  const { ctx } = await resolveLockedTitleTruthCtx(db, { parentAsin, audienceLean })
  const verifyCtx: AssembledTitleCtx = { truth: ctx }
  const verdict = verdictForAssembledTitle(t, verifyCtx)
  return verdict.ok ? { ok: true, reason: null } : { ok: false, reason: verdict.reason }
}

/* ─── DB LOADERS (fail-open wrappers around the pure miner) ──────────────────────────────────────── */

const CANDIDATE_FIELDS = ['title', 'title (locked)']

/** Fetches the raw candidate rows the miner needs. Shared by both loaders below so a single query
 *  shape serves golds and reject pairs — `mineTitleGolds`/`mineTitleRejectPairs` each apply their own
 *  independent filter over the SAME rows (a row rejected as a gold can still be reject-pair material). */
async function fetchChangeLogTitleRows(supabase: SupabaseClient, sinceLimit = 2000): Promise<ChangeLogTitleRow[]> {
  const { data, error } = await supabase
    .from('listing_change_log')
    .select('parent_asin, sku, field, action, source, before_value, after_value, changed_at, title_truth_ok, title_truth_reason')
    .in('field', CANDIDATE_FIELDS)
    .eq('action', 'edit')
    .eq('source', 'manual_edit')
    .order('changed_at', { ascending: false })
    .limit(sinceLimit)
  if (error || !data) return []
  return data as ChangeLogTitleRow[]
}

/**
 * Mined, truth-vetted golds from `listing_change_log` — the NEW channel `loadPoGoldTitles` unions
 * alongside its existing `listing_seo_recommendations` read (poGoldCorpus.ts). Fail-open: any read
 * error returns `[]`, never throws — the caller's existing seed/union fallback covers it.
 */
export async function loadMinedTitleGolds(
  supabase: SupabaseClient | null | undefined,
  limit: number,
): Promise<MinedGold[]> {
  if (!supabase) return []
  try {
    return mineTitleGolds(await fetchChangeLogTitleRows(supabase), limit)
  } catch {
    return []
  }
}

/**
 * Mined reject pairs from `listing_change_log` — today this is a 100%-static seed
 * (`listingPipeline.ts`'s `buildApparelTitleBrief` calls `rejectPairBlock(SEED_REJECT_PAIRS)`
 * unconditionally); this is the loader that lets it grow from real corrections instead. Fail-open:
 * any read error returns `[]` so the caller's SEED_REJECT_PAIRS fallback still fires.
 */
export async function loadMinedTitleRejectPairs(
  supabase: SupabaseClient | null | undefined,
  limit: number = REJECT_PAIR_BRIEF_LIMIT,
): Promise<MinedRejectPair[]> {
  if (!supabase) return []
  try {
    return mineTitleRejectPairs(await fetchChangeLogTitleRows(supabase), limit)
  } catch {
    return []
  }
}
