/**
 * itemHighlightWriterFixRoundB8a.test.ts — fix round B8a (controller RULING on the B7 panel,
 * `.superpowers/sdd/2026-09-10-ih-writer/phase-b8-rulings.md`, S1-S9 — the WRITER-LOGIC-AND-REPORT
 * half of the split round; the wire half (V1, module-boundary AST rebuild) is B8b's and is NOT
 * touched here). Every "lie" line below is a STUB arrangement or a hand-built pool row, never model
 * output; no live model call is made anywhere in this file, and no `.env` file is read.
 *
 * MUTATION PROOFS: every new or changed pin this round introduces (S1's identity-gated garment-head
 * admission, S2's wear-fact-stands-alone grammar rule, S4's admission pair pin, S6's produce*-path
 * brand pins, S7's REAL T01b judge pin) was verified by TEMPORARILY reverting the guarded production
 * change in a SCRATCH COPY (never the worktree file itself), running the pin below against that copy
 * through a vite alias, confirming RED, then discarding the copy and confirming the SAME pin GREEN
 * against the real worktree file — both runs are pasted in `phase-b-report.md`'s "Fix round B8a"
 * section as literal command output.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildAdmittedUnits, judgeWriterArrangement, validateArrangement, buildWriterPrompt,
  writerReadabilityVerdict, runWriterForDesign, mandatoryBrandStatus, WRITER_RULE_REGISTRY,
  type AdmittedUnit, type ArrangementPart,
} from './itemHighlightWriter'
import { lineCarriesBrand } from './itemHighlightComposer'
import { buildItemHighlights, buildItemHighlightsPerDesign, produceItemHighlights, produceItemHighlightsPerDesign, runIhTail } from './listingPipeline'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number, themeFit: number | null = 3): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)
const kwFor = (keyword: string, searchVolume: number, keys: readonly string[]): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit: 3, themeFitByDesign: Object.fromEntries(keys.map((k) => [k, { fit: 3 }])) } as unknown as AnalyzedKeyword)
const CC = DEFAULT_BLANK_SPECS[0]
const NEVER: RegExp = /(?!)/
const PURE_TEE: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '100% Ring-Spun Cotton' } as never, styleCode: 'x', garmentFamily: 'tee' } as unknown as BlankSpecRow
const CC_SWEATSHIRT: BlankSpecRow = { match: NEVER, spec: { ...(CC.spec as object), fit: 'Classic' } as never, styleCode: 'x', garmentFamily: 'sweatshirt' } as unknown as BlankSpecRow
const runTailFor = (title: string, blank: BlankSpecRow | null, truthCtx: PhraseTruthCtx) =>
  (line: string) => runIhTail(line, { titles: [title], blankBrand: blank, truthCtx, site: 'fix-round-b8a-test' })

interface Setup { units: AdmittedUnit[]; runTail: (l: string) => { value: string; hold: string | null; reason?: string | null }; truthCtx: PhraseTruthCtx; value: string; composed: unknown }
function setup(o: { name: string | null; pool: string[]; blank: BlankSpecRow | null; title?: string; audienceLean?: PhraseTruthCtx['audienceLean'] }): Setup {
  const title = o.title ?? `THE CEO ${o.name ?? 'X'} Shirt`
  const input = {
    finalTitle: title, pool: o.pool.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
    blankBrand: o.blank, netTitles: [title], designTokens: o.name ? [o.name] : [], capacityFamily: false, brandName: 'THE CEO',
    audienceLean: o.audienceLean,
  }
  const built = buildItemHighlights(input)
  const units = buildAdmittedUnits(built.composed!, { designName: o.name, truthCtx: built.truthCtx! })
  const runTail = (l: string) => runIhTail(l, { titles: [title], blankBrand: o.blank, truthCtx: built.truthCtx!, capacityFamily: false, brandName: 'THE CEO', site: 'fix-round-b8a-test' })
  return { units, runTail, truthCtx: built.truthCtx!, value: built.value, composed: built.composed }
}

/** A stub OpenAI-shaped client whose `create()` ignores the prompt and always returns the SAME
 *  pre-computed arrangement (or `{}` when none is supplied) — used wherever this file needs a
 *  DETERMINISTIC writer draft without depending on prompt parsing. Records every call's message
 *  pair for inspection (`calls`). */
function stubClient(arrangement: { parts: ArrangementPart[] } | null) {
  const calls: { system: string; user: string }[] = []
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async (req: { messages: { role: string; content: string }[] }) => {
            const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
            const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
            calls.push({ system, user })
            return { choices: [{ message: { role: 'assistant', content: JSON.stringify(arrangement ?? {}) }, finish_reason: 'stop' }] }
          },
        },
      },
    } as never,
  }
}

/** Builds a generically-valid arrangement out of REAL admitted units: identity + garment-head
 *  (abutment, if both exist), ONE relation clause with a spec-fact (with article if fit/neck-
 *  shaped), then every remaining unit list-joined — the brand unit included, the wear fact ALONE
 *  in its own trailing clause. Not guaranteed to land in the character band (irrelevant to every
 *  caller below, which accepts EITHER an accepted, correctly-branded line OR a byte-identical
 *  fallback to the composer). */
function autoArrange(units: readonly AdmittedUnit[]): { parts: ArrangementPart[] } | null {
  const identity = units.find((u) => u.kind === 'identity')
  const head = units.find((u) => u.kind === 'garment-head')
  const brand = units.find((u) => u.isBrand)
  const wear = units.find((u) => u.kind === 'wear-fact')
  const relSpec = units.find((u) => u.kind === 'spec-fact')
  const parts: ArrangementPart[] = []
  if (identity) parts.push({ unit: identity.id })
  if (identity && head) parts.push({ unit: head.id })
  if (relSpec) {
    parts.push({ glue: 'with' })
    if (/\b(fit|neck)$/i.test(relSpec.text)) parts.push({ glue: 'a' })
    parts.push({ unit: relSpec.id })
  }
  const tail = [
    ...units.filter((u) => u.kind === 'spec-fact' && u.id !== relSpec?.id),
    ...units.filter((u) => u.kind === 'pool' && !u.isBrand),
    ...(brand ? [brand] : []),
  ]
  for (const u of tail) { parts.push({ glue: ',' }); parts.push({ unit: u.id }) }
  if (wear) { parts.push({ glue: ',' }); parts.push({ unit: wear.id }) }
  if (parts.length === 0 || !('unit' in parts[0])) return null // no identity, nothing legal to lead with here
  return { parts }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S1 (Blocking, value): a garment-head unit is offered ONLY when an identity unit was admitted.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S1: a garment-head unit is offered only when an identity unit was admitted', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: PURE_TEE.spec as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const composed = { candidates: ['Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }

  it('designName null: NO garment-head unit is admitted', () => {
    const units = buildAdmittedUnits(composed, { designName: null, truthCtx })
    expect(units.find((u) => u.kind === 'identity')).toBeUndefined()
    expect(units.filter((u) => u.kind === 'garment-head')).toHaveLength(0)
  })

  it('a trademark-dropped identity ("Disney Squad"): NO garment-head unit is admitted, logged no-identity-anchor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const units = buildAdmittedUnits(composed, { designName: 'Disney Squad', truthCtx })
      expect(units.find((u) => u.kind === 'identity')).toBeUndefined()
      expect(units.filter((u) => u.kind === 'garment-head')).toHaveLength(0)
      const dropLogs = warn.mock.calls.map((c) => c[0] as string).filter((s) => s.includes('IH_WRITER_UNIT_DROPPED') && s.includes('no-identity-anchor'))
      expect(dropLogs.length, JSON.stringify(warn.mock.calls)).toBeGreaterThanOrEqual(3) // Shirt, Tee, Top
      for (const head of ['Shirt', 'Tee', 'Top']) {
        expect(dropLogs.some((s) => s.includes(`"phrase":"${head}"`))).toBe(true)
      }
    } finally { warn.mockRestore() }
  })

  it('an untrue-dropped identity ("Oversized Vibes", a fit claim a Classic-fit blank does not back): NO garment-head unit is admitted', () => {
    const units = buildAdmittedUnits(composed, { designName: 'Oversized Vibes', truthCtx })
    expect(units.find((u) => u.kind === 'identity')).toBeUndefined()
    expect(units.filter((u) => u.kind === 'garment-head')).toHaveLength(0)
  })

  it('CONTROL: an admitted identity ("Retro Sunset") DOES get garment-head units', () => {
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    expect(units.find((u) => u.kind === 'identity')).toBeDefined()
    expect(units.filter((u) => u.kind === 'garment-head').length).toBeGreaterThan(0)
  })

  // The r10b CENSUS (reproduced against HEAD 4489eb6 before any edit — see
  // `.../scratchpad/writer/repro/1-r10b-census.out.txt`): for each no-identity family, sweep every
  // structurally distinct position a garment-head unit could occupy (abutment lead, list-joined
  // front/middle/end of the tail clause, bare lead) across every permutation of the pool, through
  // the REAL judge — assert NO accepted arrangement ever uses one; the CONTROL must show the
  // opposite (a head unit IS reachable there).
  function permutations<T>(arr: readonly T[]): T[][] {
    if (arr.length <= 1) return [[...arr]]
    const out: T[][] = []
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
      for (const p of permutations(rest)) out.push([arr[i], ...p])
    }
    return out
  }
  function censusShapes(units: readonly AdmittedUnit[], identity: AdmittedUnit | null, head: AdmittedUnit, spec: AdmittedUnit, poolPerm: AdmittedUnit[]): ArrangementPart[][] {
    const lead: ArrangementPart[] = identity ? [{ unit: identity.id }] : []
    const shapes: ArrangementPart[][] = []
    { const p: ArrangementPart[] = [...lead, { glue: 'with' }, { unit: spec.id }]; poolPerm.forEach((u, i) => { p.push({ glue: i === poolPerm.length - 1 && poolPerm.length > 1 ? 'and' : ',' }); p.push({ unit: u.id }) }); shapes.push(p) }
    if (identity) { const p: ArrangementPart[] = [{ unit: identity.id }, { unit: head.id }, { glue: 'with' }, { unit: spec.id }]; poolPerm.forEach((u, i) => { p.push({ glue: i === poolPerm.length - 1 && poolPerm.length > 1 ? 'and' : ',' }); p.push({ unit: u.id }) }); shapes.push(p) }
    { const p: ArrangementPart[] = [...lead, { glue: 'with' }, { unit: spec.id }, { glue: ',' }, { unit: head.id }]; poolPerm.forEach((u) => { p.push({ glue: ',' }); p.push({ unit: u.id }) }); shapes.push(p) }
    { const p: ArrangementPart[] = [...lead, { glue: 'with' }, { unit: spec.id }]; poolPerm.forEach((u) => { p.push({ glue: ',' }); p.push({ unit: u.id }) }); p.push({ glue: 'and' }, { unit: head.id }); shapes.push(p) }
    if (!identity) { const p: ArrangementPart[] = [{ unit: head.id }, { glue: 'with' }, { unit: spec.id }]; poolPerm.forEach((u) => { p.push({ glue: ',' }); p.push({ unit: u.id }) }); shapes.push(p) }
    return shapes
  }
  function censusNeverUsesHead(designName: string | null): { anyAccepted: boolean; headEverAccepted: boolean } {
    const units = buildAdmittedUnits(composed, { designName, truthCtx })
    const identity = units.find((u) => u.kind === 'identity') ?? null
    const heads = units.filter((u) => u.kind === 'garment-head')
    const spec = units.find((u) => u.kind === 'spec-fact')!
    const pool = units.filter((u) => u.kind === 'pool')
    const runTail = runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, truthCtx)
    let anyAccepted = false, headEverAccepted = false
    for (const head of heads) {
      for (const poolPerm of permutations(pool)) {
        for (const parts of censusShapes(units, identity, head, spec, poolPerm)) {
          const usesHead = parts.some((p) => 'unit' in p && p.unit === head.id)
          const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail })
          if (v.ok) { anyAccepted = true; if (usesHead) headEverAccepted = true }
        }
      }
    }
    return { anyAccepted, headEverAccepted }
  }
  it('CENSUS: designName null / trademark-dropped / untrue-dropped — zero accepted arrangements ever carry a garment-head unit', () => {
    for (const name of [null, 'Disney Squad', 'Oversized Vibes']) {
      const { headEverAccepted } = censusNeverUsesHead(name)
      expect(headEverAccepted, `designName=${name}`).toBe(false)
    }
  })
  it('CENSUS CONTROL: with an admitted identity, a garment-head unit IS reachable in an accepted arrangement', () => {
    const { anyAccepted, headEverAccepted } = censusNeverUsesHead('Retro Sunset')
    expect(anyAccepted).toBe(true)
    expect(headEverAccepted).toBe(true)
  })

  // The prompt: no DESIGN NAME line, and no garment-head units in the ADMITTED UNITS json, when
  // no identity survives — folds in m2 ("a dropped identity is still sent as the DESIGN NAME").
  it('buildWriterPrompt: with NO identity unit admitted, the user message never mentions "DESIGN NAME"', () => {
    const units = buildAdmittedUnits(composed, { designName: 'Disney Squad', truthCtx })
    const { user } = buildWriterPrompt(units, 'Disney Squad', [])
    expect(user).not.toMatch(/DESIGN NAME/)
    expect(user).not.toMatch(/Disney Squad/)
  })
  it('buildWriterPrompt: WITH an identity unit admitted, the DESIGN NAME line IS sent, reproduced exactly', () => {
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    const { user } = buildWriterPrompt(units, 'Retro Sunset', [])
    expect(user).toMatch(/DESIGN NAME \(reproduce spelling EXACTLY.*"Retro Sunset"/)
  })

  // Through BOTH produce* paths: the writer never sends a headless-identity design's garment-head
  // group, and the composer's own line ships whenever the stub cannot legally use one (there is
  // none to use).
  it('produceItemHighlights (single-design path): designName null (no identityDesignName, no designTokens) — the composer\'s OWN line ships, and no garment-head is ever offered to the model', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const title = 'THE CEO Retro Sunset Shirt'
      const input = {
        finalTitle: title, pool: ['Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'].map((k, i) => kw(k, 5000 - i * 10)),
        apparelProduct: true, blankBrand: PURE_TEE, netTitles: [title], designTokens: [], capacityFamily: false,
      }
      const composerBaseline = buildItemHighlights(input)
      const { client, calls } = stubClient(null) // malformed draft -> exhausts retries -> falls back
      const result = await produceItemHighlights(input, { openai: client })
      expect(result.value).toBe(composerBaseline.value)
      expect(calls.length).toBeGreaterThan(0) // the writer DID run (eligible; identity-null alone is not a skip)
      for (const c of calls) {
        expect(c.user).not.toMatch(/DESIGN NAME/)
        expect(JSON.parse(c.user.match(/(\{"identity":.*\})/)?.[1] ?? '{}')['garment-head'] ?? []).toEqual([])
      }
    } finally { delete process.env.IH_WRITER }
  })

  it('produceItemHighlightsPerDesign: a design with an untrue-dropped identity — the composer\'s OWN line ships for THAT design, and it never sees a garment-head unit', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const keys = ['A', 'B']
      const pool = [
        kwFor('vintage beach vibes', 5000, keys), kwFor('made for lazy summer days', 4500, keys), kwFor('great for weekend road trips', 4000, keys),
      ]
      const groups = [
        { key: 'A', designName: 'Oversized Vibes', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Oversized Vibes Shirt'] },
        { key: 'B', designName: 'Retro Sunset', skus: [{ sku: 'B1', asin: 'B0B0000001' }], titles: ['THE CEO Retro Sunset Shirt'] },
      ]
      const input = { groups, pool, apparelProduct: true, blankBrand: PURE_TEE, familyTitleText: 'Family' }
      const composerBaseline = buildItemHighlightsPerDesign(input)
      const { client, calls } = stubClient(null)
      const result = await produceItemHighlightsPerDesign(input, { openai: client })
      const aRow = result.perDesign.find((d) => d.designKey === 'A')!
      const aBaseline = composerBaseline.perDesign.find((d) => d.designKey === 'A')!
      expect(aRow.value).toBe(aBaseline.value)
      const aCalls = calls // both designs share ONE client; filter by absence of "Retro Sunset" head offering is enough
      expect(aCalls.some((c) => c.user.includes('"Oversized Vibes"'))).toBe(false) // never sent as DESIGN NAME
    } finally { delete process.env.IH_WRITER }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S2 (Important, value): the wear fact stands ALONE in its own comma clause.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S2: the wear fact stands alone in its own comma clause', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
  const units = buildAdmittedUnits(
    { candidates: ['Vintage Beach Vibes', 'Funny Pun Shirt'], specFacts: ['100% Ring-Spun Cotton', 'Relaxed Fit'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: 'Can be worn as Oversized' },
    { designName: 'Retro Sunset', truthCtx },
  )
  const id = (t: string) => units.find((u) => u.text === t)!.id
  const garmentHead = units.find((u) => u.kind === 'garment-head')!.id

  for (const glue of ['and', '&', '—', '|'] as const) {
    it(`the wear fact list-joined to a NEIGHBOUR by "${glue}" (never a with/in subject) is a NAMED grammar violation`, () => {
      const parts: ArrangementPart[] = [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: id('Can be worn as Oversized') }, { glue }, { unit: id('Vintage Beach Vibes') }]
      const v = validateArrangement({ parts }, units)
      expect(v.ok, JSON.stringify(v)).toBe(false)
      if (!v.ok) expect(v.violation).toMatch(/is a wear-fact unit and must stand ALONE in its own "," comma clause/)
    })
    it(`the wear fact preceded by a NEIGHBOUR joined with "${glue}" (the wear fact on the RIGHT) is likewise refused`, () => {
      const parts: ArrangementPart[] = [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: id('Vintage Beach Vibes') }, { glue }, { unit: id('Can be worn as Oversized') }]
      const v = validateArrangement({ parts }, units)
      expect(v.ok, JSON.stringify(v)).toBe(false)
      if (!v.ok) expect(v.violation).toMatch(/is a wear-fact unit and must stand ALONE in its own "," comma clause/)
    })
  }

  it('POSITIVE: alone at the very START of the line (no preceding glue) still ships', () => {
    const parts: ArrangementPart[] = [
      { unit: id('Can be worn as Oversized') }, { glue: ',' }, { unit: id('Retro Sunset') }, { unit: garmentHead },
      { glue: 'with' }, { glue: 'a' }, { unit: id('Relaxed Fit') }, { glue: ',' }, { unit: id('Comfort Colors Tee') },
      { glue: ',' }, { unit: id('Vintage Beach Vibes') }, { glue: 'and' }, { unit: id('Funny Pun Shirt') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset Tee', CC, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
  it('POSITIVE: alone at the very END of the line still ships', () => {
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: 'with' }, { glue: 'a' }, { unit: id('Relaxed Fit') },
      { glue: ',' }, { unit: id('Comfort Colors Tee') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: 'and' }, { unit: id('Funny Pun Shirt') }, { glue: ',' }, { unit: id('Can be worn as Oversized') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset Tee', CC, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })

  // The re-measured wear shape set: EVERY grammar-legal draw that places the wear fact beside a
  // neighbour via and/&/—/| (the exact shapes review B7's I1 measured at 21.3% first-call, because
  // the OLD sentence invited them) must now be refused at CALL 1 by the GRAMMAR check, never
  // reaching the tail/span-truth layer at all.
  it('RE-MEASURE: every and/&/—/| neighbour-join shape on the wear fact is refused at the GRAMMAR layer (call 1), for both sides', () => {
    let checked = 0
    for (const glue of ['and', '&', '—', '|'] as const) {
      for (const side of ['before', 'after'] as const) {
        checked++
        const neighbour = id('Vintage Beach Vibes')
        const wear = id('Can be worn as Oversized')
        const parts: ArrangementPart[] = side === 'before'
          ? [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: neighbour }, { glue }, { unit: wear }]
          : [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: wear }, { glue }, { unit: neighbour }]
        const v = validateArrangement({ parts }, units)
        expect(v.ok, `${glue}/${side}: ${JSON.stringify(v)}`).toBe(false)
      }
    }
    expect(checked).toBe(8) // 4 glue tokens x 2 sides — the "should reach 100%" refusal set
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S3 (Important, value): the R3 sweep, built for real.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S3: the WRITER_RULE_REGISTRY when-predicate SWEEP, real families, real refusals', () => {
  interface SweepCase {
    id: string
    truthCtx: PhraseTruthCtx
    composed: Parameters<typeof buildAdmittedUnits>[0] & { needBrand?: boolean }
    designName: string
    expectedRuleId: string
    /** Builds a REAL violating arrangement from the ADMITTED units, and the expected refusal regex.
     *  `judgeUnits`, when given, overrides the units passed to the judge call ONLY (never the
     *  sentence-rendering check, which always reads the REAL admitted units) — used for the ONE
     *  case whose violation is a defense-in-depth check that admission itself already prevents by
     *  construction (see the allowedBrand-only case below). */
    attack: (units: AdmittedUnit[], truthCtx: PhraseTruthCtx) => { parts: ArrangementPart[]; expectRe: RegExp; judge: 'readability' | 'grammar'; judgeUnits?: AdmittedUnit[] }
  }
  const idOf = (units: readonly AdmittedUnit[], t: string) => units.find((u) => u.text === t)!.id
  const headOf = (units: readonly AdmittedUnit[]) => units.find((u) => u.kind === 'garment-head')!.id

  const CASES: SweepCase[] = [
    {
      id: 'PURE tee, LEADING "Unisex Graphic Tee" pool unit',
      truthCtx: { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' },
      composed: { candidates: ['Unisex Graphic Tee', 'Birthday Gift for Women', 'Great for Weekend Road Trips'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
      designName: 'Retro Sunset', expectedRuleId: 'unisex-gender',
      attack: (units, truthCtx) => ({
        parts: [{ unit: idOf(units, 'Retro Sunset') }, { unit: headOf(units) }, { glue: 'with' }, { unit: idOf(units, 'Classic Fit') }, { glue: ',' }, { unit: idOf(units, 'Unisex Graphic Tee') }, { glue: ',' }, { unit: idOf(units, 'Birthday Gift for Women') }, { glue: 'and' }, { unit: idOf(units, 'Great for Weekend Road Trips') }],
        expectRe: /gender audience beside "Unisex"/, judge: 'readability',
      }),
    },
    {
      // S3's own required MID-TEXT case: a Unisex pool phrase whose text does NOT start with
      // "unisex" — the exact case M2's narrowed `when` (`/^unisex\b/i`) turns this sweep RED on.
      id: 'PURE tee, MID-TEXT "Soft Unisex Tee" pool unit',
      truthCtx: { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' },
      composed: { candidates: ['Soft Unisex Tee', 'Birthday Gift for Women', 'Great for Weekend Road Trips'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
      designName: 'Retro Sunset', expectedRuleId: 'unisex-gender',
      attack: (units, truthCtx) => ({
        parts: [{ unit: idOf(units, 'Retro Sunset') }, { unit: headOf(units) }, { glue: 'with' }, { unit: idOf(units, 'Classic Fit') }, { glue: ',' }, { unit: idOf(units, 'Soft Unisex Tee') }, { glue: ',' }, { unit: idOf(units, 'Birthday Gift for Women') }, { glue: 'and' }, { unit: idOf(units, 'Great for Weekend Road Trips') }],
        expectRe: /gender audience beside "Unisex"/, judge: 'readability',
      }),
    },
    {
      // S3's own required allowedBrand-ONLY case: needBrand=false (no dedicated brand unit at
      // all), but `allowedBrand` is still set (the title already carries the brand) — the exact
      // case M3's narrowed `when` (`!!ctx.brandUnit` alone) turns this sweep RED on. The SENTENCE
      // check uses the REAL admitted units (buildAdmittedUnits keeps at most ONE unbranded carrier
      // by construction — R1's own admission-time defence). The JUDGE-level check this family
      // teaches (`judgeWriterArrangement`'s P1 "more than one carrier", defense in depth for a
      // FUTURE admission gap) is demonstrated on a hand-built unit set with two carriers, exactly
      // the shape B7a's own K2 pin uses for this class of edge case.
      id: 'Comfort Colors tee, allowedBrand-only (needBrand=false, no dedicated brand unit)',
      truthCtx: { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' },
      composed: { candidates: ['Comfort Colors Pocket Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: ['100% Ring-Spun Cotton'], brandPick: null, wearFact: null, needBrand: false },
      designName: 'Beach Days', expectedRuleId: 'brand',
      attack: () => ({
        parts: [{ unit: 'u0' }, { unit: 'u3' }, { glue: 'with' }, { unit: 'u1' }, { glue: ',' }, { unit: 'u2' }, { glue: 'and' }, { unit: 'u4' }],
        expectRe: /more than one unit carries the brand/, judge: 'readability', // caught by judgeWriterArrangement's own P1 check, not the grammar layer
        judgeUnits: [
          { id: 'u0', text: 'Beach Days', kind: 'identity' as const, numberable: false },
          { id: 'u1', text: '100% Ring-Spun Cotton', kind: 'spec-fact' as const, numberable: false },
          { id: 'u2', text: 'Comfort Colors Pocket Tee', kind: 'pool' as const, numberable: false },
          { id: 'u3', text: 'Tee', kind: 'garment-head' as const, numberable: true },
          { id: 'u4', text: 'Comfort-Colors Graphic Tee', kind: 'pool' as const, numberable: false },
        ],
      }),
    },
    {
      id: 'Comfort Colors tee, wear-fact family',
      truthCtx: { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' },
      composed: { candidates: ['Vintage Beach Vibes', 'Funny Pun Shirt'], specFacts: ['Relaxed Fit'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: 'Can be worn as Oversized' },
      designName: 'Retro Sunset', expectedRuleId: 'wear-fact-list-only',
      attack: (units, truthCtx) => ({
        // A LIST join to a NEIGHBOUR (never the with/in-subject shape R6 already refused) — the
        // NEW S2 "stands alone" violation specifically.
        parts: [{ unit: idOf(units, 'Retro Sunset') }, { unit: headOf(units) }, { glue: 'with' }, { glue: 'a' }, { unit: idOf(units, 'Relaxed Fit') }, { glue: ',' }, { unit: idOf(units, 'Comfort Colors Tee') }, { glue: ',' }, { unit: idOf(units, 'Vintage Beach Vibes') }, { glue: 'and' }, { unit: idOf(units, 'Can be worn as Oversized') }],
        expectRe: /must stand ALONE in its own "," comma clause/, judge: 'grammar',
      }),
    },
  ]

  for (const c of CASES) {
    it(`${c.id}: the "${c.expectedRuleId}" sentence renders, and the REAL judge refuses a real attack for the TAUGHT reason`, () => {
      const units = buildAdmittedUnits(c.composed, { designName: c.designName, truthCtx: c.truthCtx })
      const { system } = buildWriterPrompt(units, c.designName, [], c.truthCtx.allowedBrand)
      const rule = WRITER_RULE_REGISTRY.find((r) => r.id === c.expectedRuleId)!
      expect(system.includes(rule.sentence), `${c.id}: rule "${c.expectedRuleId}" must be rendered`).toBe(true)
      const { parts, expectRe, judge, judgeUnits: judgeUnitsOverride } = c.attack(units, c.truthCtx)
      const judgeUnits = judgeUnitsOverride ?? units
      if (judge === 'grammar') {
        const v = validateArrangement({ parts }, judgeUnits, c.composed.needBrand)
        expect(v.ok, JSON.stringify(v)).toBe(false)
        if (!v.ok) expect(v.violation).toMatch(expectRe)
      } else {
        const v = judgeWriterArrangement({ parts }, judgeUnits, { truthCtx: c.truthCtx, needBrand: c.composed.needBrand, runTail: runTailFor(`THE CEO ${c.designName} Shirt`, c.truthCtx.allowedBrand ? CC : PURE_TEE, c.truthCtx) })
        expect(v.ok, JSON.stringify(v)).toBe(false)
        if (!v.ok) expect(v.violations.join(' ')).toMatch(expectRe)
      }
    })
  }

  it('every when-gated registry id is covered by this sweep (brand, unisex-gender, wear-fact-list-only)', () => {
    const conditional = WRITER_RULE_REGISTRY.filter((r) => r.when).map((r) => r.id).sort()
    expect(conditional).toEqual(['brand', 'unisex-gender', 'wear-fact-list-only'])
    for (const id of conditional) expect(CASES.some((c) => c.expectedRuleId === id), id).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S4 (Important, value): R2's admission PAIR check — pinned for real.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S4: R2\'s admission-time gender/Unisex pair check is pinned', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }

  it('"Unisex Shirt for Women" is dropped at admission, reason identity-collision-unisex-gender', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const units = buildAdmittedUnits(
        { candidates: ['Unisex Shirt for Women', 'Vintage Beach Vibes'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
        { designName: 'Retro Sunset', truthCtx },
      )
      expect(units.find((u) => u.text === 'Unisex Shirt for Women')).toBeUndefined()
      expect(units.find((u) => u.text === 'Vintage Beach Vibes')).toBeDefined()
      const log = warn.mock.calls.map((c) => c[0] as string).find((s) => s.includes('Unisex Shirt for Women'))
      expect(log, JSON.stringify(warn.mock.calls)).toBeDefined()
      expect(log).toMatch(/"reason":"identity-collision-unisex-gender"/)
    } finally { warn.mockRestore() }
  })

  it('"Mens and Womens Matching Shirt" is dropped at admission, reason identity-collision-gender-mix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const units = buildAdmittedUnits(
        { candidates: ['Mens and Womens Matching Shirt', 'Vintage Beach Vibes'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
        { designName: 'Retro Sunset', truthCtx },
      )
      expect(units.find((u) => u.text === 'Mens and Womens Matching Shirt')).toBeUndefined()
      const log = warn.mock.calls.map((c) => c[0] as string).find((s) => s.includes('Mens and Womens Matching Shirt'))
      expect(log, JSON.stringify(warn.mock.calls)).toBeDefined()
      expect(log).toMatch(/"reason":"identity-collision-gender-mix"/)
    } finally { warn.mockRestore() }
  })

  it('through produceItemHighlights: neither colliding phrase is ever offered to the model (never appears in any prompt user message)', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const title = 'THE CEO Retro Sunset Shirt'
      const input = {
        finalTitle: title, pool: ['Unisex Shirt for Women', 'Mens and Womens Matching Shirt', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'].map((k, i) => kw(k, 5000 - i * 10)),
        apparelProduct: true, blankBrand: PURE_TEE, netTitles: [title], designTokens: ['Retro Sunset'], capacityFamily: false,
      }
      const composerBaseline = buildItemHighlights(input)
      // Sanity: at least ONE of the two colliding phrases really is a composer candidate (so this
      // pin is not vacuous — the composer itself could plausibly have shipped it were it not
      // dropped at the WRITER's own admission gate).
      const composedAny = composerBaseline.composed
      expect(composedAny, 'the composer must actually produce a result for this pin to mean anything').toBeDefined()
      const { client, calls } = stubClient(null)
      await produceItemHighlights(input, { openai: client })
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) {
        expect(c.user).not.toMatch(/Unisex Shirt for Women/)
        expect(c.user).not.toMatch(/Mens and Womens Matching Shirt/)
      }
    } finally { delete process.env.IH_WRITER }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S5 (Important, value): R4's sentence and retry message come from RELATION_GLUE.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S5: the readability fidelity sentence and retry message name a JOIN, not a word', () => {
  it('the rendered sentence says "JOIN" and explicitly excludes a with/in appearing inside a unit\'s own text', () => {
    const units: AdmittedUnit[] = [{ id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false }]
    const { system } = buildWriterPrompt(units, 'Retro Sunset', [])
    expect(system).toMatch(/must contain a "with"\/"in" JOIN \(a glue token connecting two units\) — a "with"\/"in" appearing INSIDE a unit's own text does not count/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S6 (Important, compliance): R1's produce*-path pins, committed for real.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S6: R1\'s produce*-path brand pins, committed through BOTH produce* paths', () => {
  const COLLISION_NAMES = ['Comfort Food Club', 'Colors of Fall', 'Show Your Colors', 'Comfort Zone', 'True Colors']
  const IDENTITY_CARRIES_NAMES = ['ComfortColors Club', 'Comfort-Colors Crew']
  const ALL_NAMES = [...COLLISION_NAMES, ...IDENTITY_CARRIES_NAMES]
  const POOL = ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips']
  const BLANKS: { label: string; blank: BlankSpecRow }[] = [{ label: 'CC tee', blank: CC }, { label: 'CC sweatshirt', blank: CC_SWEATSHIRT }]
  const POOL_SHAPES: { label: string; brandOrigin: 'spec' | 'pool' }[] = [{ label: 'spec-origin brand', brandOrigin: 'spec' }, { label: 'pool-origin brand', brandOrigin: 'pool' }]
  const LEANS: (undefined | 'women' | 'men')[] = [undefined, 'women', 'men']

  it('SINGLE-design path: 5 collision names x 2 blanks x 2 pool-shapes x 3 leans + 2 identity-carries names x 2 blanks x 2 pool-shapes x 3 leans — every non-collision cell either carries the brand or is byte-identical to the composer; every collision cell spends 0 calls', async () => {
    process.env.IH_WRITER = 'on'
    let cells = 0, mandatoryCollisionSkips = 0, notAcceptedByteIdentical = 0, acceptedBranded = 0, bad = 0
    try {
      for (const name of ALL_NAMES) {
        for (const { blank } of BLANKS) {
          for (const { brandOrigin } of POOL_SHAPES) {
            for (const audienceLean of LEANS) {
              cells++
              const title = `THE CEO ${name} ${blank.garmentFamily === 'sweatshirt' ? 'Sweatshirt' : 'Tee'}`
              const input = {
                finalTitle: title, pool: POOL.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
                blankBrand: blank, netTitles: [title], designTokens: [name], capacityFamily: false, brandName: 'THE CEO',
                audienceLean,
              }
              const composerBaseline = buildItemHighlights(input)
              if (!composerBaseline.composed || !composerBaseline.truthCtx) continue // no coverable comparison
              const units = buildAdmittedUnits(composerBaseline.composed, { designName: name, truthCtx: composerBaseline.truthCtx })
              const arrangement = autoArrange(units)
              const { client } = stubClient(arrangement)
              const result = await produceItemHighlights(input, { openai: client })
              const isCollision = COLLISION_NAMES.includes(name)
              if (isCollision) {
                if (result.writerLog?.calls === 0 && result.writerLog?.reasons.join(' ').includes('mandatory-collision')) mandatoryCollisionSkips++
                else bad++
                continue
              }
              if (result.value === composerBaseline.value) { notAcceptedByteIdentical++; continue }
              // Accepted a DIFFERENT line than the composer — it MUST carry the brand.
              if (lineCarriesBrand(result.value, 'Comfort Colors')) acceptedBranded++
              else bad++
            }
          }
        }
      }
    } finally { delete process.env.IH_WRITER }
    expect(bad, `cells=${cells} skips=${mandatoryCollisionSkips} byteIdentical=${notAcceptedByteIdentical} branded=${acceptedBranded}`).toBe(0)
    expect(mandatoryCollisionSkips).toBeGreaterThan(0) // the collision names DID skip
    expect(cells).toBeGreaterThan(0)
  }, 30_000)

  it('PER-DESIGN path: the same 7 names as siblings in one family — every non-collision design either carries the brand or is byte-identical, every collision design spends 0 calls', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const keys = ALL_NAMES.map((_, i) => `K${i}`)
      const pool = POOL.map((k, i) => kwFor(k, 5000 - i * 10, keys))
      const groups = ALL_NAMES.map((name, i) => ({ key: `K${i}`, designName: name, skus: [{ sku: `S${i}`, asin: `B0A000000${i}` }], titles: [`THE CEO ${name} Tee`] }))
      const input = { groups, pool, apparelProduct: true, blankBrand: CC, familyTitleText: 'Comfort Colors Family' }
      const composerBaseline = buildItemHighlightsPerDesign(input)
      // Pre-compute a per-design stub arrangement (one client per call is impossible to vary per
      // design with a single stub — use a GENERIC autoArrange keyed off each design's real units,
      // dispatched by DESIGN NAME visible in the prompt).
      const byName = new Map<string, { parts: ArrangementPart[] } | null>()
      for (const d of composerBaseline.perDesign) {
        if (!d.composed || !d.truthCtx) continue
        const units = buildAdmittedUnits(d.composed, { designName: d.designName, truthCtx: d.truthCtx })
        byName.set(d.designName ?? '', autoArrange(units))
      }
      const calls: { system: string; user: string }[] = []
      const client = {
        chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
          const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
          calls.push({ system: '', user })
          const nameMatch = user.match(/DESIGN NAME[^:]*: "([^"]*)"/)
          const arrangement = nameMatch ? byName.get(nameMatch[1]) ?? null : null
          return { choices: [{ message: { role: 'assistant', content: JSON.stringify(arrangement ?? {}) }, finish_reason: 'stop' }] }
        } } },
      } as never
      const result = await produceItemHighlightsPerDesign(input, { openai: client })
      let bad = 0, skips = 0, byteIdentical = 0, branded = 0
      for (const name of ALL_NAMES) {
        const row = result.perDesign.find((d) => d.designName === name)!
        const baseline = composerBaseline.perDesign.find((d) => d.designName === name)!
        const log = result.writerLog?.find((w) => w.design === row.designKey)
        if (COLLISION_NAMES.includes(name)) {
          if (log?.calls === 0 && log?.reasons.join(' ').includes('mandatory-collision')) skips++
          else bad++
          continue
        }
        if (row.value === baseline.value) { byteIdentical++; continue }
        if (lineCarriesBrand(row.value, 'Comfort Colors')) branded++
        else bad++
      }
      expect(bad, `skips=${skips} byteIdentical=${byteIdentical} branded=${branded}`).toBe(0)
      expect(skips).toBeGreaterThan(0)
    } finally { delete process.env.IH_WRITER }
  }, 20_000)

  it('IDENTITY-CARRIES escape (the shape the brand requirement has TWO independent defences for): with the identity OMITTED, an all-pool arrangement that carries no brand text is REJECTED — never ships unbranded', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const name = 'ComfortColors Club' // identity-carries: the dedicated brand unit is WITHHELD
      const title = `THE CEO ${name} Tee`
      const input = {
        finalTitle: title, pool: POOL.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
        blankBrand: CC, netTitles: [title], designTokens: [name], capacityFamily: false, brandName: 'THE CEO',
      }
      const composerBaseline = buildItemHighlights(input)
      const units = buildAdmittedUnits(composerBaseline.composed!, { designName: name, truthCtx: composerBaseline.truthCtx! })
      expect(units.filter((u) => u.isBrand)).toHaveLength(0) // withheld — confirms this IS the identity-carries shape
      const pool = units.filter((u) => u.kind === 'pool' && !u.isBrand)
      // The adversary: no identity, no head, no brand-carrying unit at all — every unit here is
      // ordinary pool text that does NOT carry "Comfort Colors".
      for (const u of pool) expect(lineCarriesBrand(u.text, 'Comfort Colors'), u.text).toBe(false)
      const parts: ArrangementPart[] = [{ unit: pool[0].id }, { glue: 'with' }, { unit: units.find((u) => u.kind === 'spec-fact')!.id }]
      pool.slice(1).forEach((u, i) => { parts.push({ glue: i === pool.length - 2 ? 'and' : ',' }); parts.push({ unit: u.id }) })
      const { client } = stubClient({ parts })
      const result = await produceItemHighlights(input, { openai: client })
      expect(result.value).toBe(composerBaseline.value) // fell back — the adversary never shipped
      expect(result.writerLog?.accepted).toBe(false)
      expect(result.writerLog?.reasons.some((r) => r.includes('does not name or evoke the design'))).toBe(true)
    } finally { delete process.env.IH_WRITER }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S7 (Important, truth): the R7 pin must actually contain T01b.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S7: R7\'s pin judges the ACTUAL T01b arrangement, on the PURE tee', () => {
  it('T01b: "Retro Sunset Shirt with a Classic Fit, Deep Pockets and Stretchy Waistband, Vintage Beach Vibes, Made for Lazy Summer Days" — judged through judgeWriterArrangement — passes; "Deep Pockets"/"Stretchy Waistband" ARE composer candidates (picker-bounded, FILED, not this writer\'s defect)', () => {
    const title = 'THE CEO Retro Sunset Shirt'
    const pool = ['deep pockets', 'stretchy waistband', 'vintage beach vibes', 'made for lazy summer days']
    const built = buildItemHighlights({
      finalTitle: title, pool: pool.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
      blankBrand: PURE_TEE, netTitles: [title], designTokens: ['Retro Sunset'], capacityFamily: false,
    })
    expect(built.composed?.candidates).toContain('Deep Pockets')
    expect(built.composed?.candidates).toContain('Stretchy Waistband')
    const units = buildAdmittedUnits(built.composed!, { designName: 'Retro Sunset', truthCtx: built.truthCtx! })
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const head = units.find((u) => u.kind === 'garment-head' && u.text === 'Shirt')!.id
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: head }, { glue: 'with' }, { glue: 'a' }, { unit: id('Classic Fit') },
      { glue: ',' }, { unit: id('Deep Pockets') }, { glue: 'and' }, { unit: id('Stretchy Waistband') },
      { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: ',' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx: built.truthCtx!, runTail: runTailFor(title, PURE_TEE, built.truthCtx!) })
    expect(v.ok, JSON.stringify(v)).toBe(true)
    if (v.ok) expect(v.value).toBe('Retro Sunset Shirt with a Classic Fit, Deep Pockets and Stretchy Waistband, Vintage Beach Vibes, Made for Lazy Summer Days')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S9 (minors): word-bounded identity strip; the readability verdict calls the SAME shared function
// the admission side does (genderAudienceViolation, which identityPairViolation also calls — "one
// function, not a copy").
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S9: word-bounded identity strip; the readability verdict shares the gender/Unisex primitive with admission', () => {
  it('m6: identity "Lad" does NOT strip the "Lad" out of "Ladies Night Out" (a DIFFERENT unit\'s text) — a real gender word beside a Unisex/gender-mix pair still fires', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Lad', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Ladies Night Out', kind: 'pool', numberable: false },
      { id: 'u2', text: 'Mens Graphic Tee', kind: 'pool', numberable: false },
    ]
    const line = 'Lad Shirt with a Classic Fit and a Crew Neck, Ladies Night Out, Mens Graphic Tee, Vintage Beach Vibes'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.reason).toBe('states both a feminine and a masculine audience word in the same line')
  })
  it('CONTROL: the SAME pair beside "Retro Sunset" (no prefix overlap) still fires identically', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Ladies Night Out', kind: 'pool', numberable: false },
      { id: 'u2', text: 'Mens Graphic Tee', kind: 'pool', numberable: false },
    ]
    const line = 'Retro Sunset Shirt with a Classic Fit and a Crew Neck, Ladies Night Out, Mens Graphic Tee, Vintage Beach Vibes'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.reason).toBe('states both a feminine and a masculine audience word in the same line')
  })
  it('the persona exclusion still works for a one-word design name that IS itself a gender-core word ("Lad" alone, no other gendered unit)', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Lad', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
      { id: 'u2', text: 'Vintage Beach Vibes', kind: 'pool', numberable: false },
    ]
    const line = 'Lad Shirt with Unisex Fit, Vintage Beach Vibes'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
})
