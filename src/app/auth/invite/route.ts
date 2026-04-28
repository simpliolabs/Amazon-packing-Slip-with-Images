import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /auth/invite?token=<uuid>
 *
 * Secure invite flow — Step 1:
 * 1. Validates the reusable invite token from user_profiles
 * 2. Checks invite_expires_at for 72-hour TTL (Amazon Credential Management 1.4)
 * 3. Ensures the auth user exists (with email_confirm: true)
 * 4. Generates a magic link via admin.generateLink()
 * 5. Redirects to /auth/confirm with the hashed_token for server-side verification
 *
 * /auth/confirm calls verifyOtp() to establish the session with cookies,
 * then redirects to /set-password where the user sets their password.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://slip.theceo.store'

  if (!token) {
    return NextResponse.redirect(new URL('/login?error=Missing+invite+token', appUrl))
  }

  // Must use Service Role Key for admin actions
  const supabaseAdmin = createSupabaseAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // 1. Validate the invite token in user_profiles
  const { data: profile, error: lookupError } = await supabaseAdmin
    .from('user_profiles')
    .select('id, email, full_name, role, invite_expires_at')
    .eq('invite_token', token)
    .single()

  if (lookupError || !profile) {
    return NextResponse.redirect(
      new URL('/set-password?error=invalid_link', appUrl)
    )
  }

  // 2. Check invite expiration (72-hour TTL)
  if (profile.invite_expires_at) {
    const expiresAt = new Date(profile.invite_expires_at)
    if (new Date() > expiresAt) {
      return NextResponse.redirect(
        new URL('/set-password?error=invite_expired', appUrl)
      )
    }
  }

  // 3. Check if user already exists in Supabase Auth
  let userId = profile.id
  if (userId) {
    const { data: existingUser } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (!existingUser?.user) {
      // Profile row exists but auth user was deleted — recreate
      userId = null
    }
  }

  // 4. If user doesn't exist in auth, create them
  if (!userId) {
    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: profile.email,
      email_confirm: true, // Auto-confirm since admin invited them
      user_metadata: {
        full_name: profile.full_name || '',
        role: profile.role || 'packer',
      },
    })

    if (createError) {
      console.error('Failed to create user:', createError.message)
      return NextResponse.redirect(
        new URL('/login?error=Failed+to+create+account', appUrl)
      )
    }

    userId = newUser.user.id

    // Update user_profiles with the new auth user ID
    await supabaseAdmin
      .from('user_profiles')
      .update({ id: userId } as any)
      .eq('invite_token', token)
  }

  // 5. Ensure email is confirmed (in case user was created earlier without confirmation)
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    email_confirm: true,
  })

  // 6. Generate the Magic Link — we use the hashed_token for server-side verification
  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: profile.email,
  })

  if (linkError || !linkData?.properties?.hashed_token) {
    console.error('Failed to generate magic link:', linkError?.message)
    return NextResponse.redirect(
      new URL('/login?error=Failed+to+generate+session', appUrl)
    )
  }

  // 7. Redirect to our /auth/confirm route with the hashed_token
  const confirmUrl = new URL('/auth/confirm', appUrl)
  confirmUrl.searchParams.set('token_hash', linkData.properties.hashed_token)
  confirmUrl.searchParams.set('type', 'magiclink')
  confirmUrl.searchParams.set('next', `/set-password?token=${token}`)

  return NextResponse.redirect(confirmUrl)
}
