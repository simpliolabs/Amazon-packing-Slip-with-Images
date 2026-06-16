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

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      sha: process.env.BUILD_SHA || 'unknown',
      builtAt: process.env.BUILD_TIME || 'unknown',
      now: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
