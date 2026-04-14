/**
 * Amazon SP-API OAuth2 Token Management
 * Handles LWA (Login with Amazon) token refresh flow
 */

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
 * Get a valid access token, refreshing if necessary.
 * Uses in-memory cache to avoid unnecessary refreshes.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now()

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token
  }

  const clientId = process.env.AMAZON_CLIENT_ID
  const clientSecret = process.env.AMAZON_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Amazon SP-API credentials not configured. Set AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, and AMAZON_REFRESH_TOKEN in environment variables.'
    )
  }

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
 * Exchange an authorization code for tokens (used in OAuth callback)
 */
export async function exchangeCodeForTokens(code: string): Promise<TokenResponse> {
  const clientId = process.env.AMAZON_CLIENT_ID
  const clientSecret = process.env.AMAZON_CLIENT_SECRET
  const appUrl = process.env.NEXT_PUBLIC_APP_URL

  if (!clientId || !clientSecret) {
    throw new Error('Amazon SP-API credentials not configured.')
  }

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
