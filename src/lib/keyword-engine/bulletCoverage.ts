/**
 * Shim → coverage-core (Coherence Invariant 1: ONE coverage predicate).
 * ─────────────────────────────────────────────────────────────────────────────
 * This module used to define the bullet-coverage predicate inline. It is now a thin re-export of
 * `coverage-core.ts`, the single source of truth, so the scorer, the generator, and the report
 * surfaces cannot drift into different rulebooks again.
 *
 * `bulletTokens` / `foldPlural` / `BKW_STOP` keep their EXACT legacy semantics — the GENERATOR
 * (listingPipeline fill/dedupe/floors) and the client "drafted" chip (page.tsx) depend on them.
 * `missingBulletKeywords` is re-exported as the LEGACY (non-garment-folded) check for the same reason
 * (Invariant 4: the fill must still be able to emit "tee").
 *
 * The garment-aware REPORT predicate lives in coverage-core as `coverageTokens` / `isCovered` /
 * `missingCoverage`; `foldGarment` is re-exported here so the backend fill can apply the same fold
 * locally at its echo gates (Step 4) without garment-folding the shared `bulletTokens`.
 */
export { BKW_STOP, foldPlural, bulletTokens, foldGarment } from './coverage-core'
export { missingBulletKeywordsLegacy as missingBulletKeywords } from './coverage-core'
