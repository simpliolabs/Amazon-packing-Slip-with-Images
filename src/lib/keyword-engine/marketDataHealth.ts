/**
 * marketDataHealth.ts — ONE definition of "does this keyword pool carry MARKET data?"
 * ─────────────────────────────────────────────────────────────────────────────
 * PO RULING (verbatim, 2026-08-09): "VOLUME is not the biggest thing we look at but the JS
 * opportunity and ranking ability with the right volume." The 3-factor model
 * (market_opportunity = demand × winnability, ease_of_ranking, volume) is the decider —
 * RAW VOLUME ALONE IS NEVER AN ACCEPTABLE SILENT FALLBACK.
 *
 * LIVE EVIDENCE that forced this module (B0GVV3XL4T, probed 2026-08-09): 88 stored keyword rows,
 * 0 with market_opportunity, 0 with a selection rank, research date June 24 (46 days stale), and
 * ZERO "football" rows. The title generator still produced a confident-looking title by falling
 * back to searchVolume ordering — silently — over a pool whose top-volume rows are unwinnable heads
 * for a niche 2026 tee ("usa soccer jersey" 1.98M/mo, "usa soccer shirt" 657K/mo). The degradation
 * was invisible on EVERY surface: the money tail picked on volume, the seller's screen showed the
 * volume order as if it were a priority order, and the RANK council brief handed the LLM composite
 * numbers as if they were market truth.
 *
 * This module is the shared, PURE floor under all three. No I/O, no env reads, no date libraries,
 * and — per the coherence doctrine — NO NEW TOKENIZER OR TEXT PREDICATE. `carriesMarketOpportunity`
 * is a finite-number check on ONE native column (migration 055), deliberately identical to the
 * predicate `priorityDisplay.ts:19` already uses to decide whether to render a market number, so a
 * keyword can never be "market-scored" on one screen and "unscored" on another.
 *
 * Consumers (all three read the SAME functions, which is what makes them incapable of disagreeing):
 *   1. listingPipeline.ts — `rankByMarketOpportunity` REFUSES to hand the money tail a candidate
 *      list when nothing carries market data (returns [] ⇒ byte-identical, honest title).
 *   2. src/app/api/fba/intelligence/[asin]/route.ts — `deriveMarketDataHealth` becomes the
 *      seller-visible health signal on the stored GET.
 *   3. src/lib/fba/rankAnalysis.ts — the council brief says the numbers are not market truth.
 *
 * TTL: this module NEVER declares a freshness number. `ttlDays` is a REQUIRED parameter and every
 * caller passes `RESEARCH_TTL_DAYS` from keywordResearcher.ts (the one existing declaration, the
 * same 14 days keyword_cache expiry is computed from). A default here would be a second, silently
 * divergent TTL — the exact failure mode `EMPTY_POOL_THRESHOLD` was hoisted to prevent.
 */

/** The only fields any of this reads. Structural, so AnalyzedKeyword, RankPlaybookRow, and the
 *  client's hand-mirrored row type all satisfy it without importing each other. */
export interface MarketDataRow {
  /** Native JS market opportunity 0-10 (demand × winnability, migration 055).
   *  null/undefined/absent = NOT MEASURED — never a fabricated 0. */
  marketOpportunity?: number | null
  /** KEYWORD_TARGET_SET selection rank (migration 049). NOT NULL = a chosen ranking target. */
  selectionRank?: number | null
}

/**
 * `fresh`    — rows exist, at least one carries market data, researched within the TTL.
 * `stale`    — rows carry market data but the research is older than the TTL (scores describe a
 *              market that has since moved).
 * `unscored` — rows exist but ZERO carry market_opportunity. THE B0GVV3XL4T state: any ordering of
 *              this pool is volume/composite ordering wearing an opportunity label.
 * `empty`    — no rows at all.
 * `unknown`  — we could not determine it (a failed read, an unparseable timestamp). Fail-open:
 *              callers must degrade to this, never block a regen or throw.
 */
export type MarketDataState = 'fresh' | 'stale' | 'unscored' | 'empty' | 'unknown'

export interface MarketDataHealth {
  /** Stored pool size. */
  rows: number
  /** How many carry a real market_opportunity (the 3-factor decider's first factor). */
  rowsWithMarketOpportunity: number
  /** How many were actually SELECTED as ranking targets (selection_rank NOT NULL). */
  rowsWithSelectionRank: number
  /** keyword_cache.fetched_at for this pool — WHEN the research happened. null = unknown. */
  researchedAt: string | null
  /** Whole days since `researchedAt`; null when it is missing or unparseable. */
  ageDays: number | null
  /** The TTL this verdict was computed against (echoed so the UI never invents its own number). */
  ttlDays: number
  state: MarketDataState
}

/**
 * THE market-data predicate. A finite number (INCLUDING 0 — a measured zero is a measurement)
 * counts; null/undefined/NaN do not. Byte-identical in spirit to `priorityDisplay.ts:19`, which is
 * what decides whether the seller is shown a market number at all.
 * PURE.
 */
export function carriesMarketOpportunity(row: MarketDataRow | null | undefined): boolean {
  const v = row?.marketOpportunity
  return typeof v === 'number' && Number.isFinite(v)
}

/** True when ANY row carries market data. The one question every "is this ordering honest?" check
 *  reduces to. PURE. */
export function hasAnyMarketOpportunity(rows: readonly MarketDataRow[] | null | undefined): boolean {
  return (rows ?? []).some((r) => carriesMarketOpportunity(r))
}

/**
 * THE ordering rule the PO ruling mandates, and the ONLY sanctioned way to order candidates by
 * "opportunity":
 *   - rows WITHOUT market data are DROPPED, never ranked. Volume may only ever break ties BETWEEN
 *     rows that both carry market data — so an unscored row can never be picked "because it has the
 *     biggest number", which is precisely how "usa soccer jersey" (1.98M/mo) beat the design.
 *   - nothing carries market data ⇒ EMPTY. The caller must then refuse (and say so loudly), not
 *     silently fall back to volume.
 *   - `read` is a selector so a caller can rank a WRAPPER (e.g. {k, safe}) without unwrapping and
 *     re-pairing — the pipeline's money-tail candidates are exactly that shape.
 * Stable within a tie: Array.prototype.sort is stable in every runtime we ship on (ES2019+).
 * PURE.
 */
export function rankByMarketOpportunity<T>(
  rows: readonly T[] | null | undefined,
  read: (row: T) => MarketDataRow & { searchVolume?: number | null },
): T[] {
  return (rows ?? [])
    .filter((r) => carriesMarketOpportunity(read(r)))
    .sort((a, b) => {
      const ra = read(a), rb = read(b)
      return ((rb.marketOpportunity as number) - (ra.marketOpportunity as number))
        || ((rb.searchVolume || 0) - (ra.searchVolume || 0))
    })
}

/** Whole days between `researchedAt` and `now`. null when absent/unparseable — an unreadable stamp
 *  must read as "we don't know", never as "0 days old". PURE. */
export function researchAgeDays(researchedAt: string | null | undefined, now: number): number | null {
  if (!researchedAt) return null
  const t = new Date(researchedAt).getTime()
  if (!Number.isFinite(t)) return null
  return Math.floor((now - t) / (1000 * 60 * 60 * 24))
}

/**
 * State derivation. PRECEDENCE IS LOAD-BEARING: empty → unscored → unknown-age → stale → fresh.
 *
 * `unscored` OUTRANKS `stale` deliberately. B0GVV3XL4T is BOTH (46 days old AND zero scored rows);
 * if staleness won, the banner would read "research is a bit old" and the seller would never learn
 * that every number on the screen is volume order. The harsher, more actionable truth wins the
 * label — and `researchedAt`/`ageDays` stay on the payload so the UI can still state the date.
 *
 * The staleness comparison is `ageDays > ttlDays` (STRICTLY greater), mirroring the cache-expiry
 * check at keywordResearcher.ts:1187 exactly — a pool at exactly the TTL is still servable there,
 * so it must not read "stale" here.
 * PURE.
 */
export function deriveMarketDataState(input: {
  rows: number
  rowsWithMarketOpportunity: number
  ageDays: number | null
  ttlDays: number
}): MarketDataState {
  if (input.rows <= 0) return 'empty'
  if (input.rowsWithMarketOpportunity <= 0) return 'unscored'
  if (input.ageDays == null) return 'unknown'
  return input.ageDays > input.ttlDays ? 'stale' : 'fresh'
}

/** The fail-open value. A failed count/timestamp read degrades to THIS — never a thrown error, and
 *  never a fabricated 'fresh'. PURE. */
export function unknownMarketDataHealth(ttlDays: number): MarketDataHealth {
  return {
    rows: 0, rowsWithMarketOpportunity: 0, rowsWithSelectionRank: 0,
    researchedAt: null, ageDays: null, ttlDays, state: 'unknown',
  }
}

/**
 * Count the stored pool and derive its health. Cheap — three passes over rows already in memory,
 * no extra round trips. Never throws: a malformed row array degrades to `unknown`.
 * PURE (apart from the injectable `now`).
 */
export function deriveMarketDataHealth(
  rows: readonly MarketDataRow[] | null | undefined,
  researchedAt: string | null | undefined,
  opts: { ttlDays: number; now?: number },
): MarketDataHealth {
  try {
    const list = rows ?? []
    const counts = {
      rows: list.length,
      rowsWithMarketOpportunity: list.filter((r) => carriesMarketOpportunity(r)).length,
      rowsWithSelectionRank: list.filter((r) => r?.selectionRank != null).length,
    }
    const ageDays = researchAgeDays(researchedAt, opts.now ?? Date.now())
    return {
      ...counts,
      researchedAt: researchedAt ?? null,
      ageDays,
      ttlDays: opts.ttlDays,
      state: deriveMarketDataState({ ...counts, ageDays, ttlDays: opts.ttlDays }),
    }
  } catch {
    return unknownMarketDataHealth(opts.ttlDays)
  }
}
