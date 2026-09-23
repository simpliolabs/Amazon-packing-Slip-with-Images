/**
 * itemHighlightWriterFixRoundF1.test.ts — Round F1 (`.superpowers/sdd/2026-09-10-ih-writer/phase-
 * f1-rulings.md`), the FIRST live shadow run: PO ran IH_WRITER=shadow on B0DSCDZC6K (2026-09-23,
 * sha `f4317ce`), pasted the writer block verbatim. Six designs, `calls: 3` each, `accepted: false`
 * each, `writer: null` each — 18 billable calls, ZERO accepted lines.
 *
 * REPRODUCES FIRST (per the task's own instruction): every case below is rebuilt from the units
 * the live rejections NAMED — the six pool-unit shapes and the one shared spec fact — run through
 * the REAL `validateArrangement`/`judgeWriterArrangement`, never a re-implementation of the
 * grammar under test. At HEAD before this round's fix, every "12 of 18" case below produced the
 * EXACT message the PO pasted:
 *   "', with' is not a legal join between '<pool unit>' and '50% Cotton / 50% Polyester' — only a
 *   join followed by 'a'/'an' is"
 * and the one padded-glue case produced:
 *   "glue token ' with ' is outside the closed glue/punctuation set"
 * (verified by temporarily reverting this round's diff and re-running this file — RED before the
 * fix, GREEN after; see `phase-f1-report.md`).
 *
 * THE FIX THIS FILE PINS:
 *   F1 (Blocking) — a LIST join may be followed by a RELATION join ("<unit>, with <spec fact>"),
 *     under the EXACT SAME right-hand-unit legality rule a bare relation join already enforces.
 *   F2 (Blocking) — a glue token is normalised (trimmed, case-folded) BEFORE being matched against
 *     the closed glue/punctuation sets, so `' with '`/`'With'`/`'with'` are one token.
 *   F3 (Important) — the prompt carries a WORKED EXAMPLE, built by CODE from THIS design's own
 *     admitted units, that itself passes `validateArrangement` and the band.
 *   F4 (Important) — the user message states the max length, the example's own length, and says
 *     plainly that an over-length line is discarded.
 *   F5 (Important) — every one of the 18 live rejections, re-measured: the 12 `', with'` attempts
 *     now ACCEPT; the 3 over-length attempts (211/270/318 chars) still REFUSE, with the precise
 *     count; the 1 padded-glue attempt now ACCEPTS.
 *
 * DO NOT (per the ruling): no truth rule widened, no other path touched, hold semantics unchanged.
 */
import { describe, it, expect } from 'vitest'
import {
  validateArrangement, renderArrangement, judgeWriterArrangement,
  type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { DEFAULT_BLANK_SPECS } from '@/lib/fba/blankSpecs'
import type { PhraseTruthCtx } from '@/lib/fba/contentTruth'

// ─── the live evidence, verbatim from phase-f1-rulings.md ─────────────────────────────────────────

/** The six pool-unit shapes the PO's pasted `writer` block named, each rejected 2x (12 of 18
 *  attempts) for the identical `', with'` join to the shared material fact below. */
const LIVE_POOL_UNITS = [
  'Embroidered Sweatshirts for Women',
  'Sweatshirts for Women Trendy',
  'Graphic Crewneck Sweatshirts Women',
  'Fall Graphic Sweatshirts for Women',
  'Fun Sweatshirts for Women',
  'Fall Crewneck',
] as const
const LIVE_MATERIAL = '50% Cotton / 50% Polyester'

/** A minimal, direct admitted-set fixture — exactly the two units a live rejection named, nothing
 *  else — so the grammar fix is isolated from every other admission/truth/readability concern. */
function liveUnits(poolText: string): AdmittedUnit[] {
  return [
    { id: 'pool', text: poolText, kind: 'pool', numberable: false },
    { id: 'mat', text: LIVE_MATERIAL, kind: 'spec-fact', numberable: false },
  ]
}
const listWithParts = (poolId = 'pool', matId = 'mat'): ArrangementPart[] => [
  { unit: poolId }, { glue: ',' }, { glue: 'with' }, { unit: matId },
]

describe('F1 (Blocking): a list join may be followed by a relation join', () => {
  for (const poolText of LIVE_POOL_UNITS) {
    it(`ACCEPTS '${poolText}, with ${LIVE_MATERIAL}' — the exact live-rejected shape`, () => {
      const units = liveUnits(poolText)
      const v = validateArrangement({ parts: listWithParts() }, units)
      expect(v.ok, !v.ok ? v.violation : '').toBe(true)
      if (v.ok) {
        expect(renderArrangement(v.parts, units)).toBe(`${poolText}, with ${LIVE_MATERIAL}`)
      }
    })
  }

  it('the SAME right-hand-unit rule a bare relation join already enforces still applies: a list join followed by "with" onto a POOL/BRAND/WEAR-FACT unit is still refused, named the SAME way a bare relation refusal is', () => {
    const units: AdmittedUnit[] = [
      { id: 'pool', text: 'Fall Crewneck', kind: 'pool', numberable: false },
      { id: 'pocket', text: 'Deep Pockets', kind: 'pool', numberable: false },
      { id: 'wear', text: 'Can be worn as Oversized', kind: 'wear-fact', numberable: false },
      { id: 'brand', text: 'Comfort Colors Tee', kind: 'pool', numberable: false, isBrand: true },
    ]
    const poolTarget = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'with' }, { unit: 'pocket' }] }, units)
    expect(poolTarget.ok).toBe(false)
    if (!poolTarget.ok) expect(poolTarget.violation).toMatch(/must introduce a spec fact/)
    const wearTarget = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'with' }, { unit: 'wear' }] }, units)
    expect(wearTarget.ok).toBe(false)
    if (!wearTarget.ok) expect(wearTarget.violation).toMatch(/cannot introduce the wear-fact unit/)
    const brandTarget = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'with' }, { unit: 'brand' }] }, units)
    expect(brandTarget.ok).toBe(false)
    if (!brandTarget.ok) expect(brandTarget.violation).toMatch(/cannot introduce the brand unit/)
  })

  it('", in" is legal under the SAME rule (relation join is "with" OR "in", not only "with")', () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'in' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
  })

  it('end to end through judgeWriterArrangement (real tail): the live shape ships when it is also in-band and true for the family', () => {
    const material = '100% Ring-Spun Cotton'
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material, fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const units: AdmittedUnit[] = [
      { id: 'id', text: "Don't Quit", kind: 'identity', numberable: false },
      { id: 'pool', text: 'Fall Graphic Sweatshirts for Women', kind: 'pool', numberable: false },
      { id: 'mat', text: material, kind: 'spec-fact', numberable: false },
      { id: 'pool2', text: 'Cute Crewnecks', kind: 'pool', numberable: false },
      { id: 'pool3', text: 'Perfect Weekend Layer', kind: 'pool', numberable: false },
    ]
    const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: DEFAULT_BLANK_SPECS[1], truthCtx, capacityFamily: false, site: 'f1-test' })
    const parts: ArrangementPart[] = [{ unit: 'id' }, { glue: ',' }, { unit: 'pool2' }, { glue: ',' }, { glue: 'with' }, { unit: 'mat' }, { glue: ',' }, { unit: 'pool' }, { glue: 'and' }, { unit: 'pool3' }]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
})

describe('F2 (Blocking): a glue token is normalised (trim + case-fold) before matching', () => {
  it("pins ' with ' (the live padded token) and 'With' as the SAME token as 'with'", () => {
    const units = liveUnits('Fall Crewneck')
    for (const spelling of [' with ', 'With', 'WITH', '\twith\n']) {
      const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: spelling }, { unit: 'mat' }] }, units)
      expect(v.ok, `'${spelling}': ${!v.ok ? v.violation : ''}`).toBe(true)
      if (v.ok) expect(renderArrangement(v.parts, units)).toBe(`Fall Crewneck with ${LIVE_MATERIAL}`)
    }
  })

  it("pins ' , ' (padded comma) as the SAME token as ','", () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ' , ' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
    if (v.ok) expect(renderArrangement(v.parts, units)).toBe(`Fall Crewneck, ${LIVE_MATERIAL}`)
  })

  it('a token that is NOT one of the closed set even after trim/fold is still refused (normalisation never widens the set itself)', () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ' For ' }, { unit: 'mat' }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/outside the closed glue\/punctuation set/)
  })

  it('the exact live case: a padded relation AFTER a list join (", with ") is accepted (F1+F2 compose)', () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: ' With ' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
  })
})

// RULING G5 (fix round G1, phase-g1-rulings.md): "Rebuild the three live over-length shapes as
// three separate pins, each asserting its own rendered count." The ORIGINAL F5 (below, until this
// round) represented the PO's 3 live 211/270/318-char rejections with ONE combined case joining
// EVERY live pool unit at once (`phase-f1-review.md` §8, Minor: "the three over-length cases are
// represented by one rebuilt case rather than the three live counts — cosmetic"). Three SEPARATE
// subset sizes below reproduce three DISTINCT overflow counts, each measured and asserted on its
// own — never one case standing in for three, and never a hand-typed expected number (every
// `expect` reads `rendered.length` back off the SAME `renderArrangement` call the judge renders
// with, so a future wording change cannot make this pin quietly assert the wrong number).
describe('F5/G5: three SEPARATE over-length live-shaped rejections, each with its OWN precise rendered count (band unchanged)', () => {
  const material = '100% Ring-Spun Cotton'
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material, fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: DEFAULT_BLANK_SPECS[1], truthCtx, capacityFamily: false, site: 'f1-test' })

  function overLengthCase(poolCount: number) {
    const pool = LIVE_POOL_UNITS.slice(0, poolCount)
    const units: AdmittedUnit[] = [
      { id: 'id', text: "Don't Quit", kind: 'identity', numberable: false },
      ...pool.map((t, i) => ({ id: `p${i}`, text: t, kind: 'pool' as const, numberable: false })),
      { id: 'mat', text: material, kind: 'spec-fact', numberable: false },
    ]
    const parts: ArrangementPart[] = [
      { unit: 'id' },
      ...pool.flatMap((_, i) => (i === 0 ? [{ glue: ',' } as ArrangementPart, { unit: `p${i}` } as ArrangementPart] : [{ glue: 'and' } as ArrangementPart, { unit: `p${i}` } as ArrangementPart])),
      { glue: ',' }, { glue: 'with' }, { unit: 'mat' },
    ]
    return { units, parts }
  }

  // Three DIFFERENT subset sizes of the SAME six live pool units — three DIFFERENT overflow
  // counts, never the same number asserted three times over.
  for (const poolCount of [3, 5, 6]) {
    it(`SHAPE (${poolCount} of 6 live pool units, 1 relation clause): overflows 125 and is named with the REAL rendered length`, () => {
      const { units, parts } = overLengthCase(poolCount)
      const rendered = renderArrangement(parts, units)
      expect(rendered.length).toBeGreaterThan(125)
      const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail })
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.violations.join(' ')).toMatch(new RegExp(`rendered ${rendered.length} chars, max 125`))
    })
  }

  it('the three shapes above are genuinely DISTINCT counts, not the same overflow measured three times', () => {
    const counts = [3, 5, 6].map((n) => renderArrangement(overLengthCase(n).parts, overLengthCase(n).units).length)
    expect(new Set(counts).size).toBe(3)
    expect(counts.every((c) => c > 125)).toBe(true)
  })
})

// ─── F3/F4: RETIRED by RULING G3/G4 (fix round G1, phase-g1-rulings.md, design change) ────────────
//
// F3 pinned `buildWorkedExample` (a single hand-built example arrangement, re-verified only against
// `validateArrangement` + the band) and F4 pinned that `buildWriterPrompt`'s user message showed it.
// `phase-f1-review.md` §3 measured F3's own example rejected by the REAL judge 130 of 130 times —
// verified against the wrong gate from the start. RULING G3 deletes `buildWorkedExample` entirely:
// every candidate line the model can ever be shown is now a MEMBER of `enumerateWriterCandidates`'s
// own output, which is verified against the REAL, FULL acceptance path (`judgeWriterArrangement`)
// by construction — there is no separate "example" to re-verify, and no unverified template can ever
// exist again. See `itemHighlightWriterFixRoundG3.test.ts` for the successor pins (the search, the
// ranking, the chooser prompt, and the fallback semantics).
