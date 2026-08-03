# POOL_STRATA — stratified pool-composition contract (the #147/#149 foundational design)
2026-08-03. Output of a 3-architect / 3-adversarial-judge design panel under the PO's binding
constraint: **every design must be foundational, not a pile-on** (rebuild ONE seam, the old
behavior DIES). POOL_STRATA won unanimously (65/63/64 points; zero fatal flaws from any judge).
The two competing designs and why they lost are recorded in §7. **Status: awaiting PO GO.**

## 1. The problem (live, measured)
Thin-pool families miss the golden bands: titles 47–67 vs 70–75 (B0F6QZ34B1 parent 47, children
58/67/62; B0FKJW57H7 61), backend 158–219B vs 240–250 (B0GR22ZHBW pool held ~116B of novel tokens
vs the 220 floor). Established deepest cause (#144, ⭐⭐⭐): each Jungle Scout universe arrives
pre-cut to its cluster's top-100-by-volume, and the client then re-cuts the merged harvest with a
two-band volume sort (`keywordResearcher.ts:552-572`) — a niche design's own ~450/mo terms are
harvested and then discarded by a volume auction they can never win. SEED_TOKEN_NET's 12-slot
reservation was a bolt-on bandage on that seam.

## 2. The seam rebuilt
**Pool membership stops being an accident of volume.** ONE pure composer, `composePool()`
(new `src/lib/keyword-engine/poolComposer.ts`), builds the shipped 100-row analysis blob as a
DECLARED stratified composition over the same API responses:
- **S1 broad-heads** — exactly the top-30 by volume of the merge (today's heads survive verbatim → zero head regression),
- **S2 design-own** — rows hitting coverage-core `isCovered` on the design's distinctive tokens (existing off-niche + trademark nets gate entry), guaranteed up to 25 slots,
- **S3 niche-tail** — niche-universe rows (falls back to non-fromUniverse rows when `nicheHead` is absent — no dependency on the GARMENT_NOUN flag), up to 25,
- **S4 remainder** — by volume to 100; underfilled strata REDISTRIBUTE by volume, never pad.

Final blob re-sorted volume-DESC so every downstream consumer (buckets.primary, rankAnalysis,
Intelligence, coverage, both fills) sees the same shape it does today — just with the design's own
rows guaranteed present. No global volume ranking ever runs ACROSS strata again: either the
design's terms occupy their stratum, or the composer has provably exhausted supply (including one
budget-gated tail pull) and says so. **The change lands upstream of the ship-path fork, so
single-design, multi-design, and section-regen benefit with ZERO generator changes.**

## 3. What DIES (foundational proof)
- `keywordResearcher.ts:552-572` — the two-band volume cut (the membership decider itself)
- `:106-107` NICHE_SLOTS/POOL_SLOTS constants (cap moves into the composer as the one cap)
- `:359-399` SEED_TOKEN_NET trip logic (conditions relocate VERBATIM into the composer's `ensureDesignSupply`)
- `:480` flag-conditional seed-token wiring; `:495-517` [SEED_TOKEN_NET] terminal log (replaced by always-on `[POOL_STRATA]` census)
- `seedTokenNet.ts` reservation model + SEED_TOKEN_NET flag machinery (env var retired; `seedTokenHit`/`auditSeedTokens` survive as supply-audit primitives inside the composer) + the health-route flag line
- reservation tests (replaced by strata-guarantee tests incl. the B0GF49RLDL crowding shape)

## 4. Phases (each independently shippable, gated)
- **P1 — composer in shadow ($0):** `composePool` + tests; `POOL_STRATA=shadow` computes both compositions, ships OLD, logs `[POOL_STRATA_DIFF]` (entered/exited, per-stratum counts, designTokenHits old vs new, broadTop30Retained, offNicheEntered). **Gate:** on the 3 specimens every design token reaches shippedHits ≥3 in NEW, broadTop30Retained = 30/30, offNicheEntered = 0; zero unexplained old-vs-new gaps (calibration discipline — blocks all later phases).
- **P2 — supply guarantee relocation (shadow $0; ≤1 credit/starved research at flip):** `ensureDesignSupply` = the relocated tail-pull conditions (hits<3 AND not harvest-degraded AND budget-gated callsRemaining>50) → ONE `${missingToken} ${noun}` universe via the normal storage-first seed-pool loop. **Gate:** would_pull fires only on genuinely under-supplied strata; zero pulls during outage/low headroom; provider's own billable count unchanged.
- **P3 — flip + deletion (the foundational moment):** `POOL_STRATA=on`, DELETE the old decider + the whole SEED_TOKEN_NET layer in the same PR. One forced fresh research per specimen **after the monthly JS reset** (~3–12 credits), then plain regens on all three ship paths. **Flip gate (what THIS seam controls):** B0GR22ZHBW backend ≥240B via keywords-only partial; designToken shippedHits ≥3 everywhere; broadTop30Retained 30/30; zero KEYWORDS_BELOW_FLOOR. **Observed, not gating:** title bands (shared with the facts lever); B0F6QZ34B1 parent passes at "70–75 OR facts-exhausted provenance".
- **P4 — soak + flag decommission ($0):** no forced catalog re-research — composition rolls on lazily over the 14-day TTL. Watch `[POOL_STRATA]` + SHIP_CENSUS one full TTL cycle; gate = zero NEW band violations on previously-healthy listings; then the POOL_STRATA flag itself is removed (coverage-core precedent).

## 5. Judge-mandated grafts (in the design)
1. **Census attribution:** the composer's supply verdict (pool-cured | supply-exhausted | facts-missing) + acquisition provenance (pool-hit | fetched | skipped-budget | outage-guarded) is threaded into SHIP_CENSUS band-miss lines — every future short ship NAMES its starving lever. The census stays an independent auditor (it never verifies the system against its own plan).
2. **Composition-sha parity proof:** `[POOL_STRATA]` emits a deterministic composition sha; the same sha must appear on single/multi/section-regen runs of one listing — path parity as a logged invariant, not an argument.
3. **Honest split gates** (above): seam-owned acceptance vs shared-lever observation.

## 6. Credits & blast radius
$0 for P1/P2/P4. P3 verification ~3–12 credits, scheduled post-reset. Steady state: ≤1 credit only
when a design stratum is genuinely under-supplied (same envelope SEED_TOKEN_NET=on had reserved).
Code blast: keywordResearcher Phase-5 region + seedTokenNet (deleted) + new poolComposer.ts.
Explicitly untouched: jungleScoutClient, listingPipeline fills and all 4 backend call sites, the
route, keyword_seed_pool schema/TTL (zero migration). Main risk (self-declared + soak-gated):
volume-rank-31-100 generic rows get evicted for design rows — S1 + shadow diff + P4 soak cover it.

## 7. The losers (recorded so they are not re-litigated)
- **SUPPLY_PLAN** (plan-first generation): 3 fatal flags — the pool seam SURVIVES (a parallel
  supply channel beside the broken membership decider = the pile-on the constraint forbids, and
  every non-fill consumer keeps a design-absent pool); deleting humanizeTitleTo75 re-opens the
  short-title class it was built to cure; census-verifies-against-its-own-plan demotes the
  independent auditor. Its good ideas (attribution, parity proof, split gates) are grafted above.
- **LISTING_FACTS_LEDGER** (canonical facts model): no structural flaw, but it rebuilds root cause
  #2 and cannot close the backend band by construction (blank facts ≈ 40–60B ceiling). **It is the
  PAIRED NEXT DESIGN** (separate GO): minimal slice first — DB-backed `blank_specs` catalog seeded
  byte-identically from the two hardcoded rows + PO add-a-blank-without-deploy + census gap
  annotation. That is the proven B0GR22ZHBW 63→70 lever productized, aimed exactly at the residual
  POOL_STRATA's facts-exhausted log will name.

## 8. Standing notes on GO
- SEED_TOKEN_NET stays `shadow` and is SUPERSEDED — never flip it `on`; it dies in P3.
- The #149c census-triggered-retry sketch is SUPERSEDED — never build it (retry-on-blind-generation is the anti-pattern).
- Flip-runbook memories updated accordingly at P3.
