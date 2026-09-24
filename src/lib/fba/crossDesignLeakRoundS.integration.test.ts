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

  it('T6 (Round T): this family\'s section regen still completes and ships real per-child bullets under S5+T6\'s combined gate', async () => {
    // CORRECTED (Round T, T6): this test used to assert that a section regen's per-child bullets
    // grew LONGER via the terminal expander (`expandShortBulletsTerminal`, called from
    // `gatePerChildMultiDesign`) — encoding the exact cost regression T6 fixes (that call, and its
    // description counterpart, are gpt-4.1-mini calls with no budget counter, now gated
    // `!input.onlySection`). A tight, in-repo byte- or call-count assertion for T6 on THIS fixture
    // turned out to be unreliable: this family also exercises several OTHER, unrelated, always-on
    // mechanisms that touch bullet length/content on EITHER path regardless of T6 (the
    // deterministic identity floor weaving the design name into a bullet; the pre-existing,
    // unconditional broadcast-side `applyTerminalNets` pass; the metric-gated resynthesis loop) —
    // so a assertion narrow enough to isolate T6's OWN two calls without tripping on those would
    // have to duplicate `s5cost.probe.test.ts`'s own resolver-aliased before/after harness, which
    // already measured this precisely (142 -> 82 total calls on a 6-design family, re-run
    // unmodified as this round's decisive, quantitative evidence for T6). What THIS test still
    // usefully pins, byte-identical to before T6 landed: the section regen on this ratcheted
    // family completes and ships real per-child bullets — T6's gating must never silently degrade
    // the regen itself, only its call volume.
    const openai = makeOpenAiStub()
    const input: PipelineInput = { ...makeBaseInput(openai), onlySection: 'bullets' }
    const result = await runListingPipeline(input)
    const mhgRows = result.per_child_bullets?.filter((c) => c.designKey === 'MHG') ?? []
    expect(mhgRows.length).toBeGreaterThan(0)
    // U5 (Round U) — RESTORES the per-child bullet-count FLOOR this round's own commit (`00e9ef6`)
    // deleted, replacing it with `toBeGreaterThan(0)`: after that change the suite had NO
    // assertion anywhere that a section-regen per-child bullets row ships the contract's five —
    // it would have gone green if a regen shipped ONE bullet per child. U1 (all-or-nothing ship
    // door) is what makes `toHaveLength(5)` correct to pin again: on HEALTHY copy (this fixture)
    // there is no partial array any more, only the full five or a refusal, so every row here
    // ships exactly five, never a length-4 casualty of a false-positive foreign match.
    for (const row of mhgRows) expect(row.bullets).toHaveLength(5)
    const bbRows = result.per_child_bullets?.filter((c) => c.designKey === 'BB') ?? []
    const hdgRows = result.per_child_bullets?.filter((c) => c.designKey === 'HDG') ?? []
    for (const row of bbRows) expect(row.bullets).toHaveLength(5)
    for (const row of hdgRows) expect(row.bullets).toHaveLength(5)
  }, 30_000)

  /** V1/V2 (Round V) — CORRECTED. Rounds S/T/U each built, armed and re-shaped a subtractive door
   *  that edited or emptied a "leaking" per-child row; Round V deletes it entirely (measured
   *  outcome across all three shapes: designScope.ts's Round V comment above
   *  `detectForeignBullets`). A row that names a sibling now SHIPS UNCHANGED — never emptied,
   *  never shortened — and the leak is only REPORTED (a console.warn + `degradedSections:
   *  ['cross_design_leak']`, which route.ts surfaces as an SSE warning). The stored per-child copy
   *  is therefore never overwritten by an empty row on this account, by construction: there is no
   *  code path left that produces one. */
  it('V1/V2: a per-child row that names a sibling SHIPS UNCHANGED and is only REPORTED, never emptied', async () => {
    const LEAK_BULLETS = [
      "BOLD STATEMENT - Featuring the empowering phrase 'Business B*tch,' this sweatshirt celebrates ambition for every day of the week and beyond.",
      'RELAXED FIT - A classic crewneck cut that layers easily for any season and keeps its shape wash after wash for years.',
      'GREAT GIFT - Perfect for the go-getter who never stops chasing the next goal, a thoughtful present for any occasion.',
      'BUILT TO LAST - Durable stitching holds up wash after wash, season after season, so the design stays crisp and bright.',
      'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles without shrinking or fading.',
    ]
    const leakSink = { title: 'THE CEO Graphic Sweatshirt | Long Sleeve Comfort Colors Crewneck', bullets: LEAK_BULLETS, description: '<p>x</p>', backend_drop: [] }
    const openai = {
      chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(leakSink) }, finish_reason: 'stop' }] })) } },
    } as unknown as PipelineInput['openai']
    const input: PipelineInput = { ...makeBaseInput(openai), onlySection: 'bullets' }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let result: Awaited<ReturnType<typeof runListingPipeline>>
    let reportLines: string[]
    try {
      result = await runListingPipeline(input)
      // Read the spy's call history BEFORE mockRestore() — mockRestore() implies mockReset(),
      // which CLEARS .mock.calls, not merely detaches the mock implementation.
      reportLines = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('DESIGN_SCOPE_REPORT'))
    } finally {
      warnSpy.mockRestore()
    }
    const hdgRows = result.per_child_bullets?.filter((c) => c.designKey === 'HDG') ?? []
    expect(hdgRows.length).toBeGreaterThan(0)
    // Never emptied (the ship door is gone) — still five bullets, and the leaking sentence is
    // never removed. (Not byte-identical to LEAK_BULLETS: the pipeline's OWN pre-existing
    // deterministic identity floor — unrelated to this round — may still weave HDG's own resolved
    // name into whichever bullet doesn't yet carry it; that mechanism is untouched by Round V.)
    for (const row of hdgRows) {
      expect(row.bullets).toHaveLength(5)
      expect(row.bullets.some((b) => b.includes("Business B*tch"))).toBe(true)
    }
    // The leak is reported, not silent: a DESIGN_SCOPE_REPORT log line naming HDG, and the
    // existing degraded-sections/SSE surface flagged (never a persist-skip — see designScope.ts's
    // Round V comment above `detectForeignBullets`).
    expect(reportLines.some((m) => m.includes('"design":"HDG"'))).toBe(true)
    expect(result.degradedSections).toContain('cross_design_leak')
    // BB genuinely owns the slogan — its row ships the full, real five, never flagged at all.
    const bbRows = result.per_child_bullets?.filter((c) => c.designKey === 'BB') ?? []
    for (const row of bbRows) expect(row.bullets).toHaveLength(5)
  }, 30_000)
})
