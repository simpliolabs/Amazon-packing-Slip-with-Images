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

import { checkPresence, ListingContent } from './checkPresence';
import { calculateScore, ScoringInputs } from './calculateScore';
import { generateAction, prioritizeActions, KeywordAction, ActionContext } from './generateActions';

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

/** Raw keyword row from Jungle Scout API (future) */
export interface JungleScoutKeywordRow {
  keyword: string;
  searchVolume: number;
  organicProductCount: number;    // competing products
  sponsoredProductCount: number;
  exactPpcBid?: number;
  broadPpcBid?: number;
  relevancyScore?: number;
}

/** Union type for any keyword source */
export type RawKeywordRow = SQPKeywordRow | JungleScoutKeywordRow;

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface AnalyzedKeyword {
  keyword: string;
  opportunityScore: number;
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
  scoreBreakdown?: object;
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
} {
  return {
    keyword: row.keyword,
    searchVolume: row.searchVolume ?? 0,
    keywordSales: 0, // JS doesn't provide total keyword sales directly
    competingProducts: (row.organicProductCount ?? 0) + (row.sponsoredProductCount ?? 0),
    asinImpressionShare: 0, // Not available from JS without our own ASIN data
    asinClickShare: 0,
    asinPurchaseShare: 0,
    relevanceRank: row.relevancyScore ? Math.round((1 - row.relevancyScore) * 100) : 50,
  };
}

// ─── Main Engine Function ─────────────────────────────────────────────────────

export function runKeywordEngine(
  asin: string,
  rawKeywords: RawKeywordRow[],
  listing: ListingContent,
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

    // Skip keywords with zero volume (noise)
    if (normalized.searchVolume < 50) continue;

    // Step 1: Check presence in listing
    const presence = checkPresence(normalized.keyword, listing);

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

    analyzed.push({
      keyword: normalized.keyword,
      opportunityScore: score.opportunityScore,
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
      scoreBreakdown: score.scoreBreakdown,
    });
  }

  // Group by category with dynamic cap:
  // CRITICAL: 5-10 (all scoring ≥50, min 5, max 10)
  // UPGRADE/REINFORCE/DEFENDED: top 10 each
  const criticalAll = analyzed.filter(a => a.actionType === 'CRITICAL')
    .sort((a, b) => b.opportunityScore - a.opportunityScore);
  const criticalCapped = criticalAll.length <= 5
    ? criticalAll
    : criticalAll.filter(a => a.opportunityScore >= 50).slice(0, 10).length >= 5
      ? criticalAll.filter(a => a.opportunityScore >= 50).slice(0, 10)
      : criticalAll.slice(0, 5);

  const upgradeTop = analyzed.filter(a => a.actionType === 'UPGRADE')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
  const reinforceTop = analyzed.filter(a => a.actionType === 'REINFORCE')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);
  const defendedTop = analyzed.filter(a => a.actionType === 'DEFENDED')
    .sort((a, b) => b.opportunityScore - a.opportunityScore).slice(0, 10);

  const topOpportunities = [...criticalCapped, ...upgradeTop, ...reinforceTop, ...defendedTop];

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
