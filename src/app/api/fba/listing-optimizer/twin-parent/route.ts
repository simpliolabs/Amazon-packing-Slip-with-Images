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

/** Generate SKU-prefix CANDIDATES from longest to shortest, broken at each separator. The
 *  caller queries the DB with each in turn — the LONGEST that finds matches is the right one.
 *  Heuristic prefix-trimming alone is too fragile (you can't tell "482" the product code from
 *  "32G" the variation axis just by looking). Letting the data answer is more correct. */
function prefixCandidates(skus: string[]): string[] {
  if (skus.length === 0) return []
  // Start by computing the longest common prefix across the inputs (intersect at chars).
  let common = skus[0]
  for (const s of skus.slice(1)) {
    let i = 0; while (i < common.length && i < s.length && common[i] === s[i]) i++
    common = common.slice(0, i)
  }
  // Trim trailing partial segment so we don't anchor on "DAFEI-48".
  const sep = (s: string) => Math.max(s.lastIndexOf('-'), s.lastIndexOf('_'), s.lastIndexOf('.'))
  let p = common
  const lastSep = sep(p)
  if (lastSep > 0) p = p.slice(0, lastSep)
  // Walk back through every separator boundary, emitting each prefix while it's >=4 chars.
  const out: string[] = []
  while (p.length >= 4) {
    out.push(p)
    const s = sep(p)
    if (s <= 0) break
    p = p.slice(0, s)
  }
  return out
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
    const candidates = prefixCandidates(ownSkus)
    if (candidates.length === 0) return NextResponse.json({ parent_asin: parentAsin, prefix: '', twinParent: null })

    // 2) Try each candidate prefix from LONGEST to shortest. The first one that finds OTHER
    //    SKUs under a DIFFERENT parent is the right level of specificity. The longest match
    //    avoids false twins (e.g. matching on a 4-char brand prefix that owns dozens of unrelated
    //    products); the shortest fallback handles cases where only a coarse prefix matches.
    let usedPrefix = ''
    let twinParent: string | null = null
    let twinChildCount = 0
    for (const prefix of candidates) {
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
      if (top && top[1] > 0) {
        usedPrefix = prefix; twinParent = top[0]; twinChildCount = top[1]
        break
      }
    }

    return NextResponse.json({
      parent_asin: parentAsin,
      prefix: usedPrefix,
      candidatesTried: candidates,
      ownChildCount: ownRows.length,
      twinParent,
      twinChildCount,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'twin-parent lookup failed' }, { status: 500 })
  }
}
