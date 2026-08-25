/**
 * broadcastShipDoorScope.test.ts — DEFECT A reproduction (PR #646, reverted 2026-08-24).
 *
 * THE LIVE COLLAPSE: B0DSCDZC6K's broadcast/parent title shipped `THE CEO Motivational, for Men`
 * (29 chars, orphaned comma). Root cause: `computeBroadcastShipDoorScope` (extracted from
 * `scrubPublished`'s inline block in `listingPipeline.ts`) built `protectHay` by filtering
 * `familyDesignNames` with the TOKEN-level `isForeignToDesign` — so the family's own broadcast theme
 * name ("Motivational Entrepreneur") was convicted and dropped WHOLESALE merely because it shares the
 * word "entrepreneur" with sibling design "Entrepreneur Definition". A reviewer described this
 * mechanism verbatim and filed it Minor/doc-drift; it was the collapse (see
 * mempalace: minor-findings-are-not-minor-when-they-name-the-collapse.md).
 *
 * PO ruling 2026-08-24: subtract the family theme from the broadcast foreign set by WHOLE NAME
 * (case-insensitive equality), never by token. A theme that merely SHARES A WORD with a per-design
 * name keeps its protection.
 *
 * Every reused function here is production code, not a re-derivation: `computeBroadcastShipDoorScope`
 * (listingPipeline.ts), `buildForeignDesignTokens`/`isForeignToDesign` (designScope.ts),
 * `applyTitleTruthNet`/`buildPhraseTruthCtx` (contentTruth.ts).
 */
import { describe, it, expect } from 'vitest'
import { computeBroadcastShipDoorScope } from './listingPipeline'
import { applyTitleTruthNet, buildPhraseTruthCtx } from './contentTruth'
import { buildForeignDesignTokens, isForeignToDesign } from './designScope'

/** B0DSCDZC6K-shaped fixture: a distinct broadcast/family theme name ("Motivational Entrepreneur")
 *  that is NOT itself one of the family's six per-design names, but SHARES a word ("entrepreneur")
 *  with one of them (design ED, "Entrepreneur Definition"). */
const FAMILY_THEME_NAME = 'Motivational Entrepreneur'
const FAMILY_DESIGN_VOCAB: { key: string; name: string }[] = [
  { key: 'BB', name: 'Business B*tch' },
  { key: 'BCS', name: 'Billionare Coming Soon' },
  { key: 'DQ', name: "Don't Quit" },
  { key: 'ED', name: 'Entrepreneur Definition' },
  { key: 'HD', name: 'Hustle Definiton' },
  { key: 'MH', name: 'Mother Hustler' },
]
const FAMILY_DESIGN_NAMES: string[] = [FAMILY_THEME_NAME, ...FAMILY_DESIGN_VOCAB.map((d) => d.name)]

describe('computeBroadcastShipDoorScope — defect A: whole-name subtraction, never token', () => {
  it('keeps the family theme WHOLE even though it shares a word with a sibling design name', () => {
    const r = computeBroadcastShipDoorScope(FAMILY_DESIGN_NAMES, FAMILY_DESIGN_VOCAB, '')
    expect(r.protectHay).toBe(FAMILY_THEME_NAME)
    // LENGTH, not just content — a partial survivor ("Motivational", 12 chars) would satisfy a
    // loose `.toContain` check but is exactly the defect class this fix exists to prevent.
    expect(r.protectHay.length).toBe(FAMILY_THEME_NAME.length)
    expect(r.protectHay.length).toBe(25)
  })

  it('still convicts an ACTUAL sibling name (whole-string match, case-insensitive) — the fix only widens the exemption for a shared WORD, never for a shared IDENTITY', () => {
    const withEcho = [...FAMILY_DESIGN_NAMES, 'business b*tch']   // differently-cased echo of design BB
    const r = computeBroadcastShipDoorScope(withEcho, FAMILY_DESIGN_VOCAB, '')
    expect(r.protectHay).not.toContain('business b*tch')
    expect(r.protectHay).toBe(FAMILY_THEME_NAME)
    expect(r.protectHay.length).toBe(25)
  })

  it('foreignTokens stays TOKEN-level (unchanged) — only the NAME-level protectHay decision changed granularity', () => {
    const r = computeBroadcastShipDoorScope(FAMILY_DESIGN_NAMES, FAMILY_DESIGN_VOCAB, '')
    expect(r.foreignTokens.has('entrepreneur')).toBe(true)   // ED's distinguishing word, still foreign
    expect(r.foreignTokens.size).toBeGreaterThan(0)
  })
})

describe('THE LIVE COLLAPSE — reproduced end to end through the real truth net', () => {
  const truth = buildPhraseTruthCtx({
    garmentFamily: 'sweatshirt',
    mixedFamilies: ['sweatshirt', 'hoodie'],
    spec: null,
    allowedBrand: null,
    designTokens: FAMILY_DESIGN_NAMES,
    audienceLean: 'unisex',
  }, 'title')!
  // The exact live producer text shape (harness RAW_PARENT): a stray comma before the pipe, and a
  // wrong-garment-noun + forced-gender tail that is untrue on this sweatshirt/hoodie unisex family
  // regardless of the design-name defect — both halves of the raw string are genuinely bad, and the
  // truth net is SUPPOSED to remove both; the bug is that it also ate the true theme name beside them.
  const RAW_PARENT = 'THE CEO Motivational Entrepreneur, | Funny Work Shirts for Men'

  it('RED — reproduces PR #646 as reverted: the TOKEN-level protect-hay collapses the title to well under 30 chars', () => {
    // Byte-for-byte the reverted production expression (listingPipeline.ts, pre-fix):
    //   familyDesignNames.filter((n) => !isForeignToDesign(n, broadcastForeignTokens)).join(' ')
    // Not a re-derivation of a new predicate — the SAME `buildForeignDesignTokens`/`isForeignToDesign`
    // this repo already uses everywhere else, just applied at the wrong (token) granularity for a
    // NAME-level decision.
    const scope = buildForeignDesignTokens(FAMILY_DESIGN_VOCAB, { familyTitleText: '', poolKeywords: [], strictNames: true })
    const foreignTokens = scope('__broadcast__')
    const buggyProtectHay = FAMILY_DESIGN_NAMES.filter((n) => !isForeignToDesign(n, foreignTokens)).join(' ')
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    const collapsed = applyTitleTruthNet(RAW_PARENT, truth, buggyProtectHay, {
      rejectSegment: reject, foreignTokens, scrubProtectedOverlap: true,
    })
    // THE REPORTED LIVE SPECIMEN was 29 chars ("THE CEO Motivational, for Men"). This fixture's raw
    // text differs slightly (its untrue tail is wrong-garment-noun AND forced-gender, both of which
    // the net removes wholesale rather than word-scrubbing), so the exact collapsed string differs,
    // but the DEFECT CLASS is identical and must be proven on LENGTH, not merely absence of a word:
    // "Entrepreneur" is gone, and what remains is far short of the 70-75 band.
    expect(collapsed).not.toContain('Entrepreneur')
    expect(collapsed.length).toBeLessThan(30)
    expect(collapsed.startsWith('THE CEO Motivational')).toBe(true)
  })

  it('GREEN — computeBroadcastShipDoorScope (the fix) keeps "Motivational Entrepreneur" whole, through the same real truth net', () => {
    const { foreignTokens, protectHay } = computeBroadcastShipDoorScope(FAMILY_DESIGN_NAMES, FAMILY_DESIGN_VOCAB, '')
    const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
    const healed = applyTitleTruthNet(RAW_PARENT, truth, protectHay, {
      rejectSegment: reject, foreignTokens, scrubProtectedOverlap: true,
    })
    expect(healed).toContain(FAMILY_THEME_NAME)
    // LENGTH: the healed segment must be at least as long as the intact theme name — the fix is
    // about NOT losing characters, so this is the one assertion a content-only check would miss.
    expect(healed.length).toBeGreaterThanOrEqual(FAMILY_THEME_NAME.length)
    expect(healed).not.toMatch(/,\s*\|/)   // no orphaned comma before the separator either
  })
})
