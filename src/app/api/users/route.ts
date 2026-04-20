import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { randomUUID } from 'crypto'

/**
 * GET /api/users
 * Returns all users with status derived from invite_token (admin only).
 * invite_token IS NOT NULL → pending (hasn't set password)
 * invite_token IS NULL     → active (has set password)
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Admin check — RLS policy now lets admins see all profiles
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null }

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fetch ALL user_profiles — RLS now allows admin to see all rows
  const { data: users, error } = await supabase
    .from('user_profiles')
    .select('*')
    .order('created_at', { ascending: false }) as {
      data: Array<{
        id: string; email: string; full_name: string; role: string;
        created_at: string; invite_token?: string | null;
        [key: string]: unknown
      }> | null;
      error: { message: string } | null
    }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Derive status from invite_token — single source of truth
  const allUsers = (users || []).map(u => ({
    ...u,
    status: u.invite_token ? 'pending' as const : 'active' as const,
  }))

  return NextResponse.json({ users: allUsers })
}

/**
 * POST /api/users
 * Create a user and generate a reusable invite link.
 * Uses admin.createUser with email_confirm: true so email is always confirmed.
 * The invite link contains a UUID token stored in user_profiles.
 * Each click generates a fresh session server-side — link never expires
 * until the user sets their password.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single() as { data: { role: string } | null }

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: Admin only' }, { status: 403 })
  }

  const { email, role = 'packer', fullName, reinvite } = await request.json()

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  const adminSupabase = await createAdminClient()
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://slip.theceo.store'

  // If reinvite, delete the old user first so we can create a fresh one
  if (reinvite) {
    try {
      const { data: authUsers } = await adminSupabase.auth.admin.listUsers()
      const existingUser = authUsers?.users?.find(u => u.email === email)
      if (existingUser) {
        // Use admin client (service role) to bypass RLS for delete
        await (adminSupabase.from('user_profiles') as any)
          .delete()
          .eq('id', existingUser.id)
        await adminSupabase.auth.admin.deleteUser(existingUser.id)
      }
    } catch {
      // Continue with invite even if delete fails
    }
  }

  // Create the user with email already confirmed — no verification email needed
  // NOTE: The handle_new_user() trigger on auth.users INSERT automatically creates
  // a user_profiles row (without invite_token). We then UPDATE to set invite_token.
  const { data: newUser, error: createError } = await adminSupabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      role,
      full_name: fullName || '',
    },
  })

  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 500 })
  }

  const newUserId = newUser?.user?.id

  // Generate a reusable invite token (UUID)
  const inviteToken = randomUUID()

  // UPDATE the profile row created by the trigger to set invite_token
  // The trigger fires synchronously on INSERT, so the row exists by now
  if (newUserId) {
    const { error: updateError } = await (adminSupabase.from('user_profiles') as any)
      .update({ invite_token: inviteToken })
      .eq('id', newUserId)

    if (updateError) {
      console.error('Failed to set invite_token:', updateError)
    }
  }

  // Build the reusable invite URL — points to our /auth/invite route
  // which looks up the token, generates a fresh session, and redirects
  const inviteLink = `${appUrl}/auth/invite?token=${inviteToken}`

  return NextResponse.json({
    success: true,
    user: newUser?.user,
    inviteLink,
  })
}
