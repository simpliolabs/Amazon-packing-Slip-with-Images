/**
 * POST /api/fba/intelligence/scan-identity  { parent_asin, force?: boolean }
 * ─────────────────────────────────────────────────────────────────────────────
 * Identity-only vision scan (2026-08-21). The vision scan used to run ONLY inside a full regen, so a
 * family whose image arrived after its last regen (or whose scan failed silently) stayed identity-less
 * forever — no theme card, no theme rating, and the Item Highlights composer holds it as
 * 'unrated-pool' (B0DQ5YZH38, B0F6VTY79T, B0DSCDZC6K). A full regen is the wrong tool to fix that:
 * with CONTENT_RECONCILE on it would auto-push any changed core field.
 *
 * This route reads the design off the product image and persists product_identity — NOTHING ELSE.
 * COST: one OpenAI vision call. ZERO Jungle Scout involvement by construction (imports no keyword
 * research code; touches listing_seo_scores/catalog_products for the image URL and product_identity
 * for the result). Chain afterwards: POST /api/fba/keyword-pool/rerate → regenerate-item-highlight.
 * Auth: the /api/fba middleware. Cached identities are returned without a new call unless force=true.
 * { parent_asin, per_design: true } (PO 2026-08-21): one identity PER DESIGN GROUP — the pipeline's
 * own grouping (detectDesignGroups), one representative child (first with an image) scanned per
 * group. Returns one entry per design key; the regenerate-item-highlight route reads them.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { scanProductImage, getProductImageUrl } from '@/lib/keyword-engine/visionScanner'
import { detectDesignGroups } from '@/lib/fba/listingPipeline'
import { scanDesignGroupIdentity } from '@/lib/fba/designGroupIdentity'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { parent_asin, force, per_design } = (await req.json().catch(() => ({}))) as { parent_asin?: string; force?: boolean; per_design?: boolean }
    const asin = (parent_asin ?? '').trim().toUpperCase()
    if (!asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })

    // Cost-guard pass (2026-08-22): routed through the gateway (llmGateway.ts) instead of a
    // hand-rolled `new OpenAI({...})`, which inherited the SDK's default maxRetries: 2 — an
    // insufficient_quota (429) account silently retried this vision call up to 3x. Same
    // resolveOpenAIKey() + baseURL + instrumentAiHealth as before.
    const { getLlmClientForRequest } = await import('@/lib/fba/llmGateway')
    const openai = await getLlmClientForRequest()

    // ── PER DESIGN (PO 2026-08-21): one identity per DESIGN GROUP — the SAME grouping the pipeline's
    // per_child_titles use (detectDesignGroups over the family's child SKUs, seller override
    // honored), scanning ONE representative child per group (first child with an image). One vision
    // call per design at most; cached identities return without a call. Still ZERO Jungle Scout.
    if (per_design === true) {
      const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })
      const { data: rows, error: rowsErr } = await supabase.from('listing_content').select('sku, asin').eq('parent_asin', asin).order('sku', { ascending: true })
      if (rowsErr) return NextResponse.json({ error: `listing_content read failed: ${rowsErr.message}` }, { status: 500 })
      const byAsin = new Map<string, { sku: string; asin: string }>()
      for (const r of (rows ?? []) as { sku: string; asin: string }[]) {
        const ex = byAsin.get(r.asin)
        if (!ex || r.sku.endsWith('-FBA')) byAsin.set(r.asin, r)
      }
      const children = [...byAsin.values()].sort((a, b) => a.sku.localeCompare(b.sku))
      const { data: scoreRow } = await supabase.from('listing_seo_scores').select('is_multi_design_override').eq('parent_asin', asin).maybeSingle()
      const override = (scoreRow as { is_multi_design_override?: boolean | null } | null)?.is_multi_design_override ?? null
      const detected = detectDesignGroups(children, { parentAsin: asin })
      const isMulti = override === true ? true : override === false ? false : detected.isMultiDesign
      if (!isMulti || detected.groups.length < 2) {
        return NextResponse.json({ error: `${asin} is not a multi-design family (${detected.groups.length} design group(s) detected${override === false ? ', forced single-design' : ''}) — use the family scan instead.`, parent_asin: asin, reason: 'not-multi-design', groups: detected.groups.map((g) => g.key) }, { status: 422 })
      }
      const out = []
      for (const g of detected.groups) {
        const gi = await scanDesignGroupIdentity(g, { openai, force: force === true })
        out.push({
          designKey: g.key, skus: g.skus.length, repAsin: gi.repAsin, imageUrl: gi.imageUrl,
          designTheme: gi.identity?.designTheme ?? null,
          seedKeywords: gi.identity?.seedKeywords ?? [],
          suggestedSearchTerms: (gi.identity as { suggestedSearchTerms?: string[] } | null)?.suggestedSearchTerms ?? [],
          reason: gi.identity ? null : (gi.repAsin ? 'scan-empty' : 'no-image'),
        })
      }
      console.log(JSON.stringify({ tag: 'SCAN_IDENTITY_PER_DESIGN', parent: asin, groups: out.map((o) => ({ key: o.designKey, rep: o.repAsin, theme: o.designTheme })) }))
      return NextResponse.json({ parent_asin: asin, per_design: true, groups: out })
    }

    const imageUrl = await getProductImageUrl(asin)
    if (!imageUrl) {
      return NextResponse.json({ error: `No product image URL stored for ${asin} — run /api/fba/admin/backfill-images?execute=1 first.`, parent_asin: asin, reason: 'no-image' }, { status: 422 })
    }

    const identity = await scanProductImage(asin, imageUrl, { forceRescan: force === true, openai })
    if (!identity) {
      console.warn(`[scan-identity] vision returned nothing for ${asin} (${imageUrl})`)
      return NextResponse.json({ error: `Vision scan returned no identity for ${asin}.`, parent_asin: asin, imageUrl, reason: 'scan-empty' }, { status: 502 })
    }
    console.log(JSON.stringify({ tag: 'SCAN_IDENTITY', parent: asin, designTheme: identity.designTheme ?? null, seeds: (identity.seedKeywords ?? []).length }))
    return NextResponse.json({
      parent_asin: asin,
      imageUrl,
      designTheme: identity.designTheme ?? null,
      visualElements: identity.visualElements ?? [],
      seedKeywords: identity.seedKeywords ?? [],
      suggestedSearchTerms: (identity as { suggestedSearchTerms?: string[] }).suggestedSearchTerms ?? [],
    })
  } catch (e) {
    console.error('[scan-identity]', e)
    return NextResponse.json({ error: 'Internal error', details: String(e) }, { status: 500 })
  }
}
