import { describe, it, expect } from 'vitest'
import { CONTENT_CONTRACT as C } from './contentContract'

describe('contentContract — value lock', () => {
  it('holds the current live generator values byte-for-byte', () => {
    expect(C.bullets.min).toBe(150)
    expect(C.bullets.max).toBe(200)
    expect(C.bullets.count).toBe(5)
    expect(C.description.floor).toBe(900)
    expect(C.description.ceiling).toBe(980)
    expect(C.keywords.minLegacy).toBe(190)
    expect(C.keywords.minStrict).toBe(220)
    expect(C.keywords.byteCap).toBe(250)
    expect(C.title.hardCap).toBe(75)
    expect(C.title.floor).toBe(50)
  })

  it('is internally consistent (min < max, floor < ceiling)', () => {
    expect(C.bullets.min).toBeLessThan(C.bullets.max)
    expect(C.description.floor).toBeLessThan(C.description.ceiling)
    expect(C.keywords.minStrict).toBeGreaterThan(C.keywords.minLegacy)
    expect(C.title.goldenBandLo).toBeLessThan(C.title.goldenBandHi)
  })
})

describe('contentContract — scorer↔generator drift tripwires (Step 4 reconciles)', () => {
  // These lock the KNOWN lies in place so they cannot change silently. When Step 4 aligns the scorer
  // to the generator, these three assertions flip in the same commit. If anyone edits a scorer OR a
  // generator number without going through Step 4, the mismatch surfaces here and the build fails.
  it('BULLETS: scorer full-marks at 80 while generator targets 150 (a lie until Step 4)', () => {
    expect(C.bullets.scorerTooShort).toBe(80)
    expect(C.bullets.min).toBe(150)
    expect(C.bullets.scorerTooShort).not.toBe(C.bullets.min) // <-- the lie, asserted explicitly
  })
  it('DESCRIPTION: scorer docks apparel <700 while generator floor is 900 (a lie until Step 4)', () => {
    expect(C.description.scorerApparelFloor).toBe(700)
    expect(C.description.floor).toBe(900)
    expect(C.description.scorerApparelFloor).not.toBe(C.description.floor)
  })
  it('KEYWORDS: scorer counts CHARS <100 while generator budgets BYTES 220-250 (a unit lie until Step 4)', () => {
    expect(C.keywords.scorerCharDockLo).toBe(100)
    expect(C.keywords.minStrict).toBe(220)
  })
})
