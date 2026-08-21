/**
 * Item Highlight PER DESIGN (PO 2026-08-21, B0DQ5YZH38 BD/BM/DQ/RIACG/RK).
 *
 * Pins: (1) each design's line is composed from the family pool MINUS phrases naming OTHER designs
 * (a BM line never carries "don't quit"; a DQ line never carries "beast mode"); shared family phrases
 * survive on every design; (2) a ONE-group family composes byte-identically to buildItemHighlights
 * (the single-design path is untouched — it never enters the per-design function); (3) the per-design
 * storage shape mirrors per_child_titles (one entry per SKU, designKey/designName labels, '' + hold
 * for a held design); (4) the sticky gate NEVER snaps a per-design marker row to an accepted broadcast
 * push — the broadcast value on a multi-design family is never design-specific.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('OpenAI must never be called by the Item Highlights producer') })
vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create } } } }))

import { buildItemHighlights, buildItemHighlightsPerDesign } from './listingPipeline'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'
import { applyStickyDetails } from './stickyDetails'
import { buildForeignDesignTokens, isForeignToDesign } from './designScope'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number, themeFit: number | null = 3): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)

const GILDAN = DEFAULT_BLANK_SPECS[1]

/** A B0DQ5YZH38-shaped family pool: shared gym/motivation phrases + phrases naming ONE design each. */
const POOL: AnalyzedKeyword[] = [
  kw('beast mode shirt', 9000), kw('beast mode gym tee', 4000),
  kw("don't quit shirt", 7000), kw('dont quit motivational tee', 3500),
  kw('real king shirt', 6000), kw('real king graphic tee', 2500),
  kw('gym motivation shirts', 8000), kw('workout graphic tees', 7500), kw('motivational tops for men', 5000),
  kw('lifting apparel for men', 4500), kw('fitness clothing men', 4000), kw('weightlifting shirts', 3800),
  kw('gym humor tshirts', 3000), kw('funny workout apparel', 2800), kw('bodybuilding tops', 2600),
]
const BM = { key: 'BM', designName: 'Beast Mode', skus: [{ sku: 'BM64000L-BK', asin: 'B0BM000001' }, { sku: 'BM64000M-BK', asin: 'B0BM000002' }], titles: ['THE CEO Beast Mode Gym Shirt for Men Workout Tee'] }
const DQ = { key: 'DQ', designName: "Don't Quit", skus: [{ sku: 'DQ64000L-BK', asin: 'B0DQ000001' }], titles: ["THE CEO Don't Quit Motivational Shirt for Men Gym Tee"] }
const RK = { key: 'RK', designName: 'Real King', skus: [{ sku: 'RK64000L-BK', asin: 'B0RK000001' }], titles: ['THE CEO Real King Graphic Shirt for Men Lifting Tee'] }
const FAMILY_TITLE = 'Funny Gym Shirts for Men Motivational Workout Tees'

describe('buildItemHighlightsPerDesign — per-group composition excludes the OTHER designs', () => {
  const r = buildItemHighlightsPerDesign({ groups: [BM, DQ, RK], pool: POOL, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })
  const line = (key: string) => r.perDesign.find((d) => d.designKey === key)!.value.toLowerCase()

  it('composes one line per design group, each non-empty on this pool', () => {
    expect(r.perDesign.map((d) => d.designKey)).toEqual(['BM', 'DQ', 'RK'])
    for (const d of r.perDesign) expect(d.value.length).toBeGreaterThanOrEqual(107)
    expect(create).not.toHaveBeenCalled()
  })

  it("a BM line never carries \"don't quit\" or \"real king\"; a DQ line never carries \"beast mode\" or \"real king\"; RK never the other two", () => {
    expect(line('BM')).not.toMatch(/quit|real king/)
    expect(line('DQ')).not.toMatch(/beast|real king/)
    expect(line('RK')).not.toMatch(/beast|quit/)
  })

  it("each design's OWN name phrases are composable when its title does not already cover them", () => {
    // The BM title covers "beast mode" so the composer excludes it by coverage (novel phrases beside the
    // title), but the partition itself must NOT have dropped BM's own tokens — prove at the seam.
    const foreignFor = buildForeignDesignTokens(
      [BM, DQ, RK].map((g) => ({ key: g.key, name: g.designName })),
      { familyTitleText: FAMILY_TITLE, poolKeywords: POOL.map((k) => k.keyword), strictNames: true },
    )
    expect(isForeignToDesign('beast mode shirt', foreignFor('BM'))).toBe(false)
    expect(isForeignToDesign("don't quit shirt", foreignFor('BM'))).toBe(true)
    expect(isForeignToDesign('beast mode shirt', foreignFor('DQ'))).toBe(true)
    expect(isForeignToDesign('gym motivation shirts', foreignFor('DQ'))).toBe(false)  // shared family phrase
  })

  it('the storage shape mirrors per_child_titles: one entry per SKU, labeled with designKey/designName', () => {
    expect(r.perChild.map((e) => e.sku)).toEqual(['BM64000L-BK', 'BM64000M-BK', 'DQ64000L-BK', 'RK64000L-BK'])
    const bm = r.perChild.filter((e) => e.designKey === 'BM')
    expect(bm).toHaveLength(2)
    expect(bm[0].item_highlight).toBe(bm[1].item_highlight)
    expect(bm[0].designName).toBe('Beast Mode')
    expect(bm[0].asin).toBe('B0BM000001')
    expect(bm[0].hold).toBeNull()
  })

  it('the vision identity extends a design vocabulary: phrases naming another design ONLY via its identity seeds are foreign too', () => {
    const pool = [...POOL, kw('lion crown tee', 5000), kw('lion king of the gym shirt', 4200)]
    const rk = { ...RK, identityPhrases: ['lion wearing a crown', 'lion', 'crown', 'king'] }
    const out = buildItemHighlightsPerDesign({ groups: [BM, DQ, rk], pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })
    expect(out.perDesign.find((d) => d.designKey === 'BM')!.value.toLowerCase()).not.toMatch(/lion|crown/)
    expect(out.perDesign.find((d) => d.designKey === 'DQ')!.value.toLowerCase()).not.toMatch(/lion|crown/)
  })
})

describe('buildItemHighlightsPerDesign — hold semantics per group + single-group parity', () => {
  it('a design whose scoped pool cannot compose HOLDS with a named reason; the other designs still ship', () => {
    // Only one shared phrase + the DQ-only phrases: after the partition BM/RK have too few candidates.
    const thinPool = [kw("don't quit shirt", 7000), kw('dont quit motivational tee', 3500), kw('dont quit gym tops', 3000), kw('never quit workout apparel', 2800), kw('dont quit lifting shirts', 2500), kw('dont quit fitness clothing', 2400), kw('gym motivation shirts', 8000)]
    const r = buildItemHighlightsPerDesign({ groups: [BM, DQ], pool: thinPool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })
    const bm = r.perDesign.find((d) => d.designKey === 'BM')!
    expect(bm.value).toBe('')
    expect(bm.hold).not.toBeNull()
    expect(r.perChild.filter((e) => e.designKey === 'BM').every((e) => e.item_highlight === '' && e.hold === bm.hold)).toBe(true)
    // BM's SKUs are never handed DQ's line.
    expect(r.perChild.filter((e) => e.designKey === 'BM').every((e) => !/quit/i.test(e.item_highlight))).toBe(true)
  })

  it('ONE group composes byte-identically to buildItemHighlights with the same titles/pool (no partition ⇒ no drift)', () => {
    const single = buildItemHighlights({ finalTitle: BM.titles[0], pool: POOL, apparelProduct: true, blankBrand: GILDAN, netTitles: BM.titles })
    const viaPerDesign = buildItemHighlightsPerDesign({ groups: [BM], pool: POOL, apparelProduct: true, blankBrand: GILDAN, familyTitleText: FAMILY_TITLE })
    expect(viaPerDesign.perDesign[0].value).toBe(single.value)
    expect(viaPerDesign.perDesign[0].hold).toBe(single.hold)
  })
})

describe('the broadcast Item Highlight row on a multi-design family is NEVER design-specific', () => {
  it('the sticky gate leaves a per-design MARKER row untouched even when a broadcast push was accepted', () => {
    const fresh = [{ field_name: 'Item Highlight', sp_api_key: 'title_differentiation', recommended_value: '', per_design: true, current_value: null }]
    const prior = [{ field_name: 'Item Highlight', sp_api_key: 'title_differentiation', recommended_value: 'Beast Mode Shirt, Gym Motivation Shirts, Workout Graphic Tees', current_value: 'Beast Mode Shirt, Gym Motivation Shirts, Workout Graphic Tees' }]
    const accepted = new Map([['titledifferentiation', 'Beast Mode Shirt, Gym Motivation Shirts, Workout Graphic Tees']])
    const out = applyStickyDetails({ fresh, prior, acceptedByKey: accepted, log: () => {} })
    expect(out.details[0].recommended_value).toBe('')
    expect(out.details[0].per_design).toBe(true)
    expect(out.ihReverted).toBe(false)
    // and the prior-equality fallback path (push-log unreadable) must not carry a line either
    const out2 = applyStickyDetails({ fresh, prior, acceptedByKey: null, log: () => {} })
    expect(out2.details[0].recommended_value).toBe('')
    expect(out2.details[0].current_value ?? null).toBeNull()
  })
})
