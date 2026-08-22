/**
 * truthBandGate.test.ts — THE GOLDEN-BAND MERGE GATE (PO 2026-08-22).
 *
 * THIS IS THE TEST THAT WOULD HAVE STOPPED THE REVERT. PRs #630/#631 shipped with a clean
 * typecheck, a green 74-file suite and 26 fresh pins written against the exact live strings — and
 * were pulled off production on the first regen, because every one of those pins asked "is this
 * rule enforced?" and none asked "how long is the string that comes out?". The truth rules were all
 * correct. The titles were 29-49 characters against a 70-75 band.
 *
 * A rule pin cannot catch that, because the failure was not in any rule. It was in the COMPOSITION:
 * a subtractive net with no additive counterpart can only shorten, and no test that exercises one
 * leaf at a time can see it. So this file runs the whole title path over a real family and asserts
 * on the RETURNED STRINGS — length first, because length is what was lost.
 *
 * WHAT IT PINS, per the PO's acceptance list, on every produced title:
 *   • 70-75 characters, or an explicit HOLD that preserves the live title (never a silent stub)
 *   • no "shirt(s)" on a sweatshirt-class design
 *   • no "for women" / "for men" on a unisex-lean family
 *   • no sibling design's name inside another design's title
 *   • no orphan fragment (the "Mind" class)
 *   • "Business B*tch" cased verbatim
 * …plus the per-child garment model and the migration-062 child override that proves it.
 */
import { describe, it, expect } from 'vitest'
import { runTruthBandHarness, DESIGNS, POOL, type HarnessResult } from './truthBandHarness'
import { TITLE_BAND_LO, TITLE_BAND_HI } from './titleBand'
import { phraseTruthVerdict } from './contentTruth'

const RESULT: HarnessResult = runTruthBandHarness()
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

describe('THE BAND — the invariant the reverted build lost', () => {
  it('EVERY produced title is 70-75 characters', () => {
    const lens = RESULT.rows.map((r) => `${r.scope}=${r.len}`)
    for (const r of RESULT.rows) {
      expect(r.len, `${r.scope} shipped ${r.len} chars: "${r.title}" (all: ${lens.join(' ')})`)
        .toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(r.len, `${r.scope} shipped ${r.len} chars: "${r.title}"`).toBeLessThanOrEqual(TITLE_BAND_HI)
    }
  })

  it('every title reached the band by RE-FILLING from true material — not one refusal on this family', () => {
    // The refusal path is correct and must exist, but a family with this much true material should
    // never need it. A regression that starves the pad shows up HERE first, as a hold.
    for (const r of RESULT.rows) {
      expect(r.decision, `${r.scope}: ${r.reason}`).toBe('refilled')
      expect(r.hold, `${r.scope} raised a hold: ${r.reason}`).toBe(false)
    }
  })

  it('the truth net genuinely CUT these titles first — the band was restored, not merely never lost', () => {
    // Guards the trivial pass: if the net stopped removing anything, every title would be "in band"
    // and this whole file would go green while the spine did nothing at all.
    const cut = RESULT.rows.filter((r) => r.title !== r.produced)
    expect(cut.length).toBe(RESULT.rows.length)
    // …and at least one title was cut deeply enough that a single fact could never have restored it,
    // which is the exact case greedy one-segment padding dead-ended on.
    expect(RESULT.rows.some((r) => /re-filled (\d+)/.test(r.reason) && Number(RegExp.$1) < 45)).toBe(true)
  })
})

describe('THE TRUTH — every rule the reverted build got right, still enforced', () => {
  it('no sweatshirt-class design says "shirt" or "shirts"', () => {
    for (const r of RESULT.rows) {
      if (r.garmentFamily !== 'sweatshirt' && r.garmentFamily !== 'hoodie') continue
      expect(norm(r.title), `${r.scope}: "${r.title}"`).not.toMatch(/\bshirts?\b/)
    }
  })

  it('no title forces a gender on a unisex-lean family', () => {
    for (const r of RESULT.rows) {
      expect(norm(r.title), `${r.scope}: "${r.title}"`).not.toMatch(/\bfor (?:women|men)\b/)
      expect(norm(r.title), `${r.scope}: "${r.title}"`).not.toMatch(/\b(?:womens|mens|ladies)\b/)
    }
  })

  it('no design carries a SIBLING design name (the "Business B*tch" contamination)', () => {
    for (const r of RESULT.rows) {
      if (r.scope === 'broadcast') continue                 // the parent is answerable to every design
      const own = DESIGNS.find((d) => d.key === r.scope)!
      for (const sib of DESIGNS) {
        if (sib.key === own.key) continue
        // Compare on the sibling's DISTINCTIVE token, not its whole name: a one-word overlap
        // ("Business" in both "Business B*tch" and "Small Business Owner Gift") is shared vocabulary.
        expect(norm(r.title), `${r.scope} carries ${sib.name}: "${r.title}"`).not.toContain(norm(sib.name))
      }
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
    // The specimen, explicitly: the produced BB title ended ", Mind" and the shipped one must not.
    const bb = RESULT.rows.find((r) => r.scope === 'BB')!
    expect(bb.produced).toMatch(/, Mind$/)
    expect(bb.title).not.toMatch(/\bMind$/)
  })

  it('the seller\'s censored design name ships VERBATIM — "Business B*tch", never "B*Tch"', () => {
    const bb = RESULT.rows.find((r) => r.scope === 'BB')!
    expect(bb.produced).toContain('Business B*Tch')          // the council mangles it…
    expect(bb.title).toContain('Business B*tch')             // …and the door ships it correctly
    expect(bb.title).not.toContain('B*Tch')
  })

  it('no title re-states one concept in two spellings ("Crewneck" + "Crew Neck")', () => {
    for (const r of RESULT.rows) {
      const w = norm(r.title).split(' ').filter(Boolean)
      const seen = new Set<string>()
      for (let i = 0; i < w.length; i++) {
        for (let n = 1; n <= 3 && i + n <= w.length; n++) {
          const flat = w.slice(i, i + n).join('')
          if (n > 1 && seen.has(flat)) expect.unreachable(`${r.scope} repeats the concept "${flat}": "${r.title}"`)
        }
        seen.add(w[i])
      }
    }
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
  it('the three untrue pool phrases never reach any title', () => {
    for (const r of RESULT.rows) {
      expect(norm(r.title)).not.toContain('funny work shirts')
      expect(norm(r.title)).not.toContain('graphic sweatshirts for women')
    }
  })

  it('the predicate itself rejects them for the family, and accepts the true ones', () => {
    const sweats = { garmentFamily: 'sweatshirt' as const, mixedFamilies: ['sweatshirt', 'hoodie'] as const,
      spec: null, allowedBrand: null, audience: 'adult' as const, audienceLean: 'unisex' as const, field: 'title' as const }
    expect(phraseTruthVerdict('funny work shirts', sweats)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(phraseTruthVerdict('graphic sweatshirts for women', sweats)).toEqual({ ok: false, reason: 'audience-lean-lie' })
    expect(phraseTruthVerdict('fall crewneck', sweats)).toEqual({ ok: true })
    expect(phraseTruthVerdict('mind your business', sweats)).toEqual({ ok: true })
  })

  it('at least one title carries a TRUTHFUL pool phrase — the additive half is real', () => {
    // The whole cure: #630/#631 restricted the pad to BLANK_SPECS facts and starved. If this ever
    // goes false, the pad is facts-only again and the band is one mixed-blank family from failing.
    const truePhrases = ['mind your business', 'fall crewneck', 'cozy fleece pullover', 'small business owner gift']
    const carriers = RESULT.rows.filter((r) => truePhrases.some((p) => norm(r.title).includes(p)))
    expect(carriers.length, 'no title used a truthful pool phrase — the pad is facts-only again').toBeGreaterThan(0)
  })
})

/**
 * THE SECOND LIVE GATE (parent-title-truth fix, PO 2026-08-22). A REAL `regenerate_section:'title'`
 * POST on this SAME B0DSCDZC6K family, live sha 42451a7, WITH #632 AND #634 already deployed — the
 * fix the pins above cover. Despite that, the PARENT still shipped a garment lie ("…Entrepreneur
 * Tee") and a forced gender ("…for Men") on a unisex family, FOUR per-design titles still carried
 * the "Business B*tch" sibling name, and one design named two garment classes at once ("…Shirt
 * Sweatshirt Long Sleeve Tee"). Three producer-side/net-side root causes, one shared seam each:
 *   1. `applyTitleTruthNet` never judged segment 0 (the money phrase), only kept-or-dropped it whole.
 *   2. `buildNicheParentTitle`'s own "Product type" brief line came from Amazon's raw productType,
 *      and the money-tail candidate derivation never asked the truth spine at all.
 *   3. nothing rejected a truthful SECOND garment class, in the net OR in the band pad.
 * See truthBandHarness.ts's `LIVE_PARENT_TITLE`/`LIVE_TITLES`/`liveRows` for the fixture + runner.
 */
describe('THE SECOND LIVE GATE — parent-title-truth fix (sha 42451a7, WITH #632+#634 deployed)', () => {
  /** Independent of the implementation's own `dominantGarmentGroup` — a title should never trip
   *  more than one of these three groups, however the code decides it. */
  const garmentClassesIn = (title: string): Set<string> => {
    const groups: Record<string, RegExp> = {
      tee: /\b(?:t[-\s]?shirts?|tshirts?|tees?)\b/i,
      sweatshirt: /\b(?:sweatshirts?|crewnecks?|pullovers?)\b/i,
      hoodie: /\b(?:hoodies?|hoodys?|hooded)\b/i,
    }
    const out = new Set<string>()
    for (const [cls, re] of Object.entries(groups)) if (re.test(title)) out.add(cls)
    return out
  }

  it('the PARENT never contains tee/tshirt for this sweatshirt+hoodie family', () => {
    const parent = RESULT.liveRows.find((r) => r.scope === 'broadcast')!
    expect(norm(parent.title), parent.title).not.toMatch(/\b(?:tees?|tshirts?|t-?shirts?)\b/)
  })

  it('the PARENT asserts no "for Men"/"for Women" — the family lean is unisex', () => {
    const parent = RESULT.liveRows.find((r) => r.scope === 'broadcast')!
    expect(norm(parent.title), parent.title).not.toMatch(/\bfor (?:women|men)\b/)
    expect(norm(parent.title), parent.title).not.toMatch(/\b(?:womens|mens|ladies)\b/)
  })

  it('no title carries a SIBLING design name (the live "Business B*tch" leak, x4)', () => {
    for (const r of RESULT.liveRows) {
      if (r.scope === 'broadcast') continue                 // the parent is answerable to every design
      const own = DESIGNS.find((d) => d.key === r.scope)!
      for (const sib of DESIGNS) {
        if (sib.key === own.key) continue
        expect(norm(r.title), `${r.scope} carries ${sib.name}: "${r.title}"`).not.toContain(norm(sib.name))
      }
    }
  })

  it('no title names two garment classes — even two both-true ones (sweatshirt + hoodie)', () => {
    for (const r of RESULT.liveRows) {
      const classes = garmentClassesIn(r.title)
      expect(classes.size, `${r.scope} names ${[...classes].join('+')}: "${r.title}"`).toBeLessThanOrEqual(1)
    }
  })

  it('the band + hold behavior still holds — every live title reaches 70-75 from true material', () => {
    for (const r of RESULT.liveRows) {
      expect(r.len, `${r.scope}: "${r.title}"`).toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(r.len, `${r.scope}: "${r.title}"`).toBeLessThanOrEqual(TITLE_BAND_HI)
      expect(r.decision, `${r.scope}: ${r.reason}`).toBe('refilled')
      expect(r.hold, `${r.scope} raised a hold: ${r.reason}`).toBe(false)
    }
  })

  it('pins the EXACT fixed strings — a future regression shows a byte diff here, not a re-derivation', () => {
    const byScope = Object.fromEntries(RESULT.liveRows.map((r) => [r.scope, r.title]))
    expect(byScope.broadcast).toBe('THE CEO Motivational Entrepreneur | Mind Your Business Long Sleeve Pullover')
    expect(byScope.BB).toBe('THE CEO Business B*tch Funny Work Sweatshirt Long Sleeve | Fall Crewneck')
    expect(byScope.BCS).toBe('THE CEO Billionare Coming Soon Sweatshirt | Pullover Long Sleeve Crewneck')
    expect(byScope.DQ).toBe("THE CEO Don't Quit Sweatshirt | Long Sleeve Pullover Mind Your Business")
    expect(byScope.ED).toBe('THE CEO Entrepreneur Definition Sweatshirt | Fall Crewneck Long Sleeve')
    expect(byScope.HD).toBe('THE CEO Hustle Definiton Sweatshirt | Long Sleeve Fall Crewneck Pullover')
    expect(byScope.MH).toBe('THE CEO Mother Hustler Sweatshirt | Long Sleeve Small Business Owner Gift')
  })
})
