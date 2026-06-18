// poolOpportunity.ts — Pure cross-listing Opportunity Score for the keyword-pool dashboard.
// ──────────────────────────────────────────────────────────────────────────────
// The /fba/keywords pool (keyword_seed_pool.keyword_data) stores RAW Jungle Scout
// fields (searchVolume, organicProductCount, easeOfRankingScore, …). JS's keyword
// API exposes NO single "niche/opportunity" score (that lives in their Opportunity
// Finder, not the Keywords endpoint we pull), so we SYNTHESIZE one here.
//
// This is NOT calculateScore.ts — that score needs per-ASIN signals (impression/
// click/purchase share, presence) the cross-listing pool doesn't have. This one is
// self-contained from the always-present pool fields, on a 0–10 scale to match the
// JS niche-score mental model the seller reasons with (~7+ = strong).
//
// Model: demand × winnability.
//   demand      — search volume, log-scaled. GATES the score: 0 volume → 0, no
//                 matter how uncontested (kills low-volume junk floating to the top).
//   winnability — JS ease-of-ranking (60%) + low competition (40%). Multiplicative
//                 and floored at 0.5×demand, so a high-volume keyword you can't
//                 easily win still keeps half its demand value, but a low-volume
//                 keyword never floats up on low competition alone.
//   fallback    — when JS omits easeOfRankingScore on a pool row, winnability falls
//                 back to low-competition only (volume + competition are always set),
//                 so every row still scores.

export interface PoolKeyword {
  keyword?: string
  searchVolume?: number
  organicProductCount?: number
  easeOfRankingScore?: number // 0–100, JS native, higher = easier to rank
}

/** Opportunity score on a 0–10 scale (JS niche-score model: ~7+ = strong). Pure, deterministic. */
export function poolOpportunityScore(kw: PoolKeyword): number {
  // Number(...) || 0 (not ?? 0) so a malformed/NaN field can't propagate NaN into the sort key.
  const volume = Math.max(0, Number(kw.searchVolume) || 0)
  if (volume <= 0) return 0 // no demand = no opportunity, regardless of competition/ease

  const competing = Math.max(0, Number(kw.organicProductCount) || 0)
  const easeRaw = Number(kw.easeOfRankingScore)
  const ease = Number.isFinite(easeRaw) && easeRaw >= 0 ? Math.min(100, easeRaw) / 100 : null

  const demand = Math.min(1, Math.log10(volume + 1) / 5) // 100→0.4, 1k→0.6, 10k→0.8, 100k→1.0
  // organicProductCount is stored as `?? 0` at write time, so 0 means EITHER genuinely uncontested
  // OR JS returned no value — indistinguishable. A high-volume keyword almost always HAS competitors,
  // so treat 0 as UNKNOWN (neutral 0.5) rather than a perfect low-competition bonus that would float
  // data-sparse keywords to the top. Real counts (>0): 100→0.5, 1k→0.25, 10k→0.
  const lowComp = competing > 0 ? 1 - Math.min(1, Math.log10(competing + 1) / 4) : 0.5
  const winnability = ease !== null ? ease * 0.6 + lowComp * 0.4 : lowComp // 0–1
  const composite = demand * (0.5 + 0.5 * winnability) // demand gates; winnability scales 0.5×–1.0×

  return Math.round(composite * 100) / 10 // 0–10, one decimal
}

/** Sort a keyword list by opportunity score (desc), volume as the tiebreak. Returns a new array. */
export function byOpportunity<T extends PoolKeyword>(keywords: T[]): T[] {
  return [...keywords].sort(
    (a, b) =>
      poolOpportunityScore(b) - poolOpportunityScore(a) || (b.searchVolume ?? 0) - (a.searchVolume ?? 0),
  )
}
