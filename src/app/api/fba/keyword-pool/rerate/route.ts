/**
 * POST /api/fba/keyword-pool/rerate  { parent_asin }
 * ─────────────────────────────────────────────────────────────────────────────
 * CREDIT-FREE theme re-rating of a family's EXISTING keyword pool. Reads the stored
 * keyword_analysis rows under the ONE pool key, rebuilds the theme card the way the sync does,
 * runs the OpenAI raters over those keywords, and writes theme_fit + a new theme_run_id for the
 * rows it rated. It never calls researchKeywords / Jungle Scout, never touches keyword_cache, and
 * never moves kw_ref_fingerprint — the only network calls are the existing OpenAI rating calls.
 *
 * Exists because a plain Regenerate cannot repair an unrated pool: the ai-recommendations
 * fingerprint gate re-runs the sync (the rater's only other caller) only when the pool is EMPTY
 * or a reference signal CHANGED. Auth is enforced by the /api/fba middleware (task #49).
 *
 * 409 while a rating for the pool was armed or completed inside the last 10 minutes — the guard
 * is armed BEFORE the first OpenAI call (retry-guard-armed-by-completion), so a request the
 * gateway kills mid-rating cannot be re-fired into a second billable run by the next click.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { rerateFromCache, THEME_RERATE_COOLDOWN_MS, THEME_RATE_MAX_ATTEMPTS } from '@/lib/keyword-engine/themeRatingRun'

export const dynamic = 'force-dynamic'
// A 100-row pool is 2 chunks x 3 parallel raters (+ one bounded retry); measured ~160s worst case.
export const maxDuration = 300

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

export async function POST(req: NextRequest) {
  let parentAsin = ''
  try {
    const body = (await req.json().catch(() => ({}))) as { parent_asin?: string }
    parentAsin = (body.parent_asin || '').trim().toUpperCase()
    if (!/^[A-Z0-9]{10}$/.test(parentAsin)) {
      return NextResponse.json({ error: 'parent_asin (10-char ASIN) is required' }, { status: 400 })
    }

    const result = await rerateFromCache(parentAsin, { supabase: admin() })
    const { poolKey, status, asked, rated, runId } = result
    switch (status) {
      case 'empty':
        return NextResponse.json({ error: `No keyword_analysis rows under pool key ${poolKey} — nothing to re-rate (run research first)`, poolKey, asked, rated, runId }, { status: 404 })
      case 'cooldown':
        return NextResponse.json(
          { error: `A theme rating for ${poolKey} was armed or completed within the last ${THEME_RERATE_COOLDOWN_MS / 60000} minutes`, poolKey, asked, rated, runId, retryAfterMs: result.retryAfterMs },
          { status: 409, headers: { 'Retry-After': String(Math.ceil((result.retryAfterMs ?? THEME_RERATE_COOLDOWN_MS) / 1000)) } },
        )
      case 'failed': {
        // Nothing was written. `no-card` is a DATA gap (no design name / vision theme / plan name
        // anywhere for this family — zero OpenAI calls were made), so it is 422 with the PO action;
        // `below-threshold` means the raters ran and judged too little to count as a run — 502 names
        // an upstream (model) failure, and the PO can retry after the cooldown.
        const noCard = result.reason === 'no-card'
        const error = noCard
          ? `No theme card for ${poolKey}: no design name, per-design names, vision theme or resolved plan name exist for this family, so there is nothing to rate against. Set a Design Name override for the family, then re-rate.`
          : `Theme rating FAILED for ${poolKey} (${result.reason}) — rated ${rated}/${asked} after ${THEME_RATE_MAX_ATTEMPTS} attempts; no rows were written. Retry after the cooldown; see THEME_RATE_FAILED / [KW_THEME_RATER] in the logs.`
        return NextResponse.json({ error, poolKey, asked, rated, runId: null, reason: result.reason }, { status: noCard ? 422 : 502 })
      }
      case 'rated':
      default:
        return NextResponse.json({ poolKey, asked, rated, runId })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[keyword-pool/rerate] parent=${parentAsin || '?'} threw: ${msg}`)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
