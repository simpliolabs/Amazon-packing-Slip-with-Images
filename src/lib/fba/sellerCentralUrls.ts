/**
 * ONE SEAM for every "open this in Seller Central" link the optimizer renders.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE EXISTS (PO 2026-08-21, live on B0DQ5YZH38: "The product LINK to open in
 * Amazon doesn't work on this pop up"):
 *
 * The ParentManualUpdateModal built its deep link inline and only when BOTH `parentSku` and
 * `productType` were handed to it — and those two props were sourced from a sibling
 * `heal:composite` verify-queue task payload. For B0DQ5YZH38 the verify queue holds ZERO heal
 * tasks, so both props were undefined and EVERY operator fell through to
 *
 *     https://sellercentral.amazon.com/abis/listing/edit?asin=<asin>&ref_=xx_addlisting_dnav_xx
 *
 * which the modal's own comment already recorded as opening a STUB without the composite fields.
 * A "reference input" (the heal payload) that is empty on the common path is a DEAD WIRE, and the
 * fallback it exposed was a link that doesn't work. Same stub shape was on the listing page header.
 *
 * THE RULE THIS MODULE ENFORCES: never emit the ASIN-only `abis/listing/edit?asin=…` shape again.
 * When no SKU is known we hand the operator the INVENTORY SEARCH url instead — it always resolves,
 * lists the matching SKUs, and lets them click through to the real editor in one more click. A
 * working two-click path beats a one-click stub.
 *
 * SHAPES:
 *   - parentVariationsUrl  — the PO-verified variations deep link (verified 2026-07-21); this is
 *     where a variation-parent composite (shirt_size etc.) is actually completed.
 *   - skuEditUrl           — the plain ABIS editor for a single (non-parent) SKU.
 *   - inventorySearchUrl   — LAST RESORT; the only shape allowed when no SKU is resolvable.
 *
 * `productType` is an OPTIONAL refinement on both editor shapes: it selects the right attribute
 * schema in the editor, but `sku` is what identifies the listing. When Amazon answers nothing for
 * the productType probe we omit the param rather than degrade to the inventory fallback — knowing
 * the SKU is already enough for the editor to open on the right listing.
 *
 * Pure. No fetches, no React. Every caller imports from here; no inline url building anywhere.
 */

const SELLER_CENTRAL = 'https://sellercentral.amazon.com'
const MARKETPLACE_ID = 'ATVPDKIKX0DER'

export interface SellerCentralTarget {
  /** Seller SKU. When absent/blank every builder degrades to the inventory search. */
  sku?: string | null
  asin: string
  /** Amazon productType (e.g. SHIRT). Omitted from the url when unknown. */
  productType?: string | null
}

const clean = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '')

/**
 * LAST-RESORT fallback and the ONLY allowed shape when no SKU is known. Always resolves: Seller
 * Central's inventory grid filtered to this ASIN, from which the operator opens the real editor.
 */
export function inventorySearchUrl(asin: string): string {
  return `${SELLER_CENTRAL}/inventory?searchTerm=${encodeURIComponent(clean(asin))}`
}

/**
 * Variation-parent deep link — jumps straight to the Variations tab of the parent hub, which is
 * where the blocking composite is completed. PO verified 2026-07-21 that the generic
 * `/abis/listing/edit` page opens a stub WITHOUT those fields, so this shape (not that one) is the
 * link the manual-update popup exists to hand over.
 */
export function parentVariationsUrl(target: SellerCentralTarget): string {
  const sku = clean(target.sku)
  const asin = clean(target.asin)
  if (!sku) return inventorySearchUrl(asin)
  const productType = clean(target.productType)
  const pt = productType ? `&productType=${encodeURIComponent(productType)}` : ''
  return (
    `${SELLER_CENTRAL}/abis/listing/edit/variations?sku=${encodeURIComponent(sku)}` +
    `&asin=${encodeURIComponent(asin)}${pt}` +
    `&marketplaceID=${MARKETPLACE_ID}&isVariationParent=true&ref_=myp_1x1#variations`
  )
}

/** Plain ABIS editor for ONE non-parent SKU (standalone listing or a single child). */
export function skuEditUrl(target: SellerCentralTarget): string {
  const sku = clean(target.sku)
  const asin = clean(target.asin)
  if (!sku) return inventorySearchUrl(asin)
  const productType = clean(target.productType)
  const pt = productType ? `&productType=${encodeURIComponent(productType)}` : ''
  return (
    `${SELLER_CENTRAL}/abis/listing/edit?sku=${encodeURIComponent(sku)}` +
    `&asin=${encodeURIComponent(asin)}${pt}` +
    `&marketplaceID=${MARKETPLACE_ID}&ref_=myp_1x1`
  )
}

/** Where the resolved parent SKU/productType came from — surfaced so the UI can say so. */
export type ParentTargetSource = 'heal' | 'family' | 'none'

export interface ResolveParentTargetInput {
  parentAsin: string
  /** heal:composite verify-task payload — AUTHORITATIVE when present (Amazon named this SKU). */
  healParentSku?: string | null
  healProductType?: string | null
  /** GET /api/fba/listing-optimizer/family-skus — live resolver, answers on every healthy family. */
  familyParentSku?: string | null
  familyProductType?: string | null
}

export interface ResolvedParentTarget {
  sku: string | null
  asin: string
  productType: string | null
  source: ParentTargetSource
}

/**
 * SELECTION ORDER — heal payload → family-skus → (no sku ⇒ inventory search at the builder).
 *
 * The heal payload wins when present because Amazon itself named that SKU in the rejection; the
 * family-skus resolver is the fallback that keeps the link working on the 99% of listings that have
 * no heal task at all (the B0DQ5YZH38 case). Fields are taken INDEPENDENTLY: a heal payload that
 * carries a SKU but no productType still gets the family-skus productType.
 */
export function resolveParentSellerCentralTarget(input: ResolveParentTargetInput): ResolvedParentTarget {
  const healSku = clean(input.healParentSku)
  const familySku = clean(input.familyParentSku)
  const sku = healSku || familySku || null
  const productType = clean(input.healProductType) || clean(input.familyProductType) || null
  const source: ParentTargetSource = healSku ? 'heal' : familySku ? 'family' : 'none'
  return { sku, asin: clean(input.parentAsin), productType, source }
}
