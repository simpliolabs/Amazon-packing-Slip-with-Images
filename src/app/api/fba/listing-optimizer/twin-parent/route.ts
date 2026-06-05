/**
 * GET /api/fba/listing-optimizer/twin-parent?parent_asin=...
 *
 * Finds the most likely "real" parent ASIN for what looks like a STALE parent. Used by the
 * dashboard after self-heal: once #53 moves children's parent_asin in our DB from the old
 * (stale) parent to the live one, the stale-parent badge from #51 stops firing because it
 * keyed off "reparented" children that are no longer stored under the donor. The donor row
 * keeps showing on the dashboard, and clicking it sends the seller to a now-empty page.
 *
 * Detection: take this parent's stored children's longest common SKU prefix. Find OTHER
 * parents in listing_seo_scores whose children share that prefix. The parent with the most
 * matching children is the twin. Returns null if none found.
 *
 * Read-only, best-effort. The seller can still manually click the original parent if they
 * want — this just provides a smarter default destination.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

/** Longest common SKU prefix across a set, broken at separators (-, _, .). Mirror the logic
 *  used by /related-orphans so the two routes agree on what counts as "related". */
function commonSkuPrefix(skus: string[]): string {
  if (skus.length === 0) return ''
  let prefix = skus[0]
  for (const s of skus.slice(1)) {
    let i = 0; while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++
    prefix = prefix.slice(0, i)
  }
  const lastSep = Math.max(prefix.lastIndexOf('-'), prefix.lastIndexOf('_'), prefix.lastIndexOf('.'))
  if (lastSep > 0) prefix = prefix.slice(0, lastSep)
  return prefix.length >= 4 ? prefix : ''
}

export async function GET(req: NextRequest) {
  const parentAsin = new URL(req.url).searchParams.get('parent_asin')
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  try {
    const supabase = await createAdminClient()

    // 1) Get THIS parent's currently stored children's SKUs (used to compute the prefix).
    //    Note: after self-heal, this set may be small (just the orphan remaining). We can still
    //    derive a prefix from it as long as the SKU is structured.
    const { data: own } = await supabase
      .from('listing_content')
      .select('sku, asin')
      .eq('parent_asin', parentAsin)
    const ownRows = (own ?? []) as { sku: string; asin: string }[]
    const ownSkus = ownRows.filter((r) => r.asin !== parentAsin).map((r) => r.sku)
    const prefix = commonSkuPrefix(ownSkus)
    if (!prefix) return NextResponse.json({ parent_asin: parentAsin, prefix: '', twinParent: null })

    // 2) Find OTHER child SKUs sharing that prefix, grouped by parent_asin. The parent with the
    //    most matching children is the most likely "real" family for these SKUs.
    const { data: related } = await supabase
      .from('listing_content')
      .select('sku, asin, parent_asin')
      .like('sku', `${prefix}%`)
      .neq('parent_asin', parentAsin)
    const counts = new Map<string, number>()
    for (const r of (related ?? []) as { parent_asin: string | null }[]) {
      if (!r.parent_asin) continue
      counts.set(r.parent_asin, (counts.get(r.parent_asin) ?? 0) + 1)
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    const twinParent = top?.[0] ?? null
    const twinChildCount = top?.[1] ?? 0

    return NextResponse.json({
      parent_asin: parentAsin,
      prefix,
      ownChildCount: ownRows.length,
      twinParent,
      twinChildCount,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'twin-parent lookup failed' }, { status: 500 })
  }
}
