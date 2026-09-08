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
import { firstEmptyReplaceOp, MARKETPLACE_ID, type PatchOp } from './pushExecutor'
import { buildDetailPatchValue, type DetailAttribute } from './productDetailAttrs'

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

  // FIX ROUND 3 (I-2, controller RULING): the reason TEXT is no longer a hand-rolled ternary naming
  // REPEAT_IN_STORED_LINE specifically — it is the ONE `ihSkipReasonText` mapper (which itself is
  // directly unit-tested in `perDesignItemHighlights.test.ts` to return the accurate
  // "repeats a significant word" text for THIS reason, among every other reason). The routing
  // condition (the `if` gate itself) is UNCHANGED — only the text-construction ternary this pin used
  // to assert is gone, per this round's ruling ("do not add a third branch in two places").
  it('the executePush details-branch per-SKU skip check recognizes REPEAT_IN_STORED_LINE (not only NO_LINE_FOR_DESIGN/!item.raw) and reports its message via the ONE ihSkipReasonText mapper (fix round 3)', () => {
    expect(SRC).toMatch(/item\.skipReason === NO_LINE_FOR_DESIGN \|\| item\.skipReason === REPEAT_IN_STORED_LINE \|\| !item\.raw/)
    expect(SRC).toMatch(/const reason = `Skipped — \$\{ihSkipReasonText\(item\.skipReason \?\? NO_LINE_FOR_DESIGN\)\}\.`/)
  })

  // FIX ROUND 3 (I-1/I-2, controller RULING): the filter widened from the enumerated
  // NO_LINE_FOR_DESIGN/REPEAT_IN_STORED_LINE/UNDER_FLOOR literals to "any skipReason at all"
  // (`classifyIhEntry` can now surface ANY IhHoldReason here — a held-but-in-band-line entry whose
  // hold is, say, 'under-floor-no-repeat' was silently DROPPED by the old 3-literal filter, never
  // surfaced at all; reproduced live, fix round 3 probe). The message comes from the ONE
  // `ihSkipReasonText` mapper, so REPEAT_IN_STORED_LINE (and every other reason) is reported
  // accurately without a per-reason hand-rolled branch.
  it('the held-SKU surfacing pass (rawDetailDiff) surfaces EVERY skipReason (widened from 3 enumerated literals) and reports each via ihSkipReasonText — REPEAT_IN_STORED_LINE included, never the generic "has no composed Item Highlight" text', () => {
    expect(SRC).toMatch(/rawDetailDiff\.filter\(\(r\) => !!r\.skipReason && r\.asin !== parent_asin\)/)
    expect(SRC).toMatch(/const reason = `Skipped \(\$\{d\.skipReason\}\) — \$\{d\.designName \|\| d\.designKey \|\| 'this design'\}: \$\{ihSkipReasonText\(d\.skipReason as IhSkuSkipReason\)\}\.`/)
  })
})

/**
 * IMPORTANT 3 (2026-09-07, controller RULING on phase-1-fix-round-findings.md, opus review
 * phase-1-review.md): an `under-floor` SKU (Phase 1's H13 fix) reached `buildPerSkuItemHighlightMap`'s
 * `skipped` list and the CARD (pre-flight) correctly, but vanished from the PUSH REPORT — the
 * `:3903`/`:3983` gates only recognized `NO_LINE_FOR_DESIGN`/`REPEAT_IN_STORED_LINE`, so an
 * under-floor SKU produced NO result row, no progress event, and no line in the push summary. Same
 * source-scan discipline as FIX WAVE 2 above (live Supabase/SP-API chain — see the file docstring).
 */
describe('pushExecutor.ts consumes the under-floor refusal at the push REPORT (IMPORTANT 3, fix round 1)', () => {
  it('imports UNDER_FLOOR from the seam module', () => {
    const importLine = SRC.match(/import \{[^}]*\} from '@\/lib\/fba\/perDesignItemHighlights'/)?.[0] ?? ''
    expect(importLine).toMatch(/\bUNDER_FLOOR\b/)
  })

  it('the executePush details-branch per-SKU skip check ALSO recognizes UNDER_FLOOR (a third branch, appended after the pinned prefix above) and reports it via the ONE ihSkipReasonText mapper (fix round 3)', () => {
    expect(SRC).toMatch(/item\.skipReason === NO_LINE_FOR_DESIGN \|\| item\.skipReason === REPEAT_IN_STORED_LINE \|\| !item\.raw \|\| item\.skipReason === UNDER_FLOOR/)
    expect(SRC).toMatch(/const reason = `Skipped — \$\{ihSkipReasonText\(item\.skipReason \?\? NO_LINE_FOR_DESIGN\)\}\.`/)
  })

  // FIX ROUND 3 (I-1/I-2, controller RULING): see the widened-filter comment above — the same
  // "!!r.skipReason" filter (not a 3-literal enumeration) now surfaces UNDER_FLOOR (and every other
  // reason) here too, via the same ihSkipReasonText call.
  it('the held-SKU surfacing pass (rawDetailDiff) surfaces UNDER_FLOOR via the widened filter + ihSkipReasonText, never falling through to the generic "has no composed Item Highlight" text', () => {
    expect(SRC).toMatch(/rawDetailDiff\.filter\(\(r\) => !!r\.skipReason && r\.asin !== parent_asin\)/)
    expect(SRC).toMatch(/ihSkipReasonText\(d\.skipReason as IhSkuSkipReason\)/)
  })

  // FIX ROUND 3 (I-2, controller RULING): pushExecutor.ts no longer references IH_HOLD_MESSAGES
  // directly (the literal `IH_HOLD_MESSAGES[UNDER_FLOOR]` this pin used to assert lived ONLY inside
  // the hand-rolled ternaries this round removed) -- the under-floor text is now sourced from the
  // ONE `ihSkipReasonText` mapper, which itself reuses `IH_HOLD_MESSAGES[UNDER_FLOOR]` internally
  // (proven directly in perDesignItemHighlights.test.ts's "ihSkipReasonText" describe block: 'under-floor reads as the REAL under-floor message'). This pin now proves pushExecutor.ts calls
  // THAT mapper at every site instead of re-deriving the text itself.
  it('the under-floor message is sourced from the ONE ihSkipReasonText mapper (which itself reuses IH_HOLD_MESSAGES) -- pushExecutor.ts no longer hand-writes a floor sentence or references IH_HOLD_MESSAGES directly', () => {
    expect(SRC).toMatch(/ihSkipReasonText/)
    expect(SRC).not.toMatch(/IH_HOLD_MESSAGES/)
  })
})

/**
 * BLOCKING 1 (2026-09-07, controller RULING on phase-1-fix-round-findings.md, opus review
 * phase-1-review.md): a refusal must never become an empty SP-API `replace` patch. `buildDetailPatchValue`
 * now returns `[]` on refusal (productDetailAttrs.ts) instead of `[{value:''}]` — this pin proves the
 * ONE choke point every single-attribute PATCH sender (`patchSkuDetail`, called directly by the
 * single-push details branch AND by `pushPerFieldFallback`'s per-attribute retries) refuses to
 * forward an empty resolved value to Amazon at all, rather than sending `patches:[{value:[]}]`
 * un-examined.
 */
describe('pushExecutor.ts never forwards an empty resolved patch value to Amazon (BLOCKING 1, fix round 1)', () => {
  it('patchSkuDetail resolves the patch value BEFORE the fetch call and refuses (no HTTP call) when it is empty', () => {
    // CRLF-tolerant: this repo's source files use \r\n line endings.
    const fn = SRC.match(/async function patchSkuDetail\([\s\S]*?\r?\n\}\r?\n/)?.[0] ?? ''
    expect(fn).not.toBe('')
    // the guard's own emptiness check must appear BEFORE the `await fetch(` call in this function
    const guardIdx = fn.search(/resolvedValue\.length === 0/)
    const fetchIdx = fn.search(/await fetch\(/)
    expect(guardIdx).toBeGreaterThan(-1)
    expect(fetchIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(fetchIdx)
  })
})

/**
 * BLOCKING 1, fix round 2 (2026-09-07, controller RULING on phase-1-fix-round-2-findings.md): fix
 * round 1 closed the choke point ONLY on the single-attribute path (`patchSkuDetail` above). The
 * BULK/raw path — `opFor` (pushExecutor.ts:4722-4723), `specializePlanValue`, and the Phase-2
 * calibration loop, all inside `executeBulkDetailsPush` — builds its own ops from the SAME
 * `buildDetailPatchValue` and hands them straight to `patchSkuMulti`, which had NO emptiness check:
 * a refused Item Highlight reaching Auto Push / bulk details still became a live `replace` with an
 * empty value. The ruling: close it at `patchSkuMulti` (the REJOIN point every raw/bulk op funnels
 * through — ~20 call sites, phase-1-report.md "Fix round 2" traces every one), not at the three
 * call-site builders. `op:'delete'` is exempt (twin-heal `delOnly` + composite-delete carry
 * stored/selector values by design, load-bearing production behaviour — memory
 * `parent-hub-dead-tokens-cure`).
 */
describe('pushExecutor.ts never forwards an empty resolved patch value to Amazon via the BULK/raw path (BLOCKING 1, fix round 2)', () => {
  it('patchSkuMulti calls firstEmptyReplaceOp and refuses (no HTTP call) BEFORE the fetch call', () => {
    const fn = SRC.match(/async function patchSkuMulti\([\s\S]*?\r?\n\}\r?\n/)?.[0] ?? ''
    expect(fn).not.toBe('')
    const guardIdx = fn.search(/firstEmptyReplaceOp\(ops\)/)
    const fetchIdx = fn.search(/await fetch\(/)
    expect(guardIdx).toBeGreaterThan(-1)
    expect(fetchIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(fetchIdx)
  })

  it('op:delete is exempt from the guard even with an empty-looking value (twin-heal delOnly / composite-delete selector shape)', () => {
    const deleteOps: PatchOp[] = [{ op: 'delete', path: '/attributes/shirt_size', value: [] }]
    expect(firstEmptyReplaceOp(deleteOps)).toBeNull()
    const deleteNoValue: PatchOp[] = [{ op: 'delete', path: '/attributes/shirt_size' }]
    expect(firstEmptyReplaceOp(deleteNoValue)).toBeNull()
  })

  it('a non-empty composite op:replace (the twin-heal shirt_size rewrite / parent-hub mirror shape — value:[item]) is NOT refused', () => {
    const compositeOps: PatchOp[] = [{
      op: 'replace', path: '/attributes/shirt_size',
      value: [{ size: 'L', size_system: 'as1', size_class: 'alpha', marketplace_id: MARKETPLACE_ID }],
    }]
    expect(firstEmptyReplaceOp(compositeOps)).toBeNull()
  })

  it('REJOIN PROOF: a REFUSED Item Highlight value reaches neither the SINGLE-path builder nor the BULK-path builder\'s constructed op — both resolve to the SAME empty shape the guard refuses', () => {
    // The reviewer's / round-1's exact fixture: 218-char comma-less line — every phrase nets to
    // non-empty via the repeat cap but none fits under the 125-char length cap alone -> refusal.
    const H11 = 'A remarkably durable garment constructed from ringspun combed fibres finished with double needle stitching throughout every seam so it survives repeated laundering while keeping its original silhouette and vivid colour'
    expect(H11.length).toBe(218)
    const attr: DetailAttribute = { spApiKey: 'item_highlights', scope: 'broadcast' }

    // SINGLE path: patchSkuDetail's own `resolvedValue` (no valueShape/patchValue override) —
    // guarded since fix round 1 (the describe block above).
    const singleResolvedValue = buildDetailPatchValue(attr, H11, MARKETPLACE_ID, 'en_US')
    expect(singleResolvedValue).toEqual([])

    // BULK path: opFor's LITERAL expression (pushExecutor.ts:4722-4723) — `p.patchValue` is
    // undefined for a FLAT field like item_highlights (patchValue is only set by the Phase-2
    // calibration loop for COMPOSITE/valueShape fields), so it falls through to the exact same
    // buildDetailPatchValue call the single path uses. `patchValue` is typed as a real optional
    // (not a bare `undefined` literal) so this mirrors BulkFieldPlan's own field type instead of
    // tripping tsc's "always nullish" check on a literal cast.
    let patchValue: { value: unknown }[] | undefined
    const bulkOp: PatchOp = {
      op: 'replace', path: `/attributes/${attr.spApiKey}`,
      value: patchValue ?? buildDetailPatchValue(attr, H11, MARKETPLACE_ID),
    }
    expect(bulkOp.value).toEqual([])

    // Both builders produced the identical empty shape for the identical refused input — and the
    // REJOIN guard (patchSkuMulti's firstEmptyReplaceOp) catches the bulk-path op, closing the gap
    // fix round 1 left open.
    expect(firstEmptyReplaceOp([bulkOp])).toBe(bulkOp)
  })
})
