/**
 * LLM GATEWAY (PO GO 2026-08-07 — Option A of the gateway brief).
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE place that constructs LLM clients for the whole portal. Before this module the
 * codebase had 13 hand-rolled `new OpenAI(...)` constructions across 9 files, of which
 * only 3 honored OPENAI_BASE_URL and only some carried the ai-health instrumentation —
 * so provider routing, outage classification, and retry policy all diverged per call
 * site. The gateway owns:
 *   1. ONE client factory — honors OPENAI_BASE_URL everywhere, applies instrumentAiHealth
 *      (the #43 outage classifier) uniformly, memoizes per (baseURL, timeout).
 *   2. ONE retry policy — `maxRetries: 0` is LOAD-BEARING: the SDK's internal retries
 *      stack on Cloudflare's ~100s edge timeout and turn one slow call into a multi-
 *      minute hang (learned live; never re-enable without re-testing behind Cloudflare).
 *   3. ONE model map — replaces the ×7 copy-pasted `isGpt5` regexes (migrated in PR-2).
 * Migration is MECHANICAL: call sites swap `new OpenAI({...})` for `getLlmClient()`;
 * no prompt or behavior changes. Multi-provider routing is deliberately OUT of scope
 * (this module is the seam that makes it a later one-line change).
 *
 * PR-3 (2026-08-22, cost-guard pass): `getLlmClient()` reads OPENAI_API_KEY from the env
 * only — it did NOT carry PR #82's `resolveOpenAIKey()` (DB-stored Settings-UI key, env
 * fallback), which the three highest-traffic route call sites (ai-recommendations,
 * rank-analysis, scan-identity) depend on. Added `getLlmClientForRequest()` below rather
 * than making `getLlmClient()` itself async (that would ripple into its two existing
 * synchronous callers, detectColor.ts and titleRefereeLlm.ts, for no reason). Deliberately
 * NOT memoized like `getLlmClient()`'s cache: instrumentAiHealth's `__aiHardError` flag is
 * sticky for the client's whole lifetime (see errorClass.ts), and ai-recommendations reads
 * it per-request to report "AI credit exhausted" — a cached/shared client would leak that
 * flag across unrelated requests once any one of them hit a hard error.
 */
import OpenAI from 'openai'
import { instrumentAiHealth, type HealthTrackedOpenAI } from '@/lib/openai/errorClass'
import { resolveOpenAIKey } from '@/lib/openai/credentials'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

const cache = new Map<string, HealthTrackedOpenAI>()

/** The one client factory. `timeoutMs` optional — omit for the SDK default (long-running
 *  council calls); pass a short budget for latency-sensitive helpers (e.g. detectColor's
 *  15s). Returns null when OPENAI_API_KEY is unset so callers keep their existing
 *  fail-open behavior (warn + skip) instead of throwing at construction time. */
export function getLlmClient(opts?: { timeoutMs?: number }): HealthTrackedOpenAI | null {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null
  const baseURL = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL
  const key = `${baseURL}|${opts?.timeoutMs ?? 'default'}`
  const hit = cache.get(key)
  if (hit) return hit
  const client = instrumentAiHealth(new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0,   // LOAD-BEARING — see module header (Cloudflare ~100s edge timeout)
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  }))
  cache.set(key, client)
  return client
}

/** Async sibling of getLlmClient() for callers that need the seller's DB-resolved key
 *  (Settings UI, PR #82's resolveOpenAIKey) instead of the raw OPENAI_API_KEY env var. Same
 *  maxRetries: 0 + instrumentAiHealth policy; mints a FRESH client every call (see PR-3 note
 *  in the module header for why this is not cached). Unlike getLlmClient(), this never
 *  returns null — it mirrors the pre-migration call sites exactly, which passed
 *  resolveOpenAIKey()'s result (including '' when unset) straight into `new OpenAI({...})`
 *  and let the SDK throw. */
export async function getLlmClientForRequest(opts?: { timeoutMs?: number }): Promise<HealthTrackedOpenAI> {
  const apiKey = await resolveOpenAIKey()
  const baseURL = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL
  return instrumentAiHealth(new OpenAI({
    apiKey,
    baseURL,
    maxRetries: 0,   // LOAD-BEARING — see module header (Cloudflare ~100s edge timeout)
    ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
  }))
}

/** ONE model-name map (PR-2 folds the seven `isGpt5` regex copies into this). A GPT-5-class
 *  model takes `max_completion_tokens` and rejects `temperature` — the two divergences the
 *  scattered regexes existed to detect. */
export function isGpt5Class(model: string): boolean {
  return /^gpt-5/i.test(model)
}
