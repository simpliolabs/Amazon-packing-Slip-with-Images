/**
 * POST /api/fba/regenerate-item-highlight  { parent_asin }
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-field regenerate for the Item Highlight (title_differentiation) WITHOUT a full audit
 * (PO: "no REGENERATE button"). Rebuilds it from the STORED detail facts (Material/Fit/Neck/
 * Sleeve/Department) + the design via buildItemHighlights — which now forces the clean, spec-
 * grounded fallback when the LLM emits a keyword-list and caps repeated words — then persists the
 * updated product_details_improvements row. Isolated: does NOT run the full pipeline. Auth is
 * enforced by the /api/fba middleware (task #49). Never blanks the field (keeps the old value on
 * empty/error).
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import { getStoredAnalysis } from '@/lib/keyword-engine'
import { selectionMode, resolveRankingTargets } from '@/lib/keyword-engine/selection-core'
import { loadSelectionContext, readWindow } from '@/lib/keyword-engine/selectionContext'
import { resolveToChildAsin } from '@/lib/fba/resolveAsin'
import { poolKeyFromResolved } from '@/lib/keyword-engine/poolKey'
import { buildItemHighlights } from '@/lib/fba/listingPipeline'
import { detailValueToString, isItemHighlightsField, capItemHighlightRepeats } from '@/lib/fba/productDetailAttrs'
import { resolveBlankRowForNet } from '@/lib/fba/blankSpecs'

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

async function openaiClient() {
  const { resolveOpenAIKey } = await import('@/lib/openai/credentials')
  const { instrumentAiHealth } = await import('@/lib/openai/errorClass')
  const apiKey = await resolveOpenAIKey()
  return instrumentAiHealth(new OpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' }))
}

export async function POST(req: NextRequest) {
  try {
    const { parent_asin } = (await req.json()) as { parent_asin?: string }
    if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    const supabase = admin()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rec } = await (supabase as any).from('listing_seo_recommendations')
      .select('recommended_title, product_details_improvements, keyword_plan')
      .eq('parent_asin', parent_asin).maybeSingle()
    if (!rec) return NextResponse.json({ error: 'No recommendations found — run an AI audit first.' }, { status: 404 })

    const details = Array.isArray(rec.product_details_improvements)
      ? (rec.product_details_improvements as Record<string, unknown>[]) : []
    const ihIdx = details.findIndex((p) => isItemHighlightsField(detailValueToString(p.field_name), (p as { sp_api_key?: string }).sp_api_key))
    if (ihIdx < 0) return NextResponse.json({ error: 'No Item Highlight row to regenerate — run a full AI audit first.' }, { status: 404 })

    const title = detailValueToString(rec.recommended_title)
    const designName = detailValueToString((rec.keyword_plan as { designName?: string } | null)?.designName)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: scoreRow } = await (supabase as any).from('listing_seo_scores')
      .select('design_name_override').eq('parent_asin', parent_asin).maybeSingle()
    const designAnchor = designName || detailValueToString((scoreRow as { design_name_override?: string } | null)?.design_name_override)

    const resolved = await resolveToChildAsin(parent_asin.toUpperCase(), supabase)
    // ONE POOL KEY (#174): read the family drawer, not the resolved child's.
    const analysis = (resolved ? await getStoredAnalysis(poolKeyFromResolved(resolved, parent_asin.toUpperCase()), readWindow(100)) : []) ?? []
    // KEYWORD_TARGET_SET (#143). This route BYPASSES runListingPipeline entirely, so it must resolve
    // its own targets — buildItemHighlights sorts contextKws by coverageGapScore, which is the
    // gap-amplified score this PR exists to stop trusting. Without this, the one surface that skips
    // the pipeline would keep feeding off-theme keywords to the highlight prompt after the flip.
    //
    // BACKEND-slot targets are excluded: an item highlight is customer-facing copy, and that slot
    // exists precisely for terms it must never contain.
    let hlAnalysis = analysis
    if (selectionMode() === 'on' && resolved) {
      const selCtx = await loadSelectionContext({
        supabase,
        childAsin: resolved.childAsin,
        parentAsin: resolved.parentAsin ?? null,
        site: 'regenerate-item-highlight',
      })
      const targeted = resolveRankingTargets(analysis, {
        legacy: (r) => [...r],
        site: 'regenerate-item-highlight',
        ctx: selCtx,
        inputAsin: resolved.childAsin,
      }).filter((k) => k.selectionSlot !== 'BACKEND')
      // Fail-open: an empty result would starve the prompt of context entirely.
      if (targeted.length > 0) hlAnalysis = targeted
    }
    // THEME-FIT RE-HYDRATION (2026-08-20): the targeting projection can drop themeFit, which made
    // 92%-rated pools read as UNRATED downstream — the composer's rated-pool guarantees (fit gate,
    // never-fall-to-LLM) silently disarmed and the LLM improvised past the PO's rulings ("Walt
    // Shirt", "Oversized Crew Neck"). Re-hydrate from the raw pool by keyword: one deterministic
    // seam, correct regardless of which projection stripped the field.
    {
      const fitByKw = new Map(analysis.map((k) => [k.keyword.toLowerCase(), k.themeFit ?? null]))
      hlAnalysis = hlAnalysis.map((k) => (
        (k as { themeFit?: number | null }).themeFit == null
          ? { ...k, themeFit: fitByKw.get(k.keyword.toLowerCase()) ?? null }
          : k
      ))
    }

    // Facts the highlight grounds in: the stored detail rows (the DB lookup). Shape matches the
    // generator's `details` param exactly (Parameters<>[3]) so the compiler enforces it.
    const factRows = details.map((p) => ({
      field_name: detailValueToString(p.field_name),
      current_value: p.current_value == null ? null : detailValueToString(p.current_value),
      recommended_value: detailValueToString(p.recommended_value),
    })) as unknown as Parameters<typeof buildItemHighlights>[3]

    const apparel = /\b(shirt|tee|t-?shirts?|hoodie|sweatshirt|tank|apparel|garment)\b/i.test(title)

    // ── BLANK-BRAND WATERFALL (PO 2026-08-08, all-paths invariant): this route bypasses the
    // pipeline, so it resolves its own blank row — via the ONE shared spec-truth resolver
    // (resolveBlankRowForNet: SKU-first per PO 2026-08-21 — every child SKU's style code, then the
    // family override, then the legacy title/productType regex, NEVER a search keyphrase; its
    // garment-compatibility gate keeps a tee row off a sweatshirt family and vice-versa).
    // `title` here is rec.recommended_title, which IS the PO's locked title when
    // title_source='manual' (lock-title route stores it there) — exactly the title the net must
    // test. Best-effort: any read failure leaves blankRow null → net no-ops.
    const blankRow = await resolveBlankRowForNet(supabase, {
      parentAsin: parent_asin,
      childAsin: resolved?.childAsin ?? null,
      titles: [title],
    })

    const openai = await openaiClient()
    let hl = ''
    try {
      // unisexFit from the resolved blank row (adversarial LOW, path parity / Invariant 1: one net,
      // one input set, every path — the pipeline passes blankSpec?.unisex === true; hardcoding false
      // here dropped the unisex-sizing fact from every route-regenerated highlight).
      hl = await buildItemHighlights(openai, title, designAnchor, factRows, hlAnalysis, 'THE CEO', apparel, false, undefined, blankRow?.spec.unisex === true, blankRow, [title])
    } catch (e) {
      return NextResponse.json({ error: 'Generation failed: ' + (e instanceof Error ? e.message : String(e)) }, { status: 500 })
    }
    hl = capItemHighlightRepeats((hl || '').trim())
    if (!hl) return NextResponse.json({ error: 'Regeneration produced an empty highlight — kept the existing value.' }, { status: 422 })

    const updated = details.map((p, i) => (i === ihIdx ? { ...p, recommended_value: hl } : p))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from('listing_seo_recommendations')
      .update({ product_details_improvements: updated }).eq('parent_asin', parent_asin)

    return NextResponse.json({ item_highlight: hl, product_details_improvements: updated })
  } catch (e) {
    console.error('[regenerate-item-highlight]', e)
    return NextResponse.json({ error: 'Internal error', details: String(e) }, { status: 500 })
  }
}
