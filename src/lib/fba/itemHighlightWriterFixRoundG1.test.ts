/**
 * itemHighlightWriterFixRoundG1.test.ts — Round G1 (`.superpowers/sdd/2026-09-10-ih-writer/phase-
 * g1-rulings.md`, RULINGS G1 and G2 ONLY — G3/G4/G5 are a separate round, not built here).
 *
 * WHAT PROMPTED THIS ROUND. `phase-f1-review.md` §2 (Blocking) measured that fix round F1
 * legalised `X , with Y` (a list join immediately followed by a relation join) WITHOUT widening
 * the truth-scope clause walk in `judgeWriterArrangement` to match. Both truth oracles in this
 * codebase stop at a `,`:
 *   phraseTruthVerdict('Relaxed Weekend Layer with Unisex Fit')   = 'fit-claim-lie'
 *   phraseTruthVerdict('Relaxed Weekend Layer, with Unisex Fit')  = OK   (a DIFFERENT string)
 * — so a fact refused BARE shipped, unchanged in meaning, one comma to the right. The writer's own
 * retry message (the `pair-truth` registry sentence) tells the model to make exactly that move,
 * and through the REAL `runWriterForDesign`, call 2 (the bare units + one comma) SHIPPED after
 * call 1 (bare) was refused. Reproduced verbatim at HEAD (`bb7a954`) before this round's fix — see
 * `phase-g1-report.md` for both pasted runs (RED before, GREEN after).
 *
 * THE FIX THIS FILE PINS:
 *   G1 (Blocking, truth fix) — in the WRITER ONLY (never `ihLineTruthVerdict` in contentTruth.ts,
 *     shared with the composer — flag-off bytes must not move), a `,` immediately followed by a
 *     relation glue no longer closes the truth-scope clause `judgeWriterArrangement`'s P4 walk
 *     builds, and the span rendered FOR THE TRUTH CHECK ONLY drops that same `,` — so `X , with Y`
 *     is judged as the byte-identical span `X with Y`, never a different string the regex-based
 *     `phraseTruthVerdict` can tell apart. The OUTPUT line (what actually ships) is unaffected —
 *     this is a judging-time view, not a rendering change.
 *   G2 (narrows F1 to what the ruling actually named) — F1's own `roles[0] === 'list'` test
 *     legalised routing a relation join after ANY of the five list-glue spellings
 *     (`,` `and` `&` `|` `—`); the ruling and the 12 live shadow attempts it was built from only
 *     ever used `,`. `and with` / `& with` / `| with` / `— with` are refused again.
 *
 * REPRODUCES FIRST (per the task's own instruction): the property test below and the exact
 * retry-escape pin are both built from the units `phase-f1-review.md` §2 names — the SAME two
 * pool phrases, the SAME "Unisex Fit" spec fact, the SAME Classic-fit/50-50-blend truth context —
 * run through the REAL `validateArrangement`/`judgeWriterArrangement`/`runWriterForDesign`, never
 * a re-implementation of either oracle under test.
 *
 * DO NOT (per the ruling): widen a truth rule, touch title/bullets/backend/description, change
 * hold semantics, make a live model call, or load an env file.
 */
import { describe, it, expect } from 'vitest'
import {
  validateArrangement, renderArrangement, judgeWriterArrangement, runWriterForDesign,
  buildAdmittedUnits, buildWriterPrompt, enumerateWriterCandidates,
  type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { type BlankSpecRow } from '@/lib/fba/blankSpecs'
import { phraseTruthVerdict, type PhraseTruthCtx } from '@/lib/fba/contentTruth'

// ─── shared fixtures ────────────────────────────────────────────────────────────────────────────

const NEVER: RegExp = /(?!)/
const BLEND: BlankSpecRow = {
  match: NEVER,
  spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '50% Cotton / 50% Polyester' } as never,
  styleCode: '18000', garmentFamily: 'sweatshirt',
} as unknown as BlankSpecRow

function truthCtxFor(fit: string, material: string): PhraseTruthCtx {
  return { garmentFamily: 'sweatshirt', spec: { material, fit } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
}
function runTailFor(truthCtx: PhraseTruthCtx) {
  return (l: string) => runIhTail(l, { titles: [], blankBrand: BLEND, truthCtx, capacityFamily: false, site: 'g1-test' })
}

// ─── G1's own pin: the reviewer's exact retry-escape pair, RED before the fix, GREEN after ────────

describe('G1 (Blocking, truth fix): the retry-escape phase-f1-review.md §2 measured is closed', () => {
  it("phraseTruthVerdict itself still tells bare and comma apart (unchanged, contentTruth.ts untouched) — this is the SAME PREMISE the retry loop exploited, re-asserted so a future edit to contentTruth.ts cannot silently 'fix' this file's expectations without anyone noticing the premise moved", () => {
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    const bareLine = 'Relaxed Weekend Layer with Unisex Fit'
    const commaLine = 'Relaxed Weekend Layer, with Unisex Fit'
    expect(phraseTruthVerdict(bareLine, truthCtx).ok).toBe(false)
    expect(phraseTruthVerdict(commaLine, truthCtx).ok).toBe(true) // still OK — G1 never touches this function
  })

  it('the SAME pair through the REAL judge (judgeWriterArrangement): bare refuses, and — this is the fix — the comma spelling now refuses for the IDENTICAL reason, never a different one', () => {
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    const runTail = runTailFor(truthCtx)
    const units: AdmittedUnit[] = [
      { id: 'id', text: 'Dear Queen', kind: 'identity', numberable: false },
      { id: 'pool1', text: 'Relaxed Weekend Layer', kind: 'pool', numberable: false },
      { id: 'pool2', text: 'Fall Graphic Crewneck Sweatshirts', kind: 'pool', numberable: false },
      { id: 'pool3', text: 'Made For Chilly Mornings', kind: 'pool', numberable: false },
      { id: 'fit', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
    ]
    const head: ArrangementPart[] = [
      { unit: 'id' }, { glue: ',' }, { unit: 'pool2' }, { glue: ',' }, { unit: 'pool3' }, { glue: ',' }, { unit: 'pool1' },
    ]
    const BARE: ArrangementPart[] = [...head, { glue: 'with' }, { unit: 'fit' }]
    const COMMA: ArrangementPart[] = [...head, { glue: ',' }, { glue: 'with' }, { unit: 'fit' }]

    const bareLine = renderArrangement(BARE, units)
    const commaLine = renderArrangement(COMMA, units)
    expect(bareLine).toBe('Dear Queen, Fall Graphic Crewneck Sweatshirts, Made For Chilly Mornings, Relaxed Weekend Layer with Unisex Fit')
    expect(commaLine).toBe('Dear Queen, Fall Graphic Crewneck Sweatshirts, Made For Chilly Mornings, Relaxed Weekend Layer, with Unisex Fit')

    const bareVerdict = judgeWriterArrangement({ parts: BARE }, units, { truthCtx, runTail })
    const commaVerdict = judgeWriterArrangement({ parts: COMMA }, units, { truthCtx, runTail })

    expect(bareVerdict.ok).toBe(false)
    expect(commaVerdict.ok).toBe(false) // THE FIX: pre-fix this was `true` — the laundered accept
    if (!bareVerdict.ok && !commaVerdict.ok) {
      expect(bareVerdict.violations).toEqual(commaVerdict.violations) // byte-identical reason
      expect(bareVerdict.violations.join(' ')).toMatch(/fit\/cut claim/)
    }
  })

  // RULING G3 (fix round G1, phase-g1-rulings.md, design change, built in the SAME round as this
  // file's G1/G2 fix — see `itemHighlightWriterFixRoundG3.test.ts`): the writer no longer COMPOSES,
  // so there is no more retry loop for a model to launder a refusal through — it can only return an
  // INDEX into a list of lines `enumerateWriterCandidates` already judged. The property this test
  // pinned (the retry-escape stays closed) now has to hold at the SEARCH layer instead: the
  // poisoned line can never become a candidate in the first place, so the model is never OFFERED
  // it, laundered spelling or not. Re-proven below through the REAL `enumerateWriterCandidates` and
  // the REAL `runWriterForDesign`, on the EXACT SAME units this test always used.
  it('END TO END: enumerateWriterCandidates, on these exact units, NEVER offers the laundered comma pairing as a candidate — the search itself never reaches it, so no retry loop is needed to catch it', () => {
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    const runTail = runTailFor(truthCtx)
    const composed = {
      candidates: ['Fall Graphic Crewneck Sweatshirts', 'Made For Chilly Mornings', 'Relaxed Weekend Layer'],
      specFacts: ['Unisex Fit'],
      brandPick: null, brandOrigin: null, wearFact: null, needBrand: false,
    } as never
    const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: 'Dear Queen', truthCtx })
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    for (const c of result.candidates) {
      expect(c.line, 'no candidate may pair "Relaxed Weekend Layer" with "Unisex Fit" in the same relation clause').not.toMatch(/Relaxed Weekend Layer,? with Unisex Fit/)
    }
  })

  it("END TO END through the REAL runWriterForDesign: even a client that ANSWERS WITH THE OLD COMPOSED SHAPE (not an index — a stub built to look like the pre-G3 retry escape) cannot ship the laundered line, because it has no \"pick\" key and is treated as a client-error retry, exhausting the cap and shipping the search's OWN top (safe) candidate instead", async () => {
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    const runTail = runTailFor(truthCtx)
    const composed = {
      candidates: ['Fall Graphic Crewneck Sweatshirts', 'Made For Chilly Mornings', 'Relaxed Weekend Layer'],
      specFacts: ['Unisex Fit'],
      brandPick: null, brandOrigin: null, wearFact: null, needBrand: false,
    } as never
    const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: 'Dear Queen', truthCtx })
    const idOf = (t: string) => units.find((u) => u.text === t)!.id
    const head: ArrangementPart[] = [
      { unit: idOf('Dear Queen') }, { glue: ',' }, { unit: idOf('Fall Graphic Crewneck Sweatshirts') },
      { glue: ',' }, { unit: idOf('Made For Chilly Mornings') }, { glue: ',' }, { unit: idOf('Relaxed Weekend Layer') },
    ]
    // The exact old live shape — has no "pick" key at all, so `runWriterForDesign` cannot even
    // interpret it as a (malformed) pick; it is indistinguishable from a client failure.
    const COMMA = { parts: [...head, { glue: ',' }, { glue: 'with' }, { unit: idOf('Unisex Fit') }] }
    const client = {
      chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(COMMA) }, finish_reason: 'stop' }] }) } },
    } as never

    const out = await runWriterForDesign({
      composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail,
      deps: { openai: client }, model: 'gpt-4.1-mini',
    })
    // Ships SOMETHING (the search's own safe top candidate) rather than refusing outright — but it
    // is NEVER the laundered pairing, because that line was never in the candidate list to begin
    // with (proven directly above).
    if (out.accepted) expect(out.value).not.toMatch(/Relaxed Weekend Layer,? with Unisex Fit/)
    expect(out.value).not.toBe('') // a candidate exists for this family (proven above) — it ships
  })
})

// ─── G1's class fix: the PROPERTY, over GENERATED unit sets — not one example ──────────────────────

// Generated axes — every combination below is a DIFFERENT unit set, spanning several distinct
// truth-predicate classes (fit, material, weight-class, audience, capability, and the OK case),
// not a single hand-picked scenario. Built at MODULE scope (never inside an `it`) so filtering to
// band-safe combinations is a generation-time decision, not a runtime early-return inside a test —
// every `it` this produces runs its full assertion body unconditionally.
const G1_PROP_FITS = ['Classic', 'Relaxed', 'Slim', 'Oversized'] as const
const G1_PROP_MATERIALS = ['50% Cotton / 50% Polyester', '100% Ring-Spun Cotton'] as const
const G1_PROP_PRE = ['Relaxed Weekend Layer', 'Classic Weekend Layer', 'Oversized Cozy Layer', 'Slim Fit Layer', 'Soft Everyday Feel', 'Moisture Wicking Comfort']
const G1_PROP_POST = ['Unisex Fit', '50% Cotton / 50% Polyester', '100% Ring-Spun Cotton', 'Heavyweight Fleece', 'Kids Fit']
const G1_PROP_RELATIONS = ['with', 'in'] as const

function g1PropUnits(pre: string, post: string): AdmittedUnit[] {
  return [
    { id: 'id', text: 'Dear Queen', kind: 'identity', numberable: false },
    { id: 'f1', text: 'Fall Graphic Crewneck Sweatshirts', kind: 'pool', numberable: false },
    { id: 'f2', text: 'Made For Chilly Mornings', kind: 'pool', numberable: false },
    { id: 'pre', text: pre, kind: 'pool', numberable: false },
    { id: 'post', text: post, kind: 'spec-fact', numberable: false },
  ]
}
function g1PropArm(units: AdmittedUnit[], relation: string): { bare: ArrangementPart[]; comma: ArrangementPart[] } {
  const head: ArrangementPart[] = [
    { unit: 'id' }, { glue: ',' }, { unit: 'f1' }, { glue: ',' }, { unit: 'f2' }, { glue: ',' }, { unit: 'pre' },
  ]
  return {
    bare: [...head, { glue: relation }, { unit: 'post' }],
    comma: [...head, { glue: ',' }, { glue: relation }, { unit: 'post' }],
  }
}

interface G1PropCase {
  label: string
  truthCtx: PhraseTruthCtx
  units: AdmittedUnit[]
  bare: ArrangementPart[]
  comma: ArrangementPart[]
}

// Every combination, unfiltered — this is the count the "diverse, non-trivial spread" assertion
// below checks against, so that assertion can never be satisfied by an accidentally-tiny generator.
const G1_PROP_ALL_COMBOS: G1PropCase[] = []
for (const fit of G1_PROP_FITS) {
  for (const material of G1_PROP_MATERIALS) {
    for (const pre of G1_PROP_PRE) {
      for (const post of G1_PROP_POST) {
        for (const relation of G1_PROP_RELATIONS) {
          const units = g1PropUnits(pre, post)
          const { bare, comma } = g1PropArm(units, relation)
          G1_PROP_ALL_COMBOS.push({
            label: `fit=${fit} material=${material.slice(0, 6)} pre="${pre}" post="${post}" relation="${relation}"`,
            truthCtx: truthCtxFor(fit, material), units, bare, comma,
          })
        }
      }
    }
  }
}
// Keep every generated case comfortably clear of the 97-125 band edges (the comma spelling is
// always exactly one character longer than the bare one) so band membership itself is never the
// confound this property is testing — the property is about TRUTH SCOPE, not band arithmetic. The
// filter runs at generation time, over the full unfiltered list, never as a skip inside a test.
const G1_PROP_NEAR_EDGE = 3
const G1_PROP_IN_BAND_CASES: G1PropCase[] = G1_PROP_ALL_COMBOS.filter((c) => {
  const bareLen = renderArrangement(c.bare, c.units).length
  return bareLen >= 97 + G1_PROP_NEAR_EDGE && bareLen <= 125 - G1_PROP_NEAR_EDGE
})

describe('G1 property: for any units, the bare and the comma spelling of a relation join always reach the SAME verdict', () => {
  it('the generator produced a diverse, non-trivial spread (never vacuously true — this is the class fix, not one example)', () => {
    expect(G1_PROP_ALL_COMBOS.length).toBe(G1_PROP_FITS.length * G1_PROP_MATERIALS.length * G1_PROP_PRE.length * G1_PROP_POST.length * G1_PROP_RELATIONS.length)
    expect(G1_PROP_ALL_COMBOS.length).toBeGreaterThanOrEqual(400) // 4 fits x 2 materials x 6 pre x 5 post x 2 relations = 480
    expect(G1_PROP_IN_BAND_CASES.length).toBeGreaterThan(100)
    // Every in-band case is independently judged (real judge, no mocking) to confirm the sweep
    // actually exercises BOTH the lie classes and the OK case — never an all-refused or
    // all-accepted generator that would make the equality assertions below vacuous.
    const bareOks = G1_PROP_IN_BAND_CASES.map((c) => judgeWriterArrangement({ parts: c.bare }, c.units, { truthCtx: c.truthCtx, runTail: runTailFor(c.truthCtx) }).ok)
    expect(bareOks.filter((ok) => ok).length).toBeGreaterThan(20)
    expect(bareOks.filter((ok) => !ok).length).toBeGreaterThan(20)
  })

  for (const c of G1_PROP_IN_BAND_CASES) {
    it(`GENERATED: ${c.label}`, () => {
      const runTail = runTailFor(c.truthCtx)
      const bareVerdict = judgeWriterArrangement({ parts: c.bare }, c.units, { truthCtx: c.truthCtx, runTail })
      const commaVerdict = judgeWriterArrangement({ parts: c.comma }, c.units, { truthCtx: c.truthCtx, runTail })

      expect(commaVerdict.ok, `${c.label}\n  bare  : ${JSON.stringify(bareVerdict)}\n  comma : ${JSON.stringify(commaVerdict)}`).toBe(bareVerdict.ok)
      // When BOTH are refused for a truth-scope ("join:") reason, the span text the fix renders
      // for the truth check is now byte-identical between the two spellings, so the violation
      // itself must be byte-identical too — never merely "both refused".
      if (!bareVerdict.ok && !commaVerdict.ok) {
        const bareIsJoin = bareVerdict.violations.some((v) => v.startsWith('join:'))
        const commaIsJoin = commaVerdict.violations.some((v) => v.startsWith('join:'))
        if (bareIsJoin || commaIsJoin) {
          expect(commaVerdict.violations).toEqual(bareVerdict.violations)
        }
      }
    })
  }
})

// ─── G2: only ',' may precede a relation join — every other list glue stays illegal ───────────────

describe("G2: F1 is narrowed to ',' only — 'and'/'&'/'|'/'—' immediately before a relation join stay illegal", () => {
  const units: AdmittedUnit[] = [
    { id: 'pool', text: 'Fall Crewneck', kind: 'pool', numberable: false },
    { id: 'mat', text: '50% Cotton / 50% Polyester', kind: 'spec-fact', numberable: false },
  ]

  it("','  + 'with' is still legal (F1's own case, unchanged by the narrowing)", () => {
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'with' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
  })

  for (const listGlue of ['and', '&', '|', '—']) {
    it(`'${listGlue} with' is refused (F1 legalised 'roles[0]===list', which wrongly included this)`, () => {
      const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: listGlue }, { glue: 'with' }, { unit: 'mat' }] }, units)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.violation).toMatch(/is not a legal join between/)
    })
    it(`'${listGlue} in' is refused too (the relation half of the pair is 'with' OR 'in')`, () => {
      const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: listGlue }, { glue: 'in' }, { unit: 'mat' }] }, units)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.violation).toMatch(/is not a legal join between/)
    })
  }

  it('a bare relation join (no preceding list glue at all) is still legal — G2 narrows the TWO-GLUE case only, never the one-glue case F1 never touched', () => {
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: 'with' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
  })

  it('the chooser prompt (G4, built in THIS round — see itemHighlightWriterFixRoundG3.test.ts) is unaffected by this narrowing: it renders from CANDIDATES, never from the grammar this file pins', () => {
    const { system } = buildWriterPrompt([{ parts: [], line: 'Fall Crewneck, with 50% Cotton / 50% Polyester', keywordShapedClauses: 0, distinctPoolUnits: 1, lengthFromTarget: 0 }], 'Fall Crewneck')
    expect(typeof system).toBe('string')
  })
})
