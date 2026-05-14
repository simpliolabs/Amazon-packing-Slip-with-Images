/**
 * Typed Amazon SP-API Client
 *
 * Uses @sp-api-sdk (bizon) packages for full TypeScript type safety.
 * Wraps the existing credential/auth infrastructure from auth.ts.
 *
 * Available clients:
 *   - ListingsItemsApiClient  — get real suppression reasons, listing status
 *   - CatalogItemsApiClient   — get product details, images, attributes
 *
 * Auth: reads credentials from Supabase app_settings (same as auth.ts),
 * falling back to environment variables.
 */

import { SellingPartnerApiAuth } from '@sp-api-sdk/auth'
import { ListingsItemsApiClient } from '@sp-api-sdk/listings-items-api-2021-08-01'
import { CatalogItemsApiClient } from '@sp-api-sdk/catalog-items-api-2022-04-01'
import { createClient } from '@supabase/supabase-js'

// ── Region mapping ────────────────────────────────────────────────────────────
// Map AMAZON_ENDPOINT env var to @sp-api-sdk region strings
function getRegion(): 'na' | 'eu' | 'fe' {
  const endpoint = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
  if (endpoint.includes('-eu.')) return 'eu'
  if (endpoint.includes('-fe.')) return 'fe'
  return 'na'
}

// ── Credential loading (mirrors auth.ts logic) ────────────────────────────────
async function getSpApiCredentials(): Promise<{
  clientId: string
  clientSecret: string
  refreshToken: string
}> {
  // Try Supabase app_settings first
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (supabaseUrl && serviceKey) {
      const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data: settings } = await supabase
        .from('app_settings')
        .select('key, value')
        .in('key', ['amazon_client_id', 'amazon_client_secret', 'amazon_refresh_token'])
      if (settings && settings.length === 3) {
        const map: Record<string, string> = {}
        settings.forEach((s: { key: string; value: string }) => { map[s.key] = s.value })
        const clientId     = map['amazon_client_id']
        const clientSecret = map['amazon_client_secret']
        const refreshToken = map['amazon_refresh_token']
        if (clientId && clientSecret && refreshToken) {
          return { clientId, clientSecret, refreshToken }
        }
      }
    }
  } catch (err) {
    console.warn('[SpApiClient] Failed to read credentials from Supabase, falling back to env vars:', err)
  }

  const clientId     = process.env.AMAZON_CLIENT_ID
  const clientSecret = process.env.AMAZON_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Amazon SP-API credentials not configured. Set them in Settings or as environment variables.'
    )
  }
  return { clientId, clientSecret, refreshToken }
}

// ── Client factory ────────────────────────────────────────────────────────────

let _auth: SellingPartnerApiAuth | null = null

async function getAuth(): Promise<SellingPartnerApiAuth> {
  if (_auth) return _auth
  const { clientId, clientSecret, refreshToken } = await getSpApiCredentials()
  _auth = new SellingPartnerApiAuth({
    clientId,
    clientSecret,
    refreshToken,
  })
  return _auth
}

/**
 * Get a typed ListingsItemsApiClient.
 * Use this to fetch real suppression status and reason codes from Amazon.
 *
 * Example:
 *   const client = await getListingsItemsClient()
 *   const item = await client.getListingsItem(sellerId, sku, [marketplaceId], {
 *     includedData: ['issues', 'summaries', 'attributes']
 *   })
 */
export async function getListingsItemsClient(): Promise<ListingsItemsApiClient> {
  const auth = await getAuth()
  return new ListingsItemsApiClient({
    auth,
    region: getRegion(),
    rateLimiting: {
      retry: true,
      onRetry: (info) => console.warn('[SpApiClient] ListingsItems rate limited, retrying…', info),
    },
  })
}

/**
 * Get a typed CatalogItemsApiClient.
 * Use this to fetch product details, images, and attributes by ASIN.
 *
 * Example:
 *   const client = await getCatalogItemsClient()
 *   const item = await client.getCatalogItem(asin, [marketplaceId], {
 *     includedData: ['summaries', 'images', 'attributes']
 *   })
 */
export async function getCatalogItemsClient(): Promise<CatalogItemsApiClient> {
  const auth = await getAuth()
  return new CatalogItemsApiClient({
    auth,
    region: getRegion(),
    rateLimiting: {
      retry: true,
      onRetry: (info) => console.warn('[SpApiClient] CatalogItems rate limited, retrying…', info),
    },
  })
}

/**
 * Fetch real-time listing issues for a specific SKU from Amazon's Listings Items API.
 * Returns the suppression issues with reason codes, or null if the listing is healthy.
 *
 * This is the definitive source — more accurate than the All Listings Report.
 * Use this for on-demand checks when a user clicks "Refresh" on a specific listing.
 */
export async function getListingIssuesForSku(
  sellerId: string,
  sku: string,
  marketplaceId: string
): Promise<{ issues: Array<{ code: string; message: string; severity: string }> } | null> {
  try {
    const client = await getListingsItemsClient()
    const response = await client.getListingsItem({
      sellerId,
      sku,
      marketplaceIds: [marketplaceId],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      includedData: ['issues', 'summaries'] as any,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const issues: any[] = (response.data as any)?.issues || []
    return {
      issues: issues.map((issue) => ({
        code:     issue.code     || 'UNKNOWN',
        message:  issue.message  || '',
        severity: issue.severity || 'ERROR',
      })),
    }
  } catch (err) {
    console.error(`[SpApiClient] Failed to get listing issues for SKU ${sku}:`, err)
    return null
  }
}
