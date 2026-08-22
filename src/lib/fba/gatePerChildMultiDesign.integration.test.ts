/**
 * Behavioral proof for FIX 2 (2026-08-22 cost-guard pass): a bullets-only regen on a multi-design
 * family must NOT invoke the per-child editorial audit (gatePerChildMultiDesign's
 * runFinalEditorialAudit loop, up to MULTI_DESIGN_AUDIT_MAX_GROUPS sequential gpt-4.1 calls) —
 * that used to fire on every regen path this gate is invoked from, including partial section
 * regens, so a multi-design "Regenerate bullets" click paid up to 8x what the identical click
 * pays on a single-design family.
 *
 * Drives the REAL runListingPipeline() with a stubbed OpenAI client (no network) so the guard is
 * exercised as production would hit it, not re-implemented as a second copy of the condition.
 */
import { describe, it, expect, vi } from 'vitest'
import { runListingPipeline, type PipelineInput, type PipelineChild } from './listingPipeline'

/** A generic "kitchen sink" JSON payload — every field any JSON-mode caller in the bullets-only
 *  multi-design path might read, so ANY of them can parse a valid, non-empty result regardless of
 *  which prompt fired. The pipeline's LLM-calling helpers are documented fail-open (try/catch ->
 *  fallback) almost everywhere EXCEPT the broadcast-bullets "empty = failed" adversarial gate
 *  (assertCoreHealthy) — this payload exists to keep that one gate satisfied. */
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

let callCount = 0
let auditCallCount = 0
const AUDIT_FINGERPRINT = 'senior Amazon apparel listing EDITOR'

function makeOpenAiStub() {
  callCount = 0
  auditCallCount = 0
  return {
    chat: {
      completions: {
        create: vi.fn(async (args: { model?: string; messages?: { content?: string }[] }) => {
          callCount++
          const sys = args?.messages?.[0]?.content ?? ''
          if (args?.model === 'gpt-4.1' && sys.includes(AUDIT_FINGERPRINT)) auditCallCount++
          return { choices: [{ message: { content: JSON.stringify(KITCHEN_SINK) }, finish_reason: 'stop' }] }
        }),
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
    // Two design groups (GATOR / SHARK), each with 2 SKUs — detectDesignGroups(children) resolves
    // this the same way live SKUs do (no override needed): designKeyForSku() strips the size token,
    // leaving "GATOR" / "SHARK" as the two design keys, each with >=2 SKUs -> isMultiDesign.
    priorPerChildTitles: [
      { sku: 'GATOR-M-BLK', asin: 'B0GATORMBLK', title: 'THE CEO Gator Bites Tee', designName: 'Gator Bites', designKey: 'GATOR' },
      { sku: 'GATOR-L-BLK', asin: 'B0GATORLBLK', title: 'THE CEO Gator Bites Tee', designName: 'Gator Bites', designKey: 'GATOR' },
      { sku: 'SHARK-M-BLK', asin: 'B0SHARKMBLK', title: 'THE CEO Shark Week Tee', designName: 'Shark Week', designKey: 'SHARK' },
      { sku: 'SHARK-L-BLK', asin: 'B0SHARKLBLK', title: 'THE CEO Shark Week Tee', designName: 'Shark Week', designKey: 'SHARK' },
    ],
  }
}

describe('gatePerChildMultiDesign — partial vs full regen on a multi-design family', () => {
  it('a bullets-only regen makes ZERO per-child editorial audit calls', async () => {
    const openai = makeOpenAiStub()
    const input: PipelineInput = { ...makeBaseInput(openai), onlySection: 'bullets' }
    const result = await runListingPipeline(input)
    expect(auditCallCount).toBe(0)
    // Sanity: this is a real multi-design run (2 groups resolved), not a no-op from
    // misclassification — a false "0 calls" from never reaching the gate at all would be a
    // meaningless pass. per_child_bullets carries each group's OWN generated content.
    expect(result.debug.multiDesign).toBe(true)
    expect(result.debug.designGroups).toEqual(['GATOR', 'SHARK'])
    expect(result.per_child_bullets?.length).toBe(4)
  }, 30_000)

  it('a FULL regen still invokes the per-child editorial audit (one call per design group)', async () => {
    const openai = makeOpenAiStub()
    // No onlySection => full regen. The title branch runs too (buildNicheParentTitle for the
    // multi-design parent + per-design title generation), which is what resolves
    // designGroupContexts on the full path — a heavier call graph than the bullets-only cheap
    // rebuild, but the SAME kitchen-sink stub satisfies every JSON-mode caller along it.
    const input: PipelineInput = makeBaseInput(openai)
    const result = await runListingPipeline(input)
    expect(auditCallCount).toBeGreaterThan(0)
    expect(auditCallCount).toBeLessThanOrEqual(2) // 2 design groups, budget-capped at MULTI_DESIGN_AUDIT_MAX_GROUPS
    expect(result.debug.multiDesign).toBe(true)
  }, 30_000)
})
