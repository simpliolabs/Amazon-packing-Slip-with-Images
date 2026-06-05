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
import { runListingPipeline } from '@/lib/fba/listingPipeline'

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
  per_child_titles?: { sku: string; asin: string; title: string }[]
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
    const { data: childrenRaw, error } = await supabase
      .from('listing_content')
      .select('sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt')
      .eq('parent_asin', parent_asin)
      .order('sku', { ascending: true })

    if (error || !childrenRaw || childrenRaw.length === 0) {
      return NextResponse.json({ error: 'No listing content found. Run Scan Listings first.' }, { status: 404 })
    }

    // Dedup by ASIN (prefer the FBA SKU). The same ASIN can have BOTH an FBA and an FBM SKU in
    // listing_content (stale per-SKU rows); backend search terms are effectively per-ASIN, so
    // generate ONE recommendation per ASIN — otherwise the push writes the same string to both
    // SKUs of an ASIN (the duplicate-push the PO flagged).
    const byAsin = new Map<string, ChildRow>()
    for (const c of childrenRaw as ChildRow[]) {
      const existing = byAsin.get(c.asin)
      if (!existing || c.sku.endsWith('-FBA')) byAsin.set(c.asin, c)
    }
    const children: ChildRow[] = [...byAsin.values()].sort((a, b) => a.sku.localeCompare(b.sku))

    const rep = children[0] as ChildRow

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
      // product_type intentionally excluded — leaks product name into LLM context
      category: 'Clothing, Shoes & Jewelry > Novelty & More > Clothing > Novelty',
      is_new_listing: !rep.title,
      has_aplus: rep.has_aplus || false,
      has_brand_story: rep.aplus_has_brand_story || false,
      // NOTE: current_title and current_bullets are intentionally excluded from the LLM input.
      // The model must NOT anchor on existing product name phrases (e.g., "Later Gator Vintage 90s T-Shirt")
      // when generating the new title and bullets. All content must be driven purely by keyword
      // opportunity scores from the Keyword Intelligence block.
      // Current content is available in diagnosis_only fields below for issue detection only.
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

    // ─── Resolve the keyword-bearing ASIN and load the analysis for the pipeline ───
    const { data: pipelineScoreRow } = await supabase
      .from('listing_seo_scores')
      .select('top_child_asin')
      .eq('parent_asin', parent_asin)
      .single()
    const analysisAsin = pipelineScoreRow?.top_child_asin || children[0]?.asin
    const analysis = (await getStoredAnalysis(analysisAsin, 50)) ?? []

    // Build the child list for the pipeline (color/size parsed from SKU)
    const pipelineChildren = children.map((c: ChildRow) => {
      const color = extractColor(c.sku, c.title || '')
      const skuParts = c.sku.split('-')
      const size = skuParts.length >= 3 ? skuParts[2] : null
      // title is threaded through so the pipeline can read each child's current capacity
      // (e.g. "...128GB...") for per-child capacity titles on storage-variation families.
      return { sku: c.sku, asin: c.asin, color: color || null, size: size || null, title: c.title || null }
    })

    const openai = getOpenAI()
    const encoder = new TextEncoder()

    // ─── Streaming shell: run the multi-agent pipeline, emitting NDJSON keepalives ───
    // Coolify/Cloudflare drop idle connections at ~100s; emit() before each agent keeps
    // the connection warm. Each agent is a focused single-task prompt (see listingPipeline).
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
        try {
          emit({ type: 'progress', message: 'Analyzing listing content...' })
          if (analysis.length === 0) {
            emit({ type: 'progress', message: 'No keyword data yet — generating from listing content...' })
          }

          const result = await runListingPipeline({
            openai,
            brandName,
            category: inputJson.category,
            analysis,
            children: pipelineChildren,
            repTitle: rep.title,
            variantDetails,
            keywordContext,
            hasAplus: rep.has_aplus || false,
            hasBrandStory: rep.aplus_has_brand_story || false,
            auditModel: 'o4-mini',
            onProgress: (message) => emit({ type: 'progress', message }),
          })

          emit({ type: 'progress', message: 'Saving to database...' })

          const rec: AiRecommendations = {
            parent_asin,
            recommended_title: result.recommended_title,
            recommended_bullets: result.recommended_bullets,
            recommended_keywords: result.per_child_keywords[0]?.keywords ?? '',
            per_child_keywords: result.per_child_keywords,
            per_child_titles: result.per_child_titles,
            recommended_description: result.recommended_description,
            variant_corrections: result.variant_corrections,
            cannibalization_warnings: result.cannibalization_warnings,
            product_details_improvements: result.product_details_improvements,
            keyword_reconciliation: result.keyword_reconciliation as KeywordReconciliation[],
            action_plan: result.action_plan as ActionPlanItem[],
            generated_at: new Date().toISOString(),
            keyword_opportunities_used: opportunitiesUsed,
          }

          // DB write. recommended_bullets + the *_warnings/improvements/reconciliation/action_plan
          // columns are JSONB (arrays written directly); recommended_keywords is TEXT (JSON string).
          const dbPayload: Record<string, unknown> = {
            parent_asin: rec.parent_asin,
            recommended_title: rec.recommended_title,
            recommended_bullets: rec.recommended_bullets,
            recommended_keywords: JSON.stringify(rec.per_child_keywords),
            recommended_description: rec.recommended_description,
            generated_at: rec.generated_at,
            variant_corrections: rec.variant_corrections,
            cannibalization_warnings: rec.cannibalization_warnings,
            product_details_improvements: rec.product_details_improvements,
            keyword_reconciliation: rec.keyword_reconciliation,
            action_plan: rec.action_plan,
          }

          const { error: upsertErr } = await supabase
            .from('listing_seo_recommendations')
            .upsert(dbPayload, { onConflict: 'parent_asin' })
          if (upsertErr) {
            console.warn('[AI Recs] Full upsert failed, retrying minimal payload:', upsertErr.message)
            await supabase.from('listing_seo_recommendations').upsert({
              parent_asin: rec.parent_asin,
              recommended_title: rec.recommended_title,
              recommended_bullets: rec.recommended_bullets,
              recommended_keywords: JSON.stringify(rec.per_child_keywords),
              recommended_description: rec.recommended_description,
              generated_at: rec.generated_at,
            }, { onConflict: 'parent_asin' })
          }

          // Refresh the ISSUES-TO-FIX panel so it reflects the current listing. The scorer
          // otherwise only runs on Sync, so deployed copy fixes and content changes looked
          // stale here. Best-effort — must NEVER break a generation that already persisted.
          emit({ type: 'progress', message: 'Refreshing issues panel...' })
          try {
            const { scoreListingContent, fetchScoringContext } = await import('@/lib/sync/syncListingContent')
            // The route's child rows carry the fields the scorer reads (title/bullets/
            // description/backend/image_count/aplus_*); cast to the scorer's row shape.
            const scoreRows = children as unknown as Parameters<typeof scoreListingContent>[1]
            const parentOwn = scoreRows.find((r) => r.asin === parent_asin) || null
            const ctx = await fetchScoringContext(supabase, parent_asin, pipelineScoreRow?.top_child_asin || children[0]?.asin || null)
            const score = scoreListingContent(parentOwn, scoreRows, ctx)
            await supabase.from('listing_seo_scores').update({
              title_score: score.title_score,
              bullet_score: score.bullet_score,
              keyword_score: score.keyword_score,
              aplus_score: score.aplus_score,
              overall_score: score.overall_score,
              issues: score.issues,
              child_override_count: score.child_override_count,
            }).eq('parent_asin', parent_asin)
          } catch (scoreErr) {
            console.warn('[AI Recs] Issue re-score failed (non-fatal):', scoreErr instanceof Error ? scoreErr.message : scoreErr)
          }

          emit({
            type: 'result',
            recommendations: rec,
            keywordIntelligenceUsed: opportunitiesUsed > 0,
            titleDebug: result.debug,
          })
          controller.close()
        } catch (err) {
          console.error('[AI Recs] Pipeline error:', err)
          emit({ type: 'error', error: err instanceof Error ? err.message : 'Unexpected error during generation' })
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
