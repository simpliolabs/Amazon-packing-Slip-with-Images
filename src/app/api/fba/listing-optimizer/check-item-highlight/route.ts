/**
 * POST /api/fba/listing-optimizer/check-item-highlight
 * ─────────────────────────────────────────────────────────────────────────────
 * "Type your own Item Highlight" checker — the IH counterpart of score-title, and the server side
 * of the seller's 2026-08-18 request (IH-1): the Ship Detail modal for Item Highlight had no way to
 * edit a value before shipping it, while the Title modal has had an editable box plus a rules check
 * for months.
 *
 * WHAT IT RETURNS. The SAME deterministic gates the generator runs (validateItemHighlights) plus a
 * preview of what the push boundary would actually ship (capItemHighlightRepeats). Both come from
 * the ONE repeat rule unified earlier today — before that unification these two disagreed, and an
 * edit box would have validated the seller's typing against a rule Amazon does not have.
 *
 * WHY BOTH, AND WHY THE PREVIEW MATTERS. `capItemHighlightRepeats` runs at the push boundary
 * regardless of what this endpoint says, so the honest thing to show is the value that will LAND on
 * Amazon, not just a pass/fail on what was typed. `willShipUnchanged` is the property the seller
 * actually cares about; when it is false we return the trimmed string so nothing is a surprise.
 *
 * READ-ONLY. No writes, no LLM, no Jungle Scout, no Amazon call — pure functions over the posted
 * string. The push itself stays on push-content, exactly like score-title.
 *
 * Body: { parent_asin: string, value: string }
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { validateItemHighlights, deriveDesignSeasons } from '@/lib/fba/listingPipeline'
import { capItemHighlightRepeats, ihRepeatViolations, IH_MAX_WORD_REPEATS } from '@/lib/fba/productDetailAttrs'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'

/** ONE budget constant (generation-invariants INVARIANT 5): Amazon's Item Highlights budget is 125
 *  chars (CONTENT_CONTRACT.itemHighlights.max — PO ruling 2026-08-10; sellercentral G200390640).
 *  This route shipped 2026-08-18 with a hardcoded 75 — the RETIRED pre-08-10 cap — so the editor
 *  told the seller a 77-char value was over budget while the validator and terminal net accepted
 *  up to 125. The 75 belongs to the TITLE (and the 100476 heal) only. PO-caught 2026-08-20. */
const IH_MAX_CHARS = CONTENT_CONTRACT.itemHighlights.max

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

export async function POST(req: NextRequest) {
  try {
    const { parent_asin, value } = (await req.json()) as { parent_asin?: string; value?: string }
    if (!parent_asin || typeof value !== 'string') {
      return NextResponse.json({ error: 'parent_asin and value are required' }, { status: 400 })
    }

    const supabase = getAdminSupabase()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any

    // Brand + design context for the gates. Fail-open on every read: a missing score row must not
    // stop the seller from checking a string — it only means the season/capacity gates run blanket,
    // which is the historical default the out-of-file caller already uses.
    let brandName = 'THE CEO'
    let designNameOverride = ''
    let capacityFamily = false
    try {
      const { data: s } = await db.from('listing_seo_scores')
        .select('design_name_override, product_title').eq('parent_asin', parent_asin).maybeSingle()
      designNameOverride = (s?.design_name_override as string | undefined) ?? ''
      const t = (s?.product_title as string | undefined) ?? ''
      if (t) brandName = t.split(/\s+/).slice(0, 2).join(' ')
      capacityFamily = /\b\d+\s?(gb|tb|mb)\b/i.test(t)
    } catch { /* fail-open — gates run with defaults */ }

    let designSeasons: string[] = []
    try {
      designSeasons = deriveDesignSeasons(
        { designNameOverride, canonicalTitle: null, repTitle: null } as never,
        designNameOverride || null,
      )
    } catch { /* fail-open — [] is the blanket seasonal rule */ }

    const trimmed = value.trim()
    const problems = validateItemHighlights(trimmed, brandName, capacityFamily, designSeasons)
    const wouldShip = capItemHighlightRepeats(trimmed)

    return NextResponse.json({
      ok: problems.length === 0,
      problems,
      chars: trimmed.length,
      maxChars: IH_MAX_CHARS,
      overCap: trimmed.length > IH_MAX_CHARS,
      repeatedWords: ihRepeatViolations(trimmed),
      maxWordRepeats: IH_MAX_WORD_REPEATS,
      /** The bytes the push boundary would actually PATCH — shown so a trim is never a surprise. */
      wouldShip,
      willShipUnchanged: wouldShip === trimmed,
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'check failed' }, { status: 500 })
  }
}
