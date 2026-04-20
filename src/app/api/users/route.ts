import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'
import { randomUUID } from 'crypto'

/**
 * GET /api/users
 * Returns all users including pending invites (admin only)
 */
export async function GET(request: NextRequest) {
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
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fetch confirmed users from user_profiles
  const { data: users, error } = await supabase
    .from('user_profiles')
    .select('*')
    .order('created_at', { ascending: false }) as { data: Array<{ id: string; email: string; full_name: string; role: string; created_at: string; invite_token?: string; [key: string]: unknown }> | null; error: { message: string } | null }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Also fetch pending invited users from auth.users via admin client
  const adminSupabase = await createAdminClient()
  let pendingUsers: Array<{
    id: string
    email: string
    full_name: string
    role: string
    created_at: string
    status: 'pending'
    invite_token?: string
  }> = []

  try {
    const { data: authUsers } = await adminSupabase.auth.admin.listUsers()
    if (authUsers?.users) {
      const confirmedIds = new Set((users || []).map((u: { id: string }) => u.id))
      pendingUsers = authUsers.users
        .filter(au => !confirmedIds.has(au.id) && au.email)
        .map(au => ({
          id: au.id,
          email: au.email || '',
          full_name: au.user_metadata?.full_name || '',
          role: au.user_metadata?.role || 'packer',
          created_at: au.created_at,
          status: 'pending' as const,
        }))
    }
  } catch {
    // If admin list fails, just return confirmed users
  }

  // Merge: confirmed users (with status 'active') + pending users
  const usersList = users || []
  const allUsers = [
    ...usersList.map(u => ({ ...u, status: 'active' as const })),
    ...pendingUsers,
  ]

  return NextResponse.json({ users: allUsers })
}

/**
 * POST /api/users
 * Create a user and generate a reusable invite link.
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

  // Create the user via invite (this creates the auth.users entry with metadata)
  const { data: linkData, error: linkError } = await adminSupabase.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      data: {
        role,
        full_name: fullName || '',
      },
    },
  })

  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 500 })
  }

  const newUserId = linkData?.user?.id

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
    user: linkData?.user,
    inviteLink,
  })
}
