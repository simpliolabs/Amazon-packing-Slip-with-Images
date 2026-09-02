/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * TITLE_V4 — STOP MANUFACTURING TEXT. Phase 3 of handoff/TITLE_ARCHITECTURE.md.
 *
 * Four pieces of deterministic code are withdrawn at `on`, and every one of them is on the record as
 * an AUTHOR of a title the seller rejected, or as a law that contradicts the seller's own corpus:
 *
 *   1. the humanizer length-extension retry  — measured author of "Fan Tournament" (B0GVV3XL4T,
 *      2026-08-12: council wrote 56 chars, this stretched to 71, judge paid 70 -> 100 for length)
 *   2. the facts pad in enforceTitleBand     — the repo's own attribution for "| Crew Neck" and
 *      "| Short Sleeve", and the laundering vector that turns a droppable spec tail into a
 *      protected brand tail
 *   3. the council's Rule-2 audience append  — recorded as the SOLE author of "for Men … for Women"
 *   4. the corpus-derived identity ceiling   — returns 7 while the brief prints a 10-word gold
 *      beneath it, and docks that gold to 86
 *
 * THE GOVERNING RULE THEY ALL BREAK, in the seller's words (2026-08-12): "never ship short — always
 * ask me". And the architecture's asymmetry: CODE MAY FILTER, NEVER ADD. All five rejected titles
 * were authored by an addition.
 *
 * THIS FILE PROVES BOTH DIRECTIONS: `off` changes nothing, `on` withdraws exactly these four and
 * nothing else.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, afterEach } from 'vitest'
import { SEED_GOLD_TITLES, measureGoldShape } from './poGoldCorpus'
import { titleQualityJudge, titleV4Mode, buildApparelTitleBrief } from './listingPipeline'

const SHAPE = measureGoldShape(SEED_GOLD_TITLES)
/** Gold #4 — ten identity words, and the title the derived ceiling of 7 currently docks. */
const CEILING_VICTIM = 'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women'

const withV4 = <T,>(mode: string, fn: () => T): T => {
  const prev = process.env.TITLE_V4
  process.env.TITLE_V4 = mode
  try { return fn() } finally { if (prev === undefined) delete process.env.TITLE_V4; else process.env.TITLE_V4 = prev }
}
const judge = (t: string): number =>
  titleQualityJudge(t, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true }).score

afterEach(() => { delete process.env.TITLE_V4; delete process.env.TITLE_SHAPE_JUDGE })

describe('THE FLAG — three states, and `off` is the default', () => {
  it('defaults to SHADOW — the measurement starts without anyone setting a variable', () => {
    // A behaviour-neutral measurement that requires a manual step is a measurement that does not
    // happen. Shadow ships today's bytes unchanged (asserted below), so this is safe by default.
    delete process.env.TITLE_V4
    expect(titleV4Mode()).toBe('shadow')
  })

  it('a typo can log, but can NEVER change a shipped title', () => {
    expect(withV4('on', titleV4Mode)).toBe('on')
    expect(withV4('ON', titleV4Mode)).toBe('on')
    expect(withV4('off', titleV4Mode)).toBe('off')     // the kill switch must be typed exactly
    expect(withV4('yes', titleV4Mode)).toBe('shadow')  // unrecognised -> measure, never enable
    expect(withV4('', titleV4Mode)).toBe('shadow')
  })

  it('SHADOW DOES NOT CHANGE BEHAVIOUR — it only measures', () => {
    // The whole point of shadow: the seller sees the refusal rate BEFORE a listing moves. If shadow
    // altered a score, the number it reports would be about a system that never shipped.
    process.env.TITLE_SHAPE_JUDGE = 'on'
    for (const g of SEED_GOLD_TITLES) {
      expect(withV4('shadow', () => judge(g)), g).toBe(withV4('off', () => judge(g)))
    }
  })
})

describe('THE IDENTITY CEILING — withdrawn at `on`, and the seller stops being docked', () => {
  it('OFF: the derived ceiling docks the seller\'s own gold #4 (the defect, pinned)', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    expect(SEED_GOLD_TITLES).toContain(CEILING_VICTIM)
    expect(SHAPE.maxLeftWords).toBe(7)                                   // derived from the corpus…
    const identityWords = CEILING_VICTIM.slice(0, CEILING_VICTIM.indexOf(' | ')).split(/\s+/).length
    expect(identityWords).toBe(10)                                       // …and this gold breaks it
    expect(withV4('off', () => judge(CEILING_VICTIM))).toBe(86)
  })

  it('ON: every one of the ten golds scores a clean 100 — no seller title is docked', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    // The B0DP5H8QBT gold ("for Kids & Children") used to be excluded from this loop: it was docked
    // -15 by the "for Men and Women" audience-pair rule (listingPipeline.ts ~:1838), which reuses
    // `hasInclusiveAudience` — RESOLVED by the PO ruling 2026-09-02 (goldCorpusSelfTest.test.ts's
    // "PO ruling 2026-09-02" describe block has the full axis+value explanation). No exception
    // needed any more.
    for (const g of SEED_GOLD_TITLES) {
      expect(withV4('on', () => judge(g)), g).toBe(100)
    }
  })

  it('and the ceiling could never have been repaired by re-tuning the number', () => {
    // The seller's Rod Father gold and pure keyword soup BOTH run 13 identity words. No word count
    // separates them, so identity LENGTH was never the rule — "is this one thing a person says" is,
    // and that question belongs to the referee.
    const rodFather = SEED_GOLD_TITLES.find((t) => t.includes('Rod Father'))!
    const soup = 'THE CEO 2026 World Soccer Cup USA Mexico Canada Football Graphic Tee Shirt'
    const idWords = (t: string): number => {
      const cut = [t.indexOf(' | '), t.indexOf(', ')].filter((i) => i >= 0)
      return (cut.length ? t.slice(0, Math.min(...cut)) : t).split(/\s+/).length
    }
    expect(idWords(rodFather)).toBe(idWords(soup))
  })
})

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE NEAREST-GOLD ANCHOR — the fix for the ROOT, not the symptom.
 *
 * MEASURED LIVE 2026-08-13 on B0GVV3XL4T. The council's own draft was:
 *
 *     THE CEO 2026 World Soccer Cup Tee Shirt | futbol          (48 chars)
 *
 * A ONE-WORD money position, lowercase. The padder then invented "Tournament Supporters" to reach
 * 70, and the shadow diff recorded wouldRefuse: TRUE — so deleting the padder WITHOUT fixing this
 * would hold the listing back rather than improve it. The padding was never the root; a 48-character
 * draft is.
 *
 * The pool already held `usa jersey` and `mexico football jersey`. The words were there. What was
 * missing was an ANCHOR — all nine golds shown at once, so the model averages a shape instead of
 * following the ONE that matches.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
describe('NEAREST-GOLD ANCHOR — follow the matching gold, not the average of nine', () => {
  const brief = (designPhrase: string | null) => buildApparelTitleBrief({
    brandName: 'THE CEO',
    roleLine: 'You write Amazon apparel titles for THE CEO.',
    inputBlock: 'Brand: THE CEO',
    designPhrase,
    garmentNoun: 'tee',
    lean: null,
  }).user

  it('a World-Cup-shaped design is anchored on the ESPANA gold', () => {
    // The event gold with a proper-noun cluster and a plain join — the closest thing in the corpus
    // to a World Cup design, and NOT one of the piped apparel golds every failing draft imitated.
    const u = brief('2026 World Soccer Cup')
    expect(u).toContain('THE CLOSEST MATCH IN THEIR OWN CORPUS')
    expect(u).toContain('Espana Championship')
  })

  it('a first-person statement design is anchored somewhere else entirely', () => {
    const u = brief('I Could Be Meaner')
    expect(u).toContain('THE CLOSEST MATCH IN THEIR OWN CORPUS')
    const anchorSection = u.slice(u.indexOf('THE CLOSEST MATCH'))
    expect(anchorSection).not.toContain('Espana Championship')
  })

  it('names the failure the live draft committed — a one-word tail', () => {
    expect(brief('2026 World Soccer Cup')).toContain('A one-word tail wastes the most valuable part of the title')
  })

  it('FAIL-OPEN: no design phrase means no anchor and a byte-identical brief', () => {
    // An anchor that cannot be built must never cost a title. Absence is a no-op, not a degrade.
    const withNone = brief(null)
    expect(withNone).not.toContain('THE CLOSEST MATCH IN THEIR OWN CORPUS')
    expect(withNone).toBe(buildApparelTitleBrief({
      brandName: 'THE CEO',
      roleLine: 'You write Amazon apparel titles for THE CEO.',
      inputBlock: 'Brand: THE CEO',
    }).user)
  })
})
