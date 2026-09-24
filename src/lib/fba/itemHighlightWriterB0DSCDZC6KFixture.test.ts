/**
 * itemHighlightWriterB0DSCDZC6KFixture.test.ts — RULING I6 (round I) landed this fixture; RULING K4
 * (round K1, phase-k1-rulings.md, Important) REBUILT its contents; RULING L2 (round L1,
 * phase-l1-rulings.md, Blocking) corrected its BLANK; RULING M1/M2/M5 (round M, phase-m1-rulings.md,
 * Blocking) correct a SECOND invented field this fixture carried beside the first.
 *
 * WHY THIS EXISTS. Three rounds (F1, G1, H1) measured writer acceptance on "the live-shaped
 * B0DSCDZC6K family" from a scratch directory that lived in a PRIOR session, never committed, so
 * no later round or reviewer could re-run the exact same measurement. RULING I6 landed a committed
 * fixture for this — but review I1 (IMPORTANT 2) found it synthetic under the live ASIN (invented
 * design names, invented pool, invented blank) for the THIRD time. RULING K4 rebuilt the design
 * names and pool from recorded artefacts — but review K1-value (BLOCKING 1) found the BLANK's own
 * `unisex`/`audienceLean` fields still invented, contradicted by this repo's own recorded live
 * artefacts in FOUR places. RULING L2 corrected the blank to the record — but review
 * `phase-l1-review-value.md` (BLOCKING 1) found that correction left a SECOND field, `specFacts`,
 * hardcoded beside it: `["Classic Fit","50% Cotton / 50% Polyester"]`, one fact SHORT of what
 * `ihSpecFactFillers` (`productDetailAttrs.ts:516-533`, the ONE pad bank the live composer reads at
 * `itemHighlightComposer.ts:436`) actually derives from that same blank — `["50% Cotton / 50%
 * Polyester","Classic Fit","Unisex Fit"]`. That missing `Unisex Fit` (11 characters) was the WHOLE
 * difference between a wrongly-reported 2-of-6 and the honest 5-of-6 (four designs' best case with
 * the 2-fact pad measured exactly `96c < 97c` against the accept floor).
 *
 * RULING M1's remedy, applied here: `specFacts` is no longer a field this fixture carries at all.
 * This test derives it by calling `ihSpecFactFillers` directly, exactly as the live composer does,
 * so it structurally cannot drift from the blank a third time. RULING M5 adds `titleTemplate`
 * (the recorded live title shape — the title decides the number, and no title was recorded before)
 * and records the `mixedFamilies` decision: kept as documentation of the record, but NOT threaded
 * into this test's `truthCtx`, because the live Item Highlights path has no such field yet (a real
 * gap, filed, not fixed this round — see the fixture's own `note`).
 *
 * THE CORRECTED RESULT (RULING M2 — the mechanism, restated correctly). Five of the pool's six
 * phrases are gendered ("for Women") and are correctly refused by `phraseTruthVerdict`'s
 * forced-gender rule for the four designs that inherit the family's unisex default — every real
 * composer run logs `truthDrops: {"audience-lean-lie":5}`, never 6. The sixth, `Fall Crewneck`,
 * names no gender, is admitted, and carries the rank-1 line of FIVE of the six designs. **5 of 6
 * designs accept** — BB, BCSG, EDG, HDG, MHG — above RULING I2's own 4-of-6 STOP floor. The one
 * hold, DQG ("Don't Quit"), is NOT a gender refusal: it is the family's shortest design name, and
 * its entire admitted unit multiset sums to 94 characters against the 97-character accept floor, so
 * the bounded search never evaluates a single arrangement. This remains a POOL finding (memory
 * `unisex-lean-vs-a-women-pool-starves-the-field` — a unisex lean against a mostly-gendered pool),
 * never a writer defect — see the fixture's own `note` for the full citation trail and the
 * BEFORE/AFTER numbers.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { buildAdmittedUnits, enumerateWriterCandidates, runWriterForDesign, humanizeAdmittedUnits, isHumanizerEligible, type AdmittedUnit } from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { normalizeAudienceLean, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import { ihSpecFactFillers } from '@/lib/fba/productDetailAttrs'
import { titleCasePhrase } from '@/lib/fba/titleBand'
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

// RULING M1: DERIVED from the fixture's own blank by the ONE pad bank the live composer reads
// (`ihSpecFactFillers`, `productDetailAttrs.ts:516-533`) — never a second, hand-typed array that can
// drift from the blank the way the fixture's own hardcoded `specFacts` field drifted twice (K4's
// `unisex: false` masked it as a set-equal coincidence; L2's `unisex: true` correction exposed it).
const SPEC_FACTS: readonly string[] = ihSpecFactFillers({
  material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex,
} as never).map(titleCasePhrase)

// RULING M5: the family's own RECORDED live title shape
// (docs/superpowers/specs/2026-09-05-title-judge-sees-shipped-bytes.md:28-31), never a hand-invented
// title constant — the title decides the accepted count (a title carrying both "Fall" and
// "Crewneck" title-dedupes the pool's only ungendered phrase and drops the family to 2 of 6).
const titleFor = (designName: string): string => fixture.titleTemplate.replace('{design}', designName)

// RULING M1/M2: with `specFacts` correctly DERIVED (never hardcoded), 5 of 6 designs accept on the
// recorded lean — BB and MHG on their per-design female override, BCSG/EDG/HDG because the derived
// pad's third fact (`Unisex Fit`) is what clears the 97-character floor on the unisex default. DQG
// alone holds, on a floor-vs-name-length problem, not a gender refusal (see the module doc comment).
const ACCEPTS_ON_RECORDED_LEAN = new Set(['BB', 'BCSG', 'EDG', 'HDG', 'MHG'])

describe('RULING M1/M2 fixture: the committed B0DSCDZC6K family, specFacts DERIVED (never hardcoded), mechanism corrected (5 of 6 accept, unisex family, BB+MHG female)', () => {
  it('the fixture has 6 distinct design keys including BB (restored — its own recorded name accepts; K4\'s omission measured an invented name), each with a non-empty pool', () => {
    expect(fixture.designs.length).toBe(6)
    const keys = new Set(fixture.designs.map((d) => d.designKey))
    expect(keys.size).toBe(6)
    expect(keys.has('BB')).toBe(true)
    for (const d of fixture.designs) expect(d.pool.length).toBeGreaterThan(0)
  })

  it('the blank matches the record, not an invention: unisex family, sweatshirt+hoodie mixed parent (documentation only — see RULING M5), two female-coded designs', () => {
    expect(fixture.blank.unisex).toBe(true)
    expect(fixture.blank.audienceLean).toBe('unisex')
    expect(fixture.mixedFamilies).toEqual(['sweatshirt', 'hoodie'])
    expect(fixture.audienceLeanByDesign).toEqual({ BB: 'female', MHG: 'female' })
  })

  it('RULING M1: specFacts DERIVED from the blank by the live composer\'s own pad bank is NOT the fixture\'s old hardcoded array — the missing fact is exactly what the wrong 2-of-6 number rested on', () => {
    // The array this fixture used to hardcode, preserved here only as the NEGATIVE assertion that
    // proves the derivation changed the input, not merely re-stated it.
    const OLD_HARDCODED_SPEC_FACTS = ['Classic Fit', '50% Cotton / 50% Polyester']
    expect(SPEC_FACTS.length).toBeGreaterThan(0)
    expect(SPEC_FACTS).not.toEqual(OLD_HARDCODED_SPEC_FACTS)
    expect(SPEC_FACTS).toContain('Unisex Fit')
  })

  // RULING M5: NOT `mixedFamilies` — the live Item Highlights path (`PerDesignItemHighlightsInput`,
  // `buildItemHighlights`) has no such field, so feeding it into this ctx would make the fixture's
  // oracle strictly MORE permissive than any line the live path can actually judge (review
  // phase-l1-review-value.md IMPORTANT 1).
  const truthCtxBase: PhraseTruthCtx = {
    garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never,
    allowedBrand: fixture.blank.brandInCopy ? fixture.blank.brand : null,
    audience: 'adult',
    field: 'highlights',
  }

  for (const d of fixture.designs) {
    const expectAccept = ACCEPTS_ON_RECORDED_LEAN.has(d.designKey)
    it(`design ${d.designKey} ("${d.designName}"): through the REAL enumerateWriterCandidates + runWriterForDesign + runIhTail, ${expectAccept ? 'ACCEPTS' : 'HOLDS (band-vs-name-length, not a gender refusal — see module doc comment)'}`, async () => {
      const truthCtx: PhraseTruthCtx = { ...truthCtxBase, audienceLean: leanForDesign(d.designKey), designTokens: [d.designName] } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'm1-fixture' })
      const enumerated = enumerateWriterCandidates(units, { truthCtx, runTail })
      const r = await runWriterForDesign({
        composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail,
        deps: { openai: stubPickOneClient() },
      })
      console.log(JSON.stringify({
        tag: 'M1_FIXTURE_ACCEPTANCE', design: d.designName, lean: truthCtx.audienceLean, found: enumerated.candidates.length,
        accepted: r.accepted, value: r.value || null, len: r.value ? r.value.length : 0, reasons: r.reasons,
      }))
      // RULING K1-value MINOR 2 / review I1 MINOR 1: pins the ACTUAL per-design outcome the recorded
      // lean + DERIVED spec facts produce, so a future change to the writer, the admission gate or
      // the fixture that moves a design across the accept/hold line fails this test instead of
      // passing silently.
      expect(r.accepted).toBe(expectAccept)
      if (expectAccept) {
        expect(r.value.length).toBeGreaterThan(0)
      } else {
        expect(r.value).toBe('')
        expect(r.reasons.length).toBeGreaterThan(0)
      }
    })
  }

  it('5 of 6 designs accept on the RECORDED lean with DERIVED specFacts — above RULING I2\'s 4-of-6 STOP floor; the one hold (DQG) is a floor-vs-name-length problem, not a pool-gender one', async () => {
    const acceptedKeys: string[] = []
    for (const d of fixture.designs) {
      const truthCtx: PhraseTruthCtx = { ...truthCtxBase, audienceLean: leanForDesign(d.designKey), designTokens: [d.designName] } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'm1-fixture-total' })
      const r = await runWriterForDesign({
        composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail,
        deps: { openai: stubPickOneClient() },
      })
      if (r.accepted) acceptedKeys.push(d.designKey)
    }
    // The honest number on the PO's real listing (phase-m1-report.md), once specFacts is derived
    // rather than invented. Above RULING I2's 4-of-6 floor — no STOP is warranted. NOT to be
    // "improved" further by loosening the audience-lean truth rule (OUT OF BOUNDS —
    // phraseTruthVerdict) or by lowering the accept floor (FILED, not fixed: DQG's 94c-vs-97c gap is
    // a 10-character design name problem).
    expect(acceptedKeys.sort(), `accepted designs: ${JSON.stringify(acceptedKeys)}`).toEqual(['BB', 'BCSG', 'EDG', 'HDG', 'MHG'])
  })
})

// ─── ROUND M6/J1-J7 (phase-j1-rulings.md; PO 2026-09-23 "A: go with a") — THE HUMANIZER'S OWN
// ACCEPTANCE, "the eligible atoms and rank 1, per design, BEFORE and AFTER, verbatim with character
// counts" — measured on THIS fixture, whose every field is now derived or recorded (RULING M6's own
// precondition). Built AFTER the M1-M5 fixture corrections above, per the ruling's own ordering.
describe('ROUND M6/J1-J7: the humanizer, measured on this same corrected fixture — eligible atoms + rank 1, BEFORE and AFTER, per design', () => {
  afterEach(() => { delete process.env.IH_HUMANIZER })

  // SAME truthCtx shape the M1/M2 describe block above builds (never `mixedFamilies` — RULING M5) —
  // re-declared locally because `describe` blocks do not share each other's `const`s.
  const truthCtxBase: PhraseTruthCtx = {
    garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never,
    allowedBrand: fixture.blank.brandInCopy ? fixture.blank.brand : null,
    audience: 'adult',
    field: 'highlights',
  }

  // Hand-authored, net-legal rewrite table (reorder-only or insert-from-the-closed-set-only — every
  // entry independently verified against the REAL `humanizerRewriteVerdict` in
  // `itemHighlightWriterHumanizer.test.ts`'s own property suite, never asserted here without proof).
  // "Graphic Crewneck Sweatshirts Women" -> "...for Women" is the round's OWN worked example (J1's
  // WHY section: an audience word "stranded on the end" with no "for").
  const REWRITES: Record<string, string> = {
    'Embroidered Sweatshirts for Women': 'Embroidered Sweatshirts for Women',
    'Sweatshirts for Women Trendy': 'Trendy Sweatshirts for Women',
    'Graphic Crewneck Sweatshirts Women': 'Graphic Crewneck Sweatshirts for Women',
    'Fall Graphic Sweatshirts for Women': 'Fall Graphic Sweatshirts for Women',
    'Fun Sweatshirts for Women': 'Fun Sweatshirts for Women',
    'Fall Crewneck': 'Fall Crewneck',
  }
  function stubHumanizeAndPickClient() {
    return {
      chat: {
        completions: {
          create: async (req: { messages: { role: string; content: string }[] }) => {
            const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
            const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
            if (system.includes('rewrite a NUMBERED list')) {
              const lines = [...user.matchAll(/^(\d+)\.\s(.+)$/gm)]
              const rewrites = lines.map(([, i, text]) => ({ i: Number(i), text: REWRITES[text] ?? text }))
              return { choices: [{ message: { content: JSON.stringify({ rewrites }) }, finish_reason: 'stop' }] }
            }
            return { choices: [{ message: { content: JSON.stringify({ pick: 1 }) }, finish_reason: 'stop' }] }
          },
        },
      },
    } as never
  }

  // MEASURED (2026-09-24, this fixture, this stub table) — pinned so a future change to admission,
  // the net or the search that moves ANY of these numbers fails this test instead of passing
  // silently. BB/MHG (women lean) admit all 6 pool phrases and the humanizer touches 2 of them
  // (reorder + insert "for"); BCSG/EDG/HDG (unisex default) admit only "Fall Crewneck", already
  // natural, untouched; DQG never reaches this stage (it holds on the 94c-vs-97c floor problem —
  // RULING M2 — before `runWriterForDesign` ever calls the humanizer).
  const EXPECTED: Record<string, { eligibleBefore: string[]; eligibleAfter: string[]; rank1Before: string; rank1After: string }> = {
    BB: {
      eligibleBefore: ['Embroidered Sweatshirts for Women', 'Sweatshirts for Women Trendy', 'Graphic Crewneck Sweatshirts Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck'],
      eligibleAfter: ['Embroidered Sweatshirts for Women', 'Trendy Sweatshirts for Women', 'Graphic Crewneck Sweatshirts for Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck'],
      rank1Before: 'Business B*tch, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
      rank1After: 'Business B*tch, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
    },
    BCSG: {
      eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'],
      rank1Before: 'Billionaire Coming Soon Sweatshirt, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit',
      rank1After: 'Billionaire Coming Soon Sweatshirt, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit',
    },
    // DQG holds (RULING M2's 94c-vs-97c floor problem) — never reached by the rank1 columns, which
    // are unused for this key; see the `if (d.designKey === 'DQG')` branch below.
    DQG: { eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'], rank1Before: '', rank1After: '' },
    EDG: {
      eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'],
      rank1Before: 'Entrepreneur Definition Sweatshirt, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit',
      rank1After: 'Entrepreneur Definition Sweatshirt, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit',
    },
    HDG: {
      eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'],
      rank1Before: 'Hustle Definition Sweatshirt, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit',
      rank1After: 'Hustle Definition Sweatshirt, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit',
    },
    MHG: {
      eligibleBefore: ['Embroidered Sweatshirts for Women', 'Sweatshirts for Women Trendy', 'Graphic Crewneck Sweatshirts Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck'],
      eligibleAfter: ['Embroidered Sweatshirts for Women', 'Trendy Sweatshirts for Women', 'Graphic Crewneck Sweatshirts for Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck'],
      rank1Before: 'Mother Hustler, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
      rank1After: 'Mother Hustler, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
    },
  }

  for (const d of fixture.designs) {
    it(`design ${d.designKey}: eligible atoms + rank-1, BEFORE (IH_HUMANIZER=off) and AFTER (IH_HUMANIZER=on)`, async () => {
      const truthCtx: PhraseTruthCtx = { ...truthCtxBase, audienceLean: leanForDesign(d.designKey), designTokens: [d.designName] } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never

      process.env.IH_HUMANIZER = 'off'
      const unitsBefore: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const eligibleBefore = unitsBefore.filter(isHumanizerEligible).map((u) => u.text)
      const runTailBefore = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'm6-fixture-before' })
      const rBefore = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail: runTailBefore, deps: { openai: stubHumanizeAndPickClient() } })

      process.env.IH_HUMANIZER = 'on'
      const humanized = await humanizeAdmittedUnits(unitsBefore, { truthCtx, designName: d.designName, deps: { openai: stubHumanizeAndPickClient() } })
      const eligibleAfter = humanized.units.filter(isHumanizerEligible).map((u) => u.text)
      const runTailAfter = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'm6-fixture-after' })
      const rAfter = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail: runTailAfter, deps: { openai: stubHumanizeAndPickClient() } })

      console.log(JSON.stringify({
        tag: 'M6_HUMANIZER_ACCEPTANCE', design: d.designName,
        eligibleBefore: eligibleBefore.map((t) => `${t} [${t.length}c]`),
        eligibleAfter: eligibleAfter.map((t) => `${t} [${t.length}c]`),
        rank1Before: rBefore.value ? `${rBefore.value} [${rBefore.value.length}c]` : rBefore.reasons,
        rank1After: rAfter.value ? `${rAfter.value} [${rAfter.value.length}c]` : rAfter.reasons,
        humanizeCalls: humanized.calls, humanizeAccepted: humanized.accepted, humanizeRejected: humanized.rejected,
      }))

      const expected = EXPECTED[d.designKey]
      expect(eligibleBefore).toEqual(expected.eligibleBefore)
      expect(eligibleAfter).toEqual(expected.eligibleAfter)
      expect(rBefore.value || `HOLD: ${rBefore.reasons.join('; ')}`).toBe(d.designKey === 'DQG' ? `HOLD: ${rBefore.reasons.join('; ')}` : expected.rank1Before)
      expect(rAfter.value || `HOLD: ${rAfter.reasons.join('; ')}`).toBe(d.designKey === 'DQG' ? `HOLD: ${rAfter.reasons.join('; ')}` : expected.rank1After)
      if (d.designKey === 'DQG') {
        // RULING M2: DQG holds on the floor-vs-name-length problem — but its naive best-case join
        // (identity + specFacts + "Fall Crewneck" + heads, plain-comma-joined) DOES clear
        // `runWriterForDesign`'s own cheap pre-check, so — unlike a design with fewer than 2 admitted
        // units — it DOES reach and spend the humanizer's one call; `enumerateWriterCandidates`'s
        // REAL grammar-constrained search (relation clause required, garment-head abutment, etc.)
        // is what finds zero in-band candidates. Its ONE eligible atom ("Fall Crewneck") is already
        // natural (unchanged by the humanizer either way), so the hold reason is IDENTICAL before
        // and after regardless.
        expect(rBefore.accepted).toBe(false)
        expect(rAfter.accepted).toBe(false)
        expect(humanized.calls).toBe(1)
        expect(rAfter.calls).toBe(1) // the humanizer's own call, spent, then zero candidates — never a picker call (no taste to exercise among zero).
        expect(rAfter.reasons).toEqual(rBefore.reasons)
      } else {
        expect(humanized.accepted + humanized.rejected).toBe(expected.eligibleBefore.length)
      }
    })
  }
})
