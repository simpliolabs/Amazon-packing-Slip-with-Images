/**
 * seedTokenNet.ts — THE SEED-TOKEN NET (PO 2026-07-28, task #144).
 *
 * INVARIANT: "the seed's own literal tokens MUST appear in the harvest, or the pull is
 * rejected/retried." Deterministic and measurable — a NET, never a prompt (doctrine 4).
 *
 * MEASURED ROOT CAUSE (B0GF49RLDL "Cupid Valentine", seed "cupid valentine shirt", manual +
 * forceRefresh): jungleScoutClient.ts:235 asks JS for the seed's related cluster with
 * sort=-monthly_search_volume_exact and keeps the top 100. A NICHE design's own keywords are
 * LOW-VOLUME BY DEFINITION, so they fall below the cut. Pool floor 1,173/mo · median 6,255 ·
 * max 476,829, while this design's valentine terms sit at ~450/mo. The MISSPELLING
 * "confort colors t shirt" (3,625) survived. The design did not.
 *
 * SECOND, INDEPENDENT CUT — the reason a fetch-only fix ships and does nothing:
 * categorizeBuckets (keywordResearcher.ts:434-442) truncates AGAIN by volume DESC, 70 niche /
 * remainder universe. Even a perfect harvest is discarded there. reserveSeedTokenSlots is what
 * makes the harvest survive; without it the whole change is a paid no-op.
 *
 * ONE predicate — seedTokenHit — with THREE consumers in keywordResearcher.ts (doctrine 1: this
 * repo grew SEVEN disagreeing definitions of "covered" by patching; do not add an 8th anything):
 *   1. auditSeedTokens over the merged harvest  → the TRIGGER for the niche-tail universe
 *   2. reserveSeedTokenSlots in categorizeBuckets → the rows SURVIVE the 70/100 cut
 *   3. auditSeedTokens over result.allKeywords    → the TERMINAL measurement on what SHIPS
 *
 * OWNS NO VOCABULARY. Tokens come from keywordResearcher's `distinctiveNicheTokens` (the SAME
 * filter broadNicheSeed uses). Matching is `isCovered` from coverage-core — the repo's ONE
 * coverage predicate, which already gives apostrophe stripping, plural folding and garment
 * unification for free. No bespoke regex lives here.
 *
 * PURE — no I/O, no supabase, no fetch. That is what makes it unit-testable: importing
 * keywordResearcher runs createClient() at module load and the sandbox has no DATABASE_URL.
 *
 * ┌─ THE #95 RULE — READ THIS TWICE BEFORE EDITING ────────────────────────────────────────┐
 * │ THIS IS A GATE ON THE **PULL**. IT IS NEVER A PREDICATE ON A **ROW**.                   │
 * │ Task #95 (commit 13b4629) was cured by harvesting "jesus shirt" / "faith shirt" /       │
 * │ "religious shirts" off the seed "christian shirt" — rows carrying NONE of the seed's    │
 * │ literal tokens. Used as a per-row FILTER, this predicate DELETES EXACTLY THAT WIN.      │
 * │ auditSeedTokens COUNTS rows and returns numbers. reserveSeedTokenSlots REORDERS a band  │
 * │ that gets sliced identically either way. Neither can remove a row. Do not "optimise"    │
 * │ either into a .filter(). seedTokenNet.test.ts fails if you do.                          │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * FAIL-OPEN, ALWAYS (doctrine 3). Nothing here can shrink or empty a pool. There is a prior
 * incident where an outage silently PERSISTED an empty pool over approved copy; a net that
 * empties the harvest is indistinguishable from that outage. "Rejected" means ONE more universe
 * is researched, then the verdict is REPORTED LOUDLY — never EMPTIED and never THROWN.
 */

import { isCovered } from './coverage-core'

// ─── Flag. Mirrors the GARMENT_NOUN contract (keywordResearcher.ts:534-535). This repo has no
//     central flags module — each module declares its own. Rollback = env + restart.
//   off    = byte-identical output, ZERO new network calls, ZERO new DB reads, ZERO new logs.
//   shadow = compute + log the audit and the CANDIDATE tail seed. No pull, no reservation, $0.
//            This is how the `on` flip is priced for free before a credit is spent.
//   on     = niche-tail universe armed + cap reservation active.
export const SEED_TOKEN_MODE = (process.env.SEED_TOKEN_NET || 'off').toLowerCase()
export const SEED_TOKEN_ON = SEED_TOKEN_MODE === 'on'
export const SEED_TOKEN_ACTIVE = SEED_TOKEN_ON || SEED_TOKEN_MODE === 'shadow'

// ─── Budgets — doctrine 5: ONE exported constant per budget, none inline ────────────────────
/**
 * A seed token counts as PRESENT at >= this many rows. The measured B0GF49RLDL failure had ZERO,
 * so 0-vs-3 is a wide, unambiguous margin. 1 would go green on a single accidental match while
 * the design is still starved. THIS IS THE TRIP-RATE KNOB: raise it for a stricter net (more
 * universes, more credits), lower it for fewer. Re-tune from shadow data, not from intuition.
 */
export const SEED_TOKEN_MIN_HITS = 3
/**
 * The tail universe YIELDS first: never spend when callsRemaining <= this.
 * JUNGLE_SCOUT_MONTHLY_BUDGET is 950 (cacheService.ts:29) and research PAUSES there; $0.05/call
 * starts above the 1,000 plan limit. Holding 50 calls of slack makes this OPTIONAL pull
 * structurally incapable of being the call that trips the pause or reaches the paid band.
 */
export const SEED_TAIL_MIN_HEADROOM = 50
/**
 * Slots reserved for seed-token rows inside EACH band of the categorizeBuckets cut.
 * Applied to the niche band AND the universe band because the harvested rows can legitimately
 * land in either (a broadNicheSeed/tail universe row is fromUniverse; a Phase-2 or competitor row
 * is not) — reserving in only one band is how this change ships and appears to do nothing.
 * NEITHER BAND'S SIZE CHANGES: reserveSeedTokenSlots reorders, it never adds or removes, so
 * nicheRows.length is still min(count, NICHE_SLOTS) and the universe budget
 * `POOL_SLOTS - nicheRows.length` is arithmetically identical to today.
 * SELF-LIMITING: only rows that would otherwise be CUT are displaced. On a listing whose
 * seed-token rows are already above the cut, displacement is zero.
 * NOT EVIDENCED: 12 is a judgment call (58 of 70 and most of the universe band left to existing
 * behaviour, while 12+12 comfortably exceeds TARGET_SLOTS.CORE = 14). Exported so it is
 * re-tunable from shadow data without touching logic.
 */
export const SEED_TOKEN_RESERVED_SLOTS = 12

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
 * Reusing this seam rather than a bespoke \\b regex is what keeps the net agreeing with every
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
 * defect — the net must not buy a credit trying to rescue a blank-brand seed.
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

/**
 * Reorder a band so the highest-volume seed-token rows occupy the first `slots` positions.
 * The caller still slices — this only decides WHO is inside the slice, never how big it is.
 *
 * BYTE-IDENTICAL GUARANTEE: seedTokens=[] or slots<=0 returns exactly [...rows].sort(volDESC),
 * which is precisely what keywordResearcher.ts:436-440 does today. That is what makes
 * SEED_TOKEN_NET=off and =shadow provable no-ops at the cap. Pinned by unit test.
 */
export function reserveSeedTokenSlots<T extends { keyword: string; searchVolume: number }>(
  rows: T[],
  seedTokens: string[],
  slots: number,
): T[] {
  const sorted = [...rows].sort((a, b) => b.searchVolume - a.searchVolume)
  if (seedTokens.length === 0 || slots <= 0) return sorted
  const reserved: T[] = []
  const rest: T[] = []
  for (const r of sorted) {
    if (reserved.length < slots && seedTokenHit(r.keyword, seedTokens)) reserved.push(r)
    else rest.push(r)
  }
  return [...reserved, ...rest] // both halves stay volume-DESC internally
}
