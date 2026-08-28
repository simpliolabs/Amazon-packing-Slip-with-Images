/**
 * Child colour resolver — the SINGLE entry point for "what colour is this child" (PO ruling
 * 2026-08-28, migration 072). Precedence:
 *
 *   stored catalog colour (listing_content.color)  →  decodeSkuColor(sku, title)  →  null
 *
 * WHY: decodeSkuColor (skuColorCodes.ts) parses TEXT — the SKU's last '-'-separated segment, any
 * single unambiguous segment, or the child's own title's trailing "- Color - Size". For an
 * Amazon-generated opaque SKU (B0DP5H8QBT: "1V-C6WM-US5T", "3A-MINF-4TRD", "4K-WJVI-T618",
 * "5M-0T69-IFXD") no segment is ever a colour code and none ever will be — every fallback returns
 * null, all children collapse to one backend-keywords string, and the degrade gate
 * (listingPipeline.ts's backendOutputProblems) freezes that family's backend forever with a
 * message implying the next retry might succeed. It never will; the failure is deterministic on
 * the SKU shape, not transient.
 *
 * This is NOT a third text-parsing heuristic (colour decoding has already been patched twice: the
 * FBM-suffix miss, then the middle-segment scan — see skuColorCodes.ts's own doc). It is an
 * independent, higher-precedence SOURCE — Amazon's own Catalog Items API, fetched by
 * src/lib/amazon/catalogColor.ts and stored per child ASIN by the backfill route
 * (/api/fba/admin/backfill-child-color) — that outranks parsing because it is ground truth, not
 * a guess. decodeSkuColor stays EXACTLY as it is and becomes the fallback for a child Amazon
 * hasn't been asked about yet (stored colour NULL/absent).
 *
 * Every existing caller resolving a VARIANT's colour must go through this function; decodeSkuColor
 * itself must never be called directly for that purpose again.
 *
 * Deliberately a PURE, synchronous function (no Supabase/SP-API access of its own): the one live
 * caller already loads every child's `listing_content` row (including `.color`, migration 072) in
 * ONE query, so passing that value in here keeps colour resolution at O(1) DB round trips per
 * family instead of one extra lookup per child.
 */
import { decodeSkuColor } from './skuColorCodes'

export type ChildColorSource = 'catalog' | 'sku' | 'none'

export interface ResolveChildColorInput {
  /** Child ASIN — carried for caller/log/test traceability; not itself part of the precedence
   *  logic (resolution depends only on sku/title/storedColor). */
  asin: string
  sku: string
  title?: string | null
  /** listing_content.color (migration 072). NULL/undefined/blank means "not fetched / unknown" —
   *  NEVER treat an empty string as a real colour. */
  storedColor?: string | null
}

export interface ResolveChildColorResult {
  color: string | null
  /** Which branch produced `color` — proves the precedence actually ran, not just that SOME string
   *  came back: 'catalog' (stored value, used verbatim) | 'sku' (decodeSkuColor fallback fired) |
   *  'none' (both failed). */
  source: ChildColorSource
}

export function resolveChildColor({ sku, title, storedColor }: ResolveChildColorInput): ResolveChildColorResult {
  const catalog = (storedColor ?? '').trim()
  if (catalog) return { color: catalog, source: 'catalog' }
  const decoded = decodeSkuColor(sku, title)
  if (decoded) return { color: decoded, source: 'sku' }
  return { color: null, source: 'none' }
}
