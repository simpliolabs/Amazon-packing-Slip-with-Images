/**
 * garmentPerDesign.ts — per-DESIGN garment-blank display + write helpers for the listing page
 * (PO 2026-09-03: "the PO had no way to SEE or CHANGE" a wrong child-scope blank_assignments row —
 * B0DSCDZC6K's "Business B*tch" design shipped a Tee title for a design the PO says IS a
 * sweatshirt, because a `scope='child'` row seeded by migration 062 overrides the family's correct
 * SKU-derived code, and that row was visible/editable only via hand-written SQL).
 *
 * Deliberately kept SEPARATE from blankAssignmentImpact.ts, which imports blankSpecs.ts, which
 * imports `@supabase/supabase-js` and reads `SUPABASE_SERVICE_ROLE_KEY` (lazily, but still a
 * module the 'use client' listing page must never pull into its browser bundle). This module has
 * ZERO dependency on the DB catalog — it only re-groups the /api/fba/blank-assignment GET
 * response's already-resolved per-child rows (ResolutionSource, SOURCE_LABEL — SAME literal
 * strings the route computes) by design, and builds the write payloads for the per-design control.
 * Both the listing page and PerDesignCard import from HERE, never from blankAssignmentImpact.ts,
 * so the client bundle never gains a service-role-touching import.
 */

// Mirrors blankAssignmentImpact.ts's ResolutionSource exactly (duplicated as a literal union, not
// imported, to keep this module's import graph supabase-free) — every value is a copy-paste of the
// route's, so a drift here would be caught the moment a route response includes an unmapped key
// (SOURCE_LABEL[source] ?? source already fails open to the raw string, never a crash).
export type ResolutionSource = 'child-assignment' | 'sku-code' | 'family-assignment' | 'legacy' | null

/** The seller-facing label for each precedence level — the ONE copy of these strings; the family
 *  Garment row, the per-SKU Variant Breakdown row, and the per-design Garment row all import this
 *  so the badge text can never drift between the three surfaces. */
export const SOURCE_LABEL: Record<string, string> = {
  'child-assignment': 'assignment',
  'sku-code': 'from SKU code',
  'family-assignment': 'family default',
  'legacy': 'guessed from title',
}

export interface GarmentResolution { styleCode: string | null; source: ResolutionSource; blankId: number | null }
export interface ChildGarmentResolution extends GarmentResolution {
  sku: string | null
  asin: string | null
  /** What this ONE SKU would resolve to if its own explicit child assignment were cleared (family
   *  assignment / legacy / another child's SKU-code still apply unchanged) — computed server-side
   *  by the GET route (resolveChildFallback in blankAssignmentImpact.ts) so the client never needs
   *  the blank catalog to preview a clear. */
  fallback: GarmentResolution
}

/**
 * ONE design's displayed garment resolution: the FIRST of the design's SKUs that has a resolution
 * in `childResolutions` — the same "first SKU of the group is representative" convention
 * `perDesignEntries` (perDesign.ts) already uses for title/bullets/description, so a design's
 * Garment badge follows the identical rule as its Title/Bullets/Description bodies. Returns null
 * when the design has no SKUs, or none of them appear in `childResolutions` yet (garment data
 * still loading).
 */
export function resolveDesignGarment(
  designSkus: readonly string[],
  childResolutions: readonly ChildGarmentResolution[],
): ChildGarmentResolution | null {
  if (designSkus.length === 0) return null
  const bySku = new Map<string, ChildGarmentResolution>()
  for (const c of childResolutions) if (c.sku) bySku.set(c.sku, c)
  for (const sku of designSkus) {
    const hit = bySku.get(sku)
    if (hit) return hit
  }
  return null
}

export interface DesignAssignmentRequest { scope: 'child'; key: string; style_code: string }
export interface DesignClearRequest { scope: 'child'; key: string }

/**
 * Every {scope:'child', key, style_code} body the per-design Garment control's "assign" action
 * must PUT to /api/fba/blank-assignment — one per SKU belonging to the design, so EVERY SKU in a
 * multi-SKU design carries the same explicit blank (decision: write to every SKU in the design,
 * not a separate row per SKU in the UI — the design already broadcasts title/bullets/description
 * to all of its SKUs the same way; Business B*tch has 1 SKU, a sibling design has 8, and both must
 * end up with ONE consistent garment). Pure, so the fan-out is provable without mocking fetch.
 * Blank/whitespace SKUs are dropped defensively; callers should never pass one.
 */
export function buildDesignAssignmentRequests(designSkus: readonly string[], styleCode: string): DesignAssignmentRequest[] {
  const code = styleCode.trim()
  if (!code) return []
  return designSkus.filter((s) => s && s.trim()).map((sku) => ({ scope: 'child' as const, key: sku, style_code: code }))
}

/** The DELETE bodies for clearing every SKU in a design's explicit child assignment — the inverse
 *  fan-out of buildDesignAssignmentRequests. A DELETE for a SKU with no row is a harmless no-op
 *  (route.ts's `.delete().eq(...)` matches zero rows), so this is safe to call uniformly even when
 *  only some of the design's SKUs actually carry an explicit assignment. */
export function buildDesignClearRequests(designSkus: readonly string[]): DesignClearRequest[] {
  return designSkus.filter((s) => s && s.trim()).map((sku) => ({ scope: 'child' as const, key: sku }))
}
