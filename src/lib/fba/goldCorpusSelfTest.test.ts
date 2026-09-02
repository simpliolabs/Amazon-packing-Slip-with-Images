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
import { SEED_GOLD_TITLES, classifyTail, measureGoldShape, specClaimSpans, attestedUse } from './poGoldCorpus'
import { collapseRepeatedWords, dropSpecOnlyTail, hasInclusiveAudience, stripInclusiveAudience, stripTitleWasteVocabulary } from './titleBand'
import { buildApparelTitleBrief, titleQualityJudge } from './listingPipeline'

const SHAPE = measureGoldShape(SEED_GOLD_TITLES)
const score = (t: string) => titleQualityJudge(t, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords }).score
/** PR-C scoring: the full corpus shape threaded, apparel-gated — what the live producers now pass. */
const scoreC = (t: string) => titleQualityJudge(t, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true }).score

/** Gold #4 — the title the corpus-derived left-word ceiling now rejects, though it is IN the corpus
 *  the ceiling was derived from. Named once, used by the AFTER contract and by the defect block. */
const CEILING_VICTIM = 'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women'

/** The adversary's winning titles: spec-stuffed garbage that fully complied with the first-draft
 *  brief. ATTACK_A scored 100/100 with ZERO recorded problems. */
const ATTACK_A = 'THE CEO 2026 Soccer Cup Garment Dyed Crew Neck Tee | Comfort Colors Shirt'
const ATTACK_B = 'THE CEO 2026 World Soccer Cup Short Sleeve Tee | Comfort Colors Shirt'
/** The seller's real rejections, in their words: "STILL BAD" / "WAY off from my recommended title". */
const REJECT_1 = 'THE CEO 2026 World Soccer Cup Unisex Classic Fit Fan Shirt | Short Sleeve'
const REJECT_2 = 'THE CEO 2026 World Soccer Cup USA, Mexico & Canada Unisex Tee | Crew Neck'

/* THE CORPUS AS IT STOOD AT PR-A, FROZEN AS LITERALS.
 *
 * These BEFORE-state assertions pin exact scores to document a historical defect. They used to read
 * the LIVE `SEED_GOLD_TITLES`, which means every future seller revision silently rewrote the past —
 * and on 2026-08-12 it did: the seller trimmed their over-cap gold #7 and seven of these tests went
 * red, not because the history changed but because the constant did. History is now a literal.
 * Only the AFTER blocks read the live corpus, which is the only place a corpus change SHOULD land. */
const CORPUS_AT_PR_A: readonly string[] = [
  'THE CEO Later Alligator Long Sleeve Shirt, Later Gator Comfort Colors Shirt',
  'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup',
  'THE CEO Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men',
  'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women',
  'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women',
  'THE CEO Cupid Valentine Tee Shirt | Comfort Colors Graphic Tshirt for Women',
  'THE CEO I Could Be Meaner Tee Shirt | Funny Comfort Colors Shirt for Men Women', // 78 — PO-revised 2026-08-12
  "THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women, Rodeo Shirt",
  'THE CEO The Rod Father T-Shirt Funny Fishing Mens Graphic Tee for Men',
]
const SHAPE_AT_PR_A = measureGoldShape(CORPUS_AT_PR_A)
const scoreA = (t: string) => titleQualityJudge(t, { brandName: 'THE CEO', maxLeftWords: SHAPE_AT_PR_A.maxLeftWords }).score

afterEach(() => { delete process.env.TITLE_SHAPE_JUDGE })

describe('BEFORE STATE (pinned at PR-A) — the hand-written rules dock the seller and reward the attack', () => {
  it('the judge docks TWO of the seller\'s own canonical golds', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    const scores = CORPUS_AT_PR_A.map(scoreA)
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
    expect(scoreA(ATTACK_A)).toBe(100)   // zero recorded problems, today
    expect(scoreA(ATTACK_B)).toBe(90)
    // Both attacks score >= the seller's gold #9 and > gold #7. The scorer prefers fabricated
    // spec-stuffing over the seller's actual taste. THIS is why titles kept coming back wrong.
    expect(scoreA(ATTACK_A)).toBeGreaterThan(scoreA(CORPUS_AT_PR_A[6]))
    expect(scoreA(ATTACK_A)).toBeGreaterThan(scoreA(CORPUS_AT_PR_A[8]))
  })

  it('the seller\'s explicit rejections still score in the 75-80 band — not separated from taste', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    expect(scoreA(REJECT_1)).toBe(80)
    expect(scoreA(REJECT_2)).toBe(75)
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
  it('EVERY gold is now cap-compliant — the seller\'s 2026-08-12 revision removed the last exception', () => {
    // The `if (g.length > 75) continue` guard this test used to carry is GONE, and that is the point:
    // the corpus no longer contains a title we could never ship. It also removes the contradiction
    // inside the council prompt, which printed a 78-char exemplar directly beneath "75 characters
    // maximum, counted exactly".
    for (const g of SEED_GOLD_TITLES) expect(g.length, g).toBeLessThanOrEqual(75)
  })

  it('no TASTE dock survives — every gold the derived ceiling admits scores a clean 100', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    // Gold #4 is excluded here for the identity ceiling (a live defect, pinned in its own block
    // below). The 2026-09-02 B0DP5H8QBT gold (PR #663) is excluded for a DIFFERENT, already-
    // documented reason: it is docked -15 by the "for Men and Women" audience-pair rule
    // (listingPipeline.ts ~:1837), which reuses `hasInclusiveAudience` — the SAME analyzer gap this
    // file's "EVERY seller gold passes through the analyzer byte-identical" test documents (a
    // conjunction-joined 'kids'/'children' trips the same shape as the pinned "Adults and Kids"
    // attack). Reported for a PO ruling, not force-fixed here.
    const KNOWN_GAP = "THE CEO Don't Quit Tee Shirt | Motivational T-shirt for Kids & Children"
    for (const g of SEED_GOLD_TITLES) {
      if (g === CEILING_VICTIM) continue
      if (g === KNOWN_GAP) { expect(scoreC(g), g).toBe(86); continue }
      expect(scoreC(g), g).toBe(100)
    }
    // Gold #9 (69 chars, "funny"): scored 80 under the hand-typed rules. The corpus floor is 68 and
    // "funny" is the seller's attested voice — no dock survives.
    expect(scoreC(SEED_GOLD_TITLES[8])).toBe(100)
    // Gold #7, revised by the seller to 68 chars, is no longer docked by the cap at all.
    expect(scoreC(SEED_GOLD_TITLES[6])).toBe(100)
  })

  it('QUANTIFIED (coordinator ask, PR #663 review, 2026-09-02): the audience-pair dock is real (-15), and the PO gold STILL outscores the machine title it replaced despite carrying it', () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    const GOLD = "THE CEO Don't Quit Tee Shirt | Motivational T-shirt for Kids & Children"
    // The B0DP5H8QBT machine-produced title this gold replaced — the reported live defect, scored
    // RAW (titleQualityJudge does not itself run scrubUnspecdGarmentClaims; that is a SEPARATE
    // terminal-net stage — this measures the raw candidate's own quality, same as every other score
    // in this file).
    const MACHINE_TITLE_REPLACED = "THE CEO Don't Quit Motivational T-Shirt | Kids Oversized Tshirts Crew Neck"

    const goldResult = titleQualityJudge(GOLD, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true })
    const machineResult = titleQualityJudge(MACHINE_TITLE_REPLACED, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true })

    // THE DOCK IS REAL: exactly one problem, the audience-pair analyzer gap (goldCorpusSelfTest's
    // "EVERY seller gold passes through the analyzer byte-identical" test documents WHY it fires).
    expect(goldResult.problems).toEqual(['"for Men and Women" — 0 of 10 seller golds carry it (-15)'])
    expect(goldResult.score).toBe(86)

    // THE ANSWER: despite carrying that -15 dock, the PO's gold (86) still outscores the machine
    // title it replaced (76) — the machine title carries the SAME audience-pair dock PLUS an
    // unattested-vocabulary dock ("crew neck" is not corpus-attested prose vocabulary). Reported for
    // the PO ruling on the analyzer gap; NOT a claim that the dock should stay — only that it does
    // not invert the comparison this gold exists to make.
    expect(machineResult.score).toBe(76)
    expect(goldResult.score).toBeGreaterThan(machineResult.score)

    // Without the analyzer gap, the margin would be 24 points (100 vs 76), not 10 — the gap costs
    // the gold real ground, even though it does not lose the comparison outright.
    const scoreWithoutGapHypothetically = 100
    expect(scoreWithoutGapHypothetically - machineResult.score).toBe(24)
    expect(goldResult.score - machineResult.score).toBe(10)
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

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * LIVE DEFECT (surfaced 2026-08-12) — A CORPUS-DERIVED LAW THAT REJECTS ITS OWN CORPUS.
 *
 * The seller trimmed ONE WORD from gold #7 ("Tee Shirt" -> "Tee"). That flipped an outlier test
 * inside `measureGoldShape` and dropped `maxLeftWords` from 10 to 7:
 *
 *   piped left counts BEFORE: [10, 8, 6, 6, 4]  ->  10 > 8+2 is FALSE  -> trimmedMax = 10
 *   piped left counts AFTER:  [10, 7, 6, 6, 4]  ->  10 > 7+2 is TRUE   -> trimmedMax = 7  (runner-up)
 *
 * `goldBriefBlock` prints that number to the council as a hard law ("never more than N"). So the
 * brief now instructs the producer never to exceed 7 identity words while displaying, directly
 * beneath, a 10-word gold. The law and the examples contradict each other inside one prompt — the
 * same failure mode the 78-char exemplar had, arriving through a different door.
 *
 * WHY THIS IS NOT FIXED HERE. `measureGoldShape`'s left-segment statistic has already been amended
 * twice (the piped-subset correction, then MIN_PIPED_SAMPLE + trimmedMax). A third amendment is the
 * repeat-fix circuit breaker firing, and the architecture (handoff/TITLE_ARCHITECTURE.md) deletes
 * the ceiling outright: identity length CANNOT be the rule, because the seller's Rod Father gold and
 * the keyword soup both run 13 words. Patching the number would make this test green and leave the
 * wrong idea in place. It is pinned instead, so it cannot drift unnoticed and cannot be forgotten.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
describe('LIVE DEFECT — the derived ceiling rejects a gold it was derived from', () => {
  it("one trimmed word moved the council's stated ceiling by three", () => {
    expect(SHAPE_AT_PR_A.maxLeftWords).toBe(10)
    expect(SHAPE.maxLeftWords).toBe(7)
  })

  it('gold #4 is IN the corpus and VIOLATES the ceiling measured from it', () => {
    expect(SEED_GOLD_TITLES).toContain(CEILING_VICTIM)
    const identityWords = CEILING_VICTIM.slice(0, CEILING_VICTIM.indexOf(' | ')).split(/\s+/).length
    expect(identityWords).toBe(10)
    expect(identityWords).toBeGreaterThan(SHAPE.maxLeftWords)
  })

  it("and the judge therefore docks it — a gold scored below 100 by the seller's own corpus", () => {
    process.env.TITLE_SHAPE_JUDGE = 'on'
    expect(scoreC(CEILING_VICTIM)).toBe(86)
  })

  it.fails('THE INVARIANT THAT MUST HOLD: no statistic derived from the corpus may reject a member of it', () => {
    // Written as `it.fails` because it does not hold today. It starts failing — loudly — the moment
    // the architecture deletes the ceiling, which is the signal to flip it to a plain `it`.
    const lefts = SEED_GOLD_TITLES.filter((t) => t.includes(' | '))
      .map((t) => t.slice(0, t.indexOf(' | ')).split(/\s+/).length)
    expect(Math.max(...lefts)).toBeLessThanOrEqual(SHAPE.maxLeftWords)
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
    // These numbers MOVE when the seller edits a gold, and that is correct — they are measurements,
    // not policy. Updated 2026-09-02 after PR #663 added the PO's B0DP5H8QBT attribute-truth gold
    // (10th seed; 6 of 10 now pipe, up from 5 of 9 — see poGoldCorpus.ts's SEED_GOLD_TITLES).
    expect(b.user).toContain('length 68-75 characters, median 74')
    expect(b.user).toContain('6 of 10 use " | "')
    expect(b.user).toContain('0 spec-only')
    expect(b.user).toContain('never more than 7 (measured over 6)')
  })

  it('LIVE DEFECT: the brief states a ceiling its own printed exemplars break', () => {
    // The brief prints "never more than 7" as a hard law, then shows a 10-word gold underneath it.
    // Pinned so the contradiction is visible in a test run rather than only in a comment. It is
    // removed by deleting the ceiling (handoff/TITLE_ARCHITECTURE.md), not by re-tuning the number.
    expect(b.user).toContain('never more than 7')
    expect(b.user).toContain(CEILING_VICTIM)
    expect(CEILING_VICTIM.slice(0, CEILING_VICTIM.indexOf(' | ')).split(/\s+/).length).toBe(10)
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

/**
 * THE ADVERSARIAL ATTACK SET (2026-08-11). Six confirmed evasions of the closed gender-pair regex,
 * every one a plausible next thing an LLM council would write. Pinned so the next variant has to be
 * genuinely novel rather than a synonym swap.
 */
describe('audience-span analyzer — the attack set', () => {
  it.each([
    ['a second gender appended across the separator', 'THE CEO 2026 World Soccer Cup Tee Shirt for Men | Fan Shirt for Women'],
    ['the "or" conjunction',                          'THE CEO Soccer Cup Tee | Fan Shirt for Men or Women'],
    ['unattested synonyms (guys/girls)',              'THE CEO Soccer Cup Tee | Shirt for Guys and Girls'],
    ['pronouns (him/her)',                            'THE CEO Soccer Cup Tee | Shirt for Him and Her'],
    ['a non-gender axis (adults/kids)',               'THE CEO Soccer Cup Tee | Shirt for Adults and Kids'],
    ['a determiner-led run (the Whole Family)',       'THE CEO Soccer Cup Tee | Shirt for the Whole Family'],
    ['the live rejection, verbatim',                  'THE CEO 2026 World Soccer Cup Unisex Tee for Men & Women Fans | Shirt'],
  ])('%s', (_name, attack) => {
    expect(hasInclusiveAudience(attack), attack).toBe(true)
    const out = stripInclusiveAudience(attack)
    expect(out, attack).not.toMatch(/\bfor\s+(the\s+)?(men|women|guys|girls|him|her|adults|kids|whole)\b.*\b(women|men|girls|her|kids|family)\b/i)
  })

  it('EVERY seller gold passes through the analyzer byte-identical — including the dual-gender one', () => {
    // NOTED GAP (PR #663, 2026-09-02) — reported, not force-fixed; out of THIS PR's scope (attribute
    // spec-grounding, not the audience-span analyzer). The new B0DP5H8QBT gold's tail "for Kids &
    // Children" trips the SAME mechanism this describe block's own attack set pins as intentional:
    // "a non-gender axis (adults/kids)" ('THE CEO Soccer Cup Tee | Shirt for Adults and Kids') is a
    // CONFIRMED EVASION this analyzer must catch, because 'kids' is not yet attested vocabulary and
    // the phrase is conjunction-joined. The new gold hits reason (a) — unattested vocabulary — for
    // the identical structural reason, even though "Kids & Children" names ONE audience twice
    // (synonym repetition), not two DIFFERENT audiences the way "Adults and Kids" does. The analyzer
    // cannot tell those apart from the regex shape alone. This is a real shape delta the gold
    // demonstrates (see poGoldCorpus.ts's provenance comment) — flagged for a PO ruling on whether
    // 'kids'/'children' should join AUD_ATTESTED, not silently patched here.
    const KNOWN_GAP = "THE CEO Don't Quit Tee Shirt | Motivational T-shirt for Kids & Children"
    for (const g of SEED_GOLD_TITLES) {
      if (g === KNOWN_GAP) {
        expect(hasInclusiveAudience(g), g).toBe(true) // documents the gap; see comment above
        continue
      }
      expect(hasInclusiveAudience(g), g).toBe(false)
      expect(stripInclusiveAudience(g), g).toBe(g)
    }
  })

  it('"Fan" no longer rescues a worthless money position — the load-bearing token', () => {
    // Measured before the fix: 'Fan Shirt for Women' classified 'search' and scored 100/100, while
    // 'Shirt for Women' classified specOnly. One generic wearer-noun carried all six attacks.
    expect(classifyTail('Fan Shirt for Women')).toBe('specOnly')
    expect(classifyTail('Shirt for Women')).toBe('specOnly')
    // …while the seller's real tails keep their exact class
    expect(classifyTail('Christian Shirts for Women')).toBe('search')
    expect(classifyTail('USA Mexico Canada Football Tee')).toBe('search')
    expect(classifyTail('Comfort Colors Alligator Tshirt for Women')).toBe('brand')
    expect(classifyTail('Funny Comfort Colors Shirt for Men Women')).toBe('brand')
  })
})

/**
 * ROUND-2 REGRESSION: the door must not damage the seller's own corpus.
 *
 * The round-2 adversarial pass found the door MUTILATING gold #1 — collapseRepeatedWords advanced
 * its segment counter only on a literal '|', so on a COMMA-joined title every word shared segment 0
 * and the cross-separator allowance could never fire:
 *   in  "THE CEO Later Alligator Long Sleeve Shirt, Later Gator Comfort Colors Shirt"  (75)
 *   out "THE CEO Later Alligator Long Sleeve Shirt, Gator Comfort Colors"              (63)
 * It deleted the design echo AND the mandated second garment noun, ending on a bare brand. FOUR of
 * the nine golds are non-pipe and the rebuilt brief now teaches that shape, so this was corrupting
 * the specification on the most likely output form.
 */
describe('the door never damages the seller\'s own golds', () => {
  it('all NINE pass collapseRepeatedWords byte-identical', () => {
    for (const g of SEED_GOLD_TITLES) {
      expect(collapseRepeatedWords(g).title, g).toBe(g)
    }
  })

  it('…without re-opening defect #148 (the ADJACENT stutter still goes)', () => {
    // The distinction is DISTANCE, not the separator: a design echo two or more significant words
    // away is structure ("Later … Later Gator"); an immediate repeat is a stutter.
    const r = collapseRepeatedWords('THE CEO Golf Widow Tshirt, Tshirt Graphic Tee for Women')
    expect(r.title).toBe('THE CEO Golf Widow Tshirt, Graphic Tee for Women')
  })

  it('stays IDEMPOTENT — a second pass changes nothing', () => {
    for (const t of [...SEED_GOLD_TITLES, 'THE CEO 2026 World Soccer Cup USA Mexico Canada Tee | Football Tee Shirt']) {
      const once = collapseRepeatedWords(t).title
      expect(collapseRepeatedWords(once).title, t).toBe(once)
    }
  })
})

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FEEL INJECTOR IS DELETED (2026-08-12, task #169) — and this is the guard that keeps it dead.
 *
 * It inserted 'Soft' / 'Comfy' / 'Cozy' / 'Cool' before the garment brand on any apparel title under
 * 50 characters, hash-picked from the design name, purely to lift the length. It was added for an
 * 80-char floor superseded twice, neither ban list caught it, and this session's own fixes ARMED it
 * by making sub-50-char titles common.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
describe("FEEL INJECTOR — deleted, and unable to return by the corpus's own evidence", () => {
  const FEEL_WORDS = ['soft', 'comfy', 'cozy', 'cool', 'comfortable', 'premium']

  it('the seller has NEVER used any of these words in nine gold titles', () => {
    const att = attestedUse(SEED_GOLD_TITLES, FEEL_WORDS)
    for (const w of FEEL_WORDS) {
      expect(att.get(w)!.length, `"${w}" is attested — re-check before treating it as banned`).toBe(0)
    }
  })

  it('so injecting one is adding vocabulary that is not a fact, not a search term, and not theirs', () => {
    // The architecture's governing asymmetry: code may FILTER, never ADD. Every one of the five
    // titles the seller rejected was authored by an ADDITION.
    for (const g of SEED_GOLD_TITLES) {
      for (const w of FEEL_WORDS) {
        expect(g.toLowerCase(), `${w} appeared in a gold`).not.toContain(w)
      }
    }
  })
})
