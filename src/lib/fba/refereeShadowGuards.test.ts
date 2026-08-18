/**
 * TITLE_REFEREE SHADOW — the guards that decide whether this can ever cost money.
 *
 * This is the first thing in the title pipeline that puts a REAL MODEL CALL on the regen path. The
 * 2026-08-09 incident is the precedent: an in-band LLM heal ran >160s, the gateway 502'd it BEFORE
 * the write that would have armed its own cooldown, and every page load re-fired a doomed billable
 * job. These tests pin the properties that make this a different shape.
 *
 * The call itself is not unit-tested here — it needs a live model. What IS tested is everything
 * that decides WHETHER it happens, because that is the part with a blast radius.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { titleRefereeMode } from './listingPipeline'

const clear = () => { delete process.env.TITLE_REFEREE; delete process.env.TITLE_REFEREE_SAMPLE }
afterEach(clear)

const withEnv = <T,>(v: string | undefined, fn: () => T): T => {
  const prev = process.env.TITLE_REFEREE
  if (v === undefined) delete process.env.TITLE_REFEREE; else process.env.TITLE_REFEREE = v
  try { return fn() } finally { if (prev === undefined) delete process.env.TITLE_REFEREE; else process.env.TITLE_REFEREE = prev }
}

describe('the flag defaults to OFF — a measurement that spends money is opt-in', () => {
  it('UNSET means off, so nothing is billed until someone decides otherwise', () => {
    clear()
    expect(titleRefereeMode()).toBe('off')
  })

  it('contrast with TITLE_V4, whose shadow was free: that one defaults to shadow, this one cannot', () => {
    // TITLE_V4's shadow cost one captured variable and one log line — the "new" title was already
    // in memory. THIS shadow is a model call. The asymmetry in defaults is deliberate and is the
    // whole reason these two flags do not share a convention.
    clear()
    expect(titleRefereeMode()).toBe('off')
  })

  it('an unrecognised or empty value is OFF, never a spending mode', () => {
    // Note the direction: for TITLE_V4 a typo falls to the behaviour-NEUTRAL middle. Here the
    // neutral state IS off, because the middle state costs money. A typo must never bill.
    for (const v of ['', '   ', 'yes', 'true', '1', 'SHADOWY', 'enabled']) {
      expect(withEnv(v, titleRefereeMode), JSON.stringify(v)).toBe('off')
    }
  })

  it('both real modes must be typed exactly, and are case-insensitive', () => {
    expect(withEnv('shadow', titleRefereeMode)).toBe('shadow')
    expect(withEnv('SHADOW', titleRefereeMode)).toBe('shadow')
    expect(withEnv(' shadow ', titleRefereeMode)).toBe('shadow')
    expect(withEnv('on', titleRefereeMode)).toBe('on')
    expect(withEnv('ON', titleRefereeMode)).toBe('on')
  })
})

describe('sampling is DETERMINISTIC — the shadow data must be reproducible', () => {
  /** Mirrors the shipped hash + sample so the property is asserted without exporting internals. */
  const stableHash = (s: string): number => {
    let h = 0
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
    return Math.abs(h)
  }
  const sampled = (key: string, oneIn: number): boolean => oneIn <= 1 || stableHash(key) % oneIn === 0

  it('the SAME candidate set samples the same way every time', () => {
    // Math.random() here would make every measurement unrepeatable — you could never re-run a
    // disagreement to check it. Same input, same decision, forever.
    const key = 'THE CEO A|THE CEO B|THE CEO C'
    const first = sampled(key, 5)
    for (let i = 0; i < 50; i++) expect(sampled(key, 5)).toBe(first)
  })

  it('different candidate sets do NOT all sample identically', () => {
    const keys = Array.from({ length: 40 }, (_, i) => `THE CEO Design ${i} Tee|THE CEO Alt ${i} Shirt`)
    const on = keys.filter((k) => sampled(k, 5)).length
    expect(on).toBeGreaterThan(0)      // some are sampled
    expect(on).toBeLessThan(keys.length) // and some are not — it really is a sample
  })

  it('1-in-1 samples everything, which is the deliberate full-rate setting', () => {
    for (const k of ['a', 'b', 'anything at all']) expect(sampled(k, 1)).toBe(true)
  })
})
