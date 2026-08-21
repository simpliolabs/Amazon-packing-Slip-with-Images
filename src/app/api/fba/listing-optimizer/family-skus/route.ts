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
 * It also carries `product_type` (2026-08-21): the listing page needs the parent SKU + productType
 * to build a WORKING Seller Central variations deep link (src/lib/fba/sellerCentralUrls.ts). Those
 * two used to come only from a heal-task payload, so any listing without an active heal task got an
 * ASIN-only stub link. This route already resolves the parent SKU — the productType rides along.
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
import { tryGetFamilyProductType } from '@/lib/amazon/productType'
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

    // 4) productType for the family (2026-08-21). The listing page needs it to build the Seller
    //    Central VARIATIONS deep link (sellerCentralUrls.ts) — without it the link used to degrade
    //    to an ASIN-only stub that opens an editor with no composite fields. REUSED probe: the same
    //    tryGetFamilyProductType the details push executor runs (tries candidates in order, never
    //    returns the 'PRODUCT' fallback) — no second probe, so the link and the push can't disagree.
    //    Parent hub SKU first (its own type is the one the variations editor loads), children after.
    //    FAIL-OPEN: null when Amazon answers nothing — the url builder just omits the param.
    //    CAPPED at 4 candidates: this route runs on every listing-page load and a family can hold
    //    113 SKUs; an uncapped probe would walk all of them (2 attempts + a 400ms backoff each) on
    //    every load of a family Amazon has nothing to say about. Failed probes are not cached, so
    //    the cap is what bounds that cost. 4 is well past the "one dead row in position 1" case the
    //    family probe exists for.
    const ptCandidates = [...(parentSku ? [parentSku] : []), ...children.map((c) => c.sku)].slice(0, 4)
    const { productType } = await tryGetFamilyProductType(sellerId, token, ptCandidates)

    return NextResponse.json({
      parent_asin: parentAsin,
      parent: parentSku ? { sku: parentSku, asin: parentAsin } : null,
      product_type: productType,
      children,
      count: children.length + (parentSku ? 1 : 0),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'family-skus failed' }, { status: 500 })
  }
}
