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
        await (supabase.from('user_profiles') as any)
          .delete()
          .eq('id', existingUser.id)
        await adminSupabase.auth.admin.deleteUser(existingUser.id)
      }
    } catch {
      // Continue with invite even if delete fails
    }
  }

  // Create the user with email already confirmed — no verification email needed
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

  // Ensure user_profiles row exists with the invite_token
  if (newUserId) {
    // Upsert: create profile if not exists, or update invite_token if it does
    await (adminSupabase.from('user_profiles') as any).upsert({
      id: newUserId,
      email,
      full_name: fullName || '',
      role,
      invite_token: inviteToken,
    }, { onConflict: 'id' })
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
