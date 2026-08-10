/**
 * GET /api/health
 * ─────────────────────────────────────────────────────────────────────────────
 * Liveness + BUILD IDENTITY. Returns the commit SHA and build timestamp baked into
 * THIS running bundle (next.config.ts injects BUILD_SHA / BUILD_TIME at build time).
 *
 * Why this exists: deploys to Coolify can silently serve a stale bundle (a failed
 * layer-export, or "deployed" but not rebuilt). There was no way to confirm what's
 * actually live — which caused hours of "is #263 deployed?" confusion on 2026-06-16.
 * Hit this endpoint after any deploy: if `sha` matches the merged commit and `builtAt`
 * is fresh, the new code is live. No auth required (no sensitive data). Never cached.
 */
import { NextResponse } from 'next/server'
import { describeContentReconcileMode } from '@/lib/fba/contentReconcile'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Behavior-flag readout (flag census, 2026-08-03). Hard allowlist — only known
 * non-secret behavior switches, never arbitrary env. `null` = unset (module
 * defaults apply). Dark flags are drift bombs: without this there is no way to
 * confirm what the live process is actually running with.
 */
const BEHAVIOR_FLAGS = [
  'TITLE_COUNCIL_V3', // retired in code 2026-08-03 — listed to surface env residue
  'TITLE_QUALITY_V2', // retired in code 2026-08-03 — listed to surface env residue
  'TITLE_COHERENCE_GATE',
  'BULLET_COHERENCE_GATE',
  'FIX_C_NICHE_POOL', // retired in code 2026-08-03 — listed to surface env residue
  'RELEVANCE_THEME_V2', // retired in code 2026-08-03 (was live-unset) — listed to surface env residue
  'KEYWORD_TARGET_SET',
  'KEYWORD_EASE_WEIGHT', // numeric weight, not on/off (selection-core.selectionEaseWeight; unset/≤0 ⇒ ease term inert) — echo gap found 2026-08-08
  'THEME_HEAL_ON_READ', // KILL SWITCH, default off — in-band re-rating 502'd past its own cooldown (2026-08-09); must read 'off' until the heal moves off the request path
  'THEME_PRINT_TEST', // rater 2-vs-3 boundary (PO ruling 2026-08-09); DEFAULT ON — 'off' reverts the pre-ruling prompt without a redeploy
  'COVERAGE_CORE',
  'CONTENT_SPINE', // retired in code 2026-07-31 — listed to surface env residue
  'BACKEND_DEGRADE_STRICT', // retired in code 2026-08-03 — listed to surface env residue
  'BACKEND_CRITICAL_KEYWORDS',
  'GARMENT_NOUN',
  'SEED_TOKEN_NET', // retired in code 2026-08-03 (POOL_STRATA flip) — listed to surface env residue
  'POOL_STRATA', // flip complete 2026-08-03 — composer unconditional; flag inert, removed at P4
  'SHIP_BAND_NET', // retired in code 2026-08-03 — listed to surface env residue
  'SHIP_ENFORCE', // retired in code 2026-08-03 — listed to surface env residue
  'BULLETS_METRIC_LOOP', // retired in code 2026-08-03 — listed to surface env residue
  'MULTI_DESIGN_AUDIT_MAX_GROUPS',
  'PUSH_QUEUE_ALL',
  'CONTENT_RECONCILE_ENABLED', // content-reconcile loop (PO 2026-08-08) — UNSET = SHADOW; echoed as the EFFECTIVE mode below, never raw
  'NEXT_PUBLIC_PUSH_QUEUE_ALL',
  'PUSH_HEAL_FEEDS_FALLBACK',
  'AUTO_RESHIP_ENABLED',
  'JUNGLE_SCOUT_ENABLED',
] as const

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      sha: process.env.BUILD_SHA || 'unknown',
      builtAt: process.env.BUILD_TIME || 'unknown',
      now: new Date().toISOString(),
      flags: {
        ...Object.fromEntries(BEHAVIOR_FLAGS.map((name) => [name, process.env[name] ?? null])),
        // EFFECTIVE mode, not the raw env: for every other flag null reads "unset → off/default",
        // but this loop runs in SHADOW when unset — echoing null would tell the flag census the
        // opposite of the truth ('shadow (default)' when unset; 'off'/'shadow'/'on' otherwise).
        CONTENT_RECONCILE_ENABLED: describeContentReconcileMode(),
      },
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
