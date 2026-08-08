import { describe, it, expect } from 'vitest'
import { priorityDisplay, priorityTooltip } from './priorityDisplay'

/* Item 2 (PO 2026-08-08 override of #520): the Priority cell is market-first — native
 * market_opportunity N/10 primary, the internal gap composite demoted to an honest ~fallback. */

describe('priorityDisplay — native primary', () => {
  it('shows N/10 with 0-10 bands when the native metric exists', () => {
    expect(priorityDisplay(7.2, 50)).toEqual({ text: '7.2/10', cls: 'text-violet-700', native: true })
    expect(priorityDisplay(4, 50)).toEqual({ text: '4/10', cls: 'text-slate-700', native: true })
    expect(priorityDisplay(3.9, 99)).toEqual({ text: '3.9/10', cls: 'text-slate-400', native: true })
  })

  it('native 0 is a REAL measured value — shown as 0/10, never the ~fallback', () => {
    const pd = priorityDisplay(0, 90)
    expect(pd.native).toBe(true)
    expect(pd.text).toBe('0/10')
  })
})

describe('priorityDisplay — honest ~fallback (no native metric)', () => {
  it('null/undefined native -> ~gap with the historical 70/40 bands', () => {
    expect(priorityDisplay(null, 87)).toEqual({ text: '~87', cls: 'text-violet-700', native: false })
    expect(priorityDisplay(undefined, 45.4)).toEqual({ text: '~45', cls: 'text-slate-700', native: false })
    expect(priorityDisplay(null, 32.4)).toEqual({ text: '~32', cls: 'text-slate-400', native: false })
  })

  it('non-finite inputs degrade to ~0, never NaN on screen', () => {
    expect(priorityDisplay(null, Number.NaN).text).toBe('~0')
    expect(priorityDisplay(Number.NaN, 50).native).toBe(false)
  })
})

describe('priorityTooltip — states what is actually shown', () => {
  it('native tooltip names the market metric AND carries the internal gap number', () => {
    const t = priorityTooltip(true, 32.4)
    expect(t).toContain('Jungle Scout market opportunity')
    expect(t).toContain('32')
  })
  it('fallback tooltip admits the composite is internal and coverage-sensitive', () => {
    const t = priorityTooltip(false, 32.4)
    expect(t).toContain('No native market metric')
  })
})
