/**
 * LIVE-FAMILY RECONCILE — shared by the on-open self-heal (ai-recommendations, #242) and the
 * catalog-wide cron (cron-complete-children, "A") so the two NEVER drift.
 *
 * Asks Amazon's Catalog Items API for a parent's live VARIATION childAsins and:
 *   (1) RE-ATTACH any listing_content row currently stored under a DIFFERENT parent (children the
 *       seller newly linked into the family, or rows healed from a stale/self-parent), and
 *   (2) BACKFILL a minimal Active row for any childAsin with NO listing_content row at all — the
 *       zero-sales / no-FBA-inventory variations (e.g. every variation of a Custom/Handmade
 *       listing) that the orders∪inventory→parent_asin funnel never ingested. The catalog is
 *       ground truth for the live family, so we CREATE a minimal row per missing child (resolving
 *       childAsin→SKU via Listings Items) so the optimizer enumerates + pushes to the FULL family.
 *
 * SP-API only (no Jungle Scout credits). ADDITIVE & idempotent: content is left blank (the push
 * writes optimized values, the next Scan fills current content), re-runs skip children that now
 * have rows, and it NEVER deletes or overwrites an existing row's content. OFFER-GATED: a child is
 * backfilled ONLY if it has a live offer — an offerless ("Missing offer") SKU would be materialized
 * as a phantom incomplete ASIN by a later push (the 2026-06-16 B0GHH4MQ7N incident).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface FamilyReconcileResult {
  /** Live VARIATION children Amazon reports for this parent (0 = not a variation family / no data). */
  childAsins: number
  /** Child rows moved to this parent from a different/stale parent_asin. */
  reattached: number
  /** New placeholder rows created for children that had no row at all. */
  backfilled: number
  /** childAsins that had no row before backfill (>= backfilled; some may resolve to no SKU). */
  missingAsins: number
}

export async function reconcileFamilyChildren(
  parentAsin: string,
  supabase: SupabaseClient,
  opts: { placeholderTitle?: string; backfillCap?: number } = {},
): Promise<FamilyReconcileResult> {
  const result: FamilyReconcileResult = { childAsins: 0, reattached: 0, backfilled: 0, missingAsins: 0 }

  const { getAccessToken } = await import('@/lib/amazon/auth')
  const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
  const MP = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
  const tok = await getAccessToken()

  const url = `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(parentAsin)}?marketplaceIds=${MP}&includedData=relationships`
  const resp = await fetch(url, { headers: { 'x-amz-access-token': tok } })
  if (!resp.ok) return result
  const cat = await resp.json() as { relationships?: { relationships?: { type?: string; childAsins?: string[] }[] }[] }
  const childAsins: string[] = []
  for (const byMp of cat.relationships ?? []) for (const r of byMp.relationships ?? []) {
    if (r.type === 'VARIATION' && Array.isArray(r.childAsins)) childAsins.push(...r.childAsins)
  }
  result.childAsins = childAsins.length
  if (childAsins.length === 0) return result

  const { data: matched } = await supabase
    .from('listing_content')
    .select('sku, asin, parent_asin, title')
    .in('asin', childAsins)
  const matchedRows = (matched ?? []) as { sku: string; asin: string; parent_asin: string | null; title: string | null }[]

  // (1) RE-ATTACH: child rows stored under a DIFFERENT parent → move them to this parent.
  const movable = matchedRows.filter((r) => r.parent_asin !== parentAsin)
  if (movable.length > 0) {
    const movableSkus = movable.map((r) => r.sku)
    await supabase.from('listing_content').update({ parent_asin: parentAsin }).in('sku', movableSkus)
    result.reattached = movableSkus.length
  }

  // (2) BACKFILL: childAsins with NO listing_content row at all.
  const knownAsins = new Set(matchedRows.map((r) => r.asin))
  const missingAsins = childAsins.filter((a) => !knownAsins.has(a))
  result.missingAsins = missingAsins.length
  if (missingAsins.length > 0) {
    try {
      const { data: sidRow } = await supabase.from('app_settings').select('value').eq('key', 'amazon_seller_id').maybeSingle()
      const sellerId = (sidRow as { value?: string } | null)?.value || process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID || ''
      // Placeholder title: caller-supplied (on-open passes a sibling's title), else borrow an
      // existing sibling's title so the row isn't blank-titled (the cron path). Left '' only when
      // the family has no titled sibling yet — the next Scan/push fills it.
      const placeholderTitle = opts.placeholderTitle || (matchedRows.find((r) => r.parent_asin === parentAsin && r.title)?.title ?? '')
      const nowIso = new Date().toISOString()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newRows: any[] = []
      if (sellerId) {
        for (const childAsin of missingAsins.slice(0, opts.backfillCap ?? 60)) { // cap: a runaway family can't stall the run
          // includedData=offers too — we backfill a child ONLY if it has a live offer (gate below).
          const lurl = `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}?identifiers=${encodeURIComponent(childAsin)}&identifiersType=ASIN&marketplaceIds=${MP}&includedData=summaries,offers`
          const lresp = await fetch(lurl, { headers: { 'x-amz-access-token': tok } })
          if (!lresp.ok) continue
          const ljson = await lresp.json() as { items?: { sku?: string; offers?: unknown[] }[] }
          for (const it of ljson.items ?? []) {
            if (!it.sku || /^amzn\./i.test(it.sku)) continue // skip Amazon-managed system SKUs
            // OFFER GATE: only backfill children that have a LIVE offer. An offerless SKU ("Missing
            // offer") would, when later PATCHed by a push, make Amazon CREATE a phantom incomplete
            // ASIN. Skip — never seed an offerless/unpushable row. Scoped to the offerless case: a
            // zero-sales / no-inventory child that DOES carry an offer still backfills (the reconcile's
            // legitimate purpose). The push update-only gate is the backstop if a bad row slips in.
            if (!Array.isArray(it.offers) || it.offers.length === 0) continue
            newRows.push({
              sku: it.sku, asin: childAsin, parent_asin: parentAsin, title: placeholderTitle,
              bullet_1: '', bullet_2: '', bullet_3: '', bullet_4: '', bullet_5: '',
              description: '', backend_keywords: '', image_count: 0, has_aplus: false,
              content_synced_at: nowIso,
            })
          }
        }
      }
      if (newRows.length > 0) {
        const { error: insErr } = await supabase.from('listing_content').upsert(newRows, { onConflict: 'sku' } as never)
        if (insErr) console.warn('[familyReconcile] backfill upsert failed:', insErr.message)
        else result.backfilled = newRows.length
      }
    } catch (be) { console.warn('[familyReconcile] backfill skipped (non-fatal):', be instanceof Error ? be.message : be) }
  }

  return result
}
