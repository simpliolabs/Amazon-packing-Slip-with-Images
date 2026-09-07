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
  LEAN_FEM_CORE,
  LEAN_MASC_CORE,
  type PhraseTruthCtx,
} from './contentTruth'
import { ihTruthVerdict } from './itemHighlightComposer'
import { verdictForAssembledTitle, type AssembledTitleCtx } from './titleBand'
import { leanExcludesKeyword } from '@/lib/keyword-engine/nicheGuards'
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

/* ── FIX ROUND (final fix wave, 2026-09-06) — rule (f) fit-claim-lie is ITEM HIGHLIGHTS ONLY
 * (Important #1). REPRODUCED against HEAD 7c53fc2 (see the wave's report, probe 1): rule (f) was
 * field-agnostic and fired on EVERY field including title/backend — a SECOND fit oracle on the title
 * path the plan forbade touching, provably disagreeing with the title path's OWN oracle
 * (titleBand.ts:747-753 `scrubUnspecdGarmentClaims` + its `FIT_WORD_CANON`, titleBand.ts:758). Gated
 * exactly like rule (c2) above (an `if (ctx.field === ...)` guard) — unifying the two oracles is
 * Phase 4 of the title programme, not this task. ───────────────────────────────────────────────── */

describe('(f) fit-claim-lie — ITEM HIGHLIGHTS ONLY (Important #1)', () => {
  const CLASSIC_FIT_TEE: PhraseTruthCtx = {
    garmentFamily: 'tee',
    spec: { fit: 'Classic' },
    allowedBrand: null,
    audience: audienceOfGarmentFamily('tee'),
    audienceLean: null,
    field: 'highlights',
  }
  it('does NOT fire on title/backend — REPRODUCED as a defect against HEAD 7c53fc2 (rule (f) used to return fit-claim-lie here)', () => {
    for (const field of ['title', 'backend'] as const) {
      expect(phraseTruthVerdict('relaxed fit tee', { ...CLASSIC_FIT_TEE, field })).toEqual({ ok: true })
    }
  })
  it('still fires on highlights — the ONE field with no fit oracle at all before Task 4', () => {
    expect(phraseTruthVerdict('relaxed fit tee', CLASSIC_FIT_TEE)).toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
})

/* ── DEFECT (c): the audience lie, TITLE-ONLY by design ────────────────────────────────────────── */

describe('(c) audience-lean-lie — a unisex family forces no gender on its TITLE', () => {
  it('rejects a single-gender phrase for the TITLE when audienceLean is unisex', () => {
    for (const p of ['for women', 'womens sweatshirt', 'for men', 'mens crewneck', 'ladies pullover'])
      expect(phraseTruthVerdict(p, SWEATS)).toEqual({ ok: false, reason: 'audience-lean-lie' })
  })
  it('ALLOWS the same phrase on bullets/description/backend — they carry MARKET vocabulary', () => {
    // CHANGED (Task 5, 2026-09-06 item-highlights-per-design plan): this loop used to ALSO include
    // 'highlights', pinning the PRE-Task-5 state where `ihTruthVerdict` hardcoded `audienceLean:
    // null` so the rule could never fire there regardless of what `phraseTruthVerdict` itself did.
    // Item Highlights joins the TITLE's side of this line now (see the (c3) describe block below) —
    // it is a customer-facing product-fact field, not a keyword-research surface like bullets/
    // description/backend remain. Moved deliberately, not weakened: 'highlights' is asserted
    // OPPOSITE below, with its own design-own-name exemption.
    for (const field of ['bullets', 'description', 'backend'] as const)
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

/* ── DEFECT (c) EXTENDED: Item Highlights (Task 5, 2026-09-06 item-highlights-per-design plan) ──
 *
 * Root cause (proven by the Task 1 implementer, not guessed): the Item Highlights composer had NO
 * audience-lean rule at all — `ihTruthVerdict` hardcoded `audienceLean: null` so this rule could
 * never fire there regardless of what the SHARED predicate itself did. Live: "Why is Women repeating
 * Twice?" on UNISEX family B0DSCDZC6K. Item Highlights joins the TITLE's side of the (c2) rule (a
 * customer-facing product-fact field, not a keyword-research surface) — the SAME predicate, widened
 * to a second field, never a second rule. Unlike the title, `ihTruthVerdict` threads a design-own-
 * name exemption (per-design `designTokens`, never the family-wide union the title uses).
 */
describe('(c2 extended) audience-lean-lie now ALSO fires on Item Highlights — same rule, second field', () => {
  it('rejects a single-gender phrase for `field: "highlights"` when audienceLean is unisex — same verdict as the TITLE', () => {
    for (const p of ['for women', 'womens sweatshirt', 'for men', 'mens crewneck', 'ladies pullover'])
      expect(phraseTruthVerdict(p, { ...SWEATS, field: 'highlights' })).toEqual({ ok: false, reason: 'audience-lean-lie' })
  })
  it('an INCLUSIVE phrase naming both genders is still not a forced gender on `highlights`', () => {
    expect(phraseTruthVerdict('for men and women', { ...SWEATS, field: 'highlights' })).toEqual({ ok: true })
  })
  it('never fires without a declared unisex lean, same as the title', () => {
    for (const lean of ['women', 'men', null] as const)
      expect(phraseTruthVerdict('womens sweatshirt', { ...SWEATS, field: 'highlights', audienceLean: lean }).ok).toBe(true)
  })
  it('the DESIGN-OWN-NAME exemption applies ONLY to `highlights` (Task 5), never to the title (unchanged, family-wide `designTokens` there)', () => {
    // "Mother Hustler" carries no LEAN_FEM_RE/LEAN_MASC_RE word, so use a design whose name actually
    // does: "Lady Boss" ("lady" matches the same lexicon "womens"/"ladies" use).
    const withLadyBossName = { ...SWEATS, designTokens: ['Lady Boss'] }
    expect(phraseTruthVerdict('lady boss sweatshirt', { ...withLadyBossName, field: 'highlights' })).toEqual({ ok: true })
    // The exemption is about the CLAIM matching the design's own name, not "any gendered word is now
    // fine for this design" — an UNRELATED gendered phrase in the same design's pool still lies.
    expect(phraseTruthVerdict('womens sweatshirt', { ...withLadyBossName, field: 'highlights' }))
      .toEqual({ ok: false, reason: 'audience-lean-lie' })
    // TITLE is untouched: this task must not change title behavior, so the SAME designTokens here
    // does NOT exempt the title (it never read designTokens for this rule before, and still doesn't).
    expect(phraseTruthVerdict('lady boss sweatshirt', { ...withLadyBossName, field: 'title' }))
      .toEqual({ ok: false, reason: 'audience-lean-lie' })
  })
  it('ihTruthVerdict (the composer\'s own wrapper) reflects the same rule end-to-end — `audience-lean-lie` is no longer excluded from its reason type', () => {
    expect(ihTruthVerdict('womens sweatshirt', { ...SWEATS, audienceLean: 'unisex' }))
      .toEqual({ ok: false, reason: 'audience-lean-lie' })
    // Every caller before Task 5 passed no `audienceLean` at all — still a no-op, byte-identical.
    expect(ihTruthVerdict('womens sweatshirt', { ...SWEATS, audienceLean: undefined }).ok).toBe(true)
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
  it('every title producer call site passes a shared family-level truth ctx (never an ad-hoc one)', () => {
    // `broadcastTruthCtx` (defect 1, PO 2026-08-23, live B0DSCDZC6K: a sweatshirt-dominant/hoodie-
    // minority family shipped "…Hoodie" on the shared parent title) is the SAME `truthCtxFor`-built,
    // family-level ctx `titleTruthCtx` is — just with `mixedFamilies` omitted so a broadcast/parent
    // exit (answerable to every child at once) commits to the family's DOMINANT class alone, never
    // the permissive union. It is defined once, right beside `titleTruthCtx`, and reused at every
    // call site that is unambiguously the broadcast/parent exit (couple/unified-set, the explicit
    // multi-design parent, and the single-design branch — none of which fan out per-child titles);
    // the one PER-DESIGN fallback call site (`groupTruthCtx ?? titleTruthCtx`) still reads
    // `titleTruthCtx` because an unresolved design group's fallback is a per-child concern, not a
    // broadcast one, and is deliberately unchanged by defect 1's fix. PATH PARITY still holds: every
    // call site reads ONE of these two named, shared variables — never a one-off ctx built inline.
    const calls = src.match(/await build(?:TitleFor|NicheParentTitle)\([^\n]*\)/g) ?? []
    expect(calls.length).toBe(4)          // 3× buildTitleFor (couple / per-design / single) + 1× parent
    for (const c of calls) expect(c, c).toMatch(/\b(?:titleTruthCtx|broadcastTruthCtx)\b/)
  })
  it('both producers strip competitor blanks from the title (defect (d) parity)', () => {
    for (const producer of ['buildTitleFor', 'buildNicheParentTitle']) {
      const at = src.indexOf(`async function ${producer}(`)
      // Window widened 2026-08-23 (kids-audience-truth fix): a few comment lines landed ahead of
      // `stripCompetitorBlanks(` inside buildNicheParentTitle and pushed it just past the old 9000.
      const body = src.slice(at, at + 10000)
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

/**
 * TASK 7 (2026-09-06, item-highlights-per-design plan). PO ruling verbatim "1. Extend", given after
 * the final whole-branch reviewer (agent a081fa7a, read-only) probed the realistic six-design fixture
 * under `audienceLean: 'unisex'` and observed every one of the six shipped lines leading with "Novelty
 * Shirts for Guys" — REPRODUCED against this file's own HEAD (5144d4e, pre-Task-7):
 * `phraseTruthVerdict('novelty shirts for guys', { ...unisex tee ctx, field: 'highlights' })` returned
 * `{ ok: true }` (a defect) because `LEAN_MASC_RE` was `m[ae]n['’]?s?` only — `guys` was invisible to
 * it, while `phraseTruthVerdict('novelty shirts for men', ...)` already correctly returned
 * `audience-lean-lie` (the control).
 *
 * THE FIX widens the SAME shared predicate rule (c2) already consumes — `LEAN_FEM_RE`/`LEAN_MASC_RE`
 * — with adult slang only: feminine `+gals`; masculine `+guys|guy|dudes|dude|bros|bro|gents|gent`.
 * `girls`/`boys` deliberately stay OFF this lexicon and on the KIDS axis (rule (c), `KIDS_AUDIENCE_RE`
 * above) — the controller's pre-stage ruling (task-7-brief.md) pinned below, so double-classifying a
 * kids family's correct "shirts for girls" as a forced-gender lie can never recur.
 *
 * ONE LEXICON, not four: the core is now EXPORTED from this file as pattern STRINGS (`LEAN_FEM_CORE`/
 * `LEAN_MASC_CORE`, not compiled RegExp) so the two other module-private copies this task found
 * (`nicheGuards.ts:220`, `syncListingContent.ts:382` — both already independently drifted, carrying
 * `female`/`girls?` this file never had) COMPOSE their own extra axis words onto this SAME core
 * instead of hand-copying it. `contentTruth.ts` is a leaf module (verified before this task: neither
 * consumer's import chain loops back to itself), so both import directly — the "preferred" path per
 * the brief, not the enumeration-test fallback (added anyway, belt-and-suspenders, below).
 */
describe('Task 7: forced-gender lexicon extended with adult slang — ONE lexicon, both surfaces', () => {
  const MASC_SLANG = ['for guys', 'guys crewneck', 'for dudes', 'dudes pullover', 'for bros', 'bros hoodie', 'for gents', 'gents sweatshirt']
  const FEM_SLANG = ['for gals', 'gals crewneck']

  it('REPRODUCTION: rejects masculine slang on the TITLE the same way "for men" already is (field:\'title\', unisex)', () => {
    for (const p of MASC_SLANG) expect(phraseTruthVerdict(p, SWEATS)).toEqual({ ok: false, reason: 'audience-lean-lie' })
  })
  it('rejects masculine slang on ITEM HIGHLIGHTS too — same rule, second field (this is the PO\'s exact live instance)', () => {
    for (const p of MASC_SLANG) expect(phraseTruthVerdict(p, { ...SWEATS, field: 'highlights' })).toEqual({ ok: false, reason: 'audience-lean-lie' })
  })
  it('rejects the feminine addition ("gals") the same way "for women" already is, on both fields', () => {
    for (const p of FEM_SLANG) {
      expect(phraseTruthVerdict(p, SWEATS)).toEqual({ ok: false, reason: 'audience-lean-lie' })
      expect(phraseTruthVerdict(p, { ...SWEATS, field: 'highlights' })).toEqual({ ok: false, reason: 'audience-lean-lie' })
    }
  })
  it('an INCLUSIVE phrase naming both slang genders is still not a forced gender', () => {
    expect(phraseTruthVerdict('crewneck for guys and gals', SWEATS)).toEqual({ ok: true })
  })
  it('never fires without a declared unisex lean — a hard lean keeps ITS OWN slang vocabulary (a lean_male/lean_female SIBLING may still carry it)', () => {
    expect(phraseTruthVerdict('for guys', { ...SWEATS, audienceLean: 'men' }).ok).toBe(true)
    expect(phraseTruthVerdict('for gals', { ...SWEATS, audienceLean: 'women' }).ok).toBe(true)
  })
  it('word-boundary discipline is unchanged by the extension: germany / human / management / guyana are NOT matched', () => {
    for (const p of ['germany flag crewneck', 'human rights pullover', 'management team hoodie', 'guyana flag sweatshirt'])
      expect(phraseTruthVerdict(p, SWEATS)).toEqual({ ok: true })
  })

  it('KIDS/ADULT AXIS SPLIT — the controller\'s pre-stage ruling, verbatim pins (girls/boys stay OFF the gender lexicon)', () => {
    const KIDS_UNISEX: PhraseTruthCtx = {
      garmentFamily: 'kids_tee', spec: TEE.spec, allowedBrand: null,
      audience: audienceOfGarmentFamily('kids_tee'), audienceLean: 'unisex', field: 'highlights',
    }
    // kids family + "shirts for girls" + design lean unisex → ok under (c2) (girls is not in the
    // gender lexicon) AND ok under (c) (kids audience asserted on a kids family is not foreign).
    expect(phraseTruthVerdict('shirts for girls', KIDS_UNISEX)).toEqual({ ok: true })
    // adult unisex family + "novelty shirts for guys" → audience-lean-lie — the PO's exact live
    // instance ("Novelty Shirts for Guys" on six unisex designs).
    expect(phraseTruthVerdict('novelty shirts for guys', { ...TEE, audienceLean: 'unisex' }))
      .toEqual({ ok: false, reason: 'audience-lean-lie' })
    // lean_male adult family + "for guys" → ok — a hard/soft lean keeps its own gendered vocabulary
    // (rule (c2) never fires without a declared unisex lean; unchanged by this task).
    expect(phraseTruthVerdict('for guys', { ...SWEATS, audienceLean: 'men' })).toEqual({ ok: true })
    // adult family + "for girls" → STILL rejected, but by rule (c) audience-kids-on-adult, NOT (c2) —
    // unchanged behavior, pinned here so the split between the two axes is visible in one place.
    expect(phraseTruthVerdict('for girls', SWEATS)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
  })

  it('LEAN_FEM_CORE / LEAN_MASC_CORE are the exact pattern strings the ruling specified (lexicon-content pin)', () => {
    expect(LEAN_FEM_CORE).toBe(`wom[ae]n['’]?s?|ladies|lady|gals`)
    expect(LEAN_MASC_CORE).toBe(`m[ae]n['’]?s?|guys|guy|dudes|dude|bros|bro|gents|gent`)
  })

  /* ── ONE LEXICON: both other copies compose onto the SAME exported core, never hand-copy it ──── */
  describe('ONE lexicon, not four — the two other copies compose onto the shared core', () => {
    it('nicheGuards.ts leanExcludesKeyword: the new slang words exclude the SAME way the pre-existing words already did', () => {
      // BEHAVIORAL proof against the REAL exported function (not merely a source pin) — nicheGuards.ts
      // has zero OTHER imports (verified before this task), so importing it here carries no
      // environment risk (no supabase/env-var dependency, unlike syncListingContent.ts below).
      for (const kw of ['tee for guys', 'tee for dudes', 'tee for bros', 'tee for gents'])
        expect(leanExcludesKeyword(kw, 'female'), kw).toBe(true)        // excluded, same as "tee for men"
      expect(leanExcludesKeyword('tee for gals', 'male')).toBe(true)    // excluded, same as "tee for women"
      expect(leanExcludesKeyword('tee for guys', 'male')).toBe(false)   // same-gender keyword is KEPT
      expect(leanExcludesKeyword('tee for guys', null)).toBe(false)     // soft/unisex lean: no-op, unchanged
    })
    // The old "enumeration/source pin" that lived here (an `expect(src).toContain('LEAN_FEM_CORE')`
    // identifier-anywhere check) is DELETED (fix round 1, I1): the opus reviewer proved by executed
    // perturbation that re-drifting syncListingContent.ts's regex to a hand-copied literal, with the
    // now-decorative import line left in place, stayed GREEN under that pin — a false assurance. It
    // is replaced by `genderLexiconSingleSource.test.ts`'s SOURCE-SCAN ENUMERATION TEST, which reads
    // the consumer's actual regex body (not merely whether the identifier appears somewhere in the
    // file) and fails on a re-drift, a brand-new copy anywhere in src/lib, or an edited allowlist
    // entry — see that file's header doc for the full mechanism. `listingPipeline.ts` and
    // `rankAnalysis.ts` still carry their OWN independent copies of a similar, already-diverged
    // lexicon — out of scope for Task 7 (the brief's and controller's "ONE lexicon, not four"
    // paragraph names only `nicheGuards.ts`/`syncListingContent.ts` + the core); every one of those
    // legacy sites is now enumerated and classified in that test's `ALLOWLIST`, not silently ignored.
  })
})

/**
 * FIX ROUND 1 (2026-09-06, controller ruling on the opus reviewer's B1) — the DETECTOR (`LEAN_FEM_RE`/
 * `LEAN_MASC_RE`) was widened by Task 7; the REMOVER was not. `scrubMoneyPhrase`'s rule (b) detected
 * "for Guys" as a forced-gender lie but stripped with a hand-copied `wom[ae]n['’]?s?`/`m[ae]n['’]?s?`
 * literal that never learned the nine new words, and `AUDIENCE_TAIL_RE` (the ONE thing standing
 * between a whole-segment DROP and a surgical clause-only strip) was the same story. Because
 * `verdictForAssembledTitle`'s ship gate judges truth by NET IDEMPOTENCE (`netted !== t` -> blocked),
 * a lie the net could not touch read as CLEAN: "…Novelty Shirts for Guys" SHIPPED, byte-identical to
 * BASE, while its "for Men" twin was BLOCKED (task-7-review-findings.md, B1, executed evidence (a)).
 * THE FIX derives both halves from the SAME `LEAN_FEM_CORE`/`LEAN_MASC_CORE` the detector already
 * uses (see `LEAN_FEM_STRIP_RE`/`LEAN_MASC_STRIP_RE` and the widened `AUDIENCE_TAIL_RE`, both above)
 * — the rule (b2) idiom one rule below, now applied to rule (b) too.
 */
describe('Fix round 1 (B1): the title REMOVER now derives from the SAME core the DETECTOR uses', () => {
  const ADULT_UNISEX: PhraseTruthCtx = { ...TEE, audienceLean: 'unisex', field: 'title' }
  const shipCtx: AssembledTitleCtx = { truth: ADULT_UNISEX, protect: '' }

  it('PIN 1 — ship gate: every adult-slang audience word is BLOCKED on a unisex title exactly like "for Men"/"for Women" already were (RED at 675e8a1: "for Guys"/"for Gals"/"for Dudes"/"for Bros"/"for Gents" all SHIPPED, byte-identical to BASE — task-7-review-findings.md B1, executed evidence (a))', () => {
    for (const w of ['Men', 'Women', 'Guys', 'Gals', 'Dudes', 'Bros', 'Gents']) {
      const title = `THE CEO Grind Mode Novelty Shirts for ${w}`
      expect(verdictForAssembledTitle(title, shipCtx), title).toEqual({ ok: false, reason: 'untrue-or-foreign-segment-present' })
    }
  })

  it('PIN 2 — segmented case: the audience clause is the ONLY thing lost — "for Guys" nets to the IDENTICAL string as its "for Men" twin, never the whole-segment collapse (RED at 675e8a1: 47c "…Tee | Novelty Shirt for Guys" collapsed to 22c "…Tee" — losing "Novelty Shirt" too — while the "for Men" twin lost only its 8-char clause, 46c -> 38c)', () => {
    const menTitle = 'THE CEO Grind Mode Tee | Novelty Shirt for Men'
    const guysTitle = 'THE CEO Grind Mode Tee | Novelty Shirt for Guys'
    const menNetted = applyTitleTruthNet(menTitle, ADULT_UNISEX)
    const guysNetted = applyTitleTruthNet(guysTitle, ADULT_UNISEX)
    const CLAUSE_ONLY_SHAPE = 'THE CEO Grind Mode Tee | Novelty Shirt'
    expect(guysNetted).toBe(CLAUSE_ONLY_SHAPE)                 // NOT the 675e8a1 whole-segment collapse ("…Tee")
    expect(menNetted).toBe(CLAUSE_ONLY_SHAPE)                  // same shape, modulo the audience word
    expect(guysNetted).toBe(menNetted)
    expect(guysNetted.length).toBe(guysTitle.length - ' for Guys'.length)   // clause-removed length, not less
    expect(menNetted.length).toBe(menTitle.length - ' for Men'.length)
  })

  it('PIN 3 — the AUDIENCE_TAIL_RE caller (contentTruth.ts, applyTitleTruthNet step 1): "for guys"/"for gals"/"for ladies" are recognised as the TAIL (clause-only loss) the same way "for men"/"for women" already are; "for guys only" mid-segment and "germany" are NOT tails', () => {
    // "ladies" is the PRE-EXISTING orphan this fix also closes (B1: "ladies"/"lady" were
    // detector-only from the day rule (c2) shipped, before Task 7 ever touched the masculine side).
    expect(applyTitleTruthNet('THE CEO Grind Mode Tee | Novelty Shirt for Ladies', ADULT_UNISEX))
      .toBe('THE CEO Grind Mode Tee | Novelty Shirt')
    // A non-tail: "for Guys" is followed by more content ("Only") before the string ends, so
    // AUDIENCE_TAIL_RE's `$`-anchor cannot match it — the segment-sweep's coarser whole-segment drop
    // fires instead (observably different: "Novelty Shirt" is lost WITH it, unlike the true-tail
    // case above where "Novelty Shirt" survives).
    expect(applyTitleTruthNet('THE CEO Grind Mode Tee | Novelty Shirt for Guys Only', ADULT_UNISEX))
      .toBe('THE CEO Grind Mode Tee')
    // "germany" is not a gender word at all — untouched, ships clean (no false positive from the
    // widened core or the derived tail regex).
    const germanyTitle = 'THE CEO Grind Mode Novelty Shirts for Germany'
    expect(applyTitleTruthNet(germanyTitle, ADULT_UNISEX)).toBe(germanyTitle)
    expect(verdictForAssembledTitle(germanyTitle, shipCtx)).toEqual({ ok: true })
  })

  it('PIN 4 — net idempotence on a TRUE title is unchanged: a lean_male title keeps "for Guys" and a lean_female title keeps "for Gals" untouched (rule (b) is unisex-only — pre-existing gating, unaffected by this fix)', () => {
    const maleLeanTitle = 'THE CEO Grind Mode Novelty Shirt for Guys'
    const femaleLeanTitle = 'THE CEO Grind Mode Novelty Shirt for Gals'
    expect(applyTitleTruthNet(maleLeanTitle, { ...TEE, audienceLean: 'men', field: 'title' })).toBe(maleLeanTitle)
    expect(applyTitleTruthNet(femaleLeanTitle, { ...TEE, audienceLean: 'women', field: 'title' })).toBe(femaleLeanTitle)
  })
})
