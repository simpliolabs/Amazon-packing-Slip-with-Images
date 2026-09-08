/**
 * R1 (finish-line-rulings.md, controller RULING, 2026-09-08 — "GET it done"): the blank-brand
 * insertion net (`ensureBlankBrandInHighlights`) abandons the insertion SILENTLY when inserting the
 * brand would push a composer-shaped, in-band line under the floor (phase-1-final-review-2.md
 * IMPORTANT 1, measured live on ~1 in 5 real Item Highlights). The outcome — ship the compliant,
 * unbranded line rather than an under-floor branded one — is CORRECT and stands (ruled). What must
 * change: the abandonment must become a NAMED, SURFACED signal on the card, reusing the EXISTING
 * `IhHoldReason` vocabulary (`IH_HOLD_MESSAGES`) — never a parallel one — so the PO can see exactly
 * which designs lost their blank brand and why. A console.log JSON line is not a signal.
 *
 * REPRODUCED (scratchpad/finish-a/r1-blank-brand.ts) against a real composer-shaped, 109-char,
 * no-repeat, in-band line whose brand-prefixed candidate cannot fit under the 125-char max without
 * evicting the second phrase entirely, landing the survivor under the 107 floor:
 *   ensureBlankBrandInHighlights -> unchanged (109c, no brand) — CORRECT
 *   applyBlankBrandNetPerDesign  -> entry unchanged, hold: null — NOTHING on the entry names why
 *   the only trace was console.log({tag:'BLANK_BRAND_NET', decision:'floor-abort', ...})
 */
import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_BLANK_SPECS, ensureBlankBrandInHighlights, applyBlankBrandNetPerDesign } from './blankSpecs'
import { perDesignIhRows, collapseSharedIhRows, type PerChildItemHighlight, type IhHoldReason } from './perDesignItemHighlights'

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => new Promise(() => { /* never settles */ }) }) }) }),
  }),
}))

const CC = DEFAULT_BLANK_SPECS[0]   // Comfort Colors — brand allowed in copy
const TITLE_NO_BRAND = 'Alligator Graphic Crewneck Sweatshirt'   // never carries the brand

// Composer-shaped: >=107c, no repeated significant word, brand-prefixed candidate ("authentic
// Comfort Colors blank, " = 32c) forces an all-or-nothing eviction of phrase2 (98c) that lands the
// survivor (prefix + phrase1 alone, 44c) under the 107 floor -- the exact class IMPORTANT 1 measured.
const PHRASE1 = 'Relaxed Fit'
const PHRASE2 = 'Everyday Wear Cotton Blend Crew Neckline Durable Stitching Vivid Print Color Fastness Guaranteed'
const HL = `${PHRASE1}, ${PHRASE2}`

describe('R1 — ensureBlankBrandInHighlights diag out-param (byte-identical for every existing caller)', () => {
  it('REPRODUCTION: HL is in-band (>=107, no repeat) and the net abandons the insertion (unchanged)', () => {
    expect(HL.length).toBeGreaterThanOrEqual(107)
    expect(HL.length).toBeLessThanOrEqual(125)
    const out = ensureBlankBrandInHighlights(HL, [TITLE_NO_BRAND], CC)
    expect(out).toBe(HL)   // CORRECT outcome, ruled: ship unbranded rather than under-floor
  })

  it('FIX: an optional diag out-param records WHY, reusing IhHoldReason -- never changes the string return', () => {
    const diag: { abandoned?: import('./perDesignItemHighlights').IhHoldReason | null } = {}
    const out = ensureBlankBrandInHighlights(HL, [TITLE_NO_BRAND], CC, diag)
    expect(out).toBe(HL)                       // the return contract is UNCHANGED (every existing
                                                 // call site in blankBrandHighlightNet.test.ts omits
                                                 // the 4th arg and keeps comparing a bare string)
    expect(diag.abandoned).toBe('under-floor')  // the SAME reason buildItemHighlights/the per-child
                                                 // persist net already use for this capResult shape
  })

  it('no diag mutation on every non-abandonment exit (no-blank, brand-not-in-copy, title-carries, ih-carries, inserted)', () => {
    const diag1: { abandoned?: IhHoldReason | null } = {}
    ensureBlankBrandInHighlights(HL, [TITLE_NO_BRAND], null, diag1)          // no-blank
    expect(diag1.abandoned).toBeUndefined()

    const diag2: { abandoned?: IhHoldReason | null } = {}
    ensureBlankBrandInHighlights(HL, ['Comfort Colors Tee'], CC, diag2)      // title-carries
    expect(diag2.abandoned).toBeUndefined()

    const diag3: { abandoned?: IhHoldReason | null } = {}
    const shortHl = 'Relaxed Fit, Cuff Sleeves, Gift Ready, Machine Washable, Everyday Wear Piece'
    const inserted = ensureBlankBrandInHighlights(shortHl, [TITLE_NO_BRAND], CC, diag3)
    expect(inserted).not.toBe(shortHl)   // actually inserted this time
    expect(diag3.abandoned).toBeUndefined()
  })
})

describe('R1 — applyBlankBrandNetPerDesign surfaces the abandonment on the entry (card-visible), never a hold', () => {
  const baseEntry: PerChildItemHighlight = { sku: 'SKU-1', asin: 'B0AAA00001', item_highlight: HL, designName: 'Alligator', designKey: 'alligator', hold: null }
  const titles = [{ sku: 'SKU-1', asin: 'B0AAA00001', title: TITLE_NO_BRAND }]

  it('FIX: the returned entry names the abandonment reason (reusing IhHoldReason), the line still SHIPS, and hold stays null', () => {
    const res = applyBlankBrandNetPerDesign([baseEntry], titles, CC)
    expect(res.entries[0].item_highlight).toBe(HL)               // ships, unbranded — correct
    expect((res.entries[0] as PerChildItemHighlight).hold).toBeNull()   // NEVER a hold — it still ships
    expect((res.entries[0] as PerChildItemHighlight).blankBrandAbandoned).toBe('under-floor')
    expect(res.changed).toBe(true)   // the entry gained an observability field — must persist
  })

  it('a design that never needed the brand carries no abandonment note at all', () => {
    const titleWithBrand = [{ sku: 'SKU-1', asin: 'B0AAA00001', title: 'Comfort Colors Tee' }]
    const res = applyBlankBrandNetPerDesign([baseEntry], titleWithBrand, CC)
    expect((res.entries[0] as PerChildItemHighlight).blankBrandAbandoned ?? null).toBeNull()
  })

  it('an entry that already carries a stale abandonment note CLEARS it once the insertion succeeds', () => {
    const stale: PerChildItemHighlight = { ...baseEntry, item_highlight: 'Relaxed Fit, Cuff Sleeves, Gift Ready, Machine Washable, Everyday Wear Piece', blankBrandAbandoned: 'under-floor' }
    const res = applyBlankBrandNetPerDesign([stale], titles, CC)
    expect((res.entries[0] as PerChildItemHighlight).blankBrandAbandoned ?? null).toBeNull()
    expect(res.changed).toBe(true)
  })

  it('perDesignIhRows carries the abandonment through to the card row, independent of skipReason/hold', () => {
    const res = applyBlankBrandNetPerDesign([baseEntry], titles, CC)
    const rows = perDesignIhRows(res.entries as PerChildItemHighlight[])
    expect(rows[0].skipReason).toBeNull()          // still pushable
    expect(rows[0].blankBrandAbandoned).toBe('under-floor')
  })

  it('collapseSharedIhRows never merges two designs with byte-identical (hold, line) but a DIFFERENT blankBrandAbandoned', () => {
    const entryA: PerChildItemHighlight = { sku: 'A1', asin: 'B0AAA00001', item_highlight: HL, designName: 'Alligator', designKey: 'alligator', hold: null, blankBrandAbandoned: 'under-floor' }
    const entryB: PerChildItemHighlight = { sku: 'B1', asin: 'B0BBB00001', item_highlight: HL, designName: 'Bear', designKey: 'bear', hold: null, blankBrandAbandoned: null }
    const rows = perDesignIhRows([entryA, entryB])
    expect(rows[0].line).toBe(rows[1].line)              // byte-identical line
    expect(rows[0].hold).toBe(rows[1].hold)               // byte-identical hold (both null)
    const shared = collapseSharedIhRows(rows)
    expect(shared.length).toBe(2)                         // NOT collapsed into one row
    expect(shared.map((s) => s.blankBrandAbandoned).sort()).toEqual([null, 'under-floor'])
  })
})
