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

export async function getProductType(sellerId: string, token: string, sku: string): Promise<string> {
  const cached = _productTypeCache.get(sku)
  if (cached) return cached
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
  } catch { /* fall through to fallback */ }
  return 'PRODUCT' // generic fallback; Amazon resolves the actual type from the listing. NOT cached.
}
