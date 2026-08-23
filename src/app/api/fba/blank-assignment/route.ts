/**
 * GET    /api/fba/blank-assignment?parentAsin=X — the family's + each child's CURRENT resolved
 *                                                  blank, its source, and the raw assignment rows.
 *                                                  Powers the listing page's Garment card.
 * PUT    /api/fba/blank-assignment  {scope:'family'|'child', key, style_code} — upsert an assignment.
 * DELETE /api/fba/blank-assignment  {scope, key} — clear an assignment (falls back to SKU/legacy).
 *
 * PO 2026-08-22 (handoff/BLANKS_IN_PORTAL_DESIGN.md §5.1/§5.3, decisions A/C/D): scope is the ONE
 * unified `blank_assignments` table (owned by a concurrent agent's migration 062 — this route reads
 * and writes it but does not create it). Auth is the standing /api/fba middleware — any signed-in
 * user may write (never admin-gated), stamped with `set_by` for accountability. An assignment never
 * auto-queues a regenerate (decision C) — this route only ever touches blank_assignments.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { resolveUserName } from '@/lib/fba/claims'
import {
  toCatalogRows, groupFamilies, buildAssignmentMaps, resolveFamily, styleCodeExists,
  type AssignmentRow, type DbBlankRow,
} from '@/lib/fba/blankAssignmentImpact'
import { invalidateBlankCaches } from '@/lib/fba/blankSpecs'

export async function GET(req: NextRequest) {
  const parentAsin = (new URL(req.url).searchParams.get('parentAsin') ?? '').trim().toUpperCase()
  if (!parentAsin) return NextResponse.json({ error: 'parentAsin required' }, { status: 400 })

  const admin = await createAdminClient()

  const { data: blankRows, error: bErr } = await admin.from('blank_specs').select('*').eq('active', true).order('id', { ascending: true })
  if (bErr) {
    console.error('[blank-assignment][GET] blank_specs read failed:', bErr.message)
    return NextResponse.json({ error: bErr.message }, { status: 500 })
  }

  const { data: contentRows, error: cErr } = await admin
    .from('listing_content')
    .select('parent_asin, sku, title, asin')
    .eq('parent_asin', parentAsin)
    .limit(500)
  if (cErr) {
    console.error('[blank-assignment][GET] listing_content read failed:', cErr.message)
    return NextResponse.json({ error: cErr.message }, { status: 500 })
  }
  const children = (contentRows ?? []) as { parent_asin?: string | null; sku?: string | null; title?: string | null; asin?: string | null }[]
  const childSkus = children.map((c) => c.sku).filter((s): s is string => !!s)

  // Best-effort: blank_assignments (migration 062) is owned by a concurrent agent and may not exist
  // yet in every environment — fail OPEN to "no assignments" so the card still shows the SKU/legacy
  // resolution rather than a hard error.
  const [{ data: familyAssignRows, error: faErr }, { data: childAssignRows, error: caErr }] = await Promise.all([
    admin.from('blank_assignments').select('scope, key, style_code').eq('scope', 'family').eq('key', parentAsin),
    childSkus.length > 0
      ? admin.from('blank_assignments').select('scope, key, style_code').eq('scope', 'child').in('key', childSkus)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ])
  if (faErr) console.warn('[blank-assignment][GET] family assignment read failed (fail-open):', faErr.message)
  if (caErr) console.warn('[blank-assignment][GET] child assignment read failed (fail-open):', caErr.message)

  const catalog = toCatalogRows((blankRows ?? []) as DbBlankRow[])
  const families = groupFamilies(children)
  const family = families.get(parentAsin) ?? { parentAsin, skus: [], hay: '' }
  const allAssignments = [...(familyAssignRows ?? []), ...(childAssignRows ?? [])] as AssignmentRow[]
  const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(allAssignments)

  // `blankId` (not the internal `rowId`) is the field name the listing page's GarmentResolution
  // type expects — kept consistent between the family object and every child object below.
  const familyRes = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
  const familyResolution = { styleCode: familyRes.styleCode, source: familyRes.source, blankId: familyRes.rowId }
  const childResolutions = children.map((c) => {
    const oneChild = { parentAsin: family.parentAsin, skus: c.sku ? [c.sku] : [], hay: family.hay }
    const res = resolveFamily(oneChild, catalog, childCodeBySku, familyCodeByAsin)
    return { sku: c.sku ?? null, asin: c.asin ?? null, styleCode: res.styleCode, source: res.source, blankId: res.rowId }
  })

  return NextResponse.json({
    family: familyResolution,
    children: childResolutions,
    assignments: {
      family: familyCodeByAsin.get(parentAsin) ?? null,
      child: Object.fromEntries(childCodeBySku.entries()),
    },
  })
}

export async function PUT(req: NextRequest) {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { scope?: string; key?: string; style_code?: string; note?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const scope = body.scope
  const key = (body.key ?? '').trim()
  const styleCode = (body.style_code ?? '').trim()
  if (scope !== 'family' && scope !== 'child') return NextResponse.json({ error: "scope must be 'family' or 'child'" }, { status: 400 })
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 })
  if (!styleCode) return NextResponse.json({ error: 'style_code is required' }, { status: 400 })

  const admin = await createAdminClient()
  const { data: blankRows, error: bErr } = await admin.from('blank_specs').select('style_code').eq('active', true)
  if (bErr) {
    console.error('[blank-assignment][PUT] blank_specs read failed:', bErr.message)
    return NextResponse.json({ error: bErr.message }, { status: 500 })
  }
  const knownCodes = ((blankRows ?? []) as { style_code: string | null }[]).map((r) => r.style_code).filter((c): c is string => !!c)
  if (!styleCodeExists(knownCodes, styleCode)) {
    return NextResponse.json({ error: `Unknown style_code "${styleCode}" — it must match an active blank_specs.style_code` }, { status: 400 })
  }

  const actedBy = await resolveUserName(user.id, user.email ?? null)
  const row = {
    scope,
    key: scope === 'family' ? key.toUpperCase() : key,
    style_code: styleCode.toUpperCase(),
    note: body.note?.trim() || null,
    set_by: actedBy,
    set_at: new Date().toISOString(),
  }
  const { error } = await admin.from('blank_assignments').upsert(row as never, { onConflict: 'scope,key' })
  if (error) {
    console.error('[blank-assignment][PUT] upsert failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  // Bust the pipeline's blankSpecs.ts caches so the very next regen sees this assignment instead
  // of serving up to 5 minutes of stale data (this route's own reads stay fresh regardless, since
  // GET above queries blank_assignments directly rather than through the cached reader).
  invalidateBlankCaches()
  return NextResponse.json({ success: true })
}

export async function DELETE(req: NextRequest) {
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { scope?: string; key?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const scope = body.scope
  const key = (body.key ?? '').trim()
  if (scope !== 'family' && scope !== 'child') return NextResponse.json({ error: "scope must be 'family' or 'child'" }, { status: 400 })
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 })

  const admin = await createAdminClient()
  const { error } = await admin
    .from('blank_assignments')
    .delete()
    .eq('scope', scope)
    .eq('key', scope === 'family' ? key.toUpperCase() : key)
  if (error) {
    console.error('[blank-assignment][DELETE] delete failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  invalidateBlankCaches()
  return NextResponse.json({ success: true })
}
