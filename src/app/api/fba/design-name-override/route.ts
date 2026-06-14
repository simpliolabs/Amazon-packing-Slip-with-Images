/**
 * GET/POST /api/fba/design-name-override?parentAsin=xxx
 * ─────────────────────────────────────────────────────────────────────────────
 * Seller-controlled DESIGN NAME override (PO 2026-06-14: "how do we prevent stuck
 * design again"). When set, the pipeline uses this verbatim as the design anchor —
 * no LLM extraction, no heuristic, no keyword-pool guessing. Mirrors the
 * competitor-asin endpoint pattern.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  const parentAsin = new URL(req.url).searchParams.get('parentAsin')
  if (!parentAsin) return NextResponse.json({ error: 'parentAsin required' }, { status: 400 })
  try {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
      .from('listing_seo_scores')
      .select('design_name_override')
      .eq('parent_asin', parentAsin)
      .single()
    if (error) return NextResponse.json({ designNameOverride: null })   // column may not exist pre-migration
    return NextResponse.json({
      designNameOverride: (data as { design_name_override: string | null })?.design_name_override || null,
    })
  } catch {
    return NextResponse.json({ designNameOverride: null })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { parentAsin, designNameOverride } = body as { parentAsin?: string; designNameOverride?: string | null }
    if (!parentAsin) return NextResponse.json({ error: 'parentAsin required' }, { status: 400 })
    // Trim + length cap (a sane upper bound for a design slogan; longer values are almost
    // certainly the seller pasting the whole title by accident).
    const trimmed = typeof designNameOverride === 'string' ? designNameOverride.trim().slice(0, 80) : ''
    const value = trimmed || null
    const supabase = await createAdminClient()
    const { error } = await supabase
      .from('listing_seo_scores')
      .update({ design_name_override: value } as never)
      .eq('parent_asin', parentAsin)
    if (error) {
      console.error('[design-name-override] update error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ success: true, designNameOverride: value })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
