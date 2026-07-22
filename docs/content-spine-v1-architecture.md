# Content Spine V1 — Foundational Architecture

**Status:** awaiting PO approval of scope + pace · **Task #112** · **Supersedes** the field-by-field TITLE_COUNCIL_V3 plan
**Derived from:** two 11-agent mining passes (`wf_f03ea742-a18` title; `wf_c24bde98-706` bullets/description/keywords/parity/infra) over ~400 commits, all memory drawers, and live code.

---

## The problem, measured

| Field | Rules | Contradictions | Un-flagged gates |
|---|---|---|---|
| Title | 68 | 27 | ~12 |
| Bullets | 41 | 21 | 17 |
| Description | 41 | 21 | 17 |
| Keywords | 50 | 20 | 18 |
| **Deduped total** | — | **90** | — |

**Parity debt = up to 59 edit sites for one new invariant** (4 fields × 3 paths × N design groups). It never gets added everywhere → the same fix keeps needing to be re-made → the 101st patch is structurally inevitable.

**Root cause:** three hand-maintained paths (full regen; section-regen `#79`; single-vs-multi split at `listingPipeline.ts:7413`), each field re-implemented in each, with no shared contract, no shared council harness, no shared terminal net. Flags gate the *prompt*; ~74 un-flagged deterministic passes downstream mangle the output back.

**Scorer lies:** generator and scorer read different numbers for the same field —
description gen 900 vs scorer dock <700; keywords gen counts BYTES vs scorer counts CHARS; bullets gen 150 vs scorer full-marks <80. Green scores have been measuring against a lower floor than what ships.

---

## The four structural fixes

1. **`content-contract.ts`** — single source of truth. Every band, ban, and word-list exported once; scorer and generator both import it. If two fields legitimately differ, the contract holds both explicitly so they can't drift.
2. **Single-design = multi-design with N=1.** `resolveDesignGroups(input)` returns one synthetic group for single-design; delete the `:7413` guard; the per-child loop runs for every family. Divergence becomes unrepresentable, not merely discouraged.
3. **One finalizer + path table.** `PATH_FIELDS[only ?? 'full']` → `finalizeField(field, groups, ctx)`; every `(path, field)` cell routes through `applyTerminalNets`, enforced by a CI reachability test. A future bypass fails the build.
4. **One council harness.** `runCouncil()` parameterised per field; adversary ≠ judge enforced at load; trademark clauses generated from `TRADEMARK_RULES` (kills 4 stale "World Soccer Cup" strings); scored fail-open replaces silent array-index bias.

---

## Per-field resolved contracts

**TITLE** — 72–75 chars, hard cap 75. Pattern A `Brand [expanded idiom] Noun | [Variant] [Category] Noun`; Pattern B (low-search design) major category keywords lead, design phrase last. Idiom expansion. No modifier stuffing. No forced gender. Product noun twice. Zero commas/dashes. Specs grounded to `BLANK_SPECS`. (Full spec: `docs/title-council-v3-spec.md`.)

**BULLETS** — exactly 5, each **150–200** (ONE band, scorer full-marks == generator target). ALL-CAPS 2–4 word benefit hook + ` - ` + one complete sentence, terminal period, no dangling conjunction. Design name in ≥1 bullet is the ONLY coverage floor — opportunity keywords are NOT bullets' job (backend is). ≤2 repeats of any blend-brand/material. No role word unless in title (gift-clause exception, bullet 5). Bare 3P brands only as for/compatible-with. No gendered-fit on unisex blank. No hardcoded capacity on ≥2-capacity family. Terminal net guarantees the 150 floor on ALL shipped bytes across all three paths.

**DESCRIPTION** — **900–980 visible chars** (ONE constant; today scattered across 4 sites with an 850–899 dead band). HTML end-to-end: `<ul>` with 2–4 `<li>` (flat prose rejected) + ≥1 `<b>`. Order: hook → features `<ul>` → use-cases/audience → close. No shopper-search phrasing (backend home). No seller brand in body prose. screen-print → "printed". No oversized/boxy on relaxed blank. Terminal re-cap/re-expand on FINAL bytes after audit + per-design fan-out.

**KEYWORDS** — **240–250 bytes** per child, hard floor 220 (ONE byte budget; today 190/200/220/233/244/250 scattered). CRITICAL search terms survive title-echo. Relevance-gate drops stored in a SEPARATE recomputed column (never overwrite `action_type` — kills the CRITICAL→IRRELEVANT ratchet). CRITICAL-first sort. Generator and scorer agree on "covered" (`coverage-core`).

---

## Migration plan — 10 independently-shippable steps

Each step leaves the system working. Sequenced highest-value/lowest-risk first.

1. **content-contract.ts = today's literals** + advisory CI test (`scorerBand === genBand`). Additive, zero behavior change. Test FAILS for description/keywords/bullets — that failure is the map of the scorer lies.
2. **Extract `applyTerminalNets(field, …)`** wrapping the existing chain; swap in at current call sites only. Byte-identical, snapshot-tested. One door.
3. **Wire terminal nets into section-regen returns** (bullets-only, desc-only). Stops "Regenerate bullets" shipping 111-char bullets and "Regenerate description" shipping un-stripped brand + sub-900. **Highest live value, focused blast radius.**
4. **Scorer → contract bands**, behind `SCORER_CONTRACT=shadow`, `[CONTRACT_DIFF]` log. Flips thousands green→red — correct, but review the diff before flip.
5. **Collapse single→N=1**, delete the `:7413` guard, route single-design through the per-child loop. Highest structural value; own adversarial review (can silently regress single-design).
6. **Finalizer + path table + reachability CI test.** After this, new invariants are one-place edits.
7. **One council harness.** Migrate bullets first, then title/description/keywords. Enforce adversary≠judge at load. Generate ban clauses from `TRADEMARK_RULES`. Scored fail-open.
8. **Kill the CRITICAL→IRRELEVANT ratchet.** Stop the route writeback overwriting `keyword_analysis.action_type`; store drops in a recomputed column. Then default `BACKEND_CRITICAL_KEYWORDS=on` once backstops confirmed.
9. **Consolidate word-lists** into content-contract.ts; delete duplicate `FOREIGN_FUNCTION_WORDS`, 4 divergent stopword sets, the manual `SEASONAL_TERMS` copy.
10. **Flip CI tests to GATING.** From here a drift or a bypassed path fails the build.

---

## Biggest risks

1. **Live-write blast radius** — rewrites the exact bytes PATCHed to Amazon for every catalog listing. Every step flag-gated shadow→on; no exceptions.
2. **Step 4 looks like mass regression** — aligning scorer to contract flips thousands green→red. Correct (old green was a lie) but reads as "you broke my catalog". Shadow + `[CONTRACT_DIFF]` + explicit PO warning each flip.
3. **Step 5 can regress single-design** — the per-child loop carries invariants single-design never had (group-scoped pools, sibling-name bans). The synthetic N=1 group must equal "the whole family" exactly. Own adversarial review.
4. **Adversary≠judge costs quality/latency/$** — secondary model may be weaker; two models per council raises cost + Cloudflare-idle risk on the parallel per-design fan-out. Pick the distinct adversary carefully.
5. **Un-ratcheting IRRELEVANT re-admits junk if backstops are weak** — flipping the ratchet re-opens previously-dropped keywords. Any hole in off-niche/foreign/3P/trademark backstops turns it into contamination. Confirm backstops first.
6. **The contract is only as strong as the reachability test** — any new path that bypasses `applyTerminalNets` (a new onlySection, a new field, the serve/read path `route.ts:1529` that today re-applies only `scrubTrademarks`) silently reintroduces the disease. The CI test is load-bearing.
7. **Terminal-net ordering is a fixpoint hazard** — `scrubTrademarks` changes length after the cap; `reExpand` runs after `scrubBody`; `deDangle` vs the audit's for/to/of/with rule is an unstable fixpoint. The runner must define a deterministic order that always converges.

---

## What this is NOT

Not a session. This is multi-day. Today's three flags (BACKEND_CRITICAL, TITLE_QUALITY_V2, BACKEND_DEGRADE_STRICT) stop *regressions* and are live. The spine stops the *class* from recurring — a different size of work. Steps 1–3 are safe and high-value and could land first; steps 4–5 need the most care and PO attention.
