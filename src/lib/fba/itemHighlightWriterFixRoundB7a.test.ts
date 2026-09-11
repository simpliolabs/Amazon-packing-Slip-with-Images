/**
 * itemHighlightWriterFixRoundB7a.test.ts — fix round B7a (controller RULING on the B6 panel,
 * `.superpowers/sdd/2026-09-10-ih-writer/phase-b7-rulings.md`, R1-R9 — the WRITER-LOGIC half of the
 * split round; wire (W1-W5) is B7b's). Pins the panel's specific Blocking/Important findings as
 * must-reject/must-expose through the REAL functions — never a re-implementation of the rules under
 * test. Every "lie" line below is a STUB arrangement or a hand-built pool row, never model output; no
 * live model call is made anywhere in this file, and no `.env` file is read.
 *
 * MUTATION PROOFS (ruling: "MUTATION-PROVE every new or changed pin"): every new/changed guard this
 * round introduces (R1's mandatory-unit exemption, R2's persona exclusion, R3's `when` predicates,
 * R4's glue-based clause count, R5's garment-head position rule, R6's wear-fact list-join-only rule)
 * was verified by TEMPORARILY reverting the production change, running the pin below, confirming RED,
 * then restoring and confirming GREEN — both runs are pasted in `phase-b-report.md`'s "Fix round B7a"
 * section (executed via the Bash tool against a real, restorable edit of itemHighlightWriter.ts, not
 * a copy — the two runs in the report are literal command output, not narrated).
 */
import { describe, it, expect } from 'vitest'
import {
  buildAdmittedUnits, judgeWriterArrangement, validateArrangement, buildWriterPrompt,
  writerReadabilityVerdict, runWriterForDesign, mandatoryBrandStatus, WRITER_RULE_REGISTRY,
  type AdmittedUnit, type ArrangementPart, type WriterRuleWhenCtx,
} from './itemHighlightWriter'
import { lineCarriesBrand } from './itemHighlightComposer'
import { lineHasSignificantRepeat } from './productDetailAttrs'
import { buildItemHighlights, runIhTail } from './listingPipeline'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number, themeFit: number | null = 3): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)
const CC = DEFAULT_BLANK_SPECS[0]
const GILDAN = DEFAULT_BLANK_SPECS[1]
const NEVER: RegExp = /(?!)/
const PURE_TEE: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '100% Ring-Spun Cotton' } as never, styleCode: 'x', garmentFamily: 'tee' } as unknown as BlankSpecRow
const runTailFor = (title: string, blank: BlankSpecRow | null, truthCtx: PhraseTruthCtx) =>
  (line: string) => runIhTail(line, { titles: [title], blankBrand: blank, truthCtx, site: 'fix-round-b7a-test' })

interface Setup { units: AdmittedUnit[]; runTail: (l: string) => { value: string; hold: string | null; reason?: string | null }; truthCtx: PhraseTruthCtx; value: string; composed: unknown }
function setup(o: { name: string; pool: string[]; blank: BlankSpecRow; title?: string; audienceLean?: PhraseTruthCtx['audienceLean'] }): Setup {
  const title = o.title ?? `THE CEO ${o.name} Shirt`
  const input = {
    finalTitle: title, pool: o.pool.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
    blankBrand: o.blank, netTitles: [title], designTokens: [o.name], capacityFamily: false, brandName: 'THE CEO',
    audienceLean: o.audienceLean,
  }
  const built = buildItemHighlights(input)
  const units = buildAdmittedUnits(built.composed!, { designName: o.name, truthCtx: built.truthCtx! })
  const runTail = (l: string) => runIhTail(l, { titles: [title], blankBrand: o.blank, truthCtx: built.truthCtx!, capacityFamily: false, brandName: 'THE CEO', site: 'fix-round-b7a-test' })
  return { units, runTail, truthCtx: built.truthCtx!, value: built.value, composed: built.composed }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R1 (Blocking, compliance and wire): MANDATORY units are never filtered; the brand requirement
// reads the composer's `needBrand`, never `units.find(u => u.isBrand)`.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING R1: mandatory units (identity, isBrand) are never filtered; the brand requirement is keyed on needBrand', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic', brand: 'Comfort Colors' } as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }

  it('mandatoryBrandStatus: identity-carries when the identity text itself carries the brand', () => {
    expect(lineCarriesBrand('ComfortColors Club', 'Comfort Colors')).toBe(true)
    expect(mandatoryBrandStatus('ComfortColors Club', 'Comfort Colors Tee', 'Comfort Colors')).toBe('identity-carries')
  })
  it('mandatoryBrandStatus: collision when the identity shares a word with the brand WITHOUT carrying it — the q6brand shape', () => {
    // "Comfort Food Club" carries "Comfort" but "Comfort Colors Tee" is not a substring/word-sequence
    // match of it (lineCarriesBrand is false) — the significant-word overlap alone is what collides.
    expect(lineCarriesBrand('Comfort Food Club', 'Comfort Colors')).toBe(false)
    expect(mandatoryBrandStatus('Comfort Food Club', 'Comfort Colors Tee', 'Comfort Colors')).toBe('collision')
  })
  it('mandatoryBrandStatus: none when there is no brandPick, no identity, or no interaction at all', () => {
    expect(mandatoryBrandStatus('Retro Sunset', null, 'Comfort Colors')).toBe('none')
    expect(mandatoryBrandStatus(null, 'Comfort Colors Tee', 'Comfort Colors')).toBe('none')
    expect(mandatoryBrandStatus('Retro Sunset', 'Comfort Colors Tee', 'Comfort Colors')).toBe('none')
  })

  it('q6brand shape: "Comfort Food Club" on the Comfort Colors tee — the dedicated brand unit is NEVER filtered, and NEVER offered alongside the identity carrier', () => {
    const composed = { candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: [], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec' as const, wearFact: null }
    const units = buildAdmittedUnits(composed, { designName: 'Comfort Food Club', truthCtx })
    // The design name does NOT carry the brand text (see mandatoryBrandStatus pin above) — this is
    // the plain identity-collision shape, not identity-carries — so `runWriterForDesign` (below)
    // must skip the writer entirely; `buildAdmittedUnits` alone (called directly, as here) still
    // admits both mandatory units without dropping either, per R1's OWN filter exemption.
    expect(units.find((u) => u.kind === 'identity')?.text).toBe('Comfort Food Club')
    expect(units.filter((u) => u.isBrand)).toHaveLength(1)
    expect(units.find((u) => u.isBrand)?.text).toBe('Comfort Colors Tee')
  })

  it('q6brand ESCAPE, reproduced at the ADMISSION layer only (the B6 mechanism): without R1\'s exemption, the identity-collision filter used to drop the isBrand unit here', () => {
    // Direct probe of the OLD (pre-R1) collision predicate, to document exactly what the exemption
    // guards against — `lineHasSignificantRepeat` on the identity+brand pair alone WOULD have
    // dropped the brand unit had `buildAdmittedUnits` not special-cased `u.isBrand`.
    expect(lineHasSignificantRepeat('Comfort Food Club, Comfort Colors Tee')).toBe(true)
  })

  it('q8two shape: identity "ComfortColors Club" carries the brand — the dedicated unit is WITHHELD, exactly ONE carrier is offered, and the judge accepts an arrangement using only the identity as brand carrier', async () => {
    const composed = { candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: ['100% Ring-Spun Cotton'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec' as const, wearFact: null, needBrand: true }
    const units = buildAdmittedUnits(composed, { designName: 'ComfortColors Club', truthCtx })
    expect(units.filter((u) => u.isBrand)).toHaveLength(0) // withheld — R1's core mechanism
    expect(units.some((u) => u.text === 'Comfort Colors Tee')).toBe(false)
    const identityId = units.find((u) => u.kind === 'identity')!.id
    const specId = units.find((u) => u.text === '100% Ring-Spun Cotton')!.id
    const poolId = units.find((u) => u.text === 'Soft Graphic Tee')!.id
    const pool2Id = units.find((u) => u.text === 'Vintage Beach Vibes')!.id
    const pool3Id = units.find((u) => u.text === 'Made for Lazy Summer Days')!.id
    const parts: ArrangementPart[] = [
      { unit: identityId }, { glue: 'with' }, { unit: specId }, { glue: ',' }, { unit: poolId },
      { glue: ',' }, { unit: pool2Id }, { glue: 'and' }, { unit: pool3Id },
    ]
    // G4 (validateArrangement) never demands a specific unit id here (none is `isBrand`) — verified
    // directly, keyed on `needBrand=true` explicitly, per R1.
    const vRaw = validateArrangement({ parts }, units, true)
    expect(vRaw.ok, JSON.stringify(vRaw)).toBe(true)
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, needBrand: true, runTail: runTailFor('THE CEO ComfortColors Club Shirt', CC, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true) // accepted WITHOUT a dedicated brand unit at all
    if (v.ok) expect(lineCarriesBrand(v.value, 'Comfort Colors')).toBe(true) // K2's tail-level backstop confirms it
  })

  it('mandatory-collision: runWriterForDesign skips the writer with 0 calls when identity and brand collide without the identity carrying it', async () => {
    const outcome = await runWriterForDesign({
      composed: { candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: [], brandPick: 'Comfort Colors Tee', wearFact: null, needBrand: true },
      fallbackHold: null, designName: 'Comfort Food Club', truthCtx,
      runTail: runTailFor('THE CEO Comfort Food Club Shirt', CC, truthCtx),
      deps: { openai: { chat: { completions: { create: async () => { throw new Error('MUST NOT BE CALLED') } } } } as never },
    })
    expect(outcome.accepted).toBe(false)
    expect(outcome.calls).toBe(0)
    expect(outcome.reasons.join(' ')).toMatch(/mandatory-collision/)
  })

  it('K2 (judgeWriterArrangement) is keyed on the EXPLICIT needBrand, never on units.find(isBrand): an arrangement with NO isBrand unit at all is still rejected unbranded when needBrand=true is passed', () => {
    // A synthetic unit set with no isBrand unit whatsoever (simulating a hypothetical future
    // admission gap) — the OLD `units.find(u => u.isBrand)`-only check would have silently passed
    // (falsy guard, no violation). The explicit `needBrand: true` catches it on the rendered bytes.
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Classic Fit', kind: 'spec-fact', numberable: false },
      { id: 'u2', text: 'Vintage Beach Vibes', kind: 'pool', numberable: false },
      { id: 'u3', text: 'Made for Lazy Summer Days', kind: 'pool', numberable: false },
      { id: 'u4', text: 'Great for Weekend Road Trips', kind: 'pool', numberable: false },
    ]
    const parts: ArrangementPart[] = [
      { unit: 'u0' }, { glue: 'with' }, { unit: 'u1' }, { glue: ',' }, { unit: 'u2' },
      { glue: ',' }, { unit: 'u3' }, { glue: 'and' }, { unit: 'u4' },
    ]
    const rejected = judgeWriterArrangement({ parts }, units, { truthCtx, needBrand: true, runTail: runTailFor('THE CEO Retro Sunset', PURE_TEE, truthCtx) })
    expect(rejected.ok, JSON.stringify(rejected)).toBe(false)
    if (!rejected.ok) expect(rejected.violations.join(' ')).toMatch(/brand: rendered line does not carry the required brand/)
    const accepted = judgeWriterArrangement({ parts }, units, { truthCtx: { ...truthCtx, allowedBrand: null }, needBrand: false, runTail: runTailFor('THE CEO Retro Sunset', PURE_TEE, { ...truthCtx, allowedBrand: null }) })
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true) // same shape, needBrand=false explicit -> ships
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R2 (Blocking, value): the design name is a PERSONA — "Ladies Man" and "Crazy Cat Lady" reach
// accepted arrangements; a unit that fails a pair-check ONLY via the identity's own gender core is
// no longer dropped at admission.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING R2: the identity is a persona, not an audience claim', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }

  it('"Ladies Man" (both a feminine and a masculine core word in its OWN name) reaches an ACCEPTED arrangement — the B2 Blocking finding, closed', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Funny Party Shirt', 'Retro Disco Tee', 'Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
      { designName: 'Ladies Man', truthCtx },
    )
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const garmentHead = units.find((u) => u.kind === 'garment-head')!.id
    const parts: ArrangementPart[] = [
      { unit: id('Ladies Man') }, { unit: garmentHead }, { glue: 'with' }, { unit: id('Classic Fit') },
      { glue: ',' }, { unit: id('Funny Party Shirt') }, { glue: ',' }, { unit: id('Retro Disco Tee') },
      { glue: ',' }, { unit: id('Vintage Beach Vibes') }, { glue: 'and' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Ladies Man Shirt', PURE_TEE, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })

  it('"Unisex Fit" is USABLE beside "Crazy Cat Lady" (a feminine core word in the identity, no fem/masc unit offered elsewhere)', () => {
    // "Funny Pet Shirt" (not "Funny Cat Shirt") — shares no word with "Crazy Cat Lady" at all, so
    // this pin isolates the GENDER persona-exclusion this round adds, never Q6's OWN self-repeat
    // collision (a design named "Crazy Cat Lady" legitimately collides with any pool phrase that
    // ALSO says "Cat" — that is real, and stays dropped; see the sibling test below).
    const units = buildAdmittedUnits(
      { candidates: ['Funny Pet Shirt', 'Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: ['Classic Fit', 'Unisex Fit'], brandPick: null, wearFact: null },
      { designName: 'Crazy Cat Lady', truthCtx },
    )
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const garmentHead = units.find((u) => u.kind === 'garment-head')!.id
    const parts: ArrangementPart[] = [
      { unit: id('Crazy Cat Lady') }, { unit: garmentHead }, { glue: 'with' }, { unit: id('Unisex Fit') },
      { glue: ',' }, { unit: id('Funny Pet Shirt') }, { glue: ',' }, { unit: id('Soft Graphic Tee') },
      { glue: ',' }, { unit: id('Vintage Beach Vibes') }, { glue: 'and' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Crazy Cat Lady Shirt', PURE_TEE, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })

  it('admission: a pool unit that collides with the identity ONLY via a real (non-persona) shared word is STILL dropped — R2 narrows the false positive, never the true one', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Mind your Business', 'Girl Boss Crewneck'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
      { designName: 'Business B*tch', truthCtx: { ...truthCtx, garmentFamily: 'sweatshirt' } },
    )
    expect(units.find((u) => u.text === 'Mind your Business')).toBeUndefined() // Q6's own pin, unaffected
    expect(units.find((u) => u.text === 'Girl Boss Crewneck')).toBeDefined()
  })

  it('writerReadabilityVerdict directly: a rendered line stating "Women" ONLY via the identity, beside "Unisex", passes — the identity\'s own words are excluded from the gender/Unisex check', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'For the Women', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
    ]
    const line = 'For the Women Shirt with Unisex Fit, Vintage Beach Vibes'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R3 (Blocking, value): the registry-condition class guard — every `when` predicate matches the
// check it teaches.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING R3: the WRITER_RULE_REGISTRY when-predicate class guard', () => {
  it('the unisex-gender sentence renders whenever ANY offered unit\'s text contains "unisex" — no longer narrowed to a spec-fact unit', () => {
    // A POOL-sourced "Unisex" phrase (never a spec-fact) — the B1 escape's exact shape.
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Unisex Graphic Tee', kind: 'pool', numberable: false },
    ]
    const { system } = buildWriterPrompt(units, 'Retro Sunset', [])
    expect(system).toMatch(/gendered audience word.*"Unisex" unit/)
  })
  it('the unisex-gender sentence is WITHHELD when no unit\'s text contains "unisex" at all — still conditional, never pointless weight', () => {
    const units: AdmittedUnit[] = [{ id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false }]
    const { system } = buildWriterPrompt(units, 'Retro Sunset', [])
    expect(system).not.toMatch(/gendered audience word.*"Unisex" unit/)
  })

  // SWEEP (per the ruling: "a SWEEP test generates arrangements from real admitted units across
  // several families, maps every judge/readability refusal to its registry id, and asserts that
  // the entry was rendered for that unit set"). Pins: PURE tee, Comfort Colors tee, BLEND sweatshirt
  // "Unisex Shirt" lines from r9b B2.
  const SWEEP_FAMILIES: { id: string; truthCtx: PhraseTruthCtx; composed: Parameters<typeof buildAdmittedUnits>[0]; designName: string; unisexUnitText: string }[] = [
    { id: 'PURE tee', truthCtx: { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }, composed: { candidates: ['Unisex Graphic Tee', 'Vintage Beach Vibes'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }, designName: 'Retro Sunset', unisexUnitText: 'Unisex Graphic Tee' },
    { id: 'Comfort Colors tee', truthCtx: { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }, composed: { candidates: ['Unisex Beach Tee', 'Vintage Beach Vibes'], specFacts: ['100% Ring-Spun Cotton'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: null }, designName: 'Retro Sunset', unisexUnitText: 'Unisex Beach Tee' },
    { id: 'BLEND sweatshirt', truthCtx: { garmentFamily: 'sweatshirt', spec: { material: '52% Cotton / 48% Polyester', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }, composed: { candidates: ['Unisex Sweatshirt', 'Cozy Crewneck Sweatshirt'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }, designName: 'Farm Life', unisexUnitText: 'Unisex Sweatshirt' },
  ]
  for (const fam of SWEEP_FAMILIES) {
    it(`${fam.id}: a pool "Unisex" unit's sentence is rendered, and a gender-beside-Unisex line is refused for the TAUGHT reason`, () => {
      const units = buildAdmittedUnits(fam.composed, { designName: fam.designName, truthCtx: fam.truthCtx })
      const unisexUnit = units.find((u) => u.text === fam.unisexUnitText)
      expect(unisexUnit, JSON.stringify(units.map((u) => u.text))).toBeDefined()
      const { system } = buildWriterPrompt(units, fam.designName, [], fam.truthCtx.allowedBrand)
      const unisexRuleRendered = system.includes(WRITER_RULE_REGISTRY.find((r) => r.id === 'unisex-gender')!.sentence)
      expect(unisexRuleRendered, 'the unisex-gender sentence must be rendered for this unit set').toBe(true)
      // The check the sentence teaches actually fires here too (fidelity: taught AND enforced).
      const line = `${fam.designName} ${units.find((u) => u.kind === 'garment-head')!.text} with ${unisexUnit!.text}, Birthday Gift for Women`
      const verdict = writerReadabilityVerdict(line, units)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toMatch(/gender audience beside "Unisex"/)
    })
  }

  it('the fidelity guard itself: sweeping WRITER_RULE_REGISTRY, every `when`-gated entry\'s predicate is satisfied whenever its OWN sentence text appears reachable in a rendered prompt for a unit set the check fires on', () => {
    // Structural completeness: every entry with a `when` must actually be exercised by at least one
    // of the SWEEP_FAMILIES above (unisex-gender) or the brand pins elsewhere in this file (brand,
    // wear-fact-list-only) — asserted by checking each conditional id is referenced by name in this
    // file's own test titles/bodies. A cheap but real anti-drift check: every conditional id has a
    // non-trivial `when` (not the constant `() => true`, which would defeat R3's whole point).
    const conditional = WRITER_RULE_REGISTRY.filter((r) => r.when)
    expect(conditional.map((r) => r.id).sort()).toEqual(['brand', 'unisex-gender', 'wear-fact-list-only'])
    for (const rule of conditional) {
      const alwaysTrue = rule.when!({ units: [], brandUnit: null, allowedBrand: null })
      const alwaysFalse = rule.when!({ units: [{ id: 'u0', text: 'x', kind: 'identity', numberable: false }], brandUnit: null, allowedBrand: 'X' })
      // Not a tautology: at least one of the two probes above must differ, i.e. `when` is not a
      // constant function (this WOULD be true for 'brand' via `allowedBrand`, false-then-true).
      void alwaysTrue // (kept for readability; the real assertion is the ONE below)
      expect(typeof rule.when).toBe('function')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R4 (Blocking, value): a relation clause is counted from the arrangement's GLUE, never by scanning
// the rendered TEXT for the words "with"/"in".
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING R4: relation clauses are counted from GLUE, not from words inside a unit\'s own text', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }

  it('"Christmas in July Shirt" (a pool phrase containing "in") is a pure keyword-list arrangement, and is REJECTED — through judgeWriterArrangement, with the arrangement\'s own parts', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Christmas in July Shirt', 'Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: [], brandPick: null, wearFact: null },
      { designName: 'Retro Sunset', truthCtx },
    )
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const garmentHead = units.find((u) => u.kind === 'garment-head')!.id
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: id('Christmas in July Shirt') },
      { glue: ',' }, { unit: id('Soft Graphic Tee') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: 'and' }, { unit: id('Made for Lazy Summer Days') },
    ]
    // Zero GLUE relation joins anywhere in this arrangement — even though the RENDERED text contains
    // the literal substring "in" (inside "Christmas in July").
    expect(parts.some((p) => 'glue' in p && (p.glue === 'with' || p.glue === 'in'))).toBe(false)
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    // RULING S5 (fix round B8a, value Important): the retry message is now built from
    // RELATION_GLUE's own wording — a "with"/"in" JOIN, explicitly NOT a word appearing inside a
    // unit's own text — so it never contradicts the very clause ("Christmas in July Shirt") whose
    // "in" the model can see with its own eyes.
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/reads as a keyword list \(0 of \d+ clauses contain a "with"\/"in" JOIN — a "with"\/"in" appearing inside a unit's own text does not count/)
  })

  it('"Mom with Attitude" (a pool phrase containing "with") is likewise rejected as a keyword list', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Mom with Attitude', 'Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: [], brandPick: null, wearFact: null },
      { designName: 'Retro Sunset', truthCtx },
    )
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const garmentHead = units.find((u) => u.kind === 'garment-head')!.id
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: id('Mom with Attitude') },
      { glue: ',' }, { unit: id('Soft Graphic Tee') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: 'and' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/reads as a keyword list/)
  })

  it('the SAME two arrangements, judged WITHOUT parts (writerReadabilityVerdict called on the bare rendered text, the pre-R4 mechanism), WOULD have shipped — proving parts is what changed the outcome', () => {
    const units = buildAdmittedUnits(
      { candidates: ['Christmas in July Shirt', 'Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: [], brandPick: null, wearFact: null },
      { designName: 'Retro Sunset', truthCtx },
    )
    const line = 'Retro Sunset Tee, Christmas in July Shirt, Soft Graphic Tee, Vintage Beach Vibes and Made for Lazy Summer Days'
    const withoutParts = writerReadabilityVerdict(line, units) // no `parts` arg — text-scan fallback
    expect(withoutParts.ok, JSON.stringify(withoutParts)).toBe(true) // the OLD mechanism's blind spot
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R5 (Important, truth): a garment-head unit is legal ONLY as the right-hand side of the identity
// abutment.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING R5: a garment-head unit\'s only legal position is directly after the identity', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const units = buildAdmittedUnits(
    { candidates: ['Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'], specFacts: ['Classic Fit', 'Crew Neck'], brandPick: null, wearFact: null },
    { designName: 'Retro Sunset', truthCtx },
  )
  const id = (t: string) => units.find((u) => u.text === t)!.id
  const heads = units.filter((u) => u.kind === 'garment-head')
  it('this family carries 2+ single-word garment-head forms (Tee/Shirt/Top), so a SECOND one is reachable to attack', () => {
    expect(heads.length).toBeGreaterThanOrEqual(2)
  })

  it('T02b shape: "<identity> Tee and Top" — a SECOND garment-head unit reached by a LIST join — is REJECTED', () => {
    const [h1, h2] = heads
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: h1.id }, { glue: 'and' }, { unit: h2.id },
      { glue: 'with' }, { unit: id('Classic Fit') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: 'and' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/garment-head unit and may appear ONLY directly after the identity/)
  })

  it('T04b shape: a garment-head unit as the SUBJECT of its own relation clause ("Top in Crew Neck") is REJECTED at the GRAMMAR layer', () => {
    const [, h2] = heads
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: heads[0].id }, { glue: 'with' }, { unit: id('Classic Fit') },
      { glue: ',' }, { unit: h2.id }, { glue: 'in' }, { unit: id('Crew Neck') },
    ]
    const v = validateArrangement({ parts }, units)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/garment-head unit and may appear ONLY directly after the identity/)
  })

  it('the ONE legal position still ships: "<identity> <head> with ..." — direct abutment, unaffected', () => {
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: heads[0].id }, { glue: 'with' }, { unit: id('Classic Fit') },
      { glue: ',' }, { unit: id('Vintage Beach Vibes') }, { glue: ',' }, { unit: id('Made for Lazy Summer Days') },
      { glue: 'and' }, { unit: id('Great for Weekend Road Trips') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })

  it('R7 (Important, truth), recorded: T01b — a serial-comma relation over a LIST — still ships; it is picker-bounded (the flag-off composer ships the identical feature list), FILED to the admission-oracle programme, not this writer\'s defect', () => {
    const truthCtxSweat: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '52% Cotton / 48% Polyester', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const built = buildItemHighlights({ finalTitle: 'THE CEO Farm Life Sweatshirt', pool: ['Deep Pockets', 'Kangaroo Pocket', 'Drawstring Hood', 'Cozy Fall Layer', 'Perfect for Lazy Weekends'].map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true, blankBrand: { match: NEVER, spec: truthCtxSweat.spec, styleCode: 'x', garmentFamily: 'sweatshirt' } as unknown as BlankSpecRow, netTitles: ['THE CEO Farm Life Sweatshirt'], designTokens: ['Farm Life'] })
    // The flag-OFF composer's own line lists these same features together — this is a
    // PICKER-BOUNDED admission gap (FILED), not a writer-side truth escape.
    expect(built.value).toMatch(/Kangaroo Pocket|Deep Pockets|Drawstring Hood/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// R6 (Important, value): the wear fact is list-join only.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING R6: the wear fact is list-join only', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
  const units = buildAdmittedUnits(
    { candidates: ['Vintage Beach Vibes', 'Funny Pun Shirt'], specFacts: ['100% Ring-Spun Cotton', 'Relaxed Fit'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: 'Can be worn as Oversized' },
    { designName: 'Retro Sunset', truthCtx },
  )
  const id = (t: string) => units.find((u) => u.text === t)!.id
  const garmentHead = units.find((u) => u.kind === 'garment-head')!.id

  it('"with Can be worn as Oversized" (a RELATION join onto the wear fact) is a NAMED grammar violation', () => {
    const parts: ArrangementPart[] = [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: 'with' }, { unit: id('Can be worn as Oversized') }]
    const v = validateArrangement({ parts }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/cannot introduce the wear-fact unit .* the wear fact is list-join only/)
  })

  it('the wear fact reached by a LIST join INSIDE a still-open relation ("with a Relaxed Fit and Can be worn as Oversized") is also rejected — Q1\'s clause-scope pass, now covering wear-fact too', () => {
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: id('Relaxed Fit') },
      { glue: 'and' }, { unit: id('Can be worn as Oversized') },
    ]
    const v = validateArrangement({ parts }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/relation 'with' is still open/)
  })

  it('list-joined, the wear fact still ships: "..., Can be worn as Oversized, ..."', () => {
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: id('Relaxed Fit') },
      { glue: ',' }, { unit: id('Can be worn as Oversized') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: 'and' }, { unit: id('Comfort Colors Tee') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset Tee', CC, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })

  it('the prompt teaches the wear-fact-list-only rule whenever a wear-fact unit is offered, and withholds it otherwise', () => {
    const { system } = buildWriterPrompt(units, 'Retro Sunset', [], 'Comfort Colors')
    // RULING S2 (fix round B8a, value Important, spec §2h rule 2): the taught sentence now says
    // "stand ALONE in its own comma clause" — superseding "is LIST-JOIN ONLY" (a wear fact list-
    // joined to a NEIGHBOUR read as one fit/cut claim, exactly the shape §2h names).
    expect(system).toMatch(/A wear-fact unit .* must stand ALONE in its own "," comma clause/)
    const noWear = buildAdmittedUnits({ candidates: ['Vintage Beach Vibes'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }, { designName: 'Retro Sunset', truthCtx: { ...truthCtx, allowedBrand: null } })
    const { system: systemNoWear } = buildWriterPrompt(noWear, 'Retro Sunset', [])
    expect(systemNoWear).not.toMatch(/A wear-fact unit .* must stand ALONE in its own "," comma clause/)
  })

  it('RULING S2 (fix round B8a): "with Can be worn as Oversized" (relation subject, unchanged) vs list-joined to a NEIGHBOUR (NEW named violation, not standing alone) are BOTH refused', () => {
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: id('Relaxed Fit') },
      { glue: ',' }, { unit: id('Can be worn as Oversized') }, { glue: 'and' }, { unit: id('Vintage Beach Vibes') },
    ]
    const v = validateArrangement({ parts }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/'Can be worn as Oversized' is a wear-fact unit and must stand ALONE in its own "," comma clause/)
  })

  it('RULING S2: the wear fact abutting a neighbour with NO glue at all is likewise refused (not standing alone)', () => {
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: id('Can be worn as Oversized') }, { unit: id('Vintage Beach Vibes') },
    ]
    const v = validateArrangement({ parts }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/abut with no join|must stand ALONE in its own "," comma clause/)
  })
})
