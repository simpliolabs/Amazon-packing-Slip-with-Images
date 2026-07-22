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
import { detailValueToString, isItemHighlightsField, capItemHighlightRepeats } from '@/lib/fba/productDetailAttrs'
import { BACKEND_DEGRADE_STRICT_ON, tryParsePriorKeywords } from '@/lib/fba/backendDegradeGate'
import { scanProductImage, getProductImageUrl } from '@/lib/keyword-engine/visionScanner'
import { isOffNicheKeyword } from '@/lib/keyword-engine/nicheGuards'
import { scrubTrademarks, scrubTrademarksArr, scrubTrademarksDeep } from '@/lib/fba/trademarkGuard'
import { deriveActionPlan, type DeriveContentRow } from '@/lib/fba/pushFields'
import { decodeSkuColor } from '@/lib/fba/skuColorCodes'

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
  const { instrumentAiHealth } = await import('@/lib/openai/errorClass')
  const apiKey = await resolveOpenAIKey()
  // instrumentAiHealth (2026-07-08): records the first HARD error (quota/auth) on the client and
  // rethrows — the pipeline's fail-open catches keep working, but the identity survives so the
  // degradation gate + the stream catch can say "credit exhausted" instead of silently persisting
  // empty content as success. Per-request client: the flag lives exactly one POST.
  return instrumentAiHealth(new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  }))
}

/** Best-effort site-wide AI-health record (migration 045, single row id=1). Written DOWN on a hard
 *  (quota/auth) failure, OK on the next healthy run — the fba layout's AiHealthBanner polls it so
 *  the operator sees "AI is down — check billing" on EVERY page, not just the one that failed.
 *  Never throws: a missing table (pre-migration) must not break a regen. */
async function recordAiHealth(status: 'ok' | 'down', kind?: string, message?: string): Promise<void> {
  try {
    const admin = getAdminSupabase()
    // occurred_at marks the OUTAGE START: only stamp it on the ok→down transition, so a 5-hour
    // outage's banner reads "since 9:00 AM", not the time of the latest failed retry.
    let alreadyDown = false
    if (status === 'down') {
      const { data } = await admin.from('ai_health').select('status').eq('id', 1).maybeSingle()
      alreadyDown = (data as { status?: string } | null)?.status === 'down'
    }
    await admin.from('ai_health').upsert({
      id: 1,
      status,
      kind: status === 'down' ? (kind ?? null) : null,
      message: status === 'down' ? (message ?? null) : null,
      ...(status === 'down' && !alreadyDown ? { occurred_at: new Date().toISOString() } : {}),
      ...(status === 'ok' ? { cleared_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })
  } catch { /* table absent (apply migration 045) or transient DB error — health signal is best-effort */ }
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
  /** 'manual' = seller's own pushed title, LOCKED against whole-listing regens (migration 044). */
  title_source?: string
  recommended_bullets: string[]
  recommended_keywords: string
  per_child_keywords: PerChildKeywords[]
  per_child_titles?: { sku: string; asin: string; title: string }[]
  per_child_bullets?: { sku: string; asin: string; bullets: string[] }[]
  per_child_descriptions?: { sku: string; asin: string; description: string }[]
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

  // OFF-NICHE guard (Invariant 1 — same predicate as the scorer + rank panel): wrong-niche keywords
  // (competitor blanks, wholesale, activewear, foreign-language, non-apparel goods, golf pegs) must
  // NEVER be fed to the generator as "CRITICAL — you MUST include", which produced actively harmful
  // advice ("weave in 'usher and chris brown shirt'") on a graphic-tee listing. Apparel-gated via the
  // live child copy; the listing's OWN brand / genuine activewear survive via the context.
  const nicheCtx = children
    .map((c) => [c.title, c.bullet_1, c.bullet_2, c.bullet_3, c.bullet_4, c.bullet_5, c.backend_keywords].filter(Boolean).join(' '))
    .join(' ')
  if (/\b(?:t-?shirts?|tshirts?|shirts?|hoodies?|sweatshirts?|apparel)\b/i.test(nicheCtx)) {
    analysis = analysis.filter((k) => !isOffNicheKeyword(k.keyword, { context: nicheCtx }))
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

RULE 2 — BULLETS (natural fit only):
Weave a CRITICAL or UPGRADE keyword into bullets 1-3 ONLY when it reads naturally in the sentence — bullets are written for the shopper, not the crawler, so never force a keyword to hit a count. Every CRITICAL/UPGRADE keyword that does not fit naturally in the title or a bullet goes to BACKEND keywords (RULE 3) — the backend is the sanctioned home for keyword coverage and Amazon indexes it identically. Keywords that DO appear in a bullet go in the body text, NOT in the ALL CAPS benefit hook.

RULE 3 — BACKEND KEYWORDS (everything else):
All remaining keywords that did not fit naturally into title or bullets go here. Also include: synonyms, common misspellings, occasion terms, audience terms, and long-tail variants not already in title/bullets.

RULE 4 — READABILITY IS NON-NEGOTIABLE:
Keywords must flow naturally in the copy. If a keyword cannot be used without making the text awkward, push it to backend keywords. Stuffed-sounding copy hurts conversion rate, which hurts ranking.

RULE 5 — DO NOT DUPLICATE:
Never repeat the same keyword in both title AND backend keywords. Amazon indexes title and bullet words automatically — duplicating them in backend wastes bytes.

RULE 6 — ACCOUNT FOR EVERY KEYWORD:
Every CRITICAL and UPGRADE keyword must appear somewhere: in the title, in the backend keywords, or naturally in the prose (a bullet or the description). Backend is the default home — reach for a bullet only when the keyword fits the prose naturally. The keyword reconciliation report must prove placement for each one, and placed_in must name where the keyword ACTUALLY lands (do not claim a bullet you did not write). If a keyword was intentionally excluded, state why.`

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
        // Shared with the catalog-wide cron (cron-complete-children) so the two reconcile paths
        // never drift — see src/lib/fba/familyReconcile.ts. Best-effort: a failure here falls
        // through to the 404 below, never blocks a regen.
        const { reconcileFamilyChildren } = await import('@/lib/fba/familyReconcile')
        const placeholderTitle = (childrenRaw?.[0] as { title?: string } | undefined)?.title ?? ''
        const rec = await reconcileFamilyChildren(parent_asin, supabase, { placeholderTitle })
        if (rec.reattached > 0) console.log(`[ai-recommendations] self-heal: re-attached ${rec.reattached} child SKU(s) to parent ${parent_asin}`)
        if (rec.backfilled > 0) console.log(`[ai-recommendations] child backfill: created ${rec.backfilled} missing variation row(s) for parent ${parent_asin} (${rec.missingAsins} childAsins had no row)`)
        // Re-query once if EITHER re-attach or backfill changed the family.
        if (rec.reattached > 0 || rec.backfilled > 0) {
          const retry = await supabase
            .from('listing_content')
            .select(contentCols)
            .eq('parent_asin', parent_asin)
            .order('sku', { ascending: true })
          childrenRaw = retry.data; error = retry.error
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

    // Build the per-child keyword slots instruction.
    // Color from SKU via the SHARED decoder (2026-07-09): the old inline version only stripped a
    // trailing "-FBA" — on an all-FBM family every child returned the literal "FBM" as its color,
    // 13 real colors collapsed into one, and the tail LLM hallucinated a shared "burgundy maroon
    // wine" palette for all 91 children (B0FRYMM56C, PO-caught). decodeSkuColor strips FBA|FBM,
    // decodes the code (BAY→Bay, CRI→Crimson, MUS→Mustard), falls back to the child's own title
    // segment, and returns NULL for unknown — never a shared junk bucket.
    const extractColor = (sku: string, title: string): string => decodeSkuColor(sku, title) ?? ''

    // V2: Auto-sync keyword intelligence if empty (self-healing)
    // This ensures Regenerate AI Audit works even if keyword cache was cleared
    const { data: existingKws } = await supabase
      .from('keyword_analysis')
      .select('id')
      .eq('asin', (await supabase.from('listing_seo_scores').select('top_child_asin').eq('parent_asin', parent_asin).single()).data?.top_child_asin || children[0]?.asin)
      .limit(1)
    
    // Reference-signal fingerprint (H follow-up): force a keyword RE-RESEARCH when the seller's
    // competitor / design name changed since the universe was last built. Otherwise a plain Regenerate
    // keeps serving the stale, off-niche pool for a listing whose design/competitor were entered AFTER
    // the last research (the B0DMXMH266 "0 fishing keywords" case) — selectSeeds reads the design name
    // and researchKeywords force-harvests the competitor from the DB, so a forced re-research picks both
    // up. The fingerprint (stored on the score row) prevents re-researching on every regen.
    const { data: scoreRow2 } = await supabase
      .from('listing_seo_scores')
      .select('top_child_asin, competitor_asin, design_name_override')
      .eq('parent_asin', parent_asin)
      .single()
    const syncAsin = scoreRow2?.top_child_asin || children[0]?.asin
    const competitorAsin = (scoreRow2 as { competitor_asin?: string | null } | null)?.competitor_asin || ''
    const designNameOv = (scoreRow2 as { design_name_override?: string | null } | null)?.design_name_override || ''
    // VISION SIGNAL (2026-07-18): a fresh design scan writes product_identity but does NOT move the
    // competitor/design-name fingerprint, so a warm listing's plain Regenerate never re-researched and the
    // vision niche never reached the universe (the recurring "vision not feeding universe" regression — the
    // wire in researchKeywords sits AFTER the research cache, so it only runs when research actually re-runs).
    // Fold a compact vision signature into the fingerprint so a new/changed scan forces ONE re-research
    // (which runs the vision→universe wire) then re-stamps. Fail-open: no identity row → '' → no extra thrash.
    let visionSig = ''
    for (const a of [syncAsin, parent_asin]) {
      if (!a || visionSig) continue
      try {
        const { data: viRow } = await supabase.from('product_identity').select('identity_data').eq('asin', a).maybeSingle()
        const vi = (viRow as { identity_data?: { designTheme?: string; suggestedSearchTerms?: string[] } } | null)?.identity_data
        if (vi) visionSig = `${(vi.designTheme || '').trim().toLowerCase()}#${(vi.suggestedSearchTerms || []).slice(0, 3).join(',').toLowerCase()}`.slice(0, 120)
      } catch { /* product_identity may not exist for this asin */ }
    }
    const refFingerprint = `${competitorAsin}|${designNameOv}|${visionSig}`
    // Read the fingerprint defensively — the column may not exist pre-migration; if so, disable the
    // signal-change trigger entirely (no thrash) and fall back to the empty-only gate.
    let fingerprintColumnExists = true
    let storedFingerprint = ''
    try {
      const { data: fpRow, error: fpErr } = await supabase
        .from('listing_seo_scores').select('kw_ref_fingerprint').eq('parent_asin', parent_asin).single()
      if (fpErr) fingerprintColumnExists = false
      else storedFingerprint = (fpRow as { kw_ref_fingerprint?: string | null } | null)?.kw_ref_fingerprint ?? ''
    } catch { fingerprintColumnExists = false }
    const signalChanged = fingerprintColumnExists && !!(competitorAsin || designNameOv || visionSig) && refFingerprint !== storedFingerprint

    if (!existingKws || existingKws.length === 0 || signalChanged) {
      // Empty OR a changed reference signal — (re-)research now, before AI generation.
      try {
        if (syncAsin) {
          const { syncKeywordIntelligence } = await import('@/lib/sync/syncKeywordIntelligence')
          await syncKeywordIntelligence(syncAsin, {
            includeJungleScout: true,
            forceRefresh: signalChanged,   // a changed signal must RE-research, not return the stale universe
            parentAsin: parent_asin,
            listingTitle: children[0]?.title || undefined,
          })
          // Stamp the signals this universe was built with so the next regen doesn't re-research needlessly.
          if (fingerprintColumnExists) {
            await supabase.from('listing_seo_scores').update({ kw_ref_fingerprint: refFingerprint } as never).eq('parent_asin', parent_asin)
          }
          console.log(`[ai-recommendations] Keyword intelligence synced for ${syncAsin} (forceRefresh=${signalChanged}, fp=${refFingerprint})`)
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
          let visionDesign: { designTheme: string; visualElements: string[]; seedKeywords: string[]; suggestedSearchTerms?: string[] } | null = null
          try {
            emit({ type: 'progress', message: 'Reading the product design off the image...' })
            const imageUrl = await getProductImageUrl(parent_asin)
            const identity = imageUrl ? await scanProductImage(parent_asin, imageUrl, { openai }) : null
            if (identity) {
              visionDesign = {
                designTheme: identity.designTheme || '',
                visualElements: Array.isArray(identity.visualElements) ? identity.visualElements : [],
                seedKeywords: Array.isArray(identity.seedKeywords) ? identity.seedKeywords : [],
                // Forward suggestedSearchTerms too (2026-07-18): deriveNicheSeeds keys the seed-pool
                // universes on these, so the backend fill can pull the UNIVERSAL pool for single-design.
                suggestedSearchTerms: Array.isArray(identity.suggestedSearchTerms) ? identity.suggestedSearchTerms : [],
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
            // Per-design seller name overrides (migration 034, {designKey: name}). Rides the
            // existing '*' select; the multi-design group loop applies the per-key value ABOVE the
            // Amazon Color attribute. undefined (NULL/absent column) → no per-design seeding.
            designNameOverridesByKey: (pipelineScoreRow as { design_name_overrides?: Record<string, string> | null })?.design_name_overrides || undefined,
            isMultiDesignOverride: (pipelineScoreRow as { is_multi_design_override?: boolean | null })?.is_multi_design_override ?? null,
            // Seller-named #1 competitor (title-council fallback chain Part 1): the multi-design
            // parent title studies this listing's live SEO snapshot for keyword strategy/structure.
            // Rides the '*' select — cast like the other maybe-missing columns above.
            competitorAsin: (pipelineScoreRow as { competitor_asin?: string | null } | null)?.competitor_asin ?? null,
            competitorBrand: (pipelineScoreRow as { competitor_brand?: string | null } | null)?.competitor_brand ?? null,
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
            // Multi-design partial coherence (parity-audit): stored per-child titles let the pipeline
            // rebuild the design groups cheaply, so per-design fan-outs run on partial regens too.
            priorPerChildTitles: onlySection && Array.isArray(storedRec?.per_child_titles)
              ? (storedRec?.per_child_titles as { sku: string; asin: string; title: string; designName?: string; designKey?: string }[])
              : null,
            priorCoupleConcept: onlySection ? ((storedRec?.keyword_plan as { coupleConcept?: string } | null)?.coupleConcept ?? null) : null,
            onProgress: (message) => emit({ type: 'progress', message }),
          })

          // ── #79 partial persist: update ONLY the regenerated section's columns + patch its
          // action-plan card; everything else on the stored row stays exactly as the seller
          // approved it. Skips the audit, noise-persist, enum-validation and live-score stages
          // (live content didn't change — the scores still describe it).
          if (result.regeneratedSection && storedRec) {
            emit({ type: 'progress', message: 'Saving the regenerated section…' })
            const sec = result.regeneratedSection
            const storedPlan = (storedRec.keyword_plan as { bullets?: string[]; designName?: string; coupleConcept?: string } | null) ?? {}
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
              upd.keyword_plan = { bullets: storedPlan.bullets ?? [], designName: result.keywordPlan.designName, coupleConcept: result.keywordPlan.coupleConcept ?? storedPlan.coupleConcept }
              patchItem((el) => el === 'title', result.recommended_title)
            } else if (sec === 'bullets') {
              upd.recommended_bullets = result.recommended_bullets
              // Multi-design coherence (parity-audit #3/#23): the per-design sets regenerate on
              // partials now — persist them, or the push keeps preferring the stale stored ones.
              if (result.per_child_bullets) upd.per_child_bullets = result.per_child_bullets
              upd.keyword_plan = { bullets: result.keywordPlan.bullets, designName: result.keywordPlan.designName || storedPlan.designName || '', coupleConcept: result.keywordPlan.coupleConcept ?? storedPlan.coupleConcept, perDesign: result.keywordPlan.perDesign }
              result.recommended_bullets.forEach((b, i) => patchItem((el) => el === `bullet_${i + 1}`, b))
            } else if (sec === 'description') {
              upd.recommended_description = result.recommended_description
              if (result.per_child_descriptions) upd.per_child_descriptions = result.per_child_descriptions
              patchItem((el) => el === 'description', result.recommended_description)
            } else {
              // BACKEND_DEGRADE_STRICT (Task #103, 2026-07-22): the partial keywords section-regen
              // path had NO degradedSections+preserve check — the dual-write-path invariant break
              // ([[ai-recommendations-dual-write-path]]) that let B0H9VDCBZJ's 70B garbage-floor
              // regen persist over the prior 207B. Full path has the block at ~:1246; partial had
              // none. Under strict mode: if the pipeline flagged degradedSections (or, under strict,
              // it threw and we never reach here — so flagged means legacy off/shadow mode), AND a
              // valid prior is parseable, preserve the prior instead of persisting the new degraded
              // per_child_keywords. Under off/shadow: no preserve — this preserves the missing-
              // feature legacy behavior, so the flag rollout is completely reversible.
              const partialDegraded = (result as { degradedSections?: string[] }).degradedSections?.includes('backend_keywords')
              const partialPriorKw = storedRec ? (storedRec.recommended_keywords as string | null) : null
              const partialPrior = (BACKEND_DEGRADE_STRICT_ON && partialDegraded)
                ? tryParsePriorKeywords(partialPriorKw)
                : null
              if (partialPrior) {
                upd.recommended_keywords = JSON.stringify(partialPrior)
                patchItem((el) => el === 'backend_keywords', partialPrior[0]?.keywords ?? '')
                console.warn(`[ai-recommendations] partial keywords regen degraded for ${parent_asin} — preserved the stored set instead of persisting the degraded one`)
              } else {
                upd.recommended_keywords = JSON.stringify(result.per_child_keywords)
                patchItem((el) => el === 'backend_keywords', result.per_child_keywords[0]?.keywords ?? '')
              }
            }
            upd.action_plan = actionPlan
            let { error: updErr } = await supabase
              .from('listing_seo_recommendations')
              .update(upd as never)
              .eq('parent_asin', parent_asin)
            if (updErr && ('per_child_bullets' in upd || 'per_child_descriptions' in upd)) {
              // Missing-column degradation (review; mirrors the full path): a pre-migration-033 DB
              // must not lose the whole regenerated section over the per-design columns — retry
              // without them and log loudly (the broadcast section + keyword_plan still save).
              console.error(`[ai-recommendations] partial ${sec} save failed (${updErr.message}) — retrying without per-design columns`)
              delete (upd as Record<string, unknown>).per_child_bullets
              delete (upd as Record<string, unknown>).per_child_descriptions
              ;({ error: updErr } = await supabase
                .from('listing_seo_recommendations')
                .update(upd as never)
                .eq('parent_asin', parent_asin))
            }
            if (updErr) {
              emit({ type: 'error', kind: 'transient', error: `Failed to save the regenerated ${sec}: ${updErr.message}` })
              controller.close()
              return
            }
            // MANUAL-TITLE LOCK (044): an explicit "Regenerate title" is the seller ASKING for a fresh AI
            // title, so it must CLEAR the lock — otherwise the next whole-audit would preserve this AI
            // title as if the seller had typed it, and the "✏️ locked" badge would stick forever. This is
            // the ONLY unlock path (a locked listing always has a stored row, so a title regen always
            // routes through THIS partial branch, never the full-path guard). Best-effort separate write
            // so a lagging migration 044 can't fail the section save; reflected in the merged emit below.
            if (sec === 'title' && (storedRec as { title_source?: string }).title_source === 'manual') {
              const { error: tsErr } = await supabase.from('listing_seo_recommendations').update({ title_source: 'ai' }).eq('parent_asin', parent_asin)
              if (!tsErr) (storedRec as Record<string, unknown>).title_source = 'ai'
            }
            // Emit the MERGED recommendation (stored row + the new section) in the exact shape
            // the page already consumes — the client code needs zero changes.
            const merged = { ...storedRec, ...upd } as Record<string, unknown>
            const perChildKw = sec === 'keywords'
              ? result.per_child_keywords
              : (() => { try { const a = JSON.parse(String(storedRec.recommended_keywords ?? '[]')); return Array.isArray(a) ? a : [] } catch { return [] } })()
            // SHIP-TRUTH DERIVATION (2026-07-09): the emitted plan is derived live, same as the GET —
            // dual-write-path rule: any serve-time invariant runs on BOTH the full and partial paths.
            // A just-regenerated section correctly derives REPLACE (rec ≠ cache — not shipped yet).
            let mergedPlan = (Array.isArray(merged.action_plan) ? merged.action_plan : []) as unknown as ActionPlanItem[]
            try {
              mergedPlan = deriveActionPlan(
                { ...(merged as Record<string, unknown>), recommended_keywords: JSON.stringify(perChildKw) } as never,
                children as unknown as DeriveContentRow[],
              ) as unknown as ActionPlanItem[]
            } catch (e) { console.warn('[ai-recommendations] partial derive failed — emitting stored plan:', e instanceof Error ? e.message : e) }
            emit({
              type: 'result',
              recommendations: {
                ...merged,
                action_plan: mergedPlan,
                per_child_keywords: perChildKw,
                recommended_keywords: perChildKw[0]?.keywords ?? '',
              },
              keywordIntelligenceUsed: true,
              regenerated_section: sec,
              titleDebug: result.debug,
            })
            // AI-health bookkeeping (2026-07-08): a hard error that DIDN'T blank this section (e.g. an
            // enrichment call 429'd while the core call survived) still means the account is degraded —
            // warn + record so the next run's failure isn't a surprise. Healthy run self-heals the banner.
            const hardP = (openai as { __aiHardError?: string }).__aiHardError
            if (hardP) {
              emit({ type: 'warning', kind: hardP, message: hardP === 'quota' ? 'Part of this run hit an OpenAI credit limit (insufficient_quota) — the saved section is healthy, but add credit before the next regen.' : 'Part of this run hit an OpenAI auth error — the saved section is healthy, but check the API key in Settings.' })
              // AWAITED (fire-and-forget lesson): a detached write racing controller.close() can be lost.
              await recordAiHealth('down', hardP, 'Hard OpenAI error during a partial regen (section saved healthy).')
            } else {
              await recordAiHealth('ok')
            }
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
              // MULTI-DESIGN name-slot guard (parity-audit 2026-07-03): on a multi-design family,
              // style_name/color_name IS the per-design name storage (the pipeline's own design-name
              // resolver reads color → style_name → color_name). A broadcast push of "Style Name"
              // would clobber EVERY design's stored name with one value and poison the next regen's
              // per-design anchors — force those attrs per-variant/unpushable for these families.
              const familyMultiDesign = (result.debug as { multiDesign?: boolean } | undefined)?.multiDesign === true
              const DESIGN_NAME_SLOT_KEYS = new Set(['style_name', 'color_name', 'style', 'color'])
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
                if (familyMultiDesign && DESIGN_NAME_SLOT_KEYS.has(spApiKey)) {
                  row.sp_api_key = spApiKey
                  row.attr_scope = 'per-variant'
                  row.pushable = false
                  continue
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
            const { pickRescoreRepresentative } = await import('@/lib/fba/rescoreRepresentative')
            const scoreRows = children as unknown as Parameters<typeof scoreListingContent>[1]
            // 6th re-score site (review): route through the single representative helper for parity
            // with the 3 push + 2 sync sites, or a regen scored off the stale self-parented row would
            // overwrite (revert) the fresh post-push score in the same listing_seo_scores row.
            const { representative, scoredRows } = pickRescoreRepresentative(scoreRows as { asin?: unknown }[], parent_asin, pipelineScoreRow?.top_child_asin || children[0]?.asin || null)
            const ctx = await fetchScoringContext(supabase, parent_asin, pipelineScoreRow?.top_child_asin || children[0]?.asin || null)
            // This regen's recommendations (incl. product_details_improvements) are persisted to
            // listing_seo_recommendations AFTER this block — so fetchScoringContext just read the
            // PREVIOUS regen's (stale) product-detail count. Override with THIS regen's fresh count.
            // MATERIALITY (#85): count only TRUE gaps (empty value OR enum-invalid), not the full proactive
            // spec-sheet length (which wrongly docked already-filled fields — the "10/12 but 8 to push"
            // confusion). The enum validation ran just above, so is_enum/enum_valid are set here — using the
            // SAME predicate as syncListingContent keeps THIS regen's score == the next sync's (no flip-flop).
            if (Array.isArray(result.product_details_improvements)) {
              const { isWriteBlockedPreLaunch, getItemHighlightsApiState } = await import('@/lib/fba/productDetailAttrs')
              // Read the SAME app_settings probe flag the next sync will read, so THIS regen's Features
              // score == the next sync's (the #85 no-flip-flop invariant — both consult one source).
              const ihState = await getItemHighlightsApiState(supabase)
              const isEmpty = (v: string | null) => !v || !String(v).trim()
              // Item Highlights stay write-BLOCKED by Amazon ("currently unsupported") until the probe
              // flips the flag — not a closable gap, so they must not dock Features (mirrors sync).
              ctx.productDetailsGaps = result.product_details_improvements.filter((p) =>
                !isWriteBlockedPreLaunch(p.field_name, (p as unknown as { sp_api_key?: string }).sp_api_key, new Date(), { apiSupported: ihState?.supported ?? null }) &&
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
            const sc = scoreListingContent(representative as never, scoredRows as never, ctx)
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

          // ── COOLING LOCK (Convergence Stages 3-4) — a section the seller SHIPPED stays DONE while
          // Amazon applies it + the listing settles/ranks, so it does NOT flip back to "Do Now" on a
          // fresh score that dipped ("scores regress after I ship"). Source of truth: keyword_push_log
          // (last ACCEPTED push per field). Overridden per section via regenerate_section.
          //
          // RECONCILE (spec Risk R-UX2 / Phase C): the fixed 7-day constant is REPLACED by the SAME
          // data-readiness gate the outcome cron uses — the lock holds while listing_outcome_state is
          // still 'measuring' (the gate of >=2 post-epoch same-fingerprint SQP snapshots has not opened
          // yet), and RELEASES once a terminal verdict exists. Critically, when the cron returns
          // 'headroom_rewrite' (more copy CAN help) the lock must release so the triggering field is
          // NOT shown cooling-DONE (the spec's acceptance test). This is detail-page-only; the
          // parent-grain lifecycle owns the tab/queue truth. The 7-day value is kept ONLY as a hard
          // FALLBACK cap for the pre-outcome window before any snapshot exists, so the two never use
          // different clocks once measurement data lands.
          const COOLING_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000
          const lastPushMs: Record<string, number> = {}
          try {
            const { data: pl } = await supabase.from('keyword_push_log')
              .select('field, pushed_at').eq('parent_asin', parent_asin).eq('status', 'accepted')
              .order('pushed_at', { ascending: false })   // migration 015 column is pushed_at, NOT created_at (code review caught this)
            for (const r of (pl ?? []) as { field: string | null; pushed_at: string }[]) {
              if (r.field && !(r.field in lastPushMs)) lastPushMs[r.field] = new Date(r.pushed_at).getTime()
            }
          } catch { /* best-effort — no push log → no cooling lock */ }
          // Read the outcome ledger ONCE — the readiness gate that replaces the fixed timer.
          let outcomeVerdict: string | null = null
          try {
            const { data: os } = await supabase.from('listing_outcome_state')
              .select('outcome_verdict').eq('listing_key', parent_asin).maybeSingle()
            outcomeVerdict = (os as { outcome_verdict: string | null } | null)?.outcome_verdict ?? null
          } catch { /* best-effort — ledger absent (pre-039) → fall back to the timer cap */ }
          // The gate is OPEN (release the lock) once the cron has reached any TERMINAL verdict; it is
          // CLOSED (hold the lock) while 'measuring' or while no ledger row exists yet (still settling).
          const measurementOpen = outcomeVerdict != null && outcomeVerdict !== 'measuring'
          const coolFieldFor = (el: string): string =>
            el === 'title' ? 'title' : el === 'description' ? 'description'
            : el === 'backend_keywords' ? 'keywords' : /^bullet_\d+$/.test(el) ? 'bullets' : ''
          const nowMs = Date.now()

          for (const item of result.action_plan as ActionPlanItem[]) {
            if (item.verdict !== 'REPLACE') continue
            // (0) COOLING LOCK: shipped + still in the measuring window → keep DONE (settling), unless
            // the seller asked to regenerate THIS section now OR the outcome gate has opened. This is
            // what stops a just-pushed section from regressing to "Do Now" on a fresh score that dipped
            // while Amazon is still applying + ranking it.
            const cf = coolFieldFor(item.element)
            const pushedMs = cf ? lastPushMs[cf] : undefined
            const overridden = regenerate_section === 'all' || (!!cf && regenerate_section === cf)
            // Data-readiness gate: hold ONLY while measurement is still open (cron hasn't reached a
            // terminal verdict) AND we're inside the fallback cap (covers the pre-snapshot window so
            // a stuck/never-measured push doesn't lock the field forever). A terminal verdict —
            // including headroom_rewrite — opens the gate and releases the lock.
            const withinFallbackCap = pushedMs != null && (nowMs - pushedMs) < COOLING_FALLBACK_MS
            const cooling = pushedMs != null && !overridden && !measurementOpen && withinFallbackCap
            if (cooling) {
              const daysAgo = Math.max(1, Math.round((nowMs - pushedMs!) / (24 * 60 * 60 * 1000)))
              item.verdict = 'DONE'
              item.current_status = `✓ Shipped ${daysAgo}d ago — measuring (we wait for ~2 SQP months of post-push data before judging the outcome). Locked until the measurement gate opens; use Regenerate to override.`
              item.instruction = 'No action — recently shipped and still measuring. Let it settle, or click Regenerate to override the measurement lock.'
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
            per_child_bullets: result.per_child_bullets,
            per_child_descriptions: result.per_child_descriptions,
            recommended_description: result.recommended_description,
            variant_corrections: result.variant_corrections,
            cannibalization_warnings: result.cannibalization_warnings,
            product_details_improvements: result.product_details_improvements,
            keyword_reconciliation: result.keyword_reconciliation as KeywordReconciliation[],
            action_plan: result.action_plan as ActionPlanItem[],
            generated_at: new Date().toISOString(),
            keyword_opportunities_used: opportunitiesUsed,
          }

          // MANUAL-TITLE LOCK (2026-07-07, B0FRYMM56C): if the seller manually pushed their own title,
          // the manual push stamped title_source='manual' (pushExecutor). A WHOLE-listing AI Audit /
          // Regenerate must NOT silently overwrite it — read the flag fresh (storedRec is only loaded on
          // a partial regen) and, when locked AND this isn't an explicit "Regenerate title", KEEP the
          // seller's title + its per_child_titles and HOLD the lock (so a bullets/description regen can't
          // clear it either). An explicit title regen (regenerate_section==='title') is the seller asking
          // for a fresh one → replace it and reset the lock to 'ai'.
          let titleSourceOut: 'ai' | 'manual' = 'ai'
          let priorKwJson: string | null = null   // prior stored keywords, for the degraded-keywords preserve below
          try {
            const { data: lockRow } = await supabase
              .from('listing_seo_recommendations')
              .select('title_source, recommended_title, per_child_titles, recommended_keywords')
              .eq('parent_asin', parent_asin)
              .maybeSingle()
            priorKwJson = (lockRow as { recommended_keywords?: string } | null)?.recommended_keywords ?? null
            const locked = (lockRow as { title_source?: string } | null)?.title_source === 'manual'
            if (locked && regenerate_section !== 'title') {
              const kept = String((lockRow as { recommended_title?: string }).recommended_title ?? '').trim()
              if (kept) rec.recommended_title = kept
              const keptPct = (lockRow as { per_child_titles?: unknown }).per_child_titles
              if (Array.isArray(keptPct) && keptPct.length) rec.per_child_titles = keptPct as typeof rec.per_child_titles
              titleSourceOut = 'manual'
              console.log(`[ai-recommendations] manual-title lock HELD for ${parent_asin} — kept the seller's title through a ${regenerate_section ?? 'full'} regen`)
            }
          } catch (e) { console.warn('[ai-recommendations] manual-title lock check failed (non-fatal):', e instanceof Error ? e.message : e) }
          rec.title_source = titleSourceOut   // carry the lock state into the streamed result so the "✏️ locked" badge survives a whole-audit

          // DEGRADED-KEYWORDS PRESERVE (2026-07-08): the pipeline flagged the backend keywords as
          // degraded-after-retry. The old behavior console.warn'd and PERSISTED anyway — an 86-char
          // title-echo string replaced 245-byte approved keywords. Keep the STORED keywords instead
          // (abort-not-overwrite, keyword edition): swap the preserved set into `rec` BEFORE dbPayload
          // is built so the upsert simply rewrites the same stored values, and patch the action-plan
          // card so the UI shows the preserved copy, not the degraded one. A brand-new listing with no
          // prior keywords keeps the degraded output (better than nothing) — the warning still fires.
          let kwPreserved = false
          if (result.degradedSections?.includes('backend_keywords') && priorKwJson) {
            try {
              const prior = JSON.parse(priorKwJson) as { sku: string; asin: string; keywords: string }[]
              if (Array.isArray(prior) && prior.length > 0 && prior.some((p) => (p?.keywords ?? '').trim())) {
                rec.per_child_keywords = prior
                rec.recommended_keywords = prior[0]?.keywords ?? ''
                rec.action_plan = (rec.action_plan ?? []).map((it) => (it as { element?: string }).element === 'backend_keywords'
                  ? { ...it, replacement_content: prior[0]?.keywords ?? '', notes: `${(it as { notes?: string }).notes ?? ''} [This regen's backend output came back degraded — kept your previous keywords untouched.]`.trim() }
                  : it) as typeof rec.action_plan
                kwPreserved = true
                console.warn(`[ai-recommendations] backend keywords degraded for ${parent_asin} — preserved the stored set instead of persisting the degraded one`)
              }
            } catch { /* prior string unparsable — fall through, persist what we generated */ }
          }

          // SHIP-TRUTH DERIVATION (2026-07-09): derive the plan from live truth for BOTH the stream
          // and the stored row — the audit/cooling stamps above survive only as ADVISORY fields
          // (instruction/priority/notes); verdict/current_status/replacement_content are computed
          // from rec-vs-cache. A locked+shipped title now derives DONE with the seller's kept title
          // displayed (the "shipped but still red" class dies here).
          try {
            rec.action_plan = deriveActionPlan(
              { ...(rec as unknown as Record<string, unknown>), recommended_keywords: JSON.stringify(rec.per_child_keywords) } as never,
              children as unknown as DeriveContentRow[],
            ) as unknown as ActionPlanItem[]
          } catch (e) { console.warn('[ai-recommendations] full-path derive failed — persisting audit plan:', e instanceof Error ? e.message : e) }

          // DB write. recommended_bullets + the *_warnings/improvements/reconciliation/action_plan
          // columns are JSONB (arrays written directly); recommended_keywords is TEXT (JSON string).
          // per_child_titles is JSONB (migration 017) — only present for capacity variation families.
          // title_source is DELIBERATELY OMITTED here: this whole (full) path NEVER transitions the lock
          // (a locked listing stays 'manual' by omission — the upsert doesn't touch the column; the only
          // clear is the explicit-title partial path). Keeping it out of dbPayload means a lagging
          // migration 044 can't fail this upsert and trip the loud "FULL UPSERT FAILED" path every audit.
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
            // Per-design bullets/description (migration 033) — JSONB, only present for multi-design POD families.
            per_child_bullets: rec.per_child_bullets ?? null,
            per_child_descriptions: rec.per_child_descriptions ?? null,
            keyword_plan: result.keywordPlan ?? null,   // #92/#93 — read by the scorer (sync-time parity)
          }

          const { error: upsertErr } = await supabase
            .from('listing_seo_recommendations')
            .upsert(dbPayload, { onConflict: 'parent_asin' })
          if (upsertErr) {
            // LOUD: the full upsert failed. The minimal retry below SAVES THE CORE recommendation, but
            // per_child_* (per-design titles/bullets/descriptions) + keyword_plan are not in it. A MISSING
            // COLUMN (usually migration 033's per_child_bullets/descriptions, or 022's keyword_plan) is the
            // typical cause. This used to be a quiet console.warn and SILENTLY DROPPED per-design content,
            // which hid the missing-033 gap for weeks — hence the loud error + the best-effort persists below.
            console.error(`[AI Recs] FULL UPSERT FAILED for ${rec.parent_asin} — core saved via minimal retry, but PER-DESIGN content is at risk. Likely a MISSING COLUMN (run migration 033 / 022). Error:`, upsertErr.message)
            // The minimal payload intentionally OMITS the newer JSONB columns (incl. keyword_plan) so a
            // missing column can't break the core-recommendations save — that's the schema-missing safety net.
            await supabase.from('listing_seo_recommendations').upsert({
              parent_asin: rec.parent_asin,
              recommended_title: rec.recommended_title,
              recommended_bullets: rec.recommended_bullets,
              recommended_keywords: JSON.stringify(rec.per_child_keywords),
              recommended_description: rec.recommended_description,
              // action_plan is plain JSONB predating every migration — CANNOT be the missing-column
              // culprit. Omitting it here is how the stored advisory copy froze while the columns
              // advanced (the description card-vs-modal split, 2026-07-09).
              action_plan: rec.action_plan,
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
            // Best-effort persist the per-child arrays so a TRANSIENT full-upsert failure doesn't drop
            // per-design content. Titles (mig 017) and bullets/descriptions (mig 033) update INDEPENDENTLY
            // so a missing 033 column can't also drop the 017 titles. A missing column errors harmlessly
            // (ignored) — the loud error above already surfaced the gap; applying the migration is the fix.
            try {
              await supabase.from('listing_seo_recommendations')
                .update({ per_child_titles: rec.per_child_titles ?? null })
                .eq('parent_asin', rec.parent_asin)
            } catch { /* per_child_titles column absent — handled by migration 017 */ }
            try {
              await supabase.from('listing_seo_recommendations')
                .update({ per_child_bullets: rec.per_child_bullets ?? null, per_child_descriptions: rec.per_child_descriptions ?? null })
                .eq('parent_asin', rec.parent_asin)
            } catch { /* per_child_bullets/descriptions column absent — handled by migration 033 */ }
          }

          // Degraded-keywords / hard-error warnings (2026-07-08): the run SUCCEEDED (core content is
          // healthy + persisted) but something inside it degraded — say so instead of silence.
          if (kwPreserved) {
            emit({ type: 'warning', kind: 'degraded', message: 'Backend keywords came back degraded on this run — kept your previous keywords untouched. Run "Regenerate backend keywords" in a minute to refresh them.' })
          }
          const hardF = (openai as { __aiHardError?: string }).__aiHardError
          if (hardF) {
            emit({ type: 'warning', kind: hardF, message: hardF === 'quota' ? 'Part of this run hit an OpenAI credit limit (insufficient_quota) — the saved content is healthy, but add credit before the next regen.' : 'Part of this run hit an OpenAI auth error — the saved content is healthy, but check the API key in Settings.' })
            // AWAITED (fire-and-forget lesson): a detached write racing controller.close() can be lost.
            await recordAiHealth('down', hardF, 'Hard OpenAI error during a full regen (core content saved healthy).')
          } else {
            await recordAiHealth('ok')
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
          // CLASSIFIED error surfacing (2026-07-08, PO: "why doesn't the system let me know credit is
          // exhausted?"): the error's aiKind (set by assertCoreHealthy) or the instrumented client's
          // recorded hard error names the REAL cause — quota/auth get an actionable message + the
          // site-wide ai_health record; everything else stays a transient retry-style message.
          const { getAiHardError } = await import('@/lib/openai/errorClass')
          const kind = ((err as { aiKind?: string })?.aiKind) ?? getAiHardError(openai) ?? 'transient'
          const message =
            kind === 'quota' ? 'AI credit exhausted — the OpenAI account is out of quota (insufficient_quota). Nothing was changed; your stored content is safe. Add credit at platform.openai.com/billing, then regenerate.' :
            kind === 'auth' ? 'AI key rejected (401) — check the OpenAI API key in Settings. Nothing was changed; your stored content is safe.' :
            kind === 'degraded' ? (err instanceof Error ? err.message : 'The AI came back degraded. Your previous content is untouched — retry in a minute.') :
            (err instanceof Error ? err.message : 'Unexpected error during generation')
          if (kind === 'quota' || kind === 'auth') await recordAiHealth('down', kind, message)
          emit({ type: 'error', kind, error: message })
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
  const per_child_titles: { sku: string; asin: string; title: string; designName?: string | null; designKey?: string | null }[] =
    Array.isArray(data.per_child_titles) ? data.per_child_titles : []

  // per_child_bullets/per_child_descriptions (migration 033) are JSONB. Tolerate missing column / null / non-arrays.
  const per_child_bullets: { sku: string; asin: string; bullets: string[]; designName?: string | null; designKey?: string | null }[] =
    Array.isArray(data.per_child_bullets) ? data.per_child_bullets : []
  const per_child_descriptions: { sku: string; asin: string; description: string; designName?: string | null; designKey?: string | null }[] =
    Array.isArray(data.per_child_descriptions) ? data.per_child_descriptions : []

  // product_details_improvements is a blind-persisted LLM parse: values can be arrays
  // (["Water Proof","Shock Proof"]) or numbers on rows written before the pipeline
  // normalized at the write boundary. Every UI consumer .trim()s these — the B0GCF11RKL
  // page hard-crashed on exactly this — so normalize HERE too, healing ALL historical
  // rows without requiring a regen.
  const product_details_improvements = Array.isArray(data.product_details_improvements)
    ? (data.product_details_improvements as Record<string, unknown>[]).map((p) => {
        const fieldName = detailValueToString(p.field_name)
        const recVal = detailValueToString(p.recommended_value)
        return {
          ...p,
          field_name: fieldName,
          current_value: p.current_value == null ? null : detailValueToString(p.current_value),
          // HEAL-ON-SERVE (2026-07-18): a STALE keyword-stuffed Item Highlight (a word repeated >2x, e.g.
          // "comfort colors" x3) is rejected by Amazon AND — because Amazon re-validates the whole item on
          // any PATCH — blocks unrelated pushes (a title push failed on it). Cap it on the READ path so the
          // seller never SEES or pushes the raw spam; same heal-on-read as the value normalization here and
          // the trademark scrub-on-serve below. No-op on a clean value; the push boundary caps too.
          recommended_value: isItemHighlightsField(fieldName, (p as { sp_api_key?: string }).sp_api_key)
            ? capItemHighlightRepeats(recVal)
            : recVal,
        }
      })
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

  // Trademark scrub-on-serve (heal-on-read): recommendations persisted BEFORE the trademark guard
  // shipped (2026-06-15) keep raw marks like "World Cup" in stored fields. A per-section title-only
  // regen re-scrubs the title but never re-touches recommended_bullets, so the DISPLAY diverged
  // (title clean, bullets dirty). scrubTrademarks is idempotent, so re-scrubbing here is a no-op on
  // clean post-guard rows and heals ALL stale historical rows at once -- no regen required. Push is
  // already safe (pushExecutor scrubs on publish); this only fixes the read/display path. Mirrors the
  // product_details_improvements heal-on-read above.
  const recommended_title_scrubbed = typeof data.recommended_title === 'string'
    ? scrubTrademarks(data.recommended_title)
    : data.recommended_title
  const recommended_bullets_scrubbed = Array.isArray(data.recommended_bullets)
    ? scrubTrademarksArr(data.recommended_bullets)
    : data.recommended_bullets
  const recommended_description_scrubbed = typeof data.recommended_description === 'string'
    ? scrubTrademarks(data.recommended_description)
    : data.recommended_description
  const per_child_keywords_scrubbed = per_child_keywords.map((c) => ({ ...c, keywords: scrubTrademarks(c.keywords || '') }))
  const per_child_titles_scrubbed = per_child_titles.map((c) => ({ ...c, title: scrubTrademarks(c.title || '') }))
  const per_child_bullets_scrubbed = per_child_bullets.map((c) => ({ ...c, bullets: scrubTrademarksArr(c.bullets || []) }))
  const per_child_descriptions_scrubbed = per_child_descriptions.map((c) => ({ ...c, description: scrubTrademarks(c.description || '') }))

  // SHIP-TRUTH DERIVATION (2026-07-09, approach A): the card verdict / current_status /
  // replacement_content are DERIVED from live truth on every serve — displayed content is the exact
  // value the ship modal pushes (same resolver), verdict = does every cached child match its per-SKU
  // recommendation. The stored action_plan contributes ADVISORY copy only. Same heal-on-read pattern
  // as the trademark scrub above: retroactively fixes ALL historical stale cards, no regen needed.
  // Best-effort: a failed content read serves the stored plan rather than erroring the page.
  let action_plan_out = scrubTrademarksDeep(action_plan) as unknown as ActionPlanItem[]
  try {
    const { data: contentRows } = await supabase
      .from('listing_content')
      .select('sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
      .eq('parent_asin', parent_asin)
    action_plan_out = deriveActionPlan({
      recommended_title: (recommended_title_scrubbed ?? null) as string | null,
      recommended_bullets: (recommended_bullets_scrubbed ?? null) as string[] | null,
      recommended_description: (recommended_description_scrubbed ?? null) as string | null,
      per_child_titles: per_child_titles_scrubbed,
      per_child_bullets: per_child_bullets_scrubbed,
      per_child_descriptions: per_child_descriptions_scrubbed,
      recommended_keywords: JSON.stringify(per_child_keywords_scrubbed),
      action_plan: action_plan_out,
    }, (contentRows ?? []) as DeriveContentRow[]) as unknown as ActionPlanItem[]
  } catch (e) { console.warn('[ai-recommendations GET] derive failed — serving stored plan:', e instanceof Error ? e.message : e) }

  // Item Highlights write-gate: compute the single client-facing boolean server-side so the client
  // needs ZERO date logic. `writable == "not blocked for the IH field"` — the gate folds in the probe
  // flag AND the July-27 fallback (null flag → date). undefined on legacy responses → client treats
  // Item Highlights as still write-blocked (safe default).
  const { getItemHighlightsApiState: _getIhState, isWriteBlockedPreLaunch: _isBlocked } = await import('@/lib/fba/productDetailAttrs')
  const ihState = await _getIhState(supabase)
  const item_highlights_writable =
    _isBlocked('item_highlights', 'title_differentiation', new Date(), { apiSupported: ihState?.supported ?? null }) === false
  // Fire-and-forget >24h probe refresh (cycle-safe dynamic import). This GET returns the current
  // last-known flag; the refresh (if due) lands for the next request. Never blocks/throws.
  void import('@/lib/fba/pushExecutor')
    .then((m) => m.maybeRefreshItemHighlightsProbe(supabase, ihState))
    .catch(() => { /* best-effort */ })

  return NextResponse.json({
    recommendations: {
      ...data,
      recommended_title: recommended_title_scrubbed,
      recommended_bullets: recommended_bullets_scrubbed,
      recommended_description: recommended_description_scrubbed,
      per_child_keywords: per_child_keywords_scrubbed,
      per_child_titles: per_child_titles_scrubbed,
      per_child_bullets: per_child_bullets_scrubbed,
      per_child_descriptions: per_child_descriptions_scrubbed,
      // Deep-scrub the structured audit blobs too (PO-caught 2026-07-02: "france world cup tee" in an
      // action_plan copy block — the field-level scrubs above never reached these). Identifier keys
      // (sku/asin/element/...) are skipped inside scrubTrademarksDeep, so SKU codes like
      // "France-World-Cup-TS-Parent" are never rewritten. Idempotent heal-on-read, same as the rest.
      keyword_reconciliation: scrubTrademarksDeep(keyword_reconciliation),
      action_plan: action_plan_out,
      product_details_improvements: scrubTrademarksDeep(product_details_improvements),
      field_pushed_at,
      item_highlights_writable,    // server-probed marketplace flag (undefined on legacy → client treats as blocked)
      // Keep recommended_keywords as the first child's keywords for backward compat
      recommended_keywords: per_child_keywords_scrubbed.length > 0
        ? per_child_keywords_scrubbed[0].keywords
        : (typeof data.recommended_keywords === 'string' ? scrubTrademarks(data.recommended_keywords) : data.recommended_keywords || ''),
    },
  })
}

// ─── PATCH Handler ────────────────────────────────────────────────────────────
// Persist a single design's edited title / bullets / description for the per-design editor cards
// (PR-C). DB-ONLY: this writes the edited content back to listing_seo_recommendations so the seller's
// edits survive a reload — it NEVER touches Amazon. A live push only happens through the separate
// push-content flow behind the Ship modal's explicit confirm.
//
// Body: { parent_asin: string, skus: string[], title?: string, bullets?: string[], description?: string }
// Entries are matched by a SKU ALLOW-LIST (not designKey — empty/missing keys could corrupt-match):
// only per-child entries whose `sku` is in `skus` are overwritten, and only with the provided fields;
// sku/asin/designName/designKey and any unprovided field are preserved; non-matching entries pass
// through untouched.
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      parent_asin?: string
      skus?: string[]
      title?: string
      bullets?: string[]
      description?: string
    }
    const parent_asin = (body.parent_asin ?? '').trim()
    const skus = Array.isArray(body.skus) ? body.skus.filter((s) => typeof s === 'string' && s.trim()) : []
    if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    if (skus.length === 0) return NextResponse.json({ error: 'skus must be a non-empty array' }, { status: 400 })

    const supabase = getAdminSupabase()
    // Load the current per-child arrays (same JSONB shape the GET reads). Tolerate null/missing.
    const { data, error } = await supabase
      .from('listing_seo_recommendations')
      .select('per_child_titles, per_child_bullets, per_child_descriptions')
      .eq('parent_asin', parent_asin)
      .single()
    if (error) {
      // Don't mask a real query failure as "no row" — a MISSING COLUMN (e.g. pre-migration-033
      // per_child_bullets/descriptions) errors here, and returning 404 hid exactly that gap. Surface
      // the actual error (500) so it's diagnosable instead of looking like the parent simply has no row.
      console.error(`[AI Recs PATCH] read failed for ${parent_asin} (a column may be missing — check migration 033):`, error.message)
      return NextResponse.json({ error: `DB read failed (a column may be missing — check migration 033): ${error.message}` }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'No recommendation row for this parent_asin' }, { status: 404 })
    }

    const allow = new Set(skus)
    const titles = (Array.isArray(data.per_child_titles) ? data.per_child_titles : []) as {
      sku: string; asin: string; title: string; designName?: string | null; designKey?: string | null
    }[]
    const bullets = (Array.isArray(data.per_child_bullets) ? data.per_child_bullets : []) as {
      sku: string; asin: string; bullets: string[]; designName?: string | null; designKey?: string | null
    }[]
    const descriptions = (Array.isArray(data.per_child_descriptions) ? data.per_child_descriptions : []) as {
      sku: string; asin: string; description: string; designName?: string | null; designKey?: string | null
    }[]

    const hasTitle = typeof body.title === 'string'
    const hasBullets = Array.isArray(body.bullets)
    const hasDescription = typeof body.description === 'string'
    const newTitle = hasTitle ? scrubTrademarks(body.title as string) : ''
    const newBullets = hasBullets ? (body.bullets as string[]).map((b) => scrubTrademarks(b ?? '')) : []
    const newDescription = hasDescription ? scrubTrademarks(body.description as string) : ''

    // Overwrite ONLY allow-listed entries, ONLY the provided fields; preserve everything else.
    const per_child_titles = hasTitle
      ? titles.map((e) => (allow.has(e.sku) ? { ...e, title: newTitle } : e))
      : titles
    const per_child_bullets = hasBullets
      ? bullets.map((e) => (allow.has(e.sku) ? { ...e, bullets: newBullets } : e))
      : bullets
    const per_child_descriptions = hasDescription
      ? descriptions.map((e) => (allow.has(e.sku) ? { ...e, description: newDescription } : e))
      : descriptions

    const { error: updErr } = await supabase
      .from('listing_seo_recommendations')
      .update({ per_child_titles, per_child_bullets, per_child_descriptions } as never)
      .eq('parent_asin', parent_asin)
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    // Return the updated arrays so the client can refresh in place without a full reload.
    return NextResponse.json({ per_child_titles, per_child_bullets, per_child_descriptions })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'PATCH failed' },
      { status: 500 },
    )
  }
}
