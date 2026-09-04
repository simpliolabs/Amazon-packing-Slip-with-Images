/**
 * SILENT-HOLD DEFECT CLASS CLOSED (2026-09-04, B0DSCDZC6K, 6-design sweatshirt family).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Settled by live data (do not re-derive): item_highlights_api_state.supported=true (NOT
 * write-blocked) and pt_schema_cache carries `title_differentiation` for SWEATSHIRT|ATVPDKIKX0DER
 * (the attribute IS in Amazon's live schema, fetched 2026-09-01, fresh). highlightsAttr therefore
 * MATCHES and the row-build branch DOES run — yet no Item Highlights row reached the page at all.
 *
 * ROOT CAUSE: when the Item Highlight composer HOLDS (no truthful line — the family's pool carries
 * FAMILY-level theme_fit but no PER-DESIGN theme_fit_by_design, migration 061; every design's shared
 * line therefore holds `designs-unrated` by construction, correctly — see themeFitByDesign.ts), the
 * pipeline (listingPipeline.ts) used to push NO row into product_details_improvements at all, on
 * EITHER path:
 *   - single-design (`const { value: hl } = buildItemHighlights(...); if (hl) { pdiFinal.push(...) }`)
 *   - multi-design  (`if (composed > 0) { pdiFinal.push(...) }` — composed===0 pushed nothing)
 * An absent row reads as "no recommendation" instead of "held, here's why" — and the whole per-design
 * UI block in page.tsx (including the "Rate designs against pool" control PR #667 just shipped) is
 * keyed off that row EXISTING, so it was hidden inside a container that could never render.
 *
 * THE FIX: both branches now ALWAYS push the row when the attribute is in the menu, carrying WHY via
 * a new `hold` field. This file drives the REAL runListingPipeline() (same harness as
 * gatePerChildMultiDesign.integration.test.ts / garmentAgeProducer.integration.test.ts) to prove the
 * row reaches `product_details_improvements` on both paths — not a unit test of the composer itself
 * (buildItemHighlights/buildItemHighlightsPerDesign are already pinned by itemHighlightHold.test.ts /
 * itemHighlightPerDesign.test.ts, untouched by this fix) but of the PUSH DECISION around it.
 *
 * "PROVE THE BRANCH RAN, NOT MERELY THAT SOME ROW EXISTS": every held-case assertion below checks the
 * `hold` reason specifically, not just row presence — a row that exists for the wrong reason (or from
 * a different code path entirely) would still be a false green.
 *
 * CI TRAP (see gatePerChildMultiDesign.integration.test.ts for the full diagnosis): build.yml's
 * placeholder Supabase env makes every lazy-Proxy Supabase client attempt a real ~4s network call
 * instead of failing open synchronously. Nulling the three Supabase env vars for this file (restored
 * in afterAll) keeps the fast, deterministic fail-open path regardless of what CI exports.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ''

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { runListingPipeline, type PipelineInput, type PipelineChild, type PipelineProductDetailImprovement } from './listingPipeline'
import { isItemHighlightsField, isProductDetailGap } from './productDetailAttrs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

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

const IH_MENU_ATTR = { key: 'title_differentiation', title: 'Item Highlight' }

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
  product_details_improvements: [] as unknown[],
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

function makeMultiDesignChildren(): PipelineChild[] {
  return [
    { sku: 'GATOR-M-BLK', asin: 'B0GATORMBLK', color: 'Black', size: 'M' },
    { sku: 'GATOR-L-BLK', asin: 'B0GATORLBLK', color: 'Black', size: 'L' },
    { sku: 'SHARK-M-BLK', asin: 'B0SHARKMBLK', color: 'Black', size: 'M' },
    { sku: 'SHARK-L-BLK', asin: 'B0SHARKLBLK', color: 'Black', size: 'L' },
  ]
}

function makeMultiDesignBaseInput(openai: PipelineInput['openai'], analysis: AnalyzedKeyword[], detailAttributeMenu: PipelineInput['detailAttributeMenu']): PipelineInput {
  const children = makeMultiDesignChildren()
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SHIRT',
    analysis,
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
    detailAttributeMenu,
    // Two design groups (GATOR / SHARK), each with 2 SKUs — matches gatePerChildMultiDesign's proven
    // fixture for reaching designGroupContexts.length >= 2 on the FULL (non-onlySection) path.
    priorPerChildTitles: [
      { sku: 'GATOR-M-BLK', asin: 'B0GATORMBLK', title: 'THE CEO Gator Bites Tee', designName: 'Gator Bites', designKey: 'GATOR' },
      { sku: 'GATOR-L-BLK', asin: 'B0GATORLBLK', title: 'THE CEO Gator Bites Tee', designName: 'Gator Bites', designKey: 'GATOR' },
      { sku: 'SHARK-M-BLK', asin: 'B0SHARKMBLK', title: 'THE CEO Shark Week Tee', designName: 'Shark Week', designKey: 'SHARK' },
      { sku: 'SHARK-L-BLK', asin: 'B0SHARKLBLK', title: 'THE CEO Shark Week Tee', designName: 'Shark Week', designKey: 'SHARK' },
    ],
  }
}

function ihRow(pdi: PipelineProductDetailImprovement[] | undefined): PipelineProductDetailImprovement | undefined {
  return (pdi ?? []).find((p) => isItemHighlightsField(p.field_name, undefined))
}

describe('THE LIVE CASE — multi-design family, family-level theme_fit but NO per-design rating (migration 061 gap)', () => {
  it('pushes the marker row, empty value, hold "designs-unrated" — the row must EXIST (that was the bug: it was absent)', async () => {
    // Family-level theme_fit IS set (2 and 3, matching the live B0DSCDZC6K data) — but NO
    // themeFitByDesign anywhere in the pool, so unratedDesignKeys(pool, ['GATOR','SHARK']) names
    // BOTH design keys and buildItemHighlightsPerDesign holds `designs-unrated` by construction.
    const analysis: AnalyzedKeyword[] = [
      { keyword: 'graphic tees for men', searchVolume: 9000, themeFit: 3 } as unknown as AnalyzedKeyword,
      { keyword: 'funny tshirts men', searchVolume: 8000, themeFit: 2 } as unknown as AnalyzedKeyword,
      { keyword: 'novelty shirts for guys', searchVolume: 7000, themeFit: 3 } as unknown as AnalyzedKeyword,
    ]
    const openai = makeOpenAiStub()
    const input = makeMultiDesignBaseInput(openai, analysis, [IH_MENU_ATTR])
    const result = await runListingPipeline(input)

    // Sanity: this really is the multi-design path (2 groups resolved) — a false pass from
    // misclassifying as single-design would prove nothing about the branch this bug lives in.
    expect(result.debug.multiDesign).toBe(true)
    expect(result.debug.designGroups).toEqual(['GATOR', 'SHARK'])

    const row = ihRow(result.product_details_improvements)
    expect(row).toBeDefined()                       // THE BUG: this used to be undefined
    expect(row!.recommended_value).toBe('')
    expect(row!.hold).toBe('designs-unrated')        // prove the BRANCH — not merely "some row"
    expect(row!.per_design).toBe(true)
    expect(row!.reason).toMatch(/held/i)
    expect(row!.reason).toMatch(/design/i)

    // per_child_item_highlights carries the SAME hold reason per SKU (this part already worked pre-fix
    // — perChildItemHighlights was assigned unconditionally; the bug was ONLY the marker row's absence).
    expect(result.per_child_item_highlights?.length).toBe(4)
    for (const e of result.per_child_item_highlights ?? []) {
      expect(e.item_highlight).toBe('')
      expect(e.hold).toBe('designs-unrated')
    }

    // The "Rate designs against pool" button gate in page.tsx (PR #667) reads
    // `ihRows.some(row => !row.line && row.hold === 'designs-unrated')` on THIS array — prove it fires.
    const gateFires = (result.per_child_item_highlights ?? []).some((e) => !e.item_highlight && e.hold === 'designs-unrated')
    expect(gateFires).toBe(true)

    // Features score doctrine: a held row must NOT dock (current_value is empty AND hold is set).
    expect(isProductDetailGap(row!, { apiSupported: true })).toBe(false)
  })
})

describe('SINGLE-DESIGN held (the pipeline\'s `{ value: hl }` destructure path)', () => {
  function makeSingleDesignInput(openai: PipelineInput['openai'], analysis: AnalyzedKeyword[], detailAttributeMenu: PipelineInput['detailAttributeMenu']): PipelineInput {
    return {
      openai,
      brandName: 'THE CEO',
      category: 'Clothing',
      productType: 'SHIRT',
      analysis,
      children: [
        { sku: 'DINO-M-BLK', asin: 'B0DINOMBLK1', color: 'Black', size: 'M' },
        { sku: 'DINO-L-BLK', asin: 'B0DINOLBLK1', color: 'Black', size: 'L' },
      ],
      repTitle: 'THE CEO Dino Roar Tee',
      canonicalTitle: 'THE CEO Dino Roar Tee',
      priorTitle: 'THE CEO Dino Roar Tee',
      priorBullets: KITCHEN_SINK.bullets,
      variantDetails: '',
      keywordContext: '',
      hasAplus: false,
      hasBrandStory: false,
      auditModel: 'o4-mini',
      onProgress: () => {},
      detailAttributeMenu,
    }
  }

  it('an UNRATED pool (themeFit: null everywhere) holds "unrated-pool" — the row must still exist, empty value, reason carried', async () => {
    const analysis: AnalyzedKeyword[] = [
      { keyword: 'later gator shirt women', searchVolume: 450, themeFit: null } as unknown as AnalyzedKeyword,
      { keyword: 'see you later alligator', searchVolume: 900, themeFit: null } as unknown as AnalyzedKeyword,
      { keyword: 'alligator clothing women', searchVolume: 300, themeFit: null } as unknown as AnalyzedKeyword,
      { keyword: 'funny gator apparel', searchVolume: 250, themeFit: null } as unknown as AnalyzedKeyword,
      { keyword: 'novelty animal tops', searchVolume: 200, themeFit: null } as unknown as AnalyzedKeyword,
      { keyword: 'swamp humor clothing', searchVolume: 150, themeFit: null } as unknown as AnalyzedKeyword,
    ]
    const openai = makeOpenAiStub()
    const input = makeSingleDesignInput(openai, analysis, [IH_MENU_ATTR])
    const result = await runListingPipeline(input)

    expect(result.debug.multiDesign).toBeFalsy()   // sanity: really the single-design path

    const row = ihRow(result.product_details_improvements)
    expect(row).toBeDefined()                       // THE BUG: this used to be undefined
    expect(row!.recommended_value).toBe('')
    expect(row!.hold).toBe('unrated-pool')           // prove the BRANCH, not merely "some row"
    expect(row!.per_design).not.toBe(true)
    expect(row!.reason).toMatch(/held/i)

    expect(isProductDetailGap(row!, { apiSupported: true })).toBe(false)
  })
})

describe('NOT held — unchanged behaviour (regression guard: the fix must not touch the composed path)', () => {
  it('single-design: a viable rated pool still composes a real value, hold null, row pushed exactly as before', async () => {
    // The exact composing fixture from itemHighlightHold.test.ts's "composes in the band" case —
    // proven to produce a non-empty line through the SAME buildItemHighlights this pipeline calls.
    const analysis: AnalyzedKeyword[] = [
      { keyword: 'later gator shirt women', searchVolume: 450, themeFit: 3 } as unknown as AnalyzedKeyword,
      { keyword: 'see you later alligator', searchVolume: 900, themeFit: 3 } as unknown as AnalyzedKeyword,
      { keyword: 'alligator clothing women', searchVolume: 300, themeFit: 3 } as unknown as AnalyzedKeyword,
      { keyword: 'funny gator apparel', searchVolume: 250, themeFit: 3 } as unknown as AnalyzedKeyword,
      { keyword: 'novelty animal tops', searchVolume: 200, themeFit: 2 } as unknown as AnalyzedKeyword,
      { keyword: 'comfort colors graphic tee', searchVolume: 5000, themeFit: 2 } as unknown as AnalyzedKeyword,
      { keyword: 'swamp humor clothing', searchVolume: 150, themeFit: 2 } as unknown as AnalyzedKeyword,
    ]
    const openai = makeOpenAiStub()
    const input: PipelineInput = {
      openai,
      brandName: 'THE CEO',
      category: 'Clothing',
      productType: 'SHIRT',
      analysis,
      children: [
        { sku: 'GATOR-M-BLK', asin: 'B0GATORMBLK', color: 'Black', size: 'M' },
        { sku: 'GATOR-L-BLK', asin: 'B0GATORLBLK', color: 'Black', size: 'L' },
      ],
      repTitle: 'THE CEO Later Gator Tee Shirt',
      canonicalTitle: 'THE CEO Later Gator Tee Shirt',
      priorTitle: 'THE CEO Later Gator Tee Shirt',
      priorBullets: KITCHEN_SINK.bullets,
      variantDetails: '',
      keywordContext: '',
      hasAplus: false,
      hasBrandStory: false,
      auditModel: 'o4-mini',
      onProgress: () => {},
      detailAttributeMenu: [IH_MENU_ATTR],
    }
    const result = await runListingPipeline(input)
    const row = ihRow(result.product_details_improvements)
    expect(row).toBeDefined()
    expect(row!.recommended_value.length).toBeGreaterThan(0)
    expect(row!.hold == null).toBe(true)             // composed ⇒ no hold reason
    expect(row!.per_design).not.toBe(true)
    expect(isProductDetailGap(row!, { apiSupported: true })).toBe(true)  // a real un-pushed value IS still a normal gap
  })
})

describe('the attribute is genuinely ABSENT from the menu — still NO row (do not regress this into a phantom row)', () => {
  it('no detailAttributeMenu entry matches Item Highlights ⇒ the highlightsAttr guard never opens ⇒ no row, held or not', async () => {
    const analysis: AnalyzedKeyword[] = [
      { keyword: 'later gator shirt women', searchVolume: 450, themeFit: null } as unknown as AnalyzedKeyword,
    ]
    const openai = makeOpenAiStub()
    const input = makeMultiDesignBaseInput(openai, analysis, [{ key: 'material', title: 'Material' }])
    const result = await runListingPipeline(input)
    const row = ihRow(result.product_details_improvements)
    expect(row).toBeUndefined()
  })
})
