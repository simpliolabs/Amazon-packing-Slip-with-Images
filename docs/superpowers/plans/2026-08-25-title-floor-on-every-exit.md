# Title Floor On Every Exit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for a title to persist under the band, regardless of which exit produced it.

**Architecture:** Two changes, both closing gaps the exit-enumeration audit proved. (1) `settleTruthBand` has FOUR ship points; only one ever had a floor. Put it on all four. (2) `shipCensus` already MEASURES `TITLE_UNDER_BAND` on the exact persisting bytes, but the enforcement block marks only `backend_keywords` and `description` — the title mark was never written. Wire it.

**Tech Stack:** TypeScript, Next.js 15, Vitest, pnpm. No new dependencies.

**Spec:** the exit-enumeration audit (this session). Key confirmed facts are inlined per task — no external spec file is required.

## Global Constraints

- Branch from `main` at `5efa6c2`. Worktree at `C:\Users\Admin\AppData\Local\Temp\fba-wt-floorexits`.
- **NO new definition of truth.** Reuse `verdictForAssembledTitle`, the existing `TITLE_BAND_LO`/`TITLE_BAND_HI` from `contentContract.ts`, and the existing `shipCensus` measurement. A second predicate or a new band constant is a REJECTED change.
- **KARPATHY — surgical.** This plan REMOVES a gap; it does not add features. Every changed line must trace to a confirmed audit finding. No drive-by refactoring, no "while I'm here".
- **KARPATHY — simplicity.** If a task can be done by wiring an existing measurement instead of writing new logic, wire it. Prefer the smallest diff that closes the gap.
- Vitest baseline on `main` @ `5efa6c2`: run it FIRST and report the number. Zero regressions.
- CI trap: `.github/workflows/build.yml` sets PLACEHOLDER Supabase env → lazy clients make real ~4s network calls and time out. Null those env vars per test file and RESTORE in `afterAll`.
- **EVERY test must assert LENGTH, not only content.** Three live failures (29c, 42c, and a ratchet) all passed content-only acceptance. This is the single most important constraint in this plan.
- Do NOT merge, deploy, or push to Amazon. Push the branch, open a PR, wait for real CI via `gh pr checks <N>`, report the ACTUAL result.
- A local `next build` inside a worktree fails with a Turbopack symlink error — worktree artifact, not a code defect.

## Background — why three fixes failed (do not re-derive)

PR #646 shipped a 29-char parent. PR #647 added `TITLE_TRUTHFUL_SHIP_FLOOR = 65` and shipped a **42-char** parent anyway — the constant WAS in the deployed bytes. Both reverted. The audit found why: `settleTruthBand` has four ship points and #647 guarded one.

```
titleBand.ts:1503  done(prior, 'refused-kept-prior', …)     ← no floor, never had one
titleBand.ts:1513  done(best,  'shipped-truthful-under-band')← #647 guarded THIS one only
titleBand.ts:1518  done(best,  'unreachable-no-prior', …)   ← no floor, never had one
titleBand.ts:1522  done(best,  'unreachable-no-prior', …)   ← no floor, never had one
```

Separately, `listingPipeline.ts:9620-9621` marks `KEYWORDS_BELOW_FLOOR` and `DESC_UNDER_FLOOR` — and there is **no `mark('TITLE_UNDER_BAND', 'title')` anywhere in the repo**, though `shipCensus.ts:91` computes exactly that on the persisting bytes.

---

### Task 1: The floor guards ALL FOUR ship points

**Files:**
- Modify: `src/lib/fba/titleBand.ts` (`settleTruthBand`, the four `done(...)` ship points ~:1503, :1513, :1518, :1522)
- Test: Create `src/lib/fba/titleFloorEveryExit.test.ts`

**Interfaces:**
- Consumes: `TITLE_BAND_LO` / `TITLE_BAND_HI` (`titleBand.ts:42-43`, from `contentContract.ts`), `verdictForAssembledTitle`.
- Produces: a named floor constant exported from `titleBand.ts`, consumed by Task 2.

**Design call, and your invitation to reject it.** ROOT CAUSE: the floor was attached to a *decision branch* rather than to the *act of shipping*. That is why guarding one branch left three open. The right layer is therefore the single place every branch funnels through — `done(...)` itself, or one guard immediately before each return, whichever the code makes cleaner and provably total. **A per-branch guard repeated four times is the shape that just failed; prefer one choke point.** If reading the code shows `done()` cannot host the guard (e.g. it is used for non-ship outcomes too), say so and place it at the narrowest total alternative — but report which you chose and why.

**Floor value:** PO ruling 2026-08-24 — shippable range is **65-75**. Below 65, hold and keep the prior. If the prior is ALSO below 65 or absent, prefer the longest TRUE option available and record the decision; never emit empty (an empty title ratchets: it becomes the next run's `priorTitle`).

- [ ] **Step 1: Write failing tests — one per ship point**

Four tests, each driving `settleTruthBand` to a specific decision with a sub-65 result, asserting it does NOT ship:

```ts
// src/lib/fba/titleFloorEveryExit.test.ts
import { describe, it, expect } from 'vitest'
import { settleTruthBand, TITLE_BAND_LO } from './titleBand'

// Assert BOTH the decision AND the length — content-only assertions let three
// live failures through (29c, 42c, and a ratchet).
const expectNoSubFloorShip = (r: { title: string; decision: string }) => {
  if (r.title) expect(r.title.length).toBeGreaterThanOrEqual(65)
}

describe('the floor guards every ship point, not just one', () => {
  it('refused-kept-prior: a sub-65 prior is not shipped', () => { /* drive :1503 */ })
  it('shipped-truthful-under-band: a sub-65 best is not shipped', () => { /* drive :1513 */ })
  it('unreachable-no-prior (first): a sub-65 best is not shipped', () => { /* drive :1518 */ })
  it('unreachable-no-prior (second): a sub-65 best is not shipped', () => { /* drive :1522 */ })
})
```

Fill each body by reading `settleTruthBand` and constructing the ctx that reaches that exact branch. **Report which inputs reach which branch** — if a branch proves unreachable, say so rather than forcing it.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --no-cache src/lib/fba/titleFloorEveryExit.test.ts`
Expected: at least three FAIL (the unguarded branches). Report the real output. If all four pass pre-fix, the diagnosis is wrong — STOP and report.

- [ ] **Step 3: Implement the single choke point**

Place the guard so no `settleTruthBand` return can emit a sub-floor non-empty title. Never emit `''`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --no-cache src/lib/fba/titleFloorEveryExit.test.ts` → all PASS.

- [ ] **Step 5: Full suite + harness**

Run: `npx vitest run --no-cache` → zero regressions vs the baseline you measured.
Run: `TITLE_V4=on GARMENT_NOUN=on TITLE_MONEY_TAIL=on TITLE_SHAPE_JUDGE=on npx tsx src/lib/fba/truthBandHarness.ts`
Report all seven decisions **with character counts**. More holds is the approved trade. Anything below 65 shipping is a FAILURE.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fba/titleBand.ts src/lib/fba/titleFloorEveryExit.test.ts
git commit -m "fix(title): the band floor guards every ship point, not one"
```

---

### Task 2: Wire the census enforcement mark for title

**Files:**
- Modify: `src/lib/fba/listingPipeline.ts` (the enforcement block at ~:9620-9621)
- Test: Create `src/lib/fba/titleCensusEnforcement.test.ts`

**Interfaces:**
- Consumes: `shipCensus` (`src/lib/fba/shipCensus.ts:91` computes `TITLE_UNDER_BAND` on the persisting bytes), the `mark(...)` helper already used for the other two fields, and Task 1's floor constant.

**Design call.** ROOT CAUSE: the census already measures the truth about every persisting title — the number existed the whole time — but the enforcement block covers `backend_keywords` and `description` and simply omits `title`. This is not new logic; it is one missing wire. **KARPATHY-simplicity: do not write a new check. Wire the existing measurement.** If you find yourself adding a length computation, stop — `shipCensus` already has it.

**PUSH BACK** if the census's `TITLE_UNDER_BAND` is gated on something that makes it unusable here (e.g. `input.apparel`, which the audit flagged) — report that rather than working around it.

- [ ] **Step 1: Write the failing test**

Assert that a pipeline result whose persisting title is under band produces a title mark / degraded-section entry, exactly as backend and description already do. Model it on however the existing `KEYWORDS_BELOW_FLOOR` behaviour is tested, if such a test exists — reuse the pattern rather than inventing one.

- [ ] **Step 2: Run to verify it fails**

Report the real output.

- [ ] **Step 3: Add the one line (plus whatever it legitimately needs)**

```ts
mark('TITLE_UNDER_BAND', 'title')
```
beside the existing two marks, with the same gating discipline they use.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Full suite**

Run: `npx vitest run --no-cache` → zero regressions. **Expect some existing fixtures to newly report a degraded title** — that is the guard working. For each, decide: is the fixture asserting a genuinely under-band title (fix the fixture, report it) or is the mark over-firing (narrow it)? Do NOT weaken the mark to keep a stale fixture green without saying so.

- [ ] **Step 6: Commit, push, open PR, wait for real CI**

```bash
git add src/lib/fba/listingPipeline.ts src/lib/fba/titleCensusEnforcement.test.ts
git commit -m "fix(title): census enforces TITLE_UNDER_BAND, which it already measured"
gh pr create --title "fix(title): floor on every exit + census enforces TITLE_UNDER_BAND" --body "Closes the gaps the exit-enumeration audit proved: settleTruthBand had FOUR ship points and only one carried a floor; shipCensus measured TITLE_UNDER_BAND but nothing marked it."
```

Then `gh pr checks <N>` and report the ACTUAL result.

---

### Task 3: Report for the live gate

**Files:** none — reporting only.

- [ ] **Step 1: Assemble the report**

- PR URL and the real `gh pr checks` result
- Baseline and final vitest numbers, both from `--no-cache`
- Which inputs reached which of the four ship points (and any branch found unreachable)
- The seven harness decisions **with character counts**
- Every fixture you touched in Task 2 step 5 and why
- Any layer objection you formed

- [ ] **Step 2: STOP**

Do NOT merge, deploy, or push to Amazon. The live gate is run by the dispatcher: a regen on B0DSCDZC6K and B0DP5H8QBT through **BOTH** the full path and `regenerate_section:'title'`, with **parent character count as an explicit acceptance criterion**, read from the Coolify runtime logs.
