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

async function fetchAplusStatus(
  token: string,
  asin: string
): Promise<{ hasAplus: boolean; missingAltCount: number }> {
  const url =
    `${ENDPOINT}/aplus/2020-11-01/contentDocuments` +
    `?marketplaceId=${MARKETPLACE_ID}` +
    `&asinSet=${asin}` +
    `&includedDataSet=CONTENTS`

  const resp = await fetch(url, {
    headers: { 'x-amz-access-token': token },
  })

  if (!resp.ok) {
    return { hasAplus: false, missingAltCount: 0 }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await resp.json()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs: any[] = json.contentDocumentSummaryList || []

  if (docs.length === 0) {
    return { hasAplus: false, missingAltCount: 0 }
  }

  // Count images missing alt text across all A+ modules
  let missingAlt = 0
  for (const doc of docs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modules: any[] = doc.contentDocument?.contentModuleList || []
    for (const mod of modules) {
      // Check all image fields in the module for missing image_keywords (alt text)
      const moduleStr = JSON.stringify(mod)
      const imageMatches = moduleStr.match(/"image":\s*\{[^}]*\}/g) || []
      for (const imgStr of imageMatches) {
        if (!imgStr.includes('"image_keywords"') || imgStr.includes('"image_keywords":""')) {
          missingAlt++
        }
      }
    }
  }

  return { hasAplus: true, missingAltCount: missingAlt }
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
    issues.push({ field: 'title', severity: 'critical', message: 'Title is missing', auto_fixable: false })
  } else {
    const titleLen = title.length
    if (titleLen < 80) {
      titleScore -= 10
      issues.push({ field: 'title', severity: 'warning', message: `Title too short (${titleLen} chars, aim for 150-200)`, auto_fixable: false })
    } else if (titleLen < 150) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'info', message: `Title could be longer (${titleLen} chars, aim for 150-200)`, auto_fixable: false })
    } else if (titleLen > 200) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: `Title too long (${titleLen} chars, max 200)`, auto_fixable: false })
    }
    // Check for ALL CAPS words (more than 2 consecutive caps words)
    const capsWords = title.split(' ').filter(w => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w))
    if (capsWords.length > 2) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: `Title has ${capsWords.length} ALL CAPS words — Amazon may suppress`, auto_fixable: false })
    }
    // Check for forbidden characters
    if (/[!?$%^*]/.test(title)) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: 'Title contains forbidden characters (!, ?, $, etc.)', auto_fixable: false })
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
    issues.push({ field: 'bullets', severity: 'critical', message: 'No bullet points found', auto_fixable: false })
  } else {
    if (bulletCount < 5) {
      bulletScore -= 10
      issues.push({ field: 'bullets', severity: 'warning', message: `Only ${bulletCount}/5 bullet points used`, auto_fixable: false })
    }
    const shortBullets = bullets.filter(b => b.length < 100)
    if (shortBullets.length > 0) {
      bulletScore -= Math.min(15, shortBullets.length * 5)
      issues.push({ field: 'bullets', severity: 'warning', message: `${shortBullets.length} bullet(s) under 100 chars — add more detail and keywords`, auto_fixable: false })
    }
  }
  bulletScore = Math.max(0, bulletScore)

  // ── Backend keyword scoring ────────────────────────────────────────────────
  const keywords = representativeContent.backend_keywords || ''
  const kwLen = keywords.length
  if (kwLen === 0) {
    keywordScore = 0
    issues.push({ field: 'backend_keywords', severity: 'critical', message: 'Backend keywords are empty (250 chars available)', auto_fixable: true })
  } else if (kwLen < 100) {
    keywordScore -= 15
    issues.push({ field: 'backend_keywords', severity: 'warning', message: `Backend keywords only ${kwLen}/250 chars used — add more`, auto_fixable: true })
  } else if (kwLen < 200) {
    keywordScore -= 10
    issues.push({ field: 'backend_keywords', severity: 'info', message: `Backend keywords ${kwLen}/250 chars — room for more`, auto_fixable: true })
  }
  // Check for commas (waste space)
  if (keywords.includes(',')) {
    keywordScore -= 5
    issues.push({ field: 'backend_keywords', severity: 'info', message: 'Backend keywords contain commas — remove them to save space', auto_fixable: true })
  }
  keywordScore = Math.max(0, keywordScore)

  // ── A+ Content scoring ─────────────────────────────────────────────────────
  const hasAplus = representativeContent.has_aplus
  const missingAlt = representativeContent.aplus_images_missing_alt

  if (!hasAplus) {
    aplusScore = 0
    issues.push({ field: 'aplus', severity: 'critical', message: 'No A+ Content — add Enhanced Brand Content to boost conversion', auto_fixable: false })
  } else if (missingAlt > 0) {
    aplusScore -= 10
    issues.push({ field: 'aplus', severity: 'warning', message: `${missingAlt} A+ image(s) missing alt text — hurts Amazon search indexing`, auto_fixable: true })
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
        message:      `${overrideCount} child SKU(s) have individually overridden content — review and consolidate`,
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

      // ── Step 4: Fetch A+ status for the parent ASIN ──────────────────────
      let aplusData = { hasAplus: false, missingAltCount: 0 }
      try {
        aplusData = await fetchAplusStatus(token, parentAsin)
        await sleep(100) // A+ API: 10 req/sec
      } catch (err) {
        console.warn(`[ListingContent] A+ fetch failed for ${parentAsin}:`, err instanceof Error ? err.message : String(err))
      }

      // Apply A+ data to all content rows for this parent
      for (const row of contentRows) {
        row.has_aplus               = aplusData.hasAplus
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
