import { createServerClient } from '@supabase/ssr'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://slip.theceo.store'

  if (!token) {
    return NextResponse.redirect(new URL('/set-password?error=invalid_link', appUrl))
  }

  // 1. Look up the invite token in user_profiles using the admin client
  const adminClient = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: profile, error: lookupError } = await adminClient
    .from('user_profiles')
    .select('id, email, full_name')
    .eq('invite_token', token)
    .single()

  if (lookupError || !profile) {
    console.error('Invite token lookup failed:', lookupError?.message)
    return NextResponse.redirect(new URL('/set-password?error=invite_expired', appUrl))
  }

  // 2. Generate a fresh magic link for this user's email
  const { data: linkData, error: linkError } = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email: profile.email,
  })

  if (linkError || !linkData) {
    console.error('generateLink failed:', linkError?.message)
    return NextResponse.redirect(new URL('/set-password?error=invite_expired', appUrl))
  }

  const { hashed_token } = linkData.properties

  // 3. Build the redirect response FIRST so we can attach cookies to it
  const redirectUrl = new URL('/set-password', appUrl)
  const redirectResponse = NextResponse.redirect(redirectUrl)

  // 4. Create a Supabase SSR client that writes cookies to the redirect response
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
            redirectResponse.cookies.set(name, value, options)
          })
        },
      },
    }
  )

  // 5. Verify the fresh token to establish a session — cookies go onto redirectResponse
  const { error: verifyError } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: hashed_token,
  })

  if (verifyError) {
    console.error('verifyOtp failed:', verifyError.message)
    return NextResponse.redirect(new URL('/set-password?error=invite_expired', appUrl))
  }

  // 6. Session established, cookies attached — redirect to set-password
  return redirectResponse
}
