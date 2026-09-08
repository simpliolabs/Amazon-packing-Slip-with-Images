/**
 * IH TERMINAL NET, PHASE 3 (spec docs/superpowers/specs/2026-09-07-item-highlight-terminal-net.md
 * §2 Phase 3; finish-line-rulings.md — "the rule whose absence lets 'Polycotton' ship unchecked on
 * a live PDP").
 *
 * REPRODUCED against the unmodified tree (HEAD fee7ea7, `scratchpad/finish-c/repro-material-lie.ts`)
 * before any production edit:
 *   - `PhraseTruthReason` had no `material` member at all.
 *   - A fabricated composition ("100% Combed Ringspun Cotton" on a synthetic 50/50 poly-cotton
 *     blank) passed `phraseTruthVerdict` (`{ok:true}`) AND the real terminal net
 *     (`capItemHighlightRepeats`, which did not even accept a truth ctx).
 *   - The live B0DMXMH266 instance — a Gildan 64000 blank, `DEFAULT_BLANK_SPECS`,
 *     `material: 'Ring-Spun Cotton'` (100% cotton) — a line beginning "Polycotton…" was unchecked
 *     the same way.
 *
 * THE FIX. `phraseTruthVerdict` (contentTruth.ts) gains rule (g), `material-lie`, beside the
 * existing `weight-class-lie`/`fit-claim-lie` fabric rules — ONE predicate, no second rule list —
 * grounded in `ctx.spec.material`, ITEM HIGHLIGHTS ONLY (mirrors `fit-claim-lie`'s own scoping;
 * bullets/description keep their existing owner, `enforceFabricTruth`, untouched). A new exported
 * function, `ihLineTruthVerdict`, GENERALISES `applyTitleTruthNet`'s segment-then-judge core to the
 * Item Highlight's shape (no privileged "money phrase", REFUSE never drop-and-rejoin) and is wired
 * into `capItemHighlightRepeats` as an injected `truthCheck` (never an import — see
 * productDetailAttrs.ts's own doc on the contentTruth.ts/blankSpecs.ts cycle this avoids), and into
 * `buildItemHighlights` (listingPipeline.ts) using the SAME blank-fact ctx the composer's own
 * per-candidate check already resolved.
 */
import { describe, it, expect } from 'vitest'
import { phraseTruthVerdict, ihLineTruthVerdict, type PhraseTruthCtx, type PhraseTruthReason } from './contentTruth'
import { capItemHighlightRepeats } from './productDetailAttrs'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'

const GILDAN_64000_MATERIAL = DEFAULT_BLANK_SPECS.find((r) => r.styleCode === '64000')!.spec.material!

const PURE_COTTON_TEE_CTX: PhraseTruthCtx = {
  garmentFamily: 'tee',
  spec: { material: GILDAN_64000_MATERIAL, fit: 'Classic' },
  allowedBrand: null,
  audience: 'adult',
  field: 'highlights',
}

const BLEND_SWEATSHIRT_CTX: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt',
  spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic' },
  allowedBrand: null,
  audience: 'adult',
  field: 'highlights',
}

describe('PhraseTruthReason — the reason exists (reproduction claim 1)', () => {
  it('material-lie is a member', () => {
    const reasons: readonly PhraseTruthReason[] = ['material-lie']
    expect(reasons[0]).toBe('material-lie')
  })
})

describe('phraseTruthVerdict — rule (g) material-lie', () => {
  it('THE REPRODUCTION: the live "Polycotton…" opener is refused on the real Gildan 64000 blank (B0DMXMH266)', () => {
    expect(GILDAN_64000_MATERIAL).toBe('Ring-Spun Cotton') // sanity: this IS the live blank fact
    expect(phraseTruthVerdict('Polycotton Blend Comfort', PURE_COTTON_TEE_CTX))
      .toEqual({ ok: false, reason: 'material-lie' })
  })

  it('a fabricated SINGLE-fibre claim ("100% Combed Ringspun Cotton") on a 50/50 poly-cotton blank is refused', () => {
    expect(phraseTruthVerdict('100% Combed Ringspun Cotton', BLEND_SWEATSHIRT_CTX))
      .toEqual({ ok: false, reason: 'material-lie' })
  })

  it('the wrong FIBRE entirely ("Rayon Blend") is refused, independent of blend-ness', () => {
    expect(phraseTruthVerdict('Rayon Blend Softness', BLEND_SWEATSHIRT_CTX))
      .toEqual({ ok: false, reason: 'material-lie' })
  })

  it('THE TRUE COMPOSITION for the pure-cotton blank passes', () => {
    expect(phraseTruthVerdict('100% Ring-Spun Cotton', PURE_COTTON_TEE_CTX)).toEqual({ ok: true })
    expect(phraseTruthVerdict('Ring-Spun Cotton', PURE_COTTON_TEE_CTX)).toEqual({ ok: true })
  })

  it('THE TRUE COMPOSITION for the blend blank passes', () => {
    expect(phraseTruthVerdict('50% Cotton / 50% Polyester', BLEND_SWEATSHIRT_CTX)).toEqual({ ok: true })
    expect(phraseTruthVerdict('Cotton Polyester Blend', BLEND_SWEATSHIRT_CTX)).toEqual({ ok: true })
  })

  it('a BARE fibre word with no composition marker stays ordinary vocabulary (not a claim), on either blank', () => {
    expect(phraseTruthVerdict('soft cotton graphic tee', PURE_COTTON_TEE_CTX)).toEqual({ ok: true })
    expect(phraseTruthVerdict('soft cotton feel design', BLEND_SWEATSHIRT_CTX)).toEqual({ ok: true })
    expect(phraseTruthVerdict('breathable cotton shirt', PURE_COTTON_TEE_CTX)).toEqual({ ok: true })
  })

  it('an unconfirmed blank (no spec.material) backs no composition claim — FAIL CLOSED, same doctrine as weight-class-lie/fit-claim-lie', () => {
    const noSpecCtx: PhraseTruthCtx = { ...PURE_COTTON_TEE_CTX, spec: null }
    expect(phraseTruthVerdict('100% Cotton', noSpecCtx)).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('FIELD-SCOPED: the identical claim is NOT judged on title/bullets/description/backend — mirrors fit-claim-lie', () => {
    for (const field of ['title', 'bullets', 'description', 'backend'] as const) {
      expect(phraseTruthVerdict('Polycotton Blend Comfort', { ...PURE_COTTON_TEE_CTX, field })).toEqual({ ok: true })
    }
  })

  it('COMMA-BOUNDED: a fibre word in one clause cannot bind to a "%"/"blend" marker in an unrelated clause', () => {
    // "cotton" alone in clause 1 is bare vocabulary; "50% off" in clause 2 has a % but no fibre word
    // of its own — neither clause, judged alone, is a composition claim.
    expect(phraseTruthVerdict('soft cotton feel, everyday value', PURE_COTTON_TEE_CTX)).toEqual({ ok: true })
  })

  it('ordering: an existing multi-clause fixture that fails on fit-claim-lie keeps that diagnosis (material-lie is evaluated last)', () => {
    // Same fixture as itemHighlightComposer.test.ts's own comma-segment-safety pin: "cotton blend
    // fabric" (a composition claim) sits BESIDE "relaxed unisex fit" (a fit claim) in the same
    // multi-segment string; the predicate's rule (f) still fires first.
    expect(phraseTruthVerdict('cotton blend fabric, relaxed unisex fit, crew neck design, cuff sleeves', PURE_COTTON_TEE_CTX))
      .toEqual({ ok: false, reason: 'fit-claim-lie' })
  })
})

describe('ihLineTruthVerdict — the generalised applyTitleTruthNet segment-judge, for a comma-joined IH line', () => {
  it('refuses on the FIRST failing segment of an otherwise-true line', () => {
    const line = 'Classic Crew Neck, Polycotton Blend Feel, Everyday Graphic Tee, Gift Ready Idea'
    expect(ihLineTruthVerdict(line, PURE_COTTON_TEE_CTX)).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('passes a fully-true composed line (every segment backed by the blank)', () => {
    const line = 'Classic Crew Neck, 100% Ring-Spun Cotton, Everyday Graphic Tee, Gift Ready Idea'
    expect(ihLineTruthVerdict(line, PURE_COTTON_TEE_CTX)).toEqual({ ok: true })
  })

  it('is a no-op (never drops, never rejoins) — unlike applyTitleTruthNet, it only reports the verdict', () => {
    const line = 'Classic Crew Neck, Polycotton Blend Feel, Everyday Graphic Tee'
    const before = line
    ihLineTruthVerdict(line, PURE_COTTON_TEE_CTX)
    expect(line).toBe(before) // pure — the caller decides refuse-vs-ship
  })
})

describe('capItemHighlightRepeats — Phase 3 truthCheck wiring', () => {
  const FABRICATED_LINE = '100% Combed Ringspun Cotton, Relaxed Everyday Feel, Crew Neck, Gift Ready Today'
  const TRUE_LINE = '50% Cotton / 50% Polyester, Classic Crew Neck, Everyday Graphic Design, Gift Ready Today'

  it('BYTE-IDENTICAL by default: every existing call site passes no truthCheck and is unaffected', () => {
    expect(capItemHighlightRepeats(FABRICATED_LINE)).toEqual({ ok: true, value: FABRICATED_LINE })
  })

  it('WIRED: refuses the fabricated composition when a real truthCheck is supplied', () => {
    const result = capItemHighlightRepeats(FABRICATED_LINE, {
      truthCheck: (line) => ihLineTruthVerdict(line, BLEND_SWEATSHIRT_CTX),
    })
    expect(result).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('WIRED: the true composition for the same blank still ships', () => {
    const result = capItemHighlightRepeats(TRUE_LINE, {
      truthCheck: (line) => ihLineTruthVerdict(line, BLEND_SWEATSHIRT_CTX),
    })
    expect(result).toEqual({ ok: true, value: TRUE_LINE })
  })

  it('the truth check runs LAST, on the final netted bytes (after repeat/length/content-rule stages) — not on the raw candidate', () => {
    // A repeat-over-budget line with a material lie buried in a phrase the repeat cap itself drops:
    // the repeat-cap's own diagnosis must win, since the lying phrase never survives to the final
    // joined bytes the truth check judges.
    const line = 'Sweatshirt Sweatshirt Sweatshirt Sweatshirt, Polycotton Blend Feel'
    const result = capItemHighlightRepeats(line, { truthCheck: (l) => ihLineTruthVerdict(l, PURE_COTTON_TEE_CTX) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).not.toBe('material-lie')
  })
})

describe('every existing composed-bytes fixture is unaffected (Phase 3 adds a new opt-in stage only)', () => {
  it('a real composer-shaped true line, unchanged, with no truthCheck passed', () => {
    const line = 'Ring-Spun Cotton, Relaxed Fit, Crew Neck, Soft Everyday Wear, Gift Ready'
    expect(capItemHighlightRepeats(line)).toEqual({ ok: true, value: line })
  })
})
