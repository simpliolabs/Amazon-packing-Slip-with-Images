/**
 * POST /api/fba/regenerate-item-highlight  { parent_asin }
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-field regenerate for the Item Highlight (title_differentiation) WITHOUT a full audit
 * (PO: "no REGENERATE button"). Composes it from the family's rated pool + the SKU-resolved blank
 * facts via buildItemHighlights — the ONE deterministic producer the pipeline also ships (no LLM,
 * PO 2026-08-21) — then persists the updated product_details_improvements row. Isolated: does NOT
 * run the full pipeline. Auth is enforced by the /api/fba middleware (task #49). Never blanks the
 * field: a HOLD answers 422 with the named reason and keeps the stored value.
 * MULTI-DESIGN (PO 2026-08-21, refined the same day): composes ONE SHARED line — design names
 * stripped, every phrase rated >= 2 under EVERY design (theme_fit_by_design, migration 061; min
 * over designs) — through buildItemHighlightsPerDesign (the same producer the pipeline ships) into
 * per_child_item_highlights (identical per SKU by construction); the broadcast row becomes a
 * per-design marker with no line. Holds `designs-unrated` (422, missing keys named) until
 * keyword-pool/rerate { per_design: true } has rated the pool under every design.
 * READ-ONLY identity (no vision call) — see designGroupIdentity.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getStoredAnalysis } from '@/lib/keyword-engine'
import { selectionMode, resolveRankingTargets } from '@/lib/keyword-engine/selection-core'
import { loadSelectionContext, readWindow } from '@/lib/keyword-engine/selectionContext'
import { resolveToChildAsin } from '@/lib/fba/resolveAsin'
import { poolKeyFromResolved } from '@/lib/keyword-engine/poolKey'
import { buildItemHighlights, buildItemHighlightsPerDesign, IH_HOLD_MESSAGES } from '@/lib/fba/listingPipeline'
import { detailValueToString, isItemHighlightsField, capItemHighlightRepeats } from '@/lib/fba/productDetailAttrs'
import { resolveBlankRowForNet } from '@/lib/fba/blankSpecs'
import { resolveMultiDesign } from '@/lib/fba/perDesign'
import { identityPhrases, readDesignGroupIdentity } from '@/lib/fba/designGroupIdentity'
import { perDesignIhRows } from '@/lib/fba/perDesignItemHighlights'

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
      .select('recommended_title, product_details_improvements, keyword_plan, per_child_titles')
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
      // PER-DESIGN fits (migration 061) re-hydrate by the same seam — the shared multi-design line
      // is a min over these, so a projection that strips them would hold the family as unrated.
      const fitByDesignByKw = new Map(analysis.map((k) => [k.keyword.toLowerCase(), k.themeFitByDesign ?? null]))
      hlAnalysis = hlAnalysis.map((k) => {
        const next = { ...k }
        if ((k as { themeFit?: number | null }).themeFit == null) next.themeFit = fitByKw.get(k.keyword.toLowerCase()) ?? null
        if (next.themeFitByDesign == null) next.themeFitByDesign = fitByDesignByKw.get(k.keyword.toLowerCase()) ?? null
        return next
      })
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
    const storedPct = (Array.isArray(rec.per_child_titles) ? rec.per_child_titles : []) as { title?: string }[]
    const blankRow = await resolveBlankRowForNet(supabase, {
      parentAsin: parent_asin,
      childAsin: resolved?.childAsin ?? null,
      // Every title the IH will sit beside — per-child titles included on multi-design families.
      titles: [title, ...storedPct.map((t) => String(t?.title ?? ''))],
    })

    // ── MULTI-DESIGN (PO 2026-08-21): ONE SHARED line through the SAME producer the pipeline
    // ships (min-over-designs fit, all design names stripped, union of per-design titles). Groups =
    // the stored per_child_titles' design keys (the ONE grouping — never a second resolver);
    // identity per design = the READ-ONLY cached vision identity of the group's first scanned
    // child (this route never spends a vision call — POST scan-identity {per_design:true}
    // populates it). The broadcast row becomes the per-design MARKER (no line).
    const pct = (Array.isArray(rec.per_child_titles) ? rec.per_child_titles : []) as { sku: string; asin: string; title: string; designName?: string | null; designKey?: string | null }[]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: scoreRow } = await (supabase as any).from('listing_seo_scores').select('is_multi_design_override').eq('parent_asin', parent_asin).maybeSingle()
    const multi = resolveMultiDesign(pct, (scoreRow as { is_multi_design_override?: boolean | null } | null)?.is_multi_design_override ?? null)
    const byKey = new Map<string, { key: string; designName: string; skus: { sku: string; asin: string }[]; titles: string[] }>()
    if (multi) {
      for (const r of pct) {
        const key = r.designKey || r.designName || ''
        if (!key) continue
        const g = byKey.get(key) ?? { key, designName: r.designName || key, skus: [], titles: [] }
        g.skus.push({ sku: r.sku, asin: r.asin })
        if (r.title && !g.titles.includes(r.title)) g.titles.push(r.title)
        byKey.set(key, g)
      }
    }
    if (multi && byKey.size < 2) {
      // Multi-design by override/detector but no per-design titles stored yet: a broadcast line here
      // would be the exact lie the ruling forbids (and the push seam would refuse it) — say so.
      return NextResponse.json({ error: 'Multi-design family without per-design titles yet — run a full AI audit first so each design gets its own title, then regenerate the Item Highlight per design.', hold: 'no-design-groups' }, { status: 422 })
    }
    if (multi && byKey.size >= 2) {
      const groups = await Promise.all([...byKey.values()].map(async (g) => {
        const gi = await readDesignGroupIdentity(g).catch(() => null)
        return { ...g, identityPhrases: identityPhrases(gi?.identity ?? null) }
      }))
      const built = buildItemHighlightsPerDesign({
        groups, pool: hlAnalysis, apparelProduct: apparel, blankBrand: blankRow,
        familyTitleText: title,
      })
      const composed = built.perDesign.filter((d) => d.value)
      if (composed.length === 0) {
        const reasons = [...new Set(built.perDesign.map((d) => d.hold).filter((h): h is NonNullable<typeof h> => !!h))]
        const missing = built.shared.missingDesigns
        return NextResponse.json({
          error: `Shared Item Highlight HELD: ${reasons.map((r) => IH_HOLD_MESSAGES[r]).join(' · ')}${missing.length ? ` (unrated designs: ${missing.join(', ')})` : ''} — kept the existing values.`,
          hold: reasons[0] ?? 'under-floor', missing_designs: missing,
          per_design: built.perDesign.map((d) => ({ designKey: d.designKey, designName: d.designName, hold: d.hold })),
        }, { status: 422 })
      }
      const updated = details.map((p, i) => (i === ihIdx ? { ...p, recommended_value: '', per_design: true } : p))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any
      const { error: updErr } = await db.from('listing_seo_recommendations')
        .update({ product_details_improvements: updated, per_child_item_highlights: built.perChild }).eq('parent_asin', parent_asin)
      if (updErr) {
        // Missing migration 060: persisting the marker WITHOUT the lines would blank the field — refuse loudly instead.
        console.error(`[regenerate-item-highlight] per-design persist failed for ${parent_asin} (run migration 060): ${updErr.message}`)
        return NextResponse.json({ error: `Could not save the per-design Item Highlights (${updErr.message}). Apply migration 060 (per_child_item_highlights) and retry.` }, { status: 500 })
      }
      return NextResponse.json({
        per_design: perDesignIhRows(built.perChild),
        per_child_item_highlights: built.perChild,
        product_details_improvements: updated,
        shared: { item_highlight: built.shared.value, designs: built.shared.designKeys, foreignDropped: built.shared.foreignDropped },
        composed: composed.length, held: built.perDesign.length - composed.length,
      })
    }

    // Path parity (Invariant 1): the SAME inputs the pipeline hands the producer — pool, blank row,
    // the title the IH will sit beside. Deterministic; no client, no LLM.
    const built = buildItemHighlights({ finalTitle: title, pool: hlAnalysis, apparelProduct: apparel, blankBrand: blankRow, netTitles: [title] })
    const hl = capItemHighlightRepeats((built.value || '').trim())
    if (!hl) {
      // HOLD (PO 2026-08-21): name the reason — the PO's next action — never a generic "empty".
      const reason = built.hold ?? 'under-floor'
      return NextResponse.json({ error: `${IH_HOLD_MESSAGES[reason]} — kept the existing value.`, hold: reason }, { status: 422 })
    }

    // Single-design: the broadcast row carries the line; any stale per-design marker/array is cleared
    // (a family forced back to single-design must not keep per-design lines the push would prefer).
    const updated = details.map((p, i) => (i === ihIdx ? { ...p, recommended_value: hl, per_design: false } : p))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    let { error: updErr } = await db.from('listing_seo_recommendations')
      .update({ product_details_improvements: updated, per_child_item_highlights: null }).eq('parent_asin', parent_asin)
    if (updErr) {   // pre-migration-060 DB: save the row alone (missing-column tolerance)
      ;({ error: updErr } = await db.from('listing_seo_recommendations').update({ product_details_improvements: updated }).eq('parent_asin', parent_asin))
    }
    if (updErr) return NextResponse.json({ error: `Could not save: ${updErr.message}` }, { status: 500 })

    return NextResponse.json({ item_highlight: hl, product_details_improvements: updated })
  } catch (e) {
    console.error('[regenerate-item-highlight]', e)
    return NextResponse.json({ error: 'Internal error', details: String(e) }, { status: 500 })
  }
}
