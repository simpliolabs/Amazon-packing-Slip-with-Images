/**
 * FAMILY ROSTER — the ONE enumeration of a variation family's seller SKUs.
 * ─────────────────────────────────────────────────────────────────────────────
 * INVARIANT 2: ONE RESOLVER. The family-skus route (GET /api/fba/listing-optimizer/family-skus)
 * and the VARIANT-DEATH ALARM must agree on what "the family" is. Before this module the route
 * enumerated inline (DB rows + live-discovered FBA/FBM twins, twin-name guarded) while the alarm
 * read listing_content alone — so on the Later Gator family (B0GML5V7KZ) the route listed 113
 * SKUs and the detector considered 42: listing_content historically deduped FBA/FBM pairs, and
 * the twins the push discovers live were never rows. A dead twin the detector never enumerates
 * can never be flagged.
 *
 * The merge RULE lives here, pure, and both consumers call it. They differ only in WHERE the
 * discovered twins come from:
 *   - family-skus route:  live Listings-Items discovery per ASIN (it is a display route).
 *   - variant-death alarm: the PERSISTED discovery — sku_offer_liveness rows the push gate /
 *     details gate / reconcile wrote (offerLiveness.ts). READ-side, zero Amazon calls, and it
 *     is literally the same Listings-Items answer the route would fetch, one push earlier.
 *
 * Rule (unchanged from the route, byte-for-byte in behavior):
 *   1. Seed with the cached (listing_content) rows; Amazon-managed system SKUs (amzn.*) out.
 *   2. Add each discovered SKU not already present ONLY IF its base name (fulfillment suffix
 *      stripped) matches a cached SKU under the SAME ASIN — the twin-name guard that keeps an
 *      unrelated SKU sharing an ASIN through a stale mapping out of the family (PR #63 bug).
 *   3. Sort by base_name, then FBA before FBM before unknown.
 * The variation PARENT hub is NOT part of the roster (the route appends it separately; the alarm
 * never considers a non-buyable hub a variant).
 */

export interface FamilySkuRef { sku: string; asin: string }

export type Fulfillment = 'FBA' | 'FBM' | 'unknown'

export interface FamilyRosterEntry {
  sku: string
  asin: string
  fulfillment: Fulfillment
  base_name: string
  /** 'cached' = had a listing_content row; 'discovered' = a twin known only from discovery
   *  (live or persisted). The alarm uses this: a discovered-only SKU has no content attestation,
   *  so only the offer-liveness prong applies to it. */
  origin: 'cached' | 'discovered'
}

/** Amazon-managed system SKUs (amzn.gr.* graded / returnless inventory, amzn.* in general) are
 *  not real seller listings and must never be enumerated. Same filter the push executor uses. */
export function isSystemSku(sku: string): boolean { return /^amzn\./i.test(sku) }

/** Strip the trailing fulfillment suffix so an FBA SKU and its FBM twin compare equal:
 *  "DAFEI-482-32G-FBA" → "DAFEI-482-32G", "DAFEI-482-32G" → "DAFEI-482-32G". */
export function stripFulfillmentSuffix(sku: string): string {
  return sku.replace(/[-_](?:FBA|FBM|AFN|MFN|FN)$/i, '')
}

/** Best-effort fulfillment tag from the SKU naming convention. UI badge only — the actual
 *  fulfillment can also be read from /summaries[].fulfillmentChannels, but the SKU suffix matches
 *  sellers' mental model here. */
export function fulfillmentOf(sku: string): Fulfillment {
  if (/[-_]FBA$/i.test(sku)) return 'FBA'
  if (/[-_]FBM$/i.test(sku) || /[-_]MFN$/i.test(sku)) return 'FBM'
  // No suffix: most sellers use the bare SKU for FBM and -FBA for FBA, but it's a convention not
  // a rule. Tag as FBM as the more-likely sibling of an -FBA twin.
  return /[-_]/.test(sku) ? 'FBM' : 'unknown'
}

const FULFILLMENT_ORDER: Record<Fulfillment, number> = { FBA: 0, FBM: 1, unknown: 2 }

/**
 * THE resolver (pure). `cached` = this family's listing_content rows; `discovered` = every SKU
 * discovery reported under the family's ASINs (any superset is fine — the twin-name guard only
 * admits SKUs that match a cached SKU under the same ASIN).
 */
export function resolveFamilyRoster(cached: FamilySkuRef[], discovered: FamilySkuRef[]): FamilyRosterEntry[] {
  const bySku = new Map<string, FamilyRosterEntry>()
  // 1) Seed with what the DB knows.
  for (const r of cached) {
    if (!r?.sku || isSystemSku(r.sku)) continue
    if (bySku.has(r.sku)) continue
    bySku.set(r.sku, {
      sku: r.sku, asin: r.asin, fulfillment: fulfillmentOf(r.sku),
      base_name: stripFulfillmentSuffix(r.sku), origin: 'cached',
    })
  }
  // 2) Twin-name-guarded merge of discovered SKUs.
  for (const d of discovered) {
    if (!d?.sku || isSystemSku(d.sku)) continue
    if (bySku.has(d.sku)) continue
    const dBase = stripFulfillmentSuffix(d.sku)
    const matchesKnown = cached.some((c) => c?.sku && c.asin === d.asin && stripFulfillmentSuffix(c.sku) === dBase)
    if (!matchesKnown) continue
    bySku.set(d.sku, {
      sku: d.sku, asin: d.asin, fulfillment: fulfillmentOf(d.sku), base_name: dBase, origin: 'discovered',
    })
  }
  // 3) Group by base_name (variant identity), then FBA before FBM.
  return [...bySku.values()].sort((a, b) => {
    if (a.base_name !== b.base_name) return a.base_name.localeCompare(b.base_name)
    return FULFILLMENT_ORDER[a.fulfillment] - FULFILLMENT_ORDER[b.fulfillment]
  })
}
