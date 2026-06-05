/**
 * GET /api/fba/listing-optimizer/related-orphans?parent_asin=...
 *
 * Surfaces ORPHAN child SKUs that probably belong to THIS parent's family. Detection is
 * SKU-prefix based: we take this parent's current children's longest common SKU prefix,
 * find other SKUs in listing_content with the same prefix, and check which of those are
 * orphaned on Amazon (no VARIATION parentAsins via SP-API).
 *
 * Why this lives on the PARENT page: the existing orphan-check only flags children that are
 * currently STORED under a parent_asin. Once we (or the seller) fix that, the orphan disappears
 * from view. But from the seller's perspective the question is the opposite — "what orphans
 * SHOULD belong here?" — and the answer comes from looking at SKUs that look related but live
 * (live = on Amazon) under no parent.
 *
 * Also returns this parent's seller SKU (the value the Re-link modal needs), so the UI can
 * pre-fill it without asking the user.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

async function getSellerId(): Promise<string> {
  const supabase = await createAdminClient()
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'amazon_seller_id').single()
  const row = data as { value: string } | null
  if (row?.value) return row.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured.')
}

interface CatalogItem {
  asin?: string
  summaries?: { sku?: string }[]
  relationships?: { relationships?: { type?: string; parentAsins?: string[] }[] }[]
}

function liveParentOf(item: CatalogItem | undefined): string | undefined {
  for (const byMp of item?.relationships ?? []) {
    for (const r of byMp.relationships ?? []) {
      if (r.type === 'VARIATION' && r.parentAsins && r.parentAsins.length > 0) return r.parentAsins[0]
    }
  }
  return undefined
}

/** Longest common SKU prefix across a set, broken at separators (-, _, .). E.g.
 *  ["DAFEI-482-32G-FBA","DAFEI-482-64G.-FBA"] → "DAFEI-482". Empty if too short to be useful. */
function commonSkuPrefix(skus: string[]): string {
  if (skus.length === 0) return ''
  let prefix = skus[0]
  for (const s of skus.slice(1)) {
    let i = 0; while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++
    prefix = prefix.slice(0, i)
  }
  // Trim to last separator so we don't pick up partial segments (e.g. "DAFEI-482-3" → "DAFEI-482").
  const lastSep = Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.'))
  if (lastSep > 0) prefix = prefix.slice(0, lastSep)
  return prefix.length >= 4 ? prefix : ''
}

export async function GET(req: NextRequest) {
  const parentAsin = new URL(req.url).searchParams.get('parent_asin')
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  try {
    const supabase = await createAdminClient()

    // 1) This parent's current stored children (under THIS parent_asin) — used to compute prefix.
    const { data: stored } = await supabase
      .from('listing_content')
      .select('sku, asin')
      .eq('parent_asin', parentAsin)
    const storedRows = (stored ?? []) as { sku: string; asin: string }[]
    const storedAsins = new Set(storedRows.map((r) => r.asin))
    const storedSkus = new Set(storedRows.map((r) => r.sku))
    const prefix = commonSkuPrefix(storedRows.filter((r) => r.asin !== parentAsin).map((r) => r.sku))

    // Also resolve this parent's seller SKU via SP-API (needed for pre-fill in the Re-link modal).
    const token = await getAccessToken()
    const sellerId = await getSellerId()
    let parentSku: string | null = null
    try {
      const parentResp = await fetch(
        `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(parentAsin)}` +
        `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,relationships`,
        { headers: { 'x-amz-access-token': token } },
      )
      if (parentResp.ok) {
        const pj = (await parentResp.json()) as CatalogItem
        parentSku = pj.summaries?.[0]?.sku ?? null
      }
    } catch { /* best-effort — UI can still let the user type the SKU */ }
    // Fallback: getListingsItem for one of the stored child SKUs returns the seller SKU it was queried with,
    // but the parent's seller SKU isn't always derivable that way. Skip if SP-API didn't give us one.

    if (!prefix) return NextResponse.json({ parent_asin: parentAsin, parent_sku: parentSku, prefix: '', candidates: [] })

    // 2) Find OTHER child SKUs in listing_content that share the prefix but aren't already under
    //    this parent. Exclude this parent's own row and the family we already know about.
    const { data: candidatesRaw } = await supabase
      .from('listing_content')
      .select('sku, asin, parent_asin')
      .like('sku', `${prefix}%`)
      .neq('parent_asin', parentAsin)
    const candidates = (candidatesRaw ?? [])
      .map((r) => r as { sku: string; asin: string; parent_asin: string | null })
      .filter((r) => !storedSkus.has(r.sku) && !storedAsins.has(r.asin) && r.asin !== parentAsin)

    if (candidates.length === 0) return NextResponse.json({ parent_asin: parentAsin, parent_sku: parentSku, prefix, candidates: [] })

    // 3) Check each candidate's live parentage on Amazon. Batch by unique ASIN.
    const uniqueAsins = [...new Set(candidates.map((c) => c.asin))]
    const itemMap = new Map<string, CatalogItem>()
    for (let i = 0; i < uniqueAsins.length; i += 20) {
      const batch = uniqueAsins.slice(i, i + 20)
      const url =
        `${ENDPOINT}/catalog/2022-04-01/items?identifiers=${batch.join(',')}` +
        `&identifiersType=ASIN&marketplaceIds=${MARKETPLACE_ID}&includedData=relationships`
      const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
      if (!resp.ok) continue
      const json = (await resp.json()) as { items?: CatalogItem[] }
      for (const it of json.items ?? []) if (it.asin) itemMap.set(it.asin, it)
    }

    // 4) Keep only candidates that are ORPHANS on Amazon (no live VARIATION parent at all). Re-parented
    //    children correctly live elsewhere — surfacing them here as moveable would be the wrong message.
    const orphans = candidates
      .filter((c) => {
        const fetched = itemMap.get(c.asin)
        if (!fetched) return false                          // unknown — don't show
        return liveParentOf(fetched) === undefined          // truly no parent on Amazon
      })
      .map((c) => ({ sku: c.sku, asin: c.asin, storedParent: c.parent_asin }))

    return NextResponse.json({
      parent_asin: parentAsin,
      parent_sku: parentSku,
      prefix,
      candidates: orphans,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'related-orphans failed' }, { status: 500 })
  }
}
