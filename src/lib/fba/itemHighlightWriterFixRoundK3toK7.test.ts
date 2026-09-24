/**
 * itemHighlightWriterFixRoundK3toK7.test.ts — `.superpowers/sdd/2026-09-10-ih-writer/phase-k1-
 * rulings.md`, RULINGS K5 AND K7 (K3's own AST rebuild lives in
 * `itemHighlightWriterClauseAuthoritySingleSource.test.ts`; K4's fixture rebuild lives in
 * `__fixtures__/b0dscdzc6k-item-highlights-2026-09-23.json` +
 * `itemHighlightWriterB0DSCDZC6KFixture.test.ts`; K6 is a no-code deliberate-choice ruling, pinned
 * implicitly by K1's own "narrowest pair first" property in `itemHighlightWriterFixRoundK1.test.ts`).
 *
 * RULING K5: `WRITER_CANDIDATE_MAX_REL_UNITS` 6 -> 5 — review I1 (MINOR 3) measured depth 6 as
 * NEVER offered in-band on any real family, and depth 5 itself only 1.3% of offered candidates,
 * reading worse than every depth-2/3 line it competed with.
 *
 * RULING K7: `segmentClauses`'s `wearFactCloses` parameter reintroduced exactly the
 * position-dependent boundary RULING K1 removed — review I1 (MINOR 4) measured that whether the
 * writer's OWN `join:` gate catches a lying pool<->relation pairing depended on WHERE a wear-fact
 * unit sat relative to that pairing (grammar-legal at the start, middle, or end — S2 restricts
 * NEIGHBOURS, never position). The fix: `wearFactCloses` is no longer read by the truth walk at
 * all — the wear-fact unit is excluded from every cross-unit claim span (the SAME treatment K2
 * gives the identity unit, for the same reason: `validateGrammar`'s S2/relation rules already
 * refuse ANY list- or relation-join onto a wear-fact unit, so its own truth is a closed,
 * position-independent question before this walk ever runs). "Prove it by the property, not a
 * case": all four positions below refuse for the SAME underlying reason via the writer's OWN gate,
 * never only the downstream tail.
 */
import { describe, it, expect } from 'vitest'
import {
  judgeWriterArrangement, renderArrangement, validateArrangement, buildAdmittedUnits,
  enumerateWriterCandidates, type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import type { BlankSpecRow } from '@/lib/fba/blankSpecs'

const NEVER: RegExp = /(?!)/
function truthCtxFor(fit: string, material: string): PhraseTruthCtx {
  return { garmentFamily: 'sweatshirt', spec: { material, fit, weightNote: null } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
}
function blankFor(fit: string, material: string): BlankSpecRow {
  return { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit, material } as never, styleCode: '18000', garmentFamily: 'sweatshirt' } as unknown as BlankSpecRow
}

// ─── RULING K5 ──────────────────────────────────────────────────────────────────────────────────

describe('K5: the search never offers a relation clause deeper than 5 spec-fact units', () => {
  it('6 admitted spec facts, short enough that a 6-deep relation clause fits the length band (the shape review I1 confirmed the pre-fix cap of 6 DOES reach): no offered candidate carries more than 5', () => {
    const truthCtx = truthCtxFor('Classic', 'X')
    const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: blankFor('Classic', 'X'), truthCtx, capacityFamily: false, site: 'k5-test' })
    const facts = ['Crew Neck', 'Long Sleeve', 'Cuffs', 'Seams', 'Label', 'Hem']
    const composed = { candidates: [], specFacts: facts, brandPick: null, brandOrigin: null, wearFact: null, needBrand: false } as never
    const admitted: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: 'Every Day Gratitude Gift Sweatshirt Design', truthCtx })
    const res = enumerateWriterCandidates(admitted, { truthCtx, runTail, needBrand: false })
    expect(res.evaluated, 'the family must reach the search at all for this pin to mean anything').toBeGreaterThan(0)
    expect(res.candidates.length, 'the family must actually offer candidates for this pin to mean anything').toBeGreaterThan(0)
    for (const c of res.candidates) {
      const factsInLine = facts.filter((f) => c.line.includes(f)).length
      expect(factsInLine, c.line).toBeLessThanOrEqual(5)
    }
  })
})

// ─── RULING K7 ──────────────────────────────────────────────────────────────────────────────────

describe('K7: the wear fact\'s isolation from a cross-unit claim is a function of its KIND, never its position', () => {
  const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
  const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: blankFor('Classic', '50% Cotton / 50% Polyester'), truthCtx, capacityFamily: false, site: 'k7-test' })
  const jctx = { truthCtx, runTail, needBrand: false }
  const units: AdmittedUnit[] = [
    { id: 'id', text: 'Every Day Gratitude Gift', kind: 'identity', numberable: false },
    { id: 'R', text: 'Relaxed Weekend Layer', kind: 'pool', numberable: false }, // the lie, on a Classic blank
    { id: 'P', text: 'Cute Crewnecks', kind: 'pool', numberable: false },
    { id: 'W', text: 'Can be worn as Oversized', kind: 'wear-fact', numberable: false },
    { id: 'f', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
  ]
  const SHAPES: [string, ArrangementPart[]][] = [
    ['END (the only shape the search emits)',
      [{ unit: 'id' }, { glue: ',' }, { unit: 'R' }, { glue: ',' }, { unit: 'P' }, { glue: ',' }, { glue: 'with' }, { unit: 'f' }, { glue: ',' }, { unit: 'W' }]],
    ['BETWEEN the lying pool unit and the relation (grammar-legal: "," on both sides)',
      [{ unit: 'id' }, { glue: ',' }, { unit: 'R' }, { glue: ',' }, { unit: 'W' }, { glue: ',' }, { unit: 'P' }, { glue: ',' }, { glue: 'with' }, { unit: 'f' }]],
    ['BEFORE the lying pool unit',
      [{ unit: 'id' }, { glue: ',' }, { unit: 'W' }, { glue: ',' }, { unit: 'R' }, { glue: ',' }, { unit: 'P' }, { glue: ',' }, { glue: 'with' }, { unit: 'f' }]],
  ]
  const CONTROL: ArrangementPart[] = [{ unit: 'id' }, { glue: ',' }, { unit: 'R' }, { glue: ',' }, { unit: 'P' }, { glue: ',' }, { glue: 'with' }, { unit: 'f' }]

  it('every wear-fact position is grammar-LEGAL (S2 restricts neighbours, never position)', () => {
    for (const [, parts] of SHAPES) expect(validateArrangement({ parts }, units, false).ok, renderArrangement(parts, units)).toBe(true)
  })

  it('every position REFUSES via the writer\'s OWN `join:` gate — never only the downstream tail — for the SAME underlying reason', () => {
    const messages = new Set<string>()
    for (const [label, parts] of SHAPES) {
      const v = judgeWriterArrangement({ parts }, units, jctx)
      expect(v.ok, `${label}: ${JSON.stringify(v)}`).toBe(false)
      if (!v.ok) {
        expect(v.violations[0], label).toMatch(/^join: /) // the writer's OWN span-truth gate, not a tail message
        messages.add(v.violations[0])
      }
    }
    expect(messages.size, `positions disagreed on the reason: ${JSON.stringify([...messages])}`).toBe(1)
  })

  it('the control (no wear fact at all) refuses identically — the wear fact\'s presence/position changes nothing about the underlying pairing', () => {
    const v = judgeWriterArrangement({ parts: CONTROL }, units, jctx)
    const vEnd = judgeWriterArrangement({ parts: SHAPES[0][1] }, units, jctx)
    expect(v.ok).toBe(false)
    expect(vEnd.ok).toBe(false)
    if (!v.ok && !vEnd.ok) expect(v.violations[0]).toEqual(vEnd.violations[0])
  })

  it('mutation check: a genuinely wear-fact-ELIGIBLE family (Comfort Colors + an admitted "oversized" pool phrase) still ships the wear fact, standing alone, unaffected — K7 must not cost the sanctioned pattern', () => {
    const ccTruthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Relaxed', brand: 'Comfort Colors' } as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
    const ccBlank = { match: NEVER, spec: { brand: 'Comfort Colors', brandInCopy: true, fit: 'Relaxed', material: '100% Ring-Spun Cotton' } as never, styleCode: '1717', garmentFamily: 'tee' } as unknown as BlankSpecRow
    const ccRunTail = (l: string) => runIhTail(l, { titles: ['THE CEO Vintage Graphic Comfort Colors Shirt'], blankBrand: ccBlank, truthCtx: ccTruthCtx, capacityFamily: false, site: 'k7-wearfact' })
    const composed = { candidates: ['Cute Summer Tops', 'Vintage Graphic Tees'], specFacts: ['100% Ring-Spun Cotton', 'Relaxed Fit'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: 'Can be worn as Oversized' } as never
    const admitted: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: 'Dear Queen Gift', truthCtx: ccTruthCtx })
    const wearUnit = admitted.find((u) => u.kind === 'wear-fact')
    expect(wearUnit, JSON.stringify(admitted)).toBeDefined()
    const res = enumerateWriterCandidates(admitted, { truthCtx: ccTruthCtx, runTail: ccRunTail, needBrand: false })
    expect(res.evaluated).toBeGreaterThan(0)
    const withWear = res.candidates.filter((c) => c.line.includes('Can be worn as Oversized'))
    expect(withWear.length, JSON.stringify(res.candidates.map((c) => c.line))).toBeGreaterThan(0)
  })
})
