/**
 * ONE POOL KEY PER FAMILY (task #174) — the rule, pinned.
 *
 * Live 2026-08-19 (workflow wf_6d88ff51-d8b): keyword_analysis held TWO pool copies for parent
 * B0DSQPZY9S under two child keys — harvested twice, six minutes apart, on 2026-07-24 — with every
 * judgment column NULL, because four call-site-local resolvers each derived their own key. These
 * tests pin the ONE rule both entry points share: parent if the family has one, else the resolved
 * child, else the input unchanged (fail-open).
 */
import { describe, it, expect } from 'vitest'
import { poolKeyFromResolved } from './poolKey'

describe('poolKeyFromResolved — the one rule', () => {
  it('a CHILD resolves to its PARENT (the family drawer, not the sales pointer)', () => {
    expect(poolKeyFromResolved({ childAsin: 'B0DSQVMXJQ', parentAsin: 'B0DSQPZY9S' }, 'B0DSQVMXJQ'))
      .toBe('B0DSQPZY9S')
  })

  it('a SELF-PARENTED family resolves to itself — the exact shape that split the resolvers', () => {
    expect(poolKeyFromResolved({ childAsin: 'B0DSQPZY9S', parentAsin: 'B0DSQPZY9S' }, 'B0DSQPZY9S'))
      .toBe('B0DSQPZY9S')
  })

  it('an ORPHAN child (NULL parent, #85 family) fail-opens to the child itself', () => {
    expect(poolKeyFromResolved({ childAsin: 'B0ORPHAN01', parentAsin: null }, 'B0ORPHAN01'))
      .toBe('B0ORPHAN01')
  })

  it('an UNRESOLVABLE input fail-opens to the input unchanged — never a thrown-away request', () => {
    expect(poolKeyFromResolved(null, 'B0UNSYNCED')).toBe('B0UNSYNCED')
  })

  it('normalizes case, so a lowercase pasted ASIN cannot mint a second drawer', () => {
    expect(poolKeyFromResolved(null, 'b0dsqpzy9s')).toBe('B0DSQPZY9S')
  })

  it('is deterministic: the same family shape yields the same key from EITHER direction', () => {
    // The regen enters with the parent; the Intelligence route may enter with a child.
    const viaParent = poolKeyFromResolved({ childAsin: 'B0DSQVMXJQ', parentAsin: 'B0DSQPZY9S' }, 'B0DSQPZY9S')
    const viaChild = poolKeyFromResolved({ childAsin: 'B0DSR981NL', parentAsin: 'B0DSQPZY9S' }, 'B0DSR981NL')
    expect(viaParent).toBe(viaChild)   // ONE family → ONE drawer, whichever door you came in
  })
})
