/**
 * POST /api/fba/listing-optimizer/ai-recommendations
 *
 * Generates AI-powered, copy-paste-ready SEO recommendations for a specific
 * parent ASIN using the actual listing content stored in listing_content.
 *
 * Uses gemini-2.5-flash via the OpenAI-compatible API for fast, cheap analysis.
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
  aplus_suggestions: string
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

    // Build the prompt with actual listing data
    const listingContext = `
PRODUCT LISTING DATA (Amazon US):
Parent ASIN: ${parent_asin}
SKU (representative): ${rep.sku}
Child ASIN: ${rep.asin}
Variants: ${children.length} child SKUs

CURRENT TITLE (${rep.title?.length || 0} chars):
${rep.title || '[MISSING]'}

CURRENT BULLET POINTS (${bullets.length}/5):
${bullets.length > 0 ? bullets.map((b, i) => `${i + 1}. ${b}`).join('\n') : '[NO BULLETS]'}

CURRENT PRODUCT DESCRIPTION:
${rep.description ? rep.description.replace(/<[^>]+>/g, ' ').trim().slice(0, 800) : '[MISSING — no description set]'}

CURRENT BACKEND KEYWORDS (${kwLen}/250 chars used, ${kwRemaining} chars remaining):
${rep.backend_keywords || '[EMPTY]'}

A+ CONTENT STATUS:
- Has A+: ${rep.has_aplus ? 'Yes' : 'No'}
- Module count: ${rep.aplus_module_count || 0} (Amazon allows up to 7 standard modules)
- Has Brand Story (EMC): ${rep.aplus_has_brand_story ? 'Yes' : 'No'}
- Has Headline module: ${rep.aplus_has_headline ? 'Yes' : 'No'}
- Images missing alt text: ${rep.aplus_images_missing_alt || 0}
- Image count: ${rep.image_count || 0}/7 (Amazon allows up to 7 product images)
`.trim()

    const systemPrompt = `You are a senior Amazon SEO specialist with 15+ years optimizing product listings on Amazon US. You have deep expertise in:
- Amazon's A10 search algorithm and keyword indexing rules
- Title optimization (200 char limit, Title Case, no ALL CAPS, keyword front-loading)
- Bullet point copywriting (benefit-led hooks in CAPS, 200 char limit per bullet, feature+benefit format)
- Backend keyword strategy (250 chars, no commas, no repetition of title/bullet terms)
- Product description HTML formatting (Amazon allows <b>, <br>, <p>, <ul>, <li>)
- A+ Content module strategy for conversion optimization

You will receive a product listing's current content and return SPECIFIC, COPY-PASTE-READY improvements. Do not give generic advice — write the actual improved copy the seller can paste directly into Seller Central.

AMAZON RULES TO ENFORCE:
- Title: Max 200 chars, Title Case, no ALL CAPS words (except acronyms like UHS-I, SDHC, USB), no promotional phrases ("Best", "Sale", "#1"), keywords in first 80 chars
- Bullets: Start each with a 2-5 word benefit hook in ALL CAPS followed by " – ", then feature+benefit explanation. Max 200 chars each. No pricing or promotional content.
- Backend keywords: Space-separated, no commas, no terms already in title or bullets, 250 char max total
- Description: Use HTML tags. Min 150 words. Include primary keywords naturally. End with a call to action.

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "recommended_title": "string (the exact new title to paste in, max 200 chars)",
  "recommended_bullets": ["string", "string", "string", "string", "string"],
  "recommended_keywords": "string (exact terms to ADD to backend keywords, fitting in the remaining chars)",
  "recommended_description": "string (full HTML description to paste in, min 150 words)",
  "aplus_suggestions": "string (specific module recommendations with exact copy for headlines and text blocks)"
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
      aplus_suggestions: string
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
      aplus_suggestions: parsed.aplus_suggestions || '',
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
