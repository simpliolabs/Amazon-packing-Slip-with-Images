/**
 * POST /api/fba/listing-optimizer/score-title
 * ─────────────────────────────────────────────────────────────────────────────
 * "Type your own title" scorer. The seller types/pastes any title; we return the
 * REAL score it would get (the exact scoreListingContent engine, with this title
 * substituted in over the live content) PLUS the Amazon-rule check (validateTitle:
 * bare third-party brands, trademarks, length, ALL-CAPS, word repeats, audience).
 *
 * No side effects — read-only scoring. The push itself stays on the existing
 * push-content route (the seller pushes only after seeing the score).
 *
 * Body: { parent_asin: string, title: string }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { scoreListingContent, fetchScoringContext } from '@/lib/sync/syncListingContent'
import { validateTitle } from '@/lib/fba/listingPipeline'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

const CONTENT_COLS = 'sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt'

export async function POST(req: NextRequest) {
  try {
    const { parent_asin, title } = (await req.json()) as { parent_asin?: string; title?: string }
    if (!parent_asin || typeof title !== 'string') {
      return NextResponse.json({ error: 'parent_asin and title are required' }, { status: 400 })
    }

    const supabase = getAdminSupabase()
    const { data: rows } = await supabase
      .from('listing_content')
      .select(CONTENT_COLS)
      .eq('parent_asin', parent_asin)
      .order('sku', { ascending: true })

    if (!rows || rows.length === 0) {
      return NextResponse.json({ error: 'No live content found for this parent — run Scan Listings first.' }, { status: 404 })
    }

    const children = rows as Record<string, unknown>[]
    // Prefer the row whose ASIN IS the parent (the variation hub); else the first child.
    const rep = children.find((c) => c.asin === parent_asin) ?? children[0]
    const topChildAsin = (rep?.asin as string) ?? null

    const scoringCtx = await fetchScoringContext(supabase, parent_asin, topChildAsin)
    const brandName = scoringCtx.brandName ?? ''

    // Score the seller's TYPED title against the live everything-else — this is the real
    // number the dashboard would show, not an estimate.
    const trimmed = title.trim()
    const parentContent = { ...rep, title: trimmed }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const score = scoreListingContent(parentContent as any, children as any, scoringCtx)

    // Granular Amazon-rule + SEO check for the typed title.
    const ruleProblems = validateTitle(trimmed, brandName)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const titleIssues = (score.issues ?? []).filter((i: any) => i.field === 'title')
    const suppressionRisk = ruleProblems.some((p) => /SUPPRESS|TRADEMARK|bare third-party|150/i.test(p))

    return NextResponse.json({
      title: trimmed,
      length: trimmed.length,
      titleScore: score.title_score,
      maxTitleScore: 25,
      overallScore: score.overall_score,
      titleIssues,        // scorer issues (length / ALL-CAPS / front-loading / etc.)
      ruleProblems,       // validateTitle problems (bare brands, trademarks, repeats, audience)
      suppressionRisk,    // any hard Amazon-policy violation present
      brandName: brandName || null,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
