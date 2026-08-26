/**
 * End-to-end precedence proof for PER-DESIGN audience (PO ruling 2026-08-26, extending the garment
 * per-design ruling — migration 062 — to audience). resolveDesignAudienceLean's own precedence is
 * unit-pinned in audienceAssignment.test.ts; THIS file proves the wiring actually reaches
 * runListingPipeline — that a design's own assignment (audience_lean_by_design, migration 070)
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
 *
 * BLANK CATALOG STUB (review finding, 2026-08-26): the real `loadBlankSpecRows` fails open to
 * `DEFAULT_BLANK_SPECS` once the Supabase env is nulled below, but those two seed rows only match
 * "comfort colors" / "gildan"/"64000" — text this fixture's hay never contained — so
 * `resolveFamilyBlank` returned NO garmentFamily for either design group, `buildGroupTruthCtx` logged
 * DESIGN_GARMENT_TRUTH 'inherit-family-dominant' for BOTH, and `perDesignTruthCtx.set` never ran for
 * either — every test below passed with the per-design garment wire (and Fix A's perDesignLean wire,
 * gated identically) fully severed. The stub row's `match` regex targets "shirt", which every design
 * group's hay carries unconditionally via `input.productType` (see buildGroupTruthCtx's caller),
 * so both GATOR and SHARK now resolve their OWN blank regardless of title/vision text.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('@/lib/fba/blankSpecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fba/blankSpecs')>()
  const stubRows: import('@/lib/fba/blankSpecs').BlankSpecRow[] = [
    { match: /\bshirt\b/i, spec: { brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck' }, styleCode: '1717', garmentFamily: 'tee' },
  ]
  return { ...actual, loadBlankSpecRows: vi.fn(async () => stubRows) }
})

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

/** Every DESIGN_GARMENT_TRUTH log line the run emitted, parsed, keyed by design (last write wins,
 *  same convention as captureAudienceTruthLog above). Proves the Fix D blank-catalog stub actually
 *  makes both design groups resolve their OWN blank ('own-blank') rather than the
 *  'inherit-family-dominant' fallback that silently skipped perDesignTruthCtx.set (and Fix A's
 *  perDesignLean.set, gated identically) in every test in this file before the stub existed. */
function captureGarmentTruthLog(spy: ReturnType<typeof vi.spyOn>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const call of spy.mock.calls) {
    const line = call[0]
    if (typeof line !== 'string' || !line.includes('DESIGN_GARMENT_TRUTH')) continue
    try {
      const parsed = JSON.parse(line) as { tag?: string; design?: string; decision?: string }
      if (parsed.tag === 'DESIGN_GARMENT_TRUTH' && parsed.design) out[parsed.design] = parsed.decision ?? ''
    } catch { /* not JSON — some other log line sharing a substring; ignore */ }
  }
  return out
}

/** Every DESIGN_BAND_LEAN log line the run emitted (Fix A, review finding 2026-08-26), parsed, keyed
 *  by design (last write wins). `titleScopeFor` logs this once per CHILD, so a two-child design group
 *  logs twice with the same value; last-write-wins collapses that to one entry per design, same as
 *  the other capture helpers here. Proves the band itself received this design's OWN resolved lean —
 *  the thing DESIGN_AUDIENCE_TRUTH alone could only prove by inference. */
function captureBandLeanLog(spy: ReturnType<typeof vi.spyOn>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const call of spy.mock.calls) {
    const line = call[0]
    if (typeof line !== 'string' || !line.includes('DESIGN_BAND_LEAN')) continue
    try {
      const parsed = JSON.parse(line) as { tag?: string; design?: string; lean?: string | null }
      if (parsed.tag === 'DESIGN_BAND_LEAN' && parsed.design) out[parsed.design] = parsed.lean ?? null
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
    const garmentTruth = captureGarmentTruthLog(logSpy)
    logSpy.mockRestore()

    // Sanity: a genuine multi-design run, not a misclassification (a false pass from never
    // reaching the per-design fan-out would be meaningless — same guard the sibling test file uses).
    expect(result.debug.multiDesign).toBe(true)
    expect(result.debug.designGroups?.sort()).toEqual(['GATOR', 'SHARK'])

    // The blank-catalog stub (top of file) must make BOTH groups resolve their OWN blank — the
    // 'inherit-family-dominant' fallback is exactly the path that never wrote perDesignTruthCtx (or
    // Fix A's perDesignLean) in every test in this file before the stub existed.
    expect(garmentTruth.SHARK).toBe('own-blank')
    expect(garmentTruth.GATOR).toBe('own-blank')

    expect(truth.SHARK).toEqual({ decision: 'design-assignment', lean: 'female', familyLean: 'lean_male' })
    expect(truth.GATOR).toEqual({ decision: 'family-default', lean: 'lean_male', familyLean: 'lean_male' })

    // Every produced per-child title is within Amazon's ceiling AND above the standing 65-char floor
    // (#646/#647 — the reverted-live class where a correct removal collapsed a title to 29-49 chars
    // with no floor to catch it), on both the assigned and the inherited design.
    const bySku = new Map((result.per_child_titles ?? []).map((t) => [t.sku, t.title]))
    for (const sku of ['GATOR-M-BLK', 'SHARK-M-BLK']) {
      const title = bySku.get(sku) ?? ''
      expect(title.length).toBeGreaterThanOrEqual(65)
      expect(title.length).toBeLessThanOrEqual(200)
    }
    // Content, not just length — the assertion that would have caught #649: SHARK is assigned
    // 'female' and must never read "for Men"; GATOR inherits the family's 'lean_male' and must never
    // read "for Women". A pre-Fix-C run collapsed an inclusive tail toward the FAMILY's gender on a
    // design the PO declared the other way — this is exactly that class, on both directions.
    expect(bySku.get('SHARK-M-BLK') ?? '').not.toMatch(/\bfor Men\b/i)
    expect(bySku.get('GATOR-M-BLK') ?? '').not.toMatch(/\bfor Women\b/i)
  }, 30_000)

  it('the no-op-until-assigned property: with NO audienceLeanByDesign at all, EVERY design still resolves the family value (byte-identical to pre-070 behavior)', async () => {
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

  it('a SOFT per-design assignment (lean_female) resolves and reaches the band exactly like a hard one — enforceHardAudience (titleBand.ts) never fires for soft/unisex leans, so Fix B/A have no downstream repair to fall back on here', async () => {
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const input: PipelineInput = {
      ...makeBaseInput(openai),
      audienceLean: 'unisex',
      audienceLeanByDesign: { SHARK: 'lean_female' },
    }
    const result = await runListingPipeline(input)
    const truth = captureAudienceTruthLog(logSpy)
    const bandLean = captureBandLeanLog(logSpy)
    logSpy.mockRestore()

    expect(result.debug.multiDesign).toBe(true)
    expect(truth.SHARK).toEqual({ decision: 'design-assignment', lean: 'lean_female', familyLean: 'unisex' })
    expect(truth.GATOR).toEqual({ decision: 'family-default', lean: 'unisex', familyLean: 'unisex' })
    // The SAME soft lean must reach the band (Fix A) — a hard male/female assignment gets a second
    // downstream repair pass (enforceHardAudience) that a soft lean_male/lean_female/unisex value
    // never triggers, so this seam is the ONLY place a soft per-design assignment can take effect.
    expect(bandLean.SHARK).toBe('lean_female')
    expect(bandLean.GATOR).toBe('unisex')
  }, 30_000)

  it('DESIGN_BAND_LEAN (Fix A) reports the ASSIGNED lean for the assigned design and the FAMILY lean for the unassigned sibling, in the same run', async () => {
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const input: PipelineInput = {
      ...makeBaseInput(openai),
      audienceLean: 'lean_male',
      audienceLeanByDesign: { SHARK: 'female' },
    }
    await runListingPipeline(input)
    const bandLean = captureBandLeanLog(logSpy)
    logSpy.mockRestore()

    // Before Fix A, titleScopeFor's `band.lean` fell back to the bare family `lean` whenever
    // perDesignTruthCtx had no entry for this key — exactly the state a design whose blank never
    // resolves is left in. This is the seam the live gate now reads directly instead of inferring
    // from DESIGN_AUDIENCE_TRUTH plus silence.
    expect(bandLean.SHARK).toBe('female')
    expect(bandLean.GATOR).toBe('lean_male')
  }, 30_000)
})
