/**
 * keyword-engine/index.ts
 * Barrel export for the Keyword Intelligence Engine.
 */
export { checkPresence } from './checkPresence';
export type { ListingContent, PresenceResult } from './checkPresence';

export { calculateScore } from './calculateScore';
export type { ScoringInputs, ScoreResult } from './calculateScore';

export { generateAction, prioritizeActions } from './generateActions';
export type { ActionContext, KeywordAction } from './generateActions';

export { runKeywordEngine } from './engine';
export type {
  SQPKeywordRow,
  JungleScoutKeywordRow,
  RawKeywordRow,
  AnalyzedKeyword,
  EngineResult,
} from './engine';

export {
  getCachedKeywords,
  setCachedKeywords,
  storeAnalysis,
  getStoredAnalysis,
  logApiCall,
  isWithinBudget,
  getApiUsageStats,
} from './cacheService';

// Outcome loop (task #89): per-keyword SQP share time-series → rose/flat/fell signal.
export { captureShareSnapshots } from './shareSnapshots';
export { computeOutcomeSignals } from './outcomeSignals';
export type { OutcomeSignal } from './outcomeSignals';
