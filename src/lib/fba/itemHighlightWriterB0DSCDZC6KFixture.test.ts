/**
 * itemHighlightWriterB0DSCDZC6KFixture.test.ts — RULING I6 (round I) landed this fixture; RULING K4
 * (round K1, phase-k1-rulings.md, Important) REBUILT its contents.
 *
 * WHY THIS EXISTS. Three rounds (F1, G1, H1) measured writer acceptance on "the live-shaped
 * B0DSCDZC6K family" from a scratch directory that lived in a PRIOR session, never committed, so
 * no later round or reviewer could re-run the exact same measurement. RULING I6 landed a committed
 * fixture for this — but review I1 (IMPORTANT 2) found it synthetic under the live ASIN (invented
 * design names, invented pool, invented blank) for the THIRD time. RULING K4 rebuilt it from what
 * is actually recorded: the PO's own design keys/names for this session (correcting two live
 * typos), the pool named verbatim by the PO's own live shadow run (`phase-f1-report.md` §0), and
 * the blank the ruling states (Gildan 18000, 50/50 crewneck, Classic fit, lean_female). Design key
 * `BB` ("Business B*tch") is recorded as SKIP AT ADMISSION (1 admitted unit only) and is therefore
 * omitted from `designs` rather than given an invented pool — see the fixture's own `note`/`omitted`
 * fields for exactly which values are sourced vs. structurally derived.
 */
import { describe, it, expect } from 'vitest'
import { buildAdmittedUnits, enumerateWriterCandidates, runWriterForDesign, type AdmittedUnit } from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import type { PhraseTruthCtx } from '@/lib/fba/contentTruth'
import fixture from './__fixtures__/b0dscdzc6k-item-highlights-2026-09-23.json'

function stubPickOneClient() {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ pick: 1 }) }, finish_reason: 'stop' }] }) } } } as never
}

describe('RULING K4 fixture: the committed B0DSCDZC6K family, rebuilt from recorded artefacts (PO design names/typo-corrections, the live shadow run\'s own pool, the ruling\'s own blank)', () => {
  it('the fixture itself has 5 distinct design keys (BB is recorded SKIP-AT-ADMISSION and omitted, never invented), each with a non-empty pool', () => {
    expect(fixture.designs.length).toBe(5)
    const keys = new Set(fixture.designs.map((d) => d.designKey))
    expect(keys.size).toBe(5)
    expect(keys.has('BB')).toBe(false)
    for (const d of fixture.designs) expect(d.pool.length).toBeGreaterThan(0)
  })

  const truthCtxBase: PhraseTruthCtx = {
    garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never,
    allowedBrand: fixture.blank.brandInCopy ? fixture.blank.brand : null,
    audience: 'adult',
    audienceLean: fixture.blank.audienceLean as 'women',
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

  it('at least 4 of 5 measurable designs accept — RULING I2\'s 4-of-6 floor, adjusted for the ONE design (BB) this fixture cannot measure at all (it never reaches the writer — SKIP at admission)', async () => {
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
    expect(accepted, `only ${accepted} of 5 measurable designs accepted — below RULING I2's floor`).toBeGreaterThanOrEqual(4)
  })
})
