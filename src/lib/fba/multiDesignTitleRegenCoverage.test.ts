/**
 * multiDesignTitleRegenCoverage.test.ts — `.superpowers/sdd/2026-09-24-cross-design-leak/
 * phase-x1-rulings.md`, RULING X5 (the coverage that hid the crash).
 *
 * The abandoned branch (`fix/cross-design-leak`) shipped a `ReferenceError: Cannot access
 * 'vocabNameFor' before initialization` on `onlySection:'title'` for a multi-design family
 * (`listingPipeline.ts`, phase-w1-review-runbook.md Blocking 1) — introduced by round V/`cf33ea9`
 * moving that `const`'s declaration below the title partial's own return, and never on `main`. The
 * whole suite there stayed green throughout because NO committed test drove a title-only regen on
 * a multi-design family — `grep -rn "onlySection: ?'title'"` under `src` (excluding this file)
 * turns up only the route, never a pipeline test. This file is that missing coverage: it does not
 * assert the abandoned branch's specific bug is absent (that identifier does not exist on `main`),
 * it asserts the SHAPE of coverage the review said was missing — a real `onlySection:'title'` run,
 * on a real multi-design family, through the real pipeline, must return titles rather than throw —
 * so a FUTURE regression of the same shape (a `const` used above its own declaration on this one
 * code path) fails HERE instead of silently in production after the title councils are paid for.
 */
import { describe, it, expect, vi } from 'vitest'
import { runListingPipeline, type PipelineInput } from '@/lib/fba/listingPipeline'

const NAMES = [
  { key: 'BB', name: 'Business B*tch' }, { key: 'HDG', name: 'Hustle Definiton' },
  { key: 'MHG', name: 'Mother Hustler' }, { key: 'BCSG', name: 'Billionare Coming Soon' },
  { key: 'DQG', name: "Don't Quit" }, { key: 'GMG', name: 'Grind Mode' },
] as const
const LIVE: Record<string, string> = Object.fromEntries(NAMES.map((n) => [n.key, `THE CEO ${n.name} Sweatshirt | Long Sleeve for Men`]))
const children: PipelineInput['children'] = NAMES.flatMap(({ key }, i) => [
  { sku: `${key}-M`, asin: `B0${key}00000${i}1`, color: 'Black', size: 'M', title: LIVE[key] },
  { sku: `${key}-L`, asin: `B0${key}00000${i}2`, color: 'Black', size: 'L', title: LIVE[key] },
])
const priorPerChildTitles = NAMES.flatMap(({ key, name }, i) => [
  { sku: `${key}-M`, asin: `B0${key}00000${i}1`, title: LIVE[key], designName: name, designKey: key },
  { sku: `${key}-L`, asin: `B0${key}00000${i}2`, title: LIVE[key], designName: name, designKey: key },
])

const stubOpenAI = () => ({
  chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
    const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
    if (/"designName"/.test(user)) {
      let hit = ''; let best = Infinity
      for (const { name } of NAMES) { const i = user.indexOf(name); if (i >= 0 && i < best) { best = i; hit = name } }
      return { choices: [{ message: { content: JSON.stringify({ designName: hit }) }, finish_reason: 'stop' }] }
    }
    const title = 'THE CEO Graphic Sweatshirt | Motivational Long Sleeve Crewneck for Men'
    return { choices: [{ message: { content: JSON.stringify({ title, bullets: [], description: '', backend_drop: [], drop: [] }) }, finish_reason: 'stop' }] }
  }) } },
}) as unknown as PipelineInput['openai']

describe('X5 — onlySection:"title" on a multi-design family must return titles, never throw', () => {
  it('runs the real pipeline end to end and returns a titled per-child row for every design', async () => {
    const saved: Record<string, string | undefined> = {}
    for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']) { saved[k] = process.env[k]; delete process.env[k] }
    try {
      const input: PipelineInput = {
        openai: stubOpenAI(), brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
        analysis: [], children, repTitle: children[0].title!, canonicalTitle: LIVE.BB,
        priorTitle: 'THE CEO Motivational Entrepreneur Sweatshirt | Long Sleeve for Men',
        variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false, auditModel: 'o4-mini',
        onProgress: () => {}, priorPerChildTitles, onlySection: 'title',
      }
      // The bug this test guards against is a thrown ReferenceError reaching the caller — a bare
      // `await` (not `expect(...).rejects`) is the correct shape: any throw fails this test.
      const r = await runListingPipeline(input)
      const byKey = new Map((r.per_child_titles ?? []).map((c) => [c.designKey, c]))
      for (const { key } of NAMES) {
        const row = byKey.get(key)
        expect(row, `no per_child_titles row for ${key}`).toBeTruthy()
        expect((row?.title ?? '').length, `${key}'s title is empty`).toBeGreaterThan(0)
      }
      expect(typeof r.recommended_title).toBe('string')
    } finally {
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    }
  }, 120_000)
})
