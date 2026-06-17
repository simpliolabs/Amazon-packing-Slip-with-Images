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
import { missingBulletKeywords, bulletTokens } from '@/lib/keyword-engine/bulletCoverage'
import { detailValueToString } from '@/lib/fba/productDetailAttrs'
import { scrubTrademarks, scrubTrademarksArr } from '@/lib/fba/trademarkGuard'
// Per-design vision scans (Commit 2): one scan per design group via the existing vision helpers.
import { scanProductImage, getProductImageUrl } from '@/lib/keyword-engine/visionScanner'
// Per-design name resolution (Commit 2 hot-fix): the seller stores the design name as Amazon's
// Color attribute per variant; fetch via Listings Items API. Token + sellerId resolution mirrors
// the SP-API call sites in pushExecutor.
import { getAccessToken as getSpApiAccessToken } from '@/lib/amazon/auth'
import { getSellerId as getSpApiSellerId } from '@/lib/fba/pushExecutor'

// ─── Shared output types (structurally identical to the route's interfaces) ────

export interface PipelinePerChildKeywords { sku: string; asin: string; keywords: string }
export interface PipelineVariantCorrection { sku: string; field: string; current: string; replace_with: string; reason: string }
export interface PipelineCannibalizationWarning { keyword: string; affected_skus: string[]; issue: string; recommendation: string }
export interface PipelineProductDetailImprovement { field_name: string; current_value: string | null; recommended_value: string; reason: string; is_enum?: boolean; enum_valid?: boolean; enum_accepted?: string[]; normalized_from?: string }
export interface PipelineKeywordReconciliation { keyword: string; action_type: 'CRITICAL' | 'UPGRADE' | 'REINFORCE'; search_volume: number; placed_in: string[]; exact_text: string; why: string }
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
  analysis: AnalyzedKeyword[]
  children: PipelineChild[]
  /** Current title of the representative child — used for product-name token extraction */
  repTitle: string | null
  /** Canonical listing title (listing_seo_scores.product_title — the title the seller & dashboard
   *  see, sourced from the best-selling child). Preferred over repTitle for DESIGN-NAME extraction:
   *  repTitle is children[0] = the alphabetically-first variant, often a stale/secondary title that
   *  does NOT lead with the design name. Null when no score row exists. */
  canonicalTitle?: string | null
  /** Seller-set DESIGN NAME override (listing_seo_scores.design_name_override, migration 031).
   *  When set, extractDesignName uses this VERBATIM — bypasses LLM / vision / leadingDesignPhrase.
   *  Deterministic anchor for cases where the heuristic chain fails (PO 2026-06-14:
   *  B0GQVL3K4B's canonical "Don't" curly-apostrophe broke the heuristic → no design name → title
   *  agent picked "Too Young to Retire Too Poor to Quit" from the keyword pool). Null = legacy
   *  LLM-and-heuristic extraction. */
  designNameOverride?: string | null
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
  visionDesign?: { designTheme: string; visualElements: string[]; seedKeywords: string[] } | null
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
  per_child_titles?: { sku: string; asin: string; title: string }[]
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
  keywordPlan: { bullets: string[]; designName: string }
  debug: { titleProblems: string[]; candidatesUsed: string[]; titleRetried: boolean; designName?: string; designSource?: string; multiDesign?: boolean; designGroups?: string[] }
  /** #79 per-section regen: set when onlySection ran — ONLY that section's fields are
   *  meaningful; the route merges them into the STORED recommendation row. */
  regeneratedSection?: 'title' | 'bullets' | 'description' | 'keywords'
}

// ─── Constants / small helpers ────────────────────────────────────────────────

const SEASONAL_TERMS = [
  'christmas', 'xmas', 'halloween', 'valentines', 'valentine', 'easter',
  'thanksgiving', 'mothers day', 'mother day', 'fathers day', 'father day',
  'back to school', 'last day of school', 'schools out', 'school out',
  'independence day', '4th of july', 'fourth of july', 'july 4th',
  'st patrick', 'new year', 'new years', 'memorial day', 'labor day',
  'spring break', 'summer break', 'winter break', 'black friday',
  'cyber monday', 'prime day', 'hanukkah',
]
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
])

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
function stripContradictedGarments(text: string, trustedHaystack: string): string {
  if (!text) return text
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  const bad = [...new Set(words.filter((w) => GARMENT_TYPE_WORDS.has(w) && !new RegExp(`\\b${w.replace(/s$/, '')}`, 'i').test(trustedHaystack)))]
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
 *  and the 250-byte hard cap is never crossed. Runs BEFORE the hard-lean gender strip so
 *  the strip cleans additions too. */
function fillBackendToBudget(
  keywords: string,
  canonicalTitle: string | null | undefined,
  poolKeywords: string[],
  ownBrands: Set<string>,
  capacityFamily: boolean,
  /** Same token truth gate the core uses — pool phrases can carry sibling colors and
   *  ungrounded style words; the byte-fill must not smuggle back what the core banned. */
  banTok: (w: string) => boolean = () => false,
): string {
  let out = (keywords || '').trim()
  if (getByteLength(out) >= 244) return out
  // Token-normalized novelty: the field is a token soup (Amazon matches tokens, not
  // phrases), so compare and append WITHOUT punctuation — "darlin'" must not be appended
  // as a duplicate of the already-present "darlin".
  const normTok = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  const have = new Set(out.split(/\s+/).map(normTok).filter(Boolean))
  const candidates: string[] = []
  // 1. canonical descriptor bigrams, segment-aware (strip the trailing " - Color - Size" suffix)
  const canonClean = (canonicalTitle ?? '').replace(/(\s+-\s+[A-Za-z][A-Za-z -]{1,24}){1,2}\s*$/, '')
  for (const seg of canonClean.split(/[,\-–—|]/)) {
    const w = seg.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1)
    for (let i = 0; i + 1 < w.length; i++) candidates.push(`${w[i]} ${w[i + 1]}`)
  }
  // 2. leftover pool keywords
  candidates.push(...poolKeywords.map((k) => k.toLowerCase()))
  for (const cand of candidates) {
    if (capacityFamily && CAPACITY_RE.test(cand)) continue
    if (findThirdPartyBrands(cand, ownBrands).length > 0) continue
    // Append token-by-token so a partial fit still lands ("country" must not be lost
    // just because "country western" as a whole missed the cap by a byte).
    for (const raw of cand.split(/\s+/)) {
      const tok = normTok(raw)
      if (tok.length <= 1 || have.has(tok)) continue
      if (banTok(tok)) continue
      if (getByteLength(`${out} ${tok}`) > 250) continue
      out = `${out} ${tok}`
      have.add(tok)
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
  // 190 floor: healthy output lands 244-250 (the fill's target); even a thin catalog with
  // canonical bigrams clears 200. Only a starved pool / failed fill lands below.
  if (minBytes < 190) problems.push(`a child landed at ${minBytes}/250 bytes — degraded keyword pool or failed fill`)
  const distinctColors = new Set(children.map((c) => (c.color || 'default').toLowerCase())).size
  const distinctStrings = new Set(perChild.map((p) => p.keywords)).size
  if (apparel && distinctColors >= 3 && distinctStrings < 2) {
    problems.push(`all ${perChild.length} children share one identical string across ${distinctColors} colors — the per-color tail failed`)
  }
  return problems
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
  // PREFIX / colour-family encoding: text BEFORE the base-number run is the design key
  // (FHOSH64000L-BK → "FHOSH"; DAR-CCG-2XL-BAY → "DAR-CCG"; parent RA-8EU0-VP6R → unchanged).
  const beforePrefix = k.replace(/\d{3,}.*$/, '').replace(/[-_\s]+$/, '')
  if (beforePrefix) return beforePrefix
  // SUFFIX encoding: the SKU STARTS with the base-number, design name is AFTER the colour
  // (640002XL-BK-I'M-Retired-TS → "I'M-RETIRED"). Strip the leading base-number+embedded-size,
  // then the leading colour code, then a trailing product-type token (-TS). This branch ONLY
  // runs when there was no prefix, so it can't strip a real prefix like "DAR" from "DAR-CCG".
  k = k.replace(/^\d{3,}(?:2XL|3XL|4XL|5XL|6XL|XL|XS|L|M|S)?-?/i, '')   // 640002XL- → ''
  k = k.replace(/^[A-Z]{2,4}-/, '')                                     // BK- / GR- (colour) → ''
  k = k.replace(/-?TS$/i, '')                                          // trailing product-type token
  return k.replace(/[-_\s]+$/, '').replace(/^[-_\s]+/, '')
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
// design-name anchor, not the keyword pool. KEEP IN SYNC with the copy in syncListingContent.
const BASIC_COLOR_RE = /\b(?:black|white|navy|red|blue|green|grey|gray|pink|purple|yellow|orange|brown|tan|teal|maroon|burgundy|charcoal|ivory|beige|olive|mint|coral|lavender|mustard|rust|sage|cream)\b/i

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
])

/** Multi-word brand phrases (checked verbatim, not per-word). */
const THIRD_PARTY_BRAND_PHRASES = [
  'western digital', 'audio technica', 'sea gate', 'go pro',
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

/** Get the seller's own brand tokens for exemption from brand checks. */
function ownBrandTokenSet(brandName: string): Set<string> {
  return new Set(brandName.toLowerCase().split(/\s+/).filter(Boolean))
}
// Product-type words capped at 2 total in the backend core (Amazon's bag-of-words already
// has them from the title; >2 is the "shirt ×7" waste the PO flagged).
const PRODUCT_TYPE_WORDS = new Set(['shirt', 'shirts', 'tshirt', 'tshirts', 'tee', 'tees'])

// Amazon Listings-Items productTypes that ARE clothing (worn on the body) — the only families
// where shirt/tee framing, garment blank-brands, and fit/fabric specs make sense. Matched on
// _-delimited tokens so SWEATSHIRT hits but ADDRESS_LABEL / MEMORY_CARD never can.
// Exported: keyword research seeds NON-apparel from the productType (category seed) and needs
// the same ground-truth apparel gate (syncKeywordIntelligence).
export const APPAREL_PRODUCT_TYPES = /(?:^|_)(SHIRT|SWEATSHIRT|SWEATER|HOODIE|DRESS|SKIRT|PANTS|SHORTS|SOCKS|HAT|COAT|JACKET|UNDERPANTS|UNDERWEAR|BRA|PAJAMAS|SLEEPWEAR|SWIMWEAR|LEOTARD|TIGHTS|LEGGINGS|BODYSUIT|ONESIE|ROMPER|BLOUSE|CARDIGAN|VEST|ROBE|COSTUME|OUTFIT|TRACKSUIT|OVERALLS|SUIT|KURTA|SAREE|SALWAR_SUIT_SET|APPAREL)(?:_|$)/

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

const isSeasonal = (kw: string) => SEASONAL_TERMS.some((t) => kw.toLowerCase().includes(t))

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
    const tidied = cut.replace(/[\s,;:&\-–—]+$/g, '').replace(/\s(?:for|and|with|in|of|to|a|an|the|or|by)$/i, '').trim()
    if (tidied === cut) break
    cut = tidied
  }
  if (hadInclusiveAudience && /\s*\b(?:for\s+)?(?:Men|Women)['’]?s?(?:\s(?:and|&))?$/i.test(cut)) {
    cut = cut.replace(/\s*\b(?:for\s+)?(?:Men|Women)['’]?s?(?:\s(?:and|&))?$/i, '').trim().replace(/[\s,;:&\-–—]+$/g, '')
  }
  return cut
}

// ─── ITEM HIGHLIGHTS (Amazon's companion to the 75-char title, July 27 2026) ────
// ~125 chars of comma-separated search phrases shown near the title and indexed for search —
// the home for the keyphrases a ≤75-char title can no longer carry. DETERMINISTIC (no LLM):
// highest-opportunity keywords from the gated pool, with the same hygiene the bullets enforce —
// no seasonal terms, no audience-narrowing role words, no third-party brands, no capacity tokens
// on capacity families, and nothing the title already fully indexes (net-new index only).
function buildItemHighlights(finalTitle: string, pool: AnalyzedKeyword[], brandName: string, capacityFamily: boolean): string {
  const ownBrands = ownBrandTokenSet(brandName)
  const titleToks = new Set(finalTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))
  const seen = new Set<string>()
  const phrases: string[] = []
  let len = 0
  for (const k of [...pool].sort((a, b) => b.opportunityScore - a.opportunityScore)) {
    const kw = (k.keyword || '').trim().toLowerCase()
    if (!kw || seen.has(kw)) continue
    const words = kw.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    if (words.length === 0 || words.length > 6) continue
    if (SEASONAL_TERMS.some((s) => kw.includes(s))) continue                  // evergreen field
    if (words.every((w) => titleToks.has(w))) continue                        // title already indexes it
    if (words.some((w) => ROLE_WORDS.has(w) && !titleToks.has(w))) continue   // no audience-narrowing
    if (capacityFamily && CAPACITY_RE.test(kw)) continue                      // shared field — never one capacity
    if (findThirdPartyBrands(kw, ownBrands).length > 0) continue              // no third-party brands
    const next = phrases.length ? len + 2 + kw.length : kw.length
    if (next > 125) continue
    phrases.push(kw)
    seen.add(kw)
    len = next
    if (len >= 115) break                                                     // close enough — stop scanning
  }
  return phrases.join(', ')
}

// ─── Title validation (shared with the route's PR1 validator semantics) ────────

export function validateTitle(title: string, brandName: string, mustInclude?: string, attributePin?: string, upgradeKws?: string[], designName?: string): string[] {
  const problems: string[] = []
  const len = title.length
  if (len > 75) problems.push(`Title is ${len} characters; Amazon's NEW limit is 75 (effective July 27, 2026 — longer titles get AUTO-REWRITTEN by Amazon). Cut supporting keyphrases (they belong in backend keywords / Item Highlights), keep brand + design/product name + the money keyword.`)
  else if (len < 50) problems.push(`Title is only ${len} characters; aim 50-75 — there's room for the top keyword without breaking the 75-char limit.`)

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
  const season = SEASONAL_TERMS.find((s) => lc.includes(s))
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
 *   - 3+ top opportunity keywords (CRITICAL ∪ UPGRADE) missing across the whole bullet set
 *     (scorer -2 per missing, capped at -12; threshold matches scorer's "2+" trigger)
 */
export function validateBullets(
  bullets: string[],
  brandName: string,
  opportunityKws: string[] = [],
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

  // Length: bullets <100 chars get docked by the scorer.
  const shortBullets = bullets
    .map((b, i) => ({ i, b, len: b.length }))
    .filter((x) => x.len < 100)
  if (shortBullets.length > 0) {
    const names = shortBullets.map((x) => `bullet ${x.i + 1} (${x.len} chars)`).join(', ')
    problems.push(`${shortBullets.length} bullet${shortBullets.length === 1 ? '' : 's'} under 100 chars: ${names}. Expand each to 100-200 chars with a "so that" benefit, a compatible-device example, and a long-tail keyword.`)
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

  // Opportunity-keyword coverage. The scorer aggregates CRITICAL ∪ UPGRADE and penalizes
  // when 2+ are missing across the bullets joined together. We trigger the retry at the SAME
  // >=2 threshold — the shared predicate makes the validator catch EXACTLY what the scorer docks
  // (do NOT raise this back to 3+ or the validator/scorer divergence that pinned bullets at 9/18 returns).
  if (opportunityKws.length > 0) {
    // SHARED predicate so the validator catches EXACTLY what the scorer docks for; trigger at >=2 (the
    // scorer's first penalty tier) and ask to weave EACH (not "leave 2"). Kills the 9/18 rulebook divergence.
    const missing = missingBulletKeywords(bullets, opportunityKws)
    if (missing.length >= 2) {
      const sample = missing.slice(0, 6).map((k) => `"${k}"`).join(', ')
      problems.push(`Bullets are missing ${missing.length} of your top opportunity keywords (CRITICAL + UPGRADE): ${sample}. Coverage is by WORD, not by phrase — SPREAD each phrase's key words naturally across DIFFERENT bullets and sentences (the full phrase does NOT need to appear contiguously). Do NOT cram a whole multi-word search string into one sentence — that reads as keyword soup.`)
    }
  }

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

// ─── Stage 0 — candidate preparation (code only) ───────────────────────────────

interface TitleCandidate { keyword: string; opportunityScore: number; role: 'keyphrase' | 'descriptive' | 'audience'; organicRank?: number | null }

function extractProductNameTokens(repTitle: string | null): string[] {
  return (repTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !GENERIC_APPAREL.has(w))
    .slice(0, 3)
}

function selectTitleCandidates(analysis: AnalyzedKeyword[], brandName: string, repTitle: string | null, outcomeSignals?: Record<string, OutcomeSignal>): TitleCandidate[] {
  const brandTokens = brandName.toLowerCase().split(/\s+/).filter(Boolean)
  const productTokens = extractProductNameTokens(repTitle)

  // Outcome-loop tiebreak (#89): among near-equal opportunity, prefer a keyword whose SQP share is RISING
  // (reinforce what's working) and de-prioritize one that's flat-despite-a-content-change (its ceiling is now
  // non-content — reviews/price/velocity, not more copy). SECONDARY to opportunityScore: it only reorders
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

  const eligible = analysis
    .filter((k) => ['CRITICAL', 'UPGRADE', 'DEFENDED', 'REINFORCE'].includes(k.actionType))
    .filter((k) => !isSeasonal(k.keyword))
    .sort((a, b) => (b.opportunityScore - a.opportunityScore) || (tdRank(b) - tdRank(a)) || (strikeRank(b) - strikeRank(a)) || (riseRank(b.keyword) - riseRank(a.keyword)))

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

  return deduped.slice(0, 7).map((k) => ({ keyword: k.keyword, opportunityScore: k.opportunityScore, role: roleOf(k.keyword), organicRank: k.organicRank ?? null }))
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

/** COUNCIL for the title (PO directive: big decisions DEBATE instead of one agent). Reuses the
 *  fully-built title brief (system+user) so every hard constraint still applies, then runs:
 *  3 persona proposers (creative / SEO / conversion) -> a ruthless adversary critique -> a judge that
 *  synthesizes the single best title. The judge's output flows through runTitleAgent's existing
 *  validate + deterministic backstops (brand-lead, design-name lead, gender de-dup, Title-Case), so
 *  the council is additive, not a new failure mode. Fails open to a single agent if all drafts error. */
async function runTitleCouncil(openai: OpenAI, baseSystem: string, baseUser: string, onProgress?: (m: string) => void): Promise<string> {
  // The 3 proposers stay on fast gpt-4.1-mini (cheap, diverse drafts). The adversary + judge — where
  // judgment decides the title — run on GPT-5 (PO directive). GPT-5 reasoning models REJECT
  // `temperature` and use `max_completion_tokens` (not `max_tokens`), so the params branch by model.
  // Per-call timeout + NO retries: a hung call must not stall the keepalive-less title stage past
  // Cloudflare's ~100s idle window (a keepalive fires between stages, not during a call, so each call
  // must finish under that on its own). GPT-5 reasons slower, so it gets 60s; gpt-4.1-mini gets 20s.
  const ask = async (system: string, user: string, temperature: number, max_tokens = 120, model = 'gpt-4.1-mini', timeoutMs = 20_000): Promise<string> => {
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
  const COUNCIL_MODEL = process.env.TITLE_COUNCIL_MODEL || 'gpt-5'   // adversary + judge model (PR: title-council GPT-5)
  const personas: { sys: string; temp: number }[] = [
    { sys: 'You are an award-winning apparel brand COPYWRITER. Write the most compelling, human, DESIGN-LED title — the kind a shopper stops and clicks. ', temp: 0.6 },
    { sys: 'You are an Amazon SEO STRATEGIST. Capture the most legitimate search value WITHOUT stuffing: the design name leads, then only the highest-value real terms that fit naturally — the rest belongs in bullets/backend. ', temp: 0.3 },
    { sys: 'You are a CONVERSION strategist focused on trust + click-through. Write a CLEAN, professional title — design name + product type up front, clear audience, nothing that reads like spam. ', temp: 0.4 },
  ]
  const drafts = (await Promise.all(personas.map((p) => ask(p.sys + baseSystem, baseUser, p.temp)))).filter(Boolean)
  if (drafts.length === 0) return ask(baseSystem, baseUser, 0.3)            // fail open: single agent
  if (drafts.length === 1) return drafts[0]
  onProgress?.('Title council: drafts in, adversary reviewing...')          // keepalive (resets idle timer)
  const numbered = drafts.map((t, i) => `${i + 1}. ${t}`).join('\n')
  const critique = await ask(
    'You are a ruthless Amazon listing critic AND a skeptical shopper. Attack candidate titles for: keyword stuffing, spammy reads, a buried or duplicated design name, any non-trivial word used more than twice, length over 75 chars (Amazon AUTO-REWRITES longer titles from July 27, 2026), brand not first, and weak click appeal. Be specific.',
    `Brief (the title must satisfy this):\n${baseUser}\n\nCandidate titles for the SAME product:\n${numbered}\n\nCritique EACH, then name the single strongest element across them.`,
    0.3, 400, COUNCIL_MODEL, 60_000,
  )
  onProgress?.('Title council: judge synthesizing the winner...')           // keepalive
  const judged = await ask(
    baseSystem + ' You are the JUDGE: merge the strongest, COMPLIANT elements into ONE final title that satisfies every rule in the brief. Output ONLY the final title string — no quotes, no explanation.',
    `${baseUser}\n\nCandidate titles:\n${numbered}\n\nCritic review:\n${critique}\n\nReturn ONLY the single best final title.`,
    0.2, 120, COUNCIL_MODEL, 60_000,
  )
  // Fail open to the SEO/anti-stuffing draft (persona #2), NOT the creative one (#0): if the GPT-5
  // judge errors or returns empty, the leanest draft is the safest fallback. Logged so it's visible.
  if (!judged) console.warn('[title-council] judge returned empty — failing open to the SEO/anti-stuffing draft')
  return judged || drafts[1] || drafts[0]
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
  const askBullets = async (system: string, user: string, temperature: number, model = 'gpt-4.1-mini', timeoutMs = 20_000): Promise<string[]> => {
    try {
      const isGpt5 = /^(gpt-5|o\d)/.test(model)
      const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
      const r = await openai.chat.completions.create(
        isGpt5
          ? { model, messages, max_completion_tokens: 4000, reasoning_effort: 'low' as const, response_format: { type: 'json_object' as const } }
          : { model, messages, temperature, max_tokens: 1200, response_format: { type: 'json_object' as const } },
        { timeout: timeoutMs, maxRetries: 0 },
      )
      const parsed = parseJsonLoose<{ bullets?: string[] }>(r.choices[0]?.message?.content || '{}')
      return Array.isArray(parsed.bullets) ? parsed.bullets.filter((b) => typeof b === 'string').map((b) => b.trim()).filter(Boolean).slice(0, 5) : []
    } catch { return [] }
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
    { sys: 'You are an award-winning apparel COPYWRITER. Write 5 bullets a shopper FEELS — vivid CAPS benefit hooks, human voice, design-led. ', temp: 0.6 },
    { sys: 'You are an Amazon SEO STRATEGIST. The required search keyphrases in the brief MUST appear across the 5 bullets, woven naturally and accurately — maximizing legitimate keyword COVERAGE without stuffing is your job. ', temp: 0.3 },
    { sys: 'You are a CONVERSION strategist. Every bullet leads with a crisp 2-3 word CAPS benefit hook; all 5 are scannable, accurate, and trustworthy. ', temp: 0.4 },
  ]
  const drafts = (await Promise.all(personas.map((p) => askBullets(p.sys + baseSystem, baseUser, p.temp)))).filter((d) => d.length > 0)
  if (drafts.length === 0) return askBullets(baseSystem, baseUser, 0.4)        // fail open: single agent
  if (drafts.length === 1) return drafts[0]
  onProgress?.('Bullets council: drafts in, adversary reviewing...')           // keepalive (resets idle timer)
  const numbered = drafts.map((d, i) => `Set ${i + 1}:\n${d.map((b, j) => `  ${j + 1}. ${b}`).join('\n')}`).join('\n\n')
  const critique = await askText(
    'You are a ruthless Amazon listing critic. Attack each 5-bullet set for: (1) MISSING required keyphrases from the brief — name exactly which are absent from each set; (2) weak, duplicate, or non-CAPS benefit hooks; (3) any claim of a profession/role/occasion/audience NOT in the title (accuracy failure); (4) keyword stuffing or bullets under ~100 chars. Be specific per set.',
    `Brief the bullets must satisfy:\n${baseUser}\n\nCandidate 5-bullet sets for the SAME product:\n${numbered}\n\nCritique EACH set, then name which set covers the required keyphrases best.`,
    COUNCIL_MODEL, 60_000,
  )
  onProgress?.('Bullets council: judge synthesizing the winner...')            // keepalive
  const judged = await askBullets(
    baseSystem + ' You are the JUDGE: merge the strongest, ACCURATE elements into ONE final set of 5 bullets that covers EVERY required keyphrase from the brief, each starting with a CAPS benefit hook, none implying a role/occasion not in the title. Return ONLY {"bullets":["b1","b2","b3","b4","b5"]}.',
    `${baseUser}\n\nCandidate sets:\n${numbered}\n\nCritic review:\n${critique}\n\nReturn ONLY the single best final set as {"bullets":[...]}.`,
    0.2, COUNCIL_MODEL, 60_000,
  )
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
): Promise<{ title: string; problems: string[]; retried: boolean }> {
  const { openai, brandName, category, repTitle, productType } = input
  const apparel = looksApparel(category, repTitle, productType)

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
    const isGrounded = (kw: string): boolean => {
      const distinctive = kw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .map((w) => w.replace(/s$/, ''))
        .filter((w) => w.length > 1 && !MINOR_WORDS.has(w) && !FREE.has(w))
      // Motif nouns get the STRICTER test (seller text only); everything else may be
      // grounded by the wider vocab (which includes vision + seller titles).
      return distinctive.every((w) =>
        (VISUAL_MOTIF_WORDS.has(w) || VISUAL_MOTIF_WORDS.has(`${w}s`)) ? motifVocab.has(w) : groundVocab.has(w))
    }
    // The verbatim money keyword (mustInclude) is the PRIMARY leak — it is mandated + hard-validated
    // into the title, bypassing the candidate filter. If it's an ungrounded CLAIM ("vintage 90s shirt")
    // rather than a design term ("alligator shirt"), drop the mandate (it still ranks from bullets/
    // backend). NOTE: attributePin (the blank/garment brand) is NOT design-gated — it's a real PRODUCT
    // attribute, not a design claim, so grounding is the wrong test for it; it's trusted + added above.
    if (mustInclude && !isGrounded(mustInclude)) mustInclude = undefined
    candidates = candidates.filter((c) => isGrounded(c.keyword))
    upgradeKws = upgradeKws.filter(isGrounded)
    attributes = attributes.filter(isGrounded)
  }

  const candidateList = candidates
    .map((c) => {
      // Rank context for the writer/council: striking distance (#11-30) = a title spot moves
      // this keyword fastest; already top-10 = defend, don't burn budget chasing it harder.
      const rank = c.organicRank != null
        ? c.organicRank <= 10 ? `, we already rank #${c.organicRank} — defend`
          : c.organicRank <= 30 ? `, we rank #${c.organicRank} — STRIKING DISTANCE, title placement moves this fastest`
            : `, we rank #${c.organicRank}`
        : ''
      return `  - "${c.keyword}" (opportunity ${c.opportunityScore}, role: ${c.role}${rank})`
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
  const audienceLine = preferredAudience
    ? `\nAUDIENCE: end with "for ${preferredAudience}" (this product is for ${preferredAudience} — do NOT narrow it to a single gender if it says Men and Women).\n`
    : ''

  const system = `You are an Amazon SEO title writer${apparel ? ' specializing in apparel' : ''}. Write a title for the ACTUAL product described below — never reframe it as something it is not. Output ONLY the final title string — no quotes, no markdown, no explanation.`
  const user = `Brand: ${brandName}
Category: ${category}
${designLine}${mustLine}${attrPinLine}${upgradeLine}
Pre-filtered keyword candidates (already de-duplicated and seasonal-stripped — the title is capped at 75 chars, so ${apparel ? 'at most ONE beyond the mandatory keyword' : 'only 1-2 of these fit alongside the mandatory keyword; the rest rank via bullets/backend'}):
${candidateList}
${attrLine}${audienceLine}
Write ONE product title as NATURAL, readable language — NOT dash-separated sections.
${apparel
  ? `Write a clean, natural, DESIGN-LED title and TRUST your judgement. Start with the brand, then weld the design name DIRECTLY to the product type as ONE unbroken phrase — "${designName || 'Later Gator'} T-Shirt" — that exact phrase is the seller's #1 search keyword; never split it. AFTER it, write a SECOND keyword phrase built from the design's MAIN VISUAL SUBJECT + a product-type SYNONYM — e.g. "Alligator Shirt", "Cat Tee", "Skull Graphic Tee" — because "<subject> shirt/tee" is itself a high-volume search term; weave the garment brand in as a modifier ONLY if it fits the 75-char cap. 🚫 GROUND THE SUBJECT — never fabricate artwork: the visual subject MUST be something that literally appears in the design name "${designName || '<design>'}" or the title. If this is a TEXT/SLOGAN design with NO concrete object (e.g. a Gen X saying, a funny quote), do NOT invent an object/prop/motif (cassette, guitar, skull, dog, etc.) — build the second phrase from the slogan's THEME or a TONE word instead (e.g. "Funny Gen X Tee", "Sarcastic Saying Shirt"). Then end with the audience. TWO HARD RULES: (1) do NOT repeat the exact product-type word "T-Shirt" — the welded phrase already has it, so the second phrase uses a SYNONYM (Shirt / Tee / Graphic Tee) carrying the design subject; (2) do NOT pad with vague filler like "with Gator Art", "cool design", "fun graphic" — every char counts against 75. EXACT target shape (a DIFFERENT design — copy the SHAPE, not the words; it is exactly 75 chars): "THE CEO Later Gator T-Shirt, Comfort Colors Alligator Tee for Men and Women". For THIS product use: design name "${designName || '<design>'}"${attributePin ? `, garment brand "${attributePin}" (drop it first if over 75)` : ''}, design subject from the image, audience "${preferredAudience || 'Men and Women'}".`
  : `Order: ${brandName}, then the MANDATORY #1 keyword, then ${attributePin ? `the MANDATORY #2 blank-brand "${attributePin}", then an optional supporting keyphrase` : 'multiple supporting keyphrases/specs from above (fill the title)'}, then the audience.`} It should read like a human-written phrase.

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
- Must read like a human wrote it. Return ONLY the title.`

  // COUNCIL (PO directive: big decisions DEBATE, not one agent). Apparel/design titles — where the
  // keyword-stuffing problem lives — run the 3-persona debate -> adversary -> judge over the SAME
  // brief. Non-apparel keeps the single fast agent (those titles already work). Either way the result
  // flows through the validate + deterministic backstops below, so the hard rules still hold.
  let title: string
  if (apparel) {
    title = await runTitleCouncil(openai, system, user, input.onProgress)
  } else {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.3,
      max_tokens: 120,
    })
    title = (completion.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
  }
  let problems = title ? validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName) : ['No title generated.']
  let retried = false

  // Up to 2 corrective passes — the mandatory-keyword + max-2 rules are non-negotiable.
  for (let attempt = 0; attempt < 2 && title && problems.length > 0; attempt++) {
    retried = true
    const fix = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: `You are an Amazon SEO title editor${apparel ? ' for apparel' : ''}. Output ONLY the corrected title string.` },
        { role: 'user', content: `Fix this title. Brand: ${brandName}\nTitle: ${title}\n\nProblems:\n- ${problems.join('\n- ')}\n\nWrite it as natural readable language (NO " - " dashes or pipes): ${brandName} then ${mustInclude ? `the MANDATORY keyword "${mustInclude}"` : 'the top keyphrase'}${attributePin ? ` then the blank-brand "${attributePin}" if it fits` : ''} then ${apparel ? 'an optional supporting keyphrase if it fits' : 'ONE supporting keyphrase if it fits'}${preferredAudience ? ` then "for ${preferredAudience}"` : ''}. Front-load the mandatory keyword. ${apparel ? '50-75 chars' : 'TARGET 60-75 chars'} — HARD CAP 75 (Amazon auto-rewrites longer titles after July 27, 2026; overflow keyphrases belong in backend keywords, not here). ${apparel ? 'Product-type word ("shirt"/"tee") used AT MOST twice total. ' : 'Name the product type once or twice; do NOT reframe it as apparel. Include technical search terms (UHS-I/Class N/USB-C/Bluetooth/MB-per-s/capacity/model identifiers) when present in the keyword pool — they ARE search terms. NO filler words ("Durable", "Reliable", "Solution", "Premium", "Versatile"). '}No seasonal terms. No dry physical specs shoppers don\\'t search.${apparel ? ' ONE audience.' : ''} Return ONLY the corrected title.` },
      ],
      temperature: 0.2,
      max_tokens: 120,
    })
    const corrected = (fix.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
    if (corrected) {
      const cp = validateTitle(corrected, brandName, mustInclude, attributePin, upgradeKws, designName)
      // Require a STRICT improvement (fewer problems) to replace — otherwise a same-count single-agent
      // rewrite could silently discard a clean, debated council title (adversarial review caught this).
      if (cp.length < problems.length) { title = corrected; problems = cp }
    }
  }

  // Compliance guarantee: brand must lead. ALWAYS prefix — the 75-char hard-cap backstop at the
  // end trims the TAIL, so adding the brand up front can never be the thing that gets cut.
  if (title && brandName && !title.toLowerCase().includes(brandName.toLowerCase())) {
    title = `${brandName} ${title}`.trim()
    problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
  }

  // Audience guarantee: never silently narrow a unisex product to one gender.
  if (preferredAudience === 'Men and Women' && title) {
    const lc = title.toLowerCase()
    if (/\bm[ae]n\b/.test(lc) && !/\bwom[ae]n\b/.test(lc)) {
      const swapped = title
        .replace(/\bfor Men\b/i, 'for Men and Women')
        .replace(/\bMen'?s\b/i, "Men's and Women's")
      // No length gate: widening the audience is a compliance fix; the 75-char backstop below
      // protects length (and knows to drop a truncation-mangled audience rather than narrow it).
      if (swapped !== title) { title = swapped; problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName) }
    }
  }

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
        problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
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
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
    }
  }

  // Deterministic backstop (all categories): kill a redundant gendered audience the LLM stacked on
  // top of the inclusive one ("for Women for Men and Women" → "for Men and Women"). The validator
  // flags the repeat but gpt-4.1-mini's retry couldn't clear it (verified live on B0G884ZJ27).
  {
    const tidied = dedupeAudiencePhrases(title)
    if (tidied && tidied !== title) {
      title = tidied
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
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
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
    }
  }

  // Deterministic backstop (apparel): a sub-50-char title wastes real keyword space even under the
  // 75-char cap (the validator's floor is 50). Lead the garment brand with a FEEL adjective —
  // "Soft/Comfy/Cozy/Cool Comfort Colors" — which reads better AND lifts the title toward 50-75.
  // The word VARIES by a stable design hash so it's never hardcoded to one (PO: "if can be Comfy,
  // it can be Soft, Cool etc") yet stays consistent for a given product. Only when short, only when
  // there's a garment brand in the title, and only if no feel word is already in front of it.
  if (apparel && title.length < 50 && attributePin) {
    const pinEsc = attributePin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = title.match(new RegExp(`\\b${pinEsc}\\b`, 'i'))
    if (m && m.index != null && !/\b(comfy|soft|cozy|cool|cute|premium|comfortable)\b/i.test(title.slice(0, m.index))) {
      const FEEL = ['Soft', 'Comfy', 'Cozy', 'Cool']
      const seed = (designName || title).split('').reduce((a, c) => a + c.charCodeAt(0), 0)
      const mod = FEEL[seed % FEEL.length]
      const padded = `${title.slice(0, m.index)}${mod} ${title.slice(m.index)}`.replace(/\s{2,}/g, ' ').trim()
      if (padded.length <= 75) {
        title = padded
        problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
      }
    }
  }

  // Deterministic backstop: the LLM keeps stacking product-type synonyms on keyword-heavy
  // non-apparel titles despite the prompt + candidate de-dup — so collapse them mechanically.
  if (!apparel) {
    const cleaned = collapseProductPhrases(title)
    if (cleaned && cleaned !== title && cleaned.length >= 40) {
      title = cleaned
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
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
      problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
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
  }

  // ── HARD CAP 75 — the last gate before the title leaves the agent (Amazon auto-rewrites longer
  // titles from July 27, 2026). Everything valuable is front-loaded by now; capTitle75 trims the
  // tail at a word boundary and never leaves a narrowed audience fragment.
  if (title.length > 75) {
    title = capTitle75(title)
    problems = validateTitle(title, brandName, mustInclude, attributePin, upgradeKws, designName)
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
  const oppPlusDesign = dn ? [dn, ...opportunityKws.filter((k) => k.toLowerCase() !== dn.toLowerCase())] : opportunityKws
  // G4 — GIFT & OCCASION audience pool. Role/audience keywords are (correctly) excluded from
  // every other pool as product-identity claims, but they ARE legitimate gift framings
  // ("great gift for teachers") — the one compliant home for these search words in customer
  // copy. Read from RAW input.analysis (the relevance gate + plan filters strip exactly these,
  // same reason compatibilityBrands reads raw), top distinct audience words by opportunity.
  const giftAudiences: string[] = []
  if (apparel) {
    const seenAud = new Set<string>()
    const rankedKw = [...input.analysis].sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0))
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
  const requiredKws = (oppPlusDesign.length ? oppPlusDesign : remaining.slice(0, 8).map((k) => k.keyword)).slice(0, 8)
  const kwList = remaining.slice(0, 8).map((k) => `  - "${k.keyword}"`).join('\n')
  const topLine = requiredKws.length
    ? `\n🔴 REQUIRED SEARCH KEYPHRASES — these are EXACTLY what your bullet ranking is scored on. Coverage is by WORD, not by phrase: each phrase's key words must appear SOMEWHERE across the 5 bullets, but they can be SPREAD across different bullets and different sentences — the full phrase does NOT need to appear contiguously, and paraphrasing is fine. 🚫 NEVER cram a whole multi-word search string into one sentence (e.g. "channel the haitian soccer jersey world soccer cup 2026 aesthetic") — that reads as keyword soup and looks spammy. Instead let the words land where they fit naturally (e.g. "...haitian pride graphic tee..." in one bullet, "...ready for the 2026 world soccer cup..." in another). LEAD bullets 1, 2, 3 with the top three themes. Cover EVERY phrase that fits accurately:\n${requiredKws.map((k) => `  - "${k}"`).join('\n')}\n`
    : ''
  // Rank context for the council — SEPARATE from the required strings above (those are verbatim
  // machine-checked; annotating them would break coverage validation). Striking distance (#11-30)
  // = stronger bullet coverage moves rank fastest; top-10 = defend what's working.
  const rankedCtx = remaining
    .filter((k) => k.organicRank != null)
    .slice(0, 8)
    .map((k) => `"${k.keyword}" #${k.organicRank}${k.organicRank! >= 11 && k.organicRank! <= 30 ? ' (striking distance)' : k.organicRank! <= 10 ? ' (defend)' : ''}`)
    .join(', ')
  const rankLine = rankedCtx
    ? `\nCURRENT ORGANIC RANKS (context, not extra requirements — prioritize natural, leading coverage for striking-distance terms): ${rankedCtx}\n`
    : ''
  const attrLine = attributes.length
    ? `\nKNOWN PRODUCT ATTRIBUTES — real product facts; mention ${apparel ? 'the garment brand and material' : 'the key specs'} in ONE bullet${apparel ? ' (e.g. "comfort colors", "ring-spun cotton")' : ''}. Do NOT let specs crowd out the top keyphrases above:\n  ${attributes.join(', ')}\n`
    : ''
  const system = `You are an Amazon SEO copywriter${apparel ? ' for apparel' : ''}. Return ONLY valid JSON: {"bullets": ["b1","b2","b3","b4","b5"]}. Accuracy to the actual product is non-negotiable — never invent an audience, profession, occasion, or product type the product is not explicitly about.`
  const user = `The title is FINAL (do not change it): "${finalTitle}"

🚫 ACCURACY IS THE #1 RULE — violating it is a failure:
- ${apparel ? 'This is a GRAPHIC TEE; its design is ONLY what the title above says.' : 'This product is EXACTLY what the title above describes — do NOT reframe it as apparel, a t-shirt, "graphic tee", clothing, or "fashion" unless the title literally says so.'} Do NOT claim it is FOR a profession, role, or audience not explicitly named in the title. NEVER write "teacher", "nurse", "mom", "dad", "coach", "student", "educator", "boss", or any job/role word unless that exact word is in the title.${giftAudiences.length > 0 ? ' ONE EXCEPTION — GIFT FRAMING: inside an explicit gift phrase ("great gift for teachers, nurses…") these audience words ARE allowed: a gift suggestion is a use-case, not a product-identity claim. The exception applies ONLY to the dedicated gift bullet described below.' : ''}
- A keyword being in the candidate list does NOT make it usable — SKIP any keyword that forces an inaccurate or awkward claim. Fewer-but-accurate beats more-but-wrong.
- Before returning, RE-READ each bullet: if any implies the product is for a specific job/role/occasion NOT named in the title — or reframes it as a product type it is not — REWRITE it to describe the actual product instead.
${topLine}${rankLine}
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
- 80-200 characters each. Generic for ALL variants (no specific size/color).${capacityFamily ? `
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
    let bProblems = validateBullets(bullets, brandName, opportunityKws, capacityFamilyTokens)
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
- Each bullet 100-200 chars, starting with a 2-3 word BENEFIT HOOK in ALL CAPS then " - ". The hook is a real BENEFIT ("HIGH-SPEED PERFORMANCE", "DURABLE DESIGN") — never a pipeline label like "CRITICAL UPGRADE" or "KEYWORD".
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
        const fbProblems = validateBullets(fb, brandName, opportunityKws, capacityFamilyTokens)
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
            { role: 'user', content: `Rewrite ALL 5 bullets. ${instructions} The product is "${finalTitle}" — describe ONLY that. Keep the 2-3 word ALL-CAPS BENEFIT HOOK + " - " format. Each bullet 100-200 chars. Return ONLY {"bullets":["b1","b2","b3","b4","b5"]}.` },
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
  if (bullets.length > 0 && oppPlusDesign.length > 0) {
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
    for (const kw of missingBulletKeywords(bullets, oppPlusDesign)) {
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
  if (bullets.length > 0) {
    try {
      const beforeMissing = missingBulletKeywords(bullets, oppPlusDesign).length
      const ownBrandSet = ownBrandTokenSet(brandName || '')
      const beforeBrands = findThirdPartyBrands(bullets.join(' '), ownBrandSet).length
      const keyphraseList = oppPlusDesign.slice(0, 12).join(', ')
      const polishResp = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        temperature: 0.4,
        max_tokens: 900,
        messages: [
          { role: 'system', content: `You are an Amazon listing copywriter. Rewrite the 5 bullet points so they read naturally and grammatically: fix awkward keyword insertions, DELETE dangling trailing fragments (e.g. ", costume.", ", womens.", ", 100 days."), and fix obvious misspellings. HARD RULES: return EXACTLY 5 bullets; keep each bullet's "HOOK - body" shape (an ALL-CAPS hook, then " - ", then a clean sentence); each bullet 200 characters or fewer; add NO new brand names; invent NO product claims. KEEP these search keyphrases present somewhere across the 5 bullets, woven NATURALLY (rephrase around them — never just bolt a word onto the end): ${keyphraseList}. Return ONLY a JSON array of exactly 5 strings.` },
          { role: 'user', content: JSON.stringify(bullets) },
        ],
      })
      const rawPolish = (polishResp.choices[0]?.message?.content || '').replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
      const parsedPolish = JSON.parse(rawPolish)
      if (Array.isArray(parsedPolish) && parsedPolish.length === bullets.length &&
          parsedPolish.every((b) => typeof b === 'string' && b.trim().length > 0 && b.trim().length <= 200)) {
        const cleaned = parsedPolish.map((b) => b.trim())
        const afterMissing = missingBulletKeywords(cleaned, oppPlusDesign).length
        const afterBrands = findThirdPartyBrands(cleaned.join(' '), ownBrandSet).length
        // Only adopt the rewrite if coverage did NOT get worse and no new unframed brand crept in.
        if (afterMissing <= beforeMissing && afterBrands <= beforeBrands) bullets = cleaned
      }
    } catch { /* LLM/parse failure — keep the deterministic bullets (readability is best-effort) */ }
  }

  return bullets
}

// ─── Stage 3 — Backend keywords (code grouping + LLM aesthetic assignment) ──────

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
  const excludeWords = new Set(
    `${finalTitle} ${bullets.join(' ')} ${brandName}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  )
  // Color names are auto-indexed from the variant attribute — never repeat them in backend.
  const colors = [...new Set(children.map((c) => (c.color || 'default').toLowerCase()))]
  colors.forEach((c) => excludeWords.add(c))
  // The seller's DESIGN NAME is identity, not a generic auto-indexed title word — exempt its tokens
  // from the exclusion so the fill/dedup can't strip "later"/"gator" out of backend (#91/#92 parity).
  ;(designName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => excludeWords.delete(w))
  // Title-only word set. The role-word exception ("keep 'teacher' only if this IS a teacher
  // product") must check the TITLE, not bullets — a bullet that wrongly slips "teacher" must
  // not license it back into the backend.
  const titleWords = new Set(finalTitle.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))

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
  for (const k of remaining) {
    const raw = k.keyword.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!raw || isAllJunk(raw)) continue
    const toks: ({ w: string; minor: boolean } | null)[] = []
    for (const w of raw.split(' ')) {
      if (JUNK_WORDS.has(w)) { toks.push(null); continue }
      if (banTok(w)) { toks.push(null); continue }            // truth gate: ungrounded style/color/gender/stray
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
    if (getByteLength(corePhrases.join(' ')) >= 215) break
  }
  // Guarantee the product's audience tokens (PO wants Men AND Women in the backend).
  for (const a of ['men', 'women']) {
    if (titleWords.has(a) && !coreWordSet.has(a)) { corePhrases.push(a); coreWordSet.add(a) }
  }
  // Force the exact DESIGN phrase to LEAD the core (deterministic, like the title's design-name lead) so
  // backend ranks for "later gator" and it survives the 228-byte cap. This is the missing must-include
  // that let the design name silently drop from backend ("And Again"); it costs ~1 short phrase of bytes.
  const dnPhrase = (designName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (dnPhrase && !new RegExp(`\\b${dnPhrase.replace(/\s+/g, '\\s+')}\\b`).test(corePhrases.join(' '))) corePhrases.unshift(dnPhrase)
  // FILL: a small product's opportunity pool can run dry well under 250 bytes, leaving the
  // search-term field half-empty (PO: "keywords are 150 chars"). Top it up with LLM long-tail
  // BUYER search words (gifts / occasions / recipients / themes) — run through the SAME junk /
  // role / kids / dedup filters as the core, so it fills with real terms, not rejected junk.
  if (getByteLength(corePhrases.join(' ')) < 205) {
    try {
      const fillSys = 'You generate ADDITIONAL Amazon backend search keywords (long-tail buyer phrases) to fill the search-term field. Return ONLY JSON: {"keywords":"lowercase space-separated search words"}.'
      const fillUsr = `Product: ${finalTitle}
List ~25 ADDITIONAL real search terms a shopper would TYPE to find this product — gift occasions, recipients, styles, themes, related concepts (e.g. "fathers day gift", "summer vacation tee", "novelty graphic", "animal lover gift", "back to school").
ONLY real buyer search words. NO brand, NO color names, NO sizes, NO moods/adjectives ("elegant", "timeless", "premium", "cozy"). lowercase, space-separated, no commas/quotes.
Avoid reusing: ${[...coreWordSet, ...titleWords].slice(0, 60).join(' ')}
Return ONLY the JSON.`
      const fc = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'system', content: fillSys }, { role: 'user', content: fillUsr }],
        temperature: 0.6,
        max_tokens: 300,
        response_format: { type: 'json_object' },
      })
      const fillParsed = parseJsonLoose<{ keywords?: string }>(fc.choices[0]?.message?.content || '{}')
      const fillOut: string[] = []
      for (const w of (fillParsed.keywords || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
        if (!w || JUNK_WORDS.has(w) || MINOR_WORDS.has(w)) continue
        if (banTok(w)) continue                                        // truth gate (same as the core)
        if (ROLE_WORDS.has(w) && !titleWords.has(w)) continue          // weak-relevance role
        if (kidsWords.has(w) && !titleWords.has(w)) continue           // wrong audience
        if (THIRD_PARTY_BRANDS.has(w) && !ownBrandsForBackend.has(w)) continue  // 3P brand: trademark risk
        if (coreWordSet.has(w) || excludeWords.has(w)) continue        // already covered / auto-indexed
        if (PRODUCT_TYPE_WORDS.has(w)) { if (productTypeCount >= 2) continue; productTypeCount++ }
        coreWordSet.add(w); fillOut.push(w)
        if (getByteLength([...corePhrases, fillOut.join(' ')].join(' ')) >= 224) break
      }
      if (fillOut.length) corePhrases.push(fillOut.join(' '))
    } catch { /* fill is best-effort; the opportunity core still ships */ }
  }
  // The core is the opportunity keywords + long-tail fill — most of the 250 bytes (NOT colors).
  const core = truncateToBytes(corePhrases.join(' '), 228)

  // ── PER-COLOR TAIL: just the 2-3 top shade synonyms for THIS variant's color (not 10) ──
  const system = 'You generate a SHORT Amazon backend color tail per color variant. Return ONLY valid JSON: {"groups":[{"color":"<color>","keywords":"2-3 lowercase color words"}]}.'
  const user = `Color variants: ${colors.join(', ')}

For EACH color, output ONLY the 2-3 MOST-SEARCHED shade synonyms a buyer would type — no more than 3. Examples:
  light green -> sage olive
  ivory -> cream off white
  pepper -> charcoal heather
Use ONLY real color/shade SEARCH words — NEVER moods/feelings ("serene", "calm", "whimsical", "elegant", "timeless"). Max 3 words per color.

Do NOT use any of these words (already covered in title/bullets/core/color names):
${[...excludeWords].slice(0, 50).join(' ')}

Rules: lowercase, space-separated, NO commas, NO quotes, no brand or size words, 2-3 words ONLY.
Return ONLY the JSON object.`

  const tailMap = new Map<string, string>()
  if (apparel) {
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
    if (colors.length > 1 && tailMap.size === 0) {
      console.warn(`[runBackendAgent] color-tail call returned nothing for ${colors.length} colors — children will share the core string`)
    }
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
      .filter((w) => w && !effectiveCoreWords.has(w) && !excludeWords.has(w) && !MINOR_WORDS.has(w))
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
        childCore = truncateToBytes(stripped, 228)
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
  const { openai, auditModel, variantDetails, keywordContext, hasAplus, category, repTitle, productType, detailAttributeMenu } = input
  const apparel = looksApparel(category, repTitle, productType)
  const backendSummary = perChild.slice(0, 3).map((p) => `  ${p.sku}: ${p.keywords}`).join('\n')
  const specsLine = specs.length
    ? `\n=== KNOWN PRODUCT SPECS (use these to fill structured Product-Detail fields with REAL values — e.g. ${apparel ? 'Fabric Type, Material, Fit Type, Department' : 'Material, Capacity, Compatibility, Item Dimensions'}) ===\n${specs.join(', ')}\n`
    : ''
  // Live schema menu (PO: "auto-map any item to the category's Features") — the ONLY attributes
  // Amazon accepts for THIS product type, with their real enum values. When present the audit
  // picks from it instead of guessing apparel-shaped field names (Department on sticky notes).
  const menu = (detailAttributeMenu ?? []).slice(0, 14)
  const menuLine = menu.length
    ? `\n=== AMAZON ATTRIBUTE MENU for this product type (the ONLY Product-Detail field names Amazon accepts here) ===\n${menu.map((m) => `- ${m.title}${m.accepted?.length ? ` [accepted values: ${m.accepted.slice(0, 12).join(' | ')}]` : ''}`).join('\n')}\n`
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
${specsLine}${menuLine}
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
- PRODUCT DETAILS: the structured attributes in Seller Central → More Details power Amazon's filtered search + the spec comparison table, and are almost always under-filled. Do NOT assume they're already set — PROACTIVELY recommend a value for EVERY standard attribute a shopper filters THIS product type by. ${menu.length ? 'Use ONLY field names from the AMAZON ATTRIBUTE MENU above, with the EXACT names shown — any other field name is rejected by Amazon for this product type. Where the menu lists accepted values, recommended_value MUST be one of them, verbatim. Pick the 5-10 menu attributes that most improve filtered search for THIS product.' : apparel ? 'Cover (as applicable), using these EXACT field names (they match Amazon\'s apparel schema — suffixed variants like "Neck Style"/"Sleeve Type" are NOT valid top-level attributes and get rejected): Material, Fabric Type, Fit Type, Care Instructions, Department, Neck, Sleeve, Closure.' : 'Cover (adapt to the ACTUAL product — e.g. for a memory/SD card): Capacity, Read Speed, Write Speed, Speed Class, Video Speed Class, Flash Memory Type, Form Factor, Hardware Interface, Compatible Devices, Manufacturer Warranty. NOT apparel fields like Fabric Weight or Fit Type.'} Derive recommended_value from the title/bullets/keywords/specs above; set current_value to null when you can't confirm it from the listing. Emit 5-10 — these win filtered search, so err toward MORE rather than fewer.
- A+ modules: more modules lift conversion and dwell time; A+ body text is not a confirmed ranking field, so recommend filling image ALT-TEXT for discoverability.
Return ONLY the JSON object.`

  const completion = await openai.chat.completions.create({
    model: auditModel,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: 8000,
    response_format: { type: 'json_object' },
  })
  return parseJsonLoose<AuditResult>(completion.choices[0]?.message?.content || '{}')
}

// ─── Description (code-triggered LLM, always generated — field is indexed) ──────

async function runDescriptionAgent(input: PipelineInput, finalTitle: string, bullets: string[], attributes: string[], compatibilityBrands: string[] = [], topOpportunityKws: string[] = []): Promise<string> {
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
  const system = `You are an Amazon SEO copywriter${apparel ? ' for apparel' : ''}. Return ONLY the HTML description (no markdown, no JSON). Describe ONLY the actual product — never invent an audience, profession, occasion, or product type the product is not explicitly about.`
  const user = `Write a CONCISE, keyword-rich HTML product description (generic for all variants) of 900-980 characters of VISIBLE text (excluding HTML tags) — about 150 words — using <p>, <b>, <ul>, <li>. Be tight and punchy; lead with the strongest selling points and cover ${apparel ? 'the design, materials, fit, styling, and use cases' : "the product's features, specs, quality, and use cases"}. Do NOT exceed 980 visible characters.
Title: ${finalTitle}
Bullet themes: ${bullets.map((b) => b.split(' - ')[0]).join(', ')}${attrLine}${kwLine}

🚫 ACCURACY: describe ONLY what the title says this product is${apparel ? '' : ' — do NOT reframe it as apparel / a t-shirt / clothing unless it genuinely is one'}. Do NOT claim it is for a profession/role/occasion not named in the title — never write "teacher", "nurse", "mom", "educator", "coach", etc. unless that word is in the title. If a bullet theme above implies such a claim, ignore that theme and describe the actual product instead.

🚫 BRAND-NAME SAFETY (Amazon Jan 2025 policy): any third-party brand name (Canon, Nikon, Sony, GoPro, SanDisk, Kingston, Lexar, Samsung, Apple, iPhone, DJI, Bose, etc. — anything not your own brand) appears ONLY in 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]' phrasing. Examples: ✓ 'compatible with Canon EOS R5 and Sony Alpha cameras', ✗ 'Sandisk-quality storage' (bare brand reference — risks listing suppression and trademark complaints).${compatibilityBrands.length > 0 ? `

🟢 COMPATIBILITY (high-opportunity): the product genuinely works with these device brands and shoppers search for them. Naturally work the top ones into the description using "Compatible with [Brand]" framing (one feature bullet or sentence — never bare): ${compatibilityBrands.join(', ')}. Example: "Compatible with ${compatibilityBrands.slice(0, 2).join(' and ')} cameras". Legal referential use that captures real buyer traffic.` : ''}${descCapacityFamily ? `

🚫 CAPACITY: this family has MULTIPLE capacities (${descFamilyCapList}). The description is SHARED across all variants — NEVER hardcode a specific GB number in any paragraph or bullet (no "128GB and 64GB capacities", no "this 128GB SD card", no "Available in 128GB and 64GB"). Use capacity-agnostic phrasing: "available in multiple capacities", "high-capacity storage", "ample space for your needs". The capacity-specific text already lives in each variant's TITLE.` : ''}

Structure: hook -> <ul> of key features -> use cases/audience -> short closing line. Return ONLY the HTML.`
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.5,
    max_tokens: 1200,
  })
  let description = (completion.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()

  // ── Brand-safety + length retry (validateDescription) ─────────────────────────
  // Same shape as runTitleAgent / runBulletsAgent: up to 2 corrective passes. Closes the
  // last surface in PR #75 — title (#74), bullets (above), and now description all share
  // the parent/child coverage standard for validate+retry.
  const { brandName: descBrand } = input
  // PR #90: family capacity tokens for the description capacity-family check (mirrors bullets).
  const descCapTokens = descCapacityFamily ? [...descChildCaps].map((c) => c.toUpperCase()) : []
  if (description && descBrand) {
    let dProblems = validateDescription(description, descBrand, descCapTokens)
    for (let attempt = 0; attempt < 2 && dProblems.length > 0; attempt++) {
      try {
        const capClause = descCapTokens.length >= 2
          ? `\n- 🚫 CAPACITY: family spans ${descCapTokens.join(', ')}. The description is SHARED — NEVER hardcode a specific GB/TB ("128GB"). Use capacity-agnostic phrasing only.`
          : ''
        const fix = await openai.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `Rewrite the description to fix these problems. The product is "${finalTitle}" — describe ONLY that.

Problems:
- ${dProblems.join('\n- ')}

Rules to honor on rewrite:
- 900-980 visible characters (~150 words) HTML using <p>, <b>, <ul>, <li>. Do NOT exceed 980 visible characters.
- Any third-party brand name (Canon/Nikon/Sony/GoPro/SanDisk/Kingston/Lexar/Samsung/Apple/iPhone/DJI/Bose etc. — anything not "${descBrand}") appears ONLY as 'for [Brand]', 'compatible with [Brand]', or 'works with [Brand]'.${capClause}
- Return ONLY the HTML.` },
          ],
          temperature: 0.4,
          max_tokens: 1200,
        })
        const corrected = (fix.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
        if (!corrected) break
        const cdProblems = validateDescription(corrected, descBrand, descCapTokens)
        if (cdProblems.length < dProblems.length) { description = corrected; dProblems = cdProblems }
        else break
      } catch { break /* keep best-so-far */ }
    }

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
            { role: 'user', content: `Rewrite the HTML description. ${instructions} The product is "${finalTitle}" — describe ONLY that. 900-980 visible characters (~150 words) HTML using <p>, <b>, <ul>, <li>; do NOT exceed 980 visible characters. Return ONLY the HTML.` },
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
  // One expand pass when notably short (< 850). Threshold sits just under the 900-floor so an
  // in-band (900-980) description is NEVER expanded back over the cap. Best-effort; the prompt
  // forbids inventing facts/audiences. (Was < 1300 toward 270-330 words — that fought the new cap.)
  const plainLen = (d: string) => d.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length
  if (description && plainLen(description) < 850) {
    try {
      const expand = await openai.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Expand this product description to about 900-980 visible characters (~150 words; do NOT exceed 980 visible characters). Do NOT invent facts, audiences, professions, or uses not already implied. Same product ("${finalTitle}"); keep every third-party brand in "compatible with [Brand]" framing; keep clean HTML (<p>, <b>, <ul>, <li>).

Too-short description to expand:
${description}

Return ONLY the expanded HTML.` },
        ],
        temperature: 0.5,
        max_tokens: 1200,
      })
      const longer = (expand.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
      if (longer && plainLen(longer) > plainLen(description)) description = longer
    } catch { /* keep best-so-far */ }
  }

  // ── CAP at 980 VISIBLE chars (PO 2026-06-17: keep the description Amazon-compliant at 900-980
  // visible chars — the deterministic guarantee, mirroring capTitle75). Measure tag-stripped length;
  // if over, find the HTML offset where visible text reaches the cap, then trim at the last closing
  // tag boundary at/before it so the live PDP never shows a cut mid-word / mid-tag.
  const DESC_VISIBLE_CAP = 980
  if (plainLen(description) > DESC_VISIBLE_CAP) {
    let vis = 0
    let off = description.length
    for (let i = 0; i < description.length; i++) {
      if (description[i] === '<') { const c = description.indexOf('>', i); if (c === -1) break; i = c; continue }
      if (++vis >= DESC_VISIBLE_CAP) { off = i + 1; break }
    }
    let bestEnd = -1
    for (const tag of ['</p>', '</li>', '</ul>']) {
      const i = description.lastIndexOf(tag, off)
      if (i >= 0 && i + tag.length > bestEnd) bestEnd = i + tag.length
    }
    description = bestEnd > 0
      ? description.slice(0, bestEnd).trim()
      : description.slice(0, off).replace(/<[^>]*$/, '').replace(/\s+\S*$/, '').trim()
  }

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
KEEP anything plausibly about this product, including broad descriptors, audiences, occasions, gift terms, and seasonal terms (relevant even when broad). Be CONSERVATIVE — only drop clearly-unrelated or clearly-meaningless terms. Return ONLY {"drop":[...]}.`
  // Deterministic backstops: ALWAYS drop these regardless of the LLM gate, which is
  // non-deterministic and let them through in live testing.
  //   1. all-junk keywords ("interest", "full transparency", "best seller")
  //   2. trademark phrases (sports teams, universities, media franchises) — PR #77
  //      after live B0G884ZJ27 audit leaked "Florida Gators" into a recommended title.
  //      Generic team-mascot words ("alligator", "gators", "lions") still pass through
  //      — only the multi-word REGISTERED phrases are dropped.
  const dropJunkAndTrademarks = (kws: AnalyzedKeyword[]) => kws.filter((k) => {
    if (isAllJunk(k.keyword)) return false
    if (findTrademarkPhrases(k.keyword).length > 0) return false
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
    const drop = new Set((parsed.drop ?? []).filter((n) => Number.isInteger(n)))
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
  const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
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

Return ONLY {"designName":"<phrase or empty string>"}.`
    const user = `${visionText ? `Image: ${visionText}\n` : ''}Title: ${source}\n\nReturn ONLY {"designName":"..."}.`
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
    opportunityScore: 35,
    actionType: 'CRITICAL',
    actionText: '', rationale: '', urgency: 'high', estimatedImpact: '',
    searchVolume: 0, keywordSales: 0, competingProducts: 0,
    asinImpressionShare: 0, asinClickShare: 0, asinPurchaseShare: 0,
    inTitle: false, inBullets: false, inDescription: false, inBackend: false,
    dataSource: 'jungle_scout',
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
): Promise<{ title: string; problems: string[]; retried: boolean }> {
  const motifTrust = `${input.canonicalTitle ?? ''} ${input.repTitle ?? ''} ${designName}`.toLowerCase()
  const t = await runTitleAgent(input, candidates, searchKeyphrases, titleMustInclude, preferredAudience, attributePinFinal, topUpgradeKws, compatibilityBrands, designName)
  const titleProblems = t.problems
  const retried = t.retried
  // 1. Vision-hallucination backstop.
  let finalTitle = apparelProduct ? stripContradictedGarments(stripUngroundedMotifs(t.title, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase()) : t.title
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
    const tail = tailMatch ? tailMatch[0] : ''
    let head = tail ? finalTitle.slice(0, finalTitle.length - tail.length) : finalTitle
    const headToks = new Set(bulletTokens(head))
    const titleCaseKw = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
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
      const toks = bulletTokens(kw)
      if (toks.length === 0 || toks.every((tt) => headToks.has(tt))) continue
      if (lean === 'female' && MASC_T.test(kw) && !FEM_T.test(kw)) continue
      if (lean === 'male' && FEM_T.test(kw) && !MASC_T.test(kw)) continue
      const safe = stripContradictedGarments(stripUngroundedMotifs(kw, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase())
      if (safe !== kw) continue
      const next = `${head}, ${titleCaseKw(safe)}`
      if ((next + tail).length > 75) continue
      head = next
      for (const tt of toks) headToks.add(tt)
      if ((head + tail).length >= 73) break
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
// + blank-brand dedup. Design-name backstop SKIPPED (no single design name to anchor).
async function buildNicheParentTitle(
  openai: OpenAI,
  brandName: string,
  designNames: string[],
  blankBrand: string | undefined,
  preferredAudience: string,
  productType: string | null,
  topUpgradeKws: string[],
  compatibilityBrands: string[],
  onProgress: ((m: string) => void) | undefined,
): Promise<string> {
  const ptWord = /T_SHIRT|SHIRT|TEE/i.test(productType ?? '') ? 'T-Shirt' : (productType ? productType.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : 'Shirt')
  const aud = preferredAudience || 'Men and Women'
  const designNameList = designNames.filter(Boolean).slice(0, 6).join(', ') || '(unnamed)'
  const upgradeList = topUpgradeKws.slice(0, 8).join(', ') || '(none)'
  const compatList = compatibilityBrands.length > 0 ? compatibilityBrands.slice(0, 3).join(', ') : ''
  const baseSystem = `You are an Amazon SEO copywriter writing the BROADCAST PARENT TITLE for a variation family where the children carry distinct DESIGNS that share a NICHE. The parent title is the variation hub shoppers see in search results BEFORE picking a specific design — it must capture the NICHE and product type but MUST NOT name any specific design.`
  const baseUser = `Brand: ${brandName}
Blank brand (if any): ${blankBrand ?? '(none)'}
Product type: ${ptWord}
Audience: ${aud}
Child design names (DO NOT name any of these in the parent title — they belong to specific children): ${designNameList}
High-value niche keywords from the keyword pool (use ONLY the ones that broadcast to ALL designs in this family — pick the niche-wide terms, skip design-specific motifs): ${upgradeList}${compatList ? `
Compatibility (for-Brand framing if relevant): ${compatList}` : ''}

Rules:
- Brand FIRST. Then ${blankBrand ? `the blank brand "${blankBrand}", then ` : ''}the niche + product type, then optional supporting niche keyphrases that broadcast to ALL designs, then "for ${aud}" at the end.
- HARD CAP 75 characters (Amazon auto-rewrites longer titles after July 27, 2026).
- 50-75 chars; do not stuff. No design names, no design-specific motifs.
- Read like a human wrote it. Return ONLY the final title string.`
  const judged = await runTitleCouncil(openai, baseSystem, baseUser, onProgress)
  let title = (judged || '').trim()
  // Post-guards: capTitle75 + blank-brand dedup + brand-dedup + brand-front. NO design-name backstop (intentional).
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
    const rest = title.slice(brandLen).replace(/[A-Za-z][A-Za-z'’-]*/g, (w, off: number) => {
      const lw = w.toLowerCase()
      if (off > 0 && MINOR_WORDS.has(lw)) return lw
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    title = head + rest
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
    const headToks = new Set(bulletTokens(fillHead))
    const designTokSets = designNames.filter(Boolean).map((d) => new Set(bulletTokens(d)))
    const titleCaseKw = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
    for (const kw of topUpgradeKws) {
      const toks = bulletTokens(kw)
      if (toks.length === 0 || toks.every((tt) => headToks.has(tt))) continue
      if (isAllJunk(kw)) continue
      if (designTokSets.some((ds) => toks.filter((tt) => ds.has(tt)).length >= 2)) continue
      const next = `${fillHead}, ${titleCaseKw(kw)}`
      if ((next + tail).length > 75) continue
      fillHead = next
      for (const tt of toks) headToks.add(tt)
      if ((fillHead + tail).length >= 73) break
    }
    title = `${fillHead}${tail}`
  }
  return title
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

export async function runListingPipeline(input: PipelineInput): Promise<PipelineResult> {
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
  // Only SEARCHABLE keyphrases (e.g. "comfort colors graphic tee") become title-eligible
  // keywords. Specs (garment-dyed, ring-spun cotton, relaxed fit) are NOT search terms and
  // must NOT enter the title — they go to bullets/description/structured fields only.
  const analysis = [...attrs.searchKeyphrases.map(attributeAsKeyword), ...cleanGated]
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
      if (boostRe.test(k.keyword) && !demoteRe.test(k.keyword)) k.opportunityScore = (k.opportunityScore || 0) * 1.2
      else if (demoteRe.test(k.keyword) && !boostRe.test(k.keyword)) k.opportunityScore = (k.opportunityScore || 0) * (hard ? 0.5 : 0.8)
    }
  }

  const mustIncludeKw = cleanGated
    .filter((k) => ['CRITICAL', 'UPGRADE', 'DEFENDED', 'REINFORCE'].includes(k.actionType))
    .filter((k) => !isSeasonal(k.keyword))
    .filter((k) => k.keyword.split(/\s+/).length <= 6)
    .sort((a, b) => (b.searchVolume || 0) - (a.searchVolume || 0) || (b.opportunityScore || 0) - (a.opportunityScore || 0))[0]
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
  const preferredAudience = !apparelProduct ? ''
    : lean === 'male' ? 'Men'
    : lean === 'female' ? 'Women'
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
  const candidates = selectTitleCandidates(analysis, brandName, repTitle, input.outcomeSignals)
    .filter((c) => !colorNeutralFamily || !BASIC_COLOR_RE.test(c.keyword))

  // Stage 0c — top UPGRADE keywords for explicit title-coverage. UPGRADE = ranking
  // signal already present in bullets but absent from the title. The scorer in
  // syncListingContent.ts docks 5 points when 7+ of these are missing (3 when 3-6
  // miss). We feed them to the title agent as MANDATORY #3 and fail validation when
  // 3+ still aren't in the title, so the existing retry loop is on the hook for
  // covering them — not the seller.
  const topUpgradeKws = cleanGated
    .filter((k) => k.actionType === 'UPGRADE')
    .filter((k) => !isSeasonal(k.keyword))
    .filter((k) => !colorNeutralFamily || !BASIC_COLOR_RE.test(k.keyword))  // color-neutral broadcast title
    .filter((k) => k.keyword.split(/\s+/).length <= 6)  // skip long-tail phrases that wouldn't fit
    .sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0))
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
      .filter((k) => !isSeasonal(k.keyword))
      .sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0))
    for (const k of ranked) {
      for (const brand of findThirdPartyBrands(k.keyword, ownB)) {
        // Title-case the brand for display ("canon" → "Canon", multi-word kept lower→Title).
        const display = brand.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        if (!seen.has(display)) { seen.add(display); compatibilityBrands.push(display) }
      }
      if (compatibilityBrands.length >= 6) break
    }
  }

  // Design-name anchor (PR #91): the seller's distinctive design/slogan ("Later Gator")
  // that MUST survive into the title verbatim — the agent kept paraphrasing it away.
  const { name: designName, source: designSource } = await extractDesignName(input)

  // Phase 1 multi-design detection (DEBUG-only here — Commit 1). When the family carries ≥2 distinct
  // designs (SKU-prefix groups), the next commit branches title generation per design + per-design
  // vision; the parent keeps a general title. For now we only OBSERVE it (no behavior change) so the
  // detection can be verified live before the per-design title build engages.
  const designGroupInfo = apparelProduct ? detectDesignGroups(input.children) : { isMultiDesign: false, groups: [] }
  // PRESSURE-TEST FINDING #9: scorer (syncListingContent.scoreListingContent) docks bullet score
  // when keyword_plan.designName is present but missing from a child's bullets. For multi-design,
  // there is NO SINGLE family design name — each design has its own (in per_child_titles). Setting
  // effectiveDesignName='' for multi-design prevents the false-negative bullet cohesion dock.
  // Declared HERE (before partialResult) so partialResult's closure captures it.
  const effectiveDesignName: string = apparelProduct && designGroupInfo.isMultiDesign ? '' : designName

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
  const scrubPublished = (r: PipelineResult): PipelineResult => ({
    ...r,
    recommended_title: scrubTrademarks(r.recommended_title),
    recommended_bullets: scrubTrademarksArr(r.recommended_bullets),
    recommended_description: scrubTrademarks(r.recommended_description),
    per_child_keywords: r.per_child_keywords.map((c) => ({ ...c, keywords: scrubTrademarks(c.keywords) })),
    // Commit 2: per_child_titles ALSO ship to Amazon (multi-design POD + capacity families).
    // Adversarial review caught the gap — a trademark in a per-design title was unscrubbed.
    per_child_titles: r.per_child_titles?.map((c) => ({ ...c, title: scrubTrademarks(c.title) })),
  })
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
    keywordPlan: { bullets: [], designName: effectiveDesignName },
    debug: { titleProblems: [], candidatesUsed: [], titleRetried: false, designName, designSource, multiDesign: designGroupInfo.isMultiDesign, designGroups: designGroupInfo.groups.map((g) => g.key) },
    regeneratedSection: section,
    ...fields,
  })

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
  let finalTitle: string
  let titleProblems: string[] = []
  let retried = false
  // Hoisted: multi-design apparel populates this in the title branch; the non-apparel capacity
  // branch below populates it for single-design capacity families. Single-design apparel: stays undefined.
  let perChildTitles: { sku: string; asin: string; title: string }[] | undefined
  if (apparelMultiDesign && (!only || only === 'title')) {
    // PER-DESIGN TITLES (Phase 1 Commit 2 + hot-fix). Each design group resolves its design name
    // via this chain (PO 2026-06-17: "design name is stored as Amazon's Color attribute"):
    //   1. PRIMARY — fetch rep child's Amazon attributes (color → style_name → color_name) via
    //      Listings Items API. First non-empty wins.
    //   2. BACKUP — per-group vision scan (gpt-4.1-mini reading the rep child's image).
    //   3. LAST-RESORT — extractDesignName on the cloned groupInput.
    // Pressure-test mitigations preserved:
    //   - groupInput.canonicalTitle = group's child stored title (NOT parent canonical →
    //     prevents cross-design fill-bigram leakage, finding #3)
    //   - searchKeyphrases reused from parent's filtered pool (finding #1a)
    //   - vision scans + attribute fetches parallel via Promise.all
    onProgress(`Writing ${designGroupInfo.groups.length} per-design titles + niche-aware parent...`)
    perChildTitles = []
    // Resolve SP-API creds ONCE for the whole loop. Best-effort: a failure here just means the
    // per-design name resolution falls through to vision + extractDesignName (today's behavior).
    let spToken: string | null = null
    let spSellerId: string | null = null
    try { spToken = await getSpApiAccessToken(); spSellerId = await getSpApiSellerId() } catch (e) { console.warn('[pipeline] SP-API creds unavailable for per-design color fetch — falling back to vision:', e instanceof Error ? e.message : e) }
    const SP_ENDPOINT_URL = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
    const SP_MP_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
    const fetchDesignNameAttr = async (sku: string): Promise<string> => {
      if (!spToken || !spSellerId || !sku) return ''
      try {
        const u = `${SP_ENDPOINT_URL}/listings/2021-08-01/items/${spSellerId}/${encodeURIComponent(sku)}?marketplaceIds=${SP_MP_ID}&includedData=attributes`
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
    const groupResults = await Promise.all(designGroupInfo.groups.map(async (group) => {
      const groupChildren = group.skus
        .map((s) => input.children.find((c) => c.sku === s.sku))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
      const repSku = group.skus[0]?.sku ?? ''
      const repAsin = group.skus[0]?.asin ?? input.children[0]?.asin ?? ''
      const groupRepTitle = groupChildren[0]?.title ?? input.repTitle ?? null
      // PRIMARY: Amazon Color attribute (the seller's design-name slot).
      const colorAttrName = await fetchDesignNameAttr(repSku)
      // BACKUP: per-group vision scan (only when color attribute is empty — saves the OpenAI call
      // on the common case where every group has a real color attribute, ~1-2s per group).
      let groupVision = input.visionDesign
      if (!colorAttrName) {
        try {
          const url = repAsin ? await getProductImageUrl(repAsin) : null
          const identity = url && repAsin ? await scanProductImage(repAsin, url, { openai: input.openai }) : null
          if (identity) {
            groupVision = {
              designTheme: identity.designTheme || '',
              visualElements: Array.isArray(identity.visualElements) ? identity.visualElements : [],
              seedKeywords: Array.isArray(identity.seedKeywords) ? identity.seedKeywords : [],
            }
          }
        } catch (e) { console.warn(`[pipeline] per-design vision ${repAsin} failed:`, e instanceof Error ? e.message : e) }
      }
      const groupInput: PipelineInput = {
        ...input,
        canonicalTitle: groupRepTitle,
        repTitle: groupRepTitle ?? input.repTitle,
        visionDesign: groupVision,
        // Pass the Color-attribute value as the override so extractDesignName returns it verbatim.
        // null (no color attribute) → extractDesignName runs its normal heuristic chain (vision +
        // canonical + repTitle), giving us today's behavior as the last-resort fallback.
        designNameOverride: colorAttrName || null,
        children: groupChildren,
      }
      const { name: groupDesignName } = await extractDesignName(groupInput)
      const r = await buildTitleFor(groupInput, candidates, attrs.searchKeyphrases, titleMustInclude, preferredAudience, attributePinFinal, topUpgradeKws, compatibilityBrands, groupDesignName, lean, apparelProduct, brandName)
      return { group, groupDesignName, ...r }
    }))
    const allDesignNames: string[] = []
    for (const gr of groupResults) {
      allDesignNames.push(gr.groupDesignName)
      for (const s of gr.group.skus) perChildTitles.push({ sku: s.sku, asin: s.asin, title: gr.title })
      titleProblems.push(...gr.problems.map((p) => `[${gr.group.key}] ${p}`))
      retried = retried || gr.retried
    }
    finalTitle = await buildNicheParentTitle(input.openai, brandName, allDesignNames, attributePinFinal, preferredAudience, input.productType ?? null, topUpgradeKws, compatibilityBrands, onProgress)
  } else if (!only || only === 'title') {
    onProgress('Writing title...')
    const r = await buildTitleFor(input, candidates, attrs.searchKeyphrases, titleMustInclude, preferredAudience, attributePinFinal, topUpgradeKws, compatibilityBrands, designName, lean, apparelProduct, brandName)
    finalTitle = r.title
    titleProblems = r.problems
    retried = r.retried
  } else {
    finalTitle = (input.priorTitle || repTitle || '').trim()
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
    onProgress('Title regenerated.')
    return partialResult('title', {
      recommended_title: finalTitle,
      per_child_titles: perChildTitles,
      debug: { titleProblems, candidatesUsed: candidates.map((c) => c.keyword), titleRetried: retried, designName, designSource, multiDesign: designGroupInfo.isMultiDesign, designGroups: designGroupInfo.groups.map((g) => g.key) },
    })
  }

  // Bullets pool (PR15): critical/upgrade/reinforce, not in title, NO seasonal (bullets are
  // customer-facing — a seasonal claim off-season misleads and mis-describes the product),
  // no awkward >5-word composites, deduped. This is the same discipline the title gets.
  const titleLc = finalTitle.toLowerCase()
  const remainingForBullets: AnalyzedKeyword[] = []
  for (const k of analysis) {
    if (!['CRITICAL', 'UPGRADE', 'REINFORCE'].includes(k.actionType)) continue
    if (titleLc.includes(k.keyword.toLowerCase())) continue
    if (isSeasonal(k.keyword)) continue
    if (k.keyword.split(/\s+/).length > 5) continue
    if (remainingForBullets.some((d) => wordOverlapRatio(d.keyword, k.keyword) >= 0.6)) continue
    remainingForBullets.push(k)
  }
  // Highest-opportunity first so bullets 1-3 reinforce the true top keyphrases.
  remainingForBullets.sort((a, b) => b.opportunityScore - a.opportunityScore)

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
  const topOppGated = cleanGated
    .filter((k) => k.actionType === 'CRITICAL' || k.actionType === 'UPGRADE')
    .filter((k) => !isSeasonal(k.keyword))
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
  const topOpportunityKwsForBullets = topOppDeduped
    .sort((a, b) => (b.opportunityScore || 0) - (a.opportunityScore || 0))
    .slice(0, 10)
    .map((k) => k.keyword)
  let bullets: string[]
  if (!only || only === 'bullets') {
    onProgress('Writing bullets...')
    const rawBullets = await runBulletsAgent(input, finalTitle, remainingForBullets, bulletAttrs, topOpportunityKwsForBullets, capacityFamilyTokens, compatibilityBrands, designName)
    // Same vision-hallucination backstop as the title (motif words need seller corroboration),
    // plus the garment-type guard (no "fleece pullover" bullets on a t-shirt family) and the
    // hard-audience swap (no "this men's crew" on a Female-selected listing).
    bullets = apparelProduct
      ? rawBullets.map((b) => stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(b, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase()), attributePinFinal ?? ''))
      : rawBullets
    if (apparelProduct && (lean === 'female' || lean === 'male')) {
      bullets = bullets.map((b) => enforceHardAudience(b, lean === 'female' ? 'Women' : 'Men'))
    }
    bullets = bullets.map((b) => fixDoubledArticleBeforeBrand(b, brandName))
  } else {
    bullets = input.priorBullets ?? []
  }
  if (only === 'bullets') {
    onProgress('Bullets regenerated.')
    return partialResult('bullets', {
      recommended_bullets: bullets,
      keywordPlan: { bullets: topOpportunityKwsForBullets, designName: effectiveDesignName },
    })
  }

  // Stage 3 — Backend keywords. HYBRID (PO-chosen): include the TOP product keyphrases
  // (even ones in the title — utilize the best Jungle Scout terms) PLUS long-tail /
  // synonyms / occasion / seasonal. Whole coherent phrases, filled toward ~240 bytes.
  //
  // POOL COMPOSITION — the push-starvation trap (live 2026-06-12): opportunityScore is
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
      (b.keywordSales || 0) - (a.keywordSales || 0) ||
      (b.searchVolume || 0) - (a.searchVolume || 0) ||
      b.opportunityScore - a.opportunityScore)

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
  // every one wastes bytes a real term could use). Design-name tokens stay EXEMPT: "Darlin'" is
  // the product's identity, not the brand, even when the brand phrase contains it.
  const AMZ_BACKEND_STOPWORDS = new Set(['a', 'an', 'and', 'by', 'for', 'of', 'the', 'with'])
  const brandToksForBackend = ownBrandTokenSet(brandName)
  ;(designName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => brandToksForBackend.delete(w))
  const banBackendTok = (w: string): boolean => {
    if (w.length === 1 && !/\d/.test(w)) return true
    if (AMZ_BACKEND_STOPWORDS.has(w)) return true
    if (brandToksForBackend.has(w)) return true
    if (colorNeutralFamily && BASIC_COLOR_RE.test(w)) return true
    if ((STYLE_CUT_WORDS.has(w) || GARMENT_TYPE_WORDS.has(w)) && !new RegExp(`\\b${w}\\b`, 'i').test(backendTruthHay)) return true
    if (lean === 'female' && /^(?:men|mens|man|male|boys?)$/i.test(w)) return true
    if (lean === 'male' && /^(?:women|womens|woman|ladies|female|girls?)$/i.test(w)) return true
    return false
  }
  // #79 partial runs: exactly one of the pair, anchored on the stored title+bullets.
  if (only === 'keywords') {
    const ownB = ownBrandTokenSet(brandName)
    const finishBackend = (rows: PipelinePerChildKeywords[]): PipelinePerChildKeywords[] => {
      let out = rows.map((p) => ({
        ...p,
        keywords: fillBackendToBudget(p.keywords, input.canonicalTitle, backendPool.map((k) => k.keyword), ownB, capacityFamilyTokens.length >= 2, banBackendTok),
      }))
      if (lean === 'female' || lean === 'male') {
        out = out.map((p) => ({ ...p, keywords: stripOppositeGenderTokens(p.keywords, lean) }))
      }
      return out
    }
    let perChildOnly = finishBackend(await runBackendAgent(input, finalTitle, bullets, backendPool, designName, banBackendTok))
    let problems = backendOutputProblems(perChildOnly, input.children, apparelProduct)
    if (problems.length > 0) {
      // One retry — the failures here are transient LLM truncations/hiccups, not logic.
      onProgress('Backend output looked degraded — retrying…')
      perChildOnly = finishBackend(await runBackendAgent(input, finalTitle, bullets, backendPool, designName, banBackendTok))
      problems = backendOutputProblems(perChildOnly, input.children, apparelProduct)
    }
    if (problems.length > 0) {
      // HONEST FAILURE (a keywords-only regen has exactly one job): refuse to persist
      // degraded strings. Throwing aborts before the partial-persist step, so the seller's
      // previous keywords stay exactly as approved.
      throw new Error(`Backend keyword regen came back degraded (${problems.join('; ')}). Your previous keywords are untouched — run Regenerate backend again in a minute.`)
    }
    onProgress('Backend keywords regenerated.')
    return partialResult('keywords', { per_child_keywords: perChildOnly })
  }
  if (only === 'description') {
    let descriptionOnly = await runDescriptionAgent(input, finalTitle, bullets, bulletAttrs, compatibilityBrands, topOpportunityKwsForBullets)
    if (apparelProduct) descriptionOnly = stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(descriptionOnly, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase()), attributePinFinal ?? '')
    if (apparelProduct && (lean === 'female' || lean === 'male')) descriptionOnly = enforceHardAudience(descriptionOnly, lean === 'female' ? 'Women' : 'Men')
    descriptionOnly = fixDoubledArticleBeforeBrand(descriptionOnly, brandName)
    onProgress('Description regenerated.')
    return partialResult('description', { recommended_description: descriptionOnly })
  }
  // Backend and description BOTH depend on (title, bullets) but NOT on each other —
  // identical prompts and inputs as before, just issued concurrently. Quality-neutral
  // speed-up (PO gate): only genuinely independent calls overlap; the council stages
  // (proposers → adversary → judge) stay sequential because their order IS the quality.
  let [perChild, descriptionRaw] = await Promise.all([
    runBackendAgent(input, finalTitle, bullets, backendPool, designName, banBackendTok),
    runDescriptionAgent(input, finalTitle, bullets, bulletAttrs, compatibilityBrands, topOpportunityKwsForBullets),
  ])
  // Fill each child toward the 250-byte budget (seller's canonical descriptors first —
  // "country western" — then leftover pool keywords), THEN the hard-lean gender strip
  // so the strip cleans additions too.
  const finishBackendFull = (rows: PipelinePerChildKeywords[]): PipelinePerChildKeywords[] => {
    const ownB = ownBrandTokenSet(brandName)
    let out = rows.map((p) => ({
      ...p,
      keywords: fillBackendToBudget(p.keywords, input.canonicalTitle, backendPool.map((k) => k.keyword), ownB, capacityFamilyTokens.length >= 2, banBackendTok),
    }))
    // HARD audience: backend search terms drop the opposite gender's standalone tokens
    // (PO caught "…darlin mens black men…" persisting on a Female listing).
    if (lean === 'female' || lean === 'male') {
      out = out.map((p) => ({ ...p, keywords: stripOppositeGenderTokens(p.keywords, lean) }))
    }
    return out
  }
  perChild = finishBackendFull(perChild)
  // Same degraded-output gate as the keywords-only path, but a FULL regen carries five other
  // sections — retry the backend once, then proceed with a loud log rather than nuking the run.
  {
    let problems = backendOutputProblems(perChild, input.children, apparelProduct)
    if (problems.length > 0) {
      onProgress('Backend output looked degraded — retrying…')
      perChild = finishBackendFull(await runBackendAgent(input, finalTitle, bullets, backendPool, designName, banBackendTok))
      problems = backendOutputProblems(perChild, input.children, apparelProduct)
      if (problems.length > 0) console.warn(`[listingPipeline] backend output still degraded after retry: ${problems.join('; ')}`)
    }
  }
  // Same truthfulness backstops as title/bullets (garment-type + motif + hard audience).
  let description = apparelProduct
    ? stripCompetitorBlanks(stripContradictedGarments(stripUngroundedMotifs(descriptionRaw, motifTrust), `${motifTrust} ${input.productType ?? ''}`.toLowerCase()), attributePinFinal ?? '')
    : descriptionRaw
  if (apparelProduct && (lean === 'female' || lean === 'male')) description = enforceHardAudience(description, lean === 'female' ? 'Women' : 'Men')
  description = fixDoubledArticleBeforeBrand(description, brandName)

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
  // through) with ZERO new endpoints. Deterministic value replaces any audit-guessed duplicate.
  let pdiFinal: PipelineProductDetailImprovement[] = Array.isArray(audit.product_details_improvements) ? audit.product_details_improvements.slice(0, 10) : []
  // The audit rows are a blind-cast LLM parse: recommended_value can arrive as an ARRAY
  // (Additional Features: ["Water Proof","Shock Proof"]) or a bare number — every consumer
  // (.trim(), byte caps, PATCH bodies) assumes string, and the listing page hard-crashed on
  // B0GCF11RKL until normalized. Stringify at the write boundary so persisted rows are clean.
  pdiFinal = pdiFinal.map((p) => ({
    ...p,
    field_name: detailValueToString(p.field_name),
    current_value: p.current_value == null ? null : detailValueToString(p.current_value),
    recommended_value: detailValueToString(p.recommended_value),
  }))
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
      if (f === 'department') return { ...p, recommended_value: dem.dept, reason: `Set by your Audience selection (${lean.replace('_', ' ')}).` }
      if (f === 'target gender') return { ...p, recommended_value: dem.gender, reason: `Set by your Audience selection (${lean.replace('_', ' ')}).` }
      return p
    })
  }
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
    const hl = buildItemHighlights(finalTitle, analysis, input.brandName, !!perChildTitles)
    if (hl) {
      pdiFinal.push({
        field_name: highlightsAttr.title,
        current_value: null,
        recommended_value: hl,
        reason: 'NEW Amazon field (launches July 27, 2026 with the 75-char title limit): up to 125 characters of comma-separated phrases shown near the title and indexed for search — carries the keyphrases the shorter title no longer can.',
      })
    }
  }

  return scrubPublished({
    recommended_title: finalTitle,
    recommended_bullets: bullets,
    per_child_keywords: perChild,
    per_child_titles: perChildTitles,
    recommended_description: description,
    variant_corrections: Array.isArray(audit.variant_corrections) ? audit.variant_corrections : [],
    cannibalization_warnings: Array.isArray(audit.cannibalization_warnings) ? audit.cannibalization_warnings : [],
    product_details_improvements: pdiFinal,
    keyword_reconciliation: Array.isArray(audit.keyword_reconciliation) ? audit.keyword_reconciliation : [],
    action_plan: actionPlan,
    irrelevant_keywords: irrelevantKeywords,
    // #92/#93 — exactly the bullet set the generator targeted + the real design name, for the scorer.
    keywordPlan: { bullets: topOpportunityKwsForBullets, designName: effectiveDesignName },
    debug: { titleProblems, candidatesUsed: candidates.map((c) => c.keyword), titleRetried: retried, designName, designSource, multiDesign: designGroupInfo.isMultiDesign, designGroups: designGroupInfo.groups.map((g) => g.key) },
  })
}
