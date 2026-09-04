/**
 * themeRerateControl.ts — client-side trigger + response classifier for the per-design theme
 * rating control (PO 2026-09-04: family B0DSCDZC6K shipped NO Item Highlights — every design
 * holds `designs-unrated` because the pool has a FAMILY theme_fit but no PER-DESIGN rating, and
 * the "Held" badge's own tooltip tells the seller to run `keyword-pool/rerate { per_design: true }`
 * with NO control anywhere to do it — the second instance of "the UI instructs an action for
 * which no control exists" in two days, after the per-design Garment control, PR #665).
 *
 * This is a TRIGGER surface only — it calls the existing POST /api/fba/keyword-pool/rerate route
 * unchanged (no new endpoint, no GET handler) and classifies its response. It never rates
 * anything itself, never touches theme_fit semantics, and makes no OpenAI or Jungle Scout call of
 * its own — the request IS the one billable (OpenAI-only, credit-free) call the route already
 * made possible.
 *
 * Deliberately kept SEPARATE from themeRatingRun.ts (server-only: imports @supabase/supabase-js
 * transitively via selectionContext.ts) — same "deliberately separate" reason garmentPerDesign.ts
 * gives for staying out of blankAssignmentImpact.ts's import graph. The types below are a local,
 * minimal mirror of the route's per-design response shapes (verified against
 * src/app/api/fba/keyword-pool/rerate/route.ts and src/lib/keyword-engine/themeRatingRun.ts's
 * DesignRerateResult / PerDesignRerateResult), not an import, so the 'use client' listing page
 * never pulls a service-role-touching module into the browser bundle.
 *
 * `runThemeRerate` is the ONE seam the page calls: it is pure I/O orchestration with `fetchImpl`
 * injected, so every branch below (busy-gate, every documented route outcome) is a plain unit
 * test with no DOM / no React needed — the codebase's existing "extracted leaves" test style
 * (garmentPerDesign.test.ts, blankAssignmentImpact.test.ts) has no @testing-library/react
 * dependency, and this module follows the same convention rather than introducing one.
 */

export type DesignRerateStatus = 'rated' | 'failed' | 'cooldown' | 'no-card'

/** Local mirror of themeRatingRun.ts's DesignRerateResult — only the fields the UI reads. */
export interface DesignRerateGroupLike {
  designKey: string
  designName: string | null
  status: DesignRerateStatus
  asked: number
  rated: number
  written: number
  reason?: string
  retryAfterMs?: number
}

export type ThemeRerateOutcome =
  | { kind: 'success'; poolKey: string; rated: number; total: number; groups: DesignRerateGroupLike[]; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'not-multi-design'; message: string }
  | { kind: 'cooldown'; message: string; retryAfterMs: number }
  | { kind: 'no-card'; message: string; noCard: string[] }
  | { kind: 'failed'; message: string; failed: string[]; noCard: string[] }
  | { kind: 'error'; message: string }

export interface ThemeRerateRequestBody {
  parent_asin: string
  per_design: true
}

/** THE exact body the route requires (route.ts destructures `body.parent_asin` — snake_case; a
 *  camelCase `parentAsin` silently 400s: `/^[A-Z0-9]{10}$/.test('')` fails on the empty string
 *  the route falls back to). Kept as its own function so a future edit cannot drift the key name
 *  without failing `themeRerateControl.test.ts`'s exact-shape assertion. */
export function buildThemeRerateRequestBody(parentAsin: string): ThemeRerateRequestBody {
  return { parent_asin: parentAsin, per_design: true }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}
function asGroups(v: unknown): DesignRerateGroupLike[] {
  return Array.isArray(v) ? (v as DesignRerateGroupLike[]) : []
}

/**
 * Classifies ONE response from POST /api/fba/keyword-pool/rerate { per_design: true } into a
 * distinct, renderable outcome. Discrimination is by HTTP status first (matching the route's own
 * switch), then by which body key is present where two outcomes share a status (422 covers both
 * `not-multi-design` — no `noCard` key, `groups: []` — and the all-no-card refusal — `noCard`
 * present — per route.ts's two 422 branches).
 */
export function classifyThemeRerateResponse(status: number, body: unknown): ThemeRerateOutcome {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const errorMsg = asString(b.error)

  if (status >= 200 && status < 300) {
    const rated = asNumber(b.rated)
    const groups = asGroups(b.groups)
    const total = asNumber(b.total, groups.length)
    const poolKey = asString(b.poolKey) ?? ''
    return {
      kind: 'success',
      poolKey,
      rated,
      total,
      groups,
      message: `Rated ${rated} of ${total} design group${total === 1 ? '' : 's'} against the pool. Click Regen to compose the Item Highlight.`,
    }
  }
  if (status === 404) {
    return { kind: 'empty', message: errorMsg ?? 'No keyword pool cached for this family yet — run research first.' }
  }
  if (status === 409) {
    const retryAfterMs = asNumber(b.retryAfterMs, 10 * 60 * 1000)
    return { kind: 'cooldown', message: errorMsg ?? 'Every design was rated or armed within the cooldown window.', retryAfterMs }
  }
  if (status === 422) {
    const noCard = asStringArray(b.noCard)
    if (noCard.length > 0 || 'noCard' in b) {
      return { kind: 'no-card', message: errorMsg ?? 'No per-design identity to rate against.', noCard }
    }
    return { kind: 'not-multi-design', message: errorMsg ?? 'Fewer than 2 design groups — use the family rating instead.' }
  }
  if (status === 502) {
    return { kind: 'failed', message: errorMsg ?? 'Rating failed for every design that was attempted.', failed: asStringArray(b.failed), noCard: asStringArray(b.noCard) }
  }
  return { kind: 'error', message: errorMsg ?? `Rating request failed (HTTP ${status}).` }
}

export interface ThemeRerateDeps {
  /** Injected so tests never touch the network — production passes the global `fetch`. */
  fetchImpl: typeof fetch
  /** Extra headers (Authorization bearer token) — merged after Content-Type. */
  headers?: Record<string, string>
}

/**
 * The ONE call site. Returns `null` (no fetch made) when `busy` is true — the in-flight guard is
 * IN the orchestrator, not just a disabled DOM attribute, so a race between two click handlers
 * can never fire two billable rating passes. Never throws: a network failure classifies as
 * `{ kind: 'error' }` the same as the route's own 500 catch-all.
 */
export async function runThemeRerate(parentAsin: string, busy: boolean, deps: ThemeRerateDeps): Promise<ThemeRerateOutcome | null> {
  if (busy) return null
  try {
    const resp = await deps.fetchImpl('/api/fba/keyword-pool/rerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(deps.headers ?? {}) },
      body: JSON.stringify(buildThemeRerateRequestBody(parentAsin)),
    })
    const data = await resp.json().catch(() => ({}))
    return classifyThemeRerateResponse(resp.status, data)
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'Rating request failed' }
  }
}
