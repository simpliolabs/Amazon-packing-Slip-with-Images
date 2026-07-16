/**
 * POST /api/fba/aplus-scan  { asin }
 * ─────────────────────────────────────────────────────────────────────────────
 * A+-only "Scan now" self-heal (PO 2026-07-16). Re-checks JUST A+ status for one family
 * against Amazon (one API call), updates only the A+ columns, re-scores, and returns the fresh
 * numbers so the client can refetch. Narrow blast radius — never re-fetches title/bullets/keywords
 * (so it can't stomp freshly-pushed-but-not-yet-live copy under Amazon's 15min-6hr lag).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { rescanAplusForAsin } from '@/lib/sync/syncListingContent'

export async function POST(req: NextRequest) {
  try {
    const { asin } = (await req.json()) as { asin?: string }
    if (!asin || !/^[A-Z0-9]{10}$/i.test(asin)) {
      return NextResponse.json({ error: 'valid asin required' }, { status: 400 })
    }
    const supabase = await createAdminClient()
    const result = await rescanAplusForAsin(supabase, asin.toUpperCase())
    if (!result) return NextResponse.json({ scanned: false, reason: 'This listing has not been synced yet.' })
    return NextResponse.json({ scanned: true, ...result })
  } catch (err) {
    console.error('[aplus-scan] error:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
