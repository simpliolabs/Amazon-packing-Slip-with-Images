import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const token_hash = searchParams.get('token_hash')
  const type = searchParams.get('type') as 'invite' | 'magiclink' | 'signup' | 'recovery' | 'email_change' | 'email'
  const next = searchParams.get('next') ?? '/'

  if (token_hash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({ type, token_hash })

    if (!error) {
      // Successfully verified — redirect to the next page
      return NextResponse.redirect(`${origin}${next}`)
    }

    console.error('verifyOtp error:', error.message)
  }

  // If verification failed, redirect to set-password with error
  return NextResponse.redirect(
    `${origin}/set-password?error=invite_expired`
  )
}
