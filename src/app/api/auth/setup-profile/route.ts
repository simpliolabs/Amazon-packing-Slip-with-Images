import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

/**
 * POST /api/auth/setup-profile
 * Creates a user_profile for the currently authenticated user if one doesn't exist.
 * Called after an invited user sets their password.
 */
export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if profile already exists
  const adminSupabase = await createAdminClient()
  const { data: existingProfile } = await adminSupabase
    .from('user_profiles')
    .select('id')
    .eq('id', user.id)
    .single()

  if (existingProfile) {
    return NextResponse.json({ message: 'Profile already exists' })
  }

  // Create the profile from user metadata
  // Note: Using 'as any' cast because the Supabase SSR client types
  // sometimes resolve user_profiles insert as 'never' despite correct schema
  const { error: insertError } = await (adminSupabase.from('user_profiles') as any).insert({
    id: user.id,
    email: user.email || '',
    full_name: user.user_metadata?.full_name || '',
    role: user.user_metadata?.role || 'packer',
  })

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
