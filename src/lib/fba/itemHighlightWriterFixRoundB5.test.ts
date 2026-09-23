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
  runWriterForDesign, WriterPartialCallsError, ihWriterDeadlineMs, enumerateWriterCandidates,
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

  // RULING Q9 (fix round B6, wire Blocking W8): the identity unit is NEVER dropped for carrying the
  // brand any more — the identity is effectively mandatory (the "names or evokes the design" rule),
  // and dropping it left the writer with no subject to name at all.
  // SUPERSEDED by RULING R1 (fix round B7a, compliance Blocking/Important, `q6brand`/`q8two`): B5's
  // "demoted, still admitted alongside a dedicated isBrand unit" shape made EVERY such arrangement
  // unsatisfiable (the judge's own brand-once check refuses identity+isBrand together, burning the
  // whole retry budget for nothing — `q8two.mts`'s exact finding). R1 corrected this: when the
  // identity ITSELF carries the brand, it is the ONE mandatory carrier and the dedicated brand unit
  // is WITHHELD entirely (never admitted at all) — so `isBrand` units drop to ZERO here, and the
  // brand requirement is instead satisfied (and re-verified) through the identity.
  it('an identity text that ALSO carries the brand ("ComfortColors Club") is the ONE carrier — the dedicated brand unit is withheld', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Vintage Beach Vibes'], specFacts: ['100% Ring-Spun Cotton'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: null },
      { designName: 'ComfortColors Club', truthCtx },
    )
    const identity = units.find((u) => u.kind === 'identity')
    expect(identity?.text).toBe('ComfortColors Club')
    expect(units.filter((u) => u.isBrand)).toHaveLength(0)
    expect(units.some((u) => u.text === 'Comfort Colors Tee')).toBe(false)
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
  // SUPERSEDED by RULING R5 (fix round B7a, truth Important I-2): a list-joined garment head reaches
  // the SAME "second garment / multi-pack" claim a bare abutment does, one join further out
  // ("Retro Sunset Tee and Top", T02b's exact shape) — the abutment pass alone never inspected a
  // garment-head unit reached through a list join, only a bare no-glue pair. A garment-head unit's
  // ONLY legal position, full stop, is directly after the identity; B5's "still fine with a list
  // join" premise no longer holds.
  it('a pool unit list-joined to a garment head is now ALSO rejected (RULING R5) — a garment-head unit has exactly one legal position', () => {
    const v = validateArrangement({ parts: [{ unit: id('Cream of the Crop') }, { glue: 'and' }, { unit: units.find((u) => u.kind === 'garment-head')!.id }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/garment-head unit and may appear ONLY directly after the identity/)
  })
})

// ─── P4: span truth judged WITHIN a comma clause, over every sub-span — N09/N10 rejected, B08 accepted ─

describe('RULING P4: span truth is judged per comma clause, over every contiguous sub-span, never across a comma', () => {
  it('N09-shaped: inserting a garment head BETWEEN the "%" marker and the fibre no longer launders the lie', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '52% Cotton / 48% Polyester', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    // RULING Q6 (fix round B6, value Blocking B3): the design name must not share a significant
    // word with 'Farm Life Crewneck' (this pin's own pool candidate) or admission would drop it as
    // an identity-collision before ever reaching P4's span-truth check this test isolates — 'Barn
    // Yard' is unrelated vocabulary.
    const units = buildAdmittedUnits(
      { candidates: ['100% Awesome', 'Soft Poly Feel', 'Farm Life Crewneck'], specFacts: ['52% Cotton / 48% Polyester', 'Classic Fit'], brandPick: null, wearFact: null },
      { designName: 'Barn Yard', truthCtx },
    )
    const id = (t: string) => units.find((u) => u.text === t)!.id
    // "100% Awesome and Farm Life Crewneck & Soft Poly Feel with 52% Cotton / 48% Polyester" — a
    // list join between the two lying units' pair, with an INTERVENING pool unit (not a garment
    // head — RULING R5, fix round B7a, made a garment-head unit's only legal position directly
    // after the identity, so the ORIGINAL fixture's "and <garment head> &" insertion is now itself
    // grammar-illegal and would reject at the grammar stage before ever reaching the span-truth
    // check this pin isolates; a pool unit fills the identical structural role — something sitting
    // BETWEEN the "%" marker and the fibre, inside the SAME comma-free clause).
    const parts: ArrangementPart[] = [
      { unit: id('100% Awesome') }, { glue: 'and' }, { unit: id('Farm Life Crewneck') }, { glue: '&' }, { unit: id('Soft Poly Feel') },
      { glue: 'with' }, { unit: id('52% Cotton / 48% Polyester') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Barn Yard', GILDAN, truthCtx) })
    expect(v.ok).toBe(false)
    // RULING Q5 (fix round B6, value Blocking B2): the raw code is now mapped to plain language.
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/fabric\/material claim/)
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
  // RULING G3 (fix round G1, design change): "skips the call entirely" is UNCHANGED (the client
  // is still never reached) — what changed is what ships. G3 point 4's own words: "a timeout —
  // candidate 1 ships." A real candidate exists for this pool/spec set (proven directly below), so
  // the search's own top candidate ships at ZERO calls, never `accepted: false` — there is no
  // reason to fall back to the composer once a line has already cleared every gate.
  it('a deadline already in the past skips the CLIENT entirely, but still ships the search\'s own candidate — zero calls made, accepted:true', async () => {
    const client = { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })) } } }
    const composed = {
      candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'],
      specFacts: ['Classic Fit'], brandPick: null, wearFact: null,
    }
    const runTail = runTailFor('THE CEO Retro Sunset', GILDAN, truthCtx)
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    const expectedTop = enumerateWriterCandidates(units, { truthCtx, runTail }).candidates[0]
    expect(expectedTop, 'a candidate must exist for this pin to mean anything').toBeDefined()
    const outcome = await runWriterForDesign({
      composed, fallbackHold: null, designName: 'Retro Sunset', truthCtx, runTail,
      deps: { openai: client as never },
      deadlineAt: Date.now() - 1000,
    })
    expect(outcome.accepted).toBe(true)
    expect(outcome.value).toBe(expectedTop.line)
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

  // RULING G3 (fix round G1, design change): this pin's ORIGINAL premise was that `runTail`'s
  // throw is reached only AFTER a billable model call (the model composes, its draft is JUDGED,
  // the judge calls `runTail`) — so `callsMade` had to be `1`, never `0`, or a caller would over-
  // refund a call it never actually got to spend. Under the chooser, `runTail` is called by
  // `enumerateWriterCandidates` DURING THE SEARCH — a purely local step that runs BEFORE the
  // client/model even exist — so a throwing tail is now reached with ZERO calls billed, always.
  // This is a STRICTLY stronger guarantee, not a regression: a tail bug can no longer waste a real
  // API call before it is ever caught. Re-pinned for the new architecture below.
  it('WriterPartialCallsError carries ZERO calls made when the throw happens during the SEARCH (enumerateWriterCandidates), before any client/model exists', async () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const composed = {
      candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'],
      specFacts: ['Classic Fit'], brandPick: null, wearFact: null,
    }
    let calls = 0
    const client = {
      chat: { completions: { create: vi.fn(async () => { calls++; return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] } }) } },
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
    expect((thrown as WriterPartialCallsError).callsMade).toBe(0) // the throw happened during the FREE search — no call was ever billed
    expect(calls).toBe(0) // the client was never even reached
  })
})
