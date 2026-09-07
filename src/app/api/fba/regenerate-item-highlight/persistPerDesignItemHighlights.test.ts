/**
 * FIX WAVE 2 (I-2a, 2026-09-06, final whole-branch review #2, controller RULING — Important #2):
 * `persistPerDesignItemHighlights` is the ONE writer this route uses for the per-design Item
 * Highlight detail row, for BOTH the partial-hold and all-held branches — the SAME shape
 * (`buildPerDesignIhDetailPatch`, listingPipeline.ts) the full-audit pipeline writes. Before this fix
 * the route's all-held branch (`composed.length === 0`) wrote NOTHING, so a pre-ruling stored line
 * stayed pushable and the card showed no Held badge until a full AI audit ran.
 *
 * These tests call the extracted writer DIRECTLY with a mocked `supabase` — proving the actual wire
 * this route runs (not a re-implementation of it) — without mocking the route's whole upstream chain
 * (keyword pool resolution, blank-brand resolution, design-group identity, SP-API selection context),
 * which route.test.ts's own header already documents as out of this round's scope (source-scan
 * precedent for the parts of this route that genuinely need a live Supabase/SP-API chain).
 */
import { describe, it, expect, vi } from 'vitest'
import { persistPerDesignItemHighlights } from './route'
import { buildItemHighlightsPerDesign } from '@/lib/fba/listingPipeline'
import type { PerDesignItemHighlight, SharedItemHighlight } from '@/lib/fba/listingPipeline'
import type { PerChildItemHighlight } from '@/lib/fba/perDesignItemHighlights'

type Built = { perDesign: PerDesignItemHighlight[]; perChild: PerChildItemHighlight[]; shared: SharedItemHighlight }

/** A minimal fake supabase client: only `.from(table).update(payload).eq(col, val)` is exercised by
 *  the writer. Records every call so the tests can assert the EXACT rows written. */
function fakeSupabase(updateResult: { error: { message: string } | null }) {
  const calls: { table: string; payload: unknown; eqCol: string; eqVal: string }[] = []
  const supabase = {
    from(table: string) {
      return {
        update(payload: unknown) {
          return {
            eq(eqCol: string, eqVal: string) {
              calls.push({ table, payload, eqCol, eqVal })
              return Promise.resolve(updateResult)
            },
          }
        },
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { supabase, calls }
}

const DETAILS = [
  { field_name: 'Some Other Field', recommended_value: 'x' },
  { field_name: 'Item Highlight', recommended_value: 'STALE', per_design: true, hold: null, sp_api_key: 'item_highlights' },
]
const IH_IDX = 1

describe('persistPerDesignItemHighlights (FIX WAVE 2, I-2a)', () => {
  it('ALL-HELD branch: writes the detail row with per_design:true, recommended_value:"", the hold reason, and per_child_item_highlights with "" + hold for every SKU', async () => {
    const built: Built = {
      perDesign: [
        { designKey: 'BD', designName: 'Boss Definition', skus: [{ sku: 'BD1', asin: 'A1' }], value: '', hold: 'under-floor-no-repeat', foreignDropped: 0 },
        { designKey: 'BM', designName: 'Beast Mode', skus: [{ sku: 'BM1', asin: 'A2' }], value: '', hold: 'under-floor-no-repeat', foreignDropped: 0 },
      ],
      perChild: [
        { sku: 'BD1', asin: 'A1', item_highlight: '', designName: 'Boss Definition', designKey: 'BD', hold: 'under-floor-no-repeat' },
        { sku: 'BM1', asin: 'A2', item_highlight: '', designName: 'Beast Mode', designKey: 'BM', hold: 'under-floor-no-repeat' },
      ],
      shared: { value: '', hold: 'under-floor-no-repeat', designKeys: ['BD', 'BM'], missingDesigns: [], foreignDropped: 0 },
    }
    const { supabase, calls } = fakeSupabase({ error: null })
    const result = await persistPerDesignItemHighlights(supabase, 'B0TEST0001', DETAILS, IH_IDX, built)

    expect(result.error).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0].table).toBe('listing_seo_recommendations')
    expect(calls[0].eqCol).toBe('parent_asin')
    expect(calls[0].eqVal).toBe('B0TEST0001')
    const payload = calls[0].payload as { product_details_improvements: Record<string, unknown>[]; per_child_item_highlights: PerChildItemHighlight[] }
    // The untouched row (index 0) is byte-identical; the IH row (index 1) carries the hold.
    expect(payload.product_details_improvements[0]).toEqual(DETAILS[0])
    expect(payload.product_details_improvements[1]).toMatchObject({
      field_name: 'Item Highlight', per_design: true, recommended_value: '', hold: 'under-floor-no-repeat',
    })
    expect(payload.product_details_improvements[1].reason as string).toContain('HELD for every design')
    // per_child_item_highlights: EXACTLY built.perChild, unmodified — '' + hold per SKU.
    expect(payload.per_child_item_highlights).toEqual(built.perChild)
    expect(payload.per_child_item_highlights.every((c) => c.item_highlight === '' && !!c.hold)).toBe(true)
    // updated[] returned to the caller matches what was written.
    expect(result.updated).toEqual(payload.product_details_improvements)
  })

  it('PARTIAL-HOLD branch: hold is null on the detail row (composed > 0), but per_child_item_highlights still carries "" + hold for the held design — never silently dropped', async () => {
    const built: Built = {
      perDesign: [
        { designKey: 'BD', designName: 'Boss Definition', skus: [{ sku: 'BD1', asin: 'A1' }], value: 'Boss Definition Wear, Ring-Spun Cotton, Classic Fit', hold: null, foreignDropped: 0 },
        { designKey: 'BM', designName: 'Beast Mode', skus: [{ sku: 'BM1', asin: 'A2' }], value: '', hold: 'designs-unrated', foreignDropped: 0, missingDesigns: ['BM'] },
      ],
      perChild: [
        { sku: 'BD1', asin: 'A1', item_highlight: 'Boss Definition Wear, Ring-Spun Cotton, Classic Fit', designName: 'Boss Definition', designKey: 'BD', hold: null },
        { sku: 'BM1', asin: 'A2', item_highlight: '', designName: 'Beast Mode', designKey: 'BM', hold: 'designs-unrated' },
      ],
      shared: { value: '', hold: null, designKeys: ['BD', 'BM'], missingDesigns: ['BM'], foreignDropped: 0 },
    }
    const { supabase, calls } = fakeSupabase({ error: null })
    const result = await persistPerDesignItemHighlights(supabase, 'B0TEST0002', DETAILS, IH_IDX, built)

    expect(result.error).toBeNull()
    const payload = calls[0].payload as { product_details_improvements: Record<string, unknown>[]; per_child_item_highlights: PerChildItemHighlight[] }
    expect(payload.product_details_improvements[1]).toMatchObject({ per_design: true, recommended_value: '', hold: null })
    expect(payload.product_details_improvements[1].reason as string).toContain('one Item Highlight line PER DESIGN')
    expect(payload.per_child_item_highlights).toEqual(built.perChild)
    const bm = payload.per_child_item_highlights.find((c) => c.designKey === 'BM')!
    expect(bm.item_highlight).toBe('')
    expect(bm.hold).toBe('designs-unrated')
    const bd = payload.per_child_item_highlights.find((c) => c.designKey === 'BD')!
    expect(bd.item_highlight).not.toBe('')
  })

  it('a DB write failure is surfaced (not swallowed) — the caller can 500 instead of silently claiming success', async () => {
    const built: Built = {
      perDesign: [{ designKey: 'BD', designName: 'Boss Definition', skus: [{ sku: 'BD1', asin: 'A1' }], value: '', hold: 'thin-candidates', foreignDropped: 0 }],
      perChild: [{ sku: 'BD1', asin: 'A1', item_highlight: '', designName: 'Boss Definition', designKey: 'BD', hold: 'thin-candidates' }],
      shared: { value: '', hold: 'thin-candidates', designKeys: ['BD'], missingDesigns: [], foreignDropped: 0 },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { supabase } = fakeSupabase({ error: { message: 'relation does not have column per_child_item_highlights' } })
    const result = await persistPerDesignItemHighlights(supabase, 'B0TEST0003', DETAILS, IH_IDX, built)
    expect(result.error).toMatch(/Could not save the per-design Item Highlights/)
    expect(result.error).toMatch(/migration 060/)
    errorSpy.mockRestore()
  })

  it("INVARIANT (not the #352 outage-blanking trap): the REAL buildItemHighlightsPerDesign never returns composed===0 with shared.hold===null — the route's held branch always has a NAMED reason to persist, never an ambiguous empty result. Fed a genuinely thin/unrated pool, then persisted end-to-end.", async () => {
    const groups = [
      { key: 'BD', designName: 'Boss Definition', skus: [{ sku: 'BD1', asin: 'A1' }], titles: ['Boss Definition Tee'] },
      { key: 'BM', designName: 'Beast Mode', skus: [{ sku: 'BM1', asin: 'A2' }], titles: ['Beast Mode Tee'] },
    ]
    // An EMPTY pool: no candidate can ever compose, but every design is still nominally "rated"
    // (ratedShare on an empty pool is 0/0 -> requireFit false -> unrated-pool, a REAL named reason).
    const built = buildItemHighlightsPerDesign({
      groups, pool: [], apparelProduct: true, blankBrand: null, familyTitleText: 'Test Family',
    })
    const composed = built.perDesign.filter((d) => d.value).length
    expect(composed).toBe(0)
    expect(built.shared.hold).not.toBeNull()   // THE invariant persistPerDesignItemHighlights relies on

    const { supabase, calls } = fakeSupabase({ error: null })
    const result = await persistPerDesignItemHighlights(supabase, 'B0TEST0004', DETAILS, IH_IDX, built)
    expect(result.error).toBeNull()
    const payload = calls[0].payload as { product_details_improvements: Record<string, unknown>[] }
    expect(payload.product_details_improvements[1].hold).toBe(built.shared.hold)
    expect(payload.product_details_improvements[1].hold).not.toBeNull()
  })
})
