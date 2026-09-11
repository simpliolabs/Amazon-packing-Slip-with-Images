/**
 * itemHighlightWriterFixRoundB6.test.ts — fix round B6 (controller RULING on the B5 panel,
 * `.superpowers/sdd/2026-09-10-ih-writer/phase-b6-rulings.md`, Q1-Q12). Pins the panel's specific
 * Blocking/Important findings as must-reject/must-expose through the REAL functions — never a
 * re-implementation of the rules under test. Every "lie" line below is a STUB arrangement or a
 * hand-built pool row, never model output; the wall-time tests (Q10) are the ONE place a REAL
 * `openai` SDK client is constructed, pointed at a LOCAL 127.0.0.1 server (dead / slow) — never a
 * live model call, no `.env` file is read anywhere in this file.
 */
import { describe, it, expect } from 'vitest'
import http from 'node:http'
import OpenAI from 'openai'
import {
  buildAdmittedUnits, judgeWriterArrangement, validateArrangement, buildWriterPrompt,
  type AdmittedUnit, type ArrangementPart,
} from './itemHighlightWriter'
import { lineCarriesBrand } from './itemHighlightComposer'
import { buildItemHighlights, buildItemHighlightsPerDesign, produceItemHighlights, produceItemHighlightsPerDesign, runIhTail } from './listingPipeline'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number, themeFit: number | null = 3): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)
const CC = DEFAULT_BLANK_SPECS[0]
const GILDAN = DEFAULT_BLANK_SPECS[1]
const NEVER: RegExp = /(?!)/
const PURE_TEE: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '100% Ring-Spun Cotton' } as never, styleCode: 'x', garmentFamily: 'tee' } as unknown as BlankSpecRow
const BLEND_SWEAT: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '52% Cotton / 48% Polyester' } as never, styleCode: 'x', garmentFamily: 'sweatshirt' } as unknown as BlankSpecRow

const runTailFor = (title: string, blank: BlankSpecRow | null, truthCtx: PhraseTruthCtx) =>
  (line: string) => runIhTail(line, { titles: [title], blankBrand: blank, truthCtx, site: 'fix-round-b6-test' })

interface Setup { units: AdmittedUnit[]; runTail: (l: string) => { value: string; hold: string | null; reason?: string | null }; truthCtx: PhraseTruthCtx; value: string }
function setup(o: { name: string; pool: string[]; blank: BlankSpecRow; title?: string; audienceLean?: PhraseTruthCtx['audienceLean'] }): Setup {
  const title = o.title ?? `THE CEO ${o.name} Shirt`
  const input = {
    finalTitle: title, pool: o.pool.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
    blankBrand: o.blank, netTitles: [title], designTokens: [o.name], capacityFamily: false, brandName: 'THE CEO',
    audienceLean: o.audienceLean,
  }
  const built = buildItemHighlights(input)
  const units = buildAdmittedUnits(built.composed!, { designName: o.name, truthCtx: built.truthCtx! })
  const runTail = (l: string) => runIhTail(l, { titles: [title], blankBrand: o.blank, truthCtx: built.truthCtx!, capacityFamily: false, brandName: 'THE CEO', site: 'fix-round-b6-test' })
  return { units, runTail, truthCtx: built.truthCtx!, value: built.value }
}
/** Resolves a spec array of unit TEXTS into arrangement parts (mirrors the Grammar test file's own
 *  `resolve()` — RULING Q2, fix round B6: no "number" field any more). */
const GLUE_TOKENS = new Set(['a', 'an', 'and', 'with', 'in', ',', '—', '|', '&'])
function resolve(spec: readonly string[], units: readonly AdmittedUnit[]): ArrangementPart[] {
  const parts: ArrangementPart[] = []
  for (const s of spec) {
    if (GLUE_TOKENS.has(s)) { parts.push({ glue: s }); continue }
    const u = units.find((x) => x.text.toLowerCase() === s.toLowerCase())
    if (!u) throw new Error(`fixture unit not admitted: "${s}"`)
    parts.push({ unit: u.id })
  }
  return parts
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q1 (truth Blocking TR-1): A RELATION OWNS ITS CLAUSE — a list join after the legal spec unit must
// not restore the invented feature one join further out.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING Q1: a relation clause stays open until the next "," — E01/E04/E05/E07/E08/E10/E11 rejected, E02 unchanged, the positive pin ships', () => {
  const TEE_POOL = ['Deep Pockets', 'Stretchy Waistband', 'Muscle Tee', 'Vintage Beach Vibes', 'Made For Lazy Summer Days']
  const s = setup({ name: 'Retro Sunset', pool: TEE_POOL, blank: PURE_TEE })
  const id = (t: string) => s.units.find((u) => u.text === t)!.id
  const garmentHead = s.units.find((u) => u.kind === 'garment-head')!.id
  const identity = id('Retro Sunset')
  const classicFit = id('Classic Fit')

  it('E01: "...with a Classic Fit and Deep Pockets, ..." is REJECTED (the list join does not close the relation)', () => {
    const parts = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: classicFit },
      { glue: 'and' }, { unit: id('Deep Pockets') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: ',' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const v = judgeWriterArrangement({ parts }, s.units, { truthCtx: s.truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, s.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/relation 'with' is still open/)
  })

  it('E02 (control): "...with Deep Pockets, ..." — the DIRECT case, message UNCHANGED', () => {
    const parts = [{ unit: identity }, { unit: garmentHead }, { glue: 'with' }, { unit: id('Deep Pockets') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') }]
    const v = validateArrangement({ parts }, s.units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/relation 'with' must introduce a spec fact; 'Deep Pockets' is a pool unit/)
  })

  it('E04: "...with a Classic Fit and Stretchy Waistband, ..." is REJECTED', () => {
    const parts = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: classicFit },
      { glue: 'and' }, { unit: id('Stretchy Waistband') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
    ]
    const v = judgeWriterArrangement({ parts }, s.units, { truthCtx: s.truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, s.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/relation 'with' is still open/)
  })

  it('E05 (52/48 sweatshirt): "...with a Classic Fit and Deep Pockets, ..." is REJECTED on a different family too', () => {
    const sB = setup({ name: 'Farm Life', pool: ['Deep Pockets', 'Cozy Crewneck Sweatshirt', 'Warm Layer For Winter'], blank: BLEND_SWEAT })
    const idB = (t: string) => sB.units.find((u) => u.text === t)!.id
    const ghB = sB.units.find((u) => u.kind === 'garment-head')!.id
    const parts = [
      { unit: idB('Farm Life') }, { unit: ghB }, { glue: 'with' }, { glue: 'a' }, { unit: idB('Classic Fit') },
      { glue: 'and' }, { unit: idB('Deep Pockets') }, { glue: ',' }, { unit: idB('Cozy Crewneck Sweatshirt') },
    ]
    const v = judgeWriterArrangement({ parts }, sB.units, { truthCtx: sB.truthCtx, runTail: runTailFor('THE CEO Farm Life Sweatshirt', BLEND_SWEAT, sB.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/relation 'with' is still open/)
  })

  it('E07: two features chained by list joins inside one open relation — REJECTED', () => {
    const parts = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: classicFit },
      { glue: 'and' }, { unit: id('Deep Pockets') }, { glue: 'and' }, { unit: id('Stretchy Waistband') },
      { glue: ',' }, { unit: id('Vintage Beach Vibes') },
    ]
    const v = judgeWriterArrangement({ parts }, s.units, { truthCtx: s.truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, s.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/relation 'with' is still open/)
  })

  it('E08: the "&" variant — REJECTED the same way', () => {
    const parts = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: classicFit },
      { glue: '&' }, { unit: id('Deep Pockets') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
    ]
    const v = judgeWriterArrangement({ parts }, s.units, { truthCtx: s.truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, s.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/relation 'with' is still open/)
  })

  it('E10: a true spec fact list-joined to an invented style claim inside the SAME open relation — REJECTED', () => {
    const shortSleeveUnit = s.units.find((u) => u.text === 'Short Sleeve')
    if (!shortSleeveUnit) return // this blank carries no sleeve spec fact — acceptable, nothing to pin
    const parts = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { unit: shortSleeveUnit.id },
      { glue: 'and' }, { unit: id('Muscle Tee') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
    ]
    const v = judgeWriterArrangement({ parts }, s.units, { truthCtx: s.truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, s.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/relation 'with' is still open/)
  })

  it('E11 (Comfort Colors): the brand inside an open "in" relation clause — REJECTED', () => {
    const sCC = setup({ name: 'Retro Sunset', pool: ['Vintage Beach Vibes', 'comfort colors tee'], blank: CC })
    const idCC = (t: string) => sCC.units.find((u) => u.text === t)!.id
    const ghCC = sCC.units.find((u) => u.kind === 'garment-head')!.id
    const dyeUnit = sCC.units.find((u) => u.kind === 'spec-fact' && /dye|fabric/i.test(u.text))
    if (!dyeUnit) return // this blank exposes no dye spec fact — acceptable, nothing to pin
    const parts = [
      { unit: idCC('Retro Sunset') }, { unit: ghCC }, { glue: 'in' }, { unit: dyeUnit.id },
      { glue: 'and' }, { unit: idCC('Comfort Colors Tee') }, { glue: ',' }, { unit: idCC('Vintage Beach Vibes') },
    ]
    const v = judgeWriterArrangement({ parts }, sCC.units, { truthCtx: sCC.truthCtx, runTail: runTailFor('THE CEO Retro Sunset Tee', CC, sCC.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/relation 'in' is still open|brand unit is list-join only/)
  })

  it('POSITIVE pin: "...with a Classic Fit and a Crew Neck, ..." (two spec facts, both inside the SAME relation clause) still SHIPS', () => {
    const neckUnit = s.units.find((u) => u.kind === 'spec-fact' && /neck/i.test(u.text))
    if (!neckUnit) return // this blank exposes no neck spec fact — build a synthetic one for the shape instead
    const parts = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: classicFit },
      { glue: 'and' }, { glue: 'a' }, { unit: neckUnit.id }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: 'and' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const v = judgeWriterArrangement({ parts }, s.units, { truthCtx: s.truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, s.truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })

  it('POSITIVE pin (synthetic units, family-independent): the SAME shape ships when both units inside the relation clause are spec-class', () => {
    const synthetic: AdmittedUnit[] = [
      { id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Shirt', kind: 'garment-head', numberable: true },
      { id: 'u2', text: 'Classic Fit', kind: 'spec-fact', numberable: false },
      { id: 'u3', text: 'Crew Neck', kind: 'spec-fact', numberable: false },
      { id: 'u4', text: 'Vintage Beach Vibes', kind: 'pool', numberable: false },
    ]
    const parts: ArrangementPart[] = [
      { unit: 'u0' }, { unit: 'u1' }, { glue: 'with' }, { glue: 'a' }, { unit: 'u2' },
      { glue: 'and' }, { glue: 'a' }, { unit: 'u3' }, { glue: ',' }, { unit: 'u4' },
    ]
    const v = validateArrangement({ parts }, synthetic)
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q2 (truth Important TR-2): "number" is GONE — a plural on ANY unit is an unrecognized key.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING Q2: the six measured plural lines are rejected; no reference line needs "number"', () => {
  const PLURAL_SHAPES: { id: string; o: Parameters<typeof setup>[0]; unitText: string }[] = [
    { id: 'PURE (identity)', o: { name: 'Retro Sunset', pool: ['Vintage Beach Vibes', 'Soft Cotton Feel'], blank: PURE_TEE }, unitText: 'Retro Sunset' },
    { id: 'BLEND (identity)', o: { name: 'Farm Life', pool: ['Cozy Crewneck Sweatshirt', 'Warm Layer For Winter'], blank: BLEND_SWEAT }, unitText: 'Farm Life' },
    { id: 'UNISEX (identity)', o: { name: 'Retro Sunset', pool: ['Vintage Beach Vibes', 'Soft Cotton Feel'], blank: { ...PURE_TEE, spec: { ...(PURE_TEE.spec as object), unisex: true } as never } }, unitText: 'Retro Sunset' },
  ]
  for (const { id, o, unitText } of PLURAL_SHAPES) {
    it(`${id}: {"number":"plural"} on the design's own garment head is an unrecognized key, rejected`, () => {
      const s = setup(o)
      const unit = s.units.find((u) => u.text === unitText)!
      const v = validateArrangement({ parts: [{ unit: unit.id, number: 'plural' } as unknown as ArrangementPart] }, s.units)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.violation).toMatch(/unknown key/)
    })
  }
  it('a pool phrase ending in a garment noun also rejects "number"', () => {
    const s = setup({ name: 'Retro Sunset', pool: ['Cute Graphic Tops', 'Vintage Beach Vibes'], blank: PURE_TEE })
    const unit = s.units.find((u) => u.kind === 'pool')
    if (!unit) return
    const v = validateArrangement({ parts: [{ unit: unit.id, number: 'plural' } as unknown as ArrangementPart] }, s.units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/unknown key/)
  })
  it('no rule sentence in the registry mentions "number" any more', () => {
    const { system } = buildWriterPrompt([], null, [])
    expect(system).not.toMatch(/"number"/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q4 (value Blocking B1): the feminine+masculine rule is TAUGHT unconditionally.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING Q4: the fem+masc rule is taught unconditionally, including on a lean_female family with no Unisex unit offered', () => {
  it('a lean_female family with NO Unisex spec-fact carries the fem+masc sentence in the rendered prompt', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic' }, allowedBrand: null, audience: 'adult', audienceLean: 'women', field: 'highlights' }
    const units = buildAdmittedUnits(
      { candidates: ['Mens Motivational Sweatshirt', 'Fall Sweatshirts for Women'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
      { designName: "Don't Quit", truthCtx },
    )
    expect(units.some((u) => u.kind === 'spec-fact' && /\bunisex\b/i.test(u.text))).toBe(false)
    const { system } = buildWriterPrompt(units, "Don't Quit", [])
    expect(system).toMatch(/feminine audience word.*masculine audience word|masculine audience word.*feminine audience word/i)
  })

  it("N3a: \"Mens Motivational Sweatshirt and Fall Sweatshirts for Women\" — states both genders — is REJECTED", () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic' }, allowedBrand: null, audience: 'adult', audienceLean: 'women', field: 'highlights' }
    const units = buildAdmittedUnits(
      { candidates: ['Mens Motivational Sweatshirt', 'Fall Sweatshirts for Women', 'Piece-Dyed Fabric'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
      { designName: "Don't Quit", truthCtx },
    )
    const id = (t: string) => units.find((u) => u.text === t)!.id
    // No garment-head abutment here — the design's own head noun PLUS both pool phrases' own
    // "Sweatshirt"/"Sweatshirts" would exceed the repeat budget (3 > 2) and reject on THAT gate
    // first, never reaching the gender check this pin isolates. One more pool unit pushes the line
    // into the 97-125 band so neither the min nor the max fires before the gender gate does.
    const parts = [
      { unit: id("Don't Quit") }, { glue: 'with' }, { glue: 'a' }, { unit: id('Classic Fit') },
      { glue: ',' }, { unit: id('Mens Motivational Sweatshirt') }, { glue: 'and' }, { unit: id('Fall Sweatshirts for Women') },
      { glue: ',' }, { unit: id('Piece-Dyed Fabric') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Never Give Up Sweatshirt', GILDAN, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/feminine and a masculine/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q5 (value Blocking B2): span truth is taught, and its refusal speaks English.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING Q5: span truth (pair-truth) is taught in the prompt, and the "join:" violation is plain language', () => {
  // RULING R9 (fix round B7a, value Important): the OLD fixture's 3-keyword pool never contains
  // "oversized" so `factEligible` (itemHighlightComposer.ts) is never true and no wear-fact unit is
  // ever admitted — BOTH assertions below returned early before running, which is exactly the
  // test-proves-the-mock class this round was ruled to end (`b7-rulings.md` HOW THIS ROUND RUNS
  // DIFFERENTLY, #1). Replaced with the REAL 12-keyword Comfort Colors pool review B5's own value
  // lens used (`phase-b6-review-value.md` §4's "See You Later Alligator" reference family), which
  // DOES carry "oversized graphic tee" and yields a real wear-fact unit through the REAL composer.
  const s = setup({
    name: 'See You Later Alligator',
    pool: [
      'alligator shirt', 'see you later alligator', 'retro alligator graphic tee', 'swamp animal lover gift',
      'oversized graphic tee', 'comfort colors tee', 'vintage washed tee', 'reptile lover shirt',
      'cute gator shirt', 'summer beach tee', 'soft cotton tee', 'funny pun shirt',
    ],
    blank: CC, audienceLean: null as never,
  })

  it('the rendered prompt contains the pair-truth sentence, unconditionally', () => {
    const { system } = buildWriterPrompt(s.units, 'See You Later Alligator', [])
    expect(system).toMatch(/only true ON THEIR OWN/)
  })

  it('a rejected draft (the wear fact paired with a true spec fact) is REJECTED for a PLAIN-LANGUAGE reason, not a bare code — RULING S2 (fix round B8a) supersedes this exact pairing at the GRAMMAR layer, before span truth ever runs', () => {
    const wearUnit = s.units.find((u) => u.kind === 'wear-fact')
    const specUnit = s.units.find((u) => u.kind === 'spec-fact')
    // RULING R9: NO early-return guard — the 12-keyword pool is REAL and DOES yield both units;
    // an early return here would silently skip the assertions again, the exact defect being fixed.
    expect(wearUnit, JSON.stringify(s.units.map((u) => u.text))).toBeDefined()
    expect(specUnit, JSON.stringify(s.units.map((u) => u.text))).toBeDefined()
    const identity = s.units.find((u) => u.kind === 'identity')!.id
    const garmentHead = s.units.find((u) => u.kind === 'garment-head')!.id
    // RULING R6 (fix round B7a): the wear fact is now list-join-only, so the OLD shape ("with
    // <spec> and <wear-fact>", the wear fact reached via a list join INSIDE the still-open "with"
    // relation clause) is rejected at the GRAMMAR stage now (Q1's clause-scope pass), never
    // reaching span truth at all — the exact shape R6 exists to forbid, since "with Can be worn as
    // Oversized" is ungrammatical English by itself.
    // RULING S2 (fix round B8a, spec §2h rule 2, superseding this test's ORIGINAL premise): the
    // shape this test used to isolate span truth with — "<spec>, <wear-fact> and <brand>", a PURE
    // list clause where the spec+wear-fact ADJACENCY itself was the lie — is now ITSELF a named
    // grammar violation: the wear fact must stand ALONE in its own "," comma clause, so being
    // list-joined to the spec fact via the comma/"and" pair is refused before span truth ever runs.
    // Measured directly (`buildAdmittedUnits` for this family): EVERY reachable phraseTruthVerdict
    // pairwise lie among these admitted units involves the wear fact ("Can be worn as Oversized"
    // paired with anything else is a fit-claim-lie; no OTHER pairing in this family's admitted set
    // is untrue) — so S2 does not create a narrower truth net here, it makes the writer's OWN
    // wear-fact "join:" class UNREACHABLE by construction, catching the identical shape one layer
    // earlier with an equally plain-language reason. This test now asserts THAT.
    const parts = [
      { unit: identity }, { unit: garmentHead }, { glue: ',' }, { unit: specUnit!.id },
      { glue: 'and' }, { unit: wearUnit!.id }, { glue: ',' }, { unit: s.units.find((u) => u.text === 'Comfort Colors Tee')!.id },
    ]
    const v = judgeWriterArrangement({ parts }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (v.ok) return // unreachable given the assertion above; keeps TS's control-flow narrowing happy
    expect(v.violations.join(' ')).toMatch(/^arrangement:/)
    // PLAIN-LANGUAGE, not a bare code: the S2 grammar message names the unit, the required shape,
    // and the reason ("asserts a fit/cut claim this blank does not back") in one sentence.
    expect(v.violations.join(' ')).toMatch(/must stand ALONE in its own "," comma clause.*asserts a fit\/cut claim this blank does not back/)
    // Repair A: drop the offending neighbour (an extra pool phrase clears the 97-char floor).
    const repairA = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { unit: specUnit!.id }, { glue: ',' },
      { unit: s.units.find((u) => u.text === 'Comfort Colors Tee')!.id }, { glue: 'and' }, { unit: s.units.find((u) => u.text === 'Funny Pun Shirt')!.id },
      { glue: ',' }, { unit: s.units.find((u) => u.text === 'Swamp Animal Lover Gift')!.id },
    ]
    const vA = judgeWriterArrangement({ parts: repairA }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
    expect(vA.ok, JSON.stringify(vA)).toBe(true)
    // Repair B: the offending unit alone, in its own comma clause (list-joined, never after "with").
    const repairB = [
      { unit: identity }, { unit: garmentHead }, { glue: 'with' }, { unit: specUnit!.id }, { glue: ',' },
      { unit: s.units.find((u) => u.text === 'Comfort Colors Tee')!.id }, { glue: 'and' }, { unit: s.units.find((u) => u.text === 'Funny Pun Shirt')!.id },
      { glue: ',' }, { unit: wearUnit!.id },
    ]
    const vB = judgeWriterArrangement({ parts: repairB }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
    expect(vB.ok, JSON.stringify(vB)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q6 (value Blocking B3): a unit that can never be used is never offered.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING Q6: an identity-colliding unit is dropped at admission, and every remaining unit is reachable', () => {
  it('"Mind your Business" is dropped on "Business B*tch" (the flag-off composer ships it, but no writer line ever could carry it beside the mandatory identity)', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    expect(phraseTruthVerdict('Mind your Business', truthCtx).ok).toBe(true) // the PICKER admits it
    const units = buildAdmittedUnits(
      { candidates: ['Mind your Business', 'Girl Boss Crewneck'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
      { designName: 'Business B*tch', truthCtx },
    )
    expect(units.find((u) => u.text === 'Mind your Business')).toBeUndefined()
    expect(units.find((u) => u.text === 'Girl Boss Crewneck')).toBeDefined()
  })

  it('"Retro Alligator Graphic Tee" is dropped on "See You Later Alligator"', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    expect(phraseTruthVerdict('Retro Alligator Graphic Tee', truthCtx).ok).toBe(true)
    const units = buildAdmittedUnits(
      { candidates: ['Retro Alligator Graphic Tee', 'Funny Pun Shirt'], specFacts: [], brandPick: null, wearFact: null },
      { designName: 'See You Later Alligator', truthCtx },
    )
    expect(units.find((u) => u.text === 'Retro Alligator Graphic Tee')).toBeUndefined()
    expect(units.find((u) => u.text === 'Funny Pun Shirt')).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q8 (compliance Important): brand-once is taught wherever it is enforced.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING Q8: brand-once is taught whenever allowedBrand is set, and admission never offers two carriers even with needBrand=false', () => {
  it('a needBrand=false family carrying an identity-carrier AND a pool-carrier: only ONE carrier survives admission', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits(
      { candidates: ['Comfort Colors Graphic Tee', 'Vintage Beach Vibes'], specFacts: [], brandPick: null, brandOrigin: null, wearFact: null },
      { designName: 'ComfortColors Club', truthCtx },
    )
    const carriers = units.filter((u) => lineCarriesBrand(u.text, 'Comfort Colors'))
    expect(carriers.length).toBe(1)
    expect(carriers[0].text).toBe('ComfortColors Club') // the identity is protected (Q9); the pool twin is dropped
  })

  it('buildWriterPrompt renders the brand sentence whenever allowedBrand is set, even with no brand UNIT at all', () => {
    // "At most ONE unit ... may carry the brand text" is unique to the 'brand' registry sentence —
    // unlike "LIST-JOIN ONLY", which the (always-rendered) 'grammar' sentence also mentions.
    const BRAND_MARKER = /At most ONE unit in your whole arrangement may carry the brand text/
    const units: AdmittedUnit[] = [{ id: 'u0', text: 'Plain Design', kind: 'identity', numberable: false }]
    const { system } = buildWriterPrompt(units, 'Plain Design', [], 'Comfort Colors')
    expect(system).toMatch(BRAND_MARKER)
    const { system: systemNoBrand } = buildWriterPrompt(units, 'Plain Design', [], null)
    expect(systemNoBrand).not.toMatch(BRAND_MARKER)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q9 (wire Important W8): the brand-carrier drop must not eat unrelated units or the identity.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING Q9: the word-bounded brand-carrier drop never eats unrelated units or the identity', () => {
  it('with allowedBrand="Ace": "Peace Shirt", "Race Day Tee" and "Ace Design" all survive admission', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: 'Ace', audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits(
      { candidates: ['Ace Tee', 'Peace Shirt', 'Race Day Tee', 'Workout Top'], specFacts: [], brandPick: 'Ace Tee', brandOrigin: 'pool', wearFact: null },
      { designName: 'Ace Design', truthCtx },
    )
    expect(units.find((u) => u.text === 'Peace Shirt')).toBeDefined()
    expect(units.find((u) => u.text === 'Race Day Tee')).toBeDefined()
    expect(units.find((u) => u.text === 'Ace Design' && u.kind === 'identity')).toBeDefined()
  })

  it('lineCarriesBrand itself is word-bounded: "Peace"/"Race" do not carry "Ace"; hyphen/dot/slash/underscore spellings of a multi-word brand still do', () => {
    expect(lineCarriesBrand('Peace Shirt', 'Ace')).toBe(false)
    expect(lineCarriesBrand('Race Day Tee', 'Ace')).toBe(false)
    expect(lineCarriesBrand('Ace Design', 'Ace')).toBe(true)
    expect(lineCarriesBrand('Comfort-Colors Shirt', 'Comfort Colors')).toBe(true)
    expect(lineCarriesBrand('Comfort.Colors Shirt', 'Comfort Colors')).toBe(true)
    expect(lineCarriesBrand('Comfort/Colors Shirt', 'Comfort Colors')).toBe(true)
    expect(lineCarriesBrand('Comfort_Colors Shirt', 'Comfort Colors')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Q10 (wire Important W7): the ruled wall-time pin — a REAL local HTTP server, dead and slow.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const server = http.createServer(handler)
    const sockets = new Set<import('node:net').Socket>()
    server.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)) })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolveStart({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((resolveClose) => {
          for (const sock of sockets) sock.destroy()
          server.close(() => resolveClose())
        }),
      })
    })
  })
}
const OPENAI_ENVELOPE = (content: string) => JSON.stringify({
  id: 'x', object: 'chat.completion', created: 0, model: 'gpt-4.1',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
})

describe('RULING Q10 (P9\'s own ruled pin): a REAL local HTTP server, dead and slow, bounds the wall time', () => {
  const pool: AnalyzedKeyword[] = [
    kw('funny graphic novelty tee', 450), kw('cute cartoon animal print', 900), kw('retro vintage style clothing', 300),
    kw('cozy everyday casual wear', 250), kw('trendy modern weekend outfit', 5000),
  ]
  // RULING W3 (fix round B7b, wire Important): the PER-DESIGN test below feeds this SAME `pool` into
  // `produceItemHighlightsPerDesign` for design keys 'A'/'B' — but `unratedDesignKeys`/`designFitOf`
  // (themeFitByDesign.ts) rate designs by KEY, not by the flat `themeFit` above, and a row missing a
  // design's key rating holds that design 'designs-unrated' (0 writer calls) UNCONDITIONALLY, before
  // the writer is ever reached. Without this, the per-design test below silently never engaged the
  // writer at all (verified: wall ~15ms, calls:0, unconditionally, regardless of server behaviour) —
  // a DIFFERENT, and more severe, instance of the "test-proves-the-mock" class than the one Q10/W7
  // named (a wall-time bound trivially holds when nothing was ever awaited). Every row rated for both
  // keys (100% share, over the 30% DESIGN_RATED_MIN_SHARE floor) makes the per-design test below a
  // REAL exercise of the writer; the single-design test above never reads `themeFitByDesign`, so this
  // addition does not change its behaviour.
  const perDesignPool: AnalyzedKeyword[] = pool.map((k) => ({ ...k, themeFitByDesign: { A: { fit: 3 }, B: { fit: 3 } } } as unknown as AnalyzedKeyword))

  it('single-design path (produceItemHighlights): a DEAD server (hangs, never responds) bounds wall <= deadline + 20000, shipped === composer', async () => {
    const { url, close } = await startServer(() => { /* never respond — the server hangs */ })
    const deadlineMs = 1200
    process.env.IH_WRITER = 'on'
    process.env.IH_WRITER_DEADLINE_MS = String(deadlineMs)
    try {
      const input = { finalTitle: 'THE CEO Sunny Beach Vibes Tee', pool, apparelProduct: true, blankBrand: GILDAN, netTitles: ['THE CEO Sunny Beach Vibes Tee'] }
      const composer = buildItemHighlights(input)
      const client = new OpenAI({ apiKey: 'sk-test-local', baseURL: url, maxRetries: 0 })
      const t0 = Date.now()
      const result = await produceItemHighlights(input, { openai: client })
      const wall = Date.now() - t0
      expect(wall, `wall=${wall}ms`).toBeLessThanOrEqual(deadlineMs + 20_000)
      expect(result.value).toBe(composer.value)
      expect(result.hold).toBe(composer.hold)
    } finally {
      delete process.env.IH_WRITER
      delete process.env.IH_WRITER_DEADLINE_MS
      await close()
    }
  }, 40_000)

  it('per-design path (produceItemHighlightsPerDesign): a SLOW server (answers, but with a malformed/empty draft) bounds wall <= deadline + 20000, shipped === composer for every design', async () => {
    const slowMs = 500
    const { url, close } = await startServer((_req, res) => {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(OPENAI_ENVELOPE('{}')) }, slowMs)
    })
    const deadlineMs = 2500
    process.env.IH_WRITER = 'on'
    process.env.IH_WRITER_DEADLINE_MS = String(deadlineMs)
    try {
      const groups = [
        { key: 'A', designName: 'Sunny Beach Vibes', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Sunny Beach Vibes Tee'] },
        { key: 'B', designName: 'Cozy Fall Layer', skus: [{ sku: 'B1', asin: 'B0B0000001' }], titles: ['THE CEO Cozy Fall Layer Tee'] },
      ]
      const input = { groups, pool: perDesignPool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: 'Beach Family' }
      const composer = buildItemHighlightsPerDesign(input)
      const client = new OpenAI({ apiKey: 'sk-test-local', baseURL: url, maxRetries: 0 })
      const t0 = Date.now()
      const result = await produceItemHighlightsPerDesign(input, { openai: client })
      const wall = Date.now() - t0
      // RULING W3 (fix round B7b): non-vacuous — the writer must have actually run for both
      // designs (never 'designs-unrated', never 0 calls), or the bound below passes trivially.
      expect(result.writerLog?.length, JSON.stringify(result.writerLog)).toBe(2)
      for (const row of result.writerLog ?? []) expect(row.calls, JSON.stringify(row)).toBeGreaterThan(0)
      expect(wall, `wall=${wall}ms`).toBeLessThanOrEqual(deadlineMs + 20_000)
      for (const d of result.perDesign) {
        const builtD = composer.perDesign.find((x) => x.designKey === d.designKey)!
        expect(d.value).toBe(builtD.value)
        expect(d.hold).toBe(builtD.hold)
      }
    } finally {
      delete process.env.IH_WRITER
      delete process.env.IH_WRITER_DEADLINE_MS
      await close()
    }
  }, 40_000)
})
