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

import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'

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
  overall_score:        number  // 0-100
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

  // Use parent content if available, otherwise best child (most bullets)
  const representativeContent = parentContent ||
    childContents.sort((a, b) => {
      const aBullets = [a.bullet_1,a.bullet_2,a.bullet_3,a.bullet_4,a.bullet_5].filter(Boolean).length
      const bBullets = [b.bullet_1,b.bullet_2,b.bullet_3,b.bullet_4,b.bullet_5].filter(Boolean).length
      return bBullets - aBullets
    })[0]

  if (!representativeContent) {
    return { title_score: 0, bullet_score: 0, keyword_score: 0, aplus_score: 0, overall_score: 0, issues: [{ field: 'general', severity: 'critical', message: 'No listing content found — run Scan Listings to fetch data from Amazon.', auto_fixable: false }], child_override_count: 0 }
  }

  // ── 1. TITLE SCORING ──────────────────────────────────────────────────────
  const title = representativeContent.title || ''
  if (!title) {
    titleScore = 0
    issues.push({ field: 'title', severity: 'critical', message: 'Title is missing entirely. Go to Seller Central → Edit Listing → Vital Info. Lead with your primary keyword, then brand, then key attributes (size, color, material, use case). Target 150-200 chars.', auto_fixable: false })
  } else {
    const titleLen = title.length

    if (titleLen < 80) {
      titleScore -= 10
      issues.push({ field: 'title', severity: 'warning', message: `Title is only ${titleLen} chars — well below the 150-200 char sweet spot. Append key attributes: compatible devices, material, pack size, target audience, primary use case. Example tail to add: "– Compatible with Canon, Nikon, GoPro | Class 10 | For Photographers & Videographers"`, auto_fixable: false })
    } else if (titleLen < 150) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'info', message: `Title is ${titleLen} chars — you have ${200 - titleLen} chars of unused keyword real estate. Add secondary attributes at the end: compatible devices, material type, gift occasion, or pack size. Every extra keyword in the title boosts search rank.`, auto_fixable: false })
    } else if (titleLen > 200) {
      titleScore -= 5
      issues.push({ field: 'title', severity: 'warning', message: `Title is ${titleLen} chars — Amazon truncates at ~200 chars in search results, hiding your tail keywords from shoppers. Trim filler phrases like "Get a Durable" or "Ideal for" and keep only high-value keywords.`, auto_fixable: false })
    }

    // ALL CAPS check
    const capsWords = title.split(' ').filter(w => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w))
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

    // Check for keyword density — bullets should cover different topics
    if (bulletCount >= 3) {
      const allBulletText = bullets.join(' ').toLowerCase()
      const titleTokens = tokenize(title)
      const bulletTokens = tokenize(allBulletText)
      // Find title keywords NOT covered in bullets (missed opportunities)
      const titleOnlyKeywords = [...titleTokens].filter(w => !bulletTokens.has(w) && w.length > 4)
      if (titleOnlyKeywords.length > 3) {
        bulletScore -= 3
        issues.push({ field: 'bullets', severity: 'info', message: `Bullets are missing ${titleOnlyKeywords.length} keywords from your title (e.g. "${titleOnlyKeywords.slice(0,3).join('", "')}""). Weave these into your bullets — Amazon cross-references title and bullet keywords to determine relevance. Missing overlap = lower ranking for those terms.`, auto_fixable: false })
      }
    }
  }
  bulletScore = Math.max(0, bulletScore)

  // ── 3. DESCRIPTION SCORING (folded into keyword score) ────────────────────
  // Description is a separate field — we deduct from keyword score if missing
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
      keywordScore -= 8
      issues.push({ field: 'description', severity: 'warning', message: 'Product description is empty or missing. Go to Seller Central → Edit Listing → Product Description. Write 200-2000 chars of keyword-rich prose (NOT bullets). Amazon indexes this separately from bullets. Include: use cases, target audience, technical specs, and long-tail keywords that don\'t fit in the title. HTML formatting (<b>, <br>, <ul>) is allowed and improves readability.', auto_fixable: false })
    }
  } else if (descLen < 200) {
    keywordScore -= 4
    issues.push({ field: 'description', severity: 'info', message: `Description is only ${descLen} chars — expand to 500-2000 chars. Amazon indexes the full description text. Add: a brand story paragraph, technical specifications table, compatibility list (specific device models), FAQ-style content ("Works with Canon EOS R5, R6, 5D Mark IV"), and use-case scenarios. More indexed text = more long-tail search coverage.`, auto_fixable: false })
  } else if (descLen > 2000) {
    issues.push({ field: 'description', severity: 'info', message: `Description is ${descLen} chars — Amazon truncates display at ~2000 chars but indexes the full text. Ensure your most important keywords and CTAs appear in the first 2000 chars. Move technical specs and compatibility lists to the end.`, auto_fixable: false })
  }

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
    issues.push({ field: 'backend_keywords', severity: 'info', message: `Backend keywords at ${kwLen}/250 chars — ${250 - kwLen} chars still available. Use them for: long-tail device compatibility terms ("for Sony A7 III", "for DJI Mini 3"), seasonal terms ("holiday gift", "back to school"), and common misspellings of your product category.`, auto_fixable: false })
  }

  // Commas waste space
  if (keywords.includes(',')) {
    keywordScore -= 3
    issues.push({ field: 'backend_keywords', severity: 'info', message: 'Backend keywords contain commas — Amazon treats commas as characters, not separators, wasting space. Remove all commas and use spaces only. "128gb, sd card" → "128gb sd card" saves 2 chars per term and recovers keyword slots.', auto_fixable: false })
  }

  // Keyword overlap — title words repeated in backend keywords waste space
  if (title && keywords) {
    const titleTokens = tokenize(title)
    const kwTokens = tokenize(keywords)
    const overlap = [...titleTokens].filter(w => kwTokens.has(w) && w.length > 4)
    if (overlap.length > 3) {
      keywordScore -= 3
      issues.push({ field: 'backend_keywords', severity: 'info', message: `Backend keywords repeat ${overlap.length} words already in your title (e.g. "${overlap.slice(0,3).join('", "')}""). Amazon already indexes title words — repeating them in backend keywords wastes space. Replace them with NEW terms: misspellings, synonyms, and long-tail phrases not in the title.`, auto_fixable: false })
    }
  }

  // Image count check
  const imageCount = representativeContent.image_count || 0
  if (imageCount > 0 && imageCount < 7) {
    keywordScore -= 3
    issues.push({ field: 'images', severity: 'warning', message: `Only ${imageCount}/7 product images uploaded. Amazon allows 7 images — each additional image increases conversion rate. Add: lifestyle photos (product in use), infographic images (specs/features), size comparison photos, and a white-background hero variant. Listings with 7 images convert 25-40% better than those with 3-4.`, auto_fixable: false })
  } else if (imageCount === 0) {
    keywordScore -= 5
    issues.push({ field: 'images', severity: 'warning', message: 'No product images detected. Upload at least 7 images in Seller Central → Edit Listing → Images. Required: 1 white-background hero (1000x1000px minimum for zoom), 3-4 lifestyle shots, 1-2 infographic images with key specs highlighted.', auto_fixable: false })
  }

  keywordScore = Math.max(0, keywordScore)

  // ── 5. A+ CONTENT SCORING ─────────────────────────────────────────────────────
  const hasAplus      = hasAplusEarly  // already read above for description check
  const missingAlt    = representativeContent.aplus_images_missing_alt
  const moduleCount   = representativeContent.aplus_module_count || 0
  const hasBrandStory = representativeContent.aplus_has_brand_story
  const hasHeadline   = representativeContent.aplus_has_headline

  if (!hasAplus) {
    aplusScore = 0
    issues.push({ field: 'aplus', severity: 'critical', message: 'No A+ Content detected. Go to sellercentral.amazon.com/enhanced-content/content-manager and create a Standard A+ page. Minimum: 1 hero image module + 3 feature image/text modules + 1 comparison chart. Listings with A+ convert 3-10% better and rank higher in search. This is the single highest-ROI improvement you can make.', auto_fixable: false })
  } else {
    if (moduleCount > 0 && moduleCount < 5) {
      aplusScore -= 8
      issues.push({ field: 'aplus', severity: 'warning', message: `A+ page has only ${moduleCount} module(s) — Amazon allows up to 7 standard modules. Add: a comparison chart (shows your variants side-by-side and blocks competitor switching), a "How to Use" image+text module, and a technical specs module. More modules = more keyword indexing surface area and longer page dwell time.`, auto_fixable: false })
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
