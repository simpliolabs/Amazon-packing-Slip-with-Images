import { createClient as createAdminClient } from '@supabase/supabase-js'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const token = searchParams.get('token')
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://slip.theceo.store'

  if (!token) {
    return NextResponse.redirect(new URL('/set-password?error=invalid_link', appUrl))
  }

  // Look up the invite token in user_profiles
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
    return NextResponse.redirect(new URL('/set-password?error=invite_expired', appUrl))
  }

  // Token is valid — redirect to set-password with the token
  // The set-password page will use this token to set the password via API
  return NextResponse.redirect(
    new URL(`/set-password?token=${encodeURIComponent(token)}`, appUrl)
  )
}
