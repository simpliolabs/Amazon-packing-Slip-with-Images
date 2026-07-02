/**
 * Detail write-form CALIBRATION loop — transport-aware (adversarial review fix 1, 2026-07-02).
 * ─────────────────────────────────────────────────────────────────────────────
 * patchSkuDetail/patchSkuMulti return ok:false for ANY non-2xx, so a 429/5xx burst during
 * calibration used to read as "variant rejected" and ADVANCE the probe. Since the variant
 * list now spans DIFFERENT sub-fields (SHIRT sleeve: honored `type` before derived
 * `length_description`), a throttle burst on the first sub-field's variants could walk the
 * calibration into the derived sub-field — where Amazon still accepts-then-drops — and the
 * WRONG sub-field would win and be cached process-lifetime.
 *
 * Policy (single-field push AND bulk Auto Push share THIS loop — no drift):
 *   - probe ok            -> that variant wins.
 *   - validation rejection -> recorded, ADVANCE to the next variant (real evidence against it).
 *   - transport failure (HTTP 429/5xx, or the fetch threw) -> retry the SAME variant up to
 *     `retries` times with 1s/2s backoff; still failing -> ABORT the calibration for this
 *     attribute (transportAbort) WITHOUT advancing — transport says nothing about the variant,
 *     so advancing past it risks crowning a different sub-field's variant.
 */

/** The subset of PatchResult the calibration loop needs (kept structural so this module has
 *  zero imports and stays unit-testable outside Next). */
export interface ProbeResultLike { ok: boolean; error?: string }

/** Transport-shaped probe failures: throttle (429) + server errors (5xx). Every other non-2xx
 *  (400 invalid input etc.) and every parsed issues[] rejection stays a VALIDATION failure. */
export const TRANSPORT_PROBE_RE = /^HTTP (429|5\d\d)\b/

export interface CalibrationVariant { id: string; value: Record<string, unknown>[] }

export interface CalibrationResult {
  /** The winning variant id, or null (all rejected, or transport-aborted). */
  winId: string | null
  /** True = a variant transport-failed after retries; the loop stopped THERE (no advance).
   *  The caller must fail/skip this attribute loudly — not fall back to other sub-fields. */
  transportAbort: boolean
  /** One entry per failed probe: "<variantId>: <error>" (the caller surfaces these). */
  errors: string[]
}

export interface CalibrationOpts {
  /** Called before each variant's (first) probe — the streaming 'validating' progress event. */
  onProbe?: (v: CalibrationVariant) => void
  /** Pause between VARIANTS after a validation rejection (the existing PATCH_DELAY_MS pacing). */
  interProbeDelayMs?: number
  /** Transport retries per variant (default 2 -> up to 3 attempts per variant). */
  retries?: number
  /** Injectable for tests; default real setTimeout sleep. */
  sleepFn?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** One variant's probe with transport retries. Backoff: 1s before attempt 2, 2s before attempt 3. */
async function probeWithTransportRetry(
  probeOnce: () => Promise<ProbeResultLike>,
  retries: number,
  sleepFn: (ms: number) => Promise<void>,
): Promise<{ outcome: 'ok' | 'validation' | 'transport'; error: string }> {
  let lastTransportErr = 'transport failure'
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleepFn(1000 * attempt)
    let res: ProbeResultLike
    try {
      res = await probeOnce()
    } catch (e) {
      lastTransportErr = `transport: ${e instanceof Error ? e.message : String(e)}`
      continue // thrown fetch = transport — retry the SAME variant
    }
    if (res.ok) return { outcome: 'ok', error: '' }
    const err = res.error ?? 'rejected'
    if (TRANSPORT_PROBE_RE.test(err)) { lastTransportErr = err; continue } // 429/5xx — retry SAME variant
    return { outcome: 'validation', error: err }
  }
  return { outcome: 'transport', error: `${lastTransportErr} (still failing after transport retries)` }
}

/** Probe the variants IN ORDER against Amazon's validator (see module doc for the policy). */
export async function calibrateVariants(
  variants: CalibrationVariant[],
  probeVariant: (v: CalibrationVariant) => Promise<ProbeResultLike>,
  opts?: CalibrationOpts,
): Promise<CalibrationResult> {
  const retries = opts?.retries ?? 2
  const sleepFn = opts?.sleepFn ?? realSleep
  const errors: string[] = []
  for (const v of variants) {
    opts?.onProbe?.(v)
    const probe = await probeWithTransportRetry(() => probeVariant(v), retries, sleepFn)
    if (probe.outcome === 'ok') return { winId: v.id, transportAbort: false, errors }
    errors.push(`${v.id}: ${probe.error}`)
    if (probe.outcome === 'transport') return { winId: null, transportAbort: true, errors }
    if (opts?.interProbeDelayMs) await sleepFn(opts.interProbeDelayMs)
  }
  return { winId: null, transportAbort: false, errors }
}
