/**
 * THE LLM FALLBACK FOR ITEM HIGHLIGHTS IS RETIRED (PO ruling 2026-08-21, 14-family review):
 * "every LLM line produced today was the rejected style (beige 'casual apparel', a trademark 'salt
 * life', a fabric lie 'polycotton')". When the composer returns null the field HOLDS — '' engages
 * the callers' keep-old-value semantics — with ONE named reason the PO can act on. No LLM draft, no
 * spec-mash fallback, on ANY path (pipeline + regenerate route share this one function).
 *
 * These pins fail if an OpenAI client is ever constructed or called from the IH producer again.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('OpenAI must never be called by the Item Highlights producer') })
vi.mock('openai', () => ({
  default: class MockOpenAI { chat = { completions: { create } } },
}))

import { buildItemHighlights, IH_HOLD_MESSAGES, type IhHoldReason } from './listingPipeline'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'
import { CONTENT_CONTRACT } from './contentContract'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number, themeFit: number | null): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)

const CC = DEFAULT_BLANK_SPECS[0]
const GILDAN = DEFAULT_BLANK_SPECS[1]
const TITLE = 'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women'

describe('buildItemHighlights — composer-null ⇒ HOLD with a named reason, never an LLM line', () => {
  it('B0F6VTY79T / B0DSCDZC6K (unrated pools): an unrated pool that cannot compose HOLDS as unrated-pool — zero OpenAI calls', () => {
    const unrated = [kw('salt life shirts for men', 90000, null), kw('casual apparel', 80000, null)]
    const r = buildItemHighlights({ finalTitle: TITLE, pool: unrated, apparelProduct: true, blankBrand: GILDAN, netTitles: [TITLE] })
    expect(r.value).toBe('')
    expect(r.hold).toBe<IhHoldReason>('unrated-pool')
    expect(create).not.toHaveBeenCalled()
  })

  it('a RATED pool with too few truthful candidates HOLDS as thin-candidates', () => {
    const thin = [kw('france soccer jersey', 90000, 3), kw('gator lover gift', 300, 3), kw('band tees', 80000, 1)]
    const r = buildItemHighlights({ finalTitle: TITLE, pool: thin, apparelProduct: true, blankBrand: GILDAN, netTitles: [TITLE] })
    expect(r.value).toBe('')
    expect(r.hold).toBe<IhHoldReason>('thin-candidates')
    expect(create).not.toHaveBeenCalled()
  })

  it('a rated pool whose truthful phrases cannot reach the floor HOLDS as under-floor (spec present) / no-spec (no blank)', () => {
    const small = [kw('rodeo outfit women', 400, 3), kw('hello darlin shirt', 350, 3), kw('cowgirl graphic tops', 300, 3)]
    const noSpec = buildItemHighlights({ finalTitle: 'THE CEO Darlin Tee', pool: small, apparelProduct: true, blankBrand: null, netTitles: null })
    expect(noSpec.value).toBe('')
    expect(noSpec.hold).toBe<IhHoldReason>('no-spec')
    // a spec whose only filler is one short fact still cannot reach 107 → under-floor
    const thinSpec = { ...GILDAN, spec: { brand: 'Gildan', brandInCopy: false, neck: 'Crew Neck' } }
    const underFloor = buildItemHighlights({ finalTitle: 'THE CEO Darlin Tee', pool: small, apparelProduct: true, blankBrand: thinSpec, netTitles: null })
    expect(underFloor.value).toBe('')
    expect(underFloor.hold).toBe<IhHoldReason>('under-floor')
    expect(create).not.toHaveBeenCalled()
  })

  it('every hold reason has a PO-facing message that names the action', () => {
    const reasons: IhHoldReason[] = ['unrated-pool', 'thin-candidates', 'under-floor', 'no-spec']
    for (const r of reasons) expect(IH_HOLD_MESSAGES[r]).toMatch(/^Held: /)
    expect(IH_HOLD_MESSAGES['unrated-pool']).toMatch(/rating|research/i)
  })

  it('a viable rated pool composes in the band — brand waterfall satisfied inside the line, no post-net rewrite', () => {
    const pool = [
      kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
      kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
      kw('swamp humor clothing', 150, 2),
    ]
    const noBrandTitle = 'THE CEO Later Gator Tee Shirt | Alligator Tshirt for Women'
    const r = buildItemHighlights({ finalTitle: noBrandTitle, pool, apparelProduct: true, blankBrand: CC, netTitles: [noBrandTitle] })
    expect(r.hold).toBeNull()
    expect(r.value.length).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min)
    expect(r.value.length).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)
    expect(r.value).not.toMatch(/authentic/i)
    expect((r.value.match(/comfort\s*colors/gi) ?? []).length).toBe(1)
    expect(create).not.toHaveBeenCalled()
  })
})
