import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { logAudit } from '@/lib/audit'

/**
 * POST /api/amazon/credentials
 * Saves Amazon SP-API credentials to app_settings.
 * Admin only. Supports partial updates — secrets are only overwritten
 * when the client explicitly provides new values.
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

    if (!clientId) {
      return NextResponse.json(
        { error: 'clientId is required' },
        { status: 400 }
      )
    }

    const now = new Date().toISOString()

    // Always update client ID
    const upserts: { key: string; value: string; updated_at: string }[] = [
      { key: 'amazon_client_id', value: clientId, updated_at: now },
      { key: 'amazon_connected', value: 'true', updated_at: now },
    ]

    // Only update secrets if new values are provided
    if (clientSecret && clientSecret.trim()) {
      upserts.push({ key: 'amazon_client_secret', value: clientSecret.trim(), updated_at: now })
    }
    if (refreshToken && refreshToken.trim()) {
      upserts.push({ key: 'amazon_refresh_token', value: refreshToken.trim(), updated_at: now })
    }

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

    // Audit log for credential update
    await logAudit({
      userId: user.id,
      action: 'settings.update_credentials',
      resourceType: 'settings',
      details: {
        updatedFields: [
          'client_id',
          ...(clientSecret ? ['client_secret'] : []),
          ...(refreshToken ? ['refresh_token'] : []),
        ],
      },
      ipAddress: request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || undefined,
      userAgent: request.headers.get('user-agent') || undefined,
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
