/**
 * designScope — the ONE cross-design pool partition. Pins the soft (bullets/description, extracted
 * verbatim) vs strict (Item Highlight truth rule) difference: a pool harvested on ONE design's
 * identity is full of that design's name — the pool-frequency exemption must not re-license it for
 * the other designs' highlight (PO 2026-08-21, B0DQ5YZH38 "Beast Mode Shirt" on Don't Quit).
 */
import { describe, it, expect } from 'vitest'
import {
  buildForeignDesignTokens, isForeignToDesign, fillNormTok,
  rejectForeignBullets, rejectForeignDescription, stripForeignHtmlBlocks, nameMatchesSibling,
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
    const foreignFor = buildForeignDesignTokens(fishing, { familyTitleText: 'Funny Fishing Shirts for Men', poolKeywords: [], strictNames: true, phraseNames: true })
    expect(isForeignToDesign('fishing gifts for dad', foreignFor('OF'))).toBe(false)   // "fishing" in the family title
    expect(isForeignToDesign('fish hard apparel', foreignFor('FT'))).toBe(true)        // "fish hard" — FH's own WHOLE name, quoted
    // U2 (Round U) — a MULTI-word name is foreign only as the WHOLE ordered phrase (see the
    // "rejectForeignBullets" describe block below for why: single-token matching convicted a
    // design of naming a sibling on nothing but an ordinary shared word). "Only Fins" is two
    // tokens; a candidate carrying just "fins" — without "only" immediately before it — no longer
    // matches. The FULL phrase, quoted, still does (next assertion).
    expect(isForeignToDesign('fins and scales tee', foreignFor('FT'))).toBe(false)
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
const sForeignFor = buildForeignDesignTokens(S_FAMILY, { familyTitleText: '', poolKeywords: [], strictNames: true, phraseNames: true })
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
 * U2 (Round U, cross-design leak) — the root the T1 review's two lenses converged on: the door
 * matched a sibling's name at the SINGLE-TOKEN level, so "hustle" (a bare token of HDG's own name
 * "Hustle Definiton") convicted BB's OWN identity bullet ("...ambition and hustle...") of naming
 * HDG — measured, T1-COST probe 3/T1-PATHS probe 1 (cost1/cost3.probe.test.ts, five healthy
 * families losing 1-2 of their 5 bullets each to this exact class of false positive). Pinned here
 * on the REAL six-name family, with the REAL healthy bullet text from those probes.
 */
describe('U2 — a sibling NAME is foreign only as a whole phrase, never a bare token', () => {
  const U_FAMILY = [
    { key: 'BB', name: 'Business B*tch' },
    { key: 'HDG', name: 'Hustle Definiton' },
    { key: 'MHG', name: 'Mother Hustler' },
    { key: 'BCSG', name: 'Billionare Coming Soon' },
    { key: 'DQG', name: "Don't Quit" },
    { key: 'GMG', name: 'Grind Mode' },
  ]
  const uForeignFor = buildForeignDesignTokens(U_FAMILY, { familyTitleText: '', poolKeywords: [], strictNames: true, phraseNames: true })

  it('BB keeps its OWN identity bullet: "hustle" alone is HDG\'s token, not HDG\'s whole name', () => {
    const bbOwnBullet = "BOLD STATEMENT - The Business B*tch graphic celebrates ambition and hustle for every day of the week."
    expect(isForeignToDesign(bbOwnBullet, uForeignFor('BB'))).toBe(false)
  })

  it('"mother" alone does not convict a bullet of naming "Mother Hustler" — the full phrase is required', () => {
    expect(isForeignToDesign('A thoughtful gift for the mother who hustles harder than anyone.', uForeignFor('HDG'))).toBe(false)
    expect(isForeignToDesign('Perfect for a small business owner or boss mom.', uForeignFor('MHG'))).toBe(false)
  })

  it('the WHOLE phrase, quoted, still convicts — the fix narrows the match, it does not remove it', () => {
    expect(isForeignToDesign('This Mother Hustler design says it all.', uForeignFor('HDG'))).toBe(true)
    expect(isForeignToDesign("Featuring 'Business B*tch' proudly.", uForeignFor('HDG'))).toBe(true)
  })
})

describe('rejectForeignBullets — U1, the per-child bullets ship door (all-or-nothing)', () => {
  it('refuses the WHOLE row (not the one bullet) when a candidate names a sibling design', () => {
    const foreign = sForeignFor('HDG')
    const out = rejectForeignBullets([LIVE_HDG_BULLET, ...CLEAN_HDG_BULLETS], foreign)
    expect(out).toEqual([]) // U1: no partial array — the live/prior row stands instead (pushFields no-ops on []).
  })

  it('refuses on the OTHER child\'s exact live contaminated bullet too — two different strings, one class', () => {
    const foreign = sForeignFor('MHG')
    const out = rejectForeignBullets([LIVE_MHG_BULLET, ...CLEAN_HDG_BULLETS], foreign)
    expect(out).toEqual([])
  })

  it('a design\'s OWN slogan survives in its OWN bullets (never self-foreign) — the healthy row ships whole', () => {
    const own = sForeignFor('BB')
    const out = rejectForeignBullets(["SIGNATURE SLOGAN - This 'Business B*tch' design owns the room."], own)
    expect(out).toHaveLength(1)
  })

  it('the empty-foreign-set fast path is a byte-identical no-op (the healthy majority of families)', () => {
    const empty = new Set<string>()
    expect(rejectForeignBullets(CLEAN_HDG_BULLETS, empty)).toEqual(CLEAN_HDG_BULLETS)
  })

  it('a row with NOTHING foreign ships byte-identical, whole — the fast path\'s complement', () => {
    const foreign = sForeignFor('HDG')
    expect(rejectForeignBullets(CLEAN_HDG_BULLETS, foreign)).toEqual(CLEAN_HDG_BULLETS)
  })

  it('IDEMPOTENT — refusing an already-empty array changes nothing', () => {
    const foreign = sForeignFor('HDG')
    const once = rejectForeignBullets([LIVE_HDG_BULLET, ...CLEAN_HDG_BULLETS], foreign)
    expect(rejectForeignBullets(once, foreign)).toEqual(once)
  })

  /** U5 — the floor pin the round removed, restored: the REAL family names, REAL healthy
   *  five-bullet sets (verbatim from cost1.probe.test.ts), through the REAL rejector. Every
   *  design ships its full five — never a partial array below the contract's floor. */
  it('U5 FLOOR: six real names, five healthy on-brand bullets each — every design ships 5 of 5', () => {
    const NAMES = [
      { key: 'BB', name: 'Business B*tch' }, { key: 'HDG', name: 'Hustle Definiton' },
      { key: 'MHG', name: 'Mother Hustler' }, { key: 'BCSG', name: 'Billionare Coming Soon' },
      { key: 'DQG', name: "Don't Quit" }, { key: 'GMG', name: 'Grind Mode' },
    ]
    const scope = buildForeignDesignTokens(NAMES, { familyTitleText: '', poolKeywords: [], strictNames: true, phraseNames: true })
    const HEALTHY: Record<string, string[]> = {
      BB: [
        "BOLD STATEMENT - The Business B*tch graphic celebrates ambition and the woman who owns her drive.",
        "GREAT GIFT - Perfect for the boss, the founder or the mom running her own company.",
        "PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash.",
        "BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season.",
        "EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over time.",
      ],
      HDG: [
        "DEFINE YOUR GRIND - The Hustle Definiton graphic is for the woman building her own business from the ground up.",
        "MOM APPROVED - A thoughtful gift for the mother who hustles harder than anyone she knows.",
        "PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash.",
        "BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season.",
        "EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over time.",
      ],
      MHG: [
        "BOSS ENERGY - The Mother Hustler graphic celebrates the mom who never stops, from the school run to closing the deal.",
        "GREAT GIFT - Perfect for a small business owner, entrepreneur, or boss mom who earned the title.",
        "PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash.",
        "BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season.",
        "EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over time.",
      ],
      BCSG: [
        "FUTURE BILLIONAIRE - The Billionare Coming Soon graphic is for the dreamer whose hustle never sleeps.",
        "GREAT GIFT - Ideal for an entrepreneur, business owner or side hustler with big plans.",
        "PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash.",
        "BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season.",
        "EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over time.",
      ],
      DQG: [
        "NEVER GIVE UP - The Don't Quit graphic is a daily reminder to keep going when it gets hard.",
        "GREAT GIFT - For the runner, the student or the entrepreneur grinding toward a goal.",
        "PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash.",
        "BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season.",
        "EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over time.",
      ],
      GMG: [
        "GRIND MODE ON - The Grind Mode graphic is built for the early riser who out-works the room.",
        "GREAT GIFT - A present for the hustler, the lifter or the small business owner in your life.",
        "PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash.",
        "BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season.",
        "EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over time.",
      ],
    }
    for (const { key } of NAMES) {
      const out = rejectForeignBullets(HEALTHY[key], scope(key))
      expect(out).toHaveLength(5)
    }
  })
})

describe('rejectForeignDescription — U1, the per-child description ship door (all-or-nothing)', () => {
  const introBlock = '<p><b>Hustle Definiton</b> is built for the grind — a bold statement for anyone who refuses to slow down.</p>'
  const listBlock = '<ul><li>Soft ringspun cotton for all-day comfort.</li><li>Classic crewneck fit layers easily.</li></ul>'
  const closingBlock = '<p>A perfect gift for the relentless go-getter in your life.</p>'
  const contaminatedBlock = "<p>Featuring the empowering phrase 'Business B*tch,' this sweatshirt speaks to anyone chasing their goals.</p>"
  const cleanBlocks = `${introBlock}${listBlock}${closingBlock}`
  const liveContaminatedDescription = `${introBlock}${contaminatedBlock}${listBlock}${closingBlock}`

  it('refuses the WHOLE description (not just the one block) when any part names the sibling design', () => {
    // U1: the old block-level strip silently deleted a child's OWN legitimate paragraph whenever
    // it shared an ordinary word with a sibling's name (measured, cost2.probe.test.ts, a -34% on
    // 4 of 6 children) — there is no partial edit any more. `[intro][contaminated][list][closing]`
    // in, `''` out; `pushFields.resolveProposed` then treats it as nothing-to-push (live stands).
    const foreign = sForeignFor('HDG')
    const out = rejectForeignDescription(liveContaminatedDescription, foreign)
    expect(out).toBe('')
  })

  it('a CLEAN description is a byte-identical no-op (fast path never even inspects it further)', () => {
    const foreign = sForeignFor('HDG')
    expect(rejectForeignDescription(cleanBlocks, foreign)).toBe(cleanBlocks)
  })

  it('stripForeignHtmlBlocks itself (kept as a direct block-level utility) still cleans an emptied <ul></ul>', () => {
    const html = "<p>Intro.</p><ul><li>Featuring 'Business B*tch' in bold text.</li></ul>"
    const out = stripForeignHtmlBlocks(html, (seg) => /business/i.test(seg))
    expect(out).not.toContain('<ul>')
    expect(out).not.toContain('<li>')
    expect(out).toContain('Intro.')
  })

  it('refuses to a safe EMPTY string — never ships the sibling slogan as a fallback', () => {
    const allContaminated = "<p>Featuring 'Business B*tch' proudly.</p>"
    const foreign = sForeignFor('HDG')
    const out = rejectForeignDescription(allContaminated, foreign)
    expect(out).toBe('')
  })

  it('IDEMPOTENT — refusing an already-empty string changes nothing', () => {
    const foreign = sForeignFor('HDG')
    const once = rejectForeignDescription(liveContaminatedDescription, foreign)
    expect(rejectForeignDescription(once, foreign)).toBe(once)
  })

  it('U5 FLOOR: a REFUSED description is empty, never a shortened one — pushFields treats it as nothing-to-push', () => {
    const foreign = sForeignFor('MHG')
    const healthy = "<p>The Mother Hustler design, printed on a heavyweight crewneck for everyday wear.</p><ul><li>Soft ringspun cotton</li><li>Relaxed crewneck fit</li></ul><p>A great gift for the entrepreneur or the boss mom in your life, whose hustle never stops.</p>"
    // Healthy, on-brand copy — no sibling named — survives WHOLE (byte-identical).
    expect(rejectForeignDescription(healthy, foreign)).toBe(healthy)
    // Contaminated copy is refused WHOLE, not trimmed to a partial (shorter-than-floor) string.
    const contaminated = "<p>Featuring the empowering phrase 'Business B*tch,' this crewneck celebrates ambition.</p>"
    expect(rejectForeignDescription(contaminated, foreign)).toBe('')
  })
})

describe('nameMatchesSibling — S4, the identity ratchet', () => {
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
