/**
 * POST /api/fba/listing-optimizer/ai-recommendations
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates AI-powered, copy-paste-ready SEO recommendations for a specific
 * parent ASIN using the actual listing content stored in listing_content.
 *
 * V2 ENHANCEMENT: Injects keyword intelligence context (top opportunities,
 * critical gaps, missing keywords) so the AI knows EXACTLY which keywords
 * to prioritize in the title, bullets, and backend keywords.
 *
 * Uses gpt-4.1-mini via the OpenAI-compatible API for fast, cheap analysis.
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

export interface AiRecommendations {
  parent_asin: string
  recommended_title: string
  recommended_bullets: string[]
  recommended_keywords: string
  recommended_description: string
  variant_corrections: VariantCorrection[]
  cannibalization_warnings: CannibalizationWarning[]
  product_details_improvements: ProductDetailImprovement[]
  generated_at: string
  keyword_opportunities_used?: number
}

// ─── Keyword Intelligence Context Builder ─────────────────────────────────────

/**
 * Fetches stored keyword analysis for the first child ASIN of a parent
 * and formats it as a context block for the AI prompt.
 *
 * This is the V2 enhancement: the AI now knows which keywords are
 * MISSING from the listing and which ones to prioritize.
 */
async function buildKeywordContext(
  supabase: ReturnType<typeof getAdminSupabase>,
  parentAsin: string,
  children: ChildRow[]
): Promise<{ contextBlock: string; opportunitiesUsed: number }> {
  // Try to get keyword analysis for the first child ASIN
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

  // Separate by action type
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

    // Use the first child as the representative (parent-level content)
    const rep = children[0] as ChildRow
    const bullets = [rep.bullet_1, rep.bullet_2, rep.bullet_3, rep.bullet_4, rep.bullet_5].filter(Boolean) as string[]
    const kwLen = rep.backend_keywords?.trim().length || 0
    const kwRemaining = 250 - kwLen

    // Build per-variant detail for conflict analysis
    const variantDetails = children.map((c: ChildRow, idx: number) => {
      const cBullets = [c.bullet_1, c.bullet_2, c.bullet_3, c.bullet_4, c.bullet_5].filter(Boolean) as string[]
      return `VARIANT ${idx + 1}: ${c.sku} (${c.asin})
  Title: ${c.title || '[MISSING]'}
  Bullets: ${cBullets.length > 0 ? cBullets.map((b, i) => `\n    ${i + 1}. ${b}`).join('') : '[NONE]'}
  Keywords (${(c.backend_keywords?.length || 0)}/250): ${c.backend_keywords || '[EMPTY]'}
  Description: ${c.description ? c.description.replace(/<[^>]+>/g, ' ').trim().slice(0, 200) + '...' : '[MISSING]'}`
    }).join('\n\n')

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

IMPORTANT: This is a MULTI-VARIANT listing. Your recommendations (title, bullets, description) must be GENERIC enough to apply to ALL variants in this family. Do NOT mention specific sizes, colors, or variant-specific attributes unless they ALL share that attribute.

--- PER-VARIANT CONTENT (compare these to find conflicts) ---
${variantDetails}
--- END VARIANT CONTENT ---

CURRENT BACKEND KEYWORDS FOR VARIANT 1 (${kwLen}/250 chars used, ${kwRemaining} chars remaining):
${rep.backend_keywords || '[EMPTY]'}

IMAGE COUNT: ${rep.image_count || 0}/7
A+ CONTENT: ${rep.has_aplus ? `Yes (${rep.aplus_module_count} modules)` : 'No'}

${keywordContext ? `\n--- KEYWORD INTELLIGENCE (V2) ---\n${keywordContext}\n--- END KEYWORD INTELLIGENCE ---` : ''}
`.trim()

    const systemPrompt = `You are a senior Amazon SEO specialist with 15+ years optimizing product listings on Amazon US. You have deep expertise in:
- Amazon's A10 search algorithm and keyword indexing rules
- Title optimization (200 char limit, Title Case, no ALL CAPS, keyword front-loading)
- Bullet point copywriting (benefit-led hooks in CAPS, 200 char limit per bullet, feature+benefit format)
- Backend keyword strategy (250 chars, no commas, no repetition of title/bullet terms)
- Product description HTML formatting (Amazon allows <b>, <br>, <p>, <ul>, <li>)

V2 ENHANCEMENT: You now have access to KEYWORD INTELLIGENCE data showing exactly which
high-opportunity keywords are missing from the listing. You MUST use this data to drive
your recommendations. The goal is not just to optimize copy — it's to capture ranking
and sales from keywords that are proven to generate revenue but are currently missing
from the listing's most visible fields.

CRITICAL RULES:
1. This is a MULTI-VARIANT listing family. Your title, bullets, and description must work for ALL variants — do NOT mention variant-specific attributes (specific size, specific color) unless ALL variants share it.
2. Read ALL variant titles carefully to understand what the product actually is. Do NOT confuse product types.
3. If variants differ by capacity (32GB, 64GB, 128GB), write bullets that are capacity-agnostic OR mention the full range.
4. Do NOT invent features or specs not mentioned in the current listing. Only rephrase and optimize what's already there.
5. Use SIMPLE, EVERYDAY ENGLISH. Never use obscure or thesaurus-style vocabulary.
6. Bullet hooks must be 2-4 common words a shopper instantly understands.
7. CRITICAL GAP keywords from the keyword intelligence section MUST appear in title or bullets 1-2.
8. TITLE UPGRADE keywords MUST appear in the title.

AMAZON RULES TO ENFORCE:
- Title: 150-200 chars (the sweet spot — under 150 gets penalized, over 200 gets truncated in search), Title Case, no ALL CAPS words (except acronyms like UHS-I, SDHC), no promotional phrases, keywords in first 80 chars
- Bullets: Start each with a 2-5 word benefit hook in ALL CAPS followed by " – ", then feature+benefit. Max 200 chars each. Plain English.
- Backend keywords: Space-separated, no commas, no duplicates of title/bullet terms. Output the COMPLETE FULL 250-character keyword string — this means KEEP the existing good keywords AND add new ones to fill the remaining ${kwRemaining} chars. The output must be the ENTIRE replacement string (not just additions). Each word/phrase must appear only ONCE — NEVER repeat. Include a MIX of: device compatibility, use-case terms, seasonal, and common misspellings. HARD LIMIT: exactly 250 characters max total.
- Description: Use HTML tags (<b>, <br>, <ul>, <li>). Min 150 words. Generic for all variants.

VARIANT CONFLICT CORRECTIONS:
Compare the per-variant content provided above. ONLY flag HARMFUL differences — NOT expected variant differentiation.

DO flag (harmful drift):
- Wrong product type/terminology
- Contradictory or incorrect specs
- Completely off-brand or incoherent messaging

DO NOT flag (expected differentiation):
- Different size/capacity in title or bullets — this is CORRECT
- Different color names, flavor, scent, material variant attributes

CANNIBALIZATION ANALYSIS:
Compare the per-variant titles, bullets, and backend keywords. Identify:
1. Keywords that appear in the WRONG variant (e.g., "128GB" in the 32GB variant's title or bullets)
2. Variants competing against each other for the same search terms unnecessarily
3. Keyword stuffing that dilutes relevance (same keyword repeated across multiple fields)
Only report genuine problems — NOT expected variant differentiation.

PRODUCT DETAILS PAGE IMPROVEMENTS:
Based on the listing content and product type, suggest the TOP 10 most impactful structured attribute improvements for the Amazon Product Details page (Seller Central "Product Details" tab). Focus on:
- Fields that customers commonly filter by (e.g., Compatible Devices, Storage Capacity, Read Speed)
- Fields that improve search discoverability (e.g., Special Features, Use Case)
- Fields that are currently empty or have incorrect values
Do NOT suggest fields irrelevant to this product category.

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "recommended_title": "string (the exact new title to paste in, 150-200 chars target range, generic for all variants, includes CRITICAL GAP and TITLE UPGRADE keywords)",
  "recommended_bullets": ["string", "string", "string", "string", "string"],
  "recommended_keywords": "string (the COMPLETE FULL 250-char keyword string — existing good terms + new terms combined, max 250 chars total, prioritizes terms NOT already in title/bullets)",
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
      "keyword": "string (the keyword causing the issue)",
      "affected_skus": ["string (SKU 1)", "string (SKU 2)"],
      "issue": "string (clear description of the cannibalization problem)",
      "recommendation": "string (specific fix)"
    }
  ],
  "product_details_improvements": [
    {
      "field_name": "string (exact Seller Central field name, e.g. 'Compatible Devices')",
      "current_value": "string or null (what's currently there)",
      "recommended_value": "string (what it should be)",
      "reason": "string (why this matters for ranking/conversion)"
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
      max_tokens: 6000,
    })

    const rawContent = completion.choices[0]?.message?.content || ''

    // Parse the JSON response — strip markdown code fences if present
    let parsed: {
      recommended_title: string
      recommended_bullets: string[]
      recommended_keywords: string
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
        `[AI Recs] V2 validation: AI missed ${missedCritical.length} CRITICAL keywords: ${missedCritical.join(', ')}`
      )
      // Log but don't fail — the AI may have used synonyms or paraphrased
    }

    // Post-generation enforcement: truncate backend keywords to Amazon's 250-char hard limit
    let safeKeywords = (parsed.recommended_keywords || '').trim()
    if (safeKeywords.length > 250) {
      // Truncate at the last full word boundary within 250 chars
      const truncated = safeKeywords.slice(0, 250)
      const lastSpace = truncated.lastIndexOf(' ')
      safeKeywords = lastSpace > 200 ? truncated.slice(0, lastSpace).trim() : truncated.trim()
      console.warn(`[AI Recs] Backend keywords truncated from ${parsed.recommended_keywords!.length} to ${safeKeywords.length} chars (250 limit)`)
    }

    // Build the full response object
    const rec: AiRecommendations = {
      parent_asin,
      recommended_title: parsed.recommended_title || '',
      recommended_bullets: Array.isArray(parsed.recommended_bullets) ? parsed.recommended_bullets.slice(0, 5) : [],
      recommended_keywords: safeKeywords,
      recommended_description: parsed.recommended_description || '',
      variant_corrections: Array.isArray(parsed.variant_corrections) ? parsed.variant_corrections : [],
      cannibalization_warnings: Array.isArray(parsed.cannibalization_warnings) ? parsed.cannibalization_warnings : [],
      product_details_improvements: Array.isArray(parsed.product_details_improvements) ? parsed.product_details_improvements.slice(0, 10) : [],
      generated_at: new Date().toISOString(),
      keyword_opportunities_used: opportunitiesUsed,
    }

    // Store in listing_seo_recommendations
    // Try with all fields first; if DB columns don't exist yet, retry without them.
    const { cannibalization_warnings, product_details_improvements, keyword_opportunities_used, ...persistFields } = rec
    const fullPayload: Record<string, unknown> = {
      ...persistFields,
      cannibalization_warnings,
      product_details_improvements,
    }

    const { error: upsertErr } = await supabase
      .from('listing_seo_recommendations')
      .upsert(fullPayload, { onConflict: 'parent_asin' })

    if (upsertErr) {
      // Likely missing columns — retry with only the original fields
      console.warn('[AI Recs] Full upsert failed, retrying without new fields:', upsertErr.message)
      await supabase
        .from('listing_seo_recommendations')
        .upsert(persistFields, { onConflict: 'parent_asin' })
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

  return NextResponse.json({ recommendations: data })
}
