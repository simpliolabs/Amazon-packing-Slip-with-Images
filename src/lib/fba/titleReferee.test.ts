/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE REFEREE'S DETERMINISTIC HALF — offline, no LLM, no credits.
 *
 * The load-bearing case is the LIVE 2026-08-12 regen on B0GVV3XL4T, not a constructed attack. The
 * deterministic judge scored its money position 100/100 with an EMPTY problems array; the seller's
 * own gold for the same design is a different allocation of the same 75 characters. If `moneyNovelty`
 * cannot separate those two, the metric is worthless and this file says so.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from 'vitest'
import { SEED_GOLD_TITLES } from './poGoldCorpus'
import { moneyNovelty, resolveSegments, nearestGolds, goldSituation, targetFromDesign } from './titleReferee'

/** What the council judge picked and called perfect (score 100, problems []). */
const LIVE_PICKED  = 'THE CEO 2026 World Soccer Cup Tee Shirt | Futbol Cup 2026 Soccer T-Shirt'
/** What actually shipped, after the dedupe stripped the echoes and the humanizer padded the hole. */
const LIVE_SHIPPED = 'THE CEO 2026 World Soccer Cup Tee Shirt | Futbol T-Shirt Fan Tournament'
/** The seller's own gold for the same design. */
const LIVE_GOLD    = 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee'

describe('MEASURE — money novelty across the corpus and the live specimens', () => {
  it('prints every number so the separation is a fact, not a claim', () => {
    const line = (tag: string, t: string): number => {
      const m = moneyNovelty(t)
      console.log(
        `novelty=${m.novelty.toFixed(2)}  echoed=[${m.echoed.join(' ')}]  fresh=[${m.fresh.join(' ')}]  ${tag}`,
      )
      return m.novelty
    }
    console.log('\n── THE SELLER\'S NINE GOLDS ──')
    const golds = SEED_GOLD_TITLES.map((t, i) => line(`gold #${i + 1}`, t))
    console.log('\n── THE LIVE 2026-08-12 SPECIMENS (B0GVV3XL4T) ──')
    const picked = line('council PICKED (judge: 100/100)', LIVE_PICKED)
    const shipped = line('SHIPPED', LIVE_SHIPPED)
    const gold = line('PO GOLD', LIVE_GOLD)
    console.log(`\nmin(gold corpus)=${Math.min(...golds).toFixed(2)}  picked=${picked.toFixed(2)}  shipped=${shipped.toFixed(2)}  gold=${gold.toFixed(2)}\n`)
    expect(golds).toHaveLength(9)
  })
})

describe('RULE 1(a) — a repeated word buys nothing, and code can prove it', () => {
  it('THE CASE THAT MATTERS: the title the judge called perfect is mostly an echo', () => {
    const m = moneyNovelty(LIVE_PICKED)
    // cup / 2026 / soccer are all already in "THE CEO 2026 World Soccer Cup Tee Shirt".
    expect(m.echoed).toEqual(expect.arrayContaining(['cup', '2026', 'soccer']))
    expect(m.fresh).toEqual(['futbol'])
    expect(m.novelty).toBeLessThan(0.3)
  })

  it('and the seller\'s gold for the SAME design earns every character', () => {
    const m = moneyNovelty(LIVE_GOLD)
    expect(m.echoed).toEqual([])
    expect(m.fresh).toEqual(expect.arrayContaining(['usa', 'mexico', 'canada', 'football']))
    expect(m.novelty).toBe(1)
  })

  it('SEPARATION: the gold beats the judge-approved title by a wide margin', () => {
    // This is the pair no rule separated in ~1,234 commits. The margin is the whole point.
    expect(moneyNovelty(LIVE_GOLD).novelty - moneyNovelty(LIVE_PICKED).novelty).toBeGreaterThan(0.5)
  })

  it('does NOT punish the seller\'s noun x2 rule — the garment may repeat on both sides', () => {
    // "Tee Shirt … Tshirt" is REQUIRED by §3. Counting it as an echo would dock every gold.
    const m = moneyNovelty('THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women')
    expect(m.echoed).toEqual([])
    expect(m.novelty).toBe(1)
  })

  it('every one of the nine golds scores high — the metric never fights the seller', () => {
    for (const g of SEED_GOLD_TITLES) {
      expect(moneyNovelty(g).novelty, g).toBeGreaterThanOrEqual(0.75)
    }
  })

  it('catches a repeat INSIDE the money position too (the triple-stutter attack)', () => {
    const m = moneyNovelty('THE CEO Later Gator Tee Shirt | Later Gator Later Gator Tshirt for Women')
    expect(m.novelty).toBeLessThan(0.5)
  })
})

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE LINE, MEASURED. This block exists to state what this module CANNOT do, so nobody later mistakes
 * a half-solution for a whole one and starts bolting rules onto it — which is the exact failure mode
 * this architecture exists to end.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
describe('KNOWN LIMIT — rule 1(b) is NOT code-decidable, and here is the proof', () => {
  it("novelty CANNOT separate invented filler from the seller's own money keywords", () => {
    // "Fan Tournament" is filler the humanizer invented to reach a length floor.
    // "USA Mexico Canada Football" is the host countries — the design's actual subject.
    // Neither appears in the identity, so BOTH are 100% novel. Code sees no difference.
    expect(moneyNovelty(LIVE_SHIPPED).novelty).toBe(1)
    expect(moneyNovelty(LIVE_GOLD).novelty).toBe(1)
    // THIS IS NOT A BUG IN THE METRIC. "Would a shopper type this?" has no table to consult:
    // "tournament" and "fan" were both genuinely present in the design's keyword pool
    // (nicheSeeds carried "2026 soccer tournament tee" and "2026 world futbol cup fan shirt"),
    // so even a pool-provenance predicate passes them. The distinction is semantic, it is the
    // whole content of the seller's complaint, and it belongs to the LLM referee.
  })

  it('novelty must be EVIDENCE for the referee, never a hard gate — gold #1 would fail a strict one', () => {
    // The seller deliberately keeps BOTH idiom forms in gold #1 ("Later Alligator … Later Gator"),
    // so "later" is a legitimate echo and the gold scores 0.75. A gate set above that docks the
    // seller's own title — the per-item false-fire floor in the acceptance spec forbids exactly that.
    const g1 = moneyNovelty(SEED_GOLD_TITLES[0])
    expect(g1.echoed).toEqual(['later'])
    expect(g1.novelty).toBeCloseTo(0.75, 2)
    // A gate at 0.5 is safe against the whole corpus AND kills the live defect (0.25). Recorded as
    // the measured safe band, not as a number someone picked.
    const worstGold = Math.min(...SEED_GOLD_TITLES.map((t) => moneyNovelty(t).novelty))
    expect(worstGold).toBeGreaterThan(0.5)
    expect(moneyNovelty(LIVE_PICKED).novelty).toBeLessThan(0.5)
  })
})

describe('SEPARATOR-AGNOSTIC — four of the nine golds have no pipe', () => {
  it('resolves all three separator classes the seller actually uses', () => {
    expect(resolveSegments('THE CEO Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men'))
      .toMatchObject({ separator: 'pipe', identity: 'THE CEO Cashflow Cap' })
    expect(resolveSegments("THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women, Rodeo Shirt"))
      .toMatchObject({ separator: 'comma', identity: "THE CEO Darlin' T-Shirt" })
    // PLAIN JOIN — the boundary is the end of the first garment-noun run.
    expect(resolveSegments('THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup'))
      .toMatchObject({ separator: 'plain', identity: 'THE CEO Espana Championship Tee Shirt', money: '2026 Spain Jersey Football Soccer Cup' })
  })

  it('scores an unpiped gold the same way it scores a piped one', () => {
    // M2's defect was that deleting " | " changed the verdict. It must not here.
    const piped = moneyNovelty(LIVE_GOLD).novelty
    const unpiped = moneyNovelty(LIVE_GOLD.replace(' | ', ' ')).novelty
    expect(Math.abs(piped - unpiped)).toBeLessThan(0.2)
  })
})

describe('NEAREST-GOLD RETRIEVAL — anchor the writer on the RIGHT gold', () => {
  it('a World-Cup-style event design retrieves the Espana gold first', () => {
    // THE POINT OF THIS STEP. All five failing drafts imitated the piped apparel golds. The seller's
    // Espana gold — an event, a proper-noun cluster, a plain join — is the one that matches.
    const target = targetFromDesign({ designPhrase: '2026 World Soccer Cup', garmentNoun: 'tee', lean: null })
    const top = nearestGolds(target, SEED_GOLD_TITLES, 3)
    expect(top[0].title).toContain('Espana Championship')
  })

  it('a first-person statement design retrieves a statement gold, not an event one', () => {
    const target = targetFromDesign({ designPhrase: 'I Could Be Meaner', garmentNoun: 'tee', lean: 'female' })
    const top = nearestGolds(target, SEED_GOLD_TITLES, 3)
    expect(top.some((g) => /I Could Be Meaner|I Will Praise Him/.test(g.title))).toBe(true)
    expect(top[0].title).not.toContain('Espana')
  })

  it('derives every situational feature — nothing hand-typed', () => {
    const espana = goldSituation('THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup')
    expect(espana).toMatchObject({ isEvent: true, isStatement: false, hasProperSubject: true, separator: 'plain' })
    const praise = goldSituation('THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women')
    expect(praise).toMatchObject({ isEvent: false, isStatement: true, audience: 'women', separator: 'pipe' })
  })

  it('is deterministic — the same target always yields the same order', () => {
    const target = targetFromDesign({ designPhrase: '2026 World Soccer Cup', garmentNoun: 'tee', lean: null })
    const a = nearestGolds(target).map((g) => g.title)
    const b = nearestGolds(target).map((g) => g.title)
    expect(a).toEqual(b)
  })
})
