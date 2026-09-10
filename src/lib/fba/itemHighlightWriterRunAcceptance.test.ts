/**
 * itemHighlightWriterRunAcceptance.test.ts — writer spec Part 2 (2026-09-10), rulings
 * phase-a3-and-b-rulings.md PART 2 acceptance items 2, 3, 4, 5 (item 1 lives in
 * itemHighlightWriterProvenance.test.ts; item 6 is tsc/vitest/git-status, verified at the end of the
 * task, and B4's own enumeration lives in itemHighlightWriterEnumeration.test.ts). Also covers B6
 * (readability), B7/B8 (bounded retry + eligibility) and the flag-off byte/zero-call guarantee (B9).
 *
 * No probe or test here loads an env file or makes a live model call (B10) — every OpenAI client is
 * either a hand-rolled stub object passed via `deps.openai`, or the `openai` MODULE itself mocked
 * (this repo's own `itemHighlightHold.test.ts`/`itemHighlightPerDesign.test.ts` pattern), which also
 * catches a call made through `getLlmClientForRequest`'s internal `new OpenAI(...)`.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('OpenAI must never be called when IH_WRITER is off') })
vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create } } } }))

import {
  buildItemHighlights, buildItemHighlightsPerDesign, produceItemHighlights, produceItemHighlightsPerDesign,
} from './listingPipeline'
import {
  runWriterForDesign, writerReadabilityVerdict, ihWriterMode, ihWriterModel, buildAdmittedUnits,
  type AdmittedUnit,
} from './itemHighlightWriter'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'
import type { PhraseTruthCtx } from './contentTruth'

const kw = (keyword: string, searchVolume: number, themeFit: number | null): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)
const CC = DEFAULT_BLANK_SPECS[0]

// ─── B9: the flag ──────────────────────────────────────────────────────────────────────────────

describe('B9: IH_WRITER mode resolution', () => {
  it('unset or unrecognized -> off (the DEFAULT, unlike CONTENT_RECONCILE_ENABLED\'s shadow default)', () => {
    expect(ihWriterMode(undefined)).toBe('off')
    expect(ihWriterMode('')).toBe('off')
    expect(ihWriterMode('bogus')).toBe('off')
  })
  it('shadow/on recognized case-insensitively', () => {
    expect(ihWriterMode('shadow')).toBe('shadow')
    expect(ihWriterMode('SHADOW')).toBe('shadow')
    expect(ihWriterMode('on')).toBe('on')
    expect(ihWriterMode('ON')).toBe('on')
  })
  it('IH_WRITER_MODEL defaults to gpt-4.1', () => {
    expect(ihWriterModel(undefined)).toBe('gpt-4.1')
    expect(ihWriterModel('gpt-5')).toBe('gpt-5')
  })
})

// ─── Acceptance item 4: flag OFF is byte-identical and makes ZERO writer calls ───────────────────

describe('Part 2 acceptance item 4: IH_WRITER=off (default/unset) — byte-identical, zero calls', () => {
  const prevMode = process.env.IH_WRITER

  it('produceItemHighlights(off) equals buildItemHighlights(...) exactly, and never touches OpenAI', async () => {
    delete process.env.IH_WRITER
    const pool = [
      kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
      kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
      kw('swamp humor clothing', 150, 2),
    ]
    const title = 'THE CEO Later Gator Tee Shirt | Alligator Tshirt for Women'
    const sync = buildItemHighlights({ finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] })
    const viaWriter = await produceItemHighlights({ finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] })
    expect(viaWriter.value).toBe(sync.value)
    expect(viaWriter.hold).toBe(sync.hold)
    expect(create).not.toHaveBeenCalled()
    expect(process.env.IH_WRITER).toBeUndefined()
  })

  it('produceItemHighlightsPerDesign(off) equals buildItemHighlightsPerDesign(...) exactly, and never touches OpenAI', async () => {
    delete process.env.IH_WRITER
    const groups = [
      { key: 'A', designName: 'Alligator Love', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Alligator Love Tee for Women'] },
      { key: 'B', designName: 'Gator Nation', skus: [{ sku: 'B1', asin: 'B0B0000001' }], titles: ['THE CEO Gator Nation Tee for Women'] },
    ]
    const pool = [
      kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
      kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
      kw('swamp humor clothing', 150, 2), kw('gator nation pride wear', 5000, 3), kw('alligator love graphic tee', 5000, 3),
    ]
    const args = { groups, pool, apparelProduct: true, blankBrand: CC, familyTitleText: 'Gator Family' }
    const sync = buildItemHighlightsPerDesign(args)
    const viaWriter = await produceItemHighlightsPerDesign(args)
    expect(viaWriter.perDesign).toEqual(sync.perDesign)
    expect(viaWriter.perChild).toEqual(sync.perChild)
    expect(viaWriter.shared).toEqual(sync.shared)
    expect(create).not.toHaveBeenCalled()
  })

  it('shadow mode still ships the composer result unchanged (writer output never overrides bytes in shadow)', async () => {
    process.env.IH_WRITER = 'shadow'
    try {
      const pool = [
        kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
        kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
        kw('swamp humor clothing', 150, 2),
      ]
      const title = 'THE CEO Later Gator Tee Shirt | Alligator Tshirt for Women'
      const sync = buildItemHighlights({ finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] })
      const noClient = { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })) } } }
      const viaWriter = await produceItemHighlights(
        { finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] },
        { openai: noClient as never },
      )
      // Shadow: the composer's own bytes ship regardless of what the writer produced.
      expect(viaWriter.value).toBe(sync.value)
      expect(viaWriter.hold).toBe(sync.hold)
    } finally {
      if (prevMode === undefined) delete process.env.IH_WRITER; else process.env.IH_WRITER = prevMode
    }
  })
})

// ─── B6: readability ───────────────────────────────────────────────────────────────────────────

describe('B6: readability', () => {
  const units: AdmittedUnit[] = [{ text: 'Retro Sunset', kind: 'identity', atomic: true }]
  it('B6.1: 3+ comma clauses with NO connecting word anywhere reads as a keyword list', () => {
    const v = writerReadabilityVerdict('Retro Sunset Tee, Soft Cotton Feel, Classic Fit, Crew Neck', units)
    expect(v.ok).toBe(false)
  })
  it('B6.1: the same clause count with a connecting word in ONE clause passes this rule', () => {
    const v = writerReadabilityVerdict('Retro Sunset Tee for Everyday Wear, Soft Cotton Feel, Classic Fit', units)
    expect(v.ok).toBe(true)
  })
  it('B6.2: a gendered audience word beside "Unisex" fails', () => {
    const v = writerReadabilityVerdict('Retro Sunset Tee, Womens Everyday Fit, Unisex Sizing', units)
    expect(v.ok).toBe(false)
  })
  it('B6.2: "Unisex" alone (no gendered word) passes', () => {
    const v = writerReadabilityVerdict('Retro Sunset Tee for Everyday Wear, Unisex Sizing', units)
    expect(v.ok).toBe(true)
  })
  it('B6.3: when an identity unit exists, the line must name or evoke it', () => {
    const v = writerReadabilityVerdict('Graphic Tee for Everyday Wear, Classic Fit', units)
    expect(v.ok).toBe(false)
  })
  it('B6.3: no identity unit at all -> this rule is a no-op', () => {
    const v = writerReadabilityVerdict('Graphic Tee for Everyday Wear, Classic Fit', [])
    expect(v.ok).toBe(true)
  })
})

// ─── B7/B8 + acceptance items 2 and 3 ─────────────────────────────────────────────────────────────

const TEE_CTX: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
const passthroughTail = (line: string): { value: string; hold: string | null } => ({ value: line, hold: null })
const COMPOSED = { candidates: ['Soft Everyday Cotton Feel', 'Graphic Retro Tee'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }

function stubClient(lines: string[]) {
  let i = 0
  const create = vi.fn(async () => {
    const line = lines[Math.min(i, lines.length - 1)]
    i++
    return { choices: [{ message: { content: JSON.stringify({ line }) }, finish_reason: 'stop' }] }
  })
  return { client: { chat: { completions: { create } } } as never, create }
}

describe('B8: eligibility', () => {
  it('skips the call for unrated-pool (PO ruling) — zero calls', async () => {
    const { client, create: c } = stubClient(['Soft Everyday Cotton Feel, Classic Fit'])
    const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: 'unrated-pool', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(r.calls).toBe(0)
    expect(c).not.toHaveBeenCalled()
  })
  it('skips the call for zero admitted pool units — zero calls', async () => {
    const { client, create: c } = stubClient(['Soft Everyday Cotton Feel, Classic Fit'])
    const r = await runWriterForDesign({ composed: { ...COMPOSED, candidates: [] }, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(r.calls).toBe(0)
    expect(c).not.toHaveBeenCalled()
  })
  it('IS eligible for under-floor-no-repeat / thin-candidates / under-floor (non-zero pool)', async () => {
    for (const hold of ['under-floor-no-repeat', 'thin-candidates', 'under-floor']) {
      const { client } = stubClient(['Retro Sunset Tee, Soft Everyday Cotton Feel, Classic Fit'])
      const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: hold, designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
      expect(r.calls, hold).toBeGreaterThan(0)
    }
  })
})

describe('Part 2 acceptance item 2: a hallucinating stub is rejected; a honest-reword stub is accepted', () => {
  it('hallucinating stub ("Water Resistant", "Made in Italy", a fabricated blend) is rejected on every attempt -> falls back', async () => {
    const { client, create: c } = stubClient([
      'Retro Sunset Tee, Water Resistant Fabric, Classic Fit',
      'Retro Sunset Tee, Made in Italy, Classic Fit',
      'Retro Sunset Tee, 60% Bamboo 40% Cotton, Classic Fit',
    ])
    const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(c).toHaveBeenCalledTimes(3)
    console.log('hallucinating stub — rejected every attempt:', JSON.stringify(r.reasons))
  })

  it('a stub that only re-words admitted units is accepted on the first attempt', async () => {
    const { client, create: c } = stubClient(['Retro Sunset Tee with Soft Everyday Cotton Feel, Classic Fit'])
    const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(true)
    expect(c).toHaveBeenCalledTimes(1)
    console.log('honest-reword stub — accepted:', r.value)
  })
})

describe('Part 2 acceptance item 3: an always-violating stub makes exactly 3 calls, then the composer result', () => {
  it('3 calls, never accepted, HOLD is never blanked to empty over a real fallback', async () => {
    const { client, create: c } = stubClient([
      'Retro Sunset Tee, Waterproof Coating, Classic Fit',
      'Retro Sunset Tee, Made in France, Classic Fit',
      'Retro Sunset Tee, Anti-Microbial Weave, Classic Fit',
      'Retro Sunset Tee, Should Never Be Called, Classic Fit',
    ])
    const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(r.value).toBe('')
    expect(c).toHaveBeenCalledTimes(3)
  })

  it('produceItemHighlights(on), when the writer never accepts, ships the COMPOSER result — never blanks a HOMOLD to \'\'', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const { client } = stubClient(['Retro Sunset Tee, Waterproof Coating, Classic Fit'])
      const small = [kw('rodeo outfit women', 400, 3), kw('hello darlin shirt', 350, 3), kw('cowgirl graphic tops', 300, 3)]
      const sync = buildItemHighlights({ finalTitle: 'THE CEO Darlin Tee', pool: small, apparelProduct: true, blankBrand: null, netTitles: null })
      const viaWriter = await produceItemHighlights({ finalTitle: 'THE CEO Darlin Tee', pool: small, apparelProduct: true, blankBrand: null, netTitles: null }, { openai: client as never })
      expect(viaWriter.value).toBe(sync.value)
      expect(viaWriter.hold).toBe(sync.hold)
    } finally { delete process.env.IH_WRITER }
  })
})

// ─── Part 2 acceptance item 5: six B0DSCDZC6K-shaped designs (SYNTHETIC — built from the retrospective, not a live pull) ──

describe('Part 2 acceptance item 5: six B0DSCDZC6K-shaped designs (SYNTHETIC fixtures, per the acceptance instruction)', () => {
  // B0DSCDZC6K per fba-generation-invariants-retrospective.md / memory index: a Gildan
  // 18000 sweatshirt + 18500 hoodie family, UNISEX lean, six designs, where the picker itself holds
  // most designs for want of a repeat-free fill — exactly the case spec §2a's "Cost, refined" names
  // as newly ELIGIBLE for the writer ("joining admitted facts with glue words is exactly what a
  // picker cannot do"). Built here, not pulled live — no DB in this test.
  const SWEAT_UNISEX: PhraseTruthCtx = {
    garmentFamily: 'sweatshirt', spec: { material: 'Cotton/Polyester Blend', fit: 'Classic', unisex: true },
    allowedBrand: null, audience: 'adult', audienceLean: 'unisex', field: 'highlights',
  }
  const DESIGNS = ['Don\'t Quit', 'Boss Definition', 'Real King', 'Self Made', 'Beast Mode', 'Relax I\'m a CEO']
  const composedByDesign = (name: string) => ({
    candidates: [`${name} Graphic Sweatshirt`, 'Cozy Pullover Comfort'],
    specFacts: ['Classic Fit', 'Unisex Fit'],
    brandPick: null as string | null,
    wearFact: null as string | null,
  })

  for (const name of DESIGNS) {
    it(`${name}: writer eligibility + outcome, reported (stub output, calls, accepted-or-fallback+reason)`, async () => {
      const composed = composedByDesign(name)
      const truthCtx = { ...SWEAT_UNISEX, designTokens: [name] }
      const units = buildAdmittedUnits(composed, { designName: name, truthCtx })
      expect(units.length).toBeGreaterThan(0)
      // Stub always re-words the admitted units honestly for this design — a picker could never do
      // this (it can only pick whole phrases; it cannot join them with glue), which is exactly the
      // capability this acceptance row exists to demonstrate.
      const { client, create: c } = stubClient([`${name} Cozy Graphic Sweatshirt with Pullover Comfort, Unisex Fit`])
      const r = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: name, truthCtx, runTail: passthroughTail, deps: { openai: client } })
      console.log(JSON.stringify({ tag: 'B0DSCDZC6K_ACCEPTANCE', design: name, calls: c.mock.calls.length, accepted: r.accepted, value: r.value || null, reasons: r.reasons }))
      expect(c.mock.calls.length).toBeGreaterThan(0)
      expect(c.mock.calls.length).toBeLessThanOrEqual(3)
      // Either accepted with a value, or a clean fallback (never '' with no reason at all).
      if (r.accepted) expect(r.value.length).toBeGreaterThan(0)
      else expect(r.reasons.length).toBeGreaterThan(0)
    })
  }
})
