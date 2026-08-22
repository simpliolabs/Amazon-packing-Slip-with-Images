/**
 * THE SHARED CONTENT TRUTH SPINE — the pins for the four defects the PO caught live on B0DSCDZC6K
 * (a Gildan 18000 sweatshirt + 18500 hoodie variation family, stored `audience_lean='unisex'`):
 *
 *   (a) TITLE truncated mid-idiom — "…Fall Crewneck, Mind". The pool phrase "mind your business"
 *       contributed ONE orphan word because step 6b's harvest appended pool phrases WORD BY WORD.
 *   (b) GARMENT LIE — "Funny Work Shirts" on a sweatshirt/hoodie family. The only garment net on the
 *       title path grounds in a haystack DERIVED FROM THE TITLE, so a title carrying the lie is its
 *       own witness.
 *   (c) AUDIENCE LIE — "for Women" while audience_lean is 'unisex'. Nothing mapped the seller's
 *       declared lean onto any fill.
 *   (d) COMPETITOR BLANKS — stripped from bullets and description, never from the title.
 *   (e) BULLETS floor-hugging — 166/150/160/161/178 = 815 of 1000 possible characters, legal on
 *       every gate, because the contract had a floor and a ceiling but no TARGET.
 *
 * Each pin below names the defect it locks. The IH pins in itemHighlightComposer.test.ts are the
 * REGRESSION BAR for the promotion: the predicate moved out of that composer byte-for-byte.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  phraseTruthVerdict,
  applyTitleTruthNet,
  audienceOfGarmentFamily,
  normalizeAudienceLean,
  type PhraseTruthCtx,
} from './contentTruth'
import { ihTruthVerdict } from './itemHighlightComposer'
import {
  pooledNovelFragment,
  buildFragPool,
  expandShortBulletsTerminal,
  applyTerminalNets,
  BULLET_MIN_CHARS,
  BULLET_MAX_CHARS,
  BULLET_FILL_TARGET,
} from './listingPipeline'
import { CONTENT_CONTRACT } from './contentContract'

/* ── The B0DSCDZC6K family, as the resolver reports it ─────────────────────────────────────────── */

const GILDAN_18000 = { weightNote: 'heavyweight 8.0 oz fleece' }
/** Both blanks present under one parent — the union of garment classes is what copy may name. */
const SWEATS: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt',
  mixedFamilies: ['sweatshirt', 'hoodie'],
  spec: GILDAN_18000,
  allowedBrand: null,                 // Gildan is brand_in_copy=false
  audience: audienceOfGarmentFamily('sweatshirt'),
  audienceLean: 'unisex',
  field: 'title',
}
const TEE: PhraseTruthCtx = {
  garmentFamily: 'tee',
  spec: { weightNote: 'midweight 6.1 oz garment-dyed' },
  allowedBrand: 'Comfort Colors',
  audience: audienceOfGarmentFamily('tee'),
  audienceLean: null,
  field: 'title',
}

/* ── DEFECT (b): the garment lie, on every field ───────────────────────────────────────────────── */

describe('(b) garment truth — "funny work shirts" is a LIE on a sweatshirt/hoodie family', () => {
  for (const field of ['title', 'bullets', 'backend', 'description'] as const) {
    it(`rejects it for ${field} (the rule is field-agnostic)`, () => {
      expect(phraseTruthVerdict('funny work shirts', { ...SWEATS, field }))
        .toEqual({ ok: false, reason: 'wrong-garment-noun' })
    })
  }
  it('rejects the bare pool token too — the backend fill appends token by token', () => {
    expect(phraseTruthVerdict('shirts', { ...SWEATS, field: 'backend' }).ok).toBe(false)
    expect(phraseTruthVerdict('tees', { ...SWEATS, field: 'backend' }).ok).toBe(false)
  })
  it('a MIXED family may name EITHER of its blanks — the union, not the dominant row', () => {
    // 18000 is the dominant (sweatshirt) row; "hoodie" is still TRUE of this family's 18500 children.
    expect(phraseTruthVerdict('funny work hoodie', SWEATS)).toEqual({ ok: true })
    expect(phraseTruthVerdict('funny work sweatshirt', SWEATS)).toEqual({ ok: true })
    expect(phraseTruthVerdict('fall crewneck', SWEATS)).toEqual({ ok: true })
    // Without the union, the dominant sweatshirt row alone would call the hoodie a lie.
    expect(phraseTruthVerdict('funny work hoodie', { ...SWEATS, mixedFamilies: undefined }))
      .toEqual({ ok: false, reason: 'wrong-garment-noun' })
  })
  it('leaves a TEE family free to say shirt/tee — this is not a blanket garment blocklist', () => {
    for (const p of ['funny work shirts', 'graphic tees for women', 'cotton t shirt'])
      expect(phraseTruthVerdict(p, TEE)).toEqual({ ok: true })
  })
})

/* ── DEFECT (c): the audience lie, TITLE-ONLY by design ────────────────────────────────────────── */

describe('(c) audience-lean-lie — a unisex family forces no gender on its TITLE', () => {
  it('rejects a single-gender phrase for the TITLE when audienceLean is unisex', () => {
    for (const p of ['for women', 'womens sweatshirt', 'for men', 'mens crewneck', 'ladies pullover'])
      expect(phraseTruthVerdict(p, SWEATS)).toEqual({ ok: false, reason: 'audience-lean-lie' })
  })
  it('ALLOWS the same phrase on bullets/description/backend — they carry MARKET vocabulary', () => {
    for (const field of ['bullets', 'description', 'backend', 'highlights'] as const)
      expect(phraseTruthVerdict('womens sweatshirt', { ...SWEATS, field })).toEqual({ ok: true })
  })
  it('an INCLUSIVE phrase naming both genders is not a forced gender', () => {
    expect(phraseTruthVerdict('for men and women', SWEATS)).toEqual({ ok: true })
  })
  it('never fires without a declared unisex lean — a hard/soft lean keeps its gendered vocabulary', () => {
    for (const lean of ['women', 'men', null] as const)
      expect(phraseTruthVerdict('womens sweatshirt', { ...SWEATS, audienceLean: lean }).ok).toBe(true)
  })
  it('normalizeAudienceLean: only an explicit unisex is unisex; lean_* is a SOFT re-weighting', () => {
    expect(normalizeAudienceLean('unisex')).toBe('unisex')
    expect(normalizeAudienceLean('lean_female')).toBe('women')
    expect(normalizeAudienceLean('female')).toBe('women')
    expect(normalizeAudienceLean('lean_male')).toBe('men')
    expect(normalizeAudienceLean(null)).toBeNull()
  })
})

/* ── THE DESIGN-TOKEN EXEMPTION: judge the CLAIM, not the vocabulary ───────────────────────────── */

describe('design-token exemption — a family keeps its OWN design vocabulary', () => {
  /** An ADULT tee whose design is literally called "Baby Shark". */
  const BABY_SHARK: PhraseTruthCtx = { ...TEE, designTokens: ['Baby Shark'], field: 'backend' }
  /** An ADULT tee whose design is "Girl Dad" — the plural fold must let "girls" through too. */
  const GIRL_DAD: PhraseTruthCtx = { ...TEE, designTokens: ['Girl Dad'], field: 'bullets' }
  /** A youth blank (64000B). Adult vocabulary is the lie here. */
  const KIDS: PhraseTruthCtx = {
    garmentFamily: 'kids_tee', spec: TEE.spec, allowedBrand: null,
    audience: audienceOfGarmentFamily('kids_tee'), audienceLean: null, field: 'backend',
  }

  it('keeps "baby shark shirt" in BACKEND and BULLETS — the word names the DESIGN, not an audience', () => {
    for (const field of ['backend', 'bullets', 'description', 'title'] as const)
      expect(phraseTruthVerdict('baby shark shirt', { ...BABY_SHARK, field })).toEqual({ ok: true })
  })
  it('still rejects "toddler tee" on that same family — not a design token, so it IS an audience claim', () => {
    expect(phraseTruthVerdict('toddler tee', BABY_SHARK)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
  })
  it('ONE foreign hit is enough — "baby shark shirts for kids" still dies', () => {
    expect(phraseTruthVerdict('baby shark shirts for kids', BABY_SHARK))
      .toEqual({ ok: false, reason: 'audience-kids-on-adult' })
  })
  it('plural-folds the design word: a "Girl Dad" design owns "girls"', () => {
    expect(phraseTruthVerdict('girl dad shirt', GIRL_DAD)).toEqual({ ok: true })
    expect(phraseTruthVerdict('girls dad shirt', GIRL_DAD)).toEqual({ ok: true })
    expect(phraseTruthVerdict('youth girls tee', GIRL_DAD)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
  })
  it('WITHOUT the design token the very same phrase is still rejected (the rule did not weaken)', () => {
    expect(phraseTruthVerdict('baby shark shirt', { ...BABY_SHARK, designTokens: undefined }))
      .toEqual({ ok: false, reason: 'audience-kids-on-adult' })
    expect(phraseTruthVerdict('baby shark shirt', { ...BABY_SHARK, designTokens: [] }))
      .toEqual({ ok: false, reason: 'audience-kids-on-adult' })
  })
  it('a kids_tee family still rejects "womens graphic tees" — the rule is symmetric', () => {
    expect(phraseTruthVerdict('womens graphic tees', KIDS)).toEqual({ ok: false, reason: 'audience-adult-on-kids' })
    // …and the exemption is symmetric too: a kids design actually named "Ladies Night" keeps it.
    expect(phraseTruthVerdict('ladies night tee', { ...KIDS, designTokens: ['Ladies Night'] })).toEqual({ ok: true })
    expect(phraseTruthVerdict('womens graphic tees', { ...KIDS, designTokens: ['Ladies Night'] }))
      .toEqual({ ok: false, reason: 'audience-adult-on-kids' })
  })
  it('a design token NEVER licenses a GARMENT lie — the garment rule never reads designTokens', () => {
    // A sweatshirt family whose design is literally called "Sweatshirt Guy" still cannot say "shirts".
    const SWEATSHIRT_GUY: PhraseTruthCtx = { ...SWEATS, designTokens: ['Sweatshirt Guy'], audienceLean: null }
    expect(phraseTruthVerdict('funny work shirts', SWEATSHIRT_GUY)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(phraseTruthVerdict('sweatshirt guy tees', SWEATSHIRT_GUY)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    expect(phraseTruthVerdict('sweatshirt guy crewneck', SWEATSHIRT_GUY)).toEqual({ ok: true })
    // Nor any other rule: a design named after a competitor blank still cannot name it.
    expect(phraseTruthVerdict('gildan guy tee', { ...TEE, designTokens: ['Gildan Guy'] }))
      .toEqual({ ok: false, reason: 'competitor-brand' })
  })
  it('never licenses a forced gender on a unisex TITLE — the lean rule is untouched', () => {
    const WOMEN_DESIGN: PhraseTruthCtx = { ...SWEATS, designTokens: ['Wonder Women'] }
    expect(phraseTruthVerdict('womens sweatshirt', WOMEN_DESIGN)).toEqual({ ok: false, reason: 'audience-lean-lie' })
  })
  it('HIGHLIGHTS behavior is unchanged — the composer passes no design tokens', () => {
    const ihCtx = { garmentFamily: 'tee' as const, spec: TEE.spec, allowedBrand: null, audience: 'adult' as const }
    expect(ihTruthVerdict('baby shark shirt', ihCtx)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
    expect(ihTruthVerdict('motivational shirts women', ihCtx)).toEqual({ ok: true })
  })
  it('the pipeline feeds the ctx from the EXISTING design-name sources, no new resolver (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    const at = src.indexOf('const familyDesignNames: string[] = []')
    expect(at, 'familyDesignNames not built').toBeGreaterThan(0)
    const body = src.slice(at, at + 2200)
    for (const source of ['pushDesignName(designName)', 'input.designNameOverride', 'designNameOverridesByKey', 'priorPerChildTitles'])
      expect(body, `missing design-name source: ${source}`).toContain(source)
    expect(body).toContain('designTokens: familyDesignNames')
    // The per-design resolver registers each group's name at the ONE existing seam.
    expect(src).toContain('pushDesignName(groupDesignName)')
    expect(src).toContain('pushDesignName(coupleConcept)')
    // No second design-name resolver was introduced for this.
    expect((src.match(/extractDesignName\(/g) ?? []).length).toBe(3)   // definition + 2 existing callers
  })
})

/* ── DEFECTS (b)+(c)+(d) on the SHIPPED bytes: the terminal title net ──────────────────────────── */

describe('applyTitleTruthNet — the terminal net on the exact live B0DSCDZC6K title', () => {
  const LIVE = 'THE CEO Business B*tch Sweatshirt | Funny Work Shirts, Fall Crewneck, Mind'

  it('drops the garment lie and keeps everything true', () => {
    const out = applyTitleTruthNet(LIVE, SWEATS)
    expect(out).not.toMatch(/Funny Work Shirts/)
    expect(out).toContain('THE CEO Business B*tch Sweatshirt')   // segment 0 is never dropped
    expect(out).toContain('Fall Crewneck')
  })
  it('drops a forced-gender tail on a unisex family, keeping its segment content', () => {
    const t = 'THE CEO Business B*tch Sweatshirt | Fall Crewneck for Women'
    const out = applyTitleTruthNet(t, SWEATS)
    expect(out).toBe('THE CEO Business B*tch Sweatshirt | Fall Crewneck')
  })
  it('keeps the gendered tail when the seller DECLARED that gender', () => {
    const t = 'THE CEO Business B*tch Sweatshirt | Fall Crewneck for Women'
    expect(applyTitleTruthNet(t, { ...SWEATS, audienceLean: 'women' })).toBe(t)
  })
  it('is idempotent — a second pass finds nothing left to drop', () => {
    const once = applyTitleTruthNet(LIVE, SWEATS)
    expect(applyTitleTruthNet(once, SWEATS)).toBe(once)
  })
  it('is a no-op on a truthful tee title (no blanket garment scrub)', () => {
    const t = 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt'
    expect(applyTitleTruthNet(t, TEE)).toBe(t)
  })
  it('never costs the seller a design name split across a comma', () => {
    // "See You Later, Alligator" puts "Alligator Tee" in a DROPPABLE segment on a sweatshirt family.
    // Losing the design is strictly worse than the lie beside it — the design word wins.
    const t = 'THE CEO See You Later, Alligator Tee | Fall Crewneck'
    expect(applyTitleTruthNet(t, SWEATS, 'See You Later Alligator')).toBe(t)
    // …but a segment that merely RESTATES design words already present elsewhere is still droppable.
    const restated = 'THE CEO See You Later Alligator Sweatshirt | Alligator Tees, Fall Crewneck'
    expect(applyTitleTruthNet(restated, SWEATS, 'See You Later Alligator'))
      .toBe('THE CEO See You Later Alligator Sweatshirt | Fall Crewneck')
  })
  it('never edits a title this run did not PRODUCE (source pin — bullets-only regens pass through)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    const at = src.indexOf('const titleTruthDoor')
    const body = src.slice(at, at + 700)
    expect(body).toContain('if (!t || !produced || !apparelProduct) return t')
    expect((src.match(/titleTruthDoor\([^)]*\), opts\?\.titleProduced !== false\)/g) ?? []).length).toBe(2)
  })
  it('DELIBERATELY leaves kids/adult words alone on the title — a design name may carry them', () => {
    const t = 'THE CEO Baby Shark Sweatshirt | Fall Crewneck, Cozy Fleece Pullover'
    expect(applyTitleTruthNet(t, SWEATS)).toBe(t)
    // …while the FILL still refuses to harvest them from the pool.
    expect(phraseTruthVerdict('baby shark shirts', SWEATS).ok).toBe(false)
  })
})

describe('(d) competitor blanks reach the TITLE path too', () => {
  it('the predicate rejects another maker on every field, own blank exempted by name', () => {
    expect(phraseTruthVerdict('gildan softstyle tee', TEE)).toEqual({ ok: false, reason: 'competitor-brand' })
    expect(phraseTruthVerdict('comfort colors shirt', TEE)).toEqual({ ok: true })
    expect(phraseTruthVerdict('comfort colors sweatshirt', SWEATS).ok).toBe(false)  // Gildan family: not ours
  })
  it('the title door composes stripCompetitorBlanks BEFORE the truth net (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    const at = src.indexOf('const titleTruthDoor')
    expect(at, 'titleTruthDoor not found at the ship door').toBeGreaterThan(0)
    // Window widened 2026-08-22: the door now also documents the PER-DESIGN truth ctx it selects
    // before calling the net. The ORDER is what this pin owns, and it is unchanged.
    const body = src.slice(at, at + 1600)
    expect(body).toContain('stripCompetitorBlanks')
    expect(body).toContain('applyTitleTruthNet')
    expect(body.indexOf('stripCompetitorBlanks')).toBeLessThan(body.indexOf('applyTitleTruthNet'))
  })
})

/* ── DEFECT (a): the "Mind" case — no partial fragment, ever ───────────────────────────────────── */

describe('(a) a pool phrase that cannot fit WHOLE contributes NOTHING to the title', () => {
  // The exact live shape: 75-char budget, the head already at 63 chars, "mind your business" in the pool.
  const HEAD = 'THE CEO Business B*tch Sweatshirt | Funny Sweats, Fall Crewneck'
  const fragPool = buildFragPool([['mind your business', 'funny work sweatshirt', 'fall crewneck']])
  const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())

  it('the head leaves room for ", Mind" but NOT for the whole idiom (the live budget)', () => {
    expect(HEAD.length).toBe(63)
    expect(`${HEAD}, Mind`.length).toBeLessThanOrEqual(75)
    expect(`${HEAD}, Mind Your Business`.length).toBeGreaterThan(75)
  })

  it('ships NO fragment rather than the orphan ", Mind"', () => {
    const frag = pooledNovelFragment(
      'mind your business',
      new Set<string>(),
      fragPool,
      () => false,
      (f) => `${HEAD}, ${titleCase(f)}`.length <= 75,
    )
    expect(frag).toBeNull()
  })

  it('ships the idiom WHOLE when the budget allows — the gate is completeness, not refusal', () => {
    const frag = pooledNovelFragment('mind your business', new Set<string>(), fragPool, () => false, () => true)
    expect(frag).toBe('mind your business')
  })

  it('a headless remainder is not a phrase anyone searched ("Too Many" out of "too many books")', () => {
    const pool = buildFragPool([['too many books']])
    const covered = new Set(['book'])          // "books" already in the title
    expect(pooledNovelFragment('too many books', covered, pool, () => false, () => true)).toBeNull()
  })

  it('an untrue fragment is rejected even when it IS a pooled phrase', () => {
    const pool = buildFragPool([['funny work shirts']])
    const frag = pooledNovelFragment(
      'funny work shirts', new Set<string>(), pool, () => false, () => true,
      (f) => !phraseTruthVerdict(f, SWEATS).ok,
    )
    expect(frag).toBeNull()
  })

  it('step 6b and both second passes call THE one harvester — no parallel word-splitter (source pin)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    // Three call sites: buildTitleFor pass 2, buildTitleFor step 6b, buildNicheParentTitle pass 2.
    // Newline-agnostic on purpose: this checkout is CRLF on Windows and LF in CI.
    expect((src.match(/=\s*pooledNovelFragment\(/g) ?? []).length).toBe(3)
    // The word-by-word append that shipped ", Mind" must be gone: 6b's old loop kept a `firstAdd`
    // flag and appended a single `capped` WORD. Both are the fingerprint of the deleted mechanism.
    expect(src).not.toContain('let firstAdd = true')
    expect(src).not.toContain('head = next; have.add(norm); firstAdd = false')
  })
})

/* ── PATH PARITY: both title producers get the SAME spine ──────────────────────────────────────── */

describe('single-design and multi-design producers run the IDENTICAL new rules', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')

  it('both producers take the truth ctx and both build the same truthOk gate', () => {
    for (const producer of ['buildTitleFor', 'buildNicheParentTitle']) {
      const at = src.indexOf(`async function ${producer}(`)
      expect(at, `${producer} not found`).toBeGreaterThan(0)
      const body = src.slice(at, at + 4000)
      expect(body, `${producer} does not accept the truth ctx`).toContain('truth: PhraseTruthCtx | null = null')
      expect(body, `${producer} does not build the shared gate`).toContain('phraseTruthVerdict(phrase, truth).ok')
    }
  })
  it('every title producer call site passes the family truth ctx', () => {
    const calls = src.match(/await build(?:TitleFor|NicheParentTitle)\([^\n]*\)/g) ?? []
    expect(calls.length).toBe(4)          // 3× buildTitleFor (couple / per-design / single) + 1× parent
    for (const c of calls) expect(c, c).toContain('titleTruthCtx')
  })
  it('both producers strip competitor blanks from the title (defect (d) parity)', () => {
    for (const producer of ['buildTitleFor', 'buildNicheParentTitle']) {
      const at = src.indexOf(`async function ${producer}(`)
      const body = src.slice(at, at + 9000)
      expect(body, `${producer} never strips competitor blanks`).toContain('stripCompetitorBlanks(')
    }
  })
  it('the ship door applies the net to the broadcast AND every per-child title', () => {
    expect(src).toContain('recommended_title: bandTitle(titleTruthDoor(')
    expect(src).toContain("title: bandTitle(titleTruthDoor(scrubPub(c.title, 'per-child-title'),")
  })
  it('a family-level ctx gives the same verdict whichever producer asks', () => {
    // The ctx is built ONCE from the resolved blank; it has no producer-specific field.
    const single = { ...SWEATS }
    const parent = { ...SWEATS }
    for (const p of ['funny work shirts', 'for women', 'fall crewneck', 'gildan softstyle'])
      expect(phraseTruthVerdict(p, single)).toEqual(phraseTruthVerdict(p, parent))
  })
})

/* ── DEFECT (e): bullets seek the ceiling, on EVERY path ───────────────────────────────────────── */

const openaiThatAlwaysFails = {
  chat: { completions: { create: async () => { throw new Error('simulated outage') } } },
} as never

/** The PO's live B0DSCDZC6K set, at the exact measured lengths: 166/150/160/161/178. No weight-class
 *  adjective in the filler — `applyTerminalNets` runs `enforceFabricTruth`, which correctly deletes
 *  an unbacked "heavyweight" and would confound a LENGTH assertion with a TRUTH one. */
const grow = (hook: string, n: number): string => {
  const filler = ' Soft brushed fleece keeps its shape wash after wash and layers cleanly over everything you already own for cozy everyday comfort all season long'
  let s = `${hook} -`
  while (s.length < n) s += filler
  s = s.slice(0, n - 1)
  if (/[\s.]$/.test(s)) s = `${s.slice(0, -1)}y`        // never a dangling space (trim would resize it)
  return `${s}.`
}
const FLOOR_HUGGING = [
  grow('COZY EVERY DAY', 166), grow('BOLD STATEMENT', 150), grow('BUILT TO LAST', 160),
  grow('EASY LAYERING', 161), grow('THOUGHTFUL GIFT', 178),
]

describe('(e) the bullets contract has a TARGET, and the terminal net seeks it', () => {
  it('the contract names ONE fill target, between the floor and the ceiling', () => {
    expect(CONTENT_CONTRACT.bullets.fillTarget).toBe(195)
    expect(BULLET_FILL_TARGET).toBe(CONTENT_CONTRACT.bullets.fillTarget)
    expect(BULLET_FILL_TARGET).toBeGreaterThan(BULLET_MIN_CHARS)
    expect(BULLET_FILL_TARGET).toBeLessThanOrEqual(BULLET_MAX_CHARS)
  })

  it('the live floor-hugging set measures 815 of 1000 — legal on every old gate', () => {
    expect(FLOOR_HUGGING.map((b) => b.length)).toEqual([166, 150, 160, 161, 178])
    FLOOR_HUGGING.forEach((b) => expect(b.length).toBeGreaterThanOrEqual(BULLET_MIN_CHARS))
    expect(FLOOR_HUGGING.reduce((n, b) => n + b.length, 0)).toBe(815)
  })

  it('FULL path: the terminal expander grows every bullet toward the target, with ZERO model calls', async () => {
    const out = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...FLOOR_HUGGING], {
      title: 'THE CEO Business B*tch Sweatshirt | Fall Crewneck',
      designName: 'Business B*tch',
      truth: { ...SWEATS, field: 'bullets' },
    })
    const total = out.reduce((n, b) => n + b.length, 0)
    expect(total).toBeGreaterThan(815)
    out.forEach((b, i) => {
      expect(b.length).toBeGreaterThanOrEqual(FLOOR_HUGGING[i].length)   // monotonic — never regresses
      expect(b.length).toBeLessThanOrEqual(BULLET_MAX_CHARS)             // still capped
    })
  })

  it('SECTION-REGEN path: applyTerminalNets("bullets") does the same (INVARIANT 3)', async () => {
    const out = await applyTerminalNets('bullets', [...FLOOR_HUGGING], {
      openai: openaiThatAlwaysFails,
      finalTitle: 'THE CEO Business B*tch Sweatshirt | Fall Crewneck',
      designName: 'Business B*tch',
      fit: undefined,
      brandName: 'THE CEO',
      garmentBrand: undefined,
      weightNote: GILDAN_18000.weightNote,
      truth: { ...SWEATS, field: 'bullets' },
    }) as string[]
    expect(out.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(815)
    out.forEach((b) => expect(b.length).toBeLessThanOrEqual(BULLET_MAX_CHARS))
  })

  it('PER-CHILD path: the per-design fan-out calls the same exported net (source pin + behavior)', async () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    // Every expander call site forwards the truth ctx — full, section-regen and per-child alike.
    const sites = src.match(/expandShortBulletsTerminal\(input\.openai/g) ?? []
    expect(sites.length).toBe(2)                                  // per-child fan-out + broadcast
    expect((src.match(/truth: bulletsTruthCtx/g) ?? []).length).toBe(4)
    // The per-child ctx shape (title/designName/fit/garmentBrand) behaves identically.
    const out = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...FLOOR_HUGGING], {
      title: 'THE CEO Business B*tch Sweatshirt', designName: 'Business B*tch',
      fit: 'relaxed', garmentBrand: undefined, truth: { ...SWEATS, field: 'bullets' },
    })
    expect(out.reduce((n, b) => n + b.length, 0)).toBeGreaterThan(815)
  })

  it('stays idempotent: growing twice adds nothing further', async () => {
    const ctx = { title: 'THE CEO Business B*tch Sweatshirt', designName: 'Business B*tch' }
    const once = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...FLOOR_HUGGING], ctx)
    const twice = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...once], ctx)
    expect(twice).toEqual(once)
  })

  it('an already-at-target set is returned byte-identical', async () => {
    const atTarget = Array.from({ length: 5 }, (_, i) => grow(`BENEFIT ${i}`, BULLET_FILL_TARGET + 2))
    const out = await expandShortBulletsTerminal(openaiThatAlwaysFails, [...atTarget], {
      title: 'THE CEO Business B*tch Sweatshirt',
    })
    expect(out).toEqual(atTarget)
  })
})

/* ── THE PROMOTION ITSELF: the Item Highlight contract is unchanged ────────────────────────────── */

describe('promotion regression bar — ihTruthVerdict is a thin wrapper, not a rewrite', () => {
  it('returns the SAME verdict as the spine for the highlights field', () => {
    const ihCtx = { garmentFamily: 'tee' as const, spec: TEE.spec, allowedBrand: null, audience: 'adult' as const }
    for (const p of ['france soccer jersey', 'sun protection fishing shirt', 'kids dinosaur shirt',
      'pro club shirts', 'heavyweight cotton tee', 'motivational shirts women']) {
      expect(ihTruthVerdict(p, ihCtx))
        .toEqual(phraseTruthVerdict(p, { ...ihCtx, field: 'highlights', audienceLean: null }))
    }
  })
  it('can NEVER return the title-only forced-gender reason, whatever the family lean', () => {
    const ihCtx = { garmentFamily: 'sweatshirt' as const, spec: GILDAN_18000, allowedBrand: null, audience: 'adult' as const }
    expect(ihTruthVerdict('womens sweatshirt', ihCtx)).toEqual({ ok: true })
  })
  it('audienceOfGarmentFamily is the composer\'s ihAudienceOf, unmoved', () => {
    expect(audienceOfGarmentFamily('kids_tee')).toBe('kids')
    expect(audienceOfGarmentFamily('sweatshirt')).toBe('adult')
    expect(audienceOfGarmentFamily('hoodie')).toBe('adult')
    expect(audienceOfGarmentFamily(null)).toBeNull()
  })
})
