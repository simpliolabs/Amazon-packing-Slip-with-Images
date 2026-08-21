/**
 * Resolve a SKU's Amazon productType (e.g. SHIRT) from Listings Items summaries.
 * ─────────────────────────────────────────────────────────────────────────────
 * Process-lifetime cache of SUCCESSFUL resolutions only. The 'PRODUCT' fallback is NEVER cached — a
 * transient SP-API failure must not poison later calls. Caching makes the productType (and thus the
 * downstream enum validation) CONSISTENT across calls for the same SKU. Live-verify (B0G884ZJ27)
 * found intermittent resolution: an attribute's enum resolved on one call and fell back to free-text
 * on the next, because getProductType occasionally hit the fallback — caching fixes that.
 *
 * Shared by push-content (loadDetailContext + the ?debug branch) and ai-recommendations
 * (validate-at-regen), so both see the same resolved type for the same SKU.
 */
const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

const _productTypeCache = new Map<string, string>() // sku -> productType (successful resolutions only)

/** Resolve the REAL productType or null — never the 'PRODUCT' fallback. One internal retry:
 *  the failure mode is a transient SP-API blip right after a deploy restart (cold caches).
 *
 *  DETAIL pushes must use THIS and stop on null: with the generic 'PRODUCT' type, Amazon
 *  validated every patch against the wrong schema and rejected the entire family —
 *  82 × "The provided value for 'neck' is invalid" on values that were perfectly correct
 *  for SHIRT (live 2026-06-12), plus a false "not a valid attribute for this product type
 *  (PRODUCT)" guard message that blamed the recommendation. */
export async function tryGetProductType(sellerId: string, token: string, sku: string): Promise<string | null> {
  const cached = _productTypeCache.get(sku)
  if (cached) return cached
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url =
        `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
        `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
      const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
      if (resp.ok) {
        const json = (await resp.json()) as { summaries?: { productType?: string }[] }
        const pt = json.summaries?.[0]?.productType
        if (pt) { _productTypeCache.set(sku, pt); return pt }
      }
    } catch { /* retry once, then null */ }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

export async function getProductType(sellerId: string, token: string, sku: string): Promise<string> {
  // generic fallback; tolerable ONLY for the universal attributes (item_name, bullet_point, …)
  // that exist on every type. Never acceptable for product-detail attributes — use
  // tryGetProductType there and refuse to push on null.
  return (await tryGetProductType(sellerId, token, sku)) ?? 'PRODUCT'
}

/**
 * Family-wide productType probe (2026-08-21, B0FKFHSCS9): the details push used to ask Amazon for
 * the productType of the FIRST listing_content SKU of the parent — an arbitrary row — and failed the
 * WHOLE family when that one SKU had no live listing, blaming "a transient hiccup after a deploy".
 * One dead row in position 1 made a family unpushable. Try the candidates in order until one answers;
 * say exactly which SKUs answered nothing. Never the 'PRODUCT' fallback.
 */
export async function tryGetFamilyProductType(
  sellerId: string,
  token: string,
  skus: readonly string[],
): Promise<{ productType: string | null; tried: string[]; hit: string | null }> {
  const tried: string[] = []
  for (const sku of skus) {
    if (!sku || /^amzn\./i.test(sku)) continue
    tried.push(sku)
    const pt = await tryGetProductType(sellerId, token, sku)
    if (pt) return { productType: pt, tried, hit: sku }
  }
  return { productType: null, tried, hit: null }
}
