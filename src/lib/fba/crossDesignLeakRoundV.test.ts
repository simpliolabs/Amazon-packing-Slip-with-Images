/**
 * ROUND V (2026-09-24, cross-design leak controller ruling) — V4/V5, driven end to end through the
 * REAL `runListingPipeline`, capturing the ACTUAL prompt text sent to the (stubbed) LLM.
 *
 * V4 fixes the four defects the u1-source review measured in U6's `sanitizeReferenceTitle`:
 *   1. resolve the sibling's name through the SAME source `vocabNameFor`/`perChildDesignVocab` use,
 *      never the raw nullable `designName` column (U3 had already declared it unreliable);
 *   2. exempt THIS design's own vocabulary — a sibling's stored name can be a bare SUBSTRING of
 *      this design's own name ("Hustle" vs "Hustle Definiton");
 *   3. anchor every strip on WORD BOUNDARIES — the old unanchored replace turned "Ribbed" into
 *      "Ri ed" the moment a sibling's stored name/label was the 2-letter run "Bb";
 *   4. refuse to strip below a length floor.
 * The two hazards below (`sanitize.probe.test.ts`, u1-source review) ARE the acceptance, pinned at
 * the captured PROMPT TEXT — never at `sanitizeReferenceTitle` called in isolation, and never at
 * the (now-deleted) ship door.
 *
 * Same hermetic harness as crossDesignLeakRoundU6.test.ts (stubbed OpenAI, no network, Supabase env
 * neutralized).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runListingPipeline, type PipelineInput, type PipelineChild } from './listingPipeline'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}
beforeAll(() => { for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; delete process.env[key] } })
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedSupabaseEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedSupabaseEnv[key]
  }
})

const CLEAN_BULLETS = [
  'PREMIUM COMFORT - Soft ringspun cotton keeps you comfortable through a full day out there.',
  'RELAXED FIT - A classic crewneck cut that layers easily for any season and holds shape.',
  'GREAT GIFT - Perfect for the go-getter who never stops chasing the next goal each day.',
  'BUILT TO LAST - Durable stitching holds up wash after wash, season after season, always.',
  'EASY CARE - Machine washable, holds its shape and color through repeated wash cycles.',
]
const SINK = { title: 'THE CEO Graphic Sweatshirt | Long Sleeve Comfort Colors Crewneck', bullets: CLEAN_BULLETS, description: '<p>A bold sweatshirt for the grind and the long haul ahead.</p>', backend_drop: [] }
const children: PipelineChild[] = [
  { sku: 'BB-M', asin: 'B0BB000001', color: 'Black', size: 'M' },
  { sku: 'BB-L', asin: 'B0BB000002', color: 'Black', size: 'L' },
  { sku: 'HDG-M', asin: 'B0DRH5T3PN', color: 'Black', size: 'M' },
  { sku: 'HDG-L', asin: 'B0HDG00002', color: 'Black', size: 'L' },
]

/** `bbName` is BB's STORED designName (the two hazards each corrupt this field, never the title);
 *  `hdgTitle` is HDG's own STORED title (containing "Ribbed" for the HAZARD-2/CONTROL arms). */
function mk(openai: PipelineInput['openai'], bbName: string, hdgTitle: string): PipelineInput {
  const bbt = 'THE CEO Business B*tch Sweatshirt | Long Sleeve for Men'
  return {
    openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
    analysis: [], children, repTitle: bbt, canonicalTitle: bbt, priorTitle: bbt,
    priorBullets: CLEAN_BULLETS, variantDetails: '', keywordContext: '',
    hasAplus: false, hasBrandStory: false, auditModel: 'o4-mini', onProgress: () => {},
    onlySection: 'bullets',
    priorPerChildTitles: [
      { sku: 'BB-M', asin: 'B0BB000001', title: bbt, designName: bbName, designKey: 'BB' },
      { sku: 'BB-L', asin: 'B0BB000002', title: bbt, designName: bbName, designKey: 'BB' },
      { sku: 'HDG-M', asin: 'B0DRH5T3PN', title: hdgTitle, designName: 'Hustle Definiton', designKey: 'HDG' },
      { sku: 'HDG-L', asin: 'B0HDG00002', title: hdgTitle, designName: 'Hustle Definiton', designKey: 'HDG' },
    ],
  } as PipelineInput
}

function makeCapturingStub(captured: string[]) {
  return {
    chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
      const u = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
      captured.push(u)
      if (/"designName"/.test(u)) return { choices: [{ message: { content: JSON.stringify({ designName: '' }) }, finish_reason: 'stop' }] }
      return { choices: [{ message: { content: JSON.stringify(SINK) }, finish_reason: 'stop' }] }
    }) } },
  } as unknown as PipelineInput['openai']
}

/** The exact "The title is FINAL (do not change it): "..."" reference title captured for HDG's
 *  bullets writer — the CAPTURED PROMPT TEXT the ruling requires the pin to sit at. */
function hdgReferenceTitle(captured: string[]): string {
  for (const u of captured) {
    if (/"designName"/.test(u)) continue
    const m = u.match(/The title is FINAL \(do not change it\): "([^"]*)"/)
    if (m && /Hustle Definiton/.test(m[1])) return m[1]
  }
  return ''
}

describe('Round V — V4: sanitizeReferenceTitle resolves through vocabNameFor, exempts own vocabulary, anchors on word boundaries, and floors length', () => {
  it('HAZARD 1: a sibling stored designName that is a bare word inside THIS design\'s own name — HDG must not lose its own "Hustle Definiton"', async () => {
    const captured: string[] = []
    // BB's stored designName is "Hustle" — a bare word of HDG's OWN name "Hustle Definiton".
    await runListingPipeline(mk(makeCapturingStub(captured), 'Hustle', 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve for Men'))
    const ref = hdgReferenceTitle(captured)
    expect(ref).not.toBe('')
    expect(ref).toContain('Hustle Definiton')
  }, 30_000)

  it('HAZARD 2: a two-letter designKey LABEL as the stored designName must not corrupt an unrelated word ("Ribbed") mid-string', async () => {
    const captured: string[] = []
    // BB's stored designName is "Bb" — the documented degraded label (FULL regen's own fallback
    // when extractDesignName comes back empty). HDG's OWN title contains "Ribbed", which literally
    // contains the substring "bb" — the pre-V4 unanchored replace turned it into "Ri ed".
    await runListingPipeline(mk(makeCapturingStub(captured), 'Bb', 'THE CEO Hustle Definiton Ribbed Sweatshirt | Long Sleeve for Men'))
    const ref = hdgReferenceTitle(captured)
    expect(ref).not.toBe('')
    expect(ref).toContain('Ribbed')
    expect(ref).not.toContain('Ri ed')
  }, 30_000)

  it('CONTROL: a healthy stored designName changes nothing — "Ribbed" survives and BB\'s own name is still the phrase stripped from HDG\'s brief', async () => {
    const captured: string[] = []
    await runListingPipeline(mk(makeCapturingStub(captured), 'Business B*tch', 'THE CEO Hustle Definiton Ribbed Sweatshirt | Long Sleeve for Men'))
    const ref = hdgReferenceTitle(captured)
    expect(ref).not.toBe('')
    expect(ref).toContain('Ribbed')
    expect(ref).not.toContain('Business B*tch')
  }, 30_000)
})

/**
 * V5 (Important) — `ctx.groupInput.canonicalTitle` carries the SAME potentially-contaminated
 * per-group title `ctx.title` does (both are set from the group's own child's stored title), but
 * reaches the per-design motif trust haystack (`groupMotif`, bullets AND description fan-outs),
 * the backend fan-out's `groupHay` trust haystack, and `fillBackendToBudget`'s own reference-title
 * argument RAW unless wrapped. A source-scan pin (same discipline `designScopeCallSiteSingleSource
 * .test.ts` already uses for `familyTitleText`): every raw read of `ctx.groupInput.canonicalTitle`
 * outside its own construction must be wrapped by `sanitizedGroupCanonicalTitle(ctx)`, the ONE
 * helper that calls the SAME `sanitizeReferenceTitle` V4 fixed — never the raw property again.
 */
describe('Round V — V5: every raw read of ctx.groupInput.canonicalTitle is sanitized', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
  const lines = src.split(/\r?\n/)

  it('the sanitizing helper exists and is defined from the SAME sanitizeReferenceTitle V4 uses', () => {
    expect(src).toContain('const sanitizedGroupCanonicalTitle = (ctx')
    expect(src).toContain('sanitizeReferenceTitle(ctx.groupInput.canonicalTitle ?? \'\', ctx.key)')
  })

  it('every raw `ctx.groupInput.canonicalTitle` read is either the helper\'s OWN definition, a comment, or already wrapped by the helper', () => {
    const offenders: string[] = []
    lines.forEach((line, i) => {
      if (!line.includes('ctx.groupInput.canonicalTitle')) return
      const isComment = /^\s*(\*|\/\/|\/\*)/.test(line)
      const isHelperDefinition = line.includes('sanitizedGroupCanonicalTitle')
        || /^\s*sanitizeReferenceTitle\(ctx\.groupInput\.canonicalTitle/.test(line)
      const isWrappedCall = /sanitizedGroupCanonicalTitle\(ctx\)/.test(line) && !/\bctx\.groupInput\.canonicalTitle\s*\?\?/.test(line.replace(/sanitizedGroupCanonicalTitle\(ctx\)/g, ''))
      // The ONE raw exception this round leaves documented (V5's own comment, above): the
      // multi-design LLM editorial audit, gated `!input.onlySection` — full-regen-only, where the
      // per-group titles are freshly resolved and already clean per U6/V4's own established
      // reasoning. Anything else raw is an offender.
      const isDocumentedAuditException = /referenceTitle: ctx\.groupInput\.canonicalTitle \?\? ctx\.title/.test(line)
        || /detectWidowFormat\(ctx\.title, ctx\.groupInput\.canonicalTitle\)/.test(line)
      if (isComment || isHelperDefinition || isWrappedCall || isDocumentedAuditException) return
      offenders.push(`${i + 1}: ${line.trim()}`)
    })
    expect(offenders, `raw ctx.groupInput.canonicalTitle read(s) not wrapped by sanitizedGroupCanonicalTitle:\n${offenders.join('\n')}`).toEqual([])
  })

  it('sanity: the scanner actually found the known wrapped sites (groupMotif x2, groupHay, fillBackendToBudget) — a scanner matching nothing is a false green', () => {
    const wrapped = lines.filter((l) => /sanitizedGroupCanonicalTitle\(ctx\)/.test(l) && !l.includes('const sanitizedGroupCanonicalTitle'))
    expect(wrapped.length).toBe(4)
  })
})
