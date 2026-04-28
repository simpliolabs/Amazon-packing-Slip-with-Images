import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminSupabase } from '@supabase/supabase-js'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/auth/mfa-enrolled
 * Called after successful MFA enrollment to update user_profiles.mfa_enrolled flag.
 */
export async function POST() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminSupabase = createAdminSupabase(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )

  const { error: updateError } = await adminSupabase
    .from('user_profiles')
    .update({ mfa_enrolled: true })
    .eq('id', user.id)

  if (updateError) {
    console.error('Failed to update mfa_enrolled:', updateError)
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }

  await logAudit({
    userId: user.id,
    action: 'user.login' as any,
    resourceType: 'mfa',
    resourceId: user.id,
    details: { event: 'mfa_enrolled' },
  })

  return NextResponse.json({ success: true })
}
