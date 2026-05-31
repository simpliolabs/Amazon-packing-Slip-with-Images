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

// ─── Keyword Intelligence Context Builder ─────────────────────────────────────

async function buildKeywordContext(
  supabase: ReturnType<typeof getAdminSupabase>,
  parentAsin: string,
  children: ChildRow[]
): Promise<{ contextBlock: string; opportunitiesUsed: number }> {
  const firstChildAsin = children[0]?.asin
  if (!firstChildAsin) {
    return { contextBlock: '', opportunitiesUsed: 0 }
  }

  const analysis = await getStoredAnalysis(firstChildAsin, 50)

  if (!analysis || analysis.length === 0) {
    return {
      contextBlock: `
KEYWORD INTELLIGENCE: No keyword data available yet for this listing.
The AI will optimize based on listing content alone.
To unlock keyword-driven recommendations, trigger a keyword sync first.
`.trim(),
      opportunitiesUsed: 0,
    }
  }

  const critical = analysis.filter(k => k.actionType === 'CRITICAL').slice(0, 5)
  const upgrade  = analysis.filter(k => k.actionType === 'UPGRADE').slice(0, 5)
  const reinforce = analysis.filter(k => k.actionType === 'REINFORCE').slice(0, 3)
  const defended  = analysis.filter(k => k.actionType === 'DEFENDED').slice(0, 5)

  const formatKw = (k: typeof analysis[0]) =>
    `  • "${k.keyword}" — ${k.searchVolume.toLocaleString()} searches/mo` +
    (k.keywordSales > 0 ? `, ${k.keywordSales} total sales/mo` : '') +
    (k.competingProducts > 0 ? `, ${k.competingProducts.toLocaleString()} competing` : '')

  const contextBlock = `
KEYWORD INTELLIGENCE (from Brand Analytics + Jungle Scout):
Data source: ${analysis[0].dataSource === 'sqp' ? 'Amazon Brand Analytics (real sales data)' : analysis[0].dataSource === 'jungle_scout' ? 'Jungle Scout API' : 'Inherited from sibling products'}
⚡ SORT ORDER: Keywords within each section are sorted by OPPORTUNITY SCORE (highest first). The first keyword listed = highest priority = best chance to rank + convert.

🔴 CRITICAL GAPS — These high-opportunity keywords are MISSING from title AND bullets.
You MUST include them in the recommended title and/or bullets:
${critical.length > 0 ? critical.map(formatKw).join('\n') : '  (none)'}

🟠 TITLE UPGRADES — These keywords are in bullets but NOT in the title.
Move them to the title for maximum ranking impact:
${upgrade.length > 0 ? upgrade.map(formatKw).join('\n') : '  (none)'}

🟡 REINFORCE — These keywords are in the title but NOT in bullets.
Add them to at least one bullet to reinforce relevance:
${reinforce.length > 0 ? reinforce.map(formatKw).join('\n') : '  (none)'}

✅ DEFENDED — These keywords are already well-covered (title + bullets).
Keep them in your recommendations:
${defended.length > 0 ? defended.map(formatKw).join('\n') : '  (none)'}

HARD RULES FOR KEYWORD INTEGRATION:
IMPORTANT: Keywords above are listed in ORDER OF OPPORTUNITY (best first). Opportunity score factors in search volume, competition, rankability, and conversion potential. The #1 keyword in each section is the HIGHEST PRIORITY — not necessarily the highest raw volume.

1. TITLE: Include ONLY the top 2-3 keywords BY OPPORTUNITY (the first 2-3 listed under CRITICAL or UPGRADE). Front-load the #1 opportunity keyword in the first 5 words after the brand name. The title MUST be 80-150 characters. NEVER exceed 150 chars.
2. BULLETS: Place remaining CRITICAL and UPGRADE keywords in bullets 1-3. Each bullet ≤200 chars.
3. BACKEND KEYWORDS: All keywords that don't fit naturally in title/bullets go here.
4. Do NOT sacrifice readability — keywords must flow naturally in the copy.
5. Do NOT stuff all keywords into the title. Distribute intelligently: title gets 2-3, bullets get 3-5, backend gets the rest.
6. TITLE CHARACTER LIMIT IS NON-NEGOTIABLE: Count your characters. If title exceeds 150 chars, remove lower-opportunity keywords and push them to bullets.
7. If a keyword IS the product name or brand-specific term (e.g. 'Later Gator tshirt'), it MUST be the primary title keyword regardless of raw volume — brand/product-specific terms have the highest conversion rate.
`.trim()

  return {
    contextBlock,
    opportunitiesUsed: critical.length + upgrade.length + reinforce.length + defended.length,
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
    const childKeywordSlots = children.map((c: ChildRow, idx: number) => {
      const kwLen = c.backend_keywords?.trim().length || 0
      return `  Child ${idx + 1}: SKU="${c.sku}", ASIN="${c.asin}", current=${kwLen}/250 chars`
    }).join('\n')

    // V2: Build keyword intelligence context
    const { contextBlock: keywordContext, opportunitiesUsed } = await buildKeywordContext(
      supabase,
      parent_asin,
      children as ChildRow[]
    )

    // Build the full listing context
    const listingContext = `
PRODUCT LISTING DATA (Amazon US):
Parent ASIN: ${parent_asin}
Total Variants: ${children.length} child SKUs

--- PER-VARIANT CONTENT (compare these to find conflicts) ---
${variantDetails}
--- END VARIANT CONTENT ---

CHILDREN NEEDING BACKEND KEYWORDS (each child gets its own unique 250-char keyword string):
${childKeywordSlots}

IMAGE COUNT: ${rep.image_count || 0}/7 (Amazon allows up to 7 images + 1 video)
A+ CONTENT: ${rep.has_aplus ? `Yes (${rep.aplus_module_count}/7 modules used)` : 'No A+ Content'}
A+ BRAND STORY: ${rep.aplus_has_brand_story ? 'Yes' : 'No'}
A+ HEADLINE: ${rep.aplus_has_headline ? 'Yes' : 'No'}
A+ IMAGES MISSING ALT TEXT: ${rep.aplus_images_missing_alt || 0}
DESCRIPTION LENGTH: ${rep.description ? rep.description.replace(/<[^>]+>/g, '').trim().length : 0} chars
DESCRIPTION HAS HTML: ${rep.description && /<[^>]+>/.test(rep.description) ? 'Yes' : 'No'}

${keywordContext ? `\n--- KEYWORD INTELLIGENCE (V2) ---\n${keywordContext}\n--- END KEYWORD INTELLIGENCE ---` : ''}
`.trim()

    const systemPrompt = `You are a senior Amazon SEO specialist with 15+ years optimizing product listings on Amazon US.

AMAZON PARENT/CHILD LISTING ARCHITECTURE — YOU MUST UNDERSTAND THIS:
On Amazon, a variation family has a PARENT ASIN (non-buyable placeholder) and multiple CHILD ASINs (the actual buyable products). Here is how content works:

SHARED CONTENT (same for ALL children — edited once at parent level):
• Title — One title template for the whole family. Amazon auto-appends the variant attribute (size, color). You write the GENERIC part only. NEVER include variant-specific attributes like "128GB", "Black", "Large" in the title unless ALL variants share it.
• Bullets — One set of 5 bullets shared across all children. Must be generic.
• Description — One description shared across all children. Must be generic.
• A+ Content — Shared at parent level.

PER-CHILD CONTENT (different for each child — edited individually):
• Backend Keywords — Each child has its own 250-byte search terms field. This is the KEY optimization opportunity: distribute your keyword universe across children. The 32GB child should target "32gb sd card", the 64GB child should target "64gb sd card", etc.
• Images — Each child has its own image set.

YOUR TASK:
Generate optimized content following this architecture exactly.

TITLE RULES (STRICT):
- HARD LIMIT: 80-150 characters. Target 100-120 chars. NEVER exceed 150 chars.
- Amazon recommends 80 chars for mobile. Anything over 150 gets truncated on mobile and may suppress the listing.
- Include ONLY the top 2-3 highest-opportunity keywords from keyword intelligence. Push remaining keywords to bullets and backend.
- Title Case (capitalize first letter of each major word)
- NO ALL CAPS words except recognized acronyms (e.g., UHS-I, SDHC, USB, LED, FBA)
- No promotional phrases ("Best Seller", "Free Shipping")
- Front-load the most important keyword in the first 80 chars
- NEVER include variant-specific attributes (specific size, color, capacity) — Amazon handles that
- The title must make sense for EVERY child in the family
- FORMAT: Brand - Product Type - Top Keyword - Key Attribute (e.g., "THE CEO Memory Card SDHC UHS-I 90MB/s - High-Speed Camera Cards for Photography")

BULLET RULES:
- Start each with a 2-5 word benefit hook in ALL CAPS followed by " – "
- Then feature + benefit in plain English
- Max 200 chars each
- Must be generic — work for ALL variants
- CRITICAL GAP keywords from keyword intelligence MUST appear in bullets 1-2

BACKEND KEYWORDS RULES (PER CHILD):
- Each child gets its OWN unique 250-char keyword string
- Space-separated, no commas, no duplicates of title/bullet terms
- NEVER repeat the same keywords across children — distribute them
- For variant families: each child should include its variant-specific terms (e.g., "32gb" for the 32GB child, "128gb" for the 128GB child)
- Include: device compatibility, use-case terms, seasonal terms, common misspellings
- HARD LIMIT: exactly 250 characters max per child

DESCRIPTION RULES:
- Use HTML tags (<b>, <br>, <ul>, <li>)
- Min 150 words
- Generic for all variants

VARIANT HEALTH CHECK:
Compare the per-variant content. ONLY flag genuinely HARMFUL issues:
DO flag: Wrong product type, contradictory specs, incorrect attributes, backend keywords containing wrong variant terms (e.g., "128gb" in the 32GB child's keywords)
DO NOT flag: Expected variant differentiation in titles (different sizes/colors appended by Amazon), different images per variant

PRODUCT DETAILS PAGE IMPROVEMENTS:
Suggest ONLY structured attributes that are genuinely MISSING or INCORRECT on this listing.
CROSS-CHECK RULES (DO NOT suggest these if already evident from the listing content):
- If the brand name appears in the title → Brand is already set, do NOT suggest it
- If the product type/category is clear from the title → Product Type is already set, do NOT suggest it
- If capacity/size/color is in the variant attributes → those are already set, do NOT suggest them
- If model number appears in the listing → Model Number is already set, do NOT suggest it
ONLY suggest fields that would ADD NEW information not already derivable from the title, bullets, or variant structure.
Focus on: missing compatibility info, missing certifications, missing material/weight, missing warranty, or genuinely empty filterable fields.
Return 5-10 improvements max — quality over quantity. If fewer than 5 are genuinely missing, return fewer.

ACTION PLAN (COMPREHENSIVE LISTING REVIEW):
Generate a step-by-step action plan that reviews EVERY element of the listing and tells the seller exactly what to do.
You MUST include ALL of these elements in the action plan — even if the verdict is DONE:

1. title (parent level)
2. bullet_1, bullet_2, bullet_3, bullet_4, bullet_5 (parent level — review EACH individually)
3. backend_keywords (per_child level)
4. description (parent level)
5. aplus_modules (parent level) — specify which Amazon A+ module types to select from the dropdown
6. brand_story (parent level)
7. product_details (parent level)
8. images (per_child level)

For each element:
- verdict: REPLACE (swap entirely), EDIT (change specific parts), CREATE (doesn't exist, build from scratch), DONE (no action needed), SKIP (not applicable — explain why)
- priority: HIGH (directly impacts search ranking), MEDIUM (improves conversion rate), LOW (nice to have), NONE (already optimized)
- current_status: Brief factual description of what's there now (e.g. "228 chars, 5 ALL CAPS words, missing top keywords")
- instruction: Specific step-by-step instruction. NOT vague. Tell them exactly what to do.
- replacement_content: THE ACTUAL FIX. This is MANDATORY for REPLACE and EDIT verdicts. Include the full copy-paste ready text that replaces the current content.
  - For title: the new title string
  - For bullet_1 through bullet_5: the new bullet text
  - For backend_keywords: an array of strings, one per child variant (e.g. ["SKU1: keywords here", "SKU2: keywords here"])
  - For description: the full HTML description
  - For product_details: a string listing each field and value (e.g. "Compatible Devices: DSLR, Mirrorless | Warranty: 5 Years | Material: Plastic")
  - For aplus_modules, brand_story, images: null (these require visual assets, not text)
  - For DONE/SKIP verdicts: null (no content needed)
- seller_central_path: Exact navigation in Seller Central (e.g. "Inventory → Edit Listing → Vital Info → Product Name")
- notes: Important context (e.g. "A+ Content overrides description — description edits won't display to customers")

For aplus_modules specifically, include aplus_modules array with:
- module_type: The exact Amazon A+ module name from the dropdown (e.g. "Standard Comparison Chart", "Standard Image & Text Overlay", "Standard Four Image & Text", "Standard Single Image & Highlights")
- action: ADD (new module), EDIT (change existing), KEEP (leave as-is)
- content_brief: What content/images to put in this module
- position: Order number (1-7)

RULES FOR VERDICTS:
- If current bullets are strong and your recommended bullets are very similar, mark individual bullets as DONE
- If A+ exists with 2 modules, mark as EDIT and specify which 5 modules to ADD (with types and content)
- If description exists but A+ overrides it, mark description as SKIP with note explaining why
- For backend keywords, always mark as per_child and note that each child needs DIFFERENT keywords
- For images, specify what TYPE of image to add (lifestyle, infographic, size chart, comparison, packaging)
- If brand story is missing, mark as CREATE and describe what to include

KEYWORD RECONCILIATION REPORT:
This is the MOST IMPORTANT part. For every CRITICAL and UPGRADE keyword from the KEYWORD INTELLIGENCE section above, you MUST produce a reconciliation entry showing:
- Which keyword it is and its action type
- WHERE you placed it (title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords)
- The EXACT sentence or phrase in your recommended content where the keyword appears
- WHY you placed it there (e.g. "Highest volume keyword — placed in title for maximum visibility")
This lets the seller see at a glance: keyword → exact placement → copy-paste ready text.

KEYWORD DISTRIBUTION RULES FOR RECONCILIATION:
- Title: ONLY top 2-3 keywords by OPPORTUNITY SCORE. Do NOT put more than 3 keywords in the title.
- Bullets 1-3: Next 3-5 keywords by opportunity. Each bullet should target 1-2 keywords naturally.
- Backend keywords: All remaining keywords that don't fit naturally in title/bullets.
- If a keyword could NOT be naturally placed in title or bullets, place it in backend_keywords.
Include ALL keywords from the CRITICAL GAPS and TITLE UPGRADES sections — do not skip any.

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "recommended_title": "string (generic title template, 80-150 chars HARD LIMIT, target 100-120 chars, NO variant-specific attributes, Title Case, no ALL CAPS except acronyms, include only top 2-3 keywords)",
  "recommended_bullets": ["string", "string", "string", "string", "string"],
  "per_child_keywords": [
    {
      "sku": "string (the child SKU)",
      "asin": "string (the child ASIN)",
      "keywords": "string (unique 250-char keyword string for THIS child, including variant-specific terms)"
    }
  ],
  "recommended_description": "string (full HTML description, min 150 words, generic for all variants)",
  "variant_corrections": [
    {
      "sku": "string",
      "field": "string (title|bullets|keywords|description)",
      "current": "string",
      "replace_with": "string",
      "reason": "string"
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
      "current_value": "string or null",
      "recommended_value": "string",
      "reason": "string"
    }
  ],
  "keyword_reconciliation": [
    {
      "keyword": "string (the exact keyword from KEYWORD INTELLIGENCE)",
      "action_type": "string (CRITICAL or UPGRADE or REINFORCE)",
      "search_volume": 0,
      "placed_in": ["string (title|bullet_1|bullet_2|bullet_3|bullet_4|bullet_5|description|backend_keywords)"],
      "exact_text": "string (the exact sentence or phrase from your recommendation where this keyword appears)",
      "why": "string (brief reason for this placement)"
    }
  ],
  "action_plan": [
    {
      "element": "string (title|bullet_1|bullet_2|bullet_3|bullet_4|bullet_5|backend_keywords|description|aplus_modules|brand_story|product_details|images)",
      "level": "string (parent|per_child)",
      "verdict": "string (REPLACE|EDIT|CREATE|DONE|SKIP)",
      "priority": "string (HIGH|MEDIUM|LOW|NONE)",
      "current_status": "string (brief factual description of current state)",
      "instruction": "string (specific step-by-step instruction)",
      "seller_central_path": "string (exact Seller Central navigation)",
      "replacement_content": "string or array of strings (the actual copy-paste fix) or null if verdict is DONE/SKIP or element requires visual assets",
      "notes": "string (optional important context)",
      "aplus_modules": [
        {
          "module_type": "string (exact Amazon A+ module name)",
          "action": "string (ADD|EDIT|KEEP)",
          "content_brief": "string (what to put in this module)",
          "position": 1
        }
      ]
    }
  ]
}`

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

          // Parse the JSON response
          let parsed: {
            recommended_title: string
            recommended_bullets: string[]
            per_child_keywords?: { sku: string; asin: string; keywords: string }[]
            recommended_keywords?: string
            recommended_description: string
            variant_corrections?: VariantCorrection[]
            cannibalization_warnings?: CannibalizationWarning[]
            product_details_improvements?: ProductDetailImprovement[]
            keyword_reconciliation?: KeywordReconciliation[]
            action_plan?: ActionPlanItem[]
          }

          try {
            const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
            parsed = JSON.parse(cleaned)
          } catch {
            console.error('[AI Recs] Failed to parse LLM response:', rawContent.slice(0, 500))
            controller.enqueue(encoder.encode(JSON.stringify({ type: 'error', error: 'AI returned invalid JSON. Please try again.' }) + '\n'))
            controller.close()
            return
          }

          controller.enqueue(encoder.encode(JSON.stringify({ type: 'progress', message: 'Validating keywords...' }) + '\n'))

          // Post-generation validation: verify CRITICAL keywords were included
          const criticalKeywords = (await getStoredAnalysis(children[0]?.asin, 10))
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

          // Post-generation enforcement: truncate each child's backend keywords to 250 chars
          const perChildKeywords: PerChildKeywords[] = (parsed.per_child_keywords || []).map(pck => {
            let kw = (pck.keywords || '').trim()
            if (kw.length > 250) {
              const truncated = kw.slice(0, 250)
              const lastSpace = truncated.lastIndexOf(' ')
              kw = lastSpace > 200 ? truncated.slice(0, lastSpace).trim() : truncated.trim()
              console.warn(`[AI Recs] Per-child keywords for ${pck.sku} truncated from ${pck.keywords.length} to ${kw.length} chars`)
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

          const rec: AiRecommendations = {
            parent_asin,
            recommended_title: parsed.recommended_title || '',
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
