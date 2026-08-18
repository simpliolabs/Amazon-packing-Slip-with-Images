/**
 * ONE catalog-image fetcher, shared by the on-view route (`/api/fba/product-image`) and the
 * admin backfill (`/api/fba/admin/backfill-images`) so the two can never drift — same endpoint,
 * same "largest image wins" pick, same null-on-any-failure contract.
 *
 * SP-API Catalog Items is rate-limited but NOT credit-metered (no Jungle Scout involvement
 * anywhere in this module). Callers that loop must pace themselves; the default getCatalogItem
 * burst is small, so the backfill sleeps between items.
 */
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

/** Largest available catalog image link for an ASIN, or null (not found / no images / API error).
 *  `token` lets batch callers mint one access token for the whole run instead of one per item. */
export async function fetchCatalogImageUrl(asin: string, token?: string): Promise<string | null> {
  try {
    const t = token ?? (await getAccessToken())
    const url =
      `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(asin)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=images`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': t } })
    if (!resp.ok) return null
    const json = (await resp.json()) as {
      images?: { images?: { link: string; height: number; width: number }[] }[]
    }
    const imgs = json.images?.[0]?.images ?? []
    const best = [...imgs].sort((a, b) => b.height * b.width - a.height * a.width)[0]
    return best?.link ?? null
  } catch {
    return null
  }
}
