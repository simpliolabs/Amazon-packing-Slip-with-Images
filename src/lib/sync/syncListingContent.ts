/**
 * syncListingContent.ts
 *
 * Fetches listing content for the top N parent ASINs (by 30d sales) and runs
 * a comprehensive SEO audit covering:
 *
 *   1. Title — length, ALL CAPS, forbidden chars, keyword placement
 *   2. Bullets — count, length, benefit-led format, keyword density
 *   3. Description — presence, length, keyword coverage, HTML formatting
 *   4. Backend keywords — length, commas, overlap with title/bullets
 *   5. Images — count vs Amazon 7-image max
 *   6. A+ Content — presence, module count, Brand Story, headline, alt text
 *   7. Child cannibalization — parent vs child content diffs, cross-child
 *      duplicate titles, and children with better content than the parent
 *
 * APIs used:
 *   - Listings Items API  GET /listings/2021-08-01/items/{sellerId}/{sku}
 *     includedData: summaries,attributes
 *   - A+ Content API      GET /aplus/2020-11-01/contentPublishRecords
 *
 * Rate limits:
 *   - Listings Items API:  5 req/sec  → 200ms sleep
 *   - A+ Content API:      10 req/sec → 100ms sleep
 *
 * DB note: listing_content requires these columns (run migration if missing):
 *   ALTER TABLE listing_content ADD COLUMN IF NOT EXISTS description TEXT;
 *   ALTER TABLE listing_content ADD COLUMN IF NOT EXISTS image_count INTEGER DEFAULT 0;
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'
import { SECTION_WEIGHTS, weightedPoints } from '@/lib/fba/scoreWeights'
import { makeCoverageChecker } from '@/lib/keyword-engine/coverage'
import { missingBulletKeywords } from '@/lib/keyword-engine/bulletCoverage'
import { isWriteBlockedPreLaunch } from '@/lib/fba/productDetailAttrs'

const ENDPOINT       = process.env.AMAZON_ENDPOINT       || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/** Read the seller ID from app_settings, falling back to env var */
async function getSellerId(): Promise<string> {
  const supabase = getAdminSupabase()
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'amazon_seller_id')
    .single()
  if (data?.value) return data.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured. Add it in Settings or set AMAZON_MERCHANT_TOKEN env var.')
}

/** Sleep helper */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Types ─────────────────────────────────────────────────────────────────────

interface ListingContentRow {
  sku:                      string
  asin:                     string
  parent_asin:              string | null
  title:                    string | null
  bullet_1:                 string | null
  bullet_2:                 string | null
  bullet_3:                 string | null
  bullet_4:                 string | null
  bullet_5:                 string | null
  description:              string | null
  backend_keywords:         string | null
  image_count:              number
  has_aplus:                boolean
  aplus_module_count:       number
  aplus_has_brand_story:    boolean
  aplus_has_headline:       boolean
  aplus_images_missing_alt: number
  content_synced_at:        string
}

interface ChildSku {
  sku:         string
  asin:        string
  parent_asin: string | null
}

// ── Listings Items API ────────────────────────────────────────────────────────

/** Fetch real image count for an ASIN from the Catalog Items API */
async function fetchImageCount(token: string, asin: string): Promise<number> {
  const url =
    `${ENDPOINT}/catalog/2022-04-01/items/${asin}` +
    `?marketplaceIds=${MARKETPLACE_ID}` +
    `&includedData=images`
  const resp = await fetch(url, {
    headers: { 'x-amz-access-token': token },
  })
  if (!resp.ok) return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json()
  // images is an array of { marketplaceId, images: [{variant, link}] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const imagesArr: any[] = json.images || []
  if (imagesArr.length === 0) return 0
  // Find the entry for our marketplace
  const mktEntry = imagesArr.find((e: { marketplaceId?: string }) => e.marketplaceId === MARKETPLACE_ID) || imagesArr[0]
  // Count unique image variants (MAIN, PT01, PT02, etc.)
  const imgs: { variant?: string }[] = mktEntry?.images || []
  return imgs.length
}

async function fetchListingContent(
  token: string,
  sellerId: string,
  sku: string,
  asin: string,
  parentAsin: string | null
): Promise<ListingContentRow> {
  const encodedSku = encodeURIComponent(sku)
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodedSku}` +
    `?marketplaceIds=${MARKETPLACE_ID}` +
    `&includedData=summaries,attributes`

  const resp = await fetch(url, {
    headers: { 'x-amz-access-token': token },
  })

  const base: ListingContentRow = {
    sku,
    asin,
    parent_asin:              parentAsin,
    title:                    null,
    bullet_1:                 null,
    bullet_2:                 null,
    bullet_3:                 null,
    bullet_4:                 null,
    bullet_5:                 null,
    description:              null,
    backend_keywords:         null,
    image_count:              0,
    has_aplus:                false,
    aplus_module_count:       0,
    aplus_has_brand_story:    false,
    aplus_has_headline:       false,
    aplus_images_missing_alt: 0,
    content_synced_at:        new Date().toISOString(),
  }

  if (!resp.ok) {
    if (resp.status !== 404) {
      console.warn(`[ListingContent] SKU ${sku}: HTTP ${resp.status}`)
    }
    return base
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attrs: any = json.attributes || {}

  // Title
  const titleArr = attrs.item_name
  if (Array.isArray(titleArr) && titleArr.length > 0) {
    base.title = titleArr[0]?.value || null
  }

  // Bullets (up to 5)
  const bullets: string[] = []
  const bulletArr = attrs.bullet_point
  if (Array.isArray(bulletArr)) {
    for (const b of bulletArr) {
      if (b?.value) bullets.push(b.value)
    }
  }
  base.bullet_1 = bullets[0] ?? null
  base.bullet_2 = bullets[1] ?? null
  base.bullet_3 = bullets[2] ?? null
  base.bullet_4 = bullets[3] ?? null
  base.bullet_5 = bullets[4] ?? null

  // Product description (HTML allowed by Amazon, strip tags for analysis)
  const descArr = attrs.product_description
  if (Array.isArray(descArr) && descArr.length > 0) {
    const raw = descArr[0]?.value || ''
    // Strip HTML tags for length/keyword analysis but store raw
    base.description = raw || null
  }

  // Backend keywords
  const kwArr = attrs.generic_keyword
  if (Array.isArray(kwArr) && kwArr.length > 0) {
    base.backend_keywords = kwArr.map((k: { value?: string }) => k?.value || '').filter(Boolean).join(' ')
  }

  // Image count from summaries (mainImage only — otherImages not in Listings Items API)
  // We'll fetch the real count from Catalog Items API after this call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaries: any[] = json.summaries || []
  if (summaries.length > 0) {
    base.image_count = summaries[0]?.mainImage ? 1 : 0
  }

  return base
}

// ── A+ Content API ────────────────────────────────────────────────────────────

interface AplusStatus {
  hasAplus:        boolean
  moduleCount:     number
  missingAltCount: number
  hasBrandStory:   boolean
  hasHeadline:     boolean
}

async function fetchAplusStatus(
  token: string,
  asin: string
): Promise<AplusStatus> {
  // Use searchContentPublishRecords — the correct endpoint to check if a specific
  // ASIN has published A+ content. Takes a single child ASIN, not a set.
  // Docs: GET /aplus/2020-11-01/contentPublishRecords?marketplaceId=...&asin=...
  const url =
    `${ENDPOINT}/aplus/2020-11-01/contentPublishRecords` +
    `?marketplaceId=${MARKETPLACE_ID}` +
    `&asin=${asin}`

  const resp = await fetch(url, {
    headers: { 'x-amz-access-token': token },
  })

  const base: AplusStatus = { hasAplus: false, moduleCount: 0, missingAltCount: 0, hasBrandStory: false, hasHeadline: false }

  if (!resp.ok) return base

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const records: any[] = json.publishRecordList || []

  if (records.length === 0) return base

  base.hasAplus = true

  // Analyse each publish record for optimization signals
  for (const record of records) {
    const contentType: string = record.contentType || ''
    if (contentType === 'EBC') {
      // Standard A+ (EBC = Enhanced Brand Content via Seller Central)
      // publishRecordList only contains metadata; count records as module proxy
      base.moduleCount += 1
      // EBC records don't carry full module data — mark headline as present
      // if there is at least one EBC record (standard A+ always has a headline)
      base.hasHeadline = true
    } else if (contentType === 'EMC') {
      // Brand Story (Enhanced Marketing Content)
      base.hasBrandStory = true
    }
  }

  return base
}

// ── Scoring Engine ────────────────────────────────────────────────────────────

interface SeoIssue {
  field:        string
  severity:     'critical' | 'warning' | 'info'
  message:      string
  auto_fixable: boolean
}

interface SeoScore {
  title_score:          number  // 0-25
  bullet_score:         number  // 0-25
  keyword_score:        number  // 0-25
  aplus_score:          number  // 0-25
  description_score:    number  // 0-25  (own card — was folded into keyword_score)
  features_score:       number  // 0-25  (own card — product-detail specs; was folded into aplus_score)
  overall_score:        number  // 0-100 (normalized: sum of the 6 sub-scores / 150 * 100)
  issues:               SeoIssue[]
  child_override_count: number
}

/** Extract plain text from HTML description */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Tokenize text into lowercase words for keyword overlap analysis */
function tokenize(text: string): Set<string> {
  const stopWords = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','need','dare','ought','used','this','that','these','those','it','its','you','your','we','our','they','their','i','my','me','him','her','us','them'])
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  )
}

/** Data from keyword_analysis + listing_seo_recommendations, fetched before scoring */
interface ScoringContext {
  /** Keyword intelligence summary counts (from keyword_analysis table) */
  criticalCount:  number
  upgradeCount:   number
  reinforceCount: number
  defendedCount:  number
  totalKeywords:  number
  /** Top CRITICAL keywords for issue messages */
  topCriticalKeywords: string[]
  /** Top UPGRADE keywords (in bullets but not title) */
  topUpgradeKeywords:  string[]
  /** Product details improvements count (from listing_seo_recommendations) */
  productDetailsGaps:  number
  /** Description quality from AI recommendations (has recommendation = room to improve) */
  hasAiRecommendations: boolean
  /** Brand name — exempted from the ALL CAPS check (e.g. "THE CEO" is the seller's
   *  brand identity, not a style-guide violation). Resolved from settings/catalog. */
  brandName?: string
  /** KeywordPlan (#93) — the generator's ACTUAL bullet opportunity set (topOpportunityKwsForBullets) from
   *  the persisted/injected plan. When present (length>0) the scorer docks bullets against THIS exact set
   *  instead of a separately-derived DB set, closing the source/relevance-gate/title-exclusion divergence.
   *  Absent/empty → fall back to the legacy topCritical∪topUpgrade derivation (backward-compatible). */
  bulletPlanKeywords?: string[]
  /** KeywordPlan (#92) — the real extractDesignName output ('' for generic/non-apparel). The scorer docks a
   *  section that drops the design name the title anchors. From the plan, NOT a capacity-unsafe title heuristic. */
  planDesignName?: string
}

/**
 * True when a caps token is a legitimate technical acronym or brand fragment that
 * Amazon's style guide does NOT consider a violation. The old check counted UHS-I,
 * DSLR, HDMI etc. against the seller, contradicting its own error message ("UHS-I
 * and SDHC are allowed in caps"). Rule of thumb:
 *   ≤6 chars  → almost certainly an acronym (DSLR/UHS-I/USB-C/HDMI/OLED)
 *   contains a non-letter (digit or punctuation) → mixed token like "4K", "USB-C"
 * Promotional spam ("CHEAPEST", "LOWEST", "BIGGEST", "DEAL") is always 7+ letters
 * and pure letters — so this heuristic catches all real abuse without false positives
 * on industry terminology.
 */
function isLegitCapsToken(token: string): boolean {
  if (token.length <= 6) return true            // DSLR, UHS-I, USB, HDMI, OLED, NFC, LED, GPS
  if (/[^A-Za-z]/.test(token)) return true      // 4K, USB-C, 2.5GbE, MP3-320
  return false                                  // CHEAPEST, BIGGEST, AMAZING, BARGAIN
}

/**
 * Resolve a parent ASIN to the child ASIN that has keyword_analysis data.
 * Uses the same 3-step fallback as the intelligence API:
 *   1. topChildAsin from parent_asin_rollup
 *   2. Direct match in keyword_analysis for the parent ASIN itself
 *   3. Any child in listing_content with this parent → check keyword_analysis
 */
async function resolveKeywordAsin(
  supabase: SupabaseClient,
  parentAsin: string,
  topChildAsin: string | null
): Promise<string | null> {
  // Step 1: Try topChildAsin (most common path)
  if (topChildAsin) {
    const { data: check } = await supabase
      .from('keyword_analysis')
      .select('asin')
      .eq('asin', topChildAsin)
      .limit(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (check && (check as any[]).length > 0) return topChildAsin
  }

  // Step 2: Try parentAsin directly (some products store under parent)
  const { data: parentCheck } = await supabase
    .from('keyword_analysis')
    .select('asin')
    .eq('asin', parentAsin)
    .limit(1)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (parentCheck && (parentCheck as any[]).length > 0) return parentAsin

  // Step 3: Find any child in listing_content → check keyword_analysis
  const { data: children } = await supabase
    .from('listing_content')
    .select('asin')
    .eq('parent_asin', parentAsin)
    .not('title', 'is', null)
    .limit(5)

  if (children) {
    for (const child of children) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const childAsin = (child as any).asin
      const { data: kwCheck } = await supabase
        .from('keyword_analysis')
        .select('asin')
        .eq('asin', childAsin)
        .limit(1)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (kwCheck && (kwCheck as any[]).length > 0) return childAsin
    }
  }

  return null
}

/** Fetch keyword intelligence + product details data for scoring.
 *  Caps CRITICAL and UPGRADE to top 10 by opportunity score for realistic scoring. */
export async function fetchScoringContext(
  supabase: SupabaseClient,
  parentAsin: string,
  topChildAsin: string | null
): Promise<ScoringContext> {
  const ctx: ScoringContext = {
    criticalCount: 0, upgradeCount: 0, reinforceCount: 0, defendedCount: 0,
    totalKeywords: 0, topCriticalKeywords: [], topUpgradeKeywords: [],
    productDetailsGaps: 0, hasAiRecommendations: false,
  }

  // 1. Resolve the correct child ASIN that has keyword_analysis data
  const kwAsin = await resolveKeywordAsin(supabase, parentAsin, topChildAsin)
  if (!kwAsin) {
    // No keyword data exists for this product family — skip keyword scoring
    console.log(`[Scoring] No keyword_analysis data found for parent ${parentAsin}`)
  } else {
    try {
      // Fetch top 10 CRITICAL + top 10 UPGRADE (ordered by opportunity_score)
      // This is the actionable working set — nobody optimizes for 42 keywords.
      const { data: kwRows } = await supabase
        .from('keyword_analysis')
        .select('keyword, action_type, opportunity_score')
        .eq('asin', kwAsin)
        .order('opportunity_score', { ascending: false })
        .limit(100)

      if (kwRows && kwRows.length > 0) {
        // CREDIT KEYWORDS ALREADY IN THE LIVE COPY. action_type (CRITICAL/UPGRADE) is a snapshot
        // from the last keyword sync: after the seller SHIPS a recommendation the keyword is now in
        // the copy but still classified "missing", which used to pin the score (shipping the rec
        // didn't move it). Build a haystack of the family's CURRENT content (title/bullets/
        // description/backend across all children) and skip any keyword already present, so the
        // score reflects what's live and shipping a recommendation raises it immediately. The push
        // route updates listing_content BEFORE re-scoring, so the just-pushed value is included.
        // Best-effort: an empty haystack scores exactly as before.
        let haystack = ''
        try {
          const { data: contentRows } = await supabase
            .from('listing_content')
            .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
            .eq('parent_asin', parentAsin)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          haystack = ((contentRows ?? []) as any[])
            .map((r) => [r.title, r.bullet_1, r.bullet_2, r.bullet_3, r.bullet_4, r.bullet_5, r.description, r.backend_keywords].filter(Boolean).join(' '))
            .join(' ').toLowerCase().replace(/\s+/g, ' ')
        } catch { /* empty haystack → score exactly as before */ }
        // TOKEN-based coverage (not exact-phrase). Amazon ranks a listing for a query when the copy
        // contains the query's WORDS, not the verbatim phrase. A keyword counts as covered when every
        // significant token (minus stopwords) appears somewhere in the copy — so a title with
        // "SD Camera Card 64GB ... Kodak and Canon" covers "sd card for camera 64gb" and is no longer
        // flagged. The old exact-substring check is why a genuinely keyword-rich title never moved off
        // 20: no realistic title contains long-tail phrases like "sd card for camera 64gb" verbatim.
        const isCovered = makeCoverageChecker(haystack)   // shared coverage (extracted to keyword-engine/coverage.ts)

        // AUDIENCE-LEAN guard: under a hard Female/Male selection the generator deliberately
        // REFUSES opposite-gender keywords ("mens comfort colors tshirt" on a Female listing —
        // PR #198 strips them from backend). Counting those as CRITICAL gaps docks the seller
        // for obeying their own selection (live: keyword card pinned at 19/25 with the gap
        // message literally naming a mens keyword on a Female run). Skip them from gap
        // counting under hard leans; lean_*/unisex unaffected. KEEP IN SYNC with the
        // FEM/MASC regexes in listingPipeline. Best-effort read — missing column = no guard.
        let hardLean: 'male' | 'female' | null = null
        try {
          const { data: leanRow } = await supabase
            .from('listing_seo_scores').select('*').eq('parent_asin', parentAsin).maybeSingle()
          const al = (leanRow as { audience_lean?: string | null } | null)?.audience_lean
          if (al === 'male' || al === 'female') hardLean = al
        } catch { /* no guard */ }
        const FEM_RE = /\bwom[ae]ns?\b|\bladies\b|\bfemale\b|\bgirls?\b/i
        const MASC_RE = /\bm[ae]ns?\b|\bmale\b|\bboys?\b/i
        const leanExcluded = (kw: string): boolean => {
          if (!hardLean) return false
          return hardLean === 'female'
            ? (MASC_RE.test(kw) && !FEM_RE.test(kw))
            : (FEM_RE.test(kw) && !MASC_RE.test(kw))
        }

        // Count totals but cap what affects scoring to top 10 per category
        let criticalSeen = 0
        let upgradeSeen = 0
        for (const row of kwRows) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = row as any
          ctx.totalKeywords++
          if (leanExcluded(String(r.keyword ?? ''))) continue  // the seller's audience choice bans it — not a gap
          switch (r.action_type) {
            case 'CRITICAL':
              if (isCovered(r.keyword)) break  // already in the live copy — not a gap
              criticalSeen++
              if (criticalSeen <= 10) ctx.criticalCount++  // Cap at 10
              if (ctx.topCriticalKeywords.length < 5) ctx.topCriticalKeywords.push(r.keyword)
              break
            case 'UPGRADE':
              if (isCovered(r.keyword)) break  // already in the live copy — not a gap
              upgradeSeen++
              if (upgradeSeen <= 10) ctx.upgradeCount++  // Cap at 10
              if (ctx.topUpgradeKeywords.length < 5) ctx.topUpgradeKeywords.push(r.keyword)
              break
            case 'REINFORCE': ctx.reinforceCount++; break
            case 'DEFENDED':  ctx.defendedCount++;  break
          }
        }
      }
    } catch (err) {
      console.warn(`[Scoring] keyword_analysis lookup failed for ${kwAsin}:`, err instanceof Error ? err.message : String(err))
    }
  }

  // 2. Product details improvements from listing_seo_recommendations
  try {
    const { data: recRow } = await supabase
      .from('listing_seo_recommendations')
      .select('product_details_improvements')
      .eq('parent_asin', parentAsin)
      .single()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec = recRow as any
    if (rec) {
      ctx.hasAiRecommendations = true
      const pdi = rec.product_details_improvements
      if (Array.isArray(pdi)) {
        // MATERIALITY (#85): product_details_improvements is a PROACTIVE spec sheet — the AI suggests a
        // value for EVERY standard attribute, even ones already filled ("err toward more"). Counting its
        // raw length docked Features for fields that aren't actually gaps (the "10/12 but 8 to push"
        // confusion). Count only TRUE gaps: a field with no live value, or an enum field whose current
        // value is invalid against the live Amazon schema (is_enum/enum_valid persisted by validate-at-regen).
        const isEmpty = (v: unknown) => !v || !String(v).trim()
        // Pre-launch Item Highlights are write-BLOCKED by Amazon ("currently unsupported") — an
        // empty one is not a closable gap until July 27, 2026, so it must not dock Features.
        ctx.productDetailsGaps = pdi.filter((p: { field_name?: string; sp_api_key?: string; current_value?: unknown; is_enum?: boolean; enum_valid?: boolean }) =>
          !isWriteBlockedPreLaunch(p.field_name, p.sp_api_key) &&
          (isEmpty(p.current_value) || (p.is_enum === true && p.enum_valid === false)),
        ).length
      }
    }
  } catch (err) {
    // Non-fatal: listing_seo_recommendations may not exist for this parent
    console.warn(`[Scoring] recommendations lookup failed for ${parentAsin}:`, err instanceof Error ? err.message : String(err))
  }

  // 2b. KeywordPlan (#92/#93) — read in its OWN try/catch + OWN select so a not-yet-migrated `keyword_plan`
  // column can't break the product_details read above (a combined select would error the whole row, losing
  // BOTH). When the column/row/plan is absent, ctx.bulletPlanKeywords/planDesignName stay undefined and the
  // scorer falls back to its legacy behavior (fully backward-compatible — no score regression, no crash).
  try {
    const { data: planRow } = await supabase
      .from('listing_seo_recommendations')
      .select('keyword_plan')
      .eq('parent_asin', parentAsin)
      .single()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kp = (planRow as any)?.keyword_plan
    if (kp && Array.isArray(kp.bullets)) ctx.bulletPlanKeywords = kp.bullets.filter((k: unknown): k is string => typeof k === 'string')
    if (kp && typeof kp.designName === 'string') ctx.planDesignName = kp.designName
  } catch { /* keyword_plan column not present (pre-migration) — fall back to legacy scoring */ }

  // 3. Brand name — used by the scorer to EXEMPT the brand from the ALL CAPS check
  // (e.g. "THE CEO" is the seller's brand identity, not a violation). Read from
  // app_settings, falling back to catalog_products.brand if available. Best-effort —
  // missing brand just means brand tokens aren't exempted (the tech-acronym whitelist
  // still kicks in for UHS-I/DSLR/etc.).
  try {
    const { data: brandRow } = await supabase
      .from('app_settings').select('value').eq('key', 'brand_name').single()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const br = brandRow as any
    if (br?.value && typeof br.value === 'string') ctx.brandName = br.value
  } catch { /* non-fatal */ }
  if (!ctx.brandName) {
    try {
      const { data: catRow } = await supabase
        .from('catalog_products').select('brand').eq('parent_asin', parentAsin).single()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = catRow as any
      if (c?.brand && typeof c.brand === 'string') ctx.brandName = c.brand
    } catch { /* non-fatal */ }
  }

  return ctx
}

/** Longest common prefix of a list of strings (character-wise). */
function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return ''
  let prefix = strings[0]
  for (let i = 1; i < strings.length && prefix; i++) {
    while (prefix && !strings[i].startsWith(prefix)) prefix = prefix.slice(0, -1)
  }
  return prefix
}

// Amazon appends per-variant dimensions to the title (e.g. " -Light Green-XX-Large"). Strip a
// trailing "-<color>-<size>" (or a bare "-<size>") so the scored length reflects the seller-
// editable base, not Amazon's auto-appended variant theme. This handles the common case where
// every child stores an IDENTICAL suffixed title, which the common-prefix step cannot.
const SIZE_TOKEN = "(?:XS|S|M|L|XL|XXL|XXXL|[2-5]XL|X-?Small|XX?X?-?Large|Small|Medium|Large|One[ -]?Size)"
function stripVariantSuffix(title: string): string {
  return title
    .replace(new RegExp(`\\s*[-–—|]\\s*[A-Za-z][\\w /&'-]*?\\s*[-–—|]\\s*${SIZE_TOKEN}\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s*[-–—|]\\s*${SIZE_TOKEN}\\s*$`, 'i'), '')
    .trim()
}

/**
 * Recover the seller-entered base title for a variation family.
 * Amazon appends per-variant dimensions to each child title (e.g. " -Light Green-XX-Large").
 * Two complementary steps recover the base: the longest common prefix across child titles
 * (handles titles that DIVERGE by variant), then a trailing variant-dimension strip (handles the
 * common case where every child stores the SAME suffixed title). Falls back to the raw title if a
 * step would leave an implausibly short fragment.
 */
function sellerBaseTitle(rawTitle: string, childContents: ListingContentRow[]): string {
  const childTitles = childContents
    .map(c => c.title)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
  let base = rawTitle
  if (childTitles.length >= 2) {
    const prefix = longestCommonPrefix(childTitles).replace(/[\s\-–—|,]+$/, '').trim()
    if (prefix.length >= Math.min(40, Math.floor((rawTitle.length || 1) * 0.5))) base = prefix
  }
  const stripped = stripVariantSuffix(base)
  return stripped.length >= Math.min(40, Math.floor((base.length || 1) * 0.5)) ? stripped : base
}

/** Apparel detection from the title, to keep example terms category-appropriate. */
function titleLooksApparel(title: string): boolean {
  return /\b(shirt|t-?shirt|tee|tees|hoodie|sweatshirt|sweater|tank|crewneck|pullover|apparel|hat|cap|beanie|socks?|leggings|joggers|shorts|dress|jacket)\b/i.test(title)
}

// Seasonal terms — keep in sync with listingPipeline.ts:100 (SEASONAL_TERMS). The bullet-coverage
// check excludes these: per the product strategy, seasonal keywords belong in BACKEND terms, not
// bullets/title (unless the design itself is seasonal), so docking the bullets for lacking them is
// wrong (it fights the strategy). Duplicated, not imported, to avoid a scorer→pipeline circular dep.
const BULLET_SEASONAL_TERMS = [
  'christmas', 'xmas', 'halloween', 'valentines', 'valentine', 'easter',
  'thanksgiving', 'mothers day', 'mother day', 'fathers day', 'father day',
  'back to school', 'last day of school', 'schools out', 'school out',
  'independence day', '4th of july', 'fourth of july', 'july 4th',
  'st patrick', 'new year', 'new years', 'memorial day', 'labor day',
  'spring break', 'summer break', 'winter break', 'black friday',
  'cyber monday', 'prime day', 'hanukkah',
]
const isSeasonalKw = (kw: string) => BULLET_SEASONAL_TERMS.some((t) => kw.toLowerCase().includes(t))

export function scoreListingContent(
  parentContent: ListingContentRow | null,
  childContents: ListingContentRow[],
  scoringCtx: ScoringContext
): SeoScore {
  const issues: SeoIssue[] = []
  let titleScore   = 25
  let bulletScore  = 25
  let keywordScore = 25
  let aplusScore   = 25
  let descriptionScore = 25
  let featuresScore    = 25
  let overrideCount = 0

  // Use parent content if available, otherwise best child (most bullets)
  const representativeContent = parentContent ||
    childContents.sort((a, b) => {
      const aBullets = [a.bullet_1,a.bullet_2,a.bullet_3,a.bullet_4,a.bullet_5].filter(Boolean).length
      const bBullets = [b.bullet_1,b.bullet_2,b.bullet_3,b.bullet_4,b.bullet_5].filter(Boolean).length
      return bBullets - aBullets
    })[0]

  if (!representativeContent) {
    return { title_score: 0, bullet_score: 0, keyword_score: 0, aplus_score: 0, description_score: 0, features_score: 0, overall_score: 0, issues: [{ field: 'general', severity: 'critical', message: 'No listing content found — run Scan Listings to fetch data from Amazon.', auto_fixable: false }], child_override_count: 0 }
  }

  // ── 1. TITLE SCORING ──────────────────────────────────────────────────────
  // Score the seller-entered base title, not a single child's Amazon-suffixed title
  // (" -Light Green-XX-Large"), which inflated the count and read as "the child title".
  const title = sellerBaseTitle(representativeContent.title || '', childContents)
  const apparel = titleLooksApparel(title)
  if (!title) {
    titleScore = 0
    issues.push({ field: 'title', severity: 'critical', message: 'Title is missing entirely. Go to Seller Central → Edit Listing → Vital Info. Lead with your brand, then your design/product name, then your top keyword. Aim ≤75 chars — Amazon\'s new title limit (effective July 27, 2026; all categories except media).', auto_fixable: false })
  } else {
    const titleLen = title.length

    if (titleLen < 50) {
      titleScore -= 10
      issues.push({ field: 'title', severity: 'warning', message: `Title is only ${titleLen} chars — too short to carry meaningful keywords. Aim 50-75 chars: brand + design/product name + your top keyword (Amazon's new ≤75 limit, July 27, 2026).`, auto_fixable: false })
    } else if (titleLen > 75) {
      // SCALED LENGTH PENALTY (PO 2026-06-14: a 200-char title scoring 18/22 means a human
      // team will never go fix it — anything that doesn't make the title optimized SHOULD
      // affect the score). The Amazon July-2026 hard cap is 75 chars; anything over loses
      // SEO control AND chars are not free (every extra word past 75 is one Amazon will
      // auto-rewrite, undoing the keyword anchoring).
      // Curve: -5 base for crossing the cap + 1 extra penalty per 10 chars past 75, MAX -20.
      // 76 chars: -5  (still fixable in seconds)
      // 100 chars: -7 ("warning, ship a draft today")
      // 150 chars: -12 ("clearly too long — fix this week")
      // 200 chars: -17 ("title is half spam — fix NOW")
      // 230+ chars: -20 ("the title is the listing's biggest problem")
      const overage = titleLen - 75
      const penalty = Math.min(20, 5 + Math.floor(overage / 10))
      titleScore -= penalty
      const severity: 'warning' | 'critical' = titleLen > 150 ? 'critical' : 'warning'
      const action = titleLen > 200
        ? `is EGREGIOUSLY long (${titleLen} chars). Amazon's 200-char hard limit puts you at suppression risk — fix immediately by trimming redundant phrases.`
        : titleLen > 150
          ? `is ${titleLen} chars — far over Amazon's 75-char limit (effective July 27, 2026). Amazon will AUTO-REWRITE it, undoing your SEO. Regenerate now for a compliant ≤75-char draft.`
          : `is ${titleLen} chars — over Amazon's 75-char limit (effective July 27, 2026). Amazon will AUTO-REWRITE the title, undoing the keyword + design-name anchoring. Regenerate for a compliant ≤75-char draft; move the extra detail into the 125-char Item Highlights field.`
      issues.push({ field: 'title', severity, message: `Title ${action}`, auto_fixable: false })
    }

    // ALL CAPS check — the message says brand names + technical acronyms are exempt;
    // here we actually exempt them. Brand name comes from scoringCtx (resolved from
    // settings / recommendation row). Tech acronyms: any token ≤6 chars or containing
    // a non-letter — covers UHS-I, DSLR, USB, HDMI, OLED, 4K, USB-C, etc. What's left
    // is promotional spam ("CHEAPEST", "AMAZING", "LOWEST") which we DO want to flag.
    const brandTokens = new Set(
      (scoringCtx.brandName ?? '').split(/\s+/).filter(Boolean).map((t) => t.toUpperCase())
    )
    const capsWords = title.split(' ').filter((w) => {
      if (w.length <= 2) return false
      if (w !== w.toUpperCase()) return false
      if (!/[A-Z]/.test(w)) return false
      // Strip trailing punctuation for the comparison ("CEO," still matches brand "CEO").
      const stripped = w.replace(/[^\w-]+$/, '')
      if (brandTokens.has(stripped.toUpperCase())) return false  // brand name parts: exempt
      if (isLegitCapsToken(stripped)) return false                // UHS-I / DSLR / HDMI / 4K: exempt
      return true                                                 // promotional spam: counts
    })
    if (capsWords.length > 2) {
      titleScore -= 5
      const exampleFix = capsWords.slice(0, 3).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(', ')
      issues.push({ field: 'title', severity: 'warning', message: `Title has ${capsWords.length} ALL CAPS words (${capsWords.slice(0, 3).join(', ')}) — Amazon policy flags 3+ caps words and can suppress the listing. Change to Title Case: e.g. "${exampleFix}". Only brand names and acronyms (e.g. UHS-I, SDHC) are allowed in caps.`, auto_fixable: false })
    }

    // Forbidden characters
    if (/[!?$%^*]/.test(title)) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: 'Title contains special characters (!, ?, $, %, ^, or *) which violate Amazon style guidelines and can trigger suppression. Remove them — use plain descriptive language instead. Commas, dashes, and pipes (|) are allowed.', auto_fixable: false })
    }

    // Check if primary keyword appears in first 5 words (title front-loading)
    const titleWords = title.split(' ')
    if (titleWords.length > 8) {
      const firstFive = titleWords.slice(0, 5).join(' ').toLowerCase()
      // Flag if the title starts with brand name and no product type keyword
      if (/^the ceo/i.test(title) && !/\b(card|shirt|mug|notebook|tee|notes|sticky|coffee|memory|sticker|hat|hoodie|bag)\b/i.test(firstFive)) {
        titleScore -= 3
        issues.push({ field: 'title', severity: 'info', message: 'Title leads with brand name but the product-type keyword appears later. Amazon weights the first 5 words most heavily. Consider restructuring: "[Product Type] [Key Attribute] – [Brand Name] [Additional Details]". Example: "128GB SD Card Ultra High Speed – THE CEO Memory Card UHS-I 90MB/s for Camera"', auto_fixable: false })
      }
    }
  }

  // ── 1b. TITLE KEYWORD INTELLIGENCE (capped to top 10 UPGRADE keywords) ───────
  // UPGRADE keywords = present in bullets but NOT in title (should be promoted).
  // Capped to top 10 by opportunity score — these are the ones worth acting on.
  // Apparel titles are DESIGN-LED, not keyword-stuffed — upgrade keywords belong in bullets/backend,
  // not crammed into the title. Docking the apparel title for "missing" upgrade keywords is exactly
  // what drove the stuffing the design-grounded title agent now avoids, and it re-triggered the "ship"
  // nag on an otherwise-clean title. So skip this penalty for apparel. Non-apparel keeps it (specs like
  // 256GB / UHS-I genuinely ARE title search terms there).
  if (!apparel && scoringCtx.totalKeywords > 0 && scoringCtx.upgradeCount > 0) {
    const kwList = scoringCtx.topUpgradeKeywords.slice(0, 3).map(k => `"${k}"`).join(', ')
    if (scoringCtx.upgradeCount >= 7) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: `Keyword Intelligence: ${scoringCtx.upgradeCount} of your top keywords appear in bullets but NOT in your title. Top opportunities to add to title: ${kwList}. Amazon weights title keywords 3-5x more than bullets — adding even 2 of these would improve your search ranking.`, auto_fixable: false })
    } else if (scoringCtx.upgradeCount >= 3) {
      titleScore -= 3
      issues.push({ field: 'title', severity: 'info', message: `Keyword Intelligence: ${scoringCtx.upgradeCount} keywords are in your bullets but missing from your title: ${kwList}. Adding 1-2 of these to your title would capture more search traffic.`, auto_fixable: false })
    }
  }
  titleScore = Math.max(0, titleScore)

  // ── 2. BULLET SCORING ─────────────────────────────────────────────────────
  const bullets = [
    representativeContent.bullet_1,
    representativeContent.bullet_2,
    representativeContent.bullet_3,
    representativeContent.bullet_4,
    representativeContent.bullet_5,
  ].filter(Boolean) as string[]

  const bulletCount = bullets.length
  if (bulletCount === 0) {
    bulletScore = 0
    issues.push({ field: 'bullets', severity: 'critical', message: 'No bullet points found. Go to Seller Central → Edit Listing → Product Description. Add 5 bullets. Format: Lead with the BENEFIT in caps (e.g. "FAST TRANSFER SPEEDS –"), then explain the feature in plain language. Each bullet should be 100-200 chars and include secondary keywords naturally.', auto_fixable: false })
  } else {
    if (bulletCount < 5) {
      bulletScore -= 10
      issues.push({ field: 'bullets', severity: 'warning', message: `Only ${bulletCount}/5 bullets used — you are leaving ${5 - bulletCount} keyword slots empty. Add bullet(s) covering: compatibility with specific devices, warranty/guarantee, gift-readiness, or a comparison to alternatives. Each bullet Amazon indexes independently for search.`, auto_fixable: false })
    }

    // Short bullets
    const shortBullets = bullets.filter(b => b.length < 100)
    if (shortBullets.length > 0) {
      bulletScore -= Math.min(15, shortBullets.length * 5)
      issues.push({ field: 'bullets', severity: 'warning', message: `${shortBullets.length} bullet(s) are under 100 chars — too thin to rank well. Expand each one: add the "so that" benefit ("90MB/s read speed so you never miss a shot during burst photography"), mention compatible devices, and weave in long-tail keywords like "for Canon EOS" or "for GoPro Hero".`, auto_fixable: false })
    }

    // Check for benefit-led format (CAPS lead)
    const noBenefitLead = bullets.filter(b => !/^[A-Z]{2,}/.test(b.trim()))
    if (noBenefitLead.length >= 3) {
      bulletScore -= 3
      issues.push({ field: 'bullets', severity: 'info', message: `${noBenefitLead.length} bullets don't start with a capitalized benefit hook. Amazon shoppers scan bullets fast — lead each one with a 2-4 word benefit in CAPS followed by a dash: "FAST TRANSFER SPEEDS –", "UNIVERSAL COMPATIBILITY –", "LIFETIME WARRANTY –". This improves click-through and conversion.`, auto_fixable: false })
    }

    // Opportunity-keyword coverage — the real reason a well-formed bullet still gets flagged for
    // REPLACE: it misses the product's top opportunity keywords (what the AI rewrite weaves in).
    // Without this, mechanically-perfect bullets score 25/25 while the action plan says "replace".
    // SEASONAL keywords are EXCLUDED — they belong in backend, not bullets (product strategy), so a
    // missing seasonal term must not dock the bullets. Coverage is TOKEN-based (consistent with the
    // keyword-intelligence check below), so a natural paraphrase counts: bullets saying "see you later
    // alligator vibe" cover the keyword "see you later alligator shirt" (every token present across the
    // bullets). The old exact-substring check missed paraphrases and pinned good bullets at a low score.
    // #93 — when the persisted/injected KeywordPlan is present, dock bullets against the generator's EXACT
    // target set (topOpportunityKwsForBullets), so the scorer's universe == the generator's by SOURCE — not
    // just via the shared coverage predicate. This closes the residual source/relevance-gate/title-exclusion
    // divergence. Absent/empty plan → fall back to the legacy DB derivation, capped to <=6 words to match the
    // generator's pool (the #160 alignment). Seasonal stays excluded on BOTH paths (belt-and-suspenders — the
    // generator already strips seasonal from its pool).
    // CAPACITY-FAMILY guard: when the children span ≥2 distinct GB/TB capacities, broadcast
    // bullets can never carry a capacity keyword ("128 gb sd card") — the generator's
    // capacity validator + the backstop's safeKw refuse it because a hardcoded capacity
    // would mis-describe the sibling variants. Don't dock bullets for keywords the system
    // itself must refuse (B0GCF11RKL froze at 17/25 AFTER shipping the recommended bullets).
    // Applied to BOTH paths so plans persisted before the pipeline-side filter (and the
    // legacy fallback) heal on the next re-score. KEEP IN SYNC with CAPACITY_RE/capacityOf
    // in listingPipeline ("32G"/"64G." → 32GB/64GB).
    const capRe = /\b(\d{1,4})\s?(t|g)b?\b/i
    const familyCaps = new Set<string>()
    for (const c of childContents) {
      const m = `${c.sku ?? ''} ${c.title ?? ''}`.match(/\b(\d{1,4})\s?(t|g)b?\b/gi)
      for (const x of m ?? []) familyCaps.add(x.toUpperCase().replace(/[^0-9TG]/g, '') + 'B')
    }
    const isCapacityFamily = familyCaps.size >= 2
    // COLOR sibling of the capacity guard: on a MULTI-variant apparel family the broadcast
    // bullets are shared across every color, so a keyword carrying one specific color
    // ("plain black tshirt men") can never be woven — don't dock for it. Per-child backend
    // keeps the color terms. KEEP IN SYNC with BASIC_COLOR_RE in listingPipeline.
    const colorRe = /\b(?:black|white|navy|red|blue|green|grey|gray|pink|purple|yellow|orange|brown|tan|teal|maroon|burgundy|charcoal|ivory|beige|olive|mint|coral|lavender|mustard|rust|sage|cream)\b/i
    const isColorNeutralFamily = apparel && childContents.length > 1
    const bulletOppKw = ((scoringCtx.bulletPlanKeywords && scoringCtx.bulletPlanKeywords.length > 0)
      ? scoringCtx.bulletPlanKeywords.filter((k) => !isSeasonalKw(k))
      : [...scoringCtx.topCriticalKeywords, ...scoringCtx.topUpgradeKeywords]
          .filter((k) => !isSeasonalKw(k))
          .filter((k) => k.split(/\s+/).length <= 6)
    ).filter((k) => !isCapacityFamily || !capRe.test(k))
     .filter((k) => !isColorNeutralFamily || !colorRe.test(k))
    if (bulletOppKw.length > 0) {
      // Shared predicate — identical to the bullet validator + the deterministic backstop, so the
      // generator covers exactly what the scorer docks for (no more 9/18 from rulebook divergence).
      const missingOpp = missingBulletKeywords(bullets, bulletOppKw)
      if (missingOpp.length >= 2) {
        bulletScore -= Math.min(12, missingOpp.length * 2)
        issues.push({ field: 'bullets', severity: 'warning', message: `Your bullets miss ${missingOpp.length} high-opportunity keyword(s) — e.g. ${missingOpp.slice(0, 3).map(k => `"${k}"`).join(', ')}. The AI rewrite weaves these in (seasonal terms are excluded — those belong in backend).`, auto_fixable: false })
      }
    }

    // Check for keyword density — bullets should cover different topics
    if (bulletCount >= 3) {
      const allBulletText = bullets.join(' ').toLowerCase()
      const titleTokens = tokenize(title)
      const bulletTokens = tokenize(allBulletText)
      // Variant attributes and brand fragments that appear in titles but are NOT
      // semantic keywords worth repeating in bullets (sizes, colors, brand names)
      const variantStopWords = new Set([
        'alpha', 'large', 'small', 'medium', 'regular', 'slim', 'relaxed', 'fitted',
        'white', 'black', 'ivory', 'blue', 'green', 'red', 'yellow', 'pink',
        'purple', 'orange', 'brown', 'grey', 'gray', 'navy', 'cream', 'beige',
        'comfort', 'colors', 'hanes', 'gildan', 'bella', 'canvas', 'fruit',
        'loom', 'shirt', 'shirts', 'tshirt', 'adult', 'unisex', 'women', 'womens',
      ])
      // Find title keywords NOT covered in bullets (missed opportunities)
      const titleOnlyKeywords = [...titleTokens].filter(w => !bulletTokens.has(w) && w.length > 4 && !variantStopWords.has(w))
      if (titleOnlyKeywords.length > 3) {
        bulletScore -= 3
        issues.push({ field: 'bullets', severity: 'info', message: `Bullets are missing ${titleOnlyKeywords.length} keywords from your title (e.g. "${titleOnlyKeywords.slice(0,3).join('", "')}""). Weave these into your bullets — Amazon cross-references title and bullet keywords to determine relevance. Missing overlap = lower ranking for those terms.`, auto_fixable: false })
      }
    }
  }
  bulletScore = Math.max(0, bulletScore)

  // ── 3. DESCRIPTION SCORING (own /25 card) ─────────────────────────────────
  // Description is its own score now (these deductions used to fold into keyword_score).
  // NOTE: Read A+ status early so we can use it in description scoring below
  const hasAplusEarly = representativeContent.has_aplus
  const description = representativeContent.description || ''
  const descPlain = stripHtml(description)
  const descLen = descPlain.length

  if (!description || descLen < 50) {
    if (hasAplusEarly) {
      // A+ replaces the text description for most branded listings — do not penalize
      issues.push({ field: 'description', severity: 'info', message: 'This listing uses A+ Content instead of a plain-text description (common for branded/apparel products). That is fine — A+ modules replace the description slot. Ensure your A+ modules contain keyword-rich text in every image alt field and text block, as Amazon indexes all of it. If you later add a plain-text description, keep it short (under 200 chars) to avoid duplicating A+ content.', auto_fixable: false })
    } else {
      descriptionScore -= 8
      issues.push({ field: 'description', severity: 'warning', message: 'Product description is empty or missing. Go to Seller Central → Edit Listing → Product Description. Write 200-2000 chars of keyword-rich prose (NOT bullets). Amazon indexes this separately from bullets. Include: use cases, target audience, technical specs, and long-tail keywords that don\'t fit in the title. HTML formatting (<b>, <br>, <ul>) is allowed and improves readability.', auto_fixable: false })
    }
  } else if (descLen < 200) {
    descriptionScore -= 4
    issues.push({ field: 'description', severity: 'info', message: `Description is only ${descLen} chars — expand to 500-2000 chars. Amazon indexes the full description text. Add: a brand story paragraph, technical specifications table, compatibility list (specific device models), FAQ-style content ("Works with Canon EOS R5, R6, 5D Mark IV"), and use-case scenarios. More indexed text = more long-tail search coverage.`, auto_fixable: false })
  } else if (descLen > 2000) {
    issues.push({ field: 'description', severity: 'info', message: `Description is ${descLen} chars — Amazon truncates display at ~2000 chars but indexes the full text. Ensure your most important keywords and CTAs appear in the first 2000 chars. Move technical specs and compatibility lists to the end.`, auto_fixable: false })
  }

  // ── 3b. DESCRIPTION KEYWORD QUALITY ───────────────────────────────────────
  // If description exists and is substantial, check if it overlaps with title keywords.
  // A description that doesn't reinforce title keywords is a missed SEO opportunity.
  if (descLen >= 200 && title) {
    const descTokens = tokenize(descPlain)
    const titleTokensForDesc = tokenize(title)
    const descTitleOverlap = [...titleTokensForDesc].filter(w => descTokens.has(w) && w.length > 4)
    // If description doesn't share at least 3 keywords with title, it's not reinforcing SEO
    if (descTitleOverlap.length < 3) {
      descriptionScore -= 3
      issues.push({ field: 'description', severity: 'info', message: `Description shares only ${descTitleOverlap.length} keywords with your title. Amazon cross-indexes title and description — a description that reinforces title keywords boosts relevance. Weave your primary keywords naturally into the description prose.`, auto_fixable: false })
    }
  }

  // ── 3c. DESCRIPTION KEYWORD COVERAGE (PO 2026-06-15 "GO description-scoring") ──────────────
  // A stale description that misses the CURRENT high-opportunity keywords (e.g. a pre-soccer
  // description on a now-soccer listing) used to still score 25/25 — length + title-overlap were
  // the only checks — so the verdict marked it DONE / "no change needed" and NEVER prompted the
  // seller to ship the freshly-optimized copy. Dock by how many of the top CRITICAL/UPGRADE phrases
  // the live description is MISSING, so a stale one drops below the 'strong/DONE' convergence
  // threshold and the section becomes actionable ("ship the optimized description").
  if (descLen >= 50) {
    const targetKws = [...scoringCtx.topCriticalKeywords, ...scoringCtx.topUpgradeKeywords].slice(0, 8)
    if (targetKws.length >= 3) {
      const descLower = descPlain.toLowerCase()
      const missingKws = targetKws.filter((k) => !descLower.includes(k.toLowerCase()))
      const coverage = (targetKws.length - missingKws.length) / targetKws.length
      if (coverage < 0.5) {
        // Misses most current high-value terms → stale / under-optimized. Dock enough to fall below
        // the strong (>=23/25) convergence so the verdict stops saying "no change needed".
        descriptionScore -= Math.min(8, 3 + missingKws.length)
        issues.push({ field: 'description', severity: 'warning', message: `Description covers only ${targetKws.length - missingKws.length}/${targetKws.length} of your current high-opportunity keywords — it looks stale or under-optimized. Ship the optimized description below to weave in: ${missingKws.slice(0, 3).map((k) => `"${k}"`).join(', ')}.`, auto_fixable: false })
      } else if (coverage < 0.8) {
        descriptionScore -= 3
        issues.push({ field: 'description', severity: 'info', message: `Description covers ${targetKws.length - missingKws.length}/${targetKws.length} top keywords — a few high-opportunity terms are missing. Shipping the optimized version would capture them.`, auto_fixable: false })
      }
    }
  }

  descriptionScore = Math.max(0, descriptionScore)

  // ── 4. BACKEND KEYWORD SCORING ────────────────────────────────────────────
  const keywords = representativeContent.backend_keywords || ''
  const kwLen = keywords.length

  if (kwLen === 0) {
    keywordScore -= 10
    issues.push({ field: 'backend_keywords', severity: 'critical', message: `Backend keywords field is completely empty — this is 250 chars of free indexing you are not using. Go to Seller Central → Edit Listing → Keywords tab. Fill with space-separated terms NOT already in your title or bullets: misspellings, synonyms, competitor brand names (generic terms only), and long-tail phrases. Example: "micro sd card 128gb class 10 high speed memory card for camera drone dashcam"`, auto_fixable: false })
  } else if (kwLen < 100) {
    keywordScore -= 8
    issues.push({ field: 'backend_keywords', severity: 'warning', message: `Backend keywords only ${kwLen}/250 chars — ${250 - kwLen} chars of free indexing wasted. Add terms NOT in your title: common misspellings, related use cases, compatible device models, and gift search terms like "gifts for photographers". No commas, no repetition of title words.`, auto_fixable: false })
  } else if (kwLen < 200) {
    keywordScore -= 4
    const backendExamples = apparel
      ? 'occasion & audience terms ("gift for mom", "bachelorette party"), seasonal terms ("last day of school", "summer"), color/style synonyms, and common misspellings'
      : 'long-tail variants, synonyms, seasonal terms ("holiday gift", "back to school"), and common misspellings of your product category'
    issues.push({ field: 'backend_keywords', severity: 'info', message: `Backend keywords at ${kwLen}/250 chars — ${250 - kwLen} chars still available. Use them for: ${backendExamples} — terms not already in your title or bullets.`, auto_fixable: false })
  }

  // Over-limit check: Amazon silently truncates at 250 bytes
  const kwByteLen = new TextEncoder().encode(keywords).length
  if (kwByteLen > 250) {
    keywordScore -= 5
    issues.push({ field: 'backend_keywords', severity: 'warning', message: `Backend keywords are ${kwByteLen}/250 bytes — OVER the Amazon limit by ${kwByteLen - 250} bytes. Amazon silently truncates at 250 bytes, so your trailing keywords are being ignored. Trim the least-important terms from the end to fit within 250 bytes.`, auto_fixable: false })
  }

  // Commas waste space
  if (keywords.includes(',')) {
    keywordScore -= 3
    issues.push({ field: 'backend_keywords', severity: 'info', message: 'Backend keywords contain commas — Amazon treats commas as characters, not separators, wasting space. Remove all commas and use spaces only. "128gb, sd card" → "128gb sd card" saves 2 chars per term and recovers keyword slots.', auto_fixable: false })
  }

  // Title-overlap dock RETIRED (was -3 when backend repeated >3 title words): the seller's
  // CHOSEN backend strategy is HYBRID — the generator deliberately includes the TOP search
  // phrases even when they appear in the title ("utilize the best Jungle Scout terms"), so
  // this dock fired on essentially every listing and contradicted the strategy (the #188
  // trap-class: never dock for what the generator is designed to do). Whole-phrase backend
  // entries also reinforce exact-phrase matching, so the "wasted space" premise was shaky.
  // No issue row either — telling the seller to remove strategy-mandated terms is noise.

  // Image count check
  const imageCount = representativeContent.image_count || 0
  if (imageCount > 0 && imageCount < 7) {
    keywordScore -= 3
    issues.push({ field: 'images', severity: 'warning', message: `Only ${imageCount}/7 product images uploaded. Amazon allows 7 images — each additional image increases conversion rate. Add: lifestyle photos (product in use), infographic images (specs/features), size comparison photos, and a white-background hero variant. Listings with 7 images convert 25-40% better than those with 3-4.`, auto_fixable: false })
  } else if (imageCount === 0) {
    keywordScore -= 5
    issues.push({ field: 'images', severity: 'warning', message: 'No product images detected. Upload at least 7 images in Seller Central → Edit Listing → Images. Required: 1 white-background hero (1000x1000px minimum for zoom), 3-4 lifestyle shots, 1-2 infographic images with key specs highlighted.', auto_fixable: false })
  }

  // ── 4b. KEYWORD INTELLIGENCE → KEYWORD SCORE (capped to top 10 CRITICAL) ────
  // CRITICAL keywords = high-value search terms completely missing from your listing.
  // Capped to top 10 by opportunity score — these are the actionable ones.
  // Thresholds: 7+/10 = critical (-8), 4-6/10 = warning (-5), 1-3/10 = info (-3)
  if (scoringCtx.totalKeywords > 0 && scoringCtx.criticalCount > 0) {
    const kwList = scoringCtx.topCriticalKeywords.slice(0, 5).map(k => `"${k}"`).join(', ')
    if (scoringCtx.criticalCount >= 7) {
      keywordScore -= 8
      issues.push({ field: 'keyword_intelligence', severity: 'critical', message: `Keyword Intelligence: ${scoringCtx.criticalCount} of your top 10 highest-value keywords are completely missing from your listing. Add these to your title, bullets, or backend keywords: ${kwList}. These are search terms where shoppers are buying but you\'re invisible.`, auto_fixable: false })
    } else if (scoringCtx.criticalCount >= 4) {
      keywordScore -= 5
      issues.push({ field: 'keyword_intelligence', severity: 'warning', message: `Keyword Intelligence: ${scoringCtx.criticalCount} of your top 10 keywords are missing from your listing. Priority keywords to add: ${kwList}. Open the Keywords tab for the full list with placement recommendations.`, auto_fixable: false })
    } else if (scoringCtx.criticalCount >= 1) {
      keywordScore -= 3
      issues.push({ field: 'keyword_intelligence', severity: 'info', message: `Keyword Intelligence: ${scoringCtx.criticalCount} keyword gap(s) found. Add to your backend keywords or bullets: ${kwList}.`, auto_fixable: false })
    }
  }

  keywordScore = Math.max(0, keywordScore)

  // ── 4c. CROSS-SECTION DESIGN-NAME COHESION (#92) ──────────────────────────────────
  // The seller's design name (e.g. "Later Gator") anchors the title. If it anchors the title but is
  // token-missing from the live bullets or live backend, the listing under-indexes its own hook — dock the
  // section that dropped it. The design name comes from the persisted KeywordPlan (the REAL extractDesignName
  // output), NEVER a title heuristic (a heuristic is capacity-unsafe — it would read "64GB" as the design
  // name on an SD-card family). No-ops for generic/non-apparel (planDesignName '' or absent). Uses the shared
  // token predicate so "later-gator" / "Later, Gator!" count as present (no false dock on punctuation). The
  // dock is PURELY ADDITIVE (it never raises a score and never marks anything DONE — it can only push a
  // section away from the DONE threshold, never toward it).
  const designName = (scoringCtx.planDesignName ?? '').trim()
  if (designName) {
    const inTitle = missingBulletKeywords([title], [designName]).length === 0
    if (inTitle) {   // only enforce cohesion when the design genuinely anchors the title
      // DEDUPE (adversarial-review): if the design name is already OWNED by a bullet-opportunity keyword,
      // the #93 coverage dock above ALREADY charges its tokens when they're missing from the bullets — so
      // skip the bullet cohesion dock here to avoid penalizing ONE missing fact twice on bullet_score ("two
      // levers, one number", the pattern that got the prior Option-C gate reverted). The BACKEND dock has no
      // such overlap (the #93 dock is bullets-only), so it stays unconditional. Recomputed from ctx (the
      // bullet block's local bulletOppKw is out of scope here); broader-than-exact is safe — it only makes us
      // MORE likely to skip the bullet dock, never to dock wrongly.
      const oppSet = (scoringCtx.bulletPlanKeywords && scoringCtx.bulletPlanKeywords.length > 0)
        ? scoringCtx.bulletPlanKeywords
        : [...scoringCtx.topCriticalKeywords, ...scoringCtx.topUpgradeKeywords]
      const designOwnedByOppSet = oppSet.some((k) => missingBulletKeywords([k], [designName]).length === 0)
      if (!designOwnedByOppSet && missingBulletKeywords([bullets.join(' ')], [designName]).length > 0) {
        bulletScore = Math.max(0, bulletScore - 4)
        issues.push({ field: 'bullets', severity: 'warning', message: `Your design name "${designName}" anchors the title but is missing from your bullets — weave it into at least one bullet so every section reinforces the same hook (regenerate to fix automatically).`, auto_fixable: false })
      }
      if (missingBulletKeywords([keywords], [designName]).length > 0) {
        keywordScore = Math.max(0, keywordScore - 4)
        issues.push({ field: 'backend_keywords', severity: 'warning', message: `Your design name "${designName}" anchors the title but is missing from your backend search terms — add it to every child's backend keywords (regenerate to fix automatically).`, auto_fixable: false })
      }
    }
  }

  // ── 5. A+ CONTENT SCORING ─────────────────────────────────────────────────────
  const hasAplus      = hasAplusEarly  // already read above for description check
  const missingAlt    = representativeContent.aplus_images_missing_alt
  const moduleCount   = representativeContent.aplus_module_count || 0
  const hasBrandStory = representativeContent.aplus_has_brand_story
  const hasHeadline   = representativeContent.aplus_has_headline

  if (!hasAplus) {
    aplusScore = 0
    issues.push({ field: 'aplus', severity: 'critical', message: 'No A+ Content detected. Go to sellercentral.amazon.com/enhanced-content/content-manager and create a Standard A+ page. Minimum: 1 hero image module + 3 feature image/text modules + 1 comparison chart. Listings with A+ convert 3-10% better, and that higher conversion lifts organic rank indirectly. This is the single highest-ROI improvement you can make.', auto_fixable: false })
  } else {
    if (moduleCount > 0 && moduleCount < 5) {
      aplusScore -= 8
      issues.push({ field: 'aplus', severity: 'warning', message: `A+ page has only ${moduleCount} module(s) — Amazon allows up to 7 standard modules. Add: a comparison chart (shows your variants side-by-side and blocks competitor switching), a size/fit chart, and a fabric/feature module. More modules lift conversion rate and page dwell time. Note: A+ body copy is not a confirmed search-ranking field — fill the image ALT-TEXT on each module, which Amazon does use for discoverability.`, auto_fixable: false })
    }
    if (!hasBrandStory) {
      aplusScore -= 7
      issues.push({ field: 'aplus', severity: 'warning', message: 'No Brand Story (EMC) module found. Add a Brand Story at sellercentral.amazon.com/enhanced-content/content-manager — it auto-appears on ALL your ASINs, builds brand recognition, and links shoppers to your full catalog. Takes 30 minutes to create and runs on every listing forever.', auto_fixable: false })
    }
    if (!hasHeadline) {
      aplusScore -= 5
      issues.push({ field: 'aplus', severity: 'info', message: 'A+ page is missing a header/headline module. Add one as the first module — it should reinforce your primary keyword and brand positioning (e.g. "Professional-Grade Storage for Serious Creators"). It anchors the page and signals quality to shoppers.', auto_fixable: false })
    }
    if (missingAlt > 0) {
      aplusScore -= 5
      issues.push({ field: 'aplus', severity: 'warning', message: `${missingAlt} A+ image(s) have no alt text (image keywords). In A+ Content Manager, edit each image module and fill the "Image Keywords" field with descriptive terms (e.g. "128gb sd card high speed class 10 for canon camera"). Amazon indexes these for search — missing alt text = missing keyword coverage on your highest-converting page section.`, auto_fixable: false })
    }
  }
  // ── 5b. FEATURES — PRODUCT DETAILS COMPLETENESS (own /25 card) ────────────
  // The structured product-detail specs (Material, Brand-compatibility, Capacity, speed class…).
  // These deductions used to fold into aplus_score; they are now their own Features score.
  // Product Details are indexed by Amazon and power filtered search + comparison tables.
  if (scoringCtx.productDetailsGaps > 0) {
    if (scoringCtx.productDetailsGaps >= 5) {
      featuresScore -= 5
      const detailExamples = apparel ? 'Material, Fabric Type, Fit Type, Department' : 'Material, Color, Size, Department'
      issues.push({ field: 'product_details', severity: 'warning', message: `We recommend confirming or refining ${scoringCtx.productDetailsGaps} product-detail values (e.g. ${detailExamples}) — these power Amazon\'s filtered search + comparison tables. Many may already be set; the AI Recommendations tab shows the suggested value for each so you can confirm or refine it.`, auto_fixable: false })
    } else if (scoringCtx.productDetailsGaps >= 3) {
      featuresScore -= 3
      issues.push({ field: 'product_details', severity: 'info', message: `${scoringCtx.productDetailsGaps} Product Detail fields could be improved. Check the AI Recommendations tab for specific suggestions — each completed field improves your visibility in Amazon\'s filtered search results.`, auto_fixable: false })
    }
  }

  featuresScore = Math.max(0, featuresScore)
  aplusScore = Math.max(0, aplusScore)

  // ── 6. CHILD CANNIBALIZATION DETECTION ────────────────────────────────────
  if (childContents.length > 1) {
    // Check for duplicate titles across children (cannibalizing each other)
    const titleMap = new Map<string, string[]>()
    for (const child of childContents) {
      if (!child.title) continue
      const normalizedTitle = child.title.toLowerCase().trim()
      if (!titleMap.has(normalizedTitle)) titleMap.set(normalizedTitle, [])
      titleMap.get(normalizedTitle)!.push(child.sku)
    }
    const duplicateTitles = [...titleMap.entries()].filter(([, skus]) => skus.length > 1)
    if (duplicateTitles.length > 0) {
      const totalDupes = duplicateTitles.reduce((sum, [, skus]) => sum + skus.length, 0)
      issues.push({
        field:        'child_overrides',
        severity:     'warning',
        message:      `${totalDupes} variants share identical titles — they are cannibalizing each other in search. Amazon treats each child ASIN as a separate listing for indexing. Each variant should have a unique title that includes its differentiating attribute (e.g. "THE CEO Memory Card 128GB" vs "THE CEO Memory Card 64GB" vs "THE CEO Memory Card 32GB"). Go to Seller Central → Manage Inventory → Edit each variant individually.`,
        auto_fixable: false,
      })
    }

    // Check for children with better content than parent
    if (parentContent) {
      const parentBullets = [parentContent.bullet_1,parentContent.bullet_2,parentContent.bullet_3,parentContent.bullet_4,parentContent.bullet_5].filter(Boolean).length
      const childrenWithMoreBullets = childContents.filter(c => {
        const cBullets = [c.bullet_1,c.bullet_2,c.bullet_3,c.bullet_4,c.bullet_5].filter(Boolean).length
        return cBullets > parentBullets
      })
      if (childrenWithMoreBullets.length > 0) {
        issues.push({
          field:        'child_overrides',
          severity:     'info',
          message:      `${childrenWithMoreBullets.length} child variant(s) have MORE bullet points than the parent listing (${parentBullets} bullets). The parent listing is the "master" — copy the best child's bullets up to the parent. In Seller Central, edit the parent ASIN directly and paste the best-performing child's content.`,
          auto_fixable: false,
        })
      }

      // Check for children with different descriptions (description cannibalization)
      const parentDesc = (parentContent.description || '').toLowerCase().trim()
      const childrenWithDiffDesc = childContents.filter(c => {
        const cDesc = (c.description || '').toLowerCase().trim()
        return cDesc && cDesc !== parentDesc
      })
      if (childrenWithDiffDesc.length > 0) {
        overrideCount += childrenWithDiffDesc.length
        const exDesc = childrenWithDiffDesc[0]
        issues.push({
          field:        'child_overrides',
          severity:     'warning',
          message:      `${childrenWithDiffDesc.length} variant(s) have a description that differs from the parent listing (e.g. SKU "${exDesc.sku}"). Child-level description overrides fragment your keyword coverage — Amazon indexes each ASIN\'s description separately. Standardize: copy the best description to the parent and remove child-level overrides. Go to Seller Central → Edit each variant → Product Description.`,
          auto_fixable: false,
        })
      }

      // Check for children with different backend keywords (keyword fragmentation)
      const parentKw = (parentContent.backend_keywords || '').toLowerCase().trim()
      const childrenWithDiffKeywords = childContents.filter(c => {
        const cKw = (c.backend_keywords || '').toLowerCase().trim()
        return cKw && cKw !== parentKw
      })
      if (childrenWithDiffKeywords.length > 0) {
        overrideCount += childrenWithDiffKeywords.length
        issues.push({
          field:        'child_overrides',
          severity:     'warning',
          message:      `${childrenWithDiffKeywords.length} variant(s) have different backend keywords from the parent — this fragments your keyword coverage across ASINs instead of concentrating it. Standardize: copy the best keyword set to ALL variants and the parent. Go to Seller Central → Edit each variant → Keywords tab.`,
          auto_fixable: false,
        })
      }

      // Check for children with different titles from parent
      const parentTitle = (parentContent.title || '').toLowerCase().trim()
      const childrenWithDiffTitles = childContents.filter(c => {
        const cTitle = (c.title || '').toLowerCase().trim()
        return cTitle && cTitle !== parentTitle
      })
      if (childrenWithDiffTitles.length > 0) {
        overrideCount += childrenWithDiffTitles.length
        const example = childrenWithDiffTitles[0]
        const exampleTitle = example.title || ''
        issues.push({
          field:        'child_overrides',
          severity:     'warning',
          message:      `${childrenWithDiffTitles.length} variant(s) have titles that differ from the parent listing. Example: SKU "${example.sku}" has title "${exampleTitle.substring(0, 80)}...". Amazon shows child titles in search results — inconsistent titles confuse shoppers and split keyword authority. Sync all variant titles to follow the same template, differing only in the size/color/variant attribute.`,
          auto_fixable: false,
        })
      }
    }
  }

  // Importance-weighted overall. Each section's (score/25) is scaled by its weight; the weights
  // (scoreWeights.ts) SUM TO 100, so a perfect listing scores exactly 100 — no 150 ceiling, and a
  // weak-but-minor section costs fewer points than a weak critical one. The six weighted points
  // here are the same values the KPI cards display, so the cards add up to this number.
  const overall =
    weightedPoints(titleScore, SECTION_WEIGHTS.title) +
    weightedPoints(bulletScore, SECTION_WEIGHTS.bullets) +
    weightedPoints(keywordScore, SECTION_WEIGHTS.keyword) +
    weightedPoints(aplusScore, SECTION_WEIGHTS.aplus) +
    weightedPoints(descriptionScore, SECTION_WEIGHTS.description) +
    weightedPoints(featuresScore, SECTION_WEIGHTS.features)

  return {
    title_score:          titleScore,
    bullet_score:         bulletScore,
    keyword_score:        keywordScore,
    aplus_score:          aplusScore,
    description_score:    descriptionScore,
    features_score:       featuresScore,
    overall_score:        overall,
    issues,
    child_override_count: overrideCount,
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface SyncListingContentResult {
  parentsSynced:  number
  skusSynced:     number
  parentsScored:  number
  error:          string | null
  durationMs:     number
}

export async function syncListingContent(
  topN = 50
): Promise<SyncListingContentResult> {
  const start   = Date.now()
  const supabase = getAdminSupabase()

  let parentsSynced = 0
  let skusSynced    = 0
  let parentsScored = 0

  try {
    const token    = await getAccessToken()
    const sellerId = await getSellerId()

    // ── Step 1: Get top N parents by 30d sales ─────────────────────────────
    const { data: topParents, error: parentsErr } = await supabase
      .from('parent_asin_rollup')
      .select('parent_asin, total_units_30d, child_count, top_child_asin')
      .order('total_units_30d', { ascending: false })
      .limit(topN)

    if (parentsErr || !topParents || topParents.length === 0) {
      return { parentsSynced: 0, skusSynced: 0, parentsScored: 0, error: parentsErr?.message || 'No parents found', durationMs: Date.now() - start }
    }

    console.log(`[ListingContent] Syncing content for top ${topParents.length} parents`)

    for (const parent of topParents) {
      const parentAsin = parent.parent_asin

      // ── Step 2: Get all child SKUs for this parent ───────────────────────
      const { data: childRows } = await supabase
        .from('listing_health')
        .select('sku, asin, parent_asin')
        .eq('parent_asin', parentAsin)
        .eq('status', 'Active')
        .not('sku', 'ilike', 'amzn.gr.%')

      const children: ChildSku[] = childRows || []
      if (children.length === 0) continue

      // Deduplicate by ASIN — prefer FBA SKU
      const asinMap = new Map<string, ChildSku>()
      for (const child of children) {
        const existing = asinMap.get(child.asin)
        if (!existing || child.sku.endsWith('-FBA')) {
          asinMap.set(child.asin, child)
        }
      }
      const uniqueChildren = Array.from(asinMap.values())

      // ── Step 3: Fetch content for each child SKU ─────────────────────────
      const contentRows: ListingContentRow[] = []

      for (const child of uniqueChildren) {
        try {
          const content = await fetchListingContent(token, sellerId, child.sku, child.asin, parentAsin)
          // Fetch real image count from Catalog Items API (Listings Items API only returns mainImage)
          try {
            const imgCount = await fetchImageCount(token, child.asin)
            if (imgCount > 0) content.image_count = imgCount
            await sleep(100) // Catalog Items API: 2 req/sec burst
          } catch {
            // Non-fatal: keep whatever image_count was set from summaries
          }
          contentRows.push(content)
          skusSynced++
        } catch (err) {
          console.warn(`[ListingContent] Failed to fetch SKU ${child.sku}:`, err instanceof Error ? err.message : String(err))
        }
        // Rate limit: 5 req/sec → 200ms between requests
        await sleep(200)
      }

      if (contentRows.length === 0) continue

      // ── Step 4: Fetch A+ status using a child ASIN ─────────────────────────
      // A+ content is associated with child ASINs, not the parent ASIN.
      let aplusData: AplusStatus = { hasAplus: false, moduleCount: 0, missingAltCount: 0, hasBrandStory: false, hasHeadline: false }
      const firstChildAsin = uniqueChildren[0]?.asin || parentAsin
      try {
        aplusData = await fetchAplusStatus(token, firstChildAsin)
        // If first child returns nothing, try the parent ASIN as fallback
        if (!aplusData.hasAplus && firstChildAsin !== parentAsin) {
          const fallback = await fetchAplusStatus(token, parentAsin)
          if (fallback.hasAplus) aplusData = fallback
        }
        await sleep(100) // A+ API: 10 req/sec
      } catch (err) {
        console.warn(`[ListingContent] A+ fetch failed for ${parentAsin}:`, err instanceof Error ? err.message : String(err))
      }

      // Apply A+ data to all content rows for this parent
      for (const row of contentRows) {
        row.has_aplus                = aplusData.hasAplus
        row.aplus_module_count       = aplusData.moduleCount
        row.aplus_has_brand_story    = aplusData.hasBrandStory
        row.aplus_has_headline       = aplusData.hasHeadline
        row.aplus_images_missing_alt = aplusData.missingAltCount
      }

      // ── Step 5: Upsert into listing_content ──────────────────────────────
      // Note: description and image_count columns require migration:
      //   ALTER TABLE listing_content ADD COLUMN IF NOT EXISTS description TEXT;
      //   ALTER TABLE listing_content ADD COLUMN IF NOT EXISTS image_count INTEGER DEFAULT 0;
      // If columns don't exist yet, the upsert will silently ignore them.
      const { error: upsertErr } = await supabase
        .from('listing_content')
        .upsert(contentRows, { onConflict: 'sku' })

      if (upsertErr) {
        console.error(`[ListingContent] Upsert error for parent ${parentAsin}:`, upsertErr.message)
      } else {
        parentsSynced++
      }

      // ── Step 6: Score this parent ─────────────────────────────────────────
      // Fetch keyword intelligence + product details data for holistic scoring
      const scoringCtx = await fetchScoringContext(supabase, parentAsin, parent.top_child_asin)
      const parentOwnContent = contentRows.find(r => r.asin === parentAsin) || null
      const score = scoreListingContent(parentOwnContent, contentRows, scoringCtx)

      // Get product title and image from the top child
      const topChildContent = contentRows[0]
      const productTitle = topChildContent?.title || null

      // Get image from catalog_products
      const { data: catalogRow } = await supabase
        .from('catalog_products')
        .select('image_url')
        .eq('parent_asin', parentAsin)
        .limit(1)
        .single()

      const { error: scoreErr } = await supabase
        .from('listing_seo_scores')
        .upsert([{
          parent_asin:          parentAsin,
          title_score:          score.title_score,
          bullet_score:         score.bullet_score,
          keyword_score:        score.keyword_score,
          aplus_score:          score.aplus_score,
          description_score:    score.description_score,
          features_score:       score.features_score,
          overall_score:        score.overall_score,
          issues:               score.issues,
          child_count:          uniqueChildren.length,
          child_override_count: score.child_override_count,
          top_child_asin:       parent.top_child_asin,
          product_title:        productTitle,
          image_url:            catalogRow?.image_url || null,
          total_units_30d:      parent.total_units_30d,
          scored_at:            new Date().toISOString(),
        }], { onConflict: 'parent_asin' })

      if (scoreErr) {
        console.error(`[ListingContent] Score upsert error for ${parentAsin}:`, scoreErr.message)
      } else {
        parentsScored++
      }
    }

    console.log(`[ListingContent] Done: ${parentsSynced} parents, ${skusSynced} SKUs, ${parentsScored} scored in ${Date.now() - start}ms`)

    return {
      parentsSynced,
      skusSynced,
      parentsScored,
      error: null,
      durationMs: Date.now() - start,
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ListingContent] Fatal error:', msg)
    return { parentsSynced, skusSynced, parentsScored, error: msg, durationMs: Date.now() - start }
  }
}
