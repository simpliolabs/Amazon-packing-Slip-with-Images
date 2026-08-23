# Title pad: admission IS verification — one predicate governs both halves

**PO approval 2026-08-23 (approach A).** Successor to `handoff/TITLE_SETTLE_REWRITE.md`, which fixed
the *subtractive* half and left the *additive* half governed by a second, weaker rule list.

---

## 1. What actually went wrong (measured, not inferred)

`settleTruthBand` **already** calls `verdictForAssembledTitle` on every candidate before accepting it.
The predicate ran. It had no ammunition:

| Live regression (build `2552090`, 2026-08-23 07:20Z) | Why the predicate could not convict |
|---|---|
| `THE CEO Motivational Entrepreneur \| **Business B*tch** Sweatshirt for Men` (69) | The BROADCAST exit passes `foreignTokens: undefined` and `reject: undefined`. `AssembledTitleCtx` documents both as *"per-child exits only"*. A parent is nominally answerable to every design, so every design name reads as its own. |
| `THE CEO Don't Quit Motivational T-Shirt Tee Shirt \| **Oversized** Graphic Tees` (74) | `scrubUnspecdGarmentClaims` (`titleBand.ts:560`) owns unspec'd fit/weight claims, but it is a **pipeline STAGE** (`settleTitle` step C3) that runs *before* the pad (C5-C9). It deletes; the pad re-adds. |

Both are the same defect: **candidate admission and exit verification are two different rule lists.**
`candidateSegments` (`titleBand.ts:265`) gates on `isTitleWasteVocabulary`, `ctx.truthOk`,
`dominantGarmentGroup` (one-class), `conceptIsNew`, `alreadyStates`. `verdictForAssembledTitle`
gates on the truth net's idempotence, one-garment-class, duplicate-concept, punctuation, foreign
tokens, and (since #643) the youth marker. Overlapping, not identical. Tighten one, the other
refills the freed budget.

This is the third instance of the same class in one day — the generator's `TITLE_NET_REASONS`
allowlist vs the read path's unfiltered `phraseTruthVerdict`; two `PhraseTruthCtx` builders that had
already drifted on `designTokens`; and now the net vs the pad.

## 2. The invariant

> **A candidate is admissible if and only if the assembled title containing it would pass the exit
> verification. There is ONE predicate; admission and verification are the same question asked at
> two moments.**

Corollary: no rule may live only as a pipeline stage or only on one exit. A stage that deletes what
the pad may re-add is not a rule, it is an oscillation.

## 3. Design

### 3.1 Admission becomes a call to the verifier

`candidateSegments`' bespoke gate list is deleted. Admission becomes:

```
admissible(candidate) ⟺ verdictForAssembledTitle(assembleWith(title, candidate), ctx).ok
```

`assembleWith` is the SAME assembly `settleTruthBand` already uses to build the trial string, so the
string judged at admission is byte-identical to the string judged at exit.

Two gates are NOT truth and stay as cheap pre-filters (they are preference, not correctness, and
skipping them only costs a wasted verify): `alreadyStates` (dedup) and `isTitleWasteVocabulary`
(the PO's title-vocabulary ruling). Everything else — one-class, concept-new — is already expressed
in `verdictForAssembledTitle` and is removed from the pad.

### 3.2 The broadcast exit gets a foreign-name partition

**PO ruling 2026-08-23: "family theme only, never a child's name."**

The broadcast ctx today has no `foreignTokens`. It gets one, built from the SAME
`buildForeignDesignTokens` partition (`designScope.ts:71`) the per-child exits use — the difference
is only its input set:

- per-child exit → foreign = every OTHER design's name
- broadcast exit → foreign = **every** per-design name (the union), because no individual design
  speaks for the family

**PRECEDENCE — the ambiguity this spec must not leave open.** `designTokens` on the broadcast ctx is
`familyDesignNames` (`listingPipeline.ts`), which is assembled from `designName`,
`input.designNameOverride`, every value of `designNameOverridesByKey`, and every prior per-child
`designName`. That is *the same set* as the proposed broadcast foreign set. Without a stated winner,
a name would be simultaneously protected and rejected.

Resolution, explicit:

1. On the BROADCAST exit, `foreignTokens` WINS over `protect`. A per-design name is rejected even
   though it appears in `designTokens`.
2. The broadcast `protect`/`designTokens` is narrowed to the FAMILY-LEVEL theme only — the tokens
   that are NOT attributable to any single design group. Concretely: `familyDesignNames` MINUS the
   union of `designNameOverridesByKey` values and per-child `designName`s. On a multi-design family
   `effectiveDesignName` is already `''`, so the theme is whatever survives that subtraction.
3. If the subtraction leaves the broadcast with NO design vocabulary at all, that is the correct
   outcome — the parent then carries brand + garment + category vocabulary, and the band is reached
   from spec facts and pool phrases or it honestly holds. It must NOT fall back to permitting a
   design name.

An implementation that cannot cleanly separate "family theme" from "per-design name" must STOP and
report that, rather than guessing — the separation is the whole of the PO's ruling.

Per-child exits are untouched: a genuine "Business B*tch" child must still say "Business B*tch".

### 3.3 Unspec'd attribute claims become a verdict reason

`scrubUnspecdGarmentClaims`' rule moves from stage-only to a reason the verifier can return
(`unspecd-attribute-claim`), grounded in `blank_specs` exactly as the existing function is
(`spec.fit`, `spec.weightNote`). The stage may remain for defence-in-depth, but the pad can no
longer admit what it removes. This is [[spec-vs-search-grounding]] made executable: a product-FACT
attribute is addable only if the blank states it.

### 3.4 What this deliberately does NOT do

- It does not make titles longer. It makes them *provable*. Expect MORE under-band titles on thin
  pools — that is the approved trade (truth outranks band, PO 2026-08-23).
- It does not touch the producers/council, the money-tail installer's own contract, or `TITLE_V4`.
- It does not add a synonym table, a blocklist, or a second definition of anything.

## 4. Acceptance — the exact live strings that must not recur

Measured on `2552090`, 2026-08-23 07:20Z:

| Live string | Must become |
|---|---|
| `THE CEO Motivational Entrepreneur \| Business B*tch Sweatshirt for Men` | no sibling design name on the parent |
| `THE CEO Don't Quit Motivational T-Shirt Tee Shirt \| Oversized Graphic Tees` | no `Oversized` (Gildan 64000B is classic fit); youth marker asserted; ONE garment class |

Plus, unchanged from the prior contract: no `Tee`/`Tshirt` on a fleece family; `for Men` permitted on
`lean_male` (B0DSCDZC6K) and forbidden on `unisex`; parent speaks with the DOMINANT garment; every
title 70-75 **or** an honest hold / `shipped-truthful-under-band`.

## 5. Verification — the gate must run on LIVE inputs

The fixture harness reported GREEN three times on 2026-08-23 while production shipped lies, because
its inputs were richer than production's: (a) a candidate pool live does not have, (b) a hardcoded
`v4NoPad:false` that ignored `TITLE_V4`, (c) an audience/garment ctx the generator never resolves.

Therefore: **it is not done on a harness.** Done is a live `regenerate_section:'title'` POST on
**B0DSCDZC6K** (multi-design, sweatshirt-dominant, `lean_male`) **and B0DP5H8QBT** (single-design,
kids tee, `unisex`), with the decisions read from the **Coolify runtime logs** — `TITLE_DOOR_TRACE`,
`SHIP_BAND_DECISION`, `TITLE_BAND_UNREACHABLE` — not from the stored row. Byte-identical output
across deploys means a bypassed gate, not a wrong rule.

## 6. Risk

| Risk | Guard |
|---|---|
| Over-tightening starves every title | Measure band distribution before/after on both families; an honest hold is acceptable, a mass regression to <60 chars is not |
| The verify-per-candidate DFS gets slow | Pure string ops; measure, do not assume. Cap DFS as today. |
| A per-child exit loses its own design name | Explicit test: a genuine "Business B*tch" child KEEPS it |
| Removing pad gates loses a rule nobody noticed | Each deleted gate must be shown to be already expressed in `verdictForAssembledTitle`, or it stays |
