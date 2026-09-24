/**
 * itemHighlightWriterB0DSCDZC6KFixture.test.ts — RULING I6 (round I) landed this fixture; RULING K4
 * (round K1, phase-k1-rulings.md, Important) REBUILT its contents; RULING L2 (round L1,
 * phase-l1-rulings.md, Blocking) corrected its BLANK.
 *
 * WHY THIS EXISTS. Three rounds (F1, G1, H1) measured writer acceptance on "the live-shaped
 * B0DSCDZC6K family" from a scratch directory that lived in a PRIOR session, never committed, so
 * no later round or reviewer could re-run the exact same measurement. RULING I6 landed a committed
 * fixture for this — but review I1 (IMPORTANT 2) found it synthetic under the live ASIN (invented
 * design names, invented pool, invented blank) for the THIRD time. RULING K4 rebuilt the design
 * names and pool from recorded artefacts (the PO's own design keys/names for this session,
 * correcting two live typos, and the pool named verbatim by the PO's own live shadow run,
 * `phase-f1-report.md` §0) — but review K1-value (BLOCKING 1) found the BLANK's own
 * `unisex`/`audienceLean` fields still invented (`unisex: false`, `audienceLean: "women"`),
 * contradicted by this repo's own recorded live artefacts in FOUR places (`contentTruth.ts:3`,
 * `:43`, `:74`; `docs/superpowers/specs/2026-09-05-title-judge-sees-shipped-bytes.md:28`;
 * `audienceAssignment.test.ts:67-76`, "the live B0DSCDZC6K scenario") — and it is the ONE field
 * that decides the accepted-count number: 6 of 6 on the invented lean, 2 of 6 on the recorded one.
 *
 * RULING L2 corrects the blank to the record (`unisex: true`, family `audienceLean: 'unisex'`,
 * `audienceLeanByDesign: { BB: 'female', MHG: 'female' }`, `mixedFamilies: ['sweatshirt','hoodie']`)
 * and RESTORES `BB` ("Business B*tch") as the family's sixth design — K4 omitted it citing an
 * admission measurement taken against the INVENTED name "Bonus Bonus"; with BB's own recorded name
 * it admits 10 units and accepts. The honest result is **2 of 6** (BB, MHG) — below RULING I2's
 * own 4-of-6 STOP floor — because all six live pool phrases are "for Women" phrases and
 * `phraseTruthVerdict`'s forced-gender rule (contentTruth.ts, field='highlights',
 * ctx.audienceLean==='unisex') correctly refuses every one of them for the four designs that
 * inherit the family's unisex default; BB and MHG escape only because their PER-DESIGN lean is
 * 'female'. This is a POOL finding (memory `unisex-lean-vs-a-women-pool-starves-the-field`), never
 * a writer defect — see the fixture's own `note` for the full citation trail.
 */
import { describe, it, expect } from 'vitest'
import { buildAdmittedUnits, enumerateWriterCandidates, runWriterForDesign, type AdmittedUnit } from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { normalizeAudienceLean, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import fixture from './__fixtures__/b0dscdzc6k-item-highlights-2026-09-23.json'

function stubPickOneClient() {
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ pick: 1 }) }, finish_reason: 'stop' }] }) } } } as never
}

// RULING L2: the per-design lean follows the SAME resolver contract listingPipeline's own
// `resolveDesignAudienceLean` uses — a design's OWN override (`audienceLeanByDesign`) wins over the
// family's `audienceLean`, normalized through the shared `normalizeAudienceLean` (never a second,
// hand-rolled female->women mapping in the test).
function leanForDesign(designKey: string): ReturnType<typeof normalizeAudienceLean> {
  const override = fixture.audienceLeanByDesign?.[designKey as keyof typeof fixture.audienceLeanByDesign]
  return normalizeAudienceLean((override ?? fixture.blank.audienceLean) as never)
}

// The two designs the record (audienceAssignment.test.ts:67-76) actually female-codes; the other
// four inherit the family's unisex default and hold on the "for Women" pool.
const ACCEPTS_ON_RECORDED_LEAN = new Set(['BB', 'MHG'])

describe('RULING L2 fixture: the committed B0DSCDZC6K family, BLANK corrected to the record (unisex family, BB+MHG female, sweatshirt+hoodie mixed parent)', () => {
  it('the fixture has 6 distinct design keys including BB (restored — its own recorded name accepts; K4\'s omission measured an invented name), each with a non-empty pool', () => {
    expect(fixture.designs.length).toBe(6)
    const keys = new Set(fixture.designs.map((d) => d.designKey))
    expect(keys.size).toBe(6)
    expect(keys.has('BB')).toBe(true)
    for (const d of fixture.designs) expect(d.pool.length).toBeGreaterThan(0)
  })

  it('the blank matches the record, not an invention: unisex family, sweatshirt+hoodie mixed parent, two female-coded designs', () => {
    expect(fixture.blank.unisex).toBe(true)
    expect(fixture.blank.audienceLean).toBe('unisex')
    expect(fixture.mixedFamilies).toEqual(['sweatshirt', 'hoodie'])
    expect(fixture.audienceLeanByDesign).toEqual({ BB: 'female', MHG: 'female' })
  })

  const truthCtxBase: PhraseTruthCtx = {
    garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never,
    allowedBrand: fixture.blank.brandInCopy ? fixture.blank.brand : null,
    audience: 'adult',
    mixedFamilies: fixture.mixedFamilies as never,
    field: 'highlights',
  }

  for (const d of fixture.designs) {
    const expectAccept = ACCEPTS_ON_RECORDED_LEAN.has(d.designKey)
    it(`design ${d.designKey} ("${d.designName}"): through the REAL enumerateWriterCandidates + runWriterForDesign + runIhTail, ${expectAccept ? 'ACCEPTS' : 'HOLDS on the unisex-family audience-lean rule'}`, async () => {
      const truthCtx: PhraseTruthCtx = { ...truthCtxBase, audienceLean: leanForDesign(d.designKey), designTokens: [d.designName] } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: fixture.specFacts, brandPick: null as string | null, wearFact: null as string | null } as never
      const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [`THE CEO ${d.designName} Sweatshirt`], blankBrand: null, truthCtx, capacityFamily: false, site: 'l2-fixture' })
      const enumerated = enumerateWriterCandidates(units, { truthCtx, runTail })
      const r = await runWriterForDesign({
        composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail,
        deps: { openai: stubPickOneClient() },
      })
      console.log(JSON.stringify({
        tag: 'L2_FIXTURE_ACCEPTANCE', design: d.designName, lean: truthCtx.audienceLean, found: enumerated.candidates.length,
        accepted: r.accepted, value: r.value || null, reasons: r.reasons,
      }))
      // RULING K1-value MINOR 2 / review I1 MINOR 1: the old assertion here
      // (`r.accepted === true || r.reasons.length > 0`) is true for EVERY possible outcome except an
      // unhandled throw, so it could never fail. This pins the ACTUAL per-design outcome the
      // recorded lean produces, so a future change to the writer, the admission gate or the fixture
      // that moves a design across the accept/hold line fails this test instead of passing silently.
      expect(r.accepted).toBe(expectAccept)
      if (expectAccept) {
        expect(r.value.length).toBeGreaterThan(0)
      } else {
        expect(r.value).toBe('')
        expect(r.reasons.length).toBeGreaterThan(0)
      }
    })
  }

  it('2 of 6 designs accept on the RECORDED lean — below RULING I2\'s own 4-of-6 STOP floor, and the cause is the pool (all six live phrases are "for Women"), not the writer', async () => {
    const acceptedKeys: string[] = []
    for (const d of fixture.designs) {
      const truthCtx: PhraseTruthCtx = { ...truthCtxBase, audienceLean: leanForDesign(d.designKey), designTokens: [d.designName] } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: fixture.specFacts, brandPick: null as string | null, wearFact: null as string | null } as never
      const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [`THE CEO ${d.designName} Sweatshirt`], blankBrand: null, truthCtx, capacityFamily: false, site: 'l2-fixture-total' })
      const r = await runWriterForDesign({
        composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail,
        deps: { openai: stubPickOneClient() },
      })
      if (r.accepted) acceptedKeys.push(d.designKey)
    }
    // Not softened, not averaged with the K4 fixture's invented 6-of-6: this is the honest number
    // on the PO's real listing (phase-l1-report.md). Below RULING I2's 4-of-6 floor — filed as a
    // pool-starvation finding, not a writer regression, and NOT to be "fixed" by loosening the
    // audience-lean truth rule this round (that rule is OUT OF BOUNDS — phraseTruthVerdict).
    expect(acceptedKeys.sort(), `accepted designs: ${JSON.stringify(acceptedKeys)}`).toEqual(['BB', 'MHG'])
  })
})
