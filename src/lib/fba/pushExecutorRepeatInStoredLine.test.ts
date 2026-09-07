/**
 * FIX WAVE 2 (I-2, 2026-09-06, final whole-branch review #2 controller RULING): the terminal net at
 * the push seam (`buildPerSkuItemHighlightMap`, perDesignItemHighlights.ts) refuses a stored line
 * that repeats a significant word ('repeat-in-stored-line'). `pushExecutor.ts` is the consumer that
 * decides whether a per-design family is pushable at all (`loadDetailContext`) and what each SKU's
 * push modal row says when its own line is skipped (`loadDetailDiff` / `executePush`'s details
 * branch) — both must CONSULT the new refusal, not just the pre-existing 'no-line-for-design' one,
 * or the class this fix wave closes (stale/pre-ruling bytes ship because nothing downstream of the
 * seam recognizes the new reason) recurs one layer up from the function that actually catches it.
 *
 * WHY A SOURCE-LEVEL ASSERTION: `loadDetailContext`/`loadDetailDiff` open a live Supabase client
 * (`createAdminClient`, a cookies()-scoped server client — see this repo's own memory on why that
 * class of client is unsafe to drive behaviorally outside a request) and chain SP-API token/seller
 * lookups. Mocking that whole chain to drive these functions behaviorally would be a mini-rewrite of
 * this file's test surface, orthogonal to this fix's scope. Per this repo's own precedent
 * (`ihHealNoSilentRevert.test.ts`), this file reads the ACTUAL source text of pushExecutor.ts and
 * asserts the wiring points a regression could silently drop. The underlying PREDICATE
 * (`buildPerSkuItemHighlightMap` actually refusing a repeated stored line) is proven behaviorally in
 * `perDesignItemHighlights.test.ts` — this file only proves pushExecutor.ts's OWN consumption of it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(process.cwd(), 'src/lib/fba/pushExecutor.ts'), 'utf8')

describe('pushExecutor.ts consumes the repeat-in-stored-line refusal (FIX WAVE 2, I-2b)', () => {
  it('imports REPEAT_IN_STORED_LINE and pushableDesignLines from the seam module', () => {
    expect(SRC).toMatch(/from '@\/lib\/fba\/perDesignItemHighlights'/)
    const importLine = SRC.match(/import \{[^}]*\} from '@\/lib\/fba\/perDesignItemHighlights'/)?.[0] ?? ''
    expect(importLine).toMatch(/\bpushableDesignLines\b/)
    expect(importLine).toMatch(/\bREPEAT_IN_STORED_LINE\b/)
  })

  it("loadDetailContext's \"every design held\" gate consults pushableDesignLines, not a bare .trim() filter — the class this fix closes (perDesignLines.length > 0 alone making a stale family look pushable)", () => {
    expect(SRC).toMatch(/const perDesignLines = pushableDesignLines\(perDesignEntries\)/)
  })

  it('loadDetailDiff propagates the REAL skip reason from buildPerSkuItemHighlightMap\'s own skipped list, never hardcoding NO_LINE_FOR_DESIGN', () => {
    expect(SRC).toMatch(/const skipReasonBySku = new Map\(\(perDesign\?\.skipped \?\? \[\]\)\.map\(\(s\) => \[s\.sku, s\.reason\] as const\)\)/)
    expect(SRC).toMatch(/skipReason: skipReasonBySku\.get\(r\.sku\) \?\? NO_LINE_FOR_DESIGN/)
  })

  it('the DiffRow skipReason type accepts both reasons (IhSkuSkipReason), not just the literal "no-line-for-design"', () => {
    expect(SRC).toMatch(/skipReason\?:\s*IhSkuSkipReason/)
  })

  it('the executePush details-branch per-SKU skip check recognizes REPEAT_IN_STORED_LINE (not only NO_LINE_FOR_DESIGN/!item.raw) and reports its OWN accurate message', () => {
    expect(SRC).toMatch(/item\.skipReason === NO_LINE_FOR_DESIGN \|\| item\.skipReason === REPEAT_IN_STORED_LINE \|\| !item\.raw/)
    expect(SRC).toMatch(/item\.skipReason === REPEAT_IN_STORED_LINE\s*\n\s*\?\s*'Skipped — this SKU\\'s stored Item Highlight repeats a significant word/)
  })

  it('the held-SKU surfacing pass (rawDetailDiff) also recognizes REPEAT_IN_STORED_LINE with its own message, not the generic "has no composed Item Highlight" text', () => {
    expect(SRC).toMatch(/r\.skipReason === NO_LINE_FOR_DESIGN \|\| r\.skipReason === REPEAT_IN_STORED_LINE/)
    expect(SRC).toMatch(/d\.skipReason === REPEAT_IN_STORED_LINE/)
  })
})
