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
import { describeVariantDeathAlarm } from '@/lib/fba/variantDeathAlarm'

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
  'TITLE_MONEY_TAIL', // DARK FLAG until 2026-08-09: gates the money-tail door (listingPipeline.ts:7719/:8116) that the PO gold's '| ... Football Tee' needs, defaults 'off', and was echoed NOWHERE — so its live value could not be verified, only assumed
  'TITLE_SHAPE_JUDGE', // on (DEFAULT since PR #549) | shadow | off — teaches titleQualityJudge the seller's measured left-segment ceiling + their banned vocabulary, and makes the humanizer's adopt gate refuse a LONGER-but-worse rewrite. UNSET = ON, so it is echoed as the EFFECTIVE mode below, never raw — a raw null here would read as 'off' to the flag census, the opposite of the truth.
  'TITLE_RULING_OVER_FLOOR', // off|on, default off — at 'on' a PO editorial removal (waste vocab / inclusive audience / variant color) may ship UNDER our own 70 preferred floor but never over Amazon's 75 cap. At 'off' our scorer's preference can veto a seller ruling, which is how "Unisex" shipped on B0GVV3XL4T.
  'TITLE_V4', // off | shadow (code default) | on — at `on` the title length-extension pad, the facts pad, the council's audience append and the derived identity ceiling are all WITHDRAWN, so the council's output IS the title and a short draft REFUSES instead of being padded. Absent from this list before this line, which meant the flag deciding whether the measured author of the shipped defect runs could not be read in production at all. UNSET = SHADOW (measures without changing bytes); echoed as the effective mode below so a raw null cannot read as 'off' to the census.
  'TITLE_REFEREE', // off (DEFAULT) | shadow | on — at `shadow` the referee is ASKED after the council picks and its disagreement is logged as [TITLE_REFEREE_DIFF]; nothing it says changes a shipped byte. Unlike TITLE_V4 its shadow costs a REAL MODEL CALL, so `off` is the default and a typo also falls to `off` — a measurement that spends money must be opt-in. UNSET = OFF, which is the honest raw echo, so no effective-mode wrapper is needed here.
  'TITLE_REFEREE_SAMPLE', // 1-in-N regens pay for the shadow call (default 5, deterministic by candidate-set hash). Echoed because the DIFF numbers are unreadable without knowing the sample rate they were drawn at.
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
  'TITLE_COUNCIL_MODEL', // model PIN for council judges/adversaries (bullets + backend judges inherit it, default 'gpt-5') — #176 found the judges failing EVERY run with the failure swallowed; the pinned model must be readable in prod or a bad pin is invisible
  'BULLETS_COUNCIL_MODEL', // bullets-council override of the above (default: TITLE_COUNCIL_MODEL || gpt-5)
  'VARIANT_DEATH_ALARM', // on (DEFAULT — read-only alarm card) | off — per-family dead-variant detector (variantDeathAlarm.ts): a child SKU whose content_synced_at froze >14d behind its siblings' max (sync_lag) OR whose stored listing_health offer evidence says no live offer (offer_dead; fail-open on a missing row) is surfaced as a revenue-leak card on the listing page, each SKU labelled with its reason (the Later Gator XL/2XL Orchid two-months-unbuyable incident). UNSET = ON, so it is echoed as the EFFECTIVE mode below — a raw null would read as 'off' to the flag census, the opposite of the truth.
] as const

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      // BUILD_SHA first (baked at build — works for local/docker builds), then Coolify's RUNTIME
      // SOURCE_COMMIT: since Coolify v4.1.2 the build stage no longer sees the commit env, so every
      // deploy read "unknown" (2026-08-19/20 — deploy verification fell back to builtAt timestamps).
      // The runtime container env carries the deployed commit on every Coolify deploy; short form to
      // match git rev-parse --short. Probed live via docker exec 2026-08-20.
      sha: (process.env.BUILD_SHA && process.env.BUILD_SHA !== 'unknown')
        ? process.env.BUILD_SHA
        : (process.env.SOURCE_COMMIT ? process.env.SOURCE_COMMIT.slice(0, 7) : 'unknown'),
      builtAt: process.env.BUILD_TIME || 'unknown',
      now: new Date().toISOString(),
      flags: {
        ...Object.fromEntries(BEHAVIOR_FLAGS.map((name) => [name, process.env[name] ?? null])),
        // EFFECTIVE mode, not the raw env: for every other flag null reads "unset → off/default",
        // but this loop runs in SHADOW when unset — echoing null would tell the flag census the
        // opposite of the truth ('shadow (default)' when unset; 'off'/'shadow'/'on' otherwise).
        CONTENT_RECONCILE_ENABLED: describeContentReconcileMode(),
        // Same reasoning: since PR #549 this flag's default is ON in code, so a raw null would tell
        // the census the judge is off while every apparel title is being scored by it.
        TITLE_SHAPE_JUDGE: process.env.TITLE_SHAPE_JUDGE
          ? (process.env.TITLE_SHAPE_JUDGE || '').toLowerCase()
          : 'on (default)',
        // Same effective-mode echo as the other two. Code default is 'shadow' (listingPipeline.ts:
        // titleV4Mode() — 'on' must be typed exactly; anything else including a typo falls to shadow).
        // A raw null here would read as 'off' to the census, which is wrong: shadow ships today's
        // bytes unchanged BUT logs the diff, and that measurement is the whole reason the flag exists.
        TITLE_V4: process.env.TITLE_V4
          ? (process.env.TITLE_V4 || '').toLowerCase()
          : 'shadow (default)',
        // Default ON (read-only alarm) — same effective-mode reasoning as the three above.
        VARIANT_DEATH_ALARM: describeVariantDeathAlarm(),
      },
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
