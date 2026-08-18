/**
 * THE MANUAL LOCK IS NOT A BYPASS OF THE SHIP DOOR.
 *
 * Found 2026-08-18 by an adversarial triage of all remaining open work. `lock-title/route.ts` stores
 * the seller's typed title VERBATIM at both write sites — the seed upsert and the update — with no
 * trademark guard and no celebrity guard on that path. Two consumers then trusted that string:
 *
 *   1. ai-recommendations/route.ts re-injected it into the result AFTER the pipeline's scrubPublished
 *      had already run, so no regen could ever heal it. A locked "World Cup" shipped "World Cup"
 *      for ever, while the identical AI-generated title was rewritten on every single run.
 *   2. poGoldCorpus.loadPoGoldTitles selects `title_source = 'manual'` as the GOLD CORPUS — so an
 *      unscrubbable locked title was eligible to become a reference example teaching the council the
 *      measured shape and vocabulary for the entire catalog, with no deploy.
 *
 * Consumer 2 is the one that matters most: it trains the council to reproduce exactly the phrase the
 * publish door will then rewrite, so the producer is taught to fight the door.
 *
 * NEITHER FIX IS A NEW NET. Both make the EXISTING door apply to a path that walked around it.
 */
import { describe, it, expect } from 'vitest'
import { scrubTrademarks } from './trademarkGuard'
import { scrubCelebrityNames } from './celebrityGuard'

/** The exact composition the pipeline's own `scrubPub` uses, and the one both fixes call. */
const shipDoor = (s: string): string => scrubCelebrityNames(scrubTrademarks(s), 'test')

describe('the ship door — the composition both lock consumers now use', () => {
  it('rewrites a guarded phrase, which is the whole reason the lock bypass mattered', () => {
    const typed = 'THE CEO 2026 World Cup Tee Shirt | Futbol USA Mexico Canada Fans'
    const shipped = shipDoor(typed)
    expect(shipped).not.toBe(typed)
    expect(shipped.toLowerCase()).not.toContain('world cup shirt')
    // The guarded phrase is substituted, not deleted — the title stays a title.
    expect(shipped.length).toBeGreaterThan(40)
    expect(shipped).toMatch(/^THE CEO /)
  })

  it('IS IDEMPOTENT — a clean title passes through byte-identical, so the fix costs nothing', () => {
    // This is what makes it safe to apply on every regen of every locked listing: the overwhelming
    // majority of locked titles are clean and must not move by a single character.
    const clean = 'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women'
    expect(shipDoor(clean)).toBe(clean)
    expect(shipDoor(shipDoor(clean))).toBe(shipDoor(clean))
  })

  it('is idempotent on an ALREADY-SCRUBBED string too (double application is a no-op)', () => {
    const typed = 'THE CEO 2026 World Cup Tee Shirt | Futbol USA Mexico Canada Fans'
    const once = shipDoor(typed)
    expect(shipDoor(once)).toBe(once)
  })
})

describe('THE GOLD-CORPUS GUARD — identity, not repair', () => {
  /** Mirrors the predicate added to loadPoGoldTitles. A gold must survive the door UNCHANGED. */
  const admissibleAsGold = (t: string): boolean => shipDoor(t) === t

  it('ADMITS every one of the seller\'s canonical seed golds', () => {
    // The guard must never reject the corpus it exists to protect. If a seed gold ever fails this,
    // the trademark/celebrity lexicon has grown into the seller's own taste and THAT is the defect.
    const seeds = [
      'THE CEO Later Alligator Long Sleeve Shirt, Later Gator Comfort Colors Shirt',
      'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup',
      'THE CEO Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men',
      'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women',
      'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women',
      'THE CEO Cupid Valentine Tee Shirt | Comfort Colors Graphic Tshirt for Women',
      'THE CEO I Could Be Meaner Tee | Funny Comfort Colors Shirt for Women',
      "THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women, Rodeo Shirt",
      'THE CEO The Rod Father T-Shirt Funny Fishing Mens Graphic Tee for Men',
    ]
    for (const g of seeds) expect(admissibleAsGold(g), g).toBe(true)
  })

  it('REJECTS a locked title the ship door would rewrite — it never becomes a gold', () => {
    const locked = 'THE CEO 2026 World Cup Tee Shirt | Futbol USA Mexico Canada Fans'
    expect(admissibleAsGold(locked)).toBe(false)
  })

  it('rejects rather than silently admitting the REPAIRED variant', () => {
    // Deliberate: we do not add shipDoor(locked) to the corpus, because the seller never chose that
    // string — they chose the one the door forbids. Admitting the repair would put words in their
    // mouth and then teach the council those words are the seller's taste.
    const locked = 'THE CEO 2026 World Cup Tee Shirt | Futbol USA Mexico Canada Fans'
    const repaired = shipDoor(locked)
    expect(repaired).not.toBe(locked)
    expect(admissibleAsGold(locked)).toBe(false)
    // The repaired form WOULD pass the predicate — proving the guard rejects on IDENTITY with the
    // stored row, not on "is this string publishable", which is the distinction that matters.
    expect(admissibleAsGold(repaired)).toBe(true)
  })
})
