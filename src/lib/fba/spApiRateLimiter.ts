/**
 * SP-API rate limiter (2026-07-19, task #23) — a module-singleton token bucket that meters ACTUAL
 * requests to Amazon's per-operation limit (~5 rps for patchListingsItem, per selling account).
 *
 * WHY HERE, NOT AT THE QUEUE: the high-volume live writes originate from FIVE concurrent origins that
 * all share the one seller budget — the Auto Push modal, the durable push_jobs runner, the verify cron
 * re-push, the reship crons, and the reactive self-heal loops. Serializing only the push queue cannot
 * hold 5 rps because the crons/heal fire outside it. Those five all funnel through the three patch
 * primitives (patchSku / patchSkuDetail / patchSkuMulti), so gating THERE covers them from one choke
 * point. NOTE: two low-frequency ADMIN routes (fix-capacity, relink) define their OWN local patch and
 * are intentionally NOT metered here — route them through this bucket too if they ever run hot. It also
 * fixes a latent 2× burst: each SKU issues a VALIDATION_PREVIEW then a LIVE patch =
 * 2 patchListingsItem calls, but the old fixed 200ms/SKU sleep covered only ONE gap — so even a lone
 * push bursts toward ~10 rps under low latency. Acquiring one token per PRIMITIVE call meters the real
 * request rate regardless of latency or concurrency.
 *
 * SINGLE-PROCESS ASSUMPTION: a module singleton is the global limiter ONLY because Coolify runs ONE
 * node process (the same assumption the push_jobs promise chain and _cancelledPushes already rely on).
 * If the app is ever horizontally scaled, each instance would get its own bucket → N×5 rps → 429s; this
 * MUST move to a distributed limiter (Redis / a Postgres rate table) before any replica bump.
 */

class TokenBucket {
  private tokens: number
  private lastRefill: number
  constructor(private readonly ratePerSec: number, private readonly burst: number) {
    this.tokens = burst
    this.lastRefill = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    // Clock-backward guard: Date.now() can step BACK (NTP correction, VM suspend/resume on Coolify).
    // Without this, lastRefill would hold a future timestamp and refill would no-op until wall time
    // caught up — stalling EVERY live write (incl. the flag-independent verify/heal crons) for the size
    // of the step. Re-anchor to now so accrual resumes immediately.
    if (now < this.lastRefill) this.lastRefill = now
    const elapsed = (now - this.lastRefill) / 1000
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec)
      this.lastRefill = now
    }
  }

  /** Resolve as soon as a token is available. Sync token math runs on the single JS thread, so no
   *  two acquirers can double-spend; concurrent callers simply wait their turn (rate order, not
   *  strict FIFO — fine for a rate ceiling). */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill()
      if (this.tokens >= 1) { this.tokens -= 1; return }
      const deficitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000)
      await new Promise((r) => setTimeout(r, Math.max(15, deficitMs)))
    }
  }
}

/** patchListingsItem (all live writes: single field, bulk details, bulk core, heal, verify re-push). */
export const spApiWriteBucket = new TokenBucket(5, 5)
