/**
 * familyDesignGroups.ts — the family's design groups + per-design NAME signals, read from the DB.
 *
 * ONE grouping (PO 2026-08-21): detectDesignGroups over the family's child SKUs — the same keys the
 * pipeline stamps on per_child_titles / per_child_item_highlights and scan-identity {per_design}
 * scans by. Used by keyword-pool/rerate {per_design:true} to rate the pool against EACH design's
 * card. READ ONLY: listing_content, listing_seo_scores, listing_seo_recommendations. ZERO Jungle
 * Scout involvement by construction (imports only the pure grouping function).
 */
import { detectDesignGroups, type DesignGroup } from './listingPipeline'

export interface FamilyDesignGroup extends DesignGroup {
  /** listing_seo_scores.design_name_overrides[key] — the seller's per-design name (source 1). */
  sellerName: string | null
  /** per_child_titles' resolved designName for this key (the pipeline's resolved name, source 4). */
  resolvedName: string | null
  /** The design's per-child title(s) — the rater's labelled-unreliable "current title". */
  titles: string[]
}

export interface FamilyDesignGroups {
  /** Multi by the seller override (authoritative) else the detector. */
  isMultiDesign: boolean
  groups: FamilyDesignGroup[]
  audienceLean: string | null
  productTitle: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadFamilyDesignGroups(parentAsin: string, db: any): Promise<FamilyDesignGroups> {
  const { data: rows, error: rowsErr } = await db
    .from('listing_content')
    .select('sku, asin')
    .eq('parent_asin', parentAsin)
    .order('sku', { ascending: true })
  if (rowsErr) throw new Error(`listing_content read failed for ${parentAsin}: ${rowsErr.message}`)
  // One representative SKU per child ASIN (FBA/FBM twins share an ASIN — the -FBA SKU wins), the
  // same reduction scan-identity {per_design} applies.
  const byAsin = new Map<string, { sku: string; asin: string }>()
  for (const r of (rows ?? []) as { sku: string; asin: string }[]) {
    if (!r?.sku || !r?.asin) continue
    const ex = byAsin.get(r.asin)
    if (!ex || r.sku.endsWith('-FBA')) byAsin.set(r.asin, { sku: r.sku, asin: r.asin })
  }
  const children = [...byAsin.values()].sort((a, b) => a.sku.localeCompare(b.sku))

  const { data: scoreRow, error: scoreErr } = await db
    .from('listing_seo_scores')
    .select('is_multi_design_override, design_name_overrides, audience_lean, product_title')
    .eq('parent_asin', parentAsin)
    .maybeSingle()
  if (scoreErr) throw new Error(`listing_seo_scores read failed for ${parentAsin}: ${scoreErr.message}`)
  const score = (scoreRow ?? null) as { is_multi_design_override?: boolean | null; design_name_overrides?: Record<string, string> | null; audience_lean?: string | null; product_title?: string | null } | null

  const { data: recRow, error: recErr } = await db
    .from('listing_seo_recommendations')
    .select('per_child_titles')
    .eq('parent_asin', parentAsin)
    .maybeSingle()
  if (recErr) throw new Error(`listing_seo_recommendations read failed for ${parentAsin}: ${recErr.message}`)
  const pct = (Array.isArray((recRow as { per_child_titles?: unknown } | null)?.per_child_titles)
    ? (recRow as { per_child_titles: { title?: string; designName?: string | null; designKey?: string | null }[] }).per_child_titles
    : []) as { title?: string; designName?: string | null; designKey?: string | null }[]

  const detected = detectDesignGroups(children, { parentAsin })
  const override = score?.is_multi_design_override ?? null
  const isMultiDesign = override === true ? true : override === false ? false : detected.isMultiDesign
  const overrides = score?.design_name_overrides && typeof score.design_name_overrides === 'object' ? score.design_name_overrides : {}
  const groups: FamilyDesignGroup[] = detected.groups.map((g) => {
    const mine = pct.filter((t) => (t.designKey || '') === g.key)
    const resolvedName = mine.map((t) => (t.designName || '').trim()).find(Boolean) ?? null
    const titles = [...new Set(mine.map((t) => (t.title || '').trim()).filter(Boolean))]
    const sellerName = (overrides[g.key] || '').trim() || null
    return { ...g, sellerName, resolvedName, titles }
  })
  return { isMultiDesign, groups, audienceLean: score?.audience_lean ?? null, productTitle: score?.product_title ?? null }
}
