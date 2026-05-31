/**
 * POST /api/fba/listing-optimizer/ai-recommendations
 * ─────────────────────────────────────────────────────────────────────────────
 * V3: Generates AI-powered SEO recommendations that correctly follow Amazon's
 * parent/child listing architecture:
 *
 *   SHARED (parent-level): title template, bullets, description
 *   PER-CHILD: backend keywords (unique per variant)
 *
 * Uses gpt-4.1-mini via the OpenAI-compatible API.
 * Results are stored in listing_seo_recommendations for instant re-display.
 *
 * Body: { parent_asin: string }
 * Returns: { recommendations: AiRecommendations }
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

export interface AiRecommendations {
  parent_asin: string
  recommended_title: string
  recommended_bullets: string[]
  recommended_keywords: string          // Legacy: first child's keywords (for backward compat)
  per_child_keywords: PerChildKeywords[] // V3: unique keywords per child
  recommended_description: string
  variant_corrections: VariantCorrection[]
  cannibalization_warnings: CannibalizationWarning[]
  product_details_improvements: ProductDetailImprovement[]
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
1. Every CRITICAL GAP keyword must appear in either the title or bullet 1/2
2. Every TITLE UPGRADE keyword must appear in the title
3. Do NOT sacrifice readability — keywords must flow naturally in the copy
4. Backend keywords: prioritize terms NOT already in title/bullets
`.trim()

  return {
    contextBlock,
    opportunitiesUsed: critical.length + upgrade.length + reinforce.length + defended.length,
  }
}

// ─── POST Handler ─────────────────────────────────────────────────────────────

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

IMAGE COUNT: ${rep.image_count || 0}/7
A+ CONTENT: ${rep.has_aplus ? `Yes (${rep.aplus_module_count} modules)` : 'No'}

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

TITLE RULES:
- 150-200 chars (sweet spot — under 150 gets penalized, over 200 gets truncated)
- Title Case (capitalize first letter of each major word)
- NO ALL CAPS words except recognized acronyms (e.g., UHS-I, SDHC, USB, LED, FBA)
- No promotional phrases ("Best Seller", "Free Shipping")
- Front-load the most important keywords in the first 80 chars
- NEVER include variant-specific attributes (specific size, color, capacity) — Amazon handles that
- The title must make sense for EVERY child in the family

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

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "recommended_title": "string (generic title template, 150-200 chars, NO variant-specific attributes, Title Case, no ALL CAPS except acronyms)",
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
  ]
}`

    const openai = getOpenAI()

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: listingContext },
      ],
      temperature: 0.3,
      max_tokens: 8000,
    })

    const rawContent = completion.choices[0]?.message?.content || ''

    // Parse the JSON response
    let parsed: {
      recommended_title: string
      recommended_bullets: string[]
      per_child_keywords?: { sku: string; asin: string; keywords: string }[]
      recommended_keywords?: string  // Legacy fallback
      recommended_description: string
      variant_corrections?: VariantCorrection[]
      cannibalization_warnings?: CannibalizationWarning[]
      product_details_improvements?: ProductDetailImprovement[]
    }

    try {
      const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      console.error('[AI Recs] Failed to parse LLM response:', rawContent.slice(0, 500))
      return NextResponse.json({ error: 'AI returned invalid JSON. Please try again.' }, { status: 500 })
    }

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

    // Legacy fallback: if AI returned old-style single string, use it
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

    // Build the full response object
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
      generated_at: new Date().toISOString(),
      keyword_opportunities_used: opportunitiesUsed,
    }

    // Store in listing_seo_recommendations
    // The DB may not have per_child_keywords column yet, so we serialize it into recommended_keywords as JSON
    const { per_child_keywords: pck, cannibalization_warnings, product_details_improvements, keyword_opportunities_used, ...persistFields } = rec

    // Serialize per_child_keywords as JSON string into recommended_keywords for DB storage
    const dbPayload: Record<string, unknown> = {
      ...persistFields,
      // Store per_child_keywords as a JSON-encoded string in recommended_keywords
      // The UI will try JSON.parse() first; if it fails, treat as legacy string
      recommended_keywords: JSON.stringify(perChildKeywords),
      cannibalization_warnings,
      product_details_improvements,
    }

    const { error: upsertErr } = await supabase
      .from('listing_seo_recommendations')
      .upsert(dbPayload, { onConflict: 'parent_asin' })

    if (upsertErr) {
      // Likely missing columns — retry with only the original fields
      console.warn('[AI Recs] Full upsert failed, retrying without new fields:', upsertErr.message)
      const fallbackPayload = {
        ...persistFields,
        recommended_keywords: JSON.stringify(perChildKeywords),
      }
      await supabase
        .from('listing_seo_recommendations')
        .upsert(fallbackPayload, { onConflict: 'parent_asin' })
    }

    return NextResponse.json({
      recommendations: rec,
      keywordIntelligenceUsed: opportunitiesUsed > 0,
      missedCriticalKeywords: missedCritical,
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

  return NextResponse.json({
    recommendations: {
      ...data,
      per_child_keywords,
      // Keep recommended_keywords as the first child's keywords for backward compat
      recommended_keywords: per_child_keywords.length > 0
        ? per_child_keywords[0].keywords
        : data.recommended_keywords || '',
    },
  })
}
