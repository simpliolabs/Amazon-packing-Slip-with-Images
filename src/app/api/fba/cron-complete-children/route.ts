/**
 * GET /api/fba/cron-complete-children
 * ─────────────────────────────────────────────────────────────────────────────
 * Catalog-wide family completion (PO 2026-06-15, "A"). Generalizes the #242 on-open child
 * backfill to the WHOLE catalog: for each parent, ask Amazon's catalog for the live VARIATION
 * children and BACKFILL a minimal row for any that listing_content is missing (the zero-sales /
 * no-FBA-inventory variations of Custom/Handmade families that the orders∪inventory funnel never
 * ingested). Shares ONE reconcile with the on-open path (reconcileFamilyChildren) so they never
 * drift. SP-API only — NO Jungle Scout credits. ADDITIVE: only inserts placeholder rows for
 * missing children; it never overwrites or deletes existing content.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>  OR  x-cron-secret: <CRON_SECRET>
 * (mirrors cron-verify-pushes — a Coolify/external scheduler hits this. Intentionally NOT in
 * vercel.json, so it is OFF until the scheduler is pointed at it: shipping the route runs nothing.)
 *
 * Time-budgeted: stops starting new parents once BUDGET_MS is up so it can't blow Coolify's
 * maxDuration. The reconcile is idempotent, so the next tick safely re-covers anything not reached
 * — and the deferred count is REPORTED (never a silent cap).
 *
 * Canary before enabling catalog-wide (safe — read + additive-upsert only):
 *   curl -s -H "x-cron-secret: $CRON_SECRET" "https://slip.theceo.store/api/fba/cron-complete-children"
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { reconcileFamilyChildren } from '@/lib/fba/familyReconcile'

export const dynamic = 'force-dynamic'
export const maxDuration = 600

const BUDGET_MS = 4 * 60 * 1000
const PARENT_LIMIT = 2000 // generous ceiling for a POD catalog; reported if hit (no silent cap)

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  const authed =
    request.headers.get('authorization') === `Bearer ${cronSecret}` ||
    request.headers.get('x-cron-secret') === cronSecret
  if (!cronSecret || !authed) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const start = Date.now()
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )

  // Source of parents: listing_seo_scores is one row per parent (queried with .single() elsewhere).
  // Stable order for a deterministic sweep. No rotation column yet — a single 4-min tick covers a
  // typical POD catalog; a very large catalog's overflow is DEFERRED to the next tick and reported.
  const { data: parentRows, error: pErr } = await supabase
    .from('listing_seo_scores')
    .select('parent_asin')
    .order('parent_asin', { ascending: true })
    .limit(PARENT_LIMIT)
  if (pErr) return NextResponse.json({ error: `parent query failed: ${pErr.message}` }, { status: 500 })
  const parents = [...new Set(
    (parentRows ?? [])
      .map((r) => (r as { parent_asin?: string | null }).parent_asin)
      .filter((p): p is string => !!p),
  )]

  let processed = 0
  let backfilledTotal = 0
  let reattachedTotal = 0
  let familiesCompleted = 0
  let deferred = 0
  const errors: string[] = []

  for (const parentAsin of parents) {
    if (Date.now() - start > BUDGET_MS) { deferred = parents.length - processed; break }
    try {
      const rec = await reconcileFamilyChildren(parentAsin, supabase)
      processed++
      reattachedTotal += rec.reattached
      if (rec.backfilled > 0) { backfilledTotal += rec.backfilled; familiesCompleted++ }
    } catch (e) {
      processed++
      if (errors.length < 20) errors.push(`${parentAsin}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const summary = {
    ok: true,
    triggered_at: new Date(start).toISOString(),
    elapsed_ms: Date.now() - start,
    parents_total: parents.length,
    parents_processed: processed,
    parents_deferred_budget: deferred, // picked up next tick — NOT silently dropped
    parent_limit_hit: parents.length >= PARENT_LIMIT,
    families_completed: familiesCompleted,
    children_backfilled: backfilledTotal,
    children_reattached: reattachedTotal,
    errors,
  }
  console.log(`[cron-complete-children] ${JSON.stringify(summary)}`)
  return NextResponse.json(summary)
}
