/**
 * GET /api/fba/listing-optimizer/family-skus?parent_asin=X
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns the FULL set of seller SKUs in a variation family (FBA + FBM + variation
 * parent), discovered live from Amazon. The DB cache (listing_content) historically
 * deduped some FBA/FBM pairs, so a UI that renders from the cache alone misses the
 * FBM twin — the push route already discovers them at push time, but the seller
 * never SAW them listed.
 *
 * Concretely, for an SD-card family with 32G / 64G / 128G the cache might hold:
 *   DAFEI-482-32G-FBA, DAFEI-482-64G.-FBA, DAFEI-482-128GB-FBA
 * and this endpoint enriches that with the live FBM twins + the variation parent:
 *   DAFEI-482-32G, DAFEI-482-64G., (no FBM for 128GB — real data), Memory-Card-P
 *
 * The UI uses this so the "Titles to push" / "Bullets to push" / etc. cards show
 * the seller exactly what the push will hit — matching the modal's accepted-count.
 *
 * Read-only. Used for display, not as the source of truth for the push (the push
 * still does its own discovery so we don't depend on a cache window).
 *
 * INVARIANT 2 — ONE RESOLVER: the merge rule (DB seed + twin-name-guarded discovered twins +
 * sort) lives in src/lib/fba/familyRoster.ts and is SHARED with the VARIANT-DEATH ALARM, which
 * feeds it the PERSISTED discovery (sku_offer_liveness) instead of a live call. This route only
 * supplies the live discovery and appends the parent hub.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { resolveFamilyRoster, isSystemSku, type FamilySkuRef } from '@/lib/fba/familyRoster'

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

async function discoverSkusForAsin(
  sellerId: string, token: string, asin: string,
): Promise<FamilySkuRef[]> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}` +
      `?identifiers=${encodeURIComponent(asin)}&identifiersType=ASIN` +
      `&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return []
    const json = (await resp.json()) as { items?: { sku?: string }[] }
    return (json.items ?? [])
      .map((it) => (it.sku ? { sku: it.sku, asin } : null))
      .filter((x): x is FamilySkuRef => x !== null && !isSystemSku(x.sku))
  } catch { return [] }
}

async function findParentSku(sellerId: string, token: string, parentAsin: string): Promise<string | null> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}` +
      `?identifiers=${encodeURIComponent(parentAsin)}&identifiersType=ASIN` +
      `&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return null
    const json = (await resp.json()) as { items?: { sku?: string }[] }
    return json.items?.[0]?.sku ?? null
  } catch { return null }
}

export async function GET(req: NextRequest) {
  try {
    const parentAsin = new URL(req.url).searchParams.get('parent_asin')
    if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })

    const supabase = await createAdminClient()
    const { data: rowsRaw } = await supabase
      .from('listing_content')
      .select('sku, asin')
      .eq('parent_asin', parentAsin)
      .order('sku', { ascending: true })
    const cached = (rowsRaw ?? []) as { sku: string; asin: string }[]
    if (cached.length === 0) {
      // No DB rows for this parent — return an empty shape rather than 404, so the UI can render
      // "no children synced yet" without an error toast.
      return NextResponse.json({ parent_asin: parentAsin, parent: null, children: [], count: 0 })
    }

    const token = await getAccessToken()
    const sellerId = await getSellerId()

    // 1) LIVE discovery: for each unique ASIN, ask Amazon what other SKUs the seller has on it
    //    (typically the FBM twin of an -FBA SKU, or vice versa).
    const asins = [...new Set(cached.map((r) => r.asin).filter(Boolean))]
    const discovered: FamilySkuRef[] = []
    for (const asin of asins) discovered.push(...await discoverSkusForAsin(sellerId, token, asin))

    // 2) ONE RESOLVER (familyRoster.ts): DB seed + twin-name-guarded twins + sort. The alarm calls
    //    the same function over the persisted discovery, so the two can never enumerate differently.
    const children = resolveFamilyRoster(cached, discovered)
      .map(({ sku, asin, fulfillment, base_name }) => ({ sku, asin, fulfillment, base_name }))

    // 3) Variation parent SKU (non-buyable hub).
    const parentSku = await findParentSku(sellerId, token, parentAsin)

    return NextResponse.json({
      parent_asin: parentAsin,
      parent: parentSku ? { sku: parentSku, asin: parentAsin } : null,
      children,
      count: children.length + (parentSku ? 1 : 0),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'family-skus failed' }, { status: 500 })
  }
}
