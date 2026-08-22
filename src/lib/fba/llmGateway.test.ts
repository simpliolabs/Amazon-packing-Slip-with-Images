/**
 * llmGateway.getLlmClientForRequest() — cost-guard pass (2026-08-22, PO "$50 of OpenAI in 2 days").
 *
 * The three highest-traffic OpenAI call sites (ai-recommendations, rank-analysis, scan-identity)
 * used to hand-roll `new OpenAI({...})`, which inherits the SDK's default maxRetries: 2
 * (node_modules/openai/client.js:159). Because insufficient_quota arrives as HTTP 429, a
 * quota-exhausted account silently retried EVERY logical call up to 3x — the exact hazard
 * llmGateway.ts's `maxRetries: 0` policy exists to stop (see its module header). This asserts
 * getLlmClientForRequest() carries that policy while still resolving the seller's DB-stored key
 * (PR #82's resolveOpenAIKey — the one thing getLlmClient() did NOT already carry) and applying
 * the same instrumentAiHealth wrapper the pre-migration call sites relied on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import OpenAI from 'openai'

vi.mock('@/lib/openai/credentials', () => ({
  resolveOpenAIKey: vi.fn(),
}))

import { resolveOpenAIKey } from '@/lib/openai/credentials'
import { getLlmClientForRequest } from './llmGateway'

const mockResolveKey = vi.mocked(resolveOpenAIKey)

describe('getLlmClientForRequest', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    mockResolveKey.mockReset()
    mockResolveKey.mockResolvedValue('sk-test-key')
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('constructs a client with maxRetries: 0 — the SDK default (2) would silently retry a 429 insufficient_quota up to 3x', async () => {
    const client = await getLlmClientForRequest()
    expect(client.maxRetries).toBe(0)
  })

  it('resolves the seller key via resolveOpenAIKey() (DB-stored, Settings-UI), not process.env.OPENAI_API_KEY directly', async () => {
    mockResolveKey.mockResolvedValue('sk-db-stored-key')
    const client = await getLlmClientForRequest()
    expect(mockResolveKey).toHaveBeenCalled()
    expect(client.apiKey).toBe('sk-db-stored-key')
  })

  it('honors OPENAI_BASE_URL when set, defaults to api.openai.com otherwise', async () => {
    delete process.env.OPENAI_BASE_URL
    const defaultClient = await getLlmClientForRequest()
    expect(defaultClient.baseURL).toBe('https://api.openai.com/v1')

    process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1'
    const proxied = await getLlmClientForRequest()
    expect(proxied.baseURL).toBe('https://proxy.example.com/v1')
  })

  it('honors an explicit timeoutMs', async () => {
    const client = await getLlmClientForRequest({ timeoutMs: 15_000 })
    expect(client.timeout).toBe(15_000)
  })

  it('mints a FRESH client on every call — never memoized (unlike getLlmClient()'
    + ' — a shared client would leak instrumentAiHealth\'s sticky __aiHardError flag across unrelated requests)', async () => {
    const a = await getLlmClientForRequest()
    const b = await getLlmClientForRequest()
    expect(a).not.toBe(b)
  })

  it('applies instrumentAiHealth — chat.completions.create is wrapped, not the raw SDK method', async () => {
    const client = await getLlmClientForRequest()
    const raw = new OpenAI({ apiKey: 'sk-raw-unwrapped', maxRetries: 0 })
    expect(client.chat.completions.create).not.toBe(raw.chat.completions.create)
  })
})
