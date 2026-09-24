/**
 * itemHighlightWriterFixRoundI1.test.ts — Round I (`.superpowers/sdd/2026-09-10-ih-writer/phase-
 * i1-rulings.md`, RULING I1 ONLY — I2's before/after acceptance numbers live in
 * `phase-i1-report.md`; I3-I7 are a separate commit, not built here).
 *
 * WHAT PROMPTED THIS ROUND. `phase-h1-review-truth.md` BLOCKING 1 measured that H1 unified the
 * clause boundary INSIDE an already-open relation clause, but not the boundary BETWEEN two POOL
 * units reached BEFORE the relation opens — so whether a pool phrase and a later relation fact
 * land in the SAME truth clause depended on WHERE in the pool list that phrase sat, never on the
 * unit sequence itself:
 *   ADJACENT   "…, Fall Graphic Crewneck Sweatshirts, Relaxed Weekend Layer, with Unisex Fit"
 *     -> REFUSED: join: 'Relaxed Weekend Layer with Unisex Fit' — fit/cut claim
 *   SEPARATED  "…, Relaxed Weekend Layer, Fall Graphic Crewneck Sweatshirts, with Unisex Fit"
 *     -> ACCEPTED (same 4 units, same blank, both 110c, only the pool ORDER swapped)
 * and the REAL search offers ONLY the accepting (SEPARATED) shape.
 *
 * THE FIX THIS FILE PINS (RULING I1, Blocking):
 *   The judged span set in the TRUTH-ONLY view must be a function of the UNIT SEQUENCE ALONE —
 *   never of punctuation placement or where in the pool list a unit sits. `TRUTH_CLAUSE_CLOSERS`
 *   is now EMPTY, so no plain list comma closes a truth clause at all (only `segmentClauses`'s own
 *   relation-hand-off branch, RULING S2, still closes one) — the whole pool run and the relation
 *   clause it eventually opens become ONE truth clause. Every surviving list comma in that clause
 *   is rewritten to the list glue `and` before being handed to `phraseTruthVerdict`, extending H1's
 *   OWN rewrite mechanic from "the stacking comma only" to "every list comma in the truth view".
 *   The pair search inside that (now much larger) clause walks WIDTH-FIRST — the narrowest
 *   contiguous sub-span first — so the reported violation stays the TIGHTEST span that actually
 *   carries the lie, not the whole clause prefix.
 *
 * REPRODUCED FIRST at HEAD (`4bdea7e`), pasted in `phase-i1-report.md`:
 *   ADJACENT  -> REFUSED: join: 'Relaxed Weekend Layer with Unisex Fit' — fit/cut claim
 *   SEPARATED -> ACCEPTED, ihLineTruthVerdict {"ok":true}, classifyStoredIhLine "ok"
 * — the exact escape this file's first `it` pins closed (RED before this round's fix, GREEN after,
 * mutation-proven: reverting the fix reproduces the pre-fix SEPARATED=ACCEPTED result verbatim).
 *
 * DO NOT (per the ruling): touch `phraseTruthVerdict`, `ihLineTruthVerdict`, `lineCompositionVerdict`
 * or anything else shared with the composer; touch title/bullets/backend/description; change hold
 * semantics; make a live model call; or load an env file. Flag-off output must stay byte-identical.
 */
import { describe, it, expect } from 'vitest'
import {
  judgeWriterArrangement, renderArrangement, enumerateWriterCandidates, buildAdmittedUnits,
  type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { classifyStoredIhLine } from '@/lib/fba/productDetailAttrs'
import { phraseTruthVerdict, ihLineTruthVerdict, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import { type BlankSpecRow } from '@/lib/fba/blankSpecs'

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
  return (l: string) => runIhTail(l, { titles: [], blankBrand: BLEND, truthCtx, capacityFamily: false, site: 'i1-test' })
}

// ─── I1's own pin: the reviewer's exact ADJACENT/SEPARATED probe pair (t7-order.ts), byte-for-byte
//     the units, blank and lengths from phase-h1-review-truth.md BLOCKING 1 ───────────────────────

describe('I1 (Blocking, the class fix): the reviewer\'s t7-order ADJACENT/SEPARATED pair now BOTH refuse', () => {
  const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
  const runTail = runTailFor(truthCtx)
  const jctx = { truthCtx, runTail, needBrand: false }
  const units: AdmittedUnit[] = [
    { id: 'id', text: 'Every Day Gratitude Gift', kind: 'identity', numberable: false },
    { id: 'gh', text: 'Sweatshirt', kind: 'garment-head', numberable: false },
    { id: 'R', text: 'Relaxed Weekend Layer', kind: 'pool', numberable: false },
    { id: 'F', text: 'Fall Graphic Crewneck Sweatshirts', kind: 'pool', numberable: false },
    { id: 'f', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
  ]
  const ADJACENT: ArrangementPart[] = [
    { unit: 'id' }, { unit: 'gh' }, { glue: ',' }, { unit: 'F' }, { glue: ',' }, { unit: 'R' },
    { glue: ',' }, { glue: 'with' }, { unit: 'f' },
  ]
  const SEPARATED: ArrangementPart[] = [
    { unit: 'id' }, { unit: 'gh' }, { glue: ',' }, { unit: 'R' }, { glue: ',' }, { unit: 'F' },
    { glue: ',' }, { glue: 'with' }, { unit: 'f' },
  ]

  it('both orderings render to the SAME length (110c) — the length band was never the confound', () => {
    expect(renderArrangement(ADJACENT, units).length).toBe(110)
    expect(renderArrangement(SEPARATED, units).length).toBe(110)
  })

  it('ADJACENT (the offending phrase LAST before the relation) refuses — unchanged by this round', () => {
    const v = judgeWriterArrangement({ parts: ADJACENT }, units, jctx)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/fit\/cut claim/)
  })

  it('SEPARATED (one pool unit inserted between the lie and the relation) now ALSO refuses — THE FIX; pre-fix this was `ok: true`, `ihLineTruthVerdict.ok: true`, `classifyStoredIhLine: "ok"` (reached the push seam)', () => {
    const v = judgeWriterArrangement({ parts: SEPARATED }, units, jctx)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/fit\/cut claim/)
  })

  it('both orderings refuse for the SAME underlying reason (the shared oracle\'s reason code), even though the rendered span text differs — P4 still requires a CONTIGUOUS span, so SEPARATED\'s span must include the intervening pool unit; that residual difference is the intervening unit genuinely being part of the claim\'s context, never a punctuation or order escape', () => {
    const adj = judgeWriterArrangement({ parts: ADJACENT }, units, jctx)
    const sep = judgeWriterArrangement({ parts: SEPARATED }, units, jctx)
    expect(adj.ok).toBe(false)
    expect(sep.ok).toBe(false)
    if (!adj.ok && !sep.ok) {
      const suffix = (v: string) => v.split(' — ')[1]
      expect(adj.violations.map(suffix)).toEqual(sep.violations.map(suffix))
    }
    // the raw pairing both lines carry is a real fit/cut lie on this blank, unchanged by this round
    expect(phraseTruthVerdict('Relaxed Weekend Layer with Unisex Fit', truthCtx)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })

  it('neither ordering reaches ihLineTruthVerdict/classifyStoredIhLine as an accepted value — pre-fix, SEPARATED reached the push seam classified "ok"', () => {
    const adj = judgeWriterArrangement({ parts: ADJACENT }, units, jctx)
    const sep = judgeWriterArrangement({ parts: SEPARATED }, units, jctx)
    expect(adj.ok).toBe(false)
    expect(sep.ok).toBe(false)
    // defense in depth: if either had wrongly accepted, prove what it WOULD have shipped as, so a
    // future regression is caught even if the `.ok` assertions above are ever loosened by mistake.
    if (adj.ok) { expect(ihLineTruthVerdict(adj.value, truthCtx).ok).toBe(false); expect(classifyStoredIhLine(adj.value)).not.toBe('ok') }
    if (sep.ok) { expect(ihLineTruthVerdict(sep.value, truthCtx).ok).toBe(false); expect(classifyStoredIhLine(sep.value)).not.toBe('ok') }
  })

  it('the REAL search on this exact family now offers ZERO candidates (all four legal shapes carry the lie) — pre-fix it offered 4 of 4, all SEPARATED-shaped', () => {
    const composed = {
      candidates: ['Relaxed Weekend Layer', 'Fall Graphic Crewneck Sweatshirts'],
      specFacts: ['Unisex Fit'], brandPick: null, brandOrigin: null, wearFact: null, needBrand: false,
    } as never
    const admitted: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: 'Every Day Gratitude Gift', truthCtx })
    const res = enumerateWriterCandidates(admitted, jctx)
    expect(res.evaluated).toBeGreaterThan(0)
    expect(res.candidates.length).toBe(0)
  })
})

// ─── I1 property (a): SPELLING — for a GENERATED leading pool run, every mix of "," / "and" among
//     the pool units (never only the two extremes) reaches the SAME verdict as every other mix ───

const I1_PRE = ['Relaxed Weekend Layer', 'Classic Weekend Layer', 'Oversized Cozy Layer'] as const
const I1_ORDINARY = ['Fall Graphic Crewneck Sweatshirts', 'Cute Crewnecks', 'Graphic Crewneck'] as const
const I1_FITS = ['Classic', 'Relaxed', 'Slim'] as const
const I1_RELATIONS = ['with', 'in'] as const

function i1Units(pre: string, ordinary: string): AdmittedUnit[] {
  return [
    { id: 'id', text: 'Every Day Gratitude Gift', kind: 'identity', numberable: false },
    { id: 'pre', text: pre, kind: 'pool', numberable: false },
    { id: 'ord', text: ordinary, kind: 'pool', numberable: false },
    { id: 'f', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
  ]
}
/** Every leading-pool glue spelling ("," or "and") crossed with every ORDER of the two pool units,
 *  for one family — 2 spellings x 2 orders = 4 arrangements, all claimed by RULING I1 to reach the
 *  SAME verdict. */
function i1Arms(pre: string, ordinary: string, relation: string): { label: string; parts: ArrangementPart[] }[] {
  return [
    { label: 'pre-then-ord, ","', parts: [{ unit: 'id' }, { glue: ',' }, { unit: 'pre' }, { glue: ',' }, { unit: 'ord' }, { glue: ',' }, { glue: relation }, { unit: 'f' }] },
    { label: 'pre-then-ord, "and"', parts: [{ unit: 'id' }, { glue: ',' }, { unit: 'pre' }, { glue: 'and' }, { unit: 'ord' }, { glue: ',' }, { glue: relation }, { unit: 'f' }] },
    { label: 'ord-then-pre, ","', parts: [{ unit: 'id' }, { glue: ',' }, { unit: 'ord' }, { glue: ',' }, { unit: 'pre' }, { glue: ',' }, { glue: relation }, { unit: 'f' }] },
    { label: 'ord-then-pre, "and"', parts: [{ unit: 'id' }, { glue: ',' }, { unit: 'ord' }, { glue: 'and' }, { unit: 'pre' }, { glue: ',' }, { glue: relation }, { unit: 'f' }] },
  ]
}

describe('I1 property (SPELLING x ORDER): for GENERATED families, every comma/and spelling of the leading pool run, crossed with every order of its two pool units, reaches the SAME accept/refuse verdict', () => {
  const cases: { label: string; truthCtx: PhraseTruthCtx; pre: string; ordinary: string; relation: string }[] = []
  for (const fit of I1_FITS) {
    for (const pre of I1_PRE) {
      for (const ordinary of I1_ORDINARY) {
        for (const relation of I1_RELATIONS) {
          cases.push({ label: `fit=${fit} pre="${pre}" ord="${ordinary}" rel="${relation}"`, truthCtx: truthCtxFor(fit, '50% Cotton / 50% Polyester'), pre, ordinary, relation })
        }
      }
    }
  }

  it('the generator produced a diverse, non-vacuous spread (never all-accepted or all-refused)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(27)
    const oks = cases.map((c) => {
      const runTail = runTailFor(c.truthCtx)
      const units = i1Units(c.pre, c.ordinary)
      const arms = i1Arms(c.pre, c.ordinary, c.relation)
      return judgeWriterArrangement({ parts: arms[0].parts }, units, { truthCtx: c.truthCtx, runTail, needBrand: false }).ok
    })
    expect(oks.filter((ok) => ok).length).toBeGreaterThan(0)
    expect(oks.filter((ok) => !ok).length).toBeGreaterThan(0)
  })

  for (const c of cases) {
    it(`GENERATED: ${c.label}`, () => {
      const runTail = runTailFor(c.truthCtx)
      const units = i1Units(c.pre, c.ordinary)
      const jctx = { truthCtx: c.truthCtx, runTail, needBrand: false }
      const arms = i1Arms(c.pre, c.ordinary, c.relation)
      const verdicts = arms.map((arm) => ({ label: arm.label, v: judgeWriterArrangement({ parts: arm.parts }, units, jctx) }))
      const first = verdicts[0].v.ok
      for (const { label, v } of verdicts) {
        expect(v.ok, `${c.label} / ${label}\n  ${JSON.stringify(verdicts.map((x) => ({ label: x.label, ok: x.v.ok })))}`).toBe(first)
      }
    })
  }
})

// ─── I1 property (b): ORDER — permuting the pool units of a GENERATED family (no spelling change,
//     "," throughout, exactly as `enumerateWriterCandidates` emits) never changes the verdict ─────

describe('I1 property (ORDER, control): a family with NO lying pairing accepts under every pool-unit permutation — proves I1 does not over-refuse merely by widening clause scope', () => {
  const truthCtx = truthCtxFor('Classic', '100% Ring-Spun Cotton')
  const runTail = runTailFor(truthCtx)
  const jctx = { truthCtx, runTail, needBrand: false }
  const units: AdmittedUnit[] = [
    { id: 'id', text: 'Every Day Gratitude Gift', kind: 'identity', numberable: false },
    { id: 'p1', text: 'Fall Sweatshirts for Women', kind: 'pool', numberable: false },
    { id: 'p2', text: 'Cute Crewnecks', kind: 'pool', numberable: false },
    { id: 'p3', text: 'Made For Chilly Mornings', kind: 'pool', numberable: false },
    { id: 'f', text: 'Classic Fit', kind: 'spec-fact', numberable: false },
  ]
  const poolOrders: readonly (readonly string[])[] = [
    ['p1', 'p2', 'p3'], ['p1', 'p3', 'p2'], ['p2', 'p1', 'p3'], ['p2', 'p3', 'p1'], ['p3', 'p1', 'p2'], ['p3', 'p2', 'p1'],
  ]
  for (const order of poolOrders) {
    it(`order=[${order.join(',')}] accepts`, () => {
      const parts: ArrangementPart[] = [{ unit: 'id' }]
      order.forEach((id) => { parts.push({ glue: ',' }, { unit: id }) })
      parts.push({ glue: ',' }, { glue: 'with' }, { unit: 'f' })
      const v = judgeWriterArrangement({ parts }, units, jctx)
      expect(v.ok, JSON.stringify(!v.ok && v.violations)).toBe(true)
    })
  }
})

describe('I1 property (ORDER, positive): a family WITH a lying pairing refuses under every pool-unit permutation, however far the lie sits from the relation', () => {
  const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
  const runTail = runTailFor(truthCtx)
  const jctx = { truthCtx, runTail, needBrand: false }
  const units: AdmittedUnit[] = [
    { id: 'id', text: 'Every Day Gratitude Gift', kind: 'identity', numberable: false },
    { id: 'R', text: 'Relaxed Weekend Layer', kind: 'pool', numberable: false }, // the lie
    { id: 'p2', text: 'Cute Crewnecks', kind: 'pool', numberable: false },
    { id: 'p3', text: 'Graphic Crewneck', kind: 'pool', numberable: false },
    { id: 'f', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
  ]
  const poolOrders: readonly (readonly string[])[] = [
    ['R', 'p2', 'p3'], ['p2', 'R', 'p3'], ['p2', 'p3', 'R'], ['R', 'p3', 'p2'], ['p3', 'R', 'p2'], ['p3', 'p2', 'R'],
  ]
  for (const order of poolOrders) {
    it(`order=[${order.join(',')}] refuses — the lying unit is at position ${order.indexOf('R')} of 3, arbitrarily far from the relation`, () => {
      const parts: ArrangementPart[] = [{ unit: 'id' }]
      order.forEach((id) => { parts.push({ glue: ',' }, { unit: id }) })
      parts.push({ glue: ',' }, { glue: 'with' }, { unit: 'f' })
      const v = judgeWriterArrangement({ parts }, units, jctx)
      expect(v.ok, 'pre-I1 this was `true` for every order except when R sat immediately before the relation').toBe(false)
      if (!v.ok) expect(v.violations.join(' ')).toMatch(/fit\/cut claim/)
    })
  }
})
