/**
 * Behavioral proof for CRITICAL 1+2 of the final whole-branch review (2026-08-24, PR
 * feat/title-admission-is-verification, handoff/TITLE_ADMISSION_IS_VERIFICATION.md §3.2).
 *
 * WHY THIS FILE EXISTS. CRITICAL 3 of that review found that NOTHING exercised
 * `listingPipeline.ts`'s actual broadcast-scope wiring: `truthBandHarness.ts` called
 * `computeBroadcastDesignScope` and derived its OWN `broadcastReject` beside the pipeline instead of
 * reading the pipeline's values, and every unit test drove `verdictForAssembledTitle` /
 * `buildForeignDesignTokens` / `computeBroadcastDesignScope` directly with hand-built ctx objects —
 * none of them called `runListingPipeline` at all. The review proved (by reverting
 * `listingPipeline.ts:9571/:9602/:9606/:9747/:9755` to their pre-fix defaults) that all 1686 tests
 * plus the harness stayed green with the wiring GONE.
 *
 * This test drives the REAL `runListingPipeline()` end-to-end (stubbed OpenAI, no network — same
 * hermetic pattern as `gatePerChildMultiDesign.integration.test.ts`) on a genuine two-design family,
 * on the FULL "Generate recommendations" path (no `onlySection`) with `priorPerChildTitles` and
 * `designNameOverridesByKey` BOTH ABSENT from `input` — the exact shape CRITICAL 1 measured as
 * broken (`route.ts` only sets `priorPerChildTitles` when `onlySection` is truthy;
 * `designNameOverridesByKey` is a documented dead wire). The per-design names this test relies on
 * come ONLY from the real `resolveGroupDesignName` -> `extractDesignName` LLM-extraction path, using
 * distinct per-child `title` seeds — nothing is injected through the two broken inputs CRITICAL 1
 * named.
 *
 * The assertion is the exact defect shape: the STUBBED title-generation response is the SAME literal
 * string for every call (`KITCHEN_SINK.title`, containing "Gator Bites" — the GATOR design's own
 * resolved name), so it lands in BOTH the per-child titles AND the raw broadcast/parent candidate
 * text, exactly as a real LLM call embedding a sibling's name into the shared parent title did live
 * (B0DSCDZC6K: "Business B*tch" in "THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt
 * for Men"). ONLY `scrubPublished`'s real broadcast-scope wiring can strip it — a hand-rolled
 * re-derivation beside the pipeline (what `truthBandHarness.ts` used to do) would prove nothing about
 * whether the PIPELINE itself convicts it.
 */
import { describe, it, expect } from 'vitest'
import { runListingPipeline, type PipelineInput, type PipelineChild } from './listingPipeline'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}
for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; delete process.env[key] }

// KITCHEN SINK — the ONE canned response every JSON-mode title/bullets/description call receives
// (same pattern as gatePerChildMultiDesign.integration.test.ts). Its title carries "Gator Bites" —
// GATOR's own resolved design name — so when the SAME stub answers the broadcast/parent title call,
// the raw candidate ALREADY carries a per-design name, exactly like the live regression string.
const KITCHEN_SINK = {
  // 73 chars — deliberately already inside the 70-75 ship band (this fixture's `analysis: []` has
  // no candidate pool to pad from, so a base title that needed padding would HOLD and ship
  // `prior` instead, which would trivially satisfy this test's assertion for the wrong reason).
  title: 'THE CEO Gator Bites Graphic Tee | Long Sleeve Comfort Colors Cotton Shirt',
  bullets: [
    'PLAYFUL DESIGN - A fun graphic print that stands out in any crowd, made for everyday wear.',
    'SOFT COMFORT - Garment-dyed ring-spun cotton feels soft against skin, wash after wash.',
    'GREAT GIFT - A thoughtful gift for birthdays, holidays, or just because they deserve it.',
    'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
    'TRUE TO SIZE - Relaxed unisex fit runs true to size for a comfortable everyday silhouette.',
  ],
  description: '<p>A fun graphic tee for everyday wear.</p><ul><li>Soft cotton</li><li>Relaxed fit</li></ul><p>Great gift.</p>',
  backend_drop: [],
}

/** `extractDesignName`'s own system prompt (listingPipeline.ts) is the fingerprint that lets this
 *  stub answer THAT call differently per design group — everything else gets the kitchen sink. The
 *  design name comes from the group's OWN seeded child `title` (the `Title: ...` user message),
 *  never from `priorPerChildTitles`/`designNameOverridesByKey` (both absent from this test's input). */
const DESIGN_NAME_FINGERPRINT = 'You extract the DESIGN NAME'

function makeOpenAiStub() {
  return {
    chat: {
      completions: {
        create: async (args: { messages?: { content?: string }[]; response_format?: { type?: string } }) => {
          const sys = args?.messages?.[0]?.content ?? ''
          const user = args?.messages?.[1]?.content ?? ''
          if (typeof sys === 'string' && sys.includes(DESIGN_NAME_FINGERPRINT)) {
            const name = /Shark Week/i.test(user) ? 'Shark Week' : /Gator Bites/i.test(user) ? 'Gator Bites' : ''
            return { choices: [{ message: { content: JSON.stringify({ designName: name }) }, finish_reason: 'stop' }] }
          }
          // The title-council calls (proposers/adversary/judge, `titleCouncilAsk`) request NO
          // `response_format` — they read `message.content` as the RAW title/critique text directly
          // (no JSON parse). Every OTHER JSON-mode caller (bullets/description/backend, the
          // editorial audit, humanizer) sets `response_format: { type: 'json_object' }`. Branching on
          // that distinguishes the two WITHOUT hardcoding a model/system-prompt fingerprint per call
          // site (there are many, and this file should not have to track them all).
          if (args?.response_format?.type === 'json_object') {
            return { choices: [{ message: { content: JSON.stringify(KITCHEN_SINK) }, finish_reason: 'stop' }] }
          }
          // Plain-text council call: return the SAME candidate title verbatim (adversary/critique
          // calls get it too — their return value is prose fed to the judge, not parsed, so any
          // non-empty text is harmless there).
          return { choices: [{ message: { content: KITCHEN_SINK.title }, finish_reason: 'stop' }] }
        },
      },
    },
  } as unknown as PipelineInput['openai']
}

function makeChildren(): PipelineChild[] {
  return [
    { sku: 'GATOR-M-BLK', asin: 'B0GATORMBLK', color: 'Black', size: 'M', title: 'THE CEO Gator Bites Tee' },
    { sku: 'GATOR-L-BLK', asin: 'B0GATORLBLK', color: 'Black', size: 'L', title: 'THE CEO Gator Bites Tee' },
    { sku: 'SHARK-M-BLK', asin: 'B0SHARKMBLK', color: 'Black', size: 'M', title: 'THE CEO Shark Week Tee' },
    { sku: 'SHARK-L-BLK', asin: 'B0SHARKLBLK', color: 'Black', size: 'L', title: 'THE CEO Shark Week Tee' },
  ]
}

function makeFullRegenInput(): PipelineInput {
  const openai = makeOpenAiStub()
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SHIRT',
    analysis: [],
    children: makeChildren(),
    // "Gildan 64000" resolves a REAL garment family via blankSpecs.ts's DEFAULT_BLANK_SPECS
    // fail-open seed table (Supabase disabled above, so `loadBlankSpecRows` falls open to the
    // seeds — the same fail-open floor production itself uses on a DB miss) — WITHOUT it,
    // `truthGarmentFamily` stays null, `buildPhraseTruthCtx` returns null (contentTruth.ts:
    // `if (!facts.garmentFamily) return null`), and `titleTruthDoor`'s `ctx ? applyTitleTruthNet(...)
    // : stripped` skips the truth net ENTIRELY — including the foreign-name reject this test exists
    // to prove, for a reason unrelated to CRITICAL 1+2. A resolved blank is required for this test
    // to exercise anything.
    repTitle: 'THE CEO Graphic Tee Gildan 64000',
    canonicalTitle: 'THE CEO Graphic Tee Gildan 64000',
    priorTitle: 'THE CEO Graphic Tee',
    priorBullets: KITCHEN_SINK.bullets,
    variantDetails: '',
    keywordContext: '',
    hasAplus: false,
    hasBrandStory: false,
    auditModel: 'o4-mini',
    onProgress: () => {},
    // DELIBERATELY ABSENT: `priorPerChildTitles`, `designNameOverridesByKey`. CRITICAL 1's exact
    // measured shape — `route.ts` never sets either on a full "Generate recommendations" run. Design
    // names must be resolved fresh, via `resolveGroupDesignName`/`extractDesignName`, from
    // `input.children` alone.
    // No `onlySection` — this IS the full regen path.
  }
}

describe('broadcast ship-door wiring (final review CRITICAL 1+2+3)', () => {
  it('a FULL regen (no priorPerChildTitles, no designNameOverridesByKey) still rejects a per-design name from the broadcast/parent title', async () => {
    const input = makeFullRegenInput()
    const result = await runListingPipeline(input)

    // Sanity: this is a real multi-design run with genuinely DIFFERENT per-design names — a false
    // pass from misclassification (single design, or both groups resolving to the same name) would
    // prove nothing.
    expect(result.debug.multiDesign).toBe(true)
    const names = new Set((result.per_child_titles ?? []).map((c) => (c.designName ?? '').trim()))
    expect(names.has('Gator Bites')).toBe(true)
    expect(names.has('Shark Week')).toBe(true)

    // THE ASSERTION: the raw stub answers EVERY title call (including the broadcast/parent call)
    // with a string containing "Gator Bites" — a genuine per-design name, confirmed above to be
    // resolved and stored on `per_child_titles`. The broadcast title is answerable to the whole
    // family, not one design, so "gator"/"bites" must not survive scrubPublished's broadcast door.
    const broadcast = (result.recommended_title || '').toLowerCase()
    expect(broadcast).not.toMatch(/\bgator\b/)
    expect(broadcast).not.toMatch(/\bbites\b/)
  }, 30_000)
})
