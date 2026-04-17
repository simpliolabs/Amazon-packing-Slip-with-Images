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
 * Create a user and generate an invite link (no email sent).
 * Returns the invite link for the admin to share manually.
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
        await supabase
          .from('user_profiles')
          .delete()
          .eq('id', existingUser.id)
        await adminSupabase.auth.admin.deleteUser(existingUser.id)
      }
    } catch {
      // Continue with invite even if delete fails
    }
  }

  // Generate an invite link without sending an email
  const { data: linkData, error: linkError } = await adminSupabase.auth.admin.generateLink({
    type: 'invite',
    email,
    options: {
      data: {
        role,
        full_name: fullName || '',
      },
      redirectTo: `${appUrl}/auth/callback`,
    },
  })

  if (linkError) {
    return NextResponse.json({ error: linkError.message }, { status: 500 })
  }

  // The generated link contains a token_hash and type parameter
  // We need to construct the proper invite URL that goes through our auth callback
  const properties = linkData?.properties
  const hashedToken = properties?.hashed_token
  
  // Build the invite URL: Supabase verify endpoint → redirects to our callback
  const inviteLink = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/verify?token=${hashedToken}&type=invite&redirect_to=${encodeURIComponent(`${appUrl}/auth/callback`)}`

  return NextResponse.json({
    success: true,
    user: linkData?.user,
    inviteLink,
  })
}
