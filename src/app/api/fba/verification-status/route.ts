/**
 * GET /api/fba/verification-status?parent_asin=B0XYZ
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns the count + details of in-flight auto-verifications for a parent ASIN
 * (PO directive 2026-06-13: "auto verify + re-push until 100% — notify on major flags").
 *
 * The listing page renders a small banner from this: "✓ N verifications in progress"
 * (pending) or "⚠ N need your attention" (needs_attention).
 *
 * Live-notice split: `healing` counts kind='heal' tasks that are pending/running (a self-heal is in
 * flight — the page shows the violet "do not re-push" banner), while `pending` counts ONLY plain
 * verify tasks, so the green "auto-verified" copy no longer absorbs heals. `tasks` carries kind,
 * heal_payload (missingAttrKeys for the banner text) and next_check_at (the "next attempt ~HH:MM").
 *
 * Best-effort: a missing table (migration 030 not applied) → empty counts, never errors.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const parent = url.searchParams.get('parent_asin')
  if (!parent) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })

  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).from('push_verification_tasks')
      .select('id, field, detail_field, expected_value, status, attempts, max_attempts, next_check_at, last_matched_count, last_total_count, last_error, kind, heal_payload')
      .eq('parent_asin', parent)
      .in('status', ['pending', 'running', 'needs_attention'])
      .order('next_check_at', { ascending: true })
    const tasks = (data ?? []) as { status: string; kind?: string | null }[]
    const isActive = (t: { status: string }) => t.status === 'pending' || t.status === 'running'
    const healing = tasks.filter((t) => t.kind === 'heal' && isActive(t)).length
    const pending = tasks.filter((t) => t.kind !== 'heal' && isActive(t)).length
    const needs_attention = tasks.filter((t) => t.status === 'needs_attention').length
    return NextResponse.json({ pending, healing, needs_attention, tasks: data ?? [] })
  } catch {
    return NextResponse.json({ pending: 0, healing: 0, needs_attention: 0, tasks: [] })
  }
}
