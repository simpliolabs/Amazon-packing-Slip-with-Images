/**
 * Next.js instrumentation — runs ONCE when the server process boots (Next 15+ stable).
 *
 * SELF-SCHEDULED CRON (PO directive: "this should be automatic from OUR side — everything looped,
 * self-healing"). The verify/heal queue (push_verification_tasks) was designed to be driven by an
 * external scheduler hitting /api/fba/cron-verify-pushes every ~5 min — but no scheduler was ever
 * configured, so due tasks sat unclaimed forever (verified live 2026-07-02: a due heal task stayed
 * pending/attempts=0 for 18+ min). Instead of depending on infra config that can be forgotten, the
 * app schedules ITSELF: this long-lived Node server (Coolify runs `next start`, not serverless)
 * self-fetches the cron endpoint on an interval with its own CRON_SECRET.
 *
 * Safe by design:
 *  - claimDueTasks atomically flips pending -> running, so a concurrent EXTERNAL scheduler (if one
 *    is ever added) or multiple app instances can never double-process a task.
 *  - Production-only + a globalThis guard (dev HMR re-runs register()).
 *  - Timers are unref'd so they never hold the process open on shutdown.
 *  - Best-effort: a failed tick just waits for the next one; errors log to the server console
 *    (visible in Coolify logs, prefixed [self-cron]).
 */
export async function register() {
  // Node runtime only (register() is also invoked for the edge runtime bundle).
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NODE_ENV !== 'production') return

  const g = globalThis as typeof globalThis & { __fbaSelfCronStarted?: boolean }
  if (g.__fbaSelfCronStarted) return
  g.__fbaSelfCronStarted = true

  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.warn('[self-cron] CRON_SECRET is not set — self-scheduled verify/heal cron DISABLED (due tasks will not be processed)')
    return
  }

  const port = process.env.PORT || '3000'
  const url = `http://127.0.0.1:${port}/api/fba/cron-verify-pushes`
  const INTERVAL_MS = 5 * 60 * 1000
  const BOOT_DELAY_MS = 90 * 1000 // let the server finish warming before the first tick

  const tick = async () => {
    try {
      const resp = await fetch(url, { headers: { 'x-cron-secret': secret }, cache: 'no-store' })
      const body = await resp.json().catch(() => null) as { processed?: unknown[] } | null
      const n = Array.isArray(body?.processed) ? body.processed.length : 0
      if (!resp.ok) console.warn(`[self-cron] verify/heal tick HTTP ${resp.status}`)
      else if (n > 0) console.log(`[self-cron] verify/heal tick processed ${n} task(s)`)
    } catch (e) {
      console.warn('[self-cron] verify/heal tick failed (non-fatal):', e instanceof Error ? e.message : e)
    }
  }

  setTimeout(tick, BOOT_DELAY_MS).unref()
  setInterval(tick, INTERVAL_MS).unref()
  console.log(`[self-cron] verify/heal self-scheduler armed — ${url} every ${INTERVAL_MS / 60000} min (first tick in ${BOOT_DELAY_MS / 1000}s)`)
}
