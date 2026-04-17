/**
 * Amazon SP-API OAuth2 Token Management
 * Handles LWA (Login with Amazon) token refresh flow.
 * Credentials are read from Supabase app_settings (primary)
 * with fallback to environment variables.
 */

import { createClient } from '@supabase/supabase-js'

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
}

// In-memory token cache (per process)
let cachedToken: { token: string; expiresAt: number } | null = null

/**
 * Get Amazon credentials from Supabase app_settings, falling back to env vars.
 */
async function getCredentials(): Promise<{
  clientId: string
  clientSecret: string
  refreshToken: string
}> {
  // Try to read from Supabase app_settings first
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (supabaseUrl && serviceRoleKey) {
      const adminClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false },
      })

      const { data: settings } = await adminClient
        .from('app_settings')
        .select('key, value')
        .in('key', ['amazon_client_id', 'amazon_client_secret', 'amazon_refresh_token'])

      if (settings && settings.length === 3) {
        const map: Record<string, string> = {}
        settings.forEach((s: { key: string; value: string }) => { map[s.key] = s.value })

        const clientId = map['amazon_client_id']
        const clientSecret = map['amazon_client_secret']
        const refreshToken = map['amazon_refresh_token']

        if (clientId && clientSecret && refreshToken) {
          return { clientId, clientSecret, refreshToken }
        }
      }
    }
  } catch (err) {
    console.warn('Failed to read Amazon credentials from Supabase, falling back to env vars:', err)
  }

  // Fallback to environment variables
  const clientId = process.env.AMAZON_CLIENT_ID
  const clientSecret = process.env.AMAZON_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Amazon SP-API credentials not configured. Set them in Settings or as environment variables (AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_REFRESH_TOKEN).'
    )
  }

  return { clientId, clientSecret, refreshToken }
}

/**
 * Get a valid access token, refreshing if necessary.
 * Uses in-memory cache to avoid unnecessary refreshes.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now()

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token
  }

  const { clientId, clientSecret, refreshToken } = await getCredentials()

  const response = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to refresh Amazon access token: ${error}`)
  }

  const data: TokenResponse = await response.json()

  cachedToken = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  }

  return data.access_token
}

/**
 * Get a Restricted Data Token (RDT) for accessing PII data like buyer info and shipping address.
 * Returns null if the application doesn't have PII access permissions.
 */
export async function getRestrictedDataToken(
  restrictedResources: Array<{ method: string; path: string; dataElements?: string[] }>
): Promise<string | null> {
  try {
    const accessToken = await getAccessToken()
    const endpoint = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'

    const response = await fetch(`${endpoint}/tokens/2021-03-01/restrictedDataToken`, {
      method: 'POST',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ restrictedResources }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.warn(`RDT request failed (${response.status}): ${errorText}`)
      return null
    }

    const data = await response.json()
    return data.restrictedDataToken || null
  } catch (err) {
    console.warn('Failed to get RDT:', err)
    return null
  }
}

/**
 * Exchange an authorization code for tokens (used in OAuth callback)
 */
export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const { clientId, clientSecret } = await getCredentials()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL

  const response = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${appUrl}/api/amazon/callback`,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to exchange authorization code: ${error}`)
  }

  return response.json()
}
