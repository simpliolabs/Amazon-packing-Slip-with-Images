/**
 * poolComposer.ts — the stratified pool-composition contract (POOL_STRATA, task #147/#149).
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEAM (handoff/POOL_STRATA_PLAN.md): today a keyword's pool membership is an accident of a
 * volume auction — each Jungle Scout universe arrives pre-cut to its cluster's top-100-by-volume,
 * and the client re-cuts the merged harvest with a two-band volume sort, so a niche design's own
 * ~450/mo terms are harvested and then DISCARDED (the ⭐⭐⭐ #144 failure; B0GF49RLDL shipped zero
 * /valentine|cupid/ rows while a 3,625/mo misspelling survived). SEED_TOKEN_NET's 12-slot
 * reservation was a bolt-on on that seam; this module REPLACES the membership decider.
 *
 * THE CONTRACT: the shipped pool is a DECLARED stratified composition over the same rows —
 *   S1 broad-heads  — exactly the merge's top-30 by volume (today's heads survive verbatim:
 *                     zero head regression by construction);
 *   S2 design-own   — rows carrying the design's own tokens (coverage-core seedTokenHit — THE one
 *                     predicate, never a second definition), entry-gated by the caller (trademark/
 *                     off-niche), guaranteed up to 25 slots;
 *   S3 niche-tail   — niche-universe rows (nicheHead:true) with a structural fallback to
 *                     non-fromUniverse rows so the stratum never depends on the GARMENT_NOUN flag
 *                     having tagged nicheHead;
 *   S4 remainder    — by volume until the 100 cap.
 * Underfilled strata REDISTRIBUTE to S4 by volume — never pad, never invent (anti-Goodhart).
 * The final blob is re-sorted volume-DESC so every downstream consumer (buckets.primary,
 * rankAnalysis, Intelligence, coverage, both fills) sees the same SHAPE it does today. No global
 * volume ranking ever runs ACROSS strata: either the design's terms occupy their stratum, or the
 * composer has provably exhausted supply — "the rows arrived and the cap ate them" is impossible.
 *
 * Pure + deterministic (stable tiebreaks, content-addressed sha) so path parity is a LOGGED
 * INVARIANT: the same input rows produce the same sha on every path that composes them.
 *
 * Rollout: POOL_STRATA=off|shadow|on (keywordResearcher Phase 5). Phase 1-2 = shadow ([POOL_STRATA_DIFF]
 * beside the shipped old composition); Phase 3 flips + DELETES the old two-band decider and the
 * SEED_TOKEN_NET reservation layer; Phase 4 removes the flag (coverage-core precedent).
 */
import { seedTokenHit, auditSeedTokens } from './seedTokenNet'

export interface PoolRow {
  keyword: string
  searchVolume: number
  fromUniverse?: boolean
  nicheHead?: boolean
}

export interface StrataCaps {
  total: number
  s1Broad: number
  s2Design: number
  s3NicheTail: number
}

/** The one place the pool's size and strata guarantees are declared. */
export const DEFAULT_STRATA_CAPS: StrataCaps = { total: 100, s1Broad: 30, s2Design: 25, s3NicheTail: 25 }

export interface Composition<T extends PoolRow> {
  /** Final shipped rows: ≤ caps.total, volume-DESC (downstream shape unchanged). */
  rows: T[]
  /** How many rows each stratum actually contributed (post-dedup, pre-final-sort). */
  strata: { s1: number; s2: number; s3: number; s4: number }
  /** Rows in the FINAL blob carrying any design token (coverage-core predicate). */
  designTokenHits: number
  /** Of the merge's true top-`s1Broad` by volume, how many shipped (invariant: all of them). */
  broadTopRetained: number
  /** Deterministic content sha of the final composition — the path-parity oracle. */
  sha: string
}

/** Stable order: volume DESC, then keyword ASC — determinism is load-bearing for the sha. */
function byVolumeStable<T extends PoolRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.searchVolume - a.searchVolume) || a.keyword.localeCompare(b.keyword))
}

/** FNV-1a 32-bit over the composed keyword list — cheap, dependency-free, deterministic. */
function compositionSha(rows: readonly PoolRow[]): string {
  let h = 0x811c9dc5
  const s = rows.map((r) => r.keyword.toLowerCase()).join('|')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * First-writer-wins merge with NICHE precedence — the exact dedup categorizeBuckets performs at
 * its top (keywordResearcher.ts Phase 5). Exported so the shadow diff composes over identical
 * input; at Phase 3 categorizeBuckets consumes THIS instead of its inline map.
 */
export function mergeKeywordRows<T extends PoolRow>(nicheKeywords: readonly T[], competitorKeywords: readonly T[]): T[] {
  const merged = new Map<string, T>()
  for (const kw of nicheKeywords) merged.set(kw.keyword.toLowerCase(), kw)
  for (const kw of competitorKeywords) {
    const key = kw.keyword.toLowerCase()
    if (!merged.has(key)) merged.set(key, kw)
  }
  return Array.from(merged.values())
}

/** Verdict of the composer's supply guarantee — Phase 2 of the contract. */
export interface SupplyDecision {
  /** none = supply is adequate; would_pull = shadow (spend nothing, report); pull = buy ONE tail universe. */
  action: 'none' | 'would_pull' | 'pull'
  /** The `${missingToken} ${noun}` universe head to research when action != none, else null. */
  candidate: string | null
  /** Reason codes preserved VERBATIM from the SEED_TOKEN_NET trip logic they replace at Phase 3
   *  (keywordResearcher.ts:359-399): no_distinctive_tokens | pass | already_emitted | non_apparel |
   *  harvest_degraded | shadow_would_pull | budget_headroom_reserved | tail_universe_added. */
  reason: string
  /** Design tokens under the hit floor (auditSeedTokens semantics). */
  missing: string[]
}

/**
 * ensureDesignSupply — the composer-owned supply guarantee (POOL_STRATA Phase 2).
 *
 * PURE DECISION, no I/O: the caller owns the budget read, the noun namespace, and the actual
 * universe fetch (which stays the normal storage-first seed-pool loop, cross-listing reuse
 * intact). This relocates the SEED_TOKEN_NET trip conditions VERBATIM into the composition
 * contract: S2 can only be under-supplied if the design's terms never arrived — in which case the
 * contract says buy AT MOST ONE `${missingToken} ${noun}` tail universe, and only when
 *   (a) the harvest is healthy (a quota outage must never look like starvation and never
 *       escalate spend — the ⭐⭐ budget-guard incident),
 *   (b) the head is not already an emitted universe (then the pull is FREE — it is coming),
 *   (c) the listing is apparel (the `${token} shirt`-shaped head is nonsense otherwise), and
 *   (d) the budget has real headroom (this optional spend yields FIRST as the cap tightens).
 * budget=null means "unchecked" (shadow callers spend nothing, not even the budget read).
 */
export function ensureDesignSupply(opts: {
  designTokens: string[]
  /** Merged candidate rows (niche + competitor, pre-cap) the audit counts hits over. */
  candidateRows: { keyword?: string }[]
  /** Normalized keys of the primary seed + every universe already emitted this research. */
  emittedKeys: ReadonlySet<string>
  /** Builds the tail head for a token — caller owns the noun namespace (`${token} ${g.noun}`). */
  headOf: (token: string) => string
  normalizeKey: (head: string) => string
  nonApparel: boolean
  /** Pre-universe niche harvest size vs the outage floor (EMPTY_POOL_THRESHOLD). */
  harvestCount: number
  harvestFloor: number
  /** null = shadow caller, budget deliberately unchecked ($0, zero reads). */
  budget: { allowed: boolean; callsRemaining: number } | null
  minHeadroom: number
  /** false = shadow (report would_pull, spend nothing); true = armed (Phase 3). */
  arm: boolean
}): SupplyDecision {
  const { designTokens } = opts
  if (designTokens.length === 0) return { action: 'none', candidate: null, reason: 'no_distinctive_tokens', missing: [] }
  const audit = auditSeedTokens(designTokens, opts.candidateRows)
  if (audit.ok) return { action: 'none', candidate: null, reason: 'pass', missing: [] }
  const candidate = audit.missing
    .map((t) => opts.headOf(t))
    .find((h) => { const k = opts.normalizeKey(h); return !!k && !opts.emittedKeys.has(k) }) ?? null
  if (!candidate) return { action: 'none', candidate: null, reason: 'already_emitted', missing: audit.missing }
  if (opts.nonApparel) return { action: 'none', candidate: null, reason: 'non_apparel', missing: audit.missing }
  if (opts.harvestCount < opts.harvestFloor) return { action: 'none', candidate: null, reason: 'harvest_degraded', missing: audit.missing }
  if (!opts.arm) return { action: 'would_pull', candidate, reason: 'shadow_would_pull', missing: audit.missing }
  if (!opts.budget || !opts.budget.allowed || opts.budget.callsRemaining <= opts.minHeadroom) {
    return { action: 'none', candidate: null, reason: 'budget_headroom_reserved', missing: audit.missing }
  }
  return { action: 'pull', candidate, reason: 'tail_universe_added', missing: audit.missing }
}

export function composePool<T extends PoolRow>(
  merged: readonly T[],
  designTokens: string[],
  opts?: {
    /** Entry gate for the GUARANTEED design stratum (trademark/off-niche/foreign) — a junk row
     *  must win a volume seat like anyone else, never a guaranteed one. Default: allow. */
    s2Gate?: (keyword: string) => boolean
    caps?: StrataCaps
  },
): Composition<T> {
  const caps = opts?.caps ?? DEFAULT_STRATA_CAPS
  const s2Gate = opts?.s2Gate ?? (() => true)

  const sorted = byVolumeStable(merged)
  const s1 = sorted.slice(0, caps.s1Broad)
  const pool = sorted.slice(caps.s1Broad)

  const inS2 = new Set<T>()
  const s2: T[] = []
  if (designTokens.length > 0) {
    for (const r of pool) {
      if (s2.length >= caps.s2Design) break
      if (seedTokenHit(r.keyword, designTokens) && s2Gate(r.keyword)) { s2.push(r); inS2.add(r) }
    }
  }

  const inS3 = new Set<T>()
  const s3: T[] = []
  for (const r of pool) {
    if (s3.length >= caps.s3NicheTail) break
    if (inS2.has(r)) continue
    // nicheHead is only written when GARMENT_NOUN tagged the universe — the structural fallback
    // (non-fromUniverse = the design-seed + competitor harvest) keeps S3 flag-independent.
    if (r.nicheHead === true || r.fromUniverse !== true) { s3.push(r); inS3.add(r) }
  }

  const s4: T[] = []
  const s4Budget = caps.total - s1.length - s2.length - s3.length
  for (const r of pool) {
    if (s4.length >= s4Budget) break
    if (!inS2.has(r) && !inS3.has(r)) s4.push(r)
  }

  const rows = byVolumeStable([...s1, ...s2, ...s3, ...s4]).slice(0, caps.total)
  const shipped = new Set(rows.map((r) => r.keyword.toLowerCase()))
  return {
    rows,
    strata: { s1: s1.length, s2: s2.length, s3: s3.length, s4: s4.length },
    designTokenHits: designTokens.length === 0 ? 0 : rows.filter((r) => seedTokenHit(r.keyword, designTokens)).length,
    broadTopRetained: s1.filter((r) => shipped.has(r.keyword.toLowerCase())).length,
    sha: compositionSha(rows),
  }
}
