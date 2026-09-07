/**
 * TASK 5, FIX ROUND 1 (2026-09-06) — Important #1 from the scoped re-review (agent afd8468b,
 * read-only, against HEAD df365a1).
 *
 * Task 5 (commit df365a1) wired the family's/design's seller-declared `audience_lean` into
 * `buildItemHighlights`/`buildItemHighlightsPerDesign`, but ONLY reached the full-pipeline call
 * sites (`listingPipeline.ts`). This route — `regenerate-item-highlight/route.ts` — carries its own
 * "Invariant 1: one function ships the field on every path" comment (see the file's own header,
 * :6/12/188) and calls the SAME two producers at :153 (`buildItemHighlightsPerDesign`) and :190
 * (`buildItemHighlights`), but never read `audience_lean`/`audience_lean_by_design` from the DB at
 * all, and never passed either field to either call. A PO clicking "Regenerate Item Highlight" on a
 * unisex family therefore still got a bare gendered phrase back, while a full pipeline audit run on
 * the SAME family now excludes it — two paths, two answers, from the one file that names the
 * invariant it violates.
 *
 * WHY A SOURCE-LEVEL ASSERTION (this route's own comment: "READ-ONLY identity ... Auth is enforced
 * by the /api/fba middleware"; the handler chains resolveToChildAsin/getStoredAnalysis/
 * loadSelectionContext/resolveBlankRowForNet/readDesignGroupIdentity — a live DB and a real Supabase
 * client end-to-end. Mocking that whole chain to drive POST() behaviourally would be a mini-rewrite
 * of the route's test surface, orthogonal to this round's two-finding scope ("no refactor"). Per the
 * brief's own minimum and this repo's precedent (`ihHealNoSilentRevert.test.ts`'s
 * "the heal actually CONSULTS the guard" test reads pushExecutor.ts's own source), this file reads
 * the ACTUAL source text of route.ts and asserts: (a) the existing `listing_seo_scores` select is
 * widened to carry both lean columns, and (b) BOTH call sites pass the field(s), apparel-gated. A
 * regression that drops either wiring point fails HERE, not silently in production on the next PO
 * click.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTE = readFileSync(join(process.cwd(), 'src/app/api/fba/regenerate-item-highlight/route.ts'), 'utf8')

describe('regenerate-item-highlight route: audience-lean parity with the pipeline (Task 5 fix round 1, Important #1)', () => {
  it('the listing_seo_scores select carries BOTH lean columns alongside is_multi_design_override', () => {
    expect(ROUTE).toMatch(
      /\.from\('listing_seo_scores'\)\s*[\s\S]{0,80}?\.select\(\s*'is_multi_design_override,\s*audience_lean,\s*audience_lean_by_design'\s*\)/,
    )
  })

  it('the select error is destructured and handled, not discarded (a silently-empty scoreRow must not read as "no lean")', () => {
    expect(ROUTE).toMatch(/const\s*\{\s*data:\s*scoreRow,\s*error:\s*scoreErr\s*\}\s*=\s*await/)
    expect(ROUTE).toMatch(/if\s*\(scoreErr\)\s*console\.(warn|error)/)
  })

  it('the PER-DESIGN call site (buildItemHighlightsPerDesign, ~:153) passes audienceLean (apparel-gated) AND audienceLeanByDesign', () => {
    expect(ROUTE).toMatch(
      /buildItemHighlightsPerDesign\(\{[\s\S]{0,700}?audienceLean:\s*apparel\s*\?[\s\S]{0,60}?:\s*null[\s\S]{0,200}?audienceLeanByDesign:/,
    )
  })

  it('the SINGLE-design call site (buildItemHighlights, ~:190) passes audienceLean, apparel-gated AND NORMALIZED (its field is TruthAudienceLean, not the raw DB enum)', () => {
    expect(ROUTE).toMatch(
      /buildItemHighlights\(\{\s*finalTitle:\s*title,\s*pool:\s*hlAnalysis,\s*apparelProduct:\s*apparel,\s*blankBrand:\s*blankRow,\s*netTitles:\s*\[title\],[\s\S]{0,1200}?audienceLean:\s*apparel\s*\?\s*normalizeAudienceLean\(storedAudienceLean\)\s*:\s*null/,
    )
  })

  it('the normalizer is imported from the SAME leaf module the pipeline uses — never a second rule', () => {
    expect(ROUTE).toMatch(/import\s*\{\s*normalizeAudienceLean\s*\}\s*from\s*'@\/lib\/fba\/contentTruth'/)
  })

  it('neither new field is passed un-gated by apparel — the Minor the reviewer flagged (a bare pass-through would fire the gender rule on a non-apparel family)', () => {
    // A crude but effective guard: every `audienceLean:` assignment in this file must be immediately
    // preceded by the `apparel ?` ternary gate — the ONLY exception is the destructuring/typing lines
    // (which don't assign a value) and the by-design map (which is never itself gated, matching the
    // pipeline's own reference at listingPipeline.ts:11874-11875).
    const assignments = [...ROUTE.matchAll(/audienceLean:\s*([^,\n]+)/g)].map((m) => m[1].trim())
    expect(assignments.length).toBeGreaterThan(0)
    for (const a of assignments) expect(a).toMatch(/^apparel\s*\?/)
  })
})

describe('regenerate-item-highlight route: ONE writer for the per-design detail row, both branches (FIX WAVE 2, I-2a)', () => {
  it('persistPerDesignItemHighlights is called exactly once before either branch returns (path parity — never two writers)', () => {
    const calls = [...ROUTE.matchAll(/await persistPerDesignItemHighlights\(/g)]
    expect(calls).toHaveLength(1)
  })

  it('the write happens BEFORE the composed.length === 0 (all-held) branch checks/returns — the held case is no longer write-free', () => {
    const writeIdx = ROUTE.indexOf('await persistPerDesignItemHighlights(')
    const heldBranchIdx = ROUTE.indexOf('if (composed.length === 0) {')
    expect(writeIdx).toBeGreaterThan(-1)
    expect(heldBranchIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeLessThan(heldBranchIdx)
  })

  it('the all-held error message no longer claims "kept the existing values" (the held state is now persisted)', () => {
    const heldMessageIdx = ROUTE.indexOf('Item Highlight HELD for every design')
    expect(heldMessageIdx).toBeGreaterThan(-1)
    // The whole all-held return block, up to its own closing `}, { status: 422 })`.
    const block = ROUTE.slice(heldMessageIdx, ROUTE.indexOf('}, { status: 422 })', heldMessageIdx))
    expect(block).not.toMatch(/kept the existing values/)
    expect(block).toMatch(/held state has been saved/)
  })

  it('a DB write failure from the shared writer short-circuits with a 500 before either branch\'s own return', () => {
    expect(ROUTE).toMatch(/if \(persisted\.error\) \{\s*\n\s*return NextResponse\.json\(\{ error: persisted\.error \}, \{ status: 500 \}\)/)
  })

  it('buildPerDesignIhDetailPatch and IH_REASON are imported from listingPipeline.ts — the SAME writer the full audit uses, never a second construction', () => {
    expect(ROUTE).toMatch(/import \{[^}]*buildPerDesignIhDetailPatch[^}]*\} from '@\/lib\/fba\/listingPipeline'/)
    expect(ROUTE).toMatch(/import \{[^}]*\bIH_REASON\b[^}]*\} from '@\/lib\/fba\/listingPipeline'/)
  })
})
