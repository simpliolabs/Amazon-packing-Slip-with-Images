/**
 * calculateScore.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Calculates the COVERAGE-GAP SCORE for a keyword against a specific ASIN.
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
 * NAMING (PO data-truth rule 2026-08-08): this composite was called "opportunityScore", but the
 * ×usageGapMultiplier term makes it swing with OUR OWN coverage — covering a keyword collapses it
 * toward raw/3 (the PO's 52→19 on "christian shirts for women"). It is a PLACEMENT-PRIORITY /
 * gap signal, NOT market data, so nothing may display it as "opportunity". The displayable market
 * metric is `marketOpportunity` (poolOpportunityScore from native JS fields, engine.ts). The DB
 * column keeps its legacy name `opportunity_score` — same number, honest code name.
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
  /** Merged from a #280 broad-category / garment-brand universe ("graphic tees for women"). These are
   *  deliberate high-VOLUME category angles kept for backend coverage, but they must NOT out-rank a
   *  design's own winnable niche terms in the opportunity view — so their score is modestly demoted. */
  fromUniverse?: boolean;
  /** Set ONLY for broadNicheSeed single-token category heads ("christian shirt", "cashflow cap") —
   *  the WINNABLE niche head, not a mega-broad category/brand head. EXEMPT from the x0.7 demotion
   *  (flag-gated) so it reaches CRITICAL and the title front-load (workflow w6728l4wz C3). */
  nicheHead?: boolean;
}

export interface ScoreResult {
  /** Gap-amplified placement composite, 0–100 (see file header — NOT market data). */
  coverageGapScore: number;
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
 * Universe (broad-category / garment-brand) opportunity demotion (#280 niche-priority, 2026-07-17).
 * Universe terms are high-VOLUME but low-WINNABILITY category heads ("graphic tees for women", 456K)
 * that would otherwise monopolize the CRITICAL/opportunity view and bury a design's own niche terms
 * (a fishing tee's fishing keywords). A modest 0.7 factor demotes them just enough that genuinely
 * winnable niche terms out-rank the unwinnable mega-volume heads, WITHOUT evicting universe terms from
 * the pool — they stay for backend coverage, demoted from CRITICAL to UPGRADE at most. Applied BEFORE
 * deriveActionType so the stored coverageGapScore (DB: opportunity_score) and the CRITICAL tier stay coherent (Invariant 6).
 * SAFE for a listing whose niche IS broad (a plain graphic tee): its broad terms arrive via the DESIGN
 * query (non-universe → full weight) and are deduped out of the universe merge, so they keep full priority.
 */
const UNIVERSE_OPPORTUNITY_WEIGHT = 0.7;

/**
 * Log-scale normalizer: maps 0–∞ to 0–1.
 * log10(1) = 0, log10(10) = 1, log10(100) = 2, log10(1000) = 3
 * We cap at log10(1,000,000) = 6 → normalized to 1.0
 */
// EXPORTED for selection-core.ts (KEYWORD_TARGET_SET). The target selector needs the EXACT same
// volume curve this scorer uses; a second copy of it is precisely how this repo grew seven
// disagreeing definitions of "covered". Export only — no behaviour change.
export function logNorm(value: number, maxLog = 6): number {
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
export function competitionScore(competingProducts: number): number {
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

  // Weight rebalancing for Jungle Scout data:
  // JS never provides impression/click/purchase share → rScore is always 0.
  // Redistributing the 25-point rScore weight to vScore (+15) and sScore (+10)
  // prevents JS keywords from being systematically under-scored vs SQP keywords.
  // SQP data keeps the original weights (rScore is meaningful there).
  const wV = dataSource === 'jungle_scout' ? 45 : 30;
  const wS = dataSource === 'jungle_scout' ? 35 : 25;
  const wC = 20;
  const wR = dataSource === 'jungle_scout' ?  0 : 25;

  // Weighted raw score (0–100 before gap multiplier)
  const rawScore = (
    vScore  * wV +
    sScore  * wS +
    cScore  * wC +
    rScore  * wR
  );

  // Apply usage gap multiplier (1.0–3.0)
  const amplified = rawScore * presence.usageGapMultiplier;

  // Normalize to 0–100 (max possible: 100 × 3.0 = 300 → normalize by 3.0)
  const coverageGapScore = Math.min(Math.round(amplified / 3.0), 100);

  // Data source confidence adjustment: inherited data gets a 15% penalty
  const adjustedScore = dataSource === 'inherited'
    ? Math.round(coverageGapScore * 0.85)
    : coverageGapScore;

  // #280 universe demotion (niche-priority): modestly down-weight broad-category / garment-brand universe
  // heads so a design's winnable niche terms out-rank them in the opportunity view. Applied before
  // deriveActionType so the CRITICAL tier and the stored coverageGapScore agree.
  // C3 EXEMPTION (workflow w6728l4wz, flag-gated): a broadNicheSeed HEAD ("christian shirt" ~45k) is
  // the WINNABLE niche head the PO wants front-loaded — NOT a mega-broad category/brand head. When
  // GARMENT_NOUN=on, skip the x0.7 for nicheHead rows so they keep their real (CRITICAL-tier) score.
  // Flag off → the demotion applies to ALL fromUniverse rows exactly as before (byte-identical).
  const nicheHeadExempt = inputs.nicheHead === true && (process.env.GARMENT_NOUN || 'off').toLowerCase() === 'on';
  const finalScore = (inputs.fromUniverse && !nicheHeadExempt)
    ? Math.round(adjustedScore * UNIVERSE_OPPORTUNITY_WEIGHT)
    : adjustedScore;

  // Determine action type based on score and presence
  const actionType = deriveActionType(finalScore, presence);

  return {
    coverageGapScore: finalScore,
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
// EXPORTED (2026-08-08 rank-panel coherence): the RANK panel re-derives its DISPLAYED action from the
// LIVE coverage flags (rankAnalysis.buildFreeCore at COVERAGE_CORE=on) so the badge, the ✓/✗ icon and
// the advice text all come from ONE decision at ONE freshness. A second copy of this ladder is exactly
// how the repo grew seven disagreeing "covered" definitions — export the one that exists.
// Param is the structural subset actually read, so callers with live per-field flags don't have to
// fabricate a usageGapMultiplier. NOTE the score>=20 fallback labels ZERO-presence keywords UPGRADE —
// "UPGRADE ⇒ present" is NOT an invariant; display code must gate presence claims on coverage, not this.
export function deriveActionType(
  score: number,
  presence: Pick<PresenceResult, 'inTitle' | 'inBullets' | 'coverageCount'>
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
