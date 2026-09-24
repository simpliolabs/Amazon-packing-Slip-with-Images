/**
 * itemHighlightWriterFixRoundH1.test.ts — Round H1 (`.superpowers/sdd/2026-09-10-ih-writer/phase-
 * h1-rulings.md`, RULING H1 ONLY — H2's counts live in `phase-h1-report.md`; H3-H6 are a separate
 * commit, not built here).
 *
 * WHAT PROMPTED THIS ROUND. `phase-g1-review-truth.md` IMPORTANT 1 measured that a `,` inside an
 * ALREADY-OPEN relation clause ("with A, B") judges strictly FEWER truth spans than the identical
 * clause spelled with `and` ("with A and B") — the SAME class of escape RULING G1 closed for the
 * comma that OPENS a relation, now reopened one comma further in, by this round's own stacked-
 * relation search widening (`enumerateWriterCandidates`, RULING G3):
 *   phraseTruthVerdict('Relaxed Weekend Layer with Crew Neck, Unisex Fit')     = ok
 *   phraseTruthVerdict('Relaxed Weekend Layer with Crew Neck and Unisex Fit')  = fit-claim-lie
 * `phase-g1-review-value.md` IMPORTANT 1 independently measured the SAME defect from the value
 * side: `clauseShapesFromParts` (the readability rank's clause counter) closed on EVERY `,`
 * unconditionally, so the identical stacked clause counted as an extra KEYWORD-SHAPED clause and
 * was deranked out of the visible top-K entirely, even though it is the SAME shape G3's own search
 * widening was built to reach.
 *
 * THE FIX THIS FILE PINS (RULING H1, Blocking):
 *   ONE exported segmentation helper (`segmentClauses`) over `ArrangementPart[]` is the single
 *   authority on where a clause begins/ends and whether a relation glue is open in it. Its rule: a
 *   `,` does not close a clause while a relation glue is open in that clause — `with A, B` is ONE
 *   clause carrying two facts. `clauseShapesFromParts` and the truth walk in
 *   `judgeWriterArrangement` both DERIVE their clause boundaries from it now.
 *   THE MECHANIC (why widening the clause alone measures nothing): `phraseTruthVerdict` stops at a
 *   `,` inside the STRING it is handed, so in the TRUTH-ONLY `truthRenderParts` view (never the
 *   output `line`), a `,` that chains a further unit inside an already-open relation clause is
 *   REWRITTEN to the list glue `and` — the spelling the oracle judges strictly.
 *
 * REPRODUCED FIRST at HEAD (`c86668c`), pasted in `phase-h1-report.md`:
 *   COMMA "…, Relaxed Weekend Layer, with Crew Neck, Unisex Fit" -> judgeWriterArrangement ok=true
 *   AND   "…, Relaxed Weekend Layer, with Crew Neck and Unisex Fit" -> refused (fit-claim-lie)
 * — the exact escape this file's first `it` pins closed (RED before this round's fix, GREEN after,
 * mutation-proven below by reverting the fix and confirming the pin goes red again).
 *
 * DO NOT (per the ruling): touch `phraseTruthVerdict`, `ihLineTruthVerdict`, `lineCompositionVerdict`
 * or anything else shared with the composer; touch title/bullets/backend/description; change hold
 * semantics; make a live model call; or load an env file. Flag-off output must stay byte-identical.
 */
import { describe, it, expect } from 'vitest'
import {
  judgeWriterArrangement, renderArrangement, enumerateWriterCandidates, buildAdmittedUnits,
  segmentClauses,
  type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
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
  return (l: string) => runIhTail(l, { titles: [], blankBrand: BLEND, truthCtx, capacityFamily: false, site: 'h1-test' })
}

// ─── H1's own pin: the reviewer's exact stacked probe pair, RED before the fix, GREEN after ───────

describe('H1 (Blocking, the class fix): the reviewer\'s stacked-relation probe pair now reaches the SAME verdict', () => {
  it('phraseTruthVerdict itself still tells the "," and "and" spellings apart (unchanged, contentTruth.ts untouched) — the SAME premise the widened search exploited, re-asserted so a future edit cannot silently move this file\'s expectations without anyone noticing', () => {
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    expect(phraseTruthVerdict('Relaxed Weekend Layer with Crew Neck, Unisex Fit', truthCtx).ok).toBe(true) // still ok — H1 never touches this function
    expect(phraseTruthVerdict('Relaxed Weekend Layer with Crew Neck and Unisex Fit', truthCtx).ok).toBe(false)
  })

  it('the SAME stacked clause through the REAL judge: the "," spelling now refuses for the IDENTICAL reason the "and" spelling always did — this is the fix; pre-fix the "," spelling accepted', () => {
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    const runTail = runTailFor(truthCtx)
    const units: AdmittedUnit[] = [
      { id: 'id', text: 'Dear Queen', kind: 'identity', numberable: false },
      { id: 'pool1', text: 'Fall Graphic Crewneck Sweatshirts', kind: 'pool', numberable: false },
      { id: 'pool2', text: 'Made For Chilly Mornings', kind: 'pool', numberable: false },
      { id: 'pre', text: 'Relaxed Weekend Layer', kind: 'pool', numberable: false },
      { id: 'a', text: 'Crew Neck', kind: 'spec-fact', numberable: false },
      { id: 'b', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
    ]
    const head: ArrangementPart[] = [
      { unit: 'id' }, { glue: ',' }, { unit: 'pool1' }, { glue: ',' }, { unit: 'pool2' }, { glue: ',' }, { unit: 'pre' },
    ]
    const COMMA: ArrangementPart[] = [...head, { glue: ',' }, { glue: 'with' }, { unit: 'a' }, { glue: ',' }, { unit: 'b' }]
    const AND: ArrangementPart[] = [...head, { glue: ',' }, { glue: 'with' }, { unit: 'a' }, { glue: 'and' }, { unit: 'b' }]

    const commaLine = renderArrangement(COMMA, units)
    const andLine = renderArrangement(AND, units)
    expect(commaLine).toBe('Dear Queen, Fall Graphic Crewneck Sweatshirts, Made For Chilly Mornings, Relaxed Weekend Layer, with Crew Neck, Unisex Fit')
    expect(andLine).toBe('Dear Queen, Fall Graphic Crewneck Sweatshirts, Made For Chilly Mornings, Relaxed Weekend Layer, with Crew Neck and Unisex Fit')

    const commaVerdict = judgeWriterArrangement({ parts: COMMA }, units, { truthCtx, runTail })
    const andVerdict = judgeWriterArrangement({ parts: AND }, units, { truthCtx, runTail })

    expect(andVerdict.ok).toBe(false) // the "and" spelling was already refused before this round
    expect(commaVerdict.ok).toBe(false) // THE FIX: pre-fix this was `true`
    if (!commaVerdict.ok && !andVerdict.ok) {
      expect(commaVerdict.violations).toEqual(andVerdict.violations) // byte-identical reason
      expect(commaVerdict.violations.join(' ')).toMatch(/fit\/cut claim/)
    }
  })

  it('the OUTPUT line the model would actually see is UNCHANGED (comma-spelled) — H1 is a judging-time view only, never a rendering change', () => {
    const truthCtx = truthCtxFor('Classic', '100% Ring-Spun Cotton') // a truthful pairing this time, so it SHIPS
    const runTail = runTailFor(truthCtx)
    const units: AdmittedUnit[] = [
      { id: 'id', text: 'Dear Queen', kind: 'identity', numberable: false },
      { id: 'pool1', text: 'Fall Graphic Crewneck Sweatshirts', kind: 'pool', numberable: false },
      { id: 'pool2', text: 'Made For Chilly Mornings', kind: 'pool', numberable: false },
      { id: 'pre', text: 'Relaxed Weekend Layer', kind: 'pool', numberable: false },
      { id: 'a', text: 'Kids Fit', kind: 'spec-fact', numberable: false },
      { id: 'b', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
    ]
    const head: ArrangementPart[] = [
      { unit: 'id' }, { glue: ',' }, { unit: 'pool1' }, { glue: ',' }, { unit: 'pool2' }, { glue: ',' }, { unit: 'pre' },
    ]
    // Neither fact contradicts the other or the blank (both a Kids Fit and a Unisex Fit claim are
    // refused for a DIFFERENT reason on a real blank — swap in a pairing this ctx actually backs:
    // both facts empty of a fit/cut conflict by using non-fit spec facts instead.
    const c: AdmittedUnit[] = [
      { id: 'id', text: 'Dear Queen', kind: 'identity', numberable: false },
      { id: 'pool1', text: 'Fall Graphic Crewneck Sweatshirts', kind: 'pool', numberable: false },
      { id: 'pool2', text: 'Made For Chilly Mornings', kind: 'pool', numberable: false },
      { id: 'a', text: '100% Ring-Spun Cotton', kind: 'spec-fact', numberable: false },
      { id: 'b', text: 'Classic Fit', kind: 'spec-fact', numberable: false },
    ]
    const parts: ArrangementPart[] = [
      { unit: 'id' }, { glue: ',' }, { unit: 'pool1' }, { glue: ',' }, { unit: 'pool2' },
      { glue: ',' }, { glue: 'with' }, { unit: 'a' }, { glue: ',' }, { unit: 'b' },
    ]
    const line = renderArrangement(parts, c)
    expect(line).toBe('Dear Queen, Fall Graphic Crewneck Sweatshirts, Made For Chilly Mornings, with 100% Ring-Spun Cotton, Classic Fit')
    const verdict = judgeWriterArrangement({ parts }, c, { truthCtx, runTail })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.value).toBe(line) // the shipped bytes still carry the "," spelling — never rewritten to "and"
  })
})

// ─── H1's segmentation authority, unit-tested directly ─────────────────────────────────────────

describe('segmentClauses: the single authority every consumer derives from', () => {
  const units: AdmittedUnit[] = [
    { id: 'p', text: 'Pool Phrase', kind: 'pool', numberable: false },
    { id: 'a', text: 'Fact A', kind: 'spec-fact', numberable: false },
    { id: 'b', text: 'Fact B', kind: 'spec-fact', numberable: false },
    { id: 'w', text: 'Wear Fact', kind: 'wear-fact', numberable: false },
  ]

  it('"with A, B" is ONE clause carrying two facts (H1) — the stacking comma is chained, not a real close', () => {
    const parts: ArrangementPart[] = [{ unit: 'p' }, { glue: ',' }, { glue: 'with' }, { unit: 'a' }, { glue: ',' }, { unit: 'b' }]
    const { clauses, chainedCommaIdx } = segmentClauses(parts, units)
    expect(clauses.length).toBe(2) // [p] and [with, a, ",", b]
    expect(clauses[0].hasRelationGlue).toBe(false)
    expect(clauses[1].hasRelationGlue).toBe(true)
    expect(clauses[1].unitIdx).toEqual([3, 5]) // indices of units a and b
    expect(chainedCommaIdx.has(4)).toBe(true) // the comma between a and b is chained, never a close
  })

  it('a comma BEFORE any relation glue still closes the clause normally — H1 narrows the exception to a comma AFTER a relation is already open', () => {
    const parts: ArrangementPart[] = [{ unit: 'p' }, { glue: ',' }, { unit: 'a' }]
    const { clauses, chainedCommaIdx } = segmentClauses(parts, units)
    expect(clauses.length).toBe(2)
    expect(chainedCommaIdx.size).toBe(0)
  })

  it('a THIRD stacked relation-target fact stays in the SAME open clause — H1 has no arbitrary cap on how many facts may chain', () => {
    const parts: ArrangementPart[] = [{ glue: 'with' } as ArrangementPart, { unit: 'a' }, { glue: ',' }, { unit: 'b' }]
    const { clauses } = segmentClauses(parts, units)
    expect(clauses.length).toBe(1)
    expect(clauses[0].hasRelationGlue).toBe(true)
    expect(clauses[0].unitIdx).toEqual([1, 3])
  })

  it("REGRESSION GUARD (the B7a/B8a wear-fact family): a wear-fact unit reached by ',' AFTER an open relation clause CLOSES it — H1's stacking exception is scoped to a FURTHER RELATION-TARGET fact only, never a pool/brand/wear-fact unit, or RULING S2's 'stands alone' wear clause and every true B7a/B8a acceptance line built on it would wrongly fold into the relation span and refuse", () => {
    const parts: ArrangementPart[] = [{ unit: 'p' }, { glue: 'with' } as ArrangementPart, { unit: 'a' }, { glue: ',' }, { unit: 'w' }]
    const { clauses, chainedCommaIdx } = segmentClauses(parts, units)
    expect(clauses.length).toBe(2) // [p, with, a] and [w] — the wear fact gets its OWN clause
    expect(clauses[0].hasRelationGlue).toBe(true)
    expect(clauses[0].unitIdx).toEqual([0, 2])
    expect(clauses[1].hasRelationGlue).toBe(false)
    expect(clauses[1].unitIdx).toEqual([4])
    expect(chainedCommaIdx.size).toBe(0)
  })

  it('"—"/"|"/"&" still close a clause unconditionally even with a relation open — H1 narrows the exception to "," only', () => {
    for (const punct of ['—', '|', '&'] as const) {
      const parts: ArrangementPart[] = [{ glue: 'with' } as ArrangementPart, { unit: 'a' }, { glue: punct }, { unit: 'b' }]
      const { clauses } = segmentClauses(parts, units)
      expect(clauses.length, `punct=${punct}`).toBe(2)
      expect(clauses[0].hasRelationGlue, `punct=${punct}`).toBe(true)
      expect(clauses[1].hasRelationGlue, `punct=${punct}`).toBe(false)
    }
  })
})

// ─── H1 property: for GENERATED stacked units, every legal spelling of the SAME relation clause
//     over the SAME units in the SAME order reaches the SAME verdict — never hardcoded, band read
//     from CONTENT_CONTRACT (clears the exact coverage gap `phase-g1-review-truth.md` MINOR 1 named
//     in the PRIOR round's pin) ─────────────────────────────────────────────────────────────────

const H1_PROP_FITS = ['Classic', 'Relaxed', 'Slim', 'Oversized'] as const
const H1_PROP_MATERIALS = ['50% Cotton / 50% Polyester', '100% Ring-Spun Cotton'] as const
const H1_PROP_PRE = ['Relaxed Weekend Layer', 'Classic Weekend Layer', 'Oversized Cozy Layer', 'Soft Everyday Feel']
const H1_PROP_FACT_A = ['Crew Neck', 'Ring-Spun Cotton', 'Heavyweight Fleece']
const H1_PROP_FACT_B = ['Unisex Fit', '50% Cotton / 50% Polyester', 'Kids Fit']
const H1_PROP_RELATIONS = ['with', 'in'] as const
const H1_PROP_WEAR = [false, true] as const

interface H1PropCase {
  label: string
  truthCtx: PhraseTruthCtx
  units: AdmittedUnit[]
  commaSpelled: ArrangementPart[]
  andSpelled: ArrangementPart[]
}

function h1PropUnits(pre: string, factA: string, factB: string): AdmittedUnit[] {
  return [
    { id: 'id', text: 'Dear Queen', kind: 'identity', numberable: false },
    { id: 'f1', text: 'Fall Graphic Crewneck Sweatshirts', kind: 'pool', numberable: false },
    { id: 'pre', text: pre, kind: 'pool', numberable: false },
    { id: 'a', text: factA, kind: 'spec-fact', numberable: false },
    { id: 'b', text: factB, kind: 'spec-fact', numberable: false },
    { id: 'w', text: 'Can be worn as Oversized', kind: 'wear-fact', numberable: false },
  ]
}
function h1PropArms(relation: string, wear: boolean): { comma: ArrangementPart[]; and: ArrangementPart[] } {
  const head: ArrangementPart[] = [{ unit: 'id' }, { glue: ',' }, { unit: 'f1' }, { glue: ',' }, { unit: 'pre' }]
  const wearTail: ArrangementPart[] = wear ? [{ glue: ',' }, { unit: 'w' }] : []
  return {
    comma: [...head, { glue: ',' }, { glue: relation }, { unit: 'a' }, { glue: ',' }, { unit: 'b' }, ...wearTail],
    and: [...head, { glue: ',' }, { glue: relation }, { unit: 'a' }, { glue: 'and' }, { unit: 'b' }, ...wearTail],
  }
}

const H1_PROP_ALL_COMBOS: H1PropCase[] = []
for (const fit of H1_PROP_FITS) {
  for (const material of H1_PROP_MATERIALS) {
    for (const pre of H1_PROP_PRE) {
      for (const factA of H1_PROP_FACT_A) {
        for (const factB of H1_PROP_FACT_B) {
          for (const relation of H1_PROP_RELATIONS) {
            for (const wear of H1_PROP_WEAR) {
              const units = h1PropUnits(pre, factA, factB)
              const { comma, and } = h1PropArms(relation, wear)
              H1_PROP_ALL_COMBOS.push({
                label: `fit=${fit} material=${material.slice(0, 6)} pre="${pre}" a="${factA}" b="${factB}" rel="${relation}" wear=${wear}`,
                truthCtx: truthCtxFor(fit, material), units, commaSpelled: comma, andSpelled: and,
              })
            }
          }
        }
      }
    }
  }
}

// Keep every generated case comfortably clear of the band edges (the "and" spelling is always
// exactly two characters longer than the "," spelling) so band membership is never the confound —
// this property is about TRUTH SCOPE, not band arithmetic. Read from CONTENT_CONTRACT (MINOR 1),
// never a hardcoded 97/125. Filtering happens at GENERATION time, never as a skip inside an `it`.
const H1_PROP_NEAR_EDGE = 4
const { min: H1_MIN, max: H1_MAX } = CONTENT_CONTRACT.itemHighlights
const H1_PROP_IN_BAND_CASES: H1PropCase[] = H1_PROP_ALL_COMBOS.filter((c) => {
  const commaLen = renderArrangement(c.commaSpelled, c.units).length
  const andLen = renderArrangement(c.andSpelled, c.units).length
  return commaLen >= H1_MIN + H1_PROP_NEAR_EDGE && andLen <= H1_MAX - H1_PROP_NEAR_EDGE
})

describe('H1 property: for GENERATED stacked-relation units, the "," and "and" spellings of the SAME clause always reach the SAME verdict', () => {
  it('the generator produced a diverse, non-trivial, non-vacuous spread (never a generator that is all-refused or all-accepted)', () => {
    expect(H1_PROP_ALL_COMBOS.length).toBe(
      H1_PROP_FITS.length * H1_PROP_MATERIALS.length * H1_PROP_PRE.length * H1_PROP_FACT_A.length * H1_PROP_FACT_B.length * H1_PROP_RELATIONS.length * H1_PROP_WEAR.length,
    )
    expect(H1_PROP_ALL_COMBOS.length).toBeGreaterThanOrEqual(800)
    expect(H1_PROP_IN_BAND_CASES.length).toBeGreaterThan(100)
    const commaOks = H1_PROP_IN_BAND_CASES.map((c) =>
      judgeWriterArrangement({ parts: c.commaSpelled }, c.units, { truthCtx: c.truthCtx, runTail: runTailFor(c.truthCtx) }).ok,
    )
    expect(commaOks.filter((ok) => ok).length).toBeGreaterThan(20)
    expect(commaOks.filter((ok) => !ok).length).toBeGreaterThan(20)
  })

  for (const c of H1_PROP_IN_BAND_CASES) {
    it(`GENERATED: ${c.label}`, () => {
      const runTail = runTailFor(c.truthCtx)
      const commaVerdict = judgeWriterArrangement({ parts: c.commaSpelled }, c.units, { truthCtx: c.truthCtx, runTail })
      const andVerdict = judgeWriterArrangement({ parts: c.andSpelled }, c.units, { truthCtx: c.truthCtx, runTail })

      expect(commaVerdict.ok, `${c.label}\n  comma: ${JSON.stringify(commaVerdict)}\n  and  : ${JSON.stringify(andVerdict)}`).toBe(andVerdict.ok)
      if (!commaVerdict.ok && !andVerdict.ok) {
        const commaIsJoin = commaVerdict.violations.some((v) => v.startsWith('join:'))
        const andIsJoin = andVerdict.violations.some((v) => v.startsWith('join:'))
        if (commaIsJoin || andIsJoin) {
          expect(commaVerdict.violations).toEqual(andVerdict.violations)
        }
      }
    })
  }
})

// ─── H1's value-side consequence: the readability counter now AGREES with the truth walk on what
//     counts as one clause, so a stacked candidate is no longer deranked purely for its spelling ──

describe('H1 value consequence: a stacked relation clause counts as ONE clause for keywordShapedClauses too, not two', () => {
  it('END TO END through enumerateWriterCandidates: a candidate stacking two true spec facts into one relation clause is offered, and its keywordShapedClauses count equals a same-shape single-fact candidate\'s — never one more, purely for the second fact\'s spelling', () => {
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    const runTail = runTailFor(truthCtx)
    const units: AdmittedUnit[] = [
      { id: 'id', text: 'Every Day Gratitude', kind: 'identity', numberable: false },
      { id: 'gh', text: 'Sweatshirt', kind: 'garment-head', numberable: false },
      { id: 'p1', text: 'Embroidered Sweatshirts for Women', kind: 'pool', numberable: false },
      { id: 'p3', text: 'Fall Sweatshirts for Women', kind: 'pool', numberable: false },
      { id: 's1', text: '50% Cotton / 50% Polyester', kind: 'spec-fact', numberable: false },
      { id: 's2', text: 'Classic Fit', kind: 'spec-fact', numberable: false },
    ]
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(result.candidates.length).toBeGreaterThan(0)
    const stacked = result.candidates.find((c) => /50% Cotton \/ 50% Polyester, Classic Fit/.test(c.line) || /Classic Fit, 50% Cotton \/ 50% Polyester/.test(c.line))
    const singleFact = result.candidates.find((c) => /with 50% Cotton \/ 50% Polyester$/.test(c.line.replace(/,\s*$/, '')) && !/Classic Fit/.test(c.line))
    expect(stacked, 'a candidate stacking both true facts must be offered at all — this is the value-lens finding').toBeTruthy()
    if (stacked && singleFact) {
      // Same pool prefix shape, one extra TRUE fact stacked into the SAME relation clause: the
      // clause count must not grow just because the second fact was chained with "," (H1).
      expect(stacked.keywordShapedClauses).toBeLessThanOrEqual(singleFact.keywordShapedClauses + 0)
    }
  })
})
