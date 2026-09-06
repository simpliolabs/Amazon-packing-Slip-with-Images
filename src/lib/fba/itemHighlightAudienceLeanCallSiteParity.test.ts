/**
 * TASK 5, FIX ROUND 1 (2026-09-06) — Important #2 from the scoped re-review (agent afd8468b,
 * read-only, against HEAD df365a1).
 *
 * Task 5 (commit df365a1) wired the family's/design's seller-declared `audience_lean` into
 * `buildItemHighlights`/`buildItemHighlightsPerDesign` and into the pipeline's MULTI-design branch
 * (`listingPipeline.ts:11857-11876`, which passes `audienceLean: apparelProduct ? input.audienceLean
 * : null` at :11874). The pipeline's OWN single-design branch — the `else` of that same
 * `if (apparelMultiDesign && designGroupContexts.length >= 2)` at :11900 — calls the SAME shared
 * producer (`buildItemHighlights`) but never passed the field at all, even though `input.audienceLean`
 * is in scope in this same function (confirmed already read at :10435 and :11874 above it). A UNISEX
 * single-design family's Item Highlight therefore composed with NO audience gate, while the SAME
 * family running the multi-design branch (or a full audit) already excludes a bare gendered phrase.
 *
 * WHY THIS IS A SOURCE-LEVEL ASSERTION, NOT A BEHAVIOURAL ONE (brief's own escape hatch): calling
 * `buildItemHighlights` directly with `audienceLean: 'unisex'` ALREADY filters correctly — that
 * function's own field-threading was Task 5's fix, proven green by
 * `itemHighlightPerDesign.test.ts`'s "Task 5" describe block. Confirmed empirically here too: a
 * throwaway direct call with a women-heavy pool + `audienceLean:'unisex'` PASSED (no bare "women")
 * against unmodified HEAD df365a1 — so a test that hand-picks its own call args to `buildItemHighlights`
 * can never reproduce this bug; only a test that inspects what the PIPELINE'S OWN branch actually
 * passes can. Reproducing the full `runListingPipeline` end-to-end (DB-backed, vision-scan-gated,
 * ~3-4min per the route's own comment) is out of proportion to a three-token wiring fix — so, per the
 * brief and following this repo's own precedent (`ihHealNoSilentRevert.test.ts`'s
 * "the heal actually CONSULTS the guard" test; `parentLockScope.test.ts`'s CI-trap-neutralized direct
 * function drive), this file reads the ACTUAL source text of the call site and asserts the field is
 * present in the call — so deleting/regressing the wiring fails HERE, not silently in production.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LISTING_PIPELINE = readFileSync(join(process.cwd(), 'src/lib/fba/listingPipeline.ts'), 'utf8')

describe('Item Highlights: pipeline single-design branch must pass audienceLean (Task 5 fix round 1, Important #2)', () => {
  it('the MULTI-design branch (the reference) passes audienceLean, apparel-gated — sanity that the pattern exists and this test would catch its removal too', () => {
    expect(LISTING_PIPELINE).toMatch(
      /buildItemHighlightsPerDesign\(\{[\s\S]{0,1000}?audienceLean:\s*apparelProduct\s*\?\s*input\.audienceLean\s*:\s*null/,
    )
  })

  it('the SINGLE-design branch (the `else` of `apparelMultiDesign && designGroupContexts.length >= 2`) ALSO passes audienceLean, apparel-gated AND NORMALIZED — the bug this round fixes', () => {
    // Anchor on the exact single-design call (finalTitle/hlPool/blankBrandNetRow/ihNetTitles is the
    // unique fingerprint of this call site — the multi-design call above uses different variable
    // names, so this pattern cannot accidentally match that one instead).
    // NORMALIZED, not raw: `buildItemHighlights`'s `audienceLean` field is `TruthAudienceLean`
    // (unisex/women/men); `input.audienceLean` is the raw seller enum
    // (male/female/lean_male/lean_female/unisex) — the multi-design branch's OWN call never hits
    // this type seam directly because `buildItemHighlightsPerDesign` normalizes per design
    // internally before its inner call to this same function; this branch calls it directly, so it
    // must normalize inline (a bare `input.audienceLean` here is a TS type error, not a lint nit).
    expect(LISTING_PIPELINE).toMatch(
      /buildItemHighlights\(\{\s*finalTitle,\s*pool:\s*hlPool,\s*apparelProduct,\s*blankBrand:\s*blankBrandNetRow,\s*netTitles:\s*ihNetTitles,[\s\S]{0,1500}?audienceLean:\s*apparelProduct\s*\?\s*normalizeAudienceLean\(input\.audienceLean\)\s*:\s*null/,
    )
  })
})
