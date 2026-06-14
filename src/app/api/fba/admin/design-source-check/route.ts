/**
 * GET /api/fba/admin/design-source-check?parent_asin=B0XYZ
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only diagnostic for "wrong/stuck design name in regenerated title". Surfaces the
 * EXACT cached inputs extractDesignName reads from (listing_seo_scores.product_title +
 * product_identity vision), per ASIN, so we can SEE why a regen keeps producing a phrase
 * that does not appear in the live Amazon title (PO: B0GQVL3K4B "Too Young to Retire Too
 * Poor to Quit" recurs across regens; live title says "I Am Retired I Don't Have to").
 * No writes, no credits.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const parent = new URL(req.url).searchParams.get('parent_asin')
  if (!parent) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  const supabase = await createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any

  // 1) listing_seo_scores.product_title — this becomes pipeline.canonicalTitle, the PRIMARY
  //    source extractDesignName accepts the LLM's design name against (listingPipeline.ts:2885,2932).
  const score = await db.from('listing_seo_scores')
    .select('parent_asin, product_title, scored_at, top_child_asin, audience_lean, overall_score')
    .eq('parent_asin', parent).maybeSingle()

  // 2) Per-child representative title (listing_content): what's actually on Amazon now per child.
  const children = await db.from('listing_content')
    .select('asin, sku, title, last_synced_at, fulfillment_channel')
    .eq('parent_asin', parent)
    .order('asin', { ascending: true })
    .limit(20)
  const childAsins = ((children.data ?? []) as { asin: string }[]).map((c) => c.asin)

  // 3) Vision identity is stored under the PARENT — but also try children in case any have rows.
  const identityKeys = [parent, ...childAsins.slice(0, 5)]
  const identityRows = await db.from('product_identity')
    .select('asin, identity_data, scanned_at')
    .in('asin', identityKeys)

  return NextResponse.json({
    parent_asin: parent,
    canonical_title: (score.data as { product_title?: string } | null)?.product_title ?? null,
    score_row: score.data ?? null,
    score_error: score.error?.message ?? null,
    child_titles: (children.data ?? []) as { asin: string; sku: string; title: string }[],
    vision_identity: ((identityRows.data ?? []) as { asin: string; identity_data: { designTheme?: string; seedKeywords?: string[]; suggestedSearchTerms?: string[]; visualElements?: string[] } }[]).map((r) => ({
      asin: r.asin,
      designTheme: r.identity_data?.designTheme ?? null,
      seedKeywords: r.identity_data?.seedKeywords ?? [],
      suggestedSearchTerms: r.identity_data?.suggestedSearchTerms ?? [],
      visualElements: (r.identity_data?.visualElements ?? []).slice(0, 8),
    })),
  })
}
