/**
 * engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Keyword Intelligence Engine orchestrator.
 *
 * Takes raw keyword data (from SQP or Jungle Scout) + listing content,
 * runs the full pipeline (presence → score → action), and returns a
 * prioritized list of keyword opportunities ready for display and DB storage.
 *
 * This is the single entry point for all keyword analysis.
 * All other engine files are pure functions called from here.
 */

import { checkPresence, checkPresenceAny, ListingContent } from './checkPresence';
import { calculateScore, ScoringInputs } from './calculateScore';
import { generateAction, prioritizeActions, KeywordAction, ActionContext } from './generateActions';
import { poolOpportunityScore } from './poolOpportunity';
// KEYWORD_TARGET_SET (#143): the ONE copy of the legacy 4-bucket tier arithmetic, previously
// duplicated verbatim here and in the Intelligence route.
import { legacyTierBuckets } from './selection-core';

/**
 * Raw search-volume noise floor. Keywords below this monthly volume are dropped
 * before scoring/storage (engine.ts loop). Lowered 50 -> 10 (PO-approved 2026-06-17)
 * to surface genuine low-volume long-tail; 10 still drops dead/near-zero JS noise.
 * NOTE: this is the ONLY raw-volume hard-drop in the pipeline. The relevance gate
 * (+ #283 fromUniverse exemption) runs UPSTREAM and remains the quality guard;
 * scoring (logNorm vScore) de-ranks low-volume terms so they sort to the bottom
 * of the score-capped topOpportunities buckets rather than flooding the TOP list.
 */
export const MIN_SEARCH_VOLUME = 10;

// ─── Input Types ─────────────────────────────────────────────────────────────

/** Raw keyword row from SQP (Brand Analytics) */
export interface SQPKeywordRow {
  searchQuery: string;
  searchQueryScore: number;       // Amazon's relevance rank (1 = most relevant)
  searchQueryVolume: number;
  // Impression data
  totalQueryImpressionCount: number;
  asinImpressionCount: number;
  asinImpressionShare: number;    // 0–100
  // Click data
  totalClickCount: number;
  asinClickCount: number;
  asinClickShare: number;         // 0–100
  totalMedianClickPrice?: number;
  // Cart data
  totalCartAddCount: number;
  asinCartAddCount: number;
  asinCartAddShare: number;
  // Purchase data
  totalPurchaseCount: number;
  asinPurchaseCount: number;
  asinPurchaseShare: number;      // 0–100
}

/** Raw keyword row from Jungle Scout API */
export interface JungleScoutKeywordRow {
  keyword: string;
  searchVolume: number;
  organicProductCount: number;    // competing products (organic_product_count)
  sponsoredProductCount: number;
  exactPpcBid?: number;
  broadPpcBid?: number;
  relevancyScore?: number;        // 0-100, how relevant to the queried ASIN
  easeOfRankingScore?: number;   // 0-100, higher = easier to rank (Cerebro IQ equivalent)
  monthlyTrend?: number;         // % change in search volume month-over-month
  organicRank?: number;          // our ASIN's organic rank for this keyword (0 = not ranking)
  primaryAsin?: string;          // which ASIN this keyword was returned for
  fromUniverse?: boolean;        // merged from a deliberate broad-category/garment-brand universe (#280);
                                 // EXEMPT from the relevance gate — these are rule-generated on-product
                                 // angles (e.g. "graphic tees for women") the gate's token-overlap would
                                 // wrongly strip as "generic". The niche path stays fully gated.
  nicheHead?: boolean;           // set ONLY for broadNicheSeed single-token category heads ("christian
                                 // shirt", "cashflow cap") — NOT broad-category/garment-brand mega-heads.
                                 // Exempt from the #280 x0.7 opportunity demotion (flag-gated) so the
                                 // winnable niche head reaches CRITICAL/title (workflow w6728l4wz C3).
}

/** Union type for any keyword source */
export type RawKeywordRow = SQPKeywordRow | JungleScoutKeywordRow;

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface AnalyzedKeyword {
  keyword: string;
  /** INTERNAL gap-amplified placement composite (0-100) — `rawScore × usageGapMultiplier ÷ 3`
   *  (calculateScore.ts). It swings with OUR OWN coverage (52→19 the moment we cover a keyword),
   *  so it is a PLACEMENT-PRIORITY signal, never market data. Renamed from `opportunityScore`
   *  (PO data-truth rule 2026-08-08): nothing labeled "opportunity" may be fabricated — the
   *  displayable market metric is `marketOpportunity` below. DB column stays `opportunity_score`. */
  coverageGapScore: number;
  actionType: KeywordAction['actionType'];
  actionText: string;
  rationale: string;
  urgency: KeywordAction['urgency'];
  estimatedImpact: string;
  // Metrics
  searchVolume: number;
  keywordSales: number;
  competingProducts: number;
  asinImpressionShare: number;
  asinClickShare: number;
  asinPurchaseShare: number;
  // Presence flags
  inTitle: boolean;
  inBullets: boolean;
  inDescription: boolean;
  inBackend: boolean;
  // Meta
  dataSource: 'sqp' | 'jungle_scout' | 'inherited';
  /** H10 Title Density (import-only): page-1 competitors with the EXACT phrase in their TITLE.
   *  0-2 with real volume = an outsized, low-competition title/highlights win. null for native
   *  SQP/JS keywords (those sources don't measure it). */
  titleDensity?: number | null;
  /** OUR organic rank for this keyword (Jungle Scout, measured on every fresh research).
   *  null = not ranking / not measured. The rank tracker snapshots this over time. */
  organicRank?: number | null;
  scoreBreakdown?: object;

  /* ── NATIVE Jungle Scout market metrics (PO data-truth rule 2026-08-08) ──────────────────────
   * Coverage-INDEPENDENT: none of these can swing when WE change our own listing content.
   * ALL OPTIONAL for the same three reasons as the target-set fields below (hand-built literals,
   * client mirrors, pre-migration-054 rows). null/undefined = honest "not measured" — JS-sourced
   * rows carry them; SQP/import rows do not (surface as "n/a", never a fake 0). */
  /** JS ease_of_ranking_score, native 0-100, higher = easier to rank (Cerebro-IQ equivalent). */
  jsEaseOfRanking?: number | null;
  /** JS relevancy_score, native purchase-intent signal (can exceed 100). */
  jsRelevancyScore?: number | null;
  /** Market-only opportunity 0-10 (poolOpportunityScore: demand × winnability from native fields
   *  ONLY — same synthesis the /fba/keywords pool dashboard shows). THE display metric wherever
   *  "opportunity" is shown to the seller; `coverageGapScore` is the internal placement composite. */
  marketOpportunity?: number | null;

  /* ── KEYWORD_TARGET_SET (#143, 2026-07-24) ────────────────────────────────────────────────────
   * Populated by cacheService.getStoredAnalysis's mapper, and ONLY when selectionMode() === 'on'
   * AND migration 049 has landed. At off/shadow these stay absent, which is what lets every
   * consumer fall open to its legacy list without a second code path.
   *
   * ALL OPTIONAL, deliberately. Three reasons, each of which would otherwise be a build break:
   *   1. `attributeAsKeyword` at listingPipeline.ts:5461 casts a hand-built literal with
   *      `as AnalyzedKeyword` — required fields there would fail the assertion.
   *   2. The client hand-mirrors this interface (KeywordIntelligencePanel.tsx:25,
   *      OptimizerView.tsx:21). Optional fields keep those compiling untouched (PO Q3: defer).
   *   3. Pre-migration rows genuinely lack these columns; `undefined` is the honest value, and
   *      `selectRankingTargets` already treats a null band as 2 rather than hard-gating it.
   *
   * NOTE `prevSelectionRank` is deliberately NOT here. It is the selector's incumbency damper
   * input, read from the PRIOR row inside storeAnalysis's readPriorSignals — a write-time
   * concept. Putting it on the read type would invite a reader to pass this run's rank as the
   * previous one and silently freeze the selection.
   */
  themeFit?: 0 | 1 | 2 | 3 | null;
  themeAbout?: string | null;
  themeRunId?: string | null;
  /** PER-DESIGN theme fit (migration 061, PO 2026-08-21): {designKey: {fit, about}} rated against
   *  EACH design's card on a multi-design family. Read by the shared Item Highlight composer
   *  (min over designs). Same read gating as themeFit; null/absent = never rated per design. */
  themeFitByDesign?: Record<string, { fit: 0 | 1 | 2 | 3; about?: string | null }> | null;
  /** THE membership predicate's backing column. NOT NULL = ranking target. Read via
   *  `isRankingTarget(row)`, never by comparing to a literal — see selection-core.ts. */
  selectionRank?: number | null;
  selectionSlot?: 'CORE' | 'CATEGORY' | 'BACKEND' | null;
  selectionReason?: string | null;
  /** KEYWORD_EASE_WEIGHT the persisted selection was computed under (migration 056). Heal
   *  metadata for the intelligence GET's ease-restamp self-heal — NOT display data, so the
   *  getStoredAnalysis mapper populates it UNGATED by selectionMode. Tri-state:
   *    undefined = pre-056 DB (column absent) — the heal NEVER refires (fail-open);
   *    null      = migrated-but-unstamped (pre-ease era row) — treated as "written under weight 0";
   *    number    = the weight the persisted selection_rank was computed under. */
  selectionEaseWeight?: number | null;
}

export interface EngineResult {
  asin: string;
  analyzedAt: string;
  dataSource: 'sqp' | 'jungle_scout' | 'inherited';
  totalKeywordsAnalyzed: number;
  topOpportunities: AnalyzedKeyword[];   // Top 25, sorted by priority
  allKeywords: AnalyzedKeyword[];        // Full list for DB storage
  summary: {
    critical: number;
    upgrade: number;
    reinforce: number;
    defended: number;
    optimized: number;
  };
}

// ─── SQP Normalizer ──────────────────────────────────────────────────────────

function normalizeSQPRow(row: SQPKeywordRow): {
  keyword: string;
  searchVolume: number;
  keywordSales: number;
  competingProducts: number;
  asinImpressionShare: number;
  asinClickShare: number;
  asinPurchaseShare: number;
  relevanceRank: number;
  organicRank: number | null;
} {
  // Approximate competing products from total impressions
  // Assumption: average product gets ~500 impressions per keyword per month
  const approxCompeting = row.totalQueryImpressionCount > 0
    ? Math.round(row.totalQueryImpressionCount / 500)
    : 0;

  return {
    keyword: row.searchQuery,
    searchVolume: row.searchQueryVolume ?? 0,
    keywordSales: row.totalPurchaseCount ?? 0,
    competingProducts: approxCompeting,
    asinImpressionShare: (row.asinImpressionShare ?? 0) * 100, // normalize to 0-100 if decimal
    asinClickShare: (row.asinClickShare ?? 0) * 100,
    asinPurchaseShare: (row.asinPurchaseShare ?? 0) * 100,
    relevanceRank: row.searchQueryScore ?? 50,
    organicRank: null,   // SQP doesn't measure organic rank — JS rows carry it
  };
}

function normalizeJungleScoutRow(row: JungleScoutKeywordRow): {
  keyword: string;
  searchVolume: number;
  keywordSales: number;
  competingProducts: number;
  asinImpressionShare: number;
  asinClickShare: number;
  asinPurchaseShare: number;
  relevanceRank: number;
  organicRank: number | null;
} {
  // easeOfRankingScore: 0-100, higher = easier to rank (Jungle Scout's Cerebro IQ equivalent)
  // relevancyScore: purchase-intent signal — how much buying intent flows through this keyword
  //   for the queried product type. Brand-specific terms score very high (e.g. 2338 for
  //   "later gator tshirt") while generic terms score low (e.g. 21 for "cool t shirts for men").
  //   This is the correct proxy for keywordSales when SQP data is unavailable.
  const easeScore = row.easeOfRankingScore ?? null;
  const relevScore = row.relevancyScore ?? null;

  // relevanceRank: use easeOfRankingScore (0-100, higher = easier to rank)
  const relevanceRank = easeScore !== null
    ? Math.round(easeScore)
    : relevScore !== null
    ? Math.round(Math.min(relevScore / 30, 100)) // relevancyScore can exceed 100 — normalize
    : 50;

  // keywordSales proxy: use relevancyScore scaled to a realistic sales range.
  // relevancyScore 2000+ = high brand intent (~400 sales/mo equivalent)
  // relevancyScore 100  = moderate intent (~20 sales/mo equivalent)
  // relevancyScore 0-20 = generic/low intent (~0-4 sales/mo equivalent)
  // Scale: relevancyScore / 5 gives a reasonable sales proxy (max ~500 for score 2500)
  const keywordSalesProxy = relevScore !== null && relevScore > 0
    ? Math.round(relevScore / 5)
    : 0;

  return {
    keyword: row.keyword,
    searchVolume: row.searchVolume ?? 0,
    keywordSales: keywordSalesProxy,
    competingProducts: row.organicProductCount ?? 0,
    asinImpressionShare: 0, // Not available from JS
    asinClickShare: 0,
    asinPurchaseShare: 0,
    relevanceRank,
    // OUR organic rank for this keyword (JS measures it on every fetch). 0 = not ranking → null
    // so "unranked" is explicit, not a fake position 0 (the rank tracker stores both states).
    organicRank: (row.organicRank ?? 0) > 0 ? row.organicRank! : null,
  };
}

/**
 * NATIVE market metrics from a raw Jungle Scout row (PO data-truth rule 2026-08-08). PURE.
 * marketOpportunity reuses poolOpportunityScore — the ONE portal-wide "opportunity" definition
 * (already live on /fba/keywords) — so the listing page and the pool dashboard can never disagree
 * about what a 7.2 means. Coverage-independent by construction: inputs are market fields only.
 * Returns nulls when the row carries no usable market data (e.g. a synthetic/imported row with
 * searchVolume 0) so consumers render "n/a" instead of a fabricated 0.
 */
export function nativeMarketMetrics(row: {
  searchVolume?: number;
  organicProductCount?: number;
  relevancyScore?: number;
  easeOfRankingScore?: number;
}): { jsEaseOfRanking: number | null; jsRelevancyScore: number | null; marketOpportunity: number | null } {
  const ease = Number.isFinite(Number(row.easeOfRankingScore)) ? Math.round(Number(row.easeOfRankingScore)) : null;
  const relev = Number.isFinite(Number(row.relevancyScore)) ? Math.round(Number(row.relevancyScore)) : null;
  const volume = Math.max(0, Number(row.searchVolume) || 0);
  // poolOpportunityScore returns 0 for zero volume; distinguish "no demand data" (null) from a real
  // scored 0 by requiring volume > 0 — a synthetic attribute row must show n/a, not 0.0.
  const marketOpportunity = volume > 0
    ? poolOpportunityScore({
        searchVolume: volume,
        organicProductCount: row.organicProductCount,
        easeOfRankingScore: row.easeOfRankingScore,
      })
    : null;
  return { jsEaseOfRanking: ease, jsRelevancyScore: relev, marketOpportunity };
}

// ─── Main Engine Function ─────────────────────────────────────────────────────

export function runKeywordEngine(
  asin: string,
  rawKeywords: RawKeywordRow[],
  // Single row, or ALL of the ASIN's listing_content rows (FBA+FBM twins) — presence is
  // then OR'd per row (checkPresenceAny) so divergent twins can't shadow each other.
  listing: ListingContent | ListingContent[],
  dataSource: 'sqp' | 'jungle_scout' | 'inherited'
): EngineResult {
  if (!rawKeywords || rawKeywords.length === 0) {
    return {
      asin,
      analyzedAt: new Date().toISOString(),
      dataSource,
      totalKeywordsAnalyzed: 0,
      topOpportunities: [],
      allKeywords: [],
      summary: { critical: 0, upgrade: 0, reinforce: 0, defended: 0, optimized: 0 },
    };
  }

  const analyzed: AnalyzedKeyword[] = [];

  for (const rawRow of rawKeywords) {
    // Normalize based on source
    const normalized = dataSource === 'sqp'
      ? normalizeSQPRow(rawRow as SQPKeywordRow)
      : normalizeJungleScoutRow(rawRow as JungleScoutKeywordRow);

    // Skip dead/near-zero-volume noise (see MIN_SEARCH_VOLUME). Real low-volume long-tail (>=10) is kept and de-ranked by scoring.
    if (normalized.searchVolume < MIN_SEARCH_VOLUME) continue;

    // Step 1: Check presence in listing (per-row OR when twin rows are passed)
    const presence = Array.isArray(listing)
      ? checkPresenceAny(normalized.keyword, listing)
      : checkPresence(normalized.keyword, listing);

    // Step 2: Calculate opportunity score
    const scoringInputs: ScoringInputs = {
      searchVolume: normalized.searchVolume,
      keywordSales: normalized.keywordSales,
      competingProducts: normalized.competingProducts,
      asinImpressionShare: normalized.asinImpressionShare,
      asinClickShare: normalized.asinClickShare,
      asinPurchaseShare: normalized.asinPurchaseShare,
      relevanceRank: normalized.relevanceRank,
      presence,
      dataSource,
      // #280 universe terms (JS-only) are demoted in scoring so a design's niche terms out-rank the
      // broad-category heads. SQP rows have no fromUniverse → undefined → false (full weight).
      fromUniverse: (rawRow as JungleScoutKeywordRow).fromUniverse === true,
      // C3: broadNicheSeed heads carry nicheHead → exempt from the x0.7 demotion (flag-gated).
      nicheHead: (rawRow as JungleScoutKeywordRow).nicheHead === true,
    };
    const score = calculateScore(scoringInputs);

    // Step 3: Generate specific action
    const actionCtx: ActionContext = {
      keyword: normalized.keyword,
      searchVolume: normalized.searchVolume,
      keywordSales: normalized.keywordSales,
      competingProducts: normalized.competingProducts,
      asinPurchaseShare: normalized.asinPurchaseShare,
      asinImpressionShare: normalized.asinImpressionShare,
      presence,
      score,
    };
    const action = generateAction(actionCtx);

    // NATIVE market metrics (PO 2026-08-08): only JS-shaped rows carry them. SQP rows get nulls —
    // honest "not measured", surfaced as n/a downstream (never a fake 0).
    const native = dataSource === 'sqp'
      ? { jsEaseOfRanking: null, jsRelevancyScore: null, marketOpportunity: null }
      : nativeMarketMetrics(rawRow as JungleScoutKeywordRow);

    analyzed.push({
      keyword: normalized.keyword,
      coverageGapScore: score.coverageGapScore,
      actionType: score.actionType,
      actionText: action.primaryAction,
      rationale: action.rationale,
      urgency: action.urgency,
      estimatedImpact: action.estimatedImpact,
      searchVolume: normalized.searchVolume,
      keywordSales: normalized.keywordSales,
      competingProducts: normalized.competingProducts,
      asinImpressionShare: normalized.asinImpressionShare,
      asinClickShare: normalized.asinClickShare,
      asinPurchaseShare: normalized.asinPurchaseShare,
      inTitle: presence.inTitle,
      inBullets: presence.inBullets,
      inDescription: presence.inDescription,
      inBackend: presence.inBackend,
      dataSource,
      organicRank: normalized.organicRank,
      scoreBreakdown: score.scoreBreakdown,
      ...native,
    });
  }

  // Group by category with dynamic cap:
  // CRITICAL: 5-10 (all scoring ≥50, min 5, max 10)
  // UPGRADE/REINFORCE/DEFENDED: top 10 each
  //
  // KEYWORD_TARGET_SET (#143). This arithmetic existed VERBATIM in two places — here and at
  // intelligence/[asin]/route.ts — so a change to one silently disagreed with the other. It is now
  // the single exported `legacyTierBuckets`, byte-for-byte identical (including the in-place-sort
  // fix: the original `.filter().sort()` sorted the filtered copy, but `.slice()` before `.sort()`
  // is now explicit so the caller's array can never be reordered underneath it).
  //
  // DELIBERATELY NOT `resolveRankingTargets` HERE. `runKeywordEngine` is called immediately BEFORE
  // `storeAnalysis` in the same request, on rows that carry no `selection_rank` yet — so resolving
  // here would recompute a selection that storeAnalysis is about to compute again from the merged
  // pool, and the two could differ (this pool is pre-merge). One place computes selection: the
  // write path. Everything else reads what it wrote.
  const topOpportunities = legacyTierBuckets(analyzed);

  // Summary counts
  const summary = {
    critical: analyzed.filter(a => a.actionType === 'CRITICAL').length,
    upgrade: analyzed.filter(a => a.actionType === 'UPGRADE').length,
    reinforce: analyzed.filter(a => a.actionType === 'REINFORCE').length,
    defended: analyzed.filter(a => a.actionType === 'DEFENDED').length,
    optimized: analyzed.filter(a => a.actionType === 'OPTIMIZED').length,
  };

  return {
    asin,
    analyzedAt: new Date().toISOString(),
    dataSource,
    totalKeywordsAnalyzed: analyzed.length,
    topOpportunities,
    allKeywords: analyzed,
    summary,
  };
}
