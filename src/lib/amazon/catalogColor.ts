/**
 * Per-child catalog colour fetch — SP-API Catalog Items API, READ ONLY (2026-08-28, migration 072).
 *
 * Mirrors catalogImage.ts's proven shape (same endpoint family, same raw-fetch + getAccessToken()
 * pattern already used across syncListingContent.ts/catalogImage.ts, rather than the separate
 * SellingPartnerApiAuth credential path in sp-api-client.ts's getCatalogItemsClient — that path
 * duplicates the credential loading auth.ts already does and has zero existing callers in this repo;
 * every other Catalog Items read here goes through getAccessToken() + a plain fetch).
 *
 * FIELD: `summaries[].color` (ItemSummaryByMarketplace.color, per the @sp-api-sdk
 * catalog-items-api-2022-04-01 type model) — a direct, documented, per-marketplace string field
 * ("The color that is associated with the Amazon catalog item"), NOT `attributes` (an untyped,
 * product-type-schema-dependent bag). `includedData=summaries` is the cheapest request that carries it.
 *
 * RATE LIMIT: getCatalogItem's own SP-API usage plan is 2 requests/sec, burst 2 — a THIRD of the
 * 5/5 plan spApiReadBucket already meters for getListingsItem (Amazon meters operations
 * independently — see spApiRateLimiter.ts's header). Gated through the dedicated
 * spApiCatalogReadBucket so a resumed/batched backfill run can never burst past what Amazon
 * actually grants this operation (the documented cause of this repo's prior 429 incident, task #23).
 *
 * NEVER writes to Amazon. No PATCH/PUT/POST anywhere in this module.
 */
import { getAccessToken } from '@/lib/amazon/auth'
import { spApiCatalogReadBucket } from '@/lib/fba/spApiRateLimiter'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

/** Catalog colour for a single child ASIN, or null (no colour on file / not found / API error —
 *  every failure is fail-open to null, NEVER a guess). `token` lets batch callers mint one access
 *  token for the whole run instead of one per item. Trimmed, empty-string-safe: an empty `color`
 *  field on Amazon's side returns null, same as a missing one — the caller's stored column must
 *  only ever hold a real colour or NULL, never ''. */
export async function fetchCatalogColor(asin: string, token?: string): Promise<string | null> {
  try {
    const t = token ?? (await getAccessToken())
    const url =
      `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(asin)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
    await spApiCatalogReadBucket.acquire()   // getCatalogItem's own usage plan: 2 rps / burst 2
    const resp = await fetch(url, { headers: { 'x-amz-access-token': t } })
    if (!resp.ok) return null
    const json = (await resp.json()) as { summaries?: { marketplaceId?: string; color?: string }[] }
    const entry = json.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? json.summaries?.[0]
    const color = (entry?.color ?? '').trim()
    return color || null
  } catch {
    return null
  }
}
