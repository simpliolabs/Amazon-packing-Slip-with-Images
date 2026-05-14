/**
 * Amazon Ads API Authentication
 *
 * Separate from SP-API auth — the Ads API uses a different LWA application
 * with its own client_id, client_secret, and refresh_token.
 *
 * Credentials are stored in Supabase app_settings:
 *   ads_client_id     — LWA Client ID for Ads API app
 *   ads_client_secret — LWA Client Secret for Ads API app
 *   ads_refresh_token — LWA Refresh Token for Ads API app
 *   ads_profile_id    — Amazon Ads Profile ID (seller's advertising account)
 *   ads_region        — NA | EU | FE (default: NA)
 *
 * Region → endpoint mapping:
 *   NA → https://advertising-api.amazon.com
 *   EU → https://advertising-api-eu.amazon.com
 *   FE → https://advertising-api-fe.amazon.com
 */

import { createClient } from '@supabase/supabase-js'

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

const ADS_ENDPOINTS: Record<string, string> = {
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
}

interface AdsTokenCache {
  token: string
  expiresAt: number
}

let cachedAdsToken: AdsTokenCache | null = null

export interface AdsCredentials {
  clientId:     string
  clientSecret: string
  refreshToken: string
  profileId:    string
  region:       string
  endpoint:     string
}

/**
 * Load Ads API credentials from Supabase app_settings.
 * Returns null if credentials are not yet configured.
 */
export async function getAdsCredentials(): Promise<AdsCredentials | null> {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) return null

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { data: settings } = await supabase
      .from('app_settings')
      .select('key, value')
      .in('key', ['ads_client_id', 'ads_client_secret', 'ads_refresh_token', 'ads_profile_id', 'ads_region'])

    if (!settings || settings.length === 0) return null

    const map: Record<string, string> = {}
    settings.forEach((s: { key: string; value: string }) => { map[s.key] = s.value })

    const clientId     = map['ads_client_id']
    const clientSecret = map['ads_client_secret']
    const refreshToken = map['ads_refresh_token']
    const profileId    = map['ads_profile_id']
    const region       = (map['ads_region'] || 'NA').toUpperCase()

    // If any required credential is missing or empty, return null
    if (!clientId || !clientSecret || !refreshToken || !profileId) {
      return null
    }

    return {
      clientId,
      clientSecret,
      refreshToken,
      profileId,
      region,
      endpoint: ADS_ENDPOINTS[region] || ADS_ENDPOINTS.NA,
    }
  } catch (err) {
    console.error('[AdsAuth] Failed to load Ads credentials:', err)
    return null
  }
}

/**
 * Get a valid Ads API access token, refreshing if necessary.
 * Returns null if credentials are not configured.
 */
export async function getAdsAccessToken(): Promise<string | null> {
  const now = Date.now()
  if (cachedAdsToken && cachedAdsToken.expiresAt > now + 60_000) {
    return cachedAdsToken.token
  }

  const creds = await getAdsCredentials()
  if (!creds) {
    console.warn('[AdsAuth] Ads API credentials not configured — skipping token refresh')
    return null
  }

  try {
    const response = await fetch(LWA_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: creds.refreshToken,
        client_id:     creds.clientId,
        client_secret: creds.clientSecret,
      }),
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('[AdsAuth] Failed to refresh Ads access token:', error)
      return null
    }

    const data = await response.json()
    cachedAdsToken = {
      token:     data.access_token,
      expiresAt: now + data.expires_in * 1000,
    }
    return cachedAdsToken.token
  } catch (err) {
    console.error('[AdsAuth] Token refresh error:', err)
    return null
  }
}

/**
 * Make an authenticated request to the Amazon Ads API.
 * Returns null if credentials are not configured or the request fails.
 */
export async function adsApiFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response | null> {
  const creds = await getAdsCredentials()
  if (!creds) return null

  const token = await getAdsAccessToken()
  if (!token) return null

  const url = `${creds.endpoint}${path}`
  return fetch(url, {
    ...options,
    headers: {
      'Amazon-Advertising-API-ClientId': creds.clientId,
      'Amazon-Advertising-API-Scope':    creds.profileId,
      'Authorization':                   `Bearer ${token}`,
      'Content-Type':                    'application/json',
      ...(options.headers || {}),
    },
  })
}
