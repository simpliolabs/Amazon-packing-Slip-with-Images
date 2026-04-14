import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens } from '@/lib/amazon/auth'
import { createAdminClient } from '@/lib/supabase/server'
import { createClient } from '@/lib/supabase/server'

/**
 * GET /api/amazon/callback
 * Handles the OAuth2 redirect from Amazon after user grants access.
 * Stores the refresh_token in app_settings for future use.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(error)}`, request.url)
    )
  }

  if (!code) {
    return NextResponse.redirect(
      new URL('/settings?error=no_code', request.url)
    )
  }

  try {
    // Verify user is authenticated
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.redirect(new URL('/login', request.url))
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code)

    // Store refresh token securely in app_settings
    const adminSupabase = await createAdminClient()
    
    // Perform upserts individually to satisfy TypeScript types
    await adminSupabase.from('app_settings').upsert({
      key: 'amazon_refresh_token',
      value: tokens.refresh_token || '',
      updated_at: new Date().toISOString(),
    } as any)
    
    await adminSupabase.from('app_settings').upsert({
      key: 'amazon_connected',
      value: 'true',
      updated_at: new Date().toISOString(),
    } as any)

    return NextResponse.redirect(
      new URL('/settings?success=amazon_connected', request.url)
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.redirect(
      new URL(`/settings?error=${encodeURIComponent(message)}`, request.url)
    )
  }
}
