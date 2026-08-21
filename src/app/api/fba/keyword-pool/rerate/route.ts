/**
 * POST /api/fba/keyword-pool/rerate  { parent_asin, per_design?: boolean }
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
 *
 * { per_design: true } (PO 2026-08-21, multi-design families): rates the SAME pool against EACH
 * design's own card (per-design vision identity, READ ONLY) and merges theme_fit_by_design /
 * theme_run_by_design (migration 061) for the rows each design rated. The family-level theme_fit
 * is untouched. Guard per (pool, design). A design with no cached identity is `no-card` and
 * skipped — run scan-identity {per_design:true} first. Chain: this → regenerate-item-highlight.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { rerateFromCache, rerateFromCachePerDesign, THEME_RERATE_COOLDOWN_MS, THEME_RATE_MAX_ATTEMPTS } from '@/lib/keyword-engine/themeRatingRun'

export const dynamic = 'force-dynamic'
// A 100-row pool is 2 chunks x 3 parallel raters (+ one bounded retry); measured ~160s worst case.
// Per-design multiplies by the design count (sequential) — B0DQ5YZH38 has 5 — so the ceiling is the
// platform maximum; designs already rated inside the window are refused by their own guard.
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
    const body = (await req.json().catch(() => ({}))) as { parent_asin?: string; per_design?: boolean }
    parentAsin = (body.parent_asin || '').trim().toUpperCase()
    if (!/^[A-Z0-9]{10}$/.test(parentAsin)) {
      return NextResponse.json({ error: 'parent_asin (10-char ASIN) is required' }, { status: 400 })
    }

    if (body.per_design === true) {
      const result = await rerateFromCachePerDesign(parentAsin, { supabase: admin() })
      const { poolKey, status, groups } = result
      if (status === 'empty') {
        return NextResponse.json({ error: `No keyword_analysis rows under pool key ${poolKey} — nothing to re-rate (run research first)`, poolKey, per_design: true, groups }, { status: 404 })
      }
      if (status === 'not-multi-design') {
        return NextResponse.json({ error: `${poolKey} is not a multi-design family (fewer than 2 design groups) — use the family rating (omit per_design).`, poolKey, per_design: true, groups }, { status: 422 })
      }
      const rated = groups.filter((g) => g.status === 'rated').length
      const noCard = groups.filter((g) => g.status === 'no-card').map((g) => g.designKey)
      const cooling = groups.filter((g) => g.status === 'cooldown')
      const failed = groups.filter((g) => g.status === 'failed').map((g) => g.designKey)
      const summary = { poolKey, per_design: true, rated, total: groups.length, groups }
      if (rated > 0) return NextResponse.json(summary)
      // Nothing rated: say which gate stopped every design. All-cooldown → 409 (retry after the
      // longest guard); all-no-card → 422 with the PO action (scan-identity per_design); else 502.
      if (cooling.length === groups.length) {
        const retryAfterMs = Math.max(...cooling.map((g) => g.retryAfterMs ?? THEME_RERATE_COOLDOWN_MS))
        return NextResponse.json(
          { error: `Every design of ${poolKey} was rated or armed within the last ${THEME_RERATE_COOLDOWN_MS / 60000} minutes`, ...summary, retryAfterMs },
          { status: 409, headers: { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) } },
        )
      }
      if (noCard.length + cooling.length === groups.length) {
        return NextResponse.json({
          error: `No per-design identity for ${noCard.join(', ')} — nothing to rate against. Run POST /api/fba/intelligence/scan-identity { parent_asin, per_design: true } first, then re-rate.`,
          ...summary, noCard,
        }, { status: 422 })
      }
      return NextResponse.json({
        error: `Per-design theme rating FAILED for ${failed.join(', ')} of ${poolKey} after ${THEME_RATE_MAX_ATTEMPTS} attempts each; no rows were written for them${noCard.length ? ` (no identity: ${noCard.join(', ')})` : ''}. Retry after the cooldown; see THEME_RATE_FAILED / [KW_THEME_RATER] in the logs.`,
        ...summary, failed, noCard,
      }, { status: 502 })
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
