import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /auth/callback
 *
 * Secure invite flow — Step 2:
 * After Supabase verifies the magic link, it redirects here with a `code`.
 * We exchange the code for a session (setting auth cookies on the response),
 * then redirect to the `next` URL (e.g., /set-password?token=xxx).
 *
 * Uses the cookie-on-redirect pattern from /auth/confirm — cookies are
 * attached directly to the redirect response so they travel to the browser.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'
  const inviteToken = searchParams.get('invite_token')

  // Use the public app URL for redirects — request.url resolves to
  // localhost:3000 inside Docker, which is wrong.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://slip.theceo.store'

  if (code) {
    // Build the success redirect URL
    let redirectPath = next
    if (inviteToken) {
      // Append invite_token as query param to the next URL
      const separator = next.includes('?') ? '&' : '?'
      redirectPath = `${next}${separator}token=${inviteToken}`
    }
    const redirectUrl = new URL(redirectPath, appUrl)

    // Create a redirect response FIRST — we'll attach cookies to THIS response
    const redirectResponse = NextResponse.redirect(redirectUrl)

    // Create Supabase client that writes cookies directly to the redirect response
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              // Set on the redirect response so cookies travel to the browser
              redirectResponse.cookies.set(name, value, options)
            })
          },
        },
      }
    )

    // Exchange the code for a session — this calls setAll to write
    // auth cookies onto our redirect response
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // Session cookies are now on redirectResponse — return it
      return redirectResponse
    }

    console.error('exchangeCodeForSession failed:', error.message, error.status)
  }

  // Auth failed — redirect to login with error
  return NextResponse.redirect(new URL('/login?error=Authentication+failed', appUrl))
}
