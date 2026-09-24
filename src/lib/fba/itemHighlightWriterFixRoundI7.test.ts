/**
 * itemHighlightWriterFixRoundI7.test.ts — RULING I7 (round I, phase-i1-rulings.md, Minors).
 *
 * Two of I7's four minors are pinned here (the other two — H6's headline correction and the
 * contract-derived length buckets — are documentation/refactor items, addressed separately):
 *
 * 1. "A received-but-unparseable response is a DECIDED answer: collapse to candidate 1 with no
 *    retry." VERIFIED ALREADY FIXED by RULING H4 (fix round H1) — `askWriter`'s own `parseJsonLoose`
 *    catches a JSON.parse failure internally and returns `{}`, which `runWriterForDesign`'s "no
 *    pick key" branch (H4) already collapses to candidate 1 on the FIRST call, no retry
 *    (`calls: 1`, never the retry cap). Re-ran `p1-escape.ts` (phase-h1-review-truth.md's own
 *    probe) at this round's HEAD and got `calls=1` — the parenthetical "(H4 still retries three
 *    times)" in the ruling's own text describes the PRE-H4 state, not the current one. This file
 *    pins that verified behaviour as a committed regression test instead of leaving it to a probe
 *    in scratch, so a future change that reopens the 3x-retry regression is caught here.
 *
 * 2. "Make the exactly-one-candidate path reachable and tested (H5)." The code path exists
 *    (RULING H5, `runWriterForDesign`: `candidates.length === 1` -> ship it, 0 calls) but had no
 *    test reaching it — `enumerateWriterCandidates` almost always offers BOTH a "with" and an "in"
 *    relation-word variant for the same fact, so two candidates is the common case. This test
 *    engineers a family where only one of the two variants fits the character band ("in X" fits,
 *    "with X" — two characters longer — does not), so exactly one candidate survives, and proves
 *    `runWriterForDesign` takes the zero-call path.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('must never be called: this test proves ZERO writer calls') })
vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create } } } } as never))

import { buildAdmittedUnits, enumerateWriterCandidates, runWriterForDesign, type AdmittedUnit } from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
import type { PhraseTruthCtx } from '@/lib/fba/contentTruth'
import type { BlankSpecRow } from '@/lib/fba/blankSpecs'

const NEVER: RegExp = /(?!)/
const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
const BLANK: BlankSpecRow = {
  match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '100% Ring-Spun Cotton' } as never,
  styleCode: '18000', garmentFamily: 'sweatshirt',
} as unknown as BlankSpecRow
const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: BLANK, truthCtx, capacityFamily: false, site: 'i7-test' })

describe('I7 minor: the exactly-one-candidate path (RULING H5) is reachable and tested', () => {
  // 98 chars — chosen so "…, in 100% Ring-Spun Cotton" (26 more chars = 124) clears the band, and
  // "…, with 100% Ring-Spun Cotton" (28 more chars = 126) does NOT — "with" is 2 chars longer than
  // "in", the ONLY difference between the two candidates this minimal family can ever produce.
  const IDENTITY = 'Dear Queen Gift Sweatshirt For Every Single Precious Day Of My Whole Entire Wonderful Amazing Life'
  expect(IDENTITY.length).toBe(98) // pin the fixture's own premise so a future edit to this string is caught here, not by a confusing downstream failure

  it('the search offers EXACTLY one candidate for this family (the "in" variant; "with" is band-refused)', () => {
    const composed = {
      candidates: ['Fall Graphic Crewneck Sweatshirts'], specFacts: ['100% Ring-Spun Cotton'],
      brandPick: null as string | null, brandOrigin: null as string | null, wearFact: null as string | null, needBrand: false,
    } as never
    const units: AdmittedUnit[] = buildAdmittedUnits(composed, { designName: IDENTITY, truthCtx })
    const res = enumerateWriterCandidates(units, { truthCtx, runTail, needBrand: false })
    expect(res.candidates.length).toBe(1)
    expect(res.candidates[0].line).toBe(`${IDENTITY}, in 100% Ring-Spun Cotton`)
    expect(res.candidates[0].line.length).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)
    expect(res.candidates[0].line.length).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min)
  })

  it('runWriterForDesign SHIPS that one candidate directly, with ZERO calls and reason "skip: exactly one candidate" — never asks the model to pick from a list of one', async () => {
    const composed = {
      candidates: ['Fall Graphic Crewneck Sweatshirts'], specFacts: ['100% Ring-Spun Cotton'],
      brandPick: null as string | null, wearFact: null as string | null, needBrand: false,
    }
    const r = await runWriterForDesign({
      composed, fallbackHold: 'under-floor-no-repeat', designName: IDENTITY, truthCtx, runTail,
      deps: { openai: { chat: { completions: { create } } } as never },
    })
    expect(r.accepted).toBe(true)
    expect(r.calls).toBe(0)
    expect(create).not.toHaveBeenCalled()
    expect(r.value).toBe(`${IDENTITY}, in 100% Ring-Spun Cotton`)
    expect(r.reasons).toEqual(['skip: exactly one candidate — nothing to choose between'])
  })
})

describe('I7 minor: a received-but-unparseable response collapses to candidate 1 with NO retry (RULING H4, verified already fixed)', () => {
  const IDENTITY = 'Dear Queen'
  const composed = {
    candidates: ['Fall Graphic Crewneck Sweatshirts', 'Made For Chilly Mornings'], specFacts: ['Unisex Fit'],
    brandPick: null as string | null, wearFact: null as string | null, needBrand: false,
  }

  it('a genuinely UNPARSEABLE content string (not just valid-JSON-missing-a-key) still costs exactly 1 call', async () => {
    const mockCreate = vi.fn(async () => ({ choices: [{ message: { content: 'not json at all { [ garbage' }, finish_reason: 'stop' }] }))
    const r = await runWriterForDesign({
      composed, fallbackHold: 'under-floor-no-repeat', designName: IDENTITY, truthCtx, runTail,
      deps: { openai: { chat: { completions: { create: mockCreate } } } as never },
    })
    expect(r.accepted).toBe(true)
    expect(r.calls).toBe(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(r.reasons.join(' ')).toMatch(/no "pick" key.*not a transport failure.*no retry/)
  })

  it('valid JSON with no "pick" key ALSO costs exactly 1 call (the H4 case named directly by the ruling)', async () => {
    const mockCreate = vi.fn(async () => ({ choices: [{ message: { content: '{"answer": 1}' }, finish_reason: 'stop' }] }))
    const r = await runWriterForDesign({
      composed, fallbackHold: 'under-floor-no-repeat', designName: IDENTITY, truthCtx, runTail,
      deps: { openai: { chat: { completions: { create: mockCreate } } } as never },
    })
    expect(r.accepted).toBe(true)
    expect(r.calls).toBe(1)
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })
})
