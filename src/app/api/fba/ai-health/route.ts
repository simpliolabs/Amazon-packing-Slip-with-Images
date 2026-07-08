import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

/**
 * GET /api/fba/ai-health — the site-wide AI status (migration 045, single row id=1).
 * Polled by AiHealthBanner in the fba layout so a hard OpenAI failure (quota/auth) recorded by
 * any AI route shows on EVERY page, not just the one that failed. Fails quiet: a missing table
 * (pre-migration) or any read error reports 'ok' — the banner must never break the portal.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const admin = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const { data, error } = await admin
      .from('ai_health')
      .select('status, kind, message, occurred_at, cleared_at')
      .eq('id', 1)
      .maybeSingle()
    if (error || !data) return NextResponse.json({ status: 'ok' })
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ status: 'ok' })
  }
}
