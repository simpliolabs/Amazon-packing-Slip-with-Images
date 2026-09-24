/**
 * itemHighlightWriterFixRoundK1.test.ts — `.superpowers/sdd/2026-09-10-ih-writer/phase-k1-
 * rulings.md`, RULINGS K1 AND K2 ONLY (K3-K7 land in a separate commit/file).
 *
 * WHAT PROMPTED THIS ROUND. Review I1 (BLOCKING 1) measured that `contentTruth.ts`'s `FIT_CLAIM_RE`
 * has its own lazy guard that stops the first time it meets a SECOND fit-class word — so once
 * RULING I1 made the truth clause span the whole pool/relation run, a CONTIGUOUS rendered span
 * (P4's own mechanic) that drags in an intervening fit-class unit shields whichever claim comes
 * FIRST in the text from ever being examined. Move the intervening unit and the OTHER claim gets
 * shielded instead:
 *   LYING-FIRST (103c) "…, Relaxed Weekend Layer, Classic Cozy Comfort Vibes, with Unisex Fit"
 *     -> pre-fix: ACCEPTED, reaches the push seam ok
 *   TRUE-FIRST  (103c) "…, Classic Cozy Comfort Vibes, Relaxed Weekend Layer, with Unisex Fit"
 *     -> REFUSED: fit/cut claim
 * At scale (review I1 §(iv), `b2-breakdown.ts`), 10,816 TRUTH divergences over 1.9M within-family
 * permutation pairs, 182 of them PURE ORDER (same glue spelling, units permuted only).
 *
 * THE FIX THIS FILE PINS.
 *   RULING K1 (Blocking, the class fix, stated as a PROPERTY): the verdict for an arrangement must
 *   be a function of the unit MULTISET, never the order units appear in, the punctuation between
 *   them, or which unit sits in the middle. Mechanic (a): judge every unordered PAIR of
 *   claim-eligible units, in BOTH orders, rendered with NOTHING between them (so no intervening
 *   unit can ever shield a claim), PLUS the clause's full claim-eligible set rendered once more in
 *   a CANONICAL (unit-id) order, for an N-ary claim only visible across 3+ units.
 *   RULING K2 (Blocking, a regression RULING I1 caused): `identity` units are TRUTH-INERT IN
 *   COMBINATION (spec §2g: the identity is a PERSONA) — their own truth is already checked
 *   standalone at admission, so they take no part in any cross-unit span. Before this fix, 20 of 72
 *   fit-word-named families (e.g. "Classic Mom Era" on a Relaxed blank) offered ZERO candidates,
 *   because the widened truth clause bound the design NAME's own fit word to a trailing spec fact.
 *
 * REPRODUCED FIRST at `a78ef2a` (pre-K1), pasted in `phase-k1-report.md`:
 *   LYING-FIRST -> ACCEPTED, ok at the push seam | TRUE-FIRST -> REFUSED
 *   design names carrying a fit word: offered=381 HOLD=20 of 72 (control: offered=492 HOLD=0)
 * — the exact escapes this file's tests pin closed (RED before this round's fix, GREEN after,
 * mutation-proven: reverting the fix reproduces the pre-fix numbers verbatim).
 *
 * `phraseTruthVerdict`/`ihLineTruthVerdict` and every shared composer predicate are OUT OF BOUNDS
 * this round — the fix lives entirely on the writer's side of the call
 * (`judgeWriterArrangement`'s own span construction). Flag-off output must stay byte-identical.
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

const NEVER: RegExp = /(?!)/
const BLANK = (fit: string, material: string): BlankSpecRow => ({
  match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit, material } as never, styleCode: '18000', garmentFamily: 'sweatshirt',
} as unknown as BlankSpecRow)
function truthCtxFor(fit: string, material: string): PhraseTruthCtx {
  return { garmentFamily: 'sweatshirt', spec: { material, fit } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
}
function runTailFor(truthCtx: PhraseTruthCtx) {
  return (l: string) => runIhTail(l, { titles: [], blankBrand: BLANK(truthCtx.spec!.fit as string, truthCtx.spec!.material as string), truthCtx, capacityFamily: false, site: 'k1-test' })
}

// ─── RULING K1's own pin: the reviewer's exact LYING-FIRST/TRUE-FIRST fitword-shield pair ─────────

describe('K1 (Blocking, the class fix): the fitword-shield pair (review I1 BLOCKING 1) now BOTH refuse, and the search offers ZERO', () => {
  const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
  const runTail = runTailFor(truthCtx)
  const jctx = { truthCtx, runTail, needBrand: false }
  const units: AdmittedUnit[] = [
    { id: 'id', text: 'Every Day Gratitude Gift', kind: 'identity', numberable: false },
    { id: 'gh', text: 'Sweatshirt', kind: 'garment-head', numberable: false },
    { id: 'R', text: 'Relaxed Weekend Layer', kind: 'pool', numberable: false },
    { id: 'C', text: 'Classic Cozy Comfort Vibes', kind: 'pool', numberable: false },
    { id: 'f', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
  ]
  const mk = (a: string, b: string): ArrangementPart[] => [
    { unit: 'id' }, { unit: 'gh' }, { glue: ',' }, { unit: a }, { glue: ',' }, { unit: b },
    { glue: ',' }, { glue: 'with' }, { unit: 'f' },
  ]
  const LYING_FIRST = mk('R', 'C')
  const TRUE_FIRST = mk('C', 'R')

  it('both orderings render to the SAME length (103c) — length is never the confound', () => {
    expect(renderArrangement(LYING_FIRST, units).length).toBe(103)
    expect(renderArrangement(TRUE_FIRST, units).length).toBe(103)
  })

  it('LYING-FIRST (the true "Classic" claim sits BETWEEN the lying "Relaxed" claim and "Fit") now REFUSES — pre-fix this was ACCEPTED and reached the push seam ok', () => {
    const v = judgeWriterArrangement({ parts: LYING_FIRST }, units, jctx)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) {
      expect(v.violations.join(' ')).toMatch(/fit\/cut claim/)
      expect(ihLineTruthVerdict('Relaxed Weekend Layer and Classic Cozy Comfort Vibes with Unisex Fit', truthCtx).ok).toBe(true) // the RAW oracle's own laundering, unchanged — the fix is on the writer's SPAN CONSTRUCTION, not the oracle
    }
  })

  it('TRUE-FIRST refuses for the SAME reason — unchanged by this round', () => {
    const v = judgeWriterArrangement({ parts: TRUE_FIRST }, units, jctx)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/fit\/cut claim/)
  })

  it('neither ordering reaches ihLineTruthVerdict/classifyStoredIhLine as an accepted value', () => {
    for (const parts of [LYING_FIRST, TRUE_FIRST]) {
      const v = judgeWriterArrangement({ parts }, units, jctx)
      expect(v.ok).toBe(false)
      if (v.ok) { expect(ihLineTruthVerdict(v.value, truthCtx).ok).toBe(false); expect(classifyStoredIhLine(v.value)).not.toBe('ok') }
    }
  })

  it('the REAL search on this exact family, EITHER pool rank order, now offers ZERO candidates — pre-fix, ranking the shield phrase above the lie offered 8 of 8', () => {
    for (const pool of [['Relaxed Weekend Layer', 'Classic Cozy Comfort Vibes'], ['Classic Cozy Comfort Vibes', 'Relaxed Weekend Layer']]) {
      const composed = { candidates: pool, specFacts: ['Unisex Fit'], brandPick: null, brandOrigin: null, wearFact: null, needBrand: false } as never
      const admitted: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: 'Every Day Gratitude Gift', truthCtx })
      const res = enumerateWriterCandidates(admitted, jctx)
      expect(res.evaluated, JSON.stringify(pool)).toBeGreaterThan(0)
      expect(res.candidates.length, JSON.stringify({ pool, candidates: res.candidates.map((c) => c.line) })).toBe(0)
    }
  })
})

// ─── K1 property: a from-scratch permutation sweep, over a domain with TWO OR MORE fit-class units
//     (the exact domain review I1 named as the one the committed I1 pin's own domain could not see)
//     — PURE ORDER divergences must be ZERO ─────────────────────────────────────────────────────────

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]]
  const out: T[][] = []
  xs.forEach((x, i) => { for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]) })
  return out
}

describe('K1 property: PURE ORDER divergences = 0 over a domain where 2+ pool units carry a fit-class word (the class review I1\'s own committed pin could not see)', () => {
  const POOL_VOCAB = ['Relaxed Weekend Layer', 'Classic Crewneck Sweatshirts', 'Slim Cozy Pullover', 'Oversized Cozy Layer', 'Fall Graphic Crewneck Sweatshirts', 'Cute Crewnecks'] as const
  const FITS = ['Classic', 'Relaxed'] as const
  const MATERIAL = '50% Cotton / 50% Polyester'

  const classify = (v: ReturnType<typeof judgeWriterArrangement>): string => {
    if (v.ok) return 'ACCEPT'
    const m = v.violations.join(' | ')
    if (/^arrangement:/.test(m)) return 'GRAMMAR'
    if (/rendered \d+ chars/.test(m)) return 'BAND'
    if (/appears \d+ times/.test(m)) return 'REPEAT'
    return 'TRUTH'
  }

  it('sweep', () => {
    let pureOrderDivergences = 0
    let familiesSwept = 0
    const samples: string[] = []
    for (const fit of FITS) {
      for (let i = 0; i < POOL_VOCAB.length; i++) {
        for (let j = i + 1; j < POOL_VOCAB.length; j++) {
          const truthCtx = truthCtxFor(fit, MATERIAL)
          const runTail = runTailFor(truthCtx)
          const jctx = { truthCtx, runTail, needBrand: false }
          const composed = { candidates: [POOL_VOCAB[i], POOL_VOCAB[j]], specFacts: ['Unisex Fit'], brandPick: null, brandOrigin: null, wearFact: null, needBrand: false } as never
          const admitted: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: 'Every Day Gratitude Gift', truthCtx })
          const identity = admitted.find((u) => u.kind === 'identity')!
          const poolUnits = admitted.filter((u) => u.kind === 'pool')
          const factUnit = admitted.find((u) => u.kind === 'spec-fact')!
          if (poolUnits.length < 2) continue
          familiesSwept++
          const arms = permutations(poolUnits).map((order) => {
            const parts: ArrangementPart[] = [{ unit: identity.id }]
            order.forEach((u) => parts.push({ glue: ',' }, { unit: u.id }))
            parts.push({ glue: ',' }, { glue: 'with' }, { unit: factUnit.id })
            return { order: order.map((u) => u.id).join('>'), v: judgeWriterArrangement({ parts }, admitted, jctx) }
          })
          for (let a = 0; a < arms.length; a++) {
            for (let b = a + 1; b < arms.length; b++) {
              const ca = classify(arms[a].v), cb = classify(arms[b].v)
              if (ca === cb) continue
              if (ca !== 'TRUTH' && ca !== 'ACCEPT') continue
              if (cb !== 'TRUTH' && cb !== 'ACCEPT') continue
              pureOrderDivergences++
              if (samples.length < 4) samples.push(`fit=${fit} pool=[${POOL_VOCAB[i]}|${POOL_VOCAB[j]}] ${arms[a].order}=${ca} vs ${arms[b].order}=${cb}`)
            }
          }
        }
      }
    }
    expect(familiesSwept, 'the sweep generated zero comparable families — the domain may have drifted').toBeGreaterThan(5)
    expect(pureOrderDivergences, `PURE ORDER divergences found (must be 0):\n${samples.join('\n')}`).toBe(0)
  })
})

// ─── RULING K2's own pin: a design NAME carrying a fit-class word must not zero out the offered set ─

describe('K2 (Blocking, a regression RULING I1 caused): a fit-word-NAMED design offers candidates exactly like its clean-named twin — never a HOLD caused by the design\'s own name', () => {
  const POOL = ['Fall Graphic Crewneck Sweatshirts', 'Cute Crewnecks', 'Cozy Autumn Pullover']
  const FACTS = ['Unisex Fit']

  for (const [fitWordDesign, cleanDesign] of [
    ['Classic Mom Era', 'Dear Queen Gift'],
    ['Relaxed Vibes Club', 'Every Day Gratitude Gift'],
  ] as const) {
    it(`"${fitWordDesign}" offers the SAME candidate count as its clean-named twin "${cleanDesign}" (both on a Classic blank, neither pool phrase carries a fit word)`, () => {
      const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
      const runTail = runTailFor(truthCtx)
      const jctx = { truthCtx, runTail, needBrand: false }
      const composed = { candidates: [...POOL], specFacts: [...FACTS], brandPick: null, brandOrigin: null, wearFact: null, needBrand: false } as never

      const fwUnits = buildAdmittedUnits(composed, { designName: fitWordDesign, truthCtx })
      const clUnits = buildAdmittedUnits(composed, { designName: cleanDesign, truthCtx })
      const fwRes = enumerateWriterCandidates(fwUnits, jctx)
      const clRes = enumerateWriterCandidates(clUnits, jctx)

      expect(fwRes.candidates.length, `"${fitWordDesign}" HELD (0 offered) — pre-fix regression: RULING I1 bound the design NAME's own fit word to the trailing spec fact`).toBeGreaterThan(0)
      expect(clRes.candidates.length, `clean-named twin "${cleanDesign}" unexpectedly held too — the domain may have drifted`).toBeGreaterThan(0)
    })
  }

  it('the identity unit itself is EXCLUDED from every cross-unit claim span: a fit-word design name paired with a genuinely UNBACKED fit claim in the pool still refuses on the POOL PAIRING, never on the identity', () => {
    // "Relaxed Vibes Club" (identity, carries "relaxed") + "Classic Crewneck Sweatshirts" (pool,
    // carries "classic") + "Unisex Fit" (spec-fact) on a RELAXED blank: the identity's own claim
    // ("relaxed...") is TRUE for this blank and inert in combination; the pool phrase's claim
    // ("classic...fit") is a real lie against a Relaxed blank and must still be caught.
    const truthCtx = truthCtxFor('Relaxed', '50% Cotton / 50% Polyester')
    const runTail = runTailFor(truthCtx)
    const jctx = { truthCtx, runTail, needBrand: false }
    const composed = { candidates: ['Classic Crewneck Sweatshirts', 'Cute Crewnecks'], specFacts: ['Unisex Fit'], brandPick: null, brandOrigin: null, wearFact: null, needBrand: false } as never
    const units = buildAdmittedUnits(composed, { designName: 'Relaxed Vibes Club', truthCtx })
    const parts: ArrangementPart[] = [
      { unit: units.find((u) => u.kind === 'identity')!.id }, { glue: ',' },
      { unit: units.find((u) => u.text === 'Classic Crewneck Sweatshirts')!.id }, { glue: ',' },
      { unit: units.find((u) => u.text === 'Cute Crewnecks')!.id }, { glue: ',' }, { glue: 'with' },
      { unit: units.find((u) => u.kind === 'spec-fact')!.id },
    ]
    const v = judgeWriterArrangement({ parts }, units, jctx)
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/fit\/cut claim/)
  })

  it('mutation check: the pairing K2\'s exclusion keeps OUT of the cross-unit walk is a REAL lie were it ever examined — proves the fix is a genuine exclusion, never a coincidental non-trigger', () => {
    // Cannot literally revert production code from a test; instead proves the MECHANISM: a bare
    // pairing of the fit-word IDENTITY text against the trailing spec fact, run through the SAME
    // `phraseTruthVerdict` the writer calls, IS refused on a mismatched blank (the connector word
    // does not matter to `FIT_CLAIM_RE`) — so K2's exclusion is doing real work, not merely failing
    // to trigger by accident.
    const truthCtx = truthCtxFor('Classic', '50% Cotton / 50% Polyester')
    expect(phraseTruthVerdict('Relaxed Vibes Club with Unisex Fit', truthCtx)).toEqual({ ok: false, reason: 'fit-claim-lie' })
    // and it is BACKED (no violation) on the blank it actually names, proving the pairing is a
    // genuine truth predicate outcome, not a constant refusal:
    expect(phraseTruthVerdict('Relaxed Vibes Club with Unisex Fit', truthCtxFor('Relaxed', '50% Cotton / 50% Polyester'))).toEqual({ ok: true })
  })
})
