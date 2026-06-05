/**
 * GET /api/fba/listing-optimizer/relink-status?child_skus=A,B,C
 *
 * Returns the most-recent pending or applied re-link submission per child SKU. The orphan
 * banner uses this to show "Submitted N min ago — Amazon processing" instead of repeatedly
 * offering the Re-link button after the seller has already pushed.
 *
 * Auto-resolution: if a pending row's child ASIN now reports a live VARIATION parent on Amazon
 * that matches what the seller asked for, mark the row applied. This way the banner clears
 * automatically the next time the page loads after Amazon finishes processing.
 *
 * Read-only for the UI; lazily issues SP-API calls when there are pending rows to verify.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

interface CatalogItem { asin?: string; relationships?: { relationships?: { type?: string; parentAsins?: string[] }[] }[] }
function liveParentOf(item: CatalogItem | undefined): string | undefined {
  for (const byMp of item?.relationships ?? []) {
    for (const r of byMp.relationships ?? []) {
      if (r.type === 'VARIATION' && r.parentAsins && r.parentAsins.length > 0) return r.parentAsins[0]
    }
  }
  return undefined
}

interface LogRow {
  id: string
  child_sku: string
  child_asin: string
  target_parent_sku: string
  submission_id: string | null
  status: 'pending' | 'applied' | 'failed'
  submitted_at: string
  applied_at: string | null
  last_checked_at: string | null
  error_message: string | null
}

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get('child_skus')
  if (!raw) return NextResponse.json({ statuses: [] })
  const skus = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (skus.length === 0) return NextResponse.json({ statuses: [] })
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: logs } = await (supabase as any)
      .from('relink_log')
      .select('*')
      .in('child_sku', skus)
      .in('status', ['pending', 'applied'])
      .order('submitted_at', { ascending: false })

    // Keep only the most recent row per child_sku.
    const latestPerSku = new Map<string, LogRow>()
    for (const row of (logs ?? []) as LogRow[]) {
      if (!latestPerSku.has(row.child_sku)) latestPerSku.set(row.child_sku, row)
    }
    if (latestPerSku.size === 0) return NextResponse.json({ statuses: [] })

    // Lazily verify any pending rows against the live SP-API catalog. Skip verification if we
    // checked the row within the last minute (avoid hammering SP-API on rapid UI refreshes).
    const pending = [...latestPerSku.values()].filter((r) => {
      if (r.status !== 'pending') return false
      if (!r.last_checked_at) return true
      const ageMs = Date.now() - new Date(r.last_checked_at).getTime()
      return ageMs > 60_000
    })
    if (pending.length > 0) {
      try {
        const token = await getAccessToken()
        const asins = [...new Set(pending.map((p) => p.child_asin).filter(Boolean))]
        const itemMap = new Map<string, CatalogItem>()
        for (let i = 0; i < asins.length; i += 20) {
          const batch = asins.slice(i, i + 20)
          const url =
            `${ENDPOINT}/catalog/2022-04-01/items?identifiers=${batch.join(',')}` +
            `&identifiersType=ASIN&marketplaceIds=${MARKETPLACE_ID}&includedData=relationships`
          const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
          if (!resp.ok) continue
          const json = (await resp.json()) as { items?: CatalogItem[] }
          for (const it of json.items ?? []) if (it.asin) itemMap.set(it.asin, it)
        }
        for (const row of pending) {
          const liveParent = liveParentOf(itemMap.get(row.child_asin))
          if (liveParent) {
            // The child has a parent on Amazon now. Mark applied — the seller's request landed.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase as any).from('relink_log').update({
              status: 'applied', applied_at: new Date().toISOString(), last_checked_at: new Date().toISOString(),
            }).eq('id', row.id)
            row.status = 'applied'; row.applied_at = new Date().toISOString()
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (supabase as any).from('relink_log').update({
              last_checked_at: new Date().toISOString(),
            }).eq('id', row.id)
          }
        }
      } catch (e) { console.warn('[relink-status] verification skipped:', e) }
    }

    return NextResponse.json({
      statuses: [...latestPerSku.values()].map((r) => ({
        child_sku: r.child_sku,
        target_parent_sku: r.target_parent_sku,
        status: r.status,
        submitted_at: r.submitted_at,
        applied_at: r.applied_at,
        submission_id: r.submission_id,
      })),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'relink-status failed' }, { status: 500 })
  }
}
