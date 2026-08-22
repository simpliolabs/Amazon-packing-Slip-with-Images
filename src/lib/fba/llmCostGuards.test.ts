/**
 * llmCostGuards.test.ts — REGRESSION-CLASS tripwires for the 2026-08-22 cost-guard pass
 * (PO: "$50 of OpenAI in 2 days, not sustainable"; account hit insufficient_quota).
 * ─────────────────────────────────────────────────────────────────────────────────────
 * FIX 1 — retry amplification. Three highest-traffic call sites hand-rolled `new OpenAI({...})`,
 * which inherits the SDK's default maxRetries: 2 (node_modules/openai/client.js:159, retrying on
 * 408/409/429/5xx per client.js:525-534). Because insufficient_quota arrives as HTTP 429, a
 * quota-exhausted account silently retried EVERY logical call up to 3x — the exact hazard
 * llmGateway.ts's `maxRetries: 0` policy exists to stop. getLlmClientForRequest()'s own
 * maxRetries/key-resolution/instrumentAiHealth behavior is asserted BEHAVIORALLY in
 * llmGateway.test.ts; these three checks are SOURCE-TEXT assertions (same rationale as
 * keyword-engine/designSignalWiring.test.ts) because the regression is the ABSENCE of a call —
 * a route going back to hand-rolling `new OpenAI({...})` is not observable without a live,
 * quota-exhausted OpenAI account.
 *
 * FIX 2 — the multi-design per-child editorial audit (`gatePerChildMultiDesign`,
 * listingPipeline.ts) used to run its full per-DESIGN-GROUP `runFinalEditorialAudit` loop (up to
 * MULTI_DESIGN_AUDIT_MAX_GROUPS=8 sequential gpt-4.1 calls) on EVERY regen path it's invoked from
 * — including bullets-only/description-only section regens — so a multi-design "Regenerate
 * bullets" click paid up to 8x what the identical click pays on a single-design family (which
 * mirrors the single-design final audit's own `!input.onlySection` guard, ~listingPipeline.ts:11642).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...parts: string[]) => readFileSync(join(process.cwd(), 'src', ...parts), 'utf8')

describe('FIX 1 — the three highest-traffic OpenAI call sites use the maxRetries:0 gateway', () => {
  const sites: { label: string; parts: string[] }[] = [
    { label: 'ai-recommendations/route.ts (getOpenAI, behind EVERY call in EVERY regen)', parts: ['app', 'api', 'fba', 'listing-optimizer', 'ai-recommendations', 'route.ts'] },
    { label: 'rank-analysis/[asin]/route.ts (POST, the council analysis client)', parts: ['app', 'api', 'fba', 'rank-analysis', '[asin]', 'route.ts'] },
    { label: 'intelligence/scan-identity/route.ts (the vision-scan client)', parts: ['app', 'api', 'fba', 'intelligence', 'scan-identity', 'route.ts'] },
  ]

  for (const site of sites) {
    it(`${site.label} calls the gateway's getLlmClientForRequest(), not new OpenAI({...})`, () => {
      const src = read(...site.parts)
      // The gateway factory IS in use — all three sites import it dynamically (`await
      // import('@/lib/fba/llmGateway')`), matching the pre-migration `resolveOpenAIKey`/
      // `instrumentAiHealth` dynamic-import style at the same call sites.
      expect(src).toContain('getLlmClientForRequest')
      expect(src).toMatch(/import\(['"]@\/lib\/fba\/llmGateway['"]\)/)
      // No hand-rolled client construction survives — that is exactly what re-introduces the
      // SDK's default maxRetries: 2 (the gateway itself is the only file allowed to construct
      // one). Matches actual CODE (a real `apiKey:` follows), not this file's own doc comments
      // mentioning `new OpenAI({...})` as the thing that was removed.
      expect(src).not.toMatch(/new OpenAI\(\{\s*\n?\s*apiKey/)
      // The unused top-level `import OpenAI from 'openai'` must go with it (Surgical Changes —
      // a leftover import is a tell that the migration was only half-done).
      expect(src).not.toMatch(/^import OpenAI from ['"]openai['"]/m)
    })
  }

  it("llmGateway.ts is the only site that may construct `new OpenAI(` for these three routes' key path", () => {
    const gateway = read('lib', 'fba', 'llmGateway.ts')
    expect(gateway).toMatch(/maxRetries:\s*0/)
    expect(gateway).toContain('getLlmClientForRequest')
    expect(gateway).toContain('resolveOpenAIKey')
  })
})

describe('FIX 2 — the multi-design per-child editorial audit skips its LLM fan-out on a partial regen', () => {
  const src = read('lib', 'fba', 'listingPipeline.ts')

  it('gatePerChildMultiDesign is guarded by the SAME !input.onlySection pattern as the single-design final audit', () => {
    // The single-design final audit's own guard (unchanged by this pass) — the pattern being mirrored.
    expect(src).toMatch(/!designGroupInfo\.isMultiDesign && !input\.onlySection && bullets\.length === 5/)
    // gatePerChildMultiDesign's early-return now ALSO bails on any section regen — same literal
    // condition, applied to the per-child gate that used to run its full audit loop on every path.
    const gateStart = src.indexOf('const gatePerChildMultiDesign =')
    const gateBody = src.slice(gateStart, src.indexOf('for (const ctx of designGroupContexts)', gateStart))
    expect(gateBody).toMatch(/if \(input\.onlySection\) return/)
  })

  it('a LLM_FANOUT log records the call count at both audit sites (single-design + multi-design)', () => {
    const fanoutLines = [...src.matchAll(/tag: 'LLM_FANOUT'[^}]*\}/g)].map((m) => m[0])
    expect(fanoutLines.length).toBe(2)
    expect(fanoutLines.some((l) => l.includes("op: 'final_editorial_audit'"))).toBe(true)
    expect(fanoutLines.some((l) => l.includes("op: 'multi_design_editorial_audit'"))).toBe(true)
  })

  it('FULL regens are unaffected — gatePerChildMultiDesign is still called from the full path with its normal args', () => {
    // Full-path call site (~:11734 before this pass) — unchanged.
    expect(src).toMatch(/await gatePerChildMultiDesign\(perChildBullets, perChildDescriptions, truthFit, garmentBrandCanonical \|\| ''\)/)
  })

  it('the deterministic truth+brand scrub inside the gate is still reachable (not deleted, only reordered behind the new guard)', () => {
    expect(src).toContain('let auditBudget = MULTI_DESIGN_AUDIT_MAX_GROUPS')
    expect(src).toContain('runFinalEditorialAudit(input.openai, ctx.title, gb, gd')
  })
})
