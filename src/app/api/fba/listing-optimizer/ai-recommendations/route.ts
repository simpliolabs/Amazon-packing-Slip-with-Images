/**
 * POST /api/fba/listing-optimizer/ai-recommendations
 * ─────────────────────────────────────────────────────────────────────────────
 * V4: Uses OpenAI streaming to prevent proxy timeouts.
 * Returns a streaming response with progress updates, then the final JSON.
 *
 * The response format is newline-delimited JSON (NDJSON):
 *   {"type":"progress","message":"Generating recommendations..."}
 *   {"type":"progress","message":"Processing keywords..."}
 *   {"type":"result","recommendations":{...},"keywordIntelligenceUsed":true,"missedCriticalKeywords":[]}
 *
 * The client should read the stream and use the last "result" line.
 *
 * Body: { parent_asin: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { getStoredAnalysis } from '@/lib/keyword-engine'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  })
}

interface ChildRow {
  sku: string
  asin: string
  title: string | null
  bullet_1: string | null
  bullet_2: string | null
  bullet_3: string | null
  bullet_4: string | null
  bullet_5: string | null
  description: string | null
  backend_keywords: string | null
  image_count: number
  has_aplus: boolean
  aplus_module_count: number
  aplus_has_brand_story: boolean
  aplus_has_headline: boolean
  aplus_images_missing_alt: number
}

export interface VariantCorrection {
  sku: string
  field: string
  current: string
  replace_with: string
  reason: string
}

export interface CannibalizationWarning {
  keyword: string
  affected_skus: string[]
  issue: string
  recommendation: string
}

export interface ProductDetailImprovement {
  field_name: string
  current_value: string | null
  recommended_value: string
  reason: string
}

export interface PerChildKeywords {
  sku: string
  asin: string
  keywords: string
}

export interface KeywordReconciliation {
  keyword: string
  action_type: 'CRITICAL' | 'UPGRADE' | 'REINFORCE'
  search_volume: number
  placed_in: string[]
  exact_text: string
  why: string
}

export interface AplusModuleAction {
  module_type: string
  action: 'ADD' | 'EDIT' | 'KEEP'
  content_brief: string
  position: number
}

export interface ActionPlanItem {
  element: string
  level: 'parent' | 'per_child'
  verdict: 'REPLACE' | 'EDIT' | 'CREATE' | 'DONE' | 'SKIP'
  priority: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
  current_status: string
  instruction: string
  replacement_content?: string | string[]
  seller_central_path?: string
  notes?: string
  aplus_modules?: AplusModuleAction[]
}

export interface AiRecommendations {
  parent_asin: string
  recommended_title: string
  recommended_bullets: string[]
  recommended_keywords: string
  per_child_keywords: PerChildKeywords[]
  recommended_description: string
  variant_corrections: VariantCorrection[]
  cannibalization_warnings: CannibalizationWarning[]
  product_details_improvements: ProductDetailImprovement[]
  keyword_reconciliation: KeywordReconciliation[]
  action_plan: ActionPlanItem[]
  generated_at: string
  keyword_opportunities_used?: number
}

// ─── Keyword Intelligence Context Builder (V2) ─────────────────────────────────

async function buildKeywordContext(
  supabase: ReturnType<typeof getAdminSupabase>,
  parentAsin: string,
  children: ChildRow[]
): Promise<{ contextBlock: string; opportunitiesUsed: number; brandAnchorKeyword: string | null }> {
  // ASIN resolution: use top_child_asin from listing_seo_scores (has keyword data)
  let lookupAsin = children[0]?.asin
  
  const { data: scoreRow } = await supabase
    .from('listing_seo_scores')
    .select('top_child_asin')
    .eq('parent_asin', parentAsin)
    .single()
  
  if (scoreRow?.top_child_asin) {
    lookupAsin = scoreRow.top_child_asin
  }

  if (!lookupAsin) {
    return { contextBlock: '', opportunitiesUsed: 0, brandAnchorKeyword: null }
  }

  // Try the resolved ASIN first, then fallback to parent_asin, then children[0]
  let analysis = await getStoredAnalysis(lookupAsin, 50)
  if (!analysis || analysis.length === 0) {
    analysis = await getStoredAnalysis(parentAsin, 50)
  }
  if (!analysis || analysis.length === 0) {
    const firstChild = children[0]?.asin
    if (firstChild && firstChild !== lookupAsin) {
      analysis = await getStoredAnalysis(firstChild, 50)
    }
  }

  if (!analysis || analysis.length === 0) {
    return {
      contextBlock: `
KEYWORD INTELLIGENCE: No keyword data available yet for this listing.
The AI will optimize based on listing content alone.
To unlock keyword-driven recommendations, trigger a keyword sync first.
`.trim(),
      opportunitiesUsed: 0,
      brandAnchorKeyword: null,
    }
  }

  // V2: Categorize with opportunity score + competition level shown per keyword
  const critical = analysis.filter(k => k.actionType === 'CRITICAL').slice(0, 5)
  const upgrade  = analysis.filter(k => k.actionType === 'UPGRADE').slice(0, 5)
  const reinforce = analysis.filter(k => k.actionType === 'REINFORCE').slice(0, 3)
  const defended  = analysis.filter(k => k.actionType === 'DEFENDED').slice(0, 5)

  // V2 format: show Opp score + Competition level per keyword
  const getCompLevel = (competing: number): string => {
    if (competing > 50000) return 'HIGH'
    if (competing > 10000) return 'MED'
    return 'LOW'
  }

  const formatKw = (k: typeof analysis[0]) =>
    `  "${k.keyword}" — Vol: ${k.searchVolume.toLocaleString()}/mo | Opp: ${k.opportunityScore}/100 | Comp: ${getCompLevel(k.competingProducts)}`

  const formatSection = (items: typeof analysis, emptyMsg: string) =>
    items.length > 0 ? items.map(formatKw).join('\n') : `  [NO KEYWORDS IN THIS SECTION]`

  // Brand anchor: the highest search-volume brand-specific keyword, regardless of whether
  // it is already DEFENDED (in title+bullets) or UPGRADE (in bullets only).
  // If the top brand term is UPGRADE, it means it's NOT yet in the title — which is exactly
  // when we need to force it into the title via the brand anchor rule.
  // Selection pool: DEFENDED + UPGRADE keywords, sorted by search volume descending.
  // We filter to keywords with relevancyScore-derived sales (keywordSales > 50) to exclude
  // generic terms that happen to be in bullets.
  const brandAnchorPool = [...defended, ...upgrade]
    .filter(k => k.keywordSales > 50) // exclude generic low-intent keywords
    .sort((a, b) => b.searchVolume - a.searchVolume)
  const brandAnchor = brandAnchorPool.length > 0 ? brandAnchorPool[0] : null

  const contextBlock = `KEYWORD INTELLIGENCE (from Brand Analytics + Jungle Scout):
Data source: ${analysis[0].dataSource === 'sqp' ? 'Amazon Brand Analytics (real sales data)' : analysis[0].dataSource === 'jungle_scout' ? 'Jungle Scout API' : 'Inherited from sibling products'}
Sort order: Keywords within each section are sorted by OPPORTUNITY SCORE (highest first).
The first keyword listed = highest priority = best combination of rankability, search volume, competition gap, and conversion potential.

Each keyword entry follows this format:
  "keyword phrase" — Vol: [monthly searches] | Opp: [score 0-100] | Comp: [LOW/MED/HIGH]

---

TOP KEYWORDS BY OPPORTUNITY SCORE:
${brandAnchor
  ? `The highest-scoring keyword already associated with this product is: "${brandAnchor.keyword}" — Vol: ${brandAnchor.searchVolume.toLocaleString()}/mo

This keyword should be considered for the title if it is year-round relevant and fits naturally. It does NOT need to appear verbatim — use your judgment based on readability and the full keyword set.`
  : `[No high-scoring associated keywords found. Use CRITICAL and UPGRADE keywords to build the title.]`
}

---

CRITICAL GAPS — These high-opportunity keywords are MISSING from both title AND bullets.
You MUST include them in your recommended title and/or bullets.
If this section is empty, no critical keyword gaps exist — skip to TITLE UPGRADES.

${formatSection(critical, 'no critical gaps')}

---

TITLE UPGRADES — These keywords appear in bullets but NOT in the title.
Moving them to the title increases ranking weight.
If this section is empty, no title upgrades are needed — skip to REINFORCE.

${formatSection(upgrade, 'no title upgrades')}

---

REINFORCE — These keywords appear in the title but NOT in bullets.
Adding them to at least one bullet reinforces relevance signals.
If this section is empty, no reinforcement is needed — skip to DEFENDED.

${formatSection(reinforce, 'no reinforcement needed')}

---

DEFENDED — These keywords are already well-covered (present in both title AND bullets).
Keep them in your recommendations. Do not remove them.
If this section is empty, no keywords are currently defended — all optimization is net-new.

${formatSection(defended, 'no defended keywords')}

---

KEYWORD PLACEMENT RULES:

RULE 1 — TITLE (2-3 keywords max):
Build the title from the top year-round keywords by Opportunity Score. Use 2-3 keywords maximum. Prefer specific, product-relevant keywords over broad generic ones (e.g., "later gator tshirt" is better than "cool t shirts for men" for a Later Gator product because it has higher conversion intent). Title MUST be 80-150 characters. Do not include variant-specific attributes (size, color).

RULE 7 — SEASONAL KEYWORDS IN TITLE ONLY WHEN PRODUCT IS DESIGNED FOR THAT OCCASION:
Keywords tied to specific events, seasons, or occasions (e.g., "last day of school", "graduation", "christmas shirt", "halloween shirt", "mothers day", "fathers day") belong in the title ONLY if the product is specifically designed for that occasion — meaning the graphic, design, or product concept is directly tied to it.

Examples:
  ✅ A shirt with a Christmas tree graphic → "christmas shirt" belongs in the title
  ✅ A shirt that says "Happy Halloween" → "halloween shirt" belongs in the title
  ❌ A Later Gator alligator graphic tee that happens to rank for "last day of school shirt" → "last day of school" does NOT belong in the title — the product is not a school shirt, and buyers searching that term in October will not convert

If the product is a general-purpose graphic tee that incidentally ranks for a seasonal keyword, place that keyword in bullets or backend keywords only — not the title. Year-round conversion is more valuable than seasonal traffic spikes.

RULE 2 — BULLETS (3-5 keywords):
Place the top keywords from CRITICAL and UPGRADE (those not used in the title) into bullets 1-3. Each bullet should target 1-2 keywords woven naturally into the sentence. Keywords go in the body text, NOT in the ALL CAPS benefit hook.

RULE 3 — BACKEND KEYWORDS (everything else):
All remaining keywords that did not fit naturally into title or bullets go here. Also include: synonyms, common misspellings, occasion terms, audience terms, and long-tail variants not already in title/bullets.

RULE 4 — READABILITY IS NON-NEGOTIABLE:
Keywords must flow naturally in the copy. If a keyword cannot be used without making the text awkward, push it to backend keywords. Stuffed-sounding copy hurts conversion rate, which hurts ranking.

RULE 5 — DO NOT DUPLICATE:
Never repeat the same keyword in both title AND backend keywords. Amazon indexes title and bullet words automatically — duplicating them in backend wastes bytes.

RULE 6 — ACCOUNT FOR EVERY KEYWORD:
Every CRITICAL and UPGRADE keyword must appear somewhere: title, a bullet, or backend keywords. The keyword reconciliation report must prove placement for each one. If a keyword was intentionally excluded, state why.`

  return {
    contextBlock,
    opportunitiesUsed: critical.length + upgrade.length + reinforce.length + defended.length,
    brandAnchorKeyword: brandAnchor?.keyword ?? null,
  }
}

// ─── POST Handler (Streaming) ────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { parent_asin } = body as { parent_asin: string }

    if (!parent_asin) {
      return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    }

    const supabase = getAdminSupabase()

    // Fetch all child content rows for this parent
    const { data: children, error } = await supabase
      .from('listing_content')
      .select('sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt')
      .eq('parent_asin', parent_asin)
      .order('sku', { ascending: true })

    if (error || !children || children.length === 0) {
      return NextResponse.json({ error: 'No listing content found. Run Scan Listings first.' }, { status: 404 })
    }

    const rep = children[0] as ChildRow
    const bullets = [rep.bullet_1, rep.bullet_2, rep.bullet_3, rep.bullet_4, rep.bullet_5].filter(Boolean) as string[]

    // Build per-variant detail for conflict analysis
    const variantDetails = children.map((c: ChildRow, idx: number) => {
      const cBullets = [c.bullet_1, c.bullet_2, c.bullet_3, c.bullet_4, c.bullet_5].filter(Boolean) as string[]
      return `VARIANT ${idx + 1}: ${c.sku} (ASIN: ${c.asin})
  Title: ${c.title || '[MISSING]'}
  Bullets: ${cBullets.length > 0 ? cBullets.map((b, i) => `\n    ${i + 1}. ${b}`).join('') : '[NONE]'}
  Backend Keywords (${(c.backend_keywords?.length || 0)}/250 chars): ${c.backend_keywords || '[EMPTY]'}
  Description: ${c.description ? c.description.replace(/<[^>]+>/g, ' ').trim().slice(0, 200) + '...' : '[MISSING]'}`
    }).join('\n\n')

    // Build the per-child keyword slots instruction
    // Extract color from SKU for color-grouped strategy
    // SKU pattern: AQS-TMB-{SIZE}-{COLOR} or AQS-TMB-{SIZE}-{COLOR}-FBA
    // We strip the -FBA suffix before extracting the color code.
    const extractColor = (sku: string, _title: string): string => {
      const skuParts = sku.split('-')
      // Remove trailing FBA suffix if present
      const partsNoFba = skuParts[skuParts.length - 1] === 'FBA'
        ? skuParts.slice(0, -1)
        : skuParts
      // Color code is the last remaining segment (e.g., MOS, LG, BJ, IVO)
      return partsNoFba[partsNoFba.length - 1] || sku
    }

    const childKeywordSlots = children.map((c: ChildRow, idx: number) => {
      const kwLen = c.backend_keywords?.trim().length || 0
      const color = extractColor(c.sku, c.title || '')
      return `  Child ${idx + 1}: SKU="${c.sku}", ASIN="${c.asin}", color="${color}", current=${kwLen}/250 chars`
    }).join('\n')

    // V2: Auto-sync keyword intelligence if empty (self-healing)
    // This ensures Regenerate AI Audit works even if keyword cache was cleared
    const { data: existingKws } = await supabase
      .from('keyword_analysis')
      .select('id')
      .eq('asin', (await supabase.from('listing_seo_scores').select('top_child_asin').eq('parent_asin', parent_asin).single()).data?.top_child_asin || children[0]?.asin)
      .limit(1)
    
    if (!existingKws || existingKws.length === 0) {
      // No keyword data — trigger a sync now (synchronous, before AI generation)
      try {
        const { data: scoreRow2 } = await supabase
          .from('listing_seo_scores')
          .select('top_child_asin, competitor_asin')
          .eq('parent_asin', parent_asin)
          .single()
        const syncAsin = scoreRow2?.top_child_asin || children[0]?.asin
        const competitorAsin = scoreRow2?.competitor_asin || undefined
        if (syncAsin) {
          const { syncKeywordIntelligence } = await import('@/lib/sync/syncKeywordIntelligence')
          await syncKeywordIntelligence(syncAsin, {
            includeJungleScout: true,
            forceRefresh: false,
            parentAsin: parent_asin,
            listingTitle: children[0]?.title || undefined,
          })
          console.log(`[ai-recommendations] Auto-synced keyword intelligence for ${syncAsin}`)
        }
      } catch (syncErr) {
        console.warn('[ai-recommendations] Auto-sync failed, proceeding without keyword data:', syncErr)
      }
    }

    // V2: Build keyword intelligence context
    const { contextBlock: keywordContext, opportunitiesUsed, brandAnchorKeyword } = await buildKeywordContext(
      supabase,
      parent_asin,
      children as ChildRow[]
    )

    // V2: Build structured input JSON matching the system prompt's Section 2 schema
    // Brand is the seller brand, not extracted from the listing title
    // The title should lead with the highest-opportunity keyword, not the brand name
    const brandName = 'THE CEO'

    const inputJson = {
      brand: brandName,
      product_type: 't-shirt', // Default for current product line
      category: 'Clothing, Shoes & Jewelry > Novelty & More > Clothing > Novelty',
      is_new_listing: !rep.title,
      has_aplus: rep.has_aplus || false,
      has_brand_story: rep.aplus_has_brand_story || false,
      current_title: rep.title || null,
      current_bullets: bullets.length > 0 ? bullets : null,
      current_description: rep.description || null,
      children: children.map((c: ChildRow) => {
        const color = extractColor(c.sku, c.title || '')
        // Extract size from SKU (3rd segment: AQS-TMB-{SIZE}-{COLOR})
        const skuParts = c.sku.split('-')
        const size = skuParts.length >= 3 ? skuParts[2] : null
        return {
          sku: c.sku,
          asin: c.asin,
          color: color || null,
          size: size || null,
          current_backend_keywords: c.backend_keywords || '',
        }
      }),
      category_title_formula: null,
      restricted_claims: [],
    }

    // Build the full listing context (V2 format)
    const listingContext = `${JSON.stringify(inputJson, null, 2)}

--- PER-VARIANT CONTENT (for variant health check) ---
${variantDetails}
--- END VARIANT CONTENT ---

${keywordContext ? `--- KEYWORD INTELLIGENCE (V2) ---\n${keywordContext}\n--- END KEYWORD INTELLIGENCE ---` : ''}
`.trim()

    const systemPrompt = `You are a senior Amazon SEO specialist with 15+ years optimizing product listings on Amazon US.

========================================
SECTION 1: AMAZON LISTING ARCHITECTURE
========================================

On Amazon, a variation family has a PARENT ASIN (non-buyable placeholder) and multiple CHILD ASINs (the actual buyable products).

SHARED CONTENT (edited once at parent level, same for ALL children):
- Title: One generic title template. Amazon auto-appends the variant attribute (size, color). You write ONLY the generic part. NEVER include variant-specific attributes (specific size, color, capacity) in the title unless ALL variants share that attribute.
- Bullets: One set of 5 bullets shared across all children. Must be generic.
- Description: One description shared across all children. Must be generic. NOTE: If A+ Content exists, it overrides the description — see conditional rules below.
- A+ Content: Shared at parent level.

PER-CHILD CONTENT (edited individually per child):
- Backend Keywords: Each child has its own search terms field (250 BYTES max — see encoding rules below). This is the key optimization opportunity.
- Images: Each child has its own image set.

========================================
SECTION 2: INPUT FORMAT
========================================

You will receive a JSON object with the following structure. All fields are guaranteed present unless marked optional.

{
  "brand": "string",
  "product_type": "string (e.g., 't-shirt', 'memory card', 'supplement')",
  "category": "string (Amazon browse node / category name)",
  "is_new_listing": false,
  "has_aplus": false,
  "has_brand_story": false,
  "current_title": "string (current parent title, or null if new listing)",
  "current_bullets": ["string x5 (current bullets, or null if new listing)"],
  "current_description": "string | null",
  "children": [
    {
      "sku": "string",
      "asin": "string",
      "color": "string | null",
      "size": "string | null",
      "current_backend_keywords": "string (current backend keywords, or empty string)"
    }
  ],
  "category_title_formula": "string | null (if Amazon enforces a specific title format for this category, it appears here — follow it exactly)",
  "restricted_claims": ["string (list of claim types prohibited in this category, e.g., 'health_claims', 'pesticide_efficacy', 'fda_statements')"]
}

KEYWORD INTELLIGENCE is provided separately in the format defined by the Keyword Context Block.

HANDLING EDGE CASES IN INPUT:
- If "is_new_listing" is true: skip variant health check, mark current_status as "New listing — no existing content" in the action plan, and generate all content from scratch.
- If "children" has only 1 entry: skip the color-grouped backend strategy. Use one 250-byte keyword string.
- If "children" has more than 20 entries: group children by color. Produce one backend keyword string per color group. All sizes within the same color group share identical backend keywords.
- If "category_title_formula" is provided: follow that formula exactly instead of the default title format.
- If "restricted_claims" is non-empty: NEVER include any language matching those claim types in title, bullets, description, or backend keywords.
- If all keyword intelligence sections are [NO KEYWORDS IN THIS SECTION]: focus on content quality, readability, and backend keyword distribution using your expertise. Note in the action plan that no keyword gaps were identified.

========================================
SECTION 3: CONTENT RULES
========================================

--- TITLE RULES ---

HARD LIMIT: 80-150 characters. Aim for ~110 characters.
- Under 80 = likely missing a keyword opportunity. Check if you dropped one.
- Over 150 = Amazon truncates on mobile and may suppress the listing. Remove the lowest-opportunity keyword and push it to bullets.

FORMAT (score-first, unless category_title_formula overrides):
  Top Keyword - Second Keyword - Audience/Differentiator

The title MUST lead with the highest-opportunity keyword by Opportunity Score — the keyword most likely to rank AND generate traffic for this specific product. This is determined by the system's score, which combines: search volume, rankability (competing products), conversion intent (keyword sales), and gap size (whether it's missing from the listing).

Do NOT start the title with the brand name or the current product name unless the brand/product name IS the top keyword by score.

Example for a Later Gator graphic tee:
  "See You Later Alligator Shirt - Later Gator Tshirt - Cool Shirt for Men and Women"
  ("see you later alligator shirt" leads because it has the highest Opportunity Score)

TITLE CASE STANDARD — Capitalize all words EXCEPT: a, an, the, and, or, for, in, on, with, of, to, at, by. Always capitalize the first and last word regardless. Exception: recognized acronyms stay ALL CAPS (e.g., USB, LED, UHS-I, SDHC).

TITLE RESTRICTIONS:
- No promotional phrases ("Best Seller", "Free Shipping", "#1", "Top Rated")
- No special characters for decoration (stars, arrows, pipes as separators)
- No variant-specific attributes — Amazon appends these automatically
- Title must make sense for EVERY child in the family
- Include ONLY the top 2-3 keywords as determined by the Keyword Placement Rules

--- BULLET RULES ---

FORMAT: Start each bullet with a 2-3 WORD BENEFIT HOOK in ALL CAPS, followed by " - ".
- The hook describes a CUSTOMER BENEFIT (e.g., RETRO STYLE VIBES, EVERYDAY COMFORT, PERFECT GIFT)
- The hook must NOT be a keyword phrase — keywords go in the body text
- After the hook, write the feature + benefit in plain English, naturally weaving in keywords from the intelligence data

LIMITS: Each bullet must be 80-200 characters.
- Under 80 = too thin, missing keyword or benefit detail
- Over 200 = Amazon may truncate on mobile

KEYWORD TARGETING:
- CRITICAL GAP and UPGRADE keywords (from keyword intelligence) must appear in the body text of bullets 1-3
- Each bullet should naturally incorporate 1-2 keywords
- Bullets 4-5 can focus on trust signals, guarantees, or use cases without keyword pressure

GENERIC REQUIREMENT: All bullets must work for every variant in the family. Do not reference specific sizes, colors, or capacities.

EXAMPLE:
"RETRO STYLE VIBES - This later gator tshirt features a playful see you later alligator graphic with vintage 90s energy and a relaxed everyday fit."

--- BACKEND KEYWORDS RULES ---

ENCODING LIMIT: 250 BYTES maximum per child (not 250 characters).
- ASCII characters (a-z, 0-9, standard punctuation) = 1 byte each
- Accented characters (e.g., n with tilde, u with umlaut) = 2-3 bytes each
- SAFE TARGET: Stay under 240 ASCII characters to leave headroom. If using accented characters, reduce further.

FORMAT: Space-separated words. No commas, no punctuation, no quotation marks. Lowercase.

NEVER INCLUDE IN BACKEND:
- Words already in the title or bullets (Amazon indexes those automatically — duplicating wastes bytes)
- The variant's own size, color, or attribute name (Amazon indexes variant attributes automatically)
- The brand name (Amazon indexes it from the brand field)
- Competitor brand names (violates Amazon TOS)
- Subjective claims ("best", "premium", "top quality")

MUST INCLUDE: Synonyms, alternate phrasings, common misspellings, use-case terms, occasion terms (gift, birthday, christmas, fathers day), audience terms (mens, womens, unisex, teen, kids), and long-tail phrases not covered in title/bullets.

FILL EVERY BYTE: Short backend keywords waste ranking opportunity. If under 230 bytes, add more relevant terms.

--- BACKEND DISTRIBUTION STRATEGY ---

FOR MULTI-COLOR PRODUCTS (apparel, accessories, home decor):
Group children by COLOR. All sizes of the SAME color share IDENTICAL backend keywords. Each COLOR GROUP gets a COMPLETELY DIFFERENT keyword string targeting that color's specific aesthetic, audience, or use case.

Example distribution:
  Moss/Sage variants:  "nature lover outdoors hiking gift green aesthetic earth tone casual weekend"
  Ivory/White variants: "clean classic minimalist gift neutral tone wedding bridal party elegant"
  Blue Jean variants:   "denim look casual everyday workwear gift blue aesthetic vintage wash"

This maximizes indexing surface: 10 colors x 250 bytes = 2,500 bytes of unique keyword coverage.

FOR SINGLE-COLOR OR NON-COLOR PRODUCTS:
Distribute keywords across children by THEME:
  Small/Medium (or lower-tier variants): audience terms (mens, womens, unisex, teen, young adult)
  Large/XL (or mid-tier variants):       occasion terms (gift, birthday, christmas, fathers day, mothers day)
  2XL/3XL (or top-tier variants):        style terms (vintage, retro, 90s, novelty, funny, graphic)

FOR SINGLE-CHILD PRODUCTS:
Use one keyword string. Pack it with the highest-opportunity terms not already in title/bullets.

--- DESCRIPTION RULES (CONDITIONAL) ---

IF "has_aplus" is true:
  SKIP description generation. A+ Content overrides the description field — any text written here will not display to customers. Mark description as SKIP in the action plan with this explanation.

IF "has_aplus" is false:
  Generate a full HTML description using these tags: <b>, <br>, <ul>, <li>, <p>
  Minimum 150 words, maximum 2,000 characters.
  Must be generic for all variants.
  Structure: Opening hook (1-2 sentences) -> Key features (bulleted list) -> Use cases/audience -> Closing CTA

========================================
SECTION 4: ACTION PLAN RULES
========================================

Generate a step-by-step action plan reviewing EVERY element below. Include ALL elements even if the verdict is DONE.

ELEMENTS TO REVIEW:
  1. title (parent level)
  2. bullet_1 through bullet_5 (parent level — review EACH individually)
  3. backend_keywords (per_child level)
  4. description (parent level)
  5. aplus_modules (parent level)
  6. brand_story (parent level)
  7. product_details (parent level)
  8. images (per_child level)

VERDICT OPTIONS:
  REPLACE — Swap entirely. replacement_content is MANDATORY.
  EDIT    — Change specific parts. replacement_content is MANDATORY (provide the full updated text, not a diff).
  CREATE  — Does not exist, build from scratch. replacement_content is MANDATORY.
  DONE    — No action needed. replacement_content = null.
  SKIP    — Not applicable. replacement_content = null. Explain why in notes.

PRIORITY OPTIONS:
  HIGH   — Directly impacts search ranking or indexing
  MEDIUM — Improves conversion rate or click-through rate
  LOW    — Nice to have, minor improvement
  NONE   — Already optimized

VERDICT GUIDELINES:
- If current bullets are strong and your recommendation changes fewer than 5 words, mark as DONE
- If A+ Content exists with fewer than 5 modules, mark as EDIT and specify which modules to ADD (with types and content briefs)
- If A+ Content does not exist, mark as CREATE
- If description exists but A+ overrides it, mark description as SKIP
- Backend keywords are always per_child — note that each child needs different keywords
- For images, specify what TYPE to add (lifestyle, infographic, size chart, comparison, packaging, video)
- If brand story is missing, mark as CREATE and describe what to include

FOR PRODUCT DETAILS IMPROVEMENTS:
Suggest ONLY structured attributes that are genuinely MISSING or INCORRECT.
CROSS-CHECK before suggesting:
- Brand in title? -> Brand field is already set. Do not suggest.
- Product type clear from title? -> Product Type is set. Do not suggest.
- Size/color in variant attributes? -> Already set. Do not suggest.
Return 3-10 improvements. If fewer than 3 are genuinely missing, return fewer. Quality over quantity.

FOR A+ MODULE RECOMMENDATIONS:
Use exact Amazon A+ module names: "Standard Comparison Chart", "Standard Image & Text Overlay", "Standard Four Image & Text", "Standard Single Image & Highlights", "Standard Single Image & Sidebar", "Standard Three Images & Text".

========================================
SECTION 5: KEYWORD RECONCILIATION
========================================

For every CRITICAL and UPGRADE keyword from the Keyword Intelligence block, produce a reconciliation entry showing:
- The exact keyword
- Where you placed it (title, bullet_1-5, description, or backend_keywords)
- The exact phrase from your recommended content containing the keyword
- Why you placed it there (one sentence)

If a keyword was intentionally NOT placed in title or bullets (pushed to backend), state the reason (e.g., "Could not integrate naturally without hurting readability" or "Title already at 3-keyword limit").

This section exists for seller verification. Keep entries concise.

========================================
SECTION 6: VARIANT HEALTH CHECK
========================================

Compare per-variant content. ONLY flag genuinely HARMFUL issues.

FLAG THESE:
- Wrong product type in a child's content
- Contradictory specifications (child says "waterproof" but product isn't)
- Backend keywords containing a DIFFERENT variant's attributes (e.g., "128gb" in the 32GB child)
- Backend keywords containing competitor brand names

DO NOT FLAG:
- Expected variant differentiation (different titles showing different sizes/colors — Amazon does this)
- Different images per variant (this is correct behavior)
- Minor wording differences that don't affect accuracy

If "is_new_listing" is true, skip this section entirely and return an empty array.

========================================
SECTION 7: OUTPUT FORMAT
========================================

Return ONLY a JSON object. No markdown fences, no preamble text, no explanation outside the JSON.

If you cannot complete a field, use null rather than omitting the key.
All string values must have quotes properly escaped (especially HTML in description).

{
  "recommended_title": "string (80-150 chars, generic, Title Case, top 2-3 keywords only)",
  "recommended_title_char_count": 0,
  "recommended_bullets": [
    "string (bullet 1, 80-200 chars)",
    "string (bullet 2, 80-200 chars)",
    "string (bullet 3, 80-200 chars)",
    "string (bullet 4, 80-200 chars)",
    "string (bullet 5, 80-200 chars)"
  ],
  "per_child_keywords": [
    {
      "sku": "string",
      "asin": "string",
      "color_group": "string | null (the color this child belongs to)",
      "keywords": "string (unique keyword string for THIS child)",
      "byte_count": 0
    }
  ],
  "recommended_description": "string (full HTML) | null (null if A+ exists)",
  "variant_corrections": [
    {
      "sku": "string",
      "field": "string (title | bullets | keywords | description)",
      "current": "string",
      "replace_with": "string",
      "reason": "string",
      "severity": "string (HIGH | MEDIUM | LOW)"
    }
  ],
  "cannibalization_warnings": [
    {
      "keyword": "string",
      "affected_skus": ["string"],
      "issue": "string",
      "recommendation": "string"
    }
  ],
  "product_details_improvements": [
    {
      "field_name": "string (exact Seller Central field name)",
      "current_value": "string | null",
      "recommended_value": "string",
      "reason": "string"
    }
  ],
  "keyword_reconciliation": [
    {
      "keyword": "string",
      "action_type": "string (CRITICAL | UPGRADE | REINFORCE)",
      "search_volume": 0,
      "opportunity_score": 0,
      "placed_in": ["string (title | bullet_1 | bullet_2 | bullet_3 | bullet_4 | bullet_5 | description | backend_keywords)"],
      "exact_text": "string (the phrase from your content where this keyword appears)",
      "why": "string (one sentence)"
    }
  ],
  "action_plan": [
    {
      "element": "string (title | bullet_1 | bullet_2 | bullet_3 | bullet_4 | bullet_5 | backend_keywords | description | aplus_modules | brand_story | product_details | images)",
      "level": "string (parent | per_child)",
      "verdict": "string (REPLACE | EDIT | CREATE | DONE | SKIP)",
      "priority": "string (HIGH | MEDIUM | LOW | NONE)",
      "confidence": "string (HIGH | MEDIUM | LOW)",
      "current_status": "string (factual description of current state)",
      "instruction": "string (specific step-by-step instruction for the seller)",
      "replacement_content": "string | [string] | null",
      "notes": "string | null",
      "aplus_modules": [
        {
          "module_type": "string (exact Amazon A+ module name from dropdown)",
          "action": "string (ADD | EDIT | KEEP)",
          "content_brief": "string",
          "position": 1
        }
      ]
    }
  ]
}

========================================
SECTION 8: EXAMPLE OUTPUT (TRUNCATED)
========================================

Below is a PARTIAL example showing correct formatting for a fictional "Later Gator" t-shirt product. Your output must follow this exact structure. This example is truncated — your output must include ALL fields from the schema above.

{
  "recommended_title": "See You Later Alligator Shirt - Later Gator Tshirt - Cool Shirt for Men and Women",
  "recommended_title_char_count": 80,
  "recommended_bullets": [
    "RETRO STYLE VIBES - This later gator tshirt features a playful see you later alligator graphic with vintage 90s energy and a relaxed everyday fit",
    "COMFORT ALL DAY - Made from soft breathable cotton blend fabric that keeps you cool whether you are out with friends or lounging at home",
    "PERFECT FUNNY GIFT - Looking for a humorous alligator lover gift? This graphic tee makes a great birthday christmas or just-because present for him or her",
    "EASY CARE FABRIC - Machine washable and dryer safe with print that stays vibrant wash after wash without cracking fading or peeling",
    "TRUE TO SIZE FIT - Check the size chart before ordering for the best fit in this unisex crew neck short sleeve tee available in multiple colors"
  ],
  "per_child_keywords": [
    {
      "sku": "LG-MOSS-S",
      "asin": "B0EXAMPLE1",
      "color_group": "Moss",
      "keywords": "nature lover outdoors hiking gift green aesthetic earth tone casual weekend camping trip adventure wear forest sage olive neutral spring summer layering",
      "byte_count": 168
    },
    {
      "sku": "LG-IVORY-S",
      "asin": "B0EXAMPLE2",
      "color_group": "Ivory",
      "keywords": "clean classic minimalist gift neutral tone wedding party elegant simple aesthetic cream off white casual dressy brunch outfit date night light color warm",
      "byte_count": 163
    }
  ],
  "recommended_description": null,
  "variant_corrections": [],
  "cannibalization_warnings": [],
  "product_details_improvements": [
    {
      "field_name": "Fabric Type",
      "current_value": null,
      "recommended_value": "Cotton Blend",
      "reason": "Fabric Type is a filterable attribute in Clothing — setting it makes the product appear in filtered searches"
    }
  ],
  "keyword_reconciliation": [
    {
      "keyword": "later gator tshirt",
      "action_type": "CRITICAL",
      "search_volume": 11794,
      "opportunity_score": 92,
      "placed_in": ["title", "bullet_1"],
      "exact_text": "Later Gator...T-Shirt (title) | This later gator tshirt features (bullet_1)",
      "why": "Brand-specific product term — highest conversion rate, placed in title per Override Rule and reinforced in bullet 1"
    }
  ],
  "action_plan": [
    {
      "element": "title",
      "level": "parent",
      "verdict": "REPLACE",
      "priority": "HIGH",
      "confidence": "HIGH",
      "current_status": "228 chars, exceeds 150-char limit, contains 5 ALL CAPS words, missing top 2 keywords by opportunity",
      "instruction": "Replace the entire title with the recommended title below. Copy-paste exactly. Do not add variant attributes — Amazon appends those automatically.",
      "replacement_content": "Later Gator Funny Alligator T-Shirt - Vintage See You Later Graphic Tee for Men and Women",
      "notes": "89 chars. Front-loads brand term 'Later Gator' in first 12 chars. Contains top 2 keywords by opportunity score.",
      "aplus_modules": null
    }
  ]
}

========================================
SECTION 9: SELF-CHECK BEFORE RETURNING
========================================

Before returning your JSON, verify each of these. If any check fails, fix the output before returning.

1. TITLE CHARACTER COUNT: Count the characters in recommended_title. Is it 80-150? Does recommended_title_char_count match the actual count?
2. BULLET CHARACTER COUNTS: Is each bullet 80-200 characters?
3. BACKEND BYTE COUNTS: Is each child's keyword string under 250 bytes? Does byte_count match? (ASCII = 1 byte/char. Accented chars = 2-3 bytes.)
4. NO DUPLICATE WORDS: Are there words in backend keywords that already appear in the title or bullets? Remove them.
5. KEYWORD COVERAGE: Does every CRITICAL and UPGRADE keyword from the intelligence block appear in keyword_reconciliation? Is each one placed somewhere?
6. NO VARIANT ATTRIBUTES IN TITLE: Does the title contain any specific size, color, or capacity? Remove them.
7. GENERIC BULLETS: Do any bullets reference a specific variant? Fix them.
8. RESTRICTED CLAIMS: Does any content violate the restricted_claims from the input? Remove violations.
9. VALID JSON: Are all strings properly escaped? Are there no trailing commas? Is the JSON parseable?
10. SCORE-FIRST TITLE CHECK: Does the recommended_title start with the highest Opportunity Score keyword from the CRITICAL or UPGRADE section? The first keyword in the title must be the one with the highest score — not the brand name, not the current product name, not a paraphrase. If the title starts with a lower-scoring keyword, rewrite it so the top-scoring keyword leads.

========================================
END OF PROMPT
========================================`

    const openai = getOpenAI()

    // ─── Use streaming to prevent proxy timeout ─────────────────────────────
    // We stream the OpenAI response and forward progress to the client via NDJSON.
    // This keeps the HTTP connection alive even if generation takes 90-120s.

    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Send initial progress
          controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', message: 'Analyzing listing content...' }) + '\n'))

          const completion = await openai.chat.completions.create({
            model: 'gpt-4.1-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: listingContext },
            ],
            temperature: 0.3,
            max_tokens: 16000,
            stream: true,
          })

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', message: 'AI is generating recommendations...' }) + '\n'))

          let rawContent = ''
          let chunkCount = 0

          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta?.content || ''
            rawContent += delta
            chunkCount++

            // Send periodic progress updates to keep connection alive
            if (chunkCount % 50 === 0) {
              const pctEstimate = Math.min(90, Math.round((rawContent.length / 12000) * 100))
              controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', message: `Generating... ${pctEstimate}% complete`, chars: rawContent.length }) + '\n'))
            }
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', message: 'Parsing AI response...' }) + '\n'))

          // Parse the JSON response (V2 schema)
          let parsed: {
            recommended_title: string
            recommended_title_char_count?: number
            recommended_bullets: string[]
            per_child_keywords?: { sku: string; asin: string; color_group?: string; keywords: string; byte_count?: number }[]
            recommended_keywords?: string
            recommended_description: string | null
            variant_corrections?: (VariantCorrection & { severity?: string })[]
            cannibalization_warnings?: CannibalizationWarning[]
            product_details_improvements?: ProductDetailImprovement[]
            keyword_reconciliation?: (KeywordReconciliation & { opportunity_score?: number })[]
            action_plan?: (ActionPlanItem & { confidence?: string })[]
          }

          try {
            // Robust JSON extraction: strip markdown fences, find the JSON object
            let cleaned = rawContent
              .replace(/^```json\s*/i, '')
              .replace(/^```\s*/i, '')
              .replace(/\s*```$/i, '')
              .trim()

            // If it doesn't start with {, find the first {
            const firstBrace = cleaned.indexOf('{')
            if (firstBrace > 0) {
              cleaned = cleaned.slice(firstBrace)
            }

            // If it doesn't end with }, find the last }
            const lastBrace = cleaned.lastIndexOf('}')
            if (lastBrace > 0 && lastBrace < cleaned.length - 1) {
              cleaned = cleaned.slice(0, lastBrace + 1)
            }

            // Handle truncated JSON: if the response was cut off, try to repair
            // by closing any open arrays/objects
            try {
              parsed = JSON.parse(cleaned)
            } catch (firstErr) {
              // Try adding closing brackets
              let repaired = cleaned
              const openBraces = (repaired.match(/\{/g) || []).length
              const closeBraces = (repaired.match(/\}/g) || []).length
              const openBrackets = (repaired.match(/\[/g) || []).length
              const closeBrackets = (repaired.match(/\]/g) || []).length

              // Remove trailing comma if any
              repaired = repaired.replace(/,\s*$/, '')

              // Close open brackets/braces
              for (let i = 0; i < openBrackets - closeBrackets; i++) repaired += ']'
              for (let i = 0; i < openBraces - closeBraces; i++) repaired += '}'

              try {
                parsed = JSON.parse(repaired)
                console.warn('[AI Recs] JSON was truncated but successfully repaired')
              } catch {
                throw firstErr // Re-throw original error
              }
            }
          } catch (parseErr) {
            console.error('[AI Recs] Failed to parse LLM response. Length:', rawContent.length, 'First 500:', rawContent.slice(0, 500), 'Last 500:', rawContent.slice(-500))
            controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: 'AI returned invalid JSON. Please try again. (Response length: ' + rawContent.length + ' chars)' }) + '\n'))
            controller.close()
            return
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', message: 'Validating keywords...' }) + '\n'))

          // Post-generation validation: verify CRITICAL keywords were included
          // Fetch top_child_asin for validation (same logic as buildKeywordContext)
          const { data: valScoreRow } = await supabase
            .from('listing_seo_scores')
            .select('top_child_asin')
            .eq('parent_asin', parent_asin)
            .single()
          const validationAsin = valScoreRow?.top_child_asin || children[0]?.asin
          const criticalKeywords = (await getStoredAnalysis(validationAsin, 10))
            ?.filter(k => k.actionType === 'CRITICAL')
            .map(k => k.keyword) ?? []

          const titleAndBullets = [
            parsed.recommended_title,
            ...(parsed.recommended_bullets ?? []),
          ].join(' ').toLowerCase()

          const missedCritical = criticalKeywords.filter(kw =>
            !titleAndBullets.includes(kw.toLowerCase())
          )

          if (missedCritical.length > 0) {
            console.warn(
              `[AI Recs] V3 validation: AI missed ${missedCritical.length} CRITICAL keywords: ${missedCritical.join(', ')}`
            )
          }

          // Post-generation enforcement: truncate each child's backend keywords to 250 BYTES
          // Amazon's limit is 250 bytes, not 250 characters. ASCII = 1 byte, accented = 2-3 bytes.
          const getByteLength = (str: string) => new TextEncoder().encode(str).length
          const truncateToBytes = (str: string, maxBytes: number): string => {
            if (getByteLength(str) <= maxBytes) return str
            // Binary search for the right character cutoff
            let low = 0, high = str.length
            while (low < high) {
              const mid = Math.ceil((low + high) / 2)
              if (getByteLength(str.slice(0, mid)) <= maxBytes) low = mid
              else high = mid - 1
            }
            // Cut at last space before the byte limit
            const truncated = str.slice(0, low)
            const lastSpace = truncated.lastIndexOf(' ')
            return lastSpace > low * 0.7 ? truncated.slice(0, lastSpace).trim() : truncated.trim()
          }

          const perChildKeywords: PerChildKeywords[] = (parsed.per_child_keywords || []).map(pck => {
            let kw = (pck.keywords || '').trim()
            const byteLen = getByteLength(kw)
            if (byteLen > 250) {
              kw = truncateToBytes(kw, 250)
              console.warn(`[AI Recs] Per-child keywords for ${pck.sku} truncated from ${byteLen} to ${getByteLength(kw)} bytes`)
            }
            return { sku: pck.sku, asin: pck.asin, keywords: kw }
          })

          // Legacy fallback
          const legacyKeywords = perChildKeywords.length > 0
            ? perChildKeywords[0].keywords
            : (() => {
                let kw = (parsed.recommended_keywords || '').trim()
                if (kw.length > 250) {
                  const truncated = kw.slice(0, 250)
                  const lastSpace = truncated.lastIndexOf(' ')
                  kw = lastSpace > 200 ? truncated.slice(0, lastSpace).trim() : truncated.trim()
                }
                return kw
              })()

          // Build keyword reconciliation
          const keywordReconciliation: KeywordReconciliation[] = Array.isArray(parsed.keyword_reconciliation)
            ? parsed.keyword_reconciliation.map(kr => ({
                keyword: kr.keyword || '',
                action_type: kr.action_type as KeywordReconciliation['action_type'] || 'CRITICAL',
                search_volume: kr.search_volume || 0,
                placed_in: Array.isArray(kr.placed_in) ? kr.placed_in : [],
                exact_text: kr.exact_text || '',
                why: kr.why || '',
              }))
            : []

          // Use the LLM's recommended title directly — no forced verbatim injection.
          let finalTitle = parsed.recommended_title || ''
          const rec: AiRecommendations = {
            parent_asin,
            recommended_title: finalTitle,
            recommended_bullets: Array.isArray(parsed.recommended_bullets) ? parsed.recommended_bullets.slice(0, 5) : [],
            recommended_keywords: legacyKeywords,
            per_child_keywords: perChildKeywords,
            recommended_description: parsed.recommended_description || '',
            variant_corrections: Array.isArray(parsed.variant_corrections) ? parsed.variant_corrections : [],
            cannibalization_warnings: Array.isArray(parsed.cannibalization_warnings) ? parsed.cannibalization_warnings : [],
            product_details_improvements: Array.isArray(parsed.product_details_improvements) ? parsed.product_details_improvements.slice(0, 10) : [],
            keyword_reconciliation: keywordReconciliation,
            action_plan: Array.isArray(parsed.action_plan) ? parsed.action_plan : [],
            generated_at: new Date().toISOString(),
            keyword_opportunities_used: opportunitiesUsed,
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', message: 'Saving to database...' }) + '\n'))

          // Store in listing_seo_recommendations
          const { per_child_keywords: pck, cannibalization_warnings, product_details_improvements, keyword_reconciliation: kwRecon, action_plan: actionPlan, keyword_opportunities_used, ...persistFields } = rec

          const dbPayload: Record<string, unknown> = {
            ...persistFields,
            recommended_keywords: JSON.stringify(perChildKeywords),
            cannibalization_warnings,
            product_details_improvements,
            keyword_reconciliation: kwRecon,
            action_plan: actionPlan,
          }

          const { error: upsertErr } = await supabase
            .from('listing_seo_recommendations')
            .upsert(dbPayload, { onConflict: 'parent_asin' })

          if (upsertErr) {
            console.warn('[AI Recs] Full upsert failed, retrying without new fields:', upsertErr.message)
            const fallbackPayload = {
              ...persistFields,
              recommended_keywords: JSON.stringify(perChildKeywords),
            }
            await supabase
              .from('listing_seo_recommendations')
              .upsert(fallbackPayload, { onConflict: 'parent_asin' })
          }

          // Send final result
          controller.enqueue(encoder.encode(JSON.stringify({
            type: 'result',
            recommendations: rec,
            keywordIntelligenceUsed: opportunitiesUsed > 0,
            missedCriticalKeywords: missedCritical,
          }) + '\n'))

          controller.close()
        } catch (err) {
          console.error('[AI Recs] Stream error:', err)
          controller.enqueue(encoder.encode(JSON.stringify({
            type: 'error',
            error: err instanceof Error ? err.message : 'Unexpected error during generation',
          }) + '\n'))
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  } catch (err) {
    console.error('[AI Recs] Unexpected error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    )
  }
}

// ─── GET Handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const parent_asin = searchParams.get('parent_asin')

  if (!parent_asin) {
    return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  }

  const supabase = getAdminSupabase()
  const { data, error } = await supabase
    .from('listing_seo_recommendations')
    .select('*')
    .eq('parent_asin', parent_asin)
    .single()

  if (error || !data) {
    return NextResponse.json({ recommendations: null })
  }

  // Reconstruct per_child_keywords from the stored recommended_keywords JSON string
  let per_child_keywords: PerChildKeywords[] = []
  if (data.recommended_keywords) {
    try {
      const parsed = JSON.parse(data.recommended_keywords)
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].sku) {
        per_child_keywords = parsed
      }
    } catch {
      // Legacy string format — leave per_child_keywords empty
    }
  }

  // keyword_reconciliation comes from DB as JSONB — already an array
  const keyword_reconciliation: KeywordReconciliation[] = Array.isArray(data.keyword_reconciliation)
    ? data.keyword_reconciliation
    : []

  // action_plan comes from DB as JSONB — already an array
  const action_plan: ActionPlanItem[] = Array.isArray(data.action_plan)
    ? data.action_plan
    : []

  return NextResponse.json({
    recommendations: {
      ...data,
      per_child_keywords,
      keyword_reconciliation,
      action_plan,
      // Keep recommended_keywords as the first child's keywords for backward compat
      recommended_keywords: per_child_keywords.length > 0
        ? per_child_keywords[0].keywords
        : data.recommended_keywords || '',
    },
  })
}
