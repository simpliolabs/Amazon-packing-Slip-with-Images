import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { invalidateCredentialsCache } from '@/lib/sync/jungleScoutClient'

/**
 * GET /api/jungle-scout/credentials
 * Returns masked Jungle Scout credential status for the settings UI.
 * Admin only.
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const adminClient = await createAdminClient()
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null }
    if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: rows } = await adminClient
      .from('app_settings')
      .select('key, value')
      .in('key', ['jungle_scout_api_key', 'jungle_scout_key_name', 'jungle_scout_enabled'])

    const settings: Record<string, string> = {}
    for (const row of rows ?? []) {
      settings[(row as { key: string; value: string }).key] = (row as { key: string; value: string }).value
    }

    const apiKey = settings['jungle_scout_api_key'] ?? ''
    const keyName = settings['jungle_scout_key_name'] ?? ''
    const enabled = settings['jungle_scout_enabled'] === 'true'

    return NextResponse.json({
      hasApiKey: apiKey.length > 0,
      apiKeyMasked: apiKey.length > 4 ? `••••••••${apiKey.slice(-4)}` : apiKey.length > 0 ? '••••' : '',
      keyName,
      enabled,
    })
  } catch (err) {
    console.error('[GET /api/jungle-scout/credentials]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/jungle-scout/credentials
 * Saves Jungle Scout API credentials to app_settings.
 * Admin only. Supports partial updates.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const adminClient = await createAdminClient()
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null }
    if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const body = await request.json()
    const { keyName, apiKey } = body as { keyName?: string; apiKey?: string }

    if (!keyName?.trim()) {
      return NextResponse.json({ error: 'Key Name is required' }, { status: 400 })
    }
    if (!apiKey?.trim()) {
      return NextResponse.json({ error: 'API Key is required' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const upserts = [
      { key: 'jungle_scout_key_name', value: keyName.trim(), updated_at: now },
      { key: 'jungle_scout_api_key', value: apiKey.trim(), updated_at: now },
      { key: 'jungle_scout_enabled', value: 'true', updated_at: now },
    ]

    for (const record of upserts) {
      const { error } = await adminClient
        .from('app_settings')
        .upsert(record as any, { onConflict: 'key' })
      if (error) {
        console.error('[POST /api/jungle-scout/credentials] DB error:', error)
        return NextResponse.json({ error: `Failed to save ${record.key}: ${error.message}` }, { status: 500 })
      }
    }

    // Invalidate the in-memory credentials cache so the new credentials take effect immediately
    invalidateCredentialsCache();

    return NextResponse.json({ success: true, message: 'Jungle Scout API credentials saved. Keyword intelligence is now active.' })
  } catch (err) {
    console.error('[POST /api/jungle-scout/credentials]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/jungle-scout/credentials
 * Disables Jungle Scout API (sets enabled=false).
 * Admin only.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const adminClient = await createAdminClient()
    const { data: profile } = await adminClient
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single() as { data: { role: string } | null }
    if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const now = new Date().toISOString()
    await adminClient
      .from('app_settings')
      .upsert({ key: 'jungle_scout_enabled', value: 'false', updated_at: now } as any, { onConflict: 'key' })

    return NextResponse.json({ success: true, message: 'Jungle Scout API disabled.' })
  } catch (err) {
    console.error('[DELETE /api/jungle-scout/credentials]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
