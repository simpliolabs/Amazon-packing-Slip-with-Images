/**
 * /api/fba/listing-optimizer/verify-push
 * ─────────────────────────────────────────────────────────────────────────────
 * "Did Amazon actually apply the push?" diagnostic.
 *
 * SP-API submissions return ACCEPTED, not "applied". Amazon's variation-family
 * processing takes anywhere from 15 minutes to several hours. After a push the
 * seller's natural question is "I pushed an hour ago and the PDP still shows
 * the old bullets — did it land or did it fail?". This endpoint answers that
 * by reading the LIVE attribute on every (FBA + FBM + parent) SKU directly from
 * Amazon via getListingsItem and comparing to the recommendation we tried to push.
 *
 * GET ?parent_asin=...&field=title|bullets|description|keywords|details
 *     [&detail_field=Material]
 *
 * For each SKU returns:
 *   - sku, asin, isParent
 *   - currentLive : what Amazon's catalog actually shows right now
 *   - expected    : the value we tried to push (from the recommendation)
 *   - matches     : currentLive trim-equal expected
 *   - lastUpdatedDate : the listing's updated timestamp (clue for whether
 *                       Amazon processed the patch recently)
 *
 * Read-only. No writes, no patches, no logging.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { isPushField, resolveProposed, asCompare, type PushField } from '@/lib/fba/pushFields'

// VerifyField broadens PushField to include 'details', which the verify route
// supports too. pushFields.ts deliberately keeps PushField narrow (the four built-in
// attributes) — details is a separate code path in push-content and here.
type VerifyField = PushField | 'details'
import {
  resolveDetailAttribute, isPushableDetail, currentDetailValue, normalizeFieldName, detailValueToString,
} from '@/lib/fba/productDetailAttrs'

const ENDPOINT       = process.env.AMAZON_ENDPOINT       || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

async function getSellerId(): Promise<string> {
  const supabase = await createAdminClient()
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'amazon_seller_id').single()
  const row = data as { value: string } | null
  if (row?.value) return row.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured.')
}

interface LiveListing {
  attributes?: Record<string, unknown>
  summaries?: { lastUpdatedDate?: string; productType?: string }[]
}

async function getListing(sellerId: string, token: string, sku: string): Promise<LiveListing | null> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes,summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return null
    return (await resp.json()) as LiveListing
  } catch { return null }
}

/** Extract the live value for a field (post-push expected representation). */
function extractLive(field: VerifyField, detailKey: string | null, listing: LiveListing | null): string {
  if (!listing) return ''
  const attrs = listing.attributes ?? {}
  // Pick the right attribute key per field.
  let key: string | null = null
  if (field === 'title') key = 'item_name'
  else if (field === 'bullets') key = 'bullet_point'
  else if (field === 'description') key = 'product_description'
  else if (field === 'keywords') key = 'generic_keyword'
  else if (field === 'details') key = detailKey
  if (!key) return ''

  const arr = attrs[key]
  if (!Array.isArray(arr) || arr.length === 0) return ''
  // bullet_point is multi-entry (one per bullet, ordered). Other fields take the first.
  if (field === 'bullets') {
    return (arr as { value?: unknown }[])
      .map((e) => (e?.value == null ? '' : String(e.value).trim()))
      .filter(Boolean)
      .join('\n')
  }
  const first = arr[0] as { value?: unknown }
  return currentDetailValue(attrs, key) || (first?.value == null ? '' : String(first.value).trim())
}

interface RecRow {
  recommended_title?: string | null
  recommended_bullets?: string[] | null
  recommended_description?: string | null
  recommended_keywords?: string | null
  per_child_titles?: { sku: string; asin: string; title: string }[] | null
  product_details_improvements?: { field_name?: string; recommended_value?: string; sp_api_key?: string; pushable?: boolean }[] | null
}

/** Compute the value WE tried to push for this SKU (mirrors push-content's resolution). */
function expectedFor(
  field: VerifyField, rec: RecRow, sku: string, isParent: boolean,
  detailFriendlyName: string | null,
): string {
  if (field === 'details') {
    const entry = (rec.product_details_improvements ?? []).find(
      (d) => normalizeFieldName(d.field_name || '') === normalizeFieldName(detailFriendlyName || ''),
    )
    // Historical rows can carry non-string values (LLM array/number) — normalize, never throw.
    return detailValueToString(entry?.recommended_value).trim()
  }
  if (field === 'keywords') {
    try {
      const arr = JSON.parse(rec.recommended_keywords ?? '[]') as { sku?: string; keywords?: string }[]
      const match = Array.isArray(arr) ? arr.find((r) => r.sku === sku) : null
      return (match?.keywords ?? '').trim()
    } catch { return '' }
  }
  if (field === 'title') {
    // Parent gets the capacity-agnostic version when a per-child-titles family is in scope;
    // otherwise the same broadcast title every child gets.
    if (isParent && Array.isArray(rec.per_child_titles) && rec.per_child_titles.length > 1) {
      return (rec.recommended_title ?? '').replace(/\b\d{1,4}\s?(?:GB|TB|MB)\b/gi, '').replace(/\s{2,}/g, ' ').trim()
    }
    const pct = Array.isArray(rec.per_child_titles) ? rec.per_child_titles.find((p) => p.sku === sku) : null
    return (pct?.title ?? rec.recommended_title ?? '').trim()
  }
  // bullets / description are broadcast — every SKU gets the same value.
  // (field is narrowed to PushField here; details was handled above.)
  const val = resolveProposed(field as PushField, rec, new Map(), sku)
  return asCompare(val)
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const parentAsin = url.searchParams.get('parent_asin')
    const rawField = url.searchParams.get('field') ?? ''
    const detailFriendly = url.searchParams.get('detail_field') ?? ''
    if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    if (rawField !== 'details' && !isPushField(rawField)) {
      return NextResponse.json({ error: `unknown field "${rawField}"` }, { status: 400 })
    }
    const field = rawField as VerifyField

    // Load the recommendation row (so we know what we EXPECTED to push).
    const supabase = await createAdminClient()
    const { data: recRow } = await supabase
      .from('listing_seo_recommendations')
      .select('recommended_title, recommended_bullets, recommended_description, recommended_keywords, per_child_titles, product_details_improvements')
      .eq('parent_asin', parentAsin)
      .single()
    const rec = (recRow ?? {}) as RecRow

    // Resolve the SP-API attribute key for details (so extractLive knows where to look).
    // Prefer the key the regen stored on the recommendation (schema-resolved, works for ANY
    // category); the static map only covers rows from before the schema-mapping change.
    let detailKey: string | null = null
    if (field === 'details') {
      const stored = (rec.product_details_improvements ?? []).find(
        (d) => normalizeFieldName(d.field_name || '') === normalizeFieldName(detailFriendly || ''),
      )
      if (stored?.pushable && stored.sp_api_key) {
        detailKey = stored.sp_api_key
      } else {
        if (!isPushableDetail(detailFriendly)) {
          return NextResponse.json({ error: `"${detailFriendly}" can't be verified as a pushable detail.` }, { status: 400 })
        }
        detailKey = resolveDetailAttribute(detailFriendly)?.spApiKey ?? null
        if (!detailKey) return NextResponse.json({ error: `Unknown detail attribute "${detailFriendly}"` }, { status: 400 })
      }
    }

    // "EXPECTED (PUSHED)" must mean what we actually PUSHED. The recommendation row a push came
    // from can VANISH on the next regen (the audit picks a fresh 5-10 menu attributes), which made
    // verify show stale-with-empty-expected on a fully-APPLIED push (live had "Relaxed" on 80/83
    // SKUs, expected was blank). Fall back to the last ACCEPTED push per SKU from keyword_push_log
    // when the rec no longer carries the field. Details only: the other fields' rec columns are
    // replaced on regen, never removed. Best-effort: no log rows → no fallback (legacy behavior).
    const pushedFallback = new Map<string, string>()
    if (field === 'details' && detailKey) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: pl } = await (supabase as any)
          .from('keyword_push_log')
          .select('sku, new_value, pushed_at')
          .eq('parent_asin', parentAsin)
          .eq('field', `details:${detailKey}`)
          .eq('status', 'accepted')
          .order('pushed_at', { ascending: false })
        for (const r of (pl ?? []) as { sku: string | null; new_value: string | null }[]) {
          if (r.sku && r.new_value && !pushedFallback.has(r.sku)) pushedFallback.set(r.sku, r.new_value)
        }
      } catch { /* best-effort — log table missing/unreadable just means no fallback */ }
    }

    // Collect every SKU we would have pushed to (children from listing_content + the parent
    // SKU we discover via Listings Items). The parent is included for broadcast fields and
    // for details, because the verify endpoint should mirror what push-content covers.
    const { data: rowsRaw } = await supabase
      .from('listing_content')
      .select('sku, asin')
      .eq('parent_asin', parentAsin)
      .order('sku', { ascending: true })
    const rows = (rowsRaw ?? []) as { sku: string; asin: string }[]
    if (rows.length === 0) return NextResponse.json({ error: 'No children found for this parent. Run a Sync first.' }, { status: 404 })

    const token = await getAccessToken()
    const sellerId = await getSellerId()

    // Discover the variation parent SKU and include it for broadcast / details fields.
    const isBroadcastField = field === 'title' || field === 'bullets' || field === 'description' || field === 'details'
    let parentSku: string | null = null
    if (isBroadcastField) {
      try {
        const urlP =
          `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}` +
          `?identifiers=${encodeURIComponent(parentAsin)}&identifiersType=ASIN` +
          `&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
        const resp = await fetch(urlP, { headers: { 'x-amz-access-token': token } })
        if (resp.ok) {
          const j = (await resp.json()) as { items?: { sku?: string }[] }
          parentSku = j.items?.[0]?.sku ?? null
        }
      } catch { /* best-effort */ }
    }

    // Walk every (sku, isParent) and fetch its live listing in parallel batches of 5
    // (Amazon getListingsItem limit is 5 rps, same as patch).
    const targets: { sku: string; asin: string; isParent: boolean }[] = []
    for (const r of rows) targets.push({ sku: r.sku, asin: r.asin, isParent: false })
    if (parentSku && !targets.some((t) => t.sku === parentSku)) {
      targets.push({ sku: parentSku, asin: parentAsin, isParent: true })
    }

    const results: { sku: string; asin: string; isParent: boolean; currentLive: string; expected: string; expectedSource: 'recommendation' | 'push_log' | 'none'; matches: boolean; lastUpdatedDate: string | null }[] = []
    for (let i = 0; i < targets.length; i += 5) {
      const batch = targets.slice(i, i + 5)
      const settled = await Promise.all(batch.map(async (t) => {
        const listing = await getListing(sellerId, token, t.sku)
        const currentLive = extractLive(field, detailKey, listing)
        let expected = expectedFor(field, rec, t.sku, t.isParent, detailFriendly || null)
        let expectedSource: 'recommendation' | 'push_log' | 'none' = expected ? 'recommendation' : 'none'
        if (!expected) {
          const fb = pushedFallback.get(t.sku)
          if (fb) { expected = fb; expectedSource = 'push_log' }
        }
        const lastUpdatedDate = listing?.summaries?.[0]?.lastUpdatedDate ?? null
        return {
          sku: t.sku, asin: t.asin, isParent: t.isParent,
          currentLive, expected, expectedSource,
          // Squash-compare so a CORRECTLY-applied enum isn't falsely "stale": we push the API token
          // ("short_sleeve") but Amazon returns the display label ("Short Sleeve"). Exact-trim first,
          // then lowercase + strip non-alnum as a fallback — semantically identical, modulo case/
          // punctuation. (Live: B0FRYMM56C Sleeve applied as "Short Sleeve" yet showed 0/65 matched.)
          matches: currentLive.length > 0 && (
            currentLive.trim() === expected.trim() ||
            currentLive.toLowerCase().replace(/[^a-z0-9]/g, '') === expected.toLowerCase().replace(/[^a-z0-9]/g, '')
          ),
          lastUpdatedDate,
        }
      }))
      results.push(...settled)
      // Brief inter-batch pause to stay well under 5 rps even on cold caches.
      if (i + 5 < targets.length) await new Promise((r) => setTimeout(r, 250))
    }

    const matched = results.filter((r) => r.matches).length
    const stale   = results.filter((r) => !r.matches && r.expected.length > 0).length
    // No expectation anywhere (not in the rec, never logged as pushed) — its own bucket so the UI
    // never paints these as "stale" (which implied a failed push when there was nothing to compare).
    const unknown = results.filter((r) => r.expected.length === 0).length
    return NextResponse.json({
      parent_asin: parentAsin,
      field,
      detail_field: field === 'details' ? detailFriendly : undefined,
      attribute_key: field === 'details' ? detailKey : (
        field === 'title' ? 'item_name'
        : field === 'bullets' ? 'bullet_point'
        : field === 'description' ? 'product_description'
        : field === 'keywords' ? 'generic_keyword'
        : undefined
      ),
      total: results.length,
      matched,
      stale,
      unknown,
      results,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'verify-push failed' }, { status: 500 })
  }
}
