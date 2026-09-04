import { describe, it, expect, vi } from 'vitest'
import {
  buildThemeRerateRequestBody,
  classifyThemeRerateResponse,
  runThemeRerate,
  type ThemeRerateOutcome,
} from './themeRerateControl'

// ── request shape ──────────────────────────────────────────────────────────────────────────────
describe('buildThemeRerateRequestBody', () => {
  it('sends the exact snake_case body the route requires', () => {
    const body = buildThemeRerateRequestBody('B0DSCDZC6K')
    expect(body).toEqual({ parent_asin: 'B0DSCDZC6K', per_design: true })
  })

  it('never emits a camelCase parentAsin key (route.ts destructures parent_asin only)', () => {
    const body = buildThemeRerateRequestBody('B0DSCDZC6K') as unknown as Record<string, unknown>
    expect(body.parentAsin).toBeUndefined()
    expect('parentAsin' in body).toBe(false)
    expect(Object.keys(body).sort()).toEqual(['parent_asin', 'per_design'])
  })
})

// ── response classification — one case per documented route outcome ──────────────────────────────
describe('classifyThemeRerateResponse', () => {
  it('classifies a full success (200, rated > 0) distinctly, with the report-how-many message', () => {
    const groups = [
      { designKey: 'd1', designName: 'Alligator', status: 'rated', asked: 10, rated: 9, written: 4, runId: 'r1' },
      { designKey: 'd2', designName: 'Gator', status: 'rated', asked: 10, rated: 8, written: 4, runId: 'r2' },
    ]
    const outcome = classifyThemeRerateResponse(200, { poolKey: 'B0DSCDZC6K', per_design: true, rated: 2, total: 6, groups })
    expect(outcome.kind).toBe('success')
    if (outcome.kind !== 'success') throw new Error('unreachable')
    expect(outcome.rated).toBe(2)
    expect(outcome.total).toBe(6)
    expect(outcome.poolKey).toBe('B0DSCDZC6K')
    expect(outcome.groups).toHaveLength(2)
    expect(outcome.message).toMatch(/Rated 2 of 6 design groups/)
    expect(outcome.message).toMatch(/Regen/)
  })

  it('classifies a partial success (some groups no-card/cooldown alongside rated ones) as success', () => {
    const groups = [
      { designKey: 'd1', designName: 'A', status: 'rated', asked: 5, rated: 5, written: 5, runId: 'r1' },
      { designKey: 'd2', designName: 'B', status: 'no-card', asked: 5, rated: 0, written: 0, reason: 'no-card' },
    ]
    const outcome = classifyThemeRerateResponse(200, { poolKey: 'P', per_design: true, rated: 1, total: 2, groups })
    expect(outcome.kind).toBe('success')
    if (outcome.kind !== 'success') throw new Error('unreachable')
    expect(outcome.rated).toBe(1)
    expect(outcome.total).toBe(2)
  })

  it('classifies empty (404 — no keyword_analysis rows) distinctly, naming "run research first"', () => {
    const outcome = classifyThemeRerateResponse(404, {
      error: 'No keyword_analysis rows under pool key P — nothing to re-rate (run research first)',
      poolKey: 'P', per_design: true, groups: [],
    })
    expect(outcome.kind).toBe('empty')
    if (outcome.kind !== 'empty') throw new Error('unreachable')
    expect(outcome.message).toMatch(/run research first/)
  })

  it('classifies not-multi-design (422, no noCard key, empty groups) distinctly from the no-card 422', () => {
    const outcome = classifyThemeRerateResponse(422, {
      error: 'P is not a multi-design family (fewer than 2 design groups) — use the family rating (omit per_design).',
      poolKey: 'P', per_design: true, groups: [],
    })
    expect(outcome.kind).toBe('not-multi-design')
  })

  it('classifies the all-no-card 422 refusal distinctly (noCard key present)', () => {
    const outcome = classifyThemeRerateResponse(422, {
      error: 'No per-design identity for d1, d2 — nothing to rate against. Run POST /api/fba/intelligence/scan-identity …',
      poolKey: 'P', per_design: true, rated: 0, total: 2, groups: [], noCard: ['d1', 'd2'],
    })
    expect(outcome.kind).toBe('no-card')
    if (outcome.kind !== 'no-card') throw new Error('unreachable')
    expect(outcome.noCard).toEqual(['d1', 'd2'])
  })

  it('classifies the all-cooldown 409 refusal distinctly, surfacing retryAfterMs', () => {
    const outcome = classifyThemeRerateResponse(409, {
      error: 'Every design of P was rated or armed within the last 10 minutes',
      poolKey: 'P', per_design: true, rated: 0, total: 2, groups: [], retryAfterMs: 137000,
    })
    expect(outcome.kind).toBe('cooldown')
    if (outcome.kind !== 'cooldown') throw new Error('unreachable')
    expect(outcome.retryAfterMs).toBe(137000)
    expect(outcome.message).toMatch(/rated or armed/)
  })

  it('classifies the 502 failed outcome distinctly, naming which designs failed', () => {
    const outcome = classifyThemeRerateResponse(502, {
      error: 'Per-design theme rating FAILED for d3 of P after 2 attempts each; no rows were written for them',
      poolKey: 'P', per_design: true, rated: 0, total: 3, groups: [], failed: ['d3'], noCard: [],
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.failed).toEqual(['d3'])
  })

  it('falls back to a generic error kind for an unrecognized status (e.g. 500)', () => {
    const outcome = classifyThemeRerateResponse(500, { error: 'boom' })
    expect(outcome.kind).toBe('error')
    if (outcome.kind !== 'error') throw new Error('unreachable')
    expect(outcome.message).toBe('boom')
  })
})

// ── orchestration: busy-gate + exact request wiring + response passthrough ───────────────────────
describe('runThemeRerate', () => {
  it('does NOT call fetch when already busy — proves in-flight state disables re-click', async () => {
    const fetchImpl = vi.fn()
    const result = await runThemeRerate('B0DSCDZC6K', true, { fetchImpl })
    expect(result).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('POSTs the exact snake_case body + per_design:true to the unchanged route, with headers merged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ poolKey: 'B0DSCDZC6K', per_design: true, rated: 6, total: 6, groups: [] }),
    })
    const outcome = await runThemeRerate('B0DSCDZC6K', false, { fetchImpl, headers: { Authorization: 'Bearer tok' } })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/fba/keyword-pool/rerate')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer tok' })
    // The load-bearing assertion: exact payload shape, snake_case only. A camelCase regression
    // (`parentAsin`) must fail this line, not silently 400 in production.
    expect(JSON.parse(init.body as string)).toEqual({ parent_asin: 'B0DSCDZC6K', per_design: true })

    expect(outcome).not.toBeNull()
    expect((outcome as ThemeRerateOutcome).kind).toBe('success')
  })

  it('classifies a thrown network error as kind "error" instead of throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    const outcome = await runThemeRerate('B0DSCDZC6K', false, { fetchImpl })
    expect(outcome).toEqual({ kind: 'error', message: 'network down' })
  })

  it('classifies a non-JSON response body without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 404,
      json: async () => { throw new Error('not json') },
    })
    const outcome = await runThemeRerate('B0DSCDZC6K', false, { fetchImpl })
    expect(outcome?.kind).toBe('empty')
  })
})
