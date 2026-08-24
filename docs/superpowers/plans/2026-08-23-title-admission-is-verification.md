# Title Admission-Is-Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make candidate admission and exit verification the same predicate, so tightening one half can never let the other refill the freed budget with a lie.

**Architecture:** Three surgical changes across `src/lib/fba/titleBand.ts` and `src/lib/fba/listingPipeline.ts`. (1) The broadcast/parent exit gets a foreign-design-name partition it has never had. (2) The unspec'd-attribute rule stops being a pipeline stage the pad can undo and becomes a reason the whole-string verifier returns. (3) `enforceTitleBand` — documented in-code as "deliberately UNCONSTRAINED" — starts verifying what it accepts, closing the last writer that accepts on length alone.

**Tech Stack:** TypeScript, Next.js 15, Vitest, pnpm. No new dependencies.

**Spec:** `handoff/TITLE_ADMISSION_IS_VERIFICATION.md`

## Global Constraints

- Branch from `main` at `2552090`. Work in a git worktree at `C:\Users\Admin\AppData\Local\Temp\fba-wt-admission`.
- NO new definition of truth. Reuse `verdictForAssembledTitle`, `applyTitleTruthNet`, `buildPhraseTruthCtx`, `buildForeignDesignTokens`, `designScopeTokens`, `scrubUnspecdGarmentClaims`. A second synonym table, blocklist, or predicate is a REJECTED change — this repo grew SEVEN definitions of "covered" that way.
- Nothing may write after verification. `src/lib/fba/truthBandGate.test.ts` pins this at source level. Do not break it.
- Vitest baseline on `main` @ `2552090`: **1662 passed + 4 expected-fail across 85 files**. Zero regressions permitted.
- CI trap: `.github/workflows/build.yml` sets PLACEHOLDER Supabase env, so lazily-created clients make real ~4s network calls and time out. Null the relevant env vars per test file.
- A local `next build` inside a git worktree fails with a Turbopack "symlink points out of filesystem root" error. Worktree artifact, not a code defect. GitHub Actions `build` is authoritative.
- Do NOT merge, deploy, or push anything to Amazon.
- PO ruling 2026-08-23: parent titles carry the FAMILY THEME, never an individual design's name.
- PO ruling 2026-08-23: truth outranks the 70-75 band. More short titles is the accepted cost.

---

### Task 1: Broadcast exit rejects every per-design name

**Files:**
- Modify: `src/lib/fba/listingPipeline.ts` — `familyDesignNames` (~:9129) and `broadcastTruthCtx` (~:9164)
- Test: Create `src/lib/fba/broadcastForeignNames.test.ts`

**Interfaces:**
- Consumes: `buildForeignDesignTokens(designs, opts)` and `designScopeTokens(s: string): string[]` from `src/lib/fba/designScope.ts`; `verdictForAssembledTitle(title, ctx)` from `titleBand.ts`.
- Produces: `broadcastForeignTokens: ReadonlySet<string>` and `broadcastProtectHay: string` in `listingPipeline.ts`, consumed by Task 3.

**Background.** `AssembledTitleCtx.foreignTokens` is documented *"per-child exits only"*. The broadcast exit passes `undefined`, so a sibling design name is unrejectable there. Live defect on `2552090`: `THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt for Men`.

**The precedence trap (spec §3.2).** `broadcastTruthCtx.designTokens` is `familyDesignNames`, assembled from `designName`, `input.designNameOverride`, every value of `input.designNameOverridesByKey`, and every prior per-child `designName` — the SAME set you are about to make foreign. Without an explicit winner a name is both protected and rejected. Resolution, mandatory:

1. On the broadcast exit, `foreignTokens` WINS over `protect`.
2. Broadcast `protect`/`designTokens` narrows to the family theme = `familyDesignNames` MINUS the union of `designNameOverridesByKey` values and per-child `designName`s.
3. If that subtraction leaves nothing, the parent carries no design vocabulary. It must NOT fall back to permitting a design name.

If you cannot cleanly separate "family theme" from "per-design name" here, STOP and report that rather than guessing. That separation is the whole of the PO's ruling.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/fba/broadcastForeignNames.test.ts
import { describe, it, expect } from 'vitest'
import { verdictForAssembledTitle } from './titleBand'
import { buildPhraseTruthCtx } from './contentTruth'

const sweatFacts = {
  apparelProduct: true,
  garmentFamily: 'sweatshirt' as const,
  familyGarmentFamilies: ['sweatshirt' as const],
  spec: { fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight fleece' },
  allowedBrand: null,
  designTokens: ['Motivational Entrepreneur'],
  audienceLean: 'lean_male',
}

describe('broadcast exit rejects sibling design names', () => {
  it('rejects the live regression string carrying a per-design name', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt for Men',
      { truth, protect: 'Motivational Entrepreneur', foreignTokens: new Set(['business', 'btch']) },
    )
    expect(v.ok).toBe(false)
  })

  it('keeps the family theme on the broadcast title', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur | Long Sleeve Pullover Fall Crewneck',
      { truth, protect: 'Motivational Entrepreneur', foreignTokens: new Set(['business', 'btch']) },
    )
    expect(v.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --no-cache src/lib/fba/broadcastForeignNames.test.ts`
Expected: the first test FAILS — `v.ok` is `true`, because nothing rejects the sibling name today.

- [ ] **Step 3: Build the broadcast foreign set in listingPipeline.ts**

Beside the existing `familyDesignNames` (~:9129), add:

```ts
/* BROADCAST FOREIGN NAMES (PO 2026-08-23, live B0DSCDZC6K: "Business B*tch" refilled into the
 * PARENT title). A parent speaks for EVERY child, so no individual design's name may lead it —
 * PO ruling: family theme only. `foreignTokens` WINS over `protect` here; see
 * handoff/TITLE_ADMISSION_IS_VERIFICATION.md §3.2. */
const perDesignNames: string[] = [
  ...Object.values(input.designNameOverridesByKey ?? {}),
  ...(input.priorPerChildTitles ?? []).map((t) => t.designName ?? ''),
].map((v) => (v ?? '').trim()).filter(Boolean)

const broadcastForeignTokens: ReadonlySet<string> = new Set(
  perDesignNames.flatMap((n) => designScopeTokens(n)),
)

/** The FAMILY THEME: what survives after every per-design name is subtracted. MAY BE EMPTY — a
 *  parent with no design vocabulary is the correct outcome, never a fallback to permitting one. */
const broadcastThemeNames: string[] = familyDesignNames.filter(
  (n) => !perDesignNames.some((d) => d.toLowerCase() === n.toLowerCase()),
)
const broadcastProtectHay = broadcastThemeNames.join(' ')
```

Change `broadcastTruthCtx`'s `designTokens` from `familyDesignNames` to `broadcastThemeNames`, and thread `broadcastForeignTokens` / `broadcastProtectHay` into the broadcast `bandScope` and the broadcast `settleTitle` call (the same slots the per-child exits already use for their own foreign set).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --no-cache src/lib/fba/broadcastForeignNames.test.ts`
Expected: both PASS.

- [ ] **Step 5: Verify per-child exits are untouched**

Run: `npx vitest run --no-cache src/lib/fba/dominantGarmentAndCrossSegmentDedupe.test.ts src/lib/fba/truthBandGate.test.ts`
Expected: PASS. A genuine "Business B*tch" CHILD must still keep its own name.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fba/listingPipeline.ts src/lib/fba/broadcastForeignNames.test.ts
git commit -m "fix(title): broadcast exit rejects every per-design name (PO 2026-08-23)"
```

---

### Task 2: Unspec'd attribute claims become a verdict reason

**Files:**
- Modify: `src/lib/fba/titleBand.ts` — `verdictForAssembledTitle` and the `AssembledTitleVerdict` reason union
- Test: Create `src/lib/fba/unspecdAttributeClaim.test.ts`

**Interfaces:**
- Consumes: `scrubUnspecdGarmentClaims(title: string, spec: { fit?: string | null; weightNote?: string | null } | null | undefined): { title: string; removed: string[] }` at `titleBand.ts:560`.
- Produces: reason `'unspecd-attribute-claim'` on `AssembledTitleVerdict`, consumed by Task 3.

**Background.** `scrubUnspecdGarmentClaims` is `settleTitle` stage C3 and runs BEFORE the pad (C5-C9). It deletes an unspec'd claim; the pad re-adds it from the pool. Live defect on `2552090`: `THE CEO Don't Quit Motivational T-Shirt Tee Shirt | Oversized Graphic Tees` — Gildan 64000B is Classic fit, so "Oversized" is a claim the blank does not support. As a VERDICT reason the candidate becomes inadmissible rather than deleted-then-restored.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/fba/unspecdAttributeClaim.test.ts
import { describe, it, expect } from 'vitest'
import { verdictForAssembledTitle } from './titleBand'
import { buildPhraseTruthCtx } from './contentTruth'

const kidsFacts = {
  apparelProduct: true,
  garmentFamily: 'kids_tee' as const,
  familyGarmentFamilies: ['kids_tee' as const],
  spec: { fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight ring spun' },
  allowedBrand: null,
  designTokens: ["Don't Quit"],
  audienceLean: 'unisex',
}

describe('unspecd attribute claims are inadmissible, not merely stage-deleted', () => {
  it('rejects "Oversized" when the blank states Classic fit', () => {
    const truth = buildPhraseTruthCtx(kidsFacts, 'title')
    const v = verdictForAssembledTitle(
      "THE CEO Don't Quit Kids Tee | Oversized Graphic Tees",
      { truth, protect: "Don't Quit" },
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('unspecd-attribute-claim')
  })

  it('permits a fit the blank DOES state', () => {
    const truth = buildPhraseTruthCtx(
      { ...kidsFacts, spec: { ...kidsFacts.spec, fit: 'Oversized' } }, 'title')
    const v = verdictForAssembledTitle(
      "THE CEO Don't Quit Kids Tee | Oversized Graphic Tees",
      { truth, protect: "Don't Quit" },
    )
    expect(v.reason).not.toBe('unspecd-attribute-claim')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --no-cache src/lib/fba/unspecdAttributeClaim.test.ts`
Expected: the first test FAILS — today the verdict returns `{ ok: true }`.

- [ ] **Step 3: Add the check to verdictForAssembledTitle**

Inside the existing `if (ctx.truth) { ... }` block, after the `garmentGroupsIn(t).size > 1` check and before the youth-marker check:

```ts
    /* UNSPEC'D ATTRIBUTE CLAIM (PO 2026-08-23). `scrubUnspecdGarmentClaims` owned this rule as a
     * pipeline STAGE running BEFORE the pad, so the pad re-added from the pool exactly what the
     * stage removed ("Oversized" on a Classic-fit Gildan 64000B, live 2026-08-23). Expressed HERE
     * it is inadmissible, not merely deleted. Idempotence IS the probe, exactly as the truth net
     * above: a title that scrub would still edit carries a claim the blank does not support. */
    const scrubbed = scrubUnspecdGarmentClaims(t, ctx.truth.spec ?? null)
    if (scrubbed.title !== t) return { ok: false, reason: 'unspecd-attribute-claim' }
```

Add `'unspecd-attribute-claim'` to the `AssembledTitleVerdict` reason union.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --no-cache src/lib/fba/unspecdAttributeClaim.test.ts`
Expected: both PASS.

- [ ] **Step 5: Full suite — this check is global, watch for over-tightening**

Run: `npx vitest run --no-cache`
Expected: 1662 passed + 4 expected-fail, plus your new tests. If existing title fixtures now fail, they assert titles carrying unspec'd claims — inspect each. If a fixture is genuinely wrong, fix it and say so in the report. If the new check is over-broad, narrow it. Do NOT weaken the rule to make a stale fixture pass without stating why.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fba/titleBand.ts src/lib/fba/unspecdAttributeClaim.test.ts
git commit -m "fix(title): unspecd attribute claims are inadmissible, not stage-deleted"
```

---

### Task 3: enforceTitleBand verifies what it accepts

**Files:**
- Modify: `src/lib/fba/titleBand.ts` — `enforceTitleBand`'s accept loop (~:1104-1116) and its `settleTitle` call site
- Test: Create `src/lib/fba/padAdmissionIsVerification.test.ts`

**Interfaces:**
- Consumes: `verdictForAssembledTitle` (extended by Task 2); the broadcast plumbing from Task 1.
- Produces: nothing new — this closes the loop.

**Background — this is the heart of the plan.** `settleTruthBand`'s DFS already verifies every candidate, and since PR #643 its in-band fast path does too. But `enforceTitleBand` is a SECOND pad whose own comment reads *"The pad is deliberately UNCONSTRAINED here: its job is to reach the band from product facts."* It accepts on LENGTH ALONE:

```ts
if (cand.length >= TITLE_BAND_LO) {
  return { title: cand, notes: [...], decision: 'padded' }   // no verify
}
if (cand.length > best.length) best = cand                    // no verify
```

That is the last writer in the door accepting something it has not verified. `enforceTitleBand` has no `AssembledTitleCtx` today — thread one through as an OPTIONAL third argument so existing callers keep working; when absent, behaviour is byte-identical to today (fail-open, matching every other truth-ctx consumer in this file).

- [ ] **Step 1: Write the failing test**

Read the real `TitleBandCtx` interface at the top of `titleBand.ts` and supply exactly its required fields — prefer a real object over a cast.

```ts
// src/lib/fba/padAdmissionIsVerification.test.ts
import { describe, it, expect } from 'vitest'
import { enforceTitleBand } from './titleBand'
import { buildPhraseTruthCtx } from './contentTruth'

const spec = { fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight fleece' }
const sweatFacts = {
  apparelProduct: true,
  garmentFamily: 'sweatshirt' as const,
  familyGarmentFamilies: ['sweatshirt' as const],
  spec,
  allowedBrand: null,
  designTokens: ['Motivational Entrepreneur'],
  audienceLean: 'lean_male',
}

describe('enforceTitleBand may not accept a candidate the verifier rejects', () => {
  it('skips a pool phrase carrying a sibling design name even when it lands in band', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const out = enforceTitleBand(
      'THE CEO Motivational Entrepreneur',
      {
        apparel: true,
        spec,
        factSegments: [],
        poolSegments: ['Business B*tch Sweatshirt for Men', 'Long Sleeve Pullover Fall Crewneck'],
        truthOk: () => true,
      },
      { truth, protect: 'Motivational Entrepreneur', foreignTokens: new Set(['business', 'btch']) },
    )
    expect(out.title).not.toMatch(/Business/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --no-cache src/lib/fba/padAdmissionIsVerification.test.ts`
Expected: FAIL — the sibling-name pool phrase is accepted on length alone.

- [ ] **Step 3: Thread the verify ctx and consult it at both accept points**

```ts
export function enforceTitleBand(
  title: string,
  ctx: TitleBandCtx,
  /** ADMISSION IS VERIFICATION (PO 2026-08-23). Absent ⇒ length-only accept, byte-identical to the
   *  pre-2026-08-23 behaviour — the same fail-open every truth-ctx consumer in this file takes. */
  verify?: AssembledTitleCtx,
)
```

Inside the candidate loop:

```ts
    if (cand.length > TITLE_BAND_HI) continue
    // ADMISSION IS VERIFICATION: a candidate the exit predicate would reject is not a candidate.
    if (verify && !verdictForAssembledTitle(cand, verify).ok) continue
    if (cand.length >= TITLE_BAND_LO) {
      return { title: cand, notes: [`band net: +"${seg}" → ${cand.length} chars`], decision: 'padded' }
    }
    if (cand.length > best.length) best = cand
```

Then update `settleTitle` to pass its already-bound verify ctx into this call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --no-cache src/lib/fba/padAdmissionIsVerification.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite plus the source-level pin**

Run: `npx vitest run --no-cache`
Expected: zero regressions against the 1662 baseline. `truthBandGate.test.ts`'s "nothing writes after verification" pin MUST still pass.

- [ ] **Step 6: Run the offline harness under production flags**

Run: `TITLE_V4=on GARMENT_NOUN=on TITLE_MONEY_TAIL=on TITLE_SHAPE_JUDGE=on npx tsx src/lib/fba/truthBandHarness.ts`

Record all seven decisions and the band distribution. Expect MORE holds / under-band titles than baseline — that is the approved trade, not a regression. A mass collapse to under 60 chars IS a regression. Report the numbers either way.

- [ ] **Step 7: Commit and open the PR**

```bash
git add src/lib/fba/titleBand.ts src/lib/fba/padAdmissionIsVerification.test.ts
git commit -m "fix(title): enforceTitleBand verifies what it accepts - the last unverified writer"
gh pr create --title "fix(title): admission IS verification - one predicate governs pad and net" --body "Implements handoff/TITLE_ADMISSION_IS_VERIFICATION.md (PO approach A, 2026-08-23)."
```

- [ ] **Step 8: Wait for real CI**

Run: `gh pr checks <N>`
Report the ACTUAL result. Do not claim green without the output.

---

### Task 4: Retire the pad's duplicate gates (prove-then-delete)

**Files:**
- Modify: `src/lib/fba/titleBand.ts` — the `push()` closure inside `candidateSegments` (~:274-299)
- Test: Reuse `src/lib/fba/padAdmissionIsVerification.test.ts` (Task 3) — add cases there

**Interfaces:**
- Consumes: `verdictForAssembledTitle` with the Task 2 extension.
- Produces: nothing. This task only REMOVES code.

**Why this task exists.** Approach A's whole value is collapsing two rulebooks into one. Tasks 1-3 make the verifier authoritative; this task removes what it now duplicates. Leaving both means the eleventh rule gets added to one and not the other — the exact drift that produced nine PRs on 2026-08-23.

**The guard (spec §6, mandatory).** Each gate may be deleted ONLY after you demonstrate the verifier already rejects what it rejected. For each candidate gate below, write a test asserting `verdictForAssembledTitle` returns `ok: false` for a title the gate would have blocked. If the verifier does NOT reject it, the gate STAYS and you report that — a silent behaviour loss here is worse than a duplicated rule.

Gates in scope, and their expected owners:

| Pad gate (`candidateSegments`) | Expected owner in the verifier |
|---|---|
| `committedClass` / `dominantGarmentGroup` one-class skip | `garmentGroupsIn(t).size > 1` → `two-garment-classes` |
| `conceptIsNew` | `titleHasDuplicateConcept` → `duplicate-concept` |

Gates that STAY, and must not be touched (they are preference, not correctness — skipping them only costs a wasted verify):
- `alreadyStates` — dedup
- `isTitleWasteVocabulary` — the PO's title-vocabulary ruling
- `ctx.truthOk` — cheap per-phrase pre-filter ahead of the expensive whole-string verify

- [ ] **Step 1: Write the proof tests**

Add to `src/lib/fba/padAdmissionIsVerification.test.ts`:

```ts
describe('the verifier already owns what the pad gates duplicate', () => {
  it('rejects a second garment class (the one-class pad gate)', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur Sweatshirt | Long Sleeve Hoodie Tee',
      { truth, protect: 'Motivational Entrepreneur' },
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('two-garment-classes')
  })

  it('rejects a concept restated in two spellings (the conceptIsNew pad gate)', () => {
    const truth = buildPhraseTruthCtx(sweatFacts, 'title')
    const v = verdictForAssembledTitle(
      'THE CEO Motivational Entrepreneur Crewneck | Long Sleeve Crew Neck Pullover',
      { truth, protect: 'Motivational Entrepreneur' },
    )
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('duplicate-concept')
  })
})
```

- [ ] **Step 2: Run the proof tests**

Run: `npx vitest run --no-cache src/lib/fba/padAdmissionIsVerification.test.ts`
Expected: BOTH PASS **before** you delete anything. If either fails, that gate is NOT duplicated — STOP, keep the gate, and report which one and why.

- [ ] **Step 3: Delete only the proven-redundant gates**

Remove from `push()` in `candidateSegments`:

```ts
    if (committedClass) {
      const segClass = dominantGarmentGroup(s)
      if (segClass && segClass !== committedClass) return
    }
    if (!conceptIsNew(title, s)) return
```

Remove the now-unused `committedClass` binding and any import made unused BY YOUR CHANGE only. Do not remove pre-existing dead code.

- [ ] **Step 4: Full suite**

Run: `npx vitest run --no-cache`
Expected: zero regressions against the 1662 baseline. If a title fixture changes, the verifier's rejection differs from the gate's in some case — investigate rather than update the fixture.

- [ ] **Step 5: Re-run the harness and compare to Task 3 step 6**

Run: `TITLE_V4=on GARMENT_NOUN=on TITLE_MONEY_TAIL=on TITLE_SHAPE_JUDGE=on npx tsx src/lib/fba/truthBandHarness.ts`
Expected: the seven decisions should be IDENTICAL to Task 3 step 6. If any differ, the gates were not equivalent — report the diff.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fba/titleBand.ts src/lib/fba/padAdmissionIsVerification.test.ts
git commit -m "refactor(title): retire pad gates the verifier now owns"
```

---

### Task 5: Report for the live gate

**Files:** none — reporting only.

- [ ] **Step 1: Assemble the report**

Report with real output for every number:
- PR URL and the actual `gh pr checks` result
- Files changed
- Vitest baseline on `main` AND after, both from `--no-cache` runs
- The seven harness decisions under production flags, plus band distribution before/after
- Before/after for BOTH live specimen strings in spec §4
- Any layer objection formed while reading the code, and anything you could NOT cleanly separate — especially the family-theme vs per-design-name split in Task 1

- [ ] **Step 2: STOP**

Do NOT merge. Do NOT deploy. The live gate is a `regenerate_section:'title'` POST on B0DSCDZC6K and B0DP5H8QBT with decisions read from the Coolify runtime logs, run by the dispatcher — not from a harness, which reported green three times on 2026-08-23 while production shipped lies.
