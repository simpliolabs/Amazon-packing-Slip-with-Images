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
      .select('design_name_override, design_name_overrides')
      .eq('parent_asin', parentAsin)
      .single()
    // Either column may not exist pre-migration; a missing column errors the WHOLE select, so fall
    // back to safe defaults rather than 500-ing on a not-yet-migrated env.
    if (error) return NextResponse.json({ designNameOverride: null, designNameOverrides: {} })
    const row = data as { design_name_override: string | null; design_name_overrides: Record<string, string> | null }
    return NextResponse.json({
      designNameOverride: row?.design_name_override || null,
      designNameOverrides: row?.design_name_overrides || {},
    })
  } catch {
    return NextResponse.json({ designNameOverride: null, designNameOverrides: {} })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { parentAsin, designNameOverride, designKey } = body as { parentAsin?: string; designNameOverride?: string | null; designKey?: string }
    if (!parentAsin) return NextResponse.json({ error: 'parentAsin required' }, { status: 400 })
    // Trim + length cap (a sane upper bound for a design slogan; longer values are almost
    // certainly the seller pasting the whole title by accident).
    const trimmed = typeof designNameOverride === 'string' ? designNameOverride.trim().slice(0, 80) : ''
    const value = trimmed || null
    const supabase = await createAdminClient()

    // ── Per-design override (multi-design families) — keyed by designKey on the JSONB map column.
    // A blank/empty name DELETES that key (resets the design to auto-detect). The scalar
    // design_name_override (single-design back-compat) is left untouched on this path.
    if (typeof designKey === 'string' && designKey.trim()) {
      const key = designKey.trim()
      const { data: existing, error: readErr } = await supabase
        .from('listing_seo_scores')
        .select('design_name_overrides')
        .eq('parent_asin', parentAsin)
        .single()
      if (readErr) {
        console.error('[design-name-override] read error:', readErr.message)
        return NextResponse.json({ error: readErr.message }, { status: 500 })
      }
      const map: Record<string, string> = { ...((existing as { design_name_overrides: Record<string, string> | null })?.design_name_overrides || {}) }
      if (value) map[key] = value
      else delete map[key]
      const { error } = await supabase
        .from('listing_seo_scores')
        .update({ design_name_overrides: map } as never)
        .eq('parent_asin', parentAsin)
      if (error) {
        console.error('[design-name-override] per-design update error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ success: true, designKey: key, designNameOverride: value, designNameOverrides: map })
    }

    // ── Single-design scalar path (unchanged) ──
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
