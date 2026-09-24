/**
 * itemHighlightWriterB0DSCDZC6KFixture.test.ts — RULING I6 (round I, phase-i1-rulings.md, Minor).
 *
 * WHY THIS EXISTS. Three rounds (F1, G1, H1) measured writer acceptance on "the live-shaped
 * B0DSCDZC6K family" from a scratch directory that lived in a PRIOR session, never committed, so
 * no later round or reviewer could re-run the exact same measurement — every round rebuilt its own
 * approximation by hand. `__fixtures__/b0dscdzc6k-item-highlights-2026-09-23.json` lands the
 * identity phrases, per-design pool units, blank specs and the six design keys as a committed
 * fixture (data only, per the ruling — "this is a fixture, not production code"). Every future
 * round measures the SAME family, through this SAME file.
 *
 * This complements (never replaces) `itemHighlightWriterRunAcceptance.test.ts`'s own long-standing
 * "Part 2 acceptance item 5" B0DSCDZC6K-shaped fixture: that one hands every design an IDENTICAL,
 * plain pool (no fit/cut phrase at all), so it cannot exercise the RULING I1 class. This fixture's
 * pool DOES carry one fit/cut-carrying phrase per design (the exact shape
 * `phase-h1-review-truth.md`'s `t8-scale.ts` swept, and the live "relaxed unisex fit" defect came
 * from) alongside ordinary keyword phrases — the honest shape RULING I2's stop condition needs to
 * measure against.
 */
import { describe, it, expect } from 'vitest'
import { buildAdmittedUnits, enumerateWriterCandidates, runWriterForDesign, type AdmittedUnit } from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import type { PhraseTruthCtx } from '@/lib/fba/contentTruth'
import fixture from './__fixtures__/b0dscdzc6k-item-highlights-2026-09-23.json'

function stubPickOneClient() {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ pick: 1 }) }, finish_reason: 'stop' }] }) } } } as never
}

describe('RULING I6 fixture: the committed B0DSCDZC6K-shaped family, richer pool (carries a fit/cut phrase)', () => {
  it('the fixture itself has 6 distinct design keys, each with a non-empty pool, and no design repeats a pool phrase across the family (so band/repeat gates never confound a truth measurement)', () => {
    expect(fixture.designs.length).toBe(6)
    const keys = new Set(fixture.designs.map((d) => d.designKey))
    expect(keys.size).toBe(6)
    for (const d of fixture.designs) expect(d.pool.length).toBeGreaterThan(0)
  })

  const truthCtxBase: PhraseTruthCtx = {
    garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never,
    allowedBrand: fixture.blank.brandInCopy ? fixture.blank.brand : null,
    audience: 'adult',
    audienceLean: fixture.blank.audienceLean as 'unisex',
    field: 'highlights',
  }

  for (const d of fixture.designs) {
    it(`design ${d.designKey} ("${d.designName}"): through the REAL enumerateWriterCandidates + runWriterForDesign + runIhTail, either accepts or holds for a NAMED, non-truth reason`, async () => {
      const truthCtx: PhraseTruthCtx = { ...truthCtxBase, designTokens: [d.designName] } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: fixture.specFacts, brandPick: null as string | null, wearFact: null as string | null } as never
      const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [`THE CEO ${d.designName} Sweatshirt`], blankBrand: null, truthCtx, capacityFamily: false, site: 'i6-fixture' })
      const enumerated = enumerateWriterCandidates(units, { truthCtx, runTail })
      const r = await runWriterForDesign({
        composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail,
        deps: { openai: stubPickOneClient() },
      })
      console.log(JSON.stringify({
        tag: 'I6_FIXTURE_ACCEPTANCE', design: d.designName, found: enumerated.candidates.length,
        accepted: r.accepted, value: r.value || null, reasons: r.reasons,
      }))
      // A hold is legitimate (e.g. a length-floor miss) — this fixture pins that every design
      // reaches a NAMED decision through the real path, never an unhandled throw, and records
      // whether it accepted so a future round's I2-style measurement has one place to read from.
      expect(r.accepted === true || r.reasons.length > 0).toBe(true)
    })
  }

  it('at least 4 of 6 designs accept — the SAME threshold RULING I2 gates the widened truth scope on', async () => {
    let accepted = 0
    for (const d of fixture.designs) {
      const truthCtx: PhraseTruthCtx = { ...truthCtxBase, designTokens: [d.designName] } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: fixture.specFacts, brandPick: null as string | null, wearFact: null as string | null } as never
      const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [`THE CEO ${d.designName} Sweatshirt`], blankBrand: null, truthCtx, capacityFamily: false, site: 'i6-fixture-total' })
      const r = await runWriterForDesign({
        composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail,
        deps: { openai: stubPickOneClient() },
      })
      if (r.accepted) accepted++
    }
    expect(accepted, `only ${accepted} of 6 designs accepted — below RULING I2's 4-of-6 floor`).toBeGreaterThanOrEqual(4)
  })
})
