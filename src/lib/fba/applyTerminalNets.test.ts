import { describe, it, expect } from 'vitest'
import { applyTerminalNets, expandShortBulletsTerminal, BULLET_MIN_CHARS, BULLET_MAX_CHARS } from './listingPipeline'

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

// A fake openai that always errors — reproduces the 2026-07-31 B0GR22ZHBW live run where all 10 LLM
// expander attempts contributed nothing (silently) and every bullet fell to the deterministic pad.
const openaiThatAlwaysFails = {
  chat: { completions: { create: async () => { throw new Error('simulated outage') } } },
} as never

describe('expandShortBulletsTerminal — deterministic floor holds when the LLM contributes nothing', () => {
  // The exact five bullets the metric loop produced live on B0GR22ZHBW (pad tails stripped). All five
  // are short, so bullets 1-4 consume pad suffixes 0-3 and bullet 5 hit BOTH remaining suffixes'
  // overlap-skip ("with"/"year"; "thoughtful"/"gift") — the strict pass exhausted and shipped 120.
  const liveShortBullets = [
    'CELEBRATE TOGETHERNESS - Show your lasting bond with the We Still Do design, perfect for anniversaries and special milestones.',
    'ALL-DAY COMFORT - Enjoy a midweight tee crafted for softness and breathability, keeping you comfortable throughout the day.',
    'VERSATILE STYLE - This unisex shirt pairs easily with jeans or shorts, making it a great choice for casual outings or celebrations.',
    'QUALITY YOU CAN TRUST - Durable construction and a vibrant print ensure your message stays bold, wash after wash.',
    'GREAT GIFT IDEA - Surprise your partner or loved ones with a thoughtful anniversary shirt that celebrates years of love.',
  ]
  it('all five live-specimen bullets land in [min, max] even with zero LLM help', async () => {
    liveShortBullets.forEach((b) => expect(b.length).toBeLessThan(BULLET_MIN_CHARS))
    const out = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...liveShortBullets], {
      title: 'THE CEO We Still Do Anniversary T-Shirt | Tee for Men and Women',
      designName: 'We Still Do',
      fit: 'relaxed',
      garmentBrand: 'Comfort Colors',
    })
    out.forEach((b) => {
      expect(b.length).toBeGreaterThanOrEqual(BULLET_MIN_CHARS)
      expect(b.length).toBeLessThanOrEqual(BULLET_MAX_CHARS)
    })
  })
  it('no two bullets get the same pad suffix in one push', async () => {
    const out = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...liveShortBullets], {
      title: 'THE CEO We Still Do Anniversary T-Shirt | Tee for Men and Women',
      designName: 'We Still Do',
    })
    const tails = out.map((b, i) => b.slice(liveShortBullets[i].length))
    const nonEmpty = tails.filter(Boolean)
    expect(new Set(nonEmpty).size).toBe(nonEmpty.length)
  })
  it('a rewrite that prepends "- " ships without the stray prefix (live B0GR22ZHBW 05:05 run)', async () => {
    // The first live run after #460 revived the expander: the model read the prompt's «keep the
    // " - " prefix» as an instruction to PREPEND one — stored bullet 1 began "- CELEBRATE ...".
    const modelPrependsDash = {
      chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ bullet: '- CELEBRATE TOGETHERNESS - Soft, comfortable, and made to honor your story, this We Still Do anniversary tee celebrates lasting love with a clean, timeless design.' }) } }] }) } },
    } as never
    const out = await expandShortBulletsTerminal(modelPrependsDash, [
      'CELEBRATE TOGETHERNESS - Too short.',
      ...liveShortBullets.slice(1),
    ], { title: 'THE CEO We Still Do Anniversary T-Shirt | Tee for Men and Women', designName: 'We Still Do' })
    for (const b of out) expect(b).not.toMatch(/^[\s\-–—]/)
    expect(out[0]).toMatch(/^CELEBRATE TOGETHERNESS - /)
  })
  it('idempotent: running the net twice adds nothing further', async () => {
    const once = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...liveShortBullets], {
      title: 'THE CEO We Still Do Anniversary T-Shirt | Tee for Men and Women',
      designName: 'We Still Do',
    })
    const twice = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...once], {
      title: 'THE CEO We Still Do Anniversary T-Shirt | Tee for Men and Women',
      designName: 'We Still Do',
    })
    expect(twice).toEqual(once)
  })
})
