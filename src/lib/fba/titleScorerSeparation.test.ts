/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FROZEN PROBE SUITE — the acceptance gate for the title architecture (handoff/TITLE_ARCHITECTURE.md).
 *
 * WHY THIS FILE EXISTS. Five consecutive generated titles were rejected by the seller, and five
 * deterministic patches were shipped in response — each one closing the exact rejected string, each
 * one followed by a NEW rejection through a different seam. The reason none of them worked is not
 * that any individual net was wrong. It is that `titleQualityJudge` — the scorer that PICKS the
 * title that ships — cannot tell the seller's own gold titles apart from keyword soup.
 *
 * This suite is the executable statement of that defect, and of the contract that replaces it:
 *
 *      min(score over the seller's golds)  >  max(score over every attack)
 *
 * TODAY THAT IS FALSE BY A MEASURED MARGIN (printed by the `MEASURE` test below, and pinned in the
 * `it.fails` gates). The gates are written with `it.fails` on purpose: they PASS while the defect is
 * present, so CI stays honest and green, and they START FAILING the moment the architecture lands —
 * at which point the correct action is to flip that gate from `it.fails` to `it`. A gate that
 * announces its own obsolescence is the only kind that survives a refactor.
 *
 * NOTHING HERE IS A NEW RULE. No net is added, no list is extended, no behaviour changes. This file
 * only measures. Per the standing directive: architecture before code, and a measurement before a
 * claim.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest'
import { SEED_GOLD_TITLES, measureGoldShape } from './poGoldCorpus'
import { titleQualityJudge } from './listingPipeline'

const shape = measureGoldShape(SEED_GOLD_TITLES)
const score = (t: string): number =>
  titleQualityJudge(t, { brandName: 'THE CEO', maxLeftWords: shape.maxLeftWords, shape, apparel: true }).score

/** The four titles the seller rejected verbatim, with their verbatim verdicts. */
const REJECTIONS: readonly [string, string][] = [
  ['WAY off',                'THE CEO Golf Widow Tee Shirt | Comfort Colors Crew Neck'],
  ['STILL BAD',              'THE CEO 2026 World Soccer Cup Unisex Classic Fit Fan Shirt | Comfort Colors'],
  ['Still Bad after regen',  'THE CEO 2026 World Soccer Cup Tee for Men and Women Fans | Short Sleeve'],
  ['EVEN WORSE',             'THE CEO 2026 World Soccer Cup Unisex Tee for Men & Women Fans | Shirt'],
]

/* The attack set. Every one of these avoids all five previously-closed strings — which is precisely
 * what the NEXT generation would do. They are the sixth rejection, written in advance. */
const ATTACKS: readonly [string, string][] = [
  ['invented design',   'THE CEO Purple Monday Tee Shirt | Comfort Colors Banana Tshirt for Women'],
  ['NO design phrase',  'THE CEO Graphic Tee Shirt | Comfort Colors Cotton Tshirt for Women Gift'],
  ['triple stutter',    'THE CEO Later Gator Tee Shirt | Later Gator Later Gator Tshirt for Women'],
  ['pure keyword soup', 'THE CEO Cupid Valentine Tee Shirt Tshirt Shirts Tees Graphic Shirt Women'],
  ['13-word identity',  'THE CEO 2026 World Soccer Cup USA Mexico Canada Football Fan Tee, Shirt'],
  ['spec tail',         'THE CEO 2026 World Soccer Cup Tee, Midweight Cotton Fan Tee Shirt'],
]

/* THE ANAGRAM PAIR — the real test, and the one the adversarial pass says is currently unwinnable.
 * These two strings have the IDENTICAL word multiset. Same words, same count, same length band, same
 * separator. Only the ALLOCATION differs: where the identity ends and the money position begins.
 * No length rule, no vocabulary list and no regex can separate them, because there is no token-level
 * difference to find. Separating this pair is the whole job. */
const ANAGRAM_GOLD  = 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee'
const ANAGRAM_TWIN  = 'THE CEO 2026 World Soccer Cup USA Mexico Canada Tee | Football Tee Shirt'

const bag = (t: string): string => t.toLowerCase().split(/\s+\|?\s*/).filter(Boolean).sort().join(' ')

describe('MEASURE — the current separation, printed as fact', () => {
  it('prints every score so the margin is a number, not a claim', () => {
    const line = (tag: string, t: string): number => {
      const s = score(t)
      const unpiped = score(t.split(' | ').join(' '))
      console.log(
        `${String(s).padStart(3)}  unpiped=${String(unpiped).padStart(3)}  ` +
        `sepDelta=${String(unpiped - s).padStart(4)}  len=${String(t.length).padStart(2)}  ${tag.padEnd(22)} ${t}`,
      )
      return s
    }
    console.log('\n── measured corpus shape ──')
    console.log(`maxLeftWords=${shape.maxLeftWords} lenMin=${shape.lenMin} lenMax=${shape.lenMax}`)
    console.log('\n── THE SELLER\'S GOLDS ──')
    const golds = SEED_GOLD_TITLES.map((t, i) => line(`gold #${i + 1}`, t))
    console.log('\n── THE SELLER\'S REJECTIONS ──')
    REJECTIONS.forEach(([verdict, t]) => line(verdict, t))
    console.log('\n── ATTACKS (the sixth rejection, pre-written) ──')
    const attacks = ATTACKS.map(([tag, t]) => line(tag, t))
    console.log('\n── THE ANAGRAM PAIR ──')
    const ag = line('anagram GOLD shape', ANAGRAM_GOLD)
    const at = line('anagram STUFFED twin', ANAGRAM_TWIN)
    const worstGold = Math.min(...golds)
    const bestAttack = Math.max(...attacks, at)
    console.log(
      `\n── VERDICT ──\nmin(gold)=${worstGold}  max(attack)=${bestAttack}  ` +
      `SEPARATION MARGIN=${worstGold - bestAttack}  (contract: > 0)\n` +
      `anagram: gold=${ag} twin=${at} margin=${ag - at}  (contract: > 0)\n`,
    )
    expect(golds).toHaveLength(9)
  })
})

describe('THE CONTRACT — flip each `it.fails` to `it` when the architecture lands', () => {
  it('the anagram pair is a genuine anagram — identical word multiset, so no token rule can separate it', () => {
    expect(bag(ANAGRAM_GOLD)).toBe(bag(ANAGRAM_TWIN))
    expect(ANAGRAM_GOLD.length).toBe(ANAGRAM_TWIN.length)
  })

  it.fails('CONTRACT 1 — every gold must outscore every attack (today: FALSE)', () => {
    const worstGold = Math.min(...SEED_GOLD_TITLES.map(score))
    const bestAttack = Math.max(...ATTACKS.map(([, t]) => score(t)), score(ANAGRAM_TWIN))
    expect(worstGold).toBeGreaterThan(bestAttack)
  })

  it.fails('CONTRACT 2 — the gold must beat its own stuffed anagram twin (today: FALSE)', () => {
    expect(score(ANAGRAM_GOLD)).toBeGreaterThan(score(ANAGRAM_TWIN))
  })

  it.fails('CONTRACT 3 — separator-agnostic: deleting " | " must not move a score ≥10 (today: FALSE)', () => {
    // Today the scorer PAYS the writer to delete the separator: four of the seller's rejections gain
    // +24..+44 unpiped, because three of five shape checks are reached only via indexOf(' | ') —
    // while FOUR of the seller's nine golds have no pipe at all.
    for (const [verdict, t] of REJECTIONS) {
      const delta = score(t.split(' | ').join(' ')) - score(t)
      expect(Math.abs(delta), `"${verdict}" moved ${delta}`).toBeLessThan(10)
    }
  })

  it.fails('CONTRACT 4 — no attack may reach a perfect score (today: FALSE)', () => {
    for (const [tag, t] of ATTACKS) expect(score(t), tag).toBeLessThan(100)
  })

  it.fails('CONTRACT 5 — no gold may be docked below every attack (today: gold #7 is)', () => {
    // The scorer's single lowest-ranked title in this entire 22-string suite is one of the seller's own.
    const worstGold = Math.min(...SEED_GOLD_TITLES.map(score))
    const worstAttack = Math.min(...ATTACKS.map(([, t]) => score(t)))
    expect(worstGold).toBeGreaterThanOrEqual(worstAttack)
  })
})
