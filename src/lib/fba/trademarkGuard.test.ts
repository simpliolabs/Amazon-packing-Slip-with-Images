import { describe, it, expect } from 'vitest'
import { buildAdversaryTrademarkClause, hasTrademark, scrubTrademarks } from './trademarkGuard'

describe('buildAdversaryTrademarkClause — TITLE_COUNCIL_V3 §5.4 sync', () => {
  it('renders the current PO-approved World Cup substitution (2026-07-21: futbol > soccer)', () => {
    const c = buildAdversaryTrademarkClause()
    expect(c).toContain('"world cup" -> "world futbol cup"')
    // the stale "world soccer cup" hardcode this replaces MUST NOT reappear
    expect(c.toLowerCase()).not.toContain('world soccer cup')
  })

  it('renders the Super Bowl substitution', () => {
    const c = buildAdversaryTrademarkClause()
    expect(c).toContain('"super bowl" -> "big game"')
  })

  it('lists the drop-only marks (FIFA, NFL, NBA, MLB, NHL, NCAA, Olympics, Paralympics)', () => {
    const c = buildAdversaryTrademarkClause()
    // Drop list contains each mark literally
    for (const mark of ['fifa', 'olympic', 'paralympic', 'nfl', 'nba', 'mlb', 'nhl', 'ncaa']) {
      expect(c.toLowerCase()).toContain(mark)
    }
  })

  it('has a Substitute section and a Drop section', () => {
    const c = buildAdversaryTrademarkClause()
    expect(c).toMatch(/Substitute:/i)
    expect(c).toMatch(/Drop:/i)
  })
})

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT A — SUBSTITUTION IDEMPOTENCE (live regen B0GVVY5TS9, 2026-08-09 18:54).
 *
 * SHIPPED, verbatim:
 *   THE CEO Futbol World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve
 *
 * The council wrote "Futbol World Cup" — "futbol" is this seller's own bilingual design vocabulary —
 * and the `world cup -> world futbol cup` rule fired on top of a token the context already supplied.
 * The old idempotence claim only ever covered the scrub's OWN output in isolation.
 */

/** The council title as it entered the scrub (the "Futbol" is the DESIGN's word, not the rule's). */
const LIVE_COUNCIL_IN = 'THE CEO Futbol World Cup Soccer Tee Shirt | the Black Short Sleeve'
/** What actually shipped — the doubled token. */
const LIVE_SHIPPED = 'THE CEO Futbol World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve'
/** The safe phrasing, printed exactly once. */
const LIVE_FIXED = 'THE CEO World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve'

describe('scrubTrademarks — idempotent substitution (DEFECT A, B0GVVY5TS9 2026-08-09)', () => {
  const table: { name: string; input: string; expected: string }[] = [
    // ── THE LIVE SPECIMEN ───────────────────────────────────────────────────────────────────────
    { name: 'the exact live council title — the design\'s own "Futbol" is ABSORBED, never doubled',
      input: LIVE_COUNCIL_IN, expected: LIVE_FIXED },
    { name: 'the exact live SHIPPED string — repaired, and never re-doubled by the scrub-on-serve',
      input: LIVE_SHIPPED, expected: LIVE_FIXED },

    // ── THE RULE MUST STILL DO ITS JOB ──────────────────────────────────────────────────────────
    { name: 'plain "World Cup" STILL substitutes (the whole point of the rule)',
      input: 'THE CEO World Cup Soccer Tee Shirt', expected: 'THE CEO World Futbol Cup Soccer Tee Shirt' },
    { name: 'already-substituted "World Futbol Cup" is a NO-OP, byte-identical',
      input: 'THE CEO World Futbol Cup Soccer Tee Shirt', expected: 'THE CEO World Futbol Cup Soccer Tee Shirt' },
    { name: '"FIFA World Cup" still collapses to the one safe phrase',
      input: 'THE CEO FIFA World Cup Tee', expected: 'THE CEO World Futbol Cup Tee' },
    { name: 'an ALL-CAPS mark keeps ALL-CAPS casing',
      input: 'THE CEO FIFA WORLD CUP TEE', expected: 'THE CEO WORLD FUTBOL CUP TEE' },

    // ── MIXED CASING ────────────────────────────────────────────────────────────────────────────
    { name: 'mixed casing — ALL-CAPS design token before a Title-Case mark',
      input: 'FUTBOL World Cup Tee', expected: 'World Futbol Cup Tee' },
    { name: 'mixed casing — all lowercase (a research seed, not a title)',
      input: 'futbol world cup shirt', expected: 'world futbol cup shirt' },
    { name: 'mixed casing — the inserted token AFTER the mark',
      input: 'World Cup Futbol Tee', expected: 'World Futbol Cup Tee' },

    // ── SCOPE: ADJACENCY ONLY ───────────────────────────────────────────────────────────────────
    { name: 'a NON-adjacent "Futbol" is left alone — the scrub absorbs, it does not rewrite',
      input: 'Futbol Shirt World Cup', expected: 'Futbol Shirt World Futbol Cup' },

    // ── THE REPLACEMENT-SHAPE RULE (super bowl -> big game) ─────────────────────────────────────
    { name: '"Super Bowl" still substitutes', input: 'Super Bowl Party Tee', expected: 'Big Game Party Tee' },
    { name: 'an already-adjacent "Big Game" collapses instead of printing twice',
      input: 'Big Game Super Bowl Party', expected: 'Big Game Party' },
    { name: 'a replacement rule NEVER absorbs its tokens one at a time ("Board Game" survives)',
      input: 'Board Game Super Bowl Tee', expected: 'Board Game Big Game Tee' },

    // ── UNTOUCHED INPUT ─────────────────────────────────────────────────────────────────────────
    { name: 'a mark-free title is byte-identical',
      input: 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt',
      expected: 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt' },
  ]

  for (const { name, input, expected } of table) {
    it(name, () => { expect(scrubTrademarks(input)).toBe(expected) })
  }

  it('is a FIXED POINT on every row — scrub(scrub(x)) === scrub(x)', () => {
    for (const { input } of table) {
      const once = scrubTrademarks(input)
      expect(scrubTrademarks(once)).toBe(once)
      // and three passes, because the route scrubs on serve after the pipeline already scrubbed
      expect(scrubTrademarks(scrubTrademarks(once))).toBe(once)
    }
  })

  it('leaves NO protected mark behind on any row', () => {
    for (const { input } of table) expect(hasTrademark(scrubTrademarks(input))).toBe(false)
  })

  it('prints the inserted token exactly once wherever it substituted', () => {
    for (const { input } of table) {
      const out = scrubTrademarks(input).toLowerCase()
      // "Futbol World Futbol Cup" and "Big Game Big Game" are the two gibberish shapes.
      expect(out).not.toMatch(/futbol\s+world\s+futbol/)
      expect(out).not.toMatch(/\bbig game\s+big game\b/)
    }
  })
})
