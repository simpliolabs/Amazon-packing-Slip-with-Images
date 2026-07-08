import type OpenAI from 'openai'

/**
 * AI-failure classification (2026-07-08, PO: "why doesn't the system let me know credit is exhausted?").
 *
 * ROOT CAUSE this fixes: every council call is `catch { return '' }` — the Error object carrying
 * `.status === 429` / `.code === 'insufficient_quota'` is discarded at the lowest layer, so a hard
 * quota outage becomes "empty output" that persists as a successful audit. On 2026-07-08 that wiped
 * B0FRYMM56C's approved bullets/description/keywords while reporting success.
 *
 * The fix does NOT rewrite the ~28 fail-open catch sites (their fail-open behavior is deliberate for
 * transient blips). Instead the CLIENT is instrumented: a hard error is recorded on the client object
 * before the call rethrows into the existing catches, so the identity survives to the stream boundary
 * where it can be surfaced ("AI credit exhausted — check billing") and written to ai_health.
 */
export type AiErrorKind = 'quota' | 'auth' | 'transient'

/** Classify an OpenAI SDK error. SDK v6 sets top-level .status/.code/.type from the response body's
 *  nested error, but the nested shape is also checked for safety across SDK versions. */
export function classifyOpenAIError(err: unknown): AiErrorKind {
  const e = err as { status?: number; code?: string; type?: string; error?: { code?: string; type?: string } }
  const status = e?.status
  const code = (e?.code ?? e?.error?.code ?? '').toString()
  const type = (e?.type ?? e?.error?.type ?? '').toString()
  if (status === 401 || code === 'invalid_api_key') return 'auth'
  // Terminated/deactivated accounts 403 — hard, needs the operator, same handling as a bad key.
  if (status === 403 && (code.includes('terminated') || code.includes('deactivated'))) return 'auth'
  // Any billing-stop shape (insufficient_quota, billing_hard_limit_reached, …) — a plain
  // rate_limit_exceeded 429 stays transient (retryable), a quota/billing 429 is hard.
  if (status === 429 && (code.includes('quota') || type.includes('quota') || code.includes('billing') || type.includes('billing'))) return 'quota'
  return 'transient' // 429 rate-limit-retryable, 408, 5xx, connection timeouts
}

export const isHardAiError = (k: AiErrorKind): boolean => k === 'quota' || k === 'auth'

/** An OpenAI client that remembers the first HARD (quota/auth) error any call hit. */
export type HealthTrackedOpenAI = OpenAI & { __aiHardError?: AiErrorKind }

/**
 * Wrap chat.completions.create so a HARD error is recorded on the client, then RETHROWN — the
 * existing `catch { return '' }` sites still run unchanged, but the identity survives on
 * `client.__aiHardError` for the post-hoc degradation gate + the stream catch to read.
 * MUST be applied to a per-request client (getOpenAI mints one per POST) — the flag is sticky
 * for the client's lifetime, which is exactly one request.
 * NOTE: the wrapper returns a plain Promise — the SDK's APIPromise chaining (.withResponse() /
 * .asResponse()) is NOT supported on an instrumented client (no call site uses it today).
 */
export function instrumentAiHealth(client: OpenAI): HealthTrackedOpenAI {
  const c = client as HealthTrackedOpenAI
  const orig = c.chat.completions.create.bind(c.chat.completions)
  ;(c.chat.completions as unknown as { create: unknown }).create = async (...args: unknown[]) => {
    try {
      return await (orig as (...a: unknown[]) => Promise<unknown>)(...args)
    } catch (err) {
      const kind = classifyOpenAIError(err)
      if (isHardAiError(kind) && !c.__aiHardError) c.__aiHardError = kind
      throw err
    }
  }
  return c
}

/** Read the recorded hard-error kind off a (possibly uninstrumented) client. */
export function getAiHardError(client: unknown): AiErrorKind | undefined {
  return (client as { __aiHardError?: AiErrorKind })?.__aiHardError
}
