/**
 * IH-2 — ITEM HIGHLIGHTS TAKE THE DESCRIPTIVE RESIDUAL THE TITLE COULD NOT CARRY.
 *
 * PO 2026-08-18: "it should be taking descriptive terms from the Keyword bank if not used in title,
 * Such as 'Graphic Tee for Women'".
 *
 * THE PLACEMENT DOCTRINE, COMPLETED. The system already answers "which field holds which keyword"
 * for three surfaces — TITLE takes the one money keyword, BACKEND takes the CRITICAL/UPGRADE
 * overflow, BULLETS stay benefit prose and are NOT a coverage surface. Item Highlights had no stated
 * place, so the pool reached it as unfiltered "context" and the field never earned its indexed,
 * shopper-visible space.
 *
 * Its place is: spec-grounded descriptors PLUS the descriptive residual the title could not fit.
 * The filter is therefore "not already covered by the TITLE" — not "highest volume". A term the
 * title already carries is not residual, it is a repeat, and repeats are exactly what this field
 * must avoid (its own prompt rule, and Amazon's 2x word cap).
 *
 * These tests pin the SELECTION RULE against the repo's ONE coverage predicate. They deliberately
 * do not assert on LLM output — what the model writes is judged by the gates, but what it is OFFERED
 * is deterministic and is what this change controls.
 */
import { describe, it, expect } from 'vitest'
import { makeCoverageChecker } from '@/lib/keyword-engine/coverage-core'

/** Mirrors the shipped selection: keep only pool phrases the title does not already cover. */
const residual = (title: string, pool: string[]): string[] => {
  const covers = makeCoverageChecker(title)
  return pool.filter((k) => !covers(k))
}

const TITLE = 'THE CEO 2026 World Soccer Cup Tee Shirt | Futbol USA Mexico Canada Fans'

describe('the residual filter uses the ONE coverage predicate', () => {
  it("THE SELLER'S EXAMPLE survives — the title never says 'women'", () => {
    // The garment noun IS shared (tee/shirt fold together), so a naive substring or token-overlap
    // test would wrongly call this covered. isCovered requires EVERY keyword token present, and
    // 'women' is absent — which is precisely why the shared predicate is the right one here.
    expect(residual(TITLE, ['graphic tee for women'])).toEqual(['graphic tee for women'])
  })

  it('drops what the title already carries, so the field never repeats it', () => {
    for (const covered of ['world soccer cup', 'futbol', 'usa mexico canada', 'soccer cup tee']) {
      expect(residual(TITLE, [covered]), covered).toEqual([])
    }
  })

  it('keeps genuinely new descriptors', () => {
    const pool = ['graphic tee for women', 'soft cotton tee', 'unisex crew neck', 'futbol']
    expect(residual(TITLE, pool)).toEqual(['graphic tee for women', 'soft cotton tee', 'unisex crew neck'])
  })

  it('garment folding does not make everything look covered', () => {
    // tee ≡ tshirt ≡ shirt in the coverage core. A pool phrase must be dropped for its DISTINCTIVE
    // words being present, never for sharing only the garment noun with the title.
    expect(residual(TITLE, ['oversized tshirt'])).toEqual(['oversized tshirt'])
    expect(residual(TITLE, ['tee shirt'])).toEqual([])
  })

  it('is total — empty title and empty pool never throw', () => {
    expect(residual('', ['anything'])).toEqual(['anything'])
    expect(residual(TITLE, [])).toEqual([])
  })
})

describe('the haystack is the title that will actually be on the page', () => {
  it('a LOCKED title is the reference, not the freshly generated one', () => {
    // On a locked listing the shipped IH sits beside the seller's locked title (the fresh one is
    // discarded at persist), so residual is only meaningful against the locked text. Same predicate,
    // different haystack — asserted here so the netTitles wiring cannot silently regress.
    const locked = 'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women'
    // "comfort colors tee for women" is FULLY covered by the locked title, so against it the phrase
    // is a repeat, not residual…
    expect(residual(locked, ['comfort colors tee for women'])).toEqual([])
    // …but against the World Cup title, which says none of those words, the same phrase IS residual.
    // Same predicate, different haystack — which is exactly why netTitles must be threaded here.
    expect(residual(TITLE, ['comfort colors tee for women'])).toEqual(['comfort colors tee for women'])
    // And the seller's own example stays residual against BOTH, because neither title says "graphic".
    expect(residual(locked, ['graphic tee for women'])).toEqual(['graphic tee for women'])
    expect(residual(TITLE, ['graphic tee for women'])).toEqual(['graphic tee for women'])
  })
})
