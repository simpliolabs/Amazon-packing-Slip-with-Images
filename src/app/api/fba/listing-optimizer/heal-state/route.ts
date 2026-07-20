/**
 * GET /api/fba/listing-optimizer/heal-state?parent_asin=...
 *
 * READ-ONLY diagnostic probe (2026-07-20 Path A). Answers: what is the actual state of every
 * heal/verify task the queue holds for this parent? Written to settle the workflow-verifier's
 * "the composite heal has never fired" hypothesis before we invest in the Feeds API fallback
 * (Path Z). If tasks exist and are exhausted → Feeds is the right next step. If none exist →
 * the trigger really isn't firing and we have a smaller bug to fix first.
 *
 * Returns every push_verification_tasks row for the parent (all kinds/fields/statuses), most
 * recent first. Same auth as sibling routes (middleware-gated /api/fba). No writes.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { clearManualHealFlagIfStale } from '@/lib/fba/verificationQueue'

/** POST — FORCE-CLEAR the heal:manual flag for a parent+container, unblocking a fresh heal:composite
 *  enqueue on the next push. Same-auth as sibling routes. Used to trigger Strategy 5 (Path Z, Feeds)
 *  on B0FKKN8XKV without waiting the 1-hour staleness threshold. Body: {parent_asin, container_key}. */
export async function POST(req: NextRequest) {
  let body: { parent_asin?: string; container_key?: string; confirm?: boolean }
  try { body = (await req.json().catch(() => ({}))) as typeof body }
  catch { return NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
  if (!body.parent_asin || !body.container_key) return NextResponse.json({ error: 'parent_asin + container_key required' }, { status: 400 })
  if (body.confirm !== true) return NextResponse.json({ error: 'confirm:true required (this force-clears a manual flag so the next push enqueues a fresh heal:composite task)' }, { status: 400 })
  const cleared = await clearManualHealFlagIfStale(body.parent_asin, body.container_key, 0)   // 0ms → clear regardless of age
  return NextResponse.json({ cleared, parent_asin: body.parent_asin, container_key: body.container_key })
}

export async function GET(req: NextRequest) {
  const parentAsin = new URL(req.url).searchParams.get('parent_asin')
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    const { data, error } = await db
      .from('push_verification_tasks')
      .select('id, parent_asin, field, kind, status, attempts, max_attempts, last_error, last_matched_count, last_total_count, next_check_at, heal_payload, created_at, updated_at, last_verified_at')
      .eq('parent_asin', parentAsin)
      .order('updated_at', { ascending: false })
      .limit(80)
    if (error) return NextResponse.json({ error: error.message ?? String(error) }, { status: 500 })
    const rows = (data ?? []) as Record<string, unknown>[]

    // Small summary for the human eye — counts by status and by (kind, field). Everything else the
    // raw rows already show. Kept in the same response so one GET is enough for triage.
    const byStatus: Record<string, number> = {}
    const byKindField: Record<string, number> = {}
    for (const r of rows) {
      const s = String(r.status ?? 'unknown')
      const kf = `${String(r.kind ?? 'unknown')}:${String(r.field ?? '-')}`
      byStatus[s] = (byStatus[s] ?? 0) + 1
      byKindField[kf] = (byKindField[kf] ?? 0) + 1
    }
    return NextResponse.json({ parent_asin: parentAsin, count: rows.length, byStatus, byKindField, rows })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
