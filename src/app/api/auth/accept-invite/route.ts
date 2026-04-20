import { createClient as createAdminClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/auth/accept-invite
 * Accepts an invite by setting the user's password using the admin API.
 * No session required — uses the invite_token for authentication.
 */
export async function POST(request: NextRequest) {
  try {
    const { token, password } = await request.json()

    if (!token || !password) {
      return NextResponse.json(
        { error: 'Token and password are required' },
        { status: 400 }
      )
    }

    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters' },
        { status: 400 }
      )
    }

    const adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // 1. Look up the invite token to find the user
    const { data: profile, error: lookupError } = await adminClient
      .from('user_profiles')
      .select('id, email, full_name')
      .eq('invite_token', token)
      .single()

    if (lookupError || !profile) {
      return NextResponse.json(
        { error: 'Invalid or expired invite link. Please ask your admin for a new one.' },
        { status: 400 }
      )
    }

    // 2. Set the user's password and confirm email using the admin API
    const { error: updateError } = await adminClient.auth.admin.updateUserById(
      profile.id,
      { password, email_confirm: true }
    )

    if (updateError) {
      console.error('Failed to set password:', updateError.message)
      return NextResponse.json(
        { error: 'Failed to set password. Please try again.' },
        { status: 500 }
      )
    }

    // 3. Clear the invite token so the link stops working
    await adminClient
      .from('user_profiles')
      .update({ invite_token: null } as any)
      .eq('id', profile.id)

    return NextResponse.json({
      success: true,
      email: profile.email,
      message: 'Password set successfully. You can now log in.',
    })
  } catch (err) {
    console.error('Accept invite error:', err)
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    )
  }
}
