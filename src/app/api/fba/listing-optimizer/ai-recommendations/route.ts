/**
 * POST /api/fba/listing-optimizer/ai-recommendations
 *
 * Generates AI-powered, copy-paste-ready SEO recommendations for a specific
 * parent ASIN using the actual listing content stored in listing_content.
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

export interface AiRecommendations {
  parent_asin: string
  recommended_title: string
  recommended_bullets: string[]
  recommended_keywords: string
  recommended_description: string
  generated_at: string
}

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

    // Build variant summary — show all SKUs and what makes them different
    const variantSummary = children.map((c: ChildRow) => {
      // Extract the differentiator from SKU or title (e.g., size, color)
      const titleShort = c.title ? c.title.slice(0, 100) : '[no title]'
      return `  - ${c.sku} (${c.asin}): ${titleShort}`
    }).join('\n')

    // Extract unique differentiators from titles (sizes, colors, etc.)
    const allTitles = children.map((c: ChildRow) => c.title || '').filter(Boolean)
    
    // Build the prompt with actual listing data
    const listingContext = `
PRODUCT LISTING DATA (Amazon US):
Parent ASIN: ${parent_asin}
Total Variants: ${children.length} child SKUs

ALL VARIANTS IN THIS FAMILY:
${variantSummary}

IMPORTANT: This is a MULTI-VARIANT listing. Your recommendations (title, bullets, description) must be GENERIC enough to apply to ALL variants in this family. Do NOT mention specific sizes, colors, or variant-specific attributes unless they ALL share that attribute. If variants differ by size (e.g., 32GB, 64GB, 128GB), write copy that covers the whole range or is size-agnostic.

REPRESENTATIVE TITLE (${rep.title?.length || 0} chars):
${rep.title || '[MISSING]'}

ALL VARIANT TITLES (to understand the product family):
${allTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

CURRENT BULLET POINTS (${bullets.length}/5):
${bullets.length > 0 ? bullets.map((b, i) => `${i + 1}. ${b}`).join('\n') : '[NO BULLETS]'}

CURRENT PRODUCT DESCRIPTION:
${rep.description ? rep.description.replace(/<[^>]+>/g, ' ').trim().slice(0, 800) : '[MISSING — no description set]'}

CURRENT BACKEND KEYWORDS (${kwLen}/250 chars used, ${kwRemaining} chars remaining):
${rep.backend_keywords || '[EMPTY]'}

IMAGE COUNT: ${rep.image_count || 0}/7
A+ CONTENT: ${rep.has_aplus ? `Yes (${rep.aplus_module_count} modules)` : 'No'}
`.trim()

    const systemPrompt = `You are a senior Amazon SEO specialist with 15+ years optimizing product listings on Amazon US. You have deep expertise in:
- Amazon's A10 search algorithm and keyword indexing rules
- Title optimization (200 char limit, Title Case, no ALL CAPS, keyword front-loading)
- Bullet point copywriting (benefit-led hooks in CAPS, 200 char limit per bullet, feature+benefit format)
- Backend keyword strategy (250 chars, no commas, no repetition of title/bullet terms)
- Product description HTML formatting (Amazon allows <b>, <br>, <p>, <ul>, <li>)

CRITICAL RULES:
1. This is a MULTI-VARIANT listing family. Your title, bullets, and description must work for ALL variants — do NOT mention variant-specific attributes (specific size, specific color) unless ALL variants share it.
2. Read ALL variant titles carefully to understand what the product actually is. Do NOT confuse product types (e.g., "SD" vs "micro SD" are different products — use the correct one from the titles).
3. If variants differ by capacity (32GB, 64GB, 128GB), write bullets that are capacity-agnostic OR mention the full range. Never write "128GB" as if it's the only option.
4. Do NOT invent features or specs not mentioned in the current listing. Only rephrase and optimize what's already there.

AMAZON RULES TO ENFORCE:
- Title: Max 200 chars, Title Case, no ALL CAPS words (except acronyms like UHS-I, SDHC, USB), no promotional phrases ("Best", "Sale", "#1"), keywords in first 80 chars
- Bullets: Start each with a 2-5 word benefit hook in ALL CAPS followed by " – ", then feature+benefit explanation. Max 200 chars each. No pricing or promotional content.
- Backend keywords: Space-separated, no commas, no terms already in title or bullets, 250 char max total. Only suggest terms that fit in the remaining ${kwRemaining} chars.
- Description: Use HTML tags. Min 150 words. Include primary keywords naturally. End with a call to action. Must be generic for all variants.

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "recommended_title": "string (the exact new title to paste in, max 200 chars, generic for all variants)",
  "recommended_bullets": ["string", "string", "string", "string", "string"],
  "recommended_keywords": "string (exact terms to ADD to backend keywords, fitting in the remaining ${kwRemaining} chars)",
  "recommended_description": "string (full HTML description to paste in, min 150 words, generic for all variants)"
}`

    const openai = getOpenAI()

    const completion = await openai.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: listingContext },
      ],
      temperature: 0.3,
      max_tokens: 3000,
    })

    const rawContent = completion.choices[0]?.message?.content || ''

    // Parse the JSON response — strip markdown code fences if present
    let parsed: {
      recommended_title: string
      recommended_bullets: string[]
      recommended_keywords: string
      recommended_description: string
    }

    try {
      const cleaned = rawContent.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      console.error('[AI Recs] Failed to parse LLM response:', rawContent.slice(0, 500))
      return NextResponse.json({ error: 'AI returned invalid JSON. Please try again.' }, { status: 500 })
    }

    // Store in listing_seo_recommendations
    const rec: AiRecommendations = {
      parent_asin,
      recommended_title: parsed.recommended_title || '',
      recommended_bullets: Array.isArray(parsed.recommended_bullets) ? parsed.recommended_bullets.slice(0, 5) : [],
      recommended_keywords: parsed.recommended_keywords || '',
      recommended_description: parsed.recommended_description || '',
      generated_at: new Date().toISOString(),
    }

    await supabase
      .from('listing_seo_recommendations')
      .upsert(rec, { onConflict: 'parent_asin' })

    return NextResponse.json({ recommendations: rec })
  } catch (err) {
    console.error('[AI Recs] Unexpected error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unexpected error' },
      { status: 500 }
    )
  }
}

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
