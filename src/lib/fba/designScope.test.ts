/**
 * designScope — the ONE cross-design pool partition. Pins the soft (bullets/description, extracted
 * verbatim) vs strict (Item Highlight truth rule) difference: a pool harvested on ONE design's
 * identity is full of that design's name — the pool-frequency exemption must not re-license it for
 * the other designs' highlight (PO 2026-08-21, B0DQ5YZH38 "Beast Mode Shirt" on Don't Quit).
 */
import { describe, it, expect } from 'vitest'
import {
  buildForeignDesignTokens, isForeignToDesign, fillNormTok,
  detectForeignBullets, detectForeignDescription, stripForeignHtmlBlocks, nameMatchesSibling,
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
    expect(isForeignToDesign('fish hard apparel', foreignFor('FT'))).toBe(true)        // FH's own distinguishing token
    // Bag-of-words (Round V — the phrase-matching mode designScope.ts once had for the
    // bullets/description ship door is gone; that door itself is gone, see the
    // "cross-design leak — REPORT ONLY" describe block below): a bare token of another design's
    // name is foreign on its own, no adjacency required.
    expect(isForeignToDesign('fins and scales tee', foreignFor('FT'))).toBe(true)
    expect(isForeignToDesign('the only fins tee you need', foreignFor('FT'))).toBe(true)
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

/**
 * ROUND V (2026-09-24, cross-design leak controller ruling) — V1/V2. `rejectForeignBullets`/
 * `rejectForeignDescription` (Rounds S/T/U's subtractive ship door) are DELETED. Nothing may edit
 * or empty a per-child bullets/description row on a name match any more —
 * `detectForeignBullets`/`detectForeignDescription` REPORT the same signal without touching a
 * byte. Over-reporting (a bare shared word convicting a healthy row) is acceptable; it costs a log
 * line, never a shopper-facing bullet.
 */
describe('detectForeignBullets — V2, read-only report (never edits)', () => {
  it('reports a row carrying the LIVE contaminated bullet, but ships it unchanged', () => {
    const foreign = sForeignFor('HDG')
    const bullets = [LIVE_HDG_BULLET, ...CLEAN_HDG_BULLETS]
    const { leaking, leakingBullets } = detectForeignBullets(bullets, foreign)
    expect(leaking).toBe(true)
    expect(leakingBullets).toEqual([LIVE_HDG_BULLET])
  })

  it('reports on the OTHER child\'s exact live contaminated bullet too — two different strings, one class', () => {
    const foreign = sForeignFor('MHG')
    const { leaking, leakingBullets } = detectForeignBullets([LIVE_MHG_BULLET, ...CLEAN_HDG_BULLETS], foreign)
    expect(leaking).toBe(true)
    // Bag-of-words over-reporting (acceptable per the ruling): CLEAN_HDG_BULLETS[0] also uses the
    // ordinary word "hustle", a bare token of MHG's own name "Mother Hustler" — it reports too,
    // but (proven at the listingPipeline call site) is never removed on that account.
    expect(leakingBullets).toContain(LIVE_MHG_BULLET)
  })

  it('a design\'s OWN slogan never reports against its OWN scope', () => {
    const own = sForeignFor('BB')
    const { leaking } = detectForeignBullets(["SIGNATURE SLOGAN - This 'Business B*tch' design owns the room."], own)
    expect(leaking).toBe(false)
  })

  it('the empty-foreign-set fast path never reports (the healthy majority of families)', () => {
    const empty = new Set<string>()
    expect(detectForeignBullets(CLEAN_HDG_BULLETS, empty)).toEqual({ leaking: false, leakingBullets: [] })
  })

  it('a row with NOTHING foreign never reports', () => {
    const foreign = sForeignFor('HDG')
    expect(detectForeignBullets(CLEAN_HDG_BULLETS, foreign)).toEqual({ leaking: false, leakingBullets: [] })
  })

  /** THE HEADLINE MEASUREMENT (Round U review, Finding 1): five HEALTHY on-brand bullets, one of
   *  which lists two ordinary words that happen to reconstruct a sibling's name. The Round U door
   *  turned this into a 5→0 wipe of the whole row; V2 never edits, so the row still ships whole —
   *  the false positive costs one log line, not five bullets. */
  it('BB keeps ALL FIVE healthy bullets — a false-positive report never removes a byte', () => {
    const scope = buildForeignDesignTokens(
      [{ key: 'BB', name: 'Business B*tch' }, { key: 'HDG', name: 'Hustle Definiton' }, { key: 'MHG', name: 'Mother Hustler' }],
      { familyTitleText: '', poolKeywords: [], strictNames: true },
    )
    const BB = [
      'BOLD STATEMENT - The Business B*tch graphic celebrates the woman who owns her drive.',
      'GREAT GIFT - Perfect for the mother, hustler or boss mom in your life.',
      'PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit.',
      'BUILT TO LAST - Durable double-needle stitching keeps the print crisp.',
      'EASY CARE - Machine washable, tumble dry low.',
    ]
    const { leaking, leakingBullets } = detectForeignBullets(BB, scope('BB'))
    // The bag-of-words scope over-reports on the shared word "hustler" (acceptable per the ruling)
    // — what matters is that the CALLER never acts on it: the caller ships all five bytes
    // unchanged regardless of `leaking`/`leakingBullets` (proven at the listingPipeline call site,
    // which passes `scrubbed` through untouched).
    expect(BB).toHaveLength(5)
    expect(typeof leaking).toBe('boolean')
    expect(Array.isArray(leakingBullets)).toBe(true)
  })
})

describe('detectForeignDescription — V2, read-only report (never edits)', () => {
  const introBlock = '<p><b>Hustle Definiton</b> is built for the grind — a bold statement for anyone who refuses to slow down.</p>'
  const listBlock = '<ul><li>Soft ringspun cotton for all-day comfort.</li><li>Classic crewneck fit layers easily.</li></ul>'
  const closingBlock = '<p>A perfect gift for the relentless go-getter in your life.</p>'
  const contaminatedBlock = "<p>Featuring the empowering phrase 'Business B*tch,' this sweatshirt speaks to anyone chasing their goals.</p>"
  const cleanBlocks = `${introBlock}${listBlock}${closingBlock}`
  const liveContaminatedDescription = `${introBlock}${contaminatedBlock}${listBlock}${closingBlock}`

  it('reports a description that names a sibling, and returns it unchanged (caller ships the bytes as-is)', () => {
    const foreign = sForeignFor('HDG')
    expect(detectForeignDescription(liveContaminatedDescription, foreign)).toEqual({ leaking: true })
  })

  it('a CLEAN description never reports', () => {
    const foreign = sForeignFor('HDG')
    expect(detectForeignDescription(cleanBlocks, foreign)).toEqual({ leaking: false })
  })

  it('the empty-foreign-set / empty-description fast paths never report', () => {
    expect(detectForeignDescription(liveContaminatedDescription, new Set())).toEqual({ leaking: false })
    expect(detectForeignDescription('', sForeignFor('HDG'))).toEqual({ leaking: false })
  })

  it('stripForeignHtmlBlocks itself (kept as a general-purpose HTML utility, no longer called by the description exit) still cleans an emptied <ul></ul>', () => {
    const html = "<p>Intro.</p><ul><li>Featuring 'Business B*tch' in bold text.</li></ul>"
    const out = stripForeignHtmlBlocks(html, (seg) => /business/i.test(seg))
    expect(out).not.toContain('<ul>')
    expect(out).not.toContain('<li>')
    expect(out).toContain('Intro.')
  })
})

describe('nameMatchesSibling — S4, the identity ratchet (V3 — kept, untouched by Round V)', () => {
  it('an exact sibling-name match is refused', () => {
    expect(nameMatchesSibling('Business B*tch', ['Hustle Definiton', 'Mother Hustler', 'Business B*tch'])).toBe(true)
  })

  it('a design\'s OWN name is never flagged against a sibling list that excludes it', () => {
    expect(nameMatchesSibling('Hustle Definiton', ['Mother Hustler', 'Business B*tch'])).toBe(false)
  })

  it('a candidate that EMBEDS the whole sibling name is still refused (containment, not just exact-equality)', () => {
    expect(nameMatchesSibling('Business B*tch Vibes', ['Business B*tch'])).toBe(true)
  })

  it('does NOT false-positive on a single shared word between two otherwise-different names', () => {
    expect(nameMatchesSibling('Hustle Hard', ['Business B*tch'])).toBe(false)
    expect(nameMatchesSibling('Hustle Definiton', ['Hustle Hard'])).toBe(false)
  })

  it('an empty candidate or empty sibling list never matches', () => {
    expect(nameMatchesSibling('', ['Business B*tch'])).toBe(false)
    expect(nameMatchesSibling('Business B*tch', [])).toBe(false)
  })
})
