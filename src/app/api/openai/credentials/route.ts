/**
 * OpenAI API credentials — admin-only CRUD via app_settings.
 *
 * Mirrors the Jungle Scout pattern (PR #82). The Settings UI calls this endpoint to
 * save / read masked status / disable the seller-provided OpenAI key. The pipeline
 * resolves the active key through lib/openai/credentials.ts: DB value wins, env var
 * falls back. So this UI is purely additive — historical env-var setups keep working.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { invalidateOpenAIKeyCache } from '@/lib/openai/credentials'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const admin = await createAdminClient()
  const { data: profile } = await admin
    .from('user_profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null }
  if (profile?.role !== 'admin') return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { admin }
}

export async function GET() {
  try {
    const { error, admin } = await requireAdmin()
    if (error) return error

    const { data: rows } = await admin
      .from('app_settings')
      .select('key, value')
      .in('key', ['openai_api_key', 'openai_enabled'])

    const settings: Record<string, string> = {}
    for (const row of rows ?? []) {
      settings[(row as { key: string; value: string }).key] = (row as { key: string; value: string }).value
    }

    const apiKey = settings['openai_api_key'] ?? ''
    const enabled = settings['openai_enabled'] === 'true'
    return NextResponse.json({
      hasApiKey: apiKey.length > 0,
      apiKeyMasked: apiKey.length > 4 ? `••••••••${apiKey.slice(-4)}` : apiKey.length > 0 ? '••••' : '',
      enabled,
      // Tell the UI whether an env-var fallback is configured — so the seller knows
      // their pipeline is running even before they paste a key here.
      envFallbackPresent: !!process.env.OPENAI_API_KEY,
    })
  } catch (err) {
    console.error('[GET /api/openai/credentials]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { error, admin } = await requireAdmin()
    if (error) return error

    const body = await request.json()
    const { apiKey } = body as { apiKey?: string }
    if (!apiKey?.trim()) {
      return NextResponse.json({ error: 'API Key is required' }, { status: 400 })
    }
    // Quick sanity check: OpenAI keys start with sk- (project keys sk-proj-...).
    const trimmed = apiKey.trim()
    if (!/^sk-/.test(trimmed)) {
      return NextResponse.json({ error: 'Key does not look like an OpenAI API key (should start with "sk-").' }, { status: 400 })
    }

    const now = new Date().toISOString()
    const upserts = [
      { key: 'openai_api_key', value: trimmed, updated_at: now },
      { key: 'openai_enabled', value: 'true', updated_at: now },
    ]
    for (const record of upserts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: dbErr } = await admin.from('app_settings').upsert(record as any, { onConflict: 'key' })
      if (dbErr) {
        console.error('[POST /api/openai/credentials] DB error:', dbErr)
        return NextResponse.json({ error: `Failed to save ${record.key}: ${dbErr.message}` }, { status: 500 })
      }
    }
    invalidateOpenAIKeyCache()
    return NextResponse.json({ success: true, message: 'OpenAI API key saved. AI features will use this key on the next request.' })
  } catch (err) {
    console.error('[POST /api/openai/credentials]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE() {
  try {
    const { error, admin } = await requireAdmin()
    if (error) return error

    const now = new Date().toISOString()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await admin.from('app_settings').upsert({ key: 'openai_enabled', value: 'false', updated_at: now } as any, { onConflict: 'key' })
    invalidateOpenAIKeyCache()
    return NextResponse.json({ success: true, message: 'OpenAI API key disabled.' })
  } catch (err) {
    console.error('[DELETE /api/openai/credentials]', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
