/**
 * ROUND S (2026-09-24, live B0DSCDZC6K) — S2/S4 end-to-end, driving the REAL runListingPipeline()
 * on a bullets-only SECTION regen (the exact click the PO's "just regenerate" instruction meant,
 * and the one VERDICT.md §5 proves CANNOT self-heal without a code fix landing first).
 *
 * THE RATCHET (S4): `input.priorPerChildTitles` carries a STORED `designName` for the "HDG" group
 * that is actually the SIBLING "BB" group's name — exactly what a prior mis-resolution (the LLM
 * picking the wrong substring out of a contaminated title) would leave behind. The bullets-only
 * rebuild path (`listingPipeline.ts`'s `byKey` rebuild) never re-resolves a stored design name via
 * vision/LLM — before S4, `ctx.designName` for HDG would be handed the sibling's name VERBATIM, and
 * the deterministic identity floor (`bulletCoverageFloor`, design-name-only, `runBulletsAgent`)
 * FORCE-WEAVES it into a bullet regardless of what the (stubbed) LLM returned — so this reproduces
 * end-to-end with a static JSON stub, no LLM behavior to simulate.
 *
 * THE SHIP DOOR (S2): even if a wrong identity slipped past S4 for any reason, `scrubPublished`'s
 * per-child ship door must still refuse a bullet naming a sibling design before it is persisted.
 *
 * Same hermetic harness as gatePerChildMultiDesign.integration.test.ts (stubbed OpenAI, no network,
 * Supabase env neutralized so every lazy-Proxy client fails open synchronously).
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

/** Clean, generic bullets — NONE of them name "Business B*tch" or any design at all. Whatever the
 *  test observes naming it must come from the pipeline's OWN identity-floor/ship-door machinery,
 *  never from the stub. */
const CLEAN_BULLETS = [
  'PREMIUM COMFORT - Soft ringspun cotton keeps you comfortable through a full day of hustle.',
  'RELAXED FIT - A classic crewneck cut that layers easily for any season.',
  'GREAT GIFT - Perfect for the go-getter who never stops chasing the next goal.',
  'BUILT TO LAST - Durable stitching holds up wash after wash, season after season.',
  'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
]
const KITCHEN_SINK = {
  title: 'THE CEO Graphic Sweatshirt | Long Sleeve Comfort Colors Crewneck',
  bullets: CLEAN_BULLETS,
  description: '<p>A bold sweatshirt for the everyday hustle.</p><ul><li>Soft cotton</li><li>Relaxed fit</li></ul><p>Great gift.</p>',
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
    { sku: 'BB-M-BLK', asin: 'B0BBMBLK000', color: 'Black', size: 'M' },
    { sku: 'BB-L-BLK', asin: 'B0BBLBLK000', color: 'Black', size: 'L' },
    { sku: 'HDG-M-BLK', asin: 'B0HDGMBLK00', color: 'Black', size: 'M' },
    { sku: 'HDG-L-BLK', asin: 'B0HDGLBLK00', color: 'Black', size: 'L' },
    { sku: 'MHG-M-BLK', asin: 'B0MHGMBLK00', color: 'Black', size: 'M' },
    { sku: 'MHG-L-BLK', asin: 'B0MHGLBLK00', color: 'Black', size: 'L' },
  ]
}

function makeBaseInput(openai: PipelineInput['openai']): PipelineInput {
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SWEATSHIRT',
    analysis: [],
    children: makeChildren(),
    repTitle: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men',
    canonicalTitle: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men',
    priorTitle: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men',
    priorBullets: CLEAN_BULLETS,
    variantDetails: '',
    keywordContext: '',
    hasAplus: false,
    hasBrandStory: false,
    auditModel: 'o4-mini',
    onProgress: () => {},
    // THE RATCHET: HDG's STORED designName is WRONGLY "Business B*tch" (BB's own name) — exactly
    // the artifact a prior mis-resolution on a contaminated title leaves behind. Its STORED TITLE
    // is clean ("Hustle Definiton"), so the S4 fallback (leadingDesignPhrase on the stored title)
    // has real, correct material to recover.
    priorPerChildTitles: [
      { sku: 'BB-M-BLK', asin: 'B0BBMBLK000', title: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men', designName: 'Business B*tch', designKey: 'BB' },
      { sku: 'BB-L-BLK', asin: 'B0BBLBLK000', title: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men', designName: 'Business B*tch', designKey: 'BB' },
      { sku: 'HDG-M-BLK', asin: 'B0HDGMBLK00', title: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve for Men', designName: 'Business B*tch', designKey: 'HDG' },
      { sku: 'HDG-L-BLK', asin: 'B0HDGLBLK00', title: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve for Men', designName: 'Business B*tch', designKey: 'HDG' },
      { sku: 'MHG-M-BLK', asin: 'B0MHGMBLK00', title: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve for Men', designName: 'Mother Hustler', designKey: 'MHG' },
      { sku: 'MHG-L-BLK', asin: 'B0MHGLBLK00', title: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve for Men', designName: 'Mother Hustler', designKey: 'MHG' },
    ],
  }
}

describe('Round S — a stored identity carrying a sibling\'s name is refused, end to end', () => {
  it('S4 fires: the ratchet is DETECTED and logged for the group whose stored name IS a sibling\'s', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const openai = makeOpenAiStub()
      const input: PipelineInput = { ...makeBaseInput(openai), onlySection: 'bullets' }
      await runListingPipeline(input)
      const messages = warnSpy.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => m.includes('names a SIBLING design') && m.includes('HDG'))).toBe(true)
    } finally {
      warnSpy.mockRestore()
    }
  }, 30_000)

  it('S4+S2 together: the SHIPPED per_child_bullets for the ratcheted group never name the sibling design', async () => {
    const openai = makeOpenAiStub()
    const input: PipelineInput = { ...makeBaseInput(openai), onlySection: 'bullets' }
    const result = await runListingPipeline(input)
    expect(result.debug.multiDesign).toBe(true)
    const hdgRows = result.per_child_bullets?.filter((c) => c.designKey === 'HDG') ?? []
    expect(hdgRows.length).toBeGreaterThan(0)
    for (const row of hdgRows) {
      expect(row.designName?.toLowerCase()).not.toContain('business')
      for (const b of row.bullets) expect(b.toLowerCase()).not.toContain('business')
    }
  }, 30_000)

  it('the healthy groups are UNAFFECTED — BB keeps its OWN name, MHG keeps its OWN correct name', async () => {
    const openai = makeOpenAiStub()
    const input: PipelineInput = { ...makeBaseInput(openai), onlySection: 'bullets' }
    const result = await runListingPipeline(input)
    const bbRows = result.per_child_bullets?.filter((c) => c.designKey === 'BB') ?? []
    const mhgRows = result.per_child_bullets?.filter((c) => c.designKey === 'MHG') ?? []
    expect(bbRows.length).toBeGreaterThan(0)
    expect(mhgRows.length).toBeGreaterThan(0)
    expect(bbRows.every((r) => (r.designName ?? '').toLowerCase().includes('business'))).toBe(true)
    expect(mhgRows.every((r) => (r.designName ?? '').toLowerCase().includes('mother hustler'))).toBe(true)
    // Mother Hustler's own bullets must still be non-empty (S4/S2 refusing a SIBLING's name must
    // never collaterally empty a design that never had a wrong identity).
    for (const row of mhgRows) expect(row.bullets.some((b) => b.trim().length > 0)).toBe(true)
  }, 30_000)

  it('S5: the deterministic step-2 gate (terminal bullets expander) now runs on a SECTION regen too, not just a full one', async () => {
    // Every CLEAN_BULLETS entry is well under BULLET_MIN_CHARS (150) — before S5, the whole
    // gatePerChildMultiDesign loop returned before this ran on `input.onlySection`, so a
    // "Regenerate bullets" click shipped these bytes UNPADDED. Measured directly (not guessed):
    // the first bullet (90 chars) grows once the deterministic pad runs.
    const openai = makeOpenAiStub()
    const input: PipelineInput = { ...makeBaseInput(openai), onlySection: 'bullets' }
    const result = await runListingPipeline(input)
    const mhgRows = result.per_child_bullets?.filter((c) => c.designKey === 'MHG') ?? []
    expect(mhgRows.length).toBeGreaterThan(0)
    for (const row of mhgRows) {
      expect(row.bullets).toHaveLength(5)
      expect(row.bullets[0].length).toBeGreaterThan(CLEAN_BULLETS[0].length)
    }
  }, 30_000)
})
