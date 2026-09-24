/**
 * itemHighlightWriterB0DSCDZC6KFixture.test.ts — RULING I6 (round I) landed this fixture; RULING K4
 * (round K1, phase-k1-rulings.md, Important) REBUILT its contents; RULING L2 (round L1,
 * phase-l1-rulings.md, Blocking) corrected its BLANK; RULING M1/M2/M5 (round M, phase-m1-rulings.md,
 * Blocking) correct a SECOND invented field this fixture carried beside the first; RULING N3/N4
 * (round N, phase-n1-rulings.md, Blocking — closing `phase-m1-review-wire.md` BLOCKING 1) correct a
 * THIRD, still-incomplete field beside those two.
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
 * hardcoded beside it, one fact SHORT of what `ihSpecFactFillers` (`productDetailAttrs.ts:516-523`,
 * the ONE pad bank the live composer reads at `itemHighlightComposer.ts:436`) actually derives from
 * that same blank. RULING M1 fixed THAT by deriving `specFacts` from the blank at run time — but
 * review `phase-m1-review-wire.md` (BLOCKING 1) found the BLANK ITSELF still incomplete: the pad bank
 * reads SIX descriptors (`material`, `fit`, `unisex`, `neck`, `sleeve`, `dye`) and the blank carried
 * only three, silently omitting `neck`/`sleeve` even though BOTH are recorded elsewhere in this SAME
 * fixture (the note's own K4 citation, and the `titleTemplate` field M5 added the same round). This
 * is the THIRD consecutive round in which an undeclared/incomplete fixture field moved the headline —
 * RULING N3 (see the fixture's own `note`) adds the two recorded fields; `dye` stays genuinely absent
 * (never recorded for this blank anywhere in this repo).
 *
 * RULING M1's remedy, applied here: `specFacts` is no longer a field this fixture carries at all.
 * This test derives it by calling `ihSpecFactFillers` directly, exactly as the live composer does,
 * so it structurally cannot drift from the blank. RULING M5 adds `titleTemplate`
 * (the recorded live title shape — the title decides the number, and no title was recorded before)
 * and records the `mixedFamilies` decision: kept as documentation of the record, but NOT threaded
 * into this test's `truthCtx`, because the live Item Highlights path has no such field yet (a real
 * gap, filed, not fixed this round — see the fixture's own `note`).
 *
 * THE CORRECTED RESULT (RULING N4 — the mechanism, restated correctly for the THIRD time; RULING O4,
 * round O, Blocking, retires hand-typing any of its numbers a FOURTH time). The pool's gendered
 * phrases ("for Women") are correctly refused by `phraseTruthVerdict`'s forced-gender rule for the
 * designs that inherit the family's unisex default; the exact `truthDrops` count every real
 * composer run logs is pinned below, never retyped here. The ungendered phrase, `Fall Crewneck`,
 * names no gender, is admitted, and carries the rank-1 line of every design. With the blank's
 * `neck`/`sleeve` now supplied (RULING N3), `specFacts` derives further facts ("Crew Neck",
 * "Long Sleeve") beside `50% Cotton / 50% Polyester`/`Classic Fit`/`Unisex Fit` — and every design
 * in the family accepts, including DQG ("Don't Quit"), the family's shortest design name, whose
 * naive best-case join now clears the accept floor where it previously did not
 * (`evaluated=0` was an outcome of `enumerateWriterCandidates`'s own grammar-constrained search never
 * finding an in-band arrangement, NOT of the floor pre-check, as RULING M2's own wording wrongly
 * implied — see `phase-m1-review-reading.md` §3). The mechanism M2 filed (a floor-vs-name-length
 * problem) is RETIRED, not merely restated: the fixture's OWN incompleteness was the finding, not a
 * genuine band/name-length limit. RULING O4 pins DQG's exact admitted-unit count, its naive-join
 * length against the accept floor, and `SPEC_FACTS.length` against a fresh `ihSpecFactFillers` call
 * as real assertions (below, in the dedicated "RULING O4" test) — every number that sentence used to
 * state by hand now lives ONLY there, read from that test's own run, never retyped in this comment.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { buildAdmittedUnits, enumerateWriterCandidates, runWriterForDesign, humanizeAdmittedUnits, isHumanizerEligible, type AdmittedUnit } from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { normalizeAudienceLean, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import { ihSpecFactFillers } from '@/lib/fba/productDetailAttrs'
import { titleCasePhrase } from '@/lib/fba/titleBand'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
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

// RULING M1/N3: DERIVED from the fixture's own blank by the ONE pad bank the live composer reads
// (`ihSpecFactFillers`, `productDetailAttrs.ts:516-523`) — never a second, hand-typed array that can
// drift from the blank the way the fixture's own hardcoded `specFacts` field drifted twice (K4's
// `unisex: false` masked it as a set-equal coincidence; L2's `unisex: true` correction exposed it).
// RULING N3: the blank object passed here is now the WHOLE recorded row (`material`, `fit`,
// `unisex`, `neck`, `sleeve` — `dye` genuinely absent), not a hand-picked subset of the six fields
// `IH_PAD_FILLER_DESCRIPTORS` reads — the THIRD round's own fixture-completeness defect this ruling
// closes.
const SPEC_FACTS: readonly string[] = ihSpecFactFillers({
  material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex,
  neck: fixture.blank.neck, sleeve: fixture.blank.sleeve,
} as never).map(titleCasePhrase)

// RULING M5: the family's own RECORDED live title shape
// (docs/superpowers/specs/2026-09-05-title-judge-sees-shipped-bytes.md:28-31), never a hand-invented
// title constant — the title decides the accepted count (a title carrying both "Fall" and
// "Crewneck" title-dedupes the pool's only ungendered phrase and drops the family to 2 of 6).
const titleFor = (designName: string): string => fixture.titleTemplate.replace('{design}', designName)

// RULING N3/N4: with `specFacts` derived from the WHOLE recorded blank (never a hand-picked
// subset), all 6 of 6 designs accept — including DQG, once the naive best-case join includes its
// two extra recorded facts ("Crew Neck", "Long Sleeve") and the grammar-constrained search has room
// to find an in-band arrangement. See the module doc comment for the corrected mechanism.
const ACCEPTS_ON_RECORDED_LEAN = new Set(['BB', 'BCSG', 'DQG', 'EDG', 'HDG', 'MHG'])

describe('RULING M1/N3/N4 fixture: the committed B0DSCDZC6K family, specFacts DERIVED from the WHOLE recorded blank (never hardcoded, never a hand-picked subset), mechanism corrected (6 of 6 accept, unisex family, BB+MHG female)', () => {
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

  it('RULING M1/N3: specFacts DERIVED from the WHOLE recorded blank by the live composer\'s own pad bank is NOT the fixture\'s old hardcoded array, and NOT the round-M hand-picked three-field subset either — the missing facts are exactly what the wrong 2-of-6 and 5-of-6 numbers rested on', () => {
    // The arrays this fixture used to hardcode/derive-from-a-subset, preserved here only as the
    // NEGATIVE assertions that prove each derivation changed the input, not merely re-stated it.
    const OLD_HARDCODED_SPEC_FACTS = ['Classic Fit', '50% Cotton / 50% Polyester']
    const ROUND_M_THREE_FIELD_SPEC_FACTS = ['50% Cotton / 50% Polyester', 'Classic Fit', 'Unisex Fit']
    expect(SPEC_FACTS.length).toBeGreaterThan(0)
    expect(SPEC_FACTS).not.toEqual(OLD_HARDCODED_SPEC_FACTS)
    expect(SPEC_FACTS).not.toEqual(ROUND_M_THREE_FIELD_SPEC_FACTS)
    expect(SPEC_FACTS).toContain('Unisex Fit')
    expect(SPEC_FACTS).toContain('Crew Neck')
    expect(SPEC_FACTS).toContain('Long Sleeve')
  })

  // RULING O4 (round O, Blocking, fourth consecutive round — phase-o1-rulings.md): the fixture's
  // own `note` field used to state DQG's unit count, its naive-join-vs-floor comparison, and
  // `SPEC_FACTS.length` by hand — and got at least one of the three wrong in every one of the last
  // four rounds (most recently: "94c vs 97c", when the committed blank's own naive join is 124c).
  // The structural cure is HERE, not more careful prose: these three relations are now PINNED as
  // actual assertions, computed from the SAME functions the note used to describe, and the fixture
  // note itself carries no number at all any more (it points back at this test). Every number below
  // is pasted from this test's own run (`npx vitest run itemHighlightWriterB0DSCDZC6KFixture.test.ts`),
  // never typed from memory.
  it('RULING O4: DQG\'s admitted unit count, its naive-join-vs-floor relation, and SPEC_FACTS.length against ihSpecFactFillers on the committed blank are PINNED — this test fails the instant any of the three drifts, instead of a hand-typed sentence silently going stale', () => {
    const d = fixture.designs.find((x) => x.designKey === 'DQG')!
    const truthCtx: PhraseTruthCtx = {
      garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
      spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: fixture.blank.neck, sleeve: fixture.blank.sleeve } as never,
      allowedBrand: null, audience: 'adult', field: 'highlights',
      audienceLean: leanForDesign('DQG'), designTokens: [d.designName],
    } as PhraseTruthCtx
    const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
    const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
    const naiveJoin = units.map((u) => u.text).join(', ')
    console.log(JSON.stringify({
      tag: 'O4_DQG_PIN', specFactsLength: SPEC_FACTS.length, dqgUnitCount: units.length,
      naiveJoinLength: naiveJoin.length, floor: CONTENT_CONTRACT.itemHighlights.min,
    }))
    // SPEC_FACTS.length against a FRESH, independent call to ihSpecFactFillers on the SAME blank —
    // never the module-level `SPEC_FACTS` const compared to itself.
    const freshSpecFacts = ihSpecFactFillers({
      material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex,
      neck: fixture.blank.neck, sleeve: fixture.blank.sleeve,
    } as never)
    expect(SPEC_FACTS.length).toBe(freshSpecFacts.length)
    expect(SPEC_FACTS.length).toBe(5) // pasted from this test's own O4 run — material/fit/unisex/neck/sleeve
    // DQG's admitted unit count on the COMMITTED (whole recorded) blank.
    expect(units.length).toBe(9) // pasted from this test's own O4 run
    // The naive-join-vs-floor relation the note's retracted "94c vs 97c" sentence got wrong.
    expect(naiveJoin.length).toBe(124) // pasted from this test's own O4 run
    expect(naiveJoin.length).toBeGreaterThan(CONTENT_CONTRACT.itemHighlights.min) // the floor CLEARS
  })

  // RULING M5: NOT `mixedFamilies` — the live Item Highlights path (`PerDesignItemHighlightsInput`,
  // `buildItemHighlights`) has no such field, so feeding it into this ctx would make the fixture's
  // oracle strictly MORE permissive than any line the live path can actually judge (review
  // phase-l1-review-value.md IMPORTANT 1).
  const truthCtxBase: PhraseTruthCtx = {
    garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: fixture.blank.neck, sleeve: fixture.blank.sleeve } as never,
    allowedBrand: fixture.blank.brandInCopy ? fixture.blank.brand : null,
    audience: 'adult',
    field: 'highlights',
  }

  for (const d of fixture.designs) {
    const expectAccept = ACCEPTS_ON_RECORDED_LEAN.has(d.designKey)
    it(`design ${d.designKey} ("${d.designName}"): through the REAL enumerateWriterCandidates + runWriterForDesign + runIhTail, ${expectAccept ? 'ACCEPTS' : 'HOLDS'}`, async () => {
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

  it('6 of 6 designs accept on the RECORDED lean with specFacts DERIVED FROM THE WHOLE BLANK — above RULING I2\'s 4-of-6 STOP floor; RULING N3/N4 retires the DQG hold entirely (it was the fixture\'s own incompleteness, not a genuine band/name-length limit)', async () => {
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
    // The honest number on the PO's real listing, once specFacts is derived from the WHOLE blank
    // rather than a hand-picked subset. Above RULING I2's 4-of-6 floor — no STOP is warranted. NOT to
    // be "improved" further by loosening the audience-lean truth rule (OUT OF BOUNDS —
    // phraseTruthVerdict) or by lowering the accept floor (moot now — every design clears it).
    expect(acceptedKeys.sort(), `accepted designs: ${JSON.stringify(acceptedKeys)}`).toEqual(['BB', 'BCSG', 'DQG', 'EDG', 'HDG', 'MHG'])
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
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: fixture.blank.neck, sleeve: fixture.blank.sleeve } as never,
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

  // MEASURED (2026-09-24, this fixture, this stub table, POST RULING P1 — round P, re-measured
  // from this test's own run after RULING O2 was superseded in turn): BB/MHG (women lean) admit
  // all 6 pool phrases, but this stub table's REWRITES map is the identity rewrite for four of the
  // six ('Embroidered Sweatshirts for Women', 'Fall Graphic Sweatshirts for Women', 'Fun
  // Sweatshirts for Women', 'Fall Crewneck' each map to themselves) — RULING O5 (round O, Important)
  // now refuses an identity rewrite before any other check runs (it would be a byte-identical
  // duplicate unit, never a genuine alternate), so only the REMAINING two (genuinely-reworded)
  // rewrites survive as ALTERNATE units: `eligibleAfter` is `eligibleBefore` followed by those TWO
  // alternates, 8 entries, not 12. RULING P1 (round P, Blocking — "the humanizer becomes STRICTLY
  // ADDITIVE") replaced O2's "search a combined ranking for the first zero-alt entry" (which review
  // O1 measured FALSE: the alt-carrying branches could consume enough of the fixed 300-evaluation
  // budget that the zero-alt line the combined search reached first was no longer the same one
  // flag-off finds) with a search that decides slot 1 from a SOURCES-ONLY pass BEFORE any
  // alt-carrying branch is ever explored — rank 1 AFTER is now BYTE-IDENTICAL to rank 1 BEFORE, by
  // construction, exactly as it is with `IH_HUMANIZER=off` (`EXPECTED` below, `rank1After ===
  // rank1Before` for every design). See `itemHighlightWriterHumanizer.test.ts`'s dedicated rank
  // test for the isolated P1 mechanism. BCSG/EDG/HDG/DQG's sole eligible atom, "Fall Crewneck", is
  // TWO words — RULING N5 (round N) skips the humanize call entirely for them (0 calls, not 1),
  // knowable before the call: a 2-word atom has no room to reorder into anything else.
  // RULING N3 (the whole recorded blank, `neck`/`sleeve` now supplied): every design's rank 1 now
  // has access to two MORE spec-fact candidates ("Crew Neck", "Long Sleeve") — DQG's naive best-case
  // join clears the search (RULING N4: it ACCEPTS now, 6 of 6, retiring the M2 "floor-vs-name-length"
  // filed finding entirely — see the module doc comment). BCSG/EDG/HDG's rank 1 also CHANGES shape:
  // the search now finds a candidate CLOSER to the 110c fill target using the extra facts, so their
  // new rank 1 no longer carries the garment-head abutment ("Sweatshirt") in every case — a genuine
  // ranking outcome, not a regression (every candidate still passes the full acceptance oracle).
  const EXPECTED: Record<string, { eligibleBefore: string[]; eligibleAfter: string[]; rank1Before: string; rank1After: string; humanizeCalls: number }> = {
    BB: {
      eligibleBefore: ['Embroidered Sweatshirts for Women', 'Sweatshirts for Women Trendy', 'Graphic Crewneck Sweatshirts Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck'],
      eligibleAfter: [
        'Embroidered Sweatshirts for Women', 'Sweatshirts for Women Trendy', 'Graphic Crewneck Sweatshirts Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck',
        'Trendy Sweatshirts for Women', 'Graphic Crewneck Sweatshirts for Women',
      ],
      rank1Before: 'Business B*tch, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
      rank1After: 'Business B*tch, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
      humanizeCalls: 1,
    },
    BCSG: {
      eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'],
      rank1Before: 'Billionaire Coming Soon, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Long Sleeve',
      rank1After: 'Billionaire Coming Soon, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Long Sleeve',
      humanizeCalls: 0,
    },
    DQG: {
      eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'],
      rank1Before: "Don't Quit, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Crew Neck, Long Sleeve",
      rank1After: "Don't Quit, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Crew Neck, Long Sleeve",
      humanizeCalls: 0,
    },
    EDG: {
      eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'],
      rank1Before: 'Entrepreneur Definition, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Long Sleeve',
      rank1After: 'Entrepreneur Definition, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Long Sleeve',
      humanizeCalls: 0,
    },
    HDG: {
      eligibleBefore: ['Fall Crewneck'], eligibleAfter: ['Fall Crewneck'],
      rank1Before: 'Hustle Definition Sweatshirt, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Crew Neck, Long Sleeve',
      rank1After: 'Hustle Definition Sweatshirt, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit, Crew Neck, Long Sleeve',
      humanizeCalls: 0,
    },
    MHG: {
      eligibleBefore: ['Embroidered Sweatshirts for Women', 'Sweatshirts for Women Trendy', 'Graphic Crewneck Sweatshirts Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck'],
      eligibleAfter: [
        'Embroidered Sweatshirts for Women', 'Sweatshirts for Women Trendy', 'Graphic Crewneck Sweatshirts Women', 'Fall Graphic Sweatshirts for Women', 'Fun Sweatshirts for Women', 'Fall Crewneck',
        'Trendy Sweatshirts for Women', 'Graphic Crewneck Sweatshirts for Women',
      ],
      rank1Before: 'Mother Hustler, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
      rank1After: 'Mother Hustler, Embroidered Sweatshirts for Women, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit',
      humanizeCalls: 1,
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
      // RULING N4: DQG ACCEPTS now (6 of 6) — the pre-N "HOLD" branch for it is retired; every
      // design in this fixture ships a rank-1 line, before and after.
      expect(rBefore.value).toBe(expected.rank1Before)
      expect(rAfter.value).toBe(expected.rank1After)
      expect(rBefore.accepted).toBe(true)
      expect(rAfter.accepted).toBe(true)
      expect(humanized.calls).toBe(expected.humanizeCalls)
      if (expected.humanizeCalls === 0) {
        // RULING N5: every eligible atom is <=2 words — the call is skipped, so nothing was offered
        // to accept or reject.
        expect(humanized.accepted).toBe(0)
        expect(humanized.rejected).toBe(0)
      } else {
        expect(humanized.accepted + humanized.rejected).toBe(expected.eligibleBefore.length)
      }
    })
  }
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING P4 (round P, Blocking, phase-p1-rulings.md — second half): "the flag-off sha256 gate this
// programme has cited for fifteen rounds is computed over six EMPTY strings and cannot fail."
// Review `phase-o1-review-reading.md` IMPORTANT 5 traced the round's own throwaway probe script
// (`o1/flagoff-sha256.ts`) and found it ran with BOTH `IH_WRITER` and `IH_HUMANIZER` unset — on
// this fixture the composer HOLDS every design at that configuration, so the "corpus" it hashed was
// six `""` rows: a sha256 that "never fails" because the six rows behind it have no bytes to move.
// No committed vitest test ever hashed anything at all (a source-scan of this repo's `*.test.ts`
// files, before this test, found zero references to `createHash`/`sha256`) — every prior round's
// citation was to that same one-off probe, re-typed by hand each round, never a durable gate.
// THIS is that gate, made real and durable: hashed over the corpus review IMPORTANT 5 itself named
// as "the one that carries bytes" — `IH_WRITER=on` (every row below calls `runWriterForDesign`
// directly), `IH_HUMANIZER=off` — so every one of the 6 rows is the REAL, non-empty, accepted
// writer line this fixture ships end to end (RULING N4: 6 of 6 accept), never a hold.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('RULING P4 (round P, Blocking): the flag-off sha256 ship gate, over REAL rows this time', () => {
  afterEach(() => { delete process.env.IH_HUMANIZER })

  async function corpusRows(): Promise<string[]> {
    delete process.env.IH_HUMANIZER // this gate's own corpus: writer on, humanizer off — never the both-off, six-empty-string corpus the pre-P4 "gate" hashed.
    const rows: string[] = []
    for (const d of fixture.designs) {
      const truthCtx: PhraseTruthCtx = {
        garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
        spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: fixture.blank.neck, sleeve: fixture.blank.sleeve } as never,
        allowedBrand: null, audience: 'adult', field: 'highlights',
        audienceLean: leanForDesign(d.designKey), designTokens: [d.designName],
      } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'p4-sha256-gate' })
      const r = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail, deps: { openai: stubPickOneClient() } })
      rows.push(`${d.designKey}=${r.value}`)
    }
    return rows
  }

  it('the gate is NOT vacuous: every one of the 6 rows it hashes carries real, non-empty bytes (the pre-P4 "gate" hashed 6 EMPTY strings)', async () => {
    const rows = await corpusRows()
    expect(rows.length).toBe(6)
    for (const row of rows) {
      const value = row.slice(row.indexOf('=') + 1)
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('PINNED sha256 over the 6-row real corpus — pasted from this test\'s own run, never typed from memory', async () => {
    const rows = await corpusRows()
    const hash = createHash('sha256').update(rows.join('\n')).digest('hex')
    console.log(JSON.stringify({ tag: 'P4_FLAGOFF_SHA256', hash, rows }))
    expect(hash).toBe('1c89bd43bd874b09b0ff86a571a7e12e13e546677d454a9c3cf790ad9b9b965e')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING R3 (round R, Blocking, phase-r1-rulings.md — "the gate must see the ballot, not one
// slot"). RULING P4's gate (above) hashes the SHIPPED value under a chooser that always picks slot
// 1 — it can only ever notice rank 1 change. RULING R2 measured that round Q's OWN bug (pass 2
// re-running a whole redundant search even on a flag-off ballot) moved candidates BELOW rank 1
// without ever moving rank 1 itself, so the P4 gate stayed GREEN through the entire round-Q
// regression it was cited against. Two new pins close that blind spot, over the SAME 6-design
// fixture: (1) hashing the FULL ballot `enumerateWriterCandidates` returns — every slot, never only
// the one a pick-1 chooser would reveal — and (2) a SECOND shipped-value corpus sha, alongside the
// existing pick-1 one, under a chooser that always picks the LAST ballot option: a change below
// slot 1 moves what "last" IS, so this sha can go red exactly when the pick-1 sha would not.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('RULING R3 (round R, Blocking): the gate sees the WHOLE ballot, not slot 1 alone', () => {
  afterEach(() => { delete process.env.IH_HUMANIZER })

  async function fullBallotRows(): Promise<string[]> {
    delete process.env.IH_HUMANIZER // this gate's own corpus: the flag-off SEARCH, never the humanizer.
    const rows: string[] = []
    for (const d of fixture.designs) {
      const truthCtx: PhraseTruthCtx = {
        garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
        spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: fixture.blank.neck, sleeve: fixture.blank.sleeve } as never,
        allowedBrand: null, audience: 'adult', field: 'highlights',
        audienceLean: leanForDesign(d.designKey), designTokens: [d.designName],
      } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const units = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'r3-full-ballot-gate' })
      const en = enumerateWriterCandidates(units, { truthCtx, runTail })
      rows.push(`${d.designKey}=${JSON.stringify(en.candidates.map((c) => c.line))}`)
    }
    return rows
  }

  it('the full-ballot gate is NOT vacuous: every one of the 6 rows carries at least one rendered line', async () => {
    const rows = await fullBallotRows()
    expect(rows.length).toBe(6)
    for (const row of rows) {
      const lines: string[] = JSON.parse(row.slice(row.indexOf('=') + 1))
      expect(lines.length).toBeGreaterThan(0)
    }
  })

  it('PINNED sha256 over the FULL 8-slot ballot per design (every slot `enumerateWriterCandidates` returns, not just what a pick-1 chooser would reveal) — pasted from this test\'s own run', async () => {
    const rows = await fullBallotRows()
    const hash = createHash('sha256').update(rows.join('\n')).digest('hex')
    console.log(JSON.stringify({ tag: 'R3_FULLBALLOT_SHA256', hash, rows }))
    expect(hash).toBe('ff958d46447cbc8b3e28ccc3b10f77df30e529afdfeecab1997a29775c15a27f')
  })

  async function shippedRows(pick: 'first' | 'last'): Promise<string[]> {
    delete process.env.IH_HUMANIZER
    const rows: string[] = []
    for (const d of fixture.designs) {
      const truthCtx: PhraseTruthCtx = {
        garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
        spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: fixture.blank.neck, sleeve: fixture.blank.sleeve } as never,
        allowedBrand: null, audience: 'adult', field: 'highlights',
        audienceLean: leanForDesign(d.designKey), designTokens: [d.designName],
      } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'r3-shipped-gate' })
      const client = { chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
        const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
        const opts = [...user.matchAll(/^(\d+)\.\s/gm)].map(([, i]) => Number(i))
        const picked = pick === 'first' ? opts[0] : opts[opts.length - 1]
        return { choices: [{ message: { content: JSON.stringify({ pick: picked }) }, finish_reason: 'stop' }] }
      } } } } as never
      const r = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail, deps: { openai: client } })
      rows.push(`${d.designKey}=${r.value}`)
    }
    return rows
  }

  it('PINNED sha256, pick-1 chooser — the SAME shape as the P4 gate above, reproduced here so the pair sits together', async () => {
    const rows = await shippedRows('first')
    const hash = createHash('sha256').update(rows.join('\n')).digest('hex')
    expect(hash).toBe('1c89bd43bd874b09b0ff86a571a7e12e13e546677d454a9c3cf790ad9b9b965e')
  })

  it('PINNED sha256, pick-LAST chooser — a SEPARATE corpus that moves independently of the pick-1 one, proving this gate sees below slot 1 (mutating RULING R2\'s own fix back to Q\'s shared-space pass 2 must move THIS sha without necessarily moving the pick-1 one)', async () => {
    const rows = await shippedRows('last')
    const hash = createHash('sha256').update(rows.join('\n')).digest('hex')
    console.log(JSON.stringify({ tag: 'R3_PICKLAST_SHA256', hash, rows }))
    expect(hash).toBe('0e6a29f0e4f4c06cca6dcdd2a64a374b54ec9fb8febb9acc231e73b4a1fec50e')
  })
})
