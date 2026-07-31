import { describe, it, expect } from 'vitest'
import { capDescriptionVisible } from './listingPipeline'

// Mirror the function's own metric: raw non-tag character count (tags→space+collapse counts one extra
// separator per tag boundary and would read ~6 chars high on a 6-item list).
const plainLen = (d: string): number => d.replace(/<[^>]*>/g, '').length

// Tag balance = every opened p/ul/li/b is closed. An unbalanced cut (e.g. a </li> boundary inside a
// <ul> with the </ul> beyond the cap) ships broken HTML to the PDP — the Phase 6 prerequisite fix.
const isBalanced = (s: string): boolean => {
  const open: string[] = []
  const re = /<\/?(p|ul|li|b)\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const name = (m[1] as string).toLowerCase()
    if (m[0][1] === '/') {
      const i = open.lastIndexOf(name)
      if (i < 0) return false
      open.splice(i, 1)
    } else open.push(name)
  }
  return open.length === 0
}

describe('capDescriptionVisible — tag balance (Phase 6 prerequisite)', () => {
  const hook = `<p>${'a'.repeat(500)}</p>`
  const lis = Array.from({ length: 10 }, () => `<li>${'b'.repeat(80)}</li>`).join('')
  const long = `${hook}<ul>${lis}</ul><p>Closing line.</p>`

  it('fixture sanity: over cap, cut lands inside the <ul>', () => {
    expect(plainLen(long)).toBeGreaterThan(980)
  })
  it('boundary cut inside a <ul> still returns balanced HTML', () => {
    const out = capDescriptionVisible(long)
    expect(plainLen(out)).toBeLessThanOrEqual(980)
    expect(isBalanced(out)).toBe(true)
  })
  it('fallback cut (no boundary tag at all) returns balanced HTML', () => {
    const noBoundary = `<p><b>${'c'.repeat(1200)}` // never closed — forces the raw-slice fallback
    const out = capDescriptionVisible(noBoundary)
    expect(plainLen(out)).toBeLessThanOrEqual(980)
    expect(isBalanced(out)).toBe(true)
  })
  it('under-cap input passes through byte-identical', () => {
    const short = '<p>Short.</p><ul><li>One</li></ul>'
    expect(capDescriptionVisible(short)).toBe(short)
  })
  it('idempotent: capping twice equals capping once', () => {
    const once = capDescriptionVisible(long)
    expect(capDescriptionVisible(once)).toBe(once)
  })
})
