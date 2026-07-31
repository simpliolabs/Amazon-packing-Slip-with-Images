# STABILITY FORMULATION — what is going on, and the fastest path to a stable system
2026-07-31. Evidence: 6-agent analysis (git archaeology over all 1,122 commits, architecture map, full institutional-memory synthesis, verification audit, competitor SaaS research, LLM-reliability research) + this week's live regen evidence.

## 1. WHAT IS GOING ON — the diagnosis in five sentences

1. **This is not 1,000 bugs.** 1,122 commits over 15.5 weeks, 69% of them fixes, reduce to ~10 recurring structural classes (path divergence, silent LLM failure behind fallbacks, multiple definitions of one concept, measurement-at-the-wrong-time, dead wires, pool contamination, flag drift, stale-truth reads, LLM-trusted-to-self-comply, live-write safety).
2. **The instability is a monoculture**: one 9,627-line file (`listingPipeline.ts`) appears in 21% of ALL commits (237, of which 190 are fixes) and held 35 direct LLM call sites, 23 env flags, and 3 different producers for the same title. The top-3 hot files absorb 41% of every fix ever made.
3. **For its first 13 weeks the system had no regression net**: 2.8% lifetime test-commit ratio; vitest wasn't even in package.json; CI verifies compilation only; tests are excluded from type-check. Every fix could silently undo a prior fix — which is exactly what 413 title commits and 405 keyword commits did to each other.
4. **The curve is already bending**: weekly fix volume fell four straight weeks (97 → 77 → 41 → ~29/wk) exactly as the structural seams landed (one coverage predicate, contentContract, ship census at the single exit, unconditional terminal nets, push gate, failing-test-first). 21 of 23 lifetime test commits landed in the last two weeks. The true revert rate is 0.4% — fixes stick; the problem was always volume, not reversal.
5. **External validation is unambiguous**: every mature vendor (Helium 10, Jungle Scout, Perci, Epinium) and the 2025-26 LLM-reliability literature converge on precisely the architecture this codebase is mid-way through installing — *LLM proposes, a deterministic layer disposes; every verdict is a named event; golden sets are harvested from live defects; all model calls go through one instrumented gateway*. We are not lost; we are half-built.

## 2. TODAY'S THREE LIVE EXHIBITS (each proves an open gap)

| Exhibit (B0GR22ZHBW full regen 14:29) | Log evidence | Open gap it proves |
|---|---|---|
| Title stuck at 63 | `SHIP_BAND_DECISION decision:'facts-exhausted' from:57 to:63` | BLANK_SPECS covers only Comfort Colors; this blank is a 4.5 oz ring-spun (per the live PDP) → the facts pool is empty. Add the real blank spec + the `customizable` fact and the same net finishes the job. |
| Description stayed 719 | Fresh copy measured **898 vs floor 900** → abort-and-preserve discarded it, kept the old 719 | Phase 3 wired floor-violations into preserve; the recorded doctrine says preserve must be **empty-only** (or at minimum better-than-prior). A 2-char miss must never keep 181-char-worse copy. |
| USA-250 keywords survived | No drop logged; terms re-enter from stored CRITICAL analysis | The new off-niche net cleans the POOL path; the CRITICAL-injection path reads the stored analysis — one more path divergence, the #1 class. |

## 3. THE STABILITY PLAN — ordered by (stability gained ÷ effort)

### Tier 0 — hours, this week
1. **Wire the existing 396 tests into CI** (verification agent: ~30 min): add vitest to package.json, `pnpm run test` step in build.yml, remove `**/*.test.ts` from tsconfig exclude, lazy-init the 3 module-top Supabase clients so all 15 suites run env-free. This single change converts two weeks of test-writing into a permanent regression net.
2. **Fix the preserve policy** (exhibit 2): abort-and-preserve fires only when the fresh copy is empty/unparseable OR strictly worse than the prior; otherwise ship fresh + degraded note.
3. **Close the CRITICAL-injection divergence** (exhibit 3): apply `isOffNicheKeyword` at the stored-CRITICAL read seam, same context guard.
4. **Flag census**: retire flipped/superseded flags (RELEVANCE_THEME_V2, legacy council branches, FIX_C when settled); decide BACKEND_DEGRADE_STRICT and GARMENT_NOUN defaults — dark flags are drift bombs (the CONTENT_SPINE retirement is the template).

### Tier 1 — days
5. **One LLM gateway** (both external agents' #1 recommendation): route all ~35 call sites through the existing instrumented client; the wrapper mechanically enforces the json-word precondition, bans bare `catch{}`, tags every call for cost/error observability. Three call sites were dead for 10 days and nobody knew — the gateway makes that class impossible.
6. **BLANK_SPECS expansion** (exhibit 1): PO confirms specs per blank actually used (this listing looks Gildan 64000-class); every entry simultaneously unlocks the title net, backend facts fill, and description builder on that part of the catalog. Plus the `customizable` auto-detect (already designed).
7. **IH parity + census codes**: the field with the harshest Amazon failure mode is the least protected (second producer with divergent contract, zero census codes).
8. **Golden fixture suite from live defects** (industry standard): every named incident becomes 3-5 replay fixtures (the pad-exhaustion and dash-prefix tests are the pattern) — organized 60% production samples / 15% adversarial / 15% edge / 10% failure replays.

### Tier 2 — the finish line (1-2 weeks)
9. **Decompose the monolith along the seams already built**, one field vertical per PR: terminal nets file → pure validators → backend vertical → description → bullets → title → the route's single-writer persist module. Every extraction gets the co-located tests the leaf pattern already proved (9 extracted leaves, all test-backed, zero regressions).
10. **Collapse single-design into multi-with-N=1** — retires the 59-site parity debt that keeps regenerating path-divergence bugs.
11. **Scorer↔contract reconcile** (the "scorer lies" gap): one number per band, scorer reads the contract.
12. **Pool root fix** when JS credits reset: SEED_TOKEN_NET shadow → on (the volume-sort harvest is the deepest single root cause on record).
13. **PO-editable rulesets** (task #104): trademark/celebrity/idiom/misspelling/colour-synonym lexicons as persisted data, not source edits — kills the "500-deploy pattern" where every correction is a code change.

### The two ideas worth stealing from competitors
- **Visible keyword ledger** (Helium 10 Scribbles' core UX): every target keyword shown with live placement state (title/bullet-N/backend/unplaced) via the one coverage predicate — the industry-standard trust surface.
- **Named restorable versions + side-by-side draft scoring** — one-click rollback beats a change log; score two council outputs against each other before you pick.

### What NOT to do (the analysis is equally clear)
- No new features into `listingPipeline.ts` until the decomposition lands (71% of last week's commits still touch it).
- No new blanket gates without off→shadow→on (4 of 5 all-time reverts were over-generalized gates).
- Never "solve" a floor by padding with pool terms; the scorer must never read the door's violations (anti-Goodhart).
- Stop hunting external blueprints: nobody publishes reliability engineering for AI listing generation; the only rigorous public source (Amazon Science's hallucination-detection paper) endorses the two-phase cheap-deterministic-then-LLM pattern already in use here.

## 4. HOW WE KNOW IT'S WORKING
Track three numbers monthly: (a) weekly fix-commit count staying <30 THROUGH the next feature push (the June dip reversed when features landed — that's the real test); (b) test-commit ratio of ongoing work (target 20%+, lifetime was 2.8%); (c) census violation rate per exit trending to zero with zero anonymous exits.
