/**
 * GET /api/fba/admin/push-log-check?parent_asin=B0XYZ
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only diagnostic for the "no ship dates" problem (PO: pushed keywords, still no
 * "shipped" stamp; field_pushed_at is {} for ALL fields on B0FKKN8XKV).
 *
 * The adversarial review proved it's NOT a field-name mismatch and NOT RLS — so the cause
 * is one of: (a) migration 015 not applied (table absent), (b) migration 016 not applied
 * (`field` column absent), or (c) the table exists but writes never persisted (e.g. a
 * NOT NULL / type / constraint error swallowed by logPush). This endpoint distinguishes
 * all three by probing the live table directly. No writes, no credits.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const parent = new URL(req.url).searchParams.get('parent_asin') || undefined
  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  const out: Record<string, unknown> = { parent_asin: parent ?? null }

  // 1) Does the table exist? (42P01 = undefined_table → migration 015 not applied)
  const probe = await db.from('keyword_push_log').select('id', { count: 'exact', head: true })
  if (probe.error) {
    out.tableExists = probe.error.code !== '42P01'
    out.error = { code: probe.error.code, message: probe.error.message }
    out.verdict = probe.error.code === '42P01'
      ? 'keyword_push_log TABLE DOES NOT EXIST — migration 015 was not applied on this database.'
      : `Cannot read keyword_push_log: ${probe.error.message}`
    return NextResponse.json(out)
  }
  out.tableExists = true
  out.totalRows = probe.count ?? null

  // 2) Does the `field` column exist? (42703 = undefined_column → migration 016 not applied)
  const fieldProbe = await db.from('keyword_push_log').select('field', { head: true }).limit(1)
  out.fieldColumnExists = !fieldProbe.error
  if (fieldProbe.error) {
    out.fieldColumnError = { code: fieldProbe.error.code, message: fieldProbe.error.message }
    out.verdict = fieldProbe.error.code === '42703'
      ? 'Table exists but the `field` column is MISSING — migration 016 was not applied. The read query .select(field, pushed_at) errors → every field shows no ship date.'
      : `Table exists but reading \`field\` failed: ${fieldProbe.error.message}`
    return NextResponse.json(out)
  }

  // 3) Both schema pieces present → what actually persisted for this parent?
  if (parent) {
    const rows = await db.from('keyword_push_log')
      .select('sku, field, status, pushed_at, error_message')
      .eq('parent_asin', parent)
      .order('pushed_at', { ascending: false })
      .limit(20)
    out.rowsForParent = rows.error ? { error: rows.error.message } : (rows.data ?? [])
    const data = (rows.data ?? []) as { field?: string; status?: string }[]
    const byField: Record<string, Record<string, number>> = {}
    for (const r of data) {
      const f = r.field ?? '(null)'
      byField[f] = byField[f] || {}
      const s = r.status ?? '(null)'
      byField[f][s] = (byField[f][s] || 0) + 1
    }
    out.summaryByFieldStatus = byField
    out.verdict = data.length === 0
      ? `Table + columns are fine, but ZERO keyword_push_log rows exist for ${parent}. The writes are failing silently (now logged server-side as "keyword_push_log insert FAILED both attempts") OR the pushes logged status='failed'. Push one field, then re-check this endpoint and the server logs for the exact Postgres error.`
      : `Table + columns fine. ${data.length} rows for ${parent}. If statuses are 'failed' the push didn't actually ship; if 'accepted' the ship date should now render.`
  } else {
    out.verdict = 'Table + `field` column both exist. Pass ?parent_asin=… to see what rows persisted for a listing.'
  }

  return NextResponse.json(out)
}

/**
 * POST /api/fba/admin/push-log-check
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-diagnose for "no ship dates" — does NOT require log access (PO is not a developer).
 * Attempts a REAL insert into keyword_push_log with a clearly-tagged diagnostic row, then
 * immediately deletes it, and returns the EXACT Postgres error string if the write failed.
 * That answer goes straight to the browser — no Coolify log grepping.
 */
export async function POST() {
  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  const diagnosticRow = {
    parent_asin: 'DIAGNOSTIC',
    sku: 'DIAG-TEST',
    field: 'keywords',
    new_value: 'diagnostic — safe to delete',
    status: 'pending',
  }

  // Attempt 1: full row (matches what pushExecutor writes for a real push).
  const ins = await db.from('keyword_push_log').insert(diagnosticRow).select('id')
  if (ins.error) {
    // Mirror pushExecutor's fallback: retry without the `field` column.
    const fallback = { ...diagnosticRow } as Record<string, unknown>
    delete fallback.field
    const ins2 = await db.from('keyword_push_log').insert(fallback).select('id')
    if (ins2.error) {
      return NextResponse.json({
        wrote: false,
        verdict: 'BOTH insert attempts failed — this is exactly why ship dates are missing. The Postgres errors below tell us which column/constraint to fix.',
        firstAttemptError: { code: ins.error.code, message: ins.error.message, details: ins.error.details, hint: ins.error.hint },
        secondAttemptError: { code: ins2.error.code, message: ins2.error.message, details: ins2.error.details, hint: ins2.error.hint },
      })
    }
    // The fallback succeeded — clean up + report.
    if (ins2.data?.[0]?.id) await db.from('keyword_push_log').delete().eq('id', ins2.data[0].id)
    return NextResponse.json({
      wrote: true,
      verdict: 'The full insert FAILED but the field-stripped fallback succeeded — meaning migration 016 (the `field` column) is missing on the live DB. Real pushes silently lose their field tag, so ship dates never index. Apply 016 (ALTER TABLE keyword_push_log ADD COLUMN IF NOT EXISTS field text NOT NULL DEFAULT \'keywords\';) and the dates will start appearing on the next push.',
      firstAttemptError: { code: ins.error.code, message: ins.error.message, details: ins.error.details, hint: ins.error.hint },
    })
  }

  // The full insert succeeded. Clean up.
  if (ins.data?.[0]?.id) await db.from('keyword_push_log').delete().eq('id', ins.data[0].id)
  return NextResponse.json({
    wrote: true,
    verdict: 'The diagnostic insert succeeded — keyword_push_log writes are fine. If ship dates still aren\'t appearing, the issue is somewhere else (e.g. pushes hit the route but never actually invoke logPush). Push a real field now and the date should appear.',
  })
}
