/**
 * designScope — the ONE cross-design pool partition. Pins the soft (bullets/description, extracted
 * verbatim) vs strict (Item Highlight truth rule) difference: a pool harvested on ONE design's
 * identity is full of that design's name — the pool-frequency exemption must not re-license it for
 * the other designs' highlight (PO 2026-08-21, B0DQ5YZH38 "Beast Mode Shirt" on Don't Quit).
 */
import { describe, it, expect } from 'vitest'
import {
  buildForeignDesignTokens, isForeignToDesign, fillNormTok,
  rejectForeignBullets, rejectForeignDescription, stripForeignHtmlBlocks,
} from './designScope'

const DESIGNS = [{ key: 'BM', name: 'Beast Mode' }, { key: 'DQ', name: "Don't Quit" }, { key: 'RK', name: 'Real King' }]
/** A pool harvested on the BM identity: "beast" in 40% of rows. */
const BM_HEAVY_POOL = ['beast mode shirt', 'beast mode gym tee', 'beast mode workout tank', 'beast mode tshirt men', 'gym motivation shirts', 'workout graphic tees', 'lifting apparel men', 'fitness clothing men', 'real king shirt', "don't quit shirt"]

describe('buildForeignDesignTokens — soft (bullets) vs strict (Item Highlight)', () => {
  it('SOFT: a pool-frequent name token is niche-exempt (the review-caught "Fishing Trip" rule — bullets behavior unchanged)', () => {
    const foreignFor = buildForeignDesignTokens(DESIGNS, { familyTitleText: 'Gym Shirts for Men', poolKeywords: BM_HEAVY_POOL })
    expect(isForeignToDesign('beast mode shirt', foreignFor('DQ'))).toBe(false)   // "beast"+"mode" frequent ⇒ exempt
    expect(isForeignToDesign("don't quit shirt", foreignFor('BM'))).toBe(true)    // "quit" rare ⇒ foreign
  })

  it('STRICT: another design NAME is foreign however full of it the pool is; identity seeds keep every exemption', () => {
    const foreignFor = buildForeignDesignTokens(DESIGNS, { familyTitleText: 'Gym Shirts for Men', poolKeywords: BM_HEAVY_POOL, strictNames: true })
    expect(isForeignToDesign('beast mode shirt', foreignFor('DQ'))).toBe(true)
    expect(isForeignToDesign('beast mode shirt', foreignFor('RK'))).toBe(true)
    expect(isForeignToDesign('beast mode shirt', foreignFor('BM'))).toBe(false)   // own
    expect(isForeignToDesign('gym motivation shirts', foreignFor('DQ'))).toBe(false)  // shared family phrase
  })

  it('family-title tokens and ≥50%-name-shared tokens are niche even in strict mode', () => {
    const fishing = [{ key: 'FT', name: 'Fishing Trip' }, { key: 'FH', name: 'Fish Hard' }, { key: 'OF', name: 'Only Fins' }]
    const foreignFor = buildForeignDesignTokens(fishing, { familyTitleText: 'Funny Fishing Shirts for Men', poolKeywords: [], strictNames: true })
    expect(isForeignToDesign('fishing gifts for dad', foreignFor('OF'))).toBe(false)   // "fishing" in the family title
    expect(isForeignToDesign('fish hard apparel', foreignFor('FT'))).toBe(true)        // "hard" is FH's own word
    expect(isForeignToDesign('fins and scales tee', foreignFor('FT'))).toBe(true)      // "fins" is OF's own word
  })

  it('identity (vision) phrases extend a design vocabulary but stay soft: a pool-frequent seed word is never foreign', () => {
    const d = [{ key: 'BM', name: 'Beast Mode', identity: ['gym', 'lifting'] }, { key: 'DQ', name: "Don't Quit", identity: ['motivation'] }]
    const foreignFor = buildForeignDesignTokens(d, { familyTitleText: '', poolKeywords: ['gym shirt', 'gym tee', 'gym tank', 'gym hoodie', 'quit tee'], strictNames: true })
    expect(isForeignToDesign('gym shirt', foreignFor('DQ'))).toBe(false)     // "gym" frequent in pool ⇒ exempt (identity token)
    expect(isForeignToDesign('lifting shirt', foreignFor('DQ'))).toBe(true)  // "lifting" only BM's seed, rare ⇒ foreign
    expect(isForeignToDesign('motivation tee', foreignFor('BM'))).toBe(true)
  })

  it('fillNormTok folds gender plurals, light plurals and tshirt→shirt (the title fill dedup contract)', () => {
    expect(['mens', 'womens', 'tees', 'shirts', 'tshirt', 'men'].map(fillNormTok)).toEqual(['men', 'women', 'tee', 'shirt', 'shirt', 'men'])
  })
})

/**
 * ROUND S (2026-09-24, B0DSCDZC6K) — the live defect: B0DRH5T3PN (Hustle Definiton) and
 * B0DSCJX5QF (Mother Hustler) advertised the THIRD design's slogan, "Business B*tch", in bullets.
 * These are the family's real design names/keys, and the two bullet strings below are quoted
 * VERBATIM off Amazon 2026-09-24 (the task's own repro strings) — not paraphrased fixtures.
 */
const S_FAMILY = [
  { key: 'BB', name: 'Business B*tch' },
  { key: 'HDG', name: 'Hustle Definiton' },
  { key: 'MHG', name: 'Mother Hustler' },
  { key: 'BCSG', name: 'Billionare Coming Soon' },
  { key: 'DQG', name: "Don't Quit" },
]
const sForeignFor = buildForeignDesignTokens(S_FAMILY, { familyTitleText: '', poolKeywords: [], strictNames: true })
const LIVE_HDG_BULLET = "BOLD STATEMENT - Featuring the empowering phrase 'Business B*tch,' this sweatshirt celebrates ambition and hustle in every wear."
const LIVE_MHG_BULLET = "MOTIVATIONAL DESIGN - Featuring bold, empowering text 'Business B*tch' that inspires confidence."
const CLEAN_HDG_BULLETS = [
  'PREMIUM COMFORT - Soft ringspun cotton keeps you comfortable through a full day of hustle.',
  'RELAXED FIT - A classic crewneck cut that layers easily for any season.',
  'GREAT GIFT - Perfect for the go-getter who never stops chasing the next goal.',
  'BUILT TO LAST - Durable stitching holds up wash after wash, season after season.',
]

describe('the class, measured (VERDICT.md §2, empty pool, the most favourable case)', () => {
  it('isForeignToDesign("Business B*tch", <sibling>) is TRUE at every per-design caller once STRICT NAMES + an empty familyTitleText apply', () => {
    expect(isForeignToDesign('Business B*tch', sForeignFor('HDG'))).toBe(true)
    expect(isForeignToDesign('Business B*tch', sForeignFor('MHG'))).toBe(true)
    expect(isForeignToDesign('Business B*tch', sForeignFor('BCSG'))).toBe(true)
    expect(isForeignToDesign('Business B*tch', sForeignFor('DQG'))).toBe(true)
    // Never foreign to its OWN design.
    expect(isForeignToDesign('Business B*tch', sForeignFor('BB'))).toBe(false)
  })
})

describe('rejectForeignBullets — S2, the per-child bullets ship door', () => {
  it('drops the EXACT live contaminated bullet and keeps this design\'s own clean ones', () => {
    const foreign = sForeignFor('HDG')
    const out = rejectForeignBullets([LIVE_HDG_BULLET, ...CLEAN_HDG_BULLETS], foreign, [])
    expect(out).not.toContain(LIVE_HDG_BULLET)
    expect(out.some((b) => /business/i.test(b))).toBe(false)
    expect(out).toEqual(CLEAN_HDG_BULLETS)
  })

  it('drops the OTHER child\'s exact live contaminated bullet too — two different strings, one class', () => {
    const foreign = sForeignFor('MHG')
    const out = rejectForeignBullets([LIVE_MHG_BULLET, ...CLEAN_HDG_BULLETS], foreign, [])
    expect(out).not.toContain(LIVE_MHG_BULLET)
    expect(out.some((b) => /business/i.test(b))).toBe(false)
  })

  it('restores the SAME-INDEX prior bullet when the prior is itself clean — refuse-and-keep-prior, not refuse-and-drop', () => {
    const foreign = sForeignFor('HDG')
    const prior = ['PREMIUM COMFORT - the old clean bullet at index 0.', '', '', '', '']
    const out = rejectForeignBullets([LIVE_HDG_BULLET, ...CLEAN_HDG_BULLETS.slice(1)], foreign, prior)
    expect(out[0]).toBe(prior[0])
    expect(out).not.toContain(LIVE_HDG_BULLET)
  })

  it('never restores a prior that is ITSELF foreign — drops rather than re-shipping the sibling name a second way', () => {
    const foreign = sForeignFor('HDG')
    const priorAlsoContaminated = [LIVE_HDG_BULLET, '', '', '', '']
    const out = rejectForeignBullets([LIVE_HDG_BULLET, ...CLEAN_HDG_BULLETS.slice(1)], foreign, priorAlsoContaminated)
    expect(out.some((b) => /business/i.test(b))).toBe(false)
    expect(out).toEqual(CLEAN_HDG_BULLETS.slice(1))
  })

  it('a design\'s OWN slogan survives in its OWN bullets (never self-foreign)', () => {
    const own = sForeignFor('BB')
    const out = rejectForeignBullets(["SIGNATURE SLOGAN - This 'Business B*tch' design owns the room."], own, [])
    expect(out).toHaveLength(1)
  })

  it('the empty-foreign-set fast path is a byte-identical no-op (the healthy majority of families)', () => {
    const empty = new Set<string>()
    expect(rejectForeignBullets(CLEAN_HDG_BULLETS, empty, [])).toEqual(CLEAN_HDG_BULLETS)
  })

  it('IDEMPOTENT — a second pass over the survivors changes nothing', () => {
    const foreign = sForeignFor('HDG')
    const once = rejectForeignBullets([LIVE_HDG_BULLET, ...CLEAN_HDG_BULLETS], foreign, [])
    expect(rejectForeignBullets(once, foreign, [])).toEqual(once)
  })

  it('NEVER pads a dropped slot with a blank string — a shorter true array, not a same-length one with "" holes', () => {
    const foreign = sForeignFor('HDG')
    const out = rejectForeignBullets([LIVE_HDG_BULLET], foreign, [])
    expect(out).toEqual([])
    expect(out).not.toContain('')
  })
})

describe('stripForeignHtmlBlocks + rejectForeignDescription — S2, the per-child description ship door', () => {
  const introBlock = '<p><b>Hustle Definiton</b> is built for the grind — a bold statement for anyone who refuses to slow down.</p>'
  const listBlock = '<ul><li>Soft ringspun cotton for all-day comfort.</li><li>Classic crewneck fit layers easily.</li></ul>'
  const closingBlock = '<p>A perfect gift for the relentless go-getter in your life.</p>'
  const contaminatedBlock = "<p>Featuring the empowering phrase 'Business B*tch,' this sweatshirt speaks to anyone chasing their goals.</p>"
  const cleanBlocks = `${introBlock}${listBlock}${closingBlock}`
  const liveContaminatedDescription = `${introBlock}${contaminatedBlock}${listBlock}${closingBlock}`

  it('drops ONLY the block naming the sibling design, never mid-tag, and keeps the rest', () => {
    const foreign = sForeignFor('HDG')
    const out = rejectForeignDescription(liveContaminatedDescription, foreign)
    expect(out.toLowerCase()).not.toContain('business')
    expect(out).toContain('<li>Soft ringspun cotton for all-day comfort.</li>')
    expect(out).toContain('Hustle Definiton')
    // No dangling/unbalanced tags left by the removal.
    expect((out.match(/<p>/g) ?? []).length).toBe((out.match(/<\/p>/g) ?? []).length)
    expect((out.match(/<li>/g) ?? []).length).toBe((out.match(/<\/li>/g) ?? []).length)
  })

  it('a CLEAN description is a byte-identical no-op (fast path never even splits it)', () => {
    const foreign = sForeignFor('HDG')
    expect(rejectForeignDescription(cleanBlocks, foreign)).toBe(cleanBlocks)
  })

  it('cleans an emptied <ul></ul> when every <li> inside it named the sibling', () => {
    const html = "<p>Intro.</p><ul><li>Featuring 'Business B*tch' in bold text.</li></ul>"
    const out = stripForeignHtmlBlocks(html, (seg) => /business/i.test(seg))
    expect(out).not.toContain('<ul>')
    expect(out).not.toContain('<li>')
    expect(out).toContain('Intro.')
  })

  it('refuses to a safe EMPTY string only when EVERY block is foreign — never ships the sibling slogan as a fallback', () => {
    const allContaminated = "<p>Featuring 'Business B*tch' proudly.</p>"
    const foreign = sForeignFor('HDG')
    const out = rejectForeignDescription(allContaminated, foreign)
    expect(out.toLowerCase()).not.toContain('business')
  })

  it('IDEMPOTENT — a second pass over the survivors changes nothing', () => {
    const foreign = sForeignFor('HDG')
    const once = rejectForeignDescription(liveContaminatedDescription, foreign)
    expect(rejectForeignDescription(once, foreign)).toBe(once)
  })
})
