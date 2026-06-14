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
