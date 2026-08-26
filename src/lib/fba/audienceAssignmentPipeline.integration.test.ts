/**
 * End-to-end precedence proof for PER-DESIGN audience (PO ruling 2026-08-26, extending the garment
 * per-design ruling — migration 062 — to audience). resolveDesignAudienceLean's own precedence is
 * unit-pinned in audienceAssignment.test.ts; THIS file proves the wiring actually reaches
 * runListingPipeline — that a design's own assignment (audience_lean_by_design, migration 066)
 * overrides the family's audience_lean for THAT design's ctx, while an unassigned sibling design in
 * the SAME family still inherits the family value untouched (the no-op-until-assigned safety
 * property, verified through the real pipeline, not just the pure resolver).
 *
 * Drives the REAL runListingPipeline() with a stubbed OpenAI client (no network) — same harness as
 * gatePerChildMultiDesign.integration.test.ts, whose own header documents the CI trap this guards
 * against: build.yml's placeholder Supabase env makes every lazy-Proxy Supabase client (blankSpecs.ts
 * etc.) attempt a real ~4s-per-call network request instead of failing open synchronously. Nulling
 * the three Supabase env vars for the duration of this file restores the synchronous fail-open path
 * regardless of what the CI runner exports.
 *
 * WHAT THIS PROVES, PRECISELY: `buildGroupTruthCtx` (listingPipeline.ts) logs one DESIGN_AUDIENCE_TRUTH
 * line per design group, tagging the decision 'design-assignment' or 'family-default' — the SAME
 * resolveDesignAudienceLean() call that also sets (a) this group's PhraseTruthCtx.audienceLean (feeds
 * audience-lean-lie, contentTruth.ts), (b) perDesignTruthCtx's raw `lean` (feeds the cross-gender veto
 * via titleScopeFor -> moneyCtx.lean / titleBandCtx().lean, titleBand.ts — untouched), and (c)
 * groupInput.audienceLean (feeds runTitleAgent's own writer-stage gender filtering). One resolution,
 * three consumers, asserted here via its one shared log line — the seam every consumer reads from is
 * either provably right (as this file confirms), or provably wrong for all three at once.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { runListingPipeline, type PipelineInput, type PipelineChild } from './listingPipeline'

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

const KITCHEN_SINK = {
  title: 'THE CEO Gator Bites Graphic Tee | Long Sleeve Comfort Colors Shirt',
  bullets: [
    'PLAYFUL DESIGN - A fun graphic print that stands out in any crowd, made for everyday wear.',
    'SOFT COMFORT - Garment-dyed ring-spun cotton feels soft against skin, wash after wash.',
    'GREAT GIFT - A thoughtful gift for birthdays, holidays, or just because they deserve it.',
    'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
    'TRUE TO SIZE - Relaxed unisex fit runs true to size for a comfortable everyday silhouette.',
  ],
  description: '<p>A fun graphic tee for everyday wear.</p><ul><li>Soft cotton</li><li>Relaxed fit</li></ul><p>Great gift.</p>',
  backend_drop: [],
}

function makeOpenAiStub() {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(KITCHEN_SINK) }, finish_reason: 'stop' }] })),
      },
    },
  } as unknown as PipelineInput['openai']
}

function makeChildren(): PipelineChild[] {
  return [
    { sku: 'GATOR-M-BLK', asin: 'B0GATORMBLK', color: 'Black', size: 'M' },
    { sku: 'GATOR-L-BLK', asin: 'B0GATORLBLK', color: 'Black', size: 'L' },
    { sku: 'SHARK-M-BLK', asin: 'B0SHARKMBLK', color: 'Black', size: 'M' },
    { sku: 'SHARK-L-BLK', asin: 'B0SHARKLBLK', color: 'Black', size: 'L' },
  ]
}

function makeBaseInput(openai: PipelineInput['openai']): PipelineInput {
  const children = makeChildren()
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SHIRT',
    analysis: [],
    children,
    repTitle: 'THE CEO Graphic Tee',
    canonicalTitle: 'THE CEO Graphic Tee',
    priorTitle: 'THE CEO Graphic Tee',
    priorBullets: KITCHEN_SINK.bullets,
    variantDetails: '',
    keywordContext: '',
    hasAplus: false,
    hasBrandStory: false,
    auditModel: 'o4-mini',
    onProgress: () => {},
    // Two design groups (GATOR / SHARK) — same fixture shape as gatePerChildMultiDesign.integration.test.ts.
    priorPerChildTitles: [
      { sku: 'GATOR-M-BLK', asin: 'B0GATORMBLK', title: 'THE CEO Gator Bites Tee', designName: 'Gator Bites', designKey: 'GATOR' },
      { sku: 'GATOR-L-BLK', asin: 'B0GATORLBLK', title: 'THE CEO Gator Bites Tee', designName: 'Gator Bites', designKey: 'GATOR' },
      { sku: 'SHARK-M-BLK', asin: 'B0SHARKMBLK', title: 'THE CEO Shark Week Tee', designName: 'Shark Week', designKey: 'SHARK' },
      { sku: 'SHARK-L-BLK', asin: 'B0SHARKLBLK', title: 'THE CEO Shark Week Tee', designName: 'Shark Week', designKey: 'SHARK' },
    ],
  }
}

/** Every DESIGN_AUDIENCE_TRUTH log line the run emitted, parsed, keyed by design (last write wins —
 *  the per-design loop resolves each group's audience once per title-fan-out pass). */
function captureAudienceTruthLog(spy: ReturnType<typeof vi.spyOn>): Record<string, { decision: string; lean: string | null; familyLean: string | null }> {
  const out: Record<string, { decision: string; lean: string | null; familyLean: string | null }> = {}
  for (const call of spy.mock.calls) {
    const line = call[0]
    if (typeof line !== 'string' || !line.includes('DESIGN_AUDIENCE_TRUTH')) continue
    try {
      const parsed = JSON.parse(line) as { tag?: string; design?: string; decision?: string; lean?: string | null; familyLean?: string | null }
      if (parsed.tag === 'DESIGN_AUDIENCE_TRUTH' && parsed.design) {
        out[parsed.design] = { decision: parsed.decision ?? '', lean: parsed.lean ?? null, familyLean: parsed.familyLean ?? null }
      }
    } catch { /* not JSON — some other log line sharing a substring; ignore */ }
  }
  return out
}

describe('per-design audience precedence — real runListingPipeline', () => {
  it('an ASSIGNED design (SHARK) uses its OWN audience; an UNASSIGNED sibling (GATOR) inherits the family value', async () => {
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const input: PipelineInput = {
      ...makeBaseInput(openai),
      audienceLean: 'lean_male',
      audienceLeanByDesign: { SHARK: 'female' },
    }
    const result = await runListingPipeline(input)
    const truth = captureAudienceTruthLog(logSpy)
    logSpy.mockRestore()

    // Sanity: a genuine multi-design run, not a misclassification (a false pass from never
    // reaching the per-design fan-out would be meaningless — same guard the sibling test file uses).
    expect(result.debug.multiDesign).toBe(true)
    expect(result.debug.designGroups?.sort()).toEqual(['GATOR', 'SHARK'])

    expect(truth.SHARK).toEqual({ decision: 'design-assignment', lean: 'female', familyLean: 'lean_male' })
    expect(truth.GATOR).toEqual({ decision: 'family-default', lean: 'lean_male', familyLean: 'lean_male' })

    // Every produced per-child title is non-empty and within Amazon's title ceiling — length AND
    // content, on both the assigned and the inherited design (both paths ran the real title door).
    const bySku = new Map((result.per_child_titles ?? []).map((t) => [t.sku, t.title]))
    for (const sku of ['GATOR-M-BLK', 'SHARK-M-BLK']) {
      const title = bySku.get(sku)
      expect(title).toBeTruthy()
      expect((title ?? '').length).toBeGreaterThan(0)
      expect((title ?? '').length).toBeLessThanOrEqual(200)
    }
  }, 30_000)

  it('the no-op-until-assigned property: with NO audienceLeanByDesign at all, EVERY design still resolves the family value (byte-identical to pre-066 behavior)', async () => {
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    // audienceLeanByDesign OMITTED entirely — the exact shape every pre-existing PipelineInput caller
    // already sends today.
    const input: PipelineInput = { ...makeBaseInput(openai), audienceLean: 'lean_female' }
    const result = await runListingPipeline(input)
    const truth = captureAudienceTruthLog(logSpy)
    logSpy.mockRestore()

    expect(result.debug.multiDesign).toBe(true)
    expect(truth.GATOR).toEqual({ decision: 'family-default', lean: 'lean_female', familyLean: 'lean_female' })
    expect(truth.SHARK).toEqual({ decision: 'family-default', lean: 'lean_female', familyLean: 'lean_female' })
  }, 30_000)

  it('with NO family audienceLean either, an unassigned design resolves to null — never a guessed gender', async () => {
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const input: PipelineInput = { ...makeBaseInput(openai) } // audienceLean absent, audienceLeanByDesign absent
    const result = await runListingPipeline(input)
    const truth = captureAudienceTruthLog(logSpy)
    logSpy.mockRestore()

    expect(result.debug.multiDesign).toBe(true)
    expect(truth.GATOR).toEqual({ decision: 'family-default', lean: null, familyLean: null })
    expect(truth.SHARK).toEqual({ decision: 'family-default', lean: null, familyLean: null })
  }, 30_000)
})
