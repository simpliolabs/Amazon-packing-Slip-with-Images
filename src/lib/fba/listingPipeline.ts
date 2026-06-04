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
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

// ─── Shared output types (structurally identical to the route's interfaces) ────

export interface PipelinePerChildKeywords { sku: string; asin: string; keywords: string }
export interface PipelineVariantCorrection { sku: string; field: string; current: string; replace_with: string; reason: string }
export interface PipelineCannibalizationWarning { keyword: string; affected_skus: string[]; issue: string; recommendation: string }
export interface PipelineProductDetailImprovement { field_name: string; current_value: string | null; recommended_value: string; reason: string }
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

export interface PipelineChild { sku: string; asin: string; color: string | null; size: string | null }

export interface PipelineInput {
  openai: OpenAI
  brandName: string
  category: string
  analysis: AnalyzedKeyword[]
  children: PipelineChild[]
  /** Current title of the representative child — used for product-name token extraction */
  repTitle: string | null
  /** Per-variant content block (for the audit's variant-health check) */
  variantDetails: string
  /** Keyword intelligence context block (reused for the audit agent) */
  keywordContext: string
  hasAplus: boolean
  /** Reasoning-class model for the audit step, e.g. 'o4-mini' */
  auditModel: string
  /** NDJSON keepalive emitter — called before each stage */
  onProgress: (msg: string) => void
}

export interface PipelineResult {
  recommended_title: string
  recommended_bullets: string[]
  per_child_keywords: PipelinePerChildKeywords[]
  recommended_description: string
  variant_corrections: PipelineVariantCorrection[]
  cannibalization_warnings: PipelineCannibalizationWarning[]
  product_details_improvements: PipelineProductDetailImprovement[]
  keyword_reconciliation: PipelineKeywordReconciliation[]
  action_plan: PipelineActionPlanItem[]
  debug: { titleProblems: string[]; candidatesUsed: string[]; titleRetried: boolean }
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

// ─── Title validation (shared with the route's PR1 validator semantics) ────────

export function validateTitle(title: string, brandName: string, mustInclude?: string): string[] {
  const problems: string[] = []
  const len = title.length
  if (len > 150) problems.push(`Title is ${len} characters; Amazon's hard limit is 150 — shorten it (aim 80-125 for apparel).`)
  else if (len < 80) problems.push(`Title is only ${len} characters; use at least 80 to capture more keyword space.`)

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

  if (brandName && !lc.includes(brandName.toLowerCase())) problems.push(`Title must start with the brand "${brandName}".`)
  return problems
}

// ─── Stage 0 — candidate preparation (code only) ───────────────────────────────

interface TitleCandidate { keyword: string; opportunityScore: number; role: 'keyphrase' | 'descriptive' | 'audience' }

function extractProductNameTokens(repTitle: string | null): string[] {
  return (repTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !GENERIC_APPAREL.has(w))
    .slice(0, 3)
}

function selectTitleCandidates(analysis: AnalyzedKeyword[], brandName: string, repTitle: string | null): TitleCandidate[] {
  const brandTokens = brandName.toLowerCase().split(/\s+/).filter(Boolean)
  const productTokens = extractProductNameTokens(repTitle)

  const eligible = analysis
    .filter((k) => ['CRITICAL', 'UPGRADE', 'DEFENDED', 'REINFORCE'].includes(k.actionType))
    .filter((k) => !isSeasonal(k.keyword))
    .sort((a, b) => b.opportunityScore - a.opportunityScore)

  // Dedup by >=60% word overlap, keeping the higher-scoring keyword
  const deduped: AnalyzedKeyword[] = []
  for (const k of eligible) {
    if (!deduped.some((d) => wordOverlapRatio(d.keyword, k.keyword) >= 0.6)) deduped.push(k)
  }

  const roleOf = (kw: string): TitleCandidate['role'] => {
    const lc = kw.toLowerCase()
    const kwWords = new Set(lc.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/))
    if (brandTokens.some((t) => lc.includes(t)) || productTokens.some((t) => kwWords.has(t))) return 'keyphrase'
    if (ADULT_AUDIENCE.some((t) => kwWords.has(t)) || /\bfor (men|women|kids)\b/.test(lc)) return 'audience'
    return 'descriptive'
  }

  return deduped.slice(0, 7).map((k) => ({ keyword: k.keyword, opportunityScore: k.opportunityScore, role: roleOf(k.keyword) }))
}

// ─── Stage 1 — Title Agent ─────────────────────────────────────────────────────

async function runTitleAgent(
  input: PipelineInput,
  candidates: TitleCandidate[],
  attributes: string[],
  mustInclude: string | undefined,
  preferredAudience: string,
): Promise<{ title: string; problems: string[]; retried: boolean }> {
  const { openai, brandName, category } = input
  const candidateList = candidates
    .map((c) => `  - "${c.keyword}" (opportunity ${c.opportunityScore}, role: ${c.role})`)
    .join('\n')
  const attrLine = attributes.length
    ? `\nSearchable product keyphrases shoppers actually type — include one or two if they fit AFTER the mandatory keyword above (e.g. a blank-brand search term like "comfort colors graphic tee"):\n  ${attributes.join(', ')}\n`
    : ''
  const mustLine = mustInclude
    ? `\n🔴 MANDATORY — the title MUST contain this highest-search-volume keyword VERBATIM and FRONT-LOADED (it is your single biggest money term — never drop it): "${mustInclude}"\n`
    : ''
  const audienceLine = preferredAudience
    ? `\nAUDIENCE: end with "for ${preferredAudience}" (this product is for ${preferredAudience} — do NOT narrow it to a single gender if it says Men and Women).\n`
    : ''

  const system = 'You are an Amazon apparel SEO title writer. Output ONLY the final title string — no quotes, no markdown, no explanation.'
  const user = `Brand: ${brandName}
Category: ${category}
${mustLine}
Pre-filtered keyword candidates (already de-duplicated and seasonal-stripped — pick the best 2-3 to support the mandatory keyword):
${candidateList}
${attrLine}${audienceLine}
Write ONE product title as NATURAL, readable language — NOT dash-separated sections.
Order: ${brandName}, then the MANDATORY keyword, then ONE supporting keyphrase, then the audience. It should read like a human-written phrase.

Rules:
- FRONT-LOAD the mandatory keyword in the first ~80 characters (that's all mobile shows).
- Do NOT use " - " dashes or " | " pipes to separate sections — flow as natural language (a single comma is OK only if it genuinely reads better). Amazon indexes the title as a bag of words, so separators add nothing and only cost characters.
- 80-125 characters. Title Case. ONE consistent audience (never mix kids with men/women).
- Use the product-type word ("shirt"/"tee"/"t-shirt") AT MOST TWICE in the WHOLE title. Do NOT append "Shirt" to every keyphrase (no "Comfort Colors Shirt Vintage 90s Shirt Cool T Shirts").
- Include the searchable keyphrases above when they fit. Do NOT put product SPECS (material, fabric, fit, weight, dye) in the title — those are not search terms.
- Must read like a human wrote it. Return ONLY the title.`

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.3,
    max_tokens: 120,
  })
  let title = (completion.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
  let problems = title ? validateTitle(title, brandName, mustInclude) : ['No title generated.']
  let retried = false

  // Up to 2 corrective passes — the mandatory-keyword + max-2 rules are non-negotiable.
  for (let attempt = 0; attempt < 2 && title && problems.length > 0; attempt++) {
    retried = true
    const fix = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You are an Amazon apparel SEO title editor. Output ONLY the corrected title string.' },
        { role: 'user', content: `Fix this title. Brand: ${brandName}\nTitle: ${title}\n\nProblems:\n- ${problems.join('\n- ')}\n\nWrite it as natural readable language (NO " - " dashes or pipes): ${brandName} then ${mustInclude ? `the MANDATORY keyword "${mustInclude}"` : 'the top keyphrase'} then one supporting keyphrase${preferredAudience ? ` then "for ${preferredAudience}"` : ''}. Front-load the mandatory keyword. 80-125 chars. Product-type word ("shirt"/"tee") used AT MOST twice total. No seasonal terms. No product specs (material/fit). ONE audience. Return ONLY the corrected title.` },
      ],
      temperature: 0.2,
      max_tokens: 120,
    })
    const corrected = (fix.choices[0]?.message?.content || '').trim().replace(/^["']+|["']+$/g, '')
    if (corrected) {
      const cp = validateTitle(corrected, brandName, mustInclude)
      if (cp.length <= problems.length) { title = corrected; problems = cp }
    }
  }

  // Compliance guarantee: brand must lead.
  if (title && brandName && !title.toLowerCase().includes(brandName.toLowerCase())) {
    const prefixed = `${brandName} ${title}`.trim()
    if (prefixed.length <= 150) { title = prefixed; problems = validateTitle(title, brandName, mustInclude) }
  }

  // Audience guarantee: never silently narrow a unisex product to one gender.
  if (preferredAudience === 'Men and Women' && title) {
    const lc = title.toLowerCase()
    if (/\bm[ae]n\b/.test(lc) && !/\bwom[ae]n\b/.test(lc)) {
      const swapped = title
        .replace(/\bfor Men\b/i, 'for Men and Women')
        .replace(/\bMen'?s\b/i, "Men's and Women's")
      if (swapped !== title && swapped.length <= 150) { title = swapped; problems = validateTitle(title, brandName, mustInclude) }
    }
  }
  return { title, problems, retried }
}

// ─── Stage 2 — Bullets Agent ───────────────────────────────────────────────────

async function runBulletsAgent(input: PipelineInput, finalTitle: string, remaining: AnalyzedKeyword[], attributes: string[]): Promise<string[]> {
  const { openai } = input
  const topKeyphrases = remaining.slice(0, 3).map((k) => k.keyword)
  const kwList = remaining.slice(0, 8).map((k) => `  - "${k.keyword}"`).join('\n')
  const topLine = topKeyphrases.length
    ? `\n🔴 TOP SEARCH KEYPHRASES — weave ONE of these into EACH of bullets 1, 2, and 3 (verbatim or lightly reworded), ONLY where it reads naturally and accurately. These are the highest-volume terms not already in the title; bullets must reinforce them for ranking cohesion:\n${topKeyphrases.map((k) => `  - "${k}"`).join('\n')}\n`
    : ''
  const attrLine = attributes.length
    ? `\nKNOWN PRODUCT ATTRIBUTES — real product facts; mention the garment brand and material in ONE bullet (e.g. "comfort colors", "ring-spun cotton"). Do NOT let specs crowd out the top keyphrases above:\n  ${attributes.join(', ')}\n`
    : ''
  const system = 'You are an Amazon apparel SEO copywriter. Return ONLY valid JSON: {"bullets": ["b1","b2","b3","b4","b5"]}.'
  const user = `The title is FINAL (do not change it): "${finalTitle}"
${topLine}
These are ADDITIONAL candidate keywords you MAY weave into the bullet body text (not the hook) — only when they fit naturally:
${kwList || '  (none — focus on benefits)'}
${attrLine}
CRITICAL RELEVANCE RULES (read carefully):
- Describe ONLY what this product actually is. Do NOT invent occasions, audiences, or product types that the product is not. For example: do NOT call it a "teacher shirt", "last day of school shirt", or "summer shirt" unless the product's design is genuinely about that. A retro alligator graphic tee is NOT a teacher/school product.
- A keyword being in the candidate list does NOT mean you must use it. SKIP any keyword that would force an inaccurate or awkward claim. It is better to use fewer keywords naturally than to misrepresent the product.
- Never stuff a long-tail phrase (e.g. "later gator after while crocodile shirt") verbatim if it reads unnaturally — paraphrase or skip it.

Rules per bullet:
- Start with a 2-3 WORD BENEFIT HOOK in ALL CAPS, then " - ", then the benefit sentence.
- The hook is a benefit (e.g. RETRO STYLE VIBES), NOT a keyword phrase.
- 80-200 characters each. Generic for ALL variants (no specific size/color).
- Bullets 1-3 carry the top keyphrases; bullets 4-5 may focus on material/comfort/care/gifting.
Return ONLY the JSON object.`

  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.4,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
  })
  const parsed = parseJsonLoose<{ bullets?: string[] }>(completion.choices[0]?.message?.content || '{}')
  const bullets = Array.isArray(parsed.bullets) ? parsed.bullets.filter((b) => typeof b === 'string').slice(0, 5) : []
  return bullets.map((b) => b.trim()).filter(Boolean)
}

// ─── Stage 3 — Backend keywords (code grouping + LLM aesthetic assignment) ──────

async function runBackendAgent(
  input: PipelineInput,
  finalTitle: string,
  bullets: string[],
  remaining: AnalyzedKeyword[],
): Promise<PipelinePerChildKeywords[]> {
  const { openai, children, brandName } = input

  // Words already in title/bullets/brand — Amazon auto-indexes those, so exclude from backend.
  const excludeWords = new Set(
    `${finalTitle} ${bullets.join(' ')} ${brandName}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean),
  )
  // Color names are auto-indexed from the variant attribute — never repeat them in backend.
  const colors = [...new Set(children.map((c) => (c.color || 'default').toLowerCase()))]
  colors.forEach((c) => excludeWords.add(c))

  // ── SHARED CORE (best-practice dedup, PR: backend-dedupe-best-practice) ──
  // Amazon indexes title + bullets + backend as ONE bag of words, so a token already in
  // the title/bullets earns NOTHING if repeated here. Best practice = spend all 250 bytes
  // on NET-NEW tokens (synonyms, misspellings, long-tail, occasion/seasonal not in the
  // title). We walk opportunity-sorted phrases and append only the words NOT already seen
  // (in title/bullets/colors/brand via excludeWords, minor words, or earlier in the core).
  // Each token appears once — no "shirt ×7" waste, maximum unique coverage of the 250 bytes.
  const corePhrases: string[] = []
  const coreWordSet = new Set<string>()
  for (const k of remaining) {
    const kw = k.keyword.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!kw) continue
    const newWords = kw.split(' ').filter((w) => w && !MINOR_WORDS.has(w) && !excludeWords.has(w) && !coreWordSet.has(w))
    if (newWords.length === 0) continue                  // every meaningful word already covered
    newWords.forEach((w) => coreWordSet.add(w))
    corePhrases.push(newWords.join(' '))
    if (getByteLength(corePhrases.join(' ')) >= 185) break
  }
  // ~185 bytes of net-new core, leaving ~65 for the per-color tail (target ~245/250).
  const core = truncateToBytes(corePhrases.join(' '), 185)

  // ── PER-COLOR TAIL: REAL color search terms unique to each color (NOT mood words) ──
  const system = 'You generate Amazon backend COLOR search-term tails per color variant. Return ONLY valid JSON: {"groups":[{"color":"<color>","keywords":"space separated lowercase color search words"}]}.'
  const user = `Color variants: ${colors.join(', ')}

For EACH color, output ~8-12 lowercase words that REAL shoppers TYPE to find that shade — color synonyms and near-shades a buyer would actually search. Examples:
  light green -> sage mint pistachio olive moss seafoam
  ivory -> cream off white eggshell bone beige
  pepper -> charcoal dark grey gray heather slate
Use ONLY actual color/shade SEARCH terms a buyer types — NEVER abstract moods/feelings (no "serene", "calm", "whimsical", "elegant", "timeless", "peaceful", "delicate").

Do NOT use any of these words (already covered in title/bullets/core/color names):
${[...excludeWords].slice(0, 50).join(' ')}

Rules: lowercase, space-separated, NO commas, NO quotes, no brand or size words. ~70 characters max per color.
Return ONLY the JSON object.`

  const tailMap = new Map<string, string>()
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.6,
      max_tokens: 1500,
      response_format: { type: 'json_object' },
    })
    const parsed = parseJsonLoose<{ groups?: { color: string; keywords: string }[] }>(completion.choices[0]?.message?.content || '{}')
    for (const g of parsed.groups ?? []) {
      if (g?.color && typeof g.keywords === 'string') tailMap.set(g.color.toLowerCase(), g.keywords.trim())
    }
  } catch {
    /* tail is best-effort; core still ships */
  }

  // ── Combine core (whole phrases, kept intact) + per-color tail, byte-cap to 250 ──
  // Only NEW tail words are appended (those not already in the core); the core phrases
  // are never re-split, so coherent phrases survive.
  const coreWords = new Set(core.toLowerCase().split(/\s+/).filter(Boolean))
  const buildString = (tail: string): string => {
    // Tail must be net-new too: drop anything already in the core OR in title/bullets/colors.
    const tailWords = tail.toLowerCase().split(/\s+/).filter((w) => w && !coreWords.has(w) && !excludeWords.has(w))
    return truncateToBytes(`${core} ${tailWords.join(' ')}`.trim(), 250)
  }

  return children.map((c) => {
    const color = (c.color || 'default').toLowerCase()
    return { sku: c.sku, asin: c.asin, keywords: buildString(tailMap.get(color) || '') }
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
  const { openai, auditModel, variantDetails, keywordContext, hasAplus } = input
  const backendSummary = perChild.slice(0, 3).map((p) => `  ${p.sku}: ${p.keywords}`).join('\n')
  const specsLine = specs.length
    ? `\n=== KNOWN PRODUCT SPECS (use these to fill structured Product-Detail fields with REAL values — e.g. Fabric Type, Material, Fit Type, Department) ===\n${specs.join(', ')}\n`
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
${specsLine}
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
- PRODUCT DETAILS: suggest only genuinely missing structured attributes (e.g. Fabric Type, Material, Department). 3-10 max.
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

async function runDescriptionAgent(input: PipelineInput, finalTitle: string, bullets: string[], attributes: string[]): Promise<string> {
  const { openai } = input
  const attrLine = attributes.length
    ? `\nNaturally mention these known product attributes (real facts from the listing — e.g. garment brand, material, fit): ${attributes.join(', ')}.`
    : ''
  const system = 'You are an Amazon apparel SEO copywriter. Return ONLY the HTML description (no markdown, no JSON).'
  const user = `Write a 150-220 word HTML product description (generic for all variants) using <p>, <b>, <ul>, <li>.
Title: ${finalTitle}
Bullet themes: ${bullets.map((b) => b.split(' - ')[0]).join(', ')}${attrLine}
Structure: hook -> <ul> of key features -> use cases/audience -> short closing line. Return ONLY the HTML.`
  const completion = await openai.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.5,
    max_tokens: 700,
  })
  return (completion.choices[0]?.message?.content || '').replace(/^```html\s*/i, '').replace(/\s*```$/i, '').trim()
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
1. Other companies' brands or TRADEMARKS (sports teams, bands, other sellers), unrelated products, or personal/character names with no connection to this product.
2. VAGUE, non-descriptive filler that does not describe a product attribute, style, design, audience, occasion, or use case (e.g. "interest", "full transparency", "high quality", "best seller").
KEEP anything plausibly about this product, including broad descriptors, audiences, occasions, gift terms, and seasonal terms (relevant even when broad). Be CONSERVATIVE — only drop clearly-unrelated or clearly-meaningless terms. Return ONLY {"drop":[...]}.`
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
    if (filtered.length < Math.max(3, Math.floor(analysis.length * 0.3))) return analysis
    return filtered
  } catch (err) {
    console.warn('[pipeline] relevance gate failed, using unfiltered pool:', err)
    return analysis
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
  const { openai, repTitle, variantDetails } = input
  const text = `${repTitle ?? ''}\n${variantDetails}`.slice(0, 4000).trim()
  if (!text) return { searchKeyphrases: [], specs: [] }
  const system = 'You extract product attributes from an existing Amazon apparel listing, split into searchable keyphrases vs specs. Return ONLY valid JSON: {"searchKeyphrases":["..."],"specs":["..."]}.'
  const user = `From the listing text, extract TWO groups:

1. searchKeyphrases — terms a shopper would actually TYPE into Amazon search. In particular, if a recognizable garment BLANK BRAND is present (e.g. comfort colors, bella canvas, gildan, next level, american apparel), output it COMBINED with the product type as a real query — e.g. "comfort colors graphic tee", "comfort colors shirt". 2-4 words each. These are TITLE-eligible.

2. specs — concrete product SPECIFICATIONS that nobody searches: material/fabric, weight, fit/cut, dye method (e.g. "ring spun cotton", "6.1 oz", "garment dyed", "relaxed fit", "unisex"). These go in bullets/description/structured fields, NOT the title.

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

// ─── Orchestrator ──────────────────────────────────────────────────────────────

export async function runListingPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { brandName, repTitle, onProgress } = input

  // Stage 0a — relevance gate: drop keywords that are not about this product
  // (competitor brands, trademarks, unrelated names) before anything downstream uses them.
  onProgress('Filtering keywords for relevance...')
  const gated = await filterRelevantKeywords(input, input.analysis)

  // Stage 0c — surface seller-known product attributes (garment brand "Comfort Colors",
  // material, fit) from the existing listing. JS never captures these, so without this
  // they're invisible to the optimizer. Inject as high-opportunity keywords so they flow
  // into the title-candidate / bullets / backend pools, and reinforce them in the prompts.
  onProgress('Extracting product attributes...')
  const attrs = await extractProductAttributes(input)
  // Only SEARCHABLE keyphrases (e.g. "comfort colors graphic tee") become title-eligible
  // keywords. Specs (garment-dyed, ring-spun cotton, relaxed fit) are NOT search terms and
  // must NOT enter the title — they go to bullets/description/structured fields only.
  const analysis = [...attrs.searchKeyphrases.map(attributeAsKeyword), ...gated]
  const bulletAttrs = [...attrs.searchKeyphrases, ...attrs.specs]

  // PIN the single highest SEARCH-VOLUME real keyword (not a synthetic attribute, not
  // seasonal — seasonal belongs in backend) so the title agent can never drop the money
  // term. This is what stopped "see you later alligator shirt" (22.7k/mo) from surviving.
  const mustIncludeKw = gated
    .filter((k) => ['CRITICAL', 'UPGRADE', 'DEFENDED', 'REINFORCE'].includes(k.actionType))
    .filter((k) => !isSeasonal(k.keyword))
    .filter((k) => k.keyword.split(/\s+/).length <= 6)
    .sort((a, b) => (b.searchVolume || 0) - (a.searchVolume || 0) || (b.opportunityScore || 0) - (a.opportunityScore || 0))[0]
  const mustInclude = mustIncludeKw?.keyword

  // Determine the product's true audience from the existing listing + specs, so the title
  // never silently narrows a unisex product to one gender (the "for Men" regression).
  const audienceText = `${repTitle ?? ''} ${attrs.specs.join(' ')} ${gated.map((k) => k.keyword).join(' ')}`.toLowerCase()
  const mentionsWomen = /\bwom[ae]n\b|womens|ladies|female/.test(audienceText)
  const mentionsMen = /\bm[ae]n\b|mens|male/.test(audienceText)
  const preferredAudience =
    /\bunisex\b/.test(audienceText) || (mentionsWomen && mentionsMen) ? 'Men and Women'
    : mentionsWomen ? 'Women'
    : mentionsMen ? 'Men'
    : ''

  // Stage 0b — candidates (code)
  const candidates = selectTitleCandidates(analysis, brandName, repTitle)

  // Stage 1 — Title
  onProgress('Writing title...')
  const { title: finalTitle, problems: titleProblems, retried } = await runTitleAgent(input, candidates, attrs.searchKeyphrases, mustInclude, preferredAudience)

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
  onProgress('Writing bullets...')
  const bullets = await runBulletsAgent(input, finalTitle, remainingForBullets, bulletAttrs)

  // Stage 3 — Backend keywords. HYBRID (PO-chosen): include the TOP product keyphrases
  // (even ones in the title — utilize the best Jungle Scout terms) PLUS long-tail /
  // synonyms / occasion / seasonal. Whole coherent phrases, filled toward ~240 bytes.
  // Sorted by opportunity so the highest-value phrases land first.
  onProgress('Distributing backend keywords...')
  const backendPool = analysis
    .filter((k) => ['CRITICAL', 'UPGRADE', 'REINFORCE', 'DEFENDED'].includes(k.actionType))
    .sort((a, b) => b.opportunityScore - a.opportunityScore)
  const perChild = await runBackendAgent(input, finalTitle, bullets, backendPool)

  // Description (always generated — indexed field)
  onProgress('Writing description...')
  const description = await runDescriptionAgent(input, finalTitle, bullets, bulletAttrs)

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
  const forceReplace = (item: PipelineActionPlanItem, content: string) => {
    item.replacement_content = content
    item.verdict = 'REPLACE'
    if (item.priority === 'NONE') item.priority = 'HIGH'
  }
  for (const item of actionPlan) {
    if (item.element === 'title') forceReplace(item, finalTitle)
    else if (/^bullet_([1-5])$/.test(item.element)) {
      const idx = Number(item.element.split('_')[1]) - 1
      if (bullets[idx]) forceReplace(item, bullets[idx])
    } else if (item.element === 'description') forceReplace(item, description)
    else if (item.element === 'backend_keywords') item.verdict = 'REPLACE'
  }

  return {
    recommended_title: finalTitle,
    recommended_bullets: bullets,
    per_child_keywords: perChild,
    recommended_description: description,
    variant_corrections: Array.isArray(audit.variant_corrections) ? audit.variant_corrections : [],
    cannibalization_warnings: Array.isArray(audit.cannibalization_warnings) ? audit.cannibalization_warnings : [],
    product_details_improvements: Array.isArray(audit.product_details_improvements) ? audit.product_details_improvements.slice(0, 10) : [],
    keyword_reconciliation: Array.isArray(audit.keyword_reconciliation) ? audit.keyword_reconciliation : [],
    action_plan: actionPlan,
    debug: { titleProblems, candidatesUsed: candidates.map((c) => c.keyword), titleRetried: retried },
  }
}
