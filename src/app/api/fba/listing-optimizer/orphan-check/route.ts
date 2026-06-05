/**
 * GET /api/fba/listing-optimizer/orphan-check?parent_asin=...
 *
 * Detects ORPHANED children — child ASINs we have stored under a parent, but whose LIVE Amazon
 * catalog no longer links them to that parent (the variation relationship broke, e.g. a
 * deprecated variation theme split the family). Per the SP-API Catalog Items 2022-04-01
 * `relationships` model: a healthy child carries a VARIATION relationship with `parentAsins`;
 * an orphan carries none. We also flag "re-parented" (live parent differs from our stored one).
 *
 * Read-only, best-effort. The seller's stored parent_asin IS the "should be in a family"
 * baseline; the missing/changed live parent link is the "currently isn't" signal.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

interface CatalogItem {
  asin: string
  relationships?: { relationships?: { type?: string; parentAsins?: string[] }[] }[]
}

/** Flatten the doubly-nested relationships and return the live VARIATION parent ASIN, if any. */
function liveParentOf(item: CatalogItem | undefined): string | undefined {
  for (const byMarketplace of item?.relationships ?? []) {
    for (const r of byMarketplace.relationships ?? []) {
      if (r.type === 'VARIATION' && r.parentAsins && r.parentAsins.length > 0) return r.parentAsins[0]
    }
  }
  return undefined
}

export async function GET(req: NextRequest) {
  const parentAsin = new URL(req.url).searchParams.get('parent_asin')
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  try {
    const supabase = await createAdminClient()
    const { data: rows } = await supabase
      .from('listing_content')
      .select('sku, asin, parent_asin')
      .eq('parent_asin', parentAsin)
    const all = (rows ?? []) as { sku: string; asin: string; parent_asin: string | null }[]

    // Children only — never the parent's own row (a parent returns childAsins, not parentAsins,
    // so it would false-positive as orphan). DO NOT dedup by ASIN here: FBA + FBM SKUs share the
    // same child ASIN but are SEPARATE listings on Amazon, each with its OWN parentage attribute.
    // If both are detached, each needs its own Re-link, so each must appear in the warning.
    const children = all.filter((c) => c.asin !== parentAsin)
    if (children.length === 0) return NextResponse.json({ parent_asin: parentAsin, children: [], orphanCount: 0 })

    const token = await getAccessToken()
    // Batch the API call by UNIQUE ASIN (no point fetching the same catalog item twice for two
    // SKUs of the same ASIN) but map the result back to every SKU.
    const uniqueAsins = [...new Set(children.map((c) => c.asin))]
    const itemMap = new Map<string, CatalogItem>()
    for (let i = 0; i < uniqueAsins.length; i += 20) {
      const batch = uniqueAsins.slice(i, i + 20)
      const url =
        `${ENDPOINT}/catalog/2022-04-01/items?identifiers=${batch.join(',')}` +
        `&identifiersType=ASIN&marketplaceIds=${MARKETPLACE_ID}&includedData=relationships`
      const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
      if (!resp.ok) continue // best-effort — a failed batch leaves those ASINs "unknown", not orphaned
      const json = (await resp.json()) as { items?: CatalogItem[] }
      for (const it of json.items ?? []) if (it.asin) itemMap.set(it.asin, it)
    }

    const result = children.map((c) => {
      const fetched = itemMap.has(c.asin)
      const liveParent = liveParentOf(itemMap.get(c.asin))
      let status: 'ok' | 'orphan' | 'reparented' | 'unknown'
      if (!fetched) status = 'unknown'                                  // couldn't verify — don't alarm
      else if (!liveParent) status = 'orphan'                           // no live parent link
      else if (c.parent_asin && liveParent !== c.parent_asin) status = 'reparented'
      else status = 'ok'
      return { sku: c.sku, asin: c.asin, storedParent: c.parent_asin, liveParent: liveParent ?? null, status }
    })
    const orphanCount = result.filter((r) => r.status === 'orphan' || r.status === 'reparented').length
    return NextResponse.json({ parent_asin: parentAsin, count: result.length, orphanCount, children: result })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'orphan check failed' }, { status: 500 })
  }
}
