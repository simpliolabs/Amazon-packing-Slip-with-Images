/**
 * itemHighlightWriterFixRoundB5.test.ts — fix round B5 (controller RULING on the four-lens panel,
 * `.superpowers/sdd/2026-09-10-ih-writer/phase-b5-rulings.md`, P1-P12). Pins the panel's specific
 * Blocking/Important findings as must-reject/must-expose through the REAL functions — never a
 * re-implementation of the rules under test. Every "lie" line below is a STUB arrangement or a
 * hand-built pool row, never model output; no live model call is made anywhere in this file.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildAdmittedUnits, judgeWriterArrangement, validateArrangement, renderArrangement,
  runWriterForDesign, WriterPartialCallsError, ihWriterDeadlineMs,
  type AdmittedUnit, type ArrangementPart,
} from './itemHighlightWriter'
import { composeItemHighlightDetailed, type ComposerResult } from './itemHighlightComposer'
import { buildItemHighlightsPerDesign, produceItemHighlightsPerDesign, produceItemHighlights, runIhTail } from './listingPipeline'
import { classifyStoredIhLine, lineHasSignificantRepeat } from './productDetailAttrs'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number, themeFit: number | null): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)
const CC = DEFAULT_BLANK_SPECS[0]
const GILDAN = DEFAULT_BLANK_SPECS[1]
const NEVER: RegExp = /(?!)/
const runTailFor = (title: string, blank: BlankSpecRow | null, truthCtx: PhraseTruthCtx) =>
  (line: string) => runIhTail(line, { titles: [title], blankBrand: blank, truthCtx, site: 'fix-round-b5-test' })

// ─── P6(a): REPRODUCE the live push-seam defect FIRST, then P6(b)'s fix ────────────────────────────

describe('RULING P6(a)/(b): the 50/50 material fact is no longer a false "repeat"', () => {
  it('P6(a) reproduced: the material fact ALONE used to be classifyStoredIhLine=repeat-in-stored-line (fixed by P6(b))', () => {
    const materialOnly = '50% Cotton / 50% Polyester'
    expect(lineHasSignificantRepeat(materialOnly)).toBe(false)
    expect(classifyStoredIhLine(materialOnly)).not.toBe('repeat-in-stored-line')
  })
  it('the PO\'s own live line STILL correctly refuses — for "Women" twice, never for "50"', () => {
    const line = 'Crewneck Sweatshirts Women, Fall Sweatshirts for Women, Graphic Crewneck, 50% Cotton / 50% Polyester, Classic Fit'
    expect(classifyStoredIhLine(line)).toBe('repeat-in-stored-line')
  })
  it('a DIFFERENT pair of numbers (52/48) never collided before, and still does not', () => {
    expect(lineHasSignificantRepeat('52% Cotton / 48% Polyester')).toBe(false)
  })
})

describe('RULING P6(c): a unit that self-repeats is dropped at admission; the (fixed) material fact is NOT', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
  it('after P6(b), the true 50/50 material unit IS admitted (it no longer self-repeats)', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Fall Sweatshirts', 'Graphic Crewneck'], specFacts: ['50% Cotton / 50% Polyester', 'Classic Fit'], brandPick: null, wearFact: null },
      { designName: 'Cozy Days', truthCtx },
    )
    expect(units.some((u) => u.text === '50% Cotton / 50% Polyester')).toBe(true)
  })
  it('a unit that genuinely self-repeats a significant word is dropped and logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const units = buildAdmittedUnits(
        { candidates: ['Soft Soft Feel'], specFacts: [], brandPick: null, wearFact: null },
        { designName: 'Cozy Days', truthCtx },
      )
      expect(units.some((u) => u.text === 'Soft Soft Feel')).toBe(false)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('IH_WRITER_UNIT_DROPPED') && String(c[0]).includes('self-repeat'))).toBe(true)
    } finally { warn.mockRestore() }
  })
})

// ─── P1: ONE brand-carrier predicate — admission drops every extra carrier; the judge is defense in depth ─

describe('RULING P1: at most ONE brand-carrying unit, across every kind', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }

  it('a flattened/hyphenated second carrier ("Comfortcolors Shirt") is dropped at admission, not merely the exact-text twin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const units = buildAdmittedUnits(
        { candidates: ['Comfortcolors Shirt', 'Vintage Beach Vibes'], specFacts: ['100% Ring-Spun Cotton'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: null },
        { designName: 'Retro Sunset', truthCtx },
      )
      expect(units.some((u) => u.text === 'Comfortcolors Shirt')).toBe(false)
      expect(units.filter((u) => u.isBrand)).toHaveLength(1)
    } finally { warn.mockRestore() }
  })

  it('an identity text that ALSO carries the brand ("ComfortColors Club") is dropped at admission (attack8 §A8\'s mechanism)', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Vintage Beach Vibes'], specFacts: ['100% Ring-Spun Cotton'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: null },
      { designName: 'ComfortColors Club', truthCtx },
    )
    expect(units.some((u) => u.kind === 'identity')).toBe(false)
    expect(units.filter((u) => u.isBrand)).toHaveLength(1)
  })

  it('defense in depth: the judge rejects an arrangement using two units that BOTH carry the brand, even if admission somehow let both through', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Comfort Colors Tee', kind: 'brand', numberable: false, isBrand: true },
      { id: 'u2', text: 'Comfortcolors Shirt', kind: 'pool', numberable: true }, // simulates a gap: a second carrier that slipped past admission
      { id: 'u3', text: '100% Ring-Spun Cotton', kind: 'spec-fact', numberable: false },
    ]
    const parts: ArrangementPart[] = [
      { unit: 'u0' }, { glue: 'with' }, { unit: 'u3' }, { glue: ',' }, { unit: 'u1' }, { glue: 'and' }, { unit: 'u2' },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset', CC, truthCtx) })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/more than one unit carries the brand/)
  })
})

// ─── P3: garment-head abutment is legal ONLY after the IDENTITY unit — N01's "Cream of the Crop Top" ─

describe('RULING P3: a POOL unit may no longer abut a garment-head noun directly (N01)', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const units = buildAdmittedUnits(
    { candidates: ['Cream of the Crop', 'Vintage Beach Vibes'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
    { designName: 'Harvest Moon', truthCtx },
  )
  const id = (t: string) => units.find((u) => u.text === t)!.id

  it('N01: "Cream of the Crop" + "Top" (pool abutting a garment head) is REJECTED — was a live lie under K3', () => {
    const v = validateArrangement({ parts: [{ unit: id('Cream of the Crop') }, { unit: units.find((u) => u.kind === 'garment-head')!.id }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/identity unit directly/)
  })
  it('the IDENTITY unit may still abut a garment head ("Harvest Moon Shirt")', () => {
    const v = validateArrangement({ parts: [{ unit: id('Harvest Moon') }, { unit: units.find((u) => u.kind === 'garment-head')!.id }] }, units)
    expect(v.ok).toBe(true)
  })
  it('a pool unit CAN still precede a garment head — with a list join', () => {
    const v = validateArrangement({ parts: [{ unit: id('Cream of the Crop') }, { glue: 'and' }, { unit: units.find((u) => u.kind === 'garment-head')!.id }] }, units)
    expect(v.ok).toBe(true)
  })
})

// ─── P4: span truth judged WITHIN a comma clause, over every sub-span — N09/N10 rejected, B08 accepted ─

describe('RULING P4: span truth is judged per comma clause, over every contiguous sub-span, never across a comma', () => {
  it('N09-shaped: inserting a garment head BETWEEN the "%" marker and the fibre no longer launders the lie', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '52% Cotton / 48% Polyester', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits(
      { candidates: ['100% Awesome', 'Soft Poly Feel', 'Farm Life Crewneck'], specFacts: ['52% Cotton / 48% Polyester', 'Classic Fit'], brandPick: null, wearFact: null },
      { designName: 'Farm Life', truthCtx },
    )
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const garmentHead = units.find((u) => u.kind === 'garment-head' && u.text !== 'Crewneck')?.id ?? units.find((u) => u.kind === 'garment-head')!.id
    // "100% Awesome and Sweatshirt & Soft Poly Feel with 52% Cotton / 48% Polyester, Farm Life
    // Crewneck in a Classic Fit" — a list join (not abutment, per P3) between the pool unit and
    // the garment head, so this pin isolates P4's span-truth fix rather than P3's abutment fix.
    const parts: ArrangementPart[] = [
      { unit: id('100% Awesome') }, { glue: 'and' }, { unit: garmentHead }, { glue: '&' }, { unit: id('Soft Poly Feel') },
      { glue: 'with' }, { unit: id('52% Cotton / 48% Polyester') }, { glue: ',' },
      { unit: id('Farm Life Crewneck') }, { glue: 'in' }, { glue: 'a' }, { unit: id('Classic Fit') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Farm Life', GILDAN, truthCtx) })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/material-lie/)
  })

  it('B08-shaped: the PO-sanctioned wear fact IN ITS OWN comma clause is ACCEPTED end to end — never laundered by crossing a comma', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
    const composed = {
      candidates: ['Vintage Beach Vibes'], specFacts: ['100% Ring-Spun Cotton', 'Relaxed Fit'],
      brandPick: 'Comfort Colors Tee', brandOrigin: 'spec' as const, wearFact: 'Can be worn as Oversized',
    }
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    const id = (t: string) => units.find((u) => u.text === t)!.id
    // "Retro Sunset Tee with a Relaxed Fit, Can be worn as Oversized, Vintage Beach Vibes and Comfort Colors Tee"
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: units.find((u) => u.kind === 'garment-head')!.id },
      { glue: 'with' }, { glue: 'a' }, { unit: id('Relaxed Fit') }, { glue: ',' },
      { unit: id('Can be worn as Oversized') }, { glue: ',' },
      { unit: id('Vintage Beach Vibes') }, { glue: 'and' }, { unit: id('Comfort Colors Tee') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset', CC, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
})

// ─── P9/P10: the deadline is carried into runWriterForDesign, and the K10 catch is exercised for real ─

describe('RULING P9: the deadline is threaded into runWriterForDesign and checked between retries', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
  it('a deadline already in the past skips the call entirely — zero calls made, accepted:false', async () => {
    const client = { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })) } } }
    const outcome = await runWriterForDesign({
      // A pool/spec set whose best-case join clears the 97-char floor (avoids the EARLIER
      // "cannot reach the floor" skip that would otherwise mask the deadline check under test).
      composed: {
        candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'],
        specFacts: ['Classic Fit'], brandPick: null, wearFact: null,
      },
      fallbackHold: null, designName: 'Retro Sunset', truthCtx,
      runTail: runTailFor('THE CEO Retro Sunset', GILDAN, truthCtx),
      deps: { openai: client as never },
      deadlineAt: Date.now() - 1000,
    })
    expect(outcome.accepted).toBe(false)
    expect(outcome.calls).toBe(0)
    expect(client.chat.completions.create).not.toHaveBeenCalled()
    expect(outcome.reasons.join(' ')).toMatch(/deadline exceeded/)
  })
  it('ihWriterDeadlineMs default and clean-parse behaviour (P11 minor 1)', () => {
    expect(ihWriterDeadlineMs(undefined)).toBe(45_000)
    expect(ihWriterDeadlineMs('1e3')).toBe(45_000)
  })
})

describe('RULING P10: the K10 catch is exercised by a THROWING DEPS GETTER (not a throwing client — askWriter swallows client errors)', () => {
  it('produceItemHighlightsPerDesign(shadow): a throwing deps getter falls back to the composer\'s OWN result — never an exception escaping produce*, and calls=0 is correct (no call was ever billed)', async () => {
    const groups = [{ key: 'A', designName: 'Sunny Beach Vibes', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Sunny Beach Vibes Tee'] }]
    const pool: AnalyzedKeyword[] = [
      kw('funny graphic novelty tee', 450, 3), kw('cute cartoon animal print', 900, 3), kw('retro vintage style clothing', 300, 3),
      kw('cozy everyday casual wear', 250, 3), kw('trendy modern weekend outfit', 5000, 3),
    ]
    const input = { groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: 'Beach Family' }
    process.env.IH_WRITER = 'shadow'
    try {
      // A deps object whose `openai` GETTER throws when accessed — reached inside
      // `runWriterForDesign` BEFORE any client call is made, so this is the case a throwing
      // CLIENT cannot exercise (`askWriter`'s own try/catch swallows a throwing client and simply
      // spends the retry budget on malformed drafts, never reaching the outer catch).
      const throwingDeps = {} as { openai?: unknown }
      Object.defineProperty(throwingDeps, 'openai', { get() { throw new Error('deps getter blew up') } })
      const result = await produceItemHighlightsPerDesign(input, throwingDeps as never)
      const built = buildItemHighlightsPerDesign(input)
      const designA = result.perDesign.find((d) => d.designKey === 'A')!
      const builtA = built.perDesign.find((d) => d.designKey === 'A')!
      // THE core claim: a deps-getter throw never escapes produce* — the design ships the
      // COMPOSER'S OWN result, byte-identical, regardless of whether that result is a composed
      // line or a HOLD (this fixture's pool composes or holds identically either way).
      expect(designA.value).toBe(builtA.value)
      expect(designA.hold).toBe(builtA.hold)
      const rowA = result.writerLog?.find((r) => r.design === 'A')
      // A row is populated only when the design's OWN composed/truthCtx resolved far enough to
      // attempt the writer at all (`d.composed && d.truthCtx`) — when it did, calls must be 0
      // (the throw happened accessing `deps.openai`, before any client call could be billed).
      if (rowA) {
        expect(rowA.accepted).toBe(false)
        expect(rowA.calls).toBe(0)
      }
    } finally { delete process.env.IH_WRITER }
  })

  it('the single-design path (produceItemHighlights) is ALSO wrapped — a throwing deps getter falls back to the composer, never a 500 in shadow', async () => {
    process.env.IH_WRITER = 'shadow'
    try {
      const pool: AnalyzedKeyword[] = [
        kw('funny graphic novelty tee', 450, 3), kw('cute cartoon animal print', 900, 3), kw('retro vintage style clothing', 300, 3),
        kw('cozy everyday casual wear', 250, 3), kw('trendy modern weekend outfit', 5000, 3),
      ]
      const input = { finalTitle: 'THE CEO Sunny Beach Vibes Tee', pool, apparelProduct: true, blankBrand: GILDAN, netTitles: ['THE CEO Sunny Beach Vibes Tee'] }
      const throwingDeps = {} as { openai?: unknown }
      Object.defineProperty(throwingDeps, 'openai', { get() { throw new Error('deps getter blew up') } })
      const result = await produceItemHighlights(input, throwingDeps as never)
      expect(result.writerLog?.accepted).toBe(false)
      expect(result.writerLog?.calls).toBe(0)
      expect(typeof result.value).toBe('string')
    } finally { delete process.env.IH_WRITER }
  })

  it('WriterPartialCallsError carries the ACTUAL calls made before a post-call throw — never 0 when calls were spent', async () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const composed = {
      candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'],
      specFacts: ['Classic Fit'], brandPick: null, wearFact: null,
    }
    // Build the SAME admitted set the writer would, so the stub client can return a WELL-FORMED
    // arrangement (validates, renders, clears the band) — the throw must happen at `runTail`, not
    // be masked by an earlier "malformed"/"under-floor" rejection that never bills a call at all.
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const garmentHeadId = units.find((u) => u.kind === 'garment-head')!.id
    const draftParts = [
      { unit: id('Retro Sunset') }, { unit: garmentHeadId }, { glue: 'with' }, { unit: id('Classic Fit') }, { glue: ',' },
      { unit: id('Soft Graphic Tee') }, { glue: 'and' }, { unit: id('Vintage Beach Vibes') }, { glue: ',' }, { unit: id('Made for Lazy Summer Days') },
    ]
    let calls = 0
    const client = {
      chat: { completions: { create: vi.fn(async () => {
        calls++
        return { choices: [{ message: { content: JSON.stringify({ parts: draftParts }) }, finish_reason: 'stop' }] }
      }) } },
    }
    const throwingTail = (): { value: string; hold: string | null; reason?: string | null } => { throw new Error('tail blew up') }
    let thrown: unknown = null
    try {
      await runWriterForDesign({
        composed, fallbackHold: null, designName: 'Retro Sunset', truthCtx,
        runTail: throwingTail,
        deps: { openai: client as never },
      })
    } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(WriterPartialCallsError)
    expect((thrown as WriterPartialCallsError).callsMade).toBe(1) // the call that produced the arrangement WAS billed
    expect(calls).toBe(1)
  })
})
