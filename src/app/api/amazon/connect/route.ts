import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import crypto from 'crypto'

/**
 * GET /api/amazon/connect
 * Redirects the user to Amazon's OAuth consent screen.
 * Generates a cryptographically secure state token to prevent CSRF.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const clientId = process.env.AMAZON_CLIENT_ID
  const appUrl = process.env.NEXT_PUBLIC_APP_URL

  if (!clientId) {
    return NextResponse.json(
      { error: 'AMAZON_CLIENT_ID not configured' },
      { status: 500 }
    )
  }

  const redirectUri = `${appUrl}/api/amazon/callback`
  // Use cryptographically secure random state for CSRF protection
  const state = crypto.randomBytes(32).toString('hex')

  const amazonAuthUrl = new URL('https://sellercentral.amazon.com/apps/authorize/consent')
  amazonAuthUrl.searchParams.set('application_id', clientId)
  amazonAuthUrl.searchParams.set('state', state)
  amazonAuthUrl.searchParams.set('redirect_uri', redirectUri)
  amazonAuthUrl.searchParams.set('version', 'beta')

  // Store state in a secure, httpOnly cookie for validation in callback
  const response = NextResponse.redirect(amazonAuthUrl.toString())
  response.cookies.set('amazon_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600, // 10 minutes
    path: '/api/amazon/callback',
  })

  return response
}
