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
import { getAccessToken } from '@/lib/amazon/auth'
import { getSellerId, MARKETPLACE_ID } from '@/lib/fba/pushExecutor'

const SP_API_ENDPOINT = process.env.AMAZON_SPAPI_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'

/** Fetch LIVE parent-SKU state from SP-API — attributes + issues + summaries — for triage. Returns raw
 *  Amazon JSON so we can see exactly what shirt_size composite Amazon is holding and what issues[] it
 *  reports. Called by ?deep=1; the one probe the wbrimuhr6 workflow said to run before more code. */
async function fetchLiveParentState(sku: string): Promise<{
  ok: boolean; status: number; sku: string;
  shirt_size?: unknown; apparel_size?: unknown; color?: unknown; size?: unknown;
  variation_theme?: unknown; parentage_level?: unknown; item_name?: unknown;
  issues?: unknown; summaries?: unknown; rawAttributes?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const [sellerId, token] = await Promise.all([getSellerId(), getAccessToken()])
    const url = `${SP_API_ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes,issues,summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    const text = await resp.text()
    if (!resp.ok) return { ok: false, status: resp.status, sku, error: text.slice(0, 500) }
    const json = JSON.parse(text) as { attributes?: Record<string, unknown>; issues?: unknown; summaries?: unknown }
    const attrs = json.attributes ?? {}
    return {
      ok: true, status: resp.status, sku,
      shirt_size: attrs.shirt_size,
      apparel_size: attrs.apparel_size,
      color: attrs.color,
      size: attrs.size,
      variation_theme: attrs.variation_theme,
      parentage_level: attrs.parentage_level,
      item_name: attrs.item_name,
      issues: json.issues ?? [],
      summaries: json.summaries ?? [],
      rawAttributes: attrs,
    }
  } catch (e) {
    return { ok: false, status: 0, sku, error: e instanceof Error ? e.message : String(e) }
  }
}

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
  const url = new URL(req.url)
  const parentAsin = url.searchParams.get('parent_asin')
  const deep = url.searchParams.get('deep') === '1'
  const skuOverride = url.searchParams.get('sku') ?? undefined
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

    const byStatus: Record<string, number> = {}
    const byKindField: Record<string, number> = {}
    for (const r of rows) {
      const s = String(r.status ?? 'unknown')
      const kf = `${String(r.kind ?? 'unknown')}:${String(r.field ?? '-')}`
      byStatus[s] = (byStatus[s] ?? 0) + 1
      byKindField[kf] = (byKindField[kf] ?? 0) + 1
    }

    // ?deep=1 — also probe LIVE Amazon state (parent SKU attributes+issues+summaries). Read-only,
    // costs 1 SP-API GET call. Reveals whether shirt_size composite is (system+class) only vs the
    // dead-token triad, and lists Amazon's active issues[] on the parent — the ONE probe the
    // wbrimuhr6 workflow said to run before writing more heal-chain code.
    let live: Awaited<ReturnType<typeof fetchLiveParentState>> | null = null
    if (deep) {
      let parentSku = skuOverride
      // Fallback 1: mine heal_payload.parentSku from the freshest heal:composite queue row we already
      // fetched — this is the exact parent SKU the heal chain is targeting, so it never disagrees
      // with what pushExecutor sees. Preferred over any DB join.
      if (!parentSku) {
        for (const r of rows) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hp = (r as any).heal_payload as { parentSku?: string } | null
          if (hp?.parentSku && String(hp.parentSku).trim()) { parentSku = String(hp.parentSku).trim(); break }
        }
      }
      if (!parentSku) {
        live = { ok: false, status: 0, sku: '', error: `no parent SKU resolved for ${parentAsin} — pass ?sku=<sku>` }
      } else {
        live = await fetchLiveParentState(parentSku)
      }
    }

    return NextResponse.json({ parent_asin: parentAsin, count: rows.length, byStatus, byKindField, rows, live })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
