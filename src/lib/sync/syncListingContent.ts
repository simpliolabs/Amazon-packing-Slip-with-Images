/**
 * syncListingContent.ts
 *
 * Fetches listing content (title, bullets, backend keywords, A+ status)
 * for the top N parent ASINs (by 30d sales) using the Amazon SP-API:
 *
 *   1. Listings Items API  — GET /listings/2021-08-01/items/{sellerId}/{sku}
 *      includedData: summaries,attributes
 *      → title, bullet_point[], generic_keyword, image count
 *
 *   2. A+ Content API      — GET /aplus/2020-11-01/contentDocuments
 *      → has_aplus, count of images missing alt text (image_keywords)
 *
 * Rate limits:
 *   - Listings Items API:  5 req/sec
 *   - A+ Content API:      10 req/sec
 *
 * Strategy:
 *   - Fetch top 50 parents from parent_asin_rollup (by total_units_30d)
 *   - For each parent, fetch all child SKUs from listing_health
 *   - Fetch content for each child SKU via Listings Items API
 *   - Fetch A+ status once per parent ASIN via A+ Content API
 *   - Upsert results into listing_content table
 *   - Then run the scoring engine to update listing_seo_scores
 */

import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT      = process.env.AMAZON_ENDPOINT      || 'https://sellingpartnerapi-na.amazon.com'
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
  sku:                     string
  asin:                    string
  parent_asin:             string | null
  title:                   string | null
  bullet_1:                string | null
  bullet_2:                string | null
  bullet_3:                string | null
  bullet_4:                string | null
  bullet_5:                string | null
  backend_keywords:        string | null
  image_count:             number
  has_aplus:               boolean
  aplus_module_count:      number
  aplus_has_brand_story:   boolean
  aplus_has_headline:      boolean
  aplus_images_missing_alt: number
  content_synced_at:       string
}

interface ChildSku {
  sku:         string
  asin:        string
  parent_asin: string | null
}

// ── Listings Items API ────────────────────────────────────────────────────────

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
    parent_asin: parentAsin,
    title: null,
    bullet_1: null,
    bullet_2: null,
    bullet_3: null,
    bullet_4: null,
    bullet_5: null,
    backend_keywords: null,
    image_count: 0,
    has_aplus: false,
    aplus_module_count: 0,
    aplus_has_brand_story: false,
    aplus_has_headline: false,
    aplus_images_missing_alt: 0,
    content_synced_at: new Date().toISOString(),
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

  // Bullets
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

  // Backend keywords
  const kwArr = attrs.generic_keyword
  if (Array.isArray(kwArr) && kwArr.length > 0) {
    base.backend_keywords = kwArr.map((k: { value?: string }) => k?.value || '').filter(Boolean).join(' ')
  }

  // Image count from summaries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const summaries: any[] = json.summaries || []
  if (summaries.length > 0) {
    const mainImageCount = summaries[0]?.mainImage ? 1 : 0
    const otherImages: number = summaries[0]?.otherImages?.length || 0
    base.image_count = mainImageCount + otherImages
  }

  return base
}

// ── A+ Content API ────────────────────────────────────────────────────────────

interface AplusStatus {
  hasAplus:       boolean
  moduleCount:    number
  missingAltCount: number
  hasBrandStory:  boolean
  hasHeadline:    boolean
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
      // Brand Story (Enhanced Marketing Content via Vendor Central)
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
  overall_score:        number  // 0-100
  issues:               SeoIssue[]
  child_override_count: number
}

function scoreListingContent(
  parentContent: ListingContentRow | null,
  childContents: ListingContentRow[]
): SeoScore {
  const issues: SeoIssue[] = []
  let titleScore   = 25
  let bulletScore  = 25
  let keywordScore = 25
  let aplusScore   = 25
  let overrideCount = 0

  // Use the worst child's content for scoring (weakest link)
  // If no parent content, use the first child
  const representativeContent = parentContent || childContents[0]
  if (!representativeContent) {
    return { title_score: 0, bullet_score: 0, keyword_score: 0, aplus_score: 0, overall_score: 0, issues: [{ field: 'general', severity: 'critical', message: 'No listing content found', auto_fixable: false }], child_override_count: 0 }
  }

  // ── Title scoring ──────────────────────────────────────────────────────────
  const title = representativeContent.title || ''
  if (!title) {
    titleScore = 0
    issues.push({ field: 'title', severity: 'critical', message: 'Title is missing entirely. Go to Seller Central → Edit Listing → Vital Info and add a keyword-rich title (150-200 chars). Lead with your primary keyword, then brand, then key attributes (size, color, material, use case).', auto_fixable: false })
  } else {
    const titleLen = title.length
    if (titleLen < 80) {
      titleScore -= 10
      issues.push({ field: 'title', severity: 'warning', message: `Title is only ${titleLen} chars — well below the 150-200 char sweet spot. Expand it by appending key attributes: compatible devices, material, pack size, target audience, and primary use case. Example tail: "– Compatible with Canon, Nikon, GoPro | Class 10 | For Photographers & Videographers"`, auto_fixable: false })
    } else if (titleLen < 150) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'info', message: `Title is ${titleLen} chars — you have ${150 - titleLen}+ chars of unused keyword real estate. Add secondary attributes at the end: compatible devices, material type, gift occasion, or pack size. Every extra keyword in the title boosts search rank.`, auto_fixable: false })
    } else if (titleLen > 200) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: `Title is ${titleLen} chars — Amazon truncates at ~200 chars in search results, hiding your tail keywords from shoppers. Trim filler phrases like "Get a Durable" or "Ideal for" and keep only high-value keywords.`, auto_fixable: false })
    }
    // Check for ALL CAPS words (more than 2 consecutive caps words)
    const capsWords = title.split(' ').filter(w => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w))
    if (capsWords.length > 2) {
      titleScore -= 5
      const exampleFix = capsWords.slice(0, 3).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(', ')
      issues.push({ field: 'title', severity: 'warning', message: `Title has ${capsWords.length} ALL CAPS words (${capsWords.slice(0, 3).join(', ')}) — Amazon policy flags 3+ caps words and can suppress the listing. Change to Title Case: e.g. "${exampleFix}". Only brand names and acronyms (e.g. UHS-I, SDHC) are allowed in caps.`, auto_fixable: false })
    }
    // Check for forbidden characters
    if (/[!?$%^*]/.test(title)) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: 'Title contains special characters (!, ?, $, %, ^, or *) which violate Amazon style guidelines and can trigger suppression. Remove them — use plain descriptive language instead. Punctuation like commas, dashes, and pipes (|) are allowed.', auto_fixable: false })
    }
  }
  titleScore = Math.max(0, titleScore)

  // ── Bullet scoring ─────────────────────────────────────────────────────────
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
    issues.push({ field: 'bullets', severity: 'critical', message: 'No bullet points found. Go to Seller Central → Edit Listing → Product Description and add 5 bullets. Format: Lead with the benefit in caps (e.g. "FAST TRANSFER SPEEDS –"), then explain the feature in plain language. Each bullet should be 100-200 chars and include secondary keywords naturally.', auto_fixable: false })
  } else {
    if (bulletCount < 5) {
      bulletScore -= 10
      issues.push({ field: 'bullets', severity: 'warning', message: `Only ${bulletCount}/5 bullets used — you are leaving ${5 - bulletCount} keyword slots empty. Add bullet(s) covering: compatibility, warranty/guarantee, gift-readiness, or a comparison to competitors. Each bullet Amazon indexes independently for search.`, auto_fixable: false })
    }
    const shortBullets = bullets.filter(b => b.length < 100)
    if (shortBullets.length > 0) {
      bulletScore -= Math.min(15, shortBullets.length * 5)
      issues.push({ field: 'bullets', severity: 'warning', message: `${shortBullets.length} bullet(s) are under 100 chars — too thin to rank. Expand each one: add the "so that" benefit ("90MB/s read speed so you never miss a shot during burst photography"), mention compatible devices, and weave in long-tail keywords like "for Canon EOS" or "for GoPro Hero".`, auto_fixable: false })
    }
  }
  bulletScore = Math.max(0, bulletScore)

  // ── Backend keyword scoring ────────────────────────────────────────────────
  const keywords = representativeContent.backend_keywords || ''
  const kwLen = keywords.length
  if (kwLen === 0) {
    keywordScore = 0
    issues.push({ field: 'backend_keywords', severity: 'critical', message: `Backend keywords field is completely empty — this is 250 chars of free indexing you are not using. Go to Seller Central → Edit Listing → Keywords tab. Fill with space-separated terms NOT already in your title or bullets: misspellings, synonyms, competitor brand names (generic terms only), and long-tail phrases. Example: "micro sd card 128gb class 10 high speed memory card for camera drone dashcam"`, auto_fixable: false })
  } else if (kwLen < 100) {
    keywordScore -= 15
    issues.push({ field: 'backend_keywords', severity: 'warning', message: `Backend keywords only ${kwLen}/250 chars — ${250 - kwLen} chars of free indexing wasted. Add terms NOT in your title: common misspellings, related use cases, compatible device models, and gift search terms like "gifts for photographers". No commas, no repetition of title words.`, auto_fixable: false })
  } else if (kwLen < 200) {
    keywordScore -= 10
    issues.push({ field: 'backend_keywords', severity: 'info', message: `Backend keywords at ${kwLen}/250 chars — ${250 - kwLen} chars still available. Use them for: long-tail device compatibility terms ("for Sony A7 III", "for DJI Mini 3"), seasonal terms ("holiday gift", "back to school"), and common misspellings of your product category.`, auto_fixable: false })
  }
  // Check for commas (waste space)
  if (keywords.includes(',')) {
    keywordScore -= 5
    issues.push({ field: 'backend_keywords', severity: 'info', message: 'Backend keywords contain commas — Amazon treats commas as characters, not separators, wasting space. Remove all commas and use spaces only. "128gb, sd card" → "128gb sd card" saves 2 chars per term.', auto_fixable: false })
  }
  keywordScore = Math.max(0, keywordScore)

  // ── A+ Content scoring ─────────────────────────────────────────────────────
  const hasAplus           = representativeContent.has_aplus
  const missingAlt         = representativeContent.aplus_images_missing_alt
  const moduleCount        = representativeContent.aplus_module_count || 0
  const hasBrandStory      = representativeContent.aplus_has_brand_story
  const hasHeadline        = representativeContent.aplus_has_headline

  if (!hasAplus) {
    aplusScore = 0
    issues.push({ field: 'aplus', severity: 'critical', message: 'No A+ Content detected. Go to sellercentral.amazon.com/enhanced-content/content-manager and create a Standard A+ page. Minimum recommended: 1 hero image module + 3 feature image/text modules + 1 comparison chart. Listings with A+ convert 3-10% better and rank higher. This is the single highest-ROI improvement you can make.', auto_fixable: false })
  } else {
    // A+ exists — check optimization quality
    if (moduleCount > 0 && moduleCount < 5) {
      aplusScore -= 8
      issues.push({ field: 'aplus', severity: 'warning', message: `A+ page has only ${moduleCount} module(s) — Amazon allows up to 7 standard modules. Add: a comparison chart (shows your variants side-by-side), a "How to Use" image+text module, and a technical specs module. More modules = more keyword indexing surface area.`, auto_fixable: false })
    }
    if (!hasBrandStory) {
      aplusScore -= 7
      issues.push({ field: 'aplus', severity: 'warning', message: 'No Brand Story (EMC) module found. Add a Brand Story at sellercentral.amazon.com/enhanced-content/content-manager — it auto-appears on ALL your ASINs, builds brand trust, and links shoppers to your full catalog. Takes 30 minutes to create and runs forever.', auto_fixable: false })
    }
    if (!hasHeadline) {
      aplusScore -= 5
      issues.push({ field: 'aplus', severity: 'info', message: 'A+ page is missing a header/headline module. Add one as the first module — it should reinforce your primary keyword and brand positioning (e.g. "Professional-Grade Storage for Serious Creators"). It anchors the page and signals quality to shoppers.', auto_fixable: false })
    }
    if (missingAlt > 0) {
      aplusScore -= 5
      issues.push({ field: 'aplus', severity: 'warning', message: `${missingAlt} A+ image(s) have no alt text (image keywords). In A+ Content Manager, edit each image module and fill the "Image Keywords" field with descriptive terms (e.g. "128gb sd card high speed class 10 for canon camera"). Amazon indexes these for search — missing alt text = missing keyword coverage.`, auto_fixable: false })
    }
  }
  aplusScore = Math.max(0, aplusScore)

  // ── Child override detection ───────────────────────────────────────────────
  if (parentContent && childContents.length > 0) {
    for (const child of childContents) {
      const titleDiffers   = child.title   && parentContent.title   && child.title   !== parentContent.title
      const bulletsDiffer  = child.bullet_1 && parentContent.bullet_1 && child.bullet_1 !== parentContent.bullet_1
      const keywordsDiffer = child.backend_keywords && parentContent.backend_keywords && child.backend_keywords !== parentContent.backend_keywords
      if (titleDiffers || bulletsDiffer || keywordsDiffer) {
        overrideCount++
      }
    }
    if (overrideCount > 0) {
      issues.push({
        field:        'child_overrides',
        severity:     'warning',
        message:      `${overrideCount} variant(s) have content that differs from the parent listing — this means Amazon is showing inconsistent titles/bullets across your variations, which confuses shoppers and dilutes keyword coverage. Go to Seller Central → Manage Inventory → Edit each variant and sync the title and bullets to match the parent. Use the parent's optimised content as the master template.`,
        auto_fixable: false,
      })
    }
  }

  const overall = titleScore + bulletScore + keywordScore + aplusScore

  return {
    title_score:          titleScore,
    bullet_score:         bulletScore,
    keyword_score:        keywordScore,
    aplus_score:          aplusScore,
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
      // Query using the first child ASIN — if A+ exists for any child it exists for the parent.
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
      const { error: upsertErr } = await supabase
        .from('listing_content')
        .upsert(contentRows, { onConflict: 'sku' })

      if (upsertErr) {
        console.error(`[ListingContent] Upsert error for parent ${parentAsin}:`, upsertErr.message)
      } else {
        parentsSynced++
      }

      // ── Step 6: Score this parent ─────────────────────────────────────────
      // Find the parent's own content (if the parent ASIN has a direct SKU)
      const parentOwnContent = contentRows.find(r => r.asin === parentAsin) || null
      const score = scoreListingContent(parentOwnContent, contentRows)

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
