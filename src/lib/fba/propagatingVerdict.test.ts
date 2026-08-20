/**
 * THE AMBER PROPAGATING VERDICT (task #175) — a mismatch explained by an accepted push is never a RED.
 *
 * PO 2026-08-20, verbatim pain: "Each time I sent a section and something fail, a different
 * shippable item goes RED, this is very confusing." Amazon's Catalog read-back lags an accepted
 * push by 15min-6hr, so the ship-truth compare flips to a FALSE mismatch right after every Ship.
 * The deriver now answers with a third verdict: PROPAGATING (amber) — shown only when the push is
 * NEWER than the recommendation (else a red mismatch correctly means "new rec not shipped") and
 * within the 6-hour propagation window (else a mismatch is a genuine problem again).
 */
import { describe, it, expect } from 'vitest'
import { deriveActionPlan, type DeriveContentRow } from './pushFields'

const NOW = Date.now()
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const H = 3600 * 1000

const rec = {
  recommended_title: 'THE CEO Dont Quit Tee Shirt | Bold Motivational Shirt',
  recommended_bullets: ['B1 fresh bullet', 'B2 fresh bullet', 'B3', 'B4', 'B5'],
  recommended_description: '<p>Fresh description.</p>',
  per_child_titles: [],
  per_child_bullets: null,
  per_child_descriptions: null,
  recommended_keywords: '[]',
  action_plan: [],
} as never

const liveRows: DeriveContentRow[] = [{
  sku: 'SKU-1', asin: 'B000000001',
  title: 'OLD stale live title', bullet_1: 'OLD b1', bullet_2: 'OLD b2', bullet_3: 'OLD b3',
  bullet_4: 'OLD b4', bullet_5: 'OLD b5', description: '<p>OLD description.</p>', backend_keywords: '',
} as DeriveContentRow]

const itemFor = (plan: { element?: string; verdict?: string; current_status?: string }[], el: string) =>
  plan.find((i) => i.element === el)

describe('PROPAGATING — mismatch explained by a recent accepted push', () => {
  it('turns AMBER when the push is newer than the rec and inside the 6h window', () => {
    const plan = deriveActionPlan(rec, liveRows, {
      pushedAt: { title: iso(30 * 60 * 1000) },          // pushed 30m ago
      generatedAt: iso(2 * H),                            // rec generated 2h ago
    }) as { element?: string; verdict?: string; current_status?: string }[]
    const t = itemFor(plan, 'title')
    expect(t?.verdict).toBe('PROPAGATING')
    expect(t?.current_status).toMatch(/propagating/i)
    expect(t?.current_status).toMatch(/not a failure/i)
  })

  it('stays RED when the rec is NEWER than the push — a regen after shipping means "ship the new rec"', () => {
    const plan = deriveActionPlan(rec, liveRows, {
      pushedAt: { title: iso(2 * H) },                    // pushed 2h ago
      generatedAt: iso(30 * 60 * 1000),                   // rec regenerated 30m ago (newer)
    }) as { element?: string; verdict?: string }[]
    expect(itemFor(plan, 'title')?.verdict).toBe('REPLACE')
  })

  it('stays RED when the push is OUTSIDE the 6h window — a lasting mismatch is a real problem again', () => {
    const plan = deriveActionPlan(rec, liveRows, {
      pushedAt: { title: iso(7 * H) },
      generatedAt: iso(20 * H),
    }) as { element?: string; verdict?: string }[]
    expect(itemFor(plan, 'title')?.verdict).toBe('REPLACE')
  })

  it('a MATCHING field stays DONE even with a recent push — match always wins', () => {
    const matchedRows = [{ ...liveRows[0], title: 'THE CEO Dont Quit Tee Shirt | Bold Motivational Shirt' }] as DeriveContentRow[]
    const plan = deriveActionPlan(rec, matchedRows, {
      pushedAt: { title: iso(10 * 60 * 1000) },
      generatedAt: iso(2 * H),
    }) as { element?: string; verdict?: string }[]
    expect(itemFor(plan, 'title')?.verdict).toBe('DONE')
  })

  it('bullet elements map to the "bullets" push-log field', () => {
    const plan = deriveActionPlan(rec, liveRows, {
      pushedAt: { bullets: iso(10 * 60 * 1000) },
      generatedAt: iso(2 * H),
    }) as { element?: string; verdict?: string }[]
    expect(itemFor(plan, 'bullet_1')?.verdict).toBe('PROPAGATING')
    expect(itemFor(plan, 'title')?.verdict).toBe('REPLACE')   // title had no push — stays honest RED
  })

  it('without shipSignals the deriver is byte-identical to the old behavior (persist paths)', () => {
    const plan = deriveActionPlan(rec, liveRows) as { element?: string; verdict?: string }[]
    expect(itemFor(plan, 'title')?.verdict).toBe('REPLACE')
    expect(itemFor(plan, 'bullet_1')?.verdict).toBe('REPLACE')
  })
})
