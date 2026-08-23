/**
 * truthBandGate.test.ts — THE GOLDEN-BAND MERGE GATE, DRIVING THE DOOR (PO approval 2026-08-22).
 *
 * THIS IS THE TEST THAT WOULD HAVE STOPPED FOUR REVERTS/PATCHES, NOT ONE. PRs/attempts #630, #632,
 * #634 and #637 each shipped with a clean typecheck and a green suite, and each one failed live on
 * THIS SAME family (B0DSCDZC6K) for a DIFFERENT reason: #630 shipped 29-49 char titles (subtractive
 * net, no additive counterpart); #632's refill re-added market vocabulary the net had just removed;
 * #634's producer improved but a later stage still wrote after it; #637 scrubbed segment 0 but "for
 * Men" went from 1 title to 6, sibling names still leaked, and "Long Sleeve Longsleeve Tee" shipped.
 *
 * WHY THIS FILE WAS REWRITTEN (not just re-pinned). Every one of those four failures shipped through
 * a harness that called a LEAF — `enforceTitleTruthBand` or `settleTruthBand` — three to nine stages
 * downstream of what the route actually returns. `bandTitle` (listingPipeline.ts) also runs casing,
 * spec-truth, cap+dedupe, waste-vocabulary stripping, the money tail, color stripping, inclusive-
 * audience narrowing and the facts pad BEFORE the truth+band settle, and the live defects lived in
 * THOSE stages. A harness that green-lights a leaf while the door ships lies is worse than no harness.
 *
 * So this file asserts on `runTruthBandHarness()`'s `rows`, which are built by calling `settleTitle`
 * — THE SAME function `bandTitle`'s thin adapter calls in listingPipeline.ts, with the FULL ctx a
 * real regen would build (money-tail ctx, band ctx, spec, cap, waste-vocabulary probe — everything).
 * No stage is skipped; nothing here is a re-implementation.
 *
 * WHAT IT PINS, per the acceptance list (handoff/TITLE_SETTLE_REWRITE.md §5 + the rewrite ticket):
 *   • every one of the 7 titles (parent + 6 designs) lands 70-75, or holds honestly (kept = the
 *     PRIOR live title, itself truthful and in band — never a silent stub, never a lie)
 *   • no "tee"/"tshirt" anywhere (this is a fleece — sweatshirt/hoodie — family)
 *   • no "for Men"/"for Women" anywhere (the family's stored audience_lean is unisex)
 *   • no title contains another design's name (per-design scope, never the family union)
 *   • no title names two garment classes, even two both individually-true ones (sweatshirt + hoodie)
 *   • no stray punctuation before a separator (the live "Entrepreneur, |" specimen)
 *   • no concept restated in two spellings ("Crewneck" + "Crew Neck")
 *   • the seller's censored design name ships verbatim ("Business B*tch", never "B*Tch")
 * …plus the per-child garment model and the migration-062 child override that proves it (unchanged
 * by this rewrite — those assertions were never leaf-vs-door dependent).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runTruthBandHarness, DESIGNS, POOL, type HarnessResult } from './truthBandHarness'
import { TITLE_BAND_LO, TITLE_BAND_HI, titleHasDuplicateConcept, titleHasPunctuationDefect } from './titleBand'
import { phraseTruthVerdict } from './contentTruth'

const RESULT: HarnessResult = runTruthBandHarness()
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

describe('THE BAND — the invariant the reverted builds lost', () => {
  it('EVERY title (parent + 6 designs) is 70-75 characters', () => {
    const lens = RESULT.rows.map((r) => `${r.scope}=${r.len}`)
    expect(RESULT.rows.length).toBe(7)
    for (const r of RESULT.rows) {
      expect(r.len, `${r.scope} shipped ${r.len} chars: "${r.title}" (all: ${lens.join(' ')})`)
        .toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(r.len, `${r.scope} shipped ${r.len} chars: "${r.title}"`).toBeLessThanOrEqual(TITLE_BAND_HI)
    }
  })

  it('a title that holds NEVER ships a stub — every hold keeps the PRIOR (truthful, in-band) title', () => {
    for (const r of RESULT.rows) {
      if (!r.hold) continue
      expect(r.decision, `${r.scope}: ${r.reason}`).toBe('refused-kept-prior')
      // The kept title landed in band too (asserted above) — a hold is a legitimate, honest fallback,
      // never a shorter/lying substitute for the band.
      expect(r.title).not.toBe(r.raw)
    }
  })

  it('the truth net genuinely CUT these titles first — the band was restored/held, not merely never lost', () => {
    // Guards the trivial pass: if the net stopped removing anything, every title would trivially equal
    // its raw input and this whole file would go green while the spine did nothing at all.
    for (const r of RESULT.rows) {
      expect(r.title, `${r.scope} was not changed at all: "${r.title}"`).not.toBe(r.raw)
    }
  })
})

describe('THE TRUTH — every rule the reverted builds got right, still enforced END TO END', () => {
  it('no title anywhere contains "tee" or "tshirt" — this is a fleece (sweatshirt/hoodie) family', () => {
    for (const r of RESULT.rows) {
      expect(norm(r.title), `${r.scope}: "${r.title}"`).not.toMatch(/\btees?\b/)
      expect(norm(r.title), `${r.scope}: "${r.title}"`).not.toMatch(/\bt ?shirts?\b/)
    }
  })

  it('no title anywhere forces a gender on the unisex-lean family ("for Men"/"for Women")', () => {
    for (const r of RESULT.rows) {
      expect(norm(r.title), `${r.scope}: "${r.title}"`).not.toMatch(/\bfor (?:women|men)\b/)
      expect(norm(r.title), `${r.scope}: "${r.title}"`).not.toMatch(/\b(?:womens|mens|ladies)\b/)
    }
  })

  it('no design carries a SIBLING design name', () => {
    for (const r of RESULT.rows) {
      if (r.scope === 'broadcast') continue                 // the parent is answerable to every design
      const own = DESIGNS.find((d) => d.key === r.scope)!
      for (const sib of DESIGNS) {
        if (sib.key === own.key) continue
        expect(norm(r.title), `${r.scope} carries ${sib.name}: "${r.title}"`).not.toContain(norm(sib.name))
      }
    }
  })

  it('no title names two garment classes, even two both-true ones (sweatshirt + hoodie)', () => {
    const classesIn = (title: string): Set<string> => {
      // "Hooded Sweatshirt" is ONE compound noun — a hoodie IS a hooded sweatshirt (contentTruth.ts's
      // own doctrine) — so it is folded to the hoodie class BEFORE testing the bare sweatshirt/
      // crewneck/pullover pattern, or the compound double-counts as two classes on its own. This is
      // still independent of the implementation's own `dominantGarmentGroup`/`garmentGroup` — it is
      // the same domain fact, re-encoded as a black-box check.
      const folded = title.replace(/\bhooded[\s-]?sweatshirts?\b/gi, 'Hoodie')
      const groups: Record<string, RegExp> = {
        tee: /\b(?:t[-\s]?shirts?|tshirts?|tees?)\b/i,
        sweatshirt: /\b(?:sweatshirts?|crewnecks?|pullovers?)\b/i,
        hoodie: /\b(?:hoodies?|hoodys?|hooded)\b/i,
      }
      const out = new Set<string>()
      for (const [cls, re] of Object.entries(groups)) if (re.test(folded)) out.add(cls)
      return out
    }
    for (const r of RESULT.rows) {
      const classes = classesIn(r.title)
      expect(classes.size, `${r.scope} names ${[...classes].join('+')}: "${r.title}"`).toBeLessThanOrEqual(1)
    }
  })

  it('no title restates one concept in two spellings ("Crewneck" + "Crew Neck")', () => {
    for (const r of RESULT.rows) {
      expect(titleHasDuplicateConcept(r.title), `${r.scope}: "${r.title}"`).toBe(false)
    }
  })

  it('no title carries a punctuation defect (the live "Entrepreneur, |" specimen)', () => {
    for (const r of RESULT.rows) {
      expect(titleHasPunctuationDefect(r.title), `${r.scope}: "${r.title}"`).toBe(false)
    }
  })

  it('no orphan fragment — a pool phrase ships WHOLE or not at all (the "Mind" class)', () => {
    for (const r of RESULT.rows) {
      const segs = r.title.split(/\s*[|,]\s*/).slice(1).map(norm).filter(Boolean)
      for (const seg of segs) {
        const orphan = POOL.map(norm).some((p) => p.startsWith(`${seg} `))
        expect(orphan, `${r.scope} ends a segment mid-phrase ("${seg}"): "${r.title}"`).toBe(false)
      }
    }
    // The specimen, explicitly: the raw BB/MH producer strings must not survive their own dangling
    // fragments if the door were ever to leave one — MH's raw string ends ", Mind".
    const mh = RESULT.rows.find((r) => r.scope === 'MH')!
    expect(mh.raw).toMatch(/, Mind$/)
    expect(mh.title).not.toMatch(/\bMind\b/i)
  })

  it('the seller\'s censored design name ships VERBATIM — "Business B*tch", never "B*Tch"', () => {
    const bb = RESULT.rows.find((r) => r.scope === 'BB')!
    expect(bb.raw).toContain('Business B*Tch')                // the raw producer text mangles it…
    expect(bb.title).toContain('Business B*tch')              // …and the door ships it correctly
    expect(bb.title).not.toContain('B*Tch')
  })
})

describe('THE PER-CHILD GARMENT MODEL — a family verdict is the wrong shape', () => {
  it('the FAMILY stays sweatshirt-dominant; one stray child never licenses tee vocabulary', () => {
    expect(RESULT.familyGarmentFamily).toBe('sweatshirt')
    expect(RESULT.familyUnion).toEqual(['sweatshirt', 'hoodie'])
    expect(RESULT.familyUnion).not.toContain('tee')
    expect(RESULT.familyUnion).not.toContain('long_sleeve_tee')
    // GARMENT_UNION_DOMINANCE is what excludes it: 1 child of 34 is not a class of the family.
    expect(RESULT.familyByStyle).toEqual({ '6014': 1, '18000': 25, '18500': 9 })
  })

  it('each design group is judged against ITS OWN blank, not the family union', () => {
    const mh = RESULT.rows.find((r) => r.scope === 'MH')!
    expect(mh.garmentFamily).toBe('hoodie')                  // Mother Hustler ships hoodies only
    expect(mh.union).toEqual(['hoodie'])
    const bcs = RESULT.rows.find((r) => r.scope === 'BCS')!
    expect(bcs.garmentFamily).toBe('sweatshirt')
    // A hoodie group may say "Hooded"; a crewneck-only group may not.
    expect(norm(mh.title)).toMatch(/\bhood(?:ed|ie)\b/)
    expect(norm(bcs.title)).not.toMatch(/\bhood(?:ed|ie)\b/)
  })
})

describe('MIGRATION 062 — a SKU style code can be WRONG, and the PO must be able to say so', () => {
  const m = RESULT.mislabeledChild

  it('WITHOUT the assignment, BB64000XL-BK-FBA resolves to the WRONG blank entirely', () => {
    expect(m.withoutOverride).toBe('64000')                  // Gildan adult SHORT-sleeve tee — wrong
    expect(m.withoutOverrideSource).toBe('sku-code')
  })

  it('WITH the assignment it resolves to the PO-stated Comfort Colors 6014 long sleeve', () => {
    expect(m.withOverride).toBe('6014')
    expect(m.withOverrideSource).toBe('child-assignment')
    expect(RESULT.childAssignmentHits).toBe(1)
  })

  it('the resolution REPORTS its source — the four strings the portal renders as a badge', () => {
    // API surface (PO 2026-08-22): renaming any of these breaks the portal badge, so they are pinned.
    expect(['child-assignment', 'sku-code', 'family-assignment', 'legacy']).toContain(RESULT.familySource)
    expect(RESULT.familySource).toBe('sku-code')             // 34 of 35 children carry a real code
    // …and the per-child census separates "the PO said so" from "the SKU said so".
    expect(RESULT.bySource).toEqual({ 'sku-code': 34, 'child-assignment': 1 })
  })

  it("the child's OWN scope is a long_sleeve_tee even though its stored title says 'Sweatshirt'", () => {
    // The conflict gate would normally NULL this scope — every resolved row contradicts its own hay.
    // A PO override is a STATEMENT, not an inference, so it survives the gate.
    expect(m.ownGarmentFamily).toBe('long_sleeve_tee')
    expect(m.ownUnion).toEqual(['long_sleeve_tee'])
  })

  it('"Long Sleeve Shirt" is TRUE for that child and FALSE for the family — both at once', () => {
    expect(m.longSleeveShirtOnChild).toBe(true)
    expect(m.longSleeveShirtOnFamily).toBe(false)
  })

  it('the override still cannot license tee vocabulary for the PARENT title', () => {
    const parent = RESULT.rows.find((r) => r.scope === 'broadcast')!
    expect(norm(parent.title)).not.toMatch(/\bshirts?\b/)
  })
})

describe('THE POOL IS GATED, NOT TRUSTED — a pad that adds untrue material is the old bug', () => {
  it('the untrue pool phrases never reach any title', () => {
    for (const r of RESULT.rows) {
      expect(norm(r.title)).not.toContain('funny work shirts')
      expect(norm(r.title)).not.toContain('graphic sweatshirts for women')
      expect(norm(r.title)).not.toContain('tshirt for men')
    }
  })

  it('the predicate itself rejects the untrue phrases and accepts the true ones', () => {
    const sweats = { garmentFamily: 'sweatshirt' as const, mixedFamilies: ['sweatshirt', 'hoodie'] as const,
      spec: null, allowedBrand: null, audience: 'adult' as const, audienceLean: 'unisex' as const, field: 'title' as const }
    expect(phraseTruthVerdict('funny work shirts', sweats)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(phraseTruthVerdict('tshirt for men', sweats)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(phraseTruthVerdict('graphic sweatshirts for women', sweats)).toEqual({ ok: false, reason: 'audience-lean-lie' })
    expect(phraseTruthVerdict('fall crewneck', sweats)).toEqual({ ok: true })
    expect(phraseTruthVerdict('mind your business', sweats)).toEqual({ ok: true })
    expect(phraseTruthVerdict('long sleeve', sweats)).toEqual({ ok: true })
    expect(phraseTruthVerdict('pullover', sweats)).toEqual({ ok: true })
    expect(phraseTruthVerdict('crewneck', sweats)).toEqual({ ok: true })
  })

  it('at least one title carries a TRUTHFUL pool phrase — the additive half is real', () => {
    // The whole cure: #630/#631 restricted the pad to BLANK_SPECS facts and starved. If this ever
    // goes false, the pad is facts-only again and the band is one mixed-blank family from failing.
    const truePhrases = ['long sleeve', 'pullover', 'crewneck', 'fall crewneck', 'mind your business']
    const carriers = RESULT.rows.filter((r) => truePhrases.some((p) => norm(r.title).includes(p)))
    expect(carriers.length, 'no title used a truthful pool phrase — the pad is facts-only again').toBeGreaterThan(0)
  })
})

/**
 * PINS THE EXACT PRODUCED STRINGS — a future regression shows a byte diff here, not a re-derivation.
 * This is the number the design doc asked for directly: "Report the ACTUAL produced strings in your
 * final report — all seven." If any of these seven change, the change must be reviewed on purpose.
 */
describe('THE SEVEN STRINGS — pinned', () => {
  it('matches exactly, byte for byte', () => {
    const byScope = Object.fromEntries(RESULT.rows.map((r) => [r.scope, r.title]))
    expect(byScope.broadcast).toBe('THE CEO Motivational Entrepreneur | Long Sleeve Pullover Fall Crewneck')
    expect(byScope.BB).toBe('THE CEO Business B*tch Graphic Casual | Long Sleeve Pullover Fall Crewneck')
    expect(byScope.BCS).toBe('THE CEO Billionare Coming Soon Sweatshirt | Long Sleeve Pullover Crewneck')
    expect(byScope.DQ).toBe("THE CEO Don't Quit Sweatshirt | Long Sleeve Pullover Crewneck Gift Set")
    expect(byScope.ED).toBe('THE CEO Entrepreneur Definition Sweatshirt | Graphic Sweatshirts Pullover')
    expect(byScope.HD).toBe('THE CEO Hustle Definiton Sweatshirt | Long Sleeve Pullover Fall Crewneck')
    expect(byScope.MH).toBe('THE CEO Mother Hustler Hoodie | Long Sleeve Hooded Sweatshirt Cozy Gift')
  })

  it('DQ and MH are the two honest holds — pinned so a regression that makes them "succeed" differently is reviewed too', () => {
    const byScope = Object.fromEntries(RESULT.rows.map((r) => [r.scope, r]))
    expect(byScope.DQ.hold).toBe(true)
    expect(byScope.MH.hold).toBe(true)
    expect(byScope.broadcast.hold).toBe(false)
    expect(byScope.BB.hold).toBe(false)
    expect(byScope.BCS.hold).toBe(false)
    expect(byScope.ED.hold).toBe(false)
    expect(byScope.HD.hold).toBe(false)
  })
})

/**
 * NOTHING WRITES AFTER THE VERIFY (design doc requirement #6). The hard constraint: no stage may
 * modify the title after the terminal truth+band verify. Casing passes move BEFORE it (or are
 * provably case-only); any future writer added AFTER it is a bug by construction. Two independent
 * proofs, so a regression in either the source shape or the runtime behavior is caught:
 */
describe('NOTHING WRITES AFTER THE VERIFY — settleTitle is the DOOR, and it is the last writer', () => {
  it('RUNTIME: a verified, in-band, truthful title is a fixed point — settleTitle changes nothing further', () => {
    // If any code path between the terminal net's own verify and `settleTitle`'s return could still
    // mutate the string, feeding the door's own output back through the door would show a diff. It
    // never does, for any of the 7 rows — refilled AND held alike.
    for (const r of RESULT.rows) {
      expect(r.idempotent, `${r.scope}: "${r.title}" changed when re-settled`).toBe(true)
    }
  })

  it('SOURCE: the returned title is `settled.title` directly — no wrapping call sits between the terminal net and the return', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'titleBand.ts'), 'utf8')
    const settleTitleAt = src.indexOf('export function settleTitle(')
    expect(settleTitleAt, 'settleTitle must exist as the door').toBeGreaterThan(0)
    const settledCallAt = src.indexOf('const settled = enforceTitleTruthBand({', settleTitleAt)
    expect(settledCallAt, 'settleTitle must call enforceTitleTruthBand as its terminal net').toBeGreaterThan(settleTitleAt)
    const returnAt = src.indexOf('return { title: settled.title,', settledCallAt)
    expect(returnAt, 'the returned title must be settled.title directly — not wrapped by another writer').toBeGreaterThan(settledCallAt)
    // Nothing in this span may REASSIGN a string named `title`, or call a string-mutating method on
    // `settled.title` — the only permitted touches are READS (interpolated into log lines). A future
    // writer added here is exactly the bug class four prior attempts shipped; this fails CI on sight.
    const between = src.slice(settledCallAt, returnAt)
    expect(between).not.toMatch(/\btitle\s*=\s*(?!settled\.title)/)
    expect(between).not.toMatch(/settled\.title\s*\.\s*(replace|trim|slice|toUpperCase|toLowerCase|concat|padStart|padEnd)\(/)
  })
})
