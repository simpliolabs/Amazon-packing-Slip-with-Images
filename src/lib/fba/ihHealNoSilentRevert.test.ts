/**
 * THE CLASS: a repair mechanism that "restores" content converts a DELIBERATE change into an
 * INVISIBLE revert. This codebase has now hit it four times — the parent lock that overwrote six
 * fresh child titles (B0DSCDZC6K), the backend degrade-preserve gate, the Item-Highlights silent
 * hold, and the Amazon-100476 title auto-heal. Every one was individually correct. None could tell
 * a transient failure from a deliberate new state, so each preserved the past over the present,
 * quietly.
 *
 * THE SPECIFIC HAZARD HERE. `autoHealIhLongTitle` (pushExecutor.ts) reacts to Amazon error 100476
 * — "provide an Item Name <=75 chars to use Item Highlights" — by PATCHing that SKU's live
 * `item_name` down to our stored recommendation. That is a real repair today, because our ceiling
 * equals the precondition, so healing costs nothing.
 *
 * The moment the ceiling is deliberately raised (title-ceiling spec Phase 4), EVERY such SKU
 * 100476s, this heal fires on every one, and a stale <=75 recommendation would be pushed over the
 * new longer title — per SKU, soft-failing to a note nobody reads — to restore a field that renders
 * only in the browser tab. The raise would walk itself back and the logs would look normal.
 *
 * WHY A CONTRACT-DERIVED GUARD rather than a flag: a flag is a thing someone must remember to flip
 * in a second place, and this repo's own standing rule is derive-don't-remember. Raising
 * `CONTENT_CONTRACT.title.hardCap` now disables the heal BY CONSTRUCTION, in the same edit.
 *
 * The last test is the one that matters: it asserts the guard fires at the ceiling Phase 4 will
 * actually set, so this protection cannot be silently absent when it is finally needed.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ihHealAllowedByContract } from './titleCap'
import { CONTENT_CONTRACT, ITEM_HIGHLIGHTS_TITLE_PRECONDITION } from './contentContract'

const PUSH_EXECUTOR = readFileSync(join(process.cwd(), 'src/lib/fba/pushExecutor.ts'), 'utf8')

describe('100476 auto-heal — cannot silently revert a deliberate ceiling raise', () => {
  it('is ALLOWED today, because the ceiling equals the Item Highlights precondition', () => {
    expect(CONTENT_CONTRACT.title.hardCap).toBe(ITEM_HIGHLIGHTS_TITLE_PRECONDITION)
    expect(ihHealAllowedByContract().allowed).toBe(true)
  })

  it('DISABLES ITSELF at the ceilings Phase 4 will set — 88, 95 and 100', () => {
    for (const cap of [88, 95, 100]) {
      const r = ihHealAllowedByContract(cap)
      expect(r.allowed, `heal must be disabled at a ${cap}-char ceiling`).toBe(false)
      expect(r.why).toMatch(/deliberate trade|forfeited/i)
    }
  })

  it('stays allowed at any ceiling at or below the precondition', () => {
    for (const cap of [50, 70, 75]) {
      expect(ihHealAllowedByContract(cap).allowed, `heal should stay on at ${cap}`).toBe(true)
    }
  })

  it('the heal actually CONSULTS the guard — not merely that the guard exists', () => {
    // The #652 failure was a test asserting a mechanism that the live path never reached. Assert the
    // call site, so deleting the check fails here rather than in production six weeks later.
    expect(PUSH_EXECUTOR).toContain('ihHealAllowedByContract()')
    expect(PUSH_EXECUTOR).toMatch(/if\s*\(!contract\.allowed\)\s*return\s*\{\s*healed:\s*false/)
  })

  it('uses THIS SKU\'s own title, not the parent broadcast — the parent-lock class', () => {
    // The previous implementation read only `recommended_title` (the broadcast/parent value) and its
    // own docstring filed pushing it onto a child as "fine as a starting point". That is the exact
    // defect that froze six child titles on B0DSCDZC6K, living in the push path.
    expect(PUSH_EXECUTOR).toContain('per_child_titles')
    expect(PUSH_EXECUTOR).toMatch(/find\(\(t\)\s*=>\s*\(t\?\.sku\s*\?\?\s*''\)\s*===\s*sku\)/)
  })

  it('announces itself when it mutates a live title', () => {
    // A title change the seller did not ask for, as a side effect of an Item-Highlights push, must
    // never be inferable only from its absence (#643, the in-band fast path that skipped every net).
    expect(PUSH_EXECUTOR).toContain('[IH_100476_HEAL]')
  })
})
