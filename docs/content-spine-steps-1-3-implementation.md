# Content Spine — Steps 1–3 Implementation Plan (executable)

**Author:** Opus 4.8 · **Executor:** smaller model under `/karpathy-dev-principles` · **Status:** awaiting PO approval
**Parent architecture:** `docs/content-spine-v1-architecture.md` (10 steps). THIS doc is Steps 1–3 only — the safe, high-value foundation. Steps 4–10 are explicitly OUT of scope and listed at the end.

---

## 0. How to execute this (read first)

- Create ONE todo per numbered edit below. Do them in order. Do not batch across steps.
- **Every edit is an exact-string replacement.** The `FIND` block is copied byte-for-byte from the live file. Use the Edit tool with `old_string` = FIND and `new_string` = REPLACE. If Edit reports the string is not unique, the plan says so and gives extra context — include it.
- After **each step**, run the step's SUCCESS GATE. Do not proceed until it is green.
- **Touch only what is named.** No drive-by refactors, no reformatting, no "while I'm here."
- All file paths are relative to `C:/Users/Admin/AppData/Local/Temp/fba-portal`.
- This is live-write code (bytes reach Amazon). Steps 1 and 2 are byte-identical (contract holds today's values; new function is defined but only *called* in Step 3). Step 3's behavior change is behind the `CONTENT_SPINE` flag, default `off`.

---

## STEP 1 — `contentContract.ts` (single source of truth) + drift tripwire tests

**Goal:** one module holds every length/byte band. Re-point the 5 canonical exported constants to read from it (byte-identical — same values). Lock the known scorer-vs-generator drifts with tripwire tests so they can never change silently. Zero runtime behavior change.

### 1.1 — Create `src/lib/fba/contentContract.ts`

```ts
/**
 * Content Contract — the single source of truth for every content length/byte band and the
 * scorer↔generator reconciliation targets (content-spine Step 1, 2026-07-22).
 *
 * Today many of these numbers are duplicated as raw literals across ~40 sites in listingPipeline.ts
 * and syncListingContent.ts, and the SCORER and the GENERATOR disagree for three fields (documented
 * below as `scorer*` fields). This module makes the values one place. Step 1 re-points only the 5
 * canonical exported constants; the scattered raw literals are migrated in later steps. Step 4 will
 * flip the scorer* fields to equal the generator floors — until then the tripwire tests lock them.
 *
 * NOTHING in this module has side effects; it is pure data, safe to import anywhere (no cycles).
 */
export const CONTENT_CONTRACT = {
  title: {
    hardCap: 75,            // capTitle75 ceiling — Amazon auto-rewrites >75 after 2026-07-27
    floor: 50,              // validateTitle under-length trigger
    goldenBandLo: 70,       // scoreTitleQuality golden band low
    goldenBandHi: 75,
    humanizerTrigger: 68,   // humanizeTitleTo75 fires below this
    fillTarget: 73,         // deterministic fill-to target
  },
  bullets: {
    count: 5,               // exactly 5 bullets
    min: 150,               // BULLET_MIN_CHARS — generator floor, terminal-net enforced
    max: 200,               // BULLET_MAX_CHARS — capBulletLen ceiling
    scorerTooShort: 80,     // syncListingContent b.length<80 dock — DIVERGES from min (Step-4 reconcile)
  },
  description: {
    floor: 900,             // DESC_MIN_CHARS — generator floor, reExpand-enforced
    ceiling: 980,           // capDescriptionVisible default
    scorerApparelFloor: 700, // syncListingContent apparel desc dock — DIVERGES from floor (Step-4 reconcile)
  },
  keywords: {
    byteCap: 250,           // fillBackendToBudget hard cap
    fillEarlyReturn: 244,   // fillBackendToBudget early-return
    coreTargetColored: 233, // coreByteTarget with color tail
    coreTargetColorless: 244,
    minLegacy: 190,         // backendDegradeGate BACKEND_MIN_LEGACY
    minStrict: 220,         // backendDegradeGate BACKEND_MIN_STRICT + scoreBackend green-band low
    scorerCharDockLo: 100,  // syncListingContent backend .length<100 dock — DIVERGES (byte vs char) (Step-4)
    scorerCharDockHi: 200,  // syncListingContent backend .length<200 dock
  },
} as const
```

### 1.2 — Re-point `BULLET_MIN_CHARS` / `BULLET_MAX_CHARS`

**File:** `src/lib/fba/listingPipeline.ts`

**FIND** (unique — the declaration block):
```ts
// Bullet char-budget invariants (2026-07-21, INVARIANT 5 — ONE source of truth per byte budget). PO
// SEO/conversion target: each bullet 150-200 chars (previously 100-200 across scattered prompts, leaving
// the LLM to land at the 100 floor and ship 500-char totals when 1000 hits the shopper better).
export const BULLET_MIN_CHARS = 150
export const BULLET_MAX_CHARS = 200
```
**REPLACE:**
```ts
// Bullet char-budget invariants (2026-07-21, INVARIANT 5 — ONE source of truth per byte budget). PO
// SEO/conversion target: each bullet 150-200 chars. Values now live in contentContract.ts (spine Step 1).
export const BULLET_MIN_CHARS = CONTENT_CONTRACT.bullets.min
export const BULLET_MAX_CHARS = CONTENT_CONTRACT.bullets.max
```

### 1.3 — Re-point `DESC_MIN_CHARS`

**File:** `src/lib/fba/listingPipeline.ts`

**FIND** (unique):
```ts
// Description char-budget floor (mirrors existing 900-980 target). Exported so the terminal re-expand
// (INVARIANT 3, added 2026-07-21) can re-check length AFTER scrubDescriptionBody trimmed brand/screen-
// print mentions and pushed the audit output below the floor on B0FKKN8XKV live regen.
export const DESC_MIN_CHARS = 900
```
**REPLACE:**
```ts
// Description char-budget floor (mirrors existing 900-980 target). Value now lives in contentContract.ts
// (spine Step 1). Exported so the terminal re-expand can re-check length after scrubDescriptionBody.
export const DESC_MIN_CHARS = CONTENT_CONTRACT.description.floor
```

### 1.4 — Add the import to `listingPipeline.ts`

**FIND** (unique — the backendDegradeGate import added earlier):
```ts
import { BACKEND_DEGRADE_STRICT_ON, backendMinBytesFloor, logShadowDiff } from '@/lib/fba/backendDegradeGate'
```
**REPLACE:**
```ts
import { BACKEND_DEGRADE_STRICT_ON, backendMinBytesFloor, logShadowDiff } from '@/lib/fba/backendDegradeGate'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
```

### 1.5 — Re-point the backend floors in `backendDegradeGate.ts`

**File:** `src/lib/fba/backendDegradeGate.ts`

**FIND** (unique):
```ts
/** Legacy floor — kept as the default so flag=off is byte-identical. */
export const BACKEND_MIN_LEGACY = 190
/** Doctrine floor per fba-generation-invariants — the golden band is 240-250, floor is 220. */
export const BACKEND_MIN_STRICT = 220
```
**REPLACE:**
```ts
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
/** Legacy floor — kept as the default so flag=off is byte-identical. */
export const BACKEND_MIN_LEGACY = CONTENT_CONTRACT.keywords.minLegacy
/** Doctrine floor per fba-generation-invariants — the golden band is 240-250, floor is 220. */
export const BACKEND_MIN_STRICT = CONTENT_CONTRACT.keywords.minStrict
```
> If Edit rejects the added `import` line because imports must be top-of-file, instead: (a) add `import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'` at the top of the file next to its other imports, and (b) replace only the two `= 190` / `= 220` right-hand sides.

### 1.6 — Create `src/lib/fba/contentContract.test.ts` (drift tripwires)

```ts
import { describe, it, expect } from 'vitest'
import { CONTENT_CONTRACT as C } from './contentContract'

describe('contentContract — value lock', () => {
  it('holds the current live generator values byte-for-byte', () => {
    expect(C.bullets.min).toBe(150)
    expect(C.bullets.max).toBe(200)
    expect(C.bullets.count).toBe(5)
    expect(C.description.floor).toBe(900)
    expect(C.description.ceiling).toBe(980)
    expect(C.keywords.minLegacy).toBe(190)
    expect(C.keywords.minStrict).toBe(220)
    expect(C.keywords.byteCap).toBe(250)
    expect(C.title.hardCap).toBe(75)
    expect(C.title.floor).toBe(50)
  })

  it('is internally consistent (min < max, floor < ceiling)', () => {
    expect(C.bullets.min).toBeLessThan(C.bullets.max)
    expect(C.description.floor).toBeLessThan(C.description.ceiling)
    expect(C.keywords.minStrict).toBeGreaterThan(C.keywords.minLegacy)
    expect(C.title.goldenBandLo).toBeLessThan(C.title.goldenBandHi)
  })
})

describe('contentContract — scorer↔generator drift tripwires (Step 4 reconciles)', () => {
  // These lock the KNOWN lies in place so they cannot change silently. When Step 4 aligns the scorer
  // to the generator, these three assertions flip in the same commit. If anyone edits a scorer OR a
  // generator number without going through Step 4, the mismatch surfaces here and the build fails.
  it('BULLETS: scorer full-marks at 80 while generator targets 150 (a lie until Step 4)', () => {
    expect(C.bullets.scorerTooShort).toBe(80)
    expect(C.bullets.min).toBe(150)
    expect(C.bullets.scorerTooShort).not.toBe(C.bullets.min) // <-- the lie, asserted explicitly
  })
  it('DESCRIPTION: scorer docks apparel <700 while generator floor is 900 (a lie until Step 4)', () => {
    expect(C.description.scorerApparelFloor).toBe(700)
    expect(C.description.floor).toBe(900)
    expect(C.description.scorerApparelFloor).not.toBe(C.description.floor)
  })
  it('KEYWORDS: scorer counts CHARS <100 while generator budgets BYTES 220-250 (a unit lie until Step 4)', () => {
    expect(C.keywords.scorerCharDockLo).toBe(100)
    expect(C.keywords.minStrict).toBe(220)
  })
})
```

### STEP 1 SUCCESS GATE
1. `npx tsc --noEmit` → 0 errors.
2. `npx vitest run src/lib/fba/contentContract.test.ts` → all green.
3. `git grep -n "BULLET_MIN_CHARS = " src/lib/fba/listingPipeline.ts` shows it now reads `CONTENT_CONTRACT.bullets.min`.
4. Emitted values unchanged: `node -e "console.log(require('...').CONTENT_CONTRACT.bullets.min)"` prints 150. (Or trust the test — `.toBe(150)` proves it.)

Zero behavior change. Commit: `feat(spine): Step 1 — contentContract.ts single source + drift tripwires`.

---

## STEP 2 — define `applyTerminalNets(field, value, ctx)` (defined, not yet called on full path)

**Goal:** one function that runs a field's terminal deterministic net. Step 2 only DEFINES it and unit-tests it against the inline passes on a no-LLM fixture. It is not wired into the full path (that consolidation is deferred to Step 6 to keep blast radius tiny). Zero runtime behavior change.

### 2.1 — Add `applyTerminalNets` in `listingPipeline.ts`

Place it immediately AFTER the `reExpandDescriptionIfShort` function so both helpers it calls are in scope.

**FIND** (unique — the `reExpandDescriptionIfShort` signature start; include just enough to anchor):
```ts
export async function reExpandDescriptionIfShort(
  openai: OpenAI,
  description: string,
  opts: { finalTitle: string; brand?: string; garmentBrand?: string },
): Promise<string> {
```
**REPLACE** — same lines, then insert the new function BEFORE them:
```ts
/**
 * Terminal deterministic net — content-spine Step 2 (2026-07-22). ONE function that runs a field's
 * terminal passes in the exact order + with the exact arguments the FULL regen path uses today:
 *   bullets      → expandShortBulletsTerminal (the 150-floor enforcer; idempotent, apparel-gated by caller)
 *   description  → scrubDescriptionBody (brand/screen-print strip) → reExpandDescriptionIfShort (re-fill <900)
 * Idempotent by construction (each underlying pass no-ops when already in band), so it is safe to call
 * on any path. Step 3 wires it into the section-regen returns; the full-path call sites are swapped in
 * Step 6. Keywords are intentionally NOT handled here (the keywords-only path already runs its chain).
 */
export async function applyTerminalNets(
  field: 'bullets' | 'description',
  value: string[] | string,
  ctx: {
    openai: OpenAI
    finalTitle: string
    designName: string
    fit: string | undefined
    brandName: string
    garmentBrand: string | undefined
  },
): Promise<string[] | string> {
  if (field === 'bullets') {
    const bullets = value as string[]
    if (!Array.isArray(bullets) || bullets.length !== 5) return bullets
    return expandShortBulletsTerminal(ctx.openai, bullets, {
      title: ctx.finalTitle,
      designName: ctx.designName,
      fit: ctx.fit,
      garmentBrand: ctx.garmentBrand,
    })
  }
  // description
  let d = value as string
  if (!d) return d
  if (ctx.brandName) d = scrubDescriptionBody(d, { brand: ctx.brandName, garmentBrand: ctx.garmentBrand })
  if (ctx.brandName) d = await reExpandDescriptionIfShort(ctx.openai, d, { finalTitle: ctx.finalTitle, brand: ctx.brandName, garmentBrand: ctx.garmentBrand })
  return d
}

export async function reExpandDescriptionIfShort(
  openai: OpenAI,
  description: string,
  opts: { finalTitle: string; brand?: string; garmentBrand?: string },
): Promise<string> {
```
> Note: `expandShortBulletsTerminal` and `scrubDescriptionBody` must be declared ABOVE this point in the file (they are — expandShortBulletsTerminal ~6347, scrubDescriptionBody ~6433, reExpandDescriptionIfShort ~6408). If TypeScript complains about use-before-declaration for a `function` declaration, it will not (hoisted). If it complains about `scrubDescriptionBody` being a `const`, move `applyTerminalNets` to just below `scrubDescriptionBody` instead.

### 2.2 — Create `src/lib/fba/applyTerminalNets.test.ts` (no-LLM idempotence proof)

```ts
import { describe, it, expect } from 'vitest'
import { applyTerminalNets } from './listingPipeline'

// A fake openai that MUST NOT be called — the fixtures are already in-band, so every terminal pass
// no-ops and no model call happens. If applyTerminalNets ever calls the model here, this test throws.
const openaiThatMustNotBeCalled = {
  chat: { completions: { create: () => { throw new Error('terminal net called the model on in-band input') } } },
} as never

const ctx = {
  openai: openaiThatMustNotBeCalled,
  finalTitle: 'THE CEO Test Tee Shirt | Comfort Colors Shirt for Women',
  designName: 'Test',
  fit: 'relaxed',
  brandName: 'THE CEO',
  garmentBrand: 'Comfort Colors',
}

describe('applyTerminalNets — idempotent passthrough on in-band input', () => {
  it('bullets: 5 bullets each >=150 chars pass through unchanged (no model call)', async () => {
    const b = Array.from({ length: 5 }, (_, i) =>
      `BENEFIT ${i} - ` + 'This is a deliberately long benefit sentence that comfortably clears the one hundred fifty character minimum for a bullet so the terminal expander does nothing at all here.')
    b.forEach((x) => expect(x.length).toBeGreaterThanOrEqual(150))
    const out = await applyTerminalNets('bullets', b, ctx) as string[]
    expect(out).toEqual(b)
  })
  it('bullets: non-5 array returns unchanged', async () => {
    const out = await applyTerminalNets('bullets', ['a', 'b'], ctx) as string[]
    expect(out).toEqual(['a', 'b'])
  })
  it('description: >=900 chars, no seller brand in body, passes through (no model call)', async () => {
    const html = '<p><b>Great tee.</b> ' + 'Soft ringspun cotton feels smooth all day. '.repeat(30) + '</p>'
    const plain = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    expect(plain.length).toBeGreaterThanOrEqual(900)
    const out = await applyTerminalNets('description', html, ctx) as string
    expect(out).toBe(html)
  })
})
```
> If the description fixture happens to fall under 900 after tag-stripping, lengthen the `.repeat(30)` until the pre-assert passes. The point is an in-band no-op.

### STEP 2 SUCCESS GATE
1. `npx tsc --noEmit` → 0 errors.
2. `npx vitest run src/lib/fba/applyTerminalNets.test.ts` → green (proves the function is wired to the real passes and is idempotent, with NO model call on in-band input).
3. `git grep -n "applyTerminalNets(" src/lib/fba/listingPipeline.ts` shows the definition and ZERO call sites yet (Step 3 adds them).

Zero behavior change (function defined, never called). Commit: `feat(spine): Step 2 — applyTerminalNets terminal-net door + idempotence test`.

---

## STEP 3 — wire `applyTerminalNets` into the two leaky section-regen returns (behind `CONTENT_SPINE`)

**Goal:** "Regenerate bullets" stops shipping broadcast bullets under 150 chars; "Regenerate description" stops shipping brand-in-body / "screen-printed" / sub-900 broadcast copy. Behind `CONTENT_SPINE` = off/shadow/on.

### 3.1 — Add the flag near the other flags in `listingPipeline.ts`

**FIND** (unique — the BACKEND_CRIT flag block tail):
```ts
const BACKEND_CRIT_MODE = (process.env.BACKEND_CRITICAL_KEYWORDS || 'off').toLowerCase()
const BACKEND_CRIT_ON = BACKEND_CRIT_MODE === 'on'
const BACKEND_CRIT_SHADOW = BACKEND_CRIT_MODE === 'shadow'
```
**REPLACE:**
```ts
const BACKEND_CRIT_MODE = (process.env.BACKEND_CRITICAL_KEYWORDS || 'off').toLowerCase()
const BACKEND_CRIT_ON = BACKEND_CRIT_MODE === 'on'
const BACKEND_CRIT_SHADOW = BACKEND_CRIT_MODE === 'shadow'
// CONTENT_SPINE (2026-07-22, spine Step 3): route the leaky section-regen returns through the shared
// applyTerminalNets so "Regenerate bullets"/"Regenerate description" get the SAME terminal net the full
// path runs. off=legacy (byte-identical); shadow=log [SPINE_DIFF] which would-change, ship legacy;
// on=apply the terminal net.
const CONTENT_SPINE_MODE = (process.env.CONTENT_SPINE || 'off').toLowerCase()
const CONTENT_SPINE_ON = CONTENT_SPINE_MODE === 'on'
const CONTENT_SPINE_SHADOW = CONTENT_SPINE_MODE === 'shadow'
```

### 3.2 — Bullets-only: add the terminal net after the metric loop

**File:** `src/lib/fba/listingPipeline.ts`, inside `if (only === 'bullets') {`.

**FIND** (unique — the metric-loop call + the following per-child gate comment):
```ts
    bullets = await runBulletsMetricLoops(input.openai, bullets, perChildBullets, {
      title: finalTitle, brandName: brandName || 'THE CEO', designName: effectiveDesignName || '',
      fit: truthFitEarly, onProgress,
    }, enableBulletsLoop)
    // Per-child multi-design bullets the push prefers now get the SAME gate (task #61) — closing the
    // former "per_child_bullets are ungated on both paths" gap. Deterministic scrub always; audit capped.
    await gatePerChildMultiDesign(perChildBullets, undefined, truthFitEarly, garmentBrandCanonical || '')
```
**REPLACE:**
```ts
    bullets = await runBulletsMetricLoops(input.openai, bullets, perChildBullets, {
      title: finalTitle, brandName: brandName || 'THE CEO', designName: effectiveDesignName || '',
      fit: truthFitEarly, onProgress,
    }, enableBulletsLoop)
    // CONTENT_SPINE Step 3: the FULL path runs the terminal 150-floor bullets expander after the metric
    // loop; the bullets-only path never did, so a section-regen could ship broadcast bullets < 150. Wire
    // the SAME terminal net here. apparel-gated to match the full-path guard.
    if (apparelProduct && Array.isArray(bullets) && bullets.length === 5) {
      const spineCtx = { openai: input.openai, finalTitle, designName: effectiveDesignName || '', fit: truthFitEarly, brandName: brandName || 'THE CEO', garmentBrand: blankSpec?.brand }
      if (CONTENT_SPINE_ON) {
        bullets = await applyTerminalNets('bullets', bullets, spineCtx) as string[]
      } else if (CONTENT_SPINE_SHADOW) {
        const short = bullets.filter((b) => b.length < BULLET_MIN_CHARS).length
        if (short) console.log(`[SPINE_DIFF] bullets-only: ${short}/5 broadcast bullets < ${BULLET_MIN_CHARS} — terminal net would expand`)
      }
    }
    // Per-child multi-design bullets the push prefers now get the SAME gate (task #61) — closing the
    // former "per_child_bullets are ungated on both paths" gap. Deterministic scrub always; audit capped.
    await gatePerChildMultiDesign(perChildBullets, undefined, truthFitEarly, garmentBrandCanonical || '')
```
> Verify `blankSpec` is in scope at this point (it is used by the full-path bullets terminal call). If the local variable is named differently here, use the same expression the full path uses at `:8565` (`garmentBrand: blankSpec?.brand`).

### 3.3 — Description-only: add scrub + re-expand after the editorial gate

**File:** `src/lib/fba/listingPipeline.ts`, inside `if (only === 'description') {`.

**FIND** (unique — the editorial gate + its assert, then the per-design fan-out comment):
```ts
    ;({ description: descriptionOnly } = await applyEditorialGates(bullets, descriptionOnly))
    assertCoreHealthy(input.openai, null, null, descriptionOnly)
    // Partial coherence (#9): refresh the per-design descriptions the push actually prefers —
    // previously only the broadcast updated and the regenerated copy never reached the children.
    // Runs AFTER the gates so the single-design BROADCAST copy is gated.
    perChildDescriptions = await fanOutPerDesignDescriptions(descriptionOnly)
```
**REPLACE:**
```ts
    ;({ description: descriptionOnly } = await applyEditorialGates(bullets, descriptionOnly))
    assertCoreHealthy(input.openai, null, null, descriptionOnly)
    // CONTENT_SPINE Step 3: the FULL path runs scrubDescriptionBody + reExpandDescriptionIfShort on the
    // BROADCAST description; the description-only path never did (only per-child got them via the gate),
    // so a section-regen could ship brand-in-body / "screen-printed" / sub-900 broadcast copy. Wire the
    // SAME terminal net here, before the per-design fan-out and the existing capDescriptionVisible below.
    {
      const spineCtx = { openai: input.openai, finalTitle, designName: effectiveDesignName || '', fit: truthFitEarly, brandName: brandName || 'THE CEO', garmentBrand: blankSpec?.brand }
      if (CONTENT_SPINE_ON && descriptionOnly && brandName) {
        descriptionOnly = await applyTerminalNets('description', descriptionOnly, spineCtx) as string
      } else if (CONTENT_SPINE_SHADOW && descriptionOnly) {
        const plain = descriptionOnly.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        const wouldScrub = brandName ? scrubDescriptionBody(descriptionOnly, { brand: brandName, garmentBrand: blankSpec?.brand }) !== descriptionOnly : false
        if (plain.length < DESC_MIN_CHARS || wouldScrub) console.log(`[SPINE_DIFF] description-only: len=${plain.length} (floor ${DESC_MIN_CHARS}) wouldScrubBrand=${wouldScrub} — terminal net would fix`)
      }
    }
    // Partial coherence (#9): refresh the per-design descriptions the push actually prefers —
    // previously only the broadcast updated and the regenerated copy never reached the children.
    // Runs AFTER the gates so the single-design BROADCAST copy is gated.
    perChildDescriptions = await fanOutPerDesignDescriptions(descriptionOnly)
```

### STEP 3 SUCCESS GATE
1. `npx tsc --noEmit` → 0 errors.
2. `CONTENT_SPINE` unset → both new branches are dead (`_ON` and `_SHADOW` false); output is byte-identical to today. Confirm by re-running the Step 2 test suite + a full-regen snapshot if one exists.
3. **Live (INVARIANT 6):** deploy, set `CONTENT_SPINE=shadow`, trigger "Regenerate bullets" and "Regenerate description" on a listing whose current section-regen output is short/brand-leaky → server logs a `[SPINE_DIFF]` line for each. Then set `=on`, re-regen → fetch the recommendation and assert: every broadcast bullet ≥ 150 chars; description ≥ 900 plain chars with no seller brand in body prose and no "screen-print"/"silk-screen".
4. Rollback = `CONTENT_SPINE=off` + restart.

Commit: `feat(spine): Step 3 — route section-regen bullets/description through applyTerminalNets (CONTENT_SPINE flag)`.

---

## Rollback summary

- **Step 3** behavior: `CONTENT_SPINE=off` (env) — instant, no deploy.
- **Steps 1–2** are byte-identical refactors; if a mistake is found, `git revert` the step's commit. The contract values and the terminal-net function are inert until Step 3 turns them on.

## Verification order for the PO

1. Merge Steps 1–2 (byte-identical) — CI proves it.
2. Merge Step 3 — CI green, flag `off` in prod (nothing changes).
3. Set `CONTENT_SPINE=shadow` — read `[SPINE_DIFF]` logs to see how many section-regens were leaking.
4. Set `CONTENT_SPINE=on` — verify a live section-regen hits the floors.

## Explicitly OUT of scope (need separate approval — Steps 4–10)

- **Step 4** scorer↔contract reconciliation (`SCORER_CONTRACT` flag) — flips thousands green→red; this is the "you broke my catalog" step; needs its own PR + shadow-diff review.
- **Step 5** collapse single-design → N=1 group + delete the `:7413` guard — highest structural value, own adversarial review.
- **Step 6** swap the FULL-path call sites to `applyTerminalNets` + finalizer + path table + reachability CI test.
- **Step 7** one council harness, adversary≠judge, TITLE_COUNCIL_V3 gold-pattern prompts + the 12 title gate deletions (`docs/title-council-v3-spec.md`).
- **Step 8** kill the CRITICAL→IRRELEVANT ratchet.
- **Step 9** consolidate word-lists into the contract.
- **Step 10** flip the CI tests to gating.

These are named so the executor does NOT attempt them and the PO knows what remains.
