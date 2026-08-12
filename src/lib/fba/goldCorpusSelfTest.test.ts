/**
 * goldCorpusSelfTest — the judge scored against the seller's OWN corpus, plus the attack titles.
 *
 * THE PO'S QUESTION, VERBATIM (2026-08-11): "AGAIN, why rules and And NO Council and Judge having
 * gold standards to build from?"
 *
 * THE MEASURED ANSWER, pinned below as the BEFORE state: the deterministic judge that picks every
 * shipped title scores the seller's own canonical golds at 55/100 and 80/100 — docked by
 * hand-written taste rules ("funny" ban, sub-70 floor) the seller never made — while scoring a
 * spec-stuffed attack title at a PERFECT 100/100, because no predicate recognised "crew neck" /
 * "garment dyed" as spec vocabulary.
 *
 * This file exists in two eras:
 *   PR-A (now): PINS the defective before-state exactly, so the defect is a recorded fact and any
 *     drift is caught. The BEFORE-STATE describe block is the seller's answer, in numbers.
 *   PR-C: flips these assertions — every gold must score >= its pre-change score, and every attack/
 *     reject must score STRICTLY below every gold. The AFTER contract is written at the bottom,
 *     skipped, ready to be enabled.
 *
 * All fixture strings are verbatim: golds from the seller's 2026-08-11 message; attacks from the
 * adversarial break that defeated the first draft of the brief rebuild; rejects from the titles the
 * seller called "STILL BAD" / "WAY off".
 */
import { describe, it, expect, afterEach } from 'vitest'
import { SEED_GOLD_TITLES, measureGoldShape, specClaimSpans, attestedUse } from './poGoldCorpus'
import { dropSpecOnlyTail, stripInclusiveAudience, stripTitleWasteVocabulary } from './titleBand'
import { buildApparelTitleBrief, titleQualityJudge } from './listingPipeline'

const SHAPE = measureGoldShape(SEED_GOLD_TITLES)
const score = (t: string) => titleQualityJudge(t, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords }).score
/** PR-C scoring: the full corpus shape threaded, apparel-gated — what the live producers now pass. */
const scoreC = (t: string) => titleQualityJudge(t, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true }).score

/** The adversary's winning titles: spec-stuffed garbage that fully complied with the first-draft
 *  brief. ATTACK_A scored 100/100 with ZERO recorded problems. */
const ATTACK_A = 'THE CEO 2026 Soccer Cup Garment Dyed Crew Neck Tee | Comfort Colors Shirt'
const ATTACK_B = 'THE CEO 2026 World Soccer Cup Short Sleeve Tee | Comfort Colors Shirt'
/** The seller's real rejections, in their words: "STILL BAD" / "WAY off from my recommended title". */
const REJECT_1 = 'THE CEO 2026 World Soccer Cup Unisex Classic Fit Fan Shirt | Short Sleeve'
const REJECT_2 = 'THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee | Crew Neck'

afterEach(() => { delete process.env.TITLE_SHAPE_JUDGE })

describe('BEFORE STATE (pinned at PR-A) — the hand-written rules dock the seller and reward the attack', () => {
  it('the judge docks TWO of the seller\'s own canonical golds', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    const scores = SEED_GOLD_TITLES.map(score)
    // Gold #7 ("| Funny Comfort Colors Shirt…", 78 chars): 55 — docked for Amazon's cap (a real,
    // external rule) AND for "funny" (a taste rule the seller's own corpus attests x2).
    expect(scores[6]).toBe(55)
    // Gold #9 ("…Funny Fishing Mens Graphic Tee for Men", 69 chars): 80 — docked for being under
    // OUR floor (the seller's own gold breaks it) AND for "funny" again.
    expect(scores[8]).toBe(80)
    // The other seven score 100 — the docks are not noise; they single out exactly the two golds
    // that use the seller's vocabulary the hand-written list bans.
    expect(scores.filter((s) => s === 100).length).toBe(7)
  })

  it('the spec-stuffed ATTACK outscores the seller\'s own golds — the defect in one line', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    expect(score(ATTACK_A)).toBe(100)   // zero recorded problems, today
    expect(score(ATTACK_B)).toBe(90)
    // Both attacks score >= the seller's gold #9 and > gold #7. The scorer prefers fabricated
    // spec-stuffing over the seller's actual taste. THIS is why titles kept coming back wrong.
    expect(score(ATTACK_A)).toBeGreaterThan(score(SEED_GOLD_TITLES[6]))
    expect(score(ATTACK_A)).toBeGreaterThan(score(SEED_GOLD_TITLES[8]))
  })

  it('the seller\'s explicit rejections still score in the 75-80 band — not separated from taste', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    expect(score(REJECT_1)).toBe(80)
    expect(score(REJECT_2)).toBe(75)
  })
})

describe('the keystone predicate — specClaimSpans names the poison the judge cannot see', () => {
  it('identifies every spec claim in the attack and reject titles', () => {
    expect(specClaimSpans(ATTACK_A).sort()).toEqual(['crew neck', 'garment dyed'])
    expect(specClaimSpans(ATTACK_B)).toEqual(['short sleeve'])
    expect(specClaimSpans(REJECT_1).sort()).toEqual(['classic fit', 'short sleeve', 'unisex'])
    expect(specClaimSpans(REJECT_2).sort()).toEqual(['crew neck', 'unisex'])
  })

  it('does NOT flag design language that merely shares a word with a spec claim', () => {
    expect(specClaimSpans('THE CEO Classic Car Shirt | Comfort Colors Tee')).toEqual([])
    expect(specClaimSpans('THE CEO Short Story Club Tee | Book Lover Shirt')).toEqual([])
    expect(specClaimSpans('THE CEO Crew Love Boat Tee')).toEqual([])   // 'crew' without 'neck'
  })

  it('attestation separates the seller\'s vocabulary from the fabricated kind', () => {
    const att = attestedUse(SEED_GOLD_TITLES, ['funny', 'graphic', 'long sleeve', 'unisex', 'classic fit', 'crew neck', 'short sleeve', 'garment dyed'])
    expect(att.get('funny')!.length).toBe(2)          // the seller's own words — a ban list that
    expect(att.get('graphic')!.length).toBe(3)        // docks these is fighting their taste
    expect(att.get('long sleeve')!.length).toBe(1)    // attested ONCE, in the identity position
    for (const zero of ['unisex', 'classic fit', 'crew neck', 'short sleeve', 'garment dyed']) {
      expect(att.get(zero)!.length, zero).toBe(0)     // never once in nine golds — not their voice
    }
  })
})

/**
 * THE AFTER CONTRACT — LIVE since PR-C: the judge derives its terms from the corpus (attestation
 * vocabulary, corpus length floor, classifyTail money dock, adjacency-collapsed noun rule). The
 * BEFORE block above still passes because it scores WITHOUT `shape` threaded — that legacy arm is
 * exactly what un-shaped callers still get, and pinning it documents the difference the corpus makes.
 */
describe('AFTER (PR-C, live): the corpus outranks every hand-written rule', () => {
  it('every cap-compliant gold scores a clean 100 — zero TASTE docks remain', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    for (const g of SEED_GOLD_TITLES) {
      if (g.length > 75) continue              // gold #7 (78 chars): Amazon's cap is a SHIP rule, not taste
      expect(scoreC(g), g).toBe(100)
    }
    // Gold #9 (69 chars, "funny"): scored 80 under the hand-typed rules. The corpus floor is 69 and
    // "funny" is the seller's attested voice — no dock survives.
    expect(scoreC(SEED_GOLD_TITLES[8])).toBe(100)
  })

  it('every attack and reject scores STRICTLY below every cap-compliant gold', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    const worstCompliantGold = Math.min(...SEED_GOLD_TITLES.filter((g) => g.length <= 75).map(scoreC))
    for (const bad of [ATTACK_A, ATTACK_B, REJECT_1, REJECT_2]) {
      expect(scoreC(bad), `${bad} => ${scoreC(bad)} vs gold floor ${worstCompliantGold}`).toBeLessThan(worstCompliantGold)
    }
  })

  it('the docks NAME the poison: unattested spec vocabulary + spec-only money position', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    const r = titleQualityJudge(REJECT_2, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true })
    expect(r.problems.join(' ; ')).toMatch(/spec vocabulary the seller never uses/)
    expect(r.problems.join(' ; ')).toMatch(/money position holds only spec facts/)
  })
})

describe('PR-B acceptance — no hand-typed shape rule survives in the rendered brief', () => {
  const b = buildApparelTitleBrief({
    brandName: 'THE CEO',
    roleLine: 'You write Amazon apparel titles for THE CEO.',
    inputBlock: 'Brand: THE CEO\nDesign phrase: World Soccer Cup',
  })

  it('the deleted template is GONE: no PATTERN A/B, no [Variant/Attribute] slot, no 70-75 mandate', () => {
    for (const banned of ['PATTERN A', 'PATTERN B', 'Variant/Attribute', '70-75', 'Category brand goes AFTER', 'Long Sleeve Shirt"']) {
      expect(b.user, banned).not.toContain(banned)
      expect(b.system, banned).not.toContain(banned)
    }
  })

  it('every shape statement is a measurement from the corpus', () => {
    expect(b.user).toContain('length 69-78 characters, median 74')
    expect(b.user).toContain('5 of 9 use " | "')
    expect(b.user).toContain('0 spec-only')
    expect(b.user).toContain('never more than 10 (measured over 5)')
  })

  it('carries the genuine rejects with the seller\'s verbatim words', () => {
    expect(b.user).toContain('STILL BAD')
    expect(b.user).toContain('crew neck can go on highlights')
    expect(b.user).not.toContain('See You Later Alligator Shirt | Long Sleeve')   // never fabricate a rejection
  })

  it('the honest-short instruction replaces the pad-to-band mandate', () => {
    expect(b.user).toContain('A shorter honest title IS the correct output')
    expect(b.user).not.toMatch(/never below 70|hard goal/i)
  })
})

/**
 * THE THREE LIVE REJECTIONS, as regression fixtures. Each shipped to the seller and each was
 * rejected in their own words. The door must now clean all three — and the four seller golds that
 * carry a legitimate tail must pass through untouched.
 */
describe('the seller\'s three rejected titles cannot recur', () => {
  const band = { apparel: true, garmentBrand: '', spec: { fit: 'Classic Fit', sleeve: 'Short Sleeve', neck: 'Crew Neck' }, garmentSecond: 'Tee' }
  const chain = (t: string) => {
    const a = stripInclusiveAudience(t)
    const w = stripTitleWasteVocabulary(a, { apparel: true, band: band as never, moneyKws: null, money: null }).title
    return dropSpecOnlyTail(w, { apparel: true, specValues: ['classic fit', 'short sleeve', 'crew neck'] }).title
  }

  it.each([
    ['STILL BAD',              'THE CEO 2026 World Soccer Cup Unisex Classic Fit Fan Shirt | Short Sleeve'],
    ['Still Bad after regen',  'THE CEO 2026 World Soccer Cup Tee for Men and Women Fans | Short Sleeve'],
    ['EVEN WORSE',             'THE CEO 2026 World Soccer Cup Unisex Tee for Men & Women Fans | Shirt'],
    ['WAY off',                'THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee | Crew Neck'],
  ])('%s — banned vocabulary, the universal tail, and the weak money position all go', (_verdict, title) => {
    const out = chain(title)
    expect(out, 'waste vocabulary').not.toMatch(/\b(unisex|classic\s+fit)\b/i)
    expect(out, 'universal audience tail').not.toMatch(/\bfor\s+men\s*(?:and|&|\+|,)?\s*women\b/i)
    expect(out, 'spec-only money position').not.toMatch(/\|\s*(short sleeve|crew neck|classic fit|shirt|tee)\s*$/i)
    expect(out.length).toBeLessThanOrEqual(75)
  })

  it('the seller\'s own tails are NEVER dropped — brand and search positions survive', () => {
    for (const g of SEED_GOLD_TITLES.filter((t) => t.includes(' | '))) {
      expect(dropSpecOnlyTail(g, { apparel: true }).decision, g).toBe('kept')
      expect(dropSpecOnlyTail(g, { apparel: true }).title, g).toBe(g)
    }
  })
})
