/**
 * U6 (Round U, cross-design leak) — THE REAL CURE, upstream of the ship door. `sanitizeReferenceTitle`
 * (listingPipeline.ts, next to `groupNameToks`) strips every OTHER group's resolved name phrase out of
 * the reference title handed to `runBulletsAgent`/`runDescriptionAgent`'s brief ("The title is FINAL
 * ... its design is ONLY what the title above says") before the writer ever sees it — driven end to
 * end through the REAL `runListingPipeline`, capturing the ACTUAL prompt text sent to the (stubbed)
 * LLM, not a proxy.
 *
 * Same hermetic harness as crossDesignLeakRoundS.integration.test.ts (stubbed OpenAI, no network,
 * Supabase env neutralized).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { runListingPipeline, type PipelineInput, type PipelineChild } from './listingPipeline'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}
beforeAll(() => { for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; delete process.env[key] } })
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedSupabaseEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedSupabaseEnv[key]
  }
})

const CLEAN_BULLETS = [
  'PREMIUM COMFORT - Soft ringspun cotton keeps you comfortable through a full day of grinding.',
  'RELAXED FIT - A classic crewneck cut that layers easily for any season.',
  'GREAT GIFT - Perfect for the go-getter who never stops chasing the next goal.',
  'BUILT TO LAST - Durable stitching holds up wash after wash, season after season.',
  'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
]
const KITCHEN_SINK = {
  title: 'THE CEO Graphic Sweatshirt | Long Sleeve Comfort Colors Crewneck',
  bullets: CLEAN_BULLETS,
  description: '<p>A bold sweatshirt for the everyday grind.</p><ul><li>Soft cotton</li><li>Relaxed fit</li></ul><p>Great gift.</p>',
  backend_drop: [],
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

/** THE CLEAN-BRIEF CASE (U6's own acceptance): every group's designName is already CORRECTLY
 *  resolved (S4 has nothing to fix) and every STORED title is HEALTHY — no sibling's slogan
 *  anywhere. `sanitizeReferenceTitle` must be a no-op tripwire here: it never fires on a healthy
 *  family, and the brief handed to every writer is byte-identical to its own group's title. */
function makeHealthyBaseInput(openai: PipelineInput['openai']): PipelineInput {
  return {
    openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
    analysis: [], children: makeChildren(),
    repTitle: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men',
    canonicalTitle: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men',
    priorTitle: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men',
    priorBullets: CLEAN_BULLETS, variantDetails: '', keywordContext: '',
    hasAplus: false, hasBrandStory: false, auditModel: 'o4-mini', onProgress: () => {},
    priorPerChildTitles: [
      { sku: 'BB-M-BLK', asin: 'B0BBMBLK000', title: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men', designName: 'Business B*tch', designKey: 'BB' },
      { sku: 'BB-L-BLK', asin: 'B0BBLBLK000', title: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men', designName: 'Business B*tch', designKey: 'BB' },
      { sku: 'HDG-M-BLK', asin: 'B0HDGMBLK00', title: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve for Men', designName: 'Hustle Definiton', designKey: 'HDG' },
      { sku: 'HDG-L-BLK', asin: 'B0HDGLBLK00', title: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve for Men', designName: 'Hustle Definiton', designKey: 'HDG' },
      { sku: 'MHG-M-BLK', asin: 'B0MHGMBLK00', title: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve for Men', designName: 'Mother Hustler', designKey: 'MHG' },
      { sku: 'MHG-L-BLK', asin: 'B0MHGLBLK00', title: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve for Men', designName: 'Mother Hustler', designKey: 'MHG' },
    ],
  }
}

/** THE CONTAMINATED-TITLE CASE: HDG's designName has ALREADY resolved correctly ("Hustle
 *  Definiton" — S4 has nothing to fix here, isolating this test to the title-sanitization
 *  mechanism alone), but its STORED TITLE TEXT itself still literally carries BB's slogan — the
 *  exact shape the live defect left behind (a title that was never re-generated after a past
 *  contamination). Without U6, the brief handed to HDG's writer says "The title is FINAL...:
 *  \"...Hustle Definiton Sweatshirt Business B*tch...\"" and would legitimately instruct the
 *  writer that Business B*tch IS part of this design. */
function makeContaminatedTitleInput(openai: PipelineInput['openai']): PipelineInput {
  const base = makeHealthyBaseInput(openai)
  return {
    ...base,
    priorPerChildTitles: base.priorPerChildTitles!.map((r) =>
      r.designKey === 'HDG'
        ? { ...r, title: 'THE CEO Hustle Definiton Sweatshirt Business B*tch | Long Sleeve for Men' }
        : r),
  }
}

function makeCapturingStub(captured: Map<string, string>) {
  return {
    chat: {
      completions: {
        create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
          const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
          if (/"designName"/.test(user)) return { choices: [{ message: { content: JSON.stringify({ designName: '' }) }, finish_reason: 'stop' }] }
          // Capture the brief for whichever design it names in its own embedded reference title —
          // `runBulletsAgent` quotes it ('The title is FINAL...: "..."'), `runDescriptionAgent`
          // states it plainly ('Title: ...').
          const m = user.match(/The title is FINAL[^"]*"([^"]*)"/) ?? user.match(/^Title: (.+)$/m)
          if (m) captured.set(m[1], user)
          return { choices: [{ message: { content: JSON.stringify(KITCHEN_SINK) }, finish_reason: 'stop' }] }
        }),
      },
    },
  } as unknown as PipelineInput['openai']
}

describe('U6 — the reference title handed to the writer is sanitized of sibling names', () => {
  it('THE FIX: a contaminated STORED title never reaches the bullets writer for the design it does NOT belong to', async () => {
    const captured = new Map<string, string>()
    const openai = makeCapturingStub(captured)
    const input: PipelineInput = { ...makeContaminatedTitleInput(openai), onlySection: 'bullets' }
    await runListingPipeline(input)
    const hdgBrief = [...captured.entries()].find(([title]) => title.includes('Hustle Definiton'))?.[1] ?? ''
    expect(hdgBrief).not.toBe('')
    expect(hdgBrief).not.toContain('Business B*tch')
    // BB's OWN brief still correctly carries its OWN name — sanitization is per-SIBLING, never
    // self-scrubbing.
    const bbBrief = [...captured.entries()].find(([title]) => title.includes('Business B') && !title.includes('Hustle'))?.[1] ?? ''
    expect(bbBrief).toContain('Business B')
  }, 30_000)

  it('THE FIX: the same holds for the description writer', async () => {
    const captured = new Map<string, string>()
    const openai = makeCapturingStub(captured)
    const input: PipelineInput = { ...makeContaminatedTitleInput(openai), onlySection: 'description' }
    await runListingPipeline(input)
    const hdgBrief = [...captured.entries()].find(([title]) => title.includes('Hustle Definiton'))?.[1] ?? ''
    expect(hdgBrief).not.toBe('')
    expect(hdgBrief).not.toContain('Business B*tch')
  }, 30_000)

  it('CLEAN-BRIEF ACCEPTANCE: on a HEALTHY family (no contamination anywhere), the sanitizer is a ' +
    'no-op — every group\'s own brief is byte-identical to its own stored title', async () => {
    const captured = new Map<string, string>()
    const openai = makeCapturingStub(captured)
    const input: PipelineInput = { ...makeHealthyBaseInput(openai), onlySection: 'bullets' }
    await runListingPipeline(input)
    expect(captured.size).toBeGreaterThanOrEqual(3)
    const titles = {
      BB: 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men',
      HDG: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve for Men',
      MHG: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve for Men',
    }
    const briefs: Record<string, string> = {}
    for (const [key, title] of Object.entries(titles)) {
      const brief = [...captured.entries()].find(([t]) => t === title)?.[1]
      expect(brief, `no byte-identical brief found for ${key} ("${title}")`).toBeTruthy()
      briefs[key] = brief!
    }
    // Tripwire-never-fires: no design's brief carries a SIBLING's name — but it legitimately
    // carries its OWN (the reference title is byte-identical to its own stored title, asserted
    // above; sanitizeReferenceTitle never touches a group's own name).
    expect(briefs.HDG).not.toContain('Business B*tch')
    expect(briefs.HDG).not.toContain('Mother Hustler')
    expect(briefs.MHG).not.toContain('Business B*tch')
    expect(briefs.MHG).not.toContain('Hustle Definiton')
    expect(briefs.BB).not.toContain('Mother Hustler')
    expect(briefs.BB).not.toContain('Hustle Definiton')
    expect(briefs.BB).toContain('Business B*tch') // BB's own name, correctly present
  }, 30_000)
})
