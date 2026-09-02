/**
 * End-to-end proof for the GARMENT AGE PRODUCER (PO ruling 2026-08-27, migration 071 — adversarial
 * audit, 12 verified findings). Unit coverage for the pure resolver lives in
 * contentTruth.garmentAudience.test.ts; THIS file proves the wiring actually reaches
 * runListingPipeline's Product Detail block (listingPipeline.ts, the `if (apparelProduct && (lean
 * || aud.ageClass))` gate just above the `if (blankSpec)` ground-truth override) — that a STATED
 * blank age fact composes into Department and appends age_range_description, while a family with
 * no stated age fact is a byte-identical no-op.
 *
 * Drives the REAL runListingPipeline() with a stubbed OpenAI client and a stubbed blank catalog —
 * same harness as audienceAssignmentPipeline.integration.test.ts / gatePerChildMultiDesign.
 * integration.test.ts, whose headers document the CI trap this guards against: build.yml's
 * placeholder Supabase env makes every lazy-Proxy Supabase client (blankSpecs.ts etc.) attempt a
 * real ~4s-per-call network request instead of failing open synchronously. Nulling the three
 * Supabase env vars for the duration of this file (RESTORED in afterAll) keeps the synchronous
 * fail-open path regardless of what the CI runner exports.
 *
 * "PROVE THE BRANCH RAN, NOT JUST THE OUTPUT" (brief's own words): every assertion below reads the
 * GARMENT_AUDIENCE log line's `source` field, not merely the recommended_value string — a test that
 * only checked the output string would still pass if an LLM (or a stale cache) happened to guess the
 * same value while the resolver itself never fired (source:'none'). This repo shipped exactly that
 * class of false-green test last week (a fixture that early-returned before the store ran).
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ''

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('@/lib/fba/blankSpecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fba/blankSpecs')>()
  return { ...actual, loadBlankSpecRows: vi.fn(async () => [] as import('@/lib/fba/blankSpecs').BlankSpecRow[]) }
})

import { loadBlankSpecRows, type BlankSpecRow } from '@/lib/fba/blankSpecs'
import { runListingPipeline, type PipelineInput, type PipelineChild, type PipelineProductDetailImprovement } from './listingPipeline'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; delete process.env[key] }
})
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedSupabaseEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedSupabaseEnv[key]
  }
})

const mockedLoadBlankSpecRows = vi.mocked(loadBlankSpecRows)

// The mega-audit's canned response. Carries a Department/Target Gender row (mimicking the audit's
// typical guess) so the deterministic override below has something to prove it overrode — an EMPTY
// pdiFinal would make the department assertions vacuous (nothing to override).
function kitchenSink() {
  return {
    title: 'THE CEO Dino Roar Graphic Tee | Short Sleeve Comfort Colors Shirt',
    bullets: [
      'PLAYFUL DESIGN - A fun graphic print that stands out in any crowd, made for everyday wear.',
      'SOFT COMFORT - Ring-spun cotton feels soft against skin, wash after wash.',
      'GREAT GIFT - A thoughtful gift for birthdays, holidays, or just because they deserve it.',
      'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
      'TRUE TO SIZE - Classic fit runs true to size for a comfortable everyday silhouette.',
    ],
    description: '<p>A fun graphic tee for everyday wear.</p><ul><li>Soft cotton</li><li>Classic fit</li></ul><p>Great gift.</p>',
    backend_drop: [],
    product_details_improvements: [
      { field_name: 'Department', current_value: null, recommended_value: 'Mens', reason: 'audit guess' },
      { field_name: 'Target Gender', current_value: null, recommended_value: 'Male', reason: 'audit guess' },
    ],
  }
}

function makeOpenAiStub() {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(kitchenSink()) }, finish_reason: 'stop' }] })),
      },
    },
  } as unknown as PipelineInput['openai']
}

// THE LIVE CASE (B0DP5H8QBT, defect closed 2026-09-02): the mega-audit has ALREADY guessed an Age
// Range Description row from the listing's own existing copy ("Big Kid", no value_source — exactly
// what a real audit returns) in the SAME payload as the Department/Target Gender guesses. This is
// what kitchenSink() alone never covered, which is why the original appendSpecFact bug shipped past
// CI: every existing test's audit stub was silent on age, so the append's "skip if a row already
// exists" guard never had a row to collide with.
function kitchenSinkWithAgeGuess() {
  const base = kitchenSink()
  return {
    ...base,
    product_details_improvements: [
      ...base.product_details_improvements,
      { field_name: 'Age Range Description', current_value: null, recommended_value: 'Big Kid', reason: 'guessed from the listing\'s existing copy' },
    ],
  }
}

function makeOpenAiStubWithAgeGuess() {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(kitchenSinkWithAgeGuess()) }, finish_reason: 'stop' }] })),
      },
    },
  } as unknown as PipelineInput['openai']
}

function makeChildren(): PipelineChild[] {
  return [
    { sku: 'DINO64000B-M-BLK', asin: 'B0DINOMBLK1', color: 'Black', size: 'M' },
    { sku: 'DINO64000B-L-BLK', asin: 'B0DINOLBLK1', color: 'Black', size: 'L' },
  ]
}

// THE REAL LIVE ENUM (read from the DB 2026-09-02, PO ruling: "kids -> Big Kid"). NO bare
// "Kids"/"Kid"/"Youth"/"Newborn" member exists — this is the exact list every test in this file
// now resolves `ageRangeCandidate` against, so a fixture never again hides the enum-validity gap
// the way the old "Kids"-inclusive list did (see the ENUM-VALIDITY block below for the history).
const AGE_RANGE_MENU_ATTR = { key: 'age_range_description', title: 'Age Range Description', accepted: ['Adult', 'Big Kid', 'Infant', 'Little Kid', 'Toddler'] }

function makeBaseInput(openai: PipelineInput['openai']): PipelineInput {
  const children = makeChildren()
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SHIRT',
    analysis: [],
    children,
    repTitle: 'THE CEO Dino Roar Tee',
    canonicalTitle: 'THE CEO Dino Roar Tee',
    priorTitle: 'THE CEO Dino Roar Tee',
    priorBullets: kitchenSink().bullets,
    variantDetails: '',
    keywordContext: '',
    hasAplus: false,
    hasBrandStory: false,
    auditModel: 'o4-mini',
    onProgress: () => {},
    // Live-schema menu the appendSpecFact helper reads — present in EVERY test here (including the
    // adult no-op) so "no age row appears" proves the FAMILY's age is unstated, not merely that the
    // schema lacks the key.
    detailAttributeMenu: [
      { key: 'department', title: 'Department' },
      { key: 'target_gender', title: 'Target Gender' },
      AGE_RANGE_MENU_ATTR,
    ],
  }
}

/** Every GARMENT_AUDIENCE log line the run emitted, parsed. Last write wins (the console.log fires
 *  once per top-level pipeline pass, so a single-design run logs exactly one). */
function captureGarmentAudienceLog(spy: ReturnType<typeof vi.spyOn>): { ageClass: string | null; source: string; dept: string | null } | null {
  let out: { ageClass: string | null; source: string; dept: string | null } | null = null
  for (const call of spy.mock.calls) {
    const line = call[0]
    if (typeof line !== 'string' || !line.includes('GARMENT_AUDIENCE')) continue
    try {
      const parsed = JSON.parse(line) as { tag?: string; ageClass?: string | null; source?: string; dept?: string | null }
      if (parsed.tag === 'GARMENT_AUDIENCE') out = { ageClass: parsed.ageClass ?? null, source: parsed.source ?? '', dept: parsed.dept ?? null }
    } catch { /* not JSON — some other log line sharing a substring; ignore */ }
  }
  return out
}

function findRow(rows: PipelineProductDetailImprovement[], re: RegExp) {
  return rows.find((p) => re.test(p.field_name))
}

describe('garment age producer — real runListingPipeline, Product Detail block', () => {
  it('NO-OP CONTROL: an ADULT family (no stated age_class, not kids_tee) is byte-identical to pre-task behavior — no age_range_description row, department stays the plain lean map value, GARMENT_AUDIENCE source is none', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([
      { match: /\bshirt\b/i, spec: { brand: 'Comfort Colors', fit: 'Relaxed' }, styleCode: '1717', garmentFamily: 'tee' },
    ] as BlankSpecRow[])
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const input: PipelineInput = { ...makeBaseInput(openai), audienceLean: 'female' }
    const result = await runListingPipeline(input)
    const aud = captureGarmentAudienceLog(logSpy)
    logSpy.mockRestore()

    expect(aud).not.toBeNull()
    expect(aud!.source).toBe('none')
    expect(aud!.ageClass).toBeNull()

    const pdi = result.product_details_improvements
    expect(findRow(pdi, /age\s*range/i)).toBeUndefined()
    const dept = findRow(pdi, /^department$/i)
    // Byte-identical to the pre-task lean-only map: female -> 'Womens', stamped 'audience' — the
    // resolver contributed NOTHING because it had NOTHING stated to contribute.
    expect(dept?.recommended_value).toBe('Womens')
    expect(dept?.value_source).toBe('audience')
  }, 30_000)

  it('a STATED blank-column age fact (blank_specs.age_class=kids) composes Department to "Unisex Kids", stamps it spec (re-proposable per the PO ruling), and APPENDS an age_range_description row from the live accepted enum', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([
      { match: /\bshirt\b/i, spec: { brand: 'Gildan', brandInCopy: false, ageClass: 'kids' }, styleCode: '64000B', garmentFamily: 'kids_tee' },
    ] as BlankSpecRow[])
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    // No seller audience-lean selection at all — proving the ADDITIVE case the brief calls out:
    // "today a kids family with no selector gets nothing."
    const input: PipelineInput = { ...makeBaseInput(openai) }
    const result = await runListingPipeline(input)
    const aud = captureGarmentAudienceLog(logSpy)
    logSpy.mockRestore()

    // Prove the branch RAN (not just the output): the resolver's own decision, independent of what
    // ships in pdiFinal.
    expect(aud).not.toBeNull()
    expect(aud!.source).toBe('blank-column')
    expect(aud!.ageClass).toBe('kids')
    expect(aud!.dept).toBe('Unisex Kids')

    const pdi = result.product_details_improvements
    const dept = findRow(pdi, /^department$/i)
    expect(dept?.recommended_value).toBe('Unisex Kids')
    // PO ruling: a STATED blank fact stamps 'spec' (sticky-details honors 'spec' as a legit
    // re-propose trigger over an already-accepted push) — never 'audience' here, since no selector
    // spoke at all in this test.
    expect(dept?.value_source).toBe('spec')

    const ageRow = findRow(pdi, /age\s*range/i)
    expect(ageRow).toBeDefined()
    // PO ruling 2026-09-02: this product type's live enum has no bare "Kids" member, so the
    // resolver's ordered preference (AGE_RANGE_PREFERENCE.kids, contentTruth.ts) picks "Big Kid" —
    // the first entry AGE_RANGE_MENU_ATTR.accepted actually carries. (enum_valid/is_enum are only
    // stamped when mergeDetailRowsByPrecedence arbitrates a MULTI-row field — this audit stub
    // never guessed an age row, so this one ships alone; the validity proof for the competing-row
    // shape lives in the "THE REAL LIVE ENUM" test below.)
    expect(ageRow?.recommended_value).toBe('Big Kid')
    expect(ageRow?.value_source).toBe('spec')
    // The candidate came from the LIVE accepted enum this fixture declared, not a hardcoded literal.
    expect(AGE_RANGE_MENU_ATTR.accepted).toContain(ageRow?.recommended_value)
  }, 30_000)

  it('THE LIVE CASE (B0DP5H8QBT): a STATED blank-column age fact wins over an LLM guess that has ALREADY proposed a row for the same field in the SAME audit payload, by PROVENANCE — even though both now independently land on the same enum-valid value', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([
      { match: /\bshirt\b/i, spec: { brand: 'Gildan', brandInCopy: false, ageClass: 'kids' }, styleCode: '64000B', garmentFamily: 'kids_tee' },
    ] as BlankSpecRow[])
    // The mega-audit ALREADY guessed 'Big Kid' for Age Range Description — see kitchenSinkWithAgeGuess.
    // This is the exact shape of the live defect: before the #654 fix, appendSpecFact's "skip if a
    // row already exists" guard treated that guess as reason to never even try the deterministic
    // append. PO ruling 2026-09-02 separately fixed WHAT the deterministic append proposes (Big Kid,
    // not the unvalidatable "Kids") — so this fixture's LLM guess and the spec row now agree on the
    // VALUE. What proves the deterministic path still ran, not a lucky coincidence, is `value_source`.
    const openai = makeOpenAiStubWithAgeGuess()
    const logSpy = vi.spyOn(console, 'log')
    const input: PipelineInput = { ...makeBaseInput(openai) }
    const result = await runListingPipeline(input)
    const aud = captureGarmentAudienceLog(logSpy)
    logSpy.mockRestore()

    // Prove the branch RAN (not just the output): the resolver's own decision.
    expect(aud).not.toBeNull()
    expect(aud!.source).toBe('blank-column')
    expect(aud!.ageClass).toBe('kids')

    const pdi = result.product_details_improvements
    // Exactly ONE row ships for the field — the merge collapsed the guess and the deterministic
    // row; it did not let both ride through to the seller-facing list.
    const ageRows = pdi.filter((p) => /age\s*range/i.test(p.field_name))
    expect(ageRows).toHaveLength(1)
    const ageRow = ageRows[0]
    // PROVE THE BRANCH RAN VIA PROVENANCE, not merely a value that happens to look right: 'Big Kid'
    // is now what BOTH the LLM's guess and the deterministic producer propose, so the value alone
    // cannot distinguish them — value_source is the only signal that the SPEC row won, not the guess.
    expect(ageRow.value_source).toBe('spec')
    expect(ageRow.recommended_value).toBe('Big Kid')
    // Drawn from the LIVE accepted enum this fixture declared, not a hardcoded literal.
    expect(AGE_RANGE_MENU_ATTR.accepted).toContain(ageRow.recommended_value)
  }, 30_000)

  it('GARMENT-FAMILY FALLBACK: a kids_tee family with NO stated age_class column still resolves kids — source garment-family, same Department/age-row effect', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([
      // garment_family='kids_tee' present; age_class ABSENT (pre-071 row, or a kids_tee blank the
      // PO has not yet stated on the new column).
      { match: /\bshirt\b/i, spec: { brand: 'Gildan', brandInCopy: false }, styleCode: '64000B', garmentFamily: 'kids_tee' },
    ] as BlankSpecRow[])
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const input: PipelineInput = { ...makeBaseInput(openai) }
    const result = await runListingPipeline(input)
    const aud = captureGarmentAudienceLog(logSpy)
    logSpy.mockRestore()

    expect(aud).not.toBeNull()
    expect(aud!.source).toBe('garment-family')
    expect(aud!.ageClass).toBe('kids')

    const pdi = result.product_details_improvements
    const dept = findRow(pdi, /^department$/i)
    // departmentQualifier composes "Unisex Kids" from AGE_RANGE_LABEL (unaffected by this ruling —
    // it is a human-readable department phrase, snapped to Department's OWN enum downstream by
    // coerceGenderToEnum, not age_range_description's enum). ageRangeCandidate below is the row this
    // ruling actually changed.
    expect(dept?.recommended_value).toBe('Unisex Kids')
    expect(dept?.value_source).toBe('spec')
    expect(findRow(pdi, /age\s*range/i)?.recommended_value).toBe('Big Kid')
  }, 30_000)

  // ENUM-VALIDITY defect class (RESOLVED 2026-09-02, PO ruling "kids -> Big Kid"). Amazon's REAL
  // apparel age_range_description enum for this product type — read live from the DB 2026-09-02 —
  // is exactly ["Adult","Big Kid","Infant","Little Kid","Toddler"]. No bare "Kid"/"Kids"/"Youth"/
  // "Newborn" member exists at all, so the OLD hardcoded `AGE_RANGE_LABEL.kids = 'Kids'` could
  // NEVER validate — PR #661's validity-outranks-provenance guard correctly refused it every time,
  // and the field silently fell through to whatever the LLM happened to guess. The cure
  // (`AGE_RANGE_PREFERENCE` + `resolveAgeRangeLabel`, contentTruth.ts) makes the PRODUCER itself
  // resolve against the live enum, so it proposes a member Amazon actually accepts — this test
  // proves that end-to-end through the real runListingPipeline, not just the isolated
  // mergeDetailRowsByPrecedence unit (productDetailAttrs.test.ts).
  it('THE REAL LIVE ENUM: the deterministic producer now resolves "Big Kid" itself — enum_valid, is_enum, and value_source:spec together prove the SPEC row shipped, not an LLM fallback', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([
      { match: /\bshirt\b/i, spec: { brand: 'Gildan', brandInCopy: false, ageClass: 'kids' }, styleCode: '64000B', garmentFamily: 'kids_tee' },
    ] as BlankSpecRow[])
    const openai = makeOpenAiStubWithAgeGuess()   // the LLM already guessed 'Big Kid' — see kitchenSinkWithAgeGuess
    const input: PipelineInput = {
      ...makeBaseInput(openai),
      detailAttributeMenu: [
        { key: 'department', title: 'Department' },
        { key: 'target_gender', title: 'Target Gender' },
        // The brief's EXACT live list — verbatim, not the file's default AGE_RANGE_MENU_ATTR — so
        // this test stands on its own as the brief's required "accepted=[...] + age_class='kids' ->
        // Big Kid, enum_valid:true, value_source:'spec'" proof.
        { key: 'age_range_description', title: 'Age Range Description', accepted: ['Adult', 'Big Kid', 'Infant', 'Little Kid', 'Toddler'] },
      ],
    }
    const result = await runListingPipeline(input)
    const pdi = result.product_details_improvements
    const ageRows = pdi.filter((p) => /age\s*range/i.test(p.field_name))
    expect(ageRows).toHaveLength(1)   // the merge collapsed the LLM guess and the spec row into one
    const ageRow = ageRows[0]
    expect(ageRow.recommended_value).not.toBe('Kids')   // THE live bug this task closes — must never ship
    expect(ageRow.recommended_value).toBe('Big Kid')
    expect(ageRow.enum_valid).toBe(true)                // prove the branch ran, not just the string
    expect(ageRow.is_enum).toBe(true)
    expect(ageRow.value_source).toBe('spec')            // proves the SPEC row won, not the LLM's guess
  }, 30_000)

  it('DIFFERENT ENUM, ZERO CODE CHANGE: a product type whose age_range_description enum is only ["Youth","Adult"] resolves "kids" to "Youth" — the first ordered-preference member that enum actually carries', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([
      { match: /\bshirt\b/i, spec: { brand: 'Gildan', brandInCopy: false, ageClass: 'kids' }, styleCode: '64000B', garmentFamily: 'kids_tee' },
    ] as BlankSpecRow[])
    const openai = makeOpenAiStub()   // no competing LLM guess this time — isolates the producer's own pick
    const input: PipelineInput = {
      ...makeBaseInput(openai),
      detailAttributeMenu: [
        { key: 'department', title: 'Department' },
        { key: 'target_gender', title: 'Target Gender' },
        { key: 'age_range_description', title: 'Age Range Description', accepted: ['Youth', 'Adult'] },
      ],
    }
    const result = await runListingPipeline(input)
    const pdi = result.product_details_improvements
    const ageRow = findRow(pdi, /age\s*range/i)
    expect(ageRow).toBeDefined()
    expect(ageRow?.recommended_value).toBe('Youth')
    expect(ageRow?.value_source).toBe('spec')
  }, 30_000)

  it('NO MATCH: a schema whose age_range_description enum is only ["Adult"] carries NO row a kids family could truthfully claim — NO row ships, and a loud, greppable log fires instead of inventing a value', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([
      { match: /\bshirt\b/i, spec: { brand: 'Gildan', brandInCopy: false, ageClass: 'kids' }, styleCode: '64000B', garmentFamily: 'kids_tee' },
    ] as BlankSpecRow[])
    const openai = makeOpenAiStub()
    const warnSpy = vi.spyOn(console, 'warn')
    const input: PipelineInput = {
      ...makeBaseInput(openai),
      detailAttributeMenu: [
        { key: 'department', title: 'Department' },
        { key: 'target_gender', title: 'Target Gender' },
        { key: 'age_range_description', title: 'Age Range Description', accepted: ['Adult'] },
      ],
    }
    const result = await runListingPipeline(input)
    const pdi = result.product_details_improvements
    // NEVER invent a member: no candidate on the ordered preference is present, so no row appends.
    expect(findRow(pdi, /age\s*range/i)).toBeUndefined()

    // PROVE THE BRANCH RAN, not merely the absence of a row (which an unrelated bug could also
    // produce): the resolver's own greppable log fired with the decision fields, not just a string.
    const noMatchLog = warnSpy.mock.calls
      .map((c) => c[0])
      .filter((line): line is string => typeof line === 'string' && line.includes('AGE_RANGE_LABEL_NO_MATCH'))
      .map((line) => JSON.parse(line) as { tag: string; ageClass: string; accepted: string[] })
    warnSpy.mockRestore()
    expect(noMatchLog).toHaveLength(1)
    expect(noMatchLog[0].ageClass).toBe('kids')
    expect(noMatchLog[0].accepted).toEqual(['Adult'])

    // Department is UNAFFECTED — it composes from AGE_RANGE_LABEL (a different, human-phrase
    // concern with its own downstream enum coercion), so the family is still filed correctly there
    // even though age_range_description has nothing truthful to propose.
    expect(findRow(pdi, /^department$/i)?.recommended_value).toBe('Unisex Kids')
  }, 30_000)
})
