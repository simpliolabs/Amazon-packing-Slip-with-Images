/**
 * POST /api/fba/blanks/impact — the blast-radius preview for a prospective blank save
 * (handoff/BLANKS_IN_PORTAL_DESIGN.md §5.3, §6 step 4).
 *
 * Body: { style_code?, match_pattern?, id? } — `id` identifies the row being edited (omit when
 * creating a brand-new blank). Returns { resolvesTodayCount, wouldResolveCount, sampleAsins }.
 * The UI calls this BEFORE any save that changes style_code or match_pattern and shows the counts
 * in a confirm step; the actual matching/precedence logic lives in
 * src/lib/fba/blankAssignmentImpact.ts (REUSES blankSpecs.ts's extractStyleCode/matchBlankSpecRow —
 * never reimplements them).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { computeBlankImpact, groupFamilies, type AssignmentRow, type DbBlankRow } from '@/lib/fba/blankAssignmentImpact'

export async function POST(req: NextRequest) {
  let body: { style_code?: string | null; match_pattern?: string | null; id?: number | string | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (body.match_pattern && body.match_pattern.trim()) {
    try {
      new RegExp(body.match_pattern, 'i')
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid regular expression' }, { status: 400 })
    }
  }

  const admin = await createAdminClient()

  const { data: rows, error } = await admin.from('blank_specs').select('*').order('id', { ascending: true })
  if (error) {
    console.error('[blanks/impact][POST] blank_specs read failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Best-effort: blank_assignments (migration 062) is owned by a concurrent agent and may not exist
  // yet in every environment — fail OPEN to "no assignments" (SKU/legacy-only preview) rather than
  // 500ing the whole modal.
  const { data: assignmentRows, error: aErr } = await admin.from('blank_assignments').select('scope, key, style_code')
  if (aErr) console.warn('[blanks/impact][POST] blank_assignments read failed (fail-open: no assignments):', aErr.message)

  const { data: contentRows, error: cErr } = await admin
    .from('listing_content')
    .select('parent_asin, sku, title')
    .not('parent_asin', 'is', null)
    .limit(20000)
  if (cErr) {
    console.error('[blanks/impact][POST] listing_content read failed:', cErr.message)
    return NextResponse.json({ error: cErr.message }, { status: 500 })
  }

  const families = groupFamilies((contentRows ?? []) as { parent_asin?: string | null; sku?: string | null; title?: string | null }[])
  const result = computeBlankImpact(
    (rows ?? []) as DbBlankRow[],
    families,
    (assignmentRows ?? []) as AssignmentRow[],
    { id: body.id ?? null, styleCode: body.style_code ?? null, matchPattern: body.match_pattern ?? null },
  )
  return NextResponse.json(result)
}
