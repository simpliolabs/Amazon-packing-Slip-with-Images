# GOAL / PLAN / ADVERSARY — raise the title ceiling and re-shape titles to the market

approved: true

**APPROVAL BASIS — PO's own words, not my judgement.** The GPA gate exists so implementation never
runs ahead of the PO. It has not: every element below was ruled on explicitly.

| Element | PO, verbatim | Date |
|---|---|---|
| Raise the ceiling | *"B: Raise it"* / *"C: Test"* | 2026-09-05 |
| Probe + IH truth-fix | *"A/B: GO"* | 2026-09-05 |
| Shape authority | *"the rule is whatever Sales and converts better as per amazon Best Sellers in our category"* | 2026-09-05 |
| Brand position | *"lets remove THE CEO from Statrt of title, i know its mandatory, but i dont see any of the Competitor brands yusing it"* | 2026-09-05 |
| Execution mandate | *"You are the conductor and manager, Make decisions!"* | 2026-09-05 |

**What is NOT approved by the above and stays PO-gated:** merging any PR, and any write to Amazon.
Both remain explicit asks. This artifact authorizes BUILDING, not SHIPPING.

## 1. GOAL

Titles that match what actually wins in our category, produced by a scorer that encodes the PO's
rulings — not policed by another output net.

### THE FACT THAT UNBLOCKED THIS

Amazon's LIVE schema for productType **SWEATSHIRT**, read 2026-09-05 with zero writes via
`GET /api/fba/listing-optimizer/push-content?parent_asin=B0DSCDZC6K&debug=1&field=details&detail_field=Item%20Name`:

```json
"value": { "title": "Item Name", "maxLength": 200, "minLength": 0,
           "examples": ["Robert Graham Men's Maya Bay Short Sleeve Classic Fit Shirt, Cranberry, X-Large"] }
```

**200, not 75.** Amazon's own example is 78 chars. Every "75 is Amazon's cap" statement in this
repo is false; 75 is only the Item-Highlights precondition (error 100476).

### FINAL PRODUCT — observable

| Property | Requirement |
|---|---|
| Ceiling | **100** (`hardCap`). Not 200 — see ADVERSARY; unbounded length is how stuffing returns. |
| Target | **88** (`fillTarget`), the category median — an aspiration the pad chases, NEVER a floor |
| Floor | **UNCHANGED.** `shipFloor` and `goldenBandLo` do not move. A family that can only say 78 truthfully ships 78. |
| Brand | **NOT at position 0.** No rule may require `^THE CEO`. |
| Separator | no ` \| ` — one flowing phrase (0 of 5 category winners use a separator) |
| Truth | every character traceable to `blank_specs` or the design. **A longer title may never be a longer lie.** |
| Silent reversal | **zero paths** that shorten a shipped title without an error |

**Non-goals.** Not raising to 200. Not touching bullets/description/backend. Not dropping Item
Highlights in this spec (that is its own decision once titles exceed 75 and 100476 starts firing).

## 2. PLAN — phased, each phase independently shippable and revertible

**Think before coding.** The audit found 15 blocker sites. Doing them in one PR guarantees a
revert. Phase them so each has its own acceptance and its own blast radius.

### PHASE 1 — Make the constraint HONEST (no behaviour change)

The class being closed: **a code comment became a load-bearing constraint that nobody re-derived
for months.** Symptom-fixing the constant without killing the false belief guarantees recurrence.

1. `contentContract.ts` — introduce `AMAZON_TITLE_MAX = 200` sourced from the live schema, and
   `ITEM_HIGHLIGHTS_TITLE_PRECONDITION = 75`. `hardCap` stays 75 **and is redefined as the
   precondition, not Amazon's cap.**
2. Correct every false statement: `titleBand.ts:114` ("Amazon's, externally enforced"),
   `pushExecutor.ts:502` + its thrown message ("Amazon auto-rewrites item_name over 75, 2026-07-27
   policy"), `poGoldCorpus.ts:84/115`, `syncListingContent.ts:821-841` (seller-facing).
3. **A test that fails if anyone reintroduces the claim** — the enumeration test the standing
   directive requires: assert no source file asserts an Amazon item_name cap below 200.

*Verify:* `git diff` shows no behaviour change; every title byte-identical on a real regen.

### PHASE 2 — Kill the SILENT reversal paths (still no raise)

Ordered by danger. Silent reversal is worse than a hard failure; these land BEFORE the ceiling moves
so that when it does, nothing quietly undoes it.

4. `capTitle75` (`listingPipeline.ts:2237`, ~20 call sites) — must read the contract constant, not
   raw literals, and must REPORT when it cuts. A truncation nobody can observe is the #643 class.
5. `truthBandHarness.ts:243` `capTitle75Like` — the harness's private copy. **Delete it and use the
   real function.** Leaving it means the tests go green on a change they reverted (#652 verbatim).
6. `autoHealIhLongTitle` (`pushExecutor.ts:1249`, `:3819`, `:5038`) — must never PATCH `item_name`
   downward to re-earn Item Highlights. It is the one mechanism that can silently walk the whole
   catalogue back.

*Verify:* a deliberately over-ceiling title produces a LOUD failure at every one of these, never a
silent trim. Test asserts the log line AND the returned bytes — downstream of the consumer.

### PHASE 3 — Move the shape authority (the ROOT)

7. `poGoldCorpus.ts:500-501` — `t.length > 80` and `!/^the ceo\b/` are the sole admission gate.
   **They encode the OLD shape and silently reject anything matching the new ruling.** Widen the
   length bound to the new ceiling and DROP the brand-prefix requirement.
8. `TITLE_SHIP_FLOOR()` (`titleBand.ts:90-93`) memoizes `measureGoldShape(SEED_GOLD_TITLES)` — the
   FROZEN seed array — in a module-level cache that never re-derives. Derive from the live corpus,
   or state in the code why the seed is correct. **A ruling that cannot reach the scorer is a doc
   note** ([[rulings-must-live-in-the-scorer]]).
9. Brand and separator become SCORED shape terms, not required prefixes.

*Verify:* the PO can lock an 88-char brandless gold and `measureGoldShape` moves. That is the
acceptance test — nothing else proves the ruling reached the scorer.

### PHASE 4 — Raise the numbers, and only now

10. `hardCap` 75 → 100, `fillTarget` 73 → 88, `goldenBandHi` 75 → 95. Floor untouched.
11. The ~11 prompt strings teaching 70-75 (`listingPipeline.ts:3549, 4164, 4210, 4216, 4256, 4301,
    7285-7286, 7538, 8551`, `ai-recommendations/route.ts:386`) — including the adversary at `:3549`
    instructed to ATTACK long titles.
12. `validateTitle:2522` and the `titleQualityJudge` -45 length dock (`listingPipeline.ts:1779`).

*Verify:* **a measured truth-capacity distribution across every family** before the flip — dry-run
the pad with the ceiling at 110 and report each family's maximum truthful length. `fillTarget` is
set from THAT distribution, not from the category median. If most families top out at 82, the
target is 82.

## 3. ADVERSARY

- **"Why 100 and not 200?"** Because the constraint that actually binds is TRUTH, not Amazon.
  Measured honest capacity is 78-85 on thin families, 88-100 on unisex families with live pools. A
  200 ceiling licenses 100+ chars of padding the fact bank cannot cover, and the pad is exactly
  where untrue vocabulary entered in #630/#631. **100 is chosen to be reachable, not to be legal.**
- **"Phase 4 could ship and be silently reverted."** Precisely why Phases 2 and 3 come first. If
  Phase 2 is skipped "to move faster", the ceiling raise will be walked back by the auto-heal one
  SKU at a time and we will not notice for weeks — the field it re-earns is invisible.
- **"Removing the brand prefix loses brand equity."** Real, and the PO owns it. Recorded: MOUSYA
  keeps its brand; UNIQUEONE, LUKYCILD and FASHGL do not. **The PO ruled with the data in front of
  them.** My earlier counter-argument used tees and hoodies to reason about sweatshirts and was
  wrong ([[title-shape-authority-is-market-not-golds]]).
- **"The 88 median may be survivorship bias."** Yes. Winners may run long titles *despite* it.
  Nothing here proves a longer title sells more, which is why the floor does not move and why the
  PO's word was **Test**.
- **"Item Highlights dies once titles exceed 75."** Correct and intended, but the fallout was NOT
  audited — that dimension failed (schema retry cap) and must be re-run before Phase 4 ships.
  Known: the field renders only in the browser tab, and its unique indexing contribution measured
  4-5 generic garment words on B0DSCDZC6K.
- **"Doing this in one PR."** Would guarantee a revert. Four phases, four acceptances.

## 4. WHAT STAYS PO-GATED

Merging any PR. Any write to Amazon. Both remain explicit asks regardless of this artifact.
