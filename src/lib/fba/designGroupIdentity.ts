/**
 * designGroupIdentity.ts — ONE identity per DESIGN for multi-design families.
 *
 * PO RULING 2026-08-21: "Design identity (vision scan) is likewise per design, never one image for
 * the family." `scanProductImage(childAsin, imageUrl)` already keys product_identity by ASIN and
 * `getProductImageUrl` reads catalog_products for child ASINs — so a design's identity is the
 * identity of ONE representative child of its group: the FIRST child of the group that has an
 * image (not blindly skus[0], whose catalog row may carry no image). Used by:
 *   - listingPipeline's per-group design-name resolution (full regen — may scan),
 *   - POST /api/fba/intelligence/scan-identity { parent_asin, per_design: true } (may scan),
 *   - the regenerate-item-highlight route (READ ONLY — never spends a vision call).
 * ZERO Jungle Scout involvement by construction (imports only the vision scanner).
 */
import type OpenAI from 'openai'
import { getCachedIdentity, getProductImageUrl, scanProductImage, type ProductIdentity } from '@/lib/keyword-engine/visionScanner'

export interface DesignGroupLike { key: string; skus: { sku: string; asin: string }[] }

export interface DesignGroupIdentity {
  key: string
  /** The child whose image was read (or whose cache was hit). null when no child had an image. */
  repAsin: string | null
  imageUrl: string | null
  identity: ProductIdentity | null
}

/** The phrases that name a design for the cross-design partition: designTheme + seedKeywords. */
export function identityPhrases(identity: ProductIdentity | null | undefined): string[] {
  if (!identity) return []
  return [identity.designTheme || '', ...(Array.isArray(identity.seedKeywords) ? identity.seedKeywords : [])]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
}

/** Distinct child ASINs of a group in SKU order (FBA/FBM twins share an ASIN — scan once). */
const groupAsins = (group: DesignGroupLike): string[] =>
  [...new Set(group.skus.map((s) => (s.asin || '').trim()).filter(Boolean))]

/**
 * SCAN (or cache-hit) the design's identity: the first child of the group that has an image.
 * A cache hit on ANY child of the group short-circuits before any image lookup — a design scanned
 * once is never scanned again for 30 days (scanProductImage's own freshness rule).
 * Best-effort: every failure returns identity:null (the callers fall back to name-only anchors).
 */
export async function scanDesignGroupIdentity(
  group: DesignGroupLike,
  opts: { openai?: OpenAI; force?: boolean } = {},
): Promise<DesignGroupIdentity> {
  const asins = groupAsins(group)
  if (!opts.force) {
    for (const asin of asins) {
      try {
        const cached = await getCachedIdentity(asin)
        if (cached) return { key: group.key, repAsin: asin, imageUrl: null, identity: cached }
      } catch { /* fall through to a scan */ }
    }
  }
  for (const asin of asins) {
    let url: string | null = null
    try { url = await getProductImageUrl(asin) } catch { url = null }
    if (!url) continue
    try {
      const identity = await scanProductImage(asin, url, { openai: opts.openai, forceRescan: opts.force === true })
      return { key: group.key, repAsin: asin, imageUrl: url, identity }
    } catch (e) {
      console.warn(`[designGroupIdentity] vision scan ${asin} (${group.key}) failed:`, e instanceof Error ? e.message : e)
      return { key: group.key, repAsin: asin, imageUrl: url, identity: null }
    }
  }
  console.warn(JSON.stringify({ tag: 'DESIGN_IDENTITY_NO_IMAGE', key: group.key, asins }))
  return { key: group.key, repAsin: null, imageUrl: null, identity: null }
}

/** READ ONLY: the design's cached identity (first child with a cache row). Never scans. */
export async function readDesignGroupIdentity(group: DesignGroupLike): Promise<DesignGroupIdentity> {
  for (const asin of groupAsins(group)) {
    try {
      const cached = await getCachedIdentity(asin)
      if (cached) return { key: group.key, repAsin: asin, imageUrl: null, identity: cached }
    } catch { /* next child */ }
  }
  return { key: group.key, repAsin: null, imageUrl: null, identity: null }
}
