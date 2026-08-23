# Title settle path — one predicate, nothing writes after verification

**PO approval 2026-08-22.** Rewrite of the title settle path after four consecutive live-gate failures on B0DSCDZC6K.

---

## 1. Why the patches kept failing

Every fix so far cured the stage it targeted, and a **later** stage re-introduced the defect:

| Attempt | Fixed | What live showed next |
|---|---|---|
| #630 | truth rules in one predicate | titles fell to 29-49 chars — the net only subtracted (REVERTED) |
| #632 | band restored by a refill | refill re-added market vocabulary the net had removed |
| #634 | council + judge learned the garment | producer improved; the refill still wrote after it |
| #637 | segment 0 scrubbed (the real "Tee" cause) | "for Men" went from 1 title to **6**, sibling names still leaked, `Long Sleeve Longsleeve Tee` appeared |

**The invariant being violated is always the same: the band refill is the LAST writer, and it appends from the raw pool after the truth verification has already run.** Whatever the net removes, the refill is free to put back — including a sibling design's name, a gendered phrase on a unisex family, and a second garment class.

## 2. The rule this rewrite enforces

> **One predicate decides truth. Nothing writes after the verification.**

Not "filter, then fill, then hope". Filtering and filling are the *same* decision, and the assembled string is re-judged as a whole before it is allowed to leave.

## 3. Design

### 3.1 One entry point

`settleTitle(raw, ctx) → { title, decision: 'kept' | 'refilled' | 'held', reason }`

Called from the ONE door every producer already passes through (`scrubPublished`). The three producers (`runTitleAgent` single-design, the per-design loop, `buildNicheParentTitle`) keep producing; none of them settles its own title.

### 3.2 The pipeline inside it

```
1. SEGMENT      split into money phrase (segment 0) + tail segments, separators preserved
2. JUDGE        every segment — including word-level inside segment 0 — via phraseTruthVerdict(ctx)
3. CANDIDATES   build the append pool: pool phrases ∪ spec facts ∪ the family's garment vocabulary
                EVERY candidate pre-filtered by the SAME phraseTruthVerdict + the string-level rules
                below. A candidate that cannot be true never enters the pool.
4. SEARCH       bounded DFS to land in [70,75] using only surviving candidates (pool-first after
                the money phrase, longest-fit is NOT preferred — it dead-ends, see #632)
5. VERIFY       re-judge the ASSEMBLED string as a whole (see 3.3). On failure: drop the last
                appended segment and continue the search. Bounded attempts.
6. SETTLE       in band and verified → ship. Not reachable from true material → KEEP THE PRIOR
                TITLE and log TITLE_BAND_UNREACHABLE. Never ship a stub, never ship a lie.
```

### 3.3 String-level rules (checked on the WHOLE assembled title, not per segment)

These are the rules a per-segment check structurally cannot catch — each of them shipped live:

- **One garment class per title.** `Long Sleeve Longsleeve Tee` is two individually-true phrases forming a false whole.
- **No foreign design name.** Each title may carry ITS OWN design name only; every sibling name in the family is forbidden. (Per-design scope, not the family union.)
- **No forced gender when `audience_lean = 'unisex'`.** `for Men` appeared in 6 of 7 titles because the refill never consulted the lean.
- **No duplicated concept across spellings** (`Crewneck` + `Crew Neck`).
- **Punctuation integrity** — `Entrepreneur, |` shipped live.

### 3.4 The hard constraint

**No stage may modify the title after step 5.** Casing and cosmetic passes move *before* the verify, or must be provably case-only (a transform that cannot change which words are present). Any future writer added after the verify is a bug by construction — pin this with a test that asserts the door's output equals the verified string byte-for-byte.

## 4. Why the harness passed while live failed

The #632/#637 harness exercised `settleTruthBand` — a **leaf**. The live path runs the leaf *plus* `enforceMoneyTail`, the band pad, and the casing passes. The defects lived in the stages the harness never called.

**Therefore: the harness must call the DOOR** (`scrubPublished`, the same entry the route uses), not any sub-function. A harness that green-lights a leaf while the door ships lies is worse than no harness — it manufactures false confidence, which is what happened four times.

## 5. Acceptance — the exact live strings that must not recur

From the 2026-08-22 19:25 regen on B0DSCDZC6K (Gildan 18000 ×25 + 18500 ×9, `audience_lean='unisex'`, 6 designs):

| Live string | Must become |
|---|---|
| `THE CEO Motivational Entrepreneur, \| Long Sleeve Pullover Crewneck for Men` | no `for Men`, no stray comma |
| `THE CEO Business B*tch Graphic Casual \| Long Sleeve Longsleeve Tee for Men` | no `Tee` (fleece family), one garment class, no `for Men` |
| `THE CEO Don't Quit Sweatshirt Business B*tch Crewneck \| Long Sleeve for Men` | no sibling name, no `for Men` |
| `THE CEO Hustle Definiton Sweatshirt Business B*tch \| Long Sleeve for Men` | no sibling name, no `for Men` |

Plus, still required: every title 70-75 or an honest hold that keeps the prior title; `TITLE_BAND_UNREACHABLE` logged with its reason.

## 6. Out of scope

The council/judge work (#634) stays as it is — better producers reduce how much settling is needed, but the settle path must be correct even when a producer writes badly. The #632 hold semantics stay. No model tiers change.
