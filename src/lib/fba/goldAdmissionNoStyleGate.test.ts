/**
 * THE ROOT: the gold-admission gate was enforcing STYLE, and style is what the corpus exists to
 * MEASURE.
 *
 * `poGoldCorpus`'s admit() rejected any candidate over 80 characters or not matching `^the ceo`.
 * Those two lines silently ate BOTH of the PO's 2026-09-05 rulings before either could reach
 * anything: they could lock an 88-char gold, or a brandless one, and it was dropped with no error,
 * no log and no deploy, while `measureGoldShape` reported the old shape forever. A ruling that
 * cannot reach the scorer is a doc note ([[rulings-must-live-in-the-scorer]]).
 *
 * THE PRINCIPLE NOW ENCODED: the gate enforces IDENTITY (is this one of our apparel titles?) and
 * PUBLISHABILITY (will Amazon take it, does it survive the ship door unchanged?). It must never
 * enforce STYLE — word order, brand position, separator, or an internal working ceiling.
 *
 * The first two tests are the acceptance criterion the spec named. The rest are the safety the old
 * brand-front check was really providing, which must not be lost while removing it: the gate's own
 * docstring warned that a bad row "would let one bad row move the measured ceiling for the whole
 * catalog with no deploy".
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAdmissibleGold, GOLD_MIN_CHARS, SEED_GOLD_TITLES } from './poGoldCorpus'
import { AMAZON_TITLE_MAX } from './contentContract'

describe('gold admission — identity and publishability, never style', () => {
  it('ADMITS an 88-char gold (PO ruling: shape follows the market, median 88)', () => {
    const t = 'Motivational Entrepreneur Crewneck Sweatshirt Women Fall Pullover Graphic Top Long Sleeve'
    // The category median is 88; what matters is that it clears the OLD 80-char bound that used to
    // reject it silently.
    expect(t.length).toBeGreaterThan(80)
    expect(isAdmissibleGold(t), `a ${t.length}-char gold was silently rejected — the ruling cannot reach the scorer`).toBe(true)
  })

  it('ADMITS a BRANDLESS gold (PO ruling: "remove THE CEO from Statrt of title")', () => {
    const t = 'Business Btch Crewneck Sweatshirt for Women Fall Graphic Pullover Top'
    expect(/^the ceo/i.test(t)).toBe(false)
    expect(isAdmissibleGold(t), 'a brandless gold was silently rejected — the ruling cannot reach the scorer').toBe(true)
  })

  it('still admits every seed gold — the old style did not become illegal', () => {
    // Removing a requirement must not invert it. Brand-front titles remain perfectly valid golds.
    for (const t of SEED_GOLD_TITLES) {
      expect(isAdmissibleGold(t), `seed gold rejected: ${t}`).toBe(true)
    }
  })

  it('REJECTS a fragment — the job brand-front was really doing', () => {
    expect(isAdmissibleGold('THE CEO Business')).toBe(false)
    expect(isAdmissibleGold('x'.repeat(GOLD_MIN_CHARS - 1))).toBe(false)
  })

  it('REJECTS another surface\'s copy — prose that names no garment', () => {
    // A bullet or description fragment: title-ish length, but no garment head noun.
    const bullet = 'Designed for entrepreneurs who want to look sharp while building their empire every day'
    expect(bullet.length).toBeGreaterThan(GOLD_MIN_CHARS)
    expect(isAdmissibleGold(bullet)).toBe(false)
  })

  it('REJECTS anything Amazon would not publish', () => {
    expect(isAdmissibleGold('Sweatshirt ' + 'x'.repeat(AMAZON_TITLE_MAX))).toBe(false)
  })

  it('REJECTS a title that the ship door would rewrite — identity, not repair', () => {
    // A gold carrying a trademark is not admitted as its scrubbed variant: the seller never chose
    // that string. Teaching the council to reproduce a title the publish door rewrites trains it to
    // fight the door.
    const tm = 'Disney Princess Crewneck Sweatshirt for Women Fall Graphic Pullover Top'
    expect(isAdmissibleGold(tm)).toBe(false)
  })

  it('the length bound is AMAZON\'s limit, not our internal working ceiling', () => {
    // Keying admission to CONTENT_CONTRACT.title.hardCap would recreate the trap in a new place: the
    // PO must be able to write the golds that JUSTIFY a raise BEFORE the raise ships.
    // Strip comments before scanning: the corrective note in poGoldCorpus quotes the OLD code
    // verbatim so the next reader knows what changed, and documenting a removed rule must not be
    // indistinguishable from still enforcing it.
    const code = readFileSync(join(process.cwd(), 'src/lib/fba/poGoldCorpus.ts'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
      .join('\n')
    expect(code).toContain('t.length > AMAZON_TITLE_MAX')
    expect(code).not.toMatch(/t\.length\s*>\s*(?:80|CONTENT_CONTRACT\.title\.hardCap)\b/)
    expect(code).not.toMatch(/\^the ceo/i)
  })
})
