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
 */
import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { scanProductImage, getProductImageUrl } from '@/lib/keyword-engine/visionScanner'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { parent_asin, force } = (await req.json().catch(() => ({}))) as { parent_asin?: string; force?: boolean }
    const asin = (parent_asin ?? '').trim().toUpperCase()
    if (!asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })

    const imageUrl = await getProductImageUrl(asin)
    if (!imageUrl) {
      return NextResponse.json({ error: `No product image URL stored for ${asin} — run /api/fba/admin/backfill-images?execute=1 first.`, parent_asin: asin, reason: 'no-image' }, { status: 422 })
    }

    const { resolveOpenAIKey } = await import('@/lib/openai/credentials')
    const { instrumentAiHealth } = await import('@/lib/openai/errorClass')
    const openai = instrumentAiHealth(new OpenAI({ apiKey: await resolveOpenAIKey(), baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1' }))

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
