import { describe, it, expect } from 'vitest'
import { shipCensus, type ShipCensusInput } from './shipCensus'

/** A healthy result — every band met. The base each test perturbs ONE way. */
const HEALTHY: ShipCensusInput = {
  exit: 'full',
  apparel: true,
  title: 'THE CEO Cupid Valentine Tee Shirt | Pixel Art Comfort Colors Women Tshirt', // 73
  // The REAL shipped bullets from B0GF49RLDL (2026-07-29 21:03) — 160-182 chars, all above the 150
  // floor. An earlier fixture used hand-written ~135-char bullets and the census CORRECTLY flagged
  // them, which is exactly the kind of fixture drift a real specimen prevents.
  bullets: [
    'CUPID CHARM DESIGN - Show off your playful side with a pixel art Cupid Valentine graphic that brings a sweet touch to any outfit. A comfortable everyday staple.',
    'RELAXED EVERYDAY FIT - Enjoy a relaxed fit that flatters and feels comfortable, perfect for casual days or festive gatherings. A soft, breathable pick for daily wear.',
    'PREMIUM MIDWEIGHT FEEL - Crafted from midweight cotton for softness and durability you can rely on all day long. Ideal for daily wear, layering, or thoughtful gifting.',
    'COMFORT COLORS QUALITY - Experience the trusted comfort and lived-in feel of Comfort Colors in every wear. Machine wash cold, tumble dry low to keep colors true.',
    'EASY GIFT IDEA - Delight your loved ones with a thoughtful Valentine shirt that is perfect for women who love fun style. Pairs cleanly with denim, joggers, or shorts.',
  ],
  description: `<p><b>${'Celebrate love with the Cupid Valentine tee. '.repeat(20)}</b></p>`, // ~900+ visible
  perChildKeywords: [{ sku: 'A', keywords: 'x'.repeat(240) }, { sku: 'B', keywords: 'y'.repeat(247) }],
  designName: 'Cupid Valentine',
}

describe('shipCensus — a healthy result is silent', () => {
  it('zero violations on the healthy base', () => {
    expect(shipCensus(HEALTHY)).toEqual([])
  })
})

describe('the live specimens (2026-07-29/30) each trip exactly their code', () => {
  it('THE 118-BYTE SPECIMEN: post-audit backend below the floor is finally VISIBLE at the exit', () => {
    // B0GR22ZHBW 2026-07-30 19:41 — gate passed pre-audit, audit gutted to 118, 118 PERSISTED.
    // The census measures the persisting bytes, so this class can never again pass silently.
    const v = shipCensus({ ...HEALTHY, perChildKeywords: [{ sku: 'S', keywords: 'x'.repeat(118) }] })
    expect(v).toEqual([{ code: 'KEYWORDS_BELOW_FLOOR', measured: 118, bound: 220, detail: 'S' }])
  })

  it('THE Tshirt,Tshirt SPECIMEN: a repeated significant word', () => {
    const v = shipCensus({ ...HEALTHY, title: 'THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt, Tshirt for Women' })
    expect(v.map((x) => x.code)).toContain('TITLE_WORD_REPEAT')
    expect(v.find((x) => x.code === 'TITLE_WORD_REPEAT')?.detail).toBe('tshirt')
  })

  it('THE 66-CHAR SPECIMEN: an under-band apparel title', () => {
    const v = shipCensus({ ...HEALTHY, title: 'THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women' })
    expect(v).toEqual([{ code: 'TITLE_UNDER_BAND', measured: 66, bound: 70 }])
  })

  it('THE MISSING-DESIGN SPECIMEN: a description that never mentions its own design', () => {
    // B0GR22ZHBW 2026-07-30 — 917 visible chars, zero anniversary words on an anniversary design.
    const v = shipCensus({
      ...HEALTHY,
      designName: 'We Still Do Anniversary',
      description: `<p>${'A comfortable everyday cotton tee for couples who value quality. '.repeat(15)}</p>`,
    })
    expect(v.map((x) => x.code)).toContain('DESC_MISSING_DESIGN')
  })

  it('…but ANY significant design token in the body satisfies it (no stuffing demand)', () => {
    const v = shipCensus({
      ...HEALTHY,
      designName: 'We Still Do Anniversary',
      description: `<p>${'Celebrate your anniversary in comfort with this soft everyday cotton tee. '.repeat(13)}</p>`,
    })
    expect(v.map((x) => x.code)).not.toContain('DESC_MISSING_DESIGN')
  })
})

describe('bounds come from the contract, one each way', () => {
  it('title over cap', () => {
    const v = shipCensus({ ...HEALTHY, title: 'A'.repeat(80) })
    expect(v.map((x) => x.code)).toContain('TITLE_OVER_CAP')
  })
  it('dangling separator', () => {
    const v = shipCensus({ ...HEALTHY, title: 'THE CEO Cupid Valentine Comfort Colors Relaxed Fit Tshirt for Women |' })
    expect(v.map((x) => x.code)).toContain('TITLE_DANGLING_SEPARATOR')
  })
  it('keywords over cap', () => {
    const v = shipCensus({ ...HEALTHY, perChildKeywords: [{ sku: 'S', keywords: 'x'.repeat(260) }] })
    expect(v.map((x) => x.code)).toContain('KEYWORDS_OVER_CAP')
  })
  it('bullet count + short bullet', () => {
    const v = shipCensus({ ...HEALTHY, bullets: ['too short', ...HEALTHY.bullets.slice(0, 3)] })
    const codes = v.map((x) => x.code)
    expect(codes).toContain('BULLETS_COUNT')
    expect(codes).toContain('BULLET_UNDER_MIN')
  })
  it('description floor and ceiling', () => {
    expect(shipCensus({ ...HEALTHY, description: '<p>short</p>' }).map((x) => x.code)).toContain('DESC_UNDER_FLOOR')
    expect(shipCensus({ ...HEALTHY, description: `<p>${'x'.repeat(1200)}</p>` }).map((x) => x.code)).toContain('DESC_OVER_CEILING')
  })
})

describe('honest boundaries — where the census deliberately stays silent', () => {
  it('non-apparel skips the length bands but keeps structural checks', () => {
    const v = shipCensus({ ...HEALTHY, apparel: false, title: 'THE CEO Ceramic Mug 11oz', description: '<p>A mug.</p>' })
    expect(v.map((x) => x.code)).not.toContain('TITLE_UNDER_BAND')
    expect(v.map((x) => x.code)).not.toContain('DESC_UNDER_FLOOR')
  })
  it('a producing stage that DECLARED backend degraded is not double-reported', () => {
    const v = shipCensus({ ...HEALTHY, perChildKeywords: [{ sku: 'S', keywords: 'x'.repeat(118) }], degradedSections: ['backend_keywords'] })
    expect(v.map((x) => x.code)).not.toContain('KEYWORDS_BELOW_FLOOR')
  })
  it('empty sections (a partial regen) are not violations', () => {
    const v = shipCensus({ ...HEALTHY, exit: 'title', bullets: [], description: '', perChildKeywords: [] })
    expect(v).toEqual([])
  })
  it('a title-only repeat check ignores connectors and punctuation-cased forms', () => {
    const ok = shipCensus({ ...HEALTHY, title: 'THE CEO Cupid Tee for Men and Women and Teens Extra Padding Fill Words Here' })
    expect(ok.map((x) => x.code)).not.toContain('TITLE_WORD_REPEAT')
  })
})
