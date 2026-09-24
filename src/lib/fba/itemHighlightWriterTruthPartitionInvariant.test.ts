/**
 * itemHighlightWriterTruthPartitionInvariant.test.ts — RULING M3 (round M, phase-m1-rulings.md,
 * Blocking — "this is the fourth time"). Review `phase-l1-review-truth.md` IMPORTANT 1 proved that
 * RULING L1's own fix (`itemHighlightWriter.ts:1110`) has **no committed pin**: reverting it to a
 * bare `close()` leaves the WHOLE `src/lib/fba` suite (126 files, 2,995 tests + 7 expected fails)
 * byte-identically green, while the same revert measures 1,451,072 ACCEPT-vs-TRUTH divergences and
 * 3,144 false lines `ok` at the push seam (`r1-partition.ts`, `.../scratchpad/writer/l1-truth/`).
 * The committed sweep at the time (`itemHighlightWriterFixRoundK1.test.ts:132-186`) always puts the
 * pool BEFORE the relation clause, so it cannot express the class the L1 fix closes — "a domain in
 * which the next instance cannot exist" (memory `net-idempotence-gate-ships-unremovable-lies`).
 *
 * THIS FILE is that pin, and it is the review's own "cheaper and stronger" form: rather than
 * re-running the full judge (grammar + tail + truth) on every arrangement, it calls `segmentClauses`
 * DIRECTLY with the truth walk's own `closers` policy (an empty set — `TRUTH_CLAUSE_CLOSERS` is
 * module-private, so this test passes the identical literal, `new Set<string>()`, which is what the
 * truth walk itself is constructed with at itemHighlightWriter.ts:1444) and asserts the single
 * structural fact RULING L1 exists to make true: over EVERY grammar-legal arrangement (as
 * `validateArrangement` — the SAME function `judgeWriterArrangement` calls — admits it), the truth
 * clause count is exactly 1, never 2+. The domain WIDENS the prior sweep exactly along the axis K1-
 * truth's BLOCKING 1 needed: every split point of the pool multiset across the relation clause (k
 * pool units BEFORE it, the rest AFTER), not only "pool always before".
 *
 * THIS TEST MUST FAIL — RED — if `itemHighlightWriter.ts:1110`'s
 *   `if (closers.has(part.glue)) { close(); return }`
 * is reverted to a bare `close()` (i.e. the truth walk closes a clause on EVERY comma inside an open
 * relation, not only when its OWN `closers` set says so). Mutation-proved for this exact revert,
 * 2026-09-24 (copy-aside / edit / run / restore-by-copy, `git stash` never used): MAX truth clauses
 * over this file's own domain goes from 1 to 2, with the same "pool unit after the relation" shape
 * `r1-partition.ts` names (e.g. "Every Day Gratitude Gift, with Unisex Fit, Long Sleeve, Relaxed
 * Weekend Layer, Classic Crewneck Sweatshirts, Cute Crewnecks" segments into TWO truth clauses
 * instead of one). See `phase-m1-report.md` for the executed RED/GREEN transcript.
 */
import { describe, it, expect } from 'vitest'
import {
  buildAdmittedUnits, segmentClauses, validateArrangement, renderArrangement,
  type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'
import type { PhraseTruthCtx } from '@/lib/fba/contentTruth'

// Same 8 pool sets / 2 fact sets / 3 fits / 2 designs as the reviewer's own `r1-partition.ts` —
// every pool set carries two-or-more fit/weight/material-class units, which is what makes the
// audience-lean/fit-claim truth rule reachable at all.
const POOL_SETS: string[][] = [
  ['Relaxed Weekend Layer', 'Classic Crewneck Sweatshirts', 'Cute Crewnecks'],
  ['Slim Cozy Pullover', 'Regular Everyday Layer', 'Cozy Autumn Pullover'],
  ['Oversized Cozy Layer', 'Classic Crewneck Sweatshirts', 'Fall Crewneck'],
  ['Midweight Fleece Feel', 'Heavyweight Winter Staple', 'Cute Crewnecks'],
  ['Soft Poly Feel', '100% Awesome Vibes', 'Cozy Autumn Pullover'],
  ['Relaxed Weekend Layer', 'Midweight Fleece Feel', 'Classic Crewneck Sweatshirts'],
  ['Boxy Everyday Pick', 'Slim Cozy Pullover', 'Fall Crewneck'],
  ['Lightweight Layer Pick', 'Heavyweight Winter Staple', 'Cute Crewnecks'],
]
const FACT_SETS: string[][] = [['Unisex Fit', 'Long Sleeve'], ['Crew Neck', 'Unisex Fit']]
const FITS = ['Classic', 'Relaxed', 'Oversized']
const MATERIAL = '50% Cotton / 50% Polyester'
const DESIGNS = ['Every Day Gratitude Gift', 'Relaxed Vibes Club']
const LIST_GLUE = [',', 'and', '&']

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]]
  const out: T[][] = []
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest])
  })
  return out
}
function glueTuples(k: number, alphabet: readonly string[]): string[][] {
  if (k <= 0) return [[]]
  const out: string[][] = []
  for (const rest of glueTuples(k - 1, alphabet)) for (const g of alphabet) out.push([g, ...rest])
  return out
}

interface Built { family: string; parts: ArrangementPart[]; units: readonly AdmittedUnit[]; poolAfterRelation: boolean }

/** Every grammar-legal arrangement, over every split of the pool multiset across the relation
 *  clause, for the domain above. Filtered through `validateArrangement` — the SAME grammar gate
 *  `judgeWriterArrangement` runs before it ever reaches the truth walk — so every entry here is one
 *  the real judge would also consider, never a shape the grammar itself would already refuse. */
function buildDomain(): Built[] {
  const out: Built[] = []
  for (const fit of FITS) for (const pool of POOL_SETS) for (const facts of FACT_SETS) for (const design of DESIGNS) {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: MATERIAL, fit, brand: 'Gildan' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const composed = { candidates: pool, specFacts: [...facts], brandPick: null, brandOrigin: null, wearFact: null, needBrand: false } as never
    const admitted: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: design, truthCtx })
    const identity = admitted.find((u) => u.kind === 'identity')
    const poolUnits = admitted.filter((u) => u.kind === 'pool' && !u.isBrand)
    const factUnits = admitted.filter((u) => u.kind === 'spec-fact')
    if (!identity || poolUnits.length < 2 || factUnits.length < 1) continue
    const n = poolUnits.length
    const familyKey = `${fit}|${pool.join('/')}|${facts.join('/')}|${design}`
    for (const poolOrder of permutations(poolUnits)) {
      for (let split = 0; split <= n; split++) {
        const before = poolOrder.slice(0, split)
        const after = poolOrder.slice(split)
        const joins = Math.max(0, before.length - 1) + Math.max(0, after.length - 1)
        for (const glues of glueTuples(joins, LIST_GLUE)) {
          for (const factOrder of permutations(factUnits)) {
            for (const rel of ['with', 'in'] as const) {
              let gi = 0
              const parts: ArrangementPart[] = [{ unit: identity.id }]
              before.forEach((u, k) => { parts.push({ glue: k === 0 ? ',' : glues[gi++] }); parts.push({ unit: u.id }) })
              parts.push({ glue: ',' }, { glue: rel })
              parts.push({ unit: factOrder[0].id })
              for (let k = 1; k < factOrder.length; k++) parts.push({ glue: ',' }, { unit: factOrder[k].id })
              after.forEach((u, k) => { parts.push({ glue: k === 0 ? ',' : glues[gi++] }); parts.push({ unit: u.id }) })
              const v = validateArrangement({ parts }, admitted)
              if (!v.ok) continue
              out.push({ family: familyKey, parts, units: admitted, poolAfterRelation: after.length > 0 })
            }
          }
        }
      }
    }
  }
  return out
}

describe('RULING M3 — the truth walk\'s clause count is a function of the unit MULTISET, never of where a pool unit falls relative to the relation clause', () => {
  it('is NON-VACUOUS and WIDENS the prior sweep along the exact axis K1-truth BLOCKING 1 needed: at least one legal arrangement in this domain places a pool unit AFTER the relation clause', () => {
    const domain = buildDomain()
    expect(domain.length).toBeGreaterThan(0)
    const withPoolAfter = domain.filter((d) => d.poolAfterRelation)
    // Every prior committed sweep (itemHighlightWriterFixRoundK1.test.ts:132-186) puts the pool
    // ALWAYS before the relation clause — this is the widened axis, asserted present, not merely
    // assumed by the domain's own construction.
    expect(withPoolAfter.length).toBeGreaterThan(0)
  })

  it('over EVERY grammar-legal arrangement in the domain (thousands, enumerated above — never a hand-picked sample), segmentClauses with the truth walk\'s OWN closers policy (an empty set, matching TRUTH_CLAUSE_CLOSERS at itemHighlightWriter.ts:490) produces EXACTLY ONE clause — MUST fail if :1110 is reverted to a bare close()', () => {
    const domain = buildDomain()
    let maxClauses = 0
    let worstSample: string | null = null
    let checked = 0
    for (const d of domain) {
      const { clauses } = segmentClauses(d.parts, d.units, new Set<string>())
      checked++
      if (clauses.length > maxClauses) {
        maxClauses = clauses.length
        worstSample = `[${d.family}] ${renderArrangement(d.parts, d.units)} -> ${clauses.length} truth clauses`
      }
    }
    // Bounded and reported, never merely asserted: this domain is large (thousands of arrangements
    // across 8 pool sets x 2 fact sets x 3 fits x 2 designs x every split point), so a passing
    // assertion here is a real sweep, not a vacuous one.
    expect(checked).toBeGreaterThan(1000)
    expect(maxClauses, `a partition produced more than one truth clause: ${worstSample}`).toBe(1)
  })
})
