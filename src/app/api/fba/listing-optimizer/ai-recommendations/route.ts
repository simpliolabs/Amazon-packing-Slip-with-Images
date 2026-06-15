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
import { getStoredAnalysis, computeOutcomeSignals } from '@/lib/keyword-engine'
import { runListingPipeline } from '@/lib/fba/listingPipeline'
import { detailValueToString } from '@/lib/fba/productDetailAttrs'
import { scanProductImage, getProductImageUrl } from '@/lib/keyword-engine/visionScanner'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/**
 * Build an OpenAI client for this request. PR #82: prefers the DB-stored key from
 * Settings UI; falls back to OPENAI_API_KEY env var so historical deploys keep
 * working. The DB key is resolved via the cached helper to avoid one DB read per
 * agent call.
 */
async function getOpenAI() {
  const { resolveOpenAIKey } = await import('@/lib/openai/credentials')
  const apiKey = await resolveOpenAIKey()
  return new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  })
}

/** Seller's Amazon merchant id from app_settings (same source as push-content). Used by the
 *  validate-at-regen step to resolve the product-type schema for enum validation. */
async function getSellerId(): Promise<string> {
  const supabase = getAdminSupabase()
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'amazon_seller_id').single()
  const row = data as { value: string } | null
  if (row?.value) return row.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured. Add it in Settings.')
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
  // Part 2b — enum validation metadata stored by validate-at-regen (see route ~632).
  is_enum?: boolean
  enum_valid?: boolean
  enum_accepted?: string[]
  normalized_from?: string
  // Schema-driven mapping: the REAL SP-API key resolved from the live product-type schema (static map OR
  // dynamic title-match), the attribute scope, and whether it's pushable — so the UI/push use the resolved
  // key for ANY category, not the hardcoded apparel map. Persisted on the JSONB item (no migration).
  sp_api_key?: string
  attr_scope?: 'broadcast' | 'per-variant'
  pushable?: boolean
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

RULE 1 — TITLE (1-2 keywords max):
Build the title from the top year-round keywords by Opportunity Score. Use 1-2 keywords maximum. Prefer specific, product-relevant keywords over broad generic ones (e.g., "later gator tshirt" is better than "cool t shirts for men" for a Later Gator product because it has higher conversion intent). Title MUST be at most 75 characters (Amazon's new limit, effective July 27, 2026 — longer titles get auto-rewritten by Amazon; overflow keywords belong in backend terms and Item Highlights). Do not include variant-specific attributes (size, color).

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
    // regenerate_section: 'title'|'bullets'|'description'|'keywords'|'all' — bypass the 7-day cooling
    // lock for that section so the seller can iterate before the settling window is up.
    const { parent_asin, regenerate_section } = body as { parent_asin: string; regenerate_section?: string }

    if (!parent_asin) {
      return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    }

    const supabase = getAdminSupabase()

    // Fetch all child content rows for this parent.
    const contentCols = 'sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt'
    let { data: childrenRaw, error } = await supabase
      .from('listing_content')
      .select(contentCols)
      .eq('parent_asin', parent_asin)
      .order('sku', { ascending: true })

    // LIVE-FAMILY RECONCILE: on EVERY regen, ask Amazon's catalog for this parent's live VARIATION
    // childAsins and re-attach any listing_content row currently stored under a DIFFERENT parent.
    // This pulls in children the seller newly LINKED into the family on Amazon (e.g. a 128GB SD
    // card moved into the SD-card parent) AND heals children stored under a stale parent. A normal
    // Sync never corrects this: syncParentAsins only FILLS null parent_asins — it never re-parents
    // an existing (stale/self-parented) one. Previously this ran ONLY when the parent had 0 stored
    // children; broadened so a parent that GAINS a child is reconciled too. Best-effort — the
    // catalog call is wrapped in try/catch and never blocks a regen.
    if (!error) {
      try {
        const { getAccessToken: getTok } = await import('@/lib/amazon/auth')
        const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
        const MP = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
        const tok = await getTok()
        const url = `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(parent_asin)}?marketplaceIds=${MP}&includedData=relationships`
        const resp = await fetch(url, { headers: { 'x-amz-access-token': tok } })
        if (resp.ok) {
          const cat = await resp.json() as { relationships?: { relationships?: { type?: string; childAsins?: string[] }[] }[] }
          const childAsins: string[] = []
          for (const byMp of cat.relationships ?? []) for (const r of byMp.relationships ?? []) {
            if (r.type === 'VARIATION' && Array.isArray(r.childAsins)) childAsins.push(...r.childAsins)
          }
          if (childAsins.length > 0) {
            const { data: matched } = await supabase
              .from('listing_content')
              .select('sku, asin, parent_asin')
              .in('asin', childAsins)
            const matchedRows = (matched ?? []) as { sku: string; asin: string; parent_asin: string | null }[]

            // (1) RE-ATTACH: child rows stored under a DIFFERENT parent → move them to this parent.
            const movable = matchedRows.filter((r) => r.parent_asin !== parent_asin)
            if (movable.length > 0) {
              const movableSkus = movable.map((r) => r.sku)
              await supabase.from('listing_content').update({ parent_asin }).in('sku', movableSkus)
              console.log(`[ai-recommendations] self-heal: re-attached ${movableSkus.length} child SKU(s) to parent ${parent_asin}`)
            }

            // (2) BACKFILL (PO 2026-06-15): childAsins with NO listing_content row at ALL — the
            // zero-sales / no-FBA-inventory variations (e.g. every variation of a Custom/Handmade
            // listing) that the orders∪inventory→parent_asin funnel never ingested. The catalog is
            // ground truth for the live family, so CREATE a minimal Active row per missing child
            // (resolve childAsin→SKU via Listings Items) so the optimizer enumerates + pushes to the
            // FULL family, not just the children that happened to sell. Content is left blank — the
            // push writes the optimized values, and the next Scan Listings fills current content.
            // SP-API only (no Jungle Scout credits). Idempotent: on re-open these rows now exist, so
            // they're in matchedRows and skipped.
            const knownAsins = new Set(matchedRows.map((r) => r.asin))
            const missingAsins = childAsins.filter((a) => !knownAsins.has(a))
            if (missingAsins.length > 0) {
              try {
                const { data: sidRow } = await supabase.from('app_settings').select('value').eq('key', 'amazon_seller_id').maybeSingle()
                const sellerId = (sidRow as { value?: string } | null)?.value || process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID || ''
                const placeholderTitle = (childrenRaw?.[0] as { title?: string } | undefined)?.title ?? ''
                const nowIso = new Date().toISOString()
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const newRows: any[] = []
                if (sellerId) {
                  for (const childAsin of missingAsins.slice(0, 60)) { // cap: a runaway family can't stall the regen
                    const lurl = `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}?identifiers=${encodeURIComponent(childAsin)}&identifiersType=ASIN&marketplaceIds=${MP}&includedData=summaries`
                    const lresp = await fetch(lurl, { headers: { 'x-amz-access-token': tok } })
                    if (!lresp.ok) continue
                    const ljson = await lresp.json() as { items?: { sku?: string }[] }
                    for (const it of ljson.items ?? []) {
                      if (!it.sku || /^amzn\./i.test(it.sku)) continue // skip Amazon-managed system SKUs
                      newRows.push({
                        sku: it.sku, asin: childAsin, parent_asin, title: placeholderTitle,
                        bullet_1: '', bullet_2: '', bullet_3: '', bullet_4: '', bullet_5: '',
                        description: '', backend_keywords: '', image_count: 0, has_aplus: false,
                        content_synced_at: nowIso,
                      })
                    }
                  }
                }
                if (newRows.length > 0) {
                  const { error: insErr } = await supabase.from('listing_content').upsert(newRows, { onConflict: 'sku' } as never)
                  if (insErr) console.warn('[ai-recommendations] child backfill upsert failed:', insErr.message)
                  else console.log(`[ai-recommendations] child backfill: created ${newRows.length} missing variation row(s) for parent ${parent_asin} (${missingAsins.length} childAsins had no row)`)
                }
              } catch (be) { console.warn('[ai-recommendations] child backfill skipped (non-fatal):', be instanceof Error ? be.message : be) }
            }

            // Re-query once if EITHER re-attach or backfill changed the family.
            if (movable.length > 0 || missingAsins.length > 0) {
              const retry = await supabase
                .from('listing_content')
                .select(contentCols)
                .eq('parent_asin', parent_asin)
                .order('sku', { ascending: true })
              childrenRaw = retry.data; error = retry.error
            }
          }
        }
      } catch (e) { console.warn('[ai-recommendations] self-heal failed (continuing with 404):', e) }
    }

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
    // select('*'), NOT a column list: audience_lean (migration 029) may not exist yet, and a
    // missing column in an explicit select errors the WHOLE query — losing product_title
    // (the canonical title that anchors design-name extraction). '*' is pre/post-migration safe.
    const { data: pipelineScoreRowRaw } = await supabase
      .from('listing_seo_scores')
      .select('*')
      .eq('parent_asin', parent_asin)
      .single()
    const pipelineScoreRow = pipelineScoreRowRaw as { top_child_asin?: string | null; product_title?: string | null; audience_lean?: string | null; design_name_override?: string | null } | null
    const analysisAsin = pipelineScoreRow?.top_child_asin || children[0]?.asin
    // 150, not 50: opportunityScore is gap-amplified, so right after the seller PUSHES
    // keywords the covered terms collapse to raw/3 and sink BELOW the top-50 cut — the
    // next regen then never even saw the listing's best (now-covered) terms. The pipeline's
    // own pools slice and byte-cap downstream; passing the full stored universe costs nothing.
    const analysis = (await getStoredAnalysis(analysisAsin, 150)) ?? []

    // ── #79 per-section regen: load the STORED recommendation — its title/bullets anchor the
    // partial run (bullets regenerate against the already-approved title). Row missing or
    // priors absent → fall back to a FULL regen so the seller always gets a result.
    let storedRec: Record<string, unknown> | null = null
    let onlySection: 'title' | 'bullets' | 'description' | 'keywords' | undefined
    if (['title', 'bullets', 'description', 'keywords'].includes(regenerate_section ?? '')) {
      const { data: recRow } = await supabase
        .from('listing_seo_recommendations')
        .select('*')
        .eq('parent_asin', parent_asin)
        .single()
      storedRec = recRow as Record<string, unknown> | null
      const priorTitle = String(storedRec?.recommended_title ?? '')
      const priorBullets = Array.isArray(storedRec?.recommended_bullets) ? (storedRec?.recommended_bullets as string[]) : []
      const usable = !!storedRec && !!priorTitle &&
        (regenerate_section === 'title' || regenerate_section === 'bullets' || priorBullets.length > 0)
      if (usable) {
        onlySection = regenerate_section as typeof onlySection
        console.log(`[ai-recommendations] #79 partial regen: ${regenerate_section} only for ${parent_asin}`)
      } else {
        console.log(`[ai-recommendations] #79 partial regen requested but no usable stored row — falling back to FULL regen for ${parent_asin}`)
      }
    }
    // Outcome loop (#89): per-keyword SQP share rose/flat/fell since the last monthly snapshot — a conservative
    // tiebreak for title-candidate selection. Best-effort: {} (no-op) until ~2 months of history accrue or if
    // the keyword_share_snapshots table isn't migrated yet.
    const outcomeSignals = await computeOutcomeSignals(analysisAsin, supabase).catch(() => ({}))

    // Build the child list for the pipeline (color/size parsed from SKU)
    const pipelineChildren = children.map((c: ChildRow) => {
      const color = extractColor(c.sku, c.title || '')
      const skuParts = c.sku.split('-')
      const size = skuParts.length >= 3 ? skuParts[2] : null
      // title is threaded through so the pipeline can read each child's current capacity
      // (e.g. "...128GB...") for per-child capacity titles on storage-variation families.
      return { sku: c.sku, asin: c.asin, color: color || null, size: size || null, title: c.title || null }
    })

    // ── GROUND-TRUTH PRODUCT TYPE + dynamic detail menu (fetched BEFORE the pipeline) ─────────
    // The live SP-API productType (SHIRT, SELF_STICK_NOTE, …) decides apparel-vs-not framing for
    // every agent — the old hardcoded "Clothing…" category below made looksApparel treat EVERY
    // product as apparel (sticky notes titled "…T-Shirt, Graphic Tee for Men and Women"). The
    // schema attribute menu makes Product-Detail recommendations come from what THIS category
    // actually accepts (PO: "dynamic per product category"). Best-effort: null/[] on any SP-API
    // failure keeps the legacy text heuristic + example list.
    let ptType: string | null = null
    let ptOpts: { token: string; sellerId: string; marketplaceId: string; endpoint: string } | null = null
    let detailMenu: { key: string; title: string; accepted?: string[] }[] = []
    try {
      const { getProductType } = await import('@/lib/amazon/productType')
      const { getAccessToken } = await import('@/lib/amazon/auth')
      const { listPushableSchemaAttributes } = await import('@/lib/fba/productTypeDefinitions')
      const ptToken = await getAccessToken()
      ptOpts = {
        token: ptToken,
        sellerId: await getSellerId(),
        marketplaceId: process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER',
        endpoint: process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com',
      }
      ptType = children[0]?.sku ? await getProductType(ptOpts.sellerId, ptToken, children[0].sku) : null
      detailMenu = await listPushableSchemaAttributes(ptType, ptOpts)
    } catch (e) {
      console.warn('[ai-recommendations] productType/menu resolution failed (non-fatal):', e instanceof Error ? e.message : e)
    }
    // Truthful prompt category from the real productType ("Self Stick Note") — the hardcoded
    // clothing path is only the legacy fallback when the PT lookup fails.
    const ptCategory = ptType ? ptType.toLowerCase().replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null

    const openai = await getOpenAI()
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

          // ── Vision: read the DESIGN off the product image (GROUND TRUTH) ─────────────────────
          // The artwork printed on the product names the design far more reliably than a keyword-
          // stuffed title (a "Later Gator" tee whose title leads "See You Later Alligator"). We pass
          // the SELLER's OpenAI client so the vision call is actually authenticated — the env key is
          // unset in prod, so `new OpenAI()` inside the scanner used to silently fail and leave
          // product_identity empty. Non-fatal: a miss just falls back to title-based extraction.
          let visionDesign: { designTheme: string; visualElements: string[]; seedKeywords: string[] } | null = null
          try {
            emit({ type: 'progress', message: 'Reading the product design off the image...' })
            const imageUrl = await getProductImageUrl(parent_asin)
            const identity = imageUrl ? await scanProductImage(parent_asin, imageUrl, { openai }) : null
            if (identity) {
              visionDesign = {
                designTheme: identity.designTheme || '',
                visualElements: Array.isArray(identity.visualElements) ? identity.visualElements : [],
                seedKeywords: Array.isArray(identity.seedKeywords) ? identity.seedKeywords : [],
              }
              console.log(`[ai-recommendations] vision design for ${parent_asin}: theme="${visionDesign.designTheme}" seeds=[${visionDesign.seedKeywords.join(', ')}]`)
            } else {
              console.log(`[ai-recommendations] no vision identity for ${parent_asin} (no image or scan miss) — falling back to title extraction`)
            }
          } catch (err) {
            console.warn('[ai-recommendations] vision scan failed (non-fatal):', err)
          }

          const result = await runListingPipeline({
            openai,
            brandName,
            category: ptCategory ?? inputJson.category,
            productType: ptType,
            detailAttributeMenu: detailMenu,
            analysis,
            children: pipelineChildren,
            repTitle: rep.title,
            // Canonical title (best-seller's product_title) for design-name extraction — rep.title is
            // the alphabetically-first variant and often does NOT lead with the design name.
            canonicalTitle: pipelineScoreRow?.product_title ?? null,
            // Seller-set design name override (migration 031). When set, extractDesignName uses
            // it VERBATIM — kills the entire "stuck design" class of bugs (LLM + heuristic +
            // vision all bypassed). Deterministic.
            designNameOverride: pipelineScoreRow?.design_name_override ?? null,
            // Seller-declared audience lean (PR #195) — persisted on the score row by the
            // listing-page selector; re-weights gendered keywords + sets the title tail.
            audienceLean: (['male', 'female', 'lean_male', 'lean_female', 'unisex'].includes(pipelineScoreRow?.audience_lean ?? '')
              ? pipelineScoreRow?.audience_lean : null) as 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null,
            // Vision-read design identity — the printed artwork is ground truth for the design name,
            // overriding a paraphrased title (PR: vision-based design recognition / Feature A).
            visionDesign,
            variantDetails,
            keywordContext,
            hasAplus: rep.has_aplus || false,
            hasBrandStory: rep.aplus_has_brand_story || false,
            auditModel: 'o4-mini',
            outcomeSignals,
            // #79 — partial run: one stage only, anchored on the stored recommendation.
            onlySection,
            priorTitle: onlySection ? String(storedRec?.recommended_title ?? '') : null,
            priorBullets: onlySection && Array.isArray(storedRec?.recommended_bullets) ? (storedRec?.recommended_bullets as string[]) : null,
            onProgress: (message) => emit({ type: 'progress', message }),
          })

          // ── #79 partial persist: update ONLY the regenerated section's columns + patch its
          // action-plan card; everything else on the stored row stays exactly as the seller
          // approved it. Skips the audit, noise-persist, enum-validation and live-score stages
          // (live content didn't change — the scores still describe it).
          if (result.regeneratedSection && storedRec) {
            emit({ type: 'progress', message: 'Saving the regenerated section…' })
            const sec = result.regeneratedSection
            const storedPlan = (storedRec.keyword_plan as { bullets?: string[]; designName?: string } | null) ?? {}
            let actionPlan = Array.isArray(storedRec.action_plan) ? [...(storedRec.action_plan as Record<string, unknown>[])] : []
            const patchItem = (match: (el: string) => boolean, content: string | string[]) => {
              actionPlan = actionPlan.map((it) => match(String(it.element ?? ''))
                ? { ...it, verdict: 'REPLACE', replacement_content: content, current_status: 'Section regenerated — review the new copy below.', notes: `Regenerated ${new Date().toISOString()} (per-section).` }
                : it)
            }
            const upd: Record<string, unknown> = { generated_at: new Date().toISOString() }
            if (sec === 'title') {
              upd.recommended_title = result.recommended_title
              if (result.per_child_titles) upd.per_child_titles = result.per_child_titles
              upd.keyword_plan = { bullets: storedPlan.bullets ?? [], designName: result.keywordPlan.designName }
              patchItem((el) => el === 'title', result.recommended_title)
            } else if (sec === 'bullets') {
              upd.recommended_bullets = result.recommended_bullets
              upd.keyword_plan = { bullets: result.keywordPlan.bullets, designName: result.keywordPlan.designName || storedPlan.designName || '' }
              result.recommended_bullets.forEach((b, i) => patchItem((el) => el === `bullet_${i + 1}`, b))
            } else if (sec === 'description') {
              upd.recommended_description = result.recommended_description
              patchItem((el) => el === 'description', result.recommended_description)
            } else {
              upd.recommended_keywords = JSON.stringify(result.per_child_keywords)
              patchItem((el) => el === 'backend_keywords', result.per_child_keywords[0]?.keywords ?? '')
            }
            upd.action_plan = actionPlan
            const { error: updErr } = await supabase
              .from('listing_seo_recommendations')
              .update(upd as never)
              .eq('parent_asin', parent_asin)
            if (updErr) {
              emit({ type: 'error', error: `Failed to save the regenerated ${sec}: ${updErr.message}` })
              controller.close()
              return
            }
            // Emit the MERGED recommendation (stored row + the new section) in the exact shape
            // the page already consumes — the client code needs zero changes.
            const merged = { ...storedRec, ...upd } as Record<string, unknown>
            const perChildKw = sec === 'keywords'
              ? result.per_child_keywords
              : (() => { try { const a = JSON.parse(String(storedRec.recommended_keywords ?? '[]')); return Array.isArray(a) ? a : [] } catch { return [] } })()
            emit({
              type: 'result',
              recommendations: {
                ...merged,
                per_child_keywords: perChildKw,
                recommended_keywords: perChildKw[0]?.keywords ?? '',
              },
              keywordIntelligenceUsed: true,
              regenerated_section: sec,
              titleDebug: result.debug,
            })
            controller.close()
            return
          }

          emit({ type: 'progress', message: 'Saving to database...' })

          // ── Stage 2 (noise filter): persist the relevance gate's drops ───────────────────────
          // The gate already removed off-product keywords (competitor brands, or a DIFFERENT
          // product like "sim card for camera" on an SD-card listing) from the rewrite. Mark those
          // same keyword_analysis rows 'IRRELEVANT' so the live score below — and every later
          // push/sync re-score — stops docking the listing for not ranking on a different product.
          // The scorer only counts CRITICAL/UPGRADE, so 'IRRELEVANT' is silently skipped: no scorer
          // change and no schema migration. Best-effort; re-evaluated on every regen.
          const noiseKw = Array.isArray(result.irrelevant_keywords) ? result.irrelevant_keywords : []
          if (noiseKw.length > 0 && analysisAsin) {
            // IMPORTANT: capture { error }. A CHECK-constraint rejection (or any PostgREST error) is
            // RETURNED here, not thrown — the first cut swallowed it and reported "Filtered N" while
            // 0 rows actually changed (action_type had a CHECK that excluded 'IRRELEVANT' until
            // migration 019). Only announce the filter when rows truly flipped, and log real errors.
            const { data: upd, error: updErr } = await supabase
              .from('keyword_analysis')
              .update({ action_type: 'IRRELEVANT' })
              .eq('asin', analysisAsin)
              .in('keyword', noiseKw)
              .select('keyword')
            if (updErr) {
              console.warn('[ai-recommendations] noise-filter persist failed (non-fatal):', updErr.message)
            } else if ((upd?.length ?? 0) > 0) {
              emit({ type: 'progress', message: `Filtered ${upd!.length} off-product keyword${upd!.length === 1 ? '' : 's'} from scoring...` })
            }
          }

          // ── VALIDATE PRODUCT DETAILS vs the live Amazon schema (E — Architecture A) ───────────
          // Coerce each pushable broadcast detail to an EXACT accepted enum member BEFORE it is stored
          // as a recommendation, so the panel shows the confirmed value (not the raw audit guess) and
          // the push works 100%. Stores is_enum/enum_valid/enum_accepted/normalized_from on the item
          // for the panel's seller-picker (Part 2b). Best-effort: any SP-API failure leaves the raw
          // value (the push VALIDATION_PREVIEW is the final backstop). productType is process-cached.
          // RUNS BEFORE the live score below so the Features count can fold in enum-invalid fields in the
          // SAME pass — otherwise the score steps DOWN on the next sync with no seller action (the
          // "scores regress when I did nothing" trust trap; adversarial-review finding).
          try {
            const pds = result.product_details_improvements
            const detailSku = children[0]?.sku
            // ptType/ptOpts were resolved ONCE before the pipeline (the same values that drove the
            // apparel branch + attribute menu) — no PT → can't validate, leave rows as-is (legacy).
            if (Array.isArray(pds) && pds.length > 0 && detailSku && ptType && ptOpts) {
              const { coerceDetailValue, attributeExistsInSchema, containerKeyFallback, resolveSpApiKeyFromTitle } = await import('@/lib/fba/productTypeDefinitions')
              const { resolveDetailAttribute } = await import('@/lib/fba/productDetailAttrs')
              const invalidDetailFields = new Set<string>()
              for (const pd of pds) {
                const row = pd as unknown as Record<string, unknown>
                const staticAttr = resolveDetailAttribute(pd.field_name)
                // Per-variant attrs (Color/Size/Capacity) are never broadcast-pushable here — mark + skip.
                if (staticAttr && staticAttr.scope !== 'broadcast') { row.attr_scope = 'per-variant'; row.pushable = false; continue }
                // Resolve the REAL spApiKey: the static map first, else a DYNAMIC schema title-match — so ANY
                // category's attributes (adhesive_type, item_package_quantity, …) become pushable, not just the
                // hardcoded apparel map (PO: "auto-map any item to the category's Features").
                let spApiKey = staticAttr?.spApiKey ?? (await resolveSpApiKeyFromTitle(ptType, pd.field_name, ptOpts))?.spApiKey ?? null
                if (!spApiKey) { row.pushable = false; continue }   // genuinely unmappable → "Manual" (seller can still set it)
                // DROP a statically-mapped attr whose key is ABSENT from THIS schema (apparel "Department" on
                // an office product) — unfillable Features gap + 400 on push. Fail-open on a schema error.
                if (!(await attributeExistsInSchema(ptType, spApiKey, ptOpts))) {
                  // CONTAINER FALLBACK before dropping: a suffixed apparel key (neck_style) that's absent
                  // reroutes to its container (neck) when THAT exists — the 8→1 detail collapse. Additive:
                  // only runs on a would-be-drop, so genuine flat-key schemas are never rerouted.
                  const container = await containerKeyFallback(ptType, spApiKey, ptOpts)
                  if (container) { spApiKey = container }
                  else { invalidDetailFields.add(pd.field_name); continue }
                }
                row.sp_api_key = spApiKey
                row.attr_scope = 'broadcast'
                row.pushable = true
                // Coerce the value against the schema enum — now ALSO for non-apparel attrs, so a wrong guess
                // like Material="Thick paper" is validated against the real enum (the accuracy fix, for free).
                const cd = await coerceDetailValue(ptType, spApiKey, pd.recommended_value, ptOpts)
                if (!cd.isEnum) continue                            // free-text — any value is accepted
                row.is_enum = true
                row.enum_valid = cd.valid
                row.enum_accepted = cd.accepted
                if (cd.valid && cd.value !== pd.recommended_value) { row.normalized_from = pd.recommended_value; pd.recommended_value = cd.value }
              }
              if (invalidDetailFields.size > 0) {
                result.product_details_improvements = pds.filter((p) => !invalidDetailFields.has(p.field_name))
              }
            }
          } catch (vErr) {
            console.warn('[AI Recs] product-detail enum validation skipped (non-fatal):', vErr instanceof Error ? vErr.message : vErr)
          }

          // ── LIVE SCORE (computed UP FRONT) — drives the issues panel AND verdict gating below ──
          // Scored on the live listing_content rows (independent of the AI rewrite). Best-effort:
          // scoring must NEVER break a generation that already produced recommendations. We need it
          // before the action-plan loop so a section that already scores MAX can be marked DONE
          // instead of a red REPLACE — that's the "Title 25/25 but still asked to ship it" bug.
          let secScore: { title: number; bullet: number; keyword: number; aplus: number; description: number; features: number } | null = null
          try {
            const { scoreListingContent, fetchScoringContext } = await import('@/lib/sync/syncListingContent')
            const scoreRows = children as unknown as Parameters<typeof scoreListingContent>[1]
            const parentOwn = scoreRows.find((r) => r.asin === parent_asin) || null
            const ctx = await fetchScoringContext(supabase, parent_asin, pipelineScoreRow?.top_child_asin || children[0]?.asin || null)
            // This regen's recommendations (incl. product_details_improvements) are persisted to
            // listing_seo_recommendations AFTER this block — so fetchScoringContext just read the
            // PREVIOUS regen's (stale) product-detail count. Override with THIS regen's fresh count.
            // MATERIALITY (#85): count only TRUE gaps (empty value OR enum-invalid), not the full proactive
            // spec-sheet length (which wrongly docked already-filled fields — the "10/12 but 8 to push"
            // confusion). The enum validation ran just above, so is_enum/enum_valid are set here — using the
            // SAME predicate as syncListingContent keeps THIS regen's score == the next sync's (no flip-flop).
            if (Array.isArray(result.product_details_improvements)) {
              const { isWriteBlockedPreLaunch } = await import('@/lib/fba/productDetailAttrs')
              const isEmpty = (v: string | null) => !v || !String(v).trim()
              // Pre-launch Item Highlights are write-BLOCKED by Amazon ("currently unsupported") —
              // not a closable gap until July 27, 2026, so it must not dock Features (mirrors sync).
              ctx.productDetailsGaps = result.product_details_improvements.filter((p) =>
                !isWriteBlockedPreLaunch(p.field_name, (p as unknown as { sp_api_key?: string }).sp_api_key) &&
                (isEmpty(p.current_value) || (p.is_enum === true && p.enum_valid === false)),
              ).length
            }
            // KeywordPlan (#92/#93): recommendations persist AFTER this block, so feed THIS regen's FRESH plan
            // into ctx directly — the scorer then docks bullets against the generator's actual target set and
            // enforces design-name cohesion off the REAL design name (parity with the next sync, which reads
            // the persisted keyword_plan column).
            if (result.keywordPlan) {
              ctx.bulletPlanKeywords = result.keywordPlan.bullets
              ctx.planDesignName = result.keywordPlan.designName
            }
            const sc = scoreListingContent(parentOwn, scoreRows, ctx)
            secScore = { title: sc.title_score, bullet: sc.bullet_score, keyword: sc.keyword_score, aplus: sc.aplus_score, description: sc.description_score, features: sc.features_score }
            await supabase.from('listing_seo_scores').update({
              title_score: sc.title_score,
              bullet_score: sc.bullet_score,
              keyword_score: sc.keyword_score,
              aplus_score: sc.aplus_score,
              description_score: sc.description_score,
              features_score: sc.features_score,
              overall_score: sc.overall_score,
              issues: sc.issues,
              child_override_count: sc.child_override_count,
            }).eq('parent_asin', parent_asin)
          } catch (scoreErr) {
            console.warn('[AI Recs] Live score (verdict gating + issues panel) failed (non-fatal):', scoreErr instanceof Error ? scoreErr.message : scoreErr)
          }

          // ── POST-PROCESS: mark items DONE when the section already scores MAX, or live matches ──
          // The pipeline FORCES verdict=REPLACE on every content element (listingPipeline.ts:1043)
          // so the copy box always renders. That's intentional, but it conflicts with the score:
          // a section the scorer just rated 25/25 must NOT show a red "REPLACE — not optimized".
          //   (1) sectionOptimal: the live section already scores MAX → DONE (copy box stays as an
          //       optional alternative). Robust after a push: pushed-optimal content re-scores MAX.
          //   (2) live-match: every child's live content already equals the recommendation → DONE.
          // Either path flips verdict to DONE so the badge/ship button/REPLACE pill all collapse.
          const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
          const everyChildMatches = (getLive: (c: ChildRow) => string, recommended: string): boolean => {
            const recNorm = norm(recommended)
            if (!recNorm || children.length === 0) return false
            return children.every((c) => norm(getLive(c)) === recNorm)
          }

          // ── 7-DAY COOLING LOCK (Convergence Stages 3-4) — a section the seller SHIPPED within the
          // last 7 days stays DONE while Amazon applies it + the listing settles/ranks. It must NOT
          // flip back to "Do Now" on a fresh score that dipped ("scores regress after I ship"). Source
          // of truth: keyword_push_log (last ACCEPTED push per field). Overridden per section via
          // regenerate_section so the seller can iterate before the window is up.
          const COOLING_MS = 7 * 24 * 60 * 60 * 1000
          const lastPushMs: Record<string, number> = {}
          try {
            const { data: pl } = await supabase.from('keyword_push_log')
              .select('field, pushed_at').eq('parent_asin', parent_asin).eq('status', 'accepted')
              .order('pushed_at', { ascending: false })   // migration 015 column is pushed_at, NOT created_at (code review caught this)
            for (const r of (pl ?? []) as { field: string | null; pushed_at: string }[]) {
              if (r.field && !(r.field in lastPushMs)) lastPushMs[r.field] = new Date(r.pushed_at).getTime()
            }
          } catch { /* best-effort — no push log → no cooling lock */ }
          const coolFieldFor = (el: string): string =>
            el === 'title' ? 'title' : el === 'description' ? 'description'
            : el === 'backend_keywords' ? 'keywords' : /^bullet_\d+$/.test(el) ? 'bullets' : ''
          const nowMs = Date.now()

          for (const item of result.action_plan as ActionPlanItem[]) {
            if (item.verdict !== 'REPLACE') continue
            // (0) COOLING LOCK: shipped within 7 days → keep DONE (settling), unless the seller asked to
            // regenerate THIS section now. This is what stops a just-pushed section from regressing to
            // "Do Now" on a fresh score that dipped while Amazon is still applying + ranking it.
            const cf = coolFieldFor(item.element)
            const pushedMs = cf ? lastPushMs[cf] : undefined
            const overridden = regenerate_section === 'all' || (!!cf && regenerate_section === cf)
            if (pushedMs && !overridden && (nowMs - pushedMs) < COOLING_MS) {
              const daysAgo = Math.max(1, Math.round((nowMs - pushedMs) / (24 * 60 * 60 * 1000)))
              const daysLeft = Math.max(1, Math.ceil((COOLING_MS - (nowMs - pushedMs)) / (24 * 60 * 60 * 1000)))
              item.verdict = 'DONE'
              item.current_status = `✓ Shipped ${daysAgo}d ago — settling (Amazon applies + ranks over ~7 days). Locked ${daysLeft}d more; use Regenerate to override.`
              item.instruction = 'No action — recently shipped. Let it settle, or click Regenerate to override the 7-day lock.'
              item.priority = 'NONE'   // a DONE (cooling-locked) item is not actionable — never keep the HIGH pill
              continue
            }
            let live = false
            if (item.element === 'title') {
              // Capacity families have per-child titles — compare each child to its own
              // recommended title rather than the broadcast one.
              if (Array.isArray(result.per_child_titles) && result.per_child_titles.length > 1) {
                const pctMap = new Map(result.per_child_titles.map((p) => [p.sku, norm(p.title)]))
                live = children.every((c) => {
                  const want = pctMap.get(c.sku)
                  return want ? norm(c.title) === want : true
                })
              } else {
                live = everyChildMatches((c) => c.title ?? '', result.recommended_title)
              }
            } else if (/^bullet_(\d+)$/.test(item.element)) {
              const n = Number(item.element.split('_')[1])
              const recBullet = result.recommended_bullets[n - 1] ?? ''
              live = everyChildMatches((c) => (c as unknown as Record<string, string | null>)[`bullet_${n}`] ?? '', recBullet)
            } else if (item.element === 'description') {
              live = everyChildMatches((c) => c.description ?? '', result.recommended_description)
            } else if (item.element === 'backend_keywords') {
              // Per-child: each SKU compares to its own per_child_keywords entry.
              const kwMap = new Map(result.per_child_keywords.map((p) => [p.sku, norm(p.keywords)]))
              live = children.length > 0 && children.every((c) => {
                const want = kwMap.get(c.sku)
                return want ? norm(c.backend_keywords) === want : true
              })
            }
            // (1) CONVERGENCE: the live section already scores STRONG (>=23/25, the seller's
            // "good enough" bar) → treat it as done and stop nagging to ship. A literal 25 isn't
            // always reachable (long-tail keywords can't all fit a 75-char title), so a strong
            // section counts as optimized. Each element gates on its OWN sub-score: title→title,
            // bullets→bullet, backend→keyword, description→description, product_details→features.
            const STRONG = 23
            let secVal: number | null = null
            if (secScore) {
              if (item.element === 'title') secVal = secScore.title
              else if (/^bullet_(\d+)$/.test(item.element)) secVal = secScore.bullet
              else if (item.element === 'backend_keywords') secVal = secScore.keyword
              else if (item.element === 'description') secVal = secScore.description
              else if (item.element === 'product_details') secVal = secScore.features
            }
            const sectionOptimal = secVal !== null && secVal >= STRONG
            // COHESION gate for BROADCAST sections: a strong score on the representative child
            // means nothing if the variants carry DIFFERENT live versions — the seller saw the
            // DESCRIPTION card say "DONE (25/25), no change needed" while the cohesion row said
            // "variants differ — unify" (the perfect-score-vs-ship contradiction, broadcast
            // edition). `live` already implies cohesion (every child matches the rec); only the
            // score path needs the guard. Backend keywords are unique-per-child — exempt.
            let distinctVersions = 0
            if (item.element === 'title') distinctVersions = new Set(children.map((c) => norm(c.title)).filter(Boolean)).size
            else if (item.element === 'description') distinctVersions = new Set(children.map((c) => norm(c.description)).filter(Boolean)).size
            else if (/^bullet_(\d+)$/.test(item.element)) {
              const n = Number(item.element.split('_')[1])
              distinctVersions = new Set(children.map((c) => norm((c as unknown as Record<string, string | null>)[`bullet_${n}`])).filter(Boolean)).size
            }
            const divergent = !live && distinctVersions > 1
            if ((live || sectionOptimal) && !divergent) {
              item.verdict = 'DONE'
              const label = item.element === 'backend_keywords' ? 'backend search terms'
                : item.element === 'description' ? 'description'
                : /^bullet_(\d+)$/.test(item.element) ? `bullet ${item.element.split('_')[1]}`
                : item.element
              item.current_status = live
                ? `✓ Live ${label} matches the recommended version across all ${children.length} variant${children.length === 1 ? '' : 's'}.`
                : `✓ Your live ${label} is already strong (${secVal}/25) — no change needed. Optimized copy is below if you want to compare.`
              item.instruction = live
                ? 'No action required — your last push wrote this exact content. The copy box stays below if you need it.'
                : 'No action required — this section is already strong. The copy box below is an optional alternative.'
              item.priority = 'NONE'   // a DONE item is not actionable — never keep the HIGH pill
            } else if (sectionOptimal && divergent) {
              // Strong but INCONSISTENT: quality isn't the problem — unity is. Same message
              // as the cohesion row, so the two surfaces agree instead of contradicting.
              item.verdict = 'REPLACE'
              item.priority = 'MEDIUM'
              item.current_status = `Strong copy (${secVal}/25) BUT your ${children.length} variants carry ${distinctVersions} different live versions — Ship once to unify them.`
              item.instruction = 'Quality is fine; consistency is the gap. Ship the recommended version below so every variant matches (one click writes all of them).'
            }
          }

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
          // per_child_titles is JSONB (migration 017) — only present for capacity variation families.
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
            per_child_titles: rec.per_child_titles ?? null,
            keyword_plan: result.keywordPlan ?? null,   // #92/#93 — read by the scorer (sync-time parity)
          }

          const { error: upsertErr } = await supabase
            .from('listing_seo_recommendations')
            .upsert(dbPayload, { onConflict: 'parent_asin' })
          if (upsertErr) {
            console.warn('[AI Recs] Full upsert failed, retrying minimal payload:', upsertErr.message)
            // The minimal payload intentionally OMITS the newer JSONB columns (incl. keyword_plan) so a
            // missing column can't break the core-recommendations save — that's the schema-missing safety net.
            await supabase.from('listing_seo_recommendations').upsert({
              parent_asin: rec.parent_asin,
              recommended_title: rec.recommended_title,
              recommended_bullets: rec.recommended_bullets,
              recommended_keywords: JSON.stringify(rec.per_child_keywords),
              recommended_description: rec.recommended_description,
              generated_at: rec.generated_at,
            }, { onConflict: 'parent_asin' })
            // Best-effort recover keyword_plan (the regen-time score was computed WITH it; if it doesn't land
            // here too, the next sync reads NULL and the score jumps with no seller action — the trust trap).
            // A column-safe UPDATE: if keyword_plan exists (full upsert failed transiently) this restores
            // regen==sync parity; if the column is MISSING (pre-migration 022) it errors harmlessly → caught,
            // and that window is closed operationally by applying migration 022 before deploy.
            try {
              await supabase.from('listing_seo_recommendations')
                .update({ keyword_plan: result.keywordPlan ?? null })
                .eq('parent_asin', rec.parent_asin)
            } catch { /* keyword_plan column absent (pre-migration) — handled by deploying migration 022 first */ }
          }

          // (Issues panel + scores were refreshed UP FRONT — see the LIVE SCORE block above.)
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

  // per_child_titles (migration 017) is JSONB. Tolerate missing column / null / non-arrays.
  const per_child_titles: { sku: string; asin: string; title: string }[] =
    Array.isArray(data.per_child_titles) ? data.per_child_titles : []

  // product_details_improvements is a blind-persisted LLM parse: values can be arrays
  // (["Water Proof","Shock Proof"]) or numbers on rows written before the pipeline
  // normalized at the write boundary. Every UI consumer .trim()s these — the B0GCF11RKL
  // page hard-crashed on exactly this — so normalize HERE too, healing ALL historical
  // rows without requiring a regen.
  const product_details_improvements = Array.isArray(data.product_details_improvements)
    ? (data.product_details_improvements as Record<string, unknown>[]).map((p) => ({
        ...p,
        field_name: detailValueToString(p.field_name),
        current_value: p.current_value == null ? null : detailValueToString(p.current_value),
        recommended_value: detailValueToString(p.recommended_value),
      }))
    : data.product_details_improvements

  // Per-field LAST-SHIPPED timestamp (PO: "see when any SEO item was shipped, for all shippable
  // items") — the most recent ACCEPTED push per field from keyword_push_log. Keys: title / bullets /
  // description / keywords, and details as `details:<spApiKey>`. Best-effort: {} on a missing/unreadable
  // table (migrations 015/016) — the card just shows no ship date, never errors.
  const field_pushed_at: Record<string, string> = {}
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: pl } = await (supabase as any)
      .from('keyword_push_log')
      .select('field, pushed_at')
      .eq('parent_asin', parent_asin)
      .eq('status', 'accepted')
      .order('pushed_at', { ascending: false })
    for (const r of (pl ?? []) as { field: string | null; pushed_at: string | null }[]) {
      if (r.field && r.pushed_at && !field_pushed_at[r.field]) field_pushed_at[r.field] = r.pushed_at
    }
  } catch { /* log table absent/unreadable — no ship dates, non-fatal */ }

  return NextResponse.json({
    recommendations: {
      ...data,
      per_child_keywords,
      per_child_titles,
      keyword_reconciliation,
      action_plan,
      product_details_improvements,
      field_pushed_at,
      // Keep recommended_keywords as the first child's keywords for backward compat
      recommended_keywords: per_child_keywords.length > 0
        ? per_child_keywords[0].keywords
        : data.recommended_keywords || '',
    },
  })
}
