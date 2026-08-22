/**
 * GET   /api/fba/blanks  — list every blank_specs row (active AND inactive), each annotated with
 *                          usedByFamilies (how many families currently resolve to it).
 * POST  /api/fba/blanks  — create a new blank.
 * PATCH /api/fba/blanks  — update an existing blank ({id, ...fields}); {id, active:false} deactivates.
 *
 * PO 2026-08-22 (handoff/BLANKS_IN_PORTAL_DESIGN.md §5.3, decision D): auth is the standing
 * /api/fba middleware (src/middleware.ts) — any signed-in user may write, never admin-gated — but
 * every write is stamped with `updated_by`/`created_by` (migration 064) for accountability.
 *
 * There is NO DELETE here on purpose: deleting a blank would silently re-point every family that
 * resolved to it onto whatever row is next in id/match order. Deactivate (`active:false`) instead.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { resolveUserName } from '@/lib/fba/claims'
import {
  validateBlankSpecInput, findDuplicateActiveStyleCode, toCatalogRows, groupFamilies, computeUsageCounts,
  type BlankSpecInput, type DbBlankRow, type AssignmentRow,
} from '@/lib/fba/blankAssignmentImpact'

const WRITABLE_FIELDS = [
  'match_pattern', 'style_code', 'garment_family', 'brand', 'brand_in_copy',
  'fit', 'sleeve', 'neck', 'weight_note', 'material', 'dye', 'stretch', 'fit_to_size',
  'unisex', 'active', 'notes',
] as const

export async function GET() {
  const admin = await createAdminClient()
  const { data: rows, error } = await admin.from('blank_specs').select('*').order('id', { ascending: true })
  if (error) {
    console.error('[blanks][GET] blank_specs read failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Best-effort usage counts: blank_assignments (migration 062) is owned by a concurrent agent and
  // may not exist yet in every environment — fail OPEN to "no assignments" so the list still renders
  // (SKU/legacy-only usage counts) rather than 500ing the whole page over a table that isn't live yet.
  const { data: assignmentRows, error: aErr } = await admin.from('blank_assignments').select('scope, key, style_code')
  if (aErr) console.warn('[blanks][GET] blank_assignments read failed (fail-open: no assignments):', aErr.message)

  const { data: contentRows, error: cErr } = await admin
    .from('listing_content')
    .select('parent_asin, sku, title')
    .not('parent_asin', 'is', null)
    .limit(20000)
  if (cErr) {
    console.error('[blanks][GET] listing_content read failed:', cErr.message)
    return NextResponse.json({ error: cErr.message }, { status: 500 })
  }

  const catalog = toCatalogRows((rows ?? []) as DbBlankRow[])
  const families = groupFamilies((contentRows ?? []) as { parent_asin?: string | null; sku?: string | null; title?: string | null }[])
  const usage = computeUsageCounts(catalog, families, (assignmentRows ?? []) as AssignmentRow[])

  const blanks = (rows ?? []).map((r: { id: number } & Record<string, unknown>) => ({ ...r, usedByFamilies: usage.get(r.id) ?? 0 }))
  return NextResponse.json({ blanks })
}

export async function POST(req: NextRequest) {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: BlankSpecInput
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const errors = validateBlankSpecInput(body, 'create')
  if (errors.length > 0) return NextResponse.json({ error: errors[0].message, errors }, { status: 400 })

  const admin = await createAdminClient()
  const { data: existing, error: existErr } = await admin.from('blank_specs').select('id, style_code, active')
  if (existErr) {
    console.error('[blanks][POST] duplicate-check read failed:', existErr.message)
    return NextResponse.json({ error: existErr.message }, { status: 500 })
  }
  const dupId = findDuplicateActiveStyleCode(
    (existing ?? []) as { id: number; style_code: string | null; active: boolean }[],
    body.style_code as string,
    null,
  )
  if (dupId != null) {
    return NextResponse.json({ error: `style_code "${body.style_code}" is already used by an active blank (id ${dupId})` }, { status: 409 })
  }

  const actedBy = await resolveUserName(user.id, user.email ?? null)
  const nowIso = new Date().toISOString()
  const insertRow = {
    match_pattern: (body.match_pattern as string).trim(),
    style_code: (body.style_code as string).trim().toUpperCase(),
    garment_family: body.garment_family,
    brand: body.brand?.trim() || null,
    brand_in_copy: typeof body.brand_in_copy === 'boolean' ? body.brand_in_copy : true,
    fit: body.fit?.trim() || null,
    sleeve: body.sleeve?.trim() || null,
    neck: body.neck?.trim() || null,
    weight_note: body.weight_note?.trim() || null,
    material: body.material?.trim() || null,
    dye: body.dye?.trim() || null,
    stretch: body.stretch?.trim() || null,
    fit_to_size: body.fit_to_size?.trim() || null,
    unisex: typeof body.unisex === 'boolean' ? body.unisex : null,
    active: typeof body.active === 'boolean' ? body.active : true,
    notes: body.notes?.trim() || null,
    created_by: actedBy,
    updated_by: actedBy,
    updated_at: nowIso,
  }
  const { data: inserted, error } = await admin.from('blank_specs').insert(insertRow as never).select().single()
  if (error) {
    console.error('[blanks][POST] insert failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ blank: inserted })
}

export async function PATCH(req: NextRequest) {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: BlankSpecInput & { id?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (body.id == null) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const errors = validateBlankSpecInput(body, 'update')
  if (errors.length > 0) return NextResponse.json({ error: errors[0].message, errors }, { status: 400 })

  const admin = await createAdminClient()

  if (Object.prototype.hasOwnProperty.call(body, 'style_code') && body.style_code) {
    const { data: existing, error: existErr } = await admin.from('blank_specs').select('id, style_code, active')
    if (existErr) {
      console.error('[blanks][PATCH] duplicate-check read failed:', existErr.message)
      return NextResponse.json({ error: existErr.message }, { status: 500 })
    }
    const dupId = findDuplicateActiveStyleCode(
      (existing ?? []) as { id: number; style_code: string | null; active: boolean }[],
      body.style_code,
      body.id,
    )
    if (dupId != null) {
      return NextResponse.json({ error: `style_code "${body.style_code}" is already used by an active blank (id ${dupId})` }, { status: 409 })
    }
  }

  const actedBy = await resolveUserName(user.id, user.email ?? null)
  const patch: Record<string, unknown> = { updated_by: actedBy, updated_at: new Date().toISOString() }
  for (const key of WRITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const v = (body as Record<string, unknown>)[key]
      patch[key] = typeof v === 'string' ? (v.trim() || null) : v
    }
  }
  if (typeof patch.style_code === 'string') patch.style_code = (patch.style_code as string).toUpperCase()

  const { data: updated, error } = await admin.from('blank_specs').update(patch as never).eq('id', body.id).select().single()
  if (error) {
    console.error('[blanks][PATCH] update failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ blank: updated })
}
