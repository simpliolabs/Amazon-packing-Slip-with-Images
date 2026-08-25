/**
 * parentTitleValidateRetry.test.ts — PO-approved fix (2026-08-25).
 *
 * Stored research (2026-08-24) named the asymmetry behind three live title failures and two
 * production reverts: only the single-design/child path (runTitleAgent, listingPipeline.ts:3867)
 * has a SECOND judge layered on top of the council — `validateTitle`, in a correct-and-recheck
 * loop — that CAN reject and retry. The multi-design/broadcast PARENT producer
 * (`buildNicheParentTitle`, :7345) called `validateTitle` zero times; its only retry
 * (`humanizeTitleTo75`) is a length maximizer, not a correctness gate.
 *
 * This file proves the fix behaviorally: `buildNicheParentTitle` now runs the SAME `validateTitle`
 * (reused, never re-implemented) in a bounded reject-and-retry loop mirroring runTitleAgent's own
 * (:4214-4239) — same validator, same 2-attempt bound, same strict-improvement adoption rule.
 *
 * WHY buildNicheParentTitle IS EXPORTED (2026-08-25, minimal, one word, no other behavior changed):
 * an OpenAI-mocked end-to-end run through the full pipeline would need to satisfy the 3-persona
 * council + adversary + judge + humanizer call graph with an order-independent stub to reach this
 * one function's new logic — the SAME complexity note councilGarmentTruth.test.ts made about
 * runTitleAgent/buildNicheParentTitle before deciding a source-pin sufficed for wiring claims. Wiring
 * is not what's being proven here; BEHAVIOR is (a problem is corrected, re-validated, and the loop
 * terminates without shipping empty) — a source pin cannot prove any of that, so this exports the
 * producer and drives it directly with a compact, content-aware OpenAI stub instead.
 *
 * CI TRAP (build.yml "Test (blocking)" step sets placeholder Supabase env vars, which turn this
 * repo's lazy-Proxy Supabase clients into REAL ~4s network attempts instead of a synchronous
 * fail-open throw — see gatePerChildMultiDesign.integration.test.ts's root-cause note). This
 * function makes no Supabase call, but the env vars are neutralized here anyway, matching the
 * brief's explicit instruction and this repo's established per-file hygiene pattern.
 *
 * TITLE_V4=on for the whole file: buildNicheParentTitle's OWN humanizeTitleTo75 call has an
 * unrelated length-extension retry gated on `!v4Applies()` (listingPipeline.ts:7236) — orthogonal to
 * this fix, but it fires more OpenAI calls whenever a title lands under 68 chars, and both of this
 * file's fixtures do by design (kept short so a single missing-brand problem is the ONLY validateTitle
 * violation). TITLE_V4=on is also the flag state the brief's own truthBandHarness verification run
 * uses, so this matches production intent, not just test convenience.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type OpenAI from 'openai'
import { buildNicheParentTitle, validateTitle } from './listingPipeline'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of SUPABASE_ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key] }
  savedEnv.TITLE_V4 = process.env.TITLE_V4
  process.env.TITLE_V4 = 'on'
})
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (savedEnv.TITLE_V4 === undefined) delete process.env.TITLE_V4
  else process.env.TITLE_V4 = savedEnv.TITLE_V4
})

const BRAND = 'THE CEO'
/** The fix-loop's distinctive system-prompt marker (listingPipeline.ts, the new block right after
 *  `let title = (judged || '').trim()` in buildNicheParentTitle) — the ONLY call site in this
 *  function's whole call graph whose system message contains this exact phrase, so the stub can
 *  route it deterministically without depending on OpenAI call ORDER (the council alone issues 5
 *  calls — 3 parallel proposers + adversary + judge — via Promise.all, so order is not guaranteed). */
const FIX_MARKER = 'Amazon SEO title editor'

/** Content-aware stub: every council call (persona/adversary/judge, all plain-text, none JSON-mode)
 *  gets `councilTitle` back; every fix-loop call gets the next entry from `fixReplies` (or
 *  `councilTitle` again if the list is exhausted, i.e. "no correction offered"). Tracks fix-loop
 *  calls separately so the bounded-retry assertions don't depend on the council's own call count. */
function makeStub(councilTitle: string, fixReplies: string[] = []) {
  let fixCalls = 0
  const create = vi.fn(async (req: { messages?: { content?: string }[] }) => {
    const sys = req?.messages?.[0]?.content ?? ''
    if (sys.includes(FIX_MARKER)) {
      const reply = fixCalls < fixReplies.length ? fixReplies[fixCalls] : councilTitle
      fixCalls++
      return { choices: [{ message: { content: reply } }] }
    }
    return { choices: [{ message: { content: councilTitle } }] }
  })
  const openai = { chat: { completions: { create } } } as unknown as OpenAI
  return { openai, create, fixCallCount: () => fixCalls }
}

/** Fixed positional args every call shares: empty family-niche / no blank-brand / no upgrade pool so
 *  every deterministic backstop downstream of the new loop (family-niche anchor, blank-brand dedup,
 *  the 73-char FILL pass) is a documented no-op — isolating the assertions to what the reject-and-
 *  retry loop itself (and the loop-independent brand-dedup/title-case backstops, which are pre-
 *  existing and unrelated to this fix) does to the title. */
async function callParent(openai: OpenAI, mustInclude?: string) {
  return buildNicheParentTitle(
    openai, BRAND, [], '', undefined, 'Men and Women', null, [], [],
    undefined, null, null, null, null, undefined, null, mustInclude,
  )
}

describe('buildNicheParentTitle — reject-and-retry via validateTitle (PR path-parity with runTitleAgent)', () => {
  it('(iv) a clean title is byte-unchanged: zero fix-loop calls, zero problems, retried=false', async () => {
    // No audience tail by design: runTitleCouncilV3's OWN pre-existing "Rule 1" terminal net
    // (listingPipeline.ts, unconditional, unrelated to this fix) strips an INCLUSIVE "for Men and
    // Women" tail from ANY council output before this producer's loop ever sees it — a real title
    // containing that phrase would legitimately be rewritten by pre-existing code, which would make
    // a byte-identity assertion prove the wrong thing. Omitting the tail keeps this test's assertion
    // scoped to what THIS fix changes.
    const clean = 'THE CEO Funny Fishing Graphic Novelty Design Tee Shirt'
    expect(clean.length).toBeGreaterThanOrEqual(50)
    expect(clean.length).toBeLessThanOrEqual(75)
    expect(validateTitle(clean, BRAND, undefined, undefined, [], undefined, [])).toEqual([])

    const { openai, create, fixCallCount } = makeStub(clean)
    const result = await callParent(openai)

    expect(result.title).toBe(clean)
    expect(result.title.length).toBe(54)
    expect(result.problems).toEqual([])
    expect(result.retried).toBe(false)
    expect(fixCallCount()).toBe(0)
    // Every call the stub saw was a council call (persona/adversary/judge) — none hit the fix marker.
    for (const [req] of create.mock.calls) expect((req.messages?.[0]?.content ?? '')).not.toContain(FIX_MARKER)
  })

  it('(i)+(ii) a title missing the brand is CORRECTED (not shipped) and the correction is re-validated', async () => {
    const badNoBrand = 'Funny Fishing Graphic Novelty Design Print Tee Shirt'
    const corrected = `${BRAND} ${badNoBrand}`
    expect(badNoBrand.length).toBe(52)
    expect(corrected.length).toBe(60)
    // Oracle: confirm the fixture's ONLY validateTitle violation is the missing brand, and that
    // prepending the brand clears it — so the test's premise matches the real validator, not a
    // hand-simulated guess of what it checks.
    const badProblems = validateTitle(badNoBrand, BRAND, undefined, undefined, [], undefined, [])
    expect(badProblems.length).toBe(1)
    expect(badProblems[0]).toMatch(/must start with the brand/)
    expect(validateTitle(corrected, BRAND, undefined, undefined, [], undefined, [])).toEqual([])

    const { openai, fixCallCount } = makeStub(badNoBrand, [corrected])
    const result = await callParent(openai)

    // CORRECTED, NOT SHIPPED: the bad council draft never reaches the caller.
    expect(result.title).not.toBe(badNoBrand)
    expect(result.title).toBe(corrected)
    expect(result.title.length).toBe(60)
    expect(result.title.startsWith(BRAND)).toBe(true)
    // RE-VALIDATED: problems reflects the CORRECTED title's (zero) violations, not the original's.
    expect(result.problems).toEqual([])
    expect(result.retried).toBe(true)
    // Adopted on the FIRST attempt (strict improvement: 1 problem -> 0), so the loop exits before a
    // second corrective call — same "stop retrying once clean" behavior as runTitleAgent's loop.
    expect(fixCallCount()).toBe(1)
  })

  it('(iii) the loop is bounded and never ships empty when the correction never improves', async () => {
    const badNoBrand = 'Funny Fishing Graphic Novelty Design Print Tee Shirt'
    // The fix-loop's own reply is the SAME uncorrected text both times — never a strict improvement
    // (cp.length === problems.length, not <), so runTitleAgent's own "adopt only on strict
    // improvement" rule (mirrored here) never adopts it.
    const { openai, fixCallCount } = makeStub(badNoBrand, [badNoBrand, badNoBrand])
    const result = await callParent(openai)

    // BOUNDED: exactly 2 corrective calls (runTitleAgent's own bound), never more.
    expect(fixCallCount()).toBe(2)
    // NEVER EMPTY: the best-so-far (the original council draft) ships rather than a blank string.
    expect(result.title).toBe(badNoBrand)
    expect(result.title.length).toBe(52)
    expect(result.title.length).toBeGreaterThan(0)
    // Unresolved problems SURFACE (this is what the caller now threads into debug.titleProblems,
    // where previously this branch stayed permanently empty/false for every multi-design regen).
    expect(result.retried).toBe(true)
    expect(result.problems.length).toBeGreaterThan(0)
    expect(result.problems.some((p) => /must start with the brand/.test(p))).toBe(true)
  })

  it('mustInclude (the family-level mandated keyword, threaded from the orchestrator) is enforced the same way runTitleAgent enforces its own', async () => {
    // Distinct vocabulary from the money phrase (no shared words) so the pre-existing NON-ADJACENT
    // TOKEN dedup backstop inside buildNicheParentTitle (unrelated to this fix — it collapses a
    // SECOND occurrence of any repeated significant word) has nothing to collapse and can't be
    // mistaken for this test's own assertion.
    const missingMoney = 'THE CEO Graphic Novelty Design Print Casual Tee Shirt'
    const withMoney = 'THE CEO Bass Fishing Gift Graphic Novelty Design Print Casual Tee Shirt'
    const money = 'bass fishing gift'
    expect(missingMoney.length).toBe(53)
    expect(withMoney.length).toBe(71)
    expect(validateTitle(missingMoney, BRAND, money, undefined, [], undefined, []).some((p) => p.includes('MUST contain the highest-volume keyword'))).toBe(true)
    expect(validateTitle(withMoney, BRAND, money, undefined, [], undefined, [])).toEqual([])

    const { openai, fixCallCount } = makeStub(missingMoney, [withMoney])
    const result = await callParent(openai, money)

    expect(result.title).toBe(withMoney)
    expect(result.title.length).toBe(71)
    expect(result.problems).toEqual([])
    expect(result.retried).toBe(true)
    expect(fixCallCount()).toBe(1)
  })
})
