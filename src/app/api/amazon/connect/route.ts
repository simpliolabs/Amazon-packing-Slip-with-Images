import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/amazon/connect
 * Redirects the user to Amazon's OAuth consent screen.
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
  const state = Math.random().toString(36).substring(2, 15)

  const amazonAuthUrl = new URL('https://sellercentral.amazon.com/apps/authorize/consent')
  amazonAuthUrl.searchParams.set('application_id', clientId)
  amazonAuthUrl.searchParams.set('state', state)
  amazonAuthUrl.searchParams.set('redirect_uri', redirectUri)
  amazonAuthUrl.searchParams.set('version', 'beta')

  return NextResponse.redirect(amazonAuthUrl.toString())
}
