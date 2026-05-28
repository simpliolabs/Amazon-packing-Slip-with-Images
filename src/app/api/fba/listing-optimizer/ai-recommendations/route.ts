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

export interface VariantCorrection {
  sku: string
  field: string
  current: string
  replace_with: string
  reason: string
}

export interface AiRecommendations {
  parent_asin: string
  recommended_title: string
  recommended_bullets: string[]
  recommended_keywords: string
  recommended_description: string
  variant_corrections: VariantCorrection[]
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

    // Build per-variant detail for conflict analysis
    const variantDetails = children.map((c: ChildRow, idx: number) => {
      const cBullets = [c.bullet_1, c.bullet_2, c.bullet_3, c.bullet_4, c.bullet_5].filter(Boolean) as string[]
      return `VARIANT ${idx + 1}: ${c.sku} (${c.asin})
  Title: ${c.title || '[MISSING]'}
  Bullets: ${cBullets.length > 0 ? cBullets.map((b, i) => `\n    ${i + 1}. ${b}`).join('') : '[NONE]'}
  Keywords (${(c.backend_keywords?.length || 0)}/250): ${c.backend_keywords || '[EMPTY]'}
  Description: ${c.description ? c.description.replace(/<[^>]+>/g, ' ').trim().slice(0, 200) + '...' : '[MISSING]'}`
    }).join('\n\n')
    
    // Build the prompt with actual listing data
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
`.trim()

    const systemPrompt = `You are a senior Amazon SEO specialist with 15+ years optimizing product listings on Amazon US. You have deep expertise in:
- Amazon's A10 search algorithm and keyword indexing rules
- Title optimization (200 char limit, Title Case, no ALL CAPS, keyword front-loading)
- Bullet point copywriting (benefit-led hooks in CAPS, 200 char limit per bullet, feature+benefit format)
- Backend keyword strategy (250 chars, no commas, no repetition of title/bullet terms)
- Product description HTML formatting (Amazon allows <b>, <br>, <p>, <ul>, <li>)

CRITICAL RULES:
1. This is a MULTI-VARIANT listing family. Your title, bullets, and description must work for ALL variants — do NOT mention variant-specific attributes (specific size, specific color) unless ALL variants share it.
2. Read ALL variant titles carefully to understand what the product actually is. Do NOT confuse product types (e.g., "SD" vs "micro SD" — check the actual titles to determine which).
3. If variants differ by capacity (32GB, 64GB, 128GB), write bullets that are capacity-agnostic OR mention the full range.
4. Do NOT invent features or specs not mentioned in the current listing. Only rephrase and optimize what's already there.
5. Use SIMPLE, EVERYDAY ENGLISH. Never use obscure or thesaurus-style vocabulary. Bad: "Amply Capacious". Good: "Large Storage Capacity".
6. Bullet hooks must be 2-4 common words a shopper instantly understands.

AMAZON RULES TO ENFORCE:
- Title: Max 200 chars, Title Case, no ALL CAPS words (except acronyms like UHS-I, SDHC), no promotional phrases, keywords in first 80 chars
- Bullets: Start each with a 2-5 word benefit hook in ALL CAPS followed by " – ", then feature+benefit. Max 200 chars each. Plain English.
- Backend keywords: Space-separated, no commas, no terms already in title or bullets. HARD LIMIT: output EXACTLY ${kwRemaining} chars or fewer of NEW keywords. Each keyword/phrase must be UNIQUE — NEVER repeat any word or phrase. Include a MIX of: device compatibility ("for Canon EOS R5"), use-case terms ("trail camera", "dash cam"), seasonal ("holiday gift"), and common misspellings. Output must be a single line of space-separated terms, max ${kwRemaining} characters total.
- Description: Use HTML tags (<b>, <br>, <ul>, <li>). Min 150 words. Generic for all variants.

VARIANT CONFLICT CORRECTIONS:
Compare the per-variant content provided above. For EACH variant that differs from Variant 1, output a specific correction object with:
- The exact SKU
- Which field(s) differ (title, bullets, keywords, description)
- The EXACT text that should REPLACE the current text (not vague instructions — give copy-paste-ready text)
- If a variant uses wrong terminology (e.g., says "TF" when it should say "SD"), specify the exact find-and-replace

Return ONLY valid JSON matching this exact schema — no markdown, no explanation:
{
  "recommended_title": "string (the exact new title to paste in, max 200 chars, generic for all variants)",
  "recommended_bullets": ["string", "string", "string", "string", "string"],
  "recommended_keywords": "string (UNIQUE terms to ADD, max ${kwRemaining} chars, NO repetition)",
  "recommended_description": "string (full HTML description, min 150 words, generic for all variants)",
  "variant_corrections": [
    {
      "sku": "string (the SKU that needs correction)",
      "field": "string (title|bullets|keywords|description)",
      "current": "string (the problematic text currently there)",
      "replace_with": "string (the exact corrected text to paste in)",
      "reason": "string (brief explanation of why this change is needed)"
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
      max_tokens: 3000,
    })

    const rawContent = completion.choices[0]?.message?.content || ''

    // Parse the JSON response — strip markdown code fences if present
    let parsed: {
      recommended_title: string
      recommended_bullets: string[]
      recommended_keywords: string
      recommended_description: string
      variant_corrections?: VariantCorrection[]
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
      variant_corrections: Array.isArray(parsed.variant_corrections) ? parsed.variant_corrections : [],
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
