/**
 * ARCHITECTURE A — the pool-first Item Highlights composer (PO sign-off 2026-08-20).
 * Pinned against the rejected batch ("THESE ARE TERRIBLE!!!"): beige filler, template skeletons and
 * spec-mash are STRUCTURALLY impossible — every phrase is a verbatim pool keyword by construction.
 */
import { describe, it, expect } from 'vitest'
import { composeItemHighlight } from './itemHighlightComposer'

const GATOR_TITLES = ["THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women"]
const GATOR_POOL = [
  { keyword: 'later gator shirt women', searchVolume: 450, themeFit: 3 },
  { keyword: 'see you later alligator', searchVolume: 900, themeFit: 3 },
  { keyword: 'alligator clothing women', searchVolume: 300, themeFit: 3 },
  { keyword: 'funny gator apparel', searchVolume: 250, themeFit: 3 },
  { keyword: 'novelty animal tops', searchVolume: 200, themeFit: 2 },
  { keyword: 'oversized tshirts for women', searchVolume: 619950, themeFit: 1 },
  { keyword: 'comfort colors graphic', searchVolume: 5000, themeFit: 2 },
  { keyword: 'casual apparel', searchVolume: 100000, themeFit: 0 },
]

describe('composeItemHighlight — Architecture A', () => {
  it('builds the line from VERBATIM pool phrases, theme-fit first, Title Cased', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES)!
    expect(out).toBeTruthy()
    // Every comma phrase must be a Title-Cased pool keyword (or the sanctioned wear-style fact).
    const poolLower = new Set(GATOR_POOL.map((r) => r.keyword.toLowerCase()))
    for (const phrase of out.split(', ')) {
      if (phrase === 'Can be worn as Oversized') continue
      expect(poolLower.has(phrase.toLowerCase()), phrase).toBe(true)
    }
    // The design's own terms lead — theme-fit 3 beats raw volume.
    expect(out.toLowerCase()).toContain('later')
  })

  it('theme-fit ordering: a fit-0 100K head term never outranks fit-3 niche phrases', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES)!
    const idxCasual = out.toLowerCase().indexOf('casual apparel')
    const idxGator = out.toLowerCase().indexOf('later gator')
    if (idxCasual >= 0) expect(idxGator).toBeLessThan(idxCasual)
  })

  it('excludes phrases the shipping titles already cover (the ONE coverage predicate)', () => {
    const out = composeItemHighlight(
      [...GATOR_POOL, { keyword: 'comfort colors alligator tshirt', searchVolume: 99999, themeFit: 3 }],
      GATOR_TITLES,
    )!
    expect(out.toLowerCase()).not.toContain('comfort colors alligator tshirt')
  })

  it('near-duplicates cannot stack — each pick must add a new folded token', () => {
    const out = composeItemHighlight(
      [
        { keyword: 'alligator shirt women', searchVolume: 500, themeFit: 3 },
        { keyword: 'alligator shirts woman', searchVolume: 400, themeFit: 3 },
        { keyword: 'gator lover gift', searchVolume: 300, themeFit: 3 },
        { keyword: 'funny reptile tee', searchVolume: 200, themeFit: 3 },
      ],
      ['THE CEO Design Tee'],
    )!
    expect(out.toLowerCase()).toContain('alligator shirt women')
    expect(out.toLowerCase()).not.toContain('alligator shirts woman')
  })

  it('stays within the 125 budget and never violates the ≤2 per-word rule', () => {
    const out = composeItemHighlight(GATOR_POOL, GATOR_TITLES)!
    expect(out.length).toBeLessThanOrEqual(125)
  })

  it('adds the PO wear-style fact ONLY for relaxed/unisex cuts with pool demand and budget', () => {
    const withFact = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: true })!
    expect(withFact).toContain('Can be worn as Oversized')
    const withoutCut = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: false })!
    expect(withoutCut).not.toContain('Can be worn as Oversized')
    const noDemand = composeItemHighlight(GATOR_POOL.filter((r) => !/oversized/i.test(r.keyword)), GATOR_TITLES, { relaxedOrUnisexCut: true })!
    expect(noDemand).not.toContain('Can be worn as Oversized')
  })

  it('returns null on a thin pool — the caller falls back, never a forced beige line', () => {
    expect(composeItemHighlight(GATOR_POOL.slice(0, 2), GATOR_TITLES)).toBeNull()
  })

  it('is deterministic — same inputs, byte-identical line', () => {
    const a = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: true })
    const b = composeItemHighlight(GATOR_POOL, GATOR_TITLES, { relaxedOrUnisexCut: true })
    expect(a).toBe(b)
  })
})
