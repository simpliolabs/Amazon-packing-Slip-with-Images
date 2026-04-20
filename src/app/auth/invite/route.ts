import { createClient as createSupabaseAdmin } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /auth/invite?token=<uuid>
 *
 * Secure invite flow — Step 1:
 * 1. Validates the reusable invite token from user_profiles
 * 2. Ensures the auth user exists (with email_confirm: true)
 * 3. Generates a magic link via admin.generateLink()
 * 4. Redirects the user to the magic link action_link
 *
 * Supabase then verifies the magic link, creates an authenticated session,
 * and redirects to /auth/callback which forwards to /set-password.
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
    .select('id, email, full_name, role')
    .eq('invite_token', token)
    .single()

  if (lookupError || !profile) {
    return NextResponse.redirect(
      new URL('/login?error=Invalid+or+expired+invite+link', appUrl)
    )
  }

  // 2. Check if user already exists in Supabase Auth
  let userId = profile.id
  if (userId) {
    const { data: existingUser } = await supabaseAdmin.auth.admin.getUserById(userId)
    if (!existingUser?.user) {
      // Profile row exists but auth user was deleted — recreate
      userId = null
    }
  }

  // 3. If user doesn't exist in auth, create them
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

  // 4. Ensure email is confirmed (in case user was created earlier without confirmation)
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    email_confirm: true,
  })

  // 5. Generate the Magic Link
  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: profile.email,
    options: {
      redirectTo: `${appUrl}/auth/callback?next=/set-password&invite_token=${token}`,
    },
  })

  if (linkError || !linkData?.properties?.action_link) {
    console.error('Failed to generate magic link:', linkError?.message)
    return NextResponse.redirect(
      new URL('/login?error=Failed+to+generate+session', appUrl)
    )
  }

  // 6. Redirect the user to the Supabase magic link action URL
  // Supabase will verify the link, create an authenticated session,
  // and redirect to /auth/callback with a code
  return NextResponse.redirect(linkData.properties.action_link)
}
