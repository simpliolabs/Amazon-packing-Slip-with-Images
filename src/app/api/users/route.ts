import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/server'

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
    .order('created_at', { ascending: false }) as { data: Array<{ id: string; email: string; full_name: string; role: string; created_at: string; [key: string]: unknown }> | null; error: { message: string } | null }

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
 * Invite a new user or reinvite an existing pending user (admin only)
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

  // If reinvite, delete the old user first so we can send a fresh invite
  if (reinvite) {
    try {
      // Find the existing auth user by email
      const { data: authUsers } = await adminSupabase.auth.admin.listUsers()
      const existingUser = authUsers?.users?.find(u => u.email === email)
      if (existingUser) {
        // Delete user_profiles record first (if exists)
        await supabase
          .from('user_profiles')
          .delete()
          .eq('id', existingUser.id)
        // Delete auth user
        await adminSupabase.auth.admin.deleteUser(existingUser.id)
      }
    } catch {
      // Continue with invite even if delete fails
    }
  }

  // Invite user via Supabase Admin API
  const { data: inviteData, error: inviteError } = await adminSupabase.auth.admin.inviteUserByEmail(
    email,
    {
      data: {
        role,
        full_name: fullName || '',
      },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    }
  )

  if (inviteError) {
    return NextResponse.json({ error: inviteError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, user: inviteData.user })
}
