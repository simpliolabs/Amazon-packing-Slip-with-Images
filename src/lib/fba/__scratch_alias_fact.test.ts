import { describe, it, expect } from 'vitest'
import { enforceTitleBand, type TitleBandCtx } from './titleBand'
import { SHIRT_BASE, garmentNounFor, type GarmentNoun } from './garmentNoun'

/**
 * Faithful replica of listingPipeline.ts:7676-7696 `titleBandCtx`.
 * `boundaryFixed=false` reproduces the SHIPPED code (template literal `\b` = U+0008 backspace).
 * `boundaryFixed=true` reproduces the code AFTER the U+0008 bug is fixed (`\\b` = real \b).
 */
function titleBandCtx(
  title: string,
  bandGarment: GarmentNoun,
  apparelProduct: boolean,
  garmentBrandCanonical: string,
  blankSpec: { fit?: string | null; sleeve?: string | null; neck?: string | null } | null,
  boundaryFixed: boolean,
): TitleBandCtx {
  const has = (w: string): boolean =>
    boundaryFixed
      ? new RegExp(`\\b${w}\\b`, 'i').test(title)
      : new RegExp(`\b${w}\b`, 'i').test(title)
  const bare = (w: string): string => w.toLowerCase().replace(/[^a-z0-9]/g, '')
  const presentBare = bandGarment.aliases.filter((al) => has(al)).map(bare)
  const second = bandGarment.aliases.find((al) => {
    if (al.includes(' ') || has(al)) return false
    const b = bare(al)
    return !presentBare.some((p) => b.includes(p) || p.includes(b))
  })
  return {
    apparel: apparelProduct,
    garmentBrand: garmentBrandCanonical || null,
    spec: blankSpec ? { fit: blankSpec.fit ? `${blankSpec.fit} Fit` : null, sleeve: blankSpec.sleeve, neck: blankSpec.neck } : null,
    garmentSecond: second ? second.replace(/\w/g, (c) => c.toUpperCase()) : null,
  }
}

describe('alias picker is not a FACT source', () => {
  // GARMENT_NOUN defaults to 'off' → garmentFor() returns SHIRT_BASE for EVERY apparel product.
  // A hoodie/sweatshirt is NOT a tee blank → looksTee false → blankSpec null → brand '' and spec null,
  // so garmentSecond is the ONLY candidate segment the leaf gets.
  const hoodie = 'THE CEO Cupid Valentine Pixel Art Hooded Sweatshirt for Women' // 61 chars, < 70

  it('(a) FLAG OFF, boundaries BROKEN (shipped): hoodie padded with "Shirt"', () => {
    const ctx = titleBandCtx(hoodie, SHIRT_BASE, true, '', null, false)
    const out = enforceTitleBand(hoodie, ctx)
    console.log('  broken-boundary garmentSecond =', ctx.garmentSecond)
    console.log('  broken-boundary title =', out.title, `(${out.title.length})`)
    expect(ctx.garmentSecond).toBe('SHIRT')
    expect(out.title).toContain('| SHIRT')
  })

  it('(a) FLAG OFF, boundaries FIXED: hoodie STILL padded with "Shirt"', () => {
    const ctx = titleBandCtx(hoodie, SHIRT_BASE, true, '', null, true)
    const out = enforceTitleBand(hoodie, ctx)
    console.log('  fixed-boundary garmentSecond =', ctx.garmentSecond)
    console.log('  fixed-boundary title =', out.title, `(${out.title.length})`)
    expect(ctx.garmentSecond).toBe('SHIRT')
    expect(out.title).toContain('| SHIRT')
  })

  it('control: a real SHIRT gets the intended "Tee" (design works for family=shirt)', () => {
    const shirt = 'THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women' // 66
    const ctxFixed = titleBandCtx(shirt, SHIRT_BASE, true, 'Comfort Colors', { fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck' }, true)
    console.log('  shirt fixed garmentSecond =', ctxFixed.garmentSecond)
    console.log('  shirt fixed title =', enforceTitleBand(shirt, ctxFixed).title)
    expect(ctxFixed.garmentSecond).toBe('TEE')
  })

  it('(b) FLAG ON: a DAD HAT title is padded with "Snapback"', () => {
    const hat = 'THE CEO Cupid Valentine Pixel Art Dad Hat for Women' // 51
    const g = garmentNounFor('HAT', hat)
    const ctx = titleBandCtx(hat, g, true, '', null, true)
    const out = enforceTitleBand(hat, ctx)
    console.log('  hat aliases =', g.aliases.join(' | '))
    console.log('  hat garmentSecond =', ctx.garmentSecond)
    console.log('  hat title =', out.title, `(${out.title.length})`)
    expect(ctx.garmentSecond).toBe('SNAPBACK')
  })

  it('(b) FLAG ON: JACKET → "Windbreaker", TANK → muscle form, SWEATSHIRT → "Pullover"', () => {
    for (const [pt, title] of [
      ['JACKET', 'THE CEO Cupid Valentine Pixel Art Jacket for Women'],
      ['TANK_TOP', 'THE CEO Cupid Valentine Pixel Art Tank Top for Women'],
      ['SWEATSHIRT', 'THE CEO Cupid Valentine Pixel Art Crewneck Sweatshirt for Women'],
    ] as const) {
      const g = garmentNounFor(pt, title)
      const ctx = titleBandCtx(title, g, true, '', null, true)
      console.log(`  ${pt} garmentSecond =`, ctx.garmentSecond, '| out =', enforceTitleBand(title, ctx).title)
    }
  })
})
