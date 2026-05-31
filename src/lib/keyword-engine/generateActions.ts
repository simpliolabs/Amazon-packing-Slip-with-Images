/**
 * generateActions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts a keyword's score + presence into a specific, actionable
 * recommendation string — not generic advice, but precise instructions.
 *
 * Examples:
 *   "Add 'funny fishing shirts for men' to your title — 2,502 searches/mo,
 *    only 27 competitors, currently missing from all listing fields."
 *
 *   "Move 'sd card camera' from bullets to your title — you rank #20 and
 *    generate 47 sales/month without even targeting it in the title."
 *
 * Karpathy principle: Goal-driven. Every action tells the user WHAT to do
 * and WHY it will generate ranking + sales.
 */

import { PresenceResult } from './checkPresence';
import { ScoreResult } from './calculateScore';

export interface ActionContext {
  keyword: string;
  searchVolume: number;
  keywordSales: number;
  competingProducts: number;
  asinPurchaseShare: number;
  asinImpressionShare: number;
  presence: PresenceResult;
  score: ScoreResult;
}

export interface KeywordAction {
  actionType: ScoreResult['actionType'];
  opportunityScore: number;
  primaryAction: string;    // The specific thing to do
  rationale: string;        // Why this generates ranking/sales
  urgency: 'high' | 'medium' | 'low';
  estimatedImpact: string;  // e.g. "Could improve rank from ~20 to top 10"
}

function formatVolume(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(v);
}

function formatCompetition(c: number): string {
  if (c <= 0) return 'unknown competition';
  if (c < 100) return `only ${c} competitors`;
  if (c < 1000) return `${c} competitors`;
  return `${(c / 1000).toFixed(1)}K competitors`;
}

/**
 * Detect if a keyword contains variant-specific attributes (capacity, size, color)
 * that should NOT go in the shared title/bullets but ONLY in per-child backend keywords.
 * Examples: "128 gb sd card", "32gb memory card", "large t shirt", "red backpack"
 */
function isVariantSpecificKeyword(keyword: string): boolean {
  const kw = keyword.toLowerCase();
  // Capacity/size patterns: digits followed by unit (gb, tb, mb, oz, ml, lb, kg, ft, in)
  const capacityPattern = /\b\d+\s*(gb|tb|mb|oz|ml|lb|kg|ft|in|mm|cm|l|g|mg)\b/;
  // Clothing sizes
  const sizePattern = /\b(xx?s|xx?l|xxx?l|small|medium|large|x-large|xx-large)\b/;
  // Color patterns (common colors that indicate variant)
  const colorPattern = /\b(black|white|red|blue|green|pink|purple|orange|yellow|grey|gray|silver|gold|navy|brown|beige)\b/;
  return capacityPattern.test(kw) || sizePattern.test(kw) || colorPattern.test(kw);
}

export function generateAction(ctx: ActionContext): KeywordAction {
  const {
    keyword,
    searchVolume,
    keywordSales,
    competingProducts,
    asinPurchaseShare,
    asinImpressionShare,
    presence,
    score,
  } = ctx;

  const vol = formatVolume(searchVolume);
  const comp = formatCompetition(competingProducts);
  const { inTitle, inBullets, inDescription, inBackend } = presence;
  const actionType = score.actionType;

  switch (actionType) {
    case 'CRITICAL': {
      // Not in title, not in bullets — completely missing or only in backend
      const where = inBackend
        ? `currently only in your backend keywords`
        : inDescription
        ? `currently only in your description`
        : `missing from all listing fields`;

      // Variant-specific keywords should go in backend keywords, not shared title/bullets
      const isVariantKw = isVariantSpecificKeyword(keyword);
      const action = isVariantKw
        ? `Add "${keyword}" to the matching variant's backend keywords`
        : `Add "${keyword}" to your title and first bullet point`;
      const rationaleExtra = isVariantKw
        ? ` This is a variant-specific term — add it to the backend keywords of the matching child ASIN, not the shared title/bullets.`
        : ` Amazon can't rank you for a keyword you don't mention in your most visible fields.`;

      return {
        actionType,
        opportunityScore: score.opportunityScore,
        primaryAction: action,
        rationale: `${vol} searches/month, ${comp}, ${where}.${rationaleExtra}`,
        urgency: 'high',
        estimatedImpact: keywordSales > 0
          ? `${keywordSales} total sales/month flow through this keyword — you're capturing 0% of them`
          : `High-volume untapped opportunity`,
      };
    }

    case 'UPGRADE': {
      // In bullets but not title
      return {
        actionType,
        opportunityScore: score.opportunityScore,
        primaryAction: `Move "${keyword}" from your bullets to your title`,
        rationale: `${vol} searches/month. You mention it in bullets but Amazon weights title keywords 3–5× more for ranking. Moving it to the title will directly improve your organic rank.`,
        urgency: 'high',
        estimatedImpact: asinImpressionShare > 0
          ? `You already appear for ${asinImpressionShare.toFixed(1)}% of searches — title placement will increase this significantly`
          : `Title placement is the single highest-impact listing change for ranking`,
      };
    }

    case 'REINFORCE': {
      // In title but not bullets
      return {
        actionType,
        opportunityScore: score.opportunityScore,
        primaryAction: `Add "${keyword}" to at least one bullet point`,
        rationale: `${vol} searches/month. It's in your title but bullets reinforce relevance signals and improve conversion. Customers scanning bullets expect to see their search term confirmed.`,
        urgency: 'medium',
        estimatedImpact: `Reinforcing in bullets improves click-through rate and conversion — both ranking signals`,
      };
    }

    case 'DEFENDED': {
      // In title + bullets — monitor and protect
      const purchaseText = asinPurchaseShare > 0
        ? `You capture ${asinPurchaseShare.toFixed(1)}% of purchases on this keyword.`
        : '';
      return {
        actionType,
        opportunityScore: score.opportunityScore,
        primaryAction: `Maintain current optimization for "${keyword}"`,
        rationale: `${vol} searches/month, ${comp}. ${purchaseText} This keyword is well-covered in your listing. Focus PPC spend here to defend and grow your rank.`,
        urgency: 'low',
        estimatedImpact: `Well-optimized. Consider increasing PPC bid to capture more of the ${keywordSales} monthly keyword sales`,
      };
    }

    case 'OPTIMIZED':
    default: {
      return {
        actionType: 'OPTIMIZED',
        opportunityScore: score.opportunityScore,
        primaryAction: `"${keyword}" is well-covered across your listing`,
        rationale: `${vol} searches/month. Present in ${presence.coverageCount} listing fields. Low incremental opportunity — focus effort on higher-scoring keywords.`,
        urgency: 'low',
        estimatedImpact: `Minimal — this keyword is already well-optimized`,
      };
    }
  }
}

/**
 * Sort and filter a list of keyword actions for display.
 * Returns top N by opportunity score, with CRITICAL and UPGRADE first.
 */
export function prioritizeActions(
  actions: KeywordAction[],
  topN = 25
): KeywordAction[] {
  const priority: Record<string, number> = {
    CRITICAL: 4,
    UPGRADE: 3,
    REINFORCE: 2,
    DEFENDED: 1,
    OPTIMIZED: 0,
  };

  return [...actions]
    .sort((a, b) => {
      // Primary: action type priority
      const pDiff = (priority[b.actionType] ?? 0) - (priority[a.actionType] ?? 0);
      if (pDiff !== 0) return pDiff;
      // Secondary: opportunity score
      return b.opportunityScore - a.opportunityScore;
    })
    .slice(0, topN);
}
