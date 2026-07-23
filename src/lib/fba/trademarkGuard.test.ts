import { describe, it, expect } from 'vitest'
import { buildAdversaryTrademarkClause } from './trademarkGuard'

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
