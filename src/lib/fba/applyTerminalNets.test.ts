import { describe, it, expect } from 'vitest'
import { applyTerminalNets } from './listingPipeline'

// A fake openai that MUST NOT be called — the fixtures are already in-band, so every terminal pass
// no-ops and no model call happens. If applyTerminalNets ever calls the model here, this test throws.
const openaiThatMustNotBeCalled = {
  chat: { completions: { create: () => { throw new Error('terminal net called the model on in-band input') } } },
} as never

const ctx = {
  openai: openaiThatMustNotBeCalled,
  finalTitle: 'THE CEO Test Tee Shirt | Comfort Colors Shirt for Women',
  designName: 'Test',
  fit: 'relaxed',
  brandName: 'THE CEO',
  garmentBrand: 'Comfort Colors',
}

describe('applyTerminalNets — idempotent passthrough on in-band input', () => {
  it('bullets: 5 bullets each >=150 chars pass through unchanged (no model call)', async () => {
    const b = Array.from({ length: 5 }, (_, i) =>
      `BENEFIT ${i} - ` + 'This is a deliberately long benefit sentence that comfortably clears the one hundred fifty character minimum for a bullet so the terminal expander does nothing at all here.')
    b.forEach((x) => expect(x.length).toBeGreaterThanOrEqual(150))
    const out = await applyTerminalNets('bullets', b, ctx) as string[]
    expect(out).toEqual(b)
  })
  it('bullets: non-5 array returns unchanged', async () => {
    const out = await applyTerminalNets('bullets', ['a', 'b'], ctx) as string[]
    expect(out).toEqual(['a', 'b'])
  })
  it('description: >=900 chars, no seller brand in body, passes through (no model call)', async () => {
    const html = '<p><b>Great tee.</b> ' + 'Soft ringspun cotton feels smooth all day. '.repeat(30) + '</p>'
    const plain = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(plain.length).toBeGreaterThanOrEqual(900)
    const out = await applyTerminalNets('description', html, ctx) as string
    expect(out).toBe(html)
  })
})
