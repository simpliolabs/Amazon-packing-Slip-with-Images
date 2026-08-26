# Re-land PR #649 + pad cross-gender veto — report

## Status: code DONE and pushed, PR open and mergeable; GitHub Actions CI has NOT run (see below)

## CI status (the real, verified result — not fabricated)

PR: https://github.com/simpliolabs/Amazon-packing-Slip-with-Images/pull/651

`gh pr checks 651` → `no checks reported on the 'fix/parent-judge-plus-gender-veto' branch`, both
immediately after opening the PR and again ~16 minutes later after a forced re-trigger (empty
commit `56a9476`, pushed ~10 min after the PR was opened). Verified directly against the GitHub API,
not just the `gh` CLI wrapper:
- `GET .../actions/runs?branch=fix/parent-judge-plus-gender-veto` → empty array, both before and
  after the re-trigger push.
- `GET .../commits/<head_sha>/check-suites` → only a **Netlify** check-suite (`status: queued`,
  unrelated preview-deploy integration), **zero** check-suite from the "Build" GitHub Actions
  workflow, for both commits (`5351923` and `56a9476`).
- The "Build" workflow (`.github/workflows/build.yml`, id 288798087) is `state: active`; repo Actions
  permissions are `enabled: true, allowed_actions: all`; the last successful `pull_request`-triggered
  Build run in this repo before mine was over an hour earlier (14:02 UTC, a different branch) — no
  `pull_request` Build run has fired for ANY branch since, mine included, despite the workflow being
  live and `push`-triggered runs on `main` still completing in the same window (one such run at
  15:22 UTC finished with `conclusion: failure`, unrelated to this PR — it was already-merged `main`
  content, not my branch).

This reads as a transient GitHub-side (Actions-trigger or webhook) issue affecting `pull_request`
events on this repo today, not a defect in the pushed commits — I could not diagnose further without
repo-admin access to webhook deliveries, and did not attempt anything destructive (no force-push, no
merge, no workflow-permission changes) to work around it. **I did not fabricate a CI result.**
`gh pr checks 651` should be re-run later to get the real number; as of this report it has not run.

As a substitute (not equivalent) local signal: `npx tsc --noEmit` and the full `npx vitest run
--no-cache` suite (87 files / 1694 passed + 4 expected fail / 1698, zero failures) were run directly
in the worktree and are reported above under Test numbers. A local `next build` attempt was also
tried but is **not a valid signal** — it failed only because of a `node_modules` Windows Junction
this session created (pointing at `/tmp/fba-portal/node_modules` to skip a slow reinstall), which
Turbopack refuses to resolve through ("Symlink points out of the filesystem root"). This is an
artifact of my local dependency-sharing shortcut, gitignored and never committed, and does not
reflect the real CI's fresh `pnpm install --frozen-lockfile` + `next build`, which uses no symlink.

## What shipped

1. **Recovered PR #649** (`fce9be7`) via `git revert --no-commit 1bf75ed` (revert-of-the-revert) —
   clean auto-merge against `main`'s current HEAD (`5bc44aa`, PR #650), zero conflicts. Commit:
   `3ad7424` — "Reapply "fix(title): give the multi-design parent title the same reject-and-retry
   validateTitle already gives the single-design one (#649)"". Diff is byte-identical to `fce9be7`'s
   own diff (270 insertions, 4 deletions, same two files) — nothing rewritten.
2. **Extended the existing cross-gender veto to the pad.** `enforceMoneyTail`'s cross-gender check
   (four `if` blocks) was extracted into two shared functions, `crossGenderLeanVeto` and
   `crossGenderTailVeto`, in `titleBand.ts`. `enforceMoneyTail` now calls them (byte-identical
   behavior, confirmed by the full pre-existing test suite). `candidateSegments` (the pad's candidate
   admission gate) now calls the SAME two functions. No second regex pair, no second gender rulebook.
   Commit: `1900aeb` — "fix(title): extend the existing cross-gender veto to the pad's candidate
   admission (PR #649 follow-up)". Actual SHA: `4b88683` (confirmed via `git log` after commit —
   corrected here from a placeholder written before the commit existed).

## Correction to the brief

The brief named `LEAN_FEM_RE`/`LEAN_MASC_RE` (`contentTruth.ts:213-214`) as the regexes to reuse.
**That pair is not what `enforceMoneyTail`'s cross-gender veto uses.** `contentTruth.ts`'s
`LEAN_FEM_RE`/`LEAN_MASC_RE` back a *different* rule (`foreignAudienceHits`, the forced-audience/
kids-vs-adult check). The veto actually cited in the brief (titleBand.ts, then-lines 915-916 /
952-953) runs on `MONEY_FEM_RE`/`MONEY_MASC_RE`, defined locally in `titleBand.ts` (then-lines
854-855: `/\bwom[ae]ns?\b|\bladies\b/i` and `/\bm[ae]ns?\b/i`) — a third, separately-maintained
regex pair from a fourth one (`FEM_RE`/`MASC_RE` at `listingPipeline.ts:8751-8752`, used for
boost/demote scoring, not this veto) and a fifth near-duplicate (`MT_FEM`/`MT_MASC` at
`listingPipeline.ts:8930`, a pre-filter on money-tail candidates before they even reach
`enforceMoneyTail`). I followed the code, not the brief's line numbers: the fix reuses
`MONEY_FEM_RE`/`MONEY_MASC_RE` (the ones `enforceMoneyTail` itself runs on), not `LEAN_FEM_RE`/
`LEAN_MASC_RE`. The brief's diagnosis of the DEFECT (candidateSegments has zero gender checks) was
exactly right; only the regex-pair citation was wrong. Flagging per "my briefs have been wrong nine
times" — this is a tenth, now corrected, and not touched (no new/fifth regex pair added).

`candidateSegments` also lives in `titleBand.ts`, not `listingPipeline.ts` as the brief's "What to
build" section implied — confirmed by grep before editing.

## Reproduction (RED, before the fix)

Added to `titleBand.test.ts`, run with `npx vitest run src/lib/fba/titleBand.test.ts -t
"CROSS-GENDER VETO"` against the code with #649 recovered but the veto NOT yet extended:

```
❯ src/lib/fba/titleBand.test.ts (84 tests | 2 failed | 79 skipped)
 FAIL  ... REPRODUCTION: a lean_male family with only a "For Women" pool phrase available pads
       WITHOUT it — the exact live B0.. collapse ("Pullover Sweatshirts For Women" on a lean_male
       family)
AssertionError: expected 'the ceo hustle definiton sweatshirt |…' not to contain 'for women'
Expected: "for women"
Received: "the ceo hustle definiton sweatshirt | pullover sweatshirts for women"

 FAIL  ... REPRODUCTION: a lean_male family whose title ALREADY carries "for Men" must never pad
       into the self-contradictory "For Women for Men" — the second live shipped string
AssertionError: expected 'THE CEO Dont Quit Sweatshirt | Pullov…' not to contain 'Pullover
       Sweatshirts For Women for Men'
Expected: "Pullover Sweatshirts For Women for Men"
Received: "THE CEO Dont Quit Sweatshirt | Pullover Sweatshirts For Women for Men"

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed | 79 skipped (84)
```

Both failures reproduce the exact live shipped defects verbatim. After the fix: all 84 tests in the
file pass (2 reproductions flip to GREEN, 3 regression guards — agrees-with-lean, unisex fail-open,
absent-`lean` fail-open — pass unchanged).

## Test numbers

| Stage | Files | Passed | Expected-fail | Total |
|---|---|---|---|---|
| Baseline (`main`, before any change) | 86 | 1685 | 4 | 1689 |
| After recovering #649 only | 87 | 1689 | 4 | 1693 |
| Final (recovery + gender veto + 5 new tests) | 87 | 1694 | 4 | 1698 |

Zero regressions at every stage. `npx tsc --noEmit` clean at baseline and after the final change (no
output either run).

## Harness — all seven decisions, with lengths

`TITLE_V4=on GARMENT_NOUN=on TITLE_MONEY_TAIL=on TITLE_SHAPE_JUDGE=on npx tsx
src/lib/fba/truthBandHarness.ts`, fixture B0DSCDZC6K (band 70-75):

| Scope | Shipped title | Len | Decision |
|---|---|---|---|
| broadcast | THE CEO Motivational Entrepreneur \| Long Sleeve Pullover Fall Crewneck | 70 | refilled |
| BB (Business B*tch) | THE CEO Business B*tch Graphic Casual \| Long Sleeve Pullover Fall Crewneck | 74 | refilled |
| BCS (Billionare Coming Soon) | THE CEO Billionare Coming Soon Sweatshirt \| Long Sleeve Pullover Crewneck | 73 | refilled |
| DQ (Don't Quit) | THE CEO Don't Quit Sweatshirt \| Long Sleeve Pullover Crewneck Gift Set | 70 | refused-kept-prior [HOLD] |
| ED (Entrepreneur Definition) | THE CEO Entrepreneur Definition Sweatshirt \| Graphic Sweatshirts Pullover | 73 | refilled |
| HD (Hustle Definiton) | THE CEO Hustle Definiton Sweatshirt \| Long Sleeve Pullover Fall Crewneck | 72 | refilled |
| MH (Mother Hustler) | THE CEO Mother Hustler Hoodie \| Long Sleeve Hooded Sweatshirt Cozy Gift | 71 | refused-kept-prior [HOLD] |

**ALL 7 TITLES IN BAND 70-75** (harness's own summary line). Byte-identical to what
`truthBandGate.test.ts` pins — that test file is in the suite and passed (1694/1698), so this is a
confirmed no-diff, not an unchecked assumption.

**This run is BLIND to the gender-veto fix**, and I'm saying so per the brief's own warning. The
B0DSCDZC6K fixture is hard-coded `audience_lean='unisex'` (see the harness file's own header
comment) — `crossGenderLeanVeto` never fires on `unisex` by design (fail-open, matching
`enforceMoneyTail`'s existing rule), so this harness run cannot exercise the lean half of the fix at
all. The tail half (`crossGenderTailVeto`) is lean-independent and DID run against this fixture's
real pool candidates on every scope above; the identical pinned output proves it changed nothing for
this family (no candidate in this pool actually contradicted any scope's own audience tail). I did
not modify the harness to add a lean_male/lean_female scenario — out of scope for a "recover +
extend one veto" surgical fix, and the harness is a separate, deliberately-fixture-pinned artifact.
Treating this as "no signal on the lean half", not reassurance, per the brief's instruction.

## Pinned live strings (both now unreachable)

- `THE CEO Don't Quit Sweatshirt | Pullover Sweatshirts For Women for Men` — never survives on a
  lean_male family (test: "must never pad into the self-contradictory ... string").
- A lone `For Women` on a lean_male family with no other candidates — never survives either (test:
  "pads WITHOUT it").

## Files changed (all inside the worktree)

- `C:\Users\Admin\AppData\Local\Temp\fba-wt-genderveto\src\lib\fba\listingPipeline.ts` — 4 lines (1
  code line + 3-line comment): thread `lean` into the `titleBandCtx` closure.
- `C:\Users\Admin\AppData\Local\Temp\fba-wt-genderveto\src\lib\fba\titleBand.ts` — extract
  `crossGenderLeanVeto`/`crossGenderTailVeto`, wire them into `enforceMoneyTail` (replacing its
  inline checks, behavior unchanged) and into `candidateSegments` (new), add `lean?:
  MoneyTailCtx['lean']` to `TitleBandCtx`.
- `C:\Users\Admin\AppData\Local\Temp\fba-wt-genderveto\src\lib\fba\titleBand.test.ts` — 5 new tests
  (2 reproductions + 3 regression guards), all length-asserting.
- `C:\Users\Admin\AppData\Local\Temp\fba-wt-genderveto\src\lib\fba\parentTitleValidateRetry.test.ts`
  — restored verbatim from `fce9be7` (not authored this session).

## Commits (on `fix/parent-judge-plus-gender-veto`, branched from `main` @ `5bc44aa`)

1. `3ad7424` — Reapply PR #649 (revert of revert `1bf75ed`).
2. `4b88683` — Extend the cross-gender veto to the pad's candidate admission + reproduction tests.

## Concerns

- The brief's regex-pair citation (`LEAN_FEM_RE`/`LEAN_MASC_RE`) was wrong, as documented above —
  followed the code instead, reused `MONEY_FEM_RE`/`MONEY_MASC_RE`, the pair `enforceMoneyTail`
  itself actually runs on. No behavior or scope change from this correction, only which existing
  regex pair the shared predicate calls.
- The harness cannot currently exercise the lean half of this fix (unisex-only fixture) — flagged
  above, not silently passed over. If lean-scoped harness coverage is wanted, that is a separate,
  deliberate addition to `truthBandHarness.ts`'s fixture set, not something I added unasked.
- `enforceMoneyTail`'s two veto call sites were left in their original positions (no reordering) to
  guarantee byte-identical decision/note behavior — confirmed by the full pre-existing
  `titleBand.test.ts` suite passing unchanged, including `enforceMoneyTail`'s own cross-gender tests.
