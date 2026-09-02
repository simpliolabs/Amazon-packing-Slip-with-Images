/**
 * END-TO-END PROOF for the attribute spec-grounding fix (PR #663, 2026-09-02).
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DEMANDED BY REVIEW (coordinator, blocking PR #662 merge): the PR's original report proved the
 * subtractive half of the fix (scrubUnspecdGarmentClaims strips "Oversized", 74->64 chars) at the
 * NET level only, and asserted — did not measure — that the existing downstream facts-pad/money-tail
 * machinery would refill the freed characters back into band. That is precisely the shape of the
 * #630/#631 revert class: a subtractive net whose additive counterpart is assumed, not proven. This
 * file closes that gap by driving the REAL runListingPipeline() end-to-end and asserting on the bytes
 * that would actually persist to `recommended_title` (the DB column a single-design apparel family —
 * B0DP5H8QBT's 12 same-design youth-tee SKUs — ships to every child; `per_child_titles` exists only
 * for capacity/size-spec variation families, per PipelineResult's own doc comment, so it does not
 * apply here).
 *
 * Same harness as garmentAgeProducer.integration.test.ts / audienceAssignmentPipeline.integration.
 * test.ts / gatePerChildMultiDesign.integration.test.ts: a stubbed OpenAI client and a stubbed blank
 * catalog, Supabase env nulled for the file's duration (RESTORED in afterAll) to dodge the CI trap
 * (build.yml's placeholder Supabase env makes every lazy-Proxy client attempt a real ~4s network
 * call instead of failing open synchronously).
 *
 * TWO CASES, not one:
 *   1. THE LIVE SPECIMEN ("oversized") — B0DP5H8QBT's actual reported defect text. Investigating this
 *      end-to-end revealed that `scrubUnspecdGarmentClaims`'s PRE-EXISTING `FIT_CLAIM_RE` already
 *      matched bare "oversized" before PR #663 (proven manually during review by running this exact
 *      case against the pre-#663 titleBand.ts and observing an IDENTICAL result) — so this case
 *      alone would not prove THIS PR's diff is load-bearing.
 *   2. THE NEW-VOCABULARY CASE ("fitted") — one of the five words PR #663 actually added
 *      (fitted/cropped/baggy/tapered/loose). Proven RED against pre-#663 titleBand.ts (the word
 *      survives byte-for-byte, 71 chars, untouched, no SHIP_SPEC_TRUTH removal at all) and GREEN
 *      against the fix (stripped, refilled to the identical 73-char truthful title). This is the
 *      case that actually pins the diff.
 *
 * "PROVE THE BRANCH RAN, NOT JUST THE OUTPUT": every case captures the SHIP_SPEC_TRUTH console.log
 * line and asserts on its `removed` field (the net's own decision record), never merely on the
 * absence of the word from the final string — a title that never contained the false word in the
 * first place would pass a string-absence check without the net ever having fired.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ''

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('@/lib/fba/blankSpecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fba/blankSpecs')>()
  return { ...actual, loadBlankSpecRows: vi.fn(async () => [] as import('@/lib/fba/blankSpecs').BlankSpecRow[]) }
})

import { loadBlankSpecRows, type BlankSpecRow } from '@/lib/fba/blankSpecs'
import { runListingPipeline, type PipelineInput, type PipelineChild } from './listingPipeline'
import { TITLE_SHIP_FLOOR, TITLE_BAND_LO, TITLE_BAND_HI } from './titleBand'
import type { AnalyzedKeyword } from '../keyword-engine/engine'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; delete process.env[key] }
})
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedSupabaseEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedSupabaseEnv[key]
  }
})

const mockedLoadBlankSpecRows = vi.mocked(loadBlankSpecRows)

// The REAL 64000B row (migration 058:87-89), verbatim: fit='Classic', sleeve='Short Sleeve',
// neck='Crew Neck', weightNote='lightweight 4.5 oz ring-spun', material='Ring-Spun Cotton'. This is
// the TRUE vocabulary the pad must draw from — "Short Sleeve"/"Crew Neck" surviving in the final
// title is the proof the refill is spec-grounded, not invented.
function makeKidsBlankRow(): BlankSpecRow {
  return {
    match: /\bshirt\b/i,
    spec: {
      brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck',
      weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton',
    },
    styleCode: '64000B', garmentFamily: 'kids_tee',
  } as BlankSpecRow
}

function makeChildren(): PipelineChild[] {
  // SKU shape mirrors garmentAgeProducer.integration.test.ts's proven-working pattern (a style code
  // glued after a design prefix) so SKU-first blank resolution actually fires — confirmed live via
  // the BLANK_RESOLVE log (source:"sku-code", styleCode:"64000B", garmentFamily:"kids_tee").
  return [
    { sku: 'DONTQUIT64000B-XS-BLK', asin: 'B0DQXSBLK01', color: 'Black', size: 'XS' },
    { sku: 'DONTQUIT64000B-S-BLK', asin: 'B0DQSBLK002', color: 'Black', size: 'S' },
    { sku: 'DONTQUIT64000B-M-BLK', asin: 'B0DQMBLK003', color: 'Black', size: 'M' },
    { sku: 'DONTQUIT64000B-L-BLK', asin: 'B0DQLBLK004', color: 'Black', size: 'L' },
  ]
}

function makeOpenAiStub(defectTitle: string): PipelineInput['openai'] {
  const payload = {
    title: defectTitle,
    bullets: [
      'SOFT COMFORT - Made from ring-spun cotton, this youth tee feels soft against skin all day long.',
      'GREAT GIFT - A thoughtful motivational gift for birthdays, holidays, or just because they deserve it.',
      'TRUE TO SIZE - Classic fit runs true to size for a comfortable everyday silhouette for kids.',
      'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
      'PLAYFUL DESIGN - A fun motivational graphic print that stands out in any crowd, made for kids.',
    ],
    description: '<p>A motivational tee for kids.</p><ul><li>Soft ring-spun cotton</li><li>Classic fit</li></ul><p>Great gift.</p>',
    backend_drop: [],
    product_details_improvements: [],
  }
  return {
    chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] })) } },
  } as unknown as PipelineInput['openai']
}

const mk = (o: Partial<AnalyzedKeyword> & { keyword: string }): AnalyzedKeyword => ({
  coverageGapScore: 50, actionType: 'UPGRADE', actionText: '', rationale: '', urgency: 'medium',
  estimatedImpact: '', searchVolume: 1000, keywordSales: 0, competingProducts: 1000,
  asinImpressionShare: 0, asinClickShare: 0, asinPurchaseShare: 0,
  inTitle: false, inBullets: false, inDescription: false, inBackend: false,
  dataSource: 'jungle_scout', titleDensity: null, organicRank: null,
  ...o,
})

/** A B0DP5H8QBT-shaped pool: high-volume "<attribute> tshirts for women" market vocabulary (the
 *  exact class this defect promotes to a product claim) alongside genuine on-design phrases, so the
 *  pipeline has real candidates to choose from — not a pool engineered to have nothing else to say. */
function makePool(attributeWord: string): AnalyzedKeyword[] {
  return [
    mk({ keyword: `${attributeWord} tshirts for women`, searchVolume: 385_892, coverageGapScore: 90, actionType: 'CRITICAL' }),
    mk({ keyword: 'motivational shirts for kids', searchVolume: 12_000, coverageGapScore: 85, actionType: 'CRITICAL' }),
    mk({ keyword: "don't quit shirt", searchVolume: 4_000, coverageGapScore: 70, actionType: 'UPGRADE' }),
    mk({ keyword: 'kids graphic tee', searchVolume: 8_000, coverageGapScore: 60, actionType: 'UPGRADE' }),
    mk({ keyword: 'youth motivational t shirt', searchVolume: 3_000, coverageGapScore: 55, actionType: 'UPGRADE' }),
  ]
}

function makeInput(openai: PipelineInput['openai'], defectTitle: string, attributeWord: string): PipelineInput {
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SHIRT',
    analysis: makePool(attributeWord),
    children: makeChildren(),
    repTitle: defectTitle,
    canonicalTitle: defectTitle,
    priorTitle: defectTitle,
    priorBullets: [],
    variantDetails: '',
    keywordContext: '',
    hasAplus: false,
    hasBrandStory: false,
    auditModel: 'o4-mini',
    onProgress: () => {},
    audienceLean: 'unisex',
  }
}

/** The SHIP_SPEC_TRUTH log line (titleBand.ts's settleTitle, step 3) — the net's own decision
 *  record. Returns null if the net never fired (nothing removed / not reached), which is itself
 *  meaningful: a case that expects a removal must find a non-null entry whose `removed` names the
 *  exact word, not merely observe the word's absence from the final string. */
function captureSpecTruthLog(spy: ReturnType<typeof vi.spyOn>): { removed: string[]; from: number; to: number } | null {
  for (const call of spy.mock.calls) {
    const line = call[0]
    if (typeof line !== 'string' || !line.includes('SHIP_SPEC_TRUTH')) continue
    try {
      const parsed = JSON.parse(line) as { tag?: string; removed?: string[]; from?: number; to?: number }
      if (parsed.tag === 'SHIP_SPEC_TRUTH') return { removed: parsed.removed ?? [], from: parsed.from ?? 0, to: parsed.to ?? 0 }
    } catch { /* not JSON */ }
  }
  return null
}

describe('attribute spec-grounding — end-to-end through the REAL runListingPipeline (PR #663)', () => {
  it('THE LIVE SPECIMEN (B0DP5H8QBT, "oversized"): the persisted title reaches the 70-75 band, refilled from TRUE blank facts, and never claims "oversized"', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([makeKidsBlankRow()])
    const DEFECT = "THE CEO Don't Quit Motivational T-Shirt | Kids Oversized Tshirts Crew Neck"
    expect(DEFECT.length).toBe(74) // the exact live specimen, character-for-character
    const openai = makeOpenAiStub(DEFECT)
    const logSpy = vi.spyOn(console, 'log')
    const result = await runListingPipeline(makeInput(openai, DEFECT, 'oversized'))
    const specTruth = captureSpecTruthLog(logSpy)
    logSpy.mockRestore()

    // Prove the branch RAN — the net's own decision, not merely the final string's content.
    expect(specTruth).not.toBeNull()
    expect(specTruth!.removed).toEqual(['Oversized'])
    expect(specTruth!.from).toBe(74)
    expect(specTruth!.to).toBe(64)

    const shipped = result.recommended_title
    // THE FLOOR: must never persist below the derived ship floor (68 today) — the exact concern
    // this test exists to close. Report the ACTUAL number, not merely a pass/fail.
    const floor = TITLE_SHIP_FLOOR()
    expect(floor).toBe(68)
    expect(shipped.length).toBeGreaterThanOrEqual(floor)
    // IDEALLY 70-75 (the golden band), not merely above the correctness floor.
    expect(shipped.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(shipped.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    expect(shipped).not.toMatch(/oversized/i)
    // The pad's refill vocabulary is TRUE, spec-backed material — "Crew Neck"/"Short Sleeve" are the
    // exact facts makeKidsBlankRow() declares, not invented copy.
    expect(shipped).toContain('Crew Neck')
    // Pinned exact value — the real, measured, reproducible end-to-end result (stable across 3
    // consecutive runs during investigation; a change here means the pipeline's behavior moved and
    // this test's job is to surface that, not to silently keep passing).
    expect(shipped).toBe("THE CEO Don't Quit Motivational T-Shirt | Kids Short Sleeve Crew Neck Tee")
    expect(shipped.length).toBe(73)
  }, 60_000)

  it('THE NEW-VOCABULARY CASE ("fitted", one of the 5 words PR #663 actually added): identical end-to-end shape — proves THIS diff is load-bearing, not merely the pre-existing "oversized" handling', async () => {
    // WHY THIS SECOND CASE EXISTS: investigating the "oversized" case above end-to-end revealed that
    // scrubUnspecdGarmentClaims's PRE-EXISTING FIT_CLAIM_RE already matched bare "oversized" before
    // PR #663 (its own six-word list already included it) — running the case above against the
    // pre-#663 titleBand.ts produces an IDENTICAL 73-char result. "fitted" is NOT in that pre-#663
    // list (confirmed: pre-#663, this exact case ships "...Kids Fitted Tshirts Crew Neck" at 71
    // chars, byte-identical in/out, no SHIP_SPEC_TRUTH removal at all). This case is therefore the
    // one that actually pins PR #663's diff end-to-end.
    mockedLoadBlankSpecRows.mockResolvedValueOnce([makeKidsBlankRow()])
    const DEFECT = "THE CEO Don't Quit Motivational T-Shirt | Kids Fitted Tshirts Crew Neck"
    expect(DEFECT.length).toBe(71)
    const openai = makeOpenAiStub(DEFECT)
    const logSpy = vi.spyOn(console, 'log')
    const result = await runListingPipeline(makeInput(openai, DEFECT, 'fitted'))
    const specTruth = captureSpecTruthLog(logSpy)
    logSpy.mockRestore()

    expect(specTruth).not.toBeNull()
    expect(specTruth!.removed).toEqual(['Fitted'])
    expect(specTruth!.from).toBe(71)
    expect(specTruth!.to).toBe(64)

    const shipped = result.recommended_title
    const floor = TITLE_SHIP_FLOOR()
    expect(shipped.length).toBeGreaterThanOrEqual(floor)
    expect(shipped.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(shipped.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    expect(shipped).not.toMatch(/fitted/i)
    expect(shipped).toContain('Crew Neck')
    // Same refill target as the "oversized" case — the pad draws from the SAME true blank facts
    // regardless of which false word it had to remove first.
    expect(shipped).toBe("THE CEO Don't Quit Motivational T-Shirt | Kids Short Sleeve Crew Neck Tee")
    expect(shipped.length).toBe(73)
  }, 60_000)
})
