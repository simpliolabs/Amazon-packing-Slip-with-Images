/**
 * garmentNoun.test.ts — THE ALIAS-INHERITANCE CLASS (PO ruling 2026-09-03).
 *
 * Live defect: B0DSCDZC6K's "Business B*tch" design (blank_specs.garment_family='long_sleeve_tee',
 * migration 058's 6014 row, sleeve='Long Sleeve') shipped "...Long Sleeve Cotton Polyester Tshirt"
 * — a LONG-SLEEVE garment calling itself a Tshirt. Root cause: `LONG_SLEEVE_TEE_BASE.aliases` used
 * to spread `...SHIRT_BASE.aliases` WHOLESALE, so `resolveGarment({blankFamily:'long_sleeve_tee'})
 * .aliases` (the exact list listingPipeline.ts's `garmentFactSegments` title-cases into candidate
 * title-pad segments, listingPipeline.ts:9398) carried 'tshirt'/'t-shirt'/'tee'/'graphic tee' —
 * words that specifically assert the SHORT-sleeve tee silhouette — as if they were true of a
 * long-sleeve blank.
 *
 * THE CLASS (not the instance): a garment family's alias list must never inherit another family's
 * aliases WHOLESALE via spread; it may only inherit the SLEEVE-NEUTRAL subset. This file is
 * table-driven over the exported `SHORT_SLEEVE_IMPLYING_ALIASES` set precisely so a future edit
 * that reintroduces a wholesale `...SHIRT_BASE.aliases` spread on a long-sleeve-only family FAILS
 * here, rather than shipping live again.
 */
import { describe, it, expect } from 'vitest'
import { resolveGarment, SHIRT_BASE, SHORT_SLEEVE_IMPLYING_ALIASES } from './garmentNoun'

describe('SHORT_SLEEVE_IMPLYING_ALIASES — the named risk vocabulary', () => {
  it('is exactly the short-sleeve-specific subset of SHIRT_BASE.aliases', () => {
    // Every member must itself be a real SHIRT_BASE alias (never an invented word)…
    for (const a of SHORT_SLEEVE_IMPLYING_ALIASES) {
      expect(SHIRT_BASE.aliases, `"${a}" must be a real SHIRT_BASE alias`).toContain(a)
    }
    // …and it must contain the four known short-sleeve-specific words.
    expect([...SHORT_SLEEVE_IMPLYING_ALIASES].sort()).toEqual(['graphic tee', 't-shirt', 'tee', 'tshirt'])
  })

  it('does NOT contain bare "shirt" — the one silhouette-neutral SHIRT_BASE alias', () => {
    expect(SHORT_SLEEVE_IMPLYING_ALIASES.has('shirt')).toBe(false)
  })
})

describe('LONG_SLEEVE_TEE_BASE (via resolveGarment blankFamily=long_sleeve_tee) — the live defect class', () => {
  const aliases = resolveGarment({ blankFamily: 'long_sleeve_tee', productType: 'SHIRT', title: null }).aliases

  it.each([...SHORT_SLEEVE_IMPLYING_ALIASES])(
    'NEVER offers %j as a candidate — it asserts the WRONG sleeve length on a long-sleeve family',
    (shortSleeveWord) => {
      expect(aliases, JSON.stringify(aliases)).not.toContain(shortSleeveWord)
    },
  )

  it('still offers the sleeve-neutral "shirt" — the filter removes short-sleeve words ONLY, not every SHIRT_BASE alias', () => {
    expect(aliases).toContain('shirt')
  })

  it('still offers its own long-sleeve overlay phrases — the fix did not over-filter the family\'s own vocabulary', () => {
    expect(aliases).toEqual(expect.arrayContaining(['long sleeve tee', 'long sleeve shirt', 'long sleeve t-shirt', 'long sleeve']))
  })

  it('the live defect specimen: "tshirt"/"t-shirt"/"tee"/"graphic tee" are structurally absent, one call site to grep instead of four', () => {
    for (const bad of ['tshirt', 't-shirt', 'tee', 'graphic tee']) expect(aliases).not.toContain(bad)
  })
})

describe('THE INVERSE DIRECTION — a genuinely short-sleeve family may still assert short-sleeve words (this is correct, not a bug)', () => {
  it('kids_tee (migration 058\'s 64000B row, sleeve=Short Sleeve) still offers short-sleeve words — the ban is sleeve-length-specific, not a global word ban', () => {
    const aliases = resolveGarment({ blankFamily: 'kids_tee', productType: 'SHIRT', title: null }).aliases
    for (const shortSleeveWord of SHORT_SLEEVE_IMPLYING_ALIASES) expect(aliases).toContain(shortSleeveWord)
  })

  it('plain tee (garment_family="tee", e.g. 1717/64000, short sleeve) still offers short-sleeve words', () => {
    const aliases = resolveGarment({ blankFamily: 'tee', productType: 'SHIRT', title: null }).aliases
    for (const shortSleeveWord of SHORT_SLEEVE_IMPLYING_ALIASES) expect(aliases).toContain(shortSleeveWord)
  })

  it('kids_tee does NOT inherit LONG_SLEEVE_TEE_BASE\'s long-sleeve overlay phrases either — no wholesale spread in ANY direction for this family', () => {
    const aliases = resolveGarment({ blankFamily: 'kids_tee', productType: 'SHIRT', title: null }).aliases
    for (const longSleevePhrase of ['long sleeve tee', 'long sleeve shirt', 'long sleeve t-shirt', 'longsleeve tee', 'longsleeve shirt']) {
      expect(aliases).not.toContain(longSleevePhrase)
    }
  })
})

describe('SWEATSHIRT / HOODIE — never inherited SHIRT_BASE aliases at all (a different, unrelated vocabulary), confirmed not to carry the bleed either', () => {
  it.each(['sweatshirt', 'hoodie'] as const)('%s aliases contain none of SHORT_SLEEVE_IMPLYING_ALIASES', (family) => {
    const aliases = resolveGarment({ blankFamily: family, productType: 'SHIRT', title: null }).aliases
    for (const shortSleeveWord of SHORT_SLEEVE_IMPLYING_ALIASES) expect(aliases).not.toContain(shortSleeveWord)
  })
})
