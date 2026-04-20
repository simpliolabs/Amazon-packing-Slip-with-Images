import { createServerClient } from '@supabase/ssr'
import { NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = searchParams.get('next') ?? '/'

  // Use the public app URL for all redirects — request.url resolves to
  // localhost:3000 inside the Docker container, which is wrong.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://slip.theceo.store'

  if (token_hash && type) {
    // Build the success redirect URL using the PUBLIC domain
    const redirectUrl = new URL(next, appUrl)

    // Create a redirect response FIRST — we'll attach cookies to THIS response
    const redirectResponse = NextResponse.redirect(redirectUrl)

    // Create Supabase client that writes cookies directly to the redirect response.
    // This is the same pattern the middleware uses — it ensures verifyOtp's session
    // cookies are carried through the redirect to the browser.
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

    // Verify the OTP token — this establishes the session and calls setAll
    // to write auth cookies onto our redirect response
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })

    if (!error) {
      // Session cookies are now on redirectResponse — return it
      return redirectResponse
    }

    // Log the error for debugging
    console.error('verifyOtp failed:', error.message, error.status)
  }

  // Verification failed — redirect to set-password with error using PUBLIC domain
  const errorUrl = new URL('/set-password', appUrl)
  errorUrl.searchParams.set('error', 'invite_expired')
  return NextResponse.redirect(errorUrl)
}
