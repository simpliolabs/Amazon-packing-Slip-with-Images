/**
 * POST /api/fba/regenerate-item-highlight  { parent_asin }
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-field regenerate for the Item Highlight (title_differentiation) WITHOUT a full audit
 * (PO: "no REGENERATE button"). Composes it from the family's rated pool + the SKU-resolved blank
 * facts via buildItemHighlights — the ONE deterministic producer the pipeline also ships (no LLM,
 * PO 2026-08-21) — then persists the updated product_details_improvements row. Isolated: does NOT
 * run the full pipeline. Auth is enforced by the /api/fba middleware (task #49). Never blanks the
 * field: a HOLD answers 422 with the named reason and keeps the stored value.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getStoredAnalysis } from '@/lib/keyword-engine'
import { selectionMode, resolveRankingTargets } from '@/lib/keyword-engine/selection-core'
import { loadSelectionContext, readWindow } from '@/lib/keyword-engine/selectionContext'
import { resolveToChildAsin } from '@/lib/fba/resolveAsin'
import { poolKeyFromResolved } from '@/lib/keyword-engine/poolKey'
import { buildItemHighlights, IH_HOLD_MESSAGES } from '@/lib/fba/listingPipeline'
import { detailValueToString, isItemHighlightsField, capItemHighlightRepeats } from '@/lib/fba/productDetailAttrs'
import { resolveBlankRowForNet } from '@/lib/fba/blankSpecs'

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
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

    // Path parity (Invariant 1): the SAME inputs the pipeline hands the producer — pool, blank row,
    // the title the IH will sit beside. Deterministic; no client, no LLM.
    const built = buildItemHighlights({ finalTitle: title, pool: hlAnalysis, apparelProduct: apparel, blankBrand: blankRow, netTitles: [title] })
    const hl = capItemHighlightRepeats((built.value || '').trim())
    if (!hl) {
      // HOLD (PO 2026-08-21): name the reason — the PO's next action — never a generic "empty".
      const reason = built.hold ?? 'under-floor'
      return NextResponse.json({ error: `${IH_HOLD_MESSAGES[reason]} — kept the existing value.`, hold: reason }, { status: 422 })
    }

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
