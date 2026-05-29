/**
 * calculateScore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Calculates the Opportunity Score for a keyword against a specific ASIN.
 *
 * The score replicates the logic behind Helium 10's Cerebro IQ Score:
 * higher score = bigger opportunity for ranking and sales.
 *
 * Formula:
 *   score = (
 *     volumeScore × 30          // demand signal
 *     + salesScore × 25         // proven money flows through this keyword
 *     + competitionScore × 20   // less competition = easier win
 *     + rankMomentumScore × 25  // already ranking = momentum exists
 *   ) × usageGapMultiplier      // listing gap amplifier (1.0 – 3.0)
 *
 * Final score is normalized to 0–100.
 *
 * Karpathy principle: Think before coding. Every weight is justified.
 */

import { PresenceResult } from './checkPresence';

export interface ScoringInputs {
  /** Monthly search volume for this keyword */
  searchVolume: number;
  /** Total purchases across ALL ASINs for this keyword in the period */
  keywordSales: number;
  /** Number of competing products (0 if unknown — uses SQP approximation) */
  competingProducts: number;
  /** ASIN's impression share % for this keyword (0–100) */
  asinImpressionShare: number;
  /** ASIN's click share % for this keyword (0–100) */
  asinClickShare: number;
  /** ASIN's purchase share % for this keyword (0–100) */
  asinPurchaseShare: number;
  /** Amazon's relevance rank (1 = most relevant, 100 = least) */
  relevanceRank: number;
  /** Presence result from checkPresence */
  presence: PresenceResult;
  /** Data source — SQP data is more reliable than inherited */
  dataSource: 'sqp' | 'jungle_scout' | 'inherited';
}

export interface ScoreResult {
  opportunityScore: number; // 0–100
  actionType: 'CRITICAL' | 'UPGRADE' | 'REINFORCE' | 'DEFENDED' | 'OPTIMIZED';
  scoreBreakdown: {
    volumeScore: number;
    salesScore: number;
    competitionScore: number;
    rankMomentumScore: number;
    usageGapMultiplier: number;
    rawScore: number;
  };
}

/**
 * Log-scale normalizer: maps 0–∞ to 0–1.
 * log10(1) = 0, log10(10) = 1, log10(100) = 2, log10(1000) = 3
 * We cap at log10(1,000,000) = 6 → normalized to 1.0
 */
function logNorm(value: number, maxLog = 6): number {
  if (value <= 0) return 0;
  return Math.min(Math.log10(value) / maxLog, 1);
}

/**
 * Linear normalizer: maps value to 0–1 within a given max.
 */
function linearNorm(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(value / max, 1);
}

/**
 * Competition score: fewer competitors = higher score.
 * 0 competing products (unknown) → 0.5 (neutral)
 * 100 competing products → ~0.9 (low competition, great)
 * 10,000 competing products → ~0.3 (high competition, tough)
 * 80,000 competing products → ~0.1 (bloodbath)
 */
function competitionScore(competingProducts: number): number {
  if (competingProducts <= 0) return 0.5; // unknown → neutral
  // Inverse log scale: fewer = better
  const logComp = Math.log10(Math.max(competingProducts, 1));
  const maxLogComp = Math.log10(100000); // 100K = worst case
  return Math.max(0, 1 - logComp / maxLogComp);
}

/**
 * Rank momentum score: if the ASIN is already getting impressions/clicks/purchases
 * on this keyword, it has momentum — easier to push higher.
 *
 * Uses a weighted combination of impression share, click share, and purchase share.
 * Any non-zero share means Amazon already associates this ASIN with the keyword.
 */
function rankMomentumScore(
  impressionShare: number,
  clickShare: number,
  purchaseShare: number
): number {
  // Weighted: purchases matter most, then clicks, then impressions
  const weighted = (
    impressionShare * 0.2 +
    clickShare * 0.3 +
    purchaseShare * 0.5
  );
  // Normalize: 100% share = perfect score, but even 1% is meaningful
  // Use sqrt to give credit for small shares (0.1% → still scores ~0.3)
  return Math.min(Math.sqrt(weighted / 100) * 2, 1);
}

export function calculateScore(inputs: ScoringInputs): ScoreResult {
  const {
    searchVolume,
    keywordSales,
    competingProducts,
    asinImpressionShare,
    asinClickShare,
    asinPurchaseShare,
    presence,
    dataSource,
  } = inputs;

  // Component scores (each 0–1)
  const vScore  = logNorm(searchVolume, 6);           // Volume: log-scaled
  const sScore  = logNorm(keywordSales, 4);            // Sales: log-scaled (max 10K)
  const cScore  = competitionScore(competingProducts); // Competition: inverse log
  const rScore  = rankMomentumScore(
    asinImpressionShare,
    asinClickShare,
    asinPurchaseShare
  );

  // Weighted raw score (0–100 before gap multiplier)
  const rawScore = (
    vScore  * 30 +
    sScore  * 25 +
    cScore  * 20 +
    rScore  * 25
  );

  // Apply usage gap multiplier (1.0–3.0)
  const amplified = rawScore * presence.usageGapMultiplier;

  // Normalize to 0–100 (max possible: 100 × 3.0 = 300 → normalize by 3.0)
  const opportunityScore = Math.min(Math.round(amplified / 3.0), 100);

  // Data source confidence adjustment: inherited data gets a 15% penalty
  const adjustedScore = dataSource === 'inherited'
    ? Math.round(opportunityScore * 0.85)
    : opportunityScore;

  // Determine action type based on score and presence
  const actionType = deriveActionType(adjustedScore, presence);

  return {
    opportunityScore: adjustedScore,
    actionType,
    scoreBreakdown: {
      volumeScore: Math.round(vScore * 100) / 100,
      salesScore: Math.round(sScore * 100) / 100,
      competitionScore: Math.round(cScore * 100) / 100,
      rankMomentumScore: Math.round(rScore * 100) / 100,
      usageGapMultiplier: presence.usageGapMultiplier,
      rawScore: Math.round(rawScore * 100) / 100,
    },
  };
}

/**
 * Derive the action type from the score and listing presence.
 *
 * CRITICAL  — High score + not in title/bullets (biggest gap, easy win)
 * UPGRADE   — Medium-high score + in bullets but not title
 * REINFORCE — Medium score + in title but not bullets
 * DEFENDED  — In title + bullets (no gap, just monitor)
 * OPTIMIZED — Low score or already fully covered
 */
function deriveActionType(
  score: number,
  presence: PresenceResult
): ScoreResult['actionType'] {
  const { inTitle, inBullets, coverageCount } = presence;

  if (score >= 50 && !inTitle && !inBullets) return 'CRITICAL';
  if (score >= 35 && !inTitle && inBullets)  return 'UPGRADE';
  if (score >= 25 && inTitle && !inBullets)  return 'REINFORCE';
  if (inTitle && inBullets)                  return 'DEFENDED';
  if (coverageCount >= 3)                    return 'OPTIMIZED';
  if (score >= 20)                           return 'UPGRADE';
  return 'OPTIMIZED';
}
