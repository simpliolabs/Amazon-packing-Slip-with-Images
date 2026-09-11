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
  renderArrangement,
  type AdmittedUnit, type ArrangementPart,
} from './itemHighlightWriter'
import { lineCarriesBrand } from './itemHighlightComposer'
import { buildItemHighlights, buildItemHighlightsPerDesign, produceItemHighlights, produceItemHighlightsPerDesign, runIhTail } from './listingPipeline'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import { CONTENT_CONTRACT } from './contentContract'
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

/** RULING T3 (fix round B9a, compliance Important): builds a generically-valid arrangement out of
 *  REAL admitted units, INCREMENTALLY, so the rendered line actually LANDS inside the
 *  97-125 character band — the OLD version always included EVERY admitted unit at once, and review
 *  B8's compliance lens (S6) measured that this family's real admitted sets (5-6 spec-facts + 4 pool
 *  + brand) render 183-206 chars, so the committed sweep's "carries the brand OR byte-identical"
 *  positive branch was NEVER reached (`accepted` stayed 0 on every cell): identity + garment-head
 *  (abutment, if both exist), ONE relation clause with a spec-fact (with article if fit/neck-
 *  shaped), THEN the mandatory brand unit first (never skipped for space), then every remaining
 *  spec-fact/pool unit ONE AT A TIME — each addition tried, kept only if the render still fits under
 *  the contract's max — then the wear fact last, in its own trailing comma clause (T4: at the END,
 *  never the start). Returns whatever fits; a caller that needs the POSITIVE branch to be reached
 *  asserts the render length itself (never assumed here). */
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
  if (parts.length === 0 || !('unit' in parts[0])) return null // no identity, nothing legal to lead with here
  const tryAppend = (u: AdmittedUnit) => {
    const trial: ArrangementPart[] = [...parts, { glue: ',' }, { unit: u.id }]
    if (renderArrangement(trial, units).length > CONTENT_CONTRACT.itemHighlights.max) return
    parts.push({ glue: ',' }, { unit: u.id })
  }
  // The mandatory brand unit is tried FIRST — it is never sacrificed for space; every other
  // candidate below only ever fills room the brand (and identity/head/relSpec above) left over.
  if (brand) tryAppend(brand)
  for (const u of units.filter((u) => u.kind === 'spec-fact' && u.id !== relSpec?.id)) tryAppend(u)
  for (const u of units.filter((u) => u.kind === 'pool' && !u.isBrand)) tryAppend(u)
  if (wear) tryAppend(wear)
  return { parts }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S1 (Blocking, value): a garment-head unit is offered ONLY when an identity unit was admitted.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('RULING S1: a garment-head unit is offered only when an identity unit was admitted', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: PURE_TEE.spec as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const composed = { candidates: ['Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }
  // RULING T2 (fix round B9a): a SEPARATE, larger pool for the no-identity CENSUS only (below) — the
  // rewritten census must ACTUALLY accept a no-identity, no-head line to prove anything (a "no NEVER
  // rows" property is vacuous if nothing is ever accepted), and the shared 3-candidate `composed`
  // above (89c combined with its one spec fact) can never clear CONTENT_CONTRACT.itemHighlights.min
  // (97) without an identity/head at all. It stays SEPARATE from `composed` (never widens it) because
  // the CONTROL census below combines identity+head+spec+ALL pool candidates in one line too, and a
  // 4-candidate pool pushed that combination over the 125 max — the WITH-identity and WITHOUT-identity
  // shapes need different-sized pools to each land in-band; every other test in this block is
  // unaffected (they only read admission, never the census).
  const composedNoIdentity = { candidates: ['Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips', 'Ideal for Everyday Wear'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }

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
  // RULING T2 (fix round B9a, truth Important and value Important): the OLD census (per B8's truth
  // and value lenses) measured R5's own grammar defense, never S1's admission-time drop — every
  // shape that uses `head.id` lives INSIDE `for (const head of heads)`, and in production `heads` is
  // ALREADY `[]` for a no-identity family (S1 dropped them at admission), so that loop body never
  // runs at all: the sweep is vacuously empty, `headEverAccepted` is trivially `false`, and NOTHING
  // changes under `identityAdmittedForHeads = true` except that the (still R5-blocked) head shapes
  // now actually execute — landing on the SAME `false`. The census now asserts the RULED property
  // directly: (1) no garment-head unit is ever OFFERED for a no-identity family (the direct S1 check —
  // this alone fails under MS1, since the mutant admits heads into `units` regardless of R5's later
  // defense); (2) every unit that IS offered appears in at least one accepted arrangement (no "NEVER"
  // rows) — a head unit wrongly admitted under MS1 is exercised by `censusShapes` below exactly like
  // the CONTROL exercises a real one, and since R5 still refuses every one of those attempts, the
  // head unit becomes a NEVER row, failing this half too.
  function censusNeverUsesHead(designName: string | null, composedForCensus: typeof composed = composed): { anyAccepted: boolean; headEverAccepted: boolean; neverRows: AdmittedUnit[]; units: AdmittedUnit[] } {
    const units = buildAdmittedUnits(composedForCensus, { designName, truthCtx })
    const identity = units.find((u) => u.kind === 'identity') ?? null
    const heads = units.filter((u) => u.kind === 'garment-head')
    const spec = units.find((u) => u.kind === 'spec-fact')!
    const pool = units.filter((u) => u.kind === 'pool')
    const runTail = runTailFor('THE CEO Retro Sunset Shirt', PURE_TEE, truthCtx)
    let anyAccepted = false, headEverAccepted = false
    const usedInAccepted = new Set<string>()
    const judgeAndTrack = (parts: ArrangementPart[], usesHead: boolean) => {
      const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail })
      if (v.ok) {
        anyAccepted = true
        if (usesHead) headEverAccepted = true
        for (const p of parts) if ('unit' in p) usedInAccepted.add(p.unit)
      }
    }
    for (const poolPerm of permutations(pool)) {
      // Head-INDEPENDENT shape: identity (if any) + spec relation + the whole pool, list-joined —
      // exercised even when NO head exists at all (production, no mutant), so identity/spec/pool
      // units are always given a chance to be used, never vacuously skipped. Readability requires
      // AT LEAST ONE relation ("with"/"in") clause, so with no identity to lead (glue cannot OPEN
      // the line), the first POOL unit leads instead, and the relation opens right after it.
      const bare: ArrangementPart[] = identity
        ? [{ unit: identity.id }, { glue: 'with' }, { unit: spec.id }]
        : [{ unit: poolPerm[0].id }, { glue: 'with' }, { unit: spec.id }]
      const tailPool = identity ? poolPerm : poolPerm.slice(1)
      tailPool.forEach((u) => { bare.push({ glue: ',' }); bare.push({ unit: u.id }) })
      judgeAndTrack(bare, false)
      // Head-DEPENDENT shapes: only exercised when a head unit actually exists in `units` — under
      // real production that is precisely the empty set for a no-identity family (nothing to census);
      // under MS1 it is Shirt/Tee/Top, and every attempt below is exactly what R5 refuses.
      for (const head of heads) {
        for (const parts of censusShapes(units, identity, head, spec, poolPerm)) {
          const usesHead = parts.some((p) => 'unit' in p && p.unit === head.id)
          judgeAndTrack(parts, usesHead)
        }
      }
    }
    const neverRows = units.filter((u) => !usedInAccepted.has(u.id))
    return { anyAccepted, headEverAccepted, neverRows, units }
  }
  it('CENSUS: designName null / trademark-dropped / untrue-dropped — no garment-head unit is ever OFFERED, and every unit that IS offered appears in at least one accepted arrangement (no NEVER rows)', () => {
    for (const name of [null, 'Disney Squad', 'Oversized Vibes']) {
      const { neverRows, units } = censusNeverUsesHead(name, composedNoIdentity)
      expect(units.filter((u) => u.kind === 'garment-head'), `designName=${name}: ${JSON.stringify(units)}`).toHaveLength(0)
      expect(neverRows.map((u) => `${u.kind}:${u.text}`), `designName=${name}`).toEqual([])
    }
  })
  it('CENSUS CONTROL: with an admitted identity, a garment-head unit IS reachable in an accepted arrangement, and no NEVER rows exist', () => {
    const { anyAccepted, headEverAccepted, neverRows } = censusNeverUsesHead('Retro Sunset')
    expect(anyAccepted).toBe(true)
    expect(headEverAccepted).toBe(true)
    expect(neverRows.map((u) => `${u.kind}:${u.text}`)).toEqual([])
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
      // RULING T2 (fix round B9a, truth Important and value Important): the OLD pin stopped at the
      // DESIGN-NAME half (m2's own check) and asserted NOTHING about garment heads — it stayed GREEN
      // under MS1 (`identityAdmittedForHeads = true`) because nothing here ever inspected the
      // 'garment-head' group. Design A has no identity (its name was dropped as untrue), so per S1
      // its OWN calls carry NO "DESIGN NAME" line at all (unlike design B's, which carry "Retro
      // Sunset") — that absence is how A's calls are told apart from B's on the ONE shared client.
      // Parse A's own grouped-units JSON and assert 'garment-head' is empty on every one of them.
      const aCallsOnly = calls.filter((c) => !c.user.includes('DESIGN NAME'))
      expect(aCallsOnly.length, JSON.stringify(calls.map((c) => c.user.slice(0, 40)))).toBeGreaterThan(0)
      for (const c of aCallsOnly) {
        const grouped = JSON.parse(c.user.match(/(\{"identity":.*\})/)?.[1] ?? '{}')
        expect(grouped['garment-head'] ?? [], c.user).toEqual([])
      }
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
  // RULING T1 (fix round B9a, truth Important): review B8's truth lens (I-1) measured that every one
  // of these 8 shapes OMITS the family's mandatory brand unit ('Comfort Colors Tee'), so G4's own
  // "missing required brand unit" rule refused all 8 whether or not S2's wear-fact rule existed at
  // all — the pin passed for the wrong reason and could not fail under the s2 mutant (which disables
  // ONLY the wear-fact stand-alone check). Each shape now carries the brand unit too, and the
  // assertion is on the S2 MESSAGE itself, not merely `ok === false` — a brand-required rejection
  // would fail this narrower match, so the pin can only pass when S2's own check actually fired.
  it('RE-MEASURE: every and/&/—/| neighbour-join shape on the wear fact is refused BY THE S2 RULE at the GRAMMAR layer (call 1), for both sides, with the brand unit present', () => {
    let checked = 0
    const brand = id('Comfort Colors Tee')
    for (const glue of ['and', '&', '—', '|'] as const) {
      for (const side of ['before', 'after'] as const) {
        checked++
        const neighbour = id('Vintage Beach Vibes')
        const wear = id('Can be worn as Oversized')
        const parts: ArrangementPart[] = side === 'before'
          ? [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: brand }, { glue: ',' }, { unit: neighbour }, { glue }, { unit: wear }]
          : [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: ',' }, { unit: brand }, { glue: ',' }, { unit: wear }, { glue }, { unit: neighbour }]
        const v = validateArrangement({ parts }, units)
        expect(v.ok, `${glue}/${side}: ${JSON.stringify(v)}`).toBe(false)
        if (!v.ok) expect(v.violation, `${glue}/${side}: ${JSON.stringify(v)}`).toMatch(/is a wear-fact unit and must stand ALONE in its own "," comma clause/)
      }
    }
    expect(checked).toBe(8) // 4 glue tokens x 2 sides — the "should reach 100%" refusal set
  })

  // RULING T4 (fix round B9a, value Important): review B8's value lens (I-2) measured that the
  // GRAMMAR sentence (rule (2), and rule (3)'s closing parenthetical) and the `validateGrammar`
  // relation-wear retry message STILL taught the PRE-S2 rule — "list-join only" naming "," "and" "&"
  // "—" "|" as the wear fact's valid joins, even though S2's own check refuses every one of those
  // shapes 100% of the time. A model that followed that message literally was refused on 4 of the 5
  // joins it named, 98/98 times. Pinned here so neither the taught sentence nor the retry message
  // ever offers and/&/—/| for the wear fact again.
  it('RULING T4: the rendered GRAMMAR sentence exempts the wear fact from the list-join grant, and no longer calls it "LIST-JOIN ONLY"', () => {
    const { system } = buildWriterPrompt(units, 'Retro Sunset', [], 'Comfort Colors')
    const grammarSentence = system.slice(system.indexOf('THE GRAMMAR'), system.indexOf('(4) No other glue word exists'))
    expect(grammarSentence, grammarSentence).toMatch(/EXCEPT a garment-head unit.*wear-fact unit/)
    expect(grammarSentence, grammarSentence).not.toMatch(/both the brand and the wear fact are LIST-JOIN ONLY/)
    expect(grammarSentence, grammarSentence).toMatch(/wear fact STANDS ALONE/)
  })
  it('RULING T4: the relation-wear retry message is rebuilt from the S2 rule\'s own wording, and no longer names "," "and" "&" "—" "|" as the wear fact\'s valid joins', () => {
    const parts: ArrangementPart[] = [{ unit: id('Retro Sunset') }, { unit: garmentHead }, { glue: 'with' }, { unit: id('Can be worn as Oversized') }]
    const v = validateArrangement({ parts }, units)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) {
      expect(v.violation, v.violation).toMatch(/cannot introduce the wear-fact unit '.*' — the wear fact must stand ALONE in its own "," comma clause/)
      expect(v.violation, v.violation).not.toMatch(/list-join only/)
      expect(v.violation, v.violation).not.toMatch(/"," "and" "&" "—" "\|"/)
    }
  })
  it('RULING T4: the wear-fact-list-only registry sentence teaches the END of the line only, never the start', () => {
    const rule = WRITER_RULE_REGISTRY.find((r) => r.id === 'wear-fact-list-only')!
    expect(rule.sentence, rule.sentence).toMatch(/very END of the line, never the start/)
    expect(rule.sentence, rule.sentence).not.toMatch(/very start\/end of the line/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// S3 (Important, value): the R3 sweep, built for real.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// RULING T5 (fix round B9a, value, ruled twice): a genuine ENUMERATION, not four hand-picked
// fixtures. Review B8's value lens (n1) measured that the OLD sweep built ONE hand-typed attack per
// family with a hard-coded `expectedRuleId` — a deviation from the ruling's own form, even though
// every mutant it tried turned it RED. Each family below GENERATES many real arrangements (every
// permutation of its own pool units, combined with the target unit/pair's own structural shape) from
// the REAL admitted units (`buildAdmittedUnits`), judges EVERY one through the REAL
// `judgeWriterArrangement`, and MAPS every refusal's violation string back to its registry id via
// `violationToRuleId` — never a single pre-picked shape with an assumed outcome.
describe('RULING S3: the WRITER_RULE_REGISTRY when-predicate SWEEP — a genuine ENUMERATION over real admitted units, refusals mapped to their registry id', () => {
  function permutations<T>(arr: readonly T[]): T[][] {
    if (arr.length <= 1) return [[...arr]]
    const out: T[][] = []
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
      for (const p of permutations(rest)) out.push([arr[i], ...p])
    }
    return out
  }
  /** Maps a judge/validator violation STRING back to the `WRITER_RULE_REGISTRY` id it corresponds
   *  to — the enumeration's own "map each refusal to its registry id" requirement. `null` for a
   *  violation this sweep does not expect to see (e.g. a length/repeat rejection on a permutation
   *  that happens to run long) — not itself a failure, just not counted toward the family's target. */
  function violationToRuleId(text: string): string | null {
    if (/gender audience beside "Unisex"/.test(text)) return 'unisex-gender'
    if (/states both a feminine and a masculine audience word/.test(text)) return 'gender-mix'
    if (/missing required brand unit|more than one unit carries the brand/.test(text)) return 'brand'
    if (/is a wear-fact unit and must stand ALONE/.test(text)) return 'wear-fact-list-only'
    return null
  }
  const idOf = (units: readonly AdmittedUnit[], t: string) => units.find((u) => u.text === t)!.id
  const headOf = (units: readonly AdmittedUnit[]) => units.find((u) => u.kind === 'garment-head')!.id
  /** A leading unit (identity+head, or a bare unit when none exists) plus "with" + spec, then the
   *  WHOLE poolPerm list-joined — the same head-independent shape the S1 census uses, generalised so
   *  every family below can enumerate over pool ORDER (which puts the target phrase in a different
   *  structural position — leading, mid, trailing — across the permutation set). */
  function relationLeadShape(units: readonly AdmittedUnit[], identityText: string | null, specText: string, poolPerm: readonly AdmittedUnit[], extra: readonly AdmittedUnit[] = []): ArrangementPart[] {
    const identity = identityText ? units.find((u) => u.text === identityText) : undefined
    const head = identity ? units.find((u) => u.kind === 'garment-head') : undefined
    const parts: ArrangementPart[] = identity ? [{ unit: identity.id }] : [{ unit: poolPerm[0].id }]
    if (identity && head) parts.push({ unit: head.id })
    parts.push({ glue: 'with' }, { unit: idOf(units, specText) })
    const tail = identity ? poolPerm : poolPerm.slice(1)
    for (const u of [...tail, ...extra]) { parts.push({ glue: ',' }); parts.push({ unit: u.id }) }
    return parts
  }

  interface EnumFamily {
    id: string
    expectedRuleId: string
    truthCtx: PhraseTruthCtx
    designName: string
    units: AdmittedUnit[]
    needBrand?: boolean
    /** The units to hand the JUDGE (defaults to `units`) — overridden ONLY by the allowedBrand-only
     *  family below, whose violation is a defense-in-depth check admission itself already prevents
     *  by construction; the SENTENCE check always reads the REAL `units`, never this override. */
    judgeUnits?: AdmittedUnit[]
    arrangements: () => ArrangementPart[][]
  }

  const unisexCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const unisexComposed = { candidates: ['Soft Unisex Tee', 'Birthday Gift for Women', 'Great for Weekend Road Trips'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }
  const unisexUnits = buildAdmittedUnits(unisexComposed, { designName: 'Retro Sunset', truthCtx: unisexCtx })

  const brandOnlyCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
  const brandOnlyComposed = { candidates: ['Comfort Colors Pocket Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'], specFacts: ['100% Ring-Spun Cotton'], brandPick: null, wearFact: null, needBrand: false }
  const brandOnlyUnits = buildAdmittedUnits(brandOnlyComposed, { designName: 'Beach Days', truthCtx: brandOnlyCtx })
  // The TWO-CARRIER judge-level unit set (B7a's K2 shape): admission itself keeps at most ONE
  // unbranded carrier by construction, so this defense-in-depth check is exercised on a hand-built
  // set — enumerated over which of the two brand-carrying units leads, still real UNIT shapes.
  const brandOnlyJudgeUnitsBase: AdmittedUnit[] = [
    { id: 'j0', text: 'Beach Days', kind: 'identity', numberable: false },
    { id: 'j1', text: '100% Ring-Spun Cotton', kind: 'spec-fact', numberable: false },
    { id: 'j2', text: 'Comfort Colors Pocket Tee', kind: 'pool', numberable: false },
    { id: 'j3', text: 'Tee', kind: 'garment-head', numberable: true },
    { id: 'j4', text: 'Comfort-Colors Graphic Tee', kind: 'pool', numberable: false },
  ]

  const wearCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
  const wearComposed = { candidates: ['Vintage Beach Vibes', 'Funny Pun Shirt'], specFacts: ['Relaxed Fit'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec' as const, wearFact: 'Can be worn as Oversized' }
  const wearUnits = buildAdmittedUnits(wearComposed, { designName: 'Retro Sunset', truthCtx: wearCtx })

  // RULING T5's fourth required family: a GENDERED lean, proving `gender-mix` still teaches and
  // enforces UNCONDITIONALLY on it (RULING Q4 — bundling it with the lean-gated `unisex-gender`
  // sentence used to make it vanish on exactly the gendered-lean families it governs).
  const genderLeanCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights', audienceLean: 'women' }
  const genderLeanComposed = { candidates: ['Womens Cozy Vibe', 'Mens Bold Statement', 'Great for Weekend Road Trips'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }
  const genderLeanUnits = buildAdmittedUnits(genderLeanComposed, { designName: 'Retro Sunset', truthCtx: genderLeanCtx })

  const FAMILIES: EnumFamily[] = [
    {
      // The exact case M2's narrowed `when` (`/^unisex\b/i`) turns this sweep RED on — a Unisex pool
      // phrase whose OWN text does NOT start with "unisex" ("Soft Unisex Tee").
      id: 'PURE tee, MID-TEXT "Soft Unisex Tee" pool unit', expectedRuleId: 'unisex-gender',
      truthCtx: unisexCtx, designName: 'Retro Sunset', units: unisexUnits,
      arrangements: () => permutations(unisexUnits.filter((u) => u.kind === 'pool'))
        .map((poolPerm) => relationLeadShape(unisexUnits, 'Retro Sunset', 'Classic Fit', poolPerm)),
    },
    {
      // The exact case M3's narrowed `when` (`!!ctx.brandUnit` alone) turns this sweep RED on:
      // `allowedBrand` set, `needBrand=false`, no dedicated brand unit admitted at all.
      id: 'Comfort Colors tee, allowedBrand-only (needBrand=false, no dedicated brand unit)', expectedRuleId: 'brand',
      truthCtx: brandOnlyCtx, designName: 'Beach Days', units: brandOnlyUnits, needBrand: false,
      judgeUnits: brandOnlyJudgeUnitsBase,
      arrangements: () => permutations([brandOnlyJudgeUnitsBase[2], brandOnlyJudgeUnitsBase[4]]).map((carriers) => [
        { unit: 'j0' }, { unit: 'j3' }, { glue: 'with' }, { unit: 'j1' },
        { glue: ',' }, { unit: carriers[0].id }, { glue: 'and' }, { unit: carriers[1].id },
      ]),
    },
    {
      // The re-measured wear shape set (S2/T1's own family), through the SENTENCE-mapping lens: the
      // wear fact list-joined to a neighbour by each of and/&/—/|, on both sides, over the 2-item
      // pool's own permutations — 4 glues x 2 sides x 2 pool orders = 16 real arrangements.
      id: 'Comfort Colors tee, wear-fact family', expectedRuleId: 'wear-fact-list-only',
      truthCtx: wearCtx, designName: 'Retro Sunset', units: wearUnits,
      arrangements: () => {
        const head = headOf(wearUnits)
        const brand = idOf(wearUnits, 'Comfort Colors Tee')
        const wear = idOf(wearUnits, 'Can be worn as Oversized')
        const out: ArrangementPart[][] = []
        for (const poolPerm of permutations(wearUnits.filter((u) => u.kind === 'pool'))) {
          for (const glue of ['and', '&', '—', '|'] as const) {
            for (const side of ['before', 'after'] as const) {
              const neighbour = poolPerm[0].id
              const base: ArrangementPart[] = [{ unit: idOf(wearUnits, 'Retro Sunset') }, { unit: head }, { glue: ',' }, { unit: brand }, { glue: ',' }]
              out.push(side === 'before'
                ? [...base, { unit: neighbour }, { glue }, { unit: wear }]
                : [...base, { unit: wear }, { glue }, { unit: neighbour }])
            }
          }
        }
        return out
      },
    },
    {
      id: 'PURE tee, GENDERED (women) lean — two individually-true, oppositely-gendered pool phrases', expectedRuleId: 'gender-mix',
      truthCtx: genderLeanCtx, designName: 'Retro Sunset', units: genderLeanUnits,
      arrangements: () => permutations(genderLeanUnits.filter((u) => u.kind === 'pool'))
        .map((poolPerm) => relationLeadShape(genderLeanUnits, 'Retro Sunset', 'Classic Fit', poolPerm)),
    },
  ]

  for (const fam of FAMILIES) {
    it(`${fam.id}: the "${fam.expectedRuleId}" sentence renders for this unit set, and the ENUMERATED real arrangements map at least one refusal to it`, () => {
      const { system } = buildWriterPrompt(fam.units, fam.designName, [], fam.truthCtx.allowedBrand ?? null)
      const rule = WRITER_RULE_REGISTRY.find((r) => r.id === fam.expectedRuleId)!
      expect(system.includes(rule.sentence), `${fam.id}: rule "${fam.expectedRuleId}" must be rendered for this unit set`).toBe(true)

      const judgeUnits = fam.judgeUnits ?? fam.units
      const runTail = runTailFor(`THE CEO ${fam.designName} Shirt`, fam.truthCtx.allowedBrand ? CC : PURE_TEE, fam.truthCtx)
      const arrangements = fam.arrangements()
      expect(arrangements.length, `${fam.id}: a genuine enumeration, not one hand-picked shape`).toBeGreaterThan(1)

      const matchedRuleIds = new Set<string>()
      let anyRefusal = false
      for (const parts of arrangements) {
        const v = judgeWriterArrangement({ parts }, judgeUnits, { truthCtx: fam.truthCtx, needBrand: fam.needBrand, runTail })
        if (v.ok) continue
        anyRefusal = true
        for (const violation of v.violations) {
          const ruleId = violationToRuleId(violation)
          if (ruleId) matchedRuleIds.add(ruleId)
        }
      }
      expect(anyRefusal, `${fam.id}: the enumeration must produce at least one refusal`).toBe(true)
      expect(matchedRuleIds.has(fam.expectedRuleId), `${fam.id}: expected "${fam.expectedRuleId}" among the mapped ids, got ${JSON.stringify([...matchedRuleIds])}`).toBe(true)
    })
  }

  it('every when-gated registry id is covered by this sweep (brand, unisex-gender, wear-fact-list-only)', () => {
    const conditional = WRITER_RULE_REGISTRY.filter((r) => r.when).map((r) => r.id).sort()
    expect(conditional).toEqual(['brand', 'unisex-gender', 'wear-fact-list-only'])
    for (const id of conditional) expect(FAMILIES.some((f) => f.expectedRuleId === id), id).toBe(true)
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
  // RULING T3.2 (fix round B9a, compliance Important): a REAL pool-origin brand phrase — no garment
  // noun (so it is truth-clean on BOTH the tee and the sweatshirt blank), high volume so the
  // composer's own waterfall (`itemHighlightComposer.ts:524-528`) actually PICKS it over the
  // deterministic spec phrase. The OLD "pool-origin brand" label built the identical POOL every
  // time and never put a brand-carrying candidate in it at all — `brandOrigin` was destructured and
  // never read (`rg brandOrigin` in the OLD file: declaration + destructure only).
  const POOL_BRAND_PHRASE = 'Comfort Colors Beach Days'
  const BLANKS: { label: string; blank: BlankSpecRow }[] = [{ label: 'CC tee', blank: CC }, { label: 'CC sweatshirt', blank: CC_SWEATSHIRT }]
  const POOL_SHAPES: { label: string; brandOrigin: 'spec' | 'pool' }[] = [{ label: 'spec-origin brand', brandOrigin: 'spec' }, { label: 'pool-origin brand', brandOrigin: 'pool' }]
  // `ItemHighlightsInput.audienceLean` (single-design) takes the NORMALIZED `TruthAudienceLean`
  // vocabulary ('women'/'men'); `PerDesignItemHighlightsInput.audienceLean` (per-design) takes the
  // RAW seller-declared `AudienceLean` vocabulary ('female'/'male') and normalizes it internally
  // (`buildItemHighlightsPerDesign`'s own `normalizeAudienceLean` call) — two genuinely different
  // enums, never interchangeable, so each sweep gets its own array in its own vocabulary.
  const LEANS: (undefined | 'women' | 'men')[] = [undefined, 'women', 'men']
  const PER_DESIGN_LEANS: (undefined | 'female' | 'male')[] = [undefined, 'female', 'male']
  /** Counts occurrences of the brand text (fuzzy on spacing/hyphenation/case), never merely a
   *  boolean — RULING T3.4 requires EXACTLY one, and `lineCarriesBrand` alone cannot tell 1 from 2. */
  const BRAND_COUNT = (s: string) => (s.toLowerCase().match(/comfort[\s\-._/]*colou?rs?/g) ?? []).length
  const poolFor = (brandOrigin: 'spec' | 'pool') => {
    const texts = brandOrigin === 'pool' ? [...POOL, POOL_BRAND_PHRASE] : POOL
    return texts.map((k, i) => kw(k, brandOrigin === 'pool' && k === POOL_BRAND_PHRASE ? 9999 : 5000 - i * 10))
  }
  const poolForKeys = (brandOrigin: 'spec' | 'pool', keys: readonly string[]) => {
    const texts = brandOrigin === 'pool' ? [...POOL, POOL_BRAND_PHRASE] : POOL
    return texts.map((k, i) => kwFor(k, brandOrigin === 'pool' && k === POOL_BRAND_PHRASE ? 9999 : 5000 - i * 10, keys))
  }

  it('SINGLE-design path: 5 collision names x 2 blanks x 2 pool-shapes x 3 leans + 2 identity-carries names x 2 blanks x 2 pool-shapes x 3 leans — the positive branch is ACTUALLY reached, every accepted line carries the brand EXACTLY once, every non-collision cell either carries the brand or is byte-identical to the composer, every collision cell spends 0 calls', async () => {
    process.env.IH_WRITER = 'on'
    let cells = 0, mandatoryCollisionSkips = 0, notAcceptedByteIdentical = 0, accepted = 0, bad = 0
    try {
      for (const name of ALL_NAMES) {
        for (const { blank } of BLANKS) {
          for (const { brandOrigin } of POOL_SHAPES) {
            for (const audienceLean of LEANS) {
              cells++
              const title = `THE CEO ${name} ${blank.garmentFamily === 'sweatshirt' ? 'Sweatshirt' : 'Tee'}`
              const input = {
                finalTitle: title, pool: poolFor(brandOrigin), apparelProduct: true,
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
              // RULING T3.1: the positive branch — accepted a DIFFERENT line than the composer.
              accepted++
              // RULING T3.4: it must carry the brand EXACTLY once, never 0 and never 2+.
              const n = BRAND_COUNT(result.value)
              if (n !== 1) bad++
            }
          }
        }
      }
    } finally { delete process.env.IH_WRITER }
    expect(bad, `cells=${cells} skips=${mandatoryCollisionSkips} byteIdentical=${notAcceptedByteIdentical} accepted=${accepted}`).toBe(0)
    expect(mandatoryCollisionSkips).toBeGreaterThan(0) // the collision names DID skip
    expect(accepted, 'RULING T3.1: the positive branch must actually be reached').toBeGreaterThan(0)
    expect(cells).toBeGreaterThan(0)
  }, 30_000)

  // RULING T3.3 (fix round B9a, compliance Important): the per-design sweep now runs over BOTH
  // blanks (tee AND the Comfort Colors sweatshirt) and all 3 leans, not one fixed cell — each
  // (blank, lean) pair builds its OWN 7-design family, so the collision/identity-carries names are
  // re-tested at every combination, not merely once.
  it('PER-DESIGN path: the same 7 names as siblings, over 2 blanks x 3 leans — the positive branch is reached, every accepted line carries the brand EXACTLY once, every non-collision design either carries the brand or is byte-identical, every collision design spends 0 calls', async () => {
    process.env.IH_WRITER = 'on'
    let familyCells = 0, skips = 0, byteIdentical = 0, accepted = 0, bad = 0
    try {
      for (const { blank } of BLANKS) {
        for (const { brandOrigin } of POOL_SHAPES) {
          for (const audienceLean of PER_DESIGN_LEANS) {
            familyCells++
            const keys = ALL_NAMES.map((_, i) => `K${i}`)
            const pool = poolForKeys(brandOrigin, keys)
            const garment = blank.garmentFamily === 'sweatshirt' ? 'Sweatshirt' : 'Tee'
            const groups = ALL_NAMES.map((name, i) => ({ key: `K${i}`, designName: name, skus: [{ sku: `S${i}`, asin: `B0A000000${i}` }], titles: [`THE CEO ${name} ${garment}`] }))
            const input = { groups, pool, apparelProduct: true, blankBrand: blank, familyTitleText: 'Comfort Colors Family', audienceLean }
            const composerBaseline = buildItemHighlightsPerDesign(input)
            // Pre-compute a per-design stub arrangement (one client per call is impossible to vary
            // per design with a single stub — use a GENERIC autoArrange keyed off each design's real
            // units, dispatched by DESIGN NAME visible in the prompt).
            const byName = new Map<string, { parts: ArrangementPart[] } | null>()
            for (const d of composerBaseline.perDesign) {
              if (!d.composed || !d.truthCtx) continue
              const units = buildAdmittedUnits(d.composed, { designName: d.designName, truthCtx: d.truthCtx })
              byName.set(d.designName ?? '', autoArrange(units))
            }
            const client = {
              chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
                const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
                const nameMatch = user.match(/DESIGN NAME[^:]*: "([^"]*)"/)
                const arrangement = nameMatch ? byName.get(nameMatch[1]) ?? null : null
                return { choices: [{ message: { role: 'assistant', content: JSON.stringify(arrangement ?? {}) }, finish_reason: 'stop' }] }
              } } },
            } as never
            const result = await produceItemHighlightsPerDesign(input, { openai: client })
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
              accepted++
              const n = BRAND_COUNT(row.value)
              if (n !== 1) bad++
            }
          }
        }
      }
    } finally { delete process.env.IH_WRITER }
    expect(bad, `familyCells=${familyCells} skips=${skips} byteIdentical=${byteIdentical} accepted=${accepted}`).toBe(0)
    expect(skips).toBeGreaterThan(0)
    expect(accepted, 'RULING T3.1/T3.3: the positive branch must actually be reached over blanks x leans').toBeGreaterThan(0)
  }, 60_000)

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

  // RULING T3.5 (fix round B9a, compliance Important): the q8two shape — the design's IDENTITY
  // itself carries the brand (the dedicated brand unit is WITHHELD, exactly like the test above),
  // but this time the TITLE does NOT carry the design name at all, so the composer's own `needBrand`
  // is TRUE (unlike the test above, where the title carries the name and `needBrand` is false). This
  // exercises the BRAND-required check specifically — a defence the test above never reaches at all
  // (its `needBrand` is false, so only the readability "names the design" check ever fires there).
  // An IN-BAND (97-125c), identity-less adversary built from ONLY pool+spec units (none of which
  // carries the brand) is run through BOTH produce* paths and must fall back on both.
  it('q8two shape (identity carries the brand; the TITLE does not, so needBrand=true): an IN-BAND, identity-less adversary is REJECTED through BOTH produce* paths, never ships unbranded', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const name = 'ComfortColors Club'
      const title = 'THE CEO Tee' // does NOT carry the design name (or the brand) — needBrand=true
      const input = {
        finalTitle: title, pool: POOL.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
        blankBrand: CC, netTitles: [title], designTokens: [name], capacityFamily: false, brandName: 'THE CEO',
      }
      const composerBaseline = buildItemHighlights(input)
      expect(composerBaseline.composed?.needBrand, JSON.stringify(composerBaseline.composed)).toBe(true)
      const units = buildAdmittedUnits(composerBaseline.composed!, { designName: name, truthCtx: composerBaseline.truthCtx! })
      expect(units.filter((u) => u.isBrand)).toHaveLength(0) // withheld — identity is the sole carrier
      const pool = units.filter((u) => u.kind === 'pool' && !u.isBrand)
      for (const u of pool) expect(lineCarriesBrand(u.text, 'Comfort Colors'), u.text).toBe(false)
      const spec = units.find((u) => u.kind === 'spec-fact')!
      const parts: ArrangementPart[] = [{ unit: pool[0].id }, { glue: 'with' }, { unit: spec.id }]
      pool.slice(1).forEach((u, i) => { parts.push({ glue: i === pool.length - 2 ? 'and' : ',' }); parts.push({ unit: u.id }) })
      const line = renderArrangement(parts, units)
      expect(line.length, line).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min) // RULING T3.5: IN-BAND
      expect(line.length, line).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)

      // SINGLE-design path.
      const { client } = stubClient({ parts })
      const single = await produceItemHighlights(input, { openai: client })
      expect(single.value).toBe(composerBaseline.value) // fell back
      expect(single.writerLog?.accepted).toBe(false)

      // PER-DESIGN path — the same identity, the same adversary, offered as design A's own draft.
      const keys = ['A']
      const perInput = {
        groups: [{ key: 'A', designName: name, skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: [title] }],
        pool: POOL.map((k, i) => kwFor(k, 5000 - i * 10, keys)), apparelProduct: true, blankBrand: CC, familyTitleText: title,
      }
      const perBaseline = buildItemHighlightsPerDesign(perInput)
      const aBaseline = perBaseline.perDesign.find((d) => d.designKey === 'A')!
      expect(aBaseline.composed?.needBrand, JSON.stringify(aBaseline.composed)).toBe(true)
      const { client: perClient } = stubClient({ parts })
      const per = await produceItemHighlightsPerDesign(perInput, { openai: perClient })
      const aRow = per.perDesign.find((d) => d.designKey === 'A')!
      expect(aRow.value).toBe(aBaseline.value) // fell back
      const aLog = per.writerLog?.find((w) => w.design === 'A')
      expect(aLog?.accepted).toBe(false)
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

  // RULING T6 (fix round B9a, truth m9): the persona strip now compares TOKENS (whitespace-split,
  // case-folded), never a `\b` regex. `\b` requires a WORD-CHAR/NON-WORD-CHAR transition, so an
  // identity that STARTS or ENDS in punctuation, followed/preceded by whitespace ("Boss Lady!",
  // "#Girl Gang Lady"), has NO boundary to match at that edge — the OLD implementation's whole
  // pattern silently failed to strip, and the identity's own gender-core word ("Lady") then read as
  // an outside audience claim beside a bare "Unisex Fit" spec-fact, over-refusing a line that should
  // have shipped (review B8, truth m9, `s9edge.out.txt`).
  it('RULING T6: identity "Boss Lady!" (trailing punctuation, a NON-WORD edge) IS stripped — a bare "Unisex Fit" spec-fact beside it does NOT wrongly fire', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Boss Lady!', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
      { id: 'u2', text: 'Vintage Beach Vibes', kind: 'pool', numberable: false },
    ]
    const line = 'Boss Lady! Shirt with Unisex Fit, Vintage Beach Vibes'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
  it('RULING T6: identity "#Girl Gang Lady" (LEADING punctuation, a NON-WORD edge) IS stripped — the same bare "Unisex Fit" case', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: '#Girl Gang Lady', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
      { id: 'u2', text: 'Vintage Beach Vibes', kind: 'pool', numberable: false },
    ]
    const line = '#Girl Gang Lady Shirt with Unisex Fit, Vintage Beach Vibes'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
  it('RULING T6 CONTROL: a real gender word (NOT the identity) beside "Boss Lady!" and "Unisex Fit" still fires', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Boss Lady!', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
      { id: 'u2', text: 'Mens Graphic Tee', kind: 'pool', numberable: false },
    ]
    const line = 'Boss Lady! Shirt with Unisex Fit, Mens Graphic Tee'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.reason).toBe('states a gender audience beside "Unisex"')
  })
  it('RULING T6: a comma the renderer attaches with NO SPACE ("Business B*tch,") still matches the identity token "B*tch" — trailing punctuation trimmed for comparison, never the char embedded inside the token', () => {
    const units: AdmittedUnit[] = [
      { id: 'u0', text: 'Business B*tch', kind: 'identity', numberable: false },
      { id: 'u1', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
      { id: 'u2', text: 'Vintage Beach Vibes', kind: 'pool', numberable: false },
    ]
    const line = 'Business B*tch, Unisex Fit, Vintage Beach Vibes with a Relaxed Fit'
    const v = writerReadabilityVerdict(line, units)
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
})
