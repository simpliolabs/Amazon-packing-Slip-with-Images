/**
 * seedTokenNet.ts — seed-token SUPPLY-AUDIT PRIMITIVES (task #144 → POOL_STRATA).
 *
 * HISTORY: this module was born (PO 2026-07-28) as the SEED_TOKEN_NET flag — a 12-slot
 * reservation + tail-universe trip bolted onto the old two-band volume cut. POOL_STRATA
 * (handoff/POOL_STRATA_PLAN.md, flipped 2026-08-03) rebuilt that seam: pool membership is now a
 * DECLARED stratified composition (poolComposer.ts) with the design's own rows guaranteed by
 * construction, and the composer's `ensureDesignSupply` owns the one budget-gated tail pull. The
 * SEED_TOKEN_NET env flag, the reservation model (`reserveSeedTokenSlots`,
 * `SEED_TOKEN_RESERVED_SLOTS`) and the trip block died with the flip (git ref: pre-flip main).
 * What SURVIVES here are the pure audit primitives the composer consumes.
 *
 * MEASURED ROOT CAUSE the numbers still encode (B0GF49RLDL "Cupid Valentine"): Jungle Scout
 * returns the seed's related cluster pre-cut to its top-100 by volume; a niche design's own terms
 * (~450/mo vs a 1,173/mo pool floor) never arrived, while the misspelling "confort colors t
 * shirt" (3,625/mo) did.
 *
 * ┌─ THE #95 RULE — READ THIS TWICE BEFORE EDITING ────────────────────────────────────────┐
 * │ THESE ARE COUNTERS ON THE HARVEST. NEVER A PREDICATE ON A ROW.                          │
 * │ Task #95 (13b4629) was cured by harvesting "jesus shirt" / "faith shirt" off the seed   │
 * │ "christian shirt" — rows carrying NONE of the seed's literal tokens. Used as a per-row  │
 * │ FILTER, this predicate DELETES EXACTLY THAT WIN. auditSeedTokens COUNTS and returns     │
 * │ numbers; composePool's strata GUARANTEE representation without removing anything.       │
 * │ Do not "optimise" either into a .filter(). The tests fail if you do.                    │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * PURE — no I/O, no supabase, no fetch, no env. Matching is `isCovered` from coverage-core — the
 * repo's ONE coverage predicate (apostrophe strip, plural fold, garment unification for free).
 */

import { isCovered } from './coverage-core'

// ─── Budgets — doctrine 5: ONE exported constant per budget, none inline ────────────────────
/**
 * A seed token counts as PRESENT at >= this many rows. The measured B0GF49RLDL failure had ZERO,
 * so 0-vs-3 is a wide, unambiguous margin. THIS IS THE TRIP-RATE KNOB for ensureDesignSupply:
 * raise for a stricter guarantee (more tail universes, more credits), lower for fewer.
 */
export const SEED_TOKEN_MIN_HITS = 3
/**
 * The tail universe YIELDS first: never spend when callsRemaining <= this.
 * JUNGLE_SCOUT_MONTHLY_BUDGET is 950 (cacheService) and research PAUSES there; $0.05/call starts
 * above the 1,000 plan limit. Holding 50 calls of slack makes the OPTIONAL pull structurally
 * incapable of being the call that trips the pause or reaches the paid band.
 */
export const SEED_TAIL_MIN_HEADROOM = 50

export interface SeedTokenAudit {
  /** The distinctive seed tokens the caller asked us to assert. */
  tokens: string[]
  /** token -> number of rows carrying it. */
  hits: Record<string, number>
  /** Tokens with hits < SEED_TOKEN_MIN_HITS, in seed order. */
  missing: string[]
  /** True when every token clears the floor, OR there were no tokens to assert. */
  ok: boolean
}

/**
 * THE predicate. Does this keyword carry this seed token?
 *
 * `isCovered(token, keyword)` is coverage-core's field-agnostic check: every significant token of
 * the FIRST argument appears in the SECOND. For a single-word token that is exactly "does the
 * keyword contain this word", with the repo's canonical folding applied symmetrically:
 *   "valentines day shirt"  carries "valentine"  (foldPlural)
 *   "cupid's arrow tee"     carries "cupid"      (apostrophe strip)
 *   "cup holder shirt"      does NOT carry "cupid" (whole-token match, never substring)
 * Reusing this seam rather than a bespoke \\b regex is what keeps the audit agreeing with every
 * scorer, generator and coverage surface in the repo by construction.
 */
export function seedTokenHit(keyword: string, seedTokens: string[]): boolean {
  if (!keyword || seedTokens.length === 0) return false
  return seedTokens.some((t) => isCovered(t, keyword))
}

/**
 * Count rows per token and report which tokens fell below the floor. Pure; no side effects; no
 * row is inspected for anything but counting; NOTHING is removed.
 *
 * FAIL-OPEN: an empty token list (a seed made only of generic words, e.g. "comfort colors shirt")
 * returns ok:true. There is no identity to assert, and a seed like that is the separate auto-seed
 * defect — the guarantee must not buy a credit trying to rescue a blank-brand seed.
 */
export function auditSeedTokens(
  seedTokens: string[],
  rows: { keyword?: string }[],
): SeedTokenAudit {
  const hits: Record<string, number> = {}
  const missing: string[] = []
  for (const t of seedTokens) {
    let n = 0
    for (const r of rows) if (r.keyword && isCovered(t, r.keyword)) n++
    hits[t] = n
    if (n < SEED_TOKEN_MIN_HITS) missing.push(t)
  }
  return { tokens: seedTokens, hits, missing, ok: missing.length === 0 }
}
