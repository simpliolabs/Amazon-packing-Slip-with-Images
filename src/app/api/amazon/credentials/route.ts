import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

/**
 * POST /api/amazon/credentials
 * Saves Amazon SP-API credentials to app_settings.
 * Admin only.
 */
export async function POST(request: NextRequest) {
  try {
    // Verify user is authenticated and is admin
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminClient = await createAdminClient()
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null }

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json()
    const { clientId, clientSecret, refreshToken } = body

    if (!clientId || !clientSecret || !refreshToken) {
      return NextResponse.json(
        { error: 'clientId, clientSecret, and refreshToken are required' },
        { status: 400 }
      )
    }

    // Save all three credentials to app_settings
    const now = new Date().toISOString()
    const upserts = [
      { key: 'amazon_client_id', value: clientId, updated_at: now },
      { key: 'amazon_client_secret', value: clientSecret, updated_at: now },
      { key: 'amazon_refresh_token', value: refreshToken, updated_at: now },
      { key: 'amazon_connected', value: 'true', updated_at: now },
    ]

    for (const record of upserts) {
      const { error } = await adminClient
        .from('app_settings')
        .upsert(record as any, { onConflict: 'key' })
      if (error) {
        console.error('Error upserting', record.key, error)
        return NextResponse.json(
          { error: `Failed to save ${record.key}: ${error.message}` },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
