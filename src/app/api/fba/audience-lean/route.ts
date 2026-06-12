/**
 * POST /api/fba/audience-lean — persist the seller-declared audience lean (PR #195).
 * Body: { parent_asin, audience_lean: 'male'|'female'|'lean_male'|'lean_female'|'unisex'|null }
 * Stored on listing_seo_scores (one row per parent, mirrors the competitor-asin pattern).
 * The next Regenerate AI Audit reads it and re-weights the entire listing.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

const VALID = new Set(['male', 'female', 'lean_male', 'lean_female', 'unisex'])

export async function POST(req: NextRequest) {
  let body: { parent_asin?: string; audience_lean?: string | null }
  try { body = (await req.json()) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }

  const { parent_asin, audience_lean } = body
  if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  if (audience_lean != null && !VALID.has(audience_lean)) {
    return NextResponse.json({ error: `audience_lean must be one of ${[...VALID].join(', ')} or null` }, { status: 400 })
  }

  const supabase = await createAdminClient()
  const { error } = await supabase
    .from('listing_seo_scores')
    .update({ audience_lean: audience_lean ?? null } as never)
    .eq('parent_asin', parent_asin)
  if (error) {
    const friendly = /audience_lean|schema cache/i.test(error.message)
      ? 'audience_lean column not found — run supabase/migrations/029_audience_lean.sql in the Supabase SQL editor, then retry.'
      : error.message
    return NextResponse.json({ error: friendly }, { status: 500 })
  }
  return NextResponse.json({ ok: true, audience_lean: audience_lean ?? null })
}
