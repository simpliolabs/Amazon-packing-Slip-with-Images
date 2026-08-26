/**
 * GET/POST /api/fba/audience-lean — seller-declared audience lean, family AND per-design.
 *
 * GET  ?parentAsin=xxx        -> { audienceLean, audienceLeanByDesign }
 * POST { parent_asin, audience_lean, designKey? }
 *   - designKey ABSENT (legacy/default): writes the FAMILY scalar (PR #195, byte-identical to the
 *     pre-2026-08-26 behavior — every existing caller keeps working with no changes).
 *   - designKey PRESENT: writes ONE entry of the PER-DESIGN map (migration 066, PO 2026-08-26 —
 *     the garment per-design ruling — blank_assignments/062 — applied to audience). Mirrors
 *     design-name-override/route.ts's designKey branch exactly: a null/empty audience_lean DELETES
 *     that key (resets the design to inherit the family value) rather than storing an explicit null.
 *
 * Precedence is resolved by audienceAssignment.ts's resolveDesignAudienceLean — this route only
 * reads/writes the two columns it resolves; the resolution ITSELF happens in exactly one place,
 * shared with the pipeline (listingPipeline.ts's buildGroupTruthCtx). No second predicate here.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

const VALID = new Set(['male', 'female', 'lean_male', 'lean_female', 'unisex'])

export async function GET(req: NextRequest) {
  const parentAsin = new URL(req.url).searchParams.get('parentAsin')
  if (!parentAsin) return NextResponse.json({ error: 'parentAsin required' }, { status: 400 })
  try {
    const supabase = await createAdminClient()
    // select('*'), not a column list — audience_lean_by_design (066) may not exist yet on an
    // unmigrated env, and a missing column in an explicit select errors the WHOLE query (the same
    // trap design-name-override/route.ts and blankSpecs.ts both document).
    const { data, error } = await supabase
      .from('listing_seo_scores')
      .select('*')
      .eq('parent_asin', parentAsin)
      .single()
    if (error) return NextResponse.json({ audienceLean: null, audienceLeanByDesign: {} })
    const row = data as { audience_lean?: string | null; audience_lean_by_design?: Record<string, string> | null }
    return NextResponse.json({
      audienceLean: row?.audience_lean || null,
      audienceLeanByDesign: row?.audience_lean_by_design || {},
    })
  } catch {
    return NextResponse.json({ audienceLean: null, audienceLeanByDesign: {} })
  }
}

export async function POST(req: NextRequest) {
  let body: { parent_asin?: string; audience_lean?: string | null; designKey?: string }
  try { body = (await req.json()) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  const { parent_asin, audience_lean, designKey } = body
  if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  if (audience_lean != null && !VALID.has(audience_lean)) {
    return NextResponse.json({ error: `audience_lean must be one of ${[...VALID].join(', ')} or null` }, { status: 400 })
  }

  const supabase = await createAdminClient()

  // ── Per-design write (migration 066) — keyed by designKey on the JSONB map column, same
  // read-modify-write shape as design-name-override/route.ts's designKey branch. ──
  if (typeof designKey === 'string' && designKey.trim()) {
    const key = designKey.trim()
    const { data: existing, error: readErr } = await supabase
      .from('listing_seo_scores')
      .select('audience_lean_by_design')
      .eq('parent_asin', parent_asin)
      .single()
    if (readErr) {
      const friendly = /audience_lean_by_design|schema cache/i.test(readErr.message)
        ? 'audience_lean_by_design column not found — run supabase/migrations/066_audience_lean_by_design.sql in the Supabase SQL editor, then retry.'
        : readErr.message
      return NextResponse.json({ error: friendly }, { status: 500 })
    }
    const prevMap = (existing as { audience_lean_by_design: Record<string, string> | null } | null)?.audience_lean_by_design || {}
    const map: Record<string, string> = { ...prevMap }
    if (audience_lean) map[key] = audience_lean
    else delete map[key]
    const { error } = await supabase
      .from('listing_seo_scores')
      .update({ audience_lean_by_design: map } as never)
      .eq('parent_asin', parent_asin)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, designKey: key, audience_lean: audience_lean ?? null, audienceLeanByDesign: map })
  }

  // ── Family scalar write (PR #195) — UNCHANGED from before this route grew a designKey branch. ──
  const { error } = await supabase
    .from('listing_seo_scores')
    .update({ audience_lean: audience_lean ?? null } as never)
    .eq('parent_asin', parent_asin)
  if (error) {
    const friendly = /audience_lean|schema cache/i.test(error.message)
      ? 'audience_lean column not found — run supabase/migrations/029_audience_lean.sql in the Supabase SQL editor, then retry.'
      : error.message
    return NextResponse.json({ error: friendly }, { status: 500 })
  }
  return NextResponse.json({ ok: true, audience_lean: audience_lean ?? null })
}
