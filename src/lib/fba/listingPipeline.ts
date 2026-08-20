/**
 * listingPipeline.ts — Multi-agent Amazon listing optimization pipeline (PR 2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces the single monolithic LLM call with four focused agents:
 *
 *   Stage 0  Candidate prep      (code)         — score-rank, seasonal-filter, dedup, role-tag keywords
 *   Stage 1  Title Agent         (gpt-4.1-mini) — picks 2-3 candidates, writes title, code validates + retries
 *   Stage 2  Bullets Agent       (gpt-4.1-mini) — receives FINAL title, writes 5 bullets from remaining keywords
 *   Stage 3  Backend Agent       (code + gpt-4.1-mini) — color-group keywords, exclude title/bullet words, byte-cap
 *   Stage 4  Audit Agent         (o4-mini)      — action plan, reconciliation, variant health, product details
 *
 * Why split: one focused prompt per task beats an 860-line prompt doing 11 jobs.
 * The Title/Bullets/Backend outputs are CANONICAL; the Audit agent builds the
 * action plan AROUND them (never regenerates them), and the orchestrator overwrites
 * action_plan replacement_content with the canonical text — so the UI "Copy & Paste"
 * box can never drift from recommended_title/bullets/keywords (the read-path bug class).
 *
 * Each agent is reachable within the Cloudflare 100s idle budget because the caller
 * emits an NDJSON keepalive (onProgress) before every stage.
 */

import OpenAI from 'openai'
import type { AnalyzedKeyword, OutcomeSignal } from '@/lib/keyword-engine'
import { garmentNounFor, SHIRT_BASE, foreignHeadNoun, type GarmentNoun, APPAREL_PRODUCT_TYPES as APPAREL_PRODUCT_TYPES_SHARED } from '@/lib/fba/garmentNoun'
import { missingBulletKeywords, bulletTokens, foldPlural, foldGarment } from '@/lib/keyword-engine/bulletCoverage'
import { coverageMode, makeCoverageChecker } from '@/lib/keyword-engine/coverage-core'
// PO RULING 2026-08-09 — the money tail may never be decided by raw volume. ONE shared pure rule
// (also read by the intelligence GET's health signal and the RANK council brief) so the three
// surfaces cannot disagree about whether a pool carries market data.
import { rankByMarketOpportunity, carriesMarketOpportunity } from '@/lib/keyword-engine/marketDataHealth'
import { isOffNicheKeyword, isForeignKeyword } from '@/lib/keyword-engine/nicheGuards'
// SEASONAL — the ONE list + the ON/OFF-season predicate (PO 2026-07-23). This file used to carry its
// OWN private copy of SEASONAL_TERMS (a `const` at :244) that no other module could reach, which is
// exactly how seven disagreeing definitions of "covered" grew. seasonalTerms.ts is a zero-import leaf,
// so importing it here cannot create a cycle. `isOffSeasonKeyword(kw, [])` is byte-identical to the
// historical blanket `SEASONAL_TERMS.some(...)` strip, so every migrated site below degrades to
// today's behaviour the moment designSeasons is empty (i.e. whenever KEYWORD_TARGET_SET is not 'on').
import { SEASONAL_TERMS, seasonsIn, isOffSeasonKeyword } from '@/lib/keyword-engine/seasonalTerms'
// selectionMode() — CALL-TIME env read of KEYWORD_TARGET_SET (never module scope: a module-scope read
// freezes at import and a Coolify env flip would need a rebuild). Same flag that gates the target-set
// selector, deliberately reused: the selector classifying a keyword CORE and the generators refusing
// to place it is precisely the drift this migration exists to close.
import { selectionMode, isRankingTarget, selectionSha, type SelectionContext } from '@/lib/keyword-engine/selection-core'
// deriveSeasonsFrom — THE one design→occasion derivation, shared with the seven keyword-side callers
// that cannot build a PipelineInput. selectionContext.ts imports seasonalTerms/selection-core/
// loadListingContent only, so importing it here creates no cycle.
import { deriveSeasonsFrom } from '@/lib/keyword-engine/selectionContext'
import { guaranteedIdentitySynonyms, identitySynonymPhrases, getSeedPool, normalizeSeedKey, deriveNicheSeeds } from '@/lib/keyword-engine/keywordResearcher'
// Competitor SEO snapshot (title-council fallback chain Part 1): the seller-named competitor's live
// title/bullets, studied by the multi-design parent-title council for keyword strategy + structure.
import { getCompetitorSeoSnapshot, CompetitorSeoSnapshot } from '@/lib/fba/competitorSeo'
import { SKU_COLOR_CODES } from '@/lib/fba/skuColorCodes'
import { detailValueToString, capItemHighlightRepeats, collarStyleForNeck, ihRepeatViolations, IH_MAX_WORD_REPEATS } from '@/lib/fba/productDetailAttrs'
import { scrubTrademarks, scrubTrademarksArr, scrubTrademarksDeep, buildAdversaryTrademarkClause } from '@/lib/fba/trademarkGuard'
import { deriveAudienceRelationalCompounds } from '@/lib/fba/audienceRelationalCompounds'
import { isCelebrityToken, hasCelebrityName, scrubCelebrityNames, scrubCelebrityNamesArr } from '@/lib/fba/celebrityGuard'
import { expandIdiomDesignName, isIdiomDesign } from '@/lib/fba/titleIdiomExpander'
import { BACKEND_MIN_LEGACY } from '@/lib/fba/backendDegradeGate'
import { loadBlankSpecRows, matchBlankSpecRow, ensureBlankBrandInHighlights, enforceFabricTruth, capabilityBanTokens, stripCapabilityClaims, type BlankSpec, type BlankSpecRow } from '@/lib/fba/blankSpecs'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
import { SEED_GOLD_TITLES, SEED_REJECT_PAIRS, classifyTail, countGarmentMentions, goldSpecBlock, measureGoldShape, rejectPairBlock, specClaimSpans, type GoldShape } from '@/lib/fba/poGoldCorpus'
// NEAREST-GOLD ANCHORING: pure, deterministic, no LLM and no I/O — see buildApparelTitleBrief.
import { nearestGolds, targetFromDesign } from '@/lib/fba/titleReferee'
import { audienceSpans, collapseRepeatedWords, dropSpecOnlyTail, enforceInclusiveAudience, enforceTitleBand, fixApostropheCase, hasInclusiveAudience, isTitleWasteVocabulary, pickDistinctGarmentForm, scrubUnspecdGarmentClaims, stripInclusiveAudience, stripTitleWasteVocabulary, stripVariantColorWords, tryMoneyTail, type TitleBandCtx } from '@/lib/fba/titleBand'
import { shipCensus } from '@/lib/fba/shipCensus'
// Per-design vision scans (Commit 2): one scan per design group via the existing vision helpers.
import { scanProductImage, getProductImageUrl } from '@/lib/keyword-engine/visionScanner'
// Per-design content ANCHOR (fix/content-anchor-not-color): deriveDesignLabel recovers the real
// design name from the SKU designKey; isGarmentColor gates the literal shirt color OUT of the anchor
// so per-design content is about the DESIGN ('Rude Potato'), not the color ('Blue Spruce').
import { deriveDesignLabel, isGarmentColor, BASIC_COLOR_WORD_RE } from '@/lib/fba/designName'
// Per-design name resolution (Commit 2 hot-fix): the seller stores the design name as Amazon's
// Color attribute per variant; fetch via Listings Items API. Token + sellerId resolution mirrors
// the SP-API call sites in pushExecutor.
import { getAccessToken as getSpApiAccessToken } from '@/lib/amazon/auth'
import { getSellerId as getSpApiSellerId } from '@/lib/fba/pushExecutor'

// ─── Shared output types (structurally identical to the route's interfaces) ────

export interface PipelinePerChildKeywords { sku: string; asin: string; keywords: string }
export interface PipelineVariantCorrection { sku: string; field: string; current: string; replace_with: string; reason: string }
export interface PipelineCannibalizationWarning { keyword: string; affected_skus: string[]; issue: string; recommendation: string }
/** value_source (sticky-details gate, 2026-08-08): provenance stamped at the DETERMINISTIC
 *  proposal sites only — 'spec' = blank_specs ground truth (the ONE source allowed to re-propose
 *  over a PO-accepted push), 'audience' = the audience-lean map (defers to an accepted push — the
 *  pushed value is the newer PO declaration), 'ruling' = a deterministic PO ruling from an
 *  LLM-derived fact (today ONLY the crew-neckline → "Round Collar" collar mapping; the sticky gate
 *  honors it solely against an accepted "Collarless"). Absent = LLM guess (never outranks a push).
 *  UNFORGEABLE: the pdiFinal normalize map DELETES any value_source arriving on the blind-cast LLM
 *  parse before the stamp sites run — the invariant is structural, not prompt-behavioral.
 *  Persisted on the JSONB item — no migration. */
export interface PipelineProductDetailImprovement { field_name: string; current_value: string | null; recommended_value: string; reason: string; is_enum?: boolean; enum_valid?: boolean; enum_accepted?: string[]; normalized_from?: string; value_source?: 'spec' | 'audience' | 'ruling' }
export interface PipelineKeywordReconciliation { keyword: string; action_type: 'CRITICAL' | 'UPGRADE' | 'REINFORCE'; search_volume: number; placed_in: string[]; planned_in?: string[]; exact_text: string; why: string }

// Backend-first placement net (Step 3, task #60; TRUTH/PLAN split 2026-08-19, GAP 1 of the B0DSQPZY9S
// craft review): the LLM audit still tends to claim bullet_1..3 for keywords the generator actually
// routed to BACKEND (Content step 2). Re-derive placement from the FINALIZED content so the UI's rank
// work-list never promises a bullets-weave the pipeline won't deliver — the false "Regenerate to weave
// them in" loop. TWO fields, two meanings, never mixed again:
//   placed_in  = TRUTH — surfaces whose bytes literally carry the keyword. NEVER fabricated: the old
//                `|| placed.length === 0 → backend_keywords` fallback reported an uncovered keyword as
//                indexed, so the seller's report lied ("aritzia dupes" claimed placed while in no field).
//   planned_in = PLAN — where an UNplaced keyword should go on the next regen (backend, overflow's
//                sanctioned home). The rank work-list routes off placed_in ∪ planned_in, so unplaced
//                keywords still surface as regen tasks instead of vanishing.
// Haystacks include the per-child multi-design bytes (the ones that actually PATCH Amazon — coherence
// INVARIANT 5), not just the broadcast copy. Uses the LEGACY generator primitive so it reflects what the
// copy LITERALLY carries; emits 'bullet_1'/'backend_keywords' tokens the page's norm() understands.
export function reconcilePlacedInBackendFirst(
  recon: PipelineKeywordReconciliation[],
  finalTitle: string,
  bullets: string[],
  description: string,
  perChild: PipelinePerChildKeywords[],
  perChildBullets?: { bullets: string[] }[],
  perChildDescriptions?: { description: string }[],
): PipelineKeywordReconciliation[] {
  const backendHay = perChild.map((c) => c.keywords || '').join(' ')
  const bulletsHay = [bullets.join(' '), ...(perChildBullets ?? []).map((c) => (c.bullets || []).join(' '))].join(' ')
  const descriptionHay = [description || '', ...(perChildDescriptions ?? []).map((c) => c.description || '')].join(' ')
  return recon.map((kr) => {
    if (!kr.keyword) return kr
    const kw = [kr.keyword]
    const placed: string[] = []
    if (missingBulletKeywords([finalTitle || ''], kw).length === 0) placed.push('title')
    if (missingBulletKeywords([bulletsHay], kw).length === 0) placed.push('bullet_1')
    if (missingBulletKeywords([descriptionHay], kw).length === 0) placed.push('description')
    if (missingBulletKeywords([backendHay], kw).length === 0) placed.push('backend_keywords')
    // Truth stays truth; an uncovered keyword gets a PLAN, never a fabricated placement claim.
    return { ...kr, placed_in: placed, planned_in: placed.length === 0 ? ['backend_keywords'] : undefined }
  })
}
export interface PipelineAplusModuleAction { module_type: string; action: 'ADD' | 'EDIT' | 'KEEP'; content_brief: string; position: number }
export interface PipelineActionPlanItem {
  element: string
  level: 'parent' | 'per_child'
  verdict: 'REPLACE' | 'EDIT' | 'CREATE' | 'DONE' | 'SKIP'
  priority: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
  current_status: string
  instruction: string
  replacement_content?: string | string[] | null
  seller_central_path?: string
  notes?: string | null
  aplus_modules?: PipelineAplusModuleAction[]
}

export interface PipelineChild { sku: string; asin: string; color: string | null; size: string | null; title?: string | null }

export interface PipelineInput {
  /** TITLE_V4 diagnostics sink, set by runListingPipeline for the duration of one run.
   *
   *  WHY IT LIVES ON `input` AND NOT IN A MODULE VARIABLE: BOTH title producers — runTitleAgent
   *  (single-design) and buildNicheParentTitle (multi-design) — are top-level functions that already
   *  receive this object, so one field reaches both paths with no signature churn. A module-level
   *  array would be shared across concurrent regens and would silently mix two listings' numbers.
   *  This repo's path-parity lesson is that an instrument wired to one producer reports confidently
   *  about the other while measuring nothing. */
  __v4Sink?: Record<string, unknown>[]
  openai: OpenAI
  brandName: string
  category: string
  /** SP-API productType for this family's listings (SHIRT, SELF_STICK_NOTE, MEMORY_CARD, …).
   *  GROUND TRUTH for the apparel-vs-not branch: when set it decides outright and the
   *  category/title text heuristic is skipped — a poisoned category string or a previously
   *  contaminated live title can never flip the branch. Null/undefined → legacy heuristic. */
  productType?: string | null
  /** Live product-type schema attributes the seller can broadcast-push (SP-API key + display
   *  title + accepted enum values, from the Product Type Definitions API). When present, the
   *  audit agent recommends Product Details ONLY from this menu — every row is born mapped to
   *  a real attribute of THIS category instead of guessed from an apparel-shaped example list. */
  detailAttributeMenu?: { key: string; title: string; accepted?: string[] }[]
  /** Amazon Custom enrollment (SP-API attributes.is_customizable via listing_content, migration
   *  052). TRUE unlocks "Personalized"/"Custom" as truthful copy: a title-band fact segment, a
   *  backend fact token, and an audit garment-truth clause. Absent/false keeps the ban — most of
   *  the catalog is fixed-design, and "Personalized" on those would be a false claim. */
  customizable?: boolean
  analysis: AnalyzedKeyword[]
  children: PipelineChild[]
  /** Parent ASIN of the family this run generates for. DIAGNOSTICS ONLY — every generator is
   *  child-scoped and nothing branches on it. Threaded (2026-08-09) so the MONEY_TAIL_NO_MARKET_DATA
   *  refusal is attributable to a listing without a child→parent grep. Absent ⇒ null in the log. */
  parentAsin?: string | null
  /** keyword_cache.fetched_at for the analysed ASIN — WHEN this keyword pool was researched.
   *  DIAGNOSTICS ONLY (no gate reads it): a refusal log that says "0 of 88 rows carry market data,
   *  researched 46 days ago" is actionable; one that says only "no market data" is not. Best-effort
   *  at the route — a failed read passes null, which only costs the date in one log line. */
  researchedAt?: string | null
  /** THE SELLER'S OWN LOCKED TITLES + their MEASURED shape (poGoldCorpus.loadPoGoldTitles), loaded
   *  by the ROUTE because it holds the supabase client and this module deliberately does not.
   *  Absent ⇒ the three-title seed floor, so a failed load can never leave the council with no
   *  few-shots. PO 2026-08-10: "I gave you about 70 title recommendations ... that should be a
   *  strong signal for the council/judge how to put these together." */
  poGolds?: { titles: string[]; shape: GoldShape } | null
  /** Current title of the representative child — used for product-name token extraction */
  repTitle: string | null
  /** Canonical listing title (listing_seo_scores.product_title — the title the seller & dashboard
   *  see, sourced from the best-selling child). Preferred over repTitle for DESIGN-NAME extraction:
   *  repTitle is children[0] = the alphabetically-first variant, often a stale/secondary title that
   *  does NOT lead with the design name. Null when no score row exists. */
  canonicalTitle?: string | null
  /** The PO's LOCKED recommended_title when listing_seo_recommendations.title_source='manual'
   *  (migration 044) — the title the shipped IH will actually sit beside, because the persist-time
   *  lock guard (ai-recommendations route) discards this run's fresh title on locked listings.
   *  Consumed by the blank-brand IH waterfall net (PO 2026-08-08); null/absent = not locked →
   *  the net tests the fresh finalTitle. Best-effort at the route (a failed pre-read passes null,
   *  which only means the net keys on finalTitle — never a crash). */
  lockedTitle?: string | null
  /** Seller-set DESIGN NAME override (listing_seo_scores.design_name_override, migration 031).
   *  When set, extractDesignName uses this VERBATIM — bypasses LLM / vision / leadingDesignPhrase.
   *  Deterministic anchor for cases where the heuristic chain fails (PO 2026-06-14:
   *  B0GQVL3K4B's canonical "Don't" curly-apostrophe broke the heuristic → no design name → title
   *  agent picked "Too Young to Retire Too Poor to Quit" from the keyword pool). Null = legacy
   *  LLM-and-heuristic extraction. */
  designNameOverride?: string | null
  /** Per-DESIGN seller name overrides for multi-design families (listing_seo_scores.design_name_overrides,
   *  migration 034). {designKey: name}. In the multi-design group loop, input.designNameOverridesByKey[group.key]
   *  is fed into the group's designNameOverride ABOVE the Amazon Color attribute, so extractDesignName
   *  returns it verbatim for that design. Absent/empty key → fall back to the Color attr → heuristic chain. */
  designNameOverridesByKey?: Record<string, string>
  /** The SelectionContext the calling route resolved for this regen (KEYWORD_TARGET_SET).
   *  deriveDesignSeasons UNIONS its `designSeasons` with the live derivation so the generators'
   *  season set is provably a SUPERSET of the selector's — the direction in which a disagreement
   *  costs a missed placement instead of a dock no regenerate can clear. Absent ⇒ live-only
   *  derivation, i.e. exactly today. */
  selectionCtx?: SelectionContext | null
  /** Manual multi-design classification override (migration 041). true = force multi-design,
   *  false = force single-design, null/undefined = auto-detect via designKeyForSku. */
  isMultiDesignOverride?: boolean | null
  /** Seller-declared audience lean (PR #195, persisted in listing_seo_scores.audience_lean).
   *  The seller knows the design's audience better than keyword statistics ("Darlin'" reads
   *  female even when unisex keywords dominate). male/female narrow the title tail outright;
   *  lean_male/lean_female keep the unisex tail but re-weight gendered keywords across every
   *  pool; unisex forces the neutral tail. Null = legacy keyword-derived audience. */
  audienceLean?: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null
  /** #79 per-section regen — run ONLY this section's agent (~30-60s instead of the full
   *  3-4min chain). Other sections anchor on the seller's STORED recommendation: bullets
   *  regenerate against priorTitle; description/keywords against priorTitle+priorBullets.
   *  The audit stage is skipped entirely (the stored action plan is patched by the route). */
  onlySection?: 'title' | 'bullets' | 'description' | 'keywords'
  /** Stored recommended_title — REQUIRED context when onlySection ≠ 'title'. */
  priorTitle?: string | null
  /** Stored recommended_bullets — REQUIRED context when onlySection ∈ description/keywords. */
  priorBullets?: string[] | null
  /** Stored per_child_titles (multi-design families) — lets a partial regen rebuild the design
   *  groups CHEAPLY (sku/designName/designKey were resolved at full-regen time; no vision/LLM),
   *  so per-design bullets/description/backend fan-outs run on partials too (parity-audit). */
  priorPerChildTitles?: { sku: string; asin: string; title: string; designName?: string; designKey?: string }[] | null
  /** Stored couple concept (unified-set families) — restores the broadcast anchor on partials. */
  priorCoupleConcept?: string | null
  /** Stored per_child_bullets — on keywords/description-only partials the per-design fan-outs
   *  dedupe/ground against each group's REAL bullets instead of the broadcast prior (review). */
  priorPerChildBullets?: { sku: string; asin: string; bullets: string[]; designName?: string; designKey?: string }[] | null
  /** Design-grounded NICHE keyword seeds (PO 2026-07-03). The keyword research is self-referential
   *  (what the listing already ranks for = generic "graphic tees for women"), so a niche design
   *  (book-lover) gets a generic pool and the design-grounding filter strips it → a stub title.
   *  These are LLM-expanded from the design name + secondary phrase, GROUNDED (added to the title's
   *  ground vocab) so the council can fill a full, relevant, on-niche title. */
  nicheSeeds?: string[] | null
  /** Seller-named #1 competitor (listing_seo_scores.competitor_asin/_brand) — title-council
   *  fallback chain Part 1. When set, the multi-design parent title path fetches that listing's
   *  live Catalog SEO snapshot (title/bullets) and hands it to the council as a KEYWORD-STRATEGY/
   *  STRUCTURE reference (constraints-not-exemplars; deterministic brand-leak net downstream).
   *  Absent/null → the snapshot stage is skipped entirely (fail-open, zero behavior change). */
  competitorAsin?: string | null
  competitorBrand?: string | null
  /** Per-variant content block (for the audit's variant-health check) */
  variantDetails: string
  /** Keyword intelligence context block (reused for the audit agent) */
  keywordContext: string
  hasAplus: boolean
  /** Whether the account already has an A+ Brand Story (EMC) module — gates the
   *  brand_story CREATE recommendation so we never tell a seller to create one twice. */
  hasBrandStory: boolean
  /** Vision-scanned design identity read off the product IMAGE (visionScanner.ts) — ground-truth
   *  design/slogan (e.g. "text 'Later Gator'") so the design name doesn't depend on a poorly-written
   *  title. Null when there's no image, the scan failed, or the product isn't a design product. */
  visionDesign?: { designTheme: string; visualElements: string[]; seedKeywords: string[]; suggestedSearchTerms?: string[] } | null
  /** Reasoning-class model for the audit step, e.g. 'o4-mini' */
  auditModel: string
  /** Outcome-loop signals (task #89), keyed by LOWERCASED keyword: per-keyword SQP share rose/flat/fell
   *  since the last monthly snapshot. Used ONLY as a conservative TIEBREAK in title-candidate selection —
   *  among near-equal opportunity, reinforce rising keywords + de-prioritize ones flat-despite-a-change.
   *  Undefined/empty (every case until ~2 months of history exist) → strict no-op, ordering unchanged. */
  outcomeSignals?: Record<string, OutcomeSignal>
  /** NDJSON keepalive emitter — called before each stage */
  onProgress: (msg: string) => void
}

export interface PipelineResult {
  recommended_title: string
  recommended_bullets: string[]
  per_child_keywords: PipelinePerChildKeywords[]
  /** Per-child titles for capacity/size-spec variation families (e.g. SD cards by GB). Undefined
   *  for apparel and single-capacity products, which use the one shared recommended_title. */
  per_child_titles?: { sku: string; asin: string; title: string; designName?: string; designKey?: string }[]
  /** Per-DESIGN bullets/description for multi-design POD apparel families. Each design group gets its
   *  own generated set, fanned out to every SKU in the group. Undefined for single-design and
   *  non-apparel families, which use the one shared recommended_bullets/recommended_description.
   *  designName/designKey label each entry's design group (for the per-design editor cards). */
  per_child_bullets?: { sku: string; asin: string; bullets: string[]; designName?: string; designKey?: string }[]
  per_child_descriptions?: { sku: string; asin: string; description: string; designName?: string; designKey?: string }[]
  recommended_description: string
  variant_corrections: PipelineVariantCorrection[]
  cannibalization_warnings: PipelineCannibalizationWarning[]
  product_details_improvements: PipelineProductDetailImprovement[]
  keyword_reconciliation: PipelineKeywordReconciliation[]
  action_plan: PipelineActionPlanItem[]
  // Off-product keywords the relevance gate dropped — the API route marks these in
  // keyword_analysis so the scorer stops penalizing for keywords that target a different product.
  irrelevant_keywords: string[]
  /** KeywordPlan (#92/#93) — the generator's ACTUAL bullet opportunity set (topOpportunityKwsForBullets)
   *  + the real design name. Persisted so the SCORER docks bullets against the SAME set the generator
   *  targeted (killing the source/relevance-gate/title-exclusion divergence the shared predicate alone
   *  couldn't close) and can enforce cross-section design-name cohesion off the REAL design name — not a
   *  capacity-unsafe title heuristic. */
  /** KEYWORD_TARGET_SET (#143): `selected` is a DERIVED MIRROR of the 30 ranking targets, persisted
   *  for scorer/provenance parity only — keyword_analysis.selection_rank remains the single source of
   *  truth (migration 049's header explicitly rejects keyword_plan as selection's home: it is keyed on
   *  parent_asin, while both the Intelligence tab and the RANK panel resolve to a CHILD).
   *  `selectionSha` lets a later reader prove which selection a stored plan was built from. */
  keywordPlan: { bullets: string[]; designName: string; coupleConcept?: string; perDesign?: { designKey: string; bullets: string[] }[]; selected?: string[]; selectionSha?: string }
  /** `v4` carries the TITLE_V4 shadow measurement per bandTitle trip — shipped vs the title WITHOUT
   *  the padding, and whether removing it would drop under the seller's corpus floor. On the
   *  response, not only in a log line, so the refusal rate needs no shell access to read. */
  debug: { titleProblems: string[]; candidatesUsed: string[]; titleRetried: boolean; designName?: string; designSource?: string; multiDesign?: boolean; designGroups?: string[]; nicheSeeds?: string[]; v4?: Record<string, unknown>[] }
  /** #79 per-section regen: set when onlySection ran — ONLY that section's fields are
   *  meaningful; the route merges them into the STORED recommendation row. */
  regeneratedSection?: 'title' | 'bullets' | 'description' | 'keywords'
  /** Degradation flags (2026-07-08): sections whose output failed post-conditions on a FULL regen
   *  after retry (core sections THROW instead via assertCoreHealthy). The route must NOT persist a
   *  flagged section — it keeps the stored value and surfaces a warning, instead of the old
   *  console.warn-and-persist that shipped an 86-char title-echo string over 245-byte approved
   *  keywords. 'description' added 2026-07-30 (Phase 3): the ship census found a 719-char
   *  description PERSISTING against the 900 floor — the same post-audit blind spot as the 118-byte
   *  backend — so census floor violations now degrade-mark and route into this same preserve. */
  degradedSections?: ('backend_keywords' | 'description')[]
}

// ─── Constants / small helpers ────────────────────────────────────────────────

// SEASONAL_TERMS now lives in keyword-engine/seasonalTerms.ts and is IMPORTED at the top of this file.
// The private copy that used to sit here was deleted 2026-07-23: it made the generators' notion of
// "seasonal" unreachable by the keyword selector, so the two could silently disagree.
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'in', 'on', 'with', 'of', 'to', 'at', 'by'])
const KIDS_AUDIENCE = ['kids', 'kid', 'toddler', 'toddlers', 'baby', 'babies', 'infant', 'youth', 'boys', 'girls', 'children']
const ADULT_AUDIENCE = ['men', 'mens', 'women', 'womens', 'man', 'woman', 'adult', 'adults']
const GENERIC_APPAREL = new Set([
  'shirt', 'shirts', 'tshirt', 'tshirts', 'tee', 'tees', 'top', 'hoodie', 'sweatshirt',
  'tank', 'crewneck', 'pullover', 'graphic', 'vintage', 'retro', 'funny', 'novelty',
  'classic', 'comfort', 'cotton', 'soft', 'color', 'colors', 'cute', 'cool', 'gift',
])
// Meaningless filler + Amazon-prohibited subjective/temporal claims. These are never
// real search terms; they leak from low-quality keyword pulls (e.g. "interest",
// "full transparency") and from claim words Amazon forbids in search terms. Used as a
// DETERMINISTIC backstop to the non-deterministic LLM relevance gate, and to keep the
// code-built backend core clean.
const JUNK_WORDS = new Set([
  'interest', 'interested', 'transparency', 'full', 'thing', 'things', 'stuff',
  'item', 'items', 'product', 'products', 'misc', 'general', 'various', 'etc',
  'best', 'bestseller', 'bestselling', 'cheap', 'cheapest', 'discount', 'sale',
  'free', 'new', 'hot', 'popular', 'amazing', 'awesome', 'guaranteed', 'official',
])
/** True if every meaningful (non-minor) word in the phrase is junk filler. */
function isAllJunk(phrase: string): boolean {
  const words = phrase.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !MINOR_WORDS.has(w))
  return words.length > 0 && words.every((w) => JUNK_WORDS.has(w))
}
// Profession/role words a graphic tee usually ISN'T about. Dropped from the backend core
// UNLESS the word is in the title (a genuine "Best Teacher" shirt keeps "teacher"). Stops
// weak-relevance leaks like "...gator teacher..." on a "see you later alligator" design.
const ROLE_WORDS = new Set([
  'teacher', 'teachers', 'nurse', 'nurses', 'doctor', 'doctors', 'educator', 'educators',
  'coach', 'coaches', 'professor', 'professors', 'principal', 'student', 'students',
])

// G4 — audience/relation words that are legitimate in GIFT framing ("great gift for
// teachers, nurses, mom") even though they stay banned as product-identity claims.
// ROLE_WORDS ∪ common gift recipients the seller's niches search for (college, nursing,
// bible study, family relations). Used to build the GIFT & OCCASION bullet's audience pool.
const AUDIENCE_GIFT_WORDS = new Set([
  ...ROLE_WORDS,
  'college', 'nursing', 'bible', 'church', 'mom', 'dad', 'mama', 'grandma', 'grandpa',
  'wife', 'husband', 'sister', 'brother', 'aunt', 'uncle', 'girlfriend', 'boyfriend',
])

// VISUAL MOTIF nouns — claims about what is PRINTED on the artwork. The vision scan is a
// useful witness but it HALLUCINATES motifs (live failure: it read a heart into the Darlin'
// script font → "Comfort Colors Heart Graphic Tee" recommended for a country-western design
// with no heart anywhere). RULE: a motif word may only appear in customer-facing copy when
// the SELLER's own text corroborates it (canonical/live title or design name) — vision alone
// is never sufficient for a visual claim. Generic style words are NOT motifs (handled by the
// grounding vocab); this list is concrete drawable THINGS.
/* ERA / STYLE CLAIM WORDS — the OTHER thing the design-grounding guard legitimately protects.
 *
 * VISUAL_MOTIF_WORDS covers invented OBJECTS ("cassette" on a slogan tee). These cover invented
 * PERIOD/CONDITION claims — "vintage 90s shirt" on a design that is neither. Both are assertions
 * about the ARTWORK, and no keyword-relevance classifier checks them, so both must stay grounded in
 * the seller's own text no matter how strong the search demand is.
 *
 * They are named SEPARATELY (2026-08-13) because the guard was doing three jobs under one test:
 * block invented objects, block invented eras, and — accidentally — delete the real SEARCH
 * vocabulary of the thing a design is ABOUT. Measured on B0GVV3XL4T: "usa jersey" was dropped from
 * a World Cup design whose seller gold closes "USA Mexico Canada Football Tee". Separating the
 * three lets the first two stay strict while the third stops being collateral. */
const ERA_STYLE_CLAIM_WORDS = new Set([
  'vintage', 'retro', 'distressed', 'faded', 'antique', 'throwback', 'nostalgic', 'y2k', 'weathered',
])
/** "90s", "80s", "1990s" — a decade is a period CLAIM about the artwork, same tier as `vintage`. */
const isDecadeClaim = (w: string): boolean => /^(19|20)?\d0s$/.test(w)

const VISUAL_MOTIF_WORDS = new Set([
  'heart', 'hearts', 'sunflower', 'sunflowers', 'butterfly', 'butterflies', 'skull', 'skulls',
  'flag', 'flags', 'cross', 'crosses', 'anchor', 'rose', 'roses', 'daisy', 'daisies',
  'leopard', 'cheetah', 'cow', 'horse', 'horses', 'cactus', 'lightning', 'rainbow',
  'flamingo', 'peach', 'snake', 'eagle', 'wolf', 'bear', 'gnome', 'pumpkin', 'ghost',
  'santa', 'angel', 'mushroom', 'dragonfly', 'hummingbird', 'owl', 'fox',
  // Nostalgia/everyday OBJECTS an LLM commonly invents to "enrich" an abstract slogan design
  // (PO 2026-06-15: a "Funny Gen X" slogan tee got titled "Cassette Tee" — no cassette in the art).
  // Only stripped when the seller's OWN text doesn't corroborate them, so a real cassette/guitar
  // design (the word IS in its title/design name) keeps it; an invented one is removed.
  'cassette', 'cassettes', 'boombox', 'walkman', 'vinyl', 'guitar', 'guitars', 'dinosaur', 'dinosaurs',
  'unicorn', 'unicorns', 'llama', 'llamas', 'sloth', 'sloths', 'dragon', 'dragons',
])

/** Strip motif words the seller's own text doesn't corroborate (vision-hallucination backstop).
 *  trustedHaystack = canonical title + rep title + design name, lowercased. Word-boundary
 *  removal + punctuation/space cleanup — drops the bad word, keeps the sentence. */
function stripUngroundedMotifs(text: string, trustedHaystack: string): string {
  if (!text) return text
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  const bad = [...new Set(words.filter((w) => VISUAL_MOTIF_WORDS.has(w) && !new RegExp(`\\b${w.replace(/s$/, '')}`, 'i').test(trustedHaystack)))]
  if (bad.length === 0) return text
  const re = new RegExp(`\\b(?:${bad.join('|')})\\b`, 'gi')
  return text.replace(re, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,!;:])/g, '$1').replace(/,\s*,/g, ',').trim()
}

// GARMENT-TYPE words that flip the PRODUCT IDENTITY. The Amazon catalog attributes often
// carry the BLANK manufacturer's boilerplate (live failure: a Comfort Colors T-SHIRT family
// whose catalog attrs said "Men's Heavyweight Crewneck Sweatshirt Cotton Blend Pullover" —
// the title agent treated attrs as trusted product facts and titled a tee as a fleece
// pullover). RULE: a garment word may only appear when the SELLER's text (canonical/rep
// title, design name) or the SP-API productType corroborates it. Material/fit words
// (cotton, heavyweight, crewneck) are NOT listed — they don't flip the product type.
const GARMENT_TYPE_WORDS = new Set([
  'sweatshirt', 'sweatshirts', 'hoodie', 'hoodies', 'pullover', 'pullovers',
  'fleece', 'sweater', 'sweaters', 'jacket', 'jackets', 'coat', 'coats',
  'tank', 'tanks', 'polo', 'polos', 'onesie', 'romper', 'leggings',
  // PO-caught 2026-07-08: "trendy blouses" shipped in a T-SHIRT's backend — these are garments
  // this product is NOT (unless the truth hay says so, same grounding rule as the rest).
  'blouse', 'blouses', 'tunic', 'tunics',
])

// Category/promo words with NO search value in backend (PO 2026-07-08: the fill read like "a
// promotional string, not keywords") — a shopper searching "golf widow gift" never types
// "apparel"; even when they do type a category word, the product-type tokens already cover it.
// Unconditional ban in banBackendTok/groupBan (unlike GARMENT_TYPE_WORDS these are never
// grounded facts about THIS product — they're catalog-speak).
const BACKEND_GENERIC_FILLER = new Set([
  'apparel', 'clothing', 'clothes', 'outfit', 'outfits', 'wear', 'wardrobe',
  'garment', 'garments', 'fashion', 'trendy', 'stylish',
])

// Foreign-language FUNCTION words (ES/PT) — no search value, English MINOR_WORDS/stopwords don't
// list them, so a keyword like "camisetas para mujer de algodon" was placing "para"/"de" as if
// content (adversarial 2026-07-09). Banned in the backend gate so the CONTENT tokens (camisetas,
// mujer, algodon) still land and the function words don't waste bytes.
const FOREIGN_FUNCTION_WORDS = new Set([
  'para', 'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'con', 'por', 'y', 'o', 'e', 'en',
])

// HEAVY (warm-layer) garments — the subset of GARMENT_TYPE_WORDS a t-shirt/tee can NEVER also be.
// When the seller's OWN text proves the product is a tee, these are stuffing/mis-categorization noise.
const HEAVY_GARMENT_WORDS = new Set([
  'sweatshirt', 'sweatshirts', 'hoodie', 'hoodies', 'pullover', 'pullovers',
  'fleece', 'sweater', 'sweaters', 'jacket', 'jackets', 'coat', 'coats',
])
// A LIGHT base garment word in the SELLER'S OWN text (canonical/rep title, design) = the product is a
// shirt/tee, so any heavy garment word is keyword-stuffing or a mis-categorized productType, not the item.
const LIGHT_BASE_GARMENT_RE = /\b(?:t-?shirts?|tees?)\b/i

// STYLE/CUT claims — sibling of GARMENT_TYPE_WORDS for the backend token gate. Jungle Scout's
// top category phrases describe the whole "comfort colors" NICHE, not this product: "cropped
// comfort colors", "pocket tee", "blank tshirts", "oversized boxy" — tokens that mis-describe a
// regular-cut printed graphic tee (PO: 'Super BAD keywords "cropped pocket solid plain black for
// cotton oversized blank"'). Like garment words, a style/cut token needs corroboration from the
// SELLER'S OWN text (canonical/rep title, design, product type) to enter backend keywords —
// "blank"/"plain" additionally attract wholesale buyers hunting unprinted shirts, the wrong
// customer for a graphic tee. Fabric/material words (cotton, lightweight) stay free — they
// describe the blank's substance, not a contradictable cut.
const STYLE_CUT_WORDS = new Set([
  'cropped', 'crop', 'pocket', 'boxy', 'oversized', 'oversize', 'slim', 'fitted',
  'muscle', 'raglan', 'ringer', 'sleeveless', 'henley', 'longline', 'flowy', 'baggy',
  'distressed', 'bleached', 'plain', 'blank', 'solid', 'tall', 'petite', 'maternity',
])

// OTHER blank / competitor apparel brands that must NOT appear in a product's customer-facing copy:
// they mis-describe the actual garment (a Comfort Colors tee is NOT Gildan/Dickies) and reference a
// competitor brand (PO: "why are DICKIES and Gildan here in bullets?"). These leak from the Jungle
// Scout keyword pool (shoppers search competitor blanks). The product's OWN blank (attributePin,
// e.g. "Comfort Colors") is exempted at call time. Includes common misspellings (gilden, bella convas).
// Deliberately NOT included: ambiguous words that can be real design tokens ("champion", "next level",
// "anvil", "district").
const OTHER_BLANK_BRANDS_RE = /\b(?:gild[ae]n|guildan|bella\s*\+?\s*canvas|bella\s*convas|american\s*apparel|fruit\s*of\s*the\s*loom|dickies|carhartt|jerzees)\b(?:\s+(?:soft\s*style|softstyle))?/gi
function stripCompetitorBlanks(text: string, ownBlank: string): string {
  if (!text) return text
  const own = (ownBlank || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return text
    .replace(OTHER_BLANK_BRANDS_RE, (m) => (own && m.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(own.slice(0, 6)) ? m : ''))
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/,\s*,/g, ',').replace(/[,\s]+\.(?=\s|$)/g, '.').replace(/[,\s]+$/g, '').trim()
}
function stripContradictedGarments(text: string, trustedHaystack: string, sellerGarmentText?: string): string {
  if (!text) return text
  // When the SELLER'S OWN text (titles/design — NOT the unreliable SP-API productType) establishes a
  // LIGHT base garment (t-shirt/tee), a HEAVY garment word (sweatshirt/pullover/hoodie/…) is keyword-
  // stuffing or a mis-categorized productType, NOT the real product — strip it from the OUTPUT even when
  // the haystack "corroborates" it. Live (B0GQ6PGR2N): a Comfort Colors LONG SLEEVE tee whose seller
  // title stuffed "Pullover Top" AND whose SP-API productType was SWEATSHIRT got titled a "Sweatshirt".
  const heavyIsStuffing = !!sellerGarmentText && LIGHT_BASE_GARMENT_RE.test(sellerGarmentText)
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  const bad = [...new Set(words.filter((w) =>
    GARMENT_TYPE_WORDS.has(w) && (
      !new RegExp(`\\b${w.replace(/s$/, '')}`, 'i').test(trustedHaystack) ||
      (heavyIsStuffing && HEAVY_GARMENT_WORDS.has(w))
    )))]
  if (bad.length === 0) return text
  const re = new RegExp(`\\b(?:${bad.join('|')})\\b`, 'gi')
  return text.replace(re, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,!;:])/g, '$1').replace(/,\s*,/g, ',').trim()
}

/** BACKEND variant of the hard-audience rule: search terms are invisible, so instead of
 *  swapping we REMOVE the opposite gender's standalone tokens ("…darlin mens black men…"
 *  on a Female listing — PO: "it is still using MAN/MEN in keywords, WHY?"). Compound
 *  words survive (\b keeps "businesswoman" intact under Male). Lean_* keeps both genders
 *  (soft re-weighting only — cross-traffic is the point of lean). */
function stripOppositeGenderTokens(s: string, lean: 'male' | 'female'): string {
  const re = lean === 'female'
    ? /\b(?:men|mens|man|male|boys?)\b/gi
    : /\b(?:women|womens|woman|ladies|female|girls?)\b/gi
  let out = s.replace(re, '').replace(/\s{2,}/g, ' ').trim()
  // Removing a token can orphan its connector ("rodeo shirt for men" → "rodeo shirt for") —
  // a dangling preposition wastes bytes and shipped live on every child (PO screenshot).
  // Trim connector words off both ends until a content word anchors them.
  const EDGE_CONNECTOR = /^(?:for|with|and|or|the|a|an|to|in|on|of)\s+|\s+(?:for|with|and|or|the|a|an|to|in|on|of)$/i
  let prev = ''
  while (prev !== out) { prev = out; out = out.replace(EDGE_CONNECTOR, '').trim() }
  return out
}

/** Top-N opportunity phrases handed to fillBackendToBudget as its PRIORITY SEED. Strings only —
 *  the fill appends bytes and the ORDER carries the priority, so whatever leads this list wins the
 *  most valuable backend real estate.
 *
 *  IT NO LONGER RE-SORTS BY RAW VOLUME (2026-08-18). The original docstring justified a volume
 *  re-sort with "the backend pool is sales-PRIMARY sorted, so a high-volume/low-sales phrase can sit
 *  far down the pool and never be reached before the 244-byte stop". That premise DIED with #143:
 *  `backendPool` is now sorted with `targetRankGap` as the PRIMARY key, under a comment that reads
 *  "Targets lead so they claim bytes first". The pool head IS the decided priority.
 *
 *  So re-sorting it by `searchVolume` DESC discarded the referee's decision for exactly the eight
 *  slots that matter most, and replaced it with the one signal the seller has ruled against twice:
 *  raw volume. That is how a niche design loses its own vocabulary — measured on B0GVV3XL4T, where
 *  the pool carries 95% of its volume in generic apparel heads ("oversized tshirts for women",
 *  385K) that no shopper of a World Cup tee is typing. Volume-DESC is the same mechanism recorded
 *  in the harvest defect: the design can never outrank the category.
 *
 *  It is also the same DOCTRINE violation as the title length-pad: a deterministic step overriding
 *  the decider AFTER the ballot closed. Code may filter and propose; it may not overrule.
 *
 *  Volume survives as a TIE-BREAK only — inside one decision rank it is a real signal, and the pool
 *  comparator already exhausts its own keys before ties remain. Taking the head in POOL ORDER means
 *  targets lead, CRITICAL follows, and volume still separates equals. */
const topVolumeBackendPhrases = (
  pool: { keyword: string; searchVolume?: number | null }[],
  n = 8,
): string[] => pool.slice(0, n).map((k) => k.keyword)

/** Fill each child's backend string toward the 250-byte budget (PO: "NOT utilizing all
 *  250 characters" — the agent's ~240 target landed at 228, leaving ~20 bytes of free
 *  ranking real estate per child). Additions, in trust order:
 *    1. The SELLER'S OWN canonical-title descriptor bigrams ("country western", "vintage
 *       rodeo") — the PO's exact catch: "COUNTRY… was not part of the new suggestions".
 *       These are pre-trusted (their words about their product) and segment-aware (never
 *       spliced across punctuation).
 *    2. Leftover pool keywords (already relevance-gated), skipping third-party brands and
 *       capacity tokens on capacity families.
 *  Only NOVEL tokens are appended (the field is a token soup — duplicates waste bytes),
 *  and the 250-byte hard cap is never crossed. All 4 call sites strip opposite-gender tokens
 *  BEFORE calling this (the "Strip BEFORE fill" fix), so there is NO post-fill gender strip —
 *  gender safety for our additions comes from `banTok` inside the pass. */
function fillBackendToBudget(
  keywords: string,
  canonicalTitle: string | null | undefined,
  poolKeywords: string[],
  ownBrands: Set<string>,
  capacityFamily: boolean,
  /** Same token truth gate the core uses — pool phrases can carry sibling colors and
   *  ungrounded style words; the byte-fill must not smuggle back what the core banned. */
  banTok: (w: string) => boolean = () => false,
  /** Tokens Amazon ALREADY indexes for this listing (live title + bullets + brand + colors,
   *  normTok'd, design tokens exempted). The fill must not spend backend bytes re-adding them —
   *  the canonical-bigram source was the title-echo culprit (PO-approved removal 2026-07-08). */
  alreadyIndexed?: Set<string>,
  /** VOLUME-priority seed (2026-07-10): the highest-search-volume opportunity phrases, volume-sorted.
   *  Their scorer-required tokens are force-placed BEFORE the sales-ordered generic fill, and a
   *  product-type token (tee/tees/…) is exempted from the PRODUCT_TYPE_WORDS skip IFF title+bullets
   *  do NOT already index it under the SCORER's plural fold. Empty [] = today's behavior byte-for-byte. */
  priorityPhrases: string[] = [],
  /** The scorer's non-backend HAYSTACK for THIS listing = `${title} ${bullets.join(' ')}`. Used ONLY
   *  to decide (fold-aware, via the scorer's own bulletTokens) which priority tokens are genuinely
   *  uncovered, so we never spend a byte echoing a token the title already ranks for. */
  coverageHay: string = '',
  /** Spec-grounded product-FACT phrases (blankSpecFactTokens) — Phase 6 facts-only pad. LAST in
   *  candidate priority: demand-backed pool + the seller's catalog bigrams always claim bytes
   *  first; facts fill only the residual gap on thin pools (the 197/220 class). [] = byte-identical
   *  to today. Every safety filter below (banTok / alreadyIndexed / caps) applies to them too. */
  factTokens: string[] = [],
): string {
  let out = (keywords || '').trim()
  // Token-normalized novelty: the field is a token soup (Amazon matches tokens, not
  // phrases), so compare and append WITHOUT punctuation — "darlin'" must not be appended
  // as a duplicate of the already-present "darlin".
  const normTok = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  const have = new Set(out.split(/\s+/).map(normTok).filter(Boolean))

  // COVERAGE_CORE coupling (Invariant 4): garment-awareness in the fill is only correct when the SCORER
  // also folds garments (=on). At =off the scorer's checkPresence needs the LITERAL garment token, so the
  // fill keeps adding it (today's #373/#374 behavior, byte-identical). At =on the title's "Shirt" already
  // covers "tee"/"tees"/"shirts", so the fill must NOT waste a byte echoing it — and MAY add a garment
  // token in the rare case the title carries none. `gfold` = the scorer's fold view for a candidate token.
  const gOn = coverageMode() === 'on'
  const gfold = (t: string): string => (gOn ? foldGarment(foldPlural(t)) : foldPlural(t))

  // ── VOLUME-PRIORITY PASS (2026-07-10, the score-mover) ──────────────────────────────────────────
  // Runs FIRST — BEFORE both the >=244 short-circuit and the generic sales-ordered loop — so the
  // highest-VOLUME opportunity phrases get first claim on any free bytes up to the 250 cap, even when
  // the agent already filled the field near budget (a completely-full 250-byte field simply can't fit
  // more — best-effort by design, no displacement of existing tokens). Unlike the generic loop it does
  // NOT apply the blanket PRODUCT_TYPE_WORDS skip; the echo safety that skip provided is replaced by a
  // FOLD-AWARE coverage gate (scorerHave = the scorer's foldPlural'd view of title+bullets+placed) PLUS
  // alreadyIndexed (which carries every sibling COLOR + title/bullet tokens). So a pool "shirts" (fold
  // "shirt" in a Shirt title) and a sibling "turquoise" (in alreadyIndexed) are both skipped — no
  // "…turquoise shirts" leak — while "tee" (fold "tee", absent from a {shirt,tshirt} title, not a color)
  // lands. We append the RAW pool token ("tees"); the pool-backed banTok exemption is keyed on the raw
  // token and the scorer folds "tees"->"tee" on read. Without this "graphic tees for women" (710K) is
  // uncoverable — its "tee" token is filtered out no matter how the pool is ordered.
  // scorerHave = the scorer's fold view of title+bullets+placed. At =on it is garment-unified (every
  // garment noun → "shirt"), so a candidate garment token folds into it and is correctly seen as covered.
  const scorerHave = new Set(bulletTokens(`${coverageHay} ${out}`).map((t) => (gOn ? foldGarment(t) : t)))
  for (const phrase of priorityPhrases) {
    if (getByteLength(out) >= 250) break
    if (capacityFamily && CAPACITY_RE.test(phrase)) continue          // capacity guard (mirrors the loop)
    if (findThirdPartyBrands(phrase, ownBrands).length > 0) continue  // competitor-brand ban (mirrors the loop)
    for (const raw of phrase.toLowerCase().split(/\s+/)) {
      const tok = normTok(raw)                                        // raw pool form ("tees") — the byte we write
      if (tok.length <= 1 || have.has(tok)) continue                 // byte-novelty
      if (banTok(tok)) continue                                      // own-brand / stopword / gender
      if (scorerHave.has(gfold(tok)) || alreadyIndexed?.has(tok)) continue  // fold-aware echo + sibling-color/title index
      if (getByteLength(`${out} ${tok}`) > 250) continue             // hard cap, never crossed
      out = `${out} ${tok}`
      have.add(tok)
      scorerHave.add(gfold(tok))
    }
  }

  // GENERIC sales-ordered fill — only if headroom remains after the priority pass (unchanged behavior).
  if (getByteLength(out) >= 244) return out
  const candidates: string[] = []
  // 1. leftover pool keywords FIRST (demand-backed beats title-derived bigrams — reordered 2026-07-08)
  candidates.push(...poolKeywords.map((k) => k.toLowerCase()))
  // 2. canonical descriptor bigrams, segment-aware (strip the trailing " - Color - Size" suffix).
  //    KEPT deliberately: canonicalTitle is the seller's ORIGINAL catalog title — bigrams the new
  //    optimized title dropped ("country western") are genuinely novel; only tokens in the LIVE
  //    title/bullets are echo, and alreadyIndexed filters those below.
  const canonClean = (canonicalTitle ?? '').replace(/(\s+-\s+[A-Za-z][A-Za-z -]{1,24}){1,2}\s*$/, '')
  for (const seg of canonClean.split(/[,\-–—|]/)) {
    const w = seg.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1)
    for (let i = 0; i + 1 < w.length; i++) candidates.push(`${w[i]} ${w[i + 1]}`)
  }
  // 3. spec-grounded product FACTS (Phase 6) — last on purpose; see the factTokens param doc.
  candidates.push(...factTokens)

  for (const cand of candidates) {
    if (capacityFamily && CAPACITY_RE.test(cand)) continue
    if (findThirdPartyBrands(cand, ownBrands).length > 0) continue
    // Append token-by-token so a partial fit still lands ("country" must not be lost
    // just because "country western" as a whole missed the cap by a byte).
    for (const raw of cand.split(/\s+/)) {
      const tok = normTok(raw)
      if (tok.length <= 1 || have.has(tok) || alreadyIndexed?.has(tok)) continue
      if (banTok(tok)) continue
      // The FILL never adds product-type words (2026-07-09): the title always carries the product
      // type ("...Shirt for Women") so Amazon already indexes it, and the core places up to 2 on
      // purpose — the fill re-adding "shirts" was pure title-echo the singular/plural alreadyIndexed
      // check missed ("shirt" indexed, "shirts" slipped through → the trailing "…turquoise shirts").
      // At =on this becomes a FOLD-AWARE test (Invariant 4): skip a garment token only when the title
      // already indexes a garment (scorerHave folded contains "shirt") — so a head term stays addable in
      // the rare no-garment-title case; =off keeps the unconditional blanket skip byte-for-byte.
      if (PRODUCT_TYPE_WORDS.has(tok) && (!gOn || scorerHave.has('shirt'))) continue
      if (getByteLength(`${out} ${tok}`) > 250) continue
      out = `${out} ${tok}`
      have.add(tok)
      if (gOn && PRODUCT_TYPE_WORDS.has(tok)) scorerHave.add('shirt')  // keep the ≤1-garment-from-fill invariant
    }
    if (getByteLength(out) >= 244) break
  }
  return out
}

/** Post-conditions for a backend-keywords regen — catches SILENT degradation. Every LLM step
 *  in the backend chain is try/catch best-effort, so a truncated/failed call doesn't error, it
 *  quietly ships garbage as if healthy (live 2026-06-12: 131-byte IDENTICAL token soup across
 *  82 children persisted without a whisper). Returns human-readable problems; [] = healthy. */
function backendOutputProblems(
  perChild: PipelinePerChildKeywords[],
  children: PipelineInput['children'],
  apparel: boolean,
): string[] {
  const problems: string[] = []
  if (perChild.length === 0) return ['no per-child keyword rows were generated']
  const minBytes = Math.min(...perChild.map((p) => getByteLength(p.keywords || '')))
  // PRODUCING-GATE floor = 190 (BACKEND_MIN_LEGACY), permanently (#157 Step 2, 2026-08-03 — the
  // BACKEND_DEGRADE_STRICT flag is retired). Division of labor: this cheap gate catches CATASTROPHIC
  // output (the B0H9VDCBZJ 70/86B class); the ship census measures the POST-AUDIT bytes against the
  // doctrine 220 floor (CONTENT_CONTRACT.keywords.minStrict) and degrade-marks, which routes BOTH
  // write paths into the shared better-than-prior preserve (PR #480). The strict whole-run throw
  // this replaced lost all six sections to one thin backend; census+preserve keeps the five healthy
  // ones and swaps only the degraded field.
  const floor = BACKEND_MIN_LEGACY
  if (minBytes < floor) {
    // HONEST CAUSE (#149). The old text read "degraded keyword pool or failed fill" — it named two
    // causes and committed to neither, and this function CANNOT distinguish them: it receives the
    // per-child strings and the children, never the keyword pool. That guess sent a live diagnosis
    // down the wrong path (2026-07-30, B0GR22ZHBW at 194 bytes: it reads as a fill bug, but the pool
    // held only 18 distinct novel tokens = 116 bytes against a 220 floor — the fill was extracting
    // nearly everything there was). So: state the measurement, admit the unknown, and name the ONE
    // check that separates the two. A message that guesses is worse than one that says "look here".
    problems.push(
      `a child landed at ${minBytes}/250 bytes — the fill did not reach the floor. ` +
      `This function cannot tell WHY (it never sees the keyword pool): open the Intelligence tab and ` +
      `count the pool's DISTINCT tokens after stopwords/product-type/gender/title-echo are removed. ` +
      `Below ~${floor} bytes of novel tokens the pool is too thin and the cure is more on-niche ` +
      `research; well above it, the fill or its filters are dropping usable tokens.`,
    )
  }
  // DECODED colors (real, non-empty) vs UNdecodable children, counted separately (2026-07-15).
  const decodedColors = children.map((c) => (c.color || '').toLowerCase()).filter(Boolean)
  const distinctColors = new Set(decodedColors).size
  const undecoded = children.length - decodedColors.length
  const distinctStrings = new Set(perChild.map((p) => p.keywords)).size
  // An identical string across children is DEGRADED only when per-color differentiation was EXPECTED:
  //   • the family genuinely spans ≥2 decoded colors, OR
  //   • colors could NOT be decoded for a big family — so a mis-decode collapse (the 91-child 'FBM'
  //     incident, 2026-07-09) can't be ruled out; keep flagging it.
  // A family that CONFIDENTLY decodes to ONE color (e.g. B0H7L6KNNX = 9 White sizes) SHOULD share one
  // backend string — sizes don't change backend keywords — so flagging it there was a FALSE POSITIVE that
  // made the degradation gate PRESERVE stale junk forever (every regen silently no-op'd). The minBytes<190
  // floor above still catches truncation/wipe garbage regardless of color count.
  const differentiationExpected = distinctColors >= 2 || (distinctColors <= 1 && undecoded >= 6)
  // MAJORITY, NOT UNANIMITY (2026-08-10). `distinctStrings < 2` demands a PERFECT collapse, so ONE
  // dissenting child immunises the whole family: B0GVV3XL4T shipped 97 of 98 children byte-identical
  // (tail "navy blue royal" on black/grey/green SKUs alike) with distinctStrings === 2, and this gate
  // reported healthy. Combined with the preserve ratchet those bytes could never be replaced, so the
  // family's backend sat frozen from June to August while every regen silently re-preserved it.
  //
  // The honest question is "did per-color differentiation actually happen?", which a modal-share test
  // answers and an exact-collapse test cannot. >50% of children on ONE string means it did not.
  // Deliberately a MAJORITY threshold, not "modal > distinctColors-implied share": sizes legitimately
  // share a string, so a 3-color family whose biggest color is half the SKUs must not be flagged for
  // that alone — only a string spanning MORE than half the family proves the tail was broadcast.
  const modalCount = perChild.length
    ? Math.max(...[...new Map<string, number>(
        perChild.map((p) => [p.keywords, perChild.filter((q) => q.keywords === p.keywords).length]),
      ).values()])
    : 0
  const modalShare = perChild.length ? modalCount / perChild.length : 0
  if (apparel && differentiationExpected && modalShare > 0.5) {
    problems.push(
      `${modalCount}/${perChild.length} children share ONE identical string (${distinctStrings} distinct total; ` +
      `${distinctColors} decoded color${distinctColors === 1 ? '' : 's'}, ${undecoded} undecoded) — ` +
      `per-color tails failed or colors could not be decoded`,
    )
  }
  return problems
}

/** Post-conditions for the CORE customer-facing content (title/bullets/description) — the same
 *  silent-degradation class backendOutputProblems catches for keywords. Every council call is
 *  fail-open (`catch { return '' }`), so a hard OpenAI outage (2026-07-08: quota exhausted)
 *  produced empty bullets + description that PERSISTED over the seller's approved copy while
 *  reporting success. EMPTY-ONLY gates (never a length/count floor) so a legitimately short
 *  non-apparel result can never false-abort; pass null to skip a field a partial didn't touch. */
function coreContentProblems(title: string | null, bullets: string[] | null, description: string | null): string[] {
  const problems: string[] = []
  if (title !== null && !title.trim()) problems.push('title came back empty')
  if (bullets !== null && !bullets.some((b) => b && b.trim())) problems.push('bullets came back empty')
  if (description !== null && !description.trim()) problems.push('description came back empty')
  return problems
}

/** Throw-and-preserve for degraded core content — mirrors the keywords-only gate below ("Your
 *  previous keywords are untouched"). Throwing aborts BEFORE any persist step, so the stored
 *  recommendation stays exactly as approved. The error is tagged with the recovered cause
 *  (client.__aiHardError from instrumentAiHealth) so the route/UI can say "credit exhausted —
 *  check billing" instead of a generic failure. */
function assertCoreHealthy(openai: unknown, title: string | null, bullets: string[] | null, description: string | null): void {
  const problems = coreContentProblems(title, bullets, description)
  if (problems.length === 0) return
  const hard = (openai as { __aiHardError?: 'quota' | 'auth' })?.__aiHardError
  const e = new Error(hard === 'quota'
    ? 'AI generation failed: the OpenAI account is out of credit (insufficient_quota). Your previous content is untouched — add credit and regenerate.'
    : hard === 'auth'
      ? 'AI generation failed: the OpenAI API key was rejected (401). Your previous content is untouched — check the key in Settings.'
      : `AI content came back degraded (${problems.join('; ')}). Your previous content is untouched — retry in a minute.`) as Error & { aiKind?: string }
  e.aiKind = hard ?? 'degraded'
  throw e
}

/** Drop repeated tokens from a backend search-term string, keeping the FIRST occurrence
 *  (so a force-led design phrase survives intact). Amazon indexes each token once — a repeat
 *  is wasted budget. Compares on normalized tokens (punctuation-stripped) so "darlin'" and
 *  "darlin" collapse; keeps the original spelling of the first hit. */
function dedupeTokenSoup(s: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of (s || '').split(/\s+/)) {
    const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    out.push(raw)
  }
  return out.join(' ')
}

/** Fix the doubled article when the brand itself starts with "THE" — the agents write
 *  "with the THE CEO Darlin' T-Shirt" (live nit the PO spotted in a description). */
function fixDoubledArticleBeforeBrand(text: string, brandName: string): string {
  if (!text || !/^the\s/i.test(brandName)) return text
  const esc = brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`\\b(?:the|a|an)\\s+(?=${esc}\\b)`, 'gi'), '')
}

/** HARD audience normalization (seller selected Male or Female outright): the opposite
 *  gender's word must not survive into customer copy. Deterministic swap — "Men's" →
 *  "Women's", "Men" → "Women" (mirrored for Male) — keeps the sentence readable.
 *  \b prevents "women" matching inside itself. Lean_* selections do NOT use this. */
/** Multi-design family detection (Phase 1). POD apparel sellers put SEVERAL distinct designs under
 *  ONE parent, encoded in the SKU PREFIX — B0F6QZ34B1 (live-reviewed 2026-06-13): FHOSH64000L-BK,
 *  FRAF64000M-BK, OF64000S-BK = three designs (FHOSH / FRAF / OF="Only Fins"), all black, sizes in
 *  the suffix. Amazon shows the design as the "Color" variation value ("Only Fins"). The DESIGN KEY
 *  is the SKU with its size + color + fulfillment suffix stripped; ≥2 keys each spanning ≥2 SKUs (so
 *  the singleton parent hub never counts) = a multi-design family. Single-design colour families
 *  (Darlin' DAR-CCG-2XL-BAY → one key "DAR-CCG") are correctly NOT flagged. */
const SKU_SIZE_RE = /-(?:xxs|xs|s|m|l|xl|2xl|3xl|4xl|5xl|6xl|xxl|xxxl)(?=-|$)/i
export function designKeyForSku(sku: string): string {
  let k = (sku || '').trim().toUpperCase()
  k = k.replace(/-(?:FBA|FBM)$/i, '')        // drop the fulfillment suffix
  const sz = k.search(SKU_SIZE_RE)           // cut at a standalone "-2XL-" size token (DAR-CCG-2XL-BAY → DAR-CCG)
  if (sz >= 0) k = k.slice(0, sz)
  // STYLE-CODE prefix? A leading optional brand-letter run + a 3+ digit base number (640002, BC30012,
  // GIL64000). When present, the DESIGN lives in the SUFFIX after the colour — so the SAME design on
  // DIFFERENT blanks unifies into ONE key (640002XL-BK-Custom-Cup-TS AND BC30012XL-SC-Custom-Cup-TS →
  // "CUSTOM-CUP"). Without this, the blank-brand letters ("BC" = Bella Canvas 3001) were mis-read as a
  // SEPARATE design key, splitting one design into a FALSE multi-design family (B0GVW83L1P soccer: a
  // CUSTOM-CUP + a BC group → wrong per-design titles, dropped single override, leaked colour).
  if (/^[A-Z]*\d{3,}/.test(k)) {
    const suffix = k
      .replace(/^[A-Z]*\d{3,}(?:2XL|3XL|4XL|5XL|6XL|XL|XS|L|M|S)?-?/i, '')  // 640002XL- / BC30012XL- → ''
      .replace(/^[A-Z]{2,4}(?:-|$)/, '')                                    // leading colour code (BK / SC) → ''
      .replace(/-?TS$/i, '')                                               // trailing product-type token
      .replace(/[-_\s]+$/, '').replace(/^[-_\s]+/, '')
    if (suffix) return suffix
    // Style code but NO suffix design token → the LETTER prefix before the number IS the design
    // (FHOSH64000L-BK → "FHOSH"; OF64000S-BK → "OF").
    return k.replace(/\d{3,}.*$/, '').replace(/[-_\s]+$/, '') || k
  }
  // No leading style number → PREFIX / colour-family-encoded design (DAR-CCG-2XL-BAY → "DAR-CCG";
  // parent RA-8EU0-VP6R → unchanged).
  return k.replace(/\d{3,}.*$/, '').replace(/[-_\s]+$/, '') || k.replace(/[-_\s]+$/, '')
}
export interface DesignGroup { key: string; skus: { sku: string; asin: string }[] }
export function detectDesignGroups(children: { sku: string; asin: string }[]): { isMultiDesign: boolean; groups: DesignGroup[] } {
  const m = new Map<string, { sku: string; asin: string }[]>()
  for (const c of children) {
    const k = designKeyForSku(c.sku)
    if (!k) continue
    if (!m.has(k)) m.set(k, [])
    m.get(k)!.push({ sku: c.sku, asin: c.asin })
  }
  // A real design spans multiple sizes (≥2 SKUs); a singleton key is the parent hub / outlier.
  const groups = [...m.entries()].filter(([, skus]) => skus.length >= 2).map(([key, skus]) => ({ key, skus }))
  return { isMultiDesign: groups.length >= 2, groups }
}

function enforceHardAudience(text: string, audience: 'Men' | 'Women'): string {
  if (!text) return text
  // FIT / STYLE / CUT is a GARMENT FACT, not an audience claim. Blanks like Comfort Colors 1717,
  // Bella Canvas, Gildan are UNISEX relaxed — so "womens fit"/"mens fit" fabricates a gender the
  // garment doesn't have (PO: "1717 is a unisex relaxed fit, not a womens fit"). Targeting the
  // audience ("for Women", "gift for her") is legitimate and preserved/swapped below; the gendered
  // MODIFIER on a fit/style/cut noun is STRIPPED (keep the noun), never swapped — so we never invent
  // "womens fit". The opposite-gender modifier must match the apostrophe form too ("men's fit").
  // ['’] matches BOTH the straight and curly apostrophe — the LLM/Amazon emit "women’s" (U+2019),
  // which a straight-quote-only regex misses (the apostrophe trap, live-confirmed on this listing).
  const GENDER = `(?:men(?:['’]s|s)?|male|males|women(?:['’]s|s)?|female|females)`
  const FITNOUN = `(?:fit|style|cut|sizing|silhouette|cutting)`
  const stripGenderedFit = (s: string): string => s
    .replace(new RegExp(`\\b${GENDER}\\s+(${FITNOUN})\\b`, 'gi'), '$1')   // "womens fit" -> "fit"
    .replace(new RegExp(`\\b(${FITNOUN})\\s+(?:for\\s+)?${GENDER}\\b`, 'gi'), '$1')   // "fit for women" -> "fit"
  let out = stripGenderedFit(text)
  // Swap remaining AUDIENCE-context tokens to the chosen gender (both apostrophe forms).
  if (audience === 'Women') {
    out = out.replace(/\bmen['’]?s\b/gi, "Women's").replace(/\bmens\b/gi, 'Womens').replace(/\bmen\b/gi, 'Women')
  } else {
    out = out.replace(/\bwomen['’]?s\b/gi, "Men's").replace(/\bwomens\b/gi, 'Mens').replace(/\bwomen\b/gi, 'Men')
  }
  return out.replace(/\s{2,}/g, ' ').trim()
}

// Basic garment-color words. On a MULTI-variant apparel family, BROADCAST content (title /
// bullets) is shared across every color, so a keyword carrying one specific color ("plain
// black tshirt men") mis-describes the other 80 variants — the JS research runs against ONE
// child (whatever color it happens to be) and drags its color into the pool. Color keywords
// still rank per-child via the backend strings (each child gets its OWN color terms). A
// design name containing a color ("Black Cat") is unaffected — it flows via the verbatim
// design-name anchor, not the keyword pool.
// ONE SOURCE (2026-08-09): this was a byte-identical literal here, in syncListingContent and (as the
// base half of COLOR_WORDS) in designName — three copies, two "KEEP IN SYNC" comments. The word list
// now lives once in designName.ts; this alias keeps all eight call sites below unchanged.
const BASIC_COLOR_RE = BASIC_COLOR_WORD_RE

/**
 * Third-party brand names that REQUIRE 'for [Brand]' or 'compatible with [Brand]' framing
 * in titles and bullets. Amazon's Jan 2025 enforcement (tightened Q4 2025): bare third-party
 * brand references in titles trigger listing suppression and can lead to ASIN takedown.
 * Sources: DAM Law Firm 2026 Q4 enforcement report; Amazon Seller Central Product Title
 * Guidelines effective Jan 21, 2025.
 *
 * The seller's own brand (input.brandName) is exempted at runtime — this list is
 * COMPETITORS / accessories ecosystems the seller's product is compatible WITH, not made by.
 *
 * Apparel "blank" brands (Comfort Colors, Bella Canvas, Gildan…) are deliberately NOT here.
 * Amazon has long tolerated them as material/style descriptors and the existing pipeline
 * handles them via `attributePin`. This list focuses on actively-enforcing trademark holders.
 */
const THIRD_PARTY_BRANDS = new Set([
  // Cameras & imaging
  'canon', 'nikon', 'sony', 'fujifilm', 'fuji', 'olympus', 'panasonic', 'pentax', 'leica',
  'kodak', 'gopro', 'insta360', 'dji', 'ricoh', 'sigma', 'tamron',
  // Memory / storage manufacturers
  'sandisk', 'samsung', 'lexar', 'kingston', 'pny', 'toshiba', 'transcend', 'adata', 'patriot',
  'crucial', 'seagate', 'maxell', 'micron',
  // Phones & computing
  'apple', 'iphone', 'ipad', 'macbook', 'imac', 'galaxy', 'pixel', 'microsoft', 'surface',
  'huawei', 'xiaomi', 'oneplus', 'motorola',
  // Drones
  'parrot', 'autel', 'skydio', 'yuneec',
  // Gaming
  'nintendo', 'playstation', 'xbox', 'switch',
  // Audio
  'bose', 'beats', 'jbl', 'sennheiser',
  // Apparel / athletic competitor RETAIL brands (2026-07-07, B0FRYMM56C: "why do we have NIKE"). The
  // keyword research pulls the #1 competitor's ranking terms ("nike shirts women") into the pool as
  // proven converters, and — until now — no filter knew Nike was a brand, so the bullet coverage
  // backstop wove it straight into customer copy. A graphic tee is NOT "compatible with" Nike, so these
  // are DROPPED (like trademark phrases), never framed "for [Brand]". OMITTED pending a context-guard
  // because they double as legit design words: champion / gap / columbia / express (common words),
  // puma (animal), wrangler (cowboy/Jeep), levis / hollister (names).
  'nike', 'adidas', 'reebok', 'lululemon', 'athleta', 'underarmour', 'vuori', 'gymshark',
  'fabletics', 'aeropostale', 'abercrombie', 'nautica',
])

/** Multi-word brand phrases (checked verbatim, not per-word). */
const THIRD_PARTY_BRAND_PHRASES = [
  'western digital', 'audio technica', 'sea gate', 'go pro',
  // Apparel/athletic competitor brands whose name is multi-word (per-word checks would false-positive
  // on 'under'/'new'/'north'/'face'). See the apparel block in THIRD_PARTY_BRANDS above.
  'under armour', 'new balance', 'north face',
]

/**
 * Sports teams, college athletic programs, media franchises, and other licensed
 * trademark phrases. **Different semantics from THIRD_PARTY_BRANDS**: there's no safe
 * `'for [Brand]'` framing for these — an unlicensed seller can't write "for Florida
 * Gators" because the WORD MARK itself is protected (separately from the design mark
 * / logo). They must be DROPPED entirely from the keyword pool BEFORE any agent sees
 * them. The LLM relevance gate (filterRelevantKeywords) is supposed to catch these
 * but is non-deterministic; this is the deterministic backstop.
 *
 * Live-verified gap (B0G884ZJ27): regen emitted "Florida Gators" bare in title +
 * bullets + description. UF actively enforces this mark.
 *
 * Curated list focuses on actively-enforced marks where licensing is required for
 * apparel/accessory resale. Generic words ("alligator", "gators", "lions", "bears")
 * are NOT here — only the multi-word PHRASES that constitute the registered marks.
 */
const TRADEMARK_PHRASES = new Set([
  // NCAA football/basketball (top enforced)
  'florida gators', 'tennessee volunteers', 'tennessee vols', 'texas longhorns',
  'alabama crimson tide', 'lsu tigers', 'georgia bulldogs', 'auburn tigers',
  'oklahoma sooners', 'ohio state buckeyes', 'michigan wolverines',
  'penn state nittany lions', 'notre dame fighting irish', 'usc trojans', 'ucla bruins',
  'oregon ducks', 'washington huskies', 'miami hurricanes', 'florida state seminoles',
  'clemson tigers', 'virginia tech hokies', 'north carolina tar heels',
  'duke blue devils', 'kentucky wildcats', 'arkansas razorbacks',
  'kansas jayhawks', 'syracuse orange', 'villanova wildcats', 'arizona wildcats',
  'gonzaga bulldogs', 'michigan state spartans',
  // NFL
  'dallas cowboys', 'new york giants', 'new england patriots', 'kansas city chiefs',
  'green bay packers', 'pittsburgh steelers', 'philadelphia eagles', 'chicago bears',
  'san francisco 49ers', 'seattle seahawks', 'tampa bay buccaneers', 'miami dolphins',
  'new orleans saints', 'denver broncos', 'baltimore ravens', 'los angeles rams',
  // NBA
  'los angeles lakers', 'boston celtics', 'chicago bulls', 'golden state warriors',
  'miami heat', 'new york knicks', 'brooklyn nets', 'philadelphia 76ers',
  // MLB
  'new york yankees', 'boston red sox', 'los angeles dodgers', 'chicago cubs',
  'san francisco giants', 'st louis cardinals', 'houston astros', 'atlanta braves',
  // Major media franchises (word marks)
  'star wars', 'harry potter', 'lord of the rings', 'game of thrones',
  'the simpsons', 'family guy', 'south park', 'breaking bad',
])

/** Single-word trademark tokens (registered marks where the single word is unambiguous). */
const TRADEMARK_TOKENS = new Set([
  // Media / entertainment
  'marvel', 'disney', 'pixar', 'dreamworks', 'lucasfilm',
  // Universities (apparel context — Brown, Yale, Harvard etc. license their names)
  'harvard', 'stanford', 'yale', 'princeton',
  // Major leagues
  'nfl', 'nba', 'mlb', 'nhl', 'ncaa',
])

/**
 * Crude singular-ization for proximity matching ("gators" → "gator", "cowboys" → "cowboy").
 * Doesn't try to be a real stemmer — normalizes the trademark word forms most likely to
 * evade an exact-phrase check.
 */
function singularize(w: string): string {
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'
  if (w.endsWith('es') && w.length > 3) return w.slice(0, -2)
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1)
  return w
}

/**
 * Find trademark phrases (sports teams, universities, media franchises) in `text`.
 * Returns matched phrases — these should NEVER appear in customer-facing copy.
 *
 * Two detection paths (PR #79 widened from exact-phrase only):
 *   1. EXACT phrase match — verbatim "florida gators", "dallas cowboys".
 *   2. TOKEN-PROXIMITY match — for each multi-word phrase, tokenize, normalize stems
 *      (gators → gator), then if ALL phrase tokens appear inside any 4-token window
 *      of `text` (in either order), flag the phrase.
 *
 * Catches the live-verified evasions PR #77 missed on B0G884ZJ27:
 *   - "vintage 90s Florida gator shirt"  → flagged via 'florida' + 'gator' in window
 *   - "Vintage 90s Gator Florida Tee"    → reversed order → flagged
 *   - "love for Florida gators"          → plural caught by exact match
 *
 * Generic words alone ("alligator", "lions", "gator") are NOT flagged — only the
 * COMBINATION of trademark tokens within the proximity window triggers.
 */
export function findTrademarkPhrases(text: string): string[] {
  const lc = ` ${text.toLowerCase()} `
  const found = new Set<string>()

  // 1. Exact phrase match.
  for (const phrase of TRADEMARK_PHRASES) {
    if (lc.includes(` ${phrase} `) || lc.includes(` ${phrase}.`) || lc.includes(` ${phrase},`) || lc.includes(`${phrase}'`)) {
      found.add(phrase)
    } else if (lc.includes(phrase)) {
      found.add(phrase)
    }
  }

  // 2. Token-proximity match — handles singular/plural and reversed word order.
  const textTokens = lc.split(/[^a-z0-9]+/).filter(Boolean)
  const textStems = textTokens.map(singularize)
  for (const phrase of TRADEMARK_PHRASES) {
    if (found.has(phrase)) continue
    const phraseStems = phrase.split(/\s+/).filter(Boolean).map(singularize)
    if (phraseStems.length < 2) continue
    const windowSize = Math.max(4, phraseStems.length + 2)
    for (let i = 0; i <= textStems.length - phraseStems.length; i++) {
      const window = new Set(textStems.slice(i, i + windowSize))
      if (phraseStems.every((s) => window.has(s))) { found.add(phrase); break }
    }
  }

  // 3. Single-word trademark tokens (Marvel/Disney/Harvard/etc.).
  for (const w of textTokens) {
    if (TRADEMARK_TOKENS.has(w)) found.add(w)
  }
  return [...found]
}

/** Find every third-party brand token in `text`, excluding the seller's own brand. */
export function findThirdPartyBrands(text: string, ownBrandTokens: Set<string>): string[] {
  const lc = text.toLowerCase()
  const found = new Set<string>()
  for (const w of lc.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (ownBrandTokens.has(w)) continue
    if (THIRD_PARTY_BRANDS.has(w)) found.add(w)
  }
  for (const phrase of THIRD_PARTY_BRAND_PHRASES) {
    if (lc.includes(phrase)) found.add(phrase)
  }
  return [...found]
}

/**
 * True if EVERY occurrence of `brandToken` in `text` is properly preceded by a framing
 * word ('for' / 'compatible with' / 'works with' / 'fits') within the prior 2-3 content
 * tokens (commas / 'and' / 'or' don't count as content — they're list connectors).
 *
 * Per-occurrence check (PR #77). The previous one-shot check would mark a bullet like
 *   "GoPro is great. Compatible with GoPro Hero."
 * as framed because SOMEWHERE a framing word touches the brand — but the FIRST occurrence
 * is still bare and that's the policy-violating one.
 *
 * Handles list-with-shared-framing correctly:
 *   "for Canon, Nikon, and Sony cameras"      → all three framed via the leading "for"
 *   "compatible with GoPro Hero and Insta360" → both framed via "compatible with"
 */
export function isBrandProperlyFramed(text: string, brandToken: string): boolean {
  const lc = text.toLowerCase()
  const tokRe = brandToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const occurrences = [...lc.matchAll(new RegExp(`\\b${tokRe}\\b`, 'gi'))]
  if (occurrences.length === 0) return true   // nothing to check
  const FRAMING_RE = /^(?:for|compatible\s+with|works?\s+with|fits?(?:\s+for)?)\s*$/
  const CONNECTOR_RE = /^(?:and|or|,|\/|&)$/
  for (const m of occurrences) {
    // Walk backwards through up to 5 preceding tokens (skipping commas/and/or as list
    // connectors). If we find a framing token within that window → this occurrence is
    // framed. Otherwise → bare.
    const before = lc.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0)
    const beforeTokens = before.split(/[\s]+/).filter(Boolean)
    let framed = false
    let contentTokensSeen = 0
    for (let i = beforeTokens.length - 1; i >= 0 && contentTokensSeen < 4; i--) {
      const t = beforeTokens[i]
      // Try multi-word framing patterns first ("compatible with", "works with").
      if (i > 0) {
        const pair = `${beforeTokens[i - 1]} ${t}`
        if (FRAMING_RE.test(pair)) { framed = true; break }
      }
      if (FRAMING_RE.test(t)) { framed = true; break }
      if (CONNECTOR_RE.test(t)) continue            // list connector — keep walking, don't count
      // Allow up to 3 brand-related content tokens between the framing word and this
      // brand (covers "for action camera GoPro" + "for Canon EOS GoPro").
      contentTokensSeen++
    }
    if (!framed) return false
  }
  return true
}

/** Get the seller's own brand tokens for exemption from brand checks. Includes NORMALIZED forms
 *  (apostrophe-deleted, punctuation-stripped) alongside the raw tokens (adversarial 2026-07-08):
 *  the backend ban sites compare against normalized tokens ("Darlin' Co." must ban "darlin"), and
 *  a raw-only set silently no-ops for any punctuated brand. Superset — raw consumers unaffected. */
function ownBrandTokenSet(brandName: string): Set<string> {
  const s = new Set<string>()
  for (const t of brandName.toLowerCase().split(/\s+/).filter(Boolean)) {
    s.add(t)
    const stripped = t.replace(/['’]/g, '').replace(/[^a-z0-9]/g, '')
    if (stripped) s.add(stripped)
  }
  return s
}
// Product-type words capped at 2 total in the backend core (Amazon's bag-of-words already
// has them from the title; >2 is the "shirt ×7" waste the PO flagged).
const PRODUCT_TYPE_WORDS = new Set(['shirt', 'shirts', 'tshirt', 'tshirts', 'tee', 'tees'])

// Amazon Listings-Items productTypes that ARE clothing (worn on the body). MOVED to the shared
// garmentNoun.ts leaf (2026-07-21) so the apparel gate and the garment-noun resolver read ONE
// source; re-exported here byte-identical for back-compat (syncKeywordIntelligence + others import
// it from listingPipeline).
export const APPAREL_PRODUCT_TYPES = APPAREL_PRODUCT_TYPES_SHARED

// GARMENT_NOUN feature flag (2026-07-21, workflow w6728l4wz) — mirrors keywordResearcher's gate.
// off/shadow → shirt-defaulted (byte-identical to today); on → real per-family garment nouns in the
// title/highlights/backend producers. Each call site keeps its EXACT legacy expression when off.
const GARMENT_NOUN_ON = (process.env.GARMENT_NOUN || 'off').toLowerCase() === 'on'
// BACKEND_CRITICAL_KEYWORDS (2026-07-21, PO "words vs search terms"): a CRITICAL keyword is a SEARCH
// TERM, not a generic auto-indexed title word. The title-echo strip (~:3493) + the LLM relevance gate
// (~:4410) were dropping CRITICAL money terms (spain jersey 416K, spain world cup jersey 2026 382K, …)
// from the backend because their tokens also sit in the title. This flag (a) exempts CRITICAL pool
// tokens from title-echo, (b) fences the relevance gate from ever demoting a CRITICAL term to noise,
// (c) sorts CRITICAL-first for byte priority. It REVERSES the 2026-07-08 title-echo approval for
// CRITICAL search terms ONLY — generic title words (the/tee/2026) still dedupe, so no bytes are wasted.
// off=legacy; shadow=log [BACKEND_CRIT_DIFF] without changing bytes; on=apply. Roll out shadow → verify
// diff → on, per COVERAGE_CORE / GARMENT_NOUN.
const BACKEND_CRIT_MODE = (process.env.BACKEND_CRITICAL_KEYWORDS || 'off').toLowerCase()
const BACKEND_CRIT_ON = BACKEND_CRIT_MODE === 'on'
const BACKEND_CRIT_SHADOW = BACKEND_CRIT_MODE === 'shadow'
// CONTENT_SPINE (2026-07-22, spine Step 3): route the leaky section-regen returns through the shared
// applyTerminalNets so "Regenerate bullets"/"Regenerate description" get the SAME terminal net the full
// path runs. UNCONDITIONAL since ship-door Phase 5 (2026-07-31): prod ran CONTENT_SPINE=on from 07-22
// with no regressions, and an env-gated net leaves an env change able to silently strip it (a net that
// must be remembered is the net that gets forgotten — generation-invariants INVARIANT 3).
// SHIP_BAND_NET (2026-07-29, task #147): the ONE terminal band net for the TITLE, installed at
// `scrubPublished` — the single choke point EVERY exit passes through (title/bullets/keywords/
// description partials all route via `partialResult`, which is DEFINED as a scrubPublished wrapper).
// A live regen shipped a 66-char title against the 70-75 band because the ENFORCED retry lives only
// in the multi-design `buildNicheParentTitle` while single-design ships `runTitleAgent`'s soft pad.
// UNCONDITIONAL since the flag census (2026-08-03; SHIP_BAND_NET retired — live env was unset =
// default on, so this is byte-identical). The off/shadow modes were rollback-only, and shadow was
// incoherent (it shipped the cap+dedupe mutations when the band no-opped but returned the raw
// UNCAPPED title when the band fired). Rollback is now git-revert, per generation-invariants
// INVARIANT 3 — a net that must be remembered is the net that gets forgotten.
// V2 title brief (2026-07-22, PO "8 golds from 100+ deploys"; TITLE_QUALITY_V2 flag RETIRED
// 2026-08-03 — live env was 'on' since PR #434, fold is byte-identical, rollback = git-revert):
// idiom expansion, Pattern A (pipe) / Pattern B (front-load), 8 PO golds as few-shot, modifier-
// stuffing ban, gender-conservative default, titleQualityJudge widening the humanizer adopt gate.
// Applies on the apparel arms of BOTH producers (runTitleAgent + buildNicheParentTitle);
// non-apparel keeps its own brief. Git ref for the flagged era: PR #434 / pre-965254e.
// TITLE_COUNCIL_V3 (2026-07-23, PO "greenlight GO"; flag RETIRED 2026-08-03 at live 'on' — on since
// the 07-23 flip, live-verified on B0GF49RLDL): the V3 council architecture (personas as full
// system, split adversary/judge models, TRADEMARK_RULES-generated adversary clause, judge-scored
// fail-open) is now THE council — the pre-V3 legacy council and the [COUNCIL_V3_DIFF] shadow
// machinery are deleted (legacy stopped being a pre-Step-7 baseline when V3.1a changed its brief
// un-flagged). The two formerly V3-gated deterministic inversions are resolved to the ON branch:
// the corrective-retry pipe ban and the "for Men and Women" widen guard are DELETED. Rollback =
// git-revert (ref: pre-973fb7e).
// FIX_C_NICHE_POOL (2026-07-23, PO Q3; flag RETIRED 2026-08-03 at live 'on'): audience-relational
// compound seed injection (deriveAudienceRelationalCompounds — e.g. "golf widow shirt" for "He's
// Golfing" + lean_female) is now unconditional; the helper returns [] when no compound signal, so
// it is a no-op on non-matching designs. [FIX_C_SEEDS] stays as the ongoing observability line.

/** Audience-lean signal type — mirrors PipelineInput.audienceLean at :146. */
type AudienceLean = 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null | undefined

/** Derive the AUDIENCE MODE flag the title-council briefs + Persona 3 read (TITLE_COUNCIL_V3.1a).
 *  Any non-null non-'unisex' lean (male / female / lean_male / lean_female) → REQUIRED. Anything else → OPTIONAL.
 *  Derived from RAW lean, NOT from the collapsed preferredAudience string, so Fix D's dock has hard/soft visibility. */
function deriveAudienceMode(lean: AudienceLean): 'REQUIRED' | 'OPTIONAL' {
  if (lean === 'male' || lean === 'female' || lean === 'lean_male' || lean === 'lean_female') return 'REQUIRED'
  return 'OPTIONAL'
}

/** Persona 3 / terminal-net closed-lexicon carriers (2026-07-23, PO Q1 verbatim: "Wife, Girlfriend"). A
 *  design phrase whose tokens literally contain one of these signals the WEARER's gender unambiguously —
 *  used to (a) exempt persona 3 from forcing the audience tail when the phrase already carries the
 *  signal, and (b) trigger the ANTI-LEAN OVERRIDE when the phrase carrier disagrees with the pipeline's
 *  lean (e.g. "Best Husband Ever" printed on a Ladies-cut shirt).
 *
 *  DELIBERATELY NARROW — the PO's answer was literally "Wife, Girlfriend" for FEMALE (symmetric MALE =
 *  "Husband, Boyfriend"). Pronouns (she/he/her/his) are NOT carriers under this interpretation because
 *  "He's Golfing" (Golf Widow shirt for women) would otherwise anti-lean-trigger and BLOCK the terminal
 *  net from appending "for Women" — the exact regression PO called out. Widen later based on shadow data
 *  if gift-SKU (e.g. "Best Dad Ever" on Ladies-cut) shadow signal proves problematic. */
const DESIGN_GENDER_CARRIERS_FEMALE = new Set(['wife', 'girlfriend'])
const DESIGN_GENDER_CARRIERS_MALE = new Set(['husband', 'boyfriend'])

function designPhraseCarriesGender(designPhrase: string): { female: boolean; male: boolean } {
  const toks = (designPhrase || '').toLowerCase().replace(/[^a-z0-9\s'’]/g, ' ').split(/\s+/).filter(Boolean)
  let female = false
  let male = false
  for (const t of toks) {
    const norm = t.replace(/['’]s?$/, '')
    if (DESIGN_GENDER_CARRIERS_FEMALE.has(norm)) female = true
    if (DESIGN_GENDER_CARRIERS_MALE.has(norm)) male = true
  }
  return { female, male }
}
/** PO gold examples (2026-07-22, provided verbatim). Used as FEW-SHOT in both title branches when
 *  TITLE_QUALITY_V2 is on. Rank order = PO's original list, deduped by exact string. Extend via a
 *  future auto-miner over listing_change_log title edits (memory: title-po-gold-pattern). */
/**
 * ONE apparel title brief for ALL producer surfaces — the single-design council, the humanizer, and
 * the multi-design parent. Only `roleLine` and `inputBlock` differ per site.
 *
 * WHY ONE BUILDER (2026-08-11 rebuild): the previous brief existed as three near-identical copies,
 * each pasting the seller's golds and then CONTRADICTING them with a hand-written PATTERN A whose
 * money slot was "[Variant/Attribute]" and whose rules blessed "Long Sleeve Shirt" as a positive
 * example. The council obeyed the template over the examples — "| Short Sleeve" was compliance, not
 * failure. Here every SHAPE statement is a measurement from the seller's corpus (goldSpecBlock);
 * the only hand-written lines are genuine external constraints: Amazon's cap, brand position,
 * truth, trademark (enforced downstream).
 *
 * Exported for the brief snapshot test, which asserts no hand-typed shape rule survives in the
 * rendered output.
 */
export function buildApparelTitleBrief(ctx: {
  brandName: string
  roleLine: string
  inputBlock: string
  poGolds?: { titles: string[]; shape: GoldShape } | null
  extraRules?: string[]
  /** The design being titled — enables NEAREST-GOLD ANCHORING (see below). Absent => no anchor, and
   *  the brief is byte-identical to the pre-2026-08-13 version. */
  designPhrase?: string | null
  garmentNoun?: string | null
  lean?: AudienceLean
}): { system: string; user: string } {
  const titles = ctx.poGolds?.titles?.length ? ctx.poGolds.titles : [...SEED_GOLD_TITLES]
  const shape = ctx.poGolds?.titles?.length && ctx.poGolds.shape ? ctx.poGolds.shape : measureGoldShape(titles)
  const goldSpec = goldSpecBlock(titles, shape)
  const rejects = rejectPairBlock(SEED_REJECT_PAIRS)

  /* ── NEAREST-GOLD ANCHOR ───────────────────────────────────────────────────────────────────────
   *
   * WHY, MEASURED LIVE 2026-08-13 on B0GVV3XL4T. The council's actual draft was:
   *
   *     THE CEO 2026 World Soccer Cup Tee Shirt | futbol          (48 chars)
   *
   * A ONE-WORD money position, lowercase. The padder then invented "Tournament Supporters" to reach
   * 70, and the shadow diff recorded wouldRefuse: TRUE — deleting the padder WITHOUT fixing this
   * would hold the listing back rather than improve it. The padding was the symptom; a 48-character
   * draft is the cause.
   *
   * The pool for that design already held `usa jersey` and `mexico football jersey`, and the design
   * group was tagged HOST-COUNTRIES. The words were there. What was missing was an ANCHOR: all nine
   * golds are shown at once, so the model averages a shape instead of following the ONE gold that
   * matches this situation — here the Espana gold, an event with a proper-noun cluster and a plain
   * join, the closest thing in the corpus to a World Cup design.
   *
   * Retrieved demonstrations beat showing everything, with the largest gains on generation (Liu et
   * al., DeeLIO/ACL 2022, arXiv:2101.06804). The anchor sits LAST, immediately before the
   * instruction — the recency position (Lu et al., arXiv:2104.08786).
   *
   * PURE, DETERMINISTIC, FAIL-OPEN: `nearestGolds` is a scoring function over derived features — no
   * LLM, no I/O. With no designPhrase the block is empty and the brief is unchanged. Nothing here
   * can make a title worse by being absent. */
  const anchorBlock = (() => {
    if (!ctx.designPhrase) return ''
    try {
      const near = nearestGolds(targetFromDesign({
        designPhrase: ctx.designPhrase,
        garmentNoun: ctx.garmentNoun ?? null,
        lean: ctx.lean === 'female' || ctx.lean === 'male' ? ctx.lean : null,
      }), titles, 2)
      if (near.length === 0) return ''
      const lines = near.map((g, i) => [
        `${i + 1}. ${g.title}`,
        `   identity: ${g.identity}`,
        `   money position: ${g.money || '(none — the whole title is the identity)'}`,
      ].join('\n')).join('\n')
      return [
        '',
        'THE CLOSEST MATCH IN THEIR OWN CORPUS to the design you are titling — follow THIS one, not the average of all of them:',
        lines,
        'Note how much of the 75 characters their money position earns. A one-word tail wastes the most valuable part of the title.',
        '',
      ].join('\n')
    } catch { return '' }   // fail-open: an anchor that throws must never cost a title
  })()
  const system = `${ctx.roleLine} Below are the seller's own titles, a measurement of them, and titles this system generated that the seller rejected, with their words. Write a title they would not rewrite. Match their SHAPE, never copy their words. Output ONLY the final title string — no quotes, no markdown, no explanation.`
  const user = `${goldSpec}${anchorBlock}

${rejects}
═══ THIS PRODUCT ═══
${ctx.inputBlock.trim()}

═══ WHAT GETS THE ${CONTENT_CONTRACT.title.hardCap} CHARACTERS ═══
Every gold above is TWO POSITIONS. A separator may or may not be drawn between them; the positions exist either way.

IDENTITY — opens the title: ${ctx.brandName} + the design phrase + a garment noun. ${shape.medianLeftWords} words is typical; ${shape.maxLeftWords} is the most the seller has ever spent (count "${ctx.brandName}" as 2). A product fact may appear here ONLY in a form the seller's vocabulary table shows.

MONEY — closes the title: the phrase a shopper actually types — a search phrase from the list above, or the garment brand. A product SPEC (fit, sleeve, neck, weight, fabric, "unisex") is not something a shopper types — the seller's spec-only tail count above is ZERO. A spec may modify the phrase that earns this position; it may never BE the position.

IF NOTHING EARNS THE MONEY POSITION: stop after the identity. A shorter honest title IS the correct output — do not reach for a product fact, an adjective, or a repeated noun to fill space. Facts are not lost: fit/sleeve/neck/fabric are filed in Item Highlights; synonyms and long-tail go to backend keywords.

═══ HARD LIMITS — external, never yield ═══
- ${CONTENT_CONTRACT.title.hardCap} characters maximum, counted exactly. Amazon rejects a longer item_name (error 100476) and this pipeline refuses the push rather than trimming.
- "${ctx.brandName}" at position 0.
- Every word must be TRUE of this product. Search volume for a word does not make it true. Do not invent a motif, material, occasion or audience not given above.
${(ctx.extraRules ?? []).map((r) => `- ${r}`).join('\n')}${ctx.extraRules?.length ? '\n' : ''}
Write ONE title. Return only the title string.`
  return { system, user }
}

const PO_GOLD_TITLES = [
  'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt',                    // 72 — Pattern A, idiom expanded
  'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup',                 // 75 — Pattern B, high-search category
  'THE CEO Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men',                    // 72 — Pattern A, headwear + gender
  'THE CEO Don’t Quit Tee Shirt | Bold Motivational tShirt for Men & Women',                     // 71 — Pattern A, motivational
  'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women',                  // 74 — Pattern A, MONEY-KEYWORD pipe tail (PO lock, B0FKKN8XKV — replaces the obsolete inverted Pattern-B form)
  'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women',                   // 73 — Pattern A, idiom kept short
  'THE CEO I Could Be Meaner Tee Shirt | Comfort Color Graphic Shirt for Women',                 // 75 — Pattern A, statement
  'THE CEO Ocean Life Sea Animals Tee Shirt | Comfort Colors Tshirt for Women',                  // 74 — Pattern A, theme
] as const
/** Deterministic title QUALITY judge — scores a title against PO_GOLD_TITLES pattern rules.
 *  Returns {score 0-100, problems: string[]}. Used by the humanizer adopt gate: when the retry
 *  scores higher than the current, adopt it EVEN IF same length (fixing the strict len> gate at
 *  5473 that discards format wins). Only rejects on trademark/brand-front safety, per Karpathy:
 *  the judge scores QUALITY, the trademark/brand-front nets are separate SAFETY gates. */
const TITLE_V2_BANNED_MODIFIERS = new Set([
  'funny', 'novelty', 'graphic', 'retro', 'cute', 'vintage', 'farewell', 'goodbye',
  'going', 'away',
])
/** Product-noun tokens that a banned decorator becomes ALLOWED against — i.e. "Graphic Shirt" is a
 *  legit attribute-pair (matches PO golds #6/#7 both using "Graphic Shirt"), while a bare "Graphic"
 *  or "Graphic Design" reads as stuffing. Same principle allows "Long Sleeve", "Bold Motivational",
 *  "Puff Embroidery" — the modifier stands in for an attribute of the product-noun. */
const TITLE_V2_ATTR_PAIR_NOUNS = new Set([
  'shirt', 'shirts', 'tshirt', 'tshirts', 'tee', 'tees', 't-shirt', 't-shirts',
  'cap', 'hat', 'hoodie', 'sweatshirt', 'tank', 'polo', 'dress', 'jacket', 'beanie',
  'motivational', 'embroidery', 'sleeve', 'fit', 'style',
])
/**
 * TITLE_SHAPE_JUDGE — on (DEFAULT) | shadow | off. `TITLE_SHAPE_JUDGE=off` is the kill switch.
 *
 * DEFAULTED ON 2026-08-11, deliberately, and this DOES change generated titles on deploy.
 *
 * It shipped default-off on 2026-08-10 so the seller could stage it. The staging step was the
 * problem: with the flag unset, the very next regeneration of B0GVV3XL4T produced
 *   "THE CEO 2026 World Soccer Cup Unisex Classic Fit Fan Shirt | Short Sleeve"
 * — an 11-word left segment carrying BOTH banned phrases, with a third spec fact welded into the
 * money position. The old judge scores that 95/100. So the default was not a safety measure; it was
 * the reason the defect kept shipping while a tested cure sat inert behind an env var.
 *
 * The standing rule is that every behaviour change has a KILL SWITCH, not that every change defaults
 * to off. The switch is intact — set TITLE_SHAPE_JUDGE=off and the judge reverts byte-for-byte to
 * its pre-2026-08-10 scoring, no deploy required.
 */
const titleShapeJudgeMode = (): string => (process.env.TITLE_SHAPE_JUDGE || 'on').toLowerCase()

/* ── TITLE_V4 — the phase-3 flag: STOP MANUFACTURING TEXT ──────────────────────────────────────────
 *
 * off              byte-identical to today, and silent. The explicit kill switch.
 * shadow (DEFAULT) every deletion is MEASURED and logged — the title that WOULD have shipped
 *                  without the padding is written to [TITLE_V4_DIFF] — but today's title still
 *                  ships, byte-for-byte.
 * on               the padding is gone for real.
 *
 * WHY SHADOW IS THE DEFAULT AND NOT `off`. Shadow does not change a single shipped character —
 * that is asserted, not asserted-ish: titleV4.test.ts scores all nine golds under shadow and under
 * off and requires them equal. Defaulting to `off` would mean the refusal rate only starts being
 * collected after someone remembers to set an environment variable, and the measurement is the
 * whole point of this phase. A behaviour-neutral measurement that requires a manual step is a
 * measurement that does not happen. `off` remains as the explicit kill switch.
 *
 * WHY SHADOW FIRST, AND WHY IT IS CHEAP HERE. The "new" title under every one of these deletions is
 * simply the string as it stood BEFORE the padding ran — which the code already holds. So shadow
 * costs one captured variable and one log line per stage, not a second generation pass.
 *
 * WHAT IT MEASURES, and it is the number the seller asked for before any of this reaches a listing:
 * how often removing the padding drops a title under the corpus floor, i.e. how often the seller's
 * own ruling ("never ship short — always ask me", 2026-08-12) would hold a listing back. My estimate
 * was 33-54 chars on one traced chain; an estimate is not a rate. */
export const titleV4Mode = (): 'off' | 'shadow' | 'on' => {
  const v = (process.env.TITLE_V4 || 'shadow').toLowerCase()
  // Anything unrecognised falls to SHADOW, never to `on`: a typo can log, but it can never change a
  // shipped title. `off` must be typed exactly, because silencing the measurement is a real decision.
  return v === 'on' ? 'on' : v === 'off' ? 'off' : 'shadow'
}
/** True when the padding must not run for real. Shadow still runs it (so shipping is unchanged) and
 *  logs what it would have suppressed. */
const v4Applies = (): boolean => titleV4Mode() === 'on'

/* ── TITLE_REFEREE — SHADOW ONLY, AND `off` IS THE DEFAULT ─────────────────────────────────────
 *
 * off (DEFAULT) | shadow | on
 *
 * WHY `off` IS THE DEFAULT HERE AND `shadow` WAS THE DEFAULT FOR TITLE_V4. Shadow for V4 cost one
 * captured variable and one log line — the "new" title was a string the code already held. Shadow
 * HERE costs a REAL MODEL CALL on the regen path. A measurement that spends money must be switched
 * on deliberately, so unset means nothing happens and nothing is billed.
 *
 * THE 2026-08-09 INCIDENT IS THE REASON FOR EVERY GUARD BELOW. An in-band LLM heal ran >160s, the
 * gateway 502'd it BEFORE the write that would have armed its own cooldown, so every page load
 * re-fired a doomed billable job. The lessons, applied:
 *
 *   1. BOUNDED BY CONSTRUCTION. This runs at most ONCE per council invocation — no loop, no retry,
 *      no cooldown to arm. That is what makes it a different shape from the heal: there is no state
 *      whose absence can cause a re-fire. (Stating it plainly rather than claiming to have applied
 *      an arming pattern that does not fit.)
 *   2. SAMPLED, DETERMINISTICALLY. Only a fraction of regens pay for it, chosen by hashing the
 *      candidate set — so the same listing samples the same way on every run, which makes the
 *      shadow data reproducible instead of a lottery.
 *   3. HARD TIMEOUT. A hung call can never hold a regen open.
 *   4. FAIL-OPEN, ALWAYS. Any error, timeout or malformed verdict ships the council's own pick,
 *      unchanged, and logs why. The referee cannot make a regen fail.
 *   5. AT `shadow` IT DECIDES NOTHING. It is asked, its answer is logged as [TITLE_REFEREE_DIFF],
 *      and the council's winner ships byte-identical. `on` is deliberately NOT implemented in this
 *      change — wiring a decider is a separate, reviewable step that should follow the data.
 */
export const titleRefereeMode = (): 'off' | 'shadow' | 'on' => {
  const v = (process.env.TITLE_REFEREE || '').trim().toLowerCase()
  return v === 'shadow' ? 'shadow' : v === 'on' ? 'on' : 'off'
}
/** 1-in-N regens pay for the shadow call. Deterministic per candidate set, so a given listing is
 *  always sampled the same way and the resulting data is reproducible. */
const REFEREE_SAMPLE_1_IN = Number(process.env.TITLE_REFEREE_SAMPLE || 5) || 5
const REFEREE_TIMEOUT_MS = 25_000
/** Stable string hash — NOT Math.random: a random sample makes every measurement unrepeatable. */
const stableHash = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
const refereeSampled = (key: string): boolean =>
  REFEREE_SAMPLE_1_IN <= 1 || stableHash(key) % REFEREE_SAMPLE_1_IN === 0

/**
 * THE PO'S MEASURED TITLE SHAPE, AS NUMBERS THE PRODUCER'S ARBITER CAN SEE.
 *
 * WHY THIS EXISTS (2026-08-10, after five door-side patches to the same title). Every PO title
 * ruling in this subsystem lives in a TERMINAL NET at the ship door. None of them lived in
 * `titleQualityJudge` — the ONE deterministic title measurement in the pipeline, and the arbiter for
 * BOTH producer-side actors: the council's fail-open winner-pick (:2976) and the humanizer's adopt
 * gate (:6378). So the producer was scored INDIFFERENT to the exact things the door would then have
 * to delete, and the two disagreed by construction:
 *
 *   the door bans `unisex` / `classic fit`   (TITLE_WASTE_SOURCE, titleBand.ts:1112)
 *   TITLE_V2_BANNED_MODIFIERS above          never mentioned either one
 *
 * The live consequence, reproduced arithmetically: the council wrote "…Canada Unisex Tee" (61 chars,
 * 12 words, one segment). The door's `stripTitleWasteVocabulary` removed "Unisex" → 54 chars, then
 * had to re-pad to reach the band; its entire BLANK_SPECS vocabulary topped out at 69 (the only
 * candidate that reached band, "Classic Fit Shirt", is itself banned as waste at titleBand.ts:133).
 * 69 < 70, so the guard refused byte-identical and the banned word SHIPPED — a PO editorial ruling
 * reversed by ONE character of our own preferred floor. Scoring these upstream means the producer
 * never writes them, which cures the ruling without touching a single guard.
 *
 * PURE, and deliberately adds NO new vocabulary: waste comes from `isTitleWasteVocabulary`, the SAME
 * exported predicate the door removes with, so the producer and the door can never drift apart.
 */
export function titleShapeTerms(title: string, maxLeftWords?: number | null): {
  hasPipe: boolean
  /** Words left of the separator — null when there is no separator, because an unpiped title has no
   *  left segment to measure. That null is what protects PO gold #2 and the ~70% unpiped majority. */
  leftWords: number | null
  leftDock: number
  wasteDock: number
} {
  const t = (title || '').trim()
  const pipeIdx = t.indexOf(' | ')
  const hasPipe = pipeIdx >= 0
  // C3 is defined on the LEFT SEGMENT, which only exists when a separator does. Scoring an unpiped
  // title's whole word count as a "left segment" is the exact `leftOf` inflation corrected in
  // measureGoldShape — re-importing it here would dock every Pattern-B title, i.e. most of the corpus.
  const leftWords = hasPipe ? (t.slice(0, pipeIdx).trim().split(/\s+/).filter(Boolean).length) : null
  const ceiling = typeof maxLeftWords === 'number' && maxLeftWords > 0 ? maxLeftWords : null
  const over = leftWords !== null && ceiling !== null ? Math.max(0, leftWords - ceiling) : 0
  // -5/word over, capped at -20 so a long left segment can never outweigh brand-front (-20), which
  // is safety-adjacent. The ceiling is the seller's own measured max, not a number we invented.
  const leftDock = Math.min(20, over * 5)
  // -10 when the title carries vocabulary the PO banned. Sized above the pipe bonus (+5) so a title
  // cannot buy back a PO ban with structure, and level with the audience dock — the other explicit
  // PO ruling scored here. The PREDICATE IS THE DOOR'S OWN (`isTitleWasteVocabulary`, titleBand.ts):
  // a second copy of `unisex|classic fit` here is precisely the drift that let the producer and the
  // door disagree in the first place, so there is exactly one list and both ends read it.
  const wasteDock = isTitleWasteVocabulary(t) ? 10 : 0
  return { hasPipe, leftWords, leftDock, wasteDock }
}

export function titleQualityJudge(title: string, opts: {
  brandName: string
  productType?: string | null
  aud?: string
  designName?: string
  /** The seller's measured left-segment ceiling (`GoldShape.maxLeftWords`, poGoldCorpus.ts). Absent
   *  ⇒ no left-segment dock, so every existing caller and test is unaffected. */
  maxLeftWords?: number | null
  /** The FULL measured corpus shape (PR-C). When present at TITLE_SHAPE_JUDGE=on, the judge derives
   *  length pressure, the pipe bonus, the noun rule, the money-position dock, and the vocabulary
   *  docks from IT — never from a hand-typed constant. Absent ⇒ those terms stay legacy. */
  shape?: GoldShape | null
  /** Apparel gate for the corpus-derived terms — the multi-design parent path can reach this judge
   *  on non-apparel, where garment-spec vocabulary rules make no sense. */
  apparel?: boolean
  /** TITLE_COUNCIL_V3.1a Fix D (2026-07-23, PO Q2 single-tier): RAW audience lean forwarded from
   *  PipelineInput.audienceLean → runTitleAgent (single-design) / parent-lean via UNANIMITY (multi-design).
   *  Undefined/null = caller didn't classify → no audience dock (backward-compatible fail-open). */
  lean?: AudienceLean
} = {} as never): { score: number; problems: string[] } {
  if (!title) return { score: 0, problems: ['empty'] }
  const problems: string[] = []
  let score = 100
  const t = title.trim()
  const len = t.length

  // LENGTH. Amazon's >75 cap is external and docks in EVERY mode. The lower pressure is the part
  // that was OURS: the hand-typed sub-70 docks scored the seller's own 69-char gold at 80 (PR-C
  // before-state). At on+shape the floor derives from the corpus (lenMin=69 at HEAD): a title the
  // seller's own range admits takes NO dock; pressure starts only below their shortest gold.
  /* `corpusLen` is the seller's MEASURED LENGTH RANGE, and it must survive TITLE_V4 untouched.
   * Withdrawing it does NOT relax anything — it falls through to the hardcoded `len < 70` docks
   * below, i.e. it RE-CREATES the 70-char floor this change exists to delete, and immediately docks
   * the seller's 69-char Rod Father gold. (Caught by titleV4.test.ts before commit; the first cut of
   * this change gated the wrong variable.) The identity CEILING is a different thing and is
   * withdrawn at its own site below. */
  const corpusLen = titleShapeJudgeMode() === 'on' && opts.shape ? opts.shape : null
  if (len > 75) { score -= 45; problems.push(`length ${len} > 75 Amazon cap`) }
  else if (corpusLen) {
    if (len < corpusLen.lenMin - 10) { score -= 30; problems.push(`length ${len} far under the seller's shortest gold (${corpusLen.lenMin})`) }
    else if (len < corpusLen.lenMin) { score -= 15; problems.push(`length ${len} under the seller's shortest gold (${corpusLen.lenMin})`) }
  }
  else if (len < 50) { score -= 45; problems.push(`length ${len} < 50 floor`) }
  else if (len < 65) { score -= 30; problems.push(`length ${len} well under 70 golden`) }
  else if (len < 70) { score -= 15; problems.push(`length ${len} under 70 golden`) }

  // FORMAT: Pattern A (pipe) gets +5 as a positive structure signal for match to PO golds 1/3/4/6/7/8.
  // Review 2026-07-22: previously hasPipe was DEAD CODE — computed then read only inside an empty
  // `if (!hasPipe)` block. Now it's the actual Pattern-A bonus that lets the humanizer adopt a
  // same-length pipe rewrite over a legacy comma-string via the widened adopt gate at :5473.
  // Pattern B (front-load, no pipe) is judged by rule presence — no synthetic bonus (matches golds 2/5).
  const hasPipe = / \| /.test(t)
  // The pipe earns a bonus only to the degree the CORPUS prefers pipes (pipedShare 0.56 at HEAD →
  // +1). The old flat +5 rewarded structure the seller uses in barely half their titles.
  if (hasPipe) score += corpusLen ? Math.round(10 * (corpusLen.pipedShare - 0.5)) : 5

  // SHAPE TERMS (TITLE_SHAPE_JUDGE=on) — the seller's measured left-segment ceiling and their banned
  // vocabulary, scored HERE so the producer stops writing what the door would have to delete. See
  // `titleShapeTerms` above for the arithmetic that made this the seam. At 'off'/'shadow' the score
  // is byte-identical to the pre-2026-08-10 judge.
  if (titleShapeJudgeMode() === 'on') {
    /* THE DERIVED IDENTITY CEILING — withdrawn at TITLE_V4=on (2026-08-12).
     *
     * MEASURED SELF-CONTRADICTION: `measureGoldShape`'s outlier trim returns maxLeftWords=7, the
     * brief prints that to the council as a hard law, and gold #4 — printed as an exemplar directly
     * beneath it — has a TEN-word identity. The judge duly docks the seller's own gold to 86. A
     * corpus-derived law that rejects a member of its own corpus is not a law.
     *
     * It cannot be repaired by re-tuning the number: the seller's Rod Father gold and pure keyword
     * soup BOTH run 13 identity words, so no word count separates them. Identity LENGTH was never
     * the rule — "is this one thing a person says" is, and that question belongs to the referee. */
    const ceiling = v4Applies() ? null : (opts.shape?.maxLeftWords ?? opts.maxLeftWords)
    const shape = titleShapeTerms(t, ceiling)
    if (shape.leftDock > 0) {
      score -= shape.leftDock
      problems.push(`left segment ${shape.leftWords} words > seller's measured max ${ceiling} (-${shape.leftDock})`)
    }
    if (opts.shape && opts.apparel) {
      // UNATTESTED SPEC VOCABULARY, position-independent (the adversarial-break lesson: every
      // position-scoped rule was defeated by relocation). Each spec claim the seller has NEVER used
      // docks 10; a claim their corpus attests ("long sleeve" ×1 at HEAD) is their voice and free.
      const attested = new Set(opts.shape.vocabAttested)
      const alien = specClaimSpans(t).filter((c) => !attested.has(c))
      if (alien.length > 0) {
        const dock = Math.min(20, 10 * alien.length)
        score -= dock
        problems.push(`spec vocabulary the seller never uses: ${alien.join(', ')} (-${dock})`)
      }
      // MONEY POSITION: a pipe-right that is NOTHING but spec facts is the class the seller has
      // shipped ZERO times (tailClass.specOnly = 0) and the exact shape of every rejected title.
      if (hasPipe) {
        const tail = t.slice(t.indexOf(' | ') + 3)
        if (classifyTail(tail) === 'specOnly') {
          score -= 25
          problems.push(`money position holds only spec facts ("| ${tail.trim()}") — the seller has shipped this 0 times (-25)`)
        }
      }
      // GARMENT NOUN, adjacency-collapsed ("Tee Shirt" = ONE mention). The corpus rule: twice in
      // 8 of 9; the single exception (Espana) is UNPIPED — so a PIPED title with fewer than two
      // mentions is off-corpus, an unpiped one is not.
      const mentions = countGarmentMentions(t)
      if ((hasPipe && mentions < 2) || mentions === 0) {
        score -= 10
        problems.push(`garment noun mentions=${mentions} (corpus: twice in ${opts.shape.garment.twice} of ${opts.shape.count}) (-10)`)
      }
      // THE UNIVERSAL TAIL, corpus-measured: audienceMix.inclusive is 0 of 9. The soft -3 elsewhere
      // let a candidate carrying 23 chars of banned filler WIN on 2026-08-11 and starve the money
      // slot. Zero-attested constructs dock like the rest of the not-their-voice vocabulary.
      if (opts.shape.audienceMix.inclusive === 0 && hasInclusiveAudience(t)) {
        score -= 15
        problems.push(`"for Men and Women" — 0 of ${opts.shape.count} seller golds carry it (-15)`)
      }
    } else if (shape.wasteDock > 0) {
      // No corpus threaded (legacy caller): keep the narrow two-phrase waste dock.
      score -= shape.wasteDock
      problems.push(`title waste vocabulary present (PO §3: "unisex"/"classic fit" belong in Item Highlights) (-${shape.wasteDock})`)
    }
  }

  // PRODUCT NOUN ANCHOR — twice preferred (Shirt … Shirt, Tee Shirt … Tshirt, Cap … Hat).
  const nounRegex = /\b(shirt|shirts|tshirt|tee|tees|cap|hat|hoodie|sweatshirt|tank|polo|dress|jacket|beanie)\b/gi
  const nounHits = (t.match(nounRegex) || []).length
  // At on+shape the adjacency-collapsed mention rule (below) replaces this raw-token count, which
  // double-counts "Tee Shirt" and passed the seller's Espana gold only by that accident.
  if (!(titleShapeJudgeMode() === 'on' && opts.shape && opts.apparel) && nounHits < 2) { score -= 10; problems.push(`product noun appears ${nounHits} time(s); PO gold repeats it (Shirt … Shirt, Tee … Tshirt)`) }

  // BAN LIST — modifier stuffing. Attribute-pair exemption (review 2026-07-22): a banned modifier is
  // EXEMPT if immediately followed by a product-noun (or attribute noun) — "Graphic Shirt" / "Long
  // Sleeve" / "Bold Motivational" / "Puff Embroidery" — because it's functioning as an attribute
  // descriptor for the noun, not a standalone decorator. This fixes the false-fail on PO golds #6/#7
  // (both use "Graphic Shirt" legitimately).
  const bannedFound: string[] = []
  const toks = t.toLowerCase().split(/[\s,|]+/).filter(Boolean)
  const corpusVoice = titleShapeJudgeMode() === 'on' && opts.shape ? new Set(opts.shape.vocabAttested) : null
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]
    if (!TITLE_V2_BANNED_MODIFIERS.has(tok)) continue
    // THE SELLER'S OWN VOICE IS NEVER BANNED (PR-C): "funny" appears in TWO of their golds, yet the
    // hand-typed list docked it — which is how the judge scored their canonical golds 55 and 80.
    // A term the corpus attests is exempt; the list only governs vocabulary the seller never uses.
    if (corpusVoice?.has(tok)) continue
    const next = toks[i + 1]
    if (next && TITLE_V2_ATTR_PAIR_NOUNS.has(next)) continue   // attribute-pair exemption
    bannedFound.push(tok)
  }
  if (bannedFound.length) { score -= 5 * bannedFound.length; problems.push(`banned decorator(s): ${bannedFound.join(', ')}`) }

  // FORCED GENDER — if title has "for Men and Women" but audience is universal, gently dock.
  // (Cannot know design gender-specificity deterministically; soft signal only.)
  if (/\bfor men and women\b/i.test(t)) { score -= 3; problems.push('force-added "for Men and Women"; skip when design is universal') }

  // AUDIENCE-WHEN-LEAN DOCK (Fix D, PO Q2 = single-tier -10, PO Q7 = widened regex accepts Women's/Ladies/Men's).
  // Complements Fix A's persona pin. Sized > +5 pipe bonus so it strictly beats Pattern-A tiebreak, < -20
  // brand-front so brand-front safety still dominates. Silently no-ops when opts.lean is null/undefined
  // (backward-compatible — every existing testcase passes without change).
  const lean = opts.lean
  if (lean === 'male' || lean === 'female' || lean === 'lean_male' || lean === 'lean_female') {
    const hasForWomen = /\bfor\s+women\b/i.test(t) || /\bwomen['’]?s\b/i.test(t) || /\bladies\b/i.test(t)
    const hasForMen = (/\bfor\s+men\b/i.test(t) && !/\bfor\s+men\s+and\s+women\b/i.test(t))
      || (/\bmen['’]?s\b/i.test(t) && !/\bmen['’]?s\s+and\s+women['’]?s\b/i.test(t))
    if ((lean === 'male' || lean === 'lean_male') && !hasForMen) {
      score -= 10
      problems.push(`audience "for Men" absent; design lean=${lean} (-10)`)
    } else if ((lean === 'female' || lean === 'lean_female') && !hasForWomen) {
      score -= 10
      problems.push(`audience "for Women" absent; design lean=${lean} (-10)`)
    }
  }

  // BRAND FRONT — hard requirement, safety-adjacent.
  if (opts.brandName && !t.toLowerCase().startsWith(opts.brandName.trim().toLowerCase())) {
    score -= 20; problems.push(`brand "${opts.brandName}" not at position 0`)
  }

  return { score: Math.min(100, Math.max(0, score)), problems }
}
/** Flag-gated resolver: real garment noun when on, else the frozen shirt base (so every consumer's
 *  `off` branch is byte-identical). Callers still guard their site with GARMENT_NOUN_ON to preserve
 *  each site's exact legacy literal (which differs — 't-shirt' vs 'shirt' vs 'Tee Shirt'). */
function garmentFor(productType?: string | null, title?: string | null): GarmentNoun {
  return GARMENT_NOUN_ON ? garmentNounFor(productType, title) : SHIRT_BASE
}

// Is this an APPAREL product? The title/bullet/description framing (graphic tee, shirt, garment
// brand, men/women audience, fabric/fit specs) only makes sense for clothing. For non-apparel
// (memory cards, mugs, mounts…) the old hardcoded framing produced nonsense — e.g. "Graphic Tee
// for Men" on an SD card — so every agent branches on this.
function looksApparel(category?: string | null, repTitle?: string | null, productType?: string | null): boolean {
  // GROUND TRUTH FIRST: the live SP-API productType decides when known — both directions. The
  // text sniff below once saw a hardcoded "Clothing…" category + no rescue noun for "sticky
  // notes" and wrote "Post It Notes Sticky Note T-SHIRT… Graphic Tee for Men and Women".
  const pt = (productType ?? '').trim().toUpperCase()
  if (pt) return APPAREL_PRODUCT_TYPES.test(pt)
  const hay = ` ${category ?? ''} ${repTitle ?? ''} `.toLowerCase()
  // Strong non-apparel nouns WIN: a memory-card / mug listing templated from a shirt still has
  // leftover "shirt" in its data, but it is NOT clothing. The product noun decides.
  if (/\b(?:memory\s?cards?|sd\s?cards?|micro\s?sd|usb|flash\s?drives?|mugs?|cups?|tumblers?|bottles?|mounts?|holders?|stands?|chargers?|cables?|adapters?|cases?|stickers?|decals?|posters?|prints?|canvas|mousepads?|keychains?|magnets?|earbuds?|headphones?|speakers?|watch(?:es)?|necklaces?|bracelets?|earrings?|candles?|blankets?|pillows?|towels?|backpacks?|wallets?|notebooks?|journals?|toys?|puzzles?|ornaments?|mats?|signs?)\b/.test(hay)) return false
  return /\b(?:t[-\s]?shirts?|tees?|shirts?|hoodie|sweat\s?shirt|sweater|apparel|clothing|tank\s?top|dress|leggings|pajama|garment|jersey|crew\s?neck|long\s?sleeve|onesie|bodysuit|romper|blouse|cardigan|socks?|jacket|beanie|crop\s?top)\b/.test(hay)
}

// Apparel words that contaminate a NON-apparel listing (one templated from a shirt). Dropped
// from the keyword pool + specs so a memory card / mug never inherits "graphic tee",
// "ring-spun cotton", "for men", etc. Only applied when the product is non-apparel.
const APPAREL_CONTAMINANTS = /\b(?:t[-\s]?shirts?|tees?|shirts?|graphic\s*tees?|hoodie|sweat\s?shirts?|sweater|apparel|clothing|garments?|fabric|cotton|ring[-\s]?spun|jersey|knit(?:ted)?|relaxed\s*fit|regular\s*fit|comfort\s*colors|bella\s*canvas|gildan|next\s*level|unisex|m[ae]ns?|wom[ae]ns?|fashion|outfit|wardrobe|sleeves?|crew\s?neck|tank\s?tops?|garment[-\s]?dyed|\bdye\b|wear|wearable)\b/i

// A storage-capacity token ("128GB", "1 TB"). When children span >=2 distinct capacities the
// title is per-child (each carries its own capacity) — NOT a concept that ever matches apparel.
const CAPACITY_RE = /\b(\d{1,4})\s?(t|g)b?\b/i // GB/TB only — "MB" is usually a transfer speed, not capacity
function capacityOf(s: string | null | undefined): string | null {
  const m = (s ?? '').match(CAPACITY_RE)
  // "32G"/"64G." -> 32GB/64GB, "128GB" -> 128GB, "1T"/"1TB" -> 1TB
  return m ? `${m[1]}${m[2].toUpperCase()}B` : null
}

/* ── SEASON POLICY (KEYWORD_TARGET_SET, PO 2026-07-23) ────────────────────────────────────────────
 *
 * THE PROBLEM. Six of the seven keyword consumers below used to BLANKET-strip every SEASONAL_TERM
 * from customer-facing copy (`isSeasonal(kw)`). That rule is right for "a Golf Widow tee that happens
 * to mention Christmas" — a holiday we are not about is off-theme traffic, and a holiday phrase the
 * copy must never contain becomes a scoring dock no regenerate can clear. It MISFIRES when the
 * design's OWN theme IS the holiday: on B0GF49RLDL (a Valentine Cupid tee) 8 of 22 pooled keywords
 * are `valentine*` — the design's actual subject — and blanket stripping made them unplaceable, which
 * is the PO's reported "Valentine never appears in the description".
 *
 * THE RULE. Not "is this word seasonal" but "is this keyword's season OUR season":
 *   ON-SEASON  (the design's own occasion) → placeable in title/bullets/description/highlights.
 *   OFF-SEASON (a DIFFERENT holiday)       → stripped, exactly as before.
 * `isOffSeasonKeyword(kw, [])` === the historical blanket strip, so an EMPTY `effective` reproduces
 * today's bytes exactly — which is what makes the flag-off path provably a no-op.
 */
export interface SeasonPolicy {
  /** Canonical occasions the DESIGN is itself about, as DERIVED — flag-INDEPENDENT, so the shadow
   *  diff can compare the two rules even while the shipped bytes still follow the old one. */
  readonly derived: readonly string[]
  /** What the generators actually strip against: `derived` only when KEYWORD_TARGET_SET=on, else
   *  `[]` ⇒ blanket strip ⇒ byte-identical to today. */
  readonly effective: readonly string[]
  /** THE strip predicate every copy generator in this file calls. Replaces the old `isSeasonal`. */
  isOffSeason(keyword: string): boolean
  /** shadow/on forensics: ONE structured line per generator SITE naming the keywords the flip would
   *  newly admit. Silent when the flag is off, when the design has no season, or when the two rules
   *  agree — so a non-seasonal listing produces no log noise at all. */
  diff(site: string, keywords: readonly string[]): void
}

/**
 * The design's OWN theme text → canonical occasions.
 *
 * SOURCE PRIORITY (deliberately NOT the live listing title). The live title is seller-written and
 * routinely carries an incidental "Christmas Gift for Golfers" tail; treating that as the design's
 * theme would re-create the exact misfire the blanket strip was written to prevent. themeRater.ts
 * makes the same call for the same reason ("EMPTY means there is no design signal at all — the caller
 * must then skip the card rather than let a model guess a theme from a title"). So we read only:
 *   1. `designNameOverride`        — the seller's authoritative scalar design name.
 *   2. `designNameOverridesByKey`  — the seller's PER-DESIGN names. Folding all of them in is what
 *                                    makes a 4-design parent's seasons the UNION of its designs'.
 *   3. `visionDesign` designTheme / visualElements / seedKeywords — what is literally PRINTED on the
 *                                    garment, read off the image. Safe by construction: vision says
 *                                    "christmas" only when the artwork IS christmas.
 *   4. the RESOLVED design name from extractDesignName (optional) — already required to be a real
 *      substring of the title-or-vision text and to NAME the artwork, so it is a tight signal.
 * DELIBERATELY EXCLUDED: `visionDesign.suggestedSearchTerms` and `input.nicheSeeds` — both are
 * shopper-QUERY shaped ("valentines day gift for her"), so a generic gifting query would hand a
 * non-seasonal design a season it does not have.
 */
export function deriveDesignSeasons(input: PipelineInput, resolvedDesignName?: string | null): string[] {
  // DELEGATES to the ONE derivation (selectionContext.ts). The body used to live here, which meant
  // the seven keyword-side callers — none of which can build a PipelineInput — had to grow their own.
  // The four sources are IDENTICAL; only their provenance differs (live input here, persisted rows
  // there), which is what makes the generator's strip and the selector's slot the same rule.
  const local = deriveSeasonsFrom({
    designNameOverride: input.designNameOverride,
    designNameOverridesByKey: input.designNameOverridesByKey,
    visionDesign: input.visionDesign,
    resolvedDesignName,
  })
  // MONOTONE UNION — the safety property, not a nicety.
  //
  // The selector reads the same four signals from the DB; this function reads them LIVE. Staleness
  // can therefore make the DB set contain a season this run's live sources do not (a re-scan changed
  // the artwork; extractDesignName resolved differently than the name the last regen persisted).
  //
  // The asymmetry is NOT symmetric (slotFor, selection-core.ts:308-316):
  //   selector ⊋ generator ⇒ a keyword is classified CORE/placeable and then STRIPPED from copy by
  //                          this file's SeasonPolicy ⇒ a dock no regenerate can clear.
  //   selector ⊆ generator ⇒ a placeable keyword classifies BACKEND ⇒ dock-exempt, no ADD emitted
  //                          ⇒ a missed placement that degrades to today's blanket behaviour.
  // Unioning the ctx the caller resolved makes `generator ⊇ selector` true BY CONSTRUCTION, so the
  // dangerous direction is unreachable rather than merely unlikely.
  //
  // Safe at off/shadow regardless of how `derived` grows: makeSeasonPolicy sets
  // `effective = mode === 'on' ? derived : []`, so a wider set changes nothing until the flip.
  const fromCtx = input.selectionCtx?.designSeasons ?? []
  if (fromCtx.length === 0) return local
  return [...new Set([...local, ...fromCtx])]
}

/**
 * The EXACT historical blanket predicate, character for character as it stood at :1271.
 *
 * WHY IT SURVIVES. seasonalTerms.ts ALSO normalises apostrophes, so `isOffSeasonKeyword(kw, [])`
 * matches strictly MORE than the old rule did — "mother's day gift shirt" was silently allowed into
 * customer copy before and is stripped now. That is a genuine improvement, but it is still a
 * behaviour CHANGE, and flag-off must change nothing. So flag-off runs THIS, flag-on runs the new
 * rule, and the shadow diff reports both directions so the flip is a decision, not a surprise.
 * It reads the IMPORTED list — there is still exactly one SEASONAL_TERMS in the codebase.
 */
const historicalBlanketSeasonal = (keyword: string): boolean =>
  SEASONAL_TERMS.some((t) => keyword.toLowerCase().includes(t))

/** Build the per-regen policy. `derived` comes from deriveDesignSeasons; `asin` only tags the log. */
export function makeSeasonPolicy(derived: readonly string[], asin: string | null): SeasonPolicy {
  const mode = selectionMode()                                   // CALL-TIME read, never module scope
  const effective: readonly string[] = mode === 'on' ? derived : []
  const loggedSites = new Set<string>()                          // ONE line per site, not per keyword
  return {
    derived,
    effective,
    // off/shadow → the historical predicate verbatim (byte-identical output, provably).
    // on         → strip only holidays that are NOT this design's.
    isOffSeason: mode === 'on'
      ? (keyword: string) => isOffSeasonKeyword(keyword, derived)
      : historicalBlanketSeasonal,
    diff: (site: string, keywords: readonly string[]) => {
      if (mode === 'off' || loggedSites.has(site)) return
      const strippedUnderOld = [...new Set(keywords.filter(historicalBlanketSeasonal))]
      // What the flip would newly ADMIT — the design's own occasion. This is the number the PO cares
      // about ("which keywords does the flip let into the copy?").
      const keptUnderNew = strippedUnderOld.filter((k) => !isOffSeasonKeyword(k, derived))
      // What the flip would newly STRIP — the apostrophe-normalisation delta ("mother's day …"),
      // which the old rule let slip through. Small, but it must not be discovered in production.
      const newlyStrippedUnderNew = [...new Set(
        keywords.filter((k) => !historicalBlanketSeasonal(k) && isOffSeasonKeyword(k, derived)),
      )]
      if (keptUnderNew.length === 0 && newlyStrippedUnderNew.length === 0) return   // rules agree
      loggedSites.add(site)
      console.log(JSON.stringify({
        tag: 'KW_ONSEASON_DIFF', mode, site, asin,
        designSeasons: derived, keptUnderNew, newlyStrippedUnderNew, strippedUnderOld,
      }))
    },
  }
}

/** The flag-OFF policy: no design seasons ⇒ historical blanket strip. Used as the default for the
 *  EXPORTED generators, whose out-of-file callers (score-title/route.ts,
 *  regenerate-item-highlight/route.ts) have no design-season context and must keep behaving exactly
 *  as they do today. */
const BLANKET_SEASON_POLICY: SeasonPolicy = {
  derived: [], effective: [],
  isOffSeason: historicalBlanketSeasonal,
  diff: () => {},
}

/* ── TARGET POLICY (KEYWORD_TARGET_SET #143) ──────────────────────────────────────────────────── */

/**
 * The generator-side gate on the ranking-target set. Deliberately the SAME SHAPE as SeasonPolicy:
 * one object, built once per regen, threaded to every producer — because eighteen inline
 * `selectionMode() === 'on' && ...` checks is how a subsystem grows eighteen slightly-different
 * rules, which is the disease this whole line of work exists to cure.
 *
 * At off/shadow EVERY method is the identity function, so the generators are byte-identical.
 */
export interface TargetPolicy {
  /** True only at `on` AND when the pool actually carries persisted ranks. */
  live: boolean
  /** Keep ranking targets AND never-evaluated rows. See `wasEvaluated`. Identity when not live. */
  keep: <T extends { selectionRank?: number | null }>(rows: readonly T[]) => T[]
  /** Keep CORE-slot targets AND never-evaluated rows — the title pin (PO-locked: "CORE-slot only"). */
  core: <T extends { selectionRank?: number | null; selectionSlot?: string | null }>(rows: readonly T[]) => T[]
  /** Rank for comparator use. Infinity for a non-target; Infinity for EVERY row when not live, so
   *  `targetRankGap` returns 0 and the caller's legacy ordering is untouched. */
  rankOf: (k: { selectionRank?: number | null }) => number
}

/** A comparator FRAGMENT (`a || b || c` style) that sorts targets first. Must be composed INSIDE the
 *  call site's existing .sort(), never as a preceding .sort() — a pre-pass is fully overridden by
 *  any later comparator that can order the pair, so it would be silently inert. */
function targetRankGap(
  policy: TargetPolicy,
  a: { selectionRank?: number | null },
  b: { selectionRank?: number | null },
): number {
  if (!policy.live) return 0
  const ra = policy.rankOf(a), rb = policy.rankOf(b)
  return ra === rb ? 0 : ra - rb
}

/**
 * `null` and `undefined` MEAN DIFFERENT THINGS here, and the difference is load-bearing:
 *
 *   selectionRank === null       the selector SAW this keyword and did not pick it  ⇒ not a target
 *   selectionRank === undefined  the row was never in the scored pool at all        ⇒ EXEMPT
 *
 * The exempt case is not hypothetical. `attributeAsKeyword` (:5548) mints synthetic rows that are
 * injected straight into `cleanGated` for two PO-approved features: the seller's own secondary
 * design phrase ("Too Many Books", PO 2026-07-03) and identity synonyms (football/fútbol,
 * 2026-07-15). Those rows never went through research, so they carry no rank — and filtering them
 * out would delete the seller's own typed design phrase from the title pin. Exactly the failure the
 * target set exists to prevent, inflicted by the target set.
 *
 * Rows read from `getStoredAnalysis` always carry an EXPLICIT rank (the mapper emits `?? null`), so
 * a genuine non-target is never confused with a synthetic one.
 */
function wasEvaluated(k: { selectionRank?: number | null }): boolean {
  return k.selectionRank !== undefined
}

const INERT_TARGET_POLICY: TargetPolicy = {
  live: false,
  keep: (rows) => [...rows],
  core: (rows) => [...rows],
  rankOf: () => Infinity,
}

/**
 * @param analysis the pool this regen will generate from — used only to decide `live`.
 *
 * WHY `live` ALSO REQUIRES A NON-EMPTY RANK: at `on`, but before migration 049 has been applied or
 * before this ASIN has ever been through a rating run, every row carries `selectionRank: undefined`.
 * A naive `keep` would then filter the pool to ZERO and the generators would produce a title with no
 * keywords at all. Fail-open: no ranks ⇒ inert policy ⇒ exactly today's behaviour.
 */
function makeTargetPolicy(analysis: readonly { selectionRank?: number | null }[], asin: string | null): TargetPolicy {
  if (selectionMode() !== 'on') return INERT_TARGET_POLICY
  const ranked = analysis.filter((k) => isRankingTarget(k)).length
  if (ranked === 0) {
    console.log(`[KW_TARGET_GEN] pool=${asin ?? '?'} INERT — no persisted selection_rank in the pool (pre-049 or never rated); generators run unchanged`)
    return INERT_TARGET_POLICY
  }
  return {
    live: true,
    keep: (rows) => rows.filter((k) => !wasEvaluated(k) || isRankingTarget(k)),
    core: (rows) => rows.filter((k) => !wasEvaluated(k) || (isRankingTarget(k) && k.selectionSlot === 'CORE')),
    rankOf: (k) => (typeof k.selectionRank === 'number' && Number.isFinite(k.selectionRank) ? k.selectionRank : Infinity),
  }
}

function wordOverlapRatio(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const wb = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))
  if (wa.size === 0 || wb.size === 0) return 0
  const inter = [...wa].filter((w) => wb.has(w)).length
  return inter / Math.min(wa.size, wb.size)
}

function getByteLength(str: string): number {
  return new TextEncoder().encode(str).length
}

function truncateToBytes(str: string, maxBytes: number): string {
  if (getByteLength(str) <= maxBytes) return str
  let low = 0, high = str.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (getByteLength(str.slice(0, mid)) <= maxBytes) low = mid
    else high = mid - 1
  }
  const truncated = str.slice(0, low)
  const lastSpace = truncated.lastIndexOf(' ')
  return lastSpace > low * 0.7 ? truncated.slice(0, lastSpace).trim() : truncated.trim()
}

/** Robust JSON extraction from an LLM response (strips fences, trailing prose, repairs trailing commas). */
function parseJsonLoose<T>(raw: string): T {
  let cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
  const first = cleaned.indexOf('{')
  const last = cleaned.lastIndexOf('}')
  if (first > 0) cleaned = cleaned.slice(first)
  if (last >= 0 && last < cleaned.length - 1) cleaned = cleaned.slice(0, last + 1)
  try {
    return JSON.parse(cleaned) as T
  } catch {
    const repaired = cleaned.replace(/,\s*([}\]])/g, '$1')
    return JSON.parse(repaired) as T
  }
}

// ─── 75-char HARD CAP (Amazon's new title limit, effective July 27, 2026) ──────
// Deterministic last line of defense: never emit a title Amazon would auto-rewrite. Cuts at a
// word boundary from the END (brand + design name + money keyword are all front-loaded by the
// agent, so the tail holds the lowest-value supporting keyphrases), tidies dangling connectors/
// punctuation, and — rather than silently narrowing the audience — DROPS a truncation-mangled
// "for Men"/"for Women" fragment when the full title said "for Men and Women".
export function capTitle75(title: string): string {
  let t = (title || '').replace(/\s{2,}/g, ' ').trim()
  t = deduplicatePhrases(t)
  if (t.length <= 75) return t
  // Every inclusive-audience form the pipeline can emit: "for Men and Women", "Men's and
  // Women's" (the widen-guard's possessive swap), and "&" variants.
  const hadInclusiveAudience = /\bfor Men (?:and|&) Women\b|\bMen['’]s (?:and|&) Women['’]s\b/i.test(t)
  let cut = t.slice(0, 76)
  const lastSpace = cut.lastIndexOf(' ')
  cut = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, 75)).trim()
  // Strip trailing punctuation + dangling FUNCTION words left by the cut ("... Tee for" → "... Tee").
  // A dangling content word from a split keyphrase can survive — acceptable for a last-line backstop;
  // the agent's prompts + retries keep real titles under the cap in the normal path.
  for (let guard = 0; guard < 6; guard++) {
    const tidied = cut.replace(/[\s,;:&|\-–—]+$/g, '').replace(/\s(?:for|and|with|in|of|to|a|an|the|or|by)$/i, '').trim()
    if (tidied === cut) break
    cut = tidied
  }
  if (hadInclusiveAudience && /\s*\b(?:for\s+)?(?:Men|Women)[‘’]?s?(?:\s(?:and|&))?$/i.test(cut)) {
    cut = cut.replace(/\s*\b(?:for\s+)?(?:Men|Women)[‘’]?s?(?:\s(?:and|&))?$/i, '').trim().replace(/[\s,;:&\-–—]+$/g, '')
  }
  // Strip dangling garment fragments from truncation
  cut = cut.replace(/\s+(?:Men[‘’]?s?|Women[‘’]?s?)\s+(?:Short|Long)$/i, '').trim().replace(/[\s,;:&\-–—]+$/g, '')
  return cut
}

function deduplicatePhrases(title: string): string {
  const words = title.split(/\s+/)
  for (let len = 3; len >= 2; len--) {
    for (let i = 0; i <= words.length - len * 2; i++) {
      const phrase = words.slice(i, i + len).join(' ').toLowerCase()
      const next = words.slice(i + len, i + len * 2).join(' ').toLowerCase()
      if (phrase === next) {
        words.splice(i + len, len)
        return words.join(' ')
      }
    }
  }
  return title
}

// ─── ITEM HIGHLIGHTS (Amazon's companion to the 75-char title, July 27 2026) ────
// Item Highlights is a customer-facing companion field, NOT backend keywords (PO 2026-07-02):
// material/fit/feature/use-case phrases, no word repeated, <=125 chars. The old deterministic
// builder joined top-opportunity KEYWORDS ("canada tee shirt for men, canada t shirt, the ceo
// soccer tee, ...") — word repetition + near-duplicate keyword soup that violates Amazon's
// Item Highlights rules (PO caught it on the live output). Rebuilt on the pipeline's
// established idiom: LLM draft (gpt-4.1-mini) → deterministic validator → ONE corrective
// retry → deterministic attribute-built fallback. Every path runs scrubTrademarks before its
// output can reach the pushable rails ("world cup shirts" → "world soccer cup").

// Trivial connectors the repetition gate ignores. men/women/cotton/etc. are deliberately NOT
// here — they count as real words and are allowed only once.
const HIGHLIGHT_STOPWORDS = new Set(['for', 'and', 'the', 'a', 'an', 'of', 'with', 'in', 'to', 'great', 'her', 'his'])
// Pricing/promo language never belongs in a customer-facing highlight. "% off" and "$" match
// anywhere (a \b next to "$" could never fire — it is not a word char); the words need boundaries.
const HIGHLIGHT_PROMO_RE = /\b(?:sale|discount|cheap|free|deal)\b|% ?off|\$/i

const highlightTokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
// Same word-unification the title validator uses (its lines above): singular/plural and
// tshirt/shirt are the SAME word — the PO's live case was "tee shirt / t shirt / shirts" x6.
const normHighlightToken = (t: string): string => {
  const n = t.replace(/s$/, '')
  return n === 'tshirt' ? 'shirt' : n
}

/** Deterministic Item Highlights gates — ALL must pass. Returns the violations (empty = compliant).
 *  Callers scrub trademarks BEFORE validating (the scrubbed string is what ships), so the
 *  trademark gate only fires if a mark somehow survives the scrub. */
export function validateItemHighlights(
  s: string, brandName: string, capacityFamily: boolean,
  /** Canonical occasions THIS design is about (deriveDesignSeasons). Default [] = the historical
   *  blanket rule, which is what the out-of-file caller (regenerate-item-highlight) keeps. */
  designSeasons: readonly string[] = [],
): string[] {
  const problems: string[] = []
  // PO 2026-07-19 (phrase-quality rule) + PO 2026-08-10 (budget 75 → 125, CONTENT_CONTRACT.itemHighlights):
  // Item Highlights must be SHORT feature/benefit phrases within the 125-char Amazon budget, NOT a full
  // sentence — Amazon's field shows next to a ≤75-char title. Was a 125-char budget, which produced a
  // ~120-char comma-sentence live (B0FKKN8XKV). Cap 75 + ban sentence punctuation so the corrective-retry
  // loop + the deterministic fallback both converge on short phrases.
  if (s.length > CONTENT_CONTRACT.itemHighlights.max) problems.push(`${s.length} characters — keep it ≤${CONTENT_CONTRACT.itemHighlights.max}; short feature/benefit phrases, not a sentence`)
  if (/[.!?](\s|$)/.test(s)) problems.push('reads as a full sentence — use short comma-separated feature/benefit phrases with NO sentence punctuation (. ! ?)')
  /* ONE RULE, shared with the push boundary (productDetailAttrs.ihRepeatViolations, 2026-08-18).
   * This used to count locally with `c > 1` — STRICTER than Amazon, which allows a word twice. The
   * generator therefore rejected values `capItemHighlightRepeats` would have shipped unchanged, so
   * the corrective-retry loop chased a constraint that does not exist and the fallback dropped
   * phrases it never needed to. It also blocked the seller's "Graphic Tee for Women" case, where
   * `tee` folds to `shirt`. The validator and the door must answer the same question the same way. */
  const repeated = ihRepeatViolations(s)
  if (repeated.length) problems.push(`these words appear more than ${IH_MAX_WORD_REPEATS}x: ${repeated.join(', ')} — Amazon rejects the SKU above that`)
  if (scrubTrademarks(s).trim() !== s.trim()) problems.push('contains a protected trademark (e.g. "World Cup" — the safe phrasing is "World Futbol Cup")')
  const brands = findThirdPartyBrands(s, ownBrandTokenSet(brandName))
  if (brands.length) problems.push(`contains third-party brand(s)/team(s): ${brands.join(', ')}`)
  const lc = s.toLowerCase()
  // OFF-SEASON only (2026-07-23): "evergreen" means "not about a holiday we are not about". A Valentine
  // design's own "Valentine" is its subject, not a seasonal claim, so it is no longer a violation.
  const season = SEASONAL_TERMS.find((t) => lc.includes(t) && isOffSeasonKeyword(t, designSeasons))
  if (season) problems.push(`contains the seasonal term "${season}" — this is an evergreen field`)
  if (HIGHLIGHT_PROMO_RE.test(s)) problems.push('contains pricing/promotional language (sale/discount/cheap/free/deal/$/% off)')
  if (capacityFamily && CAPACITY_RE.test(s)) problems.push('hardcodes a storage capacity — the field is shared across all capacity variants')
  if (s.split(',').map((p) => p.trim()).filter(Boolean).length < 2) problems.push('must be at least 2 comma-separated phrases')
  return problems
}

/** Deterministic FALLBACK — compliant by construction: assemble short phrases ONLY from the
 *  attribute values actually present (material/fit/neck/sleeve/department) + the design + a
 *  personalization phrase when the title claims it, pass each candidate through the SAME gates,
 *  drop any later phrase that would repeat an earlier phrase's word, and stop at a phrase
 *  boundary <=125. A generic two-phrase tail keeps it from ever falling under 2 phrases. */
export function buildHighlightsFallback(
  finalTitle: string, designName: string, details: PipelineProductDetailImprovement[],
  brandName: string, apparelProduct: boolean, capacityFamily: boolean,
  /** See validateItemHighlights — default [] keeps the historical blanket strip. */
  designSeasons: readonly string[] = [],
  unisexFit = false,
): string {
  const val = (re: RegExp): string => {
    const row = details.find((d) => re.test(d.field_name) && (d.recommended_value || '').trim().length > 0 && d.recommended_value.trim().length <= 40)
    return row ? row.recommended_value.trim() : ''
  }
  const material = val(/^(?:material|fabric)/i)
  const fit = val(/\bfit\b/i)
  // Prefer the Neck row over the collar_style row — "crew neck" reads as copy, "round collar" doesn't.
  const neck = val(/neck/i) || val(/collar/i)
  const sleeve = val(/sleeve/i)
  // (garment-noun + department candidates removed 2026-08-04 — they echoed the title, and IH's rule
  // is to add NEW information; the composed-copy candidates below carry the field now.)
  const candidates: string[] = []
  if (apparelProduct) {
    /* COMPOSED COPY, not a fact-join (PO 2026-08-04: "Cotton tee, Cupid Valentine design, Relaxed
     * fit, Crew Neck, for women" was rejected as very poorly written — and it echoed the title's
     * design/garment/audience words, which the LLM path is explicitly forbidden to do). Each fact
     * is paired with a SAFE generic feel word (soft/comfort/easy — never a performance claim the
     * spec doesn't back), and the title-echoing candidates (design name, garment noun, department)
     * are gone: the title already says those, IH must add NEW information. */
    if (material) candidates.push(`soft ${material.toLowerCase()} feel`)
    if (fit && neck) candidates.push(`${fit.toLowerCase().replace(/\s*\bfit\b\s*/i, ' ').trim()} ${neck.toLowerCase()} comfort`.replace(/\s{2,}/g, ' '))
    else if (fit) candidates.push(/\bfit\b/i.test(fit) ? fit.toLowerCase() : `${fit.toLowerCase()} fit`)
    else if (neck) candidates.push(neck.toLowerCase())
    if (unisexFit && !candidates.some((c) => /unisex/i.test(c))) candidates.splice(1, 0, 'relaxed unisex fit')
    if (sleeve) candidates.push(`easy ${sleeve.toLowerCase()} style`)
    if (/\b(?:personalized|custom)\b/i.test(finalTitle)) candidates.push('made-to-order personalization')
    candidates.push('all-day everyday wear', 'great for gifting')
  } else {
    if (material) candidates.push(material)
    if (designName) candidates.push(`${designName} design`)
    if (/\b(?:personalized|custom)\b/i.test(finalTitle)) candidates.push('custom personalization')
    // Guaranteed generic tail so the field always carries >= 2 phrases even with zero attribute rows.
    candidates.push('made for everyday use', 'great for gifting')
  }

  const ownBrands = ownBrandTokenSet(brandName)
  const used = new Set<string>()
  const phrases: string[] = []
  let len = 0
  for (const raw of candidates) {
    const p = scrubTrademarks(raw).replace(/\s{2,}/g, ' ').trim()
    if (!p) continue
    const lc = p.toLowerCase()
    if (findThirdPartyBrands(p, ownBrands).length > 0) continue
    if (SEASONAL_TERMS.some((t) => lc.includes(t) && isOffSeasonKeyword(t, designSeasons))) continue
    if (HIGHLIGHT_PROMO_RE.test(p)) continue
    if (capacityFamily && CAPACITY_RE.test(p)) continue
    const toks = highlightTokens(p).filter((t) => !HIGHLIGHT_STOPWORDS.has(t)).map(normHighlightToken)
    if (new Set(toks).size !== toks.length) continue          // repeats a word within itself
    if (toks.some((t) => used.has(t))) continue               // would repeat an earlier phrase's word — drop it
    const next = phrases.length ? len + 2 + p.length : p.length
    if (next > CONTENT_CONTRACT.itemHighlights.max) continue   // Item Highlights budget (PO 2026-08-10: 75 → 125)
    toks.forEach((t) => used.add(t))
    phrases.push(p)
    len = next
  }
  return phrases.join(', ')
}

// Item Highlights is a customer-facing companion field, NOT backend keywords (PO 2026-07-02):
// material/fit/feature/use-case phrases, no word repeated, <=125 chars.
export async function buildItemHighlights(
  openai: OpenAI, finalTitle: string, designName: string, details: PipelineProductDetailImprovement[],
  pool: AnalyzedKeyword[], brandName: string, apparelProduct: boolean, capacityFamily: boolean,
  /** Season policy for THIS regen (makeSeasonPolicy). Defaults to the blanket policy so the
   *  out-of-file caller (regenerate-item-highlight/route.ts, 8 args) is byte-identical to today. */
  season: SeasonPolicy = BLANKET_SEASON_POLICY,
  /** blankSpec.unisex — adds the unisex-fit fact to the brief + fallback (PO 2026-08-06).
   *  Defaults false so the out-of-file regen-route caller stays byte-identical. */
  unisexFit = false,
  /** Matched blank ROW for the blank-brand waterfall net (PO 2026-08-08). null = no matched blank
   *  (or a caller that predates the net) → the net no-ops, byte-identical to today. */
  blankBrand: BlankSpecRow | null = null,
  /** The title(s) the shipped IH will actually sit beside — the PO's LOCKED title when
   *  title_source='manual' (the fresh finalTitle is discarded at persist on locked listings), else
   *  finalTitle. null = default to [finalTitle]. */
  netTitles: (string | null | undefined)[] | null = null,
): Promise<string> {
  // Product FACTS for the brief: the attribute rows the pipeline already computed (Material /
  // Fit Type / Neck / Sleeve / Department / Style / Target Gender). Keywords are CONTEXT only.
  const factRows = details
    .filter((d) => /material|fabric|\bfit\b|neck|collar|sleeve|department|style|pattern|closure|gender/i.test(d.field_name) && (d.recommended_value || '').trim())
    .slice(0, 6)
    .map((d) => `- ${d.field_name}: ${d.recommended_value.trim()}`)
  const ownBrands = ownBrandTokenSet(brandName)
  /* IH-2 (PO 2026-08-18): "it should be taking descriptive terms from the Keyword bank if not used
   * in title, Such as 'Graphic Tee for Women'".
   *
   * THE PLACEMENT DOCTRINE, EXTENDED — one rule, not a new list. The system already answers "which
   * field holds which keyword" for the other three surfaces: TITLE takes the one money keyword,
   * BACKEND takes the CRITICAL/UPGRADE overflow, BULLETS stay clean benefit prose and are NOT a
   * coverage surface. Item Highlights had no stated place in that scheme, so the pool arrived here
   * as unfiltered "context" and the field never earned its indexed, shopper-visible space.
   *
   * ITS PLACE: spec-grounded descriptors PLUS the descriptive residual the TITLE could not fit.
   * That is why the filter below is "not already covered by the title" and not "highest volume" —
   * a term the title already carries is not residual, it is a repeat, and repeats are precisely what
   * this field must avoid (the prompt's own rule, and Amazon's 2x word cap).
   *
   * ONE PREDICATE, NOT A SECOND ONE. `makeCoverageChecker` is the repo's single coverage seam
   * (coverage-core), the same tokeniser the scorer and the RANK panel use — so "the title already
   * says this" means the same thing in this field as it does on every screen. Its garment folding is
   * what makes the seller's own example work: "graphic tee for women" is NOT considered covered by a
   * title that never mentions women, even though both contain a garment noun.
   *
   * The haystack is netTitles when present — on a locked listing the shipped IH sits beside the
   * seller's LOCKED title, not the fresh one the pipeline just produced, and residual is only
   * meaningful against the title that will actually be on the page.
   *
   * Widened 3 -> 8 because the list is now FILTERED to terms that can legitimately be placed;
   * previously three unfiltered rows could all be title repeats, leaving the model nothing usable.
   * The hard gates below and the terminal net still bound what survives. */
  const ihTitleHay = ((netTitles && netTitles.length ? netTitles : [finalTitle])
    .filter(Boolean) as string[]).join(' ')
  const titleCovers = makeCoverageChecker(ihTitleHay)
  const contextKws = [...pool]
    .sort((a, b) => (b.coverageGapScore || 0) - (a.coverageGapScore || 0))
    .map((k) => scrubTrademarks((k.keyword || '').trim()).toLowerCase())
    .filter((kw) => kw
      && !season.isOffSeason(kw)
      && findThirdPartyBrands(kw, ownBrands).length === 0
      && !(capacityFamily && CAPACITY_RE.test(kw))
      // THE IH-2 FILTER: only the residual the title could not carry.
      && !titleCovers(kw))
    .slice(0, 8)
  season.diff('item-highlights', pool.map((k) => (k.keyword || '').trim()).filter(Boolean))

  // The PO's rules as the brief's spine: the CONTENT_CONTRACT.itemHighlights budget (125 max, aim 110-125 per PO 2026-08-10), short feature/benefit PHRASES (PO 2026-07-19)
  // (NOT a full sentence), and do NOT repeat what the title already says (add NEW info — fabric/fit/feel/care).
  // Display: Amazon moved Item Highlights BENEATH the item name on desktop and mobile effective
  // 2026-08-10 (Seller Central title-update FAQ) — the old "next to the title" wording is stale.
  // The "<=75-char title" clause is NOT stale and stays: it is Amazon error 100476, a dependency on
  // the ITEM NAME's length, unrelated to this field's own budget.
  // PHRASE-CLASS STRUCTURE (PO 2026-08-20, from a live competitor exemplar in the seller's own
  // niche): the field is a searchable SUB-HEADLINE — 5-6 comma phrases, each a DISTINCT search-intent
  // CLASS, built from the unused-keyword bank + spec facts. The prior brief demanded benefit-prose
  // and carried a 63-char example that trained undershoot at HALF the 110-125 band. Rules stated as
  // CONSTRAINTS with a placeholder-shape example — never a vocabulary exemplar (leak lesson #365).
  const system = 'You write the Amazon "Item Highlights" field — a searchable SUB-HEADLINE shown beneath the title and fully indexed by Amazon search. It is NOT a sentence. '
    + `Output 5-6 comma-separated phrases, EACH from a DIFFERENT class: (1) category head, (2) category + audience, (3) design-class or garment attribute, (4) tone/genre word that truthfully fits the design, (5) fabric/fit FACT from the product facts given, (6) category-synonym + audience-synonym. `
    + 'THE PHRASES ARE RANKING KEYWORDS (PO 2026-08-20): the unused-keyword bank below contains real shopper searches with real volume — build each class phrase FROM those keywords, keeping their wording near-VERBATIM (adjust only casing/grammar); a bank keyword used as-is beats a paraphrase, because the exact token sequence is what ranks. '
    + `HARD RULES: ${CONTENT_CONTRACT.itemHighlights.max} characters MAXIMUM total (aim ${CONTENT_CONTRACT.itemHighlights.fillTarget}-${CONTENT_CONTRACT.itemHighlights.max} — under-filling wastes indexed, shopper-visible space); NO sentence punctuation (. ! ?); `
    + 'SYNONYM SPREAD is the point: vary the garment noun across phrases (shirt / tee / apparel / top / short sleeve) and the audience word (men/guys, women/ladies) so DISTINCT search tokens get indexed — never repeat the EXACT garment or audience word the title uses, and no significant word may appear twice in this field; '
    + 'fabric/fit claims ONLY from the product facts provided — never invent a material, weight, or stretch; '
    + 'no prices or promo language; no third-party brand names, sports teams, leagues or franchises; standard capitalization, no ALL CAPS words. '
    + `SHAPE example with placeholders (~118 chars — hit this fullness): "<tone> <category> Shirts, <category-synonym> for <audience>, <design-class> Short Sleeve, <tone-synonym>, <fabric fact>, <category-variant> for <audience-synonym>". `
    + 'Return ONLY the Item Highlights string — no quotes, no explanation.'
  const user = [
    'Product facts:',
    `- Title: ${finalTitle}`,
    unisexFit ? '- Fit note: unisex sizing, runs relaxed (a TRUE spec fact — "relaxed unisex fit" is a great phrase)' : '',
    designName ? `- Design name: ${designName}` : '',
    ...factRows,
    `- Product type: ${apparelProduct ? 'apparel (garment)' : 'non-apparel'}`,
    capacityFamily ? '- This family spans MULTIPLE storage capacities — never mention a specific GB/TB.' : '',
    /* IH-2: these are now the descriptive RESIDUAL — real shopper phrasing the TITLE could not
     * carry (filtered by the shared coverage predicate above). They are eligible to be WORDED IN,
     * not merely inferred from, which is the seller's ask: "taking descriptive terms from the
     * Keyword bank if not used in title, Such as 'Graphic Tee for Women'".
     * The anti-keyword-list rule STAYS and matters more now that these are placeable: the field is
     * customer-facing prose, so a phrase is woven in naturally or left out. Truth is unaffected —
     * spec claims still come only from the FACT rows above, never from a search phrase. */
    /* PO 2026-08-20 (ranking-keyword classes): the bank is the PRIMARY material — the system prompt
     * builds its 5-6 class phrases FROM these near-verbatim. Truth rule unchanged: spec claims still
     * come only from the FACT rows above, never from a search phrase. */
    contextKws.length ? `UNUSED-KEYWORD BANK — real shopper searches your TITLE does not cover. Build the class phrases FROM these, keeping their wording near-verbatim (the exact token sequence is what ranks); vary garment/audience words across phrases, never letting one become a spec claim:\n${contextKws.map((k) => `- ${k}`).join('\n')}` : '',
    'Write the Item Highlights string now.',
  ].filter(Boolean).join('\n')

  // Same single-call client pattern as the other agents: short timeout, NO retries (a hung call
  // must not stall the keepalive-less tail of the pipeline), fail open to '' on any error.
  const ask = async (corrective: string): Promise<string> => {
    try {
      const r = await openai.chat.completions.create(
        {
          model: 'gpt-4.1-mini',
          messages: [
            { role: 'system' as const, content: system },
            { role: 'user' as const, content: corrective ? `${user}\n\n${corrective}` : user },
          ],
          temperature: 0.4,
          max_tokens: 40,   // ≤75 chars of output — cannot spill into a long sentence
        },
        { timeout: 15_000, maxRetries: 0 },
      )
      return (r.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
    } catch { return '' }
  }

  // KEYWORD-LIST DETECTOR (2026-07-18, PO: "NOT SEO friendly … confirm via Vision and DB"): the LLM
  // sometimes ignores "NEVER a keyword list" and emits search permutations ("… comfort colors tshirt women,
  // comfort colors t-shirts, plain t shirts") — Amazon accepts it but it's spam, not a customer highlight.
  // Detect it (>=3 comma-phrases each carrying a garment noun — a real highlight names ATTRIBUTES/use-cases,
  // not the product type in every phrase) and force the clean, SPEC-GROUNDED buildHighlightsFallback (built
  // from the DB fact rows: Material/Fit/Neck/Sleeve/Department + the design). This is the deterministic
  // "ground in DB + design, never a keyword list" the field was specified to do.
  const isKeywordList = (s: string): boolean => {
    const phrases = s.split(',').map((p) => p.trim()).filter(Boolean)
    const garmentRe = /\b(?:t[-\s]?shirts?|tees?|tshirts?|shirts?|hoodies?|sweatshirts?|tank ?tops?)\b/i
    return phrases.length >= 3 && phrases.filter((p) => garmentRe.test(p)).length >= 3
  }
  const gate = (s: string): string[] => {
    if (!s) return ['empty response']
    const p = validateItemHighlights(s, brandName, capacityFamily, season.effective)
    if (isKeywordList(s)) p.push('reads as a keyword LIST (product-type permutations) — Item Highlights must name the MATERIAL, FIT, FEATURES + ONE use-case in human phrases grounded in the product facts, NEVER a search-keyword list')
    return p
  }
  // Draft → validate (incl. keyword-list gate) → ONE corrective retry → deterministic spec-based fallback.
  // scrubTrademarks runs BEFORE validation on every LLM output (the scrubbed string is what ships).
  let out = scrubTrademarks(await ask('')).trim()
  let problems = gate(out)
  // #IH-VISIBILITY (2026-08-20): the draft->gate->retry->fallback chain decided SILENTLY — the
  // catalog-contamination remediation regen shipped the generic fallback with no trace of WHY
  // (empty draft from a swallowed API error? gate rejection? which rule?). One decision line per
  // stage, same treatment that cracked the silent council judges (#176).
  console.log(JSON.stringify({ tag: 'IH_DRAFT', design: designName || null, draftLen: out.length, draft: out.slice(0, 140), problems }))
  if (problems.length > 0) {
    const correction = `Your previous attempt was rejected:\n"${out}"\nViolations:\n${problems.map((p) => `- ${p}`).join('\n')}\nRewrite the Item Highlights string fixing EVERY violation. Return ONLY the string.`
    out = scrubTrademarks(await ask(correction)).trim()
    problems = gate(out)
    console.log(JSON.stringify({ tag: 'IH_RETRY', draftLen: out.length, draft: out.slice(0, 140), problems }))
  }
  // OVER-LENGTH ALONE IS NOT FATAL (2026-08-20, the 128-char confession): the gate was discarding a
  // perfect class-structure draft for being 3 chars over, shipping the generic fallback instead. The
  // return path's capItemHighlightRepeats already enforces the 125 budget DETERMINISTICALLY at a
  // comma boundary (INVARIANT 2: the net, not the LLM, owns the measurable) — so a draft whose ONLY
  // sin is length flows to the cap. Any other violation still falls back.
  if (problems.length > 0 && problems.every((p) => /characters/.test(p))) {
    console.log(JSON.stringify({ tag: 'IH_ACCEPT_OVERLength', len: out.length, note: 'length-only violation — comma-boundary cap enforces the budget' }))
    problems = []
  }
  if (problems.length > 0) console.warn(JSON.stringify({ tag: 'IH_FALLBACK', reason: problems }))
  // Deterministic repeated-words cap on EVERY return path (the LLM ignored the "no repeats" rule and
  // shipped "comfort colors" ×3 on a Comfort-Colors blank; the fallback is repeat-safe by construction but
  // capping it too is free insurance) — guarantees the generated Item Highlight is Amazon-compliant AND
  // (via the keyword-list gate above) a real spec-grounded highlight, not a truncated keyword list.
  // BLANK-BRAND WATERFALL (PO 2026-08-08): the net wraps BOTH producer paths — LLM output AND the
  // spec fallback (Invariant 1: one net, every path) — and the cap re-runs after any insertion so
  // the shipped bytes always hold ≤75 chars / ≤2 per word.
  const titlesForNet = netTitles ?? [finalTitle]
  if (problems.length === 0) return capItemHighlightRepeats(ensureBlankBrandInHighlights(out, titlesForNet, blankBrand))
  return capItemHighlightRepeats(ensureBlankBrandInHighlights(
    buildHighlightsFallback(finalTitle, designName, details, brandName, apparelProduct, capacityFamily, season.effective, unisexFit),
    titlesForNet, blankBrand))
}

// ─── Title validation (shared with the route's PR1 validator semantics) ────────

export function validateTitle(
  title: string, brandName: string, mustInclude?: string, attributePin?: string, upgradeKws?: string[], designName?: string,
  /** Canonical occasions THIS design is about (deriveDesignSeasons). Default [] = the historical
   *  blanket rule, which is what the out-of-file caller (score-title/route.ts) keeps. */
  designSeasons: readonly string[] = [],
): string[] {
  const problems: string[] = []
  const len = title.length
  if (len > 75) problems.push(`Title is ${len} characters; Amazon's NEW limit is 75 (effective July 27, 2026 — longer titles get AUTO-REWRITTEN by Amazon). Cut supporting keyphrases (they belong in backend keywords / Item Highlights), keep brand + design/product name + the money keyword.`)
  else if (len < 50) problems.push(`Title is only ${len} characters; use more of the 75-char budget — weave in a design-grounded / niche keyphrase (a short title wastes search real estate). Keep it under the 75-char cap.`)

  const counts = new Map<string, number>()
  title.toLowerCase().split(/\s+/).forEach((w) => {
    const base = w.replace(/[^a-z0-9]/g, '')
    if (base && !MINOR_WORDS.has(base)) {
      let norm = base.replace(/s$/, '')
      // Unify the product-type word so "T-Shirt" + "Shirt" + "Shirts" counts as THREE
      // "shirt"s (Amazon's max-2 rule). Without this, "tshirt" and "shirt" were treated
      // as different tokens and the 3× "shirt" repetition slipped through.
      if (norm === 'tshirt') norm = 'shirt'
      counts.set(norm, (counts.get(norm) ?? 0) + 1)
    }
  })
  const repeated = [...counts.entries()].filter(([, c]) => c > 2).map(([w]) => w)
  if (repeated.length) problems.push(`These words appear more than twice (Amazon allows max 2 each): ${repeated.join(', ')}. Do NOT append "shirt"/"tee" to every keyphrase — name the product type once or twice total.`)

  const lc = title.toLowerCase()
  // OFF-SEASON only (2026-07-23): a Valentine design's "Valentine" is the design's SUBJECT and belongs
  // in the title; "Christmas" on that same design is still off-theme traffic and still fails here.
  const season = SEASONAL_TERMS.find((s) => lc.includes(s) && isOffSeasonKeyword(s, designSeasons))
  if (season) problems.push(`Remove the seasonal term "${season}" — evergreen product; seasonal keywords belong in backend terms.`)

  const words = new Set(lc.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))
  const hasKids = KIDS_AUDIENCE.some((t) => words.has(t))
  const hasAdult = ADULT_AUDIENCE.some((t) => words.has(t))
  if (hasKids && hasAdult) problems.push('Title mixes kids and adult audiences (e.g. "kids" with "men"/"women") — pick ONE consistent audience.')

  // The single highest-search-volume keyword must survive into the title (the money term).
  if (mustInclude) {
    const phrase = mustInclude.toLowerCase()
    const phraseWords = phrase.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !MINOR_WORDS.has(w))
    const present = lc.includes(phrase) || (phraseWords.length > 0 && phraseWords.every((w) => words.has(w)))
    if (!present) problems.push(`Title MUST contain the highest-volume keyword "${mustInclude}" (or all of its key words) — front-load it.`)
  }

  // 🔴 DESIGN NAME (PR #91) — the seller's design identity ("Later Gator") must appear
  // VERBATIM. Substring match (not word-set) so paraphrases like "See You Later Alligator"
  // for a "Later Gator" design DON'T satisfy it. Drives the retry to restore it.
  if (designName) {
    const dn = designName.toLowerCase()
    const dnIdx = lc.indexOf(dn)
    if (dnIdx === -1) {
      problems.push(`🔴 DESIGN NAME MISSING: the title must contain the product's design name "${designName}" VERBATIM (it's the seller's design identity printed on the product). Do NOT paraphrase or substitute a synonym — use "${designName}" exactly.`)
    } else {
      // The design name is the product's IDENTITY — it must LEAD (right after the brand, before the
      // product type), not trail behind a keyword-stuffed paraphrase. A design name buried mid-title
      // means a longer paraphrase of the SAME slogan ("See You Later Alligator" for a "Later Gator"
      // design) grabbed the lead. Force it to the front via the retry loop.
      const bIdx = brandName ? lc.indexOf(brandName.toLowerCase()) : -1
      const afterBrand = bIdx >= 0 ? bIdx + brandName.length : 0
      if (dnIdx > afterBrand + 8) {
        problems.push(`🔴 DESIGN NAME NOT LEADING: "${designName}" must come FIRST, right after the brand — it currently sits deeper in the title behind other words. Move "${designName}" to the front (after the brand) and REMOVE any longer paraphrase of the same slogan.`)
      }
    }
  }

  // Gender words belong ONCE. "Cool Mens Shirts for Men and Women" repeats "men" (Mens + Men) — the
  // seller flagged this. "Men and Women" already names the audience once each; a count > 1 means a
  // redundant gender adjective is stacked on top of the audience phrase. (counts is normalized so
  // "Mens"→"men", "Womens"→"women".)
  for (const g of ['men', 'women']) {
    if ((counts.get(g) ?? 0) > 1) {
      problems.push(`The gender word "${g}" appears more than once (e.g. "Mens Shirts ... for Men and Women") — state the audience ONCE as "for Men and Women" and drop the redundant earlier "${g}'s/${g}s".`)
    }
  }

  // The blank/garment brand attribute (e.g. "comfort colors") is a strategic ranking term
  // the seller wants in the title alongside the money keyword — enforce its presence.
  if (attributePin) {
    const attrWords = attributePin.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !MINOR_WORDS.has(w))
    if (attrWords.length > 0 && !attrWords.every((w) => words.has(w))) {
      problems.push(`Title MUST also contain the blank-brand attribute "${attributePin}" — it's a strategic ranking term.`)
    }
  }

  if (brandName && !lc.includes(brandName.toLowerCase())) problems.push(`Title must start with the brand "${brandName}".`)

  // 🚫 BRAND-NAME SAFETY (Amazon Jan 2025 policy, Q4 2025 enforcement).
  // Bare third-party brand names in titles trigger listing suppression. Only allowed with
  // 'for [Brand]' or 'compatible with [Brand]' framing. The seller's own brand is exempted
  // via ownBrandTokenSet. Critical — fail validation hard so the retry fires the fix.
  const ownBrands = ownBrandTokenSet(brandName)
  const brandsInTitle = findThirdPartyBrands(title, ownBrands)
  const bareRefs = brandsInTitle.filter((b) => !isBrandProperlyFramed(title, b))
  if (bareRefs.length > 0) {
    problems.push(`🚫 LISTING-SUPPRESSION RISK: title contains bare third-party brand name${bareRefs.length === 1 ? '' : 's'} ${bareRefs.map((b) => `"${b}"`).join(', ')} without 'for' or 'compatible with' framing. Amazon's Jan 2025 policy (Q4 2025 enforcement) suppresses listings with bare brand references. Rewrite using "for ${bareRefs[0]}" or "compatible with ${bareRefs[0]}" — never the brand name standing alone.`)
  }

  // 🚫 TRADEMARK PHRASES (sports teams / universities / media franchises). Different
  // semantics from THIRD_PARTY_BRANDS — no compatibility framing can rescue them. The
  // keyword pool already drops these (PR #77 filterRelevantKeywords backstop) but
  // this is the validator's last-mile check.
  const trademarksInTitle = findTrademarkPhrases(title)
  if (trademarksInTitle.length > 0) {
    problems.push(`🚫 TRADEMARK INFRINGEMENT RISK: title contains registered trademark phrase${trademarksInTitle.length === 1 ? '' : 's'} ${trademarksInTitle.map((t) => `"${t}"`).join(', ')}. Sports teams, universities, and media franchises (Florida Gators, Dallas Cowboys, Marvel, Star Wars, etc.) cannot be used in product titles unless you hold an official license. Remove these words entirely and rewrite the title with generic descriptors (e.g. "alligator graphic" not "Florida Gators", "superhero tee" not "Marvel").`)
  }

  // UPGRADE keyword coverage — the scorer docks 5 points when 7+ UPGRADE keywords appear
  // in bullets but NOT in the title (3 points when 3-6 miss). Fail fast in validation so the
  // existing retry loop pulls more of them into the title before we commit.
  // Threshold of 3+ missing matches the scorer's mid-tier penalty so we don't over-retry
  // on titles that are already 'good enough' (1-2 missing).
  if (upgradeKws && upgradeKws.length >= 3) {
    const missing = upgradeKws.filter((kw) => {
      const phrase = kw.toLowerCase()
      // Either the verbatim phrase or every meaningful word survives — same matching the
      // mustInclude check uses, so the validator and scorer agree on what 'present' means.
      if (lc.includes(phrase)) return false
      const phraseWords = phrase.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !MINOR_WORDS.has(w))
      return !(phraseWords.length > 0 && phraseWords.every((w) => words.has(w)))
    })
    if (missing.length >= 3) {
      // Show the first 5 missing keywords — enough for the retry prompt to act on without
      // overwhelming the agent.
      const sample = missing.slice(0, 5).map((k) => `"${k}"`).join(', ')
      problems.push(`Title is missing ${missing.length} top UPGRADE keywords that appear in your bullets — Amazon weights title keywords 3-5× more than bullets. Pull at least ${Math.max(0, missing.length - 2)} of these in: ${sample}.`)
    }
  }

  return problems
}

/**
 * Validate the generated bullets against scorer-equivalent rules + Amazon brand-safety.
 * Mirrors the validateTitle contract: returns problems for the bullets-agent retry loop to
 * resolve. Each check matches a real penalty in scoreListingContent() so passing here means
 * passing the scorer too — the "follow the recommendation → perfect score" promise extends
 * to bullets the same way PR #73 extended it to title.
 *
 * Checks (all match scoreListingContent.ts:654+):
 *   - length < 100 chars per bullet (scorer -5 per short bullet, capped at -15)
 *   - bare third-party brand in any bullet (Amazon Jan 2025 listing-suppression risk —
 *     parallel to validateTitle's check; PR #74 closed it for title, this closes it for bullets)
 *
 * NOT checked (deleted 2026-08-10): opportunity-keyword coverage. Bullets carry NO coverage duty
 * (SELLER_PROFILE §5) and the scorer stopped docking for it on 2026-08-04, so the `opportunityKws`
 * parameter was removed rather than left ignored — a parameter callers still populate but nothing
 * reads is a dead wire, and this session cost months to two of those.
 */
export function validateBullets(
  bullets: string[],
  brandName: string,
  /** Distinct capacity tokens across the family (e.g. ['32GB','64GB','128GB']). Non-empty
   *  means broadcast bullets must NOT hardcode any specific capacity — they ship to every
   *  child. Live-verified bug at B0GCF11RKL: bullets 2 and 3 hardcoded "128 GB" though the
   *  family has 32/64/128 SKUs. The agent prompt already forbids this — validation
   *  enforces it through the retry loop. */
  capacityFamily: string[] = [],
): string[] {
  const problems: string[] = []
  if (bullets.length === 0) {
    problems.push('No bullets generated.')
    return problems
  }

  // Length: bullets <BULLET_MIN_CHARS get docked by the validator's problem message (drives runBulletsAgent
  // retry prompt). Raised from 100→150 (2026-07-21) — see BULLET_MIN_CHARS declaration.
  const shortBullets = bullets
    .map((b, i) => ({ i, b, len: b.length }))
    .filter((x) => x.len < BULLET_MIN_CHARS)
  if (shortBullets.length > 0) {
    const names = shortBullets.map((x) => `bullet ${x.i + 1} (${x.len} chars)`).join(', ')
    problems.push(`${shortBullets.length} bullet${shortBullets.length === 1 ? '' : 's'} under ${BULLET_MIN_CHARS} chars: ${names}. Expand each to ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} chars with a "so that" benefit, a compatible-device example, and a long-tail keyword.`)
  }

  // CAPS-hook check (live-verified bug at B0G884ZJ27: bullets opened with sentence prose
  // "Made from soft, breathable..." instead of "PREMIUM FABRIC - Made from..."). Pattern:
  // 2-4 ALL-CAPS tokens (length ≥2 each, hyphens/digits allowed) followed by " - "/" – "/" — ".
  const capsHookRe = /^(?:[A-Z][A-Z0-9-]+(?:\s+[A-Z][A-Z0-9-]+){0,3})\s*[-–—]\s+/
  const noHook: { i: number }[] = []
  for (let i = 0; i < bullets.length; i++) {
    if (!capsHookRe.test(bullets[i].trim())) noHook.push({ i })
  }
  if (noHook.length > 0) {
    const names = noHook.map((x) => `bullet ${x.i + 1}`).join(', ')
    problems.push(`${noHook.length} bullet${noHook.length === 1 ? '' : 's'} missing the CAPS benefit hook (${names}). Each bullet must start with a 2-3 word ALL-CAPS benefit followed by " - " then the explanation. Example: "HIGH-SPEED PERFORMANCE - Class 10 UHS-I technology ensures fast read/write speeds...".`)
  }

  // Awkward-forced-keyword check (live-verified bug at B0GCF11RKL: "CRITICAL UPGRADE -
  // Upgrade your storage..." — the agent literalized PR #73's MANDATORY #3 prompt term as
  // the benefit hook). CAPS hooks should be BENEFIT phrases, not pipeline action-type
  // labels that name the SEO mechanic itself.
  const FORBIDDEN_HOOK_WORDS = new Set(['CRITICAL', 'UPGRADE', 'REINFORCE', 'DEFENDED', 'KEYWORD', 'KEYWORDS', 'SEO', 'OPPORTUNITY'])
  const awkwardHooks: { i: number; forbidden: string[] }[] = []
  for (let i = 0; i < bullets.length; i++) {
    const m = bullets[i].trim().match(capsHookRe)
    if (!m) continue
    const hookOnly = m[0].replace(/\s*[-–—]\s+$/, '').trim()
    const forbidden = hookOnly.split(/\s+/).filter((w) => FORBIDDEN_HOOK_WORDS.has(w))
    if (forbidden.length > 0) awkwardHooks.push({ i, forbidden })
  }
  if (awkwardHooks.length > 0) {
    const detail = awkwardHooks.map((x) => `bullet ${x.i + 1} ("${x.forbidden.join('/')}" in hook)`).join(', ')
    problems.push(`${awkwardHooks.length} bullet${awkwardHooks.length === 1 ? '' : 's'} have a CAPS hook that literalizes a pipeline action-type label (${detail}). Hooks must name a real BENEFIT shoppers care about ("HIGH-SPEED PERFORMANCE", "DURABLE DESIGN", "WIDE COMPATIBILITY") — never "CRITICAL", "UPGRADE", "KEYWORD" or other SEO mechanic words. Rewrite the hook with a benefit phrase that fits the bullet body.`)
  }

  // 🚫 CAPACITY-FAMILY check (live-verified bug at B0GCF11RKL: bullets 2 and 3 hardcoded
  // "128 GB" though the family spans 32GB/64GB/128GB — broadcast bullets ship to every
  // child, so 32GB shoppers would see "this 128 GB SD card").
  if (capacityFamily.length >= 2) {
    const capacityRe = /\b\d{1,4}\s?(?:GB|TB|MB)\b/gi
    const hardcoded: { i: number; matches: string[] }[] = []
    for (let i = 0; i < bullets.length; i++) {
      const ms = bullets[i].match(capacityRe)
      if (ms && ms.length > 0) hardcoded.push({ i, matches: [...new Set(ms.map((m) => m.replace(/\s+/g, ' ').toUpperCase()))] })
    }
    if (hardcoded.length > 0) {
      const detail = hardcoded.map((x) => `bullet ${x.i + 1} ("${x.matches.join(', ')}")`).join('; ')
      problems.push(`🚫 CAPACITY-FAMILY VIOLATION: ${hardcoded.length} bullet${hardcoded.length === 1 ? '' : 's'} hardcode a specific capacity (${detail}). This family has multiple capacities (${capacityFamily.join(', ')}) and bullets are SHARED across all variants — saying "128GB" in a bullet ships to your 32GB and 64GB SKUs and misleads shoppers. Use capacity-agnostic phrasing: "ample capacity", "high-capacity storage", "available in multiple sizes". Each variant's specific capacity already lives in its TITLE.`)
    }
  }

  // 🚫 BRAND-NAME SAFETY — same rule that PR #74 enforced for title. Each bullet checked
  // independently because a bare brand reference in ANY bullet is a listing-suppression risk.
  const ownBrands = ownBrandTokenSet(brandName)
  const bareByBullet: { i: number; bare: string[] }[] = []
  for (let i = 0; i < bullets.length; i++) {
    const found = findThirdPartyBrands(bullets[i], ownBrands)
    const bare = found.filter((b) => !isBrandProperlyFramed(bullets[i], b))
    if (bare.length > 0) bareByBullet.push({ i, bare })
  }
  if (bareByBullet.length > 0) {
    const detail = bareByBullet
      .map(({ i, bare }) => `bullet ${i + 1}: ${bare.map((b) => `"${b}"`).join(', ')}`)
      .join('; ')
    problems.push(`🚫 LISTING-SUPPRESSION RISK: bare third-party brand name(s) in ${detail}. Amazon's Jan 2025 policy requires 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]' framing — never bare. Rewrite those bullets to wrap each brand mention in compatibility language.`)
  }

  // 🚫 TRADEMARK PHRASES per bullet (sports teams / universities / media franchises).
  const tmByBullet: { i: number; tm: string[] }[] = []
  for (let i = 0; i < bullets.length; i++) {
    const tms = findTrademarkPhrases(bullets[i])
    if (tms.length > 0) tmByBullet.push({ i, tm: tms })
  }
  if (tmByBullet.length > 0) {
    const detail = tmByBullet
      .map(({ i, tm }) => `bullet ${i + 1}: ${tm.map((t) => `"${t}"`).join(', ')}`)
      .join('; ')
    problems.push(`🚫 TRADEMARK INFRINGEMENT RISK: ${detail}. Sports teams, universities, and media franchises cannot be used in customer-facing copy unless you hold an official license. Remove these phrases entirely and rewrite with generic descriptors.`)
  }

  /* OPPORTUNITY-KEYWORD REWRITE GATE — DELETED (PO ruling 2026-08-10, "use best recommendation for
   * higher ranking"; SELLER_PROFILE §5).
   *
   * This gate forced a bullets REWRITE whenever 2+ CRITICAL/UPGRADE keywords were absent from the
   * bullets. It existed to mirror a scorer dock — and that dock was DELETED on 2026-08-04
   * (syncListingContent.ts, "OPPORTUNITY-KEYWORD COVERAGE DOCK — DELETED"), which left this half an
   * ORPHAN: the generator kept bending shopper-facing prose to satisfy a penalty that no longer
   * exists. The comment here still warned about a "9/18 divergence" that its own counterpart had
   * already cured from the other side.
   *
   * It is also wrong on the merits, which is why it goes rather than gets re-tuned. Coverage is a
   * BINARY GATE and it counts ANYWHERE (§5, "coverage anywhere counts everywhere") — a keyword in the
   * backend is indexed exactly as well as one in a bullet. So forcing it into bullets buys ZERO extra
   * indexing while spending the one thing bullets are actually for: prose that converts. Conversion
   * and CTR are the levers that move rank once a listing is in the candidate set; keyword presence is
   * the gate, not the ranking. Trading the former for the latter is a strictly losing swap.
   *
   * Coverage shortfalls still dock — on the KEYWORD dimension, once, where they belong
   * (syncListingContent criticalCount, -3/-5/-8), and its message correctly offers backend placement.
   * The deterministic bullet floor is unchanged and stays DESIGN-NAME ONLY (`bulletCoverageFloor`),
   * which is the one thing bullets genuinely must carry.
   */

  // PHRASE OVERUSE — the prompt forbids repeating a blend-brand/material >2× but nothing ENFORCED it,
  // so "comfort colors" stuffed 7× across 5 bullets shipped (PO report). Trigger the rewrite at >=3.
  const joinedBullets = bullets.join('  \n  ').toLowerCase()
  const OVERUSE_PHRASES = ['comfort colors', 'comfort color', 'bella canvas', 'gildan', 'next level', 'ring spun', 'ring-spun', 'garment dyed', 'garment-dyed']
  const overused: string[] = []
  for (const phrase of OVERUSE_PHRASES) {
    const re = new RegExp(`\\b${phrase.replace(/[-\s]+/g, '[-\\s]?')}\\b`, 'gi')
    const n = (joinedBullets.match(re) || []).length
    if (n >= 3) overused.push(`"${phrase}" (${n}×)`)
  }
  if (overused.length > 0) {
    problems.push(`Phrase overuse — these read as keyword stuffing (Amazon allows at most 2 of any single blend-brand/material name across the 5 bullets): ${overused.join(', ')}. Keep ONE strong mention (e.g. "authentic Comfort Colors tee"), drop the rest, and vary the wording with benefits/synonyms.`)
  }
  // MISSPELLINGS must never reach customer-facing bullets (PO saw "confort colors"). Shopper
  // misspellings belong only in BACKEND search terms. \bconfort\b never matches "comfort".
  const MISSPELLINGS = [/\bconfort\b/gi, /\btshrit\b/gi, /\bshrit\b/gi, /\bcoton\b/gi]
  const typos = new Set<string>()
  for (const re of MISSPELLINGS) { const m = joinedBullets.match(re); if (m) m.forEach((x) => typos.add(x.trim())) }
  if (typos.size > 0) {
    problems.push(`Customer-facing MISSPELLING in the bullets: ${[...typos].map((t) => `"${t}"`).join(', ')}. Spell every word correctly — misspellings damage trust and belong only in backend search terms, never in bullets.`)
  }

  return problems
}

/**
 * Validate the generated description. Mirrors validateBullets: returns problems for the
 * description-agent retry loop. Checks match scoreListingContent.ts:724+ penalties.
 *
 * Checks:
 *   - plain text < 200 chars (scorer -4) — description below the meaningful-indexing floor
 *   - bare third-party brand (Amazon Jan 2025 listing-suppression risk — parallel to title)
 *
 * Note: the scorer's "<3 shared title keywords" penalty isn't enforced here because the
 * agent already gets the title as input and is told to reinforce its themes. If that gap
 * shows up in practice we can add a check that takes title tokens as a param.
 */
export function validateDescription(
  description: string,
  brandName: string,
  /** Distinct capacity tokens across the family. When ≥2, the SHARED description must not
   *  hardcode a specific GB/TB/MB (PR #90 — live B0GCF11RKL shipped "THE CEO 128GB..." in a
   *  32/64/128 family). Mirrors the bullet capacity check from #76. */
  capacityFamily: string[] = [],
  /** Apparel gets a HARD gate that the description must include a <ul> feature list. Task #68 —
   *  B0FRYMM56C shipped flat paragraphs with no bulleted list, docking description_score. */
  requireBulletList: boolean = false,
): string[] {
  const problems: string[] = []
  // Strip HTML the same way the scorer does (loose tag strip — agent returns <p>/<ul>/<li>).
  const plain = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (plain.length === 0) {
    problems.push('No description generated.')
    return problems
  }
  if (plain.length < 200) {
    problems.push(`Description is only ${plain.length} chars — expand to 800-2000 chars with use cases, target audience, technical specs, and long-tail keywords. Amazon indexes the full text.`)
  }

  // 🚫 LENGTH FLOOR — apparel target is 900-980 visible chars (agent prompt line ~3434). Under 900 =
  // under-filled — retry to expand toward the target. B0FRYMM56C shipped 869 chars (~31 short). Task #68.
  if (requireBulletList && plain.length >= 200 && plain.length < 900) {
    problems.push(`🚫 LENGTH SHORT: description has only ${plain.length} visible chars — target is 900-980. Expand toward 950 by adding one more sentence to the opening paragraph OR one more <li> feature, or a fuller closing use-case line. Do NOT stuff keywords — add REAL SUBSTANCE (fabric weight/hand, fit specifics, styling ideas, gift-suggestion, care).`)
  }

  // 🚫 STRUCTURE — apparel descriptions must include a bulleted <ul> feature list. Flat prose docks
  // description_score (B0FRYMM56C shipped as flat <p>-only). Task #68.
  if (requireBulletList && !/<(?:ul|ol)\b[^>]*>[\s\S]*<li\b[^>]*>[\s\S]*<\/li>[\s\S]*<\/(?:ul|ol)>/i.test(description)) {
    problems.push('🚫 STRUCTURE VIOLATION: description is flat prose with no bulleted feature list. Rewrite with the required structure: opening hook (<p><b>…</b> …</p>) → <ul> with 2-4 <li> items covering key features (fabric/fit/design theme/care) → closing use-cases/audience line. A description without a <ul><li>…</li></ul> block is REJECTED — Amazon apparel descriptions read as scannable feature lists.')
  }

  // 🚫 BOLD MISSING — the prompt asks for <p>, <b>, <ul>, <li>. B0FRYMM56C shipped with ZERO <b> tags.
  // At least one <b> lead-in (e.g. the opening hook) gives the description shopper-scannable formatting.
  if (requireBulletList && !/<b\b[^>]*>[\s\S]*<\/b>/i.test(description) && !/<strong\b[^>]*>[\s\S]*<\/strong>/i.test(description)) {
    problems.push('🚫 FORMATTING: description has no <b>…</b> (or <strong>…</strong>) emphasis. Amazon renders <b> — use it at least once to bold the opening hook (e.g. "<p><b>Golf widow uniform</b> for the wife whose husband is always at the course.</p>") so the description scans, not blocks.')
  }

  // 🚫 CAPACITY-FAMILY check (PR #90) — same rule the bullets validator enforces.
  if (capacityFamily.length >= 2) {
    const caps = [...new Set((plain.match(/\b\d{1,4}\s?(?:GB|TB|MB)\b/gi) || []).map((m) => m.replace(/\s+/g, ' ').toUpperCase()))]
    if (caps.length > 0) {
      problems.push(`🚫 CAPACITY-FAMILY VIOLATION: the description hardcodes ${caps.join(', ')} but this family spans ${capacityFamily.join(', ')}. The description is SHARED across all variants — a specific GB misleads the other-capacity SKUs. Use capacity-agnostic phrasing ("ample capacity", "high-capacity storage", "available in multiple sizes").`)
    }
  }

  const ownBrands = ownBrandTokenSet(brandName)
  const bare = findThirdPartyBrands(plain, ownBrands).filter((b) => !isBrandProperlyFramed(plain, b))
  if (bare.length > 0) {
    problems.push(`🚫 LISTING-SUPPRESSION RISK: description contains bare third-party brand name(s) ${bare.map((b) => `"${b}"`).join(', ')} without 'for' or 'compatible with' framing. Rewrite every brand mention as 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]'.`)
  }

  // 🚫 TRADEMARK PHRASES in description.
  const tmInDesc = findTrademarkPhrases(plain)
  if (tmInDesc.length > 0) {
    problems.push(`🚫 TRADEMARK INFRINGEMENT RISK: description contains registered trademark phrase${tmInDesc.length === 1 ? '' : 's'} ${tmInDesc.map((t) => `"${t}"`).join(', ')}. Sports teams, universities, and media franchises cannot be used in customer-facing copy unless you hold an official license. Rewrite using generic descriptors.`)
  }

  return problems
}

/** Numeric quality score for an HTML description (task #70). Codifies the quality bar we've learned
 *  across the session's fixes so the description retry loop can score-gate, keep the best-scored
 *  version, and re-prompt with SPECIFIC critiques rather than the pass/fail binary of
 *  validateDescription. Runs alongside validateDescription (which owns brand/trademark/capacity hard
 *  gates); scoreDescription owns the CONTENT/FORMATTING gates. Returns { score: 0-100, critiques[] }. */
export interface DescriptionScoringCtx {
  widow?: { isWidowFormat: boolean; hobby: string; spouseWord: string }
  /** Blank's fit (e.g. 'relaxed'). When 'relaxed', "oversized"/"boxy" claims dock. Optional. */
  fit?: string
}
export function scoreDescription(html: string, ctx: DescriptionScoringCtx = {}): { score: number; critiques: string[] } {
  const critiques: string[] = []
  let score = 100
  const plain = (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const len = plain.length

  // ── LENGTH /25 — target 900-980 visible chars ─────────────────────────────────
  if (len >= 900 && len <= 980) {
    // full marks
  } else if (len >= 800 && len < 900) {
    // -17, NOT -10 (2026-07-14): at -10 an otherwise-clean 862-char draft scored 90 ≥ the 85
    // threshold, so the critic loop STOPPED without retrying and shipped short (live B0FRYMM56C).
    // Any under-900 length must land BELOW threshold so the loop keeps pushing toward 950.
    score -= 17
    critiques.push(`LENGTH SHORT (${len}/900 min): expand toward ~950 chars by adding one substantive sentence to the opening paragraph OR one more <li> feature (fabric weight/hand/care/styling) — NEVER by stuffing keywords.`)
  } else if (len > 980 && len <= 1050) {
    score -= 10
    critiques.push(`LENGTH OVER (${len}/980 max): trim ${len - 980}+ chars back to the 900-980 window — cut the most generic sentence.`)
  } else if (len >= 700 && len < 800) {
    score -= 17
    critiques.push(`LENGTH TOO SHORT (${len} — need 900-980): expand by ~150+ chars with REAL substance (design theme, fabric feel, fit specifics, gift-suggestion, care).`)
  } else if (len > 1050) {
    score -= 17
    critiques.push(`LENGTH FAR OVER (${len}, need 900-980): cut ~${len - 950} chars.`)
  } else {
    score -= 25
    critiques.push(`LENGTH WRONG (${len}, need 900-980 visible chars).`)
  }

  // ── STRUCTURE /20 — must include <ul>…<li>…</li>…</ul> ────────────────────────
  const hasUl = /<(?:ul|ol)\b[^>]*>[\s\S]*<li\b[^>]*>[\s\S]*<\/li>[\s\S]*<\/(?:ul|ol)>/i.test(html)
  if (!hasUl) {
    score -= 20
    critiques.push('NO <ul> LIST: add a <ul>…<li>…</li>…</ul> feature list (2-4 <li> items covering fabric, fit, design theme, care/styling).')
  }

  // ── BOLD /15 — must include at least one <b> or <strong> ──────────────────────
  const hasBold = /<b\b[^>]*>[\s\S]*<\/b>/i.test(html) || /<strong\b[^>]*>[\s\S]*<\/strong>/i.test(html)
  if (!hasBold) {
    score -= 15
    critiques.push('NO <b> EMPHASIS: bold the opening hook or a lead-in phrase with <b>…</b> so the description scans (e.g. "<p><b>Golf widow uniform</b> for the wife whose husband is always at the course.</p>").')
  }

  // ── JARGON LEAK /20 — trade/internal words never allowed in customer copy. High penalty by design:
  //    a single leak MUST drop below THRESHOLD (85) so any occurrence triggers a retry.
  const JARGON = /\b(?:seller(?:'s)?|blank|blanks|SKU|ASIN|listing|keyword|backend)\b/i
  const jm = plain.match(JARGON)
  if (jm) {
    score -= 20
    critiques.push(`INTERNAL JARGON: contains "${jm[0]}" — this is a trade word, NEVER use it in customer-facing copy. Remove it and describe the product directly.`)
  }

  // ── FIT CONTRADICTION /10 — Relaxed blank ≠ oversized/boxy ────────────────────
  if (ctx.fit && /relaxed/i.test(ctx.fit)) {
    const fm = plain.match(/\b(oversized|boxy|roomy\s+oversized)\b/i)
    if (fm) {
      score -= 10
      critiques.push(`FIT CONTRADICTION: describes as "${fm[0]}" but the blank is Relaxed. Say "relaxed fit" instead.`)
    }
  }

  // ── WIDOW POV /10 — the wearer is the SPOUSE, never the enthusiast ────────────
  if (ctx.widow?.isWidowFormat) {
    const h = ctx.widow.hobby
    const FORBIDDEN = new RegExp(`\\b(?:${h}[-\\s]?loving|${h}[-\\s]?lover|celebrate\\s+your\\s+${h})\\b`, 'i')
    const wm = plain.match(FORBIDDEN)
    if (wm) {
      score -= 10
      critiques.push(`WIDOW POV INVERTED: description contains "${wm[0]}" — the wearer is the SPOUSE, NOT the ${h} enthusiast. Rewrite: the wearer's PARTNER is the one who does ${h}. Correct framings: "for the ${h} widow", "for wives whose husbands are always ${h === 'golf' ? 'at the course' : `doing ${h}`}", "gift for a ${h} widow".`)
    }
  }

  // ── DANGLING SENTENCE /5 — never end on a conjunction/preposition ─────────────
  // e.g. "…styling with jeans or.</li>", "…features a relaxed and.</p>"
  if (/\b(?:and|or|with|for|to|of|plus)\.\s*(?:<\/p>|<\/li>|$)/i.test(html)) {
    score -= 5
    critiques.push('DANGLING SENTENCE: a sentence ends on a stray conjunction/preposition (and/or/with/for/to/of/plus). Finish the thought.')
  }

  return { score: Math.max(0, score), critiques }
}

/** Deterministic post-fill scorer for a BACKEND search-term CORE string (element E, 2026-07-17).
 *  Sits beside scoreDescription for the same reason (the description self-heal pattern, #388): a
 *  deterministic quality bar the generator's loop can re-prompt against with SPECIFIC problems,
 *  instead of shipping the first guess. ADVISORY ONLY — it NEVER throws and nothing hard-gates a
 *  persist on it: the <190-byte HARD floor stays in backendOutputProblems (untouched) and
 *  fillBackendToBudget's 244 early-return is untouched. A 190-219-byte result is a critique here,
 *  never an abort.
 *  GREEN = (bytes in [220,250] AND clean) OR (bytes in [200,220) AND clean AND poolExhausted).
 *  clean = zero off-niche tokens (isOffNicheKeyword), zero foreign tokens (isForeignKeyword), zero
 *  third-party-brand tokens, zero title-echo tokens (ctx.excludeWords — pass it with the DELIBERATE
 *  placements removed: design tokens and the men/women audience guarantee, which are forced into the
 *  core on purpose). poolExhausted = the remaining candidate pool supplies no further clean addable
 *  token — so a genuinely thin catalog sitting at 200-219 clean bytes is honestly green, per the
 *  "don't false-fail the thin-catalog majority" rule backendOutputProblems already encodes.
 *  Problem strings are STABLE: byte-band problems start with "bytes " so callers can separate DIRT
 *  from UNDER-FILL when comparing candidates (keep-best must never adopt a dirtier string). */
export interface BackendScoringCtx {
  /** Listing haystack for isOffNicheKeyword's own-brand / activewear-listing / own-cut guards. */
  nicheContext?: string
  /** Already-indexed tokens (live title + bullets + brand + colors, normalized) — their presence in
   *  backend is pure echo/wasted bytes. Deliberate placements must be removed by the caller. */
  excludeWords?: Set<string>
  /** Own-brand tokens — exempt from the third-party-brand check. */
  ownBrands?: Set<string>
  /** Normalized candidate tokens that could still be appended (pool + council output) — the
   *  poolExhausted probe. Empty/absent = nothing left to add = exhausted. */
  remainingCandidates?: string[]
  /** True when this candidate token could still legitimately land AND is clean (the caller's fill
   *  filters + the same off-niche/foreign nets this scorer applies). */
  isAddableCleanToken?: (w: string) => boolean
}
export function scoreBackend(str: string, ctx: BackendScoringCtx = {}): { green: boolean; problems: string[]; poolExhausted: boolean } {
  const problems: string[] = []
  const s = (str || '').trim()
  const bytes = getByteLength(s)
  const toks = s.toLowerCase().split(/\s+/).filter(Boolean)
  const offNiche: string[] = []
  const foreign: string[] = []
  const brands3p: string[] = []
  const echo: string[] = []
  for (const t of toks) {
    if (ctx.ownBrands?.has(t)) continue                                   // own brand is never "dirt"
    if (isForeignKeyword(t)) { foreign.push(t); continue }
    if (isOffNicheKeyword(t, { context: ctx.nicheContext })) { offNiche.push(t); continue }
    if (THIRD_PARTY_BRANDS.has(t)) { brands3p.push(t); continue }
    if (ctx.excludeWords?.has(t)) echo.push(t)
  }
  const uniq = (a: string[]) => [...new Set(a)].slice(0, 6).join(' ')
  if (offNiche.length) problems.push(`off-niche token(s) this copy must never carry: ${uniq(offNiche)}`)
  if (foreign.length) problems.push(`foreign-language token(s): ${uniq(foreign)}`)
  if (brands3p.length) problems.push(`third-party brand token(s) (trademark risk): ${uniq(brands3p)}`)
  if (echo.length) problems.push(`title-echo token(s) (already indexed — wasted bytes): ${uniq(echo)}`)
  const clean = problems.length === 0
  // poolExhausted BEFORE the byte-band advisory (green's 200-220 band depends on it). Tokens already
  // in the string never count as "further" candidates.
  const have = new Set(toks)
  const poolExhausted = !(ctx.remainingCandidates ?? []).some((w) => w && !have.has(w) && (ctx.isAddableCleanToken ? ctx.isAddableCleanToken(w) : true))
  if (bytes > 250) problems.push(`bytes over cap: ${bytes}/250`)
  else if (bytes < 200) problems.push(`bytes under band: ${bytes} (target 220-250)`)
  else if (bytes < 220 && !poolExhausted) problems.push(`bytes under band: ${bytes} (target 220-250; clean pool candidates remain unplaced)`)
  const green = clean && ((bytes >= 220 && bytes <= 250) || (bytes >= 200 && bytes < 220 && poolExhausted))
  return { green, problems, poolExhausted }
}

// ─── Stage 0 — candidate preparation (code only) ───────────────────────────────

interface TitleCandidate { keyword: string; coverageGapScore: number; role: 'keyphrase' | 'descriptive' | 'audience'; organicRank?: number | null }

function extractProductNameTokens(repTitle: string | null): string[] {
  return (repTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !GENERIC_APPAREL.has(w))
    .slice(0, 3)
}

export function selectTitleCandidates(analysis: AnalyzedKeyword[], brandName: string, repTitle: string | null, season: SeasonPolicy, outcomeSignals?: Record<string, OutcomeSignal>, targets: TargetPolicy = INERT_TARGET_POLICY): TitleCandidate[] {
  // KEYWORD_TARGET_SET (#143): the title draws from the ranking targets only. Defaulted to the
  // inert policy so any caller that does not pass one is byte-identical to today.
  analysis = targets.keep(analysis)
  const brandTokens = brandName.toLowerCase().split(/\s+/).filter(Boolean)
  const productTokens = extractProductNameTokens(repTitle)

  // Outcome-loop tiebreak (#89): among near-equal opportunity, prefer a keyword whose SQP share is RISING
  // (reinforce what's working) and de-prioritize one that's flat-despite-a-content-change (its ceiling is now
  // non-content — reviews/price/velocity, not more copy). SECONDARY to coverageGapScore: it only reorders
  // TIES, never across opportunity tiers, never drops a keyword. Strict no-op when outcomeSignals is empty.
  const riseRank = (kw: string): number => {
    const s = outcomeSignals?.[kw.toLowerCase()]
    if (!s) return 0
    if (s.direction === 'rose') return 1
    if (s.nonContentBottleneck) return -1
    return 0
  }

  // Title-Density tiebreak (G3, import-only metric — H10 Cerebro): among near-equal opportunity,
  // prefer a keyword FEW page-1 competitors carry in their TITLE (TD 0-2 with real volume = an
  // open lane the 75-char title can own; "college essentials" 33k/mo had TD=0). Same contract as
  // the outcome tiebreak: reorders TIES only, never across opportunity tiers, no-op when null.
  const tdRank = (k: AnalyzedKeyword): number =>
    k.titleDensity != null && k.titleDensity <= 2 && k.searchVolume >= 500 ? 1 : 0

  // Striking-distance tiebreak (rank tracker, #179): we rank #11-30 for the keyword — page 2 /
  // bottom of page 1. Title placement (Amazon's heaviest content field) moves THESE fastest;
  // a keyword we rank #200 for needs more than a title spot, and #1-10 is already won. Same
  // conservative contract as the other tiebreaks: ties only, no-op when rank is unmeasured.
  const strikeRank = (k: AnalyzedKeyword): number =>
    k.organicRank != null && k.organicRank >= 11 && k.organicRank <= 30 ? 1 : 0

  // Ease-aware tiebreak (PO 2026-08-08 3-factor rule: market opportunity + ease + volume): among
  // near-equal coverage gaps, prefer a keyword whose NATIVE marketOpportunity (migration 055:
  // demand-gated 0-10, coverage-INDEPENDENT — never the gap composite, never raw js_ease_of_ranking)
  // says the market is winnable. ≥6 is the JS niche-score "strong" band, and the demand gate inside
  // poolOpportunityScore is the junk-long-tail guard (near-zero volume can never reach 6).
  // Acceptance intent (B0FKKN8XKV): "cute christian shirts for women" (3,749/mo, ease 100, opp 6.2)
  // wins its composite tie and qualifies as a title candidate instead of being buried by volume-
  // correlated ordering. Same contract as tdRank/strikeRank: reorders TIES only — the PRIMARY key
  // stays coverageGapScore ("placement decisions SHOULD prefer gaps" is locked doctrine, cf. the
  // backendPool comment in the fill), so CRITICAL money keywords keep first claim; strict no-op
  // when native data is absent (null/undefined ⇒ 0: every SQP/import pool sorts byte-identically).
  const mkoRank = (k: AnalyzedKeyword): number =>
    k.marketOpportunity != null && k.marketOpportunity >= 6 ? 1 : 0

  season.diff('title-candidates', analysis.map((k) => k.keyword))
  const eligible = analysis
    .filter((k) => ['CRITICAL', 'UPGRADE', 'DEFENDED', 'REINFORCE'].includes(k.actionType))
    .filter((k) => !season.isOffSeason(k.keyword))
    .sort((a, b) => (b.coverageGapScore - a.coverageGapScore) || (mkoRank(b) - mkoRank(a)) || (tdRank(b) - tdRank(a)) || (strikeRank(b) - strikeRank(a)) || (riseRank(b.keyword) - riseRank(a.keyword)))

  // Dedup overlapping keyphrases so the TITLE gets DIVERSE terms — not five ways to say the same
  // product. The old "keep the higher-opportunity one at >=60% overlap" rule caused synonym + niche
  // stuffing ("Post It Notes ... Sticky Note ... CEO Sticky Notes ... Bible Study Sticky Notes"):
  //   • single-shared-noun pairs (post it notes / sticky notes = 1/2 = 0.5) slipped under the 0.6 bar,
  //   • and niche long-tails out-score the broad term, so the niche won the dedup.
  // Fix: lower the bar to 0.5, and on overlap keep the BROADER (fewer-word) term — a general
  // "sticky notes" beats "bible study sticky notes". Dropped phrases still flow to the BACKEND
  // keyword pool, so their ranking value isn't lost; they just don't crowd or narrow the title.
  const deduped: AnalyzedKeyword[] = []
  for (const k of eligible) {
    const idx = deduped.findIndex((d) => wordOverlapRatio(d.keyword, k.keyword) >= 0.5)
    if (idx === -1) deduped.push(k)
    else if (k.keyword.split(/\s+/).length < deduped[idx].keyword.split(/\s+/).length) deduped[idx] = k
  }

  const roleOf = (kw: string): TitleCandidate['role'] => {
    const lc = kw.toLowerCase()
    const kwWords = new Set(lc.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))
    if (brandTokens.some((t) => lc.includes(t)) || productTokens.some((t) => kwWords.has(t))) return 'keyphrase'
    if (ADULT_AUDIENCE.some((t) => kwWords.has(t)) || /\bfor (men|women|kids)\b/.test(lc)) return 'audience'
    return 'descriptive'
  }

  return deduped.slice(0, 7).map((k) => ({ keyword: k.keyword, coverageGapScore: k.coverageGapScore, role: roleOf(k.keyword), organicRank: k.organicRank ?? null }))
}

/** Deterministic backstop for NON-APPAREL titles: gpt-4.1-mini keeps stacking product-type synonyms
 *  on keyword-heavy listings ("Post It Notes ... Sticky Note ... CEO Sticky Notes ... Small Notes")
 *  despite the prompt (#123) and candidate de-dup (#124). This collapses them: keep at most 2
 *  DISTINCT phrases that END in the dominant product noun (the rest are redundant ways to name the
 *  same product), preserving the brand prefix and the trailing remainder. Amazon indexes the title as
 *  a bag of words, so a mechanical trim is safe. Returns the title unchanged when no product noun
 *  repeats more than twice. */
function collapseProductPhrases(title: string): string {
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')
  const words = title.split(/\s+/).filter(Boolean)
  const counts: Record<string, number> = {}
  for (const w of words) { const n = norm(w); if (n.length >= 3 && !MINOR_WORDS.has(n)) counts[n] = (counts[n] || 0) + 1 }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  if (!top || top[1] <= 2) return title
  const noun = top[0]
  // Split into chunks each ENDING at the dominant noun; words after the last noun are the tail.
  const chunks: string[][] = []
  let cur: string[] = []
  for (const w of words) { cur.push(w); if (norm(w) === noun) { chunks.push(cur); cur = [] } }
  const tail = cur
  // Keep the first 2 DISTINCT chunks (by significant-word signature); drop duplicates / extras.
  const kept: string[][] = []
  const seen = new Set<string>()
  for (const ch of chunks) {
    const sig = ch.map(norm).filter((n) => n.length >= 3 && !MINOR_WORDS.has(n)).sort().join(' ')
    if (seen.has(sig) || kept.length >= 2) continue
    seen.add(sig); kept.push(ch)
  }
  return [...kept.flat(), ...tail].join(' ').replace(/\s{2,}/g, ' ').trim()
}

/** Deterministic audience de-dup. gpt-4.1-mini stacks a redundant gendered audience on top of the
 *  inclusive one — "...Shirts for Women for Men and Women" ("Women" twice), or the possessive
 *  "Cool Mens Shirts for Men and Women" ("Men" twice). When the inclusive "for Men and Women" is
 *  present, it is the ONLY audience the title needs, so we keep that one phrase and strip every
 *  other gender mention (standalone "for Men"/"for Women", possessive "Mens"/"Men's", and any
 *  duplicate inclusive). Amazon indexes the title as a bag of words, so dropping a redundant repeat
 *  loses no ranking. Verified live on B0G884ZJ27 where the validator-driven retry couldn't clear it. */
/** Gender-variant token normalizer for the title FILL dedup sets: "mens"/"womens" must count as
 *  the same token as "men"/"women", or a gendered keyphrase gets appended on top of the audience
 *  tail (live B0DMXMH266 parent: "Mens Tees for Men" — "men" three times). bulletTokens already
 *  splits "men's" down to "men", so only the fused plurals need mapping. */
const genderNormTok = (t: string): string => (t === 'mens' ? 'men' : t === 'womens' ? 'women' : t)

/** Fill-dedup normalizer: gender variants + a light plural fold ("tees"≈"tee", "shirts"≈"shirt")
 *  so the fill never appends a near-duplicate of a word already in the title. Set-membership only —
 *  the folded form is never rendered. */
const fillNormTok = (t: string): string => {
  const g = genderNormTok(t)
  const p = g.length > 3 ? g.replace(/s$/, '') : g
  // "t-shirt" tokenizes to "shirt" (the 1-char "t" is dropped) but the fused "tshirt" survives
  // whole — fold them together or the fill ships "Graphic T-Shirts, Tshirt" (live B0DMXMH266).
  return p === 'tshirt' ? 'shirt' : p
}

/** A BARE gender word must never ship as fill content — it reads as a dangling fragment
 *  (live B0DMXMH266 child: "...Funny Fishing Humor Tee, Mens"). Audience belongs in the
 *  "for X" tail; gendered PHRASES ("Mens Fishing Gifts") remain fine. */
const BARE_GENDER_RE = /^(?:m[ae]ns?|wom[ae]ns?|ladies)$/i

/** Garment/cut modifiers that must never ship as a bare FILL FRAGMENT: torn from their phrase they
 *  read as an ATTRIBUTE CLAIM (", Long Sleeve" on a short-sleeve tee — review finding 2026-07-02).
 *  Whole keyphrases still pass through the full truthfulness rails; only fragments are gated here. */
const FRAG_ATTR_WORDS = new Set([
  'long', 'short', 'shorts', 'sleeve', 'sleeves', 'sleeveless', 'hoodie', 'hoodies', 'sweatshirt',
  'sweatshirts', 'pullover', 'tank', 'crewneck', 'vneck', 'neck', 'collar', 'pocket', 'zip', 'zipper', 'button',
])

/** Longest CONTIGUOUS run of novel significant words in `kw` (original order). Connectors (words
 *  with no significant tokens: "for", "of") ride along inside a run but never lead or trail it.
 *  A covered word, a word repeated within the run, or a blocked word BREAKS the run — fragments
 *  must be verbatim sub-phrases of the source keyword so they cannot recombine distant words into
 *  a new false composite ("leather boots" out of "leather-look print, boots graphic" — review
 *  finding 2026-07-02). */
function contiguousNovelRun(kw: string, covered: Set<string>, wordBlocked: (w: string) => boolean): string[] {
  const runs: string[][] = []
  let cur: string[] = []
  let curToks = new Set<string>()
  const flush = () => {
    while (cur.length && bulletTokens(cur[cur.length - 1]).length === 0) cur.pop()
    if (cur.length) runs.push(cur)
    cur = []
    curToks = new Set()
  }
  for (const w of kw.split(/\s+/).filter(Boolean)) {
    const ts = bulletTokens(w).map(fillNormTok)
    if (ts.length === 0) { if (cur.length) cur.push(w); continue }
    const ok = !wordBlocked(w) && ts.every((tt) => !covered.has(tt) && !curToks.has(tt))
    if (ok) { cur.push(w); for (const tt of ts) curToks.add(tt) } else flush()
  }
  flush()
  runs.sort((a, b) => b.join(' ').length - a.join(' ').length)
  return runs[0] ?? []
}

/** Fragment PROVENANCE gate (architecture council 2026-07-03, Layer 1 of A+B): a pass-2 fill
 *  fragment may ship ONLY if its normalized token sequence equals a phrase a human actually
 *  searches or wrote (the family keyword pool / canonical bigrams). contiguousNovelRun guarantees
 *  a fragment is a verbatim SUB-PHRASE — it cannot guarantee the sub-phrase MEANS anything once
 *  its head noun is covered: live B0GR1K3TXF, pool phrase "too many books" with "books" already
 *  covered shipped ", Too Many for Women". Allowlist-by-provenance replaces the four blocklist
 *  patches before it (an open generative class can't be enumerated). Same normalization stack as
 *  the dedup sets (bulletTokens + fillNormTok) — that symmetry is load-bearing. */
const fragPoolKey = (s: string): string => bulletTokens(s).map(fillNormTok).join(' ')
function buildFragPool(sources: string[][]): Set<string> {
  const set = new Set<string>()
  for (const arr of sources) for (const kw of arr) { const k = fragPoolKey(kw); if (k) set.add(k) }
  return set
}

/** BULLET-VARIANT DEDUPE (Layer 1 of the bullet coherence fix, council 2026-07-03). The keyword pool
 *  routinely holds the SAME product concept as permuted phrasings ("womens t shirts graphic" /
 *  "womens graphic t shirts" / "women graphic tees"). Amazon indexes the bag of words ONCE, so
 *  covering all three is zero ranking benefit AND reads as stuffing (live B0GQXSNQ6R). Collapse
 *  phrases that share the same significant-token SET (order-independent) with the garment noun
 *  unified (tee≈tshirt≈shirt≈t-shirt) — keep the first (highest-opportunity) phrasing. Stops the
 *  council from ever being ASKED to cover three phrasings of one noun. */
const bulletSigTok = (t: string): string => { const f = fillNormTok(t); return f === 'tee' ? 'shirt' : f }
const bulletVariantSig = (phrase: string): string => [...new Set(bulletTokens(phrase).map(bulletSigTok))].sort().join(' ')
function dedupeBulletVariants(phrases: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of phrases) {
    const sig = bulletVariantSig(p)
    if (sig && seen.has(sig)) continue   // a permuted/garment-synonym variant of a kept phrase — drop
    if (sig) seen.add(sig)
    out.push(p)
  }
  return out
}

/** Secondary DESIGN PHRASE capture (PO 2026-07-03, B0GR1K3TXF). A POD design title often carries a
 *  SECONDARY phrase after a SUBTITLE separator — "Floral Book Lover T-Shirt – Too Many Books Graphic
 *  Tee". The design-name resolver keeps ONE ("Floral Book Lover") and drops the rest, but "Too Many
 *  Books" is a real search phrase printed on the shirt that the PO wants ON THE PAGE ("just a keyword
 *  that needs to be added"). Split ONLY on genuine subtitle separators (– — | · : or a SPACED hyphen)
 *  — NOT commas/semicolons: POD titles are overwhelmingly comma-delimited keyword LISTS, and treating
 *  every comma-clause as a design phrase force-injected junk (review). Trailing ", adjective" noise is
 *  trimmed by taking each subtitle clause up to its first comma. */
function secondaryDesignPhrases(canonicalTitle: string | null | undefined, brandName: string): string[] {
  const t = (canonicalTitle || '').trim()
  if (!t) return []
  const parts = t.split(/\s*[–—|·:]\s*|\s+-\s+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return []   // no SUBTITLE separator → no distinct secondary clause
  const brandRe = brandName ? new RegExp(`\\b${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi') : null
  const out: string[] = []
  const seen = new Set<string>()
  for (const clause of parts.slice(1)) {   // clauses AFTER the primary design clause
    let p = (clause.split(',')[0] || '').trim()   // up to the first comma — drop trailing ", Trendy" noise
    if (brandRe) p = p.replace(brandRe, ' ')
    // Reject any clause carrying a third-party brand or a protected trademark (review: the injection
    // otherwise bypassed the tmSafe gate every other keyword passes); scrub marks that have a safe form.
    if (findThirdPartyBrands(p, ownBrandTokenSet(brandName || '')).length > 0) continue
    p = scrubTrademarks(p)
    if (findTrademarkPhrases(p).length > 0) continue
    // Strip ONLY trailing garment/audience/structural tokens (review: mid-phrase stripping gutted a
    // legit "Vintage Sunset"/"Funny Cat" design). Loop-trim from the end while the last token is boilerplate.
    p = p.replace(/[^A-Za-z0-9'\s]/g, ' ').replace(/\s{2,}/g, ' ').trim()
    const TRAIL_STRIP = /\s+(?:t[- ]?shirts?|tees?|tshirts?|shirts?|graphic|apparel|clothing|tops?|design|for|men|women|him|her|kids|adults|m[ae]n'?s|wom[ae]n'?s|unisex|gifts?)\s*$/i
    let prev = ''
    while (p && p !== prev) { prev = p; p = p.replace(TRAIL_STRIP, '').trim() }
    if (bulletTokens(p).length < 2) continue   // need ≥2 significant tokens to be a real phrase
    const sig = p.toLowerCase()
    if (seen.has(sig)) continue
    seen.add(sig); out.push(p)
  }
  return out.slice(0, 2)   // the page has finite room — at most 2 secondary phrases
}

/** Design-NICHE expansion (PO 2026-07-03, council-approved). The keyword research is self-referential
 *  — a niche design (book-lover) gets a generic "graphic tees for women" pool, and the title's
 *  design-grounding filter then strips it, leaving a stub title. This LLM call expands the ACTUAL
 *  design identity (design name + on-shirt secondary phrase + vision read) into the niche search
 *  phrases a shopper for THIS design types — "book lover shirt", "reading gift for women", "bookworm
 *  tee", "too many books shirt", "book nerd gift". Conservative + design-anchored so it grounds only
 *  real niche terms, not vibe-guesses. Returns [] on any failure (the title just stays as-is). */
async function expandDesignNiche(
  openai: OpenAI,
  designName: string,
  secondaryPhrases: string[],
  visionDesign: PipelineInput['visionDesign'],
  productType: string | null,
): Promise<string[]> {
  const anchor = [designName, ...secondaryPhrases, visionDesign?.designTheme, ...(visionDesign?.visualElements || [])].filter(Boolean).join(' | ')
  if (!anchor.trim()) return []
  // Flag ON → real family word (HAT → "hat"/"cap"); OFF → EXACT legacy expression (byte-identical).
  const ptWord = GARMENT_NOUN_ON
    ? garmentNounFor(productType, anchor).ptWord
    : (/T_SHIRT|SHIRT|TEE/i.test(productType ?? '') ? 't-shirt' : 'shirt')
  try {
    const r = await openai.chat.completions.create({
      model: process.env.NICHE_SEED_MODEL || 'gpt-4.1-mini',
      temperature: 0.3,
      max_tokens: 220,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You expand an Amazon apparel DESIGN into the real search keyphrases a shopper for THAT design would type. STRICT: every phrase must be about THIS design's theme/subject — never generic apparel ("graphic tees for women"), never a theme the design does not clearly express. 2-4 words each, lowercase, include a garment word (${ptWord}/tee/gift) where natural. Return JSON {"keywords":[...]} with 6-10 phrases.` },
        { role: 'user', content: `Design: ${anchor}\nProduct: ${ptWord}` },
      ],
    }, { timeout: 20_000, maxRetries: 0 })
    const kws = parseJsonLoose<{ keywords?: unknown }>(r.choices[0]?.message?.content || '{}').keywords
    if (!Array.isArray(kws)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const k of kws) {
      if (typeof k !== 'string') continue
      const s = scrubTrademarks(k.trim().toLowerCase())
      if (!s || findTrademarkPhrases(s).length > 0) continue
      if (bulletTokens(s).length < 2 || s.length > 40) continue
      if (seen.has(s)) continue
      seen.add(s); out.push(s)
    }
    return out.slice(0, 10)
  } catch (e) {
    console.warn('[niche-seed] design-niche expansion failed:', e instanceof Error ? e.message : e)
    return []
  }
}

/** Independent RELEVANCE JUDGE for niche seeds (review 2026-07-03). Deterministic token-overlap
 *  grounding is safe but too strict — it rejects legit expansion ("reading gift"/"bookworm tee" for a
 *  book design, which introduce new words by design). A separate judge (fresh context, filter-only
 *  task — NOT the generator grading itself) keeps on-theme expansions and rejects a hallucinated pivot
 *  ("wine lover shirt" for a book design). Returns null on any failure so the caller falls back to the
 *  conservative overlap floor — an unverified seed is never trusted. */
async function judgeNicheRelevance(openai: OpenAI, anchor: string, seeds: string[]): Promise<string[] | null> {
  if (seeds.length === 0) return []
  try {
    const r = await openai.chat.completions.create({
      model: process.env.NICHE_SEED_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      max_tokens: 220,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You are a STRICT relevance judge for Amazon apparel keywords. Given a DESIGN and candidate keyphrases, return ONLY the phrases a shopper for THAT SPECIFIC design would search. REJECT any phrase whose theme the design does not clearly express (e.g. "wine lover shirt" or "coffee tee" for a BOOK design). Return JSON {"keep":[...]} using the EXACT input strings — no additions, no rewrites.` },
        { role: 'user', content: `Design: ${anchor}\nCandidates: ${JSON.stringify(seeds)}` },
      ],
    }, { timeout: 15_000, maxRetries: 0 })
    const keep = parseJsonLoose<{ keep?: unknown }>(r.choices[0]?.message?.content || '{}').keep
    if (!Array.isArray(keep)) return null
    const valid = new Set(seeds.map((s) => s.toLowerCase()))
    return keep.filter((k): k is string => typeof k === 'string' && valid.has(k.toLowerCase()))
  } catch (e) {
    console.warn('[niche-seed] relevance judge failed:', e instanceof Error ? e.message : e)
    return null
  }
}

function dedupeAudiencePhrases(title: string): string {
  const incl = title.match(/\bfor (?:men and women|women and men)\b/i)
  if (!incl) return title
  const PH = ' AUD '
  // Protect the FIRST inclusive phrase, strip every other gender mention, then restore it.
  let t = title.replace(/\bfor (?:men and women|women and men)\b/i, PH)
  t = t
    .replace(/\bfor (?:men and women|women and men)\b/gi, ' ')   // any DUPLICATE inclusive phrase
    .replace(/\bfor (?:men|women)\b/gi, ' ')                      // standalone gendered audience
    .replace(/\b(?:men|women)['’]?s\b/gi, ' ')              // possessive adjective: Mens / Men's
    .replace(PH, incl[0])
  return t.replace(/\s{2,}/g, ' ').trim()
}

// ─── Stage 1 — Title Agent ─────────────────────────────────────────────────────

/** Shared LLM call helper used by both legacy and V3 council. GPT-5 reasoning models REJECT
 *  `temperature` and use `max_completion_tokens` (not `max_tokens`), so the params branch by model.
 *  Per-call timeout + NO retries: a hung call must not stall the keepalive-less title stage past
 *  Cloudflare's ~100s idle window. GPT-5 reasons slower, so it gets 60s; gpt-4.1-mini gets 20s. */
async function titleCouncilAsk(
  openai: OpenAI, system: string, user: string, temperature: number,
  max_tokens = 120, model = 'gpt-4.1-mini', timeoutMs = 20_000,
): Promise<string> {
  try {
    const isGpt5 = /^(gpt-5|o\d)/.test(model)
    const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
    const r = await openai.chat.completions.create(
      isGpt5
        // reasoning tokens count against max_completion_tokens — a tight cap returns an EMPTY title
        // (finish_reason 'length') and silently fails open. Generous floor + 'low' effort keeps the
        // synthesis fast AND non-empty (adversarial review caught the truncation→empty→fallback trap).
        ? { model, messages, max_completion_tokens: Math.max(max_tokens, 4000), reasoning_effort: 'low' }
        : { model, messages, temperature, max_tokens },
      { timeout: timeoutMs, maxRetries: 0 },
    )
    return (r.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
  } catch { return '' }
}

/** V3 title council (2026-07-23, Step 7). Same 3-persona-adversary-judge shape as the pre-V3
 *  council (deleted 2026-08-03 when TITLE_COUNCIL_V3 retired at 'on' — git ref: pre-973fb7e), but:
 *  (1) each persona is the ENTIRE system message (not `p.sys + baseSystem`) — the personas told the model
 *      one shape while baseSystem told it another, and three "design-led" prepends made all three
 *      proposers draft Pattern A;
 *  (2) proposer 1 always drafts Pattern A, proposer 2 always drafts Pattern B, proposer 3 flexes — so the
 *      judge actually adjudicates shape choice instead of picking among near-clones;
 *  (3) adversary and judge use DIFFERENT model env vars (TITLE_ADVERSARY_MODEL, TITLE_JUDGE_MODEL) so
 *      their verdicts are not correlated — the PO's directive after "even on top models we cant get it
 *      right as set up is wrong somewhere";
 *  (4) adversary trademark clause is GENERATED from TRADEMARK_RULES (kills the stale "World Soccer Cup"
 *      hardcode — TRADEMARK_RULES now says "world futbol cup");
 *  (5) fail-open uses titleQualityJudge score to pick the best draft, not `drafts[1] || drafts[0]` (the
 *      silent SEO-persona array-index bias). */
async function runTitleCouncilV3(openai: OpenAI, baseSystem: string, baseUser: string, onProgress?: (m: string) => void, opts?: { brandName?: string; lean?: AudienceLean; maxLeftWords?: number | null; shape?: GoldShape | null; apparel?: boolean }): Promise<string> {
  // Model env split — spec §4.3. Adversary MUST differ from judge (anti-echo). Default adversary =
  // gpt-4o-mini (different family from gpt-5) so an unconfigured deploy still respects the ≠ rule;
  // if operator overrides both to the same model, we log a warning but still run — the ≠ rule is
  // architecturally intended, not safety-critical.
  const PROPOSER_MODEL = process.env.TITLE_PROPOSER_MODEL || 'gpt-4.1-mini'
  const ADVERSARY_MODEL = process.env.TITLE_ADVERSARY_MODEL || 'gpt-4o-mini'
  const JUDGE_MODEL = process.env.TITLE_JUDGE_MODEL || process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
  if (ADVERSARY_MODEL === JUDGE_MODEL) {
    console.warn(`[title-council-v3] adversary and judge resolved to the SAME model (${JUDGE_MODEL}) — anti-echo diversity is lost; set TITLE_ADVERSARY_MODEL to a different family`)
  }

  // 3 personas as FULL system messages (spec §4.2). Each names the pattern it must produce so the
  // proposers cover the shape space between them. baseSystem is embedded so every hard constraint
  // (brand/audience/apparel gates already built in caller) still holds — but the persona OWNS the
  // ordering directive, so the "design-led" default is no longer echoed 3x.
  const personas: { sys: string; temp: number }[] = [
    {
      sys: `You are the IDIOM COPYWRITER for THE CEO's apparel line. You OWN the left side of the pipe: brand + design phrase + product noun 1. When the design tag is a known idiom or pun (e.g. "Later Gator" -> "See You Later Alligator"), PREFER the FULL source phrase when it fits the identity budget -- the seller keeps BOTH forms in play (their corpus locks "Later Alligator" AND "Later Gator" in one title). Draft the SEPARATED shape most of the seller golds use: IDENTITY (brand + design phrase + garment noun), then a separator, then the MONEY phrase. No modifier stuffing (funny/novelty/graphic/retro/cute/vintage as standalones). Follow every other rule in the brief below.\n\n${baseSystem}`,
      temp: 0.8,
    },
    {
      sys: `You are the DEMAND-CAPTURE STRATEGIST. Your job is to LEAD with the highest-value NICHE-THEME phrase that is actually present in the candidate pool the brief gives you. Precedence — you MUST pick your lead phrase in this order:

1. COMPOUND NICHE-THEME PHRASE FIRST. A compound niche-theme phrase is a 2–4 word phrase from the brief's CANDIDATES / SEEDS / NICHE lists whose non-brand tokens include AT LEAST ONE audience-relational or occasion-relational token: {widow, mom, dad, wife, husband, retirement, birthday, memorial, wedding, anniversary, godmother, godfather, in-law, veteran, bachelorette, mama, papa, grandpa, grandma, hubby, teacher, nurse, coach}. A phrase whose non-brand tokens are ALL in {subject, garment noun, color, fit} (e.g. "Golf Shirt", "Comfort Colors Tee") is NOT a compound niche-theme phrase — it is a raw category head; use step 2.

VISION-OVERLAP FLOOR — the compound phrase you pick MUST share at least ONE distinctive non-brand, non-garment token with the design phrase OR the brief's Design-niche keyphrases / Family niche anchor / seedKeywords. If NO compound phrase in the pool clears this floor, fall through to step 2. Do NOT lead with an off-theme compound just because it is in the pool.

DESIGN-PHRASE-ECHO GUARD — if the compound phrase's non-brand tokens are a SUBSET of the design phrase's tokens (majority overlap), skip it and fall through to step 2 — the design phrase already carries that content in the tail.

TIE-BREAK when multiple compound phrases clear the floor: (a) more vision-overlap tokens wins; (b) higher search-volume rank in the brief wins; (c) shorter phrase wins.

2. RAW CATEGORY HEAD FALLBACK. Only when NO compound niche-theme phrase clears step 1, fall back to the highest-search raw category head (e.g. "Christian Tee Shirt", "Spain Championship Jersey", "Fathers Day Shirt").

HARD RULE — you may ONLY lead with phrases that literally appear in the brief's CANDIDATES / SEEDS / NICHE lists. NEVER invent a theme, audience, or compound phrase not in the brief.

Draft the UNPIPED shape the seller Espana gold uses: the DESIGN PHRASE LEADS (right after the brand), category keywords follow it, one garment mention. No separator. Follow every other rule in the brief below.

${baseSystem}`,
      temp: 0.3,
    },
    {
      sys: `You are the COMPLIANCE & CONVERSION EDITOR. You OWN the right side of the pipe: variant + category brand + noun 2 + audience.

AUDIENCE RULE — READ THE BRIEF'S "AUDIENCE MODE" LINE:
- AUDIENCE MODE: REQUIRED — a gender lean is set. You MUST keep the audience tail "for Women" or "for Men" matching the brief's Audience: value. If length is tight, TRIM FROM THE RIGHT (variant slot > category-brand slot > secondary category noun) — NEVER trim from the LEFT (brand + primary category + design phrase). NEVER pad to reach the tail. NEVER emit "for Men and Women" — that is a universal tail, not a lean one.
- AUDIENCE MODE: OPTIONAL — universal/unisex. Audience tail is a filler slot only; include ONLY if the design is genuinely gender-specific AND it does not crowd out a higher-value candidate. Do NOT force "for Men and Women" onto a universal design.
- DESIGN-PHRASE-CARRIES-SIGNAL EXEMPTION (closed lexicon, DO NOT INFER): a design phrase is "unambiguously gendered" ONLY if it literally contains one of these tokens (case-insensitive) — FEMALE = {wife, girlfriend}; MALE = {husband, boyfriend}. Anything not on this list is NOT a carrier. When the phrase IS a carrier matching the mode, you MAY drop the audience tail — but ONLY when doing so frees space for a HIGHER-VALUE candidate, NEVER for a variant descriptor.
- ANTI-LEAN CARRIER OVERRIDE: if the design phrase contains a MALE carrier ({husband, boyfriend}) while AUDIENCE MODE=REQUIRED with "Women", TREAT AS OPTIONAL (and symmetric for female carrier + male mode). This handles the gift-SKU case (e.g. "Best Husband Ever" printed on a Ladies-cut shirt).
- If the AUDIENCE MODE line is missing from the brief, default to OPTIONAL (safe: no forced tail).

You are grounded in the seller's actual product FACTS (never invent motifs, materials, audiences, occasions). Pick the pattern that best fits the design phrase's search-demand as described in the brief. Follow every other rule in the brief below.

${baseSystem}`,
      temp: 0.4,
    },
  ]

  const drafts = (await Promise.all(personas.map((p) => titleCouncilAsk(openai, p.sys, baseUser, p.temp, 120, PROPOSER_MODEL, 20_000)))).filter(Boolean)
  if (drafts.length === 0) return titleCouncilAsk(openai, baseSystem, baseUser, 0.3)  // fail open: single agent
  if (drafts.length === 1) return drafts[0]

  onProgress?.('Title council V3: drafts in, adversary reviewing...')
  const numbered = drafts.map((t, i) => `${i + 1}. ${t}`).join('\n')

  // Trademark clause generated from TRADEMARK_RULES so "World Cup -> world futbol cup" (2026-07-21
  // PO flip) is always in sync. The stale hardcoded "World Soccer Cup" is retired here.
  const tmClause = buildAdversaryTrademarkClause()

  const critique = await titleCouncilAsk(
    openai,
    // TITLE_COUNCIL_V3.1a Step 10 (PO Q6): adversary honors AUDIENCE MODE. Legacy critique blanket-said
    // audience is optional — this pressures personas to drop the tail on lean designs. V3.1a distinguishes:
    // OPTIONAL → drop is fine; REQUIRED → the tail is a lean-appropriate signal and MUST be preserved.
    `You are a ruthless Amazon listing critic AND a skeptical shopper reviewing candidate titles. Attack each for: keyword stuffing, spammy reads, a buried or duplicated design name, any non-trivial word used more than twice, length over 75 chars (Amazon AUTO-REWRITES longer titles from 2026-07-27), brand not at position 0, and weak click appeal. (a) AUDIENCE MODE=OPTIONAL — the audience suffix ("for Men and Women", "for Men", "for Women") is optional; REJECT any title that FORCES it AND a higher-value product-specific keyphrase from the brief is unused. (b) AUDIENCE MODE=REQUIRED — the tail matching the brief's Audience: value MUST be preserved; REJECT any title that DROPS it (unless the design phrase itself is an unambiguous gender carrier per the brief's closed lexicon). NEVER accept "for Men and Women" on a REQUIRED mode — that is a universal tail, not a lean one. (c) ${tmClause} Be specific per candidate. Do NOT tell the judge to pick a particular one — just critique.`,
    `Brief (the title must satisfy this):\n${baseUser}\n\nCandidate titles for the SAME product:\n${numbered}\n\nCritique EACH candidate, then list the strongest element from each.`,
    0.3, 400, ADVERSARY_MODEL, 60_000,
  )

  onProgress?.('Title council V3: judge synthesizing the winner...')

  // Judge sees the critique but the fail-open below scores candidates deterministically so a bad
  // judge round can't silently ship a Pattern A when Pattern B would score higher.
  // TITLE_COUNCIL_V3.1a Step 7: judge-synth honors AUDIENCE MODE. Without this the synth path can
  // rewrite from scratch and silently unwind Persona 3's audience pin (spec §Fix D verdict refinement #3).
  const judged = await titleCouncilAsk(
    openai,
    `${baseSystem} You are the JUDGE. Read the brief, the candidates, and the critic review. Pick the candidate whose SHAPE best matches the seller's measured corpus in the brief (separated identity|money, or the unpiped design-leads shape — both are theirs), then synthesize the strongest COMPLIANT title in that shape — you MAY rewrite from scratch. AUDIENCE-MODE CONTRACT: when AUDIENCE MODE=REQUIRED in the brief, you MUST preserve the audience tail matching the Audience: value — even when rewriting from scratch. Only drop the tail if the length budget would push over 75c AND the freed space carries a HIGHER-VALUE candidate. NEVER emit "for Men and Women". When AUDIENCE MODE=OPTIONAL, do NOT force any gendered tail. Output ONLY the final title string — no quotes, no explanation.`,
    `${baseUser}\n\nCandidate titles:\n${numbered}\n\nCritic review:\n${critique}\n\nReturn ONLY the single best final title.`,
    0.2, 120, JUDGE_MODEL, 60_000,
  )

  // Deterministic fail-open (spec §4.4): score every non-empty draft on titleQualityJudge; pick the
  // highest. Kills the silent `drafts[1] || drafts[0]` SEO-persona bias. Judge score included so the
  // judge doesn't need to win a coin-flip against a legitimately better proposer draft.
  // TITLE_COUNCIL_V3.1a Fix D: forward opts.lean so the AUDIENCE-WHEN-LEAN dock (-10) shapes the pick.
  const brandName = opts?.brandName || 'THE CEO'
  const lean = opts?.lean
  const candidates = [judged, ...drafts].filter(Boolean)
  if (candidates.length === 0) return ''
  let best = candidates[0]
  const maxLeftWords = opts?.maxLeftWords ?? null
  const shape = opts?.shape ?? null
  const apparel = opts?.apparel ?? false
  /* P0 INSTRUMENTATION (2026-08-12) — KEEP THE DIAGNOSIS INSTEAD OF BINNING IT.
   *
   * `titleQualityJudge` returns `{ score, problems }` and every one of its five production call
   * sites read `.score` and threw `.problems` away — while the BACKEND council has had a repair
   * loop on exactly this signal since PR #75 (`council.reAskJudge(bestScore.problems, …)`, :4817).
   * So on every regen this pipeline computed a named diagnosis of the title it was about to ship
   * ("money position holds only spec facts", "identity longer than the seller has ever written")
   * and deleted it, then the seller told us in their own words what those strings already said.
   *
   * Behaviour is UNCHANGED: same candidates, same comparison, same winner. The verdict object was
   * already being constructed — this only stops discarding half of it. It is the cheapest evidence
   * available for whether a referee is needed, and it is the input the P8 repair round will feed
   * back to the writers. handoff/TITLE_ARCHITECTURE.md §7 P0. */
  let bestVerdict = titleQualityJudge(best, { brandName, lean, maxLeftWords, shape, apparel })
  let bestScore = bestVerdict.score
  for (const c of candidates.slice(1)) {
    const v = titleQualityJudge(c, { brandName, lean, maxLeftWords, shape, apparel })
    if (v.score > bestScore) { best = c; bestScore = v.score; bestVerdict = v }
  }
  console.log('[TITLE_JUDGE_DIAG]', JSON.stringify({
    picked: best,
    score: bestScore,
    problems: bestVerdict.problems,
    ballot: candidates.length,
    // The spread across the candidates the judge was asked to rank. A spread of 0 means the judge
    // expressed no preference and the winner is just `candidates[0]` — which is the measured state
    // for the seller's golds and their attack twins alike (separation margin -14, and 0 on the
    // anagram pair). Logged so that indifference is visible per regen, not only in a test.
    spread: bestScore - Math.min(...candidates.map((c) => titleQualityJudge(c, { brandName, lean, maxLeftWords, shape, apparel }).score)),
  }))
  if (!judged) console.warn(`[title-council-v3] judge returned empty — deterministic fallback score=${bestScore}/100 "${best.slice(0, 90)}"`)

  /* THE REFEREE, IN SHADOW. Asked AFTER the council has already picked, and its answer changes
   * nothing — `best` ships byte-identical below. See titleRefereeMode() for why every guard here
   * exists and why `off` is the default.
   *
   * WHAT THIS MEASURES, and it is the number that decides whether the referee is ever wired: how
   * often the referee's winner DIFFERS from the deterministic judge's. The judge is known to be
   * indifferent — measured separation margin -44, and a 100-100 tie on the gold-vs-stuffed-anagram
   * pair, which is the whole reason a referee was built. If the referee agrees with the judge on
   * essentially every real regen, it is not worth its cost and this stops here. If it disagrees on
   * the cases where the judge's spread is 0, that is the evidence to wire it.
   *
   * CODE STRIKES FIRST, exactly as in the offline gate: noveltyFloorFilter removes candidates that
   * are decidable on a measured token fact, so the referee is never asked to adjudicate something
   * code already knows — and that fact never reaches the prompt, where it once became a rule and
   * docked one of the seller's own golds. */
  if (titleRefereeMode() !== 'off' && candidates.length > 1) {
    const sampleKey = candidates.join('|')
    if (!refereeSampled(sampleKey)) {
      console.log('[TITLE_REFEREE_DIFF]', JSON.stringify({ skipped: 'not-sampled', oneIn: REFEREE_SAMPLE_1_IN }))
    } else {
      /* FIRE-AND-FORGET (2026-08-19 hotfix). The first live regen with this shadow ran ELEVEN
       * MINUTES against a ~4-minute baseline, and the await below was the author: the shadow call
       * was awaited INSIDE the council, the title's corrective loop re-runs the council up to 2
       * extra times (:4006), multi-design multiplies per group, and at TITLE_REFEREE_SAMPLE=1 every
       * one of those invocations paid the full call — serially, on the path the seller was watching.
       *
       * A shadow measurement must never extend the path it measures. The referee's answer changes
       * NOTHING here (the council's pick has already shipped by the time it resolves), so there is
       * nothing to wait for. The 25s Promise.race stays as the inner bound; a container restart
       * mid-call loses one log line and nothing else — acceptable for a measurement, and why this
       * pattern is safe here but was NOT safe for the 2026-08-09 heal (which had a WRITE after the
       * call whose loss re-armed the loop; this has no write and no loop).
       *
       * `best`/`bestScore`/the judge spread are captured NOW, synchronously, so the log reflects
       * the decision as it was made even though the line prints later. */
      const capturedBest = best
      const capturedScore = bestScore
      const capturedSpread = bestScore - Math.min(...candidates.map((c) => titleQualityJudge(c, { brandName, lean, maxLeftWords, shape, apparel }).score))
      const startedAt = Date.now()
      void (async () => {
      try {
        const { runReferee, noveltyFloorFilter } = await import('@/lib/fba/titleRefereeLlm')
        const { nearestGolds, targetFromDesign } = await import('@/lib/fba/titleReferee')
        const lineup = candidates.map((t, i) => ({ id: `c${i}`, title: t }))
        const { kept, struck } = noveltyFloorFilter(lineup)
        if (kept.length > 1) {
          /* The design phrase is the identity minus the brand — the same slice the offline gate
           * feeds (`sit.identity.split(/\s+/).slice(2)`), so shadow and gate ask the referee the
           * same question shape. `lean` is threaded so the anchor picks a gold with a matching
           * audience rather than one that merely looks similar. */
          const designPhrase = best.split(/\s+/).slice(2).join(' ').split(' | ')[0] ?? ''
          /* AudienceLean carries HARD ('female') and SOFT ('lean_female') variants; the referee's
           * situation model only has the hard three. Collapsing soft to hard is right HERE and
           * would be wrong in the producer: the anchor is asking "which gold is this design most
           * like", and a lean_female design is most like a female gold. The producer keeps the
           * distinction because soft lean must not force a gendered tail. */
          const refLean: 'male' | 'female' | 'unisex' | null =
            lean === 'female' || lean === 'lean_female' ? 'female'
            : lean === 'male' || lean === 'lean_male' ? 'male'
            : lean === 'unisex' ? 'unisex' : null
          const target = targetFromDesign({ designPhrase, lean: refLean })
          const anchors = nearestGolds(target, SEED_GOLD_TITLES)
          const res = await Promise.race([
            runReferee(kept, anchors, designPhrase, { runs: 1 }),
            new Promise<null>((r) => setTimeout(() => r(null), REFEREE_TIMEOUT_MS)),
          ])
          const refWinner = res ? kept.find((c) => c.id === res.winnerId)?.title ?? null : null
          console.log('[TITLE_REFEREE_DIFF]', JSON.stringify({
            judgePicked: capturedBest,
            judgeScore: capturedScore,
            // A judge spread of 0 means the judge expressed NO preference — those are exactly the
            // regens where a referee would be carrying the decision, so they are logged explicitly.
            judgeSpread: capturedSpread,
            refereePicked: refWinner,
            agree: refWinner === null ? null : refWinner === capturedBest,
            agreement: res?.agreement ?? null,
            model: res?.model ?? null,
            ballot: kept.length,
            struckByCode: struck.length,
            timedOut: res === null,
            // Cost made visible: without this the latency that caused the 11-minute regen would
            // have stayed invisible in its own diagnostic.
            elapsedMs: Date.now() - startedAt,
          }))
        }
      } catch (e) {
        // FAIL-OPEN. The council's pick shipped long before this resolves; a referee problem is a
        // measurement problem, never a content problem.
        console.warn('[TITLE_REFEREE_DIFF] shadow call failed (council pick shipped unchanged):', e instanceof Error ? e.message : e)
      }
      })()
    }
  }


  // TITLE_COUNCIL_V3.1a Step 8 — TERMINAL SAFETY NET at council exit (PO Q5 = YES).
  // Two tiny rules applied in order to the fail-open winner:
  //   Rule 1: universal-tail strip — if lean is set (not 'unisex'/null), remove any "for Men and Women"
  //           clause. It is never lean-appropriate. Sized narrow: only strips the exact clause.
  //   Rule 2: deterministic tail-append — if AUDIENCE MODE=REQUIRED AND winner has no lean-appropriate
  //           tail AND (winner+tail) <= 75 AND the title itself contains no ANTI-LEAN carrier (Q1 closed
  //           lexicon), append " for Women" / " for Men". This is the string change that guarantees the
  //           audience win even when all persona drafts + the judge synth drop the tail. Length gate
  //           blocks overflow (per Fix D verdict refinement #7 mitigation: on overflow, return
  //           UNMODIFIED). Anti-lean guard: if lean=female but title contains "Dad/Husband/etc" (MALE
  //           carrier), do NOT append "for Women" — the gift-SKU case (per plan risk register #3).
  const mode = deriveAudienceMode(lean)
  const rule1Before = best
  // Rule 1 WIDENED 2026-08-11 (live regen: "…Soccer Cup Tee for Men and Women Fans | Short Sleeve").
  // The universal tail is stripped in EVERY lean state, not only when a lean is set: the seller's
  // ruling is unconditional ("NEVER emit"; SELLER_PROFILE §4 "is TERRIBLE") and their corpus carries
  // it 0 times in 9 golds. On the live specimen the 23-char filler consumed exactly the budget the
  // real money keyword needed — which is what summoned the pad's "| Short Sleeve". The strip also
  // swallows ONE trailing audience noun the tail drags along ("… Fans").
  // ONE PREDICATE (2026-08-11). This net had grown its own narrower copy matching only the literal
  // "for Men and Women", so the live regen shipped "for Men & Women Fans" untouched — the same
  // second-copy drift this whole rebuild exists to delete. `hasInclusiveAudience` /
  // `stripInclusiveAudience` (titleBand) cover every equivalent the seller named: and / & / + / comma
  // / juxtaposition / possessives / Ladies.
  if (hasInclusiveAudience(best)) best = stripInclusiveAudience(best)
  const stripped = rule1Before !== best
  const hasLeanTail = (() => {
    if (lean === 'female' || lean === 'lean_female') {
      return /\bfor\s+women\b/i.test(best) || /\bwomen['’]?s\b/i.test(best) || /\bladies\b/i.test(best)
    }
    if (lean === 'male' || lean === 'lean_male') {
      return /\bfor\s+men\b/i.test(best) || /\bmen['’]?s\b/i.test(best)
    }
    return true
  })()
  let appended = false
  // F3 (2026-08-11 adversarial pass): the pipeline was MANUFACTURING the seller's rejected shape.
  // From a clean draft ending "…Tee Shirt for Men" at lean='female', Rule 1 does not strip (a single
  // gender is admissible), the anti-lean carrier lexicon contains only {husband, boyfriend} so a
  // plain "Men" is not a carrier, and this append then produced "…for Men … for Women" — the exact
  // string the seller called EVEN WORSE. A title that already names ANY audience does not get
  // another one appended; the span analyzer is the same predicate the door and judge use.
  const alreadyNamesAudience = audienceSpans(best).length > 0
  if (mode === 'REQUIRED' && !hasLeanTail && !alreadyNamesAudience) {
    const targetAud = (lean === 'male' || lean === 'lean_male') ? 'Men' : 'Women'
    const wantFemale = targetAud === 'Women'
    const wantMale = targetAud === 'Men'
    const carriers = designPhraseCarriesGender(best)
    // Anti-lean: only block append when the title carries the OPPOSITE gender's carrier tokens.
    const antiLean = (wantFemale && carriers.male && !carriers.female) || (wantMale && carriers.female && !carriers.male)
    const tail = ` for ${targetAud}`
    /* THE RULE-2 APPEND — suppressed at TITLE_V4=on (2026-08-12).
     *
     * listingPipeline.ts:3206-3211 records this as the SOLE AUTHOR of "…for Men … for Women", the
     * string the seller called EVEN WORSE. It is deterministic code adding audience words to reach a
     * shape — an ADDITION, and every one of the five rejected titles was authored by an addition.
     * Under the seller's 2026-08-12 rule 1 an audience phrase earns its place only when a shopper
     * types it; that is a judgement, and the referee owns it. Code no longer bolts one on. */
    if (!antiLean && (best.length + tail.length) <= 75 && !v4Applies()) {
      const preAppend = best
      best = `${best}${tail}`
      appended = true
      console.log(`[COUNCIL_V3_TAIL_APPEND] lean=${lean} pre="${preAppend.slice(0, 80)}" (${preAppend.length}c) post="${best.slice(0, 80)}" (${best.length}c)`)
    }
  }
  if (stripped || appended) {
    console.log(`[COUNCIL_V3_TERMINAL_NET] lean=${lean ?? 'none'} mode=${mode} stripped=${stripped} appended=${appended} finalScore=${titleQualityJudge(best, { brandName, lean, maxLeftWords, shape, apparel }).score}/100`)
  }
  // SHAPE OBSERVABILITY — UNCONDITIONAL, and it must stay that way.
  //
  // It was first written nested inside the `if (stripped || appended)` guard above, which meant
  // shadow mode's ONLY observable could not fire on a listing where neither audience net ran — i.e.
  // on a unisex / no-lean design, which is exactly B0GVV3XL4T, the ASIN this whole change exists
  // for. A flag whose shadow arm is silent on its own target listing is a dark flag, which is the
  // TITLE_MONEY_TAIL lesson this comment originally claimed to be applying.
  //
  // Placement is load-bearing: AFTER the terminal nets, so the logged string is the council's real
  // exit value including any appended audience tail — not the pre-net winner.
  console.log('[TITLE_GOLD]', JSON.stringify({
    tag: 'SHAPE_JUDGE', mode: titleShapeJudgeMode(), ceiling: maxLeftWords,
    ...titleShapeTerms(best, maxLeftWords), title: best.slice(0, 90),
  }))
  return best
}

/** COUNCIL for the title (PO directive: big decisions DEBATE instead of one agent). Reuses the
 *  fully-built title brief (system+user) so every hard constraint still applies, then runs the V3
 *  3-persona -> adversary -> judge council. The judge's output flows through runTitleAgent's
 *  existing validate + deterministic backstops (brand-lead, design-name lead, gender de-dup,
 *  Title-Case), so the council is additive, not a new failure mode. V3 fails open internally
 *  (best-scoring draft, then single agent).
 *
 *  TITLE_COUNCIL_V3 flag RETIRED 2026-08-03 at live 'on' (on since 07-23, live-verified): the
 *  legacy council + [COUNCIL_V3_DIFF] shadow machinery are deleted — legacy was no longer a
 *  pre-Step-7 baseline anyway (V3.1a changed its brief un-flagged). Rollback is git-revert.
 *  Both title paths (single-design and multi-design) call this wrapper (INVARIANT 1 parity). */
async function runTitleCouncil(openai: OpenAI, baseSystem: string, baseUser: string, onProgress?: (m: string) => void, opts?: { brandName?: string; lean?: AudienceLean; maxLeftWords?: number | null; shape?: GoldShape | null; apparel?: boolean }): Promise<string> {
  return runTitleCouncilV3(openai, baseSystem, baseUser, onProgress, opts)
}

/** Bullets COUNCIL (PR: bullets-council) — mirrors runTitleCouncil for the 5-bullet ARRAY. Bullets are
 *  an 18% (>=15%) rank-factor field, and the bullet score's single biggest lever is opportunity-keyword
 *  COVERAGE (syncListingContent docks up to -12 for missing top keywords). So 3 persona proposers draft
 *  5-bullet sets, a GPT-5 adversary hunts MISSING-keyword coverage + weak hooks + role/accuracy slips,
 *  and a GPT-5 judge synthesizes the best-covered compliant set. Output still flows the caller's
 *  role-leak guard + validateBullets retry, so the council is additive. Fails open to a single agent. */
async function runBulletsCouncil(openai: OpenAI, baseSystem: string, baseUser: string, onProgress?: (m: string) => void): Promise<string[]> {
  // Proposers + judge return JSON {bullets:[5]}; the adversary returns prose. GPT-5 reasoning models
  // reject `temperature` and use `max_completion_tokens` — params branch by model (same as the title
  // council). Per-call timeout + NO retries so a hung call can't stall past Cloudflare's ~100s idle
  // window (a keepalive fires BETWEEN stages, not during a call; each call finishes under its own cap).
  const askBullets = async (system: string, user: string, temperature: number, model = 'gpt-4.1-mini', timeoutMs = 20_000, label = 'proposer'): Promise<string[]> => {
    try {
      const isGpt5 = /^(gpt-5|o\d)/.test(model)
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
      const r = await openai.chat.completions.create(
        isGpt5
          ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' as const, response_format: { type: 'json_object' as const } }
          : { model, messages, temperature, max_tokens: 1200, response_format: { type: 'json_object' as const } },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      const content = r.choices[0]?.message?.content || ''
      // #176: an empty judge was invisible for weeks because failures were swallowed here. A
      // reasoning model can exhaust max_completion_tokens on REASONING and return empty content
      // with finish_reason 'length' — log the cause, never just the silence.
      if (!content.trim()) console.warn(`[bullets-council] ${label} (${model}) returned EMPTY content — finish_reason=${r.choices[0]?.finish_reason ?? '?'}`)
      const parsed = parseJsonLoose<{ bullets?: string[] }>(content || '{}')
      return Array.isArray(parsed.bullets) ? parsed.bullets.filter((b) => typeof b === 'string').map((b) => b.trim()).filter(Boolean).slice(0, 5) : []
    } catch (e) {
      console.warn(`[bullets-council] ${label} (${model}) call FAILED: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }
  const askText = async (system: string, user: string, model: string, timeoutMs: number): Promise<string> => {
    try {
      const isGpt5 = /^(gpt-5|o\d)/.test(model)
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
      const r = await openai.chat.completions.create(
        isGpt5
          ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' as const }
          : { model, messages, temperature: 0.3, max_tokens: 500 },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      return (r.choices[0]?.message?.content || '').trim()
    } catch { return '' }
  }
  const COUNCIL_MODEL = process.env.BULLETS_COUNCIL_MODEL || process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
  const personas: { sys: string; temp: number }[] = [
    { sys: 'You are an award-winning apparel COPYWRITER. Write 5 bullets a shopper FEELS — human voice, design-led. Each CAPS hook is a NATURAL, idiomatic 2-3 word benefit ("SOFT & COMFORTABLE", "EVERYDAY FIT", "PREMIUM COTTON FEEL") — never awkward fabric jargon or non-English phrases like "EASYGOING DRAPE". ', temp: 0.6 },
    { sys: 'You are an Amazon SEO STRATEGIST. The required search keyphrases in the brief MUST appear across the 5 bullets, woven naturally and accurately — maximizing legitimate keyword COVERAGE without stuffing is your job. ', temp: 0.3 },
    { sys: 'You are a CONVERSION strategist. Every bullet leads with a crisp 2-3 word CAPS benefit hook; all 5 are scannable, accurate, and trustworthy. ', temp: 0.4 },
  ]
  const drafts = (await Promise.all(personas.map((p) => askBullets(p.sys + baseSystem, baseUser, p.temp)))).filter((d) => d.length > 0)
  if (drafts.length === 0) return askBullets(baseSystem, baseUser, 0.4)        // fail open: single agent
  if (drafts.length === 1) return drafts[0]
  onProgress?.('Bullets council: drafts in, adversary reviewing...')           // keepalive (resets idle timer)
  const numbered = drafts.map((d, i) => `Set ${i + 1}:\n${d.map((b, j) => `  ${j + 1}. ${b}`).join('\n')}`).join('\n\n')
  const critique = await askText(
    'You are a ruthless Amazon listing critic. Attack each 5-bullet set for: (1) MISSING required keyphrases from the brief — name exactly which are absent from each set; (2) weak, duplicate, or non-CAPS benefit hooks; (3) any claim of a profession/role/occasion/audience NOT in the title (accuracy failure); (4) keyword stuffing or bullets under ~100 chars; (5) any TRADEMARKED phrase (sports teams, leagues, universities, media franchises, e.g. "World Cup", "Florida Gators", "Super Bowl", "Marvel") — REQUIRE the safe substitution ("World Cup" -> "World Soccer Cup", "Super Bowl" -> "Big Game") or removal; (6) budget spent on GENERIC audience/gift filler when a higher-value PRODUCT-SPECIFIC keyphrase from the brief is still uncovered — prefer covering the specific keyphrase. Be specific per set.',
    `Brief the bullets must satisfy:\n${baseUser}\n\nCandidate 5-bullet sets for the SAME product:\n${numbered}\n\nCritique EACH set, then name which set covers the required keyphrases best.`,
    COUNCIL_MODEL, 60_000,
  )
  onProgress?.('Bullets council: judge synthesizing the winner...')            // keepalive
  const judgeSysB = baseSystem + ' You are the JUDGE: merge the strongest, ACCURATE elements into ONE final set of 5 bullets that covers EVERY required keyphrase from the brief, each starting with a CAPS benefit hook, none implying a role/occasion not in the title. Return ONLY JSON {"bullets":["b1","b2","b3","b4","b5"]}.'
  const judgeUserB = `${baseUser}

Candidate sets:
${numbered}

Critic review:
${critique}

Return ONLY the single best final set as {"bullets":[...]}.`
  let judged = await askBullets(judgeSysB, judgeUserB, 0.2, COUNCIL_MODEL, 60_000, 'judge')
  // #176: the judge failed EVERY live run while the proposers succeeded — same messages, different
  // model. Before abandoning judgment, retry ONCE on the proposers' proven workhorse model: a
  // downgraded judge still JUDGES (merges + covers keyphrases), which beats an unjudged draft.
  if (judged.length === 0 && COUNCIL_MODEL !== 'gpt-4.1-mini') {
    judged = await askBullets(judgeSysB, judgeUserB, 0.2, 'gpt-4.1-mini', 30_000, 'judge-retry')
    if (judged.length > 0) console.log('[bullets-council] judge succeeded on gpt-4.1-mini downgrade retry')
  }
  // Fail open to the SEO/coverage draft (persona #1), NOT the creative one (#0): if the judge errors or
  // returns empty/invalid JSON, the coverage-optimized draft is the safest fallback. Logged so it's visible.
  if (judged.length === 0) console.warn('[bullets-council] judge returned empty — failing open to the SEO/coverage draft')
  return judged.length > 0 ? judged : (drafts[1] || drafts[0])
}

// ─── Stage 1 — Title Agent ─────────────────────────────────────────────────────

async function runTitleAgent(
  input: PipelineInput,
  candidates: TitleCandidate[],
  attributes: string[],
  mustInclude: string | undefined,
  preferredAudience: string,
  attributePin: string | undefined,
  /** Top UPGRADE-tagged keywords (present in bullets but not title — see scorer's
   *  title.upgradeCount penalty). The agent is told to pull as many in as fit; the
   *  validator below fails the title if 3+ are still missing, triggering a retry. */
  upgradeKws: string[] = [],
  /** High-IQ COMPATIBILITY device brands the product genuinely works with (Canon/Sony/
   *  Nikon/…). Agent weaves the top ones in as 'Compatible with [Brand]'. PR #86. */
  compatibilityBrands: string[] = [],
  /** Seller's DESIGN/SLOGAN name ("Later Gator") that MUST survive verbatim — the product's
   *  identity. Mandated + validated like the money keyword. PR #91. */
  designName = '',
  /** Season policy for THIS regen. Reaches validateTitle so a Valentine design's OWN "Valentine"
   *  is no longer a title violation while another design's Christmas still is. Default = blanket
   *  (historical). BOTH title producers reach validateTitle through here: single-design and
   *  per-design multi-design both call buildTitleFor → runTitleAgent (INVARIANT 1 parity). */
  season: SeasonPolicy = BLANKET_SEASON_POLICY,
): Promise<{ title: string; problems: string[]; retried: boolean }> {
  const { openai, brandName, category, repTitle, productType } = input
  const apparel = looksApparel(category, repTitle, productType)
  // TITLE_COUNCIL_V3.1a: RAW audience lean (apparel-only, null for non-apparel or unset). Reaches the
  // council brief as an explicit AUDIENCE MODE line + is forwarded to titleQualityJudge for the dock.
  // Preserves hard/soft distinction (male/female vs lean_male/lean_female) — collapsing to preferredAudience
  // string would lose that. Local, not param, because runTitleAgent already receives input: PipelineInput.
  const lean: AudienceLean = apparel ? (input.audienceLean ?? null) : null
  const audienceMode = deriveAudienceMode(lean)

  // 🎯 DESIGN-GROUNDED TITLE (apparel) — the root fix for keyword-stuffed titles. The TITLE may only
  // carry keywords GROUNDED in the actual design: the design name, what the image scan literally sees,
  // the garment/blank brand, the product type, and the audience. High-volume-but-ungrounded keywords
  // ("vintage 90s", "cool shirts") are stripped from the TITLE's keyword pools HERE — so the brief
  // (and the council reading it) never see them, AND validateTitle below never demands them. They are
  // NOT lost: the bullets + backend agents build their keyword pools independently and still rank them.
  // "Clear the counter" so even the council debate can't stuff. Gated on having a design signal so a
  // vision miss can't over-strip; the strict ALL-words-grounded bar is what keeps vibe-guesses out.
  if (apparel && (designName || input.visionDesign)) {
    const groundVocab = new Set<string>()
    const addWords = (s?: string | null) => {
      if (!s) return
      for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        const stem = w.replace(/s$/, '')
        if (stem.length > 1 && !MINOR_WORDS.has(stem)) groundVocab.add(stem)
      }
    }
    addWords(designName)                                   // the seller's design identity
    addWords(input.visionDesign?.designTheme)              // what the image scan read
    for (const el of input.visionDesign?.visualElements || []) addWords(el)
    for (const sk of input.visionDesign?.seedKeywords || []) addWords(sk)
    addWords(attributePin)                                 // garment/blank brand IS a real product attribute (trusted)
    addWords(preferredAudience)                            // men / women
    // The SELLER'S OWN titles are legitimate grounding — they wrote them about their own
    // product. Without these, real descriptors ("Country Western", "Vintage Rodeo") were
    // dropped as "ungrounded" whenever the vision scan missed them, while a vision
    // hallucination ("heart") sailed through — backwards trust (B0FKLGWZ4C).
    addWords(input.canonicalTitle)
    addWords(input.repTitle)
    // Design-NICHE seeds (council 2026-07-03) are GROUNDING sources: they were LLM-expanded from
    // THIS design's identity, so their words ("reading", "bookworm", "librarian") count as grounded
    // and survive the candidate filter below — giving a niche design real material to fill the title.
    for (const sk of input.nicheSeeds || []) addWords(sk)
    // TRUSTED tier for VISUAL MOTIF claims: seller text only — vision is a witness, not
    // a source, for what's printed on the artwork (it read a heart into a script font).
    const motifVocab = new Set<string>()
    const addMotifWords = (s?: string | null) => {
      if (!s) return
      for (const w of s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        const stem = w.replace(/s$/, '')
        if (stem.length > 1) motifVocab.add(stem)
      }
    }
    addMotifWords(designName)
    addMotifWords(input.canonicalTitle)
    addMotifWords(input.repTitle)
    // Generic tone/structural/gift words make NO factual claim about the artwork, so they're always
    // allowed. Only DISTINCTIVE words — the design's motifs AND era/style CLAIMS ("vintage", "90s",
    // "retro") — must be grounded in the actual design. This blocks ungrounded guesses ("vintage 90s")
    // while keeping legitimately generic phrases ("funny cat shirt", "alligator gift") so the pool is
    // never over-stripped into a too-short title (adversarial review caught the brittle all-words bar).
    const FREE = new Set(['cool', 'funny', 'cute', 'awesome', 'best', 'great', 'perfect', 'novelty', 'graphic', 'gift', 'lover', 'fan', 'apparel', 'clothing', 'outfit', 'wear', 'design', 'tee', 'shirt', 'tshirt', 'sweatshirt', 'hoodie', 'tank', 'top'])
    /* THREE JOBS, NOW SEPARATED (2026-08-13, TITLE_V4).
     *
     *   1. invented OBJECTS      ("cassette" on a slogan tee)   -> motifVocab, seller text only
     *   2. invented ERAS         ("vintage 90s")                 -> groundVocab, always
     *   3. everything else       ("usa", "jersey", "mexico")     -> see `vetted` below
     *
     * (1) and (2) are assertions about the ARTWORK. No keyword-relevance classifier checks them, so
     * they stay grounded in the seller's own text however strong the search demand.
     *
     * (3) is not a claim about the artwork at all — it is the market vocabulary of the subject the
     * design is about. MEASURED on B0GVV3XL4T: "usa jersey" was dropped from a World Cup design
     * whose seller gold closes "USA Mexico Canada Football Tee", leaving four usable candidates and
     * a 48-character draft ending "| Futbol". The guard was deleting the gold's own words before the
     * council could see them — which is why the nearest-gold anchor changed nothing.
     *
     * `vetted` marks keywords that reached here as CRITICAL/UPGRADE/DEFENDED/REINFORCE ranking
     * targets for THIS ASIN — they already passed the relevance classifier's theme gate upstream.
     * Applying the design-CLAIM guard to them as well is double-filtering with the wrong predicate.
     * Fill vocabulary (attributes, upgrade keywords, the mandated keyword) is NOT vetted and keeps
     * the full test unchanged. */
    /* THE PRODUCT-TYPE STRIKE (PO ruling 2026-08-13).
     *
     * Asked whether "USA Mexico Canada" in their World Cup gold was aimed at people searching those
     * countries or was simply describing the design, the seller answered: "No — it just describes the
     * design." So the countries belong in the title, but `usa jersey` traffic must NOT be chased — a
     * shopper who wants a real jersey will not buy a graphic tee. That makes the theme rater's 0 on
     * `usa jersey` CORRECT, and it makes the blanket `vetted` bypass below too wide: it admitted the
     * whole keyword, and the council then sourced the right words from a keyword the seller rejects.
     *
     * "is a jersey the same product as a tee" is decidable against the listing's own product type —
     * an external fact, no judgement — so it is code's job, as a STRIKE, never as an edit.
     *
     * RESOLVED BY HEAD NOUN, which is what makes it safe. English noun phrases put the head last, so
     * `usa jersey` is ABOUT a jersey while `new jersey girl shirt` is about a shirt. And an
     * out-of-family head still passes if it is genuinely the design's own vocabulary — a design about
     * New Jersey keeps "jersey" — which is the same two-tier fallback the era-claim words already use.
     * Fill vocabulary is unaffected: it never had the bypass, so `usa jersey` was already dropped. */
    const ownGarment = garmentFor(productType, input.repTitle || input.canonicalTitle)
    const isGrounded = (kw: string, vetted = false): boolean => {
      const foreign = foreignHeadNoun(kw, ownGarment)
      const distinctive = kw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .map((w) => w.replace(/s$/, ''))
        .filter((w) => w.length > 1 && !MINOR_WORDS.has(w) && !FREE.has(w))
      return distinctive.every((w) => {
        if (VISUAL_MOTIF_WORDS.has(w) || VISUAL_MOTIF_WORDS.has(`${w}s`)) return motifVocab.has(w)
        if (ERA_STYLE_CLAIM_WORDS.has(w) || isDecadeClaim(w)) return groundVocab.has(w)
        // A DIFFERENT product's name is never market vocabulary for THIS product — unless the design
        // is genuinely about it. Sits ahead of the bypass so a vetted target cannot smuggle it in.
        if (foreign && w === foreign) return groundVocab.has(w)
        // A vetted ranking target's non-claim words are market vocabulary, not invented artwork.
        if (vetted && titleV4Mode() !== 'off') return true
        return groundVocab.has(w)
      })
    }
    // The verbatim money keyword (mustInclude) is the PRIMARY leak — it is mandated + hard-validated
    // into the title, bypassing the candidate filter. If it's an ungrounded CLAIM ("vintage 90s shirt")
    // rather than a design term ("alligator shirt"), drop the mandate (it still ranks from bullets/
    // backend). NOTE: attributePin (the blank/garment brand) is NOT design-gated — it's a real PRODUCT
    // attribute, not a design claim, so grounding is the wrong test for it; it's trusted + added above.
    if (mustInclude && !isGrounded(mustInclude)) mustInclude = undefined
    /* WHAT THE DESIGN-GROUNDING FILTER REMOVES, recorded on the response.
     *
     * MEASURED NEED, 2026-08-13. `titleDebug.candidatesUsed` is built in runListingPipeline from the
     * UNFILTERED array, so it shows keywords the council never received — and it is what led to the
     * conclusion "the pool had `usa jersey`, the council ignored it". The council may never have been
     * shown it. Reading a pre-filter list and calling it what the model saw is the same class of
     * error as measuring the wrong pipeline stage.
     *
     * The suspicion this settles: for the 2026 World Soccer Cup design, `groundVocab` is built from
     * the design name, the live title and the niche seeds — 2026 / world / soccer / cup / futbol /
     * tournament / fan. The seller's OWN gold for that design closes with "USA Mexico Canada
     * Football Tee". If `usa` / `mexico` / `canada` / `jersey` are absent from that vocabulary, a
     * truth-guard written to stop invented DESIGN CLAIMS is also deleting the event's real SEARCH
     * vocabulary — and the council is being asked to write the seller's gold with the gold's words
     * removed from the table. */
    const groundingDropped = candidates.filter((c) => !isGrounded(c.keyword, true)).map((c) => c.keyword)
    if (groundingDropped.length) {
      console.log('[TITLE_GROUNDING_DROP]', JSON.stringify({ design: designName, kept: candidates.length - groundingDropped.length, dropped: groundingDropped.slice(0, 40) }))
      if (input.__v4Sink) input.__v4Sink.push({ stage: 'grounding-filter', design: designName, keptCount: candidates.length - groundingDropped.length, dropped: groundingDropped.slice(0, 40) })
    }
    candidates = candidates.filter((c) => isGrounded(c.keyword, true))   // vetted ranking targets
    upgradeKws = upgradeKws.filter((k) => isGrounded(k))                  // fill — full test, unchanged
    attributes = attributes.filter((k) => isGrounded(k))                  // fill — full test, unchanged
  }

  // TRADEMARK PRE-FILTER (Approach B) — substitute protected marks to their safe phrasing
  // (scrubTrademarks: "World Cup" -> "World Soccer Cup") and DROP any term that still trips the
  // curated franchise/team list (findTrademarkPhrases, e.g. "Florida Gators") BEFORE it enters the
  // council brief. Runs for apparel AND non-apparel (the design-grounding block above is apparel-gated,
  // so this is deliberately separate). Belt-and-suspenders with the generation-time scrubPublished:
  // scrubbing at OUTPUT still let the council spend scarce title budget PLACING a trademark keyword;
  // filtering the brief stops that at the source. Dropped terms still rank via bullets/backend.
  const tmDropped: string[] = []
  const tmSafeKw = (kw: string): string | null => {
    const s = scrubTrademarks(kw)
    if (findTrademarkPhrases(s).length > 0) { tmDropped.push(kw); return null }
    return s
  }
  candidates = candidates
    .map((c) => { const s = tmSafeKw(c.keyword); return s ? { ...c, keyword: s } : null })
    .filter((c): c is TitleCandidate => c !== null)
  upgradeKws = upgradeKws.map(tmSafeKw).filter((s): s is string => s !== null)
  attributes = attributes.map(tmSafeKw).filter((s): s is string => s !== null)
  if (mustInclude) mustInclude = tmSafeKw(mustInclude) ?? undefined
  if (tmDropped.length) console.warn(`[title-tm-filter] dropped ${tmDropped.length} residual-trademark term(s): ${tmDropped.slice(0, 6).join(' | ')}`)

  const candidateList = candidates
    .map((c) => {
      // Rank context for the writer/council: striking distance (#11-30) = a title spot moves
      // this keyword fastest; already top-10 = defend, don't burn budget chasing it harder.
      const rank = c.organicRank != null
        ? c.organicRank <= 10 ? `, we already rank #${c.organicRank} — defend`
          : c.organicRank <= 30 ? `, we rank #${c.organicRank} — STRIKING DISTANCE, title placement moves this fastest`
            : `, we rank #${c.organicRank}`
        : ''
      // "placement priority", not "opportunity" (PO data-truth 2026-08-08): this is the internal
      // gap-amplified composite — the LLM must not be told a fabricated number is market opportunity.
      return `  - "${c.keyword}" (placement priority ${c.coverageGapScore}, role: ${c.role}${rank})`
    })
    .join('\n')
  const attrLine = attributes.length
    ? `\nSearchable product keyphrases shoppers actually type — work them in AFTER the mandatory keyword${apparel ? ' (e.g. a blank-brand term like "comfort colors graphic tee")' : ' (titles under 110 chars have room for more — keep adding while you have budget)'}:\n  ${attributes.join(', ')}\n`
    : ''
  const mustLine = mustInclude
    ? apparel
      // Apparel is DESIGN-led: the design name + product type lead. Weave the money keyword in only
      // where it reads naturally — do NOT front-load it ahead of the design name / product type.
      ? `\nWeave the keyword "${mustInclude}" in naturally ONLY where it fits the design-led phrase — do NOT force it ahead of the design name or the product type.\n`
      : `\n🔴 MANDATORY #1 — the title MUST contain this highest-search-volume keyword VERBATIM and FRONT-LOADED (it is your single biggest money term — never drop it): "${mustInclude}"\n`
    : ''
  // The seller's design/slogan name is the PRODUCT'S IDENTITY (the artwork printed on it).
  // It must appear VERBATIM — do NOT paraphrase it (e.g. keep "Later Gator", never swap it
  // for "See You Later Alligator" or "Crocodile Design"). PR #91.
  const designLine = designName
    ? `\n🔴 MANDATORY — the title MUST LEAD with the product's DESIGN NAME exactly as written: "${designName}". Place it FIRST, immediately after the brand "${brandName}" and BEFORE the product type — it is the seller's design identity printed on the product and the main thing shoppers recognize. Use it VERBATIM (never paraphrase, expand, or substitute a synonym). Do NOT also include a longer paraphrase or alternate wording of the SAME slogan elsewhere in the title — e.g. if the design is "Later Gator", do NOT also write "See You Later Alligator" (that is the same slogan twice and wastes characters). Lead with "${designName}", then the product type.\n`
    // No design name resolved: forbid INVENTING one AND forbid promoting a keyword to slogan
    // status. Without the second rule, the agent treated a high-volume keyword that *looks* like a
    // slogan (e.g. "too young to retire too poor to quit shirt", JS vol 488 UPGRADE on B0GQVL3K4B)
    // as the design — even though that phrase appeared nowhere in the seller's actual listing.
    // The CURRENT title is the only authoritative source; keywords are search terms, not design names.
    : `\n🔴 Do NOT invent a design, collection, or style name. The design anchor MUST be the leading distinctive phrase of the CURRENT title (verbatim) — the words the seller put there. NEVER promote any keyword from the candidate list below into the design / slogan slot, even if it reads like a slogan or has high volume — those are SEARCH TERMS, not the design. If the current title has no clear distinctive lead, omit the design slot entirely and lead with the brand + product type only.\n`
  const attrPinLine = attributePin
    ? apparel
      // Garment brand goes AFTER the welded design-name + product-type phrase ("Later Gator T-Shirt,
      // Comfort Colors ..."), NEVER between the design name and the product type — splitting them
      // breaks the #1 exact-match keyword "<design> t-shirt" (the seller's top ranking opportunity).
      // And NEVER "for <brand>" (it's the fabric, not a compatibility target).
      ? `\nInclude the garment/blank brand "${attributePin}" AFTER the design-name + product-type phrase — e.g. "...${designName || 'Later Gator'} T-Shirt, ${attributePin} Alligator Tee...". Do NOT place "${attributePin}" BETWEEN the design name and the product type: that splits the exact-match keyword "${designName || 'Later Gator'} T-Shirt", which is the single highest ranking opportunity. NEVER write "for ${attributePin}".\n`
      : `\n🔴 MANDATORY #2 — the title MUST ALSO contain the blank/garment brand "${attributePin}" (a strategic ranking attribute the seller ranks for). Place it after the #1 keyword.\n`
    : ''
  // UPGRADE keywords = ranking signals the seller has demonstrated traffic on (present in
  // bullets, missing from title). Amazon weights title 3-5× over bullets, so dragging these
  // INTO the title is the highest-leverage move available. The scorer penalizes the title
  // when 3+ are missing; the validator below fails on the same threshold so the retry loop
  // is responsible for covering them, not the seller.
  const upgradeLine = upgradeKws.length === 0
    ? ''
    : apparel
      // Apparel: design-led titles do NOT chase keyword coverage. These are already grounding-filtered
      // above, so offer at most ONE and never mandate — a clean title beats coverage every time.
      ? `\nIf — and ONLY if — one of these fits naturally and is genuinely about the design, you MAY include a single one (never force them; a clean title wins): ${upgradeKws.map((k) => `"${k}"`).join(', ')}\n`
      : upgradeKws.length >= 3
        ? `\n🟡 MANDATORY #3 — these UPGRADE keywords already drive your bullets' search traffic but are MISSING from your live title. Amazon weights title keywords 3-5× more than bullets — folding them into the title is your single highest-leverage SEO move. Include AT LEAST ${Math.max(3, upgradeKws.length - 2)} of these (more is better, fit as many as the budget allows):\n  ${upgradeKws.map((k) => `"${k}"`).join(', ')}\n`
        : `\nTry to include these UPGRADE keywords too (they drive bullet traffic but are missing from the title): ${upgradeKws.map((k) => `"${k}"`).join(', ')}\n`
  // TITLE_COUNCIL_V3.1a Step 2 (PO Q8, deletion of retired "DROP the audience" clause): legacy path
  // now respects AUDIENCE MODE too — REQUIRED = a gender lean is set, keep the tail; OPTIONAL = universal,
  // include only if the design is genuinely gender-specific. Strict improvement over pre-7.1a legacy
  // behavior; V3=off rollback surfaces this same rule (safe, no widened blast radius).
  const audienceLine = preferredAudience
    ? `\nAUDIENCE MODE: ${audienceMode}\nAUDIENCE: ${preferredAudience}\n- REQUIRED = a gender lean is set. KEEP the "for ${preferredAudience}" tail; trim a LOWER-value candidate from the RIGHT rather than pad. NEVER emit "for Men and Women" (universal tail on a lean design).\n- OPTIONAL = universal/unisex. Audience is a filler slot; include ONLY if the design is genuinely gender-specific AND it does not crowd out a higher-value keyphrase.\n`
    : ''
  // NICHE line (council 2026-07-03): design-grounded niche keyphrases the council SHOULD use to fill
  // the budget. Unlike generic keywords (deliberately kept minimal above), these ARE about the
  // design, so filling with them is on-brand, not stuffing. The secondary design phrase leads.
  const nicheSeedList = apparel ? [...new Set((input.nicheSeeds || []).map((s) => s.trim()).filter(Boolean))] : []
  const nicheLine = nicheSeedList.length
    ? `\n🟢 DESIGN-NICHE KEYPHRASES — these ARE about your design (not generic filler). USE THEM to fill the title toward the full 68-75 char budget, woven as natural language after the design phrase. A short title wastes half your search real estate; keep adding these until you are near 72 chars:\n  ${nicheSeedList.map((s) => `"${s}"`).join(', ')}\n`
    : ''

  // V2 primary-council brief (2026-07-22; TITLE_QUALITY_V2 flag retired 2026-08-03 — live env was
  // 'on', so folding the V2 arm in unconditionally is byte-identical; rollback is git-revert). The
  // apparel guard SURVIVES the flag: non-apparel never got the V2 brief and keeps the arm below.
  const v2ExpandedDesign = apparel ? expandIdiomDesignName(designName) : (designName || '')
  const v2IsKnownIdiom = apparel && isIdiomDesign(designName)
  const [system, user] = apparel ? (() => {
    // ONE brief builder — the golds are the spec; only the product block is site-specific.
    // The audience block renders ONLY what is true: no `|| 'Men and Women'` default (that literal
    // is the seller-banned universal tail, and the old template printed it as the slot's default
    // content on every unisex design — the least-attested shape in their corpus).
    const audBlock = preferredAudience
      ? `AUDIENCE MODE: ${audienceMode}\nAudience: ${preferredAudience}\n// REQUIRED = a gender lean is set: KEEP the "for ${preferredAudience}" tail; trim a lower-value candidate rather than pad. OPTIONAL = include only if the design is genuinely gender-specific.\n`
      : `AUDIENCE MODE: ${audienceMode}\n// Universal design — no audience tail unless the design itself is gender-specific. NEVER "for Men and Women".\n`
    const inputBlock = `Brand: ${brandName}
Category: ${category}
${attributePin ? `Garment brand (a selling point — the seller's tails carry it): ${attributePin}\n` : ''}${audBlock}Design phrase (identity — KEEP this exact phrase in the title): ${v2ExpandedDesign || '(none)'}${v2IsKnownIdiom ? `\n  ↑ a known idiom/pun; the expansion above IS the source phrase — prefer it over the short tag when it fits the identity budget.` : ''}
${mustInclude ? `Mandatory keyword (KEEP verbatim — #1 search term): ${mustInclude}\n` : ''}${nicheSeedList.length ? `Design-niche keyphrases (weave those that fit): ${nicheSeedList.map((s) => `"${s}"`).join(', ')}\n` : ''}Search phrases shoppers type, most valuable first:
${candidateList}`
    const b = buildApparelTitleBrief({
      brandName,
      roleLine: `You write Amazon apparel titles for ${brandName}.`,
      inputBlock,
      poGolds: input.poGolds,
      // NEAREST-GOLD ANCHOR — the design decides WHICH gold is shown last, in the recency position.
      // v2ExpandedDesign is the idiom-expanded form when there is one, else the raw design name —
      // the same string this brief already teaches as the identity.
      designPhrase: v2ExpandedDesign || designName || null,
      garmentNoun: input.productType ?? null,
      lean,
    })
    return [b.system, b.user]
  })() : [
    `You are an Amazon SEO title writer${apparel ? ' specializing in apparel' : ''}. Write a title for the ACTUAL product described below — never reframe it as something it is not. Output ONLY the final title string — no quotes, no markdown, no explanation.`,
    `Brand: ${brandName}
Category: ${category}
${designLine}${mustLine}${attrPinLine}${nicheLine}${upgradeLine}
Pre-filtered keyword candidates (already de-duplicated and seasonal-stripped — the title is capped at 75 chars, so ${apparel ? 'at most ONE beyond the mandatory keyword' : 'only 1-2 of these fit alongside the mandatory keyword; the rest rank via bullets/backend'}):
${candidateList}
${attrLine}${audienceLine}
Write ONE product title as NATURAL, readable language — NOT dash-separated sections.
${apparel
  ? `Write a clean, natural, DESIGN-LED title and TRUST your judgement. Start with the brand, then weld the design name DIRECTLY to the product type as ONE unbroken phrase — "${designName || 'Later Gator'} T-Shirt" — that exact phrase is the seller's #1 search keyword; never split it. AFTER it, write a SECOND keyword phrase built from the design's MAIN VISUAL SUBJECT + a product-type SYNONYM — e.g. "Alligator Shirt", "Cat Tee", "Skull Graphic Tee" — because "<subject> shirt/tee" is itself a high-volume search term; weave the garment brand in as a modifier ONLY if it fits the 75-char cap. 🚫 GROUND THE SUBJECT — never fabricate artwork: the visual subject MUST be something that literally appears in the design name "${designName || '<design>'}" or the title. If this is a TEXT/SLOGAN design with NO concrete object (e.g. a Gen X saying, a funny quote), do NOT invent an object/prop/motif (cassette, guitar, skull, dog, etc.) — build the second phrase from the slogan's THEME or a TONE word instead (e.g. "Funny Gen X Tee", "Sarcastic Saying Shirt"). Then, if it fits, you MAY end with the audience — but it is OPTIONAL and lowest-priority; a higher-value product-specific keyphrase outranks it, so drop the audience rather than the keyphrase. TWO HARD RULES: (1) do NOT repeat the exact product-type word "T-Shirt" — the welded phrase already has it, so the second phrase uses a SYNONYM (Shirt / Tee / Graphic Tee) carrying the design subject; (2) do NOT pad with vague filler like "with Gator Art", "cool design", "fun graphic" — every char counts against 75. EXACT target shape (a DIFFERENT design — copy the SHAPE, not the words; it is exactly 75 chars): "THE CEO Later Gator T-Shirt, Comfort Colors Alligator Tee for Men and Women". For THIS product use: design name "${designName || '<design>'}"${attributePin ? `, garment brand "${attributePin}" (drop it first if over 75)` : ''}, design subject from the image, audience "${preferredAudience || 'Men and Women'}".`
  : `Order: ${brandName}, then the MANDATORY #1 keyword, then ${attributePin ? `the MANDATORY #2 blank-brand "${attributePin}", then an optional supporting keyphrase` : 'multiple supporting keyphrases/specs from above (fill the title)'}, then the audience only if budget remains (optional, lowest-priority).`} It should read like a human-written phrase.

Rules:
- ${apparel ? "LEAD with the brand, the design name, then the product type — design-led, NOT keyword-led. At ≤75 chars the WHOLE title shows on mobile." : 'FRONT-LOAD the mandatory keyword right after the brand — at ≤75 chars every word is prime real estate.'}
- Do NOT use " - " dashes or " | " pipes to separate sections — flow as natural language (a single comma is OK only if it genuinely reads better). Amazon indexes the title as a bag of words, so separators add nothing and only cost characters.
- ${apparel ? '50-75 characters — HARD CAP 75' : 'TARGET 60-75 characters — HARD CAP 75'} (Amazon's NEW limit, effective July 27, 2026: longer titles get AUTO-REWRITTEN by Amazon; overflow keyphrases belong in backend keywords and the Item Highlights field, NOT the title). Title Case. ONE consistent audience (never mix kids with men/women).
- ${apparel ? 'Use the product-type word ("shirt"/"tee"/"t-shirt") AT MOST TWICE in the WHOLE title. Do NOT append "Shirt" to every keyphrase (no "Comfort Colors Shirt Vintage 90s Shirt Cool T Shirts").' : 'Name the product type ONCE using the single clearest term — do NOT stack synonyms for the SAME product. If you write "Sticky Notes", do NOT also add "Post It Notes" / "Sticky Note" / another "Notes" phrase; pick the ONE clearest term and let the other synonyms live in the backend keywords. No noun may appear more than twice in the whole title (e.g. never "Notes ... Notes ... Notes"). Do NOT reframe the product as apparel / a t-shirt / "graphic tee" / clothing unless it genuinely is one. Keep the title BROAD: do NOT frame it around a single niche use-case or audience (e.g. "for Bible Study", "for Nurses", "for Teachers") — those narrow a general product and belong in the backend keywords + a bullet, NOT the title.'}
- ${apparel
  ? 'Include the searchable keyphrases above when they fit. Do NOT put dry product SPECS (material, fabric, fit, weight, dye) in the title — those are not search terms.'
  : 'Include the searchable keyphrases above. **Technical/feature identifiers that shoppers actually search for ARE search terms** — include them when in the candidate pool above (e.g. UHS-I, Class 10, Bluetooth 5.0, USB-C, IP68, speed ratings like "90MB/s", capacity like "256GB"). Only EXCLUDE dry physical specs shoppers do not search (raw inch dimensions, gram weights, internal model codes).'}
- 🚫 BRAND-NAME SAFETY (Amazon Jan 2025 policy — bare brand references SUPPRESS listings): If any keyword above is a third-party brand name (e.g. Canon, Nikon, Sony, GoPro, SanDisk, Kingston, Lexar, Samsung, Apple, iPhone, Galaxy, DJI, Bose, etc. — anything that isn't your own brand "${brandName}"), use it ONLY in 'for [Brand]' or 'compatible with [Brand]' phrasing. Examples: ✓ 'for GoPro Hero', ✓ 'compatible with Canon EOS', ✗ 'GoPro SD Card' (bare reference — listing gets suppressed). Same rule for model names (iPhone 14, DSLR camera brands, etc.).
- ${apparel ? '' : 'PREFER concrete keyphrases over filler descriptors. NEVER add empty marketing words like "Durable", "Reliable", "Solution", "Premium", "High-Quality", "Versatile", "Versatile Options" — every word should be either a search term, a real product attribute shoppers type, or an essential connector. If you have budget left, add another keyphrase from the candidate pool, not filler.'}${compatibilityBrands.length > 0 ? `
- 🟢 COMPATIBILITY (high-opportunity): the product genuinely works with these device brands and shoppers search for them. Weave the top 2-3 in using "Compatible with [Brand]" framing (NEVER bare): ${compatibilityBrands.join(', ')}. Example: "...Compatible with ${compatibilityBrands.slice(0, 2).join(' and ')}". This is legal referential use and captures real buyer traffic.` : ''}
- Must read like a human wrote it. Return ONLY the title.`,
  ]

  // COUNCIL (PO directive: big decisions DEBATE, not one agent). Apparel/design titles — where the
  // keyword-stuffing problem lives — run the 3-persona debate -> adversary -> judge over the SAME
  // brief. Non-apparel keeps the single fast agent (those titles already work). Either way the result
  // flows through the validate + deterministic backstops below, so the hard rules still hold.
  let title: string
  if (apparel) {
    title = await runTitleCouncil(openai, system, user, input.onProgress, { brandName, lean, maxLeftWords: input.poGolds?.shape.maxLeftWords ?? null, shape: input.poGolds?.shape ?? null, apparel })
  } else {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: 120,
    })
    title = (completion.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
  }
  let problems = title ? validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective) : ['No title generated.']
  let retried = false

  // Up to 2 corrective passes — the mandatory-keyword + max-2 rules are non-negotiable.
  for (let attempt = 0; attempt < 2 && title && problems.length > 0; attempt++) {
    retried = true
    const fix = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: `You are an Amazon SEO title editor${apparel ? ' for apparel' : ''}. Output ONLY the corrected title string.` },
        // The corrective-retry pipe ban was deleted with the V3 flip (retired 2026-08-03): it fought
        // every PO gold that uses ` | ` (6 of 8 golds). Non-pipe rules stay because they're safety,
        // not format opinions. See docs/title-council-v3-spec.md §5.3.
        { role: 'user', content: `Fix this title. Brand: ${brandName}\nTitle: ${title}\n\nProblems:\n- ${problems.join('\n- ')}\n\nWrite it as natural readable language: ${brandName} then ${mustInclude ? `the MANDATORY keyword "${mustInclude}"` : 'the top keyphrase'}${attributePin ? ` then the blank-brand "${attributePin}" if it fits` : ''} then ${apparel ? 'an optional supporting keyphrase if it fits' : 'ONE supporting keyphrase if it fits'}${preferredAudience ? ` then optionally "for ${preferredAudience}" if budget remains (lowest-priority — a product-specific keyphrase outranks it, so drop the audience rather than the keyphrase)` : ''}. Front-load the mandatory keyword. ${apparel ? '50-75 chars' : 'TARGET 60-75 chars'} — HARD CAP 75 (Amazon auto-rewrites longer titles after July 27, 2026; overflow keyphrases belong in backend keywords, not here). ${apparel ? 'Product-type word ("shirt"/"tee") used AT MOST twice total. ' : 'Name the product type once or twice; do NOT reframe it as apparel. Include technical search terms (UHS-I/Class N/USB-C/Bluetooth/MB-per-s/capacity/model identifiers) when present in the keyword pool — they ARE search terms. NO filler words ("Durable", "Reliable", "Solution", "Premium", "Versatile"). '}No seasonal terms. No dry physical specs shoppers don\\'t search.${apparel ? ' ONE audience.' : ''} Return ONLY the corrected title.` },
      ],
      temperature: 0.2,
      max_tokens: 120,
    })
    const corrected = (fix.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
    if (corrected) {
      const cp = validateTitle(corrected, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
      // Require a STRICT improvement (fewer problems) to replace — otherwise a same-count single-agent
      // rewrite could silently discard a clean, debated council title (adversarial review caught this).
      if (cp.length < problems.length) { title = corrected; problems = cp }
    }
  }

  // Compliance guarantee: brand must lead. ALWAYS prefix — the 75-char hard-cap backstop at the
  // end trims the TAIL, so adding the brand up front can never be the thing that gets cut.
  if (title && brandName && !title.toLowerCase().includes(brandName.toLowerCase())) {
    title = `${brandName} ${title}`.trim()
    problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
  }

  // The "for Men and Women" widen guard was deleted with the V3 flip (retired 2026-08-03): the PO
  // gold pattern says NEVER FORCE "for Men and Women" on a universal design — the council itself
  // decides, and if a design IS gender-specific the persona emits it. This resolves the documented
  // V2-brief-vs-widen-guard contradiction (FOUNDATION_SHIP_DOOR_PLAN.md §3.3).

  // 🛟 LLM brand-safety judge — final catch-net (PR #80, classified in #86).
  // piggyback brands → REMOVE; compatibility brands → ensure "Compatible with [Brand]"
  // framing (high-value, keep). Only rewrite when there's something to fix.
  try {
    const judged = await judgeBrandSafetyLLM(title, brandName, openai, `${brandName} ${category} ${repTitle ?? ''}`.trim())
    const piggyback = judged.detected.filter((d) => d.classification === 'piggyback')
    // Compatibility brand is a problem only when BARE (not already "compatible with X").
    const compatBare = judged.detected.filter((d) => d.classification === 'compatibility' && !isBrandProperlyFramed(title, d.phrase))
    if (piggyback.length > 0 || compatBare.length > 0) {
      const removeList = piggyback.map((d) => `"${d.phrase}"`).join(', ')
      const frameList = compatBare.map((d) => `"${d.phrase}"`).join(', ')
      const instructions = [
        piggyback.length > 0 ? `REMOVE these entirely (no functional tie to the product): ${removeList}.` : '',
        compatBare.length > 0 ? `KEEP these but wrap each in "Compatible with [Brand]" framing (the product genuinely works with them): ${frameList}.` : '',
      ].filter(Boolean).join(' ')
      const fix = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Rewrite the title. ${instructions} Keep the brand "${brandName}" and the mandatory keyword${mustInclude ? ` "${mustInclude}"` : ''}. 50-75 chars (HARD CAP 75). Return ONLY the title string, no quotes or markdown.` },
        ],
        temperature: 0.2,
        max_tokens: 120,
      })
      const corrected = (fix.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
      if (corrected && corrected.length <= 200) {
        title = corrected
        problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
      }
    }
  } catch { /* fail-open */ }

  // Deterministic backstop (apparel): the garment blank brand is an ATTRIBUTE, not a compatibility
  // target — strip any stray "for <blank brand>" the LLM produced ("Later Gator for Comfort Colors"
  // -> "Later Gator Comfort Colors"). The audience "for Men and Women" is untouched. Verified live wart.
  if (apparel && attributePin) {
    const pin = attributePin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const stripped = title.replace(new RegExp(`\\bfor\\s+(${pin})\\b`, 'i'), '$1').replace(/\s{2,}/g, ' ').trim()
    if (stripped !== title) {
      title = stripped
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
    }
  }

  // Deterministic backstop (all categories): kill a redundant gendered audience the LLM stacked on
  // top of the inclusive one ("for Women for Men and Women" → "for Men and Women"). The validator
  // flags the repeat but gpt-4.1-mini's retry couldn't clear it (verified live on B0G884ZJ27).
  {
    const tidied = dedupeAudiencePhrases(title)
    if (tidied && tidied !== title) {
      title = tidied
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
    }
  }

  // Deterministic backstop (apparel): never let the EXACT product-type word stutter — "Later Gator
  // T-Shirt, Comfort Colors T-Shirt" reads terribly (PO-flagged "THIS IS TERRIBLE"). The welded
  // "<design> T-Shirt" keeps its T-Shirt; every LATER identical "T-Shirt"/"Tshirt" is varied to "Tee"
  // so the product type is never repeated verbatim. A genuinely different second mention like
  // "Alligator Shirt" is untouched — only the exact-same word is de-stuttered.
  if (apparel) {
    let seenTee = 0
    const destuttered = title.replace(/\bt-?shirts?\b/gi, (m) => {
      seenTee++
      if (seenTee <= 1) return m
      return /s$/i.test(m) ? 'Tees' : 'Tee'
    })
    if (destuttered !== title) {
      title = destuttered.replace(/\s{2,}/g, ' ').trim()
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
    }
  }

  // Deterministic backstop (apparel, 2026-07-14, B0H7L6KNNX): never let the low-value DEPARTMENT word
  // "Unisex"/"Adult" split the money phrase from the product type — "…Cup Champions Unisex T-Shirt"
  // breaks the exact-match "Champions T-Shirt" the shopper searches AND burns ~7 chars. The council
  // writes "Unisex T-Shirt" (mirroring the blank), and the "weld design-name to product-type" rule is
  // advisory PROMPT text only, so nothing removes it. Strip "Unisex"/"Adult" sitting immediately BEFORE
  // the garment token — UNLESS it leads the title. SCOPED to these two: gendered/age words (Mens,
  // Womens, Girls, Boys, Kids) are real search keywords and are KEPT even if they split the phrase;
  // "Unisex"/"Adult" carry ~no search value and live in the Department attribute row anyway. The freed
  // chars feed the niche fill below.
  if (apparel) {
    const welded = title.replace(
      /\b(?:Unisex|Adult)\s+(?=(?:Graphic\s+)?(?:T-?Shirts?|Tees?|Shirts?|Hoodies?|Sweat\s?shirts?|Tanks?|Tops?)\b)/gi,
      (m, offset: number) => (offset === 0 ? m : ''),
    )
    if (welded !== title) {
      title = welded.replace(/\s{2,}/g, ' ').trim()
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
    }
  }

  // EXACT-WORD DE-DUP of the fill tail (2026-07-15, B0H7L6KNNX PO "no repeating words"). Placed HERE in
  // runTitleAgent (the function that actually produces the shipped recommended_title — proven by the
  // Unisex strip above landing) rather than in the buildTitleFor fill helper, which this regen path does
  // not use. The council pads the budget by repeating a design word after the product type ("…Champions
  // T-Shirt 2026 Tee Tshirt Gift"). Amazon indexes each word once, so a 2nd EXACT occurrence is pure
  // stuffing. De-dup only the tail AFTER the first product-type token (brand+design+type prefix is the
  // protected money phrase); same per-word alnum key on both sides; numbers counted; a different word for
  // one concept (Tshirt vs Tee) is kept.
  if (apparel) {
    const pt = title.match(/\b(?:t-?\s?shirts?|tshirts?|tees?|hoodies?|sweat\s?shirts?|tanks?|tops?)\b/i)
    if (pt && typeof pt.index === 'number') {
      const cut = pt.index + pt[0].length
      const prefix = title.slice(0, cut)
      const dk = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '')
      const seen = new Set(prefix.split(/\s+/).map(dk).filter(Boolean))
      const tail = title.slice(cut).split(/\s+/).filter((w) => {
        const k = dk(w)
        if (!k || k.length <= 2 || MINOR_WORDS.has(k)) return true
        if (seen.has(k)) return false
        seen.add(k); return true
      }).join(' ')
      const deduped = `${prefix} ${tail}`.replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim()
      if (deduped !== title) {
        title = deduped
        problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
      }
    }
  }

  // ── SHARED 70-75 HUMANIZER (single-design path-parity, 2026-07-18): the fix for the 61-char generic
  // regression (B0FKJW57H7). The ENFORCED 70-75 LLM extension used to live ONLY in buildNicheParentTitle
  // (multi-design); single-design ships THIS function's output with no humanizer, so a thin-pool listing
  // landed short + generic. Run the SAME shared humanizer with a single-design (design-LED) brief, BEFORE
  // the design-name-lead + Title-Case + HARD CAP below so they re-seat/re-case the extended title. Gated
  // on apparel + a short title; fail-open (a rejection is a no-op = no worse than before). Pool = the
  // design-niche seeds (now fed by the vision→universe wire) + the upgrade keywords.
  if (apparel && title.length < 68) {
    const aud = preferredAudience || 'Men and Women'
    // Flag ON → title-aware family display (HAT + "Snapback Cap" title → "Snapback Cap"); OFF → exact legacy.
    const ptWord = GARMENT_NOUN_ON
      ? garmentNounFor(productType, title).display
      : (/T_SHIRT|SHIRT|TEE/i.test(productType ?? '') ? 'Tee Shirt' : (productType ? productType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Shirt'))
    const nichePool = [...new Set([...(input.nicheSeeds || []), ...upgradeKws].map((s) => (s || '').trim()).filter(Boolean))]
    // V2 gold-pattern brief (2026-07-22; TITLE_QUALITY_V2 flag retired 2026-08-03 — live env was
    // 'on', unconditional fold is byte-identical): idiom expansion via titleIdiomExpander, Pattern A
    // (pipe) default, 8 golds as few-shot, modifier-stuffing ban, gender-conservative. This path is
    // already apparel-only (gate above).
    const displayDesignName = expandIdiomDesignName(designName)
    const isKnownIdiom = isIdiomDesign(designName)
    const [sdSystem, sdUser] = (() => {
      const audBlock = aud
        ? `AUDIENCE MODE: ${audienceMode}\nAudience: ${aud}\n// REQUIRED = keep the "for ${aud}" tail; trim from the right rather than pad. OPTIONAL = only if genuinely gender-specific.\n`
        : `AUDIENCE MODE: ${audienceMode}\n// Universal design — no audience tail unless the design itself is gender-specific. NEVER "for Men and Women".\n`
      const inputBlock = `Brand: ${brandName}
${attributePin ? `Garment brand (a selling point — the seller's tails carry it): ${attributePin}\n` : ''}Product type: ${ptWord}
${audBlock}Design phrase (identity — KEEP this exact phrase in the title): ${displayDesignName || '(none)'}${isKnownIdiom ? `\n  ↑ a known idiom/pun; the expansion above IS the source phrase — prefer it over the short tag when it fits the identity budget.` : ''}
${mustInclude ? `Mandatory keyword (KEEP verbatim — #1 search term): ${mustInclude}\n` : ''}Niche keyphrases (weave those that fit — occasion, subject, recipient): ${nichePool.slice(0, 10).join(' | ') || '(none)'}`
      const b = buildApparelTitleBrief({
        brandName,
        roleLine: `You write Amazon apparel titles for ${brandName}. This one is a SINGLE-DESIGN product title.`,
        inputBlock,
        poGolds: input.poGolds,
        designPhrase: displayDesignName || designName || null,
        garmentNoun: ptWord || null,
        lean,
      })
      return [b.system, b.user]
    })()
    const extended = await humanizeTitleTo75(openai, title, {
      baseSystem: sdSystem, baseUser: sdUser,
      pool: nichePool,
      brandName,
      postProcess: (raw) => capTitle75(scrubTrademarks(raw)),
      onProgress: input.onProgress,   // SSE keepalive parity with the parent call — the 1-2 gpt-5 extension calls must not run the stream silent (stream-idle-drop risk)
      v4Sink: input.__v4Sink,         // PATH PARITY: the single-design producer must report the same measurement as the parent one
      trigger: 68,
      label: 'Title',
      lean,   // Fix D: adopt-gate scores retry with the lean-aware dock so a rewrite can't silently drop the tail
      maxLeftWords: input.poGolds?.shape.maxLeftWords ?? null,
      shape: input.poGolds?.shape ?? null,
      apparel: true,   // this call sits inside the apparel-gated single-design arm
    })
    if (extended && extended !== title) {
      title = extended
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
    }
  }

  /* THE FEEL INJECTOR IS DELETED (2026-08-12, task #169).
   *
   * WHAT IT DID: on any apparel title under 50 characters it inserted one of
   * ['Soft','Comfy','Cozy','Cool'] in front of the garment brand, chosen by a hash of the design
   * name, purely to lift the length toward a band.
   *
   * WHY IT IS GONE, in four measured facts:
   *   1. NONE of the seller's nine gold titles contains any of those words.
   *   2. Neither ban list catches them, so nothing downstream could ever remove one.
   *   3. It was added 2026-06-09 to satisfy a then-live 80-char floor that has since been
   *      superseded TWICE — it outlived its own reason and nobody noticed.
   *   4. It was ARMED by this session's own fixes: the unconditional waste-vocabulary strip and the
   *      terminal spec-tail drop made sub-50-char titles common (the measured B0GVV3XL4T chain
   *      lands at 33-54), so a dormant hazard became a live one.
   *
   * It also violates the seller's 2026-08-12 ruling outright — "the floor refuses, it never pads"
   * — and the architecture's governing asymmetry: code may FILTER, never ADD. Every one of the five
   * titles the seller rejected was authored by an ADDITION, and this is an addition of words that
   * are not facts, not search terms, and not theirs.
   *
   * NOTHING REPLACES IT. A title that lands short is now a signal (thin keyword research), handled
   * by the ship gate, not a hole to be filled with adjectives. */
  // Deterministic backstop: the LLM keeps stacking product-type synonyms on keyword-heavy
  // non-apparel titles despite the prompt + candidate de-dup — so collapse them mechanically.
  if (!apparel) {
    const cleaned = collapseProductPhrases(title)
    if (cleaned && cleaned !== title && cleaned.length >= 40) {
      title = cleaned
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
    }
  }

  // ── Deterministic DESIGN-NAME LEAD — the reliability backbone. The design name must sit right
  // after the brand, but the validator-driven retry proved unreliable (verified live on B0G884ZJ27:
  // "Later Gator" intermittently vanished from the title). So mechanically guarantee it: insert it
  // after the brand when absent, or hoist it to the front when buried behind the paraphrase.
  if (designName && designName.trim()) {
    const dn = designName.trim()
    const bLc = brandName ? brandName.toLowerCase() : ''
    const bIdx = bLc ? title.toLowerCase().indexOf(bLc) : -1
    const afterBrand = bIdx >= 0 ? bIdx + brandName.length : 0
    // Apostrophe-tolerant find: the writer may render the name's apostrophe as ' / ’ or drop it
    // ("Darlin" / "Darlin’"). Detect any of those as the SAME name so we hoist/insert the canonical
    // form ("Darlin'") instead of duplicating it.
    const dnRe = (() => { try { return new RegExp(dn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]?"), 'i') } catch { return null } })()
    const dnM = dnRe ? title.match(dnRe) : null
    const dnIdx = dnM && dnM.index != null ? dnM.index : -1
    const dnLen = dnM ? dnM[0].length : dn.length
    let rebuilt = ''
    if (dnIdx === -1) {
      rebuilt = `${title.slice(0, afterBrand)} ${dn} ${title.slice(afterBrand)}`
    } else if (dnIdx > afterBrand + 8) {
      const without = `${title.slice(0, dnIdx)} ${title.slice(dnIdx + dnLen)}`.replace(/\s{2,}/g, ' ')
      const wbIdx = bLc ? without.toLowerCase().indexOf(bLc) : -1
      const wAfter = wbIdx >= 0 ? wbIdx + brandName.length : 0
      rebuilt = `${without.slice(0, wAfter)} ${dn} ${without.slice(wAfter)}`
    } else if (dnM && dnM[0] !== dn) {
      // Already leading, but a different apostrophe form ("Darlin" / "Darlin’") — normalize it in
      // place to the canonical "Darlin'" so the seller's exact design name shows.
      rebuilt = `${title.slice(0, dnIdx)}${dn}${title.slice(dnIdx + dnLen)}`
    }
    rebuilt = rebuilt.replace(/\s{2,}/g, ' ').trim()
    if (rebuilt && rebuilt !== title && rebuilt.length <= 200) {
      title = rebuilt
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
    }
  }

  // ── Title-Case backstop — gpt-4.1-mini occasionally returns an all-lowercase title (verified live).
  // Capitalize each word, preserving existing ALL-CAPS tokens (brand/acronyms: THE CEO, USB, GB) and
  // keeping minor connecting words lowercase.
  {
    const MINOR = new Set(['and', 'or', 'the', 'for', 'a', 'an', 'of', 'to', 'in', 'with', 'on', 'at', 'by'])
    title = title.split(/\s+/).map((w, i) => {
      if (w.length > 1 && w === w.toUpperCase()) return w
      const lw = w.toLowerCase()
      if (i > 0 && MINOR.has(lw)) return lw
      return w.charAt(0).toUpperCase() + w.slice(1)
    }).join(' ')
    // Repair tech acronyms the Title-Case pass can mangle when the LLM emitted them lowercase
    // ("Sd Card", "Usb-c", "Uhs-i", "128gb") — these are search identifiers and must read right.
    title = title
      .replace(/\b(\d+)\s?[Gg][Bb]\b/g, '$1GB')
      .replace(/\b(\d+)\s?[Tt][Bb]\b/g, '$1TB')
      .replace(/\bSd\b/g, 'SD').replace(/\bUsb\b/g, 'USB').replace(/\bUhs\b/g, 'UHS').replace(/\bHd\b/g, 'HD')
    // Re-snap the design name's canonical casing (B0DMXMH266 fix): the minor-word rule above
    // lowercases a design name's leading article mid-title — "A Day Without Fishing" rendered as
    // "a Day Without Fishing". The seller's design name must show verbatim; same apostrophe-tolerant
    // match as the design-name lead block, replacement via callback so "$" in a name stays literal.
    if (designName && designName.trim()) {
      const dn = designName.trim()
      const re = (() => { try { return new RegExp(dn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]?"), 'i') } catch { return null } })()
      if (re) title = title.replace(re, () => dn)
    }
  }

  // ── HARD CAP 75 — the last gate before the title leaves the agent (Amazon auto-rewrites longer
  // titles from July 27, 2026). Everything valuable is front-loaded by now; capTitle75 trims the
  // tail at a word boundary and never leaves a narrowed audience fragment.
  if (title.length > 75) {
    title = capTitle75(title)
    problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName, season.effective)
  }

  return { title, problems, retried }
}

// ─── Stage 2 — Bullets Agent ───────────────────────────────────────────────────

async function runBulletsAgent(
  input: PipelineInput,
  finalTitle: string,
  remaining: AnalyzedKeyword[],
  attributes: string[],
  /** Top opportunity keywords (CRITICAL ∪ UPGRADE) the bullets MUST cover. Passed to the
   *  validation retry below — if 3+ are missing across all bullets, the corrective prompt
   *  fires with the missing list. Same contract as runTitleAgent's upgradeKws. */
  opportunityKws: string[] = [],
  /** Capacity tokens across the family (e.g. ['32GB','64GB','128GB']). When ≥2 distinct
   *  capacities, the validator rejects any hardcoded capacity in a broadcast bullet
   *  (PR #76 fix for B0GCF11RKL "this 128 GB SD card" bug). */
  capacityFamilyTokens: string[] = [],
  /** High-IQ compatibility device brands to weave in as 'Compatible with [Brand]'.
   *  PR #87 — proactively seed (title already does; bullets/desc now match). */
  compatibilityBrands: string[] = [],
  /** Seller's DESIGN/SLOGAN name ("Later Gator") — must appear in >=1 bullet (the same identity mandate
   *  the title + backend enforce). The deterministic backstop guarantees it lands. */
  designName = '',
): Promise<string[]> {
  const { openai, brandName, category, repTitle, children, productType } = input
  const apparel = looksApparel(category, repTitle, productType)
  // The seller's DESIGN/SLOGAN name ("Later Gator") is an identity keyphrase the bullets MUST carry (the
  // title + backend already enforce it — #91/#92). Prepend it to the scored opportunity set so it LEADS the
  // council brief and is guaranteed by the deterministic backstop (parity with the title design-name lead).
  const dn = (designName || '').trim()
  // TRADEMARK PRE-FILTER (Approach B) — substitute protected marks to safe phrasing and drop residual
  // franchise/team marks from the bullets opportunity pool AT CONSTRUCTION, so EVERY downstream consumer
  // (the council brief, requiredKws, the missing-keyword retry, and validateBullets) reads the SAME safe
  // pool. If only the brief were scrubbed, the retry/validator would endlessly demand a term ("World Cup")
  // the scrubbed brief no longer contains. The design name LEADS and is substitute-only (never dropped —
  // the identity mandate requires it in >=1 bullet).
  const tmSafeBullet = (kw: string): string | null => {
    const s = scrubTrademarks(kw)
    return findTrademarkPhrases(s).length > 0 ? null : s
  }
  // Layer-1 variant dedupe (council 2026-07-03): collapse permuted/garment-synonym duplicates so the
  // brief, requiredKws, and the deterministic backstop never see three phrasings of one noun. The
  // design name LEADS and is index 0, so keeping-first preserves the identity mandate.
  const oppPlusDesign = dedupeBulletVariants(dn
    ? [scrubTrademarks(dn), ...opportunityKws.filter((k) => k.toLowerCase() !== dn.toLowerCase()).map(tmSafeBullet).filter((s): s is string => s !== null)]
    : opportunityKws.map(tmSafeBullet).filter((s): s is string => s !== null))
  // (`opportunityKwsSafe` removed 2026-08-10 with the missing-keyword retry it fed. It existed so the
  //  validator read the same trademark-SAFE pool as the brief — scrub-only marks like world cup ->
  //  world soccer cup survive tmSafeBullet's drop-gate, so validating bullets against the RAW pool
  //  flagged them as permanently missing and fired retries that pressured re-introducing the mark.
  //  With bullets carrying no coverage duty there is no such validator, so the workaround is moot.)
  // G4 — GIFT & OCCASION audience pool. Role/audience keywords are (correctly) excluded from
  // every other pool as product-identity claims, but they ARE legitimate gift framings
  // ("great gift for teachers") — the one compliant home for these search words in customer
  // copy. Read from RAW input.analysis (the relevance gate + plan filters strip exactly these,
  // same reason compatibilityBrands reads raw), top distinct audience words by opportunity.
  const giftAudiences: string[] = []
  if (apparel) {
    const seenAud = new Set<string>()
    const rankedKw = [...input.analysis].sort((a, b) => (b.coverageGapScore || 0) - (a.coverageGapScore || 0))
    for (const k of rankedKw) {
      for (const w of k.keyword.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        if (AUDIENCE_GIFT_WORDS.has(w) && !seenAud.has(w)) { seenAud.add(w); giftAudiences.push(w) }
      }
      if (giftAudiences.length >= 4) break
    }
  }
  // Capacity family detection: do any 2 children carry different capacity tokens in their SKUs?
  // If yes, the SHARED bullets must NOT hardcode a specific GB value — each variant's title
  // carries its own capacity; shared bullets that say "128GB" mislead the 32GB and 64GB rows.
  const childCaps = new Set<string>()
  for (const c of children) { const cap = capacityOf(c.sku) || capacityOf(c.title); if (cap) childCaps.add(cap) }
  const capacityFamily = !apparel && childCaps.size >= 2
  const familyCapList = [...childCaps].join(', ')
  // HARD-REQUIRE the SCORED opportunity set (exactly what the scorer + validator check) — the old brief
  // only required 3 from a DIFFERENT list, which is why bullets stalled at 9/18. Lead the top 3; cover the
  // rest somewhere across the 5 bullets. The validate-retry loop + deterministic backstop drive it home.
  const remainingSafe = remaining.slice(0, 8).map((k) => tmSafeBullet(k.keyword)).filter((s): s is string => s !== null)
  const requiredKws = (oppPlusDesign.length ? oppPlusDesign : remainingSafe).slice(0, 8)
  const kwList = remainingSafe.map((k) => `  - "${k}"`).join('\n')
  const topLine = requiredKws.length
    ? `\n🔴 REQUIRED SEARCH KEYPHRASES — these are EXACTLY what your bullet ranking is scored on. Coverage is by WORD, not by phrase: each phrase's key words must appear SOMEWHERE across the 5 bullets, but they can be SPREAD across different bullets and different sentences — the full phrase does NOT need to appear contiguously, and paraphrasing is fine. 🚫 NEVER cram a whole multi-word search string into one sentence (e.g. "channel the haitian soccer jersey world soccer cup 2026 aesthetic") — that reads as keyword soup and looks spammy. Instead let the words land where they fit naturally (e.g. "...haitian pride graphic tee..." in one bullet, "...ready for the 2026 world soccer cup..." in another). LEAD bullets 1, 2, 3 with the top three themes. Cover EVERY phrase that fits accurately:\n${requiredKws.map((k) => `  - "${k}"`).join('\n')}\n`
    : ''
  // Rank context for the council — SEPARATE from the required strings above (those are verbatim
  // machine-checked; annotating them would break coverage validation). Striking distance (#11-30)
  // = stronger bullet coverage moves rank fastest; top-10 = defend what's working.
  const rankedCtx = remaining
    .filter((k) => k.organicRank != null)
    // Trademark-safe (Approach B): substitute marks + drop residual franchise marks so a scrub-only
    // term ("world cup 2026 jersey") never surfaces into the council's context line unscrubbed.
    .map((k) => ({ kw: scrubTrademarks(k.keyword), rank: k.organicRank as number }))
    .filter((k) => findTrademarkPhrases(k.kw).length === 0)
    .slice(0, 8)
    .map((k) => `"${k.kw}" #${k.rank}${k.rank >= 11 && k.rank <= 30 ? ' (striking distance)' : k.rank <= 10 ? ' (defend)' : ''}`)
    .join(', ')
  const rankLine = rankedCtx
    ? `\nCURRENT ORGANIC RANKS (context, not extra requirements — prioritize natural, leading coverage for striking-distance terms): ${rankedCtx}\n`
    : ''
  const attrLine = attributes.length
    ? `\nKNOWN PRODUCT ATTRIBUTES — real product facts; mention ${apparel ? 'the garment brand and material' : 'the key specs'} in ONE bullet${apparel ? ' (e.g. "comfort colors", "ring-spun cotton")' : ''}. Do NOT let specs crowd out the top keyphrases above:\n  ${attributes.join(', ')}\n`
    : ''
  // Widow-format wearer-POV note — 2026-07-13 REGRESSION FIX: the previous multi-line FORBIDDEN block
  // caused the LLM to over-correct — it produced only 4 bullets and dropped the design name + top
  // opportunity keywords (B0FRYMM56C bullet_score fell from 18/18 to 8/18 after regen). Replaced with
  // a single tight sentence, moved AFTER the ACCURACY block so keyword coverage rules dominate. The
  // rich FORBIDDEN/ALLOWED block still fires in DESCRIPTION generation via widowFormatRule() (that
  // path handled it well). No-op on non-widow listings.
  const widow = detectWidowFormat(finalTitle, repTitle)
  const widowNote = widow.isWidowFormat
    ? `\n🚫 POV NOTE — "${widow.hobby} ${widow.spouseWord}" is a compound noun: the wearer is the SPOUSE of a ${widow.hobby} enthusiast, NOT the enthusiast herself. Never write "${widow.hobby}-loving" or imply SHE plays/loves ${widow.hobby}; framings like "for the ${widow.hobby} ${widow.spouseWord}" or "for wives whose husbands are always ${widow.hobby === 'golf' ? 'golfing' : widow.hobby}" are correct. This is ONE consideration among many — you STILL owe 5 bullets covering the REQUIRED search keyphrases, the garment brand once, and the design name.`
    : ''

  const system = `You are an Amazon SEO copywriter${apparel ? ' for apparel' : ''}. Return ONLY valid JSON: {"bullets": ["b1","b2","b3","b4","b5"]}. Accuracy to the actual product is non-negotiable — never invent an audience, profession, occasion, or product type the product is not explicitly about.`
  const user = `The title is FINAL (do not change it): "${finalTitle}"

🚫 ACCURACY IS THE #1 RULE — violating it is a failure:
- ${apparel ? 'This is a GRAPHIC TEE; its design is ONLY what the title above says.' : 'This product is EXACTLY what the title above describes — do NOT reframe it as apparel, a t-shirt, "graphic tee", clothing, or "fashion" unless the title literally says so.'} Do NOT claim it is FOR a profession, role, or audience not explicitly named in the title. NEVER write "teacher", "nurse", "mom", "dad", "coach", "student", "educator", "boss", or any job/role word unless that exact word is in the title.${giftAudiences.length > 0 ? ' ONE EXCEPTION — GIFT FRAMING: inside an explicit gift phrase ("great gift for teachers, nurses…") these audience words ARE allowed: a gift suggestion is a use-case, not a product-identity claim. The exception applies ONLY to the dedicated gift bullet described below.' : ''}
- A keyword being in the candidate list does NOT make it usable — SKIP any keyword that forces an inaccurate or awkward claim. Fewer-but-accurate beats more-but-wrong.
- Before returning, RE-READ each bullet: if any implies the product is for a specific job/role/occasion NOT named in the title — or reframes it as a product type it is not — REWRITE it to describe the actual product instead.
${widowNote}${topLine}${rankLine}
These are ADDITIONAL candidate keywords you MAY weave into the bullet body text (not the hook) — only when they fit naturally and accurately:
${kwList || '  (none — focus on benefits)'}
${attrLine}
- Never stuff a long-tail phrase (e.g. "later gator after while crocodile shirt") verbatim if it reads unnaturally — paraphrase or skip it.
- 🚫 BRAND-NAME SAFETY (Amazon Jan 2025 policy, Q4 2025 enforcement): If any candidate keyword above is a third-party brand name (Canon, Nikon, Sony, GoPro, SanDisk, Kingston, Lexar, Samsung, Apple, iPhone, DJI, Bose, etc. — anything that isn't your own brand), use it ONLY in 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]' phrasing. Examples: ✓ 'Compatible with GoPro Hero 11', ✗ 'Sandisk Standard Speed'. Bare third-party brand references in bullets risk listing suppression and trademark complaints. Same rule for model names (iPhone 14, EOS R5, etc.).

Rules per bullet:
- Start with a 2-3 WORD BENEFIT HOOK in ALL CAPS, then " - ", then the benefit sentence.
- AUDIENCE MATCH: do NOT mention kids, children, toddlers, youth, boys, or girls unless the title says so — match the title's audience exactly (an adult "for Men and Women" listing must NOT reference kids).${apparel ? `
- 🚫 FIT IS NOT GENDERED: the blank (e.g. Comfort Colors, Bella Canvas, Gildan) is a UNISEX relaxed-fit garment. NEVER claim a "womens fit", "mens fit", "womens style", or "mens cut" — that fabricates a gender the garment doesn't have. Describe the FIT neutrally ("relaxed fit", "classic unisex fit", "easygoing cut"). You MAY still target the buyer audience ("for women", "great gift for her") — that's marketing, not a fit claim.` : ''}
- NO PHRASE OVERUSE: do NOT repeat any single brand or material name (e.g. "Comfort Colors", "ring-spun", "garment-dyed") more than TWICE across the 5 bullets — vary the wording. And NEVER include misspellings (e.g. "confort colors") in customer-facing bullets — spell every word correctly.
- The hook is a benefit (e.g. RETRO STYLE VIBES), NOT a keyword phrase.
- ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} characters each. Generic for ALL variants (no specific size/color).${capacityFamily ? `
- 🚫 CAPACITY: this family has MULTIPLE capacities (${familyCapList}) — each variant carries its own GB in its own TITLE. The bullets are SHARED across all variants. NEVER hardcode a specific capacity value (e.g. "128GB SD card", "128GB and 64GB capacities"). Use capacity-agnostic phrasing ("ample capacity", "available in multiple capacities", "high-capacity storage") instead. If a candidate keyword contains a specific GB number, paraphrase it without that number, or skip it.` : ''}
- Bullets 1-3 carry the top keyphrases; bullets 4-5 may focus on ${apparel ? 'material/comfort/care/gifting' : 'features/quality/use/gifting'}.${compatibilityBrands.length > 0 ? `
- 🟢 COMPATIBILITY (high-opportunity): the product genuinely works with these device brands shoppers search for. Devote ONE bullet to compatibility using "Compatible with [Brand]" framing (NEVER bare): ${compatibilityBrands.join(', ')}. Example hook: "WIDE COMPATIBILITY - Compatible with ${compatibilityBrands.slice(0, 2).join(' and ')} cameras and more...".` : ''}${giftAudiences.length > 0 ? `
- 🎁 GIFT & OCCASION (bullet 5): devote the LAST bullet to gifting, framed STRICTLY as a gift suggestion — e.g. "PERFECT GIFT - Great gift for ${giftAudiences.slice(0, 3).join(', ')} and anyone who loves the design…". Use these audience words shoppers actually search: ${giftAudiences.join(', ')}. NEVER claim the product IS a ${giftAudiences[0]} item — only that it makes a great gift for them. Keep it truthful to the design.` : ''}
Return ONLY the JSON object.`

  // Bullets COUNCIL for apparel (the 18% >=15% rank-factor field). The bullet score's biggest lever is
  // opportunity-keyword COVERAGE (-12 max), so apparel runs 3 proposers -> GPT-5 adversary -> GPT-5 judge
  // to maximize legitimate coverage, mirroring the title council. Output still flows the role-leak guard
  // + validateBullets retry below, so it's additive (fails open). Non-apparel keeps the single fast call.
  let bullets: string[]
  if (apparel) {
    bullets = await runBulletsCouncil(openai, system, user, input.onProgress)
  } else {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.4,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
    })
    const parsed = parseJsonLoose<{ bullets?: string[] }>(completion.choices[0]?.message?.content || '{}')
    bullets = Array.isArray(parsed.bullets) ? parsed.bullets.filter((b) => typeof b === 'string').map((b) => b.trim()).filter(Boolean).slice(0, 5) : []
  }

  // Deterministic role-leak guard. The prompt forbids profession claims, but gpt-4.1-mini
  // occasionally slips ("PLAYFUL TEACHER VIBE"). Detect role words not in the title, retry
  // once with a pointed correction, then strip any residual role tokens as a hard backstop.
  const titleWords = new Set(finalTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))
  // G4 — gift-framed audience words are NOT leaks: "great gift for teachers, nurses…" is a
  // gift suggestion (a use-case), not a product-identity claim. Mask explicit gift clauses
  // BEFORE leak-scanning so the dedicated gift bullet survives while bare role claims
  // ("PLAYFUL TEACHER VIBE") are still caught and stripped.
  const GIFT_CLAUSE_RE = /\bgifts?(?:\s+ideas?)?\s+for\s+[^.;:!?]{0,90}/gi
  const maskGiftClauses = (s: string): string => s.replace(GIFT_CLAUSE_RE, ' ')
  const leakedRoles = (bs: string[]): string[] => {
    const found = new Set<string>()
    for (const b of bs) for (const w of maskGiftClauses(b).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
      if (ROLE_WORDS.has(w) && !titleWords.has(w)) found.add(w)
    }
    return [...found]
  }
  let leaked = leakedRoles(bullets)
  if (leaked.length > 0) {
    try {
      const fix = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Your previous bullets WRONGLY implied this product is for: ${leaked.join(', ')}. It is NOT — it is "${finalTitle}". Rewrite ALL 5 bullets describing ONLY the actual product; NEVER use the words ${leaked.join(', ')} or any profession/role word${giftAudiences.length > 0 ? ' EXCEPT inside an explicit gift phrase ("great gift for …") — the dedicated gift bullet is CORRECT, keep it' : ''}. Return ONLY {"bullets":["b1","b2","b3","b4","b5"]}.` },
        ],
        temperature: 0.3,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      })
      const reparsed = parseJsonLoose<{ bullets?: string[] }>(fix.choices[0]?.message?.content || '{}')
      const rb = Array.isArray(reparsed.bullets) ? reparsed.bullets.filter((b) => typeof b === 'string').map((b) => b.trim()).filter(Boolean).slice(0, 5) : []
      if (rb.length > 0 && leakedRoles(rb).length < leaked.length) { bullets = rb; leaked = leakedRoles(rb) }
    } catch { /* keep best-so-far */ }
  }
  if (leaked.length > 0) {
    // Hard backstop: remove residual role tokens (rare) — drops the bad word, keeps the
    // sentence. Gift clauses are preserved verbatim (leakedRoles masked them, so `leaked`
    // only contains words found OUTSIDE gift framing — strip outside-only to match).
    const roleRe = new RegExp(`\\b(?:${leaked.join('|')})\\b`, 'gi')
    bullets = bullets.map((b) => {
      const parts: string[] = []
      let last = 0
      GIFT_CLAUSE_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = GIFT_CLAUSE_RE.exec(b))) {
        parts.push(b.slice(last, m.index).replace(roleRe, ''))
        parts.push(m[0])
        last = m.index + m[0].length
      }
      parts.push(b.slice(last).replace(roleRe, ''))
      return parts.join('').replace(/\s{2,}/g, ' ').replace(/\s+([.,!])/g, '$1').trim()
    })
  }

  // ── Brand-safety + length + opportunity coverage retry (validateBullets) ─────
  // Same shape as runTitleAgent's corrective loop in PR #73/#74: up to 2 attempts. The
  // role-leak guard above runs first because its check is cheap and deterministic; this
  // pass costs one more LLM call only when validateBullets actually finds problems.
  if (bullets.length > 0 && brandName) {
    let bProblems = validateBullets(bullets, brandName, capacityFamilyTokens)
    for (let attempt = 0; attempt < 2 && bProblems.length > 0; attempt++) {
      try {
        const capacityClause = capacityFamilyTokens.length >= 2
          ? `\n- 🚫 CAPACITY: this family has multiple capacities (${capacityFamilyTokens.join(', ')}). The bullets are SHARED across all variants — NEVER hardcode a specific GB number ("128GB", "this 128 GB SD card"). Use capacity-agnostic phrasing only.`
          : ''
        const fix = await openai.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Rewrite ALL 5 bullets to fix these problems. The product is "${finalTitle}" — describe ONLY that.

Problems:
- ${bProblems.join('\n- ')}

Rules to honor on rewrite:
- Each bullet ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} chars, starting with a 2-3 word BENEFIT HOOK in ALL CAPS then " - ". The hook is a real BENEFIT ("HIGH-SPEED PERFORMANCE", "DURABLE DESIGN") — never a pipeline label like "CRITICAL UPGRADE" or "KEYWORD".
- Any third-party brand name (Canon/Nikon/Sony/GoPro/SanDisk/Kingston/Lexar/Samsung/Apple/iPhone/DJI/Bose etc. — anything not "${brandName}") appears ONLY as 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]'.${capacityClause}
- Weave in any missing opportunity keywords listed above where they fit naturally.
Return ONLY {"bullets":["b1","b2","b3","b4","b5"]}.` },
          ],
          temperature: 0.3,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
        })
        const fp = parseJsonLoose<{ bullets?: string[] }>(fix.choices[0]?.message?.content || '{}')
        const fb = Array.isArray(fp.bullets) ? fp.bullets.filter((b) => typeof b === 'string').map((b) => b.trim()).filter(Boolean).slice(0, 5) : []
        if (fb.length === 0) break
        const fbProblems = validateBullets(fb, brandName, capacityFamilyTokens)
        // Accept criteria (PR #79 strictened after live audit found the loose count-only
        // check kept original bullets when rewrite traded one issue type for another):
        //   - take the rewrite when total count drops, OR
        //   - take the rewrite when CRITICAL-class problems (suppression / trademark /
        //     capacity-family) strictly decrease — even at the cost of more lower-tier
        //     issues (length, hook). Critical violations are the seller-visible legal
        //     risk; lower-tier are polish.
        const criticalCount = (ps: string[]) => ps.filter((p) =>
          /LISTING-SUPPRESSION|TRADEMARK INFRINGEMENT|CAPACITY-FAMILY VIOLATION/.test(p)
        ).length
        const prevCrit = criticalCount(bProblems)
        const newCrit = criticalCount(fbProblems)
        if (newCrit < prevCrit || (newCrit === prevCrit && fbProblems.length < bProblems.length)) {
          bullets = fb; bProblems = fbProblems
        } else break
      } catch { break /* keep best-so-far */ }
    }

    // 🛟 Programmatic capacity backstop (PR #79). The agent retry sometimes keeps a "this
    // 128 GB SD card" string in a broadcast bullet (live-verified on B0GCF11RKL bullet 3
    // even after the validator flagged it). If capacity tokens are still present after
    // the retry, strip them deterministically — better awkward phrasing than a 32GB
    // shopper reading "this 128 GB SD card" on their PDP.
    if (capacityFamilyTokens.length >= 2) {
      const capRe = /\b\d{1,4}\s?(?:GB|TB|MB)\b/gi
      bullets = bullets.map((b) =>
        b
          // Strip "this <N>GB <noun>" → "this <noun>" (common pattern).
          .replace(/\bthis\s+\d{1,4}\s?(?:GB|TB|MB)\s+/gi, 'this ')
          // Any other "<N>GB sd card alternative" → "sd card alternative".
          .replace(/\b\d{1,4}\s?(?:GB|TB|MB)\s+(sd\s+card|memory\s+card|micro\s*sd)/gi, '$1')
          // Catch-all: any remaining capacity token → "ample capacity".
          .replace(capRe, 'ample capacity')
          // Tidy double spaces left behind.
          .replace(/\s{2,}/g, ' ')
          .trim()
      )
    }

    // 🛟 Role-leak final pass (PR #79). The pre-validation role-leak strip runs once
    // before the brand-safety/coverage retry loop; the retry can REINTRODUCE role
    // words (live-verified: bullet 2 of B0G884ZJ27 said "later gator teacher shirt"
    // after the brand retry). Strip any residual role words against the final title.
    {
      const finalTitleWords = new Set(finalTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))
      const residual = new Set<string>()
      for (const b of bullets) for (const w of b.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        if (ROLE_WORDS.has(w) && !finalTitleWords.has(w)) residual.add(w)
      }
      if (residual.size > 0) {
        const roleRe = new RegExp(`\\b(?:${[...residual].join('|')})\\b`, 'gi')
        bullets = bullets.map((b) => b.replace(roleRe, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,!])/g, '$1').trim())
      }
    }

    // 🛟 LLM brand-safety judge — final catch-net (PR #80, hybrid with curated list).
    // After all deterministic checks pass, an LLM judges the bullets for third-party
    // brand/trademark refs the curated TRADEMARK_PHRASES list can't enumerate
    // (Ripcurl, Homelander, Spaceballs, Iration etc. — all live-verified leaks on
    // B0G884ZJ27). One corrective rewrite if flagged; fail-open on LLM error.
    try {
      const joined = bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')
      const judged = await judgeBrandSafetyLLM(joined, brandName, openai, finalTitle)
      const piggyback = judged.detected.filter((d) => d.classification === 'piggyback')
      const compatBare = judged.detected.filter((d) => d.classification === 'compatibility' && !isBrandProperlyFramed(joined, d.phrase))
      if (piggyback.length > 0 || compatBare.length > 0) {
        const removeList = piggyback.map((d) => `"${d.phrase}"`).join(', ')
        const frameList = compatBare.map((d) => `"${d.phrase}"`).join(', ')
        const instructions = [
          piggyback.length > 0 ? `REMOVE these entirely (no functional tie): ${removeList} — replace with generic descriptors (e.g. "Ripcurl design" → "bold graphic design").` : '',
          compatBare.length > 0 ? `KEEP these but frame each as "Compatible with [Brand]" (the product genuinely works with them): ${frameList}.` : '',
        ].filter(Boolean).join(' ')
        const fix = await openai.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Rewrite ALL 5 bullets. ${instructions} The product is "${finalTitle}" — describe ONLY that. Keep the 2-3 word ALL-CAPS BENEFIT HOOK + " - " format. Each bullet ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} chars. Return ONLY {"bullets":["b1","b2","b3","b4","b5"]}.` },
          ],
          temperature: 0.3,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
        })
        const fp = parseJsonLoose<{ bullets?: string[] }>(fix.choices[0]?.message?.content || '{}')
        const fb = Array.isArray(fp.bullets) ? fp.bullets.filter((b) => typeof b === 'string').map((b) => b.trim()).filter(Boolean).slice(0, 5) : []
        if (fb.length === 5) bullets = fb
      }
    } catch { /* fail-open — keep best-so-far */ }
  }

  // 🛟 DETERMINISTIC COVERAGE BACKSTOP — guarantees the scorer's opportunity keywords (+ the design name)
  // land in the bullets even when the LLM council/retry stalls. The title has the same design-name floor;
  // bullets had only best-effort coverage and NO deterministic floor, which is exactly why they dead-ended
  // at 9/18. Runs LAST — after the brand-safety judge — so nothing downstream can strip a freshly-woven
  // token. Because nothing re-validates after it, safeKw() must itself enforce EVERY invariant the upstream
  // passes do (it does NOT just trust the relevance gate — adversarial review caught a bare-brand hole here):
  //   • drop all-stopword phrases — nothing real to weave (would otherwise append a meaningless tail forever);
  //   • reject any capacity-token keyword in a capacity family (broadcast bullets must stay GB-agnostic);
  //   • reject any keyword carrying a role/profession word not in the title (the documented teacher-leak);
  //   • reject any keyword that introduces an UNFRAMED third-party brand / trademark — a verbatim append
  //     can't add the required 'for [Brand]' framing, so weaving it would be a listing-suppression risk
  //     (this is the exact check validateBullets enforces; the backstop runs after it, so it must repeat it).
  // It appends at most ONE short clause per bullet (no keyword-soup), to the shortest bullet with room under
  // the 200-char cap. SOFT SPOT (not an absolute guarantee): if every bullet is maxed, a keyword is dropped.
  // STEP 2 (content-quality foundational, PO-approved 2026-07-07): the deterministic backstop now weaves
  // ONLY the DESIGN-NAME floor (the identity mandate — the design must appear in >=1 bullet), NOT the
  // opportunity keywords. Bolting raw opportunity tokens onto finished bullets was the keyword-stuffing +
  // bad-grammar source ("…complements vintage graphic tees for women and vintage tshirts for women…").
  // Opportunity coverage belongs in the BACKEND keyword field (shopper-invisible), where those keywords
  // already live — moving it out of prose loses no ranking. The council + the now-enforcing coherence gate
  // own the bullets. (Design name is oppPlusDesign[0]; it LEADS after dedupeBulletVariants.)
  const bulletCoverageFloor = dn ? oppPlusDesign.slice(0, 1) : []
  if (bullets.length > 0 && bulletCoverageFloor.length > 0) {
    const capFamily = capacityFamilyTokens.length >= 2
    const capRe = /\b\d{1,4}\s?(?:GB|TB|MB)\b/i
    const ownBrand = ownBrandTokenSet(brandName || '')
    const safeKw = (kw: string): boolean => {
      if (bulletTokens(kw).length === 0) return false                        // all-stopword phrase — nothing to weave
      if (capFamily && capRe.test(kw)) return false                          // capacity token in a capacity family
      const toks = kw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
      if (toks.some((t) => ROLE_WORDS.has(t) && !titleWords.has(t))) return false  // role/profession leak
      if (findThirdPartyBrands(kw, ownBrand).length > 0) return false        // unframed third-party brand
      if (findTrademarkPhrases(kw).length > 0) return false                  // trademark / franchise phrase
      return true
    }
    const usedBullet = new Set<number>()   // at most one appended clause per bullet — prevents keyword-soup
    for (const kw of missingBulletKeywords(bullets, bulletCoverageFloor)) {
      if (!safeKw(kw)) continue
      // Weave only the STILL-MISSING significant tokens, not the whole phrase. Coverage is token-based,
      // so appending the literal long-tail string verbatim ("…, haitian soccer jersey world cup 2026.")
      // was pure keyword-soup when most of its words were already present. The minimal missing fragment
      // satisfies the scorer just as well and reads far less spammy. (clause ⊆ kw, so the safeKw(kw) pass
      // above already covers it — a subset can't introduce a role/brand/trademark token kw didn't carry.)
      const have = new Set(bulletTokens(bullets.join(' ')))
      const clause = bulletTokens(kw).filter((t) => !have.has(t)).join(' ')
      if (clause.length === 0) continue // already covered by an earlier append
      // Weave into the SHORTEST not-yet-appended bullet that still has room for the clause under the 200 cap.
      let idx = -1, shortest = Infinity
      for (let i = 0; i < bullets.length; i++) {
        if (usedBullet.has(i)) continue
        const projected = bullets[i].replace(/[.\s]+$/, '').length + clause.length + 3 // ", " + trailing "."
        if (projected <= 200 && bullets[i].length < shortest) { shortest = bullets[i].length; idx = i }
      }
      if (idx === -1) continue // every bullet is maxed or already used — drop this kw (the acknowledged soft spot)
      bullets[idx] = `${bullets[idx].replace(/[.\s]+$/, '')}, ${clause}.`
      usedBullet.add(idx)
    }
  }

  // ── FINAL READABILITY PASS (PO 2026-06-17): the deterministic backstop above guarantees keyword
  // COVERAGE but can leave clumsy raw-token appends (", costume.", ", womens.", ", 100 days.") and the
  // council can over-jam keyphrases ("This gators shirt men and women love"). One LLM pass rewrites the
  // 5 bullets to read naturally while KEEPING coverage. Accept the rewrite ONLY if it (a) returns the
  // same bullet count, each <=200 chars, (b) covers the keyphrases AT LEAST as well (no scorer
  // regression), and (c) adds no NEW unframed third-party brand. Else keep the deterministic bullets —
  // so this can only ever IMPROVE readability, never regress coverage or safety. Best-effort.
  // STEP 2 (content-quality foundational): this pass is now QUALITY-FIRST, not coverage-preserving. It
  // AGGRESSIVELY strips keyword-stuffing (bolted-on comma-clauses of raw search terms, near-duplicate
  // keyword lists, dangling fragments) and is ALLOWED to drop opportunity keywords to do it — clean prose
  // wins, because those keywords already live in the shopper-invisible BACKEND field. It only protects the
  // DESIGN identity (floor) and brand-safety (adds no third-party brand). Best-effort.
  if (bullets.length > 0) {
    try {
      const beforeFloorMissing = missingBulletKeywords(bullets, bulletCoverageFloor).length
      const ownBrandSet = ownBrandTokenSet(brandName || '')
      const beforeBrands = findThirdPartyBrands(bullets.join(' '), ownBrandSet).length
      const polishResp = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        temperature: 0.4,
        max_tokens: 900,
        messages: [
          { role: 'system', content: `You are an Amazon listing copywriter. Rewrite the 5 bullet points so they read naturally and grammatically. AGGRESSIVELY DELETE keyword-stuffing: bolted-on comma-clauses of raw search terms (e.g. ", vintage graphic tees for women and vintage tshirts for women.", ", womens.", ", costume."), lists of near-duplicate keyword phrases, and dangling trailing fragments; fix obvious misspellings and grammar/punctuation slips (e.g. "pairs with jeans, or shorts" -> "pairs with jeans or shorts"). REWRITE any ALL-CAPS benefit hook that is NOT idiomatic English (e.g. "EASYGOING DRAPE") into a natural 2-3 word apparel benefit hook that fits the sentence — good examples: "SOFT & COMFORTABLE", "EVERYDAY FIT", "RELAXED COTTON FEEL", "BREATHABLE COMFORT", "VERSATILE STYLE". You MAY DROP search keywords that do not fit naturally — clean, human prose matters MORE than keyword coverage (keywords are handled in a separate backend field, so removing them here costs nothing).${dn ? ` KEEP the product identity "${dn}" present in at least one bullet.` : ''} HARD RULES: return EXACTLY 5 bullets; keep each bullet's "HOOK - body" shape (an ALL-CAPS hook, then " - ", then a clean sentence); each bullet 200 characters or fewer; add NO brand names; invent NO product claims. Return ONLY a JSON array of exactly 5 strings.` },
          { role: 'user', content: JSON.stringify(bullets) },
        ],
      })
      const rawPolish = (polishResp.choices[0]?.message?.content || '').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
      const parsedPolish = JSON.parse(rawPolish)
      if (Array.isArray(parsedPolish) && parsedPolish.length === bullets.length &&
          parsedPolish.every((b) => typeof b === 'string' && b.trim().length > 0 && b.trim().length <= 200)) {
        const cleaned = parsedPolish.map((b) => b.trim())
        const afterFloorMissing = missingBulletKeywords(cleaned, bulletCoverageFloor).length
        const afterBrands = findThirdPartyBrands(cleaned.join(' '), ownBrandSet).length
        // Adopt the cleaner rewrite as long as it (a) still carries the DESIGN identity (floor) and (b)
        // introduces no new third-party brand. Opportunity-keyword coverage is INTENTIONALLY allowed to
        // drop — the whole point of STEP 2 is that clean prose beats bullet keyword-coverage.
        if (afterFloorMissing <= beforeFloorMissing && afterBrands <= beforeBrands) bullets = cleaned
      }
    } catch { /* LLM/parse failure — keep the deterministic bullets (readability is best-effort) */ }
  }

  // Layer 2 — final assembled coherence re-read (the twin of coherenceGateTitles the bullet path
  // never had). Runs LAST, after the coverage backstop + readability polish, at the true assembly
  // point. Shadow by default (logs would-repairs); BULLET_COHERENCE_GATE=enforce applies them.
  // Pass only the DESIGN floor (not the opportunity pool): the gate's keyword-loss veto must protect the
  // identity, but must NOT force it to keep opportunity stuffing (STEP 2 — those live in backend).
  const gated = await coherenceGateBullets(openai, bullets, bulletCoverageFloor, brandName, input.onProgress)
  bullets = gated.bullets

  return bullets
}

// ─── Stage 3 — Backend keywords (code grouping + LLM aesthetic assignment) ──────

/** One ranked backend candidate (a token or short phrase) with its real/estimated monthly volume. */
interface BackendCouncilCandidate { keyword: string; volume: number }

/** Backend-keyword COUNCIL (element E, 2026-07-17) — the single-shot theme-fill's one gpt-4.1-mini
 *  guess becomes the same propose→deliberate→judge shape as runBulletsCouncil/runDescriptionCouncil.
 *  THREE proposers (gpt-4.1-mini, varied temp/persona, JSON, per-call timeout, maxRetries:0,
 *  Promise.all) emit RANKED candidates WITH volume — deliberately given NO byte target (a byte
 *  target at the proposer seam is a padding incentive); ONE judge (TITLE_COUNCIL_MODEL, default
 *  gpt-5; GPT-5 params branch like callBulletsModel) packs the survivors volume-ordered toward the
 *  byte budget. Fail-open chain: judge → proposer (i)'s demand list → (caller) the legacy
 *  theme-fill → bare deterministic core — never empty, never a preserved stale string (#352).
 *  The council only PROPOSES: the caller re-runs every returned token through the SAME deterministic
 *  fill filters the theme-fill applied — nothing here bypasses the rulebook. `reAskJudge` is the
 *  scoreBackend self-heal seam: one re-pack against the scorer's specific problems (the caller
 *  enforces max-1-retry + keep-best + never-dirtier). */
async function runBackendCouncil(
  openai: OpenAI,
  seedCore: string,
  poolRemaining: AnalyzedKeyword[],
  designName: string,
  excludeWords: Set<string>,
  /** banTok-style predicate bundle: true = this normalized token could still legitimately land
   *  (passes every deterministic fill filter). Shown to no model — used only to build the
   *  CRITICAL-gap brief here; the caller applies it as the real filter. */
  isUsableWord: (w: string) => boolean,
  /** Uncovered CRITICAL keywords ("phrase (vol/mo)") — proposer (iii)'s first-priority brief. */
  criticalSet: string[],
  /** Free bytes left before the core cap — the JUDGE packs toward it; proposers never see it. */
  byteBudget: number,
  onProgress?: (m: string) => void,
): Promise<{ ranked: BackendCouncilCandidate[]; reAskJudge: ((problems: string[], currentFill: string) => Promise<BackendCouncilCandidate[]>) | null }> {
  const askCandidates = async (system: string, user: string, temperature: number, model = 'gpt-4.1-mini', timeoutMs = 20_000): Promise<BackendCouncilCandidate[]> => {
    try {
      const isGpt5 = /^(gpt-5|o\d)/.test(model)
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
      const r = await openai.chat.completions.create(
        isGpt5
          ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' as const, response_format: { type: 'json_object' as const } }
          : { model, messages, temperature, max_tokens: 1000, response_format: { type: 'json_object' as const } },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      const contentB = r.choices[0]?.message?.content || ''
      if (!contentB.trim()) console.warn(`[backend-council] call (${model}) returned EMPTY content — finish_reason=${r.choices[0]?.finish_reason ?? '?'}`)
      const parsed = parseJsonLoose<{ candidates?: { keyword?: unknown; volume?: unknown }[] }>(contentB || '{}')
      return (Array.isArray(parsed.candidates) ? parsed.candidates : [])
        .filter((c) => !!c && typeof c.keyword === 'string' && c.keyword.trim().length > 0)
        .map((c) => {
          const v = typeof c.volume === 'number' ? c.volume : Number(c.volume)
          return { keyword: String(c.keyword).trim().toLowerCase(), volume: Number.isFinite(v) && v > 0 ? Math.round(v) : 0 }
        })
        .slice(0, 40)
    } catch (e) {
      console.warn(`[backend-council] call (${model}) FAILED: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }
  const JUDGE_MODEL = process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
  const poolLines = poolRemaining.slice(0, 40).map((k) => `- ${k.keyword} (${k.searchVolume ?? 0}/mo${k.actionType === 'CRITICAL' ? ', CRITICAL' : ''})`).join('\n')
  const avoid = [...excludeWords].slice(0, 60).join(' ')
  const shape = 'Return ONLY JSON: {"candidates":[{"keyword":"lowercase word or 2-4 word phrase","volume":<monthly searches, number>}]} — RANKED best-first. lowercase, no punctuation or commas inside a keyword. FORBIDDEN everywhere: brand names, color names, sizes, non-English words, generic catalog words ("apparel","clothing","clothes","outfit","wear","fashion","tops","wardrobe"), promo adjectives ("trendy","stylish","premium","elegant","timeless","cozy").'
  const brief = `Amazon backend search-term candidates (generic_keywords — invisible search indexing, a space-separated token soup) for this product.
Design/theme printed on it: ${designName || '(infer from the already-placed terms)'}
ALREADY PLACED in the field (never repeat these words): ${seedCore || '(nothing yet)'}
ALREADY INDEXED by title/bullets/brand/colors (never repeat): ${avoid}
DEMAND POOL (real shopper searches with real monthly volume):
${poolLines || '(pool exhausted — nothing left)'}
${shape}`
  const proposers: { label: string; sys: string; temp: number }[] = [
    { label: 'DEMAND MAXIMIZER', sys: 'You are a DEMAND/VOLUME MAXIMIZER for Amazon backend keywords. From the DEMAND POOL only, select the phrases whose words are NOT already placed/indexed, ranked strictly by REAL monthly volume (copy the pool volume verbatim — NEVER invent demand). 15-30 candidates.', temp: 0.2 },
    { label: 'LONG-TAIL BUYER-INTENT', sys: 'You are a LONG-TAIL BUYER-INTENT specialist. Propose the long-tail phrases real shoppers TYPE to find THIS DESIGN: build every phrase around the design theme — its subject, its joke/wordplay and synonyms, who buys it and for whom (wife, husband, mom, friend...), and gifting occasions ("<theme> gift", "<subject> lover gifts", "funny <subject> shirt for <recipient>"). Estimate volume honestly (long-tail is low, ~50-2000/mo). 15-30 candidates.', temp: 0.6 },
    { label: 'COVERAGE-COMPLETENESS', sys: `You are a COVERAGE-COMPLETENESS auditor. Close the remaining coverage gaps, in this order: FIRST the CRITICAL keywords below (propose their still-missing words, with the pool's real volume), THEN any DEMAND POOL phrase with unplaced words, THEN true buyer synonyms of the placed theme. 15-30 candidates.\nCRITICAL gaps to cover first:\n${criticalSet.length ? criticalSet.map((c) => `- ${c}`).join('\n') : '(none uncovered)'}`, temp: 0.3 },
  ]
  onProgress?.('Backend council: 3 proposers drafting candidates...')      // keepalive (resets idle timer)
  const drafts = await Promise.all(proposers.map((p) => askCandidates(p.sys, brief, p.temp)))
  if (drafts.every((d) => d.length === 0)) {
    console.warn('[backend-council] all 3 proposers returned empty — failing open to the legacy theme-fill')
    return { ranked: [], reAskJudge: null }
  }
  const numbered = drafts.map((d, i) => `${proposers[i].label} candidates:\n${d.map((c) => `- ${c.keyword} (${c.volume}/mo)`).join('\n') || '(none)'}`).join('\n\n')
  const judgeSys = 'You are the JUDGE of an Amazon backend-keyword council. Merge the three proposer lists into ONE final ranked pack: keep only distinct, on-theme, English candidates whose words are not already placed/indexed; order by REAL volume (pool-backed volume beats an estimate at equal relevance) but NEVER drop a CRITICAL-gap word; and pack toward the byte budget — stop adding once the budget is spent, never pad past it. ' + shape
  const judgeUser = `${brief}

BYTE BUDGET for the NEW words: ~${byteBudget} bytes (space-separated; a word costs its length + 1).

${numbered}

Return the single final pack, ranked in the exact order the words should be placed.`
  onProgress?.('Backend council: judge packing the survivors...')          // keepalive
  let judged = await askCandidates(judgeSys, judgeUser, 0.2, JUDGE_MODEL, 60_000)
  // #176: same downgrade retry as the bullets council — a judged pack on the workhorse model
  // beats an unjudged demand list.
  if (judged.length === 0 && JUDGE_MODEL !== 'gpt-4.1-mini') {
    judged = await askCandidates(judgeSys, judgeUser, 0.2, 'gpt-4.1-mini', 30_000)
    if (judged.length > 0) console.log('[backend-council] judge succeeded on gpt-4.1-mini downgrade retry')
  }
  // Fail open to proposer (i)'s DEMAND list (pool-backed, the safest volumes), NOT the invented
  // long-tail list — mirrors the bullets council's fail-open-to-SEO-draft rationale. Logged.
  if (judged.length === 0) console.warn('[backend-council] judge returned empty — failing open to the demand-proposer list')
  const ranked = judged.length > 0 ? judged : drafts[0]
  if (ranked.length === 0) return { ranked: [], reAskJudge: null }        // demand list empty too → caller's theme-fill
  const reAskJudge = async (problems: string[], currentFill: string): Promise<BackendCouncilCandidate[]> =>
    askCandidates(
      judgeSys,
      `${judgeUser}

YOUR PREVIOUS PACK was deterministically filtered and shipped as: "${currentFill}"
A deterministic scorer found these PROBLEMS with it:
- ${problems.join('\n- ')}
Re-pack ONCE: drop every offending word, replace the lost bytes with the next-best CLEAN candidates from the lists above, keep everything already good.`,
      0.2, JUDGE_MODEL, 60_000,
    )
  return { ranked, reAskJudge }
}

async function runBackendAgent(
  input: PipelineInput,
  finalTitle: string,
  bullets: string[],
  remaining: AnalyzedKeyword[],
  /** Seller's DESIGN/SLOGAN name ("Later Gator") — must survive in backend as an exact phrase even
   *  though it's in the title. Same identity mandate the title enforces (#91/#92); the backend used to
   *  silently drop it because it excludes title words. PR: design-name-in-backend. */
  designName = '',
  /** Token truth gate (built in pipeline scope): ungrounded style/cut/garment claims, sibling
   *  variants' colors, stray single letters, hard-lean opposite-gender tokens. Applied to the
   *  CORE and the LLM fill — NOT to the per-color tail (the tail IS this child's own color). */
  banTok: (w: string) => boolean = () => false,
): Promise<PipelinePerChildKeywords[]> {
  const { openai, children, brandName, category, repTitle, productType } = input
  const apparel = looksApparel(category, repTitle, productType)

  // Words already in title/bullets/brand — Amazon auto-indexes those, so exclude from backend.
  // Apostrophe-DELETION first (2026-07-08, parity with the pool/fill token streams): "Women's"
  // must produce 'womens' here, or the echo filter never matches the incoming 'womens' token.
  const excludeWords = new Set(
    `${finalTitle} ${bullets.join(' ')} ${brandName}`.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  )
  // Color names are auto-indexed from the variant attribute — never repeat them in backend.
  const colors = [...new Set(children.map((c) => (c.color || 'default').toLowerCase()))]
  colors.forEach((c) => excludeWords.add(c))
  // The seller's DESIGN NAME is identity, not a generic auto-indexed title word — exempt its tokens
  // from the exclusion so the fill/dedup can't strip "later"/"gator" out of backend (#91/#92 parity).
  ;(designName || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => excludeWords.delete(w))
  // BACKEND_CRITICAL_KEYWORDS (PO "words vs search terms", 2026-07-21): a CRITICAL keyword is a SEARCH
  // TERM, not a generic auto-indexed title word — it belongs in the backend even when its tokens also
  // appear in the title. Exempt CRITICAL pool tokens from title-echo exactly the way the design tokens
  // are exempted above, so spain/jersey/football/cup (the 400K money terms the seller front-loaded into
  // the title) survive. Generic title words (the/tee/2026) are NOT CRITICAL, so they still echo-dedupe
  // (no wasted bytes). Mutating this shared set propagates to the core loop, gap-close, council-fill,
  // AND scoreBackend's scoreExclude — so the self-heal stops flagging these tokens as "wasted bytes".
  const critEchoTokens = remaining
    .filter((k) => k.actionType === 'CRITICAL')
    .flatMap((k) => k.keyword.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))
  if (BACKEND_CRIT_ON) {
    critEchoTokens.forEach((w) => excludeWords.delete(w))
  } else if (BACKEND_CRIT_SHADOW) {
    const recover = [...new Set(critEchoTokens.filter((w) => excludeWords.has(w)))]
    if (recover.length) console.log(`[BACKEND_CRIT_DIFF] ${children[0]?.asin ?? ''} title-echo would-recover CRITICAL: ${recover.join(' ')}`)
  }
  // Title-only word set. The role-word exception ("keep 'teacher' only if this IS a teacher
  // product") must check the TITLE, not bullets — a bullet that wrongly slips "teacher" must
  // not license it back into the backend.
  const titleWords = new Set(finalTitle.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))

  // ── SHARED CORE: the product's biggest-opportunity keywords, intelligently de-duped ──
  // The core IS the bulk of the 250 bytes and carries the TOP opportunity-score keywords
  // (the pool is opportunity-sorted). Each meaningful word appears once (no "cool … cool"
  // repeats); JUNK, weak-relevance ROLE words ("teacher"), and WRONG-AUDIENCE words (kids/
  // youth/toddler — unless the product is actually for them, i.e. the word is in the title) are
  // dropped; the product-type word is capped at 2; minor words survive only as connectors. The
  // product's audience tokens (men/women, from the title) are GUARANTEED present.
  const kidsWords = new Set(KIDS_AUDIENCE)
  // Backend keywords are space-separated tokens — you CAN'T express "for [Brand]" framing
  // in that format. Bare third-party brand tokens in backend draw the same Amazon
  // trademark-complaint risk as in titles. Drop them entirely. The seller's compatibility
  // signal still lands via the title and bullets ("for GoPro Hero 11") which Amazon DOES
  // index. (Jan 2025 policy + Q4 2025 enforcement.)
  const ownBrandsForBackend = ownBrandTokenSet(brandName)
  const corePhrases: string[] = []
  const coreWordSet = new Set<string>()
  let productTypeCount = 0
  // BACKEND_CRITICAL_KEYWORDS Edit 5 (PO 2026-07-21 "TOP opportunities WEAVED in"): the shopper's real
  // multi-word queries ("spain jersey women", "spain soccer jersey", "spain world futbol cup jersey
  // 2026") index MUCH stronger as WHOLE PHRASES than as scattered tokens 50 chars apart. Pack the top
  // ~15 CRITICAL phrases verbatim (post-scrubTrademarks so "world cup"→"world futbol cup" keeps 'cup')
  // as the LEAD of corePhrases before the generic token pack runs. Every phrase still faces the same
  // per-token safety gates (banTok/JUNK/3P-brand/kids-audience/own-brand) so a genuine infringer can
  // never ride the phrase-lead into backend. Stops at ~180 bytes to leave the byte budget's tail for
  // the generic gap-closing pack that follows. Deduped against coreWordSet as it grows.
  if (BACKEND_CRIT_ON) {
    const critLead = remaining.filter((k) => k.actionType === 'CRITICAL').slice(0, 20)
    for (const k of critLead) {
      const scrubbed = scrubTrademarks(k.keyword || '')
      const raw = scrubbed.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (!raw || isAllJunk(raw)) continue
      const toks: string[] = []
      let dropPhrase = false
      let ptc = 0
      for (const w of raw.split(' ')) {
        if (!w || w.length <= 1) continue
        if (JUNK_WORDS.has(w) || banTok(w) || ownBrandsForBackend.has(w) || (kidsWords.has(w) && !titleWords.has(w))) { dropPhrase = true; break }
        if (THIRD_PARTY_BRANDS.has(w) && !ownBrandsForBackend.has(w)) { dropPhrase = true; break }
        if (MINOR_WORDS.has(w)) { toks.push(w); continue }
        if (PRODUCT_TYPE_WORDS.has(w)) { ptc++; if (productTypeCount + ptc > 2) continue; toks.push(w); continue }
        if (coreWordSet.has(w)) continue
        toks.push(w)
      }
      if (dropPhrase) continue
      const contentToks = toks.filter((w) => !MINOR_WORDS.has(w) && !PRODUCT_TYPE_WORDS.has(w))
      if (contentToks.length === 0) continue
      const phrase = toks.join(' ')
      if (!phrase) continue
      const prospective = [...corePhrases, phrase].join(' ')
      if (getByteLength(prospective) > 180) break
      corePhrases.push(phrase)
      productTypeCount += ptc
      for (const w of toks) if (!MINOR_WORDS.has(w)) coreWordSet.add(w)
    }
  }
  for (const k of remaining) {
    // Apostrophes collapse by DELETION ("he's" → "hes", matching normTok/dedupeTokenSoup), never
    // to a space — the old space-split shipped "he s" fragments to backend (PO-caught 2026-07-08).
    const raw = k.keyword.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!raw || isAllJunk(raw)) continue
    const toks: ({ w: string; minor: boolean } | null)[] = []
    for (const w of raw.split(' ')) {
      if (JUNK_WORDS.has(w)) { toks.push(null); continue }
      if (banTok(w)) { toks.push(null); continue }            // truth gate: ungrounded style/color/gender/stray
      if (ownBrandsForBackend.has(w)) { toks.push(null); continue }  // own brand: the brand attribute already indexes it (Amazon guideline; PO-approved 2026-07-08)
      // ROLE WORDS ARE KEPT in the backend CORE. These phrases come from REAL opportunity keywords
      // (SQP/JS — shoppers already reach this ASIN via "later gator teacher shirt"), and backend
      // generic_keyword is invisible search indexing, NOT a customer-facing audience claim. The
      // role-leak guard rightly blocks "teacher" in BULLETS; stripping it HERE made the scorer's
      // keyword-intelligence gap permanently unclosable and the rank work-list's "Regenerate to
      // weave it in" a false promise (PO-reported dead-end). The LLM FILL below still strips role
      // words — those are model-invented, not data-backed.
      if (kidsWords.has(w) && !titleWords.has(w)) { toks.push(null); continue }             // wrong audience (kids)
      if (THIRD_PARTY_BRANDS.has(w) && !ownBrandsForBackend.has(w)) { toks.push(null); continue }  // 3P brand: trademark risk in backend
      if (MINOR_WORDS.has(w)) { toks.push({ w, minor: true }); continue }
      // TITLE-ECHO REMOVAL (PO-approved 2026-07-08): tokens Amazon already indexes via the live
      // title/bullets/brand/color contribute nothing in backend — the pool stays HYBRID at the
      // phrase level (a title-covered phrase's NOVEL tokens still land), but covered tokens are
      // dropped at the byte level. Design tokens were deleted from excludeWords above, so the
      // design-phrase lead survives. Placed AFTER the MINOR branch so connectors keep working;
      // the men/women guarantee below still force-adds audience tokens (PO mandate).
      if (excludeWords.has(w)) { toks.push(null); continue }
      if (PRODUCT_TYPE_WORDS.has(w)) {
        if (productTypeCount >= 2) { toks.push(null); continue }
        productTypeCount++; toks.push({ w, minor: false }); continue
      }
      if (coreWordSet.has(w)) { toks.push(null); continue }            // content word already placed — drop repeat
      coreWordSet.add(w); toks.push({ w, minor: false })
    }
    // Keep a minor word only when it connects two surviving content words (no orphan/leading/trailing).
    const out: string[] = []
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      if (!t) continue
      if (t.minor) {
        const prevContent = out.length > 0 && !MINOR_WORDS.has(out[out.length - 1])
        let nextContent = false
        for (let j = i + 1; j < toks.length; j++) { const n = toks[j]; if (n) { nextContent = !n.minor; break } }
        if (prevContent && nextContent) out.push(t.w)
      } else out.push(t.w)
    }
    if (out.length === 0 || out.every((w) => MINOR_WORDS.has(w))) continue
    corePhrases.push(out.join(' '))
    // 200 (was 235): stop placing whole PHRASES early and leave ~33 bytes for the token-level
    // gap-closing pass below, which covers more distinct keywords per byte (PO 2026-07-09 "rank in
    // totality"). Whole phrases repeat connectors + already-placed tokens; token packing does not.
    if (getByteLength(corePhrases.join(' ')) >= 200) break
  }
  // Guarantee the product's audience tokens (PO wants Men AND Women in the backend).
  // UNSHIFT, not push (adversarial 2026-07-08): a tail-appended guarantee sat past the 233-byte
  // truncate line on well-stocked pools and got silently cut — front position always survives.
  // The dnPhrase unshift below still lands the design phrase ahead of these.
  for (const a of ['men', 'women']) {
    if (titleWords.has(a) && !coreWordSet.has(a)) { corePhrases.unshift(a); coreWordSet.add(a) }
  }
  // Force the DESIGN phrase to LEAD the core (deterministic, like the title's design-name lead) so
  // backend ranks for "later gator" and it survives the byte cap. This is the missing must-include
  // that let the design name silently drop from backend ("And Again"); it costs ~1 short phrase of bytes.
  // FILTERED (2026-07-08): apostrophes delete ("He's" → "hes", never "he s"), and OWN-BRAND tokens
  // drop from the phrase — "CEO? He's Golfing" leads as "hes golfing", not "ceo he s golfing".
  // Brand-only filter (adversarial): banTok here was over-reach — it stripped identity tokens the
  // SCORER still requires ("Black Cat" → "cat" on a multi-color family; "Powered by Coffee" →
  // "powered coffee"), creating a permanent -4 dock no regen could fix. The design phrase is the
  // deliberate identity exception (#91/#92) — everything but the brand ships intact.
  const dnPhrase = (designName || '').toLowerCase().replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter((w) => w && !ownBrandsForBackend.has(w)).join(' ')
  if (dnPhrase && !new RegExp(`\\b${dnPhrase.replace(/\s+/g, '\\s+')}\\b`).test(corePhrases.join(' '))) corePhrases.unshift(dnPhrase)
  // ── GAP-CLOSING (PO 2026-07-09, "does this rank in totality?") ────────────────────────────────
  // The core loop above places whole demand PHRASES and stops at 200 bytes. This token-packs the
  // STILL-MISSING content tokens of the opportunity pool, IN DEMAND ORDER, up to the byte budget.
  // Amazon matches a token bag, so covering a keyword's tokens = ranking for the phrase — and tokens
  // pack more distinct-keyword coverage per byte than repeating whole phrases (measured: 8/25 → 15/25
  // came from opening the gates; this closes the byte-budget gap that left mid-pool keywords, incl.
  // multilingual demand like "camisetas … algodon", entirely unplaced). Demand-backed, so it takes
  // byte priority over the LLM theme fill below (guesses get truncated first). Same filters as the
  // core; excludeWords keeps title-echo out; the product-type cap (productTypeCount) is shared.
  for (const k of remaining) {
    if (getByteLength(corePhrases.join(' ')) >= 233) break
    const add: string[] = []
    for (const w of k.keyword.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')) {
      if (!w || JUNK_WORDS.has(w) || MINOR_WORDS.has(w) || banTok(w)) continue
      if (kidsWords.has(w) && !titleWords.has(w)) continue          // wrong audience (kids)
      // THIRD-PARTY BRAND GUARD (adversarial BLOCKER 2026-07-09): banTok/groupBan do NOT filter
      // competitor/licensed brands, and the pool isn't stripped upstream — the core loop drops
      // them at THIS check, so gap-closing must mirror it or a pool brand token ("nike"/"disney")
      // ships to live backend = trademark risk. Own-brand is belt-and-suspenders (excludeWords/
      // banTok already cover it).
      if (ownBrandsForBackend.has(w)) continue
      if (THIRD_PARTY_BRANDS.has(w) && !ownBrandsForBackend.has(w)) continue
      if (excludeWords.has(w) || coreWordSet.has(w)) continue        // already title-indexed / placed
      if (PRODUCT_TYPE_WORDS.has(w) && productTypeCount >= 2) continue
      // Fit check BEFORE spending a type slot (adversarial): a type word that doesn't fit must not
      // burn the cap and block a later type word that would.
      if (getByteLength([...corePhrases, ...add, w].join(' ')) > 233) break
      if (PRODUCT_TYPE_WORDS.has(w)) productTypeCount++
      add.push(w); coreWordSet.add(w)
    }
    if (add.length) corePhrases.push(add.join(' '))
  }
  // Size the shared core against the per-color tail (PO 2026-07-16 "keywords must be 220-250"). A
  // colored family reserves ~17 bytes for its color-synonym tail (appended per child in buildString),
  // so the core caps at 233; a colorless / single-key family has NO tail, so the core may use the
  // full budget (244) — otherwise a thin single-color family caps at ~233 and never reaches the
  // 220-250 band. Computed here (mirrors the tailColors filter below, which now reuses it) so the
  // theme-fill + truncate target the right ceiling.
  const KNOWN_COLOR_NAMES = new Set(Object.values(SKU_COLOR_CODES).map((v) => v.toLowerCase()))
  const tailColors = colors.filter((c) => c !== 'default' && (KNOWN_COLOR_NAMES.has(c) || BASIC_COLOR_RE.test(c)))
  const coreByteTarget = tailColors.length ? 233 : 244
  // FILL: a small product's opportunity pool can run dry well under 250 bytes, leaving the
  // search-term field half-empty (PO: "keywords are 150 chars"). Top it up with real buyer terms —
  // run through the SAME junk / role / kids / dedup filters as the core, so it fills with real
  // terms, not rejected junk. The fill fires only when a THIN pool left real room (adversarial
  // 2026-07-09: firing at the cap was a paid call whose output was truncated away).
  // ELEMENT E COUNCIL (2026-07-17): the single-shot theme-fill is now a propose→deliberate→judge
  // COUNCIL (runBackendCouncil) + a deterministic scoreBackend SELF-HEAL loop. The council only
  // AUGMENTS the deterministic core + gap-closing above — every candidate token re-runs the EXACT
  // filter loop the theme-fill applied — and the whole chain fails open:
  // judge → demand proposer → legacy theme-fill → bare deterministic core.
  // Never empty, never a preserved stale string (#352 lesson). Because this runs INSIDE
  // runBackendAgent, every call site (family-level, per-design group, ungrouped remainder,
  // keywords-only partial, degraded-retry) inherits it; the per-color tail and per-child capacity
  // cores below both derive from the SAME filled core, so no per-child path bypasses it.
  if (getByteLength(corePhrases.join(' ')) < coreByteTarget) {
    const onProgress = input.onProgress
    // Apostrophe-deletion normalize ("valentine's" → "valentines"), matching the core normalize.
    const normFill = (s: string): string => s.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ')
    // ONE predicate: could this normalized token still legitimately land in the core? Shared by the
    // council fill filter, the legacy fill, the CRITICAL-gap brief, and scoreBackend's
    // poolExhausted probe — the same rulebook everywhere (coherence Invariant 1 discipline).
    const isUsableWord = (w: string): boolean => {
      if (!w || JUNK_WORDS.has(w) || MINOR_WORDS.has(w)) return false
      if (banTok(w)) return false                                      // truth gate (same as the core)
      if (ownBrandsForBackend.has(w)) return false                     // own brand: brand attribute indexes it
      if (ROLE_WORDS.has(w) && !titleWords.has(w)) return false        // weak-relevance role (model-suggested, not data-backed)
      if (kidsWords.has(w) && !titleWords.has(w)) return false         // wrong audience
      if (THIRD_PARTY_BRANDS.has(w) && !ownBrandsForBackend.has(w)) return false  // 3P brand: trademark risk
      if (coreWordSet.has(w) || excludeWords.has(w)) return false      // already covered / auto-indexed
      if (PRODUCT_TYPE_WORDS.has(w) && productTypeCount >= 2) return false
      return true
    }
    // The SAME filter loop the single-shot theme-fill applied (JUNK/MINOR/banTok/own-brand/ROLE/
    // kids/3P-brand/dedup/title-echo/PRODUCT_TYPE cap + the coreByteTarget stop) — now PURE (its
    // own dedup + type-count), so a judge retry can be EVALUATED without committing; commitFill
    // applies exactly one winner to coreWordSet/productTypeCount/corePhrases.
    const filterFillWords = (rawText: string): string[] => {
      const localSeen = new Set<string>()
      let localTypeCount = productTypeCount
      const out: string[] = []
      for (const w of normFill(rawText).split(/\s+/)) {
        if (!w || localSeen.has(w) || !isUsableWord(w)) continue
        if (PRODUCT_TYPE_WORDS.has(w)) { if (localTypeCount >= 2) continue; localTypeCount++ }
        localSeen.add(w); out.push(w)
        // Stop AT the core truncate ceiling (coreByteTarget) so the terms actually survive
        // truncateToBytes below (adversarial 2026-07-09 — an overshoot was sliced off).
        if (getByteLength([...corePhrases, out.join(' ')].join(' ')) >= coreByteTarget) break
      }
      return out
    }
    const commitFill = (words: string[]): void => {
      if (words.length === 0) return
      for (const w of words) { coreWordSet.add(w); if (PRODUCT_TYPE_WORDS.has(w)) productTypeCount++ }
      corePhrases.push(words.join(' '))
    }
    // LEGACY single-shot theme-fill — the council's LAST fail-open rung. Behavior preserved
    // verbatim (THEME-ANCHORED ask, PO 2026-07-08; transient-error retry, PO 2026-07-16: this is
    // the ONLY novel byte source for a thin pool, so a swallowed failure stuck the field at ~200).
    const legacyThemeFill = async (): Promise<void> => {
      try {
        const fillSys = 'You generate ADDITIONAL Amazon backend search keywords (long-tail buyer phrases) to fill the search-term field. Return ONLY JSON: {"keywords":"lowercase space-separated search words"}.'
        const fillUsr = `Product: ${finalTitle}
Design/theme printed on it: ${designName || '(infer from the title)'}
List ~40 ADDITIONAL search terms real shoppers TYPE into Amazon to find THIS DESIGN on this product. Build every phrase AROUND the design's theme — its subject, its joke/wordplay and synonyms, who buys it and for whom (wife, husband, mom, friend...), and gifting occasions. Think like the buyer: "<theme> gift", "<subject> lover gifts", "funny <subject> shirt for <recipient>", "<occasion> gift for <recipient> who loves <subject>".
ONLY concrete buyer search words tied to the theme. FORBIDDEN: generic category words ("apparel", "clothing", "clothes", "outfit", "wear", "fashion", "tops", "wardrobe"), promo adjectives ("trendy", "stylish", "premium", "elegant", "timeless", "cozy"), brand names, color names, sizes. lowercase, space-separated, no commas/quotes.
Avoid reusing: ${[...coreWordSet, ...titleWords].slice(0, 60).join(' ')}
Return ONLY the JSON.`
        const callFill = async (): Promise<string> => {
          const fc = await openai.chat.completions.create({
            model: 'gpt-4.1-mini',
            messages: [{ role: 'system', content: fillSys }, { role: 'user', content: fillUsr }],
            temperature: 0.6,
            max_tokens: 300,
            response_format: { type: 'json_object' },
          })
          return fc.choices[0]?.message?.content || '{}'
        }
        let fillRaw = '{}'
        for (let attempt = 0; attempt < 2; attempt++) {
          try { fillRaw = await callFill(); break }
          catch (e) { if (attempt === 1) throw e; console.warn(`[runBackendAgent] theme-fill attempt ${attempt + 1} failed, retrying:`, e instanceof Error ? e.message : e) }
        }
        const fillParsed = parseJsonLoose<{ keywords?: string }>(fillRaw)
        commitFill(filterFillWords(fillParsed.keywords || ''))
      } catch (e) {
        // Best-effort — the opportunity core still ships — but SURFACE it (not silent): a persistent
        // failure here is why a thin backend can stick under budget (the #352-class quiet degrade).
        console.warn('[runBackendAgent] theme-fill failed after retry; shipping core only:', e instanceof Error ? e.message : e)
      }
    }
    let filledByCouncil = false
    try {
      // Uncovered CRITICAL keywords (still carrying >=1 usable token) → proposer (iii)'s brief.
      const criticalSet = remaining
        .filter((k) => k.actionType === 'CRITICAL' && normFill(k.keyword).split(/\s+/).some((w) => w && isUsableWord(w)))
        .slice(0, 15)
        .map((k) => `${k.keyword} (${k.searchVolume ?? 0}/mo)`)
      const freeBytes = Math.max(0, coreByteTarget - getByteLength(corePhrases.join(' ')) - 1)
      const council = await runBackendCouncil(openai, corePhrases.join(' '), remaining, designName, excludeWords, isUsableWord, criticalSet, freeBytes, onProgress)
      if (council.ranked.length > 0) {
        // The judge's pack is volume-ordered; the deterministic filters have the FINAL word — every
        // council token passes the exact same loop the theme-fill applied, capped at coreByteTarget.
        let bestFill = filterFillWords(council.ranked.map((c) => c.keyword).join(' '))
        // ── scoreBackend SELF-HEAL (max 1 judge re-ask; keep-best; never adopt a dirtier string) ──
        const candidateCore = (f: string[]): string => truncateToBytes([...corePhrases, f.join(' ')].filter(Boolean).join(' '), coreByteTarget)
        // Echo scoring view: the men/women audience guarantee is a DELIBERATE forced placement
        // (unshifted into the core above), never an "echo problem"; design tokens were already
        // deleted from excludeWords (identity exemption, #91/#92).
        const scoreExclude = new Set(excludeWords)
        scoreExclude.delete('men')
        scoreExclude.delete('women')
        const nicheCtx = `${finalTitle} ${bullets.join(' ')} ${repTitle ?? ''} ${input.canonicalTitle ?? ''} ${brandName}`
        const scoreCtx: BackendScoringCtx = {
          nicheContext: nicheCtx,
          excludeWords: scoreExclude,
          ownBrands: ownBrandsForBackend,
          remainingCandidates: [...new Set([
            ...council.ranked.flatMap((c) => normFill(c.keyword).split(/\s+/)),
            ...remaining.flatMap((k) => normFill(k.keyword).split(/\s+/)),
          ].filter(Boolean))],
          isAddableCleanToken: (w) => isUsableWord(w) && !isForeignKeyword(w) && !isOffNicheKeyword(w, { context: nicheCtx }),
        }
        // DIRT vs UNDER-FILL split (scoreBackend's stable "bytes " prefix): keep-best compares
        // dirt first — a retry that packs more bytes but adds an off-niche token must LOSE.
        const dirt = (sc: { problems: string[] }): number => sc.problems.filter((p) => !p.startsWith('bytes ')).length
        let bestScore = scoreBackend(candidateCore(bestFill), scoreCtx)
        if (!bestScore.green && !bestScore.poolExhausted && council.reAskJudge) {
          onProgress?.('Backend council: self-heal — judge re-packing against scorer problems...')  // keepalive
          try {
            const retry = await council.reAskJudge(bestScore.problems, candidateCore(bestFill))
            if (retry.length > 0) {
              const retryFill = filterFillWords(retry.map((c) => c.keyword).join(' '))
              const retryScore = scoreBackend(candidateCore(retryFill), scoreCtx)
              if (dirt(retryScore) < dirt(bestScore)
                || (dirt(retryScore) === dirt(bestScore) && getByteLength(candidateCore(retryFill)) > getByteLength(candidateCore(bestFill)))) {
                bestFill = retryFill
                bestScore = retryScore
              }
            }
          } catch (e) {
            console.warn('[runBackendAgent] council self-heal re-ask failed — keeping the first pack:', e instanceof Error ? e.message : e)
          }
        }
        if (bestFill.length > 0) {
          commitFill(bestFill)
          filledByCouncil = true
          // ADVISORY ONLY (never a throw): the <190 hard floor stays in backendOutputProblems.
          if (!bestScore.green) console.warn(`[runBackendAgent] backend core not green after council (${bestScore.problems.join('; ') || 'no listed problems'}${bestScore.poolExhausted ? '; pool exhausted' : ''}) — shipping best-effort`)
        } else {
          console.warn('[runBackendAgent] council candidates were fully filtered out — falling back to the legacy theme-fill')
        }
      }
    } catch (e) {
      console.warn('[runBackendAgent] backend council failed — falling back to the legacy theme-fill:', e instanceof Error ? e.message : e)
    }
    if (!filledByCouncil) await legacyThemeFill()
  }
  // The core is the opportunity keywords + long-tail fill — most of the 250 bytes (NOT colors).
  // 233 (was 228; adversarial corrected 235): the ≤3-word color tail needs ~17 bytes ("cream off
  // white" = 16) — a 235 cap left only 14 and quietly cut tails on the best-stocked listings.
  const core = truncateToBytes(corePhrases.join(' '), coreByteTarget)

  // ── PER-COLOR TAIL: just the 2-3 top shade synonyms for THIS variant's color (not 10) ──
  // KNOWN_COLOR_NAMES + tailColors are computed ABOVE (before the theme-fill) so the core could be
  // sized against the tail. The LOOKS-LIKE-A-COLOR gate there (2026-07-09) means only plausibly-color
  // keys get shade synonyms — a junk key ('default', an undecoded code, the old 'fbm' channel suffix)
  // ships the bare core (honest) instead of a hallucinated palette broadcast to every child.
  const system = 'You generate a SHORT Amazon backend color tail per color variant. Return ONLY valid JSON: {"groups":[{"color":"<color>","keywords":"2-3 lowercase color words"}]}.'
  const user = `Color variants: ${tailColors.join(', ')}

For EACH color, output ONLY the 2-3 MOST-SEARCHED shade synonyms a buyer would type — no more than 3. Examples:
  light green -> sage olive
  ivory -> cream off white
  pepper -> charcoal heather
Use ONLY real color/shade SEARCH words — NEVER moods/feelings ("serene", "calm", "whimsical", "elegant", "timeless") and NEVER product-type words ("shirt", "shirts", "tee", "tshirt"). Max 3 words per color.

Do NOT use any of these words (already covered in title/bullets/core/color names):
${[...excludeWords].slice(0, 50).join(' ')}

Rules: lowercase, space-separated, NO commas, NO quotes, no brand or size words, 2-3 words ONLY.
Return ONLY the JSON object.`

  const tailMap = new Map<string, string>()
  if (apparel && tailColors.length > 0) {
    // max_tokens 2000, not 800: a big apparel family (Darlin' = 25+ colors) sat right at the
    // 800-token JSON truncation edge — a truncated response parses to NOTHING, the catch
    // swallowed it, and every child silently shipped the IDENTICAL bare core (live 2026-06-12:
    // 82 children, one string). One retry for the same reason — truncation/hiccups are transient.
    for (let attempt = 0; attempt < 2 && tailMap.size === 0; attempt++) {
      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.5,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        })
        const parsed = parseJsonLoose<{ groups?: { color: string; keywords: string }[] }>(completion.choices[0]?.message?.content || '{}')
        for (const g of parsed.groups ?? []) {
          if (g?.color && typeof g.keywords === 'string') tailMap.set(g.color.toLowerCase(), g.keywords.trim())
        }
      } catch {
        /* tail is best-effort; core still ships */
      }
    }
    if (tailColors.length > 1 && tailMap.size === 0) {
      console.warn(`[runBackendAgent] color-tail call returned nothing for ${tailColors.length} colors — children will share the core string`)
    }
  } else if (apparel && colors.length > 1) {
    console.warn(`[runBackendAgent] no plausibly-color keys among [${colors.slice(0, 8).join(', ')}] — color decode likely failed upstream; children share the bare core`)
  }

  // ── Per-child CAPACITY awareness ──
  // For a capacity variation family (e.g. SD cards 64/128/256GB), every child currently received
  // the IDENTICAL core, leading with whichever capacity ranked highest in the keyword pool
  // (usually 128GB). That means the 32G SKU's backend says "128 gb sd card..." first — Amazon
  // ranks it for the wrong capacity. Per Amazon SEO research, each child's backend should
  // emphasize ITS OWN capacity. Detect distinct child capacities and, when present, build a
  // per-child core: strip OTHER capacity tokens, prepend the child's own capacity.
  const backendChildCaps = new Map<string, string>()
  const liveCaps = new Set<string>()
  for (const c of children) {
    const cap = capacityOf(c.sku) || capacityOf(c.title)
    if (cap) { backendChildCaps.set(c.sku, cap); liveCaps.add(cap) }
  }
  const backendCapacityFamily = !apparel && liveCaps.size >= 2

  // Build a regex that matches ANY GB/TB token (e.g. "128 gb", "128gb", "1tb"). Used to strip
  // wrong-capacity tokens from the broadcast core before re-prepending the child's own.
  const anyCapRe = /\b\d{1,4}\s?(?:tb|gb|mb)\b/gi

  // ── Combine: opportunity-keyword core + AT MOST 3 net-new color words, byte-cap to 250 ──
  const buildString = (tail: string, customCore?: string): string => {
    const effectiveCore = customCore ?? core
    const effectiveCoreWords = customCore ? new Set(effectiveCore.toLowerCase().split(/\s+/).filter(Boolean)) : new Set(core.toLowerCase().split(/\s+/).filter(Boolean))
    const tailWords = tail.toLowerCase().split(/\s+/)
      // + PRODUCT_TYPE_WORDS (PO-caught 2026-07-09: "shirts" rode in via the tail — the tail is
      // for COLOR shade synonyms only; type words are capped in the core/fill).
      .filter((w) => w && !effectiveCoreWords.has(w) && !excludeWords.has(w) && !MINOR_WORDS.has(w) && !PRODUCT_TYPE_WORDS.has(w))
      .slice(0, 3)   // at most 3 color words — the PO does NOT want 10 color synonyms
    // Token dedup (PO: design phrase "could be meaner" appeared twice — the force-led design
    // phrase + a keyword carrying the same words). Amazon indexes each token once anyway, so a
    // repeat is pure wasted budget. Keep the FIRST occurrence (preserves the design-name lead),
    // drop later dupes by normalized token; fillBackendToBudget then tops the reclaimed bytes
    // back up with novel terms.
    return truncateToBytes(dedupeTokenSoup(`${effectiveCore} ${tailWords.join(' ')}`.trim()), 250)
  }

  return children.map((c) => {
    const color = (c.color || 'default').toLowerCase()
    let childCore: string | undefined
    if (backendCapacityFamily) {
      const childCap = backendChildCaps.get(c.sku)
      if (childCap) {
        const childCapLc = childCap.toLowerCase()                  // e.g. "32gb"
        const childCapSpaced = childCapLc.replace(/(\d+)([a-z]+)/, '$1 $2')  // "32 gb"
        // 1) Strip every capacity token in the core (we'll re-add this child's first).
        let stripped = core.replace(anyCapRe, ' ').replace(/\s{2,}/g, ' ').trim()
        // 2) Prepend this child's own capacity (twice — both unspaced and spaced — so it ranks
        //    for "32gb" and "32 gb" search variants without burning much budget).
        stripped = `${childCapSpaced} ${childCapLc} ${stripped}`.replace(/\s{2,}/g, ' ').trim()
        childCore = truncateToBytes(stripped, 233)   // matches the shared core cap (fill-to-244, 2026-07-08)
      }
    }
    return { sku: c.sku, asin: c.asin, keywords: buildString(tailMap.get(color) || '', childCore) }
  })
}

// ─── Stage 4 — Audit Agent (o4-mini, reasoning) ────────────────────────────────

interface AuditResult {
  variant_corrections?: PipelineVariantCorrection[]
  cannibalization_warnings?: PipelineCannibalizationWarning[]
  product_details_improvements?: PipelineProductDetailImprovement[]
  keyword_reconciliation?: PipelineKeywordReconciliation[]
  action_plan?: PipelineActionPlanItem[]
}

async function runAuditAgent(
  input: PipelineInput,
  finalTitle: string,
  bullets: string[],
  perChild: PipelinePerChildKeywords[],
  description: string,
  specs: string[],
): Promise<AuditResult> {
  const { openai, auditModel, variantDetails, keywordContext, hasAplus, category, repTitle, productType, detailAttributeMenu, visionDesign } = input
  const apparel = looksApparel(category, repTitle, productType)
  const backendSummary = perChild.slice(0, 3).map((p) => `  ${p.sku}: ${p.keywords}`).join('\n')
  const specsLine = specs.length
    ? `\n=== KNOWN PRODUCT SPECS (use these to fill structured Product-Detail fields with REAL values — e.g. ${apparel ? 'Fabric Type, Material, Fit Type, Department' : 'Material, Capacity, Compatibility, Item Dimensions'}) ===\n${specs.join(', ')}\n`
    : ''
  // Live schema menu (PO: "auto-map any item to the category's Features") — the ONLY attributes
  // Amazon accepts for THIS product type, with their real enum values. When present the audit
  // picks from it instead of guessing apparel-shaped field names (Department on sticky notes).
  const menu = (detailAttributeMenu ?? []).slice(0, 26)
  const menuLine = menu.length
    ? `\n=== AMAZON ATTRIBUTE MENU for this product type (the ONLY Product-Detail field names Amazon accepts here) ===\n${menu.map((m) => `- ${m.title}${m.accepted?.length ? ` [accepted values: ${m.accepted.slice(0, 12).join(' | ')}]` : ''}`).join('\n')}\n`
    : ''
  // DESIGN THEME grounding (2026-07-14, B0H7L6KNNX "Theme=Game" bug): the vision scan already read what
  // is PRINTED on the product; without it the audit derives Theme/Occasion/Sport from the generic
  // keyword pool and guesses "Game" for a soccer World-Cup tee. Feed it so those attributes ground to
  // the real design, not a generic guess.
  const designThemeLine = visionDesign?.designTheme
    ? `\n=== DESIGN THEME (what is actually printed on the product) ===\n${visionDesign.designTheme}${visionDesign.visualElements?.length ? ` — visual elements: ${visionDesign.visualElements.slice(0, 6).join(', ')}` : ''}\n`
    : ''

  const system = `You are a senior Amazon SEO auditor. Return ONLY valid JSON.
The recommended title, bullets, backend keywords, and description below are ALREADY FINALIZED — do NOT rewrite them. Build the action plan and reconciliation AROUND them.`

  const user = `=== FINALIZED CONTENT (do not change) ===
TITLE: ${finalTitle}
BULLETS:
${bullets.map((b, i) => `  ${i + 1}. ${b}`).join('\n')}
BACKEND (sample of per-child):
${backendSummary}
DESCRIPTION: ${description ? 'provided (HTML)' : '(none)'}
A+ exists: ${hasAplus}
${specsLine}${menuLine}${designThemeLine}
=== CURRENT LISTING (for variant health + product details) ===
${variantDetails}

=== KEYWORD INTELLIGENCE ===
${keywordContext}

Produce a JSON object with these keys:
{
  "action_plan": [ { "element": "title|bullet_1..5|backend_keywords|description|aplus_modules|brand_story|product_details|images", "level": "parent|per_child", "verdict": "REPLACE|EDIT|CREATE|DONE|SKIP", "priority": "HIGH|MEDIUM|LOW|NONE", "current_status": "...", "instruction": "...", "replacement_content": "string|null", "seller_central_path": "...", "notes": "...", "aplus_modules": [ { "module_type": "...", "action": "ADD|EDIT|KEEP", "content_brief": "...", "position": 1 } ] } ],
  "keyword_reconciliation": [ { "keyword": "...", "action_type": "CRITICAL|UPGRADE|REINFORCE", "search_volume": 0, "placed_in": ["title|bullet_1..5|backend_keywords"], "exact_text": "...", "why": "..." } ],
  "variant_corrections": [ { "sku": "...", "field": "title|bullets|keywords|description", "current": "...", "replace_with": "...", "reason": "..." } ],
  "cannibalization_warnings": [ { "keyword": "...", "affected_skus": ["..."], "issue": "...", "recommendation": "..." } ],
  "product_details_improvements": [ { "field_name": "...", "current_value": "string|null", "recommended_value": "...", "reason": "..." } ]
}

Rules:
- Review EVERY element in the action plan (title, bullet_1..5, backend_keywords, description, aplus_modules, brand_story, product_details, images). For title/bullets/backend/description, the replacement_content is the FINALIZED content above — restate it, do not invent new copy.
- DESCRIPTION: even if A+ exists, the field is still indexed for search — mark CREATE/EDIT (not SKIP) and note that customers see A+ but Amazon indexes this field.
- CANNIBALIZATION: children in ONE variation family do NOT compete in search. Leave cannibalization_warnings empty unless the SAME backend string is duplicated identically across many children. Never report cross-listing cannibalization (not assessable here).
- PRODUCT DETAILS: the structured attributes in Seller Central → More Details power Amazon's filtered search + the spec comparison table, and are almost always under-filled. Do NOT assume they're already set — PROACTIVELY recommend a value for EVERY standard attribute a shopper filters THIS product type by. ${menu.length ? 'Use ONLY field names from the AMAZON ATTRIBUTE MENU above, with the EXACT names shown — any other field name is rejected by Amazon for this product type. Where the menu lists accepted values, recommended_value MUST be one of them, verbatim. Recommend a value for EVERY menu attribute that plausibly applies to THIS product — do NOT pick a subset; a shopper filters by all of them, so each filled attribute is another filtered-search entry. Skip a menu attribute ONLY when it is genuinely irrelevant to this item.' : apparel ? 'Cover (as applicable), using these EXACT field names (they match Amazon\'s apparel schema — suffixed variants like "Neck Style"/"Sleeve Type" are NOT valid top-level attributes and get rejected): Material, Fabric Type, Fit Type, Care Instructions, Department, Neck, Sleeve, Closure.' : 'Cover (adapt to the ACTUAL product — e.g. for a memory/SD card): Capacity, Read Speed, Write Speed, Speed Class, Video Speed Class, Flash Memory Type, Form Factor, Hardware Interface, Compatible Devices, Manufacturer Warranty. NOT apparel fields like Fabric Weight or Fit Type.'} Derive recommended_value from the title/bullets/keywords/specs above; set current_value to null when you can't confirm it from the listing. For THEME / OCCASION / SPORT / SEASON / STYLE, ground the value to the DESIGN THEME section (what is actually printed) — e.g. a soccer/World-Cup design → a soccer or sports Theme, NEVER a generic guess like "Game". Fill as MANY applicable attributes as the menu offers — completeness wins filtered search, so err strongly toward MORE; skip only the truly irrelevant.
- A+ modules: more modules lift conversion and dwell time; A+ body text is not a confirmed ranking field, so recommend filling image ALT-TEXT for discoverability.
Return ONLY the JSON object.`

  const completion = await openai.chat.completions.create({
    model: auditModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: 8000,
    response_format: { type: 'json_object' },
  })
  const auditResult = parseJsonLoose<AuditResult>(completion.choices[0]?.message?.content || '{}')

  // DEDICATED PRODUCT-DETAILS FILL (2026-07-17) — the mega-audit above emits product_details as ONE of six
  // JSON outputs inside a single 8000-token call, so it chronically UNDER-fills the attribute menu (PO: "we
  // had ~12, the directive added ~12 more — where are they?"). The extra attributes ARE in the menu (#79's
  // force-adds + the schema's SEO band); the LLM just never gets to them. A FOCUSED second call that sees
  // ONLY the menu + specs + design fills far more of the applicable attributes. Enum-verbatim + grounded +
  // null-when-indeterminable; the route's enum coercion + VALIDATION_PREVIEW still backstop any bad value at
  // push. Fail-open (empty/error keeps the mega-audit rows). Union by field_name (audit rows win — they were
  // already truth-checked), cap 26. Only runs when a real schema menu resolved.
  if (menu.length > 0) {
    try {
      const dSys = 'You are an Amazon catalog specialist filling structured Product-Detail attributes for filtered search. Return ONLY valid JSON.'
      const dUser = `Fill Amazon Product-Detail attributes for THIS product, choosing field names + values ONLY from the menu below.
=== PRODUCT ===
TITLE: ${finalTitle}
BULLETS:
${bullets.map((b, i) => `  ${i + 1}. ${b}`).join('\n')}
${specsLine}${designThemeLine}
=== AMAZON ATTRIBUTE MENU (the ONLY field names Amazon accepts here — use the EXACT title shown) ===
${menu.map((m) => `- ${m.title}${m.accepted?.length ? ` [accepted values: ${m.accepted.slice(0, 20).join(' | ')}]` : ''}`).join('\n')}

Return {"product_details_improvements":[{"field_name":"...","recommended_value":"...","reason":"..."}]} obeying:
- A row for EVERY menu attribute you can determine for THIS product from the facts above. A standard apparel item legitimately HAS most of them (neck, sleeve, fit, material, fabric, care, department, target gender, age range, pattern, style, occasion, season, theme, closure, weave, shape) — fill them, do not stop early.
- recommended_value MUST be VERBATIM one of the [accepted values] when the menu lists them; otherwise a concise, correct value derived from the facts. Ground fit/material/fabric to the SPEC facts, never a guess.
- Ground THEME / OCCASION / SPORT / SEASON / STYLE to the DESIGN THEME (what is actually printed), never a generic guess.
- Use null ONLY when an attribute is genuinely indeterminable for this product — do NOT skip a determinable one. Completeness wins filtered search.
Return ONLY the JSON object.`
      const dResp = await openai.chat.completions.create({
        model: auditModel,
        messages: [{ role: 'system', content: dSys }, { role: 'user', content: dUser }],
        max_completion_tokens: 3000,
        response_format: { type: 'json_object' },
      })
      const dParsed = parseJsonLoose<{ product_details_improvements?: PipelineProductDetailImprovement[] }>(dResp.choices[0]?.message?.content || '{}')
      const extra = Array.isArray(dParsed.product_details_improvements) ? dParsed.product_details_improvements : []
      if (extra.length > 0) {
        const base = Array.isArray(auditResult.product_details_improvements) ? auditResult.product_details_improvements : []
        const seen = new Set(base.map((p) => detailValueToString(p.field_name).toLowerCase().trim()))
        const merged = [...base]
        for (const e of extra) {
          const key = detailValueToString(e.field_name).toLowerCase().trim()
          const val = e.recommended_value
          if (!key || val == null || detailValueToString(val).trim() === '' || seen.has(key)) continue
          seen.add(key)
          merged.push(e)
        }
        auditResult.product_details_improvements = merged.slice(0, 26)
        console.log(`[details-fill] product details: audit ${base.length} + dedicated ${extra.length} → ${auditResult.product_details_improvements.length} (menu offered ${menu.length})`)
      }
    } catch (e) {
      console.warn('[details-fill] dedicated product-details agent failed (non-fatal, keeping audit rows):', e instanceof Error ? e.message : e)
    }
  }

  return auditResult
}

// ─── Description (code-triggered LLM, always generated — field is indexed) ──────

/** Deterministic VISIBLE-length cap for the description HTML (mirrors capTitle75 + the Item Highlight cap).
 *  Trim to <= `cap` visible (tag-stripped) chars at the last </p>/</li>/</ul> boundary at/before the cap so
 *  the live PDP never shows a cut mid-word/mid-tag. MUST run on the FINAL SHIPPED bytes: runDescriptionAgent
 *  caps its own output, but the description is then re-written by applyEditorialGates (LLM audit) and
 *  fanOutPerDesignDescriptions (per-design LLM) with NOTHING re-capping — that is the "1600-char description"
 *  regression (the safeguard ran BEFORE the rewrite that expanded it). */
export function capDescriptionVisible(html: string, cap = 980): string {
  const plainLen = (d: string) => d.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length
  if (!html || plainLen(html) <= cap) return html
  let vis = 0
  let off = html.length
  for (let i = 0; i < html.length; i++) {
    if (html[i] === '<') { const c = html.indexOf('>', i); if (c === -1) break; i = c; continue }
    if (++vis >= cap) { off = i + 1; break }
  }
  let bestEnd = -1
  for (const tag of ['</p>', '</li>', '</ul>']) {
    const i = html.lastIndexOf(tag, off)
    if (i >= 0 && i + tag.length > bestEnd) bestEnd = i + tag.length
  }
  const cut = bestEnd > 0
    ? html.slice(0, bestEnd).trim()
    : html.slice(0, off).replace(/<[^>]*$/, '').replace(/\s+\S*$/, '').trim()
  // Tag balance (Phase 6 prerequisite): a </li> boundary inside a <ul> — or the raw-slice fallback —
  // leaves opened tags unclosed and ships broken HTML to the PDP. Append the missing closers; they add
  // ZERO visible chars, so the cap above still holds. Pipeline emits only p/ul/li/b.
  const open: string[] = []
  const tagScan = /<\/?(p|ul|li|b)\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = tagScan.exec(cut))) {
    const name = (m[1] as string).toLowerCase()
    if (m[0][1] === '/') {
      const i = open.lastIndexOf(name)
      if (i >= 0) open.splice(i, 1)
    } else open.push(name)
  }
  return open.length ? cut + open.reverse().map((t) => `</${t}>`).join('') : cut
}

/** Description COUNCIL (Approach B) — the description was previously the ONLY published field with no
 *  council (a single gpt-4.1-mini call), yet it is an INDEXED search field. So it now gets the same
 *  3-persona -> GPT-5 adversary -> GPT-5 judge debate as the title/bullets councils. Returns a single
 *  HTML string; output still flows the caller's validateDescription + brand-safety judge + length cap,
 *  so the council is additive. Fails open to a single agent. Description is HTML/prose (not JSON), so
 *  this mirrors runTitleCouncil's prose ask() shape, NOT the bullets JSON shape. */
async function runDescriptionCouncil(openai: OpenAI, baseSystem: string, baseUser: string, onProgress?: (m: string) => void): Promise<string> {
  // Proposers stay on fast gpt-4.1-mini; the adversary + judge run on GPT-5. GPT-5 reasoning models
  // REJECT `temperature` and use `max_completion_tokens` — params branch by model (same as the title
  // council). Per-call timeout + NO retries so a hung call can't stall past Cloudflare's ~100s idle
  // window (a keepalive fires BETWEEN stages, not during a call). Strip any ```html fence off every draft.
  const stripFence = (s: string): string => s.replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
  const ask = async (system: string, user: string, temperature: number, max_tokens = 1200, model = 'gpt-4.1-mini', timeoutMs = 20_000): Promise<string> => {
    try {
      const isGpt5 = /^(gpt-5|o\d)/.test(model)
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
      const r = await openai.chat.completions.create(
        isGpt5
          ? { model, messages, max_completion_tokens: Math.max(max_tokens, 4000), reasoning_effort: 'low' }
          : { model, messages, temperature, max_tokens },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      return stripFence(r.choices[0]?.message?.content || '')
    } catch { return '' }
  }
  const COUNCIL_MODEL = process.env.DESCRIPTION_COUNCIL_MODEL || process.env.BULLETS_COUNCIL_MODEL || process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
  const personas: { sys: string; temp: number }[] = [
    { sys: 'You are an award-winning apparel COPYWRITER. Write the most vivid, human, DESIGN-LED HTML description — evocative but tight. ', temp: 0.6 },
    { sys: 'You are a TEXTILE / PRODUCT expert. Turn the real product facts in the brief — fabric, weight, feel, fit, construction, care — into vivid, accurate, specific copy a shopper trusts. Never weave in search phrases. ', temp: 0.3 },
    { sys: 'You are a CONVERSION strategist. Lead with the strongest selling point, build trust, close with a clear reason to buy — clean, professional, no spam. ', temp: 0.4 },
  ]
  const drafts = (await Promise.all(personas.map((p) => ask(p.sys + baseSystem, baseUser, p.temp)))).filter(Boolean)
  if (drafts.length === 0) return ask(baseSystem, baseUser, 0.5)              // fail open: single agent
  if (drafts.length === 1) return drafts[0]
  onProgress?.('Description council: drafts in, adversary reviewing...')       // keepalive (resets idle timer)
  const numbered = drafts.map((t, i) => `Description ${i + 1}:\n${t}`).join('\n\n')
  const critique = await ask(
    'You are a ruthless Amazon listing critic. Attack each HTML description for: (1) THIN or GENERIC copy that could describe any shirt — lacking concrete product specifics (fabric, weight, fit, feel, care, the design\'s actual theme); (2) keyword stuffing, a keyword-list read, or any repeated shopper-search phrasing (e.g. "graphic tees for women", "cotton tshirts for women") that belongs in BACKEND keywords, not prose; (3) any claim of a profession/role/occasion/audience NOT in the title (accuracy failure); (4) invented specs or a bare third-party brand not framed as "compatible with"; (5) any TRADEMARKED phrase (sports teams, leagues, universities, media franchises, e.g. "World Cup", "Florida Gators", "Super Bowl", "Marvel") — REQUIRE the safe substitution ("World Cup" -> "World Soccer Cup", "Super Bowl" -> "Big Game") or removal; (6) exceeding the visible-character cap or weak structure (no hook, no <ul>). Be specific per description.',
    `Brief the description must satisfy:\n${baseUser}\n\nCandidate HTML descriptions for the SAME product:\n${numbered}\n\nCritique EACH, then name the single strongest element across them.`,
    0.3, 600, COUNCIL_MODEL, 60_000,
  )
  onProgress?.('Description council: judge synthesizing the winner...')        // keepalive
  const judged = await ask(
    baseSystem + ' You are the JUDGE: merge the strongest, ACCURATE elements into ONE final HTML description that satisfies every rule in the brief, grounds every claim in the real product facts (never search phrases), stays within the visible-character cap, and reads like a human wrote it. Return ONLY the HTML — no markdown, no JSON, no commentary.',
    `${baseUser}\n\nCandidate descriptions:\n${numbered}\n\nCritic review:\n${critique}\n\nReturn ONLY the single best final HTML description.`,
    0.2, 1200, COUNCIL_MODEL, 60_000,
  )
  // Fail open to the FACTS-grounded draft (persona #1, the textile/product expert), NOT the creative one
  // (#0): if the judge errors or returns empty, the facts-grounded draft is the safest fallback. Logged.
  if (!judged) console.warn('[description-council] judge returned empty — failing open to the facts-grounded draft')
  return judged || drafts[1] || drafts[0]
}

async function runDescriptionAgent(input: PipelineInput, finalTitle: string, bullets: string[], attributes: string[], compatibilityBrands: string[] = [], topOpportunityKws: string[] = [], useCouncil = true): Promise<string> {
  const { openai, category, repTitle, children, productType } = input
  const apparel = looksApparel(category, repTitle, productType)
  // Capacity-family detection (mirrors bullets): shared description must NOT hardcode a
  // capacity that doesn't match every variant.
  const descChildCaps = new Set<string>()
  for (const c of children) { const cap = capacityOf(c.sku) || capacityOf(c.title); if (cap) descChildCaps.add(cap) }
  const descCapacityFamily = !apparel && descChildCaps.size >= 2
  const descFamilyCapList = [...descChildCaps].join(', ')
  const attrLine = attributes.length
    ? `\nNaturally mention these known product attributes (real facts from the listing${apparel ? ' — e.g. garment brand, material, fit' : ''}): ${attributes.join(', ')}.`
    : ''
  // SEO: weave the top opportunity search phrases into the copy (PO 2026-06-17: the description was
  // design-pretty but had ZERO of the high-volume keywords like "graphic tees for women"). Top few
  // only, woven naturally — the 900-980 cap + "no stuffing" rule keep it readable, not a keyword list.
  const kwLine = topOpportunityKws.length
    ? `\n🟢 HIGH-VALUE SEARCH PHRASES — weave 3-5 of these in NATURALLY where they genuinely fit the copy (do NOT list them, do NOT stuff, skip any that would read awkwardly): ${topOpportunityKws.slice(0, 8).join(', ')}.`
    : ''
  // Widow-format wearer-POV rule (parity with runBulletsAgent — B0FRYMM56C shipped "Celebrate your
  // golf-loving spirit" on a Golf Widow tee). No-op when not a widow-format title.
  const widow = detectWidowFormat(finalTitle, repTitle)
  const widowLine = widowFormatRule(widow)

  const system = `You are an Amazon SEO copywriter${apparel ? ' for apparel' : ''}. Return ONLY the HTML description (no markdown, no JSON). Describe ONLY the actual product — never invent an audience, profession, occasion, or product type the product is not explicitly about.`
  const user = `${widowLine}Write a CONCISE, VIVID HTML product description (generic for all variants) of 900-980 characters of VISIBLE text (excluding HTML tags) — about 160-170 words; anything under ~160 words will land short of the 900-character floor — using <p>, <b>, <ul>, <li>. The HTML MUST include a <ul> feature list (2-4 <li> items) — a description with no bulleted list is REJECTED. Fill the length with REAL SUBSTANCE grounded in the product facts below — ${apparel ? "the design/theme story, fabric and feel, fit, construction, care, and styling/occasions" : "the product's real features, specs, materials, quality, and use cases"}. Do NOT weave in search queries or repeat shopper-search phrasing (e.g. "graphic tees for women", "cotton tshirts for women", "relaxed tshirts for women") — those live in the BACKEND keywords, never the description prose. Be tight and punchy; lead with the strongest selling point. Do NOT exceed 980 visible characters.
Title: ${finalTitle}
Bullet themes: ${bullets.map((b) => b.split(' - ')[0]).join(', ')}${attrLine}${kwLine}

🚫 ACCURACY: describe ONLY what the title says this product is${apparel ? '' : ' — do NOT reframe it as apparel / a t-shirt / clothing unless it genuinely is one'}. Do NOT claim it is for a profession/role/occasion not named in the title — never write "teacher", "nurse", "mom", "educator", "coach", etc. unless that word is in the title. If a bullet theme above implies such a claim, ignore that theme and describe the actual product instead.

🚫 BRAND-NAME SAFETY (Amazon Jan 2025 policy): any third-party brand name (Canon, Nikon, Sony, GoPro, SanDisk, Kingston, Lexar, Samsung, Apple, iPhone, DJI, Bose, etc. — anything not your own brand) appears ONLY in 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]' phrasing. Examples: ✓ 'compatible with Canon EOS R5 and Sony Alpha cameras', ✗ 'Sandisk-quality storage' (bare brand reference — risks listing suppression and trademark complaints).${compatibilityBrands.length > 0 ? `

🟢 COMPATIBILITY (high-opportunity): the product genuinely works with these device brands and shoppers search for them. Naturally work the top ones into the description using "Compatible with [Brand]" framing (one feature bullet or sentence — never bare): ${compatibilityBrands.join(', ')}. Example: "Compatible with ${compatibilityBrands.slice(0, 2).join(' and ')} cameras". Legal referential use that captures real buyer traffic.` : ''}${descCapacityFamily ? `

🚫 CAPACITY: this family has MULTIPLE capacities (${descFamilyCapList}). The description is SHARED across all variants — NEVER hardcode a specific GB number in any paragraph or bullet (no "128GB and 64GB capacities", no "this 128GB SD card", no "Available in 128GB and 64GB"). Use capacity-agnostic phrasing: "available in multiple capacities", "high-capacity storage", "ample space for your needs". The capacity-specific text already lives in each variant's TITLE.` : ''}

Structure: hook -> <ul> of key features -> use cases/audience -> short closing line. Return ONLY the HTML.`
  // Description COUNCIL for apparel (Approach B — the description is an INDEXED search field, so it now
  // gets the same debate as title/bullets). useCouncil is FALSE for the per-design multi-design loop (it
  // fans out N descriptions via Promise.all — N GPT-5 councils in parallel would risk the Cloudflare
  // idle window), so per-design descriptions keep the single fast agent; only the BROADCAST description
  // gets the council. Output still flows validateDescription + the brand-safety judge + length cap below,
  // so it is additive (fails open). Non-apparel keeps the single fast call.
  let description: string
  if (apparel && useCouncil) {
    description = await runDescriptionCouncil(openai, system, user, input.onProgress)
  } else {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.5,
      max_tokens: 1200,
    })
    description = (completion.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
  }

  // ── METRIC-GATED CRITIC LOOP (task #70) ──────────────────────────────────────
  // Codifies the quality bar we've learned across the session's description fixes as a numeric score
  // (scoreDescription) + hard problems (validateDescription). Loops generate → score+validate →
  // re-prompt with SPECIFIC critiques → keep BEST-SCORED version, up to MAX_ITERS. Threshold = 85/100;
  // if unreached, ships the best-scored candidate anyway (never blank/degrade). Replaces the previous
  // pass/fail max-2 retry loop.
  const { brandName: descBrand } = input
  // PR #90: family capacity tokens for the description capacity-family check (mirrors bullets).
  const descCapTokens = descCapacityFamily ? [...descChildCaps].map((c) => c.toUpperCase()) : []
  if (description && descBrand) {
    const scoringCtx: DescriptionScoringCtx = { widow }
    const MAX_ITERS = 4
    const THRESHOLD = 85
    let bestDescription = description
    let bestScore = scoreDescription(description, scoringCtx).score
    let bestVProblems = validateDescription(description, descBrand, descCapTokens, apparel)
    for (let attempt = 0; attempt < MAX_ITERS - 1; attempt++) {
      const { score, critiques } = scoreDescription(bestDescription, scoringCtx)
      const vProblems = validateDescription(bestDescription, descBrand, descCapTokens, apparel)
      // Done when the quality bar AND hard validators are both clean.
      if (score >= THRESHOLD && vProblems.length === 0) break
      const allProblems = [...critiques, ...vProblems]
      if (allProblems.length === 0) break                 // nothing to critique; can't retry
      try {
        const capClause = descCapTokens.length >= 2
          ? `\n- 🚫 CAPACITY: family spans ${descCapTokens.join(', ')}. The description is SHARED — NEVER hardcode a specific GB/TB ("128GB"). Use capacity-agnostic phrasing only.`
          : ''
        const fix = await openai.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Rewrite the HTML description to FIX these specific problems. The product is "${finalTitle}" — describe ONLY that.
${widowLine}
Problems to fix (score ${score}/100, target ≥${THRESHOLD}):
- ${allProblems.join('\n- ')}

Non-negotiable rules on rewrite:
- 900-980 visible characters (~160-170 words — under ~160 words lands short of the 900 floor) of REAL substance, HTML using <p>, <b>, <ul>, <li>. The <ul>…<li>…</li>…</ul> feature list is REQUIRED. At least one <b>…</b> emphasis on the opening hook.
- Any third-party brand name (Canon/Nikon/Sony/GoPro/SanDisk/Kingston/Lexar/Samsung/Apple/iPhone/DJI/Bose etc. — anything not "${descBrand}") appears ONLY as 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]'.${capClause}
- Return ONLY the HTML — no markdown, no explanation.` },
          ],
          temperature: 0.4,
          max_tokens: 1200,
        })
        const corrected = (fix.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
        if (!corrected) break
        const cScore = scoreDescription(corrected, scoringCtx).score
        const cVProblems = validateDescription(corrected, descBrand, descCapTokens, apparel)
        // Keep-best-scored across all iterations. Ties broken by fewer hard-validator problems.
        if (cScore > bestScore || (cScore === bestScore && cVProblems.length < bestVProblems.length)) {
          bestDescription = corrected
          bestScore = cScore
          bestVProblems = cVProblems
        }
      } catch { break /* keep best-so-far */ }
    }
    description = bestDescription

    // 🛟 Programmatic capacity backstop (PR #90, mirrors the bullets backstop in #79). If a
    // specific capacity still survives in a multi-capacity family's shared description after
    // the retries, strip it deterministically — better awkward phrasing than "128GB" shown
    // on a 32GB variant's PDP.
    if (descCapTokens.length >= 2) {
      description = description
        .replace(/\bthis\s+\d{1,4}\s?(?:GB|TB|MB)\s+/gi, 'this ')
        .replace(/\b\d{1,4}\s?(?:GB|TB|MB)\s+(sd\s+card|memory\s+card|sdhc|sdxc|micro\s*sd)/gi, '$1')
        .replace(/\b\d{1,4}\s?(?:GB|TB|MB)\b/gi, 'high-capacity')
        .replace(/\s{2,}/g, ' ')
    }

    // 🛟 LLM brand-safety judge — final catch-net (PR #80). Strip HTML for the judge
    // (don't ask it to reason about markup); rewrite if flagged.
    try {
      const plainForJudge = description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      const judged = await judgeBrandSafetyLLM(plainForJudge, descBrand, openai, finalTitle)
      const piggyback = judged.detected.filter((d) => d.classification === 'piggyback')
      const compatBare = judged.detected.filter((d) => d.classification === 'compatibility' && !isBrandProperlyFramed(plainForJudge, d.phrase))
      if (piggyback.length > 0 || compatBare.length > 0) {
        const removeList = piggyback.map((d) => `"${d.phrase}"`).join(', ')
        const frameList = compatBare.map((d) => `"${d.phrase}"`).join(', ')
        const instructions = [
          piggyback.length > 0 ? `REMOVE these entirely (no functional tie): ${removeList} — use generic descriptors instead.` : '',
          compatBare.length > 0 ? `KEEP these but frame each as "Compatible with [Brand]" (the product genuinely works with them): ${frameList}.` : '',
        ].filter(Boolean).join(' ')
        const fix = await openai.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Rewrite the HTML description. ${instructions} The product is "${finalTitle}" — describe ONLY that. 900-980 visible characters (~160-170 words) HTML using <p>, <b>, <ul>, <li>; do NOT exceed 980 visible characters. Return ONLY the HTML.` },
          ],
          temperature: 0.4,
          max_tokens: 1200,
        })
        const corrected = (fix.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
        if (corrected) description = corrected
      }
    } catch { /* fail-open */ }
  }

  // ── LENGTH FLOOR: the agent targets 900-980 VISIBLE chars but can under-deliver a thin blurb.
  // One expand pass when under the 900 floor (2026-07-14: was < 850, which left an 850-899 DEAD BAND —
  // live B0FRYMM56C shipped 861/862 twice: too long to expand, too short for the floor, and the critic
  // retries re-anchored on the prompt's old "~150 words" ≈ 860 chars). An in-band (900-980) description
  // is still never expanded. Best-effort; the prompt forbids inventing facts/audiences.
  const plainLen = (d: string) => d.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length
  if (description && plainLen(description) < 900) {
    try {
      const expand = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Expand this product description to 920-970 visible characters (~165 words — ADD roughly ${Math.max(1, Math.ceil((920 - plainLen(description)) / 60))} sentence(s) of real substance: fabric feel, fit specifics, styling, care, or a gift suggestion; do NOT exceed 980 visible characters). Do NOT invent facts, audiences, professions, or uses not already implied. Same product ("${finalTitle}"); keep every third-party brand in "compatible with [Brand]" framing; keep clean HTML (<p>, <b>, <ul>, <li>).

Too-short description to expand:
${description}

Return ONLY the expanded HTML.` },
        ],
        temperature: 0.5,
        max_tokens: 1200,
      })
      const longer = (expand.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
      // Accept only if genuinely longer AND structure survived — the expander must not trade the
      // <ul> list or <b> emphasis for prose length (nothing downstream compares vs pre-expand).
      const keptStructure = (!/<(?:ul|ol)\b/i.test(description) || /<(?:ul|ol)\b/i.test(longer))
        && (!/<(?:b|strong)\b/i.test(description) || /<(?:b|strong)\b/i.test(longer))
      if (longer && keptStructure && plainLen(longer) > plainLen(description)) description = longer
    } catch { /* keep best-so-far */ }
  }

  // Deterministic 980-visible-char cap (extracted to capDescriptionVisible so the SHIP paths can RE-cap
  // after the editorial audit + per-design fan-out, which run AFTER runDescriptionAgent and can re-expand
  // the copy with nothing else re-capping — the "1600-char description" regression).
  description = capDescriptionVisible(description)

  return description
}

/**
 * LLM brand-safety judge (PR #80, hybrid with curated list).
 *
 * The curated TRADEMARK_PHRASES + token-proximity check (PR #77/#79) catches the
 * enumerated marks. But the keyword pool has thousands of brand/trademark queries
 * we'll never exhaustively list — live-verified B0G884ZJ27 regen leaked Ripcurl /
 * Homelander / Spaceballs / Ella Fella / Iration (band) into title + bullets, all
 * outside our set. This judge is the catch-net: one cheap LLM pass per agent output
 * that flags any third-party brand / trademark / proper-noun reference, with the
 * seller's own brand exempt.
 *
 * Returns `{ detected: [{phrase, reason}] }`. Conservative — better false-positive
 * than miss a TM. Fail-open: on error returns empty so the agent ships its current
 * output (don't block a regen on a transient LLM failure).
 */
// PR #86: each finding is CLASSIFIED, not just flagged.
//   - 'piggyback'    → third-party mark with NO functional relationship to the product
//                      (Florida Gators on an alligator tee, Marvel, a band name). REMOVE.
//   - 'compatibility'→ a device/platform the product GENUINELY works with (Canon/Sony/
//                      Nikon/GoPro for an SD card). High-value — KEEP, ensure it's framed
//                      'Compatible with [Brand]'. NEVER bare.
export type BrandClassification = 'piggyback' | 'compatibility'
export interface BrandSafetyFinding { phrase: string; reason: string; classification: BrandClassification }
export async function judgeBrandSafetyLLM(
  text: string,
  brandName: string,
  openai: OpenAI,
  /** What the product actually IS (title/category) so the judge can decide genuine
   *  compatibility. An SD card IS compatible with Canon cameras; an alligator tee is
   *  NOT 'compatible with' Florida Gators. PR #86. */
  productContext = '',
): Promise<{ detected: BrandSafetyFinding[] }> {
  if (!text || !text.trim()) return { detected: [] }
  // PR #81: gpt-5 (gpt-4.1-mini lacked recall). PR #86: now also CLASSIFIES each brand.
  const system = `You are a STRICT Amazon trademark judge. Find every third-party brand, trademark, sports team, university, media franchise, character, band, or proper-noun reference the seller can't use unlicensed — then CLASSIFY each one.

Classification (critical):
- "compatibility": the product GENUINELY works with this device/platform brand. Example: an SD card IS compatible with Canon, Sony, Nikon, GoPro, DJI, Kodak, Nintendo Switch cameras/devices. A phone case IS compatible with iPhone/Samsung. These are LEGITIMATE to reference as "Compatible with [Brand]" and are high-value — KEEP them, just ensure proper framing.
- "piggyback": the product has NO functional relationship to the brand — it's riding the trademark. Example: an alligator graphic tee is NOT "compatible with" Florida Gators; a generic mug is NOT compatible with Marvel. Band names, movies, sports teams, unrelated apparel brands on novelty goods. These must be REMOVED.

The test: would "[product] compatible with [brand]" be TRUE and meaningful? If yes → compatibility. If it's nonsense → piggyback.

Rules:
1. Classify EVERY third-party proper-noun. If unrecognized and not generic English, include it (default "piggyback" when unsure of a functional relationship).
2. NEVER flag generic English (alligator, lion, gator, vintage, retro, cool).
3. NEVER flag the seller's own brand "${brandName}".
4. NEVER flag pure descriptors (XL, Black, JPEG).

Return ONLY {"detected":[{"phrase":"<exact substring>","classification":"compatibility|piggyback","reason":"<one line>"}]}.`
  const user = `Seller brand: ${brandName}
Product: ${productContext || '(infer from text)'}

Text to review:
"""
${text.slice(0, 1800)}
"""

Classify EVERY third-party brand/trademark/proper-noun reference.

COMPATIBILITY examples (product genuinely works with them → keep, frame as "Compatible with"):
- SD card / memory: Canon, Sony, Nikon, Fujifilm, Panasonic, GoPro, DJI, Kodak PixPro, Nintendo Switch, Raspberry Pi
- Phone/tablet accessory: iPhone, Samsung Galaxy, iPad, Pixel

PIGGYBACK examples (no functional tie → remove):
- Apparel/novelty: Florida Gators, Dallas Cowboys, Marvel, Disney, Star Wars, Harry Potter, Homelander, Ripcurl, Iration, Ella Fella, Spaceballs

Return ONLY the JSON object.`
  try {
    const r = await openai.chat.completions.create({
      model: process.env.BRAND_SAFETY_JUDGE_MODEL || 'gpt-5',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: 700,
      response_format: { type: 'json_object' },
    })
    const parsed = parseJsonLoose<{ detected?: { phrase?: string; reason?: string; classification?: string }[] }>(r.choices[0]?.message?.content || '{}')
    const detected: BrandSafetyFinding[] = Array.isArray(parsed.detected) ? parsed.detected
      .filter((f) => f && typeof f.phrase === 'string' && f.phrase.trim().length > 0)
      .map((f): BrandSafetyFinding => ({
        phrase: f.phrase!.trim(),
        reason: typeof f.reason === 'string' ? f.reason : '',
        // Default to the SAFE side (piggyback = remove) when the model omits/garbles it.
        classification: f.classification === 'compatibility' ? 'compatibility' : 'piggyback',
      }))
      .slice(0, 15) : []
    return { detected }
  } catch {
    return { detected: [] }
  }
}

// ─── Stage 0b — Relevance gate (PR17) ─────────────────────────────────────────
// Jungle Scout / competitor pulls contaminate the keyword set with terms that are
// not about THIS product (other brands, trademarks, bands, character/personal names).
// Left unfiltered, they leak into the backend core (code-built) and reconciliation —
// and pushing a trademark like "florida gators" to live listings is a TOS risk.
// One cheap classifier pass drops clearly-unrelated terms. Conservative + fail-open.
async function filterRelevantKeywords(input: PipelineInput, analysis: AnalyzedKeyword[]): Promise<AnalyzedKeyword[]> {
  if (analysis.length === 0) return analysis
  const { openai, brandName, repTitle, category } = input
  const list = analysis.map((k, i) => `${i}: ${k.keyword}`).join('\n')
  const system = 'You are an Amazon SEO relevance filter. Return ONLY valid JSON: {"drop":[<indices to drop>]}.'
  const user = `Product brand: ${brandName}
Category: ${category}
Current product title (context only): ${repTitle ?? '(unknown)'}

Keywords (index: phrase):
${list}

Return the indices of keywords to DROP:
1. Other companies' brands or TRADEMARKS (sports teams, bands, other sellers); a keyword for a DIFFERENT physical product than this listing sells — e.g. "sim card", "card reader", or "phone case" on an SD-MEMORY-CARD listing, or "mug" on a t-shirt listing (the shopper typing it wants a different item, so ranking there only brings junk traffic that never converts); or personal/character names with no connection to this product.
2. VAGUE, non-descriptive filler that does not describe a product attribute, style, design, audience, occasion, or use case (e.g. "interest", "full transparency", "high quality", "best seller").
KEEP anything plausibly about this product, including broad descriptors, audiences, occasions, gift terms, and seasonal terms (relevant even when broad). Be CONSERVATIVE — only drop clearly-unrelated or clearly-meaningless terms. Return ONLY JSON: {"drop":[...]}.`
  // Deterministic backstops: ALWAYS drop these regardless of the LLM gate, which is
  // non-deterministic and let them through in live testing.
  //   1. all-junk keywords ("interest", "full transparency", "best seller")
  //   2. trademark phrases (sports teams, universities, media franchises) — PR #77
  //      after live B0G884ZJ27 audit leaked "Florida Gators" into a recommended title.
  //      Generic team-mascot words ("alligator", "gators", "lions") still pass through
  //      — only the multi-word REGISTERED phrases are dropped.
  const ownBrandsForGate = ownBrandTokenSet(brandName)
  const apparelForGate = looksApparel(category, repTitle, input.productType)
  // Listing haystack for isOffNicheKeyword's own-brand + activewear-listing + this-listing's-own-cut guards.
  const offNicheCtx = `${repTitle ?? ''} ${input.canonicalTitle ?? ''} ${brandName}`
  const dropJunkAndTrademarks = (kws: AnalyzedKeyword[]) => kws.filter((k) => {
    if (isAllJunk(k.keyword)) return false
    if (findTrademarkPhrases(k.keyword).length > 0) return false
    // Competitor brands (Nike, Adidas, …) — DROP at the pool SOURCE so no agent or coverage backstop
    // ever sees "nike shirts women" as a required keyphrase (B0FRYMM56C). Mirrors the trademark backstop
    // above; the seller's OWN brand is exempt via ownBrandTokenSet. A tee is not "compatible with" Nike.
    if (findThirdPartyBrands(k.keyword, ownBrandsForGate).length > 0) return false
    // OFF-NICHE net (2026-07-15, B0H7L6KNNX): this pool feeds backendPool, and it was the ONE seam that
    // still bypassed isOffNicheKeyword — so a non-deterministic LLM-gate miss seated foreign-language dupes
    // ("grafica", "playeras mujer"), wrong-cut ("sleeveless printed jerseys"), competitor blanks, and
    // equipment straight into the shipped backend search terms. Deterministic + apparel-gated + context-
    // guarded (own brand / a genuine activewear listing / this listing's own cut are KEPT). This makes the
    // backend pool honor the SAME off-niche predicate as the scorer, RANK panel, route, and ingestion
    // (coherence Invariant 1 — one predicate everywhere, no disagreeing seam).
    if (apparelForGate && isOffNicheKeyword(k.keyword, { context: offNicheCtx })) return false
    return true
  })
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    })
    const parsed = parseJsonLoose<{ drop?: number[] }>(completion.choices[0]?.message?.content || '{}')
    const rawDrop = new Set((parsed.drop ?? []).filter((n) => Number.isInteger(n)))
    // BACKEND_CRITICAL_KEYWORDS: never let the non-deterministic LLM gate demote a CRITICAL SEARCH TERM
    // (it reads "spain jersey" as a sports-team / "different physical product"). The deterministic
    // dropJunkAndTrademarks below STILL removes genuine trademarks/3P-brands/off-niche even when CRITICAL,
    // so real infringers still go. This also prevents the IRRELEVANT ratchet (ai-recommendations route
    // ~:885) from permanently demoting the seller's top money keywords out of every future backend pool.
    const critDropped = [...rawDrop].filter((n) => analysis[n]?.actionType === 'CRITICAL')
    if (BACKEND_CRIT_SHADOW && critDropped.length) {
      console.log(`[BACKEND_CRIT_DIFF] relevance gate would-drop CRITICAL: ${critDropped.map((n) => analysis[n]?.keyword).join(' | ')}`)
    }
    const drop = BACKEND_CRIT_ON ? new Set([...rawDrop].filter((n) => analysis[n]?.actionType !== 'CRITICAL')) : rawDrop
    const filtered = analysis.filter((_, i) => !drop.has(i))
    // Fail-open: if the gate dropped (nearly) everything it likely misfired — keep the original pool.
    if (filtered.length < Math.max(3, Math.floor(analysis.length * 0.3))) return dropJunkAndTrademarks(analysis)
    return dropJunkAndTrademarks(filtered)
  } catch (err) {
    console.warn('[pipeline] relevance gate failed, using unfiltered pool:', err)
    return dropJunkAndTrademarks(analysis)
  }
}

// ─── Stage 0c — Known-attribute extraction (PR: known-attribute-injection) ─────
// Jungle Scout seeds the keyword pool from the IMAGE/title, so seller-known product
// FACTS that aren't search-derived — the garment/blank brand ("Comfort Colors"),
// material, fit — fall out entirely. They live in the CURRENT listing (title/bullets/
// backend) but no code path surfaces them. This reads them back from the existing
// listing text and returns them so they can be reinforced across every surface.
interface ProductAttributes {
  /** Real search terms a shopper would type — e.g. "comfort colors graphic tee". Title-eligible. */
  searchKeyphrases: string[]
  /** Specs that are NOT search terms — e.g. "garment dyed", "ring spun cotton", "relaxed fit".
   *  Go in bullets / description / structured Product-Detail fields, NEVER the title. */
  specs: string[]
}

async function extractProductAttributes(input: PipelineInput): Promise<ProductAttributes> {
  const { openai, repTitle, variantDetails, category, productType } = input
  const apparel = looksApparel(category, repTitle, productType)
  const text = `${repTitle ?? ''}\n${variantDetails}`.slice(0, 4000).trim()
  if (!text) return { searchKeyphrases: [], specs: [] }
  const system = `You extract product attributes from an existing Amazon${apparel ? ' apparel' : ''} listing, split into searchable keyphrases vs specs. Return ONLY valid JSON: {"searchKeyphrases":["..."],"specs":["..."]}.`
  const user = `From the listing text, extract TWO groups:

1. searchKeyphrases — terms a shopper would actually TYPE into Amazon search.${apparel ? ' In particular, if a recognizable garment BLANK BRAND is present (e.g. comfort colors, bella canvas, gildan, next level, american apparel), output it COMBINED with the product type as a real query — e.g. "comfort colors graphic tee", "comfort colors shirt".' : ' Combine the product type with its key descriptors as real buyer queries (e.g. "64gb sd card", "high speed memory card").'} 2-4 words each. These are TITLE-eligible.

2. specs — concrete product SPECIFICATIONS that nobody searches: ${apparel ? 'material/fabric, weight, fit/cut, dye method (e.g. "ring spun cotton", "6.1 oz", "garment dyed", "relaxed fit", "unisex")' : 'material, dimensions, capacity, compatibility, technical ratings (e.g. "class 10", "uhs-i", "waterproof")'}. These go in bullets/description/structured fields, NOT the title.

Only include attributes actually stated or strongly implied — do NOT invent. Lowercase. Max 4 per group.

Listing text:
${text}

Return ONLY {"searchKeyphrases":[...],"specs":[...]}.`
  const clean = (arr?: string[]) =>
    Array.isArray(arr) ? arr.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim().toLowerCase()).slice(0, 4) : []
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: 250,
      response_format: { type: 'json_object' },
    })
    const parsed = parseJsonLoose<{ searchKeyphrases?: string[]; specs?: string[] }>(completion.choices[0]?.message?.content || '{}')
    return { searchKeyphrases: clean(parsed.searchKeyphrases), specs: clean(parsed.specs) }
  } catch (err) {
    console.warn('[pipeline] product attribute extraction failed:', err)
    return { searchKeyphrases: [], specs: [] }
  }
}

/**
 * Extract the seller's DESIGN / SLOGAN NAME from the current title — the product's identity
 * (the graphic/phrase printed on the shirt, mug, sticker, etc.). PR #91.
 *
 * The agent kept paraphrasing "Later Gator" (the seller's actual design name, leading their
 * live title) into "See You Later Alligator" / "Crocodile Design" and DROPPING the real name.
 * The design name is the seller's brand identity for that product — it MUST survive verbatim
 * into the optimized title/bullets/description, the same way the money keyword does.
 *
 * Returns '' when there's no distinct design name (most non-apparel — an SD card has no
 * "design", its identity is its specs). Apparel/novelty almost always has one.
 */
/** The distinctive design/slogan phrase that LEADS a print-on-demand apparel title — the words
 *  before the first generic descriptor ("Later Gator" in "Later Gator Vintage 90s T-Shirt..."). A
 *  deterministic fallback for when the LLM design-name extraction returns nothing, so apparel always
 *  surfaces its design name (the seller flagged the dropped name 3×, so empty is not acceptable when
 *  a clear lead exists). */
export function leadingDesignPhrase(title: string, brandName: string): string {
  const STOP = /^(?:vintage|retro|classic|\d{2,4}s?|t|tshirt|tshirts|tee|tees|shirt|shirts|hoodie|hoodies|sweatshirt|sweater|tank|top|tops|comfort|color|colors|graphic|graphics|soft|premium|quality|unisex|man|mans|men|mens|woman|womans|women|womens|ladies|youth|adult|kid|kids|toddler|baby|for|gift|gifts|funny|cute|cool|novelty|design|designs|apparel|clothing|crewneck|crew|long|short|sleeve|sleeves|cotton|ringspun|the|a|an|and|with|by|ideal|perfect|great)$/i
  // Normalize curly apostrophes (U+2019 / U+2018) to straight BEFORE the word-cleaning regex runs.
  // The cleaner strips anything not in [A-Za-z0-9'] — so a curly apostrophe ("Don’t") was
  // silently dropped to "Dont", then accept() substring-checked it against the canonical title
  // (which still had the curly), failed, and the design name returned empty (B0GQVL3K4B, 2026-06-14).
  let t = (title || '').replace(/[’‘]/g, "'").trim()
  if (brandName && t.toLowerCase().startsWith(brandName.toLowerCase())) t = t.slice(brandName.length).trim()
  const words = t.replace(/[—–]+/g, ' ').split(/[\s\-]+/).filter(Boolean)
  const lead: string[] = []
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z0-9']/g, '')
    // SKIP generics BEFORE the design phrase starts, stop at the first generic AFTER it:
    // "Comfort Colors Darlin' T-Shirt …" used to BREAK on word 1 ("comfort") and return ''
    // — the heuristic could only find designs at the very start of the title (B0FKLGWZ4C).
    if (!clean || STOP.test(clean)) {
      if (lead.length === 0) continue
      break
    }
    lead.push(clean)
    if (lead.length >= 8) break   // slogans run long ("I Will Praise Him in Every Season" = 7 words); STOP words cap junk earlier
  }
  return lead.join(' ').trim()
}

/**
 * Extract the seller's DESIGN / SLOGAN NAME ("Later Gator") to anchor it verbatim into the title.
 *
 * Source FIX: prefer the CANONICAL title (listing_seo_scores.product_title — what the seller &
 * dashboard actually see, sourced from the best-selling child). The earlier version read
 * input.repTitle = children[0] = the ALPHABETICALLY-FIRST variant, whose stored listing_content
 * title is often a stale/secondary one that does NOT lead with the design name — so the LLM
 * extracted from the wrong title and the substring guard nulled it, silently dropping "Later Gator".
 *
 * Returns { name, source } where source is a debug tag (llm:canonical / heuristic:canonical /
 * empty:rep / none) surfaced into titleDebug so a live regen proves which path ran.
 */
async function extractDesignName(input: PipelineInput): Promise<{ name: string; source: string }> {
  const { openai, repTitle, category, canonicalTitle, brandName, visionDesign, productType, designNameOverride } = input
  // SELLER OVERRIDE — short-circuits the whole chain (LLM + vision + heuristic). The override is the
  // seller's deterministic answer to "what IS the design"; trust it verbatim (just normalize curly
  // apostrophes so downstream substring checks behave). Empty/whitespace-only string falls through.
  // NOTE: in the multi-design group loop this `designNameOverride` is ALREADY anchor-gated upstream
  // (fix/content-anchor-not-color): a garment color can never reach here as the override, so the
  // verbatim short-circuit is safe to trust — no color test is needed at this point.
  if (designNameOverride && designNameOverride.trim()) {
    return { name: designNameOverride.trim().replace(/[’‘]/g, "'"), source: 'override' }
  }
  const usingCanonical = !!(canonicalTitle && canonicalTitle.trim())
  const source = usingCanonical ? canonicalTitle!.trim() : (repTitle || '')
  const titleTag = usingCanonical ? 'canonical' : 'rep'
  // GROUND TRUTH: the design is PRINTED on the product, so the IMAGE (visionScanner) names it far
  // more reliably than a keyword-stuffed title. This is what fixes "See You Later Alligator" (a
  // title paraphrase) beating the real printed "Later Gator".
  const visionText = visionDesign
    ? [visionDesign.designTheme, ...(visionDesign.visualElements || []), ...(visionDesign.seedKeywords || [])].filter(Boolean).join(' | ')
    : ''
  const apparel = looksApparel(category, source, productType) || (!!visionText && looksApparel(category, visionText, productType))
  // Design names live on apparel / novelty / print products. Skip pure-spec products (an SD card has
  // no "design" — its identity is its specs).
  if ((!source && !visionText) || !apparel) return { name: '', source: 'none' }

  // Identify the DESIGN NAME. "Which phrase names the design" is a SEMANTIC call, so the LLM is the
  // PRIMARY extractor; the deterministic pieces only VALIDATE its answer or stand in when it returns
  // nothing. (Earlier versions collected vision search-term seeds + picked "fewest words", which
  // overfit: junk seeds beat long names and 1-word names — verified across designs.)
  // Normalize curly apostrophes BEFORE matching: the canonical title often carries "Darlin’"
  // (U+2019) while the LLM answers with a straight "Darlin'" — the substring check then
  // rejected the CORRECT answer and the design anchor silently vanished (B0FKLGWZ4C: the
  // unanchored agent invented "Urban Pulse"). snapToSource/finalize still recover the
  // title's exact punctuation afterwards.
  const normApos = (s: string) => s.replace(/[’‘]/g, "'")
  const haystack = normApos(`${visionText} ${source}`.toLowerCase())
  // Conservative generics to strip from a candidate's EDGES (product types, blank brand, audience) —
  // NOT subjective words like "cool"/"funny" that can be part of a design ("Cool Cats", "Big Dill").
  const GENERIC_TAIL = /^(t-?shirts?|tshirts?|shirts?|tees?|hoodies?|sweat\w*|sweaters?|tanks?|graphics?|vintage|retro|classic|\d{2}s|comfort|colou?rs?|apparel|clothing|garments?|premium|quality|soft|blank|unisex|m[ae]ns?|wom[ae]ns?|ladies)$/i
  const trimGeneric = (s: string): string => {
    let w = s.trim().split(/\s+/)
    while (w.length > 1 && GENERIC_TAIL.test(w[w.length - 1])) w = w.slice(0, -1)
    while (w.length > 1 && GENERIC_TAIL.test(w[0])) w = w.slice(1)
    return w.join(' ')
  }
  // fixApostropheCase (PO 2026-08-09, §4): an apostrophe is a NON-word char, so `\b` fires between
  // "women'" and "s" and this pass would emit "Women'S". Post-net rather than a rewritten regex so
  // every other casing behavior here stays byte-identical.
  const titleCase = (s: string) => fixApostropheCase(s.replace(/\b\w/g, (c) => c.toUpperCase()))
  // accept(): a design name must ACTUALLY appear in the title or image text (rejects LLM
  // hallucination/paraphrase), is not the seller's own brand, is 1-6 words, and is not entirely
  // generic. Generic edge words are trimmed first ("Later Gator Shirt" -> "Later Gator").
  const accept = (cand: string | undefined | null): string => {
    // Strip WRAPPING quotes only — double/smart quotes always, single quotes only as a balanced
    // pair — so a word-final apostrophe survives ("Darlin'" stays "Darlin'").
    let raw = (cand || '').trim().replace(/^["“”]+|["“”]+$/g, '')
    if (raw.length > 1 && raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1)
    const n = trimGeneric(raw)
    if (!n) return ''
    const words = n.split(/\s+/)
    if (words.length > 8) return ''   // inspirational/scripture slogans run 7-8 words ("I Will Praise Him in Every Season")
    if (words.every((w) => GENERIC_TAIL.test(w))) return ''
    if (!haystack.includes(normApos(n.toLowerCase()))) return ''
    if (brandName && n.toLowerCase() === brandName.toLowerCase()) return ''
    return n
  }

  // Recover the design name's EXACT form from the seller's title: the LLM commonly drops the
  // apostrophe ("Darlin" for "Darlin'") and accept() lets it pass (substring match). The title is
  // authoritative for punctuation. Then normalize a curly apostrophe (U+2019) to a straight one so
  // all downstream matching is consistent. Generalizes to Lovin', Y'all, Mom's, etc.
  const snapToSource = (n: string): string => {
    if (!n) return n
    const pat = n.split(/\s+/).filter(Boolean)
      .map((w) => w.replace(/['’][A-Za-z]*$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + `(?:['’][A-Za-z]*)?`)
      .join('\\s+')
    try { const m = source.match(new RegExp(`\\b${pat}`, 'i')); if (m?.[0]) return m[0].replace(/\s+/g, ' ').trim() } catch { /* keep n */ }
    return n
  }
  const finalize = (n: string): string => snapToSource(n).replace(/’/g, "'")

  // PRIMARY — the LLM makes the semantic call. Reliability lever = FEW-SHOT demonstrations (arXiv
  // 2403.02130: ~80% -> ~91% F1) spanning the distribution: short-brand-vs-long-paraphrase,
  // long-slogan-IS-the-design, one-word, mid-length, and generic -> empty.
  try {
    const system = `You extract the DESIGN NAME of a print-on-demand apparel/novelty product: the distinctive phrase that NAMES the artwork (its slogan, character, or joke) as the seller brands it. It is NOT the product type, blank/garment brand, audience, or generic descriptors.

- If the design has a SHORT brandable name AND a longer printed slogan of the SAME joke, return the SHORT name.
- If the design's identity IS a full slogan with no shorter form, return the whole slogan.
- Use wording that actually appears in the Title or Image below — never invent or paraphrase.
- If the listing is only generic descriptors (a blank tee, no distinct design), return "".

Examples:
Title: THE CEO See You Later Alligator Shirt Later Gator Comfort Colors Gators Tee for Men and Women | Image: cartoon alligator, text 'Later Gator'
=> {"designName":"Later Gator"}
Title: Comfort Colors Houston I Have So Many Problems Raccoon Shirt Funny Meme Graphic Tee
=> {"designName":"Houston I Have So Many Problems"}
Title: Comfort Colors Darlin' T-Shirt Country Western Graphic Tee Vintage Rodeo for Women
=> {"designName":"Darlin'"}
Title: Comfort Colors I Could Be Meaner Shirt Sarcastic Funny Saying Tee
=> {"designName":"I Could Be Meaner"}
Title: Gildan Unisex Soft Cotton Crewneck T-Shirt Premium Blank Tee Vintage
=> {"designName":""}

Return ONLY JSON: {"designName":"<phrase or empty string>"}.`
    const user = `${visionText ? `Image: ${visionText}\n` : ''}Title: ${source}\n\nReturn ONLY JSON: {"designName":"..."}.`
    const r = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: 40,
      response_format: { type: 'json_object' },
    })
    const parsed = parseJsonLoose<{ designName?: string }>(r.choices[0]?.message?.content || '{}')
    const llm = accept(parsed.designName)
    if (llm) return { name: finalize(llm), source: `llm:${titleTag}` }
  } catch (err) {
    console.warn('[pipeline] design-name LLM extraction failed:', err)
  }

  // FALLBACK 1 (LLM empty/failed) — a QUOTED printed string from the image (the scanner emits e.g.
  // `text 'Later Gator'`): literally what's on the artwork, a clean signal unlike search-term seeds.
  for (const el of visionDesign?.visualElements || []) {
    const m = String(el).match(/['"“”]([^'"“”]{2,40})['"“”]/)
    const v = accept(m?.[1] ? titleCase(m[1]) : '')
    if (v) return { name: finalize(v), source: 'vision' }
  }

  // FALLBACK 2 (last resort) — the title's leading distinctive phrase. May be a paraphrase, but gives
  // the deterministic lead-enforcement something to anchor when both the LLM and image come up empty.
  const heur = accept(leadingDesignPhrase(source, brandName))
  if (heur) return { name: finalize(heur), source: `heuristic:${titleTag}` }

  return { name: '', source: `empty:${titleTag}` }
}

/** Turn an attribute phrase into a synthetic high-opportunity keyword so it flows through
 * the title-candidate / bullets / backend pools via the existing selection logic. */
function attributeAsKeyword(attr: string): AnalyzedKeyword {
  return {
    keyword: attr,
    // Secondary, NOT top-tier: a known attribute ("comfort colors shirt") should be
    // included in the title when it fits, but must never out-rank and crowd out the
    // highest SEARCH-VOLUME real keyword (that regression dropped "see you later
    // alligator shirt", 22.7k/mo, from the title). 35 keeps it above filler, below the
    // genuine money keywords. The orchestrator separately PINS the top-volume keyword.
    coverageGapScore: 35,
    actionType: 'CRITICAL',
    actionText: '', rationale: '', urgency: 'high', estimatedImpact: '',
    searchVolume: 0, keywordSales: 0, competingProducts: 0,
    asinImpressionShare: 0, asinClickShare: 0, asinPurchaseShare: 0,
    inTitle: false, inBullets: false, inDescription: false, inBackend: false,
    // 'inherited', NOT 'jungle_scout' (fixed 2026-08-09). Nothing about this row came from Jungle
    // Scout — it is synthesised from a product ATTRIBUTE and every market field on it is a zero we
    // wrote ourselves. Claiming the provider's name on it made a fabricated row indistinguishable
    // from a measured one at every consumer that branches on dataSource. 'inherited' is the existing
    // union member that already means "carried, not measured"; no schema change.
    dataSource: 'inherited',
  } as AnalyzedKeyword
}

// ─── Title helpers — extracted for single-design AND per-design multi-design reuse ──
//
// buildTitleFor wraps the existing runTitleAgent call + the 5 post-guards (motif-strip,
// audience swap, fill-to-73, blank-brand dedup, brand-front, design-name backstop) so it can
// be called once for a single-design family OR per group in a multi-design family. The single-
// design path produces BYTE-IDENTICAL output to the pre-refactor inline block — that's the
// regression bar. Captured-closure variables from runListingPipeline are passed as parameters.
//
// GUARD ORDER (do not reorder — see runTitleAgent for why each guard matters):
//   1. Vision-hallucination strip (motif + garment)
//   2. Hard audience enforcement
//   3. Fill to 73 chars
//   4. Blank-brand dedup
//   5. Brand-at-FRONT
//   6. Design-name backstop (re-anchor if capTitle75 truncated)
//
// motifTrust is computed INSIDE this function from input.canonicalTitle + input.repTitle +
// designName, so per-design callers naturally scope grounding by passing a cloned input with
// canonicalTitle = the group's child stored title (NOT the parent's canonical — that would
// leak Design A's words into Design B's title; see commit2 pressure-test finding #3).
/** Final title cleanup for the per-child path: strip a DUPLICATE brand (keep the first occurrence,
 *  drop later case-insensitive repeats) and collapse adjacent duplicate words ("Fishing Fishing" →
 *  "Fishing"). The brand-FRONT guard only fixes a brand MISSING from index 0 — it leaves a second
 *  mid-title brand intact (live on B0F6QZ34B1/OF: "THE CEO Only Fins T-Shirt the Ceo Fishing Fishing
 *  Tee"). No-op on already-clean titles, so single-design output stays byte-identical. */
/** Layer 2 of the A+B architecture (council 2026-07-03): ONE batched LLM read of the FINAL
 *  assembled titles — the review surface the pipeline lacked (a council writes the draft, but
 *  deterministic string surgery assembles what ships and no intelligence ever re-read it).
 *  DROP-ONLY VETO: the model may flag comma-segments as broken; it never authors text, so shipped
 *  bytes stay deterministic. A PROTECT-MASK makes the brand/design lead, mustInclude/attributePin
 *  carriers, and the audience tail untouchable. Modes via TITLE_COHERENCE_GATE env:
 *  'shadow' (default — log would-drops + titleProblems note, never mutate), 'enforce' (drop
 *  flagged segments), 'off'. Promotion to enforce is a PO decision from measured shadow precision.
 *  FAIL-OPEN LOUD: any LLM/parse failure returns titles unchanged with a visible note (this
 *  codebase has been burned by silent best-effort catches — cookies()-client incident). */
async function coherenceGateTitles(
  openai: OpenAI,
  items: { id: string; title: string; designName?: string; mustInclude?: string; attributePin?: string }[],
  onProgress?: (m: string) => void,
): Promise<Map<string, { title: string; droppedNotes: string[] }>> {
  // STEP 3 (content-quality foundational, PO-approved 2026-07-07 "enforce now"): default ENFORCE. The gate
  // was inert in shadow the whole time bad copy shipped. Set TITLE_COHERENCE_GATE=shadow/off to override.
  const mode = (process.env.TITLE_COHERENCE_GATE || 'enforce').toLowerCase()
  const out = new Map<string, { title: string; droppedNotes: string[] }>()
  for (const it of items) out.set(it.id, { title: it.title, droppedNotes: [] })
  if (mode === 'off' || items.length === 0) return out
  type Seg = { text: string; protectedSeg: boolean }
  const parsed = new Map<string, { segs: Seg[]; tail: string }>()
  const qualifying: { id: string; segs: Seg[] }[] = []
  for (const it of items) {
    const tailMatch = it.title.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
    const tail = tailMatch ? tailMatch[0] : ''
    let head = tail ? it.title.slice(0, it.title.length - tail.length) : it.title
    // A COMMA-BEARING protected needle ("Fish, Fear Me") must survive the split as one segment
    // (adversarial review: splitting first orphaned the name's tail into an unprotected segment).
    for (const needle of [it.designName, it.mustInclude, it.attributePin]) {
      if (!needle?.trim() || !needle.includes(',')) continue
      try {
        const esc = needle.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        head = head.replace(new RegExp(esc, 'gi'), (m) => m.replace(/,/g, '\u0001'))
      } catch { /* unparseable needle - fall through to plain split */ }
    }
    const parts = head.split(/,\s*/).map((t) => t.replace(/\u0001/g, ','))
    const protHas = (s: string, needle?: string | null) => !!needle?.trim() && s.toLowerCase().includes(needle.trim().toLowerCase())
    const segs: Seg[] = parts.map((text, i) => ({
      text,
      protectedSeg: i === 0 || protHas(text, it.designName) || protHas(text, it.mustInclude) || protHas(text, it.attributePin),
    }))
    parsed.set(it.id, { segs, tail })
    if (segs.length >= 2 && segs.some((s) => !s.protectedSeg)) qualifying.push({ id: it.id, segs })
  }
  if (qualifying.length === 0) return out   // nothing droppable anywhere — zero LLM cost
  onProgress?.('Coherence review: reading final titles...')
  try {
    const lines = qualifying.map((q) => `${q.id}: ${q.segs.map((s, i) => `[${i}${s.protectedSeg ? '*' : ''}] ${s.text}`).join(' | ')}`).join('\n')
    const r = await openai.chat.completions.create({
      model: process.env.TITLE_COHERENCE_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You review FINISHED Amazon product titles, each split into numbered comma-segments. Flag ONLY clearly broken segments: a phrase torn from its noun ("Too Many", "Plus"), a dangling modifier, word salad. Valid search keyphrases, niche jargon, and audience phrases are NOT broken. Segments marked * are locked - never flag them. Return JSON {"drops":{"<id>":[segmentNumbers]}} listing ONLY genuinely broken segment numbers; return {"drops":{}} when nothing is broken.' },
        { role: 'user', content: lines },
      ],
    }, { timeout: 20_000, maxRetries: 0 })
    const drops = (parseJsonLoose<{ drops?: Record<string, unknown> }>(r.choices[0]?.message?.content || '{}').drops ?? {}) as Record<string, unknown>
    for (const q of qualifying) {
      const flagged = drops[q.id]
      if (!Array.isArray(flagged) || flagged.length === 0) continue
      const idxs = flagged.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < q.segs.length && !q.segs[n].protectedSeg)
      if (idxs.length === 0) continue
      const p = parsed.get(q.id)!
      const dropped = idxs.map((i) => q.segs[i].text)
      const entry = out.get(q.id)!
      if (mode === 'enforce') {
        const keptHead = q.segs.filter((_, i) => !idxs.includes(i)).map((s) => s.text).join(', ')
        entry.title = `${keptHead}${p.tail}`.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').trim()
        entry.droppedNotes.push(`coherence gate dropped: ${dropped.map((d) => `"${d}"`).join(', ')}`)
      } else {
        console.warn(`[coherence-gate][shadow] would drop from ${q.id}:`, dropped.join(' | '))
        entry.droppedNotes.push(`coherence gate (shadow) would drop: ${dropped.map((d) => `"${d}"`).join(', ')}`)
      }
    }
  } catch (e) {
    console.warn('[coherence-gate] skipped (LLM error/timeout):', e instanceof Error ? e.message : e)
    for (const it of items) out.get(it.id)!.droppedNotes.push('coherence gate skipped (LLM error/timeout)')
  }
  return out
}

/** Deterministic description polish (live regen 2026-07-03): headings shipped "THE CEO a Day
 *  Without Fishing T-Shirt" (Title-Case-style article loss upstream) and "Funny Fishing Fishing
 *  Novelty" (adjacent stutter) — the same two repairs titles already get, applied to the
 *  description text. Adversarial-review hardening: names are PLACEHOLDER-PROTECTED before the
 *  stutter collapse (it ate "Mahi Mahi"/"Boo Boo Crew"), the re-snap is word-bounded and
 *  MULTI-WORD-only (a single common-word name like "Fishing" or "Cat" would case-flip prose and
 *  "Boo" would corrupt "bamboo"), and the brand is protected verbatim. */
function polishDescription(desc: string, designName?: string | null, brandName?: string | null): string {
  let d = desc || ''
  const prot: string[] = []
  const stash = (m: string): string => { prot.push(m); return `\u0000${prot.length - 1}\u0000` }
  const dn = designName?.trim()
  if (dn && dn.split(/\s+/).length >= 2) {
    const re = (() => { try { return new RegExp(`\\b${dn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/['’]/g, "['’]?")}\\b`, 'gi') } catch { return null } })()
    if (re) d = d.replace(re, () => stash(dn))   // canonical casing + protection in one move
  }
  const bn = brandName?.trim()
  if (bn) {
    const re = (() => { try { return new RegExp(`\\b${bn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi') } catch { return null } })()
    if (re) d = d.replace(re, (m) => stash(m))   // brand kept verbatim, protected
  }
  d = d.replace(/\b([A-Za-z][\w'’-]*)(\s+\1\b)+/gi, '$1')
  return d.replace(/\u0000(\d+)\u0000/g, (_, i) => prot[Number(i)] ?? '')
}

/** Layer 2 of the bullet coherence fix (council 2026-07-03): the twin of coherenceGateTitles for
 *  bullets — the FINAL assembled re-read that the bullet path never had (the deterministic coverage
 *  backstop's own comment admits "nothing re-validates after it"). Unlike titles, bullets are prose,
 *  so this is a REPAIR gate: it re-weaves dangling raw-token appends (", oversized tshirts.") into
 *  the sentence and collapses residual same-noun variant crams — it never bolts or deletes. Accept
 *  guard is coverage-SAFE under the garment-folded token set (bulletSigTok), so a variant collapse
 *  (tee≈shirt) passes while losing a UNIQUE keyword concept is rejected. Modes via BULLET_COHERENCE_GATE:
 *  'shadow' (default: log would-repairs, never mutate) / 'enforce' / 'off'. Fail-open LOUD. */
// ─── Metric-gated bullets council loop (D1, shadow-first) ──────────────────────────────────────────
// The bullets council runs once, then many stages rewrite the 5 bullets. This gates the SHIP-READY
// bullets against an OBJECTIVE metric and, when they fall short, has the council RE-DELIBERATE against a
// specific deterministic critique (Approach 1, PO-approved 2026-07-10). SHADOW MODE by default
// (Was flag-gated by BULLETS_METRIC_LOOP; enforced-by-default since ~07-17 and the flag was retired
// 2026-08-03 in the flag census — the loop now always runs on apparel. NOTE: an older revision of
// this comment described the parse INVERTED (shadow-default) — the enforced default was live.)

/** Pure coherence-defect predicate, lifted out of coherenceGateBullets so the metric can score coherence
 *  with NO LLM call: a raw lowercase comma-tail fragment (the backstop's ", oversized tshirts." shape) or
 *  one significant concept repeated 3+ times inside a bullet. */
function bulletHasCoherenceDefect(b: string): boolean {
  const seg = (b.split(',').pop() || '').trim().replace(/\.$/, '')
  if (seg && !/[A-Z]/.test(seg)) {
    const w = seg.split(/\s+/)
    if (w.length >= 1 && w.length <= 5 && !w.some((x) => /^(?:and|or|the|with|for|to|a|an)$/.test(x))) return true
  }
  const counts = new Map<string, number>()
  for (const t of bulletTokens(b).map(bulletSigTok)) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts.values()].some((c) => c >= 3)
}

type BulletMetric = { total: number; di: number; co: number; st: number }
/** Objective bullets quality: 0.5·design-identity + 0.3·coherence + 0.2·structure. EXCLUDES keyword
 *  coverage (Content-step-2: coverage lives in backend, not bullets) and the <100-char length dock
 *  (anti-Goodhart, scope B) BY CONSTRUCTION. Every sub-score is in [0,1]; higher = better. */
function scoreBulletsMetric(bs: string[], brandName: string, designName: string): BulletMetric {
  const n = Math.max(1, bs.length)
  // (1) DESIGN IDENTITY — design-name tokens ONLY (fed [designName], never the opportunity pool). Binary:
  //     once the design tokens are present, di=1 and adding any keyword cannot raise it.
  const di = designName.trim() ? (missingBulletKeywords(bs, [designName]).length === 0 ? 1 : 0) : 1
  // (2) COHERENCE — deterministic, no LLM.
  const co = 1 - bs.filter(bulletHasCoherenceDefect).length / n
  // (3) STRUCTURE — validateBullets with EMPTY oppKw (its coverage block no-ops), <100-char dock removed.
  const structProblems = validateBullets(bs, brandName, []).filter((p) => !/under \d+ chars/.test(p))
  // LENGTH (PO 2026-07-16 "not good length"): the scorer docks bullets under 80 chars (#3). The <100
  // validateBullets dock is filtered out above (anti-Goodhart, scope B), so add the scorer's 80-char
  // floor here as SUBSTANCE — never keyword coverage, which stays backend's job (excluded by
  // construction so the loop can never keyword-stuff bullet prose).
  const tooShort = bs.filter((b) => b.trim().length < 80).length
  const st = 1 - Math.min(1, (structProblems.length + tooShort) / n)
  return { total: 0.5 * di + 0.3 * co + 0.2 * st, di, co, st }
}

/** One bullets-JSON model call, fail-open to []. MUST branch on isGpt5 exactly like the council's
 *  askBullets: GPT-5 / o-series REJECT a non-default `temperature` (a 400), so sending one makes every
 *  candidate call throw → [] → the shadow loop silently collects ZERO data and looks like a clean no-op
 *  (the "failure-looks-like-success" trap). gpt-5 uses max_completion_tokens + reasoning_effort instead. */
async function callBulletsModel(openai: OpenAI, system: string, user: string, model: string): Promise<string[]> {
  try {
    const isGpt5 = /^(gpt-5|o\d)/.test(model)
    const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
    const r = await openai.chat.completions.create(
      isGpt5
        ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' as const, response_format: { type: 'json_object' as const } }
        : { model, messages, temperature: 0.4, max_tokens: 1200, response_format: { type: 'json_object' as const } },
      { timeout: 60_000, maxRetries: 0 },
    )
    const parsed = parseJsonLoose<{ bullets?: unknown }>(r.choices[0]?.message?.content || '{}').bullets
    return Array.isArray(parsed) ? parsed.filter((b): b is string => typeof b === 'string' && b.trim().length > 0).map((b) => b.trim()) : []
  } catch { return [] }
}

// "valid JSON" is LOAD-BEARING (the #459/#460 class): OpenAI 400s any json_object call whose
// messages lack the literal word "json" — this prompt lacked it since birth, so every metric-loop
// resynthesis died silently (400 → catch → []) and the loop shipped unchanged. Found by the
// LLM-gateway call census 2026-08-04.
const bulletsResynthSys = (): string => `You are the JUDGE of an Amazon apparel bullets council. You are given 5 CURRENT bullets and a specific CRITIQUE of what is wrong. Rewrite the set to FIX ONLY the critique, keeping everything already good. Each bullet = an ALL-CAPS 2-3 word benefit hook, then " - ", then ONE complete sentence of ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} characters ending in a period. Keep the design identity in at least one bullet. Add NO new brand names, invent NO claims, do NOT keyword-stuff. Return ONLY valid JSON: {"bullets":[5 strings]}.`
function bulletsResynthUser(title: string, designName: string, bullets: string[], critique: string): string {
  return `PRODUCT TITLE: ${title}\nDESIGN IDENTITY (must appear in >=1 bullet): ${designName || '(none)'}\n\nCURRENT BULLETS:\n${bullets.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n\nCRITIQUE TO FIX:\n${critique}\n\nReturn ONLY valid JSON: {"bullets":[5 strings]}.`
}
/** Deterministic critique from the failed metric — no LLM. Names exactly what to fix. */
function bulletsCritique(m: BulletMetric, bullets: string[], designName: string): string {
  const notes: string[] = []
  if (m.di < 1 && designName.trim()) notes.push(`The design identity "${designName}" is missing — weave it naturally into at least one bullet.`)
  const defective = bullets.map((b, i) => (bulletHasCoherenceDefect(b) ? i + 1 : 0)).filter(Boolean)
  if (defective.length) notes.push(`Bullet(s) ${defective.join(', ')} read incoherently (a dangling raw-token tail, or one concept repeated 3+ times) — rewrite them as clean sentences.`)
  // Fork 3 (2026-07-21): critique text (LLM-visible) uses BULLET_MIN_CHARS; the metric dock at
  // scoreBulletsMetric.tooShort (line ~4835) intentionally stays at <80 so the gpt-5 loop doesn't
  // cascade — the terminal expandShortBulletsTerminal (added below) is the real 150-floor enforcer.
  const tooShort = bullets.map((b, i) => (b.trim().length < BULLET_MIN_CHARS ? i + 1 : 0)).filter(Boolean)
  if (tooShort.length) notes.push(`Bullet(s) ${tooShort.join(', ')} are too short (under ${BULLET_MIN_CHARS} characters) — expand each into a full ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} character benefit sentence with real product substance (never padded keywords).`)
  if (m.st < 1) notes.push('Fix weak structure: every bullet needs an ALL-CAPS 2-3 word benefit hook, then " - ", then one complete grammatical sentence.')
  return notes.length ? notes.join('\n') : 'Tighten wording and improve clarity while keeping every bullet accurate.'
}

/** Scores the SHIP-READY bullets; if below the bar, has the council RE-DELIBERATE against a deterministic
 *  critique (<=2 extra calls, strict keep-best). SHADOW: logs the would-ship delta, returns `best` unchanged. */
async function metricGatedBulletsLoop(
  openai: OpenAI,
  shipBullets: string[],
  ctx: { title: string; brandName: string; designName: string; fit: string; onProgress?: (m: string) => void; label: string },
  enableLoop: boolean,
): Promise<string[]> {
  if (!enableLoop) return shipBullets
  // FAIL-OPEN SEED GUARD: never seed from an empty/short council result (quota outage) — do nothing.
  if (!Array.isArray(shipBullets) || shipBullets.length < 5) return shipBullets

  let best = shipBullets                                          // return value — ENFORCED: updated to the best-scored candidate
  // OUTER FAIL-OPEN: shadow is an OBSERVATION path — it must NEVER break a live regen. Any throw in the
  // scoring/model path is logged and swallowed, returning the untouched ship bullets (coherenceGateBullets
  // contract). Default-off (enableLoop false) never reaches here.
  try {
    const model = process.env.BULLETS_COUNCIL_MODEL || process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
    const collapse = (s: string) => s.replace(/\b(\w+)(\s+\1)\b/gi, '$1')
    // CANDIDATES are raw LLM output — apply the deterministic ship gates so the metric scores a faithful
    // proxy of what would ship (the LLM audit is the only unsimulated stage; it polishes, not restructures).
    const shipView = (bs: string[]): string[] => scrubTrademarksArr(bs.map((b) => collapse(scrubFitClaims(deDangle(b), ctx.fit))))
    // The BASELINE is scored AS-IS: it is already the post-everything ship artifact. Re-running shipView on
    // it would double-apply `collapse` (not idempotent for 3+ repeats) and score baseline vs candidate on
    // divergent strings.
    let bestScore = scoreBulletsMetric(shipBullets, ctx.brandName, ctx.designName)
    if (bestScore.total >= 0.90) return best                      // already good (~scorer 85%+) — ship as-is, 0 calls

    const MAX_ITERS = 2                                           // <= 2 extra council calls
    for (let i = 0; i < MAX_ITERS; i++) {
      const critique = bulletsCritique(bestScore, best, ctx.designName)
      const cand = await callBulletsModel(openai, bulletsResynthSys(), bulletsResynthUser(ctx.title, ctx.designName, best, critique), model)
      if (cand.length < 5) break                                  // LENGTH GUARD before any compare
      const candScore = scoreBulletsMetric(shipView(cand), ctx.brandName, ctx.designName)
      if (bestScore.total < candScore.total) {                    // STRICT '<' keep-best
        const shipped = shipView(cand)
        const note = `[bullets-metric-loop][${ctx.label}] iter ${i + 1} improved bullets: total ${bestScore.total.toFixed(3)}->${candScore.total.toFixed(3)} (di ${bestScore.di}->${candScore.di}, co ${bestScore.co.toFixed(2)}->${candScore.co.toFixed(2)}, st ${bestScore.st.toFixed(2)}->${candScore.st.toFixed(2)})`
        console.warn(note)
        ctx.onProgress?.(note)
        best = shipped                                            // ENFORCE: ship the improved set (was shadow-frozen)
        bestScore = candScore                                     // track best SCORE for the next-iter critique
      } else break                                                // no improvement — stop early
    }
  } catch (e) {
    console.warn('[bullets-metric-loop] errored — shipping the best bullets so far:', e instanceof Error ? e.message : e)
  }
  return best
}

/** D — run the metric-gated quality loop on BOTH the per-child multi-design bullets (each DISTINCT design
 *  group looped ONCE; the winner written back to every SKU in that group) and the broadcast bullets, then
 *  return the (possibly improved) broadcast set. Per-child bullets are mutated IN PLACE. MUST be called
 *  BEFORE the per-child truth/audit gate so the looped bytes are still gated (INVARIANT 5). Bounded +
 *  fail-open: scoreBulletsMetric early-returns a healthy group at 0 model calls; a mid-loop throw is
 *  swallowed and keeps the council's per-child bullets. Shared by the full path AND the #79 bullets-only
 *  section-regen path so the ~85 quality bar has dual-write-path parity. */
async function runBulletsMetricLoops(
  openai: OpenAI,
  broadcastBullets: string[],
  perChildBullets: { sku: string; asin: string; bullets: string[]; designName?: string; designKey?: string }[] | undefined,
  ctx: { title: string; brandName: string; designName: string; fit: string; onProgress?: (m: string) => void },
  enableLoop: boolean,
): Promise<string[]> {
  if (!enableLoop) return broadcastBullets
  if (perChildBullets && perChildBullets.length) {
    try {
      const loopedByGroup = new Map<string, string[]>()   // designKey → winning bullets (loop once per group)
      for (const pcb of perChildBullets) {
        const gkey = pcb.designKey || pcb.designName || pcb.sku
        if (!loopedByGroup.has(gkey)) {
          loopedByGroup.set(gkey, await metricGatedBulletsLoop(openai, pcb.bullets, {
            title: ctx.title, brandName: ctx.brandName,
            designName: pcb.designName || ctx.designName, fit: ctx.fit,
            onProgress: ctx.onProgress, label: `design:${pcb.designName || gkey}`,
          }, true))
        }
        pcb.bullets = loopedByGroup.get(gkey)!
      }
    } catch (e) {
      console.warn('[pipeline] per-child bullets metric loop errored — keeping council per-child bullets:', e instanceof Error ? e.message : e)
    }
  }
  return metricGatedBulletsLoop(openai, broadcastBullets, {
    title: ctx.title, brandName: ctx.brandName, designName: ctx.designName,
    fit: ctx.fit, onProgress: ctx.onProgress, label: 'full',
  }, enableLoop)
}

async function coherenceGateBullets(
  openai: OpenAI,
  bullets: string[],
  keyphrases: string[],
  brandName: string,
  onProgress?: (m: string) => void,
): Promise<{ bullets: string[]; notes: string[] }> {
  // STEP 3 (content-quality foundational, PO-approved 2026-07-07 "enforce now"): default ENFORCE. Set
  // BULLET_COHERENCE_GATE=shadow/off to override.
  const mode = (process.env.BULLET_COHERENCE_GATE || 'enforce').toLowerCase()
  if (mode === 'off' || bullets.length === 0) return { bullets, notes: [] }
  // ZERO-COST PRE-FILTER (review: the title gate has one; this had an unconditional LLM call every
  // regen). Only spend the call when a bullet shows a plausible defect: a raw lowercase comma-tail
  // (the backstop's ", oversized tshirts." append shape — Title-Cased prose never looks like that),
  // or an intra-bullet concept repeated 3+ times (a variant cram). No signal → no call.
  const hasDefect = bullets.some(bulletHasCoherenceDefect)   // extracted predicate (shared with the metric loop)
  if (!hasDefect) return { bullets, notes: [] }
  const notes: string[] = []
  onProgress?.('Coherence review: reading final bullets...')
  try {
    const keyphraseList = keyphrases.slice(0, 12).join(', ')
    const r = await openai.chat.completions.create({
      model: process.env.BULLET_COHERENCE_MODEL || 'gpt-4.1-mini',
      temperature: 0,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `You do a FINAL coherence pass on 5 Amazon bullet points. Fix ONLY these two defects, changing nothing else:
1. VARIANT STUFFING — a bullet repeats the same product concept as 2+ permuted phrasings (e.g. "womens graphic t shirts ... women graphic tees ... womens t shirts graphic"): collapse to ONE natural phrasing.
2. DANGLING RAW-TOKEN FRAGMENT — a bullet contains a bolted-on token pile that is not a sentence (", oversized tshirts." / "this tshirts shirt for women graphic offers"): WEAVE those words into the sentence grammatically. Do NOT delete them, do NOT merely relocate them.
Keep each bullet's "ALL-CAPS HOOK - sentence" shape, each <=200 chars, add NO new brand names, invent NO claims. Preserve every distinct keyword concept from this list somewhere across the 5 (weave, never bolt): ${keyphraseList}.
Return JSON {"bullets":[5 strings]}. Return a bullet verbatim if it is already clean.` },
        { role: 'user', content: JSON.stringify(bullets) },
      ],
    }, { timeout: 25_000, maxRetries: 0 })
    const parsed = parseJsonLoose<{ bullets?: unknown }>(r.choices[0]?.message?.content || '{}').bullets
    if (!Array.isArray(parsed) || parsed.length !== bullets.length) { notes.push('bullet coherence gate: bad shape, kept originals'); return { bullets, notes } }
    const repaired = parsed.map((b) => (typeof b === 'string' ? b.trim() : ''))
    // Validate: caps-hook shape, length, no NEW third-party brand, and no LOST keyword concept
    // (garment-folded tokens, so a tee↔shirt variant collapse is coverage-safe; losing a unique
    // concept like "oversized" — i.e. deletion instead of weaving — is rejected).
    const ownBrandSet = ownBrandTokenSet(brandName || '')
    // Set-based, not count-based (review): a brand SWAP keeps the count equal but introduces a new
    // brand — reject if the repaired text carries any brand token absent from the original.
    const beforeBrands = new Set(findThirdPartyBrands(bullets.join(' '), ownBrandSet).map((b) => b.toLowerCase()))
    const newBrand = findThirdPartyBrands(repaired.join(' '), ownBrandSet).some((b) => !beforeBrands.has(b.toLowerCase()))
    const shapeOk = repaired.every((b) => b.length > 0 && b.length <= 200 && /^[A-Z0-9][A-Z0-9 '&/-]*\s[-–—]\s/.test(b))
    const beforeToks = new Set(bulletTokens(bullets.join(' ')).map(bulletSigTok))
    const afterToks = new Set(bulletTokens(repaired.join(' ')).map(bulletSigTok))
    const keyToks = new Set(keyphrases.flatMap((k) => bulletTokens(k).map(bulletSigTok)))
    let lostKey = false
    for (const t of keyToks) if (beforeToks.has(t) && !afterToks.has(t)) { lostKey = true; break }
    if (!shapeOk || newBrand || lostKey) {
      notes.push(`bullet coherence gate: repair rejected (${!shapeOk ? 'shape' : newBrand ? 'new-brand' : 'lost-keyword'})`)
      return { bullets, notes }
    }
    const changed = repaired.map((b, i) => (b !== bullets[i] ? i : -1)).filter((i) => i >= 0)
    if (changed.length === 0) return { bullets, notes }
    if (mode === 'enforce') {
      notes.push(`bullet coherence gate repaired ${changed.length} bullet(s)`)
      return { bullets: repaired, notes }
    }
    for (const i of changed) console.warn(`[bullet-coherence][shadow] would repair bullet ${i + 1}:`, bullets[i], '=>', repaired[i])
    notes.push(`bullet coherence gate (shadow) would repair ${changed.length} bullet(s)`)
    return { bullets, notes }
  } catch (e) {
    console.warn('[bullet-coherence] skipped (LLM error/timeout):', e instanceof Error ? e.message : e)
    return { bullets, notes: ['bullet coherence gate skipped (LLM error/timeout)'] }
  }
}

function dedupeBrandAndStutter(title: string, brandName: string): string {
  let t = (title || '').trim()
  if (brandName && t) {
    const re = new RegExp(`\\b${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    let seen = 0
    t = t.replace(re, () => (++seen === 1 ? brandName.trim() : ''))
      .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[\s,]+$/g, '').trim()
  }
  t = t.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1') // "Fishing Fishing" → "Fishing"; "T-Shirt" is safe (no space)
  return t
}

async function buildTitleFor(
  input: PipelineInput,
  candidates: TitleCandidate[],
  searchKeyphrases: string[],
  titleMustInclude: string | undefined,
  preferredAudience: string,
  attributePinFinal: string | undefined,
  topUpgradeKws: string[],
  compatibilityBrands: string[],
  designName: string,
  lean: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null,
  apparelProduct: boolean,
  brandName: string,
  /** Season policy for THIS regen — forwarded to runTitleAgent → validateTitle. Threaded (not
   *  re-derived) so the single-design branch and each per-design multi-design branch strip against
   *  the SAME occasions the bullets/description/backend pools were built with. */
  season: SeasonPolicy = BLANKET_SEASON_POLICY,
): Promise<{ title: string; problems: string[]; retried: boolean }> {
  const motifTrust = `${input.canonicalTitle ?? ''} ${input.repTitle ?? ''} ${designName}`.toLowerCase()
  const t = await runTitleAgent(input, candidates, searchKeyphrases, titleMustInclude, preferredAudience, attributePinFinal, topUpgradeKws, compatibilityBrands, designName, season)
  const titleProblems = t.problems
  const retried = t.retried
  // 1. Vision-hallucination backstop.
  let finalTitle = apparelProduct ? stripContradictedGarments(stripUngroundedMotifs(t.title, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase(), motifTrust) : t.title
  // 2. HARD audience.
  if (apparelProduct && (lean === 'female' || lean === 'male')) {
    const aud = lean === 'female' ? 'Women' as const : 'Men' as const
    finalTitle = enforceHardAudience(finalTitle, aud)
    if (!new RegExp(`\\bfor ${aud}\\b`, 'i').test(finalTitle)) {
      finalTitle = capTitle75(`${finalTitle.replace(/\s+for\s+(?:men|women)(?:\s+and\s+(?:men|women))?\s*$/i, '')} for ${aud}`)
    }
  }
  // 3. FILL the 75-char budget.
  if (apparelProduct && finalTitle.length < 73) {
    const tailMatch = finalTitle.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
    let tail = tailMatch ? tailMatch[0] : ''
    let head = tail ? finalTitle.slice(0, finalTitle.length - tail.length) : finalTitle
    // Approach B: the audience suffix is an OPTIONAL, lowest-priority tail. Drop it only for a truly
    // INCLUSIVE audience ("for Men and Women" — always contains "and"), NEVER a single-gender tail
    // ("for Men"/"for Women"). A single-gender tail may be a seller hard-lean OR a keyword-derived
    // gendered audience (preferredAudience can be single-gender even when lean===null), so the `and`
    // test protects both — gating on `lean` alone would wrongly drop a keyword-derived "for Women".
    // If a higher-value candidate does not fit WITH the inclusive tail but WOULD fit without it, drop
    // the audience and take the keyphrase (PO directive: product-specific outranks "for Men and Women").
    const audienceDroppable = !!tail && lean !== 'female' && lean !== 'male' && /\band\b/i.test(tail)
    // Dedup set spans head AND the audience tail, gender-normalized — the tail's tokens were
    // previously invisible here, letting "Mens Tees" stack on top of "for Men" (B0DMXMH266).
    const headOwnToks = new Set(bulletTokens(head).map(fillNormTok))
    // Tokens contributed ONLY by the tail — must be released from the dedup set if the inclusive
    // tail is dropped mid-fill, or gendered keywords stay blocked on a genderless title (review).
    const tailOnlyToks = bulletTokens(tail).map(fillNormTok).filter((t) => !headOwnToks.has(t))
    const headToks = new Set([...headOwnToks, ...bulletTokens(tail).map(fillNormTok)])
    // A KEYWORD-DERIVED single-gender tail (lean=null but preferredAudience gendered) must gate
    // opposite-gender appends the same way a hard lean does (review: fragments fit where whole
    // phrases didn't, landing "Mens" on a "for Women" title). Single-gender tails are never
    // droppable (audienceDroppable requires "and"), so this cannot go stale.
    const tailGender = /\bfor\s+men\s*$/i.test(tail) ? 'men' : /\bfor\s+women\s*$/i.test(tail) ? 'women' : null
    // fixApostropheCase (PO 2026-08-09, §4): this is the caser that produced the PO's "Women'S
    // T-Shirts" — the pool phrase "women's t shirts" is fine; `\b\w` capitalised the possessive.
    const titleCaseKw = (s: string) => fixApostropheCase(s.replace(/\b\w/g, (c) => c.toUpperCase()))
    const FEM_T = /\bwom[ae]ns?\b|\bladies\b/i
    const MASC_T = /\bm[ae]ns?\b/i
    const canonPhrases: string[] = []
    const canonClean = (input.canonicalTitle ?? '').replace(/(\s+-\s+[A-Za-z][A-Za-z -]{1,24}){1,2}\s*$/, '')
    for (const seg of canonClean.split(/[,\-–—|]/)) {
      const segWords = seg.replace(/[^A-Za-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)
      for (let i = 0; i + 1 < segWords.length; i++) {
        const big = `${segWords[i]} ${segWords[i + 1]}`
        if (bulletTokens(big).length === 2) canonPhrases.push(big)
      }
    }
    for (const kw of [...candidates.map((c) => c.keyword), ...topUpgradeKws, ...canonPhrases]) {
      const toks = bulletTokens(kw).map(fillNormTok)
      // ALL-NOVEL rule (sim-caught 2026-07-02): a partially-covered phrase appended verbatim
      // re-prints its covered words ("Fishing Shirts For Men" onto a "for Men" tail). The
      // no-repeated-word rule outranks exact-phrase coverage; the second pass below still
      // harvests such a phrase's novel remainder.
      if (toks.length === 0 || toks.some((tt) => headToks.has(tt))) continue
      if (new Set(toks).size !== toks.length) continue // intra-phrase repeat would ship twice (review)
      if (BARE_GENDER_RE.test(kw.trim())) continue // a lone "Mens" is a fragment, not a keyphrase
      if (lean === 'female' && MASC_T.test(kw) && !FEM_T.test(kw)) continue
      if (lean === 'male' && FEM_T.test(kw) && !MASC_T.test(kw)) continue
      if (tailGender === 'women' && MASC_T.test(kw) && !FEM_T.test(kw)) continue
      if (tailGender === 'men' && FEM_T.test(kw) && !MASC_T.test(kw)) continue
      const safe = stripContradictedGarments(stripUngroundedMotifs(kw, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase(), motifTrust)
      if (safe !== kw) continue
      const next = `${head}, ${titleCaseKw(safe)}`
      if ((next + tail).length > 75) {
        // Fits only if we drop an OPTIONAL inclusive audience tail? Prefer the product-specific keyphrase.
        if (audienceDroppable && tail && next.length <= 75) {
          tail = ''
          for (const t of tailOnlyToks) headToks.delete(t) // release the dropped tail's tokens (review)
        } else continue
      }
      head = next
      for (const tt of toks) headToks.add(tt)
      if ((head + tail).length >= 73) break
    }
    // SECOND PASS (fill-starvation fix, B0DMXMH266): whole keyphrases rarely fit the last ~10-15
    // chars, stalling child titles at ~62/75. Retry each candidate as ONLY its novel significant
    // words (original order, every token new — so no stutter and no gender dup by construction);
    // bag-of-words indexing means the trimmed remainder still ranks. Same lean/motif rails.
    if ((head + tail).length < 73) {
      // PROVENANCE POOL (council Layer 1): every phrase a fragment is allowed to BE — the same
      // sources this loop already iterates, so the gate authorizes nothing new.
      const fragPool = buildFragPool([candidates.map((c) => c.keyword), topUpgradeKws, searchKeyphrases, canonPhrases])
      for (const kw of [...candidates.map((c) => c.keyword), ...topUpgradeKws, ...canonPhrases]) {
        if (lean === 'female' && MASC_T.test(kw) && !FEM_T.test(kw)) continue
        if (lean === 'male' && FEM_T.test(kw) && !MASC_T.test(kw)) continue
        const safe = stripContradictedGarments(stripUngroundedMotifs(kw, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase(), motifTrust)
        if (safe !== kw) continue
        // Contiguous novel run only (review): a fragment must be a verbatim sub-phrase — no
        // recombining distant words into new claims, no bare attribute modifiers, no cross-gender
        // words over a single-gender tail.
        let novel = contiguousNovelRun(kw, headToks, (w) => {
          if (FRAG_ATTR_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''))) return true
          if (tailGender === 'women' && MASC_T.test(w) && !FEM_T.test(w)) return true
          if (tailGender === 'men' && FEM_T.test(w) && !MASC_T.test(w)) return true
          if (lean === 'female' && MASC_T.test(w) && !FEM_T.test(w)) return true
          if (lean === 'male' && FEM_T.test(w) && !MASC_T.test(w)) return true
          return false
        })
        // Progressive end-trim (sim-caught): with only ~7-10 chars left, the full novel fragment
        // rarely fits — drop trailing words until it does (never below one non-junk word).
        while (novel.length > 0) {
          const frag = novel.join(' ')
          if (isAllJunk(frag)) break
          if (novel.every((w) => BARE_GENDER_RE.test(w) || bulletTokens(w).length === 0)) break // ", Mens" is not content
          // PROVENANCE GATE (council Layer 1): a fragment ships only if it IS a pooled phrase —
          // "Too Many" (headless remainder of "too many books") dies here; a narrower trim that
          // is itself a real pooled phrase may still pass on the next iteration.
          if (!fragPool.has(fragPoolKey(frag))) {
            novel = novel.slice(0, -1)
            while (novel.length && bulletTokens(novel[novel.length - 1]).length === 0) novel.pop()
            continue
          }
          const next = `${head}, ${titleCaseKw(frag)}`
          if ((next + tail).length <= 75) {
            head = next
            for (const tt of bulletTokens(frag).map(fillNormTok)) headToks.add(tt)
            break
          }
          novel = novel.slice(0, -1)
          while (novel.length && bulletTokens(novel[novel.length - 1]).length === 0) novel.pop()
        }
        if ((head + tail).length >= 73) break
      }
    }
    finalTitle = `${head}${tail}`
  }
  // 4. Blank-brand single-occurrence backstop.
  if (apparelProduct && attributePinFinal && finalTitle) {
    const re = new RegExp(`\\b${attributePinFinal.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    let seen = 0
    finalTitle = finalTitle
      .replace(re, (m) => (++seen === 1 ? m : ''))
      .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[\s,]+$/g, '').trim()
  }
  // 5. Brand-at-FRONT backstop.
  if (apparelProduct && brandName && finalTitle) {
    const brandRe = new RegExp(`\\b${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const m = finalTitle.match(brandRe)
    if (m && m.index !== undefined && m.index > 0) {
      const without = (finalTitle.slice(0, m.index) + finalTitle.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim()
      finalTitle = capTitle75(`${m[0]} ${without}`)
    }
  }
  // 6. Design-name backstop.
  if (apparelProduct && designName && designName.split(/\s+/).length >= 3 && finalTitle && !new RegExp(`\\b${designName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(finalTitle)) {
    const brandMatch = brandName ? finalTitle.match(new RegExp(`^\\s*${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i')) : null
    const head = brandMatch ? brandMatch[0].trim() : ''
    const tailMatch = finalTitle.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
    const tail = tailMatch ? tailMatch[0] : ''
    const rest = finalTitle.slice(head.length).slice(0, finalTitle.length - head.length - tail.length).trim()
    finalTitle = capTitle75(`${head} ${designName}, ${rest}${tail}`.replace(/,\s*,/g, ',').replace(/\s+,/g, ','))
  }
  // 6a-dedup. EXACT-WORD DE-DUP of the fill TAIL (2026-07-15, PO on B0H7L6KNNX: "no repeating words").
  //     The council pads the budget by repeating a design word after the product type ("…Champions
  //     T-Shirt Football Champions Tee") — that reaches 73 chars, so the novel harvest below (fires
  //     under 70) never ran and nothing removed the repeat. Amazon indexes each word once, so a 2nd
  //     EXACT occurrence adds nothing and reads as stuffing. De-dup ONLY the tail after the FIRST
  //     product-type token — the brand+design+type prefix is the protected money phrase — keeping a
  //     different word for the same concept (Tshirt vs Tee). Shortening here lets the harvest re-fill
  //     the freed budget with NOVEL keywords (Football, Graphic, Fan).
  if (apparelProduct) {
    const pt = finalTitle.match(/\b(?:t-?\s?shirts?|tshirts?|tees?|hoodies?|sweat\s?shirts?|tanks?|tops?)\b/i)
    if (pt && typeof pt.index === 'number') {
      const cut = pt.index + pt[0].length
      const prefix = finalTitle.slice(0, cut)
      // SAME per-word key on both sides (2026-07-15 fix): the prior version built `seen` by splitting on
      // punctuation ("T-Shirt" → "t","shirt") while the filter keyed on alnum-strip ("Tshirt" → "tshirt"),
      // so appended garment variants slipped through; and it skipped numbers, so a repeated year ("2026")
      // slipped through. Key every word the same way and count numbers.
      const dkey = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '')
      const seen = new Set(prefix.split(/\s+/).map(dkey).filter(Boolean))
      const tail = finalTitle.slice(cut).split(/\s+/).filter((w) => {
        const key = dkey(w)
        if (!key || key.length <= 2 || MINOR_WORDS.has(key)) return true   // keep punctuation / tiny / stopwords
        if (seen.has(key)) return false                                    // exact repeat (incl. a year) → drop
        seen.add(key); return true
      }).join(' ')
      finalTitle = `${prefix} ${tail}`.replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim()
    }
  }
  // 6b. NOVEL KEYWORD HARVEST (2026-07-06 niche fill; REDESIGNED 2026-07-15 per PO on B0H7L6KNNX:
  //     "more keywords, no repeating words"). For an EVENT/theme design every pooled PHRASE reuses the
  //     design tokens (spain/soccer/cup), so step 3's all-novel pass + the provenance second-pass leave
  //     the title short. The prior fill packed it by ECHOING those words (a 2x-repeat pass shipped
  //     "Spain Soccer Cup" twice — the PO rejected it). Instead, append the top NOVEL individual keyword
  //     TOKENS from the candidate pool: each a real pooled token (provenance), content-bearing (not a
  //     stopword / junk / attribute / gender / bare-number fragment), NOT already in the title, and NEVER
  //     repeated. Yields "…Champions T-Shirt, Football Champs Graphic" instead of repeating design words.
  if (apparelProduct && finalTitle.length < 70) {
    const tailMatch = finalTitle.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
    const tail = tailMatch ? tailMatch[0] : ''
    let head = tail ? finalTitle.slice(0, finalTitle.length - tail.length) : finalTitle
    const have = new Set(bulletTokens(head).map(fillNormTok))
    const FEM_H = /\bwom[ae]ns?\b|\bladies\b/i, MASC_H = /\bm[ae]ns?\b/i
    let firstAdd = true
    for (const kw of [...(input.nicheSeeds ?? []), ...candidates.map((c) => c.keyword), ...topUpgradeKws]) {
      if ((head + tail).length >= 73) break
      if (lean === 'female' && MASC_H.test(kw) && !FEM_H.test(kw)) continue     // respect the audience lean
      if (lean === 'male' && FEM_H.test(kw) && !MASC_H.test(kw)) continue
      if (findTrademarkPhrases(kw).length > 0) continue                          // never harvest a trademark token
      for (const w of kw.split(/\s+/)) {
        if ((head + tail).length >= 73) break
        const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '')
        if (clean.length < 3 || /^\d+$/.test(clean)) continue                    // skip tiny words + bare numbers
        const norm = fillNormTok(w)
        if (have.has(norm)) continue                                            // already in the title → no repeat
        if (JUNK_WORDS.has(clean) || MINOR_WORDS.has(clean) || FRAG_ATTR_WORDS.has(clean)) continue
        if (BARE_GENDER_RE.test(w)) continue
        const capped = clean.charAt(0).toUpperCase() + clean.slice(1)
        const next = `${head}${firstAdd ? ',' : ''} ${capped}`
        if ((next + tail).length > 75) continue
        head = next; have.add(norm); firstAdd = false
      }
    }
    finalTitle = `${head}${tail}`
  }
  // 7. Brand-dedup + adjacent-stutter cleanup (PR #272) — final pass. Guard 5 only fixes a brand
  //    missing from the front; this removes a SECOND mid-title brand and collapses repeated words.
  finalTitle = dedupeBrandAndStutter(finalTitle, brandName)
  return { title: finalTitle, problems: titleProblems, retried }
}

// Multi-design parent (variation hub) niche-aware title. Children carry distinct designs that
// SHARE A NICHE (B0F6QZ34B1's 3 fishing designs; or hiking/camping families). The parent is the
// hub shoppers see in search results BEFORE picking a design — it must capture the NICHE and
// product type WITHOUT naming any specific design. Reuses the existing runTitleCouncil (3
// persona proposers → adversary critique → judge synthesis) with a parent-scoped brief; the
// council infers the niche from the design names + top upgrade keywords. Single LLM call —
// Karpathy simplicity: no separate niche-extractor stage. Post-guards: capTitle75 + brand-front
// + blank-brand dedup. NO per-design backstop (no single design name to anchor) — but a POSITIVE
// FAMILY-NICHE anchor (`familyNiche`, e.g. "funny fishing shirt") IS seated when the council drops
// the shared niche; it is a niche NOUN derived from the family design_name_override, never a design
// name. `designNames` stays the EXCLUSION arg (design names banned from the hub title).
/**
 * SHARED 70-75 HUMANIZER (title path-parity, 2026-07-18) — the fix for the recurring "short/generic
 * title" regression. Until now the ENFORCED 70-75 LLM extension lived ONLY inside buildNicheParentTitle
 * (the MULTI-design producer); single-design titles ship runTitleAgent's output, which had no humanizer,
 * so a thin-pool listing landed short + generic (B0FKJW57H7 = 61 chars). This is the ONE post-processor
 * BOTH producers call, so 70-75 enforcement is identical on every path (INVARIANT 1, fba-generation-
 * invariants). Extends a short apparel title via up to 2 LLM calls, each seeded with the caller's OWN
 * brief (system+user) + the pool phrases the title does not yet carry; post-processes each candidate with
 * the caller's cleanup (scrub→cap→dedup) then Title-Cases; adopts a candidate ONLY when it is LONGER,
 * trademark-free, and still brand-first. Fail-open: any error / empty response keeps the current best.
 */
async function humanizeTitleTo75(
  openai: OpenAI,
  title: string,
  opts: {
    baseSystem: string
    baseUser: string
    pool: string[]
    brandName: string
    postProcess: (raw: string) => string
    onProgress?: (m: string) => void
    trigger?: number
    /** Per-run collector for TITLE_V4 diffs. The humanizer pads BEFORE the ship door, so the door's
     *  own diff cannot see it — measuring only the door reports a falsely reassuring zero. */
    v4Sink?: Record<string, unknown>[]
    label?: string
    /** TITLE_COUNCIL_V3.1a Fix D: RAW audience lean. When passed, the V2 adopt gate scores current-vs-retry
     *  with the lean-aware dock so a humanizer rewrite that DROPS a lean-appropriate tail cannot silently
     *  replace a good one at the same score. Undefined = pre-Fix-D scoring (backward-compatible). */
    lean?: AudienceLean
    /** Seller's measured left-segment ceiling — the humanizer's adopt gate uses the SAME judge as the
     *  council, so without this a rewrite that bloats the left segment scores identically to one that
     *  respects it (INVARIANT-1 parity: both producer-side actors read one arbiter). */
    maxLeftWords?: number | null
    shape?: GoldShape | null
    apparel?: boolean
  },
): Promise<string> {
  const { baseSystem, baseUser, pool, brandName, postProcess, onProgress, trigger = 68, label = 'Title', lean, maxLeftWords, shape = null, apparel = false, v4Sink } = opts
  // RETRY-CASING NORMALIZER: the LLM ships raw casing (live: "THE CEO fishing humor funny t-shirt…" —
  // correct content, lowercase niche). Title-Case only FULLY-LOWERCASE words; any word already carrying
  // an uppercase letter is preserved verbatim ("THE CEO", "T-shirt"); minor connectors stay lowercase
  // unless they open the title.
  const RETRY_MINOR_WORDS = new Set(['for', 'and', 'the', 'a', 'an', 'of', 'with', 'to'])
  const titleCaseRetry = (t: string): string => t.split(/\s+/).map((w, i) =>
    /[A-Z]/.test(w) ? w
      : (i > 0 && RETRY_MINOR_WORDS.has(w)) ? w
      : w.charAt(0).toUpperCase() + w.slice(1),
  ).join(' ')
  /* THE LENGTH-EXTENSION RETRY — deleted at TITLE_V4=on (2026-08-12).
   *
   * THIS IS THE MEASURED AUTHOR OF THE LIVE DEFECT. On B0GVV3XL4T the council wrote 56 characters,
   * this loop stretched it to 71 by inventing "Fan Tournament", and the deterministic judge rewarded
   * the padding 70 -> 100 purely for the extra length. The ship door then changed nothing
   * ([TITLE_DOOR_TRACE] stages: []), so every byte of that defect was authored here.
   *
   * The code's own comment already called it "a shape-blind length maximizer sitting AFTER the
   * council". It exists only to reach a floor the seller has now abolished: "the floor refuses, it
   * never pads". A title that lands short is a signal that keyword research is thin — the ship gate
   * surfaces it; nothing fills it. */
  const v4PreRetry = title
  if (title && title.length < trigger && !v4Applies()) {
    for (let attempt = 1; attempt <= 2 && title.length < trigger; attempt++) {
      try {
        // UNUSED-KEYWORD FEED (recomputed each pass against the current title): pool phrases that still
        // carry at least one novel token, garment-folded so "Tee" doesn't mask "T-Shirt".
        const titleToks = new Set(bulletTokens(title).map(fillNormTok))
        const unused = pool.filter((k) => {
          const toks = bulletTokens(k).map(fillNormTok)
          return toks.length > 0 && toks.some((t) => !titleToks.has(t))
        }).slice(0, 8)
        onProgress?.(`${label} ${title.length}/75 — humanizer retry ${attempt} toward 70-75...`)
        const model = process.env.TITLE_COUNCIL_MODEL || 'gpt-5'
        const isGpt5 = /^(gpt-5|o\d)/.test(model)
        const messages = [
          { role: 'system' as const, content: baseSystem },
          { role: 'user' as const, content: `${baseUser}

Current title (${title.length} chars — too short):
${title}

Critique: Extend to 70-75 characters with natural niche phrasing a real shopper types — occasion, recipient, design subject. Keep every existing word's meaning; do NOT repeat any significant word; no generic category filler.${unused.length ? `
Extend the title to 70-75 characters by weaving in phrases from this list (verbatim or naturally inflected, most valuable first): ${unused.join(' | ')}. Never repeat a word already in the title.` : ''}

Return ONLY the extended title string.` },
        ]
        const r = await openai.chat.completions.create(
          isGpt5
            ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' }
            : { model, messages, temperature: 0.3, max_tokens: 120 },
          { timeout: 60_000, maxRetries: 0 },
        )
        const raw = (r.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
        if (!raw) {
          onProgress?.(`${label} retry ${attempt}: len ${title.length}→${title.length} (empty response, kept best)`)
          continue
        }
        const retryTitle = titleCaseRetry(postProcess(raw))
        const safetyOk = findTrademarkPhrases(retryTitle).length === 0
          && (!brandName || retryTitle.toLowerCase().startsWith(brandName.trim().toLowerCase()))
        // Adopt gate (2026-07-22; TITLE_QUALITY_V2 flag retired 2026-08-03, judge unconditional):
        // the historical gate rejected a same-length rewrite (strict `length >`), silently
        // discarding a FORMAT win when the LLM landed a better-structured title at the same char
        // count. Adopt a longer rewrite, OR a same-length/shorter one that scores strictly higher
        // on the deterministic titleQualityJudge — safety gates (trademark + brand-front) always
        // enforced.
        const currentScore = titleQualityJudge(title, { brandName, lean, maxLeftWords, shape, apparel }).score
        const retryScore = titleQualityJudge(retryTitle, { brandName, lean, maxLeftWords, shape, apparel }).score
        // SHAPE-AWARE ADOPT (TITLE_SHAPE_JUDGE=on). Extending toward the band is this function's whole
        // job, so a LONGER rewrite is still progress — but "longer" must not buy a title that scores
        // WORSE. The historical gate adopted ANY longer retry unconditionally, which made this a
        // shape-blind length maximizer sitting AFTER the council: a retry that added a banned word or
        // bloated the left segment displaced a better title purely for being longer, and nothing
        // downstream re-consulted the score. Without this, the shape terms added to the judge would be
        // inert on the exact path that produced the 61-char single-segment title the seller rejected.
        // At 'off' the expression is byte-identical to the pre-2026-08-10 gate.
        const longerIsProgress = titleShapeJudgeMode() === 'on'
          ? (retryTitle.length > title.length && retryScore >= currentScore)
          : retryTitle.length > title.length
        const clean = safetyOk && (longerIsProgress || retryScore > currentScore)
        // Both branches go to console as well as onProgress: onProgress is SSE-only, so until now
        // NEITHER the adopt nor the reject decision reached server logs — and at TITLE_SHAPE_JUDGE=on
        // a longer-but-rejected retry has a genuinely new cause (score veto) that the old reject
        // string could not distinguish from a trademark/brand-front veto.
        console.log('[TITLE_GOLD]', JSON.stringify({
          tag: 'HUMANIZER_ADOPT', label, attempt, adopted: clean,
          cause: clean ? 'adopted' : (!safetyOk ? 'safety' : 'score'),
          mode: titleShapeJudgeMode(), lenFrom: title.length, lenTo: retryTitle.length,
          scoreFrom: currentScore, scoreTo: retryScore,
        }))
        if (clean) {
          onProgress?.(`${label} retry ${attempt}: len ${title.length}→${retryTitle.length} score ${currentScore}→${retryScore}`)
          title = retryTitle
        } else {
          onProgress?.(`${label} retry ${attempt}: len ${title.length}→${title.length} (kept best; retry was ${retryTitle.length} chars${retryTitle.length > title.length ? ', unclean' : ''})`)
        }
      } catch (e) {
        console.warn(`[${label}] humanizer retry failed (kept current best):`, e instanceof Error ? e.message : e)
        break
      }
    }
  }
  /* THE HUMANIZER'S OWN TITLE_V4 DIFF — recorded even when the loop did not run.
   *
   * MEASURED 2026-08-13, and it is why this exists: a live shadow regen reported
   * `padManufactured: false, wouldRefuse: false` while the stream simultaneously showed
   * "Title retry 1: len 48->73". Both were true — the DOOR padded nothing because the HUMANIZER had
   * already padded, one stage earlier, and the door's diff cannot see behind itself. An instrument
   * that measures the wrong stage does not report "unknown", it reports a confident zero.
   *
   * `wouldRefuse` here is the real question the seller asked: with the padding gone, does the
   * council's own draft clear their corpus floor, or does the listing get held back? */
  if (v4Sink && titleV4Mode() !== 'off') {
    const CORPUS_FLOOR = 68
    v4Sink.push({
      stage: 'humanizer', label,
      shipped: title, shippedLen: title.length,
      withoutPad: v4PreRetry, withoutPadLen: v4PreRetry.length,
      padManufactured: title !== v4PreRetry,
      wouldRefuse: v4PreRetry.length < CORPUS_FLOOR,
      floor: CORPUS_FLOOR,
    })
  }
  return title
}

async function buildNicheParentTitle(
  openai: OpenAI,
  brandName: string,
  designNames: string[],
  familyNiche: string,
  blankBrand: string | undefined,
  preferredAudience: string,
  productType: string | null,
  topUpgradeKws: string[],
  compatibilityBrands: string[],
  onProgress: ((m: string) => void) | undefined,
  // Title-council fallback chain Part 1: the seller-named competitor's live SEO snapshot (+brand
  // for the deterministic leak net). Null/absent → the brief and the net both no-op (fail-open).
  competitorSeo?: (CompetitorSeoSnapshot & { brand: string }) | null,
  // TITLE_COUNCIL_V3.1a: parent-lean derived by caller via UNANIMITY predicate — REQUIRED only when every
  // live child shares the same non-unisex lean; any mismatch OR any unisex/null child forces the parent
  // to 'unisex' so the broadcast title never mis-genders a mixed-lean family (Q4 answer: UNANIMITY).
  parentLean: AudienceLean = null,
  // The seller's own gold corpus. Passed EXPLICITLY because this is the multi-design title
  // producer — a separate branch from runTitleAgent, and the branch that historically missed
  // fixes applied only to its twin (PR #401). Both now read the same corpus.
  poGolds?: { titles: string[]; shape: GoldShape } | null,
  // TITLE_V4 diagnostics sink. Passed EXPLICITLY for the same reason poGolds is: this is the
  // multi-design producer, a separate branch from runTitleAgent, and the branch that historically
  // missed fixes applied only to its twin (PR #401). An instrument wired to one producer reports
  // confidently about the other while measuring nothing.
  v4Sink?: Record<string, unknown>[],
): Promise<string> {
  const audienceMode = deriveAudienceMode(parentLean)
  const designNameList = designNames.filter(Boolean).slice(0, 6).join(', ') || '(unnamed)'
  // Flag ON → title-aware family display; OFF → exact legacy ('T-Shirt' for shirt else Titlecase(pt)).
  const ptWord = GARMENT_NOUN_ON
    ? garmentNounFor(productType, designNameList).display
    : (/T_SHIRT|SHIRT|TEE/i.test(productType ?? '') ? 'T-Shirt' : (productType ? productType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Shirt'))
  const aud = preferredAudience || 'Men and Women'
  const upgradeList = topUpgradeKws.slice(0, 8).join(', ') || '(none)'
  const compatList = compatibilityBrands.length > 0 ? compatibilityBrands.slice(0, 3).join(', ') : ''
  // FAMILY-NICHE ANCHOR (H "Seam 2"). familyNiche is the POSITIVE niche the whole family shares
  // ("funny fishing shirt"), derived at the call site from the scalar family design_name_override via
  // expandDesignNiche (a niche PHRASE, never a design name / slogan) and already off-niche-gated there.
  // Re-scrub trademarks here — belt-and-suspenders so a value like "Bluey Fishing" can never inject a
  // mark. Empty ('') when the family has no override / the expansion failed → every use below no-ops,
  // so this is a pure enhancement with zero regression on families that lack a niche anchor.
  const familyNicheClean = (() => {
    const s = scrubTrademarks((familyNiche || '').trim())
    return s && findTrademarkPhrases(s).length === 0 ? s : ''
  })()
  // V2 gold-pattern parent brief (2026-07-22; TITLE_QUALITY_V2 flag retired 2026-08-03 — live env
  // was 'on', unconditional fold is byte-identical): the multi-design branch uses the same PO gold
  // pattern as single-design (INVARIANT 1: fix on BOTH producers so no branch ships a stale
  // format). The family niche anchor still leads; the PO golds show BOTH single- and multi-design
  // examples so the model sees the shape both ways.
  const baseSystem = buildApparelTitleBrief({
    brandName,
    roleLine: `You write Amazon apparel titles for ${brandName}. This one is the BROADCAST PARENT TITLE for a variation family: it carries the FAMILY NICHE, never a specific child design.`,
    inputBlock: '(see user message)',
    poGolds,
    // PATH PARITY (PR #401): the parent producer is a separate branch and must receive the anchor
    // too. Its "design" is the FAMILY NICHE — the parent title never carries a child design name.
    designPhrase: familyNiche || null,
    garmentNoun: productType || null,
    lean: parentLean,
  }).system
  // COMPETITOR SEO SNAPSHOT (fallback chain Part 1) — CONSTRAINTS-NOT-EXEMPLARS (prompt-leak
  // history #365/#367: instruction text the model can echo becomes product copy). The snapshot is
  // framed as a strategy REFERENCE with explicit prohibitions; every field is trademark-scrubbed
  // before it enters the brief, and the deterministic brand-leak net below backstops the "never
  // their brand" rule on both generation passes.
  const compSnapshotBlock = (() => {
    if (!competitorSeo || (!competitorSeo.title && competitorSeo.bullets.length === 0)) return ''
    const compTitle = scrubTrademarks(competitorSeo.title).trim()
    const compBullets = competitorSeo.bullets.slice(0, 3).map((b) => scrubTrademarks(b).trim().slice(0, 140)).filter(Boolean)
    if (!compTitle && compBullets.length === 0) return ''
    return `

TOP-RANKING COMPETITOR SNAPSHOT (study HOW they rank — use their KEYWORD STRATEGY and STRUCTURE as reference; write ORIGINAL sentences; NEVER use their brand name${competitorSeo.brand.trim() ? ` '${competitorSeo.brand.trim()}'` : ''}):
Their title: ${compTitle || '(none)'}
Their bullets: ${compBullets.length ? compBullets.join(' | ') : '(none)'}`
  })()
  const baseUser = (() => {
    const audBlock = aud
      ? `AUDIENCE MODE: ${audienceMode}\nAudience: ${aud}\n// REQUIRED = every live child shares this lean (UNANIMITY). KEEP the "for ${aud}" tail on the broadcast title; trim a lower-value candidate rather than pad. NEVER "for Men and Women".\n`
      : `AUDIENCE MODE: ${audienceMode}\n// Children disagree or at least one is unisex → the parent is universal. No audience tail. NEVER "for Men and Women".\n`
    const inputBlock = `Brand: ${brandName}
${blankBrand ? `Garment brand (a selling point — the seller's tails carry it): ${blankBrand}\n` : ''}Product type: ${ptWord}
${audBlock}Family niche anchor (LEAD with THIS niche phrase; broadcasts to EVERY design; NEVER a specific design name): ${familyNicheClean || '(infer the shared niche from the design names + keywords below)'}
Child design names (DO NOT name any specifically — they belong to individual children): ${designNameList}
High-value niche keywords (niche-wide only, skip design-specific motifs): ${upgradeList}${compatList ? `
Compatibility (for-Brand framing if relevant): ${compatList}` : ''}${compSnapshotBlock}`
    const b = buildApparelTitleBrief({
      brandName,
      roleLine: `You write Amazon apparel titles for ${brandName}. This one is the BROADCAST PARENT TITLE for a variation family: it carries the FAMILY NICHE, never a specific child design.`,
      inputBlock,
      poGolds,
      extraRules: ['NO design names in the parent title — only the shared niche.'],
      designPhrase: familyNiche || null,
      garmentNoun: productType || null,
      lean: parentLean,
    })
    return b.user
  })()
  const judged = await runTitleCouncil(openai, baseSystem, baseUser, onProgress, { brandName, lean: parentLean, maxLeftWords: poGolds?.shape.maxLeftWords ?? null, shape: poGolds?.shape ?? null, apparel: /shirt|tee|hoodie|sweatshirt|tank|apparel/i.test(ptWord || '') })
  let title = (judged || '').trim()
  // FAMILY-NICHE ANCHOR — reverses the historical "NO design-name backstop" stance for MULTI-DESIGN
  // ONLY. When the council's title does not already carry the family-niche tokens, seat the niche noun
  // right after the brand, BEFORE capTitle75 + every dedup/cap guard below, so they all run on it.
  // Token-subset presence check (fillNormTok — garment-folded) so a plural "T-Shirts" already counts
  // the "shirt" token and the anchor is never double-seated. Trademark-clean by construction
  // (familyNicheClean scrubbed above); off-niche-gated at derivation. effectiveDesignName='' (bullet
  // cohesion) is untouched — this is a SEPARATE niche channel for the TITLE only.
  if (familyNicheClean && title) {
    const anchorToks = new Set(bulletTokens(familyNicheClean).map(fillNormTok))
    const titleToks = new Set(bulletTokens(title).map(fillNormTok))
    const present = anchorToks.size > 0 && [...anchorToks].every((t) => titleToks.has(t))
    if (!present) {
      const brandMatch = brandName ? title.match(new RegExp(`^\\s*${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i')) : null
      const head = brandMatch ? brandMatch[0].trim() : ''
      const rest = title.slice(head.length).replace(/^[\s,]+/, '').trim()
      // fixApostropheCase (PO 2026-08-09, §4) — see the note on titleCaseKw.
      const anchorTC = fixApostropheCase(familyNicheClean.replace(/\b\w/g, (c) => c.toUpperCase()))
      title = `${head ? `${head} ` : ''}${anchorTC}${rest ? `, ${rest}` : ''}`.replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim()
    }
  }
  // Post-guards: capTitle75 + blank-brand dedup + brand-dedup + brand-front. The only positive niche
  // insertion is the FAMILY-NICHE ANCHOR above (a niche noun, never a design name); no per-design backstop.
  title = capTitle75(title)
  if (blankBrand && title) {
    const re = new RegExp(`\\b${blankBrand.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    let seen = 0
    title = title.replace(re, (m) => (++seen === 1 ? m : '')).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[\s,]+$/g, '').trim()
  }
  // BRAND-DEDUP (Commit 2 hot-fix): the council judge can emit the brand TWICE — live regression
  // 2026-06-17 on B0F6QZ34B1 produced "THE CEO the ceo fishing Funny Fishing T-Shirt for Men and
  // Women" because the brief tells the judge "Brand FIRST" and the judge wrote the brand at the
  // top AND echoed it lowercase mid-title. The brand-FRONT backstop below only fires when the
  // brand is missing from position 0 — a lowercase mid-title doesn't qualify, so the dup survived.
  // Strip later occurrences (case-insensitive), normalize the first to brandName's canonical form.
  if (brandName && title) {
    const re = new RegExp(`\\b${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    let seen = 0
    title = title.replace(re, () => (++seen === 1 ? brandName.trim() : '')).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[\s,]+$/g, '').trim()
  }
  if (brandName && title) {
    const brandRe = new RegExp(`\\b${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const m = title.match(brandRe)
    if (m && m.index !== undefined && m.index > 0) {
      const without = (title.slice(0, m.index) + title.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim()
      title = capTitle75(`${m[0]} ${without}`)
    }
  }
  // TITLE-CASE (polish 2026-06-17): the council judge sometimes emits a lowercase niche word —
  // live regression on B0F6QZ34B1 was "THE CEO fishing Funny Fishing T-Shirt for Men and Women"
  // (lowercase "fishing"). Capitalize every major word; keep MINOR_WORDS lowercase (except the
  // first word); leave the brand prefix verbatim (it may be intentionally all-caps, e.g. "THE CEO").
  if (title) {
    const brandLen = brandName && title.toLowerCase().startsWith(brandName.trim().toLowerCase()) ? brandName.trim().length : 0
    const head = title.slice(0, brandLen)
    const restIn = title.slice(brandLen)
    const rest = restIn.replace(/[A-Za-z][A-Za-z'’-]*/g, (w, off: number) => {
      const lw = w.toLowerCase()
      // CLAUSE-INITIAL EXEMPTION (live B0GVVY5TS9, 2026-08-09). English title case lowercases a minor
      // word MID-clause only. This caser tested position with `off > 0` alone, so a minor word that
      // OPENS the pipe-right clause got lowercased too, and the family parent shipped
      //   "THE CEO … Soccer Tee Shirt | the Black Short Sleeve"
      // — a stray lowercase "the" mid-title. A `|`/`,`/`;`/`:` immediately before the word means it
      // starts a new clause, so it keeps its capital. Length-neutral and PO-gold-safe: gold #1's
      // "… Him in Every Season Tee | Christian Shirts for Women" has no minor word at a clause
      // opening, so every gold is byte-identical under this rule.
      if (off > 0 && MINOR_WORDS.has(lw) && !/[|,;:]\s*$/.test(restIn.slice(0, off))) return lw
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    title = head + rest
  }
  // AUDIENCE DE-DUP (B0DMXMH266 fix): the council emitted "Mens Tees for Men" — a possessive
  // gender word stacked on the same-gender tail, and this path bypassed the child pipeline's
  // dedupeAudiencePhrases entirely. Inclusive tails reuse that helper; a single-gender tail strips
  // possessive/standalone repeats of the SAME gender from the head (bag-of-words: no rank loss).
  if (title) {
    // Brand-prefix exemption (sim-caught): a brand like "Mens Club Co" must never lose its gender
    // word to the audience strips — every dedup below runs on the post-brand remainder only.
    const bLen = brandName && title.toLowerCase().startsWith(brandName.trim().toLowerCase()) ? brandName.trim().length : 0
    const brandPre = title.slice(0, bLen)
    const restIn = title.slice(bLen).trim()
    const sgAud = /^men$/i.test(aud.trim()) ? 'Men' : /^women$/i.test(aud.trim()) ? 'Women' : null
    let deduped: string
    if (sgAud) {
      // HARD single-gender audience (review-caught MAJOR): dedupeAudiencePhrases PROTECTS an
      // inclusive phrase — but on a single-gender family an inclusive phrase is a council
      // hallucination, and the helper would strip the mandated tail instead. Strip every audience
      // mention ("for X" as a UNIT first, so no dangling "for"), then guarantee the one trailing
      // "for {aud}" — mirroring buildTitleFor's hard-audience guard, which the parent path lacked.
      const g = sgAud.toLowerCase()
      deduped = restIn
        .replace(/\bfor (?:men and women|women and men)\b/gi, ' ')
        .replace(new RegExp(`\\bfor\\s+${g}['’]?s?\\b`, 'gi'), ' ')
        .replace(new RegExp(`\\b${g}['’]?s?\\b`, 'gi'), ' ')
        .replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim()
      // The tail must survive the 75 cap — trim the head at a word boundary, never the tail.
      const tailStr = ` for ${sgAud}`
      const headRoom = 75 - brandPre.length - (brandPre ? 1 : 0) - tailStr.length
      if (deduped.length > headRoom) deduped = deduped.slice(0, headRoom).replace(/[\s,]+\S*$/, '').replace(/[,\s]+$/, '')
      deduped = `${deduped}${tailStr}`
    } else {
      deduped = dedupeAudiencePhrases(restIn)
    }
    // Explicit-space rejoin (sim-caught): dedupeAudiencePhrases trims its result, which swallowed
    // the brand/remainder boundary space ("THE CEOFishing Tees").
    title = `${brandPre} ${deduped}`.replace(/\s{2,}/g, ' ').trim()
    const rest = title.slice(brandPre.length)
    const sg = rest.match(/\bfor (men|women)\s*$/i)
    if (!sgAud && sg && !/\bfor (?:men and women|women and men)\s*$/i.test(rest)) {
      // Inclusive-audience family whose council chose a single-gender tail — keep the council's
      // tail, strip same-gender repeats from the head ("for X" as a unit FIRST: stripping only the
      // gender word orphans its "for" — review-caught).
      const g = sg[1].toLowerCase()
      const head = rest.slice(0, sg.index ?? rest.length)
        .replace(new RegExp(`\\bfor\\s+${g}['’]?s?\\b`, 'gi'), ' ')
        .replace(new RegExp(`\\b${g}['’]?s?\\b`, 'gi'), ' ')
        .replace(/\bfor\s*(?=,|$)/gi, ' ')
      title = `${brandPre}${head} ${sg[0].trim()}`.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').trim()
    }
  }
  // FILL the 75-char budget (polish 2026-06-17): the council often lands well under 75 (live:
  // 55/75), wasting niche-keyword real estate. Append niche-wide upgrade keyphrases (Title-Cased,
  // comma-joined) toward ~73 chars, preserving the trailing "for {audience}". Source is
  // topUpgradeKws ONLY (the same niche-wide pool the brief authorizes). Mirrors buildTitleFor's
  // fill step. Design-motif guard: skip any keyword that shares a ≥2-token overlap with a single
  // design name (blocks design phrases like "Fishing Rod"/"American Flag" while still allowing the
  // shared niche word "fishing" — which legitimately appears inside one design name).
  if (title.length < 73 && topUpgradeKws.length) {
    const tailMatch = title.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
    const tail = tailMatch ? tailMatch[0] : ''
    let fillHead = tail ? title.slice(0, title.length - tail.length) : title
    // Dedup set spans head AND the audience tail, gender-normalized (same B0DMXMH266 fix as the
    // child fill) — otherwise "Mens Tees" is appended on top of "for Men".
    const headToks = new Set([...bulletTokens(fillHead), ...bulletTokens(tail)].map(fillNormTok))
    // Design sets share the fill normalization (review-caught: raw "mens" in a design name dodged
    // the >=2-token overlap guard once the kw side was normalized).
    // NICHE-AWARE design-motif guard (H "Seam 2"): subtract the family-niche tokens ("funny"/"fishing")
    // from every per-design motif set. The niche is shared by ALL designs, so a niche keyphrase must NOT
    // be blocked as a "design-specific motif" — that block is exactly why the fishing pool never reached
    // this parent title. A truly design-specific motif ("american flag") keeps its tokens, stays blocked.
    const familyNicheToks = new Set(bulletTokens(familyNicheClean).map(fillNormTok))
    const designTokSets = designNames.filter(Boolean).map((d) => new Set([...bulletTokens(d)].map(fillNormTok).filter((t) => !familyNicheToks.has(t))))
    // fixApostropheCase (PO 2026-08-09, §4): this is the caser that produced the PO's "Women'S
    // T-Shirts" — the pool phrase "women's t shirts" is fine; `\b\w` capitalised the possessive.
    const titleCaseKw = (s: string) => fixApostropheCase(s.replace(/\b\w/g, (c) => c.toUpperCase()))
    // Garment-truthfulness rail (review-caught BLOCKER): the child fill vets keywords against the
    // seller's own text; the parent fill had NO rail, so a stray "hoodie" keyword in the family
    // pool would ship a product-identity misclaim. Parent trust = product type + design names.
    const parentHay = `${ptWord} ${productType ?? ''} ${designNames.join(' ')}`.toLowerCase()
    const tailGender = /\bfor\s+men\s*$/i.test(tail) ? 'men' : /\bfor\s+women\s*$/i.test(tail) ? 'women' : null
    const PAR_MASC = /\bm[ae]ns?\b/i
    const PAR_FEM = /\bwom[ae]ns?\b|\bladies\b/i
    for (const kw of topUpgradeKws) {
      const toks = bulletTokens(kw).map(fillNormTok)
      // ALL-NOVEL rule (sim-caught): a partially-covered phrase appended verbatim re-prints its
      // covered words — pass 2 harvests the novel remainder instead.
      if (toks.length === 0 || toks.some((tt) => headToks.has(tt))) continue
      if (new Set(toks).size !== toks.length) continue // intra-phrase repeat would ship twice (review)
      if (isAllJunk(kw)) continue
      if (BARE_GENDER_RE.test(kw.trim())) continue // a lone "Mens" is a fragment, not a keyphrase
      if (tailGender === 'women' && PAR_MASC.test(kw) && !PAR_FEM.test(kw)) continue
      if (tailGender === 'men' && PAR_FEM.test(kw) && !PAR_MASC.test(kw)) continue
      if (stripContradictedGarments(kw, parentHay, parentHay) !== kw) continue
      if (designTokSets.some((ds) => toks.filter((tt) => ds.has(tt)).length >= 2)) continue
      const next = `${fillHead}, ${titleCaseKw(kw)}`
      if ((next + tail).length > 75) continue
      fillHead = next
      for (const tt of toks) headToks.add(tt)
      if ((fillHead + tail).length >= 73) break
    }
    // SECOND PASS (fill-starvation fix, B0DMXMH266: parent stalled far under 75 because whole
    // keyphrases no longer fit and the design-motif guard blocks many niche phrases outright).
    // Retry each keyword as ONLY its novel significant words — every token new, so no stutter and
    // no gender dup by construction. Same design-motif + junk rails as the whole-phrase pass.
    if ((fillHead + tail).length < 73) {
      // PROVENANCE POOL (council Layer 1): topUpgradeKws is the parent's only authorized source.
      const fragPool = buildFragPool([topUpgradeKws])
      for (const kw of topUpgradeKws) {
        // Contiguous novel run only (review): verbatim sub-phrases, no bare attribute modifiers,
        // no ungrounded garment words, no cross-gender words over a single-gender tail.
        let novel = contiguousNovelRun(kw, headToks, (w) => {
          if (FRAG_ATTR_WORDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''))) return true
          if (tailGender === 'women' && PAR_MASC.test(w) && !PAR_FEM.test(w)) return true
          if (tailGender === 'men' && PAR_FEM.test(w) && !PAR_MASC.test(w)) return true
          return stripContradictedGarments(w, parentHay, parentHay) !== w
        })
        // Progressive end-trim (sim-caught): drop trailing words until the fragment fits the
        // remaining budget (never below one non-junk word). Same design-motif rail per width.
        while (novel.length > 0) {
          const frag = novel.join(' ')
          if (isAllJunk(frag)) break
          if (novel.every((w) => BARE_GENDER_RE.test(w) || bulletTokens(w).length === 0)) break // ", Mens" is not content
          const fragToks = bulletTokens(frag).map(fillNormTok)
          if (designTokSets.some((ds) => fragToks.filter((tt) => ds.has(tt)).length >= 2)) {
            novel = novel.slice(0, -1)
            while (novel.length && bulletTokens(novel[novel.length - 1]).length === 0) novel.pop() // review: an un-popped connector let ", Gifts For" reach the gate
            continue
          }
          // PROVENANCE GATE (council Layer 1): fragments must BE pooled phrases — no headless
          // remainders ("Too Many", ", Plus" — both live-caught).
          if (!fragPool.has(fragPoolKey(frag))) {
            novel = novel.slice(0, -1)
            while (novel.length && bulletTokens(novel[novel.length - 1]).length === 0) novel.pop()
            continue
          }
          const next = `${fillHead}, ${titleCaseKw(frag)}`
          if ((next + tail).length <= 75) {
            fillHead = next
            for (const tt of fragToks) headToks.add(tt)
            break
          }
          novel = novel.slice(0, -1)
          while (novel.length && bulletTokens(novel[novel.length - 1]).length === 0) novel.pop()
        }
        if ((fillHead + tail).length >= 73) break
      }
    }
    title = `${fillHead}${tail}`
  }
  // Final ADJACENT-stutter cleanup (review-tightened): brand-prefix exempt so a legitimately
  // doubled brand ("Mahi Mahi Co") survives, and stutter-collapse only — the parent already
  // deduped brand occurrences above, and dedupeBrandAndStutter's keep-first logic would KEEP a
  // mid-title duplicate once the leading brand is sliced off.
  // Extracted into a local function (fallback chain Part 2) so the humanizer retry below runs its
  // output through the IDENTICAL garment-collapse + token-dedup pass — shared logic, no drift.
  const collapseGarmentsAndDedup = (t0: string): string => {
    let t = t0
    const bLen = brandName && t.toLowerCase().startsWith(brandName.trim().toLowerCase()) ? brandName.trim().length : 0
    const pre = t.slice(0, bLen).trim()
    // GARMENT-REPETITION collapse + singularize (H "Seam 2" — extends the adjacent-stutter cleanup to
    // the exact "Funny Fishing T-Shirts, Graphic Shirts" case the plain stutter regex misses). Amazon
    // indexes the garment noun once, so a 2nd shirt-family word reads as stuffing. Keep the FIRST of
    // each garment family and drop later same-family repeats — shirt-family (t-shirt/tshirt/shirt) and
    // tee stay DISTINCT, so a legit "Shirt ... Tee" survives — then singularize the survivor
    // ("T-Shirts" → "T-Shirt") for a clean product title. Brand-prefix exempt.
    const garmentFamily = (w: string): 'shirt' | 'tee' | null => {
      const c = w.toLowerCase().replace(/[^a-z]/g, '')
      return /^t?shirts?$/.test(c) ? 'shirt' : /^tees?$/.test(c) ? 'tee' : null
    }
    const seenG = new Set<string>()
    const restStr = t.slice(bLen).trim().split(/\s+/)
      .filter((w) => {
        const fam = garmentFamily(w)
        if (!fam) return true
        if (seenG.has(fam)) return false
        seenG.add(fam); return true
      })
      .map((w) => (garmentFamily(w) ? w.replace(/s([^A-Za-z]*)$/i, '$1') : w))
      .join(' ')
      .replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1') // adjacent stutter ("Fishing Fishing" → "Fishing")
    t = `${pre}${pre && restStr ? ' ' : ''}${restStr}`
      .replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').replace(/[\s,]+$/g, '').trim()
    // NON-ADJACENT TOKEN dedup (live loop 2026-07-17): with a niche-rich pool the council emitted
    // "Funny Fishing T-shirt Funny Fish, ..." — duplicate significant tokens the ADJACENT stutter
    // regex can't see ("Funny ... Funny"; "Fish" ⊂ "Fishing"). In a title a repeated significant word
    // is always stuffing (Amazon indexes a token once) — keep the FIRST occurrence, drop later words
    // whose normalized token duplicates (or is a ≥4-char morphological prefix/extension of) an earlier
    // one. Brand prefix exempt; minor/short words ("for", "Men") only exact-dup. Then sweep segments
    // left with no significant token and tidy commas. Deterministic, drop-only.
    {
      const headStr = t.slice(0, bLen).trim()
      const seenToks = new Set<string>(bulletTokens(headStr).map(fillNormTok).filter(Boolean))
      const dup = (tok: string) => {
        if (!tok) return false
        if (seenToks.has(tok)) return true
        if (tok.length >= 4) for (const s of seenToks) if (s.length >= 4 && (s.startsWith(tok) || tok.startsWith(s))) return true
        return false
      }
      const words = t.slice(bLen).trim().split(/\s+/).filter((w) => {
        const toks = bulletTokens(w).map(fillNormTok).filter(Boolean)
        if (toks.length === 0) return true // pure connector/punct — kept; comma tidy below
        if (toks.every(dup)) return false
        for (const tok of toks) seenToks.add(tok)
        return true
      })
      let rest2 = words.join(' ')
        .replace(/\s+,/g, ',').replace(/,\s*,+/g, ',').replace(/^\s*,/, '').replace(/[\s,]+$/g, '').trim()
      // Sweep comma segments that lost every significant token (only connectors left).
      rest2 = rest2.split(',').map((s) => s.trim())
        .filter((s) => s && bulletTokens(s).map(fillNormTok).some(Boolean))
        .join(', ')
      t = `${headStr}${headStr && rest2 ? ' ' : ''}${rest2}`.replace(/\s{2,}/g, ' ').trim()
    }
    return t
  }
  // Deterministic COMPETITOR-BRAND leak net (fallback chain Part 1 — prompt-leak history #365/#367:
  // the snapshot brief can still tempt a pass into echoing the competitor's brand). Strip every
  // significant competitor-brand token (len>=3) from OUR title — never ship their brand. Tokens the
  // family legitimately owns (our brand / the niche anchor / the product word) are PROTECTED, so a
  // generic-word competitor name ("Fishing Tees Co") can never hollow out the title. Runs after BOTH
  // generation passes; drop-only + comma tidy, so it can never add or reorder content.
  const stripCompetitorBrand = (t: string): string => {
    const compBrand = (competitorSeo?.brand || '').trim()
    if (!compBrand || !t) return t
    const protectedToks = new Set(bulletTokens(`${brandName} ${familyNicheClean} ${ptWord}`).map(fillNormTok).filter(Boolean))
    let out = t
    for (const rawTok of compBrand.split(/\s+/)) {
      const w = rawTok.replace(/[^A-Za-z0-9'’-]/g, '')
      if (w.length < 3) continue
      const norm = bulletTokens(w).map(fillNormTok).filter(Boolean)
      if (norm.length === 0) continue                        // stopword — not a significant brand token
      if (norm.every((n) => protectedToks.has(n))) continue  // shared our-brand/niche/product token — keep
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
      out = out.replace(re, ' ')
    }
    if (out === t) return t
    out = out
      .replace(/\bfor\s*(?=,|$)/gi, ' ')                     // a stripped token can orphan its "for"
      .replace(/\s+,/g, ',').replace(/,\s*,+/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s{2,}/g, ' ').trim()
    // Sweep comma segments left with no significant token (same tidy as the token dedup above).
    return out.split(',').map((s) => s.trim())
      .filter((s) => s && bulletTokens(s).map(fillNormTok).some(Boolean))
      .join(', ')
  }
  title = stripCompetitorBrand(collapseGarmentsAndDedup(title))
  // ENFORCED 70-75 HUMANIZER RETRY (fallback chain Part 2): even with the fill + seed pools the
  // council can land short when the family's pool is thin — a short parent title wastes ranking
  // budget (brief: TARGET LENGTH 70-75). Up to TWO extension calls on the council's judge model,
  // each seeded with the full brief + the CURRENT title + the pool keywords the title does not yet
  // carry (live 58/75 failure: the old prompt gave the model no keywords to extend WITH), then the
  // SAME post-pipeline as pass 1 (scrub → cap → collapse/dedup → competitor-brand net).
  // KEEP-BEST-PROGRESS: adopt a retry when it is clean (trademark-free, brand still first) AND
  // LONGER than the current best — 68 stays the retry TRIGGER, never the adoption bar (the old
  // ≥68 bar discarded real progress and shipped the short pass-1 title). On ANY error the current
  // best ships unchanged (fail-open).
  // RETRY-CASING NORMALIZER: the adopted retry ships the LLM's raw casing (live: "THE CEO fishing
  // humor funny t-shirt Dad Gift..." — correct content, lowercase niche phrase). Title-Case only
  // FULLY-LOWERCASE words; any word already carrying an uppercase letter is preserved verbatim
  // ("THE CEO", "T-shirt"); minor connector words stay lowercase unless they open the title.
  // Pass-1 council titles are already cased — this applies to the retry candidate ONLY.
  title = await humanizeTitleTo75(openai, title, {
    baseSystem, baseUser,
    pool: topUpgradeKws,
    brandName,
    // SAME post-pipeline as council pass 1 — scrub → cap → garment-collapse/dedup → competitor-brand net.
    postProcess: (raw) => stripCompetitorBrand(collapseGarmentsAndDedup(capTitle75(scrubTrademarks(raw)))),
    onProgress,
    trigger: 68,
    label: 'Parent title',
    v4Sink,
    lean: parentLean,   // Fix D: same adopt-gate discipline as single-design (INVARIANT-1 parity)
    maxLeftWords: poGolds?.shape.maxLeftWords ?? null,
    shape: poGolds?.shape ?? null,
    apparel: /shirt|tee|hoodie|sweatshirt|tank|apparel/i.test(ptWord || ''),
  })
  return title
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * FINAL EDITORIAL AUDIT — the "council-approved" gate over the FULLY-ASSEMBLED customer-facing copy
 * (content-quality foundational, PO-approved 2026-07-07). One senior-editor LLM pass reads the final
 * bullets + description + a representative backend string AGAINST the real product (design/joke, garment,
 * audience) and fixes what no deterministic rule reliably catches: truncated bullets ("…with jeans or."),
 * generic OFF-THEME bullets, awkward description phrasing, and a polluted backend (unrelated holidays/
 * countries, competitor/other blank brands, standalone colors, junk fragment tokens like "he s"/"hes").
 * Returns fixed bullets + description and a set of backend TERMS TO DROP (applied to EVERY child so all
 * per-color strings get cleaned). FAIL-OPEN: any LLM/parse failure returns everything unchanged, so it
 * can only ever IMPROVE. The title is NOT rewritten here (its 75-char/brand/manual-lock guards are upstream).
 */

/** Detect "{HOBBY} Widow" / "{HOBBY} Wife" compound-noun titles where the WEARER is the SPOUSE of the
 *  enthusiast, NOT the enthusiast herself. B0FRYMM56C (a Golf Widow tee) shipped bullet 1 as "made just
 *  for golf-loving women" and the description as "Celebrate your golf-loving spirit" — the AI inverted
 *  the joke into being about the wearer. Same class: Football Widow, Fishing Widow, Beer Wife, etc.
 *
 *  Distinction: "{HOBBY} Widow/Wife" is a compound noun (wearer's role = spouse of the enthusiast).
 *  A plain "gift for wife" / "wife birthday" is an audience/occasion phrase and does NOT fire — we only
 *  match when a KNOWN HOBBY word directly precedes widow/wife/widowed. */
const HOBBY_NOUNS_FOR_WIDOW = new Set([
  'golf','golfing','fishing','hunting','football','baseball','basketball','soccer','hockey','tennis',
  'racing','poker','gambling','gaming','gamer','gym','crossfit','running','cycling','biking','skiing',
  'snowboard','surfing','skate','skateboarding','climbing','hiking','camping','boating','sailing','yacht',
  'motorcycle','biker','trucker','car','auto','pilot','flying','beer','whiskey','wine','coffee','pool',
  'dart','bowling','chess',
])
function detectWidowFormat(...titles: (string | null | undefined)[]): { isWidowFormat: boolean; hobby: string; spouseWord: string } {
  for (const t of titles) {
    if (!t) continue
    const m = String(t).toLowerCase().match(/\b(\w+)\s+(widow|widowed|widows|wife|wives)\b/)
    if (m && HOBBY_NOUNS_FOR_WIDOW.has(m[1])) return { isWidowFormat: true, hobby: m[1], spouseWord: m[2] }
  }
  return { isWidowFormat: false, hobby: '', spouseWord: '' }
}

/** Injectable rule block for runBulletsAgent / runDescriptionAgent / runFinalEditorialAudit when a widow
 *  format is detected. Names the failure mode explicitly and enumerates ALLOWED vs FORBIDDEN framings so
 *  the model stops flipping the joke. Returns '' when not a widow format (no-op for every other listing). */
function widowFormatRule(w: { isWidowFormat: boolean; hobby: string; spouseWord: string }): string {
  if (!w.isWidowFormat) return ''
  const hobby = w.hobby
  const spouse = w.spouseWord.replace(/s$/, '').replace(/ed$/, '')   // widows/widowed → widow, wives → wife
  const doing = hobby === 'golf' ? 'golfing' : hobby === 'fishing' ? 'fishing' : hobby === 'hunting' ? 'hunting' : hobby === 'gaming' || hobby === 'gamer' ? 'gaming' : hobby === 'gym' || hobby === 'crossfit' ? 'at the gym' : hobby === 'motorcycle' || hobby === 'biker' ? 'riding' : `doing ${hobby}`
  const away = hobby === 'golf' ? 'at the course' : hobby === 'fishing' ? 'at the lake' : hobby === 'football' || hobby === 'baseball' || hobby === 'basketball' || hobby === 'soccer' || hobby === 'hockey' ? 'watching the game' : hobby === 'racing' ? 'at the track' : hobby === 'poker' || hobby === 'gambling' ? 'at the table' : hobby === 'hunting' ? 'out hunting' : `at ${hobby}`
  return `\n🚫 WEARER POV — ${hobby.toUpperCase()} ${spouse.toUpperCase()} FORMAT (read this before writing anything):
This design's title contains "${hobby} ${spouse}" — a compound noun meaning the wearer is the SPOUSE of a ${hobby} enthusiast, NOT the enthusiast herself. The joke pokes fun at HIM (or HER partner) being always ${doing}, not at the wearer's own hobby.
- The wearer does NOT do ${hobby}. Her PARTNER does. She is the one waiting at home / ${away} / holding the fort.
- 🚫 FORBIDDEN phrasing (this is the exact failure mode — do NOT reproduce it):
  ✗ "for ${hobby}-loving women" / "for women who love ${hobby}"
  ✗ "celebrate your ${hobby}-loving spirit" / "for the ${hobby} lover"
  ✗ "made just for ${hobby}-loving women" / "channel your ${hobby} passion"
  ✗ ANY phrasing that implies the WEARER is the one who plays/does/loves ${hobby}.
- ✅ CORRECT framings (the wearer is the SPOUSE, the joke is on the enthusiast):
  ✓ "for the ${hobby} ${spouse} whose husband is always ${doing}"
  ✓ "great gift for a ${hobby} ${spouse} — you know who you are"
  ✓ "when he's always ${doing}, tell everyone where he is with this ${hobby} ${spouse} tee"
  ✓ "for wives who wave the ${hobby} flag from the sidelines"
Before returning, RE-READ every sentence: if any implies SHE loves ${hobby}, rewrite it.
`
}

// Deterministic dangle repair — trims a phrase that ends on a stray CONJUNCTION/ARTICLE. A sentence never
// legitimately ends on "and/or/plus/the/a/an", so stripping those is safe; "for/to/of/with" are DELIBERATELY
// excluded (they are valid stranded prepositions — "the tee every golf widow's been waiting for."). Kills a
// cut bullet "...styling with jeans or." without corrupting grammatical copy (B0FRYMM56C).
const DANGLE_TAIL = /[\s,]+(?:and|or|plus|the|a|an|&)\s*[.,;:]*\s*$/i
function deDangle(s: string): string {
  let out = (s || '').trim()
  let prev = ''
  while (out && out !== prev) { prev = out; out = out.replace(DANGLE_TAIL, '').trim() }
  if (out && !/[.!?]["')\]]?$/.test(out) && !/>$/.test(out)) out += '.'   // restore terminal punctuation (allow a trailing quote/paren)
  return out
}
// Hard-cap a bullet at maxLen on a WORD boundary (then de-dangle) instead of discarding it — the audit's
// old all-or-nothing "every bullet <=200" gate silently threw away ALL its fixes on one overlong bullet.
function capBulletLen(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s
  const cut = s.slice(0, maxLen)
  const lastSpace = cut.lastIndexOf(' ')
  const out = deDangle(lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut)
  return out.length > maxLen ? out.slice(0, maxLen).trimEnd() : out
}
// Repair the "...for Comfort Colors and for, it features" dangling-connector artifact: a PREPOSITION (with an
// optional leading conjunction) stranded right before a comma is a cut, not an aside — collapse it. A bare
// "or,"/"and," aside ("Dress it up or, if you prefer,...") is LEFT ALONE. Looped so "and for," fully clears.
function tidyDescription(html: string): string {
  let out = (html || '')
  let prev = ''
  while (out !== prev) { prev = out; out = out.replace(/\s+(?:(?:and|or|plus)\s+)?(?:for|to|of|with|in|on|at)\s*,/gi, ',') }
  return out.replace(/\s{2,}/g, ' ').trim()
}
// Fit truthfulness backstop: when the REAL fit is known and is NOT oversized, replace a fabricated
// "oversized"/"boxy" claim with the true fit word (case-preserved) so a fail-open audit or a raw council
// bullet can't ship "oversized" on a relaxed garment (B0FRYMM56C: CC1717 is a relaxed fit). No-op if unknown.
function scrubFitClaims(s: string, fit: string): string {
  if (!s || !fit || /oversized/i.test(fit)) return s
  const word = fit.split(/\s+/)[0] || fit
  // A NEGATED false-fit claim ("a relaxed fit ... without being oversized") is ACCURATE — but a blind swap
  // turns it into a self-contradiction ("without being relaxed", live on B0FRYMM56C 2026-07-10). Drop the
  // negated aside entirely (redundant once the true fit is named) BEFORE swapping remaining POSITIVE claims.
  const out = s
    .replace(/(?:\s+(?:and|but|yet|while|though))?[,;]?\s*(?:without being|without feeling|not|never|no longer|isn't|aren't|avoids?|free of|rather than)\s+(?:a |an |too |overly )?(?:oversized|boxy)(?:\s+(?:look|fit|cut|silhouette|style|shape|feel))?\b/gi, '')
    .replace(/\b(?:oversized|boxy)\b/gi, (m) =>
      m === m.toUpperCase() ? word.toUpperCase()
        : m[0] === m[0].toUpperCase() ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
          : word.toLowerCase())
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;!?])/g, '$1').trim()
}

// Description-body scrubber (PO 2026-07-21, INVARIANT 2 terminal net). Two rules that run on the FINAL
// shipped bytes, AFTER runFinalEditorialAudit + per-design fan-out (the last LLM stages that could
// re-inject either violation). Both callers already sit in the existing scrub chain around tidyDescription
// / scrubFitClaims — this appends one more link so nothing that ships escapes the net.
//   RULE 1 — brand-strip: sellers put the brand in the `brand` attribute + title; repeating it in the
//     description body prose is redundant + eats real estate + AI-hallucinated (verified 2026-07-21:
//     B0FKKN8XKV description body contained two "THE CEO" mentions the generator invented; nothing
//     downstream stripped them). We strip STANDALONE "THE CEO" including inside a quoted phrase per PO
//     policy ("STRIP inside quotes" fork, 2026-07-21) — the failing case was `"THE CEO I Will Praise
//     Him in Every Season"` where the brand was clearly a prepend, not authorial quotation.
//   RULE 2 — production-method scrub: PO ships PRINTED tees (DTG-style), never screen-print. Any
//     "Screen-printed" / "screen printed" / "silk-screened" claim is factually wrong on the PDP; replace
//     with "printed". Extend UNSUPPORTED_PRODUCTION_METHODS deliberately when a new false claim shows up.
// Idempotent by regex construction (running twice = running once). Whitespace + possessive cleanup baked
// in so `THE CEO's Christian` doesn't leave `'s Christian` on the shelf.
// Bullet char-budget invariants (2026-07-21, INVARIANT 5 — ONE source of truth per byte budget). PO
// SEO/conversion target: each bullet 150-200 chars. Values now live in contentContract.ts (spine Step 1).
export const BULLET_MIN_CHARS = CONTENT_CONTRACT.bullets.min
export const BULLET_MAX_CHARS = CONTENT_CONTRACT.bullets.max
// Description char-budget floor (mirrors existing 900-980 target). Value now lives in contentContract.ts
// (spine Step 1). Exported so the terminal re-expand can re-check length after scrubDescriptionBody.
export const DESC_MIN_CHARS = CONTENT_CONTRACT.description.floor
export const UNSUPPORTED_PRODUCTION_METHODS = ['screen[- ]?print(ed|ing)?', 'silk[- ]?screen(ed|ing)?']

// Deterministic apparel pad pool (2026-07-21, judge workflow wg9bftozi). Terminal 100% floor guarantee
// for bullets the LLM couldn't expand to BULLET_MIN_CHARS. Curated pre-scrubbed: no "oversized"/"boxy"
// (scrubFitClaims-safe), no protected marks, no dangling connectors, terminal period for a clean join.
// 6 entries so 5 bullets in one push each land on a unique suffix without repeats. Rationale: char-count
// prompting undershoots ~20-30% on ALL current LLMs (arXiv 2508.13805) — prompt-only control cannot
// guarantee thresholds; the paper explicitly recommends separate validation logic. This IS that logic.
const APPAREL_PAD_POOL: readonly string[] = Object.freeze([
  'A comfortable everyday staple.',
  'A soft, breathable pick for daily wear.',
  'Ideal for daily wear, layering, or thoughtful gifting.',
  'Machine wash cold, tumble dry low to keep colors true.',
  'Pairs cleanly with denim, joggers, or shorts year-round.',
  'A thoughtful gift for birthdays, holidays, or just because.',
])

/** Deterministic bullet pad — runs AFTER the LLM retry budget is spent. Zero tokens. Idempotent:
 *  base >= floor returns base unchanged. Picks the smallest suffix that lifts base into [floor, ceil]
 *  without overshooting, skipping any suffix already used in this push OR whose 4+-char words already
 *  appear ≥2 times in base (avoids echoing). Never regresses — no-suffix-fits returns base as-is. */
function padBulletDeterministic(
  base: string,
  bulletIndex: number,
  usedSuffixes: Set<string>,
  floor: number = BULLET_MIN_CHARS,
  ceil: number = BULLET_MAX_CHARS,
): string {
  const trimmed = (base || '').trim()
  if (trimmed.length >= floor) return trimmed
  const baseLower = trimmed.toLowerCase()
  const pool = APPAREL_PAD_POOL
  const start = ((bulletIndex % pool.length) + pool.length) % pool.length
  // Two passes (2026-07-31, live B0GR22ZHBW): an all-5-short push consumed suffixes 0-3 on bullets 1-4
  // and bullet 5's two remaining candidates both hit the overlap-skip — the strict pass exhausted and a
  // 120-char bullet shipped (census BULLET_UNDER_MIN). The floor is the hard Amazon-facing invariant;
  // echo-avoidance is a preference — so retry relaxed (used + band still enforced) before giving up.
  for (const relaxed of [false, true]) {
    for (let k = 0; k < pool.length; k++) {
      const suffix = pool[(start + k) % pool.length] as string
      if (usedSuffixes.has(suffix)) continue
      if (!relaxed) {
        const suffixWords = suffix.toLowerCase().match(/[a-z]{4,}/g) ?? []
        const overlaps = suffixWords.filter((w) => baseLower.includes(w)).length
        if (overlaps >= 2) continue
      }
      const baseWithStop = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
      const candidate = `${baseWithStop} ${suffix}`.trim()
      if (candidate.length >= floor && candidate.length <= ceil) {
        usedSuffixes.add(suffix)
        return candidate
      }
    }
  }
  return trimmed
}

// TERMINAL bullets expander (INVARIANT 2 — deterministic net on shipped bytes; INVARIANT 3 — must fire
// on section-regen + per-child fan-out, not just the full-pipeline path). For each shipped bullet under
// BULLET_MIN_CHARS, rewrites ONLY that bullet with a targeted gpt-4.1-mini call (cheapest compliant model
// already used at other in-pipeline retry sites, per assumption 5 of the C+D plan). Per-bullet, not
// all-5-at-once — cheaper AND monotonic (keeps every already-passing bullet byte-identical). 1 retry
// with an "expand further" nudge; keep-best on distance-to-target so we NEVER regress a passing bullet.
// Post-scrub every rewrite through the same deterministic gates existing bullets already pass
// (deDangle, scrubFitClaims, dup-word collapse, normalizeBrandInBullet, capBulletLen at BULLET_MAX_CHARS).
export async function expandShortBulletsTerminal(
  openai: OpenAI,
  bullets: string[],
  ctx: { title: string; designName?: string; fit?: string; garmentBrand?: string },
): Promise<string[]> {
  if (!Array.isArray(bullets) || bullets.length !== 5) return bullets
  const needs = bullets.some((b) => (b?.trim().length ?? 0) < BULLET_MIN_CHARS)
  if (!needs) return bullets                                   // IDEMPOTENT no-op — bullets already pass
  const gate = (b: string): string => {
    // Leading-dash strip (2026-07-31, live B0GR22ZHBW): the model read the prompt's «keep the " - "
    // prefix» as PREPEND one — stored bullet 1 shipped as "- CELEBRATE ...". Deterministic net, not
    // a prompt fix alone (INVARIANT 2: the LLM is never the last word on a format invariant).
    let s = b.replace(/^[\s\-–—]+/, '')
    s = ctx.fit ? scrubFitClaims(deDangle(s), ctx.fit) : deDangle(s)
    s = s.replace(/\b(\w+)(\s+\1)\b/gi, '$1')                  // parity with per-child truth gate
    if (ctx.garmentBrand) s = normalizeBrandInBullet(s, ctx.garmentBrand)
    return capBulletLen(s, BULLET_MAX_CHARS)
  }
  const out = [...bullets]
  const usedSuffixes = new Set<string>()   // shared across the 5 bullets so the pad picks unique suffixes
  const sys = `You are an Amazon apparel copywriter. Rewrite ONE bullet to be ${BULLET_MIN_CHARS}-${BULLET_MAX_CHARS} characters long. The bullet format is "ALL-CAPS 2-3 WORD HOOK - one sentence"; keep the exact hook and start your rewrite WITH the hook — never prepend a dash or bullet mark before it. Keep the same core benefit; ADD real substance (fabric feel, fit, styling, care, gifting) — do NOT invent facts or new brand names. Return ONLY JSON: {"bullet":"..."}.`
  for (let i = 0; i < out.length; i++) {
    const original = (out[i] ?? '').trim()
    if (original.length >= BULLET_MIN_CHARS) continue
    let best = original
    let bestDist = Math.abs(BULLET_MIN_CHARS - original.length)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const nudge = attempt === 0 ? '' : ` The previous rewrite was ${best.length} chars — expand further to reach at least ${BULLET_MIN_CHARS}.`
        const resp = await openai.chat.completions.create({
          model: 'gpt-4.1-mini', temperature: 0.4, max_tokens: 400, response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: `PRODUCT: "${ctx.title}"${ctx.designName ? ` — design "${ctx.designName}"` : ''}\nCURRENT BULLET (too short at ${original.length} chars):\n${original}${nudge}\nRewrite it now.` },
          ],
        })
        const parsed = JSON.parse(resp.choices[0]?.message?.content || '{}') as { bullet?: unknown }
        const raw = typeof parsed.bullet === 'string' ? parsed.bullet.trim() : ''
        const gated = raw ? gate(raw) : ''
        if (!gated) continue
        const dist = gated.length < BULLET_MIN_CHARS ? BULLET_MIN_CHARS - gated.length
          : gated.length > BULLET_MAX_CHARS ? gated.length - BULLET_MAX_CHARS
            : 0
        // Keep-best: prefer smaller distance-to-band; on ties prefer longer (over the floor is better UX).
        if (dist < bestDist || (dist === bestDist && gated.length > best.length)) {
          best = gated
          bestDist = dist
          if (dist === 0) break                                // in-band hit → stop retrying
        }
      } catch (e) {
        // Name the failure (2026-07-31, twin of DESC_REEXPAND_MISS #457): a silent catch here hid a
        // live run where all 10 attempts contributed nothing and every bullet fell to the pad.
        console.warn(JSON.stringify({ tag: 'BULLET_EXPAND_MISS', reason: 'error', bullet: i + 1, attempt: attempt + 1, error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) }))
      }
    }
    if (bestDist > 0) console.warn(JSON.stringify({ tag: 'BULLET_EXPAND_MISS', reason: best === original ? 'no-usable-rewrite' : 'still-out-of-band', bullet: i + 1, origLen: original.length, bestLen: best.length }))
    // TERMINAL 100% floor guarantee (2026-07-21, workflow wg9bftozi judge verdict). LLM char-count
    // undershoot is systemic (arXiv 2508.13805) — prompt-only control can't guarantee thresholds;
    // deterministic pad is the only reliable enforcer. Idempotent: base >= floor → no-op.
    out[i] = padBulletDeterministic(best, i, usedSuffixes)
    if ((out[i] ?? '').length < BULLET_MIN_CHARS) console.warn(JSON.stringify({ tag: 'BULLET_PAD_EXHAUSTED', bullet: i + 1, len: (out[i] ?? '').length }))
  }
  return out
}

// TERMINAL description re-expand (INVARIANT 3 — pairs with scrubDescriptionBody, which strips 40-60 chars
// on B0FKKN8XKV and pushes the shipped bytes below DESC_MIN_CHARS after the audit's own expand-pass at
// runDescriptionAgent line ~4200 has already run). Fires ONLY if plainLen < DESC_MIN_CHARS; extends via
// gpt-4.1-mini with an explicit "no brand mentions, no screen-print claims" instruction; re-runs
// scrubDescriptionBody + capDescriptionVisible on the extended output so the LLM CAN'T re-inject either
// violation.
/**
 * Terminal deterministic net — content-spine Step 2 (2026-07-22). ONE function that runs a field's
 * terminal passes in the exact order + with the exact arguments the FULL regen path uses today:
 *   bullets      → expandShortBulletsTerminal (the 150-floor enforcer; idempotent, apparel-gated by caller)
 *   description  → scrubDescriptionBody (brand/screen-print strip) → reExpandDescriptionIfShort (re-fill <900)
 * Idempotent by construction (each underlying pass no-ops when already in band), so it is safe to call
 * on any path. Step 3 wires it into the section-regen returns; the full-path call sites are swapped in
 * Step 6. Keywords are intentionally NOT handled here (the keywords-only path already runs its chain).
 */
/** Compose a backend token-ban predicate with the capability ban (task #41 / GAP 2): a
 *  non-customizable listing's fill may never add custom/personalized/photo tokens. Returns the
 *  base predicate untouched when customizable (empty extra set — zero overhead). */
function composeCapabilityBan(base: (w: string) => boolean, customizable: boolean): (w: string) => boolean {
  const extra = new Set(capabilityBanTokens(customizable))
  return extra.size ? (w: string) => base(w) || extra.has(w.toLowerCase()) : base
}

export async function applyTerminalNets(
  field: 'bullets' | 'description',
  value: string[] | string,
  ctx: {
    openai: OpenAI
    finalTitle: string
    designName: string
    fit: string | undefined
    brandName: string
    garmentBrand: string | undefined
    /** blankSpec.unisex — drives the sizing-clarity guarantee (PO 2026-08-06: unisex blanks
     *  marketed to women MUST say so in bullets/description/features, NEVER the title). */
    unisex?: boolean
    /** blankSpec fabric truth (task #41 / GAP 2) — drives enforceFabricTruth, the terminal net that
     *  rewrites false weight-class claims to the blank's true class and strips unverifiable
     *  stretch claims. Absent spec ⇒ weight adjectives are REMOVED (never claimed unconfirmed). */
    weightNote?: string
    stretch?: string
  },
): Promise<string[] | string> {
  if (field === 'bullets') {
    let bullets = value as string[]
    if (!Array.isArray(bullets) || bullets.length !== 5) return bullets
    bullets = await expandShortBulletsTerminal(ctx.openai, bullets, {
      title: ctx.finalTitle,
      designName: ctx.designName,
      fit: ctx.fit,
      garmentBrand: ctx.garmentBrand,
    })
    if (ctx.unisex) bullets = ensureUnisexFitClause(bullets)
    // FABRIC TRUTH last (INVARIANT 2): the expander above is an LLM and can re-introduce a false
    // weight claim; the deterministic net has the final word on every path.
    bullets = bullets.map((b) => enforceFabricTruth(b, { weightNote: ctx.weightNote, stretch: ctx.stretch }))
    return bullets
  }
  // description
  let d = value as string
  if (!d) return d
  if (ctx.brandName) d = scrubDescriptionBody(d, { brand: ctx.brandName, garmentBrand: ctx.garmentBrand })
  if (ctx.unisex) d = capDescriptionVisible(injectUnisexFitNote(d))
  if (ctx.brandName) d = await reExpandDescriptionIfShort(ctx.openai, d, { finalTitle: ctx.finalTitle, brand: ctx.brandName, garmentBrand: ctx.garmentBrand })
  // FABRIC TRUTH last (INVARIANT 2) — the re-expander is an LLM and can re-inject a false weight
  // claim. Re-cap ONLY when the net changed the bytes (a weight-class replacement can lengthen the
  // text); an untouched description passes through byte-identical (the pinned passthrough contract).
  const truthed = enforceFabricTruth(d, { weightNote: ctx.weightNote, stretch: ctx.stretch })
  d = truthed === d ? d : capDescriptionVisible(truthed)
  return d
}

/** UNISEX SIZING CLARITY — bullets half (PO 2026-08-06: the whole catalog is unisex blanks
 *  marketed to women; a woman shopper assumes a women's cut unless told otherwise — a returns
 *  risk, not a wording nicety). Deterministic and idempotent: no-op when any bullet already
 *  says "unisex"; otherwise appends the sizing guidance to the fit-adjacent bullet (else the
 *  last one). Runs INSIDE applyTerminalNets so every path — full regen, section-regen — gets
 *  it by construction. NEVER applied to the title (explicit PO rule). */
export function ensureUnisexFitClause(bullets: string[]): string[] {
  if (!Array.isArray(bullets) || bullets.length === 0) return bullets
  if (bullets.some((b) => /unisex/i.test(b || ''))) return bullets
  const out = [...bullets]
  const idx = out.findIndex((b) => /\b(?:fit|relaxed|comfort|soft)\b/i.test(b || ''))
  const i = idx >= 0 ? idx : out.length - 1
  const base = (out[i] || '').trim().replace(/[.\s]+$/, '')
  out[i] = `${base}. Unisex sizing runs relaxed — many women size down one for a fitted look.`
  return out
}

/** UNISEX SIZING CLARITY — description half. Inserts one bolded fit note right after the FIRST
 *  paragraph (so the later visible-length cap trims tail prose, never this note). Idempotent:
 *  no-op when the description already mentions "unisex". */
export function injectUnisexFitNote(d: string): string {
  if (!d || /unisex/i.test(d)) return d
  const note = '<p><b>Unisex Fit:</b> Cut on a relaxed unisex size chart — for a more fitted look, many women size down one.</p>'
  const idx = d.indexOf('</p>')
  return idx >= 0 ? d.slice(0, idx + 4) + note + d.slice(idx + 4) : note + d
}

export async function reExpandDescriptionIfShort(
  openai: OpenAI,
  description: string,
  opts: { finalTitle: string; brand?: string; garmentBrand?: string },
): Promise<string> {
  if (!description) return description
  const plainLen = (d: string): number => d.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length
  const preLen = plainLen(description)
  if (preLen >= DESC_MIN_CHARS) return description                // IDEMPOTENT — already in band
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-4.1-mini', temperature: 0.5, max_tokens: 1200,
      messages: [
        { role: 'system', content: `You are an Amazon apparel copy editor. Extend the given HTML product description to 920-970 visible characters (~165 words). ADD 1-2 sentences of real substance about fabric feel, fit, styling, care, or gift suggestions. Keep clean HTML (<p>, <b>, <ul>, <li>) — never flatten to plain prose. Do NOT invent facts, audiences, or professions not already implied. Do NOT mention the seller brand in body prose (the brand attribute already carries it). Do NOT add screen-printed / silk-screen claims. Return ONLY the expanded HTML.` },
        { role: 'user', content: `Product: "${opts.finalTitle}". Current description (${preLen} chars, too short — target 920-970):\n${description}` },
      ],
    })
    const raw = (resp.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
    if (!raw || plainLen(raw) <= preLen) {
      // The model was ASKED for 920-970 and returned nothing longer. Fail-open is right, but a
      // silent fail-open is how a 719-char description persisted with no line anywhere (B0GR22ZHBW,
      // 2026-07-30 — the census caught the RESULT, this names the CAUSE for the next specimen).
      console.warn(JSON.stringify({ tag: 'DESC_REEXPAND_MISS', reason: raw ? 'not-longer' : 'empty', preLen, gotLen: raw ? plainLen(raw) : 0 }))
      return description
    }
    // BELT-AND-SUSPENDERS: LLM instructions can't be trusted (INVARIANT 2). Re-run the scrub on the
    // extended output so an accidental "THE CEO" or "screen-printed" re-injection gets caught here too.
    const scrubbed = scrubDescriptionBody(capDescriptionVisible(raw), { brand: opts.brand ?? '', garmentBrand: opts.garmentBrand })
    return plainLen(scrubbed) > preLen ? scrubbed : description
  } catch (e) {
    // fail-open — keep pre-expand copy, but never silently: the swallowed error here was the one
    // fact that could distinguish "transient LLM failure" from "prompt regression" on the 719 case.
    console.warn(JSON.stringify({ tag: 'DESC_REEXPAND_MISS', reason: 'error', preLen, error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) }))
    return description
  }
}
export function scrubDescriptionBody(html: string, opts: { brand?: string; garmentBrand?: string }): string {
  if (!html) return html
  let out = html
  // Rule 1 — brand-strip. Only STANDALONE seller-brand mentions; the `brand` attribute + title carry
  // it authoritatively. Also strip the possessive `THE CEO's` → drop the possessive fragment so we
  // don't leave "'s Christian shirt" hanging (rare but proven-possible generator output).
  const brand = (opts.brand ?? '').trim()
  if (brand && brand.length >= 2) {
    const esc = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // PREP-PREFIX strip FIRST: "tee from THE CEO." → "tee." (drops the preposition too so we don't
    // leave "tee from." dangling — verified failing 2026-07-21 on B0FKKN8XKV first regen after the
    // net's initial deploy). Covers common patterns before + after nouns.
    out = out.replace(new RegExp(`\\s+\\b(?:from|by|with|for|of|at|in|on|to)\\s+${esc}(?:'s)?\\b`, 'gi'), '')
    // Then standalone-strip whatever brand mentions remain.
    out = out.replace(new RegExp(`\\b${esc}(?:'s)?\\s+`, 'gi'), '')   // "THE CEO Christian" → "Christian"; "THE CEO's Christian" → "Christian"
    out = out.replace(new RegExp(`\\s+\\b${esc}\\b`, 'gi'), '')       // trailing " THE CEO" — rare
  }
  // Rule 2 — production-method scrub. Replace each disallowed method with "printed" (word-boundary
  // matched, case-preserving isn't necessary because "printed" is always lowercase in body prose).
  for (const pattern of UNSUPPORTED_PRODUCTION_METHODS) {
    out = out.replace(new RegExp(`\\b${pattern}\\b`, 'gi'), 'printed')
  }
  // Post-scrub cleanup: collapse doubled spaces, strip space-before-punctuation, remove empty
  // parenthetical/brace remnants a strip may leave (e.g. "(THE CEO)" → "()"). Idempotent.
  out = out.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1')
  return out.trim()
}

// GROUND-TRUTH blank specs — authoritative garment facts per blank brand/style, so the pipeline stops
// GUESSING fit/sleeve/neck from the SEARCH keyword pool (which is full of "oversized tshirt" search DEMAND,
// not product facts) and mislabelling a relaxed Comfort Colors tee as "Oversized"/"Cap Sleeve". These
// OUTRANK the features-audit's keyword-derived guess. Bootstrapped with Comfort Colors (PO-confirmed:
// CC1717 = relaxed / midweight 6.1oz / garment-dyed / crew / short-sleeve). Extend as the seller confirms
// each blank; an UNLISTED blank simply falls back to the current guess (no regression).
// `stretch` / `fitToSize` (2026-07-19, PO) feed Amazon's "Apparel Fabric Stretch" + "Fit to Size Sentiment"
// attributes — richer than our binary `fabric_stretchability` (Non-stretchable/Stretchable): CC1717's
// garment-dyed ring-spun cotton is genuinely LOW stretch (not zero) and runs slightly small. Both are
// product FACTS, so they ground here rather than being guessed from the search pool.
// BLANK CATALOG → DB (2026-08-04, PO GO on the blank_specs slice): the hardcoded table moved to
// the `blank_specs` DB catalog (migration 053, seeded byte-identically; src/lib/fba/blankSpecs.ts
// owns the reader with a 5-min cache and fail-open to the same seed rows). The PO adds/corrects a
// blank with one SQL INSERT/UPDATE — no deploy — and affected listings heal on their next regen.
// Historical decisions preserved in the seeds: CC brand casing is AUTHORITATIVE (spec-vs-search);
// Gildan brandInCopy:false ("not a selling point like comfort colors"); \b64000 with no trailing
// boundary so SKU-glued style numbers match; Gildan material without a percentage (heathers are
// blends — a spec fact must hold for every child it decorates).

/** Search-shaped fact phrases from a blank spec — the Phase 6 facts-only backend pad source.
 *  Every phrase derives from a BLANK_SPECS field, so the pad can never invent a claim (plan R3:
 *  an unlisted blank returns [] and contributes nothing). Numbers/units are dropped because
 *  shoppers don't type them ("100% Ring-Spun Cotton" → "ring spun cotton", "6.1 oz" → gone).
 *  Anti-Goodhart: this is the ~40-60-byte facts ceiling the plan names — the real fix for thin
 *  pools stays the pool itself (#144/#149), never more padding. */
export function blankSpecFactTokens(spec: BlankSpec | null): string[] {
  if (!spec) return []
  const phrases = [spec.fit && `${spec.fit} fit`, spec.sleeve, spec.neck, spec.material, spec.dye, spec.weightNote]
  return phrases
    .filter((p): p is string => !!p)
    .map((p) => p.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\boz\b/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** Dedup a list of product-fact strings case-insensitively AND by substring containment, so the description
 *  model is never fed the same spec 2-3x (which it echoes → repetition → the audit trims → under-fill).
 *  "Garment-Dyed" collapses into "midweight 6.1 oz garment-dyed"; "ring spun cotton" into "100% Ring-Spun
 *  Cotton". Keeps the FIRST (longer/authoritative) occurrence — blankFacts are ordered before attrs.specs. */
function dedupeFacts(facts: string[]): string[] {
  const out: string[] = []
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  for (const f of facts) {
    const n = norm(f)
    if (!n) continue
    if (out.some((k) => { const kn = norm(k); return kn === n || kn.includes(n) || n.includes(kn) })) continue
    out.push(f)
  }
  return out
}

/** The description is HTML end-to-end: runDescriptionAgent writes <p>/<b>/<ul>/<li> (~line 3333) and the
 *  seller copy-pastes that markup into Seller Central. Anything that rewrites it must give HTML back. */
// ANY element counts as structure — a tag allowlist would false-flag a well-formed <div>/<h3> rewrite as
// "flattened" and throw away a good edit. The <ul> is checked separately because it is the one structural
// element the prompt names, and losing it while keeping a <p> is exactly the wall-of-text failure.
const HTML_STRUCTURE = /<[a-z][a-z0-9]*\b[^>]*>/i
const HAS_LIST = /<(?:ul|ol|li)\b[^>]*>/i
// An entity renders as ONE character. Counting "&#39;" as five inflates the pre-audit side and can push a
// legitimate rewrite under the ratio (gpt-4.1 varies entity density between input and output).
const visibleLen = (s: string): number => (s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, 'x')
  .replace(/\s+/g, ' ').trim().length
const stripCodeFence = (s: string): string => s.replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/i, '').trim()

/** True when the audit's rewrite is a DEGRADATION of the description rather than an edit of it.
 *  Two failure modes, both observed live on B0FRYMM56C (2026-07-10): the editor returned a plain
 *  paragraph (all markup gone) and only 504 of ~950 visible characters — roughly half the indexed
 *  text, silently. NOTE this is a RELATIVE gate against a known-good input, and it falls back to the
 *  pre-audit description — it is NOT the absolute "length floor" that the abort-and-preserve rule
 *  forbids (that rule is about aborting a whole regen on short-but-legitimate output). */
// 2026-07-13 (#71): length-preservation IS now safe. The old #369-era comment said "shorter audit =
// legitimate stuffing removal" — that was true when the pre-audit council draft was routinely stuffed +
// un-jargon-checked ("relaxed tshirts for women and vintage tshirts for women…", "printed on a Comfort
// Colors shirt blank"). PR #388 shipped a metric-gated critic loop INSIDE runDescriptionAgent that gates
// pre-audit output on scoreDescription (length 900-980, no jargon, <ul>, <b>, widow POV) — so any
// pre-audit reaching the audit is already clean AND at target length. A post-audit shortening below the
// 900 floor is now DESTRUCTIVE, not corrective (live B0FRYMM56C: critic pushed to ~950, audit shortened
// to 784 — 82% ratio slipped past the 0.75 halving gate and shipped short).
function degradesDescription(before: string, after: string): boolean {
  if (HTML_STRUCTURE.test(before) && !HTML_STRUCTURE.test(after)) return true // flattened to prose
  if (HAS_LIST.test(before) && !HAS_LIST.test(after)) return true             // the <ul> was destroyed
  const vb = visibleLen(before)
  const va = visibleLen(after)
  if (vb >= 400 && va < vb * 0.75) return true                                // half the text vanished
  // #71 length-floor gate, tightened 2026-07-14: pre-audit met the 900 floor (critic-approved) but the
  // audit shortened below it — destructive stripping, not a trim (live: 950→784, then 9xx→862 slipped
  // an 800 floor). The pre-audit is critic-gated (clean of jargon/stuffing), so reverting to it is safe;
  // once a ≥900 description exists, nothing downstream may ship shorter than 900.
  if (vb >= 900 && va < 900) return true
  return false
}

/** Trade/internal vocabulary that must never reach a shopper. "blank" (the undecorated garment) and
 *  "seller" are OUR words for the product, not the buyer's — they leak when the editor model
 *  paraphrases its own instructions. Word-boundary matched so "blanket" and "reseller" don't trip. */
const INTERNAL_JARGON = /\b(?:sellers?|seller's|blank|blanks|sku|skus|asin|asins)\b/i

/** True when `after` contains internal jargon that `before` did not — i.e. the AUDIT introduced it.
 *  Scoped to additions on purpose: a word already in the seller's own copy is not ours to silently
 *  delete here (see the "don't over-generalize a specific failure" rule). */
function introducesInternalJargon(before: string, after: string): boolean {
  return INTERNAL_JARGON.test(after) && !INTERNAL_JARGON.test(before)
}

/** Force the brand to its authoritative casing wherever it appears, case-insensitively. The model keeps
 *  writing "the trusted comfort colors brand" (lowercase) no matter how the prompt is worded — this makes
 *  the casing a DETERMINISTIC guarantee, not a hope. `brand` supplies the exact target casing. Function
 *  replacement (not the raw string) so a brand containing `$` can't inject a replacement pattern. */
function normalizeBrandCase(text: string, brand: string): string {
  if (!text || !brand) return text
  const esc = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`\\b${esc}\\b`, 'gi'), () => brand)
}

/** Bullet-aware brand normalizer: leave the deliberately ALL-CAPS "LABEL - " prefix alone (mixing case into
 *  it would read as a typo) and only re-case the brand inside the sentence body. Splits on any dash the
 *  model might emit as the label separator (hyphen / en / em) so the label stays protected either way. */
function normalizeBrandInBullet(bullet: string, brand: string): string {
  const m = bullet.match(/\s[-–—]\s/)
  if (!m || m.index === undefined) return normalizeBrandCase(bullet, brand)
  return bullet.slice(0, m.index) + normalizeBrandCase(bullet.slice(m.index), brand)
}

async function runFinalEditorialAudit(
  openai: OpenAI,
  title: string,
  bullets: string[],
  description: string,
  backendSample: string,
  ctx: { design: string; designPhrases: string[]; garment: string; audience: string; referenceTitle: string; brandFront: string; garmentBrand: string; fit: string; weightNote?: string; customizable?: boolean; widow?: { isWidowFormat: boolean; hobby: string; spouseWord: string } },
): Promise<{ title: string; bullets: string[]; description: string; backendDrop: Set<string> }> {
  const unchanged = { title, bullets, description, backendDrop: new Set<string>() }
  try {
    // Phrased as a PERMISSION, never as a fact about the product. The old wording ("this is the
    // SELLER'S OWN garment brand") read like copy, and gpt-4.1 paraphrased it straight into a live
    // bullet: "Made with the seller's own Comfort Colors blank for trusted quality" (B0FRYMM56C,
    // 2026-07-10). Meta-guidance to the model must never be sayable about the product.
    const brandNote = ctx.garmentBrand ? ` The garment brand is "${ctx.garmentBrand}" — naming it in customer copy is ALLOWED and encouraged.` : ''
    const fitClause = ctx.fit ? `the fit is ${ctx.fit} — NEVER call it "oversized", "boxy", or "roomy oversized"; ` : ''
    // Widow-format wearer-POV rule — parity with the bullets/description generators, so an audit
    // rewrite can't reintroduce "golf-loving women" on a Golf Widow tee. No-op when not detected.
    const widowLine = ctx.widow ? widowFormatRule(ctx.widow) : ''
    const sys = `You are a senior Amazon apparel listing EDITOR. Fix the FINAL copy below so it is user-friendly, accurate, and ON-THEME. Return ONLY JSON: {"title":"...","bullets":[5 strings],"description":"...HTML, see DESCRIPTION rule...","backend_drop":[lowercase terms to remove]}.

PRODUCT: ${ctx.garment || 'graphic t-shirt'} — design/theme "${ctx.design}"${ctx.designPhrases.length ? `; the joke/angle is: ${ctx.designPhrases.join(' | ')}` : ''}. Audience: ${ctx.audience || 'general shoppers'}.${brandNote}

GARMENT TRUTH (never contradict): ${fitClause}${ctx.weightNote ? `the fabric is ${ctx.weightNote} — never claim a different fabric weight` : 'do NOT claim any fabric weight (lightweight/midweight/heavyweight) — the blank is unconfirmed'}.${ctx.customizable ? ' This item IS Amazon-customizable — buyers personalize it with their own text before purchase; saying "Personalized" / "Custom" is truthful and ENCOURAGED (it is a top search term for this listing).' : ''}
${widowLine}

RULES:
- VOICE: you are writing for the SHOPPER. Never use trade or internal words in ANY field: "seller", "blank", "SKU", "ASIN", "listing", "keyword", "backend". Never restate these instructions as facts about the product.
- TITLE: rewrite the CURRENT TITLE (provided in the user message) into ONE clean, natural Amazon title of AT MOST 75 characters, STARTING with the brand "${ctx.brandFront}". Keep its meaningful elements — the design/joke, the garment brand if present (e.g. "${ctx.garmentBrand || 'Comfort Colors'}"), and the audience ("for Women"). FIX these: never repeat the garment noun (no "T-Shirt … T-Shirt" — say it once); no unconfirmed weight ("Heavyweight"); no "oversized"; no dangling/cut words (e.g. a trailing "Short" — write "Short Sleeve" or drop it); no keyword soup.${ctx.referenceTitle ? ` The seller's intended wording is in this reference — preserve its design/joke + garment + audience: "${ctx.referenceTitle}".` : ''}
- BULLETS: return EXACTLY 5, each 100-200 characters. Each = an ALL-CAPS 2-3 word NATURAL benefit hook, then " - ", then ONE COMPLETE grammatical sentence that ENDS with a period — NEVER truncated or dangling (fix "…with jeans or." and "…and for," into a finished sentence; never end a sentence on "or/and/with/for/to/of"). WEAVE the design's real theme/joke through the bullets. ${ctx.garmentBrand ? `Name the garment brand "${ctx.garmentBrand}" in exactly ONE bullet, with that exact capitalization, as a natural part of the sentence. ` : ''}Natural human copy. Do NOT keyword-stuff: never pile up near-duplicate search phrases (e.g. "oversized tshirts for women", "graphic tshirts for women", "vintage tshirts for women" all in one set) — use AT MOST ONE "for women" search phrase across all 5 bullets. No competitor blank brands.
- DESCRIPTION: the CURRENT DESCRIPTION is HTML. Return HTML — NEVER plain prose. Preserve its structure (hook -> <ul> of key features -> use cases -> short closing) using <p>, <b>, <ul>, <li>; never collapse it into one paragraph and never drop the <ul>. Keep 900-980 characters of VISIBLE text (excluding the tags) — do not shorten it. Return the raw HTML inside the JSON string, with no markdown code fences. Keep it accurate; write REAL sentences — NEVER keyword-list fragments like "For Comfort Colors shirt and for Comfort Colors tshirt construction, plus for tshirt availability" (that is stuffing, not English). Fix awkward/incomplete/dangling phrasing; mention the garment brand at most TWICE total; ${ctx.fit ? `the fit is ${ctx.fit}, never "oversized"; ` : ''}invent no specs.
- BACKEND_DROP: list the lowercase terms in the BACKEND STRING that DO NOT belong to THIS product: unrelated holidays/events/countries (e.g. "4th","july","fourth","america" on a non-patriotic design), competitor/other blank-garment brands (e.g. "gildan","gilden","softstyle" when the product is a DIFFERENT blank), standalone color words (Amazon has a color attribute), and junk/fragment tokens (e.g. "he","s","hes"). Do NOT list relevant terms (the design theme, garment type, real audience/occasion).

BACKEND STRING: ${backendSample}`
    const resp = await openai.chat.completions.create({
      // 2500 (was 1500): title + 5 bullets + a full description + backend_drop as JSON can exceed 1500
      // tokens → truncated JSON → JSON.parse throws → the audit fails open (raw council copy ships with
      // "oversized"/stuffing surviving — B0FRYMM56C). Timeout + 1 retry cover a hang/transient error.
      model: 'gpt-4.1', temperature: 0.3, max_tokens: 2500, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ title, bullets, description }) }],
    }, { timeout: 30_000, maxRetries: 1 })
    const p = JSON.parse(resp.choices[0]?.message?.content || '{}') as { title?: unknown; bullets?: unknown; description?: unknown; backend_drop?: unknown }
    // Title accepted only if it's a plausible rewrite (>=10 chars, still starts with the brand front) — the
    // caller re-applies capTitle75 + dedupeBrandAndStutter so it stays Amazon-legal + brand-front + de-duped.
    const outTitle = typeof p.title === 'string' && p.title.trim().length >= 10 && p.title.toLowerCase().includes(ctx.brandFront.toLowerCase().split(' ')[0] || '')
      ? p.title.trim() : title
    // Accept the audit's bullets when it returned 5 non-empty strings, then REPAIR each deterministically
    // (de-dangle + hard-cap 200 at a word boundary). The OLD gate discarded ALL fixes if any one bullet
    // ran >200 chars, silently shipping the raw council bullets (dangling "…with jeans or." + "oversized"
    // survived — B0FRYMM56C). Even on the fallback we de-dangle so a bad tail never ships.
    const okBullets = Array.isArray(p.bullets) && p.bullets.length === 5 && p.bullets.every((b) => typeof b === 'string' && b.trim().length > 0)
    const audited = okBullets
      ? (p.bullets as string[]).map((b) => capBulletLen(scrubFitClaims(deDangle(b.trim()), ctx.fit), 200))
      : bullets.map((b) => scrubFitClaims(deDangle(b), ctx.fit))
    // Deterministic net for prompt-instruction leak: the model can paraphrase our meta-guidance into
    // customer copy. Reject PER INDEX (never all-or-nothing — the #344 gate silently discarded every
    // fix) and only when the audit ADDED the jargon: a pre-existing word in the input is not ours to
    // drop here. Fallback keeps that bullet's pre-audit text, de-dangled + fit-scrubbed as usual.
    const cleaned = audited.map((b, i) => {
      const src = bullets[i] ?? ''
      return introducesInternalJargon(src, b) ? scrubFitClaims(deDangle(src), ctx.fit) : b
    })
    // Force the garment brand to its authoritative casing in every bullet BODY (never the ALL-CAPS label).
    // The model writes "the trusted comfort colors brand" no matter the prompt; this makes casing certain.
    const outBullets = ctx.garmentBrand ? cleaned.map((b) => normalizeBrandInBullet(b, ctx.garmentBrand)) : cleaned
    // The description is HTML. The audit MAY edit it, but it may not flatten it to prose or halve its
    // visible text (both happened live). Fall back per-field to the pre-audit HTML — which already passed
    // validateDescription + the brand-safety judge + the length cap — rather than shipping the damage.
    const preAuditDesc = scrubFitClaims(tidyDescription(description), ctx.fit)
    const rawAudited = typeof p.description === 'string' ? stripCodeFence(p.description.trim()) : ''
    const auditedDesc = rawAudited.length > 20 ? scrubFitClaims(tidyDescription(rawAudited), ctx.fit) : preAuditDesc
    const chosenDesc = auditedDesc === preAuditDesc ? preAuditDesc
      : (introducesInternalJargon(description, auditedDesc) || degradesDescription(description, auditedDesc))
        ? preAuditDesc
        : auditedDesc
    const brandNormalizedDesc = ctx.garmentBrand ? normalizeBrandCase(chosenDesc, ctx.garmentBrand) : chosenDesc
    // TERMINAL brand-strip + production-method scrub (INVARIANT 2). Runs AFTER the audit LLM (which
    // hallucinates "THE CEO" prepends and "Screen-printed design" claims — B0FKKN8XKV, 2026-07-21).
    // No-op if brandFront/garmentBrand absent.
    const scrubbedDesc = scrubDescriptionBody(brandNormalizedDesc, { brand: ctx.brandFront, garmentBrand: ctx.garmentBrand })
    // TERMINAL length re-expand (INVARIANT 3 — bundled with Item C, 2026-07-21). The scrub above trimmed
    // ~40-60 chars on B0FKKN8XKV live regen and pushed the audit output from 883→841, below DESC_MIN_CHARS.
    // Re-check and extend if now short; re-scrubs the extension so the LLM can't re-inject.
    const outDesc = await reExpandDescriptionIfShort(openai, scrubbedDesc, {
      finalTitle: ctx.referenceTitle ?? title,
      brand: ctx.brandFront,
      garmentBrand: ctx.garmentBrand,
    })
    const drop = new Set<string>(Array.isArray(p.backend_drop)
      ? (p.backend_drop as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase().trim()).filter((t) => t.length > 0)
      : [])
    return { title: outTitle, bullets: outBullets, description: outDesc, backendDrop: drop }
  } catch { return unchanged }
}

/* P0 INSTRUMENTATION — one correlation id per trip through the ship door, so a per-stage trace can
 * be reassembled from the logs of a single regen. Process-local and monotonic; it never affects a
 * decision, only the label on a log line. */
let DOOR_SEQ = 0

export async function runListingPipeline(input: PipelineInput): Promise<PipelineResult> {
  /** Per-run collector for [TITLE_V4_DIFF] entries, surfaced on `debug.v4` so the refusal rate is
   *  readable from the regen response instead of only from a server-log grep. */
  const v4Diffs: Record<string, unknown>[] = []
  // Reach BOTH title producers. `input` is per-call, so this cannot mix two regens' measurements.
  input.__v4Sink = v4Diffs
  const { brandName, repTitle, onProgress } = input

  // Stage 0a — relevance gate: drop keywords that are not about this product
  // (competitor brands, trademarks, unrelated names) before anything downstream uses them.
  onProgress('Filtering keywords for relevance...')
  const gated = await filterRelevantKeywords(input, input.analysis)
  // Stage 2 (noise filter): the phrases the gate removed are off-product noise (competitor
  // brands, trademarks, or a DIFFERENT product like "sim card" on an SD-card listing). Surface
  // them so the API route can mark them in keyword_analysis — the SCORER must stop docking the
  // listing for not ranking on keywords the relevance gate already rejected for the rewrite.
  const gatedKeywordSet = new Set(gated.map((g) => g.keyword))
  const irrelevantKeywords = input.analysis
    .filter((k) => !gatedKeywordSet.has(k.keyword))
    .map((k) => k.keyword)

  // Stage 0c — surface seller-known product attributes (garment brand "Comfort Colors",
  // material, fit) from the existing listing. JS never captures these, so without this
  // they're invisible to the optimizer. Inject as high-opportunity keywords so they flow
  // into the title-candidate / bullets / backend pools, and reinforce them in the prompts.
  onProgress('Extracting product attributes...')
  const attrs = await extractProductAttributes(input)
  const apparelProduct = looksApparel(input.category, repTitle, input.productType)
  // GARMENT-TYPE truthfulness (input scrub): the catalog attributes often carry the BLANK
  // manufacturer's boilerplate — live failure: a Comfort Colors T-SHIRT family whose attrs
  // said "Men's Heavyweight Crewneck Sweatshirt Cotton Blend Pullover", and because attrs
  // are TRUSTED product facts the title agent titled a tee as a fleece pullover. Scrub any
  // spec/keyphrase whose garment word contradicts the seller's own titles + the SP-API
  // productType BEFORE it can reach a brief (the output backstop below catches the rest).
  const garmentTrust = `${input.canonicalTitle ?? ''} ${repTitle ?? ''} ${input.productType ?? ''}`.toLowerCase()
  // Contradicted strings are KEPT here (not just dropped): the Features optimizer turns them
  // into FLAG-AND-FIX detail rows below — "find things and fix things", not silently discard
  // (PO: the catalog saying "sweatshirt" on a tee family is itself a defect to surface).
  const catalogBoilerplate: string[] = []
  if (apparelProduct) {
    const contradictsGarment = (s: string) => {
      const ws = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      return ws.some((w) => GARMENT_TYPE_WORDS.has(w) && !new RegExp(`\\b${w.replace(/s$/, '')}`, 'i').test(garmentTrust))
    }
    for (const s of [...attrs.specs, ...attrs.searchKeyphrases]) if (contradictsGarment(s)) catalogBoilerplate.push(s)
    attrs.specs = attrs.specs.filter((s) => !contradictsGarment(s))
    attrs.searchKeyphrases = attrs.searchKeyphrases.filter((s) => !contradictsGarment(s))
  }
  // Non-apparel listings are sometimes templated from a shirt, so their data carries apparel
  // contamination ("graphic tee", "ring-spun cotton", "for men"). Strip it for non-apparel so a
  // memory card / mug never inherits clothing language in the keyword pool, specs, or title.
  if (!apparelProduct) {
    const clean = (s: string) => !APPAREL_CONTAMINANTS.test(s)
    attrs.searchKeyphrases = attrs.searchKeyphrases.filter(clean)
    attrs.specs = attrs.specs.filter(clean)
  }
  const cleanGated = apparelProduct ? gated : gated.filter((k) => !APPAREL_CONTAMINANTS.test(k.keyword))
  // Secondary design-phrase capture (PO 2026-07-03): fold seller-title subtitle phrases like "Too
  // Many Books" in as a covered keyword ("a keyword that needs to be on the page"). Inject into
  // cleanGated (review: this is the pool that feeds topOppGated → topOpportunityKwsForBullets →
  // oppPlusDesign, so the phrase is COVERAGE-PROTECTED by the bullet coherence gate and the scorer;
  // injecting only into `analysis` bypassed all of that). Score 35, the attributeAsKeyword ceiling —
  // above filler, below the genuine money keywords, so it never crowds one out of the 75-char title
  // (review). Only when NOT already present at a real score.
  const secondaryPhrases = apparelProduct ? secondaryDesignPhrases(input.canonicalTitle ?? repTitle, brandName) : []
  if (apparelProduct) {
    for (const p of secondaryPhrases) {
      const pl = p.toLowerCase()
      if (!cleanGated.some((k) => k.keyword.toLowerCase() === pl)) cleanGated.unshift(attributeAsKeyword(p))
    }
  }
  // IDENTITY-SYNONYM coverage + OPPORTUNITY INHERITANCE (2026-07-15, B0H7L6KNNX): internationally
  // soccer == football == fútbol, but the harvest seeds on the listing's OWN term ("soccer") so the sibling
  // ("football"/"fútbol") is never surfaced — the listing indexes for soccer yet is invisible to the
  // (larger) football/fútbol audience. identityTokensOf only KEEPS a sibling when the pool already has it;
  // it can't ADD one. Guarantee the design's identity siblings enter the SHARED pool (→ analysis →
  // backendPool), and — crucially — INHERIT the ranking opportunity of the harvested SOURCE concept so a
  // synonym of a high-volume term is itself a HIGH-ranking opportunity that surfaces in the RANK panel and
  // gets placement priority, instead of a flat attribute-ceiling filler. Amazon indexes the LITERAL token
  // (it does not stem soccer↔football), so the synonym is still placed literally and only counts covered
  // when really present. Asymmetric: a gridiron "football" design yields nothing (protected from soccer).
  if (apparelProduct) {
    for (const { synonym, sources } of guaranteedIdentitySynonyms(input.canonicalTitle, repTitle)) {
      const re = new RegExp(`\\b${synonym}\\b`, 'i')
      if (cleanGated.some((k) => re.test(k.keyword))) continue
      const srcRe = new RegExp(`\\b(?:${sources.join('|')})\\b`, 'i')
      const bestSibling = cleanGated
        .filter((k) => srcRe.test(k.keyword))
        .reduce<AnalyzedKeyword | null>((a, b) => (!a || (b.coverageGapScore || 0) > (a.coverageGapScore || 0) ? b : a), null)
      // Clone the best sibling's PLACEMENT profile (coverageGapScore/volume/actionType) onto the
      // synonym token so placement treats it as the high-value keyword it is; fall back to filler if no
      // sibling is in the pool (e.g. the concept was only in the title, already stripped upstream).
      //
      // The three NATIVE Jungle Scout metrics are NULLED — the twin of the fix at
      // syncKeywordIntelligence.ts (see the long note there). Jungle Scout measured the SOURCE phrase,
      // not this token, so inheriting them would state a measurement that was never taken. Nulling
      // them also stops `carriesMarketOpportunity` from letting an unmeasured token win the title
      // money-tail pin, while `coverageGapScore` keeps it placeable in the backend bytes.
      cleanGated.unshift(
        bestSibling
          ? { ...bestSibling, keyword: synonym, jsEaseOfRanking: null, jsRelevancyScore: null, marketOpportunity: null }
          : attributeAsKeyword(synonym),
      )
    }
    /* SYNONYM PHRASES (PO ruling 2026-08-09, SELLER_PROFILE §3 gold rule 3: '"Football" is a
     * required international synonym on soccer products'). The bare-token injection above makes the
     * sibling INDEXABLE — it enters `analysis`, so the backend pool and the coverage model both see
     * it. What it can never be is CHOSEN for the title's money slot: the money-tail derivation at
     * :7660 requires 3-5 words carrying a garment noun, and "football" is one word. The PO's gold
     * spends that slot on exactly such a phrase ("… | USA Mexico Canada Football Tee"), so the
     * sibling has to reach the pool in phrase form too.
     * NOT a hardcoded title string: `identitySynonymPhrases` MIRRORS phrases the market already
     * returned for the source term, substituting only where the source token directly modifies a
     * garment noun, and each mirror INHERITS its source row's real opportunity/volume/action —
     * so the selector still picks on merit, it just stops being structurally unable to pick this.
     * `selectionRank: undefined` (not the source's rank) is deliberate and is the documented
     * meaning of undefined at :1497 — "the row was never in the scored pool at all ⇒ EXEMPT". A
     * mirror is synthetic; inheriting a null rank would let the target-set filter delete a synonym
     * §3 calls REQUIRED. Capped at 4 by inherited opportunity so a soccer family cannot flood the
     * pool. Fail-open at every step: no source row ⇒ nothing injected ⇒ byte-identical. */
    const synonymPhrases = identitySynonymPhrases(cleanGated.map((k) => k.keyword), input.canonicalTitle, repTitle)
      .map((p) => ({ ...p, row: cleanGated.find((k) => k.keyword.toLowerCase() === p.source.toLowerCase()) }))
      .filter((p): p is { phrase: string; source: string; row: AnalyzedKeyword } => !!p.row)
      .sort((a, b) => ((b.row.marketOpportunity ?? -1) - (a.row.marketOpportunity ?? -1))
        || ((b.row.coverageGapScore || 0) - (a.row.coverageGapScore || 0)))
      .slice(0, 4)
    for (const { phrase, source, row } of synonymPhrases) {
      const pl = phrase.toLowerCase()
      if (cleanGated.some((k) => k.keyword.toLowerCase() === pl)) continue
      cleanGated.unshift({ ...row, keyword: phrase, selectionRank: undefined })
      console.log('[TITLE_GOLD]', JSON.stringify({ tag: 'SYNONYM_PHRASE', asin: input.children[0]?.asin ?? '?', phrase, source, opp: row.marketOpportunity ?? null }))
    }
  }
  // (Design-NICHE seed moved BELOW designGroupInfo — it must be single-design-gated and grounded
  // against the design vocab, both of which are only known after design resolution.)
  // Only SEARCHABLE keyphrases (e.g. "comfort colors graphic tee") become title-eligible
  // keywords. Specs (garment-dyed, ring-spun cotton, relaxed fit) are NOT search terms and
  // must NOT enter the title — they go to bullets/description/structured fields only.
  // OFF-NICHE CHOKE POINT (2026-07-31, USA-250 trace): this merged `analysis` is the single source
  // every backend/title/bullets pool derives from (backendPool :8869, critLead/critEchoTokens via
  // `remaining`, council briefs, topVolumeBackendPhrases, fill pools) — and it gains THREE post-gate
  // injections the relevance gate at :7454 never saw: synthetic attribute CRITICALs (attributeAsKeyword
  // stamps actionType CRITICAL), secondary design phrases (:7511), identity synonyms (:7535). Filter
  // ONCE here. Context deliberately EXCLUDES children backend_keywords — the stored contaminated string
  // self-rescued its own terms through the context escape (the route nicheCtx bug, fixed alongside).
  const offNicheChokeCtx = `${repTitle ?? ''} ${input.canonicalTitle ?? ''} ${brandName}`
  const analysis = [...attrs.searchKeyphrases.map(attributeAsKeyword), ...cleanGated]
    .filter((k) => !apparelProduct || !isOffNicheKeyword(k.keyword, { context: offNicheChokeCtx }))
  const bulletAttrs = [...attrs.searchKeyphrases, ...attrs.specs]

  // PIN the single highest SEARCH-VOLUME real keyword (not a synthetic attribute, not
  // seasonal — seasonal belongs in backend) so the title agent can never drop the money
  // term. This is what stopped "see you later alligator shirt" (22.7k/mo) from surviving.
  // Seller-declared audience lean (PR #195): re-weight gendered keywords across EVERY pool
  // BEFORE any pool is built. The seller knows the design's audience better than keyword
  // statistics ("Darlin'" reads female even when unisex keywords dominate). lean_* is a soft
  // re-ranking (boost matching gender, demote opposite); hard male/female demotes the
  // opposite gender harder. Sorting-only — nothing is dropped, backend still carries both.
  const lean = (apparelProduct && input.audienceLean) || null
  if (lean && lean !== 'unisex') {
    const FEM_RE = /\bwom[ae]ns?\b|\bladies\b|\bfemale\b|\bgirls?\b/i
    const MASC_RE = /\bm[ae]ns?\b|\bmale\b|\bboys?\b/i   // \b keeps "women" from matching "men"
    const femaleish = lean === 'female' || lean === 'lean_female'
    const boostRe = femaleish ? FEM_RE : MASC_RE
    const demoteRe = femaleish ? MASC_RE : FEM_RE
    const hard = lean === 'male' || lean === 'female'
    for (const k of analysis) {
      if (boostRe.test(k.keyword) && !demoteRe.test(k.keyword)) k.coverageGapScore = (k.coverageGapScore || 0) * 1.2
      else if (demoteRe.test(k.keyword) && !boostRe.test(k.keyword)) k.coverageGapScore = (k.coverageGapScore || 0) * (hard ? 0.5 : 0.8)
    }
  }

  // Design-name anchor (PR #91): the seller's distinctive design/slogan ("Later Gator") that MUST
  // survive into the title verbatim — the agent kept paraphrasing it away.
  // HOISTED 2026-07-23 from just below the compatibility-brand block: `designSeasons` is derived from
  // the design's own theme text and MUST exist before the very first seasonal strip (mustIncludeKw,
  // immediately below). extractDesignName reads only `input` and there is no other `await` between
  // the old and new position, so hoisting it changes no ordering that anything observes.
  const { name: designName, source: designSource } = await extractDesignName(input)

  // ── SEASON POLICY — derived ONCE per regen, threaded everywhere (KEYWORD_TARGET_SET) ───────────
  // Every seasonal strip in this orchestrator (title candidates, mustInclude pin, top-UPGRADE set,
  // compatibility-brand ranking, bullets pool, bullets opportunity plan) reads THIS one object, so
  // they cannot drift the way seven private copies of "covered" did. It sits ABOVE the `only ===
  // 'title'` early return and above the multi-design fan-out, so full regens, per-section regens and
  // per-child fan-outs all strip against the identical occasion set.
  // MULTI-DESIGN = UNION: deriveDesignSeasons folds designNameOverridesByKey (every design's seller
  // name) plus the family vision read, so a Valentine+Christmas parent carries BOTH occasions. Per-
  // GROUP scoping is not applied here because these pools are filtered UPSTREAM of scopeKwsToGroup —
  // the group scoping (foreign design tokens, own-title coverage) then narrows the union per design.
  const designSeasons = deriveDesignSeasons(input, designName)
  const season = makeSeasonPolicy(designSeasons, input.children[0]?.asin ?? null)
  // KEYWORD_TARGET_SET (#143): built ONCE beside the season policy and threaded to every producer.
  // Inert at off/shadow, and inert at `on` when the pool carries no persisted ranks (pre-049 /
  // never rated) — so it can never filter a pool to zero.
  // #174: label with the FAMILY key (parent) — children[0] printed a third ASIN that appears in
  // no pool read or write, which is exactly how the key-split stayed invisible.
  const targets = makeTargetPolicy(analysis, input.parentAsin ?? input.children[0]?.asin ?? null)
  // Spread into every keywordPlan write. EMPTY at off/shadow, so the persisted jsonb is
  // byte-identical and no consumer sees a new key until the flag is on.
  const selectedKws = targets.live ? targets.keep(analysis).map((k) => k.keyword) : []
  const selectedPlanFields = targets.live
    ? { selected: selectedKws, selectionSha: selectionSha(selectedKws) }
    : {}

  // THE TITLE PIN. This is the single highest-value filter in the PR: the sort key is RAW
  // searchVolume, so on a Valentine/Cupid tee it welds "summer tops for women" (821,120/mo) into the
  // title as an UN-DROPPABLE pin that every downstream gate must then work around.
  //
  // PO-LOCKED 2026-07-23: CORE-slot ONLY. Not merely "a target" — a CATEGORY-slot target is
  // universal garment revenue ("graphic tees for women"), legitimate in the title but wrong as the
  // one mandatory anchor; and a BACKEND-slot target is an off-season holiday the copy must never
  // contain, so pinning one would create a dock no regenerate can clear.
  const pinPool = targets.core(cleanGated)
  const pinFrom = pinPool.length > 0 ? pinPool
    // FAIL-OPEN, and deliberately NOT to raw cleanGated[0]: if the design has no CORE target we fall
    // back to any target, and only then to the legacy pool. Dropping straight to cleanGated would
    // reinstate the exact volume-sorted pin this filter exists to remove.
    : (targets.live ? (targets.keep(cleanGated).length > 0 ? targets.keep(cleanGated) : cleanGated) : cleanGated)
  if (targets.live && pinPool.length === 0) {
    console.log(`[KW_TARGET_PIN_FALLBACK] pool=${input.parentAsin ?? input.children[0]?.asin ?? '?'} no CORE-slot target; pinning from ${targets.keep(cleanGated).length > 0 ? 'any-target' : 'legacy'} pool`)
  }
  // MARKET TRUTH ON THE PIN (PO ruling 2026-08-09, SELLER_PROFILE §5: "VOLUME is not the biggest
  // thing we look at but the JS opportunity and ranking ability with the right volume"). Raw volume
  // picked `usa soccer jersey` (1.98M/mo) for a niche 2026 tee — real demand, unwinnable. Rank by
  // market_opportunity (demand × winnability) FIRST; volume may only break ties BETWEEN scored rows.
  // A pool with no market data still pins (stripping the pin catalog-wide is a bigger change than the
  // ruling asks) but it can never do so SILENTLY — the log names the gap and the seller-facing
  // marketDataHealth banner says the same thing on the listing.
  const pinCandidates = pinFrom
    .filter((k) => ['CRITICAL', 'UPGRADE', 'DEFENDED', 'REINFORCE'].includes(k.actionType))
    .filter((k) => !season.isOffSeason(k.keyword))
    .filter((k) => k.keyword.split(/\s+/).length <= 6)
  const pinScored = pinCandidates.filter((k) => carriesMarketOpportunity(k))
  if (pinCandidates.length > 0 && pinScored.length === 0) {
    console.warn(JSON.stringify({ tag: 'TITLE_PIN_NO_MARKET_DATA', parent: input.parentAsin ?? null,
      pool: input.parentAsin ?? input.children[0]?.asin ?? null, candidates: pinCandidates.length,
      note: 'no candidate carries market_opportunity — pin fell back to volume order; re-research to score the pool' }))
  }
  const mustIncludeKw = (pinScored.length > 0 ? pinScored : pinCandidates)
    .sort((a, b) => (pinScored.length > 0
      ? (b.marketOpportunity ?? 0) - (a.marketOpportunity ?? 0)
      : 0) || (b.searchVolume || 0) - (a.searchVolume || 0) || (b.coverageGapScore || 0) - (a.coverageGapScore || 0))[0]
  season.diff('title-must-include', cleanGated.map((k) => k.keyword))
  const mustInclude = mustIncludeKw?.keyword

  // Determine the product's true audience from the existing listing + specs, so the title
  // never silently narrows a unisex product to one gender (the "for Men" regression).
  // Apparel only — a memory card, mug, or mount has no gendered audience; forcing "for Men"
  // on an SD card is exactly the non-apparel mess this guards against (apparelProduct computed above).
  const audienceText = `${repTitle ?? ''} ${attrs.specs.join(' ')} ${cleanGated.map((k) => k.keyword).join(' ')}`.toLowerCase()
  const mentionsWomen = /\bwom[ae]n\b|womens|ladies|female/.test(audienceText)
  const mentionsMen = /\bm[ae]n\b|mens|male/.test(audienceText)
  // Seller-declared lean OVERRIDES the keyword-derived audience: hard male/female narrows
  // the title tail outright (their explicit choice); lean_*/unisex keeps the broad tail
  // (lean already re-weighted the pools above).
  // GENDER LEAN (PO 2026-07-21, flag-gated): a seller who set "Lean Male"/"Lean Female" wants the
  // title to READ male/female — the hat shipped "for Men and Women" despite a Lean-Male setting
  // because lean_male fell into the broad `lean ? 'Men and Women'` branch. When GARMENT_NOUN=on, a
  // SOFT lean also narrows the tail (lean_male → 'Men'); only explicit 'unisex' stays dual. Flag OFF
  // → the exact prior behavior (soft lean keeps 'Men and Women'). Hard male/female already narrowed.
  const preferredAudience = !apparelProduct ? ''
    : lean === 'male' ? 'Men'
    : lean === 'female' ? 'Women'
    : (GARMENT_NOUN_ON && lean === 'lean_male') ? 'Men'
    : (GARMENT_NOUN_ON && lean === 'lean_female') ? 'Women'
    : lean ? 'Men and Women'
    : /\bunisex\b/.test(audienceText) || (mentionsWomen && mentionsMen) ? 'Men and Women'
    : mentionsWomen ? 'Women'
    : mentionsMen ? 'Men'
    : ''

  // SECOND pin: the blank/garment brand (e.g. "comfort colors") — a strategic attribute the
  // seller ranks for. Now that the #1 money keyword is guaranteed, this can be re-elevated
  // into the title without crowding it out. Derived from the top searchKeyphrase with the
  // product-type word stripped ("comfort colors shirt" -> "comfort colors").
  let attributePin = ''
  if (apparelProduct) {
    attributePin = (attrs.searchKeyphrases[0] || '')
      .replace(/\b(graphic\s+tee|t[-\s]?shirts?|tees?|shirts?|graphic|tops?)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
  }
  // Drop it if empty or already fully covered by the #1 pin (avoids a redundant constraint).
  if (attributePin && mustInclude) {
    const miWords = new Set(mustInclude.toLowerCase().split(/\s+/))
    if (attributePin.toLowerCase().split(/\s+/).every((w) => miWords.has(w))) attributePin = ''
  }
  const attributePinFinal = attributePin || undefined

  // Stage 0b — candidates (code). Outcome-loop signals (#89) are a conservative tiebreak only (no-op until history exists).
  // Multi-variant apparel family → broadcast title/bullets must stay color-neutral (see
  // BASIC_COLOR_RE). The JS research child happened to be one color and dragged it into the
  // pool — live failure: "Black T Shirts" recommended as the shared title for 82 colors.
  const colorNeutralFamily = apparelProduct && input.children.length > 1
  // OFF-NICHE gate on the TITLE candidate pool (2026-07-15, B0H7L6KNNX: "Balon De Futbol" reached the
  // title). The scorer/rank/generator skip off-niche keywords, but the title's candidate pool was NEVER
  // filtered — so a foreign / equipment / wrong-niche term in the pool could be woven into the title by
  // the council OR the fill. Filter ONCE here, the single upstream point both consumers read, with the
  // SAME predicate. Apparel-gated + own-brand/activewear aware via the listing's own copy as context.
  const titleNicheCtx = [repTitle, brandName, ...(input.children || []).map((c) => c.title)].filter(Boolean).join(' ')
  // `tees?` added 2026-07-31 (USA-250 trace): a listing whose copy says only "Tee" skipped this
  // probe entirely, disabling the seed-extras off-niche gate on exactly the tee-heavy catalog.
  const titleIsApparel = /\b(?:t-?shirts?|tshirts?|shirts?|tees?|hoodies?|sweatshirts?|apparel)\b/i.test(titleNicheCtx)
  const notOffNiche = (kw: string) => !titleIsApparel || !isOffNicheKeyword(kw, { context: titleNicheCtx })
  const candidates = selectTitleCandidates(analysis, brandName, repTitle, season, input.outcomeSignals, targets)
    .filter((c) => !colorNeutralFamily || !BASIC_COLOR_RE.test(c.keyword))
    .filter((c) => notOffNiche(c.keyword))

  // ── TITLE_MONEY_TAIL (#147 title half) — ONE money keyword for the PO gold pipe tail ──────────
  // The locked gold shape is `Brand + design + noun | <category money keyword>` (B0FKKN8XKV:
  // "THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women"). Six stacked
  // leaks kept that tail from shipping — the :7815 4-word pin drop, the advisory apparel mustLine,
  // the design-grounding strip (:3137 — category demand is definitionally NOT design vocabulary),
  // the coverageGap sort burial, Pattern A's fact-only pipe-right, and the facts-only terminal
  // pads. So the slot's CANDIDATES are derived HERE, deterministically, and enforced by
  // enforceMoneyTail in bandTitle — never by prompts. Deliberately sorted marketOpportunity DESC
  // (native market data, migration 055) then searchVolume DESC and NOT gap-sorted: gap-sorting is
  // the exact burial this cures — "already covered elsewhere" must not demote the keyword whose
  // title PRESENCE is the point. Fail-open at every step: no qualifying keyword ⇒ [] ⇒
  // byte-identical titles.
  // TOP-5 CANDIDATE LIST, not [0] (adversarial MEDIUM, 2026-08-09): enforceMoneyTail has its own
  // per-keyword vetoes (word-repeat, spec-conflict, no-fit, cross-gender vs the TITLE tail) the
  // derivation cannot see — a single-candidate hand-off burned the whole feature on the first
  // net-side skip although candidate #2 would have applied. bandTitle tries each in order and
  // stops at the first 'applied' OR 'already-covered' (the top candidate already indexing from the
  // title = the slot is genuinely satisfied — never install a lower-value keyword past it).
  // DEFENDED/REINFORCE stay in the pool DELIBERATELY: actionType was rated against the STORED
  // content, so a fresh title may have dropped a DEFENDED keyword — and with the candidate list a
  // still-covered one costs nothing (already-covered = satisfied, by design, not a burn).
  // off → inert; shadow → derive + [MONEY_TAIL_DIFF] the would-be title, ship unchanged; on → ship.
  // Phase 1 = BROADCAST title only (per_child_titles get null; group-scoped derivation via
  // scopeKwsToGroup is Phase 2). Env read at call time, per the selection-core lesson (:35).
  const moneyTailMode = (process.env.TITLE_MONEY_TAIL || 'off').toLowerCase()
  let titleMoneyKws: string[] = []
  if (moneyTailMode !== 'off' && apparelProduct && targets.live) {
    const MT_GARMENT_RE = /\b(?:t-?shirts?|tshirts?|shirts?|tees?)\b/i
    const MT_FEM = /\bwom[ae]ns?\b|\bladies\b/i, MT_MASC = /\bm[ae]ns?\b/i // :6011-6012 twins
    const mtCandidates = targets.keep(analysis)
      // BACKEND-slot targets are backend-only by definition (off-season holidays etc. — the same
      // reason the :7534 pin draws from targets.core and :8500/:9570 exclude the slot). A BACKEND
      // keyword welded into the visible title would be a dock no regenerate could clear.
      .filter((k) => k.selectionSlot !== 'BACKEND')
      .filter((k) => ['CRITICAL', 'UPGRADE', 'DEFENDED', 'REINFORCE'].includes(k.actionType))
      .filter((k) => !season.isOffSeason(k.keyword))
      .filter((k) => notOffNiche(k.keyword))
      .filter((k) => !colorNeutralFamily || !BASIC_COLOR_RE.test(k.keyword)) // color-neutral broadcast
      .filter((k) => { const n = k.keyword.trim().split(/\s+/).length; return n >= 3 && n <= 5 })
      .filter((k) => MT_GARMENT_RE.test(k.keyword))                          // must carry a garment noun
      // SOFT leans veto here too (adversarial MEDIUM, 2026-08-09): enforceMoneyTail vetoes
      // lean_female/lean_male as well, so a derivation that only filtered hard leans handed the
      // net candidates it would deterministically refuse. Mirror the net's own rule — knowable
      // at derivation time, so the slot is never wasted on a guaranteed cross-gender skip.
      .filter((k) => !((lean === 'female' || lean === 'lean_female') && MT_MASC.test(k.keyword) && !MT_FEM.test(k.keyword)))  // :6031-6034
      .filter((k) => !((lean === 'male' || lean === 'lean_male') && MT_FEM.test(k.keyword) && !MT_MASC.test(k.keyword)))
      .map((k) => ({ k, safe: scrubTrademarks(k.keyword) }))
      .filter((e) => e.safe.trim().length > 0)                               // a fully-scrubbed kw is no candidate
      .filter((e) => findTrademarkPhrases(e.safe).length === 0)              // tmSafeKw twin (:3151)
      // CELEBRITY GATE (adversarial HIGH, 2026-08-09): the derivation had a trademark gate but no
      // celebrity gate — on the exact target ASIN (B0FKKN8XKV) "forrest frank shirt" carries real
      // search demand, passes every structural filter, and would be welded into the VISIBLE title
      // only for the push-boundary scrub to mangle it later. Same seam class as trademarks.
      .filter((e) => !hasCelebrityName(e.safe))

    // ── NO SILENT VOLUME-ONLY FALLBACK (PO RULING, verbatim 2026-08-09) ────────────────────────
    // "VOLUME is not the biggest thing we look at but the JS opportunity and ranking ability with
    // the right volume." The old comparator here was `(mo ?? -1) DESC || searchVolume DESC`, which
    // reads as market-first but DEGRADES SILENTLY: when no candidate carries market_opportunity
    // every key is -1, the first term is a constant 0, and the whole slot is decided by RAW VOLUME
    // — the single highest-volume head phrase welded into the visible title with no winnability
    // signal behind it. Historical proof (B0GVV3XL4T, probed 2026-08-09): 88 stored rows, ZERO with
    // market_opportunity, research 46 days stale, and the pool's volume leaders were unwinnable
    // heads for a niche 2026 tee ("usa soccer jersey" 1.98M/mo).
    //   ⚠ THAT PROBE IS OBSOLETE — DO NOT CITE IT AS CURRENT STATE. Re-measured 2026-08-11 by the
    //   seller: the SAME parent now returns 159 rows with 159 scored (analyzed 15:17Z). The 2026-08-09
    //   numbers survive only as the WORKED EXAMPLE of the degradation this comparator prevents.
    //   Between those two dates the stale figure was quoted as live fact by three separate analyses
    //   and produced a wrong conclusion each time ("the money tail can never fire on this ASIN").
    //   A dated observation in a comment is evidence of a MOMENT, never of the present: re-probe the
    //   pool before reasoning from it.
    // rankByMarketOpportunity is the shared rule: it DROPS unscored rows, so volume can only ever
    // break a tie BETWEEN two market-scored rows, and it returns [] when nothing is scored. Empty
    // ⇒ enforceMoneyTail installs nothing ⇒ the title stays BYTE-IDENTICAL and honest, which is the
    // correct outcome: no money tail beats a confidently-wrong one. Loud, structured, and greppable
    // so the degradation is never invisible again.
    /* BAND BEFORE MARKET (PO 2026-08-09 gold + PO 2026-08-10 "a design's own subject terms are band 3
     * / CORE by definition"). THE DEAD WIRE THIS CLOSES: `themeFit` is on AnalyzedKeyword
     * (engine.ts:155) and cacheService maps it onto every row getStoredAnalysis returns (:391) — yet
     * before this line it was referenced ZERO times in all of listingPipeline.ts. The rater decides
     * which keywords ARE this design's subject and the generator writing the title never asked, so
     * the money slot went to whatever scored best on market opportunity alone. Live on B0GVV3XL4T
     * that produced `... | Graphic T Shirts` — a generic band-2 category head — while the very same
     * pool's ranks 1-3 were band-3 world-cup terms. The PO's gold for that design is
     * `... | USA Mexico Canada Football Tee`: the DESIGN's own subject in the money position.
     *
     * PREFERENCE ORDER, NOT A FILTER. Take the best band that has any candidate, then run the
     * EXISTING market ranking within it — so §5's "volume is never the decider" and the
     * no-silent-volume-fallback rule below are untouched; this only chooses WHICH POOL that ranking
     * runs over. A design with no band-3 supply still gets its best market-scored tail.
     *
     * FAIL-OPEN BY CONSTRUCTION: on an unrated pool every row has themeFit == null, so `mtBanded` is
     * empty and this collapses to the previous behaviour byte-for-byte. Unrated is a real live state
     * (KEYWORD_TARGET_SET off/shadow, or research older than the rater) and must not lose its tail. */
    const mtBandOf = (e: { k: { themeFit?: 0 | 1 | 2 | 3 | null } }): number =>
      (typeof e.k.themeFit === 'number' ? e.k.themeFit : -1)
    const mtTopBand = Math.max(-1, ...mtCandidates.map(mtBandOf))
    const mtBanded = mtTopBand >= 0 ? mtCandidates.filter((e) => mtBandOf(e) === mtTopBand) : []
    if (mtBanded.length > 0 && mtBanded.length < mtCandidates.length) {
      console.log('[TITLE_GOLD]', JSON.stringify({ tag: 'MONEY_TAIL_BAND', asin: input.children[0]?.asin ?? '?',
        topBand: mtTopBand, inBand: mtBanded.length, ofCandidates: mtCandidates.length,
        note: 'money tail restricted to the design\'s highest theme band before market ordering' }))
    }
    /* FALL BACK WHEN THE BAND SUBSET IS UNSCORED (regression I shipped in c3f6043, caught live the
     * same day on B0GVV3XL4T). `rankByMarketOpportunity` DROPS every row that carries no
     * market_opportunity (marketDataHealth.ts:154). Narrowing to the top band BEFORE that filter can
     * therefore hand it a set it empties completely — and an empty `mtRanked` means titleMoneyKws is
     * [] and NO money tail is installed at all. Observed: the 15:20 run (pre-c3f6043) shipped
     * `... | Graphic T Shirts`; the 19:02 run (post-c3f6043) shipped `... | Crew Neck`, a BLANK_SPECS
     * neck value the band-pad inserted into the pipe-right the vanished tail left empty.
     *
     * So: rank the banded subset first, and fall back to the FULL candidate set when that yields
     * nothing scored. The band is a PREFERENCE — it must never be able to cost the listing its tail.
     * This is the same narrow-then-filter shape (a subset taken immediately before a predicate that
     * can empty it, with no fallback) that this codebase keeps being bitten by; it deserved the
     * fallback on the first commit and did not get one. */
    const mtRankedBanded = mtBanded.length > 0 ? rankByMarketOpportunity(mtBanded, (e) => e.k) : []
    if (mtBanded.length > 0 && mtRankedBanded.length === 0) {
      console.log('[TITLE_GOLD]', JSON.stringify({ tag: 'MONEY_TAIL_BAND_UNSCORED', asin: input.children[0]?.asin ?? '?',
        topBand: mtTopBand, inBand: mtBanded.length,
        note: 'top-band candidates carry no market_opportunity — falling back to the full candidate set so the tail is not lost' }))
    }
    const mtRanked = mtRankedBanded.length > 0 ? mtRankedBanded : rankByMarketOpportunity(mtCandidates, (e) => e.k)
    if (mtCandidates.length > 0 && mtRanked.length === 0) {
      console.log('[MONEY_TAIL_NO_MARKET_DATA]', JSON.stringify({
        tag: 'MONEY_TAIL_NO_MARKET_DATA',
        parent: input.parentAsin ?? null,
        asin: input.children[0]?.asin ?? null,
        poolRows: analysis.length,
        withMo: 0,                                                    // scored CANDIDATES — 0 by construction on this branch
        poolWithMarketOpportunity: analysis.filter((k) => carriesMarketOpportunity(k)).length,
        candidates: mtCandidates.length,                              // how many we REFUSED rather than pick on volume
        researchedAt: input.researchedAt ?? null,
      }))
    }
    titleMoneyKws = [...new Set(mtRanked.map((e) => e.safe))].slice(0, 5)
    if (titleMoneyKws.length > 0) {
      console.log('[TITLE_GOLD]', JSON.stringify({ tag: 'MONEY_KW', mode: moneyTailMode, asin: input.children[0]?.asin ?? '?', kws: titleMoneyKws }))
    }
  }

  // Stage 0c — top UPGRADE keywords for explicit title-coverage. UPGRADE = ranking
  // signal already present in bullets but absent from the title. The scorer in
  // syncListingContent.ts docks 5 points when 7+ of these are missing (3 when 3-6
  // miss). We feed them to the title agent as MANDATORY #3 and fail validation when
  // 3+ still aren't in the title, so the existing retry loop is on the hook for
  // covering them — not the seller.
  season.diff('title-upgrade-set', cleanGated.filter((k) => k.actionType === 'UPGRADE').map((k) => k.keyword))
  const topUpgradeKws = cleanGated
    .filter((k) => k.actionType === 'UPGRADE')
    .filter((k) => !season.isOffSeason(k.keyword))
    .filter((k) => notOffNiche(k.keyword))                                  // off-niche can't reach the title
    .filter((k) => !colorNeutralFamily || !BASIC_COLOR_RE.test(k.keyword))  // color-neutral broadcast title
    .filter((k) => k.keyword.split(/\s+/).length <= 6)  // skip long-tail phrases that wouldn't fit
    .sort((a, b) => (b.coverageGapScore || 0) - (a.coverageGapScore || 0))
    .slice(0, 10)                                        // matches the scorer's top-10 cap
    .map((k) => k.keyword)

  // COMPATIBILITY-BRAND opportunities (PR #86). Keywords whose tokens include a known
  // device brand (Canon/Sony/Nikon/GoPro/Kodak/…) are high-IQ compatibility plays the
  // product genuinely works with. Live B0GCF11RKL: 'sd card for canon camera' (CRITICAL,
  // nowhere), 'sd card for sony camera', 'fz55 sd card', etc. — all sitting unused.
  // Extract the distinct brands, opportunity-sorted, so the agents can weave them in as
  // 'Compatible with [Brand]'. NON-apparel only — an alligator tee has no device
  // compatibility (apparel brand mentions are piggyback, handled by the judge/removal).
  const compatibilityBrands: string[] = []
  if (!apparelProduct) {
    const seen = new Set<string>()
    const ownB = ownBrandTokenSet(brandName)
    // Read from RAW input.analysis, NOT cleanGated — the relevance gate
    // (filterRelevantKeywords) strips "competitor brands/trademarks" upstream, so by the
    // time we reach cleanGated the very device brands we want to chase are gone. The raw
    // pool still has 'sd card for canon camera', 'sd card for sony camera', etc. (Live-
    // verified: first #86 deploy surfaced ZERO brands because it read cleanGated.)
    const ranked = [...input.analysis]
      .filter((k) => !season.isOffSeason(k.keyword))
      .sort((a, b) => (b.coverageGapScore || 0) - (a.coverageGapScore || 0))
    for (const k of ranked) {
      for (const brand of findThirdPartyBrands(k.keyword, ownB)) {
        // Title-case the brand for display ("canon" → "Canon", multi-word kept lower→Title).
        const display = brand.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        if (!seen.has(display)) { seen.add(display); compatibilityBrands.push(display) }
      }
      if (compatibilityBrands.length >= 6) break
    }
  }

  // (Design-name anchor — extractDesignName — was HOISTED above the first seasonal strip; see the
  // SEASON POLICY block. `designName` / `designSource` are already in scope here.)

  // Phase 1 multi-design detection (DEBUG-only here — Commit 1). When the family carries ≥2 distinct
  // designs (SKU-prefix groups), the next commit branches title generation per design + per-design
  // vision; the parent keeps a general title. For now we only OBSERVE it (no behavior change) so the
  // detection can be verified live before the per-design title build engages.
  const autoDetected = apparelProduct ? detectDesignGroups(input.children) : { isMultiDesign: false, groups: [] }
  const designGroupInfo = input.isMultiDesignOverride === true
    ? { ...autoDetected, isMultiDesign: true }
    : input.isMultiDesignOverride === false
      ? { ...autoDetected, isMultiDesign: false }
      : autoDetected
  // PRESSURE-TEST FINDING #9: scorer (syncListingContent.scoreListingContent) docks bullet score
  // when keyword_plan.designName is present but missing from a child's bullets. For multi-design,
  // there is NO SINGLE family design name — each design has its own (in per_child_titles). Setting
  // effectiveDesignName='' for multi-design prevents the false-negative bullet cohesion dock.
  // Declared HERE (before partialResult) so partialResult's closure captures it.
  const effectiveDesignName: string = apparelProduct && designGroupInfo.isMultiDesign ? '' : designName

  // ── GROUND-TRUTH BLANK SPEC (hoisted 2026-07-10) ──────────────────────────────────────────────
  // Was computed near the features stage, AFTER every partial-regen early-return — so the fit truth
  // gate could not run on a bullets/description-only regen. It depends on nothing but attributes
  // available here. Comfort Colors sweatshirts fall back to the guess rather than getting
  // "Short Sleeve" force-pushed on (no regression on non-tees).
  const garmentHay = [attributePinFinal, input.canonicalTitle, repTitle, input.productType].filter(Boolean).join(' ')
  /* looksShirt (2026-08-07, the Later-Gator unisex miss): the old `looksTee` gate demanded a
   * tee/tshirt token AND rejected any "long sleeve" — so a LONG SLEEVE SHIRT family (CC 6014,
   * title says just "Shirt") got blankSpec=NULL and lost EVERY spec fact (brand casing, fit,
   * unisex…). A long-sleeve shirt is still a shirt; the gate's real job is only to keep true
   * non-shirt classes (sweatshirt/hoodie/fleece/pullover) from inheriting shirt-blank facts. */
  const isLongSleeve = /long[\s-]?sleeve/i.test(garmentHay)
  const looksShirt = /\bt?[\s-]?shirts?\b|\btees?\b/i.test(garmentHay) && !/sweat|hoodie|fleece|pullover/i.test(garmentHay)
  // SKUs join the hay (2026-07-31): print-on-demand copy often never names the blank ("Gildan"
  // appears nowhere on the We Still Do listing) but the SKUs embed the style number ("640002XL-…").
  const skuHay = (input.children ?? []).map((c) => c.sku).filter(Boolean).join(' ')
  // ROW kept (2026-08-08): the blank-brand IH waterfall net needs the match REGEX too; the spec is
  // derived from it so every downstream `blankSpec.*` consumer is byte-identical.
  const blankSpecRowMatched = apparelProduct && looksShirt ? matchBlankSpecRow(await loadBlankSpecRows(), attributePinFinal, input.canonicalTitle, repTitle, input.productType, skuHay) : null
  const blankSpecMatched = blankSpecRowMatched?.spec ?? null
  // A long-sleeve family must not inherit a short-sleeve blank row's sleeve fact (the CC row is
  // the 1717/short-sleeve spec until the PO adds a 6014 row) — drop the contradicted fact, keep the rest.
  const blankSpec = blankSpecMatched && isLongSleeve && /short/i.test(blankSpecMatched.sleeve ?? '')
    ? { ...blankSpecMatched, sleeve: undefined }
    : blankSpecMatched
  // Shopper-facing garment brand, in AUTHORITATIVE casing — from BLANK_SPECS ONLY. Empty when the blank
  // is unknown: attributePin is a lowercase SEARCH phrase ("vintage cat shirt"), NOT a confirmed brand, so
  // title-casing it as one would force "Vintage Cat" into copy on the print-on-demand majority — the exact
  // spec-vs-search error this fix condemns. An off-list blank earns a brand mention by being ADDED here.
  // brandInCopy:false (PO veto, 2026-07-31): the blank's FACTS still decorate copy, but its NAME is
  // not a selling point (Gildan ≠ Comfort Colors) — an empty canonical brand keeps it out of every
  // copy surface while the competitor-blank drop for the token stays active (we don't index it either).
  const garmentBrandCanonical = blankSpec?.brandInCopy === false ? '' : (blankSpec?.brand ?? '')
  /* SHIP_BAND_NET (#147) — the FACTS the title band net may pad with. Product attributes only:
   * BLANK_SPECS values and a distinct garment surface form. NEVER a search-pool term, because a
   * title is a product claim (spec-grounding beats coverage). A missing fact contributes NO segment,
   * so a short-sleeve blank can never be padded with "Long Sleeve". */
  const bandGarment = garmentFor(input.productType, repTitle)
  const titleBandCtx = (title: string): TitleBandCtx => ({
    apparel: apparelProduct,
    customizable: input.customizable === true,
    garmentBrand: garmentBrandCanonical || null,
    spec: blankSpec ? { fit: blankSpec.fit ? `${blankSpec.fit} Fit` : null, sleeve: blankSpec.sleeve, neck: blankSpec.neck } : null,
    // Delegated to the TESTED leaf. This was six inline lines here and shipped two invisible escaping
    // bugs: a word-boundary escape one backslash short inside a template literal (it compiled to the
    // BACKSPACE control character, so the match ALWAYS failed), plus a literal backspace byte in a
    // .replace regex that git diff renders invisibly. The filter was dead code -- green CI, green tsc,
    // 15 green tests, and the net did NOTHING on the very 66-char case it was written for. An inline
    // regex in a 9,400-line file is unreviewable; the leaf is unit-tested against real alias lists.
    garmentSecond: pickDistinctGarmentForm(title, bandGarment.aliases),
  })

  // Description SUBSTANCE = REAL product facts (blank spec + extracted specs), NEVER search keyphrases.
  // The description is a PROSE field; opportunity/search terms live in BACKEND (Content-step-2). Feeding
  // demand queries here ("comfort colors shirt", "graphic tees for women") as "attributes" is what made
  // the council stuff them into copy — the generator then only reached 900-980 by stuffing, and the audit
  // stripped it back to ~776. Grounding in concrete facts (fabric/weight/dye/fit/neck/sleeve) fills the
  // length with substance the audit keeps.
  // Assert DETAILED specs ("6.1 oz garment-dyed", "100% ring-spun cotton") in customer PROSE only when the
  // blank is HIGH-CONFIDENCE — its brand appears in the REAL product title, not merely in the search-derived
  // attributePin. lookupBlankSpec matches loosely (a listing that just mentions "comfort colors" in its
  // keyword pool would otherwise get "6.1 oz garment-dyed" asserted as fact). Low-confidence: name the brand
  // only, claim no specs (spec-vs-search grounding). `dye` is omitted — weightNote already carries it.
  const brandRe = blankSpec?.brand
    ? new RegExp(`\\b${blankSpec.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    : null
  const brandInTitle = !!(brandRe && brandRe.test(`${input.canonicalTitle ?? ''} ${repTitle ?? ''}`))
  const blankFacts: string[] = blankSpec
    ? (brandInTitle
        ? [blankSpec.brand, blankSpec.material, blankSpec.weightNote,
           blankSpec.fit ? `${blankSpec.fit} fit` : '', blankSpec.neck, blankSpec.sleeve]
        : [blankSpec.brand]
      ).map((s) => (s ?? '').trim()).filter(Boolean)
    : []
  const descAttrs = dedupeFacts([...blankFacts, ...attrs.specs])

  // Design-NICHE seed (council 2026-07-03, review-hardened). The keyword research is self-referential
  // (a niche design gets a generic pool), and the title's design-grounding filter then strips it to a
  // stub. Expand the design into niche keyphrases and GROUND them against the pre-existing design vocab
  // so an LLM hallucination ("wine lover shirt" for a book design) can't self-ground and stuff the
  // title. SINGLE-DESIGN + TITLE-section only (review: parent seeds would ground every design group; a
  // partial regen never consumes them). Seeds go ONLY to input.nicheSeeds (title groundVocab + brief),
  // never the shared bullet/scorer pool. Best-effort — any failure leaves the title unchanged.
  if (apparelProduct && !designGroupInfo.isMultiDesign && (!input.onlySection || input.onlySection === 'title')) {
    const nicheAnchor = ((input.canonicalTitle ?? repTitle ?? '').split(/\s*[–—|·:]\s*|\s+-\s+/)[0] || '').trim()
    if (nicheAnchor || input.visionDesign) {
      const anchor = [designName || nicheAnchor, ...secondaryPhrases].filter(Boolean).join(' | ')
      const raw = await expandDesignNiche(input.openai, designName || nicheAnchor, secondaryPhrases, input.visionDesign, input.productType ?? null)
      // SAFETY FLOOR — a seed sharing a DISTINCTIVE (non-generic) token with the design identity is
      // literally grounded and always safe ("book lover shirt" ← "book"). NICHE_FREE = the generic
      // words the title grounding filter also ignores.
      const NICHE_FREE = new Set(['cool', 'funny', 'cute', 'awesome', 'best', 'great', 'perfect', 'novelty', 'graphic', 'gift', 'lover', 'fan', 'apparel', 'clothing', 'outfit', 'wear', 'design', 'tee', 'shirt', 'tshirt', 'sweatshirt', 'hoodie', 'tank', 'top', 'women', 'men'])
      const distinctToks = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).map((w) => w.replace(/s$/, '')).filter((w) => w.length > 1 && !MINOR_WORDS.has(w) && !NICHE_FREE.has(w))
      const designVocab = new Set<string>()
      for (const src of [designName, nicheAnchor, ...secondaryPhrases, input.visionDesign?.designTheme ?? '', ...(input.visionDesign?.visualElements ?? [])]) for (const t of distinctToks(src)) designVocab.add(t)
      const overlapOk = raw.filter((s) => distinctToks(s).some((t) => designVocab.has(t)))
      // Independent judge admits the on-theme EXPANSION terms overlap can't ("reading gift"/"bookworm
      // tee" for a book design) while rejecting a hallucinated pivot. A non-overlap term ships ONLY if
      // the judge verifies it; on judge failure we keep just the overlap floor (never an unverified term).
      const judged = await judgeNicheRelevance(input.openai, anchor, raw)
      const extra = (judged ?? []).filter((s) => !overlapOk.includes(s))
      const grounded = [...new Set([...overlapOk, ...extra])].slice(0, 8)
      // LEAD the fill with the design's OWN secondary phrases (subtitle-split, trademark-gated — the
      // highest-signal, literally-grounded wording). They already sit in the keyword pool at the low
      // attributeAsKeyword score (35, line ~4433) so the council leaves them OUT of the title — that's
      // exactly the "Too Many Books" the PO wanted, absent from the 47-char stub. The deterministic
      // fill below is the path that actually seats them into spare title budget; LLM niche expansions
      // follow as secondary candidates. Deduped; the fill's novelty + 2x + 75 guards bound the result.
      const fillSeeds = [...new Set([...secondaryPhrases, ...grounded])]
      if (fillSeeds.length) { input.nicheSeeds = fillSeeds; onProgress(`Seeded ${fillSeeds.length} design-niche keyword(s).`) }
    }
  }

  // Audience-relational compound seed injection (2026-07-23 Fix C; FIX_C_NICHE_POOL flag retired
  // 2026-08-03 at live 'on'). Fires ONLY when deriveAudienceRelationalCompounds detects a real
  // signal (spouse-gender hint + wearer lean set + no relational carrier already in designName).
  // Deterministic; no LLM. Compounds get added to input.nicheSeeds AFTER the standard fillSeeds
  // assignment above so they flow through the same downstream path (groundVocab, brief, humanizer
  // pool, fill pool). Persona 2's compound-niche-first precedence (V3.1a) leads with them; if the
  // design has no compound signal, the helper returns [] and this is a no-op.
  {
    const compounds = deriveAudienceRelationalCompounds(designName, apparelProduct ? (input.audienceLean ?? null) : null, input.productType ?? null)
    if (compounds.length > 0) {
      input.nicheSeeds = [...new Set([...(input.nicheSeeds ?? []), ...compounds])]
      onProgress(`Fix C: injected ${compounds.length} audience-relational compound(s).`)
      console.log(`[FIX_C_SEEDS] lean=${input.audienceLean ?? 'none'} designName="${designName}" compounds=${JSON.stringify(compounds)}`)
    }
  }

  // Apparel with a clear DESIGN NAME: the design name anchors the title, so do NOT also FORCE a long
  // slogan keyword (e.g. "see you later alligator shirt") into it. Forcing both jams the same design
  // in twice and makes the title read like keyword soup — the exact "Later Gator See You Later
  // Alligator" clutter the PO rejected. The forced pin was overriding the designLine's "don't
  // paraphrase the slogan" rule; dropping it lets the title stay clean + concise. The slogan still
  // ranks via the bullets + backend pool. Short money keywords (<=3 words) are still pinned.
  const titleMustInclude = (apparelProduct && designName && mustInclude && mustInclude.split(/\s+/).length >= 4)
    ? undefined
    // A color-bearing pin would FORCE the color into the shared title — same leak, stronger.
    : (colorNeutralFamily && mustInclude && BASIC_COLOR_RE.test(mustInclude) ? undefined : mustInclude)

  // #79 per-section regen plumbing: a partial run executes ONE stage against the stored
  // priors and returns immediately — the route merges the field into the persisted row.
  const only = input.onlySection
  // TRADEMARK SCRUB (PO 2026-06-15): no PUBLISHED field may carry a protected mark — "World Cup" is
  // FIFA's registered trademark, scrubbed to the seller's safe "World Soccer Cup". Applied at BOTH
  // result chokepoints (partialResult + the full return below) so no exit path can publish an
  // infringing mark, even one pulled from the keyword pool. Pool/Intelligence data is left as-is —
  // only text that gets WRITTEN to Amazon is scrubbed. (Scope A; per-seller list is a scope-C follow-on.)
  /* THE band-net door. `titleProduced` is REQUIRED discipline, not politeness: `partialResult`
   * passes `input.priorTitle` straight through for a bullets/keywords/description-only regen, so an
   * ungated net would silently rewrite a title the seller never asked to touch — and the UI would
   * then offer it for push. Only a run that actually PRODUCED a title may band-enforce it. */
  /* `moneyKws` (TITLE_MONEY_TAIL, #147): the derived category money-keyword CANDIDATES for the PO
   * gold pipe tail (top 5, opportunity-sorted) — non-empty ONLY on the broadcast call and only when
   * the flag is shadow/on. Per-child titles pass the default null in Phase 1 (group-scoped
   * derivation is Phase 2), so the net is SHARED across both exits (path parity) while the input is
   * phased. Manual locks are untouchable by construction: a non-title partial passes produced=false
   * (priorTitle passthrough), and a locked full regen has its fresh title discarded at persist by
   * the route's lock guard. */
  /* `protectDesign` (DEFECT B, 2026-08-09): every design phrase in scope for THIS title, space-joined.
   * The color net must never strip a color word that IS the design ("Black Cat"), and the door is the
   * only place that knows which designs a given exit covers — the broadcast title is answerable to
   * EVERY design in the family, a per-child title to its own group's. Defaults to the family name so
   * an un-passed call is protected, never guard-off. */
  const bandTitle = (title: string, produced: boolean, moneyKws: readonly string[] | null = null, protectDesign: string | null = null): string => {
    if (!produced || !title) return title
    /* P0 INSTRUMENTATION (2026-08-12) — RECORD THE BYTES, NOT THEIR LENGTH.
     *
     * Nine stages below already log a decision, and all but two record only `from.length` /
     * `to.length`. That is why this repo cannot answer "who wrote this word": the '| Shirt' the
     * seller rejected is attributed to the council at :8511 and to the band pad at
     * poGoldCorpus.ts:226, and BOTH comments cannot be right. A length delta cannot settle it; a
     * before/after STRING can, and one regen then settles it forever.
     *
     * `mark` appends only when a stage actually CHANGED the string, so the trace is exactly the
     * list of authors, in order, and a clean pass costs one short line. Zero behaviour change —
     * nothing here is read by any decision. handoff/TITLE_ARCHITECTURE.md §7 P0. */
    const traceId = `${input.parentAsin ?? 'na'}#${++DOOR_SEQ}`
    const inTitle = title
    const trace: Array<{ stage: string; text: string }> = []
    const mark = (stage: string, text: string): void => {
      const prev = trace.length > 0 ? trace[trace.length - 1].text : inTitle
      if (text !== prev) trace.push({ stage, text })
    }
    /* DEFECT 2 (PO 2026-08-09, §4) — the Title-Case apostrophe artifact ("Women'S T-Shirts"). Runs
     * FIRST because it is LENGTH-NEUTRAL (it can never move a title across the band) and every stage
     * below reads cleaner bytes for it: the gendered-noun probe, the word dedupe and the census all
     * see "Women's" rather than a mangled token. The four casers that MANUFACTURE the artifact are
     * fixed at their source too (:5447 / :6012 / :6426 / :6542); this is the terminal half of the
     * same rule, catching a council/LLM title, a stored prior, or a caser added tomorrow. */
    const cased = fixApostropheCase(title)
    if (cased !== title) {
      console.log(JSON.stringify({ tag: 'SHIP_APOSTROPHE_CASE', field: 'title', from: title, to: cased }))
    }
    title = cased
    mark('APOSTROPHE_CASE', title)
    /* SPEC-TRUTH FIRST (2026-08-04, the POOL_STRATA-flip leak): the composed pool now carries the
     * MARKET'S fabric vocabulary ("comfort colors heavyweight t shirt"), and the council echoed
     * "Heavyweight" into a midweight blank's title as if it were fact. Claims the blank spec does
     * not back are removed BEFORE dedupe/band, so the freed chars go to the facts-only pad below. */
    const truth = scrubUnspecdGarmentClaims(title, blankSpec)
    if (truth.removed.length > 0) {
      console.log(JSON.stringify({ tag: 'SHIP_SPEC_TRUTH', field: 'title', removed: truth.removed, from: title.length, to: truth.title.length }))
    }
    title = truth.title
    mark('SPEC_TRUTH', title)
    // CAP FIRST, because this door now runs AFTER scrubTrademarks — whose substitutions LENGTHEN the
    // string ("world cup" -> "world futbol cup", +7 chars) and which nothing else re-caps. Before the
    // order was inverted, a title banded to 73 could leave here at 80 and push at 80 (pushFields caps
    // at 200, not 75), which is the Amazon 100476 rejection class. Adversarial review, PR #450.
    // DEDUPE FIRST (#148). The live defect was "… Comfort Colors Tshirt, Tshirt for Women" — a
    // repeat of one word, which `deduplicatePhrases` (:1600) cannot see because it only compares
    // ADJACENT windows. Amazon indexes a token once, so the repeat bought zero extra indexing while
    // spending 8 of the 75 characters. Removing it BEFORE the band pass means those characters are
    // available to the pad below rather than locked up in a duplicate.
    const deduped = collapseRepeatedWords(capTitle75(title))
    if (deduped.removed.length > 0) {
      console.log(JSON.stringify({ tag: 'SHIP_WORD_DEDUPE', field: 'title', removed: deduped.removed, from: title.length, to: deduped.title.length }))
    }
    // The dedupe refused because removing the repeat would have re-created a protected mark — the
    // second half of the live "Futbol World Futbol Cup" oscillation (B0GVVY5TS9). Rare and always
    // worth a line: it means an upstream producer wrote a mark-adjacent token.
    if (deduped.refusedForTrademark) {
      console.log(JSON.stringify({ tag: 'SHIP_WORD_DEDUPE', field: 'title', decision: 'refused-trademark-resurrection', title }))
    }
    const capped = deduped.title
    mark('CAP_AND_DEDUPE', capped)
    /* The context BOTH the waste net's probe and the money-tail loop use. Composed ONCE so the
     * probe ("would removing this waste free space for the keyword?") is answered against exactly
     * the arguments the loop below is about to run with — a second, drifting copy would let the two
     * nets disagree, and the waste net would strip on a promise the loop never keeps. */
    const moneyCtx = {
      // PO ruling 2026-08-10: the pipe-right is the MONEY position, so where the title has ROOM the
      // money tail APPENDS rather than abstaining and letting the band-pad weld a spec fact there.
      allowAppend: true,
      apparel: apparelProduct, lean, spec: blankSpec,
      // Parity with the census/anchor sites (:7967/:8763): effectiveDesignName first. The net
      // itself treats an unresolvable design as design-right (protected), never guard-off.
      // IDENTITY SYNONYMS FOLDED IN (PO ruling 2026-08-09, §6 "soccer ≡ football ≡ futbol"): the
      // design-right guard compares the pipe-right against the DESIGN's tokens, and dropping the
      // spec-fact half of the tail guard left it as the only thing standing between a good money
      // tail and a churny replacement. The PO's own gold ends "| USA Mexico Canada Football Tee" —
      // "Football" IS this design's concept, spelled the way the rest of the world spells it, so a
      // tail carrying it is carrying the design. Composed from the SAME map the pool injection uses
      // (`guaranteedIdentitySynonyms`, :7465) rather than a second copy inside the leaf; asymmetric
      // by construction, so a gridiron design gains nothing. Protect-direction only.
      protect: [
        effectiveDesignName || designName,
        ...guaranteedIdentitySynonyms(effectiveDesignName || designName).map((s) => s.synonym),
      ].filter(Boolean).join(' ') || null,
      garmentBrand: garmentBrandCanonical || null,
    }
    /* TITLE WASTE VOCABULARY (PO ruling 2026-08-09, §3 gold rule 4 + §8) — "Unisex" and "Classic
     * Fit" are not title words. The PO's own rewrite is the specimen:
     *   AI:  THE CEO 2026 World Soccer Cup USA Mexico Canada Unisex Tee | Classic Fit
     *   PO:  THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee
     * BEFORE the money tail, unlike the color and inclusive-audience nets below: those two compete
     * for the tail region the keyword wants, so the keyword gets first refusal and they clean up
     * afterwards. This one frees characters on the LEFT, and freed characters only help the keyword
     * if they are free when it is measured against the band. `moneyKws` is passed ONLY at
     * TITLE_MONEY_TAIL=on — at off/shadow the keyword never ships, so a removal justified by it
     * would leave a short title with nothing to fill it (the net then falls back to the facts-pad
     * arm alone). Fail-open: any removal that satisfies neither arm returns byte-identical. */
    const waste = stripTitleWasteVocabulary(capped, {
      apparel: apparelProduct,
      band: titleBandCtx(capped),
      moneyKws: moneyTailMode === 'on' ? (moneyKws ?? null) : null,
      money: moneyCtx,
    })
    console.log('[TITLE_GOLD]', JSON.stringify({
      tag: 'SHIP_TITLE_WASTE', decision: waste.decision,
      from: capped.length, to: waste.title.length, changed: waste.title !== capped, note: waste.note,
    }))
    let moneyed = waste.title
    mark('WASTE_VOCABULARY', moneyed)
    /* MONEY TAIL (#147) — wire order is spec-truth → cap → dedupe → waste → enforceMoneyTail →
     * enforceTitleBand: when the gold tail lands the title is already in band and the facts-only
     * pad below never fires (curing the "fact tail eats the money slot" leak); when it skips,
     * every downstream byte is identical to today. Shadow ships unchanged + logs the diff.
     * CANDIDATE LOOP (adversarial MEDIUM, 2026-08-09): per-keyword skips (cross-gender/word-repeat/
     * spec-conflict/no-fit) try the next candidate instead of burning the slot; 'already-covered'
     * STOPS the loop (the top candidate indexing from the title = slot satisfied — a lower-value
     * keyword must not be installed past it); title-structural skips (no-tail/design-right/
     * brand-tail/empty/non-apparel) stop too — they are identical for every candidate. The loop
     * itself lives in the leaf (`tryMoneyTail`) so the waste net probes the SAME code path. */
    const mtRun = tryMoneyTail(moneyed, moneyKws, moneyCtx)
    for (const a of mtRun.attempts) {
      console.log('[TITLE_GOLD]', JSON.stringify({
        tag: 'SHIP_MONEY_TAIL', mode: moneyTailMode, decision: a.decision, kw: a.kw,
        from: moneyed.length, to: a.title.length, note: a.note,
      }))
    }
    if (mtRun.applied) {
      const wonKw = mtRun.attempts[mtRun.attempts.length - 1]?.kw ?? ''
      if (moneyTailMode === 'on') { moneyed = mtRun.title; mark('MONEY_TAIL', moneyed) }
      else console.log('[MONEY_TAIL_DIFF]', JSON.stringify({ kw: wonKw, current: moneyed, would: mtRun.title }))
    }
    /* DEFECT B (PO §5, live B0GVVY5TS9 2026-08-09) — A COLOR WORD IN THE SHARED TITLE. §5: "shared
     * title/bullets carry NO color word; colors rank per-child via each child's own backend tail".
     * The rule lived ONLY as an upstream pool filter (colorNeutralFamily + BASIC_COLOR_RE), which a
     * council-written / prior-carried / fill-composed color word walks straight past — so it is
     * enforced HERE, on the bytes that ship, like every other §-rule in this door.
     * DELIBERATELY AFTER the money-tail loop, for the same reason DEFECT 1 is: a color word lives in
     * the tail region the money keyword wants, and `enforceMoneyTail` gets first refusal on that
     * space (when it takes the tail the color leaves for free, and the net below then reports
     * 'no-color'). BEFORE the inclusive-audience net because a mis-describing color is the harder
     * violation of the two and should get the better-funded re-pad. It re-pads from facts internally
     * and refuses any removal it cannot land back inside the band, so a skip is byte-identical. */
    const colorNet = stripVariantColorWords(moneyed, {
      apparel: apparelProduct,
      protect: protectDesign || effectiveDesignName || designName || null,
      band: titleBandCtx(moneyed),
    })
    console.log('[TITLE_GOLD]', JSON.stringify({
      tag: 'SHIP_COLOR_STRIP', decision: colorNet.decision,
      from: moneyed.length, to: colorNet.title.length, changed: colorNet.title !== moneyed, note: colorNet.note,
    }))
    moneyed = colorNet.title
    mark('COLOR_STRIP', moneyed)
    /* DEFECT 1 (PO 2026-08-09, §4) — "for Men and Women" is CHARACTER WASTE. Deliberately AFTER the
     * money-tail loop: §4 allows the inclusive tail on a universal design ONLY when nothing better
     * fits that space, and `enforceMoneyTail` is what decides "better" — it already treats the
     * inclusive tail as its replaceable region (AUDIENCE_TAIL_RE covers "men and women"). So the
     * keyword gets first refusal, and this net then enforces the two rules the money tail does not
     * own: never co-occur with a gendered noun (delete), never appear on a leaned listing (narrow to
     * the leaned gender). It re-pads from facts internally and refuses any removal it cannot land
     * back inside the band, so a skip is byte-identical. */
    const inc = enforceInclusiveAudience(moneyed, { apparel: apparelProduct, lean, band: titleBandCtx(moneyed) })
    console.log('[TITLE_GOLD]', JSON.stringify({
      tag: 'SHIP_INCLUSIVE_AUDIENCE', decision: inc.decision,
      from: moneyed.length, to: inc.title.length, changed: inc.title !== moneyed, note: inc.note,
    }))
    moneyed = inc.title
    mark('INCLUSIVE_AUDIENCE', moneyed)
    /* THE FACTS PAD — suppressed at TITLE_V4=on (2026-08-12).
     *
     * The repo's own attribution makes this the author of TWO of the five rejected titles: it minted
     * "| Crew Neck" (titleBand.ts:702-706) and "| Short Sleeve" (:3186-3188) to reach a length band.
     * It is also the LAUNDERING vector — appending two words converts a droppable spec-only tail into
     * a protected brand tail (classifyTail: "Short Sleeve" = specOnly, "Short Sleeve Comfort Colors
     * Tee" = brand).
     *
     * The seller abolished its reason on 2026-08-12: "never ship short — always ask me". A title that
     * cannot reach the band is now a REFUSAL, surfaced, not a hole packed with facts. */
    const v4NoPad = v4Applies()
    const v = v4NoPad
      ? { title: moneyed, decision: 'v4-no-pad', notes: ['TITLE_V4=on — the facts pad is deleted; short is a refusal, not a hole to fill'] as string[] }
      : enforceTitleBand(moneyed, titleBandCtx(moneyed))
    // PHASE 0 OBSERVABILITY. Log EVERY pass, including no-ops, with the reason. Previously the door
    // logged only when it changed something, so on the first live run after deploy — a 75-char title
    // and no log line — "the net works", "the net never fired" and "the net fired and did nothing"
    // were indistinguishable, and the only honest report was "unknown". The evidence gate for the
    // whole ship-door plan is a live `decision:'padded'` with from<70 and to in [70,75]; that cannot
    // be collected without this line. One line per title per exit; cheap next to the LLM calls.
    console.log(JSON.stringify({
      tag: 'SHIP_BAND_DECISION',
      field: 'title',
      // Flag retired 2026-08-03; constant field kept for log-schema stability (grep tooling).
      mode: 'on',
      decision: v.decision,
      from: title.length,
      to: v.title.length,
      changed: v.title !== moneyed,
      capped: capped.length !== title.length,
      note: v.notes[0] ?? '',
    }))
    const banded = v.title === moneyed ? moneyed : v.title
    mark('BAND_PAD', banded)
    if (v.title !== moneyed) console.log(JSON.stringify({ tag: 'SHIP_BAND_NET', field: 'title', from: title.length, to: v.title.length, note: v.notes[0] ?? '' }))
    // ── TERMINAL ACCEPTANCE ON THE MONEY POSITION ─────────────────────────────────────────────
    // LAST, after every net including the pad — so exactly ONE place owns the rule "the money
    // position must be worth ranking for", instead of a guard inside each operation that can touch
    // a separator. Three live rejections reached the seller through three DIFFERENT writers of the
    // same defect: the pad minted "| Short Sleeve", the pad extended into "| Shirt Short Sleeve",
    // and the council wrote "| Shirt" itself. A terminal gate does not care who wrote it.
    // `enforceMoneyTail` has already had its chance above, so a real keyword always wins the slot
    // first; this only fires when nothing better was available.
    const drop = dropSpecOnlyTail(banded, { apparel: apparelProduct, specValues: blankSpecFactTokens(blankSpec) })
    console.log('[TITLE_GOLD]', JSON.stringify({
      tag: 'SHIP_MONEY_POSITION', decision: drop.decision,
      from: banded.length, to: drop.title.length, note: drop.note,
    }))
    mark('MONEY_POSITION_GATE', drop.title)
    /* ── TITLE_V4 SHADOW MEASUREMENT — the number the seller asked for BEFORE anything changes ────
     *
     * `moneyed` is the title as it stood BEFORE the facts pad; `drop.title` is what ships today. The
     * difference is exactly what the pad manufactured, and whether removing it drops the title under
     * the seller's own corpus floor (their shortest gold is 69 — the Rod Father).
     *
     * At shadow this logs and ships today's bytes unchanged. At `on` the pad never ran, so the two
     * are the same string and `wouldRefuse` becomes a real refusal handled upstream. Logged on EVERY
     * trip, including no-ops: a flag whose shadow arm is silent on its own target listing is a dark
     * flag — the TITLE_MONEY_TAIL lesson this repo already paid for once. */
    const v4Mode = titleV4Mode()
    if (v4Mode !== 'off') {
      const unpadded = moneyed
      const CORPUS_FLOOR = 68        // the seller's shortest gold after their 2026-08-12 revision
      const entry = {
        mode: v4Mode,
        shipped: drop.title,
        shippedLen: drop.title.length,
        withoutPad: unpadded,
        withoutPadLen: unpadded.length,
        padManufactured: drop.title !== unpadded,
        wouldRefuse: unpadded.length < CORPUS_FLOOR,
        floor: CORPUS_FLOOR,
      }
      console.log('[TITLE_V4_DIFF]', JSON.stringify(entry))
      // ALSO RIDE OUT ON THE RESPONSE. The log line alone makes every reading of this measurement
      // depend on someone opening the Coolify log viewer and grepping — a manual step in front of
      // the one number this phase exists to produce. Surfacing it on `debug` makes the refusal rate
      // readable from the regen response itself, by anyone, without shell access.
      v4Diffs.push(entry)
    }
    // ONE line per trip. `stages` is the ordered list of every stage that actually rewrote the
    // string — i.e. the authorship record. An empty `stages` means the door shipped the producer's
    // bytes untouched, which is the state the architecture is aiming for.
    console.log('[TITLE_DOOR_TRACE]', JSON.stringify({ id: traceId, in: inTitle, out: drop.title, stages: trace }))
    return drop.title
  }
  /* SHIP CENSUS (Phase 2 of the foundation plan) — MEASURE-ONLY, on the object this function
   * RETURNS, i.e. the exact bytes that persist. It exists because of a same-day live specimen: the
   * backend degrade gate measured a healthy string BEFORE the editorial audit, passed, the audit
   * deleted tokens down to 118 bytes, and 118 persisted with no line anywhere. One JSON log per
   * violation; it mutates NOTHING and can therefore regress nothing. */
  const censusLog = (out: PipelineResult): PipelineResult => {
    try {
      const violations = shipCensus({
        exit: (out.regeneratedSection as 'title' | 'bullets' | 'keywords' | 'description' | undefined) ?? 'full',
        apparel: apparelProduct,
        title: out.recommended_title || '',
        bullets: out.recommended_bullets || [],
        description: out.recommended_description || '',
        perChildKeywords: out.per_child_keywords || [],
        // Per-child copy — the bytes the push PREFERS on multi-design; shipped unmeasured until
        // live 2026-07-31 (B0F6QZ34B1 fan-out at 889/877 under the 900 floor, no census line).
        perChildTitles: out.per_child_titles || [],
        perChildBullets: out.per_child_bullets || [],
        perChildDescriptions: out.per_child_descriptions || [],
        designName: effectiveDesignName || designName || null,
        degradedSections: out.degradedSections,
      })
      for (const viol of violations) {
        // FACTS-GAP annotation (blank_specs slice, 2026-08-04): a fact-starved short ship should
        // NAME its cure. When an apparel run has NO blank_specs row, the generator is missing the
        // proven title/description lever (Gildan 64000 row alone moved a title 63→70) — annotate so
        // the census line says "add the blank to blank_specs" instead of reading like a code bug.
        const factsGap = apparelProduct && !blankSpec && (viol.code === 'TITLE_UNDER_BAND' || viol.code === 'DESC_UNDER_FLOOR')
          ? { factsGap: 'blank.unknown' } : undefined
        console.log(JSON.stringify({ tag: 'SHIP_CENSUS', exit: out.regeneratedSection ?? 'full', ...viol, ...factsGap }))
      }
      /* PHASE 3 ENFORCEMENT (unconditional since the flag census 2026-08-03; the SHIP_ENFORCE flag
       * was a binary off-switch with no shadow mode, live env unset = on — retiring it is
       * byte-identical; rollback is git-revert). The census MEASURES on the persisting bytes —
       * after the editorial audit, which is what the producing gates cannot see. When it finds a
       * floor violation the enforcement is NOT a rewrite (this seam has no pool and no LLM;
       * padding here would be Goodhart): it marks the section DEGRADED, which routes the result into
       * the battle-tested abort-and-preserve machinery — the route swaps the seller's prior copy
       * back in with an honest note, exactly as the pre-audit gate has always done for the runs it
       * could see. Live evidence for why: 2026-07-30, the gate passed a healthy backend, the audit
       * gutted it to 118 bytes (later 197), and both PERSISTED because nothing measured after the
       * audit. A new listing with NO prior keeps the short output (better than nothing) — that
       * branch already exists in the route and is unchanged. */
      {
        const degraded = new Set(out.degradedSections ?? [])
        const mark = (code: string, section: 'backend_keywords' | 'description'): void => {
          if (violations.some((x) => x.code === code) && !degraded.has(section)) {
            degraded.add(section)
            console.log(JSON.stringify({ tag: 'SHIP_ENFORCE', action: 'degrade-mark', section, code }))
          }
        }
        mark('KEYWORDS_BELOW_FLOOR', 'backend_keywords')
        mark('DESC_UNDER_FLOOR', 'description')
        if (degraded.size > (out.degradedSections?.length ?? 0)) out.degradedSections = [...degraded]
      }
    } catch (e) {
      // The census must never break a regen — it is observation, not enforcement.
      console.warn('[shipCensus] failed (non-fatal):', e instanceof Error ? e.message : e)
    }
    return out
  }
  // CELEBRITY PARITY AT THE CHOKE POINT (adversarial HIGH, 2026-08-09): isCelebrityToken is a
  // PER-TOKEN gate (banBackendTok), so a PHRASE entry ("forrest frank", "chris brown") has NEVER
  // matched at generation — each half passes alone and the LLM fill can compose the pair into
  // stored bytes that only the push-boundary scrub would later strip, silently diverging pushed
  // bytes from the stored/approved ones. Run the SAME phrase-aware terminal scrub the push runs
  // (scrubCelebrityNames) right beside scrubTrademarks on every published surface, so stored ≡
  // pushed. Idempotent; runs before bandTitle so the band pad can re-fill any freed chars.
  const scrubPub = (s: string, fieldCtx: string): string => scrubCelebrityNames(scrubTrademarks(s), `pipeline:${fieldCtx}`)
  const scrubPublished = (r: PipelineResult, opts?: { titleProduced?: boolean }): PipelineResult => {
  /* DESIGN VOCABULARY THE COLOR NET MUST NOT STRIP (DEFECT B). Resolved HERE because this is the one
   * place that sees the whole result: on a multi-design family `effectiveDesignName` is deliberately
   * '' (:7750) and each design's name lives on its own per_child_titles row, so the FAMILY protect
   * set is the union — a broadcast title is answerable to every design in the family. The same union
   * is handed to the per-child exit: over-protecting a sibling design's color word costs at most one
   * un-stripped color (fail-open), while under-protecting corrupts a design name. */
  const protectHay = [
    effectiveDesignName || designName,
    ...(r.per_child_titles ?? []).map((c) => c.designName ?? ''),
  ].filter(Boolean).join(' ')
  return censusLog({
    ...r,
    // Third arg = the derived money-keyword candidates (TITLE_MONEY_TAIL) — BROADCAST title only in Phase 1.
    recommended_title: bandTitle(scrubPub(r.recommended_title, 'title'), opts?.titleProduced !== false, titleMoneyKws, protectHay),
    recommended_bullets: scrubCelebrityNamesArr(scrubTrademarksArr(r.recommended_bullets), 'pipeline:bullets'),
    recommended_description: scrubPub(r.recommended_description, 'description'),
    // RE-CAP AFTER THE SCRUB (2026-08-10) — the same discipline the title door already applies at
    // :8033 ("CAP FIRST, because this door now runs AFTER scrubTrademarks — whose substitutions
    // LENGTHEN"). The backend never got it, and `scrubTrademarks` rewriting "world cup" ->
    // "world soccer cup" pushed the already-capped 250-byte string to 251. That single byte was not
    // cosmetic: `shouldPreserveKeywords` compared RAW worst-child bytes, so an over-cap prior beat
    // every possible <=250 fresh output for ever and froze the family's backend (B0GVV3XL4T, 98
    // children byte-identical June->August). Capping here removes the byte at its source; the
    // clamp in backendDegradeGate removes its power over already-stored rows.
    per_child_keywords: r.per_child_keywords.map((c) => ({
      ...c,
      keywords: truncateToBytes(scrubPub(c.keywords, 'backend'), CONTENT_CONTRACT.keywords.byteCap),
    })),
    // Commit 2: per_child_titles ALSO ship to Amazon (multi-design POD + capacity families).
    // Adversarial review caught the gap — a trademark in a per-design title was unscrubbed.
    per_child_titles: r.per_child_titles?.map((c) => ({ ...c, title: bandTitle(scrubPub(c.title, 'per-child-title'), opts?.titleProduced !== false, null, protectHay) })),
    // Per-design bullets/description are PERSISTED (scrubbed the same as their broadcast peers), but
    // the push does NOT consume them yet — pushExecutor/resolveProposed still send the broadcast
    // bullets/description to every SKU. Per-design PUSH + UI is the next commit (PR3). Until then
    // these are generated + stored for the UI/push to read; nothing per-design reaches Amazon.
    per_child_bullets: r.per_child_bullets?.map((c) => ({ ...c, bullets: c.bullets.map((b) => scrubPub(b, 'per-child-bullets')) })),
    per_child_descriptions: r.per_child_descriptions?.map((c) => ({ ...c, description: scrubPub(c.description, 'per-child-description') })),
    // Audit blobs are seller-facing copy too (PO-caught 2026-07-02: raw mark in an action_plan copy
    // block). Deep-scrub every string value; identifier keys (sku/asin/element/...) are skipped
    // inside scrubTrademarksDeep so SKU codes are never rewritten.
    action_plan: scrubTrademarksDeep(r.action_plan),
    keyword_reconciliation: scrubTrademarksDeep(r.keyword_reconciliation),
    product_details_improvements: scrubTrademarksDeep(r.product_details_improvements),
  })
  }
  const partialResult = (section: NonNullable<PipelineInput['onlySection']>, fields: Partial<PipelineResult>): PipelineResult => scrubPublished({
    recommended_title: input.priorTitle ?? '',
    recommended_bullets: input.priorBullets ?? [],
    per_child_keywords: [],
    per_child_titles: undefined,
    recommended_description: '',
    variant_corrections: [],
    cannibalization_warnings: [],
    product_details_improvements: [],
    keyword_reconciliation: [],
    action_plan: [],
    irrelevant_keywords: irrelevantKeywords,
    keywordPlan: { bullets: [], designName: effectiveDesignName, coupleConcept: coupleConcept || undefined },
    debug: { titleProblems: [], candidatesUsed: [], titleRetried: false, designName, designSource, multiDesign: designGroupInfo.isMultiDesign, designGroups: designGroupInfo.groups.map((g) => g.key) },
    regeneratedSection: section,
    ...fields,
    // Only a TITLE partial actually produced a title this run; every other section passes
    // `input.priorTitle` straight through, and band-enforcing THAT would hand the seller a
    // rewritten title they never asked to regenerate (and offer it for push).
  }, { titleProduced: section === 'title' })

  // Stage 1 — Title (skipped on a non-title partial run: the stored title is the anchor,
  // so e.g. regenerated bullets keep deduping against the title the seller already approved)
  //
  // BRANCH:
  //   apparelMultiDesign → per-design loop (each group runs buildTitleFor → council via
  //     runTitleAgent) + niche-aware parent via buildNicheParentTitle. Fans out per_child_titles.
  //   single-design → ONE buildTitleFor call. Byte-identical output to the pre-Commit-2 inline
  //     block (the regression bar — buildTitleFor was extracted verbatim from this block).
  //   else (partial regen of a non-title section) → finalTitle = priorTitle anchor, unchanged.
  // motifTrust is reused by later stages (bullets/description/keywords) for ungrounded-motif
  // stripping, so it stays at the orchestrator scope. buildTitleFor recomputes its own from the
  // (possibly group-scoped) input, so per-design grounding is correct.
  const motifTrust = `${input.canonicalTitle ?? ''} ${input.repTitle ?? ''} ${designName}`.toLowerCase()
  const apparelMultiDesign = apparelProduct && designGroupInfo.isMultiDesign
  // Phase 2 — UNIFIED-SET (couple / matching) detection. A multi-design apparel family whose own
  // listing title says it is ONE concept split across halves ("Funny Couple Matching Tee" =
  // "Rude Potato" + "Sweet Potato") must NOT get a separate per-design title/bullets/description.
  // The PO wants ONE shared title that names BOTH designs + the couple concept, broadcast to every
  // variant. STRICT detection (a couple is exactly TWO halves of ONE concept): require an explicit
  // COUPLE/PAIR signal — NOT a bare "matching <garment>", which also appears on friend-group /
  // bachelorette / family multi-design families that are INDEPENDENT designs and MUST keep their
  // per-design titles (adversarial review: bare "matching" false-positived + collapsed them). Also
  // cap to EXACTLY 2 design groups (3+ is definitionally not a couple), and read ONLY the listing-
  // level title (canonical/rep) so one stray child phrase can't flip the whole family.
  const COUPLE_RE = /couple[\s-]?(?:match|matching|tee|tees|shirt|shirts|set|goals|pair)|match(?:ing|ed)?\s+couple|his\s*(?:and|&|\/)?\s*hers|mr\.?\s*(?:and|&)\s*mrs|king\s*(?:and|&)\s*queen/i
  const coupleTitleSource = [input.canonicalTitle ?? '', input.repTitle ?? ''].filter(Boolean).join(' ')
  const unifiedSet = apparelMultiDesign && designGroupInfo.groups.length === 2 && COUPLE_RE.test(coupleTitleSource)
  let finalTitle: string
  let titleProblems: string[] = []
  let retried = false
  // Hoisted: multi-design apparel populates this in the title branch; the non-apparel capacity
  // branch below populates it for single-design capacity families. Single-design apparel: stays undefined.
  let perChildTitles: { sku: string; asin: string; title: string; designName?: string; designKey?: string }[] | undefined
  // Per-DESIGN bullets/description fan-out (multi-design apparel only). Populated in the bullets +
  // description stages below; stay undefined for single-design/non-apparel so the broadcast ships.
  let perChildBullets: { sku: string; asin: string; bullets: string[]; designName?: string; designKey?: string }[] | undefined
  let perChildDescriptions: { sku: string; asin: string; description: string; designName?: string; designKey?: string }[] | undefined
  // Per-design contexts captured FROM the title loop so the bullets/description stages can reuse the
  // (costly) per-group design-name + vision resolution WITHOUT recomputing it. Populated only when the
  // multi-design title branch runs (full regen or a title-only partial); empty otherwise.
  let designGroupContexts: { skus: { sku: string; asin: string }[]; designName: string; title: string; groupInput: PipelineInput; key: string }[] = []
  // Phase 2: the unified-set couple anchor (e.g. "Rude Potato & Sweet Potato Couple Matching"),
  // resolved in the unified-set branch and reused by the shared bullets + description stages below
  // so they anchor on the SAME couple concept the title leads with. Empty unless unifiedSet ran.
  let coupleConcept = ''
  if (apparelMultiDesign && (!only || only === 'title')) {
    // PER-DESIGN TITLES (Phase 1 Commit 2 + hot-fix) AND Phase 2 unified-set share the SAME per-group
    // design-name resolution. Each design group resolves its name via this chain (PO 2026-06-17:
    // "design name is stored as Amazon's Color attribute"):
    //   1. PRIMARY — fetch rep child's Amazon attributes (color → style_name → color_name) via
    //      Listings Items API. First non-empty wins (gated by isGarmentColor — a literal shirt color
    //      is NEVER the anchor).
    //   2. BACKUP — per-group vision scan (gpt-4.1-mini reading the rep child's image).
    //   3. LAST-RESORT — extractDesignName on the cloned groupInput, then the designKey-derived label.
    // Pressure-test mitigations preserved:
    //   - groupInput.canonicalTitle = group's child stored title (NOT parent canonical →
    //     prevents cross-design fill-bigram leakage, finding #3)
    //   - searchKeyphrases reused from parent's filtered pool (finding #1a)
    //   - vision scans + attribute fetches parallel via Promise.all
    // Resolve SP-API creds ONCE for the whole family. Best-effort: a failure here just means the
    // per-design name resolution falls through to vision + extractDesignName (today's behavior).
    let spToken: string | null = null
    let spSellerId: string | null = null
    try { spToken = await getSpApiAccessToken(); spSellerId = await getSpApiSellerId() } catch (e) { console.warn('[pipeline] SP-API creds unavailable for per-design color fetch — falling back to vision:', e instanceof Error ? e.message : e) }
    const SP_ENDPOINT_URL = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
    const SP_MP_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
    // All design keys in THIS family — fed to deriveDesignLabel so each key's common prefix is
    // stripped against its siblings ('SOCCER-CUP-TS-ARGENTINA' → 'Argentina'). Gathered once.
    const allGroupKeys = designGroupInfo.groups.map((g) => g.key)
    const fetchDesignNameAttr = async (sku: string): Promise<string> => {
      if (!spToken || !spSellerId || !sku) return ''
      try {
        const u = `${SP_ENDPOINT_URL}/listings/2021-08-01/items/${spSellerId}/${encodeURIComponent(sku)}?marketplaceIds=${SP_MP_ID}&includedData=attributes`
        // Global 5-rps read ceiling (2026-07-20 audit — per-SKU design-name attr fetch was ungated).
        // Dynamic import to keep the pipeline module's static graph unchanged; the bucket is a
        // process-shared singleton regardless of how it's imported.
        const { spApiReadBucket } = await import('@/lib/fba/spApiRateLimiter')
        await spApiReadBucket.acquire()
        const resp = await fetch(u, { headers: { 'x-amz-access-token': spToken } })
        if (!resp.ok) return ''
        const json = await resp.json() as { attributes?: Record<string, unknown> }
        const attrs = json.attributes ?? {}
        for (const key of ['color', 'style_name', 'color_name']) {
          const arr = attrs[key] as Array<{ value?: string }> | undefined
          const v = arr?.[0]?.value
          if (typeof v === 'string' && v.trim()) return v.trim()
        }
        return ''
      } catch (e) { console.warn(`[pipeline] design-name attr fetch ${sku} failed:`, e instanceof Error ? e.message : e); return '' }
    }
    // SHARED Phase-1 anchor resolution for one design group → { groupInput, groupDesignName }. Used by
    // BOTH the per-design title loop (multi-design, !unifiedSet) and the Phase-2 unified-set path so the
    // couple concept names the SAME design names the per-design path would have produced. (Extracted
    // verbatim from the Phase-1 loop body; buildTitleFor is the only part the unified path does NOT do.)
    const resolveGroupDesignName = async (group: DesignGroup): Promise<{ group: DesignGroup; groupInput: PipelineInput; groupDesignName: string }> => {
      const groupChildren = group.skus
        .map((s) => input.children.find((c) => c.sku === s.sku))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
      const repSku = group.skus[0]?.sku ?? ''
      const repAsin = group.skus[0]?.asin ?? input.children[0]?.asin ?? ''
      const groupRepTitle = groupChildren[0]?.title ?? input.repTitle ?? null
      // Amazon Color attribute (the seller's design-name slot — but for many products this is the
      // literal SHIRT COLOR 'Blue Spruce', which must NOT anchor the content; gated below).
      const colorAttrName = await fetchDesignNameAttr(repSku)
      // VISION READ of the actual PRINTED artwork. ALWAYS runs for multi-design families now (the
      // old `if (!colorAttrName)` gate skipped it whenever a Color attribute existed — but the
      // color is exactly the wrong anchor, so vision must never be skipped on its account). Its
      // designTheme is the vision's name-like read of what is drawn on the shirt ('Rude Potato').
      let groupVision = input.visionDesign
      try {
        const url = repAsin ? await getProductImageUrl(repAsin) : null
        const identity = url && repAsin ? await scanProductImage(repAsin, url, { openai: input.openai }) : null
        if (identity) {
          // Feed the per-group vision read into groupInput.visionDesign so extractDesignName's LLM
          // refine USES it (title + vision -> a clean design name). We do NOT pre-extract a name from
          // designTheme here — letting extractDesignName refine yields 'Only Fins', not the verbose theme.
          groupVision = {
            designTheme: identity.designTheme || '',
            visualElements: Array.isArray(identity.visualElements) ? identity.visualElements : [],
            seedKeywords: Array.isArray(identity.seedKeywords) ? identity.seedKeywords : [],
          }
        }
      } catch (e) { console.warn(`[pipeline] per-design vision ${repAsin} failed:`, e instanceof Error ? e.message : e) }
      // SKU designKey-derived label ('LS-RUDEPOTATO' → 'Rude Potato'), prefix-stripped vs siblings.
      const keyLabel = deriveDesignLabel(group.key, allGroupKeys)
      const groupInput: PipelineInput = {
        ...input,
        canonicalTitle: groupRepTitle,
        repTitle: groupRepTitle ?? input.repTitle,
        visionDesign: groupVision,
        // Anchor priority (the core fix). The anchor must be about the DESIGN, never the garment
        // color. We stuff ONLY: seller override (verbatim) > a NON-color Amazon Color attribute.
        // When both are absent we pass null, so extractDesignName runs its LLM refine on the title +
        // vision (the proven resolver -> 'Only Fins'/'Rude Potato'); keyLabel is the fallback AFTER
        // that (below). We deliberately do NOT stuff vision/keyLabel here — that would short-circuit
        // the LLM refine and regress good names to a verbose theme or an opaque code.
        // KEY INVARIANT: a value isGarmentColor() returns true for never anchors.
        designNameOverride: input.designNameOverridesByKey?.[group.key]?.trim()
          || (colorAttrName && !isGarmentColor(colorAttrName) ? colorAttrName : null)
          || null,
        children: groupChildren,
      }
      const extracted = await extractDesignName(groupInput)
      // extractDesignName's LLM refine (title + vision) is the proven resolver. Fall back to the
      // designKey-derived label ONLY if it returned empty OR (defensively) a garment color slipped
      // through — per-design content must anchor on the design, never the shirt color.
      let groupDesignName = extracted.name
      if (!groupDesignName?.trim() || isGarmentColor(groupDesignName)) groupDesignName = keyLabel || groupDesignName || ''
      return { group, groupInput, groupDesignName }
    }
    if (unifiedSet) {
      // UNIFIED-SET (couple / matching). The family is ONE concept split across halves — do NOT
      // generate per-design titles/bullets/description. Resolve each half's design name with the
      // SAME anchor logic, then build ONE shared title that LEADS with the couple concept ("Rude
      // Potato & Sweet Potato Couple Matching"). Leaving per_child_* UNDEFINED broadcasts the one
      // shared set to every variant (no per-design split) — exactly what the PO wants.
      onProgress(`Writing one shared couple/matching title for ${designGroupInfo.groups.length} designs...`)
      const resolved = await Promise.all(designGroupInfo.groups.map((g) => resolveGroupDesignName(g)))
      // Preserve group order (detectDesignGroups order); drop empties so the concept reads clean.
      const allDesignNames = resolved.map((r) => r.groupDesignName.trim()).filter(Boolean)
      // The couple concept the title MUST lead with, e.g. "Rude Potato & Sweet Potato Couple Matching".
      // Fall back to the family designName, then a bare "Couple Matching" — never a leading space.
      const conceptBase = allDesignNames.length ? allDesignNames.join(' & ') : designName.trim()
      coupleConcept = (conceptBase ? `${conceptBase} ` : '') + 'Couple Matching'
      // ONE shared title — buildTitleFor with coupleConcept AS the designName, so it leads the title
      // and the design-name backstop (guard 6) re-inserts it verbatim if the council drops it.
      const r = await buildTitleFor(input, candidates, attrs.searchKeyphrases, titleMustInclude, preferredAudience, attributePinFinal, topUpgradeKws, compatibilityBrands, coupleConcept, lean, apparelProduct, brandName, season)
      finalTitle = r.title
      titleProblems = r.problems
      retried = r.retried
      // designGroupContexts stays EMPTY → the bullets/description stages skip their per-design fan-out
      // and the broadcast (shared) bullets/description ship to every variant. perChildTitles stays
      // undefined for the same reason.
    } else {
      onProgress(`Writing ${designGroupInfo.groups.length} per-design titles + niche-aware parent...`)
      perChildTitles = []
      const groupResults = await Promise.all(designGroupInfo.groups.map(async (group) => {
        const { groupInput, groupDesignName } = await resolveGroupDesignName(group)
        const r = await buildTitleFor(groupInput, candidates, attrs.searchKeyphrases, titleMustInclude, preferredAudience, attributePinFinal, topUpgradeKws, compatibilityBrands, groupDesignName, lean, apparelProduct, brandName, season)
        // groupInput is returned so the bullets/description stages can reuse the resolved per-group
        // design name + vision (designNameOverride/visionDesign/canonicalTitle) without recomputing.
        return { group, groupInput, groupDesignName, ...r }
      }))
      const allDesignNames: string[] = []
      for (const gr of groupResults) {
        allDesignNames.push(gr.groupDesignName)
        for (const s of gr.group.skus) perChildTitles.push({ sku: s.sku, asin: s.asin, title: gr.title, designName: gr.groupDesignName, designKey: gr.group.key })
        titleProblems.push(...gr.problems.map((p) => `[${gr.group.key}] ${p}`))
        retried = retried || gr.retried
      }
      // Capture per-group contexts (skus + resolved design name + title + groupInput) so the bullets +
      // description stages generate PER DESIGN reusing this work — no second design-name/vision pass.
      designGroupContexts = groupResults.map((gr) => ({ skus: gr.group.skus, designName: gr.groupDesignName, title: gr.title, groupInput: gr.groupInput, key: gr.group.key }))
      // FAMILY-NICHE ANCHOR (H "Seam 2"): the multi-design parent had NO positive niche anchor, so a
      // weak council pass shipped dead filler ("...Graphic Shirts for Men") with no niche pull. Derive
      // ONE niche noun ("funny fishing shirt") from the scalar FAMILY design_name_override via
      // expandDesignNiche — a niche PHRASE, never the verbatim slogan — trademark-scrubbed + off-niche-
      // gated (notOffNiche uses the rich title context), and hand it to the parent builder as a POSITIVE
      // anchor (TITLE channel only; the bullet-cohesion scorer still sees effectiveDesignName=''). Sourced
      // from the family override ALONE (no per-design vision/secondary phrases) so the niche broadcasts to
      // EVERY design. Best-effort → '' on any miss, and the builder no-ops on '' (zero regression).
      let familyNiche = ''
      let nicheFillSeeds: string[] = []
      const familyOverride = (input.designNameOverride ?? '').trim()
      if (familyOverride) {
        const nicheRaw = await expandDesignNiche(input.openai, familyOverride, [], undefined, input.productType ?? null)
        const cleanNiche = nicheRaw
          .map((s) => scrubTrademarks(s).trim().toLowerCase())
          .filter((s) => s && findTrademarkPhrases(s).length === 0 && bulletTokens(s).length >= 2 && notOffNiche(s))
        // Prefer a niche noun that already carries a garment word ("funny fishing shirt"); else the
        // first clean expansion.
        familyNiche = cleanNiche.find((s) => /\b(?:t-?shirts?|tshirts?|tees?|shirts?)\b/i.test(s)) || cleanNiche[0] || ''
        if (familyNiche) onProgress(`Family-niche anchor: "${familyNiche}".`)
        // NICHE FILL SEEDS (live loop 2026-07-17, B0DMXMH266): the parent fill draws from topUpgradeKws,
        // but after the #419 universe demotion that pool is broad-category permutations whose tokens are
        // already in the title (the ALL-NOVEL rule skips every one) — while the family's own niche
        // keyphrases are COVERED (Defended) and never enter topUpgradeKws. Net: the fill added nothing
        // and the parent shipped 30 chars short. Authorize the REMAINING clean niche expansions
        // ("fisherman gift tee", "fishing lover shirt") as fill seeds AHEAD of the upgrade pool — the
        // same judge-gated, trademark/off-niche-scrubbed provenance class as single-design nicheSeeds.
        nicheFillSeeds = cleanNiche.filter((s) => s !== familyNiche).slice(0, 4)
      }
      // FILL POOL (live-loop iteration 3, B0DMXMH266): nicheFillSeeds + topUpgradeKws alone still left the
      // parent 26 chars short — every niche EXPANSION phrase shares its tokens with the anchor already in
      // the title (the ALL-NOVEL rule rightly skips them), and every UPGRADE term is a broad-category
      // permutation of covered tokens. The pool's own COVERED niche terms ("fisherman gifts", "bass
      // fishing") carry genuinely NOVEL title tokens but are Defended, so they never enter topUpgradeKws.
      // `candidates` (selectTitleCandidates — already off-niche-gated #402, outcome-weighted, grounded) is
      // the provenance-correct source for them; the fill's design-motif/gender/garment/junk rails still
      // apply per keyword. Order: niche seeds first, then pool candidates, then broad upgrades.
      const parentFillPool = [...nicheFillSeeds, ...candidates.map((c) => c.keyword), ...topUpgradeKws]
      // SEED-POOL FALLBACK (fallback chain Part 3): when even seeds + candidates + upgrades leave
      // the fill pool starved of real phrases (<8 multi-token entries), pull the cross-listing
      // niche pool for the family niche (keyword_seed_pool, the same store researchKeywords shares
      // by seed) — top 10 by volume, trademark/off-niche/foreign-gated like every other title
      // source. Appended LAST so provenance order (niche seeds → candidates → upgrades → pool)
      // is preserved; the fill's ALL-NOVEL/junk/gender/garment rails still vet each phrase.
      // Fail-open: any error leaves the pool exactly as built above.
      try {
        const usable = parentFillPool.filter((k) => bulletTokens(k).length >= 2)
        if (usable.length < 8 && familyNiche) {
          const seedKey = normalizeSeedKey(familyNiche)
          const pool = await getSeedPool(seedKey)
          if (pool) {
            const extras = [...pool.keywords]
              .sort((a, b) => b.searchVolume - a.searchVolume)
              .slice(0, 10)
              .map((k) => scrubTrademarks(k.keyword).trim())
              .filter((s) => s && findTrademarkPhrases(s).length === 0 && notOffNiche(s) && !isForeignKeyword(s))
            if (extras.length) {
              parentFillPool.push(...extras)
              console.log(`[TITLE] seed-pool fallback: +${extras.length} phrases from "${seedKey}"`)
            }
          }
        }
      } catch (e) {
        console.warn('[TITLE] seed-pool fallback failed (non-fatal):', e instanceof Error ? e.message : e)
      }
      // COMPETITOR SEO SNAPSHOT (fallback chain Part 1): the seller-named competitor's live
      // title/bullets, studied by the council as a keyword-strategy/structure reference (their
      // brand never ships — deterministic net inside buildNicheParentTitle). Fail-open on any miss.
      let compSeo: (CompetitorSeoSnapshot & { brand: string }) | null = null
      if (input.competitorAsin) {
        try {
          const snap = await getCompetitorSeoSnapshot(input.competitorAsin)
          if (snap) {
            compSeo = { ...snap, brand: (input.competitorBrand ?? '').trim() }
            onProgress(`Studying top competitor ${input.competitorAsin}'s title strategy...`)
          }
        } catch (e) {
          console.warn('[TITLE] competitor snapshot failed (non-fatal):', e instanceof Error ? e.message : e)
        }
      }
      // TITLE_COUNCIL_V3.1a: parent-lean uses the family-level seller-declared audienceLean (PO Q4 = UNANIMITY —
      // a truly mixed-lean family should have audienceLean='unisex' set on the parent; a lean_female/lean_male
      // family value means the seller has already asserted family-level unanimity). Fallback null on non-apparel.
      const parentLean: AudienceLean = apparelProduct ? (input.audienceLean ?? null) : null
      finalTitle = await buildNicheParentTitle(input.openai, brandName, allDesignNames, familyNiche, attributePinFinal, preferredAudience, input.productType ?? null, parentFillPool, compatibilityBrands, onProgress, compSeo, parentLean, input.poGolds, input.__v4Sink)
    }
  } else if (!only || only === 'title') {
    onProgress('Writing title...')
    const r = await buildTitleFor(input, candidates, attrs.searchKeyphrases, titleMustInclude, preferredAudience, attributePinFinal, topUpgradeKws, compatibilityBrands, designName, lean, apparelProduct, brandName, season)
    finalTitle = r.title
    titleProblems = r.problems
    retried = r.retried
  } else {
    finalTitle = (input.priorTitle || repTitle || '').trim()
  }

  // ── PATH-INVARIANT EDITORIAL GATES (2026-07-10, PO-reported bullet-quality regression) ─────────
  // A bullets-only / description-only regen used to RETURN before the FINAL EDITORIAL AUDIT and the
  // ALWAYS-RUN TRUTH GATE, so "Regenerate bullets" shipped strictly worse copy than a full audit:
  // the fabricated "oversized" fit survived (no scrubFitClaims), the seller's OWN blank brand was
  // never re-asserted (no "mention Comfort Colors in one bullet"), bullets came back thin (no
  // 100-200 char enforcement) and unpolished. Same dual-write-path rule as every other invariant:
  // a quality gate must run on BOTH the full and the partial paths. FAIL-OPEN like the full path —
  // any error keeps the raw council copy (never blanks it: the empty-only abort rule still owns that).
  // Fit source on partials is the AUTHORITATIVE blank spec only. The full path additionally falls
  // back to the features-audit's inferred Fit — unavailable here (pdiFinal isn't built yet) and, per
  // the spec-vs-search-grounding rule, that inferred value is search-demand, not a product FACT. So a
  // partial scrubs a fabricated "oversized" exactly when the blank is known. Strictly better than the
  // prior behavior (no gate at all on partials).
  const truthFitEarly = blankSpec?.fit || ''
  const collapseDupWord = (s: string) => s.replace(/\b(\w+)(\s+\1)\b/gi, '$1')
  const applyEditorialGates = async (
    inBullets: string[],
    inDescription: string,
  ): Promise<{ bullets: string[]; description: string }> => {
    let outB = inBullets
    let outD = inDescription
    // 1) Editorial audit — same gate the full path runs; single-design apparel only (multi-design
    //    fans out per group — its broadcast copy therefore gets only the deterministic truth gate,
    //    parity with the full path; a per-group audit is a filed follow-up). We pass the ANCHOR title
    //    + whatever prose this partial owns, and take back ONLY the fields this partial regenerated —
    //    a bullets regen must never rewrite the seller's (possibly locked) title.
    //    Gate: 5 bullets to audit (bullets path) OR any description to polish (a description regen on
    //    a listing with no stored bullets must still get audited — adversarial: it silently didn't).
    if (apparelProduct && !designGroupInfo.isMultiDesign && (outB.length === 5 || outD.trim().length > 0)) {
      try {
        const ar = await runFinalEditorialAudit(input.openai, finalTitle, outB, outD, '', {
          design: effectiveDesignName || designName || repTitle || '',
          designPhrases: secondaryPhrases,
          garment: input.productType ?? '',
          audience: preferredAudience || lean || '',
          referenceTitle: input.canonicalTitle ?? repTitle ?? '',
          brandFront: brandName || 'THE CEO',
          garmentBrand: garmentBrandCanonical || '',
          fit: truthFitEarly,
          weightNote: blankSpec?.weightNote,
          customizable: input.customizable === true,
          widow: detectWidowFormat(finalTitle, repTitle),
        })
        outB = ar.bullets
        if (outD) outD = ar.description
        onProgress('Editorial audit applied.')
      } catch { /* fail-open: keep the council copy */ }
    }
    // 2) Deterministic truth gate — fit contradictions + dangling tails, regardless of audit outcome.
    if (apparelProduct && truthFitEarly) {
      outB = outB.map((b) => collapseDupWord(scrubFitClaims(deDangle(b), truthFitEarly)))
      if (outD) outD = collapseDupWord(scrubFitClaims(tidyDescription(outD), truthFitEarly))
    }
    return { bullets: outB, description: outD }
  }

  // ── PER-CHILD MULTI-DESIGN GATE (task #61, Invariant 5) ─────────────────────────────────────────
  // The push (pushFields.resolveProposed) PATCHes Amazon with per_child_bullets / per_child_descriptions
  // for a multi-design family — NOT the broadcast copy that applyEditorialGates + the always-run truth
  // gate clean. So multi-design used to ship UNSCRUBBED jargon (#365), lost HTML (#366), lowercase brand
  // (#367) and "oversized" fit contradictions. Gate the per-child bytes with the SAME chain: ONE gpt-4.1
  // audit per DESIGN GROUP (each group ships one unique set fanned to its SKUs → parity with the
  // per-group GENERATION calls, NOT per child), budget-capped; overflow / fail-open groups still get the
  // PURE deterministic truth+brand scrub (no LLM). Mutates the passed arrays in place. No-op for
  // single-design (the full-path audit already covers it) and non-apparel.
  const MULTI_DESIGN_AUDIT_MAX_GROUPS = Number(process.env.MULTI_DESIGN_AUDIT_MAX_GROUPS || 8)
  const gatePerChildMultiDesign = async (
    pcb: typeof perChildBullets,
    pcd: typeof perChildDescriptions,
    fit: string,
    brand: string,
  ): Promise<void> => {
    if (!(apparelMultiDesign && designGroupContexts.length)) return
    let auditBudget = MULTI_DESIGN_AUDIT_MAX_GROUPS
    for (const ctx of designGroupContexts) {
      const repSku = ctx.skus[0]?.sku
      let gb = pcb?.find((c) => c.sku === repSku)?.bullets ?? []
      let gd = pcd?.find((c) => c.sku === repSku)?.description ?? ''
      // 1) LLM editorial audit on the GROUP REP — same accept condition as applyEditorialGates. Weaves
      //    THIS group's theme (ctx.designName + ctx.groupInput.canonicalTitle), budget-capped, fail-open.
      if (auditBudget > 0 && (gb.length === 5 || gd.trim().length > 0)) {
        auditBudget--
        try {
          const ar = await runFinalEditorialAudit(input.openai, ctx.title, gb, gd, '', {
            design: ctx.designName || effectiveDesignName || '',
            designPhrases: secondaryPhrases,
            garment: input.productType ?? '',
            audience: preferredAudience || lean || '',
            referenceTitle: ctx.groupInput.canonicalTitle ?? ctx.title ?? '',
            brandFront: brandName || 'THE CEO',
            garmentBrand: brand,
            fit,
            weightNote: blankSpec?.weightNote,
            customizable: input.customizable === true,
            widow: detectWidowFormat(ctx.title, ctx.groupInput.canonicalTitle),
          })
          if (gb.length === 5) gb = ar.bullets
          if (gd) gd = ar.description
          onProgress('Per-design editorial audit applied.')   // keepalive between sequential calls
        } catch { /* fail-open: the deterministic gate below still runs */ }
      }
      // 2) DETERMINISTIC truth + brand gate — PURE, NO LLM — every group, regardless of budget/outcome.
      const collapseDup = (s: string) => s.replace(/\b(\w+)(\s+\1)\b/gi, '$1')
      if (fit) {
        gb = gb.map((b) => collapseDup(scrubFitClaims(deDangle(b), fit)))
        if (gd) gd = collapseDup(scrubFitClaims(tidyDescription(gd), fit))
      }
      if (brand) {
        gb = gb.map((b) => normalizeBrandInBullet(b, brand))
        if (gd) gd = normalizeBrandCase(gd, brand)
      }
      // TERMINAL per-child brand-strip + production-method scrub (INVARIANT 2 + INVARIANT 3 — must run
      // on the per-child bytes the push actually PATCHes, not just the broadcast). Uses seller brandName
      // (captured from outer scope) for the strip — the local `brand` param is the GARMENT brand for
      // casing. No-op if brandName absent or gd empty.
      if (gd && brandName) gd = scrubDescriptionBody(gd, { brand: brandName, garmentBrand: brand })
      // TERMINAL per-child length re-expand (INVARIANT 3 — bundled with Item C, 2026-07-21).
      if (gd) gd = await reExpandDescriptionIfShort(input.openai, gd, { finalTitle: ctx.title, brand: brandName, garmentBrand: brand })
      // TERMINAL per-child bullets expander (INVARIANT 2 + 3 — bundled with Item C). Rewrites any
      // per-child bullet under BULLET_MIN_CHARS via gpt-4.1-mini, keeping the ALL-CAPS hook and
      // running the same deterministic post-scrub as existing bullets.
      if (gb.length === 5) gb = await expandShortBulletsTerminal(input.openai, gb, {
        title: ctx.title, designName: ctx.designName, fit, garmentBrand: brand,
      })
      // 3) Broadcast the gated copy back to EVERY SKU in the group by ctx.skus membership (authoritative —
      //    the per-child designKey is optional and may be unset). They shared one set, so this is free.
      //    Guard on non-empty content: if the rep SKU wasn't found (gb/gd empty), NEVER overwrite the
      //    group's real copy with a blank — that would silently destroy per-child bytes the push ships.
      const groupSkus = new Set(ctx.skus.map((s) => s.sku))
      if (pcb && gb.length) for (const c of pcb) if (groupSkus.has(c.sku)) c.bullets = gb
      if (pcd && gd) for (const c of pcd) if (groupSkus.has(c.sku)) c.description = gd
    }
  }

  // ── COHERENCE GATE (council 2026-07-03, Layer 2 of A+B) — ONE batched call per regen over ALL
  // final assembled titles (parent + per-child + single/couple), at the orchestrator level so the
  // per-design fan-out never multiplies LLM calls. Shadow by default: logs what it WOULD drop;
  // TITLE_COHERENCE_GATE=enforce promotes the veto once the PO has measured shadow precision.
  if ((!only || only === 'title') && finalTitle) {
    const gateItems: { id: string; title: string; designName?: string; mustInclude?: string; attributePin?: string }[] = [
      { id: '__parent', title: finalTitle, designName: unifiedSet && coupleConcept ? coupleConcept : (apparelMultiDesign ? undefined : designName), mustInclude: titleMustInclude, attributePin: attributePinFinal },
    ]
    if (perChildTitles?.length) {
      const seenTitles = new Set<string>()
      for (const pc of perChildTitles) {
        if (seenTitles.has(pc.title)) continue   // one entry per distinct title (a design group shares one)
        seenTitles.add(pc.title)
        gateItems.push({ id: `t${gateItems.length}`, title: pc.title, designName: pc.designName, mustInclude: titleMustInclude, attributePin: attributePinFinal })
      }
    }
    const gated = await coherenceGateTitles(input.openai, gateItems, onProgress)
    const parentGate = gated.get('__parent')
    if (parentGate) {
      if (parentGate.title !== finalTitle) finalTitle = parentGate.title
      titleProblems.push(...parentGate.droppedNotes)
    }
    for (const gi of gateItems) {
      if (gi.id === '__parent') continue
      const g = gated.get(gi.id)
      if (!g) continue
      titleProblems.push(...g.droppedNotes)
      if (g.title !== gi.title && perChildTitles) {
        for (const pc of perChildTitles) if (pc.title === gi.title) pc.title = g.title
      }
    }
  }

  // Per-child capacity titles — ONLY for non-apparel families whose children span >=2 distinct
  // capacities (e.g. SD cards 64/128/256GB). Researched Amazon best practice: each child must
  // carry its OWN capacity in the title; broadcasting one capacity to the others risks search
  // suppression. Apparel is excluded by apparelProduct AND never matches the capacity pattern,
  // so its title stays the single shared/broadcast value untouched. (perChildTitles declaration
  // hoisted to the title block above — multi-design apparel populates it there.)
  if (!apparelProduct && (!only || only === 'title')) {
    const childCap = new Map<string, string>()
    // Capacity from the SKU first (reliable — e.g. "...-32G-FBA"); the child's CURRENT title is
    // an unreliable fallback (it can be a templated/wrong title — part of why we're optimizing).
    for (const c of input.children) { const cap = capacityOf(c.sku) || capacityOf(c.title); if (cap) childCap.set(c.sku, cap) }
    if (new Set(childCap.values()).size >= 2) {
      const baseCap = capacityOf(finalTitle)
      perChildTitles = input.children.map((c) => {
        const cap = childCap.get(c.sku)
        if (!cap) return { sku: c.sku, asin: c.asin, title: finalTitle }
        let t = finalTitle
        if (baseCap && cap !== baseCap) t = finalTitle.replace(new RegExp(`\\b${baseCap}\\b`, 'gi'), cap)
        else if (!baseCap) t = finalTitle.replace(/^(\S+\s+\S+\s+\S+)/, `$1 ${cap}`)
        // Same 75-char hard cap as the shared title. The INSERTION path puts the capacity up front
        // (word 4) where a tail-trim can't reach it — but the SWAP path edits the token wherever the
        // base title carried it, which can be the tail. If the cap cut the capacity (the one thing
        // that differs per child — the task-#90 regression class), re-insert it up front and re-cap.
        let capped = capTitle75(t)
        const capEsc = cap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (!new RegExp(`\\b${capEsc}\\b`, 'i').test(capped)) {
          capped = capTitle75(capped.replace(/^(\S+\s+\S+\s+\S+)/, `$1 ${cap}`))
        }
        return { sku: c.sku, asin: c.asin, title: capped }
      })
    }
  }

  if (only === 'title') {
    // Degradation gate (2026-07-08): a quota-swallowed '' title must not overwrite the approved
    // one via the partial persist — highest-traffic partial, was the one unguarded path.
    assertCoreHealthy(input.openai, finalTitle, null, null)
    onProgress('Title regenerated.')
    return partialResult('title', {
      recommended_title: finalTitle,
      per_child_titles: perChildTitles,
      debug: { titleProblems, candidatesUsed: candidates.map((c) => c.keyword), titleRetried: retried, designName, designSource, multiDesign: designGroupInfo.isMultiDesign, designGroups: designGroupInfo.groups.map((g) => g.key), nicheSeeds: input.nicheSeeds ?? [], v4: v4Diffs },
    })
  }

  // Bullets pool (PR15): critical/upgrade/reinforce, not in title, no OFF-season (bullets are
  // customer-facing — a claim about a holiday this design is NOT about misleads and mis-describes
  // the product; the design's OWN occasion is its subject and belongs here), no awkward >5-word
  // composites, deduped. This is the same discipline the title gets.
  // This pool is ALSO the source the per-design fan-out narrows via scopeKwsToGroup, so migrating
  // it here reaches the per-child bullets that actually PATCH Amazon — not just the broadcast copy.
  const titleLc = finalTitle.toLowerCase()
  season.diff('bullets', analysis.map((k) => k.keyword))
  const remainingForBullets: AnalyzedKeyword[] = []
  for (const k of analysis) {
    if (!['CRITICAL', 'UPGRADE', 'REINFORCE'].includes(k.actionType)) continue
    // KEYWORD_TARGET_SET (#143): bullets carry only ranking targets, and never a BACKEND-slot one —
    // that slot exists precisely for terms customer-facing copy must not contain. Both no-ops at
    // off/shadow (targets.live === false).
    if (targets.live && wasEvaluated(k) && !isRankingTarget(k)) continue
    if (targets.live && k.selectionSlot === 'BACKEND') continue
    if (titleLc.includes(k.keyword.toLowerCase())) continue
    if (season.isOffSeason(k.keyword)) continue
    if (k.keyword.split(/\s+/).length > 5) continue
    if (remainingForBullets.some((d) => wordOverlapRatio(d.keyword, k.keyword) >= 0.6)) continue
    remainingForBullets.push(k)
  }
  // Highest-opportunity first so bullets 1-3 reinforce the true top keyphrases.
  remainingForBullets.sort((a, b) => b.coverageGapScore - a.coverageGapScore)

  // Stage 2 — Bullets
  // Capacity-family detection — used by the plan filter just below AND passed to the bullets
  // validator (PR #76) so the retry loop rejects bullets that hardcode a specific GB/TB/MB
  // when the family spans ≥2 capacities. Mirrors the agent prompt's own capacity rule but
  // enforces it through validation, not just instruction.
  const bulletCapTokens = new Set<string>()
  for (const c of input.children) {
    const cap = capacityOf(c.sku) || capacityOf(c.title)
    if (cap) bulletCapTokens.add(cap.toUpperCase())
  }
  const capacityFamilyTokens = bulletCapTokens.size >= 2 ? [...bulletCapTokens] : []

  // Opportunity pool for the bullets retry validator: top CRITICAL ∪ UPGRADE keywords (same
  // discipline title gets in Stage 0c, but for bullets we keep BOTH tiers since the bullets
  // scorer penalizes when 2+ CRITICAL-or-UPGRADE keywords are missing across all 5 bullets).
  // Sorted by opportunity, deduped against title (those don't count as bullet gaps).
  // Same season policy as the bullets pool above — and this set is ALSO persisted as keywordPlan.bullets,
  // which the SCORER reads (#92/#93). Migrating it keeps generator↔scorer parity: a keyword the bullets
  // may now carry is a keyword the plan may now demand.
  season.diff('bullets-opportunity-plan', cleanGated.filter((k) => k.actionType === 'CRITICAL' || k.actionType === 'UPGRADE').map((k) => k.keyword))
  // TARGETS ONLY. This set is persisted as keywordPlan.bullets and READ BACK by the scorer, so a
  // non-target here becomes a keyword the plan demands and the score docks for — reinstating the
  // unclearable dock through the back door. Generator and scorer must want the same 30.
  const topOppGated = targets.keep(cleanGated)
    .filter((k) => k.actionType === 'CRITICAL' || k.actionType === 'UPGRADE')
    .filter((k) => !season.isOffSeason(k.keyword))
    .filter((k) => k.keyword.split(/\s+/).length <= 6)   // match the scorer (no word cap on its set); 6 = title pin's safe ceiling
    .filter((k) => !titleLc.includes(k.keyword.toLowerCase()))   // already in title → not a bullet gap
    // Role-word keywords (e.g. "later gator TEACHER shirt") belong in BACKEND, not bullets: the bullet agent's
    // role-leak strip + the coverage backstop's safeKw both REFUSE to put a profession word in a bullet (no
    // "for teachers" claim). If such a keyword stays in this plan, the scorer (which reads it via keyword_plan,
    // #161) docks bullets for a term the bullets can NEVER carry → bullets can't reach max. Drop them here so
    // the plan == what the generator can actually place; they still rank via the backend pool. (adversarial gap)
    .filter((k) => {
      const toks = k.keyword.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
      return !toks.some((t) => ROLE_WORDS.has(t) && !titleLc.includes(t))
    })
    // CAPACITY keywords ("128 gb sd card") belong in PER-CHILD titles/backend, never in
    // broadcast bullets: the capacity validator + the backstop's safeKw REFUSE a hardcoded
    // GB/TB in bullets shared across 32/64/128GB variants (it would mis-describe the
    // siblings). Same trap as the role-word filter above — left in the plan, the scorer
    // (#161 reads it via keyword_plan) docks bullets for keywords the generator must
    // refuse: B0GCF11RKL froze at 17/25 AFTER shipping. Drop them so plan == placeable.
    .filter((k) => capacityFamilyTokens.length === 0 || !CAPACITY_RE.test(k.keyword))
    // Color sibling of the capacity rule above: broadcast bullets shared across a multi-color
    // apparel family must not demand one variant's color (B0FKLGWZ4C plan carried
    // "plain black tshirt men" for 82 colors). Per-child backend keeps the color terms.
    .filter((k) => !colorNeutralFamily || !BASIC_COLOR_RE.test(k.keyword))
  // Blend-brand VARIANT COLLAPSE: "comfort colors", "comfort colors tshirt", "comfort colors tee",
  // "comfort colors tshirt women" are the SAME blend brand — the bullet agent saw 5+ separate
  // "opportunities" for one phrase and stuffed it into every bullet (PO: "why is comfort colors
  // repeating so many times in bullets?"). Keep ONLY the shortest variant per blend base so the
  // brand is a single opportunity. The scorer reads this same set via keyword_plan (#92/#93), so
  // dropping the longer variants keeps generator↔scorer parity — no divergence.
  const BLEND_BASE_RE = /\b(?:comfort\s*colou?rs?|bella\s*canvas|gildan|next\s*level|american\s*apparel)\b/i
  const blendIdx = new Map<string, number>()   // squashed blend base -> index in topOppDeduped
  const topOppDeduped: typeof cleanGated = []
  for (const k of topOppGated) {
    const m = k.keyword.match(BLEND_BASE_RE)
    if (!m) { topOppDeduped.push(k); continue }
    const base = m[0].toLowerCase().replace(/\s+/g, '')
    const at = blendIdx.get(base)
    if (at == null) { blendIdx.set(base, topOppDeduped.length); topOppDeduped.push(k) }
    else if (k.keyword.length < topOppDeduped[at].keyword.length) topOppDeduped[at] = k
  }
  // dedupeBulletVariants at the SINGLE SOURCE (review blocker): this pool feeds BOTH the generator
  // (runBulletsAgent → oppPlusDesign/opportunityKwsSafe/backstop/validateBullets) AND the persisted
  // keywordPlan.bullets the SCORER reads. Deduping only inside runBulletsAgent desynced them — the
  // scorer would dock coverage for a garment/plural variant Layer-1 deleted from the generator. Dedup
  // BEFORE slice so we keep 10 DISTINCT concepts, and every consumer reads the identical universe.
  const topOpportunityKwsForBullets = dedupeBulletVariants(topOppDeduped
    .sort((a, b) => (b.coverageGapScore || 0) - (a.coverageGapScore || 0))
    .map((k) => k.keyword)).slice(0, 10)
  // ── Multi-design group scoping (parity-audit structural build 2026-07-03) ─────────────────────
  // PARTIAL-REGEN COHERENCE (#3/#9/#23): bullets/description/keywords-only regens skip the title
  // branch, so designGroupContexts stayed empty, every per-design fan-out was inert, and the push
  // then PREFERRED the untouched stale per_child_* sets over the freshly regenerated broadcast —
  // regenerated copy silently never reached the children. Rebuild the contexts CHEAPLY from the
  // STORED per-child titles (sku/designName/designKey were resolved and persisted at full-regen
  // time): no vision, no SP-API, no LLM re-resolution.
  // (only === 'title' already returned above, so `only` here means a bullets/description/keywords partial.)
  // !unifiedSet (review-caught): a couple/matching family deliberately keeps per_child_* UNDEFINED
  // (one shared set broadcast to both halves) — stale stored per_child_titles from a pre-unified-set
  // rec must not re-enable the per-design fan-outs; the coupleConcept restore below is its path.
  if (apparelMultiDesign && !unifiedSet && designGroupContexts.length === 0 && only && (input.priorPerChildTitles?.length ?? 0) > 0) {
    const byKey = new Map<string, { skus: { sku: string; asin: string }[]; title: string; designName: string }>()
    for (const r of input.priorPerChildTitles!) {
      const key = r.designKey || r.designName || ''
      if (!key) continue
      const g = byKey.get(key) ?? { skus: [], title: r.title, designName: r.designName ?? '' }
      g.skus.push({ sku: r.sku, asin: r.asin })
      byKey.set(key, g)
    }
    if (byKey.size >= 2) {
      designGroupContexts = [...byKey.entries()].map(([key, g]) => {
        const groupChildren = g.skus
          .map((s) => input.children.find((c) => c.sku === s.sku))
          .filter((c): c is NonNullable<typeof c> => Boolean(c))
        const groupRepTitle = groupChildren[0]?.title ?? input.repTitle ?? null
        return {
          skus: g.skus, designName: g.designName, title: g.title, key,
          groupInput: {
            ...input,
            canonicalTitle: groupRepTitle,
            repTitle: groupRepTitle ?? input.repTitle,
            designNameOverride: g.designName || null,
            children: groupChildren,
          },
        }
      })
      onProgress(`Rebuilt ${designGroupContexts.length} design groups from stored per-child titles...`)
      // Seed the stored per-design bullets so keywords/description partials ground each group on
      // its REAL bullets, not the broadcast prior (review). A bullets-only partial regenerates and
      // overwrites this seed via its own fan-out.
      if ((only === 'keywords' || only === 'description') && (input.priorPerChildBullets?.length ?? 0) > 0) {
        perChildBullets = input.priorPerChildBullets!
      }
    }
  }
  // A unified-set's couple concept is resolved only by the title branch — restore it from the
  // stored plan on partials so the broadcast anchor keeps naming the couple, not '' (audit #4).
  if (!coupleConcept && unifiedSet && input.priorCoupleConcept?.trim()) coupleConcept = input.priorCoupleConcept.trim()
  // CROSS-DESIGN POOL PARTITION (#2): a token unique to ANOTHER design's name is FOREIGN to this
  // group — a family-pool keyword carrying one must never be force-woven into this group's content
  // (the deterministic bullet backstop appended "argentina" into a Haiti child's bullet). Tokens
  // shared by >=2 design names are NICHE words ("fishing") and never foreign. Group scoping also
  // drops keywords the group's OWN title already covers — the family pools deduped against the
  // PARENT title, which the children don't carry.
  const groupNameToks = new Map(designGroupContexts.map((c) => [c.key, new Set(bulletTokens(c.designName).map(fillNormTok))]))
  const nameTokCounts = new Map<string, number>()
  for (const s of groupNameToks.values()) for (const t of s) nameTokCounts.set(t, (nameTokCounts.get(t) ?? 0) + 1)
  // NICHE-VOCABULARY EXEMPTIONS (review-caught, both directions):
  // - A token unique to ONE design's name can still be the family's niche word ("Fishing Trip" on
  //   a fishing family) — gutting the siblings' pools of it starves them. Tokens frequent in the
  //   FAMILY KEYWORD POOL (>=10% of keywords, min 3) or present in the family's title are niche.
  // - The old ">=2 design names ⇒ niche" rule resurrected the original bug the other way: two
  //   Argentina-variant designs among 12 made "argentina" free for the other 10. Now a token must
  //   appear in >=50% of the design names (min 2) to count as niche BY NAME-SHARING alone.
  const nicheExemptToks = new Set<string>()
  for (const t of bulletTokens(`${input.canonicalTitle ?? ''} ${input.priorTitle ?? ''}`).map(fillNormTok)) nicheExemptToks.add(t)
  {
    const tokKwCount = new Map<string, number>()
    for (const k of analysis) for (const t of new Set(bulletTokens(k.keyword).map(fillNormTok))) tokKwCount.set(t, (tokKwCount.get(t) ?? 0) + 1)
    const poolThresh = Math.max(3, Math.ceil(analysis.length * 0.1))
    for (const [t, c] of tokKwCount) if (c >= poolThresh) nicheExemptToks.add(t)
  }
  const nameShareThresh = Math.max(2, Math.ceil(groupNameToks.size * 0.5))
  const foreignToksFor = (key: string): Set<string> => {
    const own = groupNameToks.get(key) ?? new Set<string>()
    const foreign = new Set<string>()
    for (const [k2, s] of groupNameToks) {
      if (k2 === key) continue
      for (const t of s) {
        if (own.has(t) || nicheExemptToks.has(t)) continue
        if ((nameTokCounts.get(t) ?? 0) >= nameShareThresh) continue
        foreign.add(t)
      }
    }
    return foreign
  }
  // dropTitleCovered: bullets/description pools dedupe against the group's OWN title (token
  // coverage, not raw substring — "gator" inside "alligator" is NOT coverage; review-caught).
  // The BACKEND pool must NOT drop title-covered keywords: the PO-chosen hybrid deliberately
  // keeps the best title keyphrases in the backend core (review-caught).
  const scopeKwsToGroup = <T>(ctx: { key: string; title: string }, kws: T[], kwOf: (k: T) => string, dropTitleCovered = true): T[] => {
    const foreign = foreignToksFor(ctx.key)
    const titleToks = new Set(bulletTokens(ctx.title || '').map(fillNormTok))
    return kws.filter((k) => {
      const kw = kwOf(k)
      const ts = bulletTokens(kw).map(fillNormTok)
      if (dropTitleCovered && ts.length > 0 && ts.every((t) => titleToks.has(t))) return false
      return !ts.some((t) => foreign.has(t))
    })
  }

  // Phase 2 unified-set: the SHARED bullets/description anchor on the COUPLE CONCEPT (both design
  // names + "Couple Matching"), not the family-level designName — so the one broadcast set names the
  // whole set. Single-design families keep designName.
  // MULTI-DESIGN (parity-audit BLOCKER 2026-07-03): the broadcast set is what the PARENT HUB is
  // pushed and what any child falls back to — anchoring it on the family-level designName (resolved
  // from ONE rep child, e.g. "Argentina" on a 12-country family) forced one design's name into the
  // hub's bullets while buildNicheParentTitle deliberately bans design names from the hub's title.
  // Anchor on effectiveDesignName ('' for multi-design) so the broadcast stays niche-generic; the
  // per-design fan-out below supplies each group's own anchor via designGroupContexts.
  const broadcastDesignAnchor = unifiedSet && coupleConcept ? coupleConcept : (apparelMultiDesign ? effectiveDesignName : designName)
  const broadcastMotifTrust = unifiedSet && coupleConcept ? `${motifTrust} ${coupleConcept.toLowerCase()}` : motifTrust
  let bullets: string[]
  if (!only || only === 'bullets') {
    onProgress('Writing bullets...')
    const rawBullets = await runBulletsAgent(input, finalTitle, remainingForBullets, bulletAttrs, topOpportunityKwsForBullets, capacityFamilyTokens, compatibilityBrands, broadcastDesignAnchor)
    // Same vision-hallucination backstop as the title (motif words need seller corroboration),
    // plus the garment-type guard (no "fleece pullover" bullets on a t-shirt family) and the
    // hard-audience swap (no "this men's crew" on a Female-selected listing).
    bullets = apparelProduct
      ? rawBullets.map((b) => stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(b, broadcastMotifTrust), `${broadcastMotifTrust} ${input.productType ?? ''}`.toLowerCase(), broadcastMotifTrust), attributePinFinal ?? ''))
      : rawBullets
    if (apparelProduct && (lean === 'female' || lean === 'male')) {
      bullets = bullets.map((b) => enforceHardAudience(b, lean === 'female' ? 'Women' : 'Men'))
    }
    bullets = bullets.map((b) => fixDoubledArticleBeforeBrand(b, brandName))
    // PER-DESIGN BULLETS (additive): for a multi-design POD apparel family, generate a SEPARATE set
    // of bullets per design group (reusing the title loop's resolved group design name + vision via
    // designGroupContexts) and fan them out to every SKU in the group. The broadcast `bullets` above
    // is UNCHANGED — it stays the parent/fallback. Any failure here leaves perChildBullets undefined
    // so the broadcast bullets still ship. (Only runs on a FULL regen: a bullets-only partial skips
    // the title branch, so designGroupContexts is empty and this block is inert.)
    if (apparelMultiDesign && designGroupContexts.length) {
      try {
        const groupBulletSets = await Promise.all(designGroupContexts.map(async (ctx) => {
          // PER-GROUP resilience (parity-audit): one group's transient LLM failure must not discard
          // every OTHER group's per-design bullets — fail only this group back to the broadcast.
          try {
            // Group-scoped pools (#2): foreign-design keywords out, own-title-covered keywords out.
            const groupRemaining = scopeKwsToGroup(ctx, remainingForBullets, (k) => k.keyword)
            const groupTopOpp = scopeKwsToGroup(ctx, topOpportunityKwsForBullets, (k) => k)
            const raw = await runBulletsAgent(ctx.groupInput, ctx.title, groupRemaining, bulletAttrs, groupTopOpp, capacityFamilyTokens, compatibilityBrands, ctx.designName)
            // Mirror the broadcast strip chain EXACTLY, but ground motif-stripping on THIS group's own
            // design (parity with per-design titles, which recompute a group-scoped motifTrust in
            // buildTitleFor) — so a motif legit for THIS design isn't judged against the parent/other-
            // design grounding.
            const groupMotif = `${ctx.groupInput.canonicalTitle ?? ''} ${ctx.groupInput.repTitle ?? ''} ${ctx.designName}`.toLowerCase()
            let gb = raw.map((b) => stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(b, groupMotif), `${groupMotif} ${input.productType ?? ''}`.toLowerCase(), groupMotif), attributePinFinal ?? ''))
            if (lean === 'female' || lean === 'male') gb = gb.map((b) => enforceHardAudience(b, lean === 'female' ? 'Women' : 'Men'))
            gb = gb.map((b) => fixDoubledArticleBeforeBrand(b, brandName))
            // EMPTY = FAILED (adversarial 2026-07-08): the bullets council fails OPEN — a quota
            // outage returns [] without throwing, so the catch below never fires and an empty
            // per-design set would persist over the approved one (the same persist-empty class the
            // broadcast gate closes, one level down). Treat empty exactly like a thrown failure.
            if (!gb.some((b) => b && b.trim())) {
              console.warn(`[pipeline] per-design bullets came back EMPTY for "${ctx.designName}" — this group falls back to broadcast`)
              return { skus: ctx.skus, bullets, designName: ctx.designName, designKey: ctx.key }
            }
            return { skus: ctx.skus, bullets: gb, designName: ctx.designName, designKey: ctx.key }
          } catch (e) {
            console.warn(`[pipeline] per-design bullets failed for "${ctx.designName}" — this group falls back to broadcast:`, e instanceof Error ? e.message : e)
            return { skus: ctx.skus, bullets, designName: ctx.designName, designKey: ctx.key }
          }
        }))
        perChildBullets = []
        for (const gs of groupBulletSets) {
          for (const s of gs.skus) perChildBullets.push({ sku: s.sku, asin: s.asin, bullets: gs.bullets, designName: gs.designName, designKey: gs.designKey })
        }
      } catch (e) {
        console.warn('[pipeline] per-design bullets failed — falling back to broadcast bullets:', e instanceof Error ? e.message : e)
        perChildBullets = undefined
      }
    }
  } else {
    bullets = input.priorBullets ?? []
  }
  // Metric loop (D) — the per-child + broadcast bullets quality loops on BOTH the bullets-only
  // section-regen path (immediately below) and the full path. Apparel-only. The BULLETS_METRIC_LOOP
  // off-switch was retired 2026-08-03 (flag census; live env was unset = enabled).
  const enableBulletsLoop = apparelProduct
  if (only === 'bullets') {
    // Degradation gate (2026-07-08): empty council output must abort, not overwrite (this exact
    // path persisted [] over B0FRYMM56C's approved bullets during the quota outage).
    assertCoreHealthy(input.openai, null, bullets, null)
    // PATH-INVARIANT GATES (2026-07-10): the audit + fit truth gate the FULL path applies. Without
    // these, "Regenerate bullets" shipped an "oversized" fit contradiction, dropped the seller's own
    // blank brand, and returned thin unpolished copy (PO-caught). Empty-only abort already ran above.
    ;({ bullets } = await applyEditorialGates(bullets, ''))
    assertCoreHealthy(input.openai, null, bullets, null)   // audit must never blank the set
    // D (2026-07-17, dual-write-path parity #364): the metric-gated quality loop ALSO runs on this
    // "Regenerate bullets" section-regen so it hits the same ~85 bar as a full regen — per-child (each
    // design group looped once) + broadcast, BEFORE the gate so the looped bytes get the truth/audit scrub.
    bullets = await runBulletsMetricLoops(input.openai, bullets, perChildBullets, {
      title: finalTitle, brandName: brandName || 'THE CEO', designName: effectiveDesignName || '',
      fit: truthFitEarly, onProgress,
    }, enableBulletsLoop)
    // CONTENT_SPINE Step 3: the FULL path runs the terminal 150-floor bullets expander after the metric
    // loop; the bullets-only path never did, so a section-regen could ship broadcast bullets < 150. Wire
    // the SAME terminal net here. apparel-gated to match the full-path guard.
    if (apparelProduct && Array.isArray(bullets) && bullets.length === 5) {
      const spineCtx = { openai: input.openai, finalTitle, designName: effectiveDesignName || '', fit: truthFitEarly, brandName: brandName || 'THE CEO', garmentBrand: blankSpec?.brand, unisex: blankSpec?.unisex === true, weightNote: blankSpec?.weightNote, stretch: blankSpec?.stretch }
      bullets = await applyTerminalNets('bullets', bullets, spineCtx) as string[]
    }
    // Per-child multi-design bullets the push prefers now get the SAME gate (task #61) — closing the
    // former "per_child_bullets are ungated on both paths" gap. Deterministic scrub always; audit capped.
    await gatePerChildMultiDesign(perChildBullets, undefined, truthFitEarly, garmentBrandCanonical || '')
    onProgress('Bullets regenerated.')
    return partialResult('bullets', {
      recommended_bullets: bullets,
      // Partial coherence (#3/#23): the per-design fan-out now runs on bullets-only regens (contexts
      // rebuilt from stored per-child titles above), so ship the fresh per-child sets too — the push
      // prefers them, and leaving them stale silently discarded the regen for every child.
      per_child_bullets: perChildBullets,
      keywordPlan: { bullets: topOpportunityKwsForBullets, designName: effectiveDesignName, coupleConcept: coupleConcept || undefined, perDesign: designGroupContexts.length ? designGroupContexts.map((c) => ({ designKey: c.key, bullets: scopeKwsToGroup(c, topOpportunityKwsForBullets, (k) => k) })) : undefined , ...selectedPlanFields },
    })
  }

  // Stage 3 — Backend keywords. HYBRID (PO-chosen): include the TOP product keyphrases
  // (even ones in the title — utilize the best Jungle Scout terms) PLUS long-tail /
  // synonyms / occasion / seasonal. Whole coherent phrases, filled toward ~240 bytes.
  //
  // POOL COMPOSITION — the push-starvation trap (live 2026-06-12): coverageGapScore is
  // gap-AMPLIFIED (raw × usageGap 1-3), so the moment the seller PUSHES the keywords the
  // covered terms' scores collapse to raw/3 and flip toward OPTIMIZED ("fully covered").
  // Filtering OPTIMIZED out + sorting by the collapsed score made the FIRST regen after a
  // push draw from the uncovered dregs (opposite-gender terms the hard-lean strip then
  // deletes, junk long-tail) — B0FKLGWZ4C regenerated 131-byte identical token soup from a
  // 100-keyword universe. The optimizer must never treat its own placed keywords as
  // worthless: OPTIMIZED stays IN the backend pool (it IS the hybrid's "best JS terms"),
  // and the sort uses RAW market value (sales, then volume) which no push can deflate.
  // IRRELEVANT (noise-marked) stays excluded. Bullets/title pools keep gap-chasing —
  // placement decisions SHOULD prefer gaps; the backend hybrid should not.
  onProgress('Distributing backend keywords + writing description...')
  // KEYWORD_TARGET_SET (#143): target rank is the PRIMARY SORT KEY below, and the pool is NEVER
  // filtered. `targets.keep` here would cut it to 30 keywords, and the FULL pool only just reaches
  // the 240-250 byte band today — the result would land under the 220-byte hard floor, trip
  // backendDegradeGate, mark the section degraded and PRESERVE the prior string behind an HTTP 200.
  // A silent no-op regen. Targets lead so they claim bytes first; everything else still fills.
  const backendPool = analysis
    .filter((k) => ['CRITICAL', 'UPGRADE', 'REINFORCE', 'DEFENDED', 'OPTIMIZED'].includes(k.actionType))
    // HARD lean (#203 symmetry): the scorer no longer counts opposite-gender keywords as gaps —
    // the generator must not PLACE them either. Placing then post-stripping left orphaned
    // connectors mid-string ("…black t shirts for…" once "men" was removed).
    .filter((k) => {
      if (lean !== 'female' && lean !== 'male') return true
      const fem = /\bwom[ae]ns?\b|\bladies\b|\bfemale\b|\bgirls?\b/i.test(k.keyword)
      const masc = /\bm[ae]ns?\b|\bmale\b|\bboys?\b/i.test(k.keyword)
      return lean === 'female' ? !(masc && !fem) : !(fem && !masc)
    })
    .sort((a, b) =>
      // KEYWORD_TARGET_SET (#143) is the PRIMARY key — a target outranks a non-target regardless of
      // sales or volume, because it is a keyword we have actually decided to rank for. It must be
      // INSIDE this comparator, not a pre-sort: a preceding .sort() is fully overridden by this one
      // for every pair the comparator can order, so a pre-pass would have been silently inert.
      // Returns 0 for every pair at off/shadow, leaving the legacy ordering byte-identical.
      targetRankGap(targets, a, b) ||
      // BACKEND_CRITICAL_KEYWORDS: CRITICAL search terms claim backend bytes before generic gift filler
      // (spain jersey 416K has ~0 historical sales as a new 2026 term, so sales-primary sort buried it).
      // CRITICAL decays to OPTIMIZED once pushed, so this self-releases — the push-starvation defense
      // documented above stays intact.
      (BACKEND_CRIT_ON ? ((b.actionType === 'CRITICAL' ? 1 : 0) - (a.actionType === 'CRITICAL' ? 1 : 0)) : 0) ||
      (b.keywordSales || 0) - (a.keywordSales || 0) ||
      (b.searchVolume || 0) - (a.searchVolume || 0) ||
      b.coverageGapScore - a.coverageGapScore)

  // FALLBACK CHAIN — Part 3, "then use the keyword POOL" (PO 2026-07-18: keywords → council logic → pool).
  // A thin-niche listing's own analysis pool can't fill the 250-byte backend budget with unique clean
  // terms (it maxes ~209 → the PO's "missing 30-40 bytes"). Append the cross-listing niche SEED POOL
  // (keyword_seed_pool — the SAME store the TITLE fallback pulls from at ~6595-6611) as an OVERFLOW source:
  // appended LAST so it's consumed only after the primary pool is exhausted, trademark/off-niche/foreign
  // pre-gated here, and every term still faces fillBackendToBudget's banBackendTok + echo/dedup rails. This
  // gives backend the SAME 3-source fallback the title already has. Fail-open (any error leaves the pool as-is).
  const backendSeedExtras: string[] = []
  try {
    // UNIVERSAL KEYWORD POOL overflow (PO: "keywords → council logic → keyword POOL"). The council + fill
    // draw from the listing's OWN top-analysis pool (getStoredAnalysis ~150), which a thin single-design
    // niche exhausts ~200 bytes — short of the 240-250 budget. The overflow source is the shared seed pool
    // (keyword_seed_pool). Keys queried:
    //  • MULTI-design: the family design-name override (as before — why multi-design already hits budget).
    //  • SINGLE-design: the VISION niche universes, keyed by the SAME deriveNicheSeeds phrasing the research
    //    wire (keywordResearcher) stores them under — so the keys MATCH. This is the wire that finally lets
    //    a single design (empty override) reach the universal pool. Needs visionDesign.suggestedSearchTerms
    //    (now threaded through from the route) for deriveNicheSeeds to reproduce the stored keys.
    // Fail-open; every term trademark/off-niche/foreign gated + deduped; appended LAST (true overflow).
    const overflowKeys = new Set<string>()
    const ov = (input.designNameOverride ?? '').trim()
    if (ov) overflowKeys.add(normalizeSeedKey(ov))
    for (const s of deriveNicheSeeds(input.visionDesign, designName || broadcastDesignAnchor || '', 6)) {
      const k = normalizeSeedKey(s); if (k) overflowKeys.add(k)
    }
    const seen = new Set<string>()
    for (const k of overflowKeys) {
      if (!k) continue
      const sp = await getSeedPool(k)
      if (!sp) continue
      for (const kw of [...sp.keywords].sort((a, b) => (b.searchVolume || 0) - (a.searchVolume || 0)).slice(0, 30)) {
        const s = scrubTrademarks(kw.keyword).trim().toLowerCase()
        if (s && !seen.has(s) && findTrademarkPhrases(s).length === 0 && notOffNiche(s) && !isForeignKeyword(s)) { seen.add(s); backendSeedExtras.push(s) }
      }
    }
    if (backendSeedExtras.length) console.log(`[BACKEND] universal-pool overflow: +${backendSeedExtras.length} phrases from ${overflowKeys.size} universe key(s) [${[...overflowKeys].join(', ')}]`)
  } catch (e) { console.warn('[BACKEND] universal-pool overflow failed (non-fatal):', e instanceof Error ? e.message : e) }
  // The backend fill's overflow keyword list = the listing's own pool THEN the shared universal pool.
  const backendKeywordPool = backendSeedExtras.length
    ? [...backendPool.map((k) => k.keyword), ...backendSeedExtras]
    : backendPool.map((k) => k.keyword)

  // TOKEN TRUTH GATE for every word that enters a backend string (core, LLM fill, byte-fill) —
  // the deterministic "council" the PO asked for ("Super BAD keywords — how did the council
  // approve this?"). Bans: stray single letters from "t-shirt" splits; OTHER variants' colors
  // on a multi-color family (each child's own color arrives via its per-color tail); style/cut/
  // garment claims the seller's own text doesn't corroborate (cropped/pocket/boxy/oversized/
  // plain/blank on a regular-cut printed tee — JS category phrases describe the NICHE, not this
  // product); hard-lean opposite-gender tokens. The design-name anchor is exempt (identity).
  const backendTruthHay = `${input.canonicalTitle ?? ''} ${repTitle} ${designName} ${(input.productType ?? '').replace(/_/g, ' ')}`.toLowerCase()
  // Amazon's search-terms guideline is explicit on BOTH of these (Seller Central, "Use search
  // terms effectively"): no brand names — not even your own (the brand attribute already indexes
  // it; the canonical-bigram byte-fill was appending "the ceo" to every child — PO: "WHY does it
  // add our Brand name to the Keywords?") — and no stop words (Amazon ignores them in queries;
  // every one wastes bytes a real term could use). The ban is UNCONDITIONAL (2026-07-08, PO-
  // approved): the old design-token exemption re-admitted "ceo" whenever the design name contained
  // the brand word ("CEO? He's Golfing") — but a "ceo golfing shirt" query still matches via the
  // brand-attribute token + the backend's design tokens; Amazon matches a token bag across
  // indexed fields, so the brand byte buys nothing even inside the design phrase.
  const AMZ_BACKEND_STOPWORDS = new Set(['a', 'an', 'and', 'by', 'for', 'of', 'the', 'with'])
  const brandToksForBackend = ownBrandTokenSet(brandName)
  // POOL-BACKED EXEMPTION (PO-approved 2026-07-09): tokens from the DEMAND pool (SQP/JS — shoppers
  // already reach this ASIN through those queries) pass the garment/style/filler gates. Backend is
  // invisible search indexing, not a customer-facing claim — the same principle as the role-word
  // rule in the core. The strict gates were banning MEASURED demand: "blouses" (705K/mo category
  // phrase) and "oversized" (636K/mo combined; the 1717 blank is commonly worn oversized — PO).
  // LLM-invented and title-derived tokens still face the full gates — those are guesses, not data.
  // UNCONDITIONAL bans stay unconditional: brand (attribute-indexed), stopwords, single letters,
  // sibling colors (each child's own color arrives via its tail), hard-lean opposite gender (PO:
  // a FEMALE item stays female; "Lean Female" never entered these strips).
  const poolToksForBackend = new Set<string>()
  for (const k of backendPool) {
    for (const w of k.keyword.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) if (w) poolToksForBackend.add(w)
  }
  const banBackendTok = (w: string): boolean => {
    if (w.length === 1 && !/\d/.test(w)) return true
    if (AMZ_BACKEND_STOPWORDS.has(w)) return true
    if (FOREIGN_FUNCTION_WORDS.has(w)) return true   // ES/PT function words carry no search value (2026-07-09)
    if (isCelebrityToken(w)) return true             // living person's name — never in a published field (2026-07-21 lamine)
    if (BACKEND_GENERIC_FILLER.has(w) && !poolToksForBackend.has(w)) return true   // catalog-speak — unless the demand data says buyers type it
    if (brandToksForBackend.has(w)) return true
    if (colorNeutralFamily && BASIC_COLOR_RE.test(w)) return true
    // GARMENT_TYPE_WORDS (polo/tank/blouse/…) flip the product IDENTITY, so a garment word may appear
    // ONLY when the PRODUCT'S OWN TRUTH corroborates it — pool membership must NOT license it. The broad
    // "graphic tees for women" universe drags "polo" into the pool, which then rode past this ban via the
    // old `!poolToks` exemption (PO 2026-07-19: "polo" in a graphic-tee backend). STYLE_CUT_WORDS keep the
    // pool exemption — a cut/style term (e.g. "oversized") is a real demand signal, not an identity flip.
    if (GARMENT_TYPE_WORDS.has(w) && !new RegExp(`\\b${w}\\b`, 'i').test(backendTruthHay)) return true
    if (STYLE_CUT_WORDS.has(w) && !poolToksForBackend.has(w) && !new RegExp(`\\b${w}\\b`, 'i').test(backendTruthHay)) return true
    if (lean === 'female' && /^(?:men|mens|man|male|boys?)$/i.test(w)) return true
    if (lean === 'male' && /^(?:women|womens|woman|ladies|female|girls?)$/i.test(w)) return true
    return false
  }
  // Tokens Amazon ALREADY indexes for a listing (live title + bullets + brand + color attribute),
  // normTok'd to match fillBackendToBudget's comparison. The byte-fill must not re-add them (echo
  // removal, PO-approved 2026-07-08). Design tokens exempted — the design phrase is identity and
  // deliberately leads the core.
  const normIdxTok = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  // 2026-07-13 (#69): bullets are DELIBERATELY excluded from alreadyIndexed. Backend is the sanctioned
  // home for opportunity-keyword coverage (Content step 2, PO-approved) — so a token that appears in a
  // bullet MUST still be free to land in backend. The `blts` param is retained for signature stability
  // (4 callers), but ignored on purpose. Title + brand + sibling colors DO stay stripped — title-echo
  // wastes bytes on the strongest-ranking field (PO 2026-07-08); colors are per-variant tails; brand is
  // Amazon-attribute-indexed. Design tokens are exempted (identity mandate).
  const mkAlreadyIndexed = (title: string, _blts: string[], dn?: string): Set<string> => {
    const s = new Set<string>()
    for (const t of `${title} ${brandName}`.split(/\s+/)) { const n = normIdxTok(t); if (n) s.add(n) }
    for (const c of input.children) { const n = normIdxTok(c.color || ''); if (n) s.add(n) }
    for (const t of (dn ?? (effectiveDesignName || designName || '')).split(/\s+/)) s.delete(normIdxTok(t))
    // BACKEND_CRITICAL_KEYWORDS: mirror the title-echo CRITICAL exemption on the byte-fill echo set so
    // fillBackendToBudget can re-add CRITICAL search terms (spain/jersey/cup) instead of skipping them as
    // alreadyIndexed. Uses the family backendPool (echo-set only; groupBan + siblingNameToks still enforce
    // per-design fill safety), so an over-exemption here cannot cross a design's real content.
    if (BACKEND_CRIT_ON) {
      for (const k of backendPool) if (k.actionType === 'CRITICAL') for (const t of k.keyword.split(/\s+/)) s.delete(normIdxTok(t))
    }
    // TITLE_MONEY_TAIL echo exemption (adversarial LOW, 2026-08-09): once the flag is ON, the
    // STORED title can carry the welded money keyword — on a later keywords-only regen that title
    // arrives as priorTitle and its tokens land in this echo set, stripping the money keyword from
    // the byte-fill. If the PO then pushes keywords WITHOUT the title, the keyword lives in
    // neither field (the backend-title-echo class). Same doctrine as the CRITICAL exemption above
    // (SELLER_PROFILE §5: money keywords are exempt from title-echo dedup); mode-gated so
    // off/shadow stay byte-identical.
    if (moneyTailMode === 'on') {
      for (const kw of titleMoneyKws) for (const t of kw.split(/\s+/)) s.delete(normIdxTok(t))
    }
    return s
  }
  // ── PER-DESIGN BACKEND (parity-audit BLOCKER #12, + #13/#14) ──────────────────────────────────
  // One family-level backend core was biased to the rep design's keyword pool and shipped to EVERY
  // design's children. Fan out per design group: group-scoped pool (foreign design tokens dropped),
  // group-grounded truth hay for the style/garment ban (#14: design A's "Distressed" no longer
  // licenses the claim for design B), the group's OWN title/bullets for the dedupe (#13), and
  // per-group byte-fill. Returns null when the family is not per-design (caller falls back to the
  // family-level agent). throwOnGroupFailure: keywords-only regen has exactly one job (honest
  // failure); the full regen degrades per-group (failed group's SKUs keep previous keywords).
  const runBackendPerDesign = async (throwOnGroupFailure: boolean): Promise<PipelinePerChildKeywords[] | null> => {
    if (!(apparelMultiDesign && designGroupContexts.length)) return null
    const ownB = ownBrandTokenSet(brandName)
    const sets = await Promise.all(designGroupContexts.map(async (ctx) => {
      try {
        // dropTitleCovered=false — the PO-chosen backend HYBRID keeps title keyphrases in the core.
        const groupPool = scopeKwsToGroup(ctx, backendPool, (k) => k.keyword, false)
        const groupHay = `${ctx.groupInput.canonicalTitle ?? ''} ${ctx.groupInput.repTitle ?? ''} ${ctx.designName} ${(input.productType ?? '').replace(/_/g, ' ')}`.toLowerCase()
        // Own-brand ban unconditional here too (2026-07-08) — same rationale as banBackendTok.
        const groupBrandToks = ownBrandTokenSet(brandName)
        // Pool-backed exemption scoped to THIS group's demand pool (PO-approved 2026-07-09) —
        // same principle as poolToksForBackend, but a foreign design's pool can't license tokens here.
        const groupPoolToks = new Set<string>()
        for (const k of groupPool) {
          for (const w of k.keyword.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) if (w) groupPoolToks.add(w)
        }
        // SIBLING-DESIGN BLEED (PO 2026-07-19: "not per design"): the OTHER designs' distinctive NAME
        // tokens must not ride into THIS design's backend ("beast mode"/"real king" inside the Relax
        // design). Sibling tokens = every other group's design-name tokens MINUS this group's own, so a
        // token shared by this design (or a family term this design also carries) is never banned here.
        const siblingNameToks = new Set<string>()
        for (const [k, toks] of groupNameToks) if (k !== ctx.key) for (const t of toks) siblingNameToks.add(t)
        for (const t of (groupNameToks.get(ctx.key) ?? new Set<string>())) siblingNameToks.delete(t)
        const groupBan = (w: string): boolean => {
          if (w.length === 1 && !/\d/.test(w)) return true
          if (AMZ_BACKEND_STOPWORDS.has(w)) return true
          if (FOREIGN_FUNCTION_WORDS.has(w)) return true   // ES/PT function words carry no search value (2026-07-09)
          if (BACKEND_GENERIC_FILLER.has(w) && !groupPoolToks.has(w)) return true   // catalog-speak — unless the demand data says buyers type it
          if (groupBrandToks.has(w)) return true
          // A sibling design's own name token — drop it unless THIS group's product truth also carries it.
          if (siblingNameToks.has(fillNormTok(w)) && !new RegExp(`\\b${w}\\b`, 'i').test(groupHay)) return true
          if (colorNeutralFamily && BASIC_COLOR_RE.test(w)) return true
          // Garment identity words: only if THIS group's product truth corroborates it — never via pool
          // membership (the "polo" leak). Style/cut words keep the group-pool demand exemption.
          if (GARMENT_TYPE_WORDS.has(w) && !new RegExp(`\\b${w}\\b`, 'i').test(groupHay)) return true
          if (STYLE_CUT_WORDS.has(w) && !groupPoolToks.has(w) && !new RegExp(`\\b${w}\\b`, 'i').test(groupHay)) return true
          if (lean === 'female' && /^(?:men|mens|man|male|boys?)$/i.test(w)) return true
          if (lean === 'male' && /^(?:women|womens|woman|ladies|female|girls?)$/i.test(w)) return true
          return false
        }
        const repSku = ctx.skus[0]?.sku
        const groupBullets = perChildBullets?.find((c) => c.sku === repSku)?.bullets ?? bullets
        let rows = await runBackendAgent(ctx.groupInput, ctx.title, groupBullets, groupPool, ctx.designName, groupBan)
        // Strip BEFORE fill (2026-07-08): the fill's own banTok already blocks opposite-gender
        // additions, and stripping first lets the fill reuse the freed bytes.
        if (lean === 'female' || lean === 'male') rows = rows.map((p) => ({ ...p, keywords: stripOppositeGenderTokens(p.keywords, lean) }))
        const groupIndexed = mkAlreadyIndexed(ctx.title, groupBullets, ctx.designName)
        // coverageHay = TITLE only (#69, 2026-07-13): Step-4's fold-aware echo gate MUST compare a
        // garment-noun candidate against the title (which stably indexes the product type), not against
        // bullets — bullets are transient prose and their "graphic"/"gift"/etc. would wrongly block
        // high-volume opportunity phrases from ever landing in backend where Content step 2 needs them.
        rows = rows.map((p) => ({ ...p, keywords: fillBackendToBudget(stripCapabilityClaims(p.keywords, input.customizable === true), ctx.groupInput.canonicalTitle, groupPool.map((k) => k.keyword), ownB, capacityFamilyTokens.length >= 2, composeCapabilityBan(groupBan, input.customizable === true), groupIndexed, topVolumeBackendPhrases(groupPool), ctx.title, blankSpecFactTokens(blankSpec).concat(input.customizable ? ['personalized custom'] : [])) }))
        return rows
      } catch (e) {
        if (throwOnGroupFailure) throw e
        console.warn(`[pipeline] per-design backend failed for "${ctx.designName}" — its SKUs keep their previous keywords:`, e instanceof Error ? e.message : e)
        return [] as PipelinePerChildKeywords[]
      }
    }))
    const rows = sets.flat()
    // COVERAGE GUARANTEE (review-caught BLOCKER): children in NO design group (added after the
    // last full regen, keyless stored rows, group-resolution drift) previously vanished from the
    // per-child keyword set — and keywords has NO broadcast fallback, so those SKUs would never
    // get keywords pushed again. Generate the remainder via the family-level agent.
    const covered = new Set(rows.map((r) => r.sku))
    const uncovered = input.children.filter((c) => !covered.has(c.sku))
    if (uncovered.length > 0) {
      onProgress(`Covering ${uncovered.length} ungrouped SKU(s) via the family-level backend...`)
      try {
        const restInput: PipelineInput = { ...input, children: uncovered }
        let rest = await runBackendAgent(restInput, finalTitle, bullets, backendPool, broadcastDesignAnchor, banBackendTok)
        if (lean === 'female' || lean === 'male') rest = rest.map((p) => ({ ...p, keywords: stripOppositeGenderTokens(p.keywords, lean) }))
        // broadcastDesignAnchor, NOT the default (adversarial): the agent above was anchored on it —
        // defaulting to the REP design's name would exempt design A's tokens on design B's children,
        // re-introducing the cross-design pollution the per-design fan-out (#12) removed.
        const restIndexed = mkAlreadyIndexed(finalTitle, bullets, broadcastDesignAnchor)
        rest = rest.map((p) => ({ ...p, keywords: fillBackendToBudget(stripCapabilityClaims(p.keywords, input.customizable === true), input.canonicalTitle, backendKeywordPool, ownB, capacityFamilyTokens.length >= 2, composeCapabilityBan(banBackendTok, input.customizable === true), restIndexed, topVolumeBackendPhrases(backendPool), finalTitle, blankSpecFactTokens(blankSpec).concat(input.customizable ? ['personalized custom'] : [])) }))
        rows.push(...rest)
      } catch (e) {
        if (throwOnGroupFailure) throw e
        console.warn(`[pipeline] family-level remainder backend failed — ${uncovered.length} SKU(s) keep their previous keywords:`, e instanceof Error ? e.message : e)
      }
    }
    return rows
  }
  // ── PER-DESIGN DESCRIPTION fan-out — shared by the full regen AND description-only partials
  // (#9: description-only never refreshed per-design descriptions while the push preferred them).
  // Per-group resilience: a failed group falls back to the broadcast description alone.
  const fanOutPerDesignDescriptions = async (broadcastDesc: string): Promise<typeof perChildDescriptions> => {
    if (!(apparelMultiDesign && designGroupContexts.length)) return undefined
    const sets = await Promise.all(designGroupContexts.map(async (ctx) => {
      try {
        const repSku = ctx.skus[0]?.sku
        const groupBullets = perChildBullets?.find((c) => c.sku === repSku)?.bullets ?? bullets
        // useCouncil:false — runs once PER design group inside a Promise.all; N parallel GPT-5
        // councils would be cost/latency-prohibitive. Only the broadcast description gets the council.
        // descAttrs (real facts, no search phrases) + [] opportunity kws — same clean-prose rule as broadcast.
        const raw = await runDescriptionAgent(ctx.groupInput, ctx.title, groupBullets, descAttrs, compatibilityBrands, [], false)
        const groupMotif = `${ctx.groupInput.canonicalTitle ?? ''} ${ctx.groupInput.repTitle ?? ''} ${ctx.designName}`.toLowerCase()
        // 3rd arg = sellerGarmentText (parity-audit #8: it was missing, so the heavy-garment-
        // stuffing guard never fired for per-design descriptions).
        let gd = stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(raw, groupMotif), `${groupMotif} ${input.productType ?? ''}`.toLowerCase(), groupMotif), attributePinFinal ?? '')
        if (lean === 'female' || lean === 'male') gd = enforceHardAudience(gd, lean === 'female' ? 'Women' : 'Men')
        gd = fixDoubledArticleBeforeBrand(gd, brandName)
        gd = polishDescription(gd, ctx.designName, brandName)
        // EMPTY = FAILED (adversarial 2026-07-08): symmetric with the per-design bullets guard.
        // This leg throws on a hard error today (useCouncil:false), but an empty string slipping
        // through post-processing must fall back to broadcast, never persist.
        if (!gd.trim()) {
          console.warn(`[pipeline] per-design description came back EMPTY for "${ctx.designName}" — this group falls back to broadcast`)
          return { skus: ctx.skus, description: broadcastDesc, designName: ctx.designName, designKey: ctx.key }
        }
        // Floor net + cap on the per-design bytes (Phase 6; live 2026-07-31 B0F6QZ34B1: the strips
        // above took designs 2/3 to 889/877 under the 900 floor while the broadcast passed at 955 —
        // census PER_CHILD_DESC_UNDER_FLOOR). Same shared net the broadcast runs (idempotent no-op
        // when in band; logs DESC_REEXPAND_MISS on failure); INSIDE the fan-out so BOTH callers
        // (full + description-only partial) are covered by construction. ≤1 LLM call per
        // under-floor DESIGN, never per child.
        if (brandName) gd = await reExpandDescriptionIfShort(input.openai, gd, { finalTitle: ctx.title, brand: brandName, garmentBrand: blankSpec?.brand })
        gd = capDescriptionVisible(gd)
        return { skus: ctx.skus, description: gd, designName: ctx.designName, designKey: ctx.key }
      } catch (e) {
        console.warn(`[pipeline] per-design description failed for "${ctx.designName}" — this group falls back to broadcast:`, e instanceof Error ? e.message : e)
        return { skus: ctx.skus, description: broadcastDesc, designName: ctx.designName, designKey: ctx.key }
      }
    }))
    const out: NonNullable<typeof perChildDescriptions> = []
    for (const ds of sets) for (const s of ds.skus) out.push({ sku: s.sku, asin: s.asin, description: ds.description, designName: ds.designName, designKey: ds.designKey })
    return out
  }
  // #79 partial runs: exactly one of the pair, anchored on the stored title+bullets.
  if (only === 'keywords') {
    const ownB = ownBrandTokenSet(brandName)
    const finishBackend = (rows: PipelinePerChildKeywords[]): PipelinePerChildKeywords[] => {
      // Strip BEFORE fill (2026-07-08): fill's banTok already blocks opposite-gender additions;
      // stripping first lets the fill reuse the freed bytes. alreadyIndexed = echo removal.
      let out = rows
      if (lean === 'female' || lean === 'male') {
        out = out.map((p) => ({ ...p, keywords: stripOppositeGenderTokens(p.keywords, lean) }))
      }
      // broadcastDesignAnchor (adversarial): parity with the agent's anchor — see the rest path.
      const idx = mkAlreadyIndexed(finalTitle, bullets, broadcastDesignAnchor)
      out = out.map((p) => ({
        ...p,
        keywords: fillBackendToBudget(stripCapabilityClaims(p.keywords, input.customizable === true), input.canonicalTitle, backendKeywordPool, ownB, capacityFamilyTokens.length >= 2, composeCapabilityBan(banBackendTok, input.customizable === true), idx, topVolumeBackendPhrases(backendPool), finalTitle, blankSpecFactTokens(blankSpec).concat(input.customizable ? ['personalized custom'] : [])),
      }))
      return out
    }
    // Per-design first (#12): contexts exist on keywords-only regens too now (rebuilt from stored
    // per-child titles). Rows arrive group-filled — do NOT re-run the family-level byte-fill on
    // them (it would re-introduce cross-design pool terms). One retry on BOTH paths (review: the
    // per-design path previously threw with zero retries — a reliability regression vs family).
    const runBackendOnce = async (): Promise<PipelinePerChildKeywords[]> =>
      (await runBackendPerDesign(true)) ?? finishBackend(await runBackendAgent(input, finalTitle, bullets, backendPool, broadcastDesignAnchor, banBackendTok))
    let perChildOnly: PipelinePerChildKeywords[]
    try {
      perChildOnly = await runBackendOnce()
    } catch {
      onProgress('Backend regen hiccuped — retrying…')
      perChildOnly = await runBackendOnce()
    }
    let problems = backendOutputProblems(perChildOnly, input.children, apparelProduct)
    if (problems.length > 0) {
      // One retry — the failures here are transient LLM truncations/hiccups, not logic.
      onProgress('Backend output looked degraded — retrying…')
      perChildOnly = await runBackendOnce()
      problems = backendOutputProblems(perChildOnly, input.children, apparelProduct)
    }
    if (problems.length > 0) {
      // HONEST FAILURE (a keywords-only regen has exactly one job): refuse to persist
      // degraded strings. Throwing aborts before the partial-persist step, so the seller's
      // previous keywords stay exactly as approved. aiKind tag → the UI shows the amber
      // "content preserved" banner (or names quota if the client recorded a hard error).
      const hard = (input.openai as { __aiHardError?: string }).__aiHardError
      const e = new Error(`Backend keyword regen came back degraded (${problems.join('; ')}). Your previous keywords are untouched — run Regenerate backend again in a minute.`) as Error & { aiKind?: string }
      e.aiKind = hard ?? 'degraded'
      throw e
    }
    onProgress('Backend keywords regenerated.')
    return partialResult('keywords', { per_child_keywords: perChildOnly })
  }
  if (only === 'description') {
    let descriptionOnly = await runDescriptionAgent(input, finalTitle, bullets, descAttrs, compatibilityBrands, [])
    // broadcastMotifTrust (review-caught): the plain motifTrust stripped a unified-set's couple
    // design names on description-only partials, where the full regen deliberately preserves them.
    if (apparelProduct) descriptionOnly = stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(descriptionOnly, broadcastMotifTrust), `${broadcastMotifTrust} ${input.productType ?? ''}`.toLowerCase(), broadcastMotifTrust), attributePinFinal ?? '')
    if (apparelProduct && (lean === 'female' || lean === 'male')) descriptionOnly = enforceHardAudience(descriptionOnly, lean === 'female' ? 'Women' : 'Men')
    descriptionOnly = fixDoubledArticleBeforeBrand(descriptionOnly, brandName)
    descriptionOnly = polishDescription(descriptionOnly, broadcastDesignAnchor, brandName)
    // Degradation gate (2026-07-08): same abort-not-overwrite as bullets/title. Runs BEFORE the
    // per-design fan-out (adversarial: an empty broadcast during an outage was firing one doomed
    // LLM call per design group before aborting — wasted spend in the exact failure the gate covers).
    assertCoreHealthy(input.openai, null, null, descriptionOnly)
    // PATH-INVARIANT GATES (2026-07-10): the editorial audit + fit truth gate the FULL path applies.
    // `bullets` here are the STORED priors — the audit needs them for context and returns them
    // unchanged for us (we take only the description back). Fail-open; empty-only abort re-checked.
    ;({ description: descriptionOnly } = await applyEditorialGates(bullets, descriptionOnly))
    assertCoreHealthy(input.openai, null, null, descriptionOnly)
    // CONTENT_SPINE Step 3: the FULL path runs scrubDescriptionBody + reExpandDescriptionIfShort on the
    // BROADCAST description; the description-only path never did (only per-child got them via the gate),
    // so a section-regen could ship brand-in-body / "screen-printed" / sub-900 broadcast copy. Wire the
    // SAME terminal net here, before the per-design fan-out and the existing capDescriptionVisible below.
    {
      const spineCtx = { openai: input.openai, finalTitle, designName: effectiveDesignName || '', fit: truthFitEarly, brandName: brandName || 'THE CEO', garmentBrand: blankSpec?.brand, unisex: blankSpec?.unisex === true, weightNote: blankSpec?.weightNote, stretch: blankSpec?.stretch }
      if (descriptionOnly && brandName) {
        descriptionOnly = await applyTerminalNets('description', descriptionOnly, spineCtx) as string
      }
    }
    // Partial coherence (#9): refresh the per-design descriptions the push actually prefers —
    // previously only the broadcast updated and the regenerated copy never reached the children.
    // Runs AFTER the gates so the single-design BROADCAST copy is gated.
    perChildDescriptions = await fanOutPerDesignDescriptions(descriptionOnly)
    // Per-child multi-design descriptions the push prefers now get the SAME gate (task #61) — they are
    // fit-scrubbed + brand-cased (and audited when budget allows), closing the former both-paths gap.
    await gatePerChildMultiDesign(undefined, perChildDescriptions, truthFitEarly, garmentBrandCanonical || '')
    // FINAL length cap on the SHIPPED bytes: applyEditorialGates + fanOutPerDesignDescriptions above are LLM
    // rewrites that can re-expand past 980 (the "1600-char description" regression) — re-cap broadcast + each
    // per-child so the shipped description is always Amazon-lean, not just runDescriptionAgent's interim output.
    descriptionOnly = capDescriptionVisible(descriptionOnly)
    if (perChildDescriptions) perChildDescriptions = perChildDescriptions.map((c) => ({ ...c, description: capDescriptionVisible(c.description) }))
    onProgress('Description regenerated.')
    return partialResult('description', { recommended_description: descriptionOnly, per_child_descriptions: perChildDescriptions })
  }
  // Backend and description BOTH depend on (title, bullets) but NOT on each other —
  // identical prompts and inputs as before, just issued concurrently. Quality-neutral
  // speed-up (PO gate): only genuinely independent calls overlap; the council stages
  // (proposers → adversary → judge) stay sequential because their order IS the quality.
  // Per-design backend first (#12) — inside the SAME concurrent pair so single-design keeps the
  // backend/description overlap (runBackendPerDesign returns null instantly for single-design).
  let usedPerDesignBackend = false
  let [perChild, descriptionRaw] = await Promise.all([
    (async () => {
      const pd = await runBackendPerDesign(false)
      if (pd) { usedPerDesignBackend = true; return pd }
      return await runBackendAgent(input, finalTitle, bullets, backendPool, broadcastDesignAnchor, banBackendTok)
    })(),
    runDescriptionAgent(input, finalTitle, bullets, descAttrs, compatibilityBrands, []),
  ])
  // Fill each child toward the 250-byte budget (seller's canonical descriptors first —
  // "country western" — then leftover pool keywords), THEN the hard-lean gender strip
  // so the strip cleans additions too.
  // extraBan (2026-08-08, audit-drop re-fill): lets the post-audit re-fill ban the exact tokens the
  // editorial audit just dropped, so the deterministic fill cannot re-add audited-out junk.
  const finishBackendFull = (rows: PipelinePerChildKeywords[], extraBan?: (w: string) => boolean): PipelinePerChildKeywords[] => {
    const ownB = ownBrandTokenSet(brandName)
    // HARD audience FIRST (2026-07-08 reorder): strip the opposite gender's standalone tokens
    // (PO caught "…darlin mens black men…" persisting on a Female listing), THEN fill — the
    // fill's banTok already blocks opposite-gender additions, and stripping first lets the
    // fill reuse the freed bytes. alreadyIndexed = title/bullets/brand/color echo removal.
    let out = rows
    if (lean === 'female' || lean === 'male') {
      out = out.map((p) => ({ ...p, keywords: stripOppositeGenderTokens(p.keywords, lean) }))
    }
    // broadcastDesignAnchor (adversarial): parity with the agent's anchor — see the rest path.
    const idx = mkAlreadyIndexed(finalTitle, bullets, broadcastDesignAnchor)
    const ban = extraBan ? (w: string) => banBackendTok(w) || extraBan(w) : banBackendTok
    out = out.map((p) => ({
      ...p,
      keywords: fillBackendToBudget(stripCapabilityClaims(p.keywords, input.customizable === true), input.canonicalTitle, backendKeywordPool, ownB, capacityFamilyTokens.length >= 2, composeCapabilityBan(ban, input.customizable === true), idx, topVolumeBackendPhrases(backendPool), finalTitle, blankSpecFactTokens(blankSpec).concat(input.customizable ? ['personalized custom'] : [])),
    }))
    return out
  }
  // Per-design rows arrive group-filled — the family-level byte-fill would re-introduce the
  // cross-design pool terms the group scoping just removed, so it is family-path only.
  // Degraded-after-retry is now FLAGGED (degradedSections) instead of warn-and-persist: on
  // 2026-07-08 the old console.warn path persisted an 86-char title-echo string over 245-byte
  // approved keywords. The route keeps the STORED keywords for a flagged section (abort-not-
  // overwrite, same principle as assertCoreHealthy — a full regen still ships its five healthy
  // sections, so this flags rather than throws).
  const degradedSections: NonNullable<PipelineResult['degradedSections']> = []
  if (!usedPerDesignBackend) {
    perChild = finishBackendFull(perChild)
    // Same degraded-output gate as the keywords-only path, but a FULL regen carries five other
    // sections — retry the backend once, then flag rather than nuking the run.
    let problems = backendOutputProblems(perChild, input.children, apparelProduct)
    if (problems.length > 0) {
      onProgress('Backend output looked degraded — retrying…')
      perChild = finishBackendFull(await runBackendAgent(input, finalTitle, bullets, backendPool, broadcastDesignAnchor, banBackendTok))
      problems = backendOutputProblems(perChild, input.children, apparelProduct)
      if (problems.length > 0) {
        console.warn(`[listingPipeline] backend output still degraded after retry: ${problems.join('; ')}`)
        // Degrade-mark, never throw (#157 Step 2, 2026-08-03 — the BACKEND_DEGRADE_STRICT whole-run
        // throw is retired): degradedSections routes BOTH write paths into the shared better-than-
        // prior preserve (PR #480), which keeps the five healthy sections and swaps only the
        // degraded keywords when the prior is genuinely better (contaminated priors never win).
        degradedSections.push('backend_keywords')
      }
    }
  } else {
    const problems = backendOutputProblems(perChild, input.children, apparelProduct)
    if (problems.length > 0) {
      console.warn(`[listingPipeline] per-design backend degraded (failed groups keep previous keywords): ${problems.join('; ')}`)
      // Per-design branch: same degrade-mark semantics (#157 Step 2) — census+preserve owns it.
      degradedSections.push('backend_keywords')
    }
  }
  // Same truthfulness backstops as title/bullets (garment-type + motif + hard audience). Uses
  // broadcastMotifTrust so a unified-set's couple-concept design names survive the ungrounded strip.
  let description = apparelProduct
    ? stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(descriptionRaw, broadcastMotifTrust), `${broadcastMotifTrust} ${input.productType ?? ''}`.toLowerCase(), broadcastMotifTrust), attributePinFinal ?? '')
    : descriptionRaw
  if (apparelProduct && (lean === 'female' || lean === 'male')) description = enforceHardAudience(description, lean === 'female' ? 'Women' : 'Men')
  description = fixDoubledArticleBeforeBrand(description, brandName)
  description = polishDescription(description, broadcastDesignAnchor, brandName)

  // PER-DESIGN DESCRIPTION: shared fan-out (also used by description-only partials). Grounded on
  // each group's own bullets/motifs; per-group failures fall back to this broadcast description.
  perChildDescriptions = await fanOutPerDesignDescriptions(description)

  // Stage 4 — Audit (reasoning model)
  onProgress('Auditing & building action plan...')
  let audit: AuditResult = {}
  try {
    audit = await runAuditAgent(input, finalTitle, bullets, perChild, description, attrs.specs)
  } catch (err) {
    console.warn('[pipeline] Audit agent failed, returning content without action plan:', err)
  }

  // Guarantee the read path AND that content always renders. The o4-mini audit is
  // non-deterministic about verdicts — it sometimes marks title/bullets DONE ("matches
  // finalized content"), which hides the copy-paste box in the UI. So for every content
  // element we (a) overwrite replacement_content with the CANONICAL pipeline output and
  // (b) force verdict=REPLACE so the seller can always copy it.
  const actionPlan = Array.isArray(audit.action_plan) ? audit.action_plan : []
  // forceReplace also overwrites current_status + instruction. The o4-mini audit is told
  // the content is "ALREADY FINALIZED", so it writes current_status="Finalized title…" and
  // instruction="No changes required" — which directly contradicts the forced REPLACE
  // verdict (a 🔴 REPLACE card that says "no changes required"). Set deterministic,
  // action-oriented copy that describes what the seller must DO.
  const forceReplace = (item: PipelineActionPlanItem, content: string, label: string) => {
    item.replacement_content = content
    item.verdict = 'REPLACE'
    if (item.priority === 'NONE') item.priority = 'HIGH'
    item.current_status = `Your live ${label} is not optimized for the target keywords.`
    item.instruction = `Replace your current ${label} with the optimized version below, then save in Seller Central.`
  }
  for (const item of actionPlan) {
    if (item.element === 'title') forceReplace(item, finalTitle, 'title')
    else if (/^bullet_([1-5])$/.test(item.element)) {
      const n = Number(item.element.split('_')[1])
      if (bullets[n - 1]) forceReplace(item, bullets[n - 1], `bullet ${n}`)
    } else if (item.element === 'description') {
      forceReplace(item, description, 'description')
      item.level = 'parent'   // description is shared across the whole family, never per-child
    } else if (item.element === 'backend_keywords') {
      item.verdict = 'REPLACE'
      if (item.priority === 'NONE') item.priority = 'HIGH'
      item.level = 'per_child'
      // Show the canonical representative string (not o4-mini's fabricated one) so the
      // copy box matches what actually gets pushed; the per-variant list lives below.
      if (perChild[0]?.keywords) item.replacement_content = perChild[0].keywords
      item.current_status = 'Your live backend search terms miss high-value keywords and repeat words already in the title.'
      item.instruction = "Replace each child SKU's backend search terms with its per-variant string below."
    } else if (item.element === 'brand_story' && item.verdict === 'SKIP' && !input.hasBrandStory) {
      // The seller has no Brand Story — recommend creating one (it auto-appears on every ASIN).
      item.verdict = 'CREATE'
      if (item.priority === 'NONE') item.priority = 'LOW'
      item.current_status = 'No Brand Story (EMC) module detected on your account.'
      item.instruction = 'Create a Brand Story in A+ Content Manager — it auto-appears on every ASIN and links shoppers to your full catalog.'
    }
  }

  // GUARANTEE the core elements always exist. The audit (o4-mini) is best-effort and sometimes
  // returns an EMPTY action_plan — which left the "Apply Changes" UI blank despite a full set of
  // recommendations (the "not loading" bug). Synthesize any missing core element from the
  // canonical pipeline output so the page ALWAYS renders its recommendations.
  const present = new Set(actionPlan.map((a) => a.element))
  const synth = (element: string, content: string, level: 'parent' | 'per_child', status: string, instruction: string) => {
    if (present.has(element) || !content) return
    actionPlan.push({
      element, level, verdict: 'REPLACE', priority: 'HIGH',
      current_status: status, instruction, replacement_content: content,
      seller_central_path: 'Manage Inventory > Edit Listing',
    } as PipelineActionPlanItem)
  }
  synth('title', finalTitle, 'parent', 'Your live title is not optimized for the target keywords.', 'Replace your current title with the optimized version below, then save in Seller Central.')
  for (let i = 1; i <= 5; i++) synth(`bullet_${i}`, bullets[i - 1], 'parent', `Your live bullet ${i} is not optimized for the target keywords.`, `Replace your current bullet ${i} with the optimized version below, then save in Seller Central.`)
  synth('description', description, 'parent', 'Your live description is not optimized for the target keywords.', 'Replace your current description with the optimized version below, then save in Seller Central.')
  synth('backend_keywords', perChild[0]?.keywords ?? '', 'per_child', 'Your live backend search terms miss high-value keywords.', "Replace each child SKU's backend search terms with its per-variant string below.")

  // ── ITEM HIGHLIGHTS row — ONLY once THIS product type's live schema accepts item_highlights
  // (menu-gated): recommending it before Amazon ships the field would create an unfillable
  // Features gap. field_name = the schema's OWN display title, so the route's resolver maps it
  // 1:1 to sp_api_key and the row rides the schema-details rails (Push button, verify, write-
  // through) with ZERO new endpoints. The generated value (LLM draft → deterministic gates →
  // attribute fallback, see buildItemHighlights) replaces any audit-guessed duplicate.
  let pdiFinal: PipelineProductDetailImprovement[] = Array.isArray(audit.product_details_improvements) ? audit.product_details_improvements.slice(0, 26) : []
  // The audit rows are a blind-cast LLM parse: recommended_value can arrive as an ARRAY
  // (Additional Features: ["Water Proof","Shock Proof"]) or a bare number — every consumer
  // (.trim(), byte caps, PATCH bodies) assumes string, and the listing page hard-crashed on
  // B0GCF11RKL until normalized. Stringify at the write boundary so persisted rows are clean.
  pdiFinal = pdiFinal.map((p) => {
    // PROVENANCE HARDENING (adversarial MEDIUM 2026-08-08): `value_source` is RESERVED for the
    // deterministic stamp sites below (blank_specs overrides / audience map / crew-collar ruling).
    // The audit + details-fill rows are a blind-cast parseJsonLoose parse and this spread preserves
    // stray keys — an LLM that echoed or hallucinated `value_source:'spec'` would forge provenance
    // and walk through the sticky gate as a fake "spec re-propose" over a PO-accepted push. Delete
    // it structurally here so the "stamped at deterministic sites ONLY" invariant cannot be
    // prompt-gamed (neither prompt mentions the key, but that is behavior, not a guarantee).
    const rest = { ...p }
    delete rest.value_source
    return {
      ...rest,
      field_name: detailValueToString(p.field_name),
      current_value: p.current_value == null ? null : detailValueToString(p.current_value),
      recommended_value: detailValueToString(p.recommended_value),
    }
  })
  // AUDIENCE-LEAN override for audit-guessed DEMOGRAPHIC details: the audit echoes the
  // catalog's (often blank-boilerplate) demographics and ignored the seller's selector —
  // live failure: Department "Mens" + Target Gender "male" recommended on a FEMALE run.
  // Deterministic per-lean map; the validate-at-regen enum coercion downstream snaps these
  // to this product type's exact accepted members.
  if (apparelProduct && lean) {
    const dem = lean === 'female' ? { dept: 'Womens', gender: 'Female' }
      : lean === 'male' ? { dept: 'Mens', gender: 'Male' }
      : { dept: 'Unisex', gender: 'Unisex' }
    pdiFinal = pdiFinal.map((p) => {
      const f = p.field_name.toLowerCase().trim()
      // value_source:'audience' (sticky-details): deterministic but SELECTOR-derived — a
      // PO-accepted pushed Department/Target Gender is the NEWER declaration and wins at the gate.
      if (f === 'department') return { ...p, recommended_value: dem.dept, value_source: 'audience' as const, reason: `Set by your Audience selection (${lean.replace('_', ' ')}).` }
      if (f === 'target gender') return { ...p, recommended_value: dem.gender, value_source: 'audience' as const, reason: `Set by your Audience selection (${lean.replace('_', ' ')}).` }
      return p
    })
  }
  // GROUND-TRUTH override: the features audit GUESSES Fit/Sleeve/Neck from the SEARCH keyword pool (full of
  // "oversized tshirt" demand), so it mislabels a relaxed Comfort Colors tee as "Oversized"/"Cap Sleeve" — a
  // WRONG pushable attribute AND poison for the downstream editorial audit + highlight. When we know the
  // blank, its real spec OUTRANKS the guess (B0FRYMM56C: unstable — "Relaxed" one regen, "Oversized" the next).
  // The bootstrapped Comfort Colors spec is TEE-specific (6.1oz short-sleeve). Comfort Colors also makes
  // sweatshirts, so gate on the garment actually being a short-sleeve tee — a CC sweatshirt falls back to
  // the guess rather than getting "Short Sleeve" force-pushed onto it (no regression on non-tees).
  // (garmentHay / looksTee / blankSpec are HOISTED above — the partial-regen quality gates need them.)
  if (blankSpec) {
    const overrideField = (re: RegExp, val: string | undefined) => {
      if (!val) return
      // value_source:'spec' (sticky-details gate): blank_specs is the ONE source allowed to
      // re-propose over a PO-accepted detail push — stamp provenance at the deterministic site.
      pdiFinal = pdiFinal.map((p) => re.test(p.field_name)
        ? { ...p, recommended_value: val, value_source: 'spec' as const, reason: `Ground-truth spec for the ${attributePinFinal || 'Comfort Colors'} blank — overrides a value the optimizer inferred from the search-keyword pool.` }
        : p)
    }
    // Override only the REPORTED-wrong attributes (Fit + Sleeve). Neck is left to the guess: it was already
    // right ("Crew Neck") and force-setting it would mislabel a rare Comfort Colors V-neck the title omits.
    overrideField(/\bfit\b/i, blankSpec.fit)
    overrideField(/sleeve/i, blankSpec.sleeve)
    // Apparel Fabric Stretch + Fit to Size Sentiment (2026-07-19, PO): ground these to the blank's real
    // spec instead of an LLM guess. NOTE the precise regexes — /fabric stretch\b/i matches Amazon's
    // "Apparel Fabric Stretch" but NOT our existing binary "Fabric Stretchability" (\b fails before
    // "ability"), so the Non-stretchable/Stretchable attribute is left exactly as-is; and /fit\s*to\s*size/i
    // can't collide with "Fit Type". Values are enum-coerced against the LIVE schema downstream, so a
    // casing/member mismatch surfaces as enum_accepted rather than a bad push.
    overrideField(/fabric stretch\b/i, blankSpec.stretch)
    overrideField(/fit\s*to\s*size/i, blankSpec.fitToSize)
    /* DETERMINISTIC APPEND (task #82, 2026-08-04). The overrides above only REPLACE rows the audit
     * happened to propose — when the LLM skipped the attribute, the PO-confirmed spec fact silently
     * vanished (found in the #82 research pass; Item Highlights already appends unconditionally for
     * exactly this reason). A spec fact must not depend on LLM initiative: if the live schema menu
     * carries the attribute and no row proposed it, add the row ourselves. Keys live-probe-confirmed
     * (?debug=1): apparel_fabric_stretch + fit_to_size_sentiment, both FLAT with display-name enums —
     * the route's coerceDetailValue then snaps casing and flags any illegal member as enum_accepted. */
    const appendSpecFact = (key: string, rowRe: RegExp, val: string | undefined): void => {
      if (!val) return
      const menuAttr = (input.detailAttributeMenu ?? []).find((m) => m.key === key || rowRe.test(m.title))
      if (!menuAttr || pdiFinal.some((p) => rowRe.test(String(p.field_name ?? '')))) return
      pdiFinal.push({
        field_name: menuAttr.title,
        current_value: null,
        recommended_value: val,
        value_source: 'spec',
        reason: `Ground-truth spec for the ${attributePinFinal || 'garment'} blank (blank_specs) — a confirmed product fact shoppers filter on, added deterministically rather than waiting for the optimizer to propose it.`,
      })
    }
    appendSpecFact('apparel_fabric_stretch', /fabric stretch\b/i, blankSpec.stretch)
    appendSpecFact('fit_to_size_sentiment', /fit\s*to\s*size/i, blankSpec.fitToSize)
    /* PO panel review (2026-08-04): two more spec-derivable rows the audit was guessing at.
     * fabric_stretchability is Amazon's BINARY (Non-stretchable/Stretchable) — derive it from the
     * graded spec.stretch (No/Low → Non-stretchable, the no-elastane convention; Medium/High →
     * Stretchable) so the two stretch attributes can never disagree. collar_style's enum has NO
     * "Crew Neck" member; "Round Collar" is the one member that describes a crew neckline — the
     * audit's "Collarless" was PO-rejected as wrong for a crew-neck tee. */
    if (blankSpec.stretch) overrideField(/stretchability/i, /\b(?:no|low)\b/i.test(blankSpec.stretch) ? 'Non-stretchable' : 'Stretchable')
  }
  /* #161 COLLAR ROOT FIX (2026-08-08, hoisted OUT of the `if (blankSpec)` gate). The collar
   * mapping used to run only when a blank_specs row resolved AND carried `neck` — the exact
   * failure classes that shipped "Collarless" on B0FKKN8XKV (blankSpec=NULL until bd88f0b's
   * looksShirt fix; a DB row whose neck column is NULL is silently dropped by rowToSpec). The
   * rule is about the NECKLINE truth, not the blank row: collar_style's enum has no "Crew Neck"
   * member and "Round Collar" is the one member that describes a crew neckline (collarStyleForNeck,
   * unit-tested). Neck truth resolves SPEC-FIRST (blank_specs.neck), else the audit's own Neck row
   * (already reliably "Crew Neck" — see the Neck note above) — so the mapping holds on EVERY path,
   * including full-regen audit re-proposals with no blank spec. value_source:'spec' when
   * blank_specs supplied the neck; an LLM-derived neck stamps 'ruling' instead (adversarial
   * MEDIUM 2026-08-08): the sticky gate honors 'ruling' ONLY against an accepted "Collarless" —
   * so an accepted-pushed "Collarless" (bulk Auto Push of the pre-fix audit) can't freeze this
   * root fix out forever on the blankSpec=NULL class (which can never earn a 'spec' stamp), while
   * an accepted push of any OTHER collar value still outranks the LLM-derived neck.
   * Override-only, like #161: a family whose audit proposed no collar row gets none forced. */
  if (apparelProduct) {
    const neckFromAudit = pdiFinal.find((p) => /\bneck\b/i.test(String(p.field_name ?? '')))?.recommended_value ?? ''
    const neckFromSpec = blankSpec?.neck ?? ''
    const collarVal = collarStyleForNeck(neckFromSpec || neckFromAudit)
    if (collarVal) {
      // ENUM-AWARE guard (adversarial LOW 2026-08-08): "Round Collar" membership is live-proven
      // only for the incident tee family's collar_style enum. When THIS family's schema menu
      // carries a collar attribute whose accepted list LACKS the mapped value, forcing it would
      // downgrade a menu-verbatim member to enum_valid=false (a red, unpushable row) — keep the
      // audit's member instead. No/empty accepted list fails OPEN (the route's coercion +
      // VALIDATION_PREVIEW still backstop a bad member visibly, never as a silent bad push).
      const collarMenu = (input.detailAttributeMenu ?? []).find((m) => /collar/i.test(m.title) || /collar/i.test(m.key))
      const collarEnumOk = !collarMenu?.accepted?.length
        || collarMenu.accepted.some((v) => String(v).trim().toLowerCase() === collarVal.toLowerCase())
      if (!collarEnumOk) {
        console.log(`[details] collar override SKIPPED: this family's ${collarMenu?.key ?? 'collar'} enum has no "${collarVal}" member — keeping the audit's value`)
      } else {
        const fromSpec = !!collarStyleForNeck(neckFromSpec)
        pdiFinal = pdiFinal.map((p) => /collar/i.test(String(p.field_name ?? ''))
          ? {
              ...p,
              recommended_value: collarVal,
              value_source: (fromSpec ? 'spec' : 'ruling') as 'spec' | 'ruling',
              reason: `A crew neckline maps to "${collarVal}" — Amazon's collar_style enum has no "Crew Neck" member, and "Collarless" is wrong for a crew-neck garment (PO ruling).`,
            }
          : p)
      }
    }
  }
  /* PO 2026-08-04: "Model Name should be without the brand name." The audit tends to emit
   * "<brand> <design>" ("THE CEO Cupid Valentine"); Amazon's model_name is the MODEL identifier,
   * and the Brand attribute already carries the brand. Strip the seller brand AND the garment
   * blank's brand deterministically — a prompt instruction is a request, not a guarantee. A row
   * that was ONLY the brand is dropped (nothing useful survives). */
  pdiFinal = pdiFinal.flatMap((p) => {
    if (!/^model\s*name$/i.test(String(p.field_name ?? ''))) return [p]
    let v = String(p.recommended_value ?? '')
    for (const b of [input.brandName, blankSpec?.brand].filter((x): x is string => !!x && !!x.trim())) {
      v = v.replace(new RegExp(`\\b${b.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), ' ')
    }
    v = v.replace(/\s{2,}/g, ' ').trim()
    if (!v) return []
    return [v === p.recommended_value ? p : { ...p, recommended_value: v }]
  })
  // FLAG-AND-FIX rows for catalog blank-boilerplate (PO: "our system needs to FLAG and
  // recommend a FIX — that's why we have the product features optimizer"). Each garment-
  // contradicting attribute string the input scrub caught becomes a Features row with the
  // corrected value (garment word swapped to this family's true product type), riding the
  // normal detail rails (Style is broadcast-pushable; otherwise the row is a Manual card).
  if (apparelProduct && catalogBoilerplate.length > 0) {
    const trueType = /\bt[\s-]?shirts?\b|\btees?\b/i.test(`${input.canonicalTitle ?? ''} ${repTitle ?? ''}`) ? 'T-Shirt'
      : (input.productType ?? 'SHIRT').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase())
    const seenFix = new Set<string>()
    for (const raw of catalogBoilerplate.slice(0, 2)) {
      const fixed = raw.replace(new RegExp(`\\b(?:${[...GARMENT_TYPE_WORDS].join('|')})\\b`, 'gi'), trueType)
        .replace(/\s{2,}/g, ' ').trim()
      if (seenFix.has(fixed)) continue
      seenFix.add(fixed)
      pdiFinal.push({
        field_name: 'Style',
        current_value: raw,
        recommended_value: fixed.replace(/\b\w/g, (ch) => ch.toUpperCase()),
        reason: `Your Amazon catalog attribute says "${raw}" — that is the blank manufacturer's boilerplate, not this listing (your title says ${trueType}). It confuses Amazon's indexing and was excluded from the generated content. Push the corrected value or fix it in Seller Central → Edit Listing.`,
      })
    }
  }

  // Match by key OR display title: Amazon shipped the attribute EARLY as `title_differentiation`
  // (schema title "Item Highlight", live-verified on SELF_STICK_NOTE 2026-06-11) while the docs say
  // `item_highlights` — the title pattern keeps this working if other categories name it differently.
  const highlightsAttr = (input.detailAttributeMenu ?? []).find(
    (m) => /^(?:item_highlights|title_differentiation)$/.test(m.key) || /\bhighlights?\b/i.test(m.title),
  )
  if (highlightsAttr) {
    // String() guard: audit rows are a blind-cast o4-mini parse — a missing field_name must not
    // crash the whole regen here (this runs OUTSIDE the route's tolerant validation loop). The
    // audit-guessed duplicate is dropped EVEN when our deterministic build comes back empty —
    // an unreviewed LLM guess must never ride the pushable rails.
    const squash = (s: unknown) => String(s ?? '').toLowerCase().replace(/[\s_-]+/g, '')
    pdiFinal = pdiFinal.filter((p) => {
      const s = squash(p.field_name)
      return s !== squash(highlightsAttr.title) && s !== 'itemhighlights' && s !== 'itemhighlight' && s !== 'titledifferentiation'
    })
    // Item Highlights is a customer-facing companion field, NOT backend keywords (PO 2026-07-02):
    // material/fit/feature/use-case phrases, no word repeated, <=125 chars. pdiFinal at this point
    // carries the Material/Fit/Neck/Sleeve/Department facts (highlight duplicates already filtered
    // out above); capacityFamilyTokens is the pipeline's real capacity-family signal.
    onProgress('Composing Item Highlights...')   // keepalive before the LLM call
    // broadcastDesignAnchor (parity-audit): identical to effectiveDesignName for single-design ('')
    // and per-design multi-design families, but a unified-set (couple) family keeps its shared
    // concept in the highlight instead of losing it to the zeroed multi-design name.
    // KEYWORD_TARGET_SET (#143): highlights are customer-facing, so they draw from targets only and
    // never a BACKEND-slot term. Filtered at the CALL SITE rather than inside buildItemHighlights so
    // the exported signature stays stable for regenerate-item-highlight/route.ts, which resolves its
    // own targets (that route bypasses this pipeline entirely).
    const hlPool = targets.live
      ? targets.keep(analysis).filter((k) => k.selectionSlot !== 'BACKEND')
      : analysis
    // BLANK-BRAND WATERFALL (PO 2026-08-08): pass the matched blank ROW (brand + match regex are
    // untouched by the long-sleeve sleeve-drop above) and the title the IH will actually ship
    // beside — the PO's LOCKED title when title_source='manual' (the fresh finalTitle is discarded
    // at persist on locked listings; live case B0FKKN8XKV), else this run's finalTitle.
    //
    // SPEC-TRUTH ROW for the brand-INSERTION net (adversarial HIGH, 2026-08-08): re-resolve WITHOUT
    // attributePinFinal. The pin is attrs.searchKeyphrases[0] — MARKET vocabulary that contaminates
    // other listings' pools ("comfort colors" on a Gildan 64000 family), and first-match-wins row
    // selection over a pin-bearing hay would let the net stamp a FALSE "authentic Comfort Colors
    // blank" claim on a Gildan garment. blankSpecRowMatched (pin included) still drives the FACT
    // decorations — pre-net that hay only ever leaked spec facts, never an affirmative brand claim.
    const blankBrandNetRow = apparelProduct && looksShirt
      ? matchBlankSpecRow(await loadBlankSpecRows(), input.canonicalTitle, repTitle, input.productType, skuHay)
      : null
    // Per-child titles join the net set (adversarial LOW, multi-design): the IH is ONE broadcast
    // value pushed to every SKU, while per_child_titles ship per SKU — the waterfall is satisfied
    // only when EVERY shipped title carries the brand (enforced inside the net via every()).
    const ihNetTitles = input.lockedTitle
      ? [input.lockedTitle]
      : [finalTitle, ...(perChildTitles ?? []).map((c) => c.title)]
    let hl = await buildItemHighlights(input.openai, finalTitle, broadcastDesignAnchor, pdiFinal, hlPool, input.brandName, apparelProduct, capacityFamilyTokens.length >= 2, season, blankSpec?.unisex === true, blankBrandNetRow, ihNetTitles)
    // The highlight LLM can still echo "oversized" from its context keywords even with the corrected Fit
    // factRow; scrub it to the true fit and collapse any duplicate word it creates ("oversized relaxed" →
    // "relaxed relaxed" → "relaxed") so the pushable Item Highlight can't ship a fit contradiction.
    // capItemHighlightRepeats RE-WRAPS the scrub (adversarial LOW): scrubFitClaims runs AFTER the
    // generator's terminal cap and can lengthen the string ("boxy"→"Relaxed", +3/occurrence past 75)
    // or repeat the fit word 3x across phrases — the cap is idempotent, so re-running it is free and
    // restores the ≤75 / ≤2-per-word guarantee on the bytes that persist.
    if (hl && blankSpec?.fit) hl = capItemHighlightRepeats(scrubFitClaims(hl, blankSpec.fit).replace(/\b(\w+)(\s+\1)\b/gi, '$1'))
    if (hl) {
      pdiFinal.push({
        field_name: highlightsAttr.title,
        current_value: null,
        recommended_value: hl,
        reason: 'NEW Amazon field (launches July 27, 2026 with the 75-char title limit): up to 125 characters of short customer-facing phrases — material, fit, features, use-case — shown near the title. Human-readable phrases, not a keyword list.',
      })
    }
  }

  // FINAL EDITORIAL AUDIT (council-approved gate, 2026-07-07). Best-effort, FAIL-OPEN. Single-design
  // apparel only (multi-design fans out per group; onlySection partials return earlier). Fixes truncated/
  // off-theme bullets + awkward description, and drops backend junk (holidays/countries/competitor blanks/
  // colors/fragments) from EVERY child. Skipped when not enough context or on any error (keeps originals).
  if (apparelProduct && !designGroupInfo.isMultiDesign && !input.onlySection && bullets.length === 5) {
    const auditRes = await runFinalEditorialAudit(input.openai, finalTitle, bullets, description, perChild[0]?.keywords ?? '', {
      design: effectiveDesignName || designName || repTitle || '',
      designPhrases: secondaryPhrases,
      garment: input.productType ?? '',
      audience: preferredAudience || lean || '',
      referenceTitle: input.canonicalTitle ?? repTitle ?? '',
      brandFront: brandName || 'THE CEO',
      // Garment truth so the audit can enforce it: the garment brand in AUTHORITATIVE casing (keep it in
      // customer copy, don't drop it as a "competitor") and the real fit (relaxed → forbid "oversized").
      garmentBrand: garmentBrandCanonical || '',
      fit: blankSpec?.fit || pdiFinal.find((p) => /\bfit\b/i.test(p.field_name))?.recommended_value?.trim() || '',
      weightNote: blankSpec?.weightNote,
      customizable: input.customizable === true,
      widow: detectWidowFormat(finalTitle, repTitle),
    })
    // Re-apply the title guards so the audited title stays Amazon-legal (<=75), brand-front, and de-duped
    // (kills "T-Shirt … T-Shirt"). If the audit returned the title unchanged, these are idempotent no-ops.
    if (auditRes.title && auditRes.title !== finalTitle) finalTitle = capTitle75(dedupeBrandAndStutter(auditRes.title, brandName))
    bullets = auditRes.bullets
    description = auditRes.description
    if (auditRes.backendDrop.size > 0) {
      perChild = perChild.map((c) => ({
        ...c,
        keywords: c.keywords.split(/\s+/).filter((t) => t && !auditRes.backendDrop.has(t.toLowerCase())).join(' '),
      }))
      // RE-FILL AFTER THE DROP (2026-08-08): this drop runs AFTER fillBackendToBudget and AFTER the
      // producing gate measured healthy PRE-audit bytes — with no re-fill, the drop alone gutted
      // backends to 118B and the degrade-preserve machinery persisted the short fresh (the confession
      // above scrubPublished). Deterministic re-fill to band with the dropped tokens BANNED so
      // audit-deleted junk cannot return (zero LLM calls; the gender strip inside is idempotent, and
      // the closure now dedups against the AUDITED title — bullets deliberately excluded per #69).
      // Safe by construction: this audit fires only on single-design !onlySection runs (guard above),
      // exactly where the family-level fill is correct (usedPerDesignBackend is always false
      // single-design). If band is still unreachable, degrade-mark — never throw
      // (BACKEND_DEGRADE_STRICT retired) — so census + better-than-prior preserve own the decision.
      // Ban set is normTok-folded (adversarial catch): the fill tests ban(normTok(raw)) with
      // punctuation stripped, so a raw-lowercase set would let "darlin'"/"v-neck" return as
      // "darlin"/"vneck"; multi-word drop entries are split so each token bans individually.
      const dropToks = new Set(
        [...auditRes.backendDrop].flatMap((d) => d.split(/\s+/).map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ''))).filter(Boolean)
      )
      const dropBan = (w: string) => dropToks.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''))
      perChild = finishBackendFull(perChild, dropBan)
      const postAuditProblems = backendOutputProblems(perChild, input.children, apparelProduct)
      if (postAuditProblems.length > 0 && !degradedSections.includes('backend_keywords')) degradedSections.push('backend_keywords')
      // Ship-truth resync (#358 class): the backend_keywords action-plan card snapshotted
      // perChild[0].keywords BEFORE this audit block — after drop + re-fill the stored card would
      // diverge from the bytes that actually push. Point it at the final string.
      const finalKw0 = perChild[0]?.keywords
      if (finalKw0) {
        for (const item of actionPlan) {
          if (item.element === 'backend_keywords') item.replacement_content = finalKw0
        }
      }
    }
    onProgress('Final editorial audit applied.')
  }

  // ALWAYS-RUN TRUTH GATE — the deterministic fit/dangle scrubs must NOT live only inside the FAIL-OPEN
  // editorial audit above: a timed-out/truncated audit returns the raw council copy, and "oversized" +
  // dangling tails survived on the bullets/description while the (independently-scrubbed) item highlight was
  // clean (B0FRYMM56C). Re-apply them here on the FINAL bullets/description regardless of the audit outcome,
  // collapsing any duplicate word the fit-swap creates ("oversized relaxed" → "relaxed relaxed" → "relaxed").
  const truthFit = blankSpec?.fit || pdiFinal.find((p) => /\bfit\b/i.test(p.field_name))?.recommended_value?.trim() || ''
  if (apparelProduct && truthFit) {
    const collapseDup = (s: string) => s.replace(/\b(\w+)(\s+\1)\b/gi, '$1')
    bullets = bullets.map((b) => collapseDup(scrubFitClaims(deDangle(b), truthFit)))
    description = collapseDup(scrubFitClaims(tidyDescription(description), truthFit))
  }
  // TERMINAL broadcast description scrub — RUNS ON THE FINAL SHIPPED BYTES (INVARIANT 2 + 6, per
  // pre-done check). Belt-and-suspenders for the broadcast/section-regen path even if the audit above
  // was skipped (audit fires only when useCouncil=true). B0FKKN8XKV verified failing case: audit
  // reintroduced "THE CEO" and "Screen-printed" between runDescriptionAgent and this line.
  if (description && brandName) description = scrubDescriptionBody(description, { brand: brandName, garmentBrand: blankSpec?.brand })
  // TERMINAL broadcast length re-expand (INVARIANT 3 — Item C bundle). Pairs with the scrub above:
  // if scrub trimmed below DESC_MIN_CHARS, re-extend once. Same re-scrub-inside-expander guarantee.
  if (description && brandName) description = await reExpandDescriptionIfShort(input.openai, description, { finalTitle, brand: brandName, garmentBrand: blankSpec?.brand })

  // D — per-child + broadcast bullets metric loops (2026-07-16/17). Runs BEFORE gatePerChildMultiDesign so
  // the looped per-child bytes still receive the per-child truth/audit scrub (INVARIANT 5). enableBulletsLoop
  // is hoisted above (shared with the bullets-only section-regen path). Bounded + fail-open (see the helper):
  // a healthy group/broadcast set spends 0 model calls; a sub-bar one re-deliberates ≤2 and keeps-best.
  bullets = await runBulletsMetricLoops(input.openai, bullets, perChildBullets, {
    title: finalTitle, brandName: brandName || 'THE CEO', designName: effectiveDesignName || '',
    fit: truthFit, onProgress,
  }, enableBulletsLoop)

  // TERMINAL broadcast bullets expander (INVARIANT 2 + 3 — Item C, 2026-07-21). MUST run AFTER
  // runBulletsMetricLoops (which enforces <80 dock only per Fork 3) — first live regen showed the
  // metric loop returned bullets at 111-130 chars, all below BULLET_MIN_CHARS. This is the actual
  // enforcer of the 150 floor on shipped broadcast bytes. Apparel-only gate per PO fork 2.
  if (apparelProduct && Array.isArray(bullets) && bullets.length === 5) {
    bullets = await expandShortBulletsTerminal(input.openai, bullets, {
      title: finalTitle,
      designName: effectiveDesignName || '',
      fit: truthFit,
      garmentBrand: blankSpec?.brand,
    })
  }

  // Per-child multi-design copy (the bytes the push actually PATCHes) gets the SAME audit + truth/brand
  // gate as the broadcast copy above — closes the R4/#61 leak where multi-design shipped unscrubbed.
  await gatePerChildMultiDesign(perChildBullets, perChildDescriptions, truthFit, garmentBrandCanonical || '')

  // FINAL length cap on the SHIPPED description bytes (broadcast + per-child): the editorial audit + the
  // per-design fan-out are LLM rewrites that can re-expand past 980 with nothing else re-capping (the
  // "1600-char description" regression). Re-cap LAST so the shipped description is always Amazon-lean.
  // FABRIC TRUTH on every shipped prose surface (task #41 / GAP 2) — broadcast AND the per-child
  // bytes the push PATCHes (INVARIANT 5). Deterministic + idempotent; runs before the final caps
  // because a weight-class replacement can lengthen the text by a few characters.
  const fabricSpec = { weightNote: blankSpec?.weightNote, stretch: blankSpec?.stretch }
  if (Array.isArray(bullets)) bullets = bullets.map((b) => enforceFabricTruth(b, fabricSpec))
  description = enforceFabricTruth(description, fabricSpec)
  if (perChildBullets) perChildBullets = perChildBullets.map((c) => ({ ...c, bullets: (c.bullets || []).map((b) => enforceFabricTruth(b, fabricSpec)) }))
  if (perChildDescriptions) perChildDescriptions = perChildDescriptions.map((c) => ({ ...c, description: enforceFabricTruth(c.description, fabricSpec) }))
  description = capDescriptionVisible(description)
  if (perChildDescriptions) perChildDescriptions = perChildDescriptions.map((c) => ({ ...c, description: capDescriptionVisible(c.description) }))

  // FULL-PATH degradation gate (2026-07-08): a quota outage made every council fail open to empty
  // and the empty result PERSISTED over approved content while reporting success. Abort-and-preserve
  // before the route can reach its upsert. Empty-only checks — never a count/length floor.
  assertCoreHealthy(input.openai, finalTitle, bullets, description)
  return scrubPublished({
    recommended_title: finalTitle,
    recommended_bullets: bullets,
    per_child_keywords: perChild,
    degradedSections: degradedSections.length ? degradedSections : undefined,
    per_child_titles: perChildTitles,
    per_child_bullets: perChildBullets,
    per_child_descriptions: perChildDescriptions,
    recommended_description: description,
    variant_corrections: Array.isArray(audit.variant_corrections) ? audit.variant_corrections : [],
    cannibalization_warnings: Array.isArray(audit.cannibalization_warnings) ? audit.cannibalization_warnings : [],
    product_details_improvements: pdiFinal,
    keyword_reconciliation: reconcilePlacedInBackendFirst(Array.isArray(audit.keyword_reconciliation) ? audit.keyword_reconciliation : [], finalTitle, bullets, description, perChild, perChildBullets, perChildDescriptions),
    action_plan: actionPlan,
    irrelevant_keywords: irrelevantKeywords,
    // #92/#93 — exactly the bullet set the generator targeted + the real design name, for the scorer.
    keywordPlan: { bullets: topOpportunityKwsForBullets, designName: effectiveDesignName, coupleConcept: coupleConcept || undefined, perDesign: designGroupContexts.length ? designGroupContexts.map((c) => ({ designKey: c.key, bullets: scopeKwsToGroup(c, topOpportunityKwsForBullets, (k) => k) })) : undefined , ...selectedPlanFields },
    debug: { titleProblems, candidatesUsed: candidates.map((c) => c.keyword), titleRetried: retried, designName, designSource, multiDesign: designGroupInfo.isMultiDesign, designGroups: designGroupInfo.groups.map((g) => g.key), nicheSeeds: input.nicheSeeds ?? [], v4: v4Diffs },
  })
}
