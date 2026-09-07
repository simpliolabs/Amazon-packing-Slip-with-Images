/**
 * FIX (2026-09-06, controller RULING on the scoped re-reviewer's new Minor, final-rereview-2-findings.md
 * §3): the bulk/broadcast push path (`executeBulkDetailsPush`) re-derived a per-SKU Item-Highlight skip
 * reason from ABSENCE ("not in the seam's `values` map ⇒ no-line-for-design"), which was true only
 * until `repeat-in-stored-line` existed as a second reason (FIX WAVE 2, I-2b). At `pushExecutor.ts`
 * (pre-fix) the bulk loop:
 *   if (!own) { console.log(JSON.stringify({ tag: 'IH_PER_DESIGN_SKIP', ..., reason: NO_LINE_FOR_DESIGN })); continue }
 * — hardcodes NO_LINE_FOR_DESIGN for ANY absence and only `console.log`s it (never `emit`s it, never
 * surfaces it to the PO), unlike the single-push path (`loadDetailDiff`'s `skipReasonBySku`,
 * `executePush`'s details branch at :3903-3908, and the held-surfacing pass at :3983-3988) which reads
 * the REAL reason from `buildPerSkuItemHighlightMap`'s own `skipped` array and both emits a `progress`
 * event AND pushes a `{status:'skipped', error:<reason text>}` result.
 *
 * This file drives `resolveBulkSkuFields` — the pure, no-I/O per-SKU field-resolution helper extracted
 * from the bulk loop — directly, proving it reads the seam's real `skipped` reason (never assuming
 * `no-line-for-design` from bare absence) and reports each skip as a structured `{field, reason}`
 * entry the caller can both log and surface, instead of a silent, wrongly-labelled console.log.
 *
 * WHY A PURE HELPER, NOT THE WHOLE LOOP: `executeBulkDetailsPush` opens a live Supabase client +
 * SP-API token/seller chain (same class of function this repo's own precedent,
 * `pushExecutorRepeatInStoredLine.test.ts`, declines to drive behaviorally) — so the per-SKU
 * resolution logic is extracted into `resolveBulkSkuFields`, synchronous and dependency-free, and
 * tested directly here.
 */
import { describe, it, expect } from 'vitest'
import { resolveBulkSkuFields } from '@/lib/fba/pushExecutor'
import { buildPerSkuItemHighlightMap, NO_LINE_FOR_DESIGN, REPEAT_IN_STORED_LINE, type PerChildItemHighlight } from '@/lib/fba/perDesignItemHighlights'

// The exact reproduction line from final-rereview-2-findings.md §0(2) / perDesignItemHighlights.test.ts —
// 'Tee' appears twice, which `classifyStoredIhLine` refuses as 'repeat-in-stored-line'.
const STALE_LINE_REPEATED_TEE = 'Graphic Novelty Tee for Men, Boss Definition Motivation Wear, Funny Tee Gift Idea Today, Ring-Spun Cotton, Classic Fit'

describe('resolveBulkSkuFields (bulk-push per-design skip parity, 2026-09-06)', () => {
  const livePlans = [
    { field: 'Item Highlights', attribute: { spApiKey: 'item_highlight' } },
    { field: 'Fabric Type', attribute: { spApiKey: 'fabric_type' } },
  ]
  const desired = { fabric_type: '100% Cotton' }

  it('a stale `tee`-twice stored line (real seam output) yields repeat-in-stored-line — NOT no-line-for-design — as a structured skip, not a bare log', () => {
    const entries: PerChildItemHighlight[] = [
      { sku: 'BD64000L-BK', asin: 'B0BD000001', item_highlight: STALE_LINE_REPEATED_TEE, designKey: 'BD', designName: 'Boss Definition', hold: null },
    ]
    const seam = buildPerSkuItemHighlightMap(entries, [{ sku: 'BD64000L-BK', asin: 'B0BD000001' }], null)
    expect(seam.values.has('BD64000L-BK')).toBe(false)          // pre-condition: the seam DID refuse it
    expect(seam.skipped).toEqual([{ sku: 'BD64000L-BK', asin: 'B0BD000001', reason: REPEAT_IN_STORED_LINE }])

    const perDesignMaps = new Map([['Item Highlights', seam]])
    const result = resolveBulkSkuFields('BD64000L-BK', livePlans, perDesignMaps, desired)

    expect(result.skips).toEqual([{ field: 'Item Highlights', reason: REPEAT_IN_STORED_LINE }])
    expect(result.skips[0].reason).not.toBe(NO_LINE_FOR_DESIGN)
    // The field is dropped for this SKU (never a partial/other-design line) — same guarantee as before.
    expect(result.desiredSku.item_highlight).toBeUndefined()
    expect(result.skuKeys).not.toContain('item_highlight')
    // The unrelated broadcast field is unaffected by the per-design skip.
    expect(result.desiredSku.fabric_type).toBe('100% Cotton')
    expect(result.skuKeys).toContain('fabric_type')
  })

  it('a genuinely absent design (no entry at all) still reports no-line-for-design — the pre-existing reason is preserved, not collapsed away', () => {
    const seam = buildPerSkuItemHighlightMap([], [{ sku: 'ZZ-NOENTRY', asin: 'B0ZZ000001' }], null)
    expect(seam.skipped).toEqual([{ sku: 'ZZ-NOENTRY', asin: 'B0ZZ000001', reason: NO_LINE_FOR_DESIGN }])

    const perDesignMaps = new Map([['Item Highlights', seam]])
    const result = resolveBulkSkuFields('ZZ-NOENTRY', livePlans, perDesignMaps, desired)

    expect(result.skips).toEqual([{ field: 'Item Highlights', reason: NO_LINE_FOR_DESIGN }])
  })

  it('a SKU WITH its own composed line is never reported as skipped — the happy path is untouched', () => {
    const entries: PerChildItemHighlight[] = [
      { sku: 'OK-SKU', asin: 'B0OK000001', item_highlight: 'Bold Graphic Print, Soft Ring-Spun Cotton, Everyday Comfort Fit', designKey: 'OK', designName: 'OK Design', hold: null },
    ]
    const seam = buildPerSkuItemHighlightMap(entries, [{ sku: 'OK-SKU', asin: 'B0OK000001' }], null)
    expect(seam.skipped).toHaveLength(0)

    const perDesignMaps = new Map([['Item Highlights', seam]])
    const result = resolveBulkSkuFields('OK-SKU', livePlans, perDesignMaps, desired)

    expect(result.skips).toHaveLength(0)
    expect(result.desiredSku.item_highlight).toBe('Bold Graphic Print, Soft Ring-Spun Cotton, Everyday Comfort Fit')
    expect(result.skuKeys).toContain('item_highlight')
  })

  it('a broadcast-only plan set (no per-design field at all) resolves every field from `desired`, no skips', () => {
    const broadcastOnly = [{ field: 'Fabric Type', attribute: { spApiKey: 'fabric_type' } }]
    const result = resolveBulkSkuFields('ANY-SKU', broadcastOnly, new Map(), { fabric_type: '100% Cotton' })
    expect(result).toEqual({ desiredSku: { fabric_type: '100% Cotton' }, skuKeys: ['fabric_type'], skips: [] })
  })

  it('defends against a future third skip reason with no matching sku in `skipped` (defensive fallback only, never the normal path): falls back to no-line-for-design rather than throwing or reporting undefined', () => {
    // A map claiming the field is per-design, but whose skipped array is simply empty for this sku
    // (should not happen in practice — the seam always records a reason for every non-values sku —
    // but the helper must not crash or silently drop the skip if it ever does).
    const perDesignMaps = new Map([['Item Highlights', { values: new Map<string, string>(), skipped: [] }]])
    const result = resolveBulkSkuFields('EDGE-SKU', livePlans, perDesignMaps, desired)
    expect(result.skips).toEqual([{ field: 'Item Highlights', reason: NO_LINE_FOR_DESIGN }])
  })
})
