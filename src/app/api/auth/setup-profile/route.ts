import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createRawAdmin } from '@supabase/supabase-js'

/**
 * POST /api/auth/setup-profile
 * Creates a user_profile for the currently authenticated user if one doesn't exist.
 * Also clears invite_token when called after password setup.
 * Records password_changed_at timestamp for expiration tracking.
 * Uses raw supabase-js admin client (not SSR) to bypass RLS for updates.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Parse optional body
  let passwordChanged = false
  try {
    const body = await request.json()
    passwordChanged = body?.passwordChanged === true
  } catch {
    // No body or invalid JSON — that's fine
  }

  // Use raw supabase-js admin client to bypass RLS
  const adminClient = createRawAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Check if profile already exists
  const { data: existingProfile } = await adminClient
    .from('user_profiles')
    .select('id, invite_token')
    .eq('id', user.id)
    .single()

  if (existingProfile) {
    // Build update payload
    const updatePayload: Record<string, unknown> = {}

    // Clear invite_token if it still exists (user has set their password)
    if (existingProfile.invite_token) {
      updatePayload.invite_token = null
    }

    // Record password change timestamp
    if (passwordChanged) {
      updatePayload.password_changed_at = new Date().toISOString()
    }

    if (Object.keys(updatePayload).length > 0) {
      const { error: updateError } = await adminClient
        .from('user_profiles')
        .update(updatePayload)
        .eq('id', user.id)

      if (updateError) {
        console.error('Failed to update profile:', updateError.message)
      } else {
        console.log('Updated profile for user:', user.id, updatePayload)
      }
    }

    return NextResponse.json({
      message: 'Profile already exists',
      tokenCleared: !!existingProfile.invite_token,
      passwordTimestampUpdated: passwordChanged,
    })
  }

  // Create the profile from user metadata
  const { error: insertError } = await adminClient
    .from('user_profiles')
    .insert({
      id: user.id,
      email: user.email || '',
      full_name: user.user_metadata?.full_name || '',
      role: user.user_metadata?.role || 'packer',
      password_changed_at: passwordChanged ? new Date().toISOString() : null,
    })

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
