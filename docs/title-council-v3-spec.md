# Title Council V3 — Specification

**Status:** awaiting PO approval · **Flag:** `TITLE_COUNCIL_V3` (off / shadow / on)
**Derived from:** 11-agent mining pass over ~400 commits, all memory drawers, live code, and the 8 PO gold titles (workflow `wf_f03ea742-a18`). 68 canonical rules, 27 contradictions, 17 historical reversals.

---

## 0. Why this exists

`TITLE_QUALITY_V2=on` did not produce the gold shape because the flag gates the **prompt only**. Roughly a dozen un-flagged deterministic passes run downstream and mangle the shape back. The most damaging is `listingPipeline.ts:2690`, which hands all three proposers a worked exemplar that is character-for-character the PO anti-pattern:

> `EXACT target shape (copy the SHAPE, not the words; it is exactly 75 chars): "THE CEO Later Gator T-Shirt, Comfort Colors Alligator Tee for Men and Women"`

Truncated idiom, comma separator, forced dual gender. Few-shot beats instruction. This alone plausibly accounts for a large share of the ~100 failed training iterations.

**Resolution principle:** where a legacy prompt or gate conflicts with a PO gold, the golds win. Delete the named legacy instruction — do not layer another net on top (per `title-coherence-architecture`: never fix an open-generative class with another blocklist).

---

## 1. PO decisions (answered 2026-07-22)

| # | Question | PO answer | Encoded as |
|---|---|---|---|
| 1 | Pattern B ordering | Pattern B fires when **the design name is not in any major search**. Then: major category keywords first, secondary keyword, design name last. | `PATTERN_B_TRIGGER` = design-name search test |
| 2 | Category brand singular/plural | `Comfort Colors` is canonical | Validator morphology-tolerant; prefer plural |
| 3 | `tShirt` casing / compact spellings | Intentional, to save characters | `tShirt` added to Title-Case preserved set |
| 4 | Identical noun repetition (`Shirt … Shirt`) | Allowed — "sometimes it must… if we have 2 high phrases we can rank to and fit them" | Judge may repeat identically when it buys a second rankable phrase |
| 5 | Pattern B volume threshold | Not a PO number (was my invention) | Replaced by design-name search test, §3 |
| 6 | Seasonal terms | Allowed when the **product is seasonal**; evergreen designs put seasonal in backend keywords | Seasonal ban narrowed to evergreen designs |
| 7 | Scope | **ALL** — prompts + every contradicting gate | One PR, all 12 gates |

---

## 2. Canonical title contract

Applies to every path, both patterns.

| Constraint | Value | Enforcement |
|---|---|---|
| Length | **72–75 characters** (all 8 golds land 72–75; mean 73.5) | One exported constant; deterministic net |
| Hard cap | 75 (Amazon auto-rewrites above, effective 2026-07-27) | `capTitle75` |
| Brand | `THE CEO` at position 0, ALL CAPS preserved | 8/8 golds; `startsWith` test |
| Commas | **Zero** | 0 in all 8 golds |
| Dashes | **Zero** | 0 in all 8 golds |
| Pipe | Exactly one ` \| ` in Pattern A; none in Pattern B | §3 |
| Product noun | Appears **twice**; prefer indexable variants; identical allowed when it buys a second rankable phrase (PO #4) | Judge + net |
| Audience tail | **Optional.** Never force dual gender. Honour seller lean (hard or soft). Universal designs omit gender entirely | Delete widen guard |
| Banned as standalone decorators | funny, novelty, graphic, retro, cute, vintage, farewell, goodbye, going, away | Allowed in attribute pairs: `Graphic Shirt`, `Bold Motivational Tshirt` |
| Banned hype | perfect gift, must-have, best, premium, high-quality, versatile | Never |
| Trademarks | `world cup` → `world futbol cup`; FIFA / NFL / NBA / MLB / NHL / NCAA / Olympics dropped; no third-party brands bare | `trademarkGuard` — generated from `TRADEMARK_RULES`, never hardcoded in prompt text |
| Person names | Never (athletes, musicians, actors) | `celebrityGuard` |
| Grounding | Every word supported by design name, vision scan, or `BLANK_SPECS`. No invented motifs, materials, audiences, or occasions | `stripUngroundedMotifs` |
| Seasonal | Only when the product itself is seasonal (PO #6) | Ban narrowed from evergreen-only |

---

## 3. Pattern selection

**Test the design phrase, not the keyword list.**

```
designNameVolume = max search volume among keyword-pool entries
                   matching the design name OR its curated idiom expansion

IF designNameVolume is materially below the strongest category-head
   keyphrase for this product
      -> PATTERN B   (design name is "not in any major search")
ELSE
      -> PATTERN A   (default; 6 of 8 golds)
```

Worked example — gold #5. "I Will Praise Him in Every Season" has no meaningful search volume; `christian tee shirt` does. → Pattern B.
Worked example — gold #2. "Espana Championship" *does* carry volume (Spain championship 2026). → design phrase leads.

Implementation: the ranked candidate list already carries volumes. The selector is computed deterministically before the council runs and passed in the brief as an explicit instruction, so the personas are not left guessing.

### Pattern A — slot grammar (default)

```
<BRAND> <DESIGN_PHRASE> <NOUN_1> " | " [<VARIANT>] [<CATEGORY_BRAND>] [<SUBJECT>] <NOUN_2> ["for " <AUDIENCE>]
```

Left of the pipe — exactly three slots, nothing else:
1. **BRAND** — `THE CEO`, position 0
2. **DESIGN_PHRASE** — design name verbatim, or its curated idiom expansion. Never both.
3. **NOUN_1** — real garment noun (`Shirt`, `Tee Shirt`, `Cap`)

Right of the pipe — ordered, middles optional, noun mandatory and terminal:
4. **VARIANT** — real searched attribute (`Long Sleeve`, `Puff Embroidery`, `Cotton Twill`, `Bold Motivational`)
5. **CATEGORY_BRAND** — `Comfort Colors` (singular permitted to save characters)
6. **SUBJECT** — the design's literal visual subject (`Alligator`) or an attribute pair (`Graphic`)
7. **NOUN_2** — required, terminal before the audience tail
8. **AUDIENCE** — optional (`for Women`, `for Men`, `for Men and Women`)

### Pattern B — slot grammar (low-search design name)

```
<BRAND> <MAJOR_CATEGORY_KEYWORDS> <NOUN> [<CATEGORY_BRAND>] <DESIGN_PHRASE_LAST>
```

No pipe. Major category keywords carry the ranking; the design phrase closes the title.

Gold #5, sliced:
`THE CEO` · `Christian Tee Shirt` · `Comfort Color` · `I Will Praise Him in Every Season` = 75

---

## 4. Council architecture

### Current defect

All three personas hardcode design-led ordering **and** are prepended to the system prompt (`ask(p.sys + baseSystem, …)`, `:2367`). All three therefore draft Pattern A. The judge has never actually adjudicated Pattern A vs B — it picks among near-clones while the adversary attacks a shape none of them produced. Three drafts, one opinion.

### V3 structure

| Stage | Role | Owns | Required pattern | Temp |
|---|---|---|---|---|
| Proposer 1 | **Idiom Copywriter** | Left of the pipe: brand + design phrase + noun 1 | Pattern A always | 0.8 |
| Proposer 2 | **Demand-Capture Strategist** | Whole-title ordering; ranks phrases by volume before writing | Pattern B always | 0.3 |
| Proposer 3 | **Compliance & Conversion Editor** | Right of the pipe: variant, category brand, noun 2, audience; truth-grounding | Selector's choice | 0.4 |
| Adversary | **Ruthless Amazon critic** | Structured per-candidate critique + judge directive | — | n/a |
| Judge | **Final synthesiser** | Selects pattern, synthesises, may rewrite from scratch | — | n/a |

Personas become the **entire system message**. The brief (contract + golds + rules + selector verdict) becomes the **entire user message**. No prepending, no competing role statements.

Forcing proposer 2 to always draft Pattern B guarantees the judge receives a genuine candidate of each shape, so pattern selection is adjudicated rather than assumed.

### Models

| Stage | Model | Rationale |
|---|---|---|
| Proposers ×3 | `TITLE_PROPOSER_MODEL` (free tier, see task #110) | Cheap, diverse drafts |
| Adversary | `TITLE_ADVERSARY_MODEL` | **Must differ from judge** — anti-echo (PO directive) |
| Judge | `TITLE_JUDGE_MODEL` | Final authority |

Today adversary and judge both read `TITLE_COUNCIL_MODEL` → same model → correlated verdicts → no real debate. Splitting the env vars is part of this PR; the free-tier proposer routing is task #110 and ships separately.

### Fail-open

Replace `drafts[1] || drafts[0]` (silent SEO-persona bias by array index) with a deterministic selection prompt scoring: factual support → trademark safety → product clarity → readability → primary keyword → closest to 72–75.

---

## 5. Gate fixes (all 12 — PO answered "ALL")

| # | File:line | Action |
|---|---|---|
| 1 | `listingPipeline.ts:2695` | **Delete** the pipe/dash ban clause |
| 2 | `:2690` | **Delete** the anti-pattern exemplar sentence entirely |
| 3 | `:2742` | **Delete** `(NO " - " dashes or pipes)` from the corrective retry |
| 4 | `:5813` | **Delete** "Use the product-type word ONCE and SINGULAR" |
| 5 | `:6603` | Rewrite editorial-audit clause: noun may appear twice as distinct variants |
| 6 | `:2763-2775` | **Delete** the audience-widen guard (force-inserts "for Men and Women") |
| 7 | `:2628` | **Delete** "never narrow to a single gender" |
| 8 | `:3013` | Make the design-name hoist **pattern-aware** — must not fire under Pattern B |
| 9 | `validateTitle:1527` | Accept design name **or** its curated idiom expansion |
| 10 | `validateTitle:1561` | Brand check → `startsWith` position-0 test |
| 11 | All fill/anchor sites | Pattern-aware insertion — never comma-join; Pattern A inserts before noun 2 |
| 12 | `syncListingContent.ts:834` | Stop recommending a non-brand-first shape; stop docking −3 from 4 of the 8 golds; add cap/snapback/beanie/cup/polo/tank to the noun list |

Plus:
- **Collapse six length bands to one exported constant** (history: 80-150 → 50-75 → 70-75; floor 50 → 60 → 50, across 9 prompt strings + validator + judge)
- **Coherence gate** must split on ` | ` as well as commas, or it goes silently inert on the target shape
- **Novel-token harvest** must reject the banned decorators, or the deterministic layer re-appends the anti-pattern's trailing modifier
- **Trademark clause generated** from `TRADEMARK_RULES`, never hardcoded (the adversary prompt still says "World Soccer Cup", stale since the flip to "World Futbol Cup")
- `titleQualityJudge` re-banded to 72–75; add idiom-expansion and pattern-conformance scoring
- Apparel upgrade-keyword check in `validateTitle` gated the same way the scorer already gates it

---

## 6. Rollout

`TITLE_COUNCIL_V3` = `off` / `shadow` / `on`.

- **off** — current behaviour, byte-identical
- **shadow** — runs V3, logs `[COUNCIL_V3_DIFF]` with both titles and both judge scores, ships the old one
- **on** — ships V3

Shadow gives a real A/B on the same product in the same call.

**Verification (INVARIANT 6 — live POST, not tsc):**
1. tsc + CI
2. Adversarial review workflow pre-merge
3. `shadow` on B0GML5V7KZ (Later Gator, Pattern A) — read both titles from the diff log
4. `on`, regen, assert: 72–75 chars · pipe present · noun ×2 · no forced gender · no commas · `titleQualityJudge ≥ 85`
5. Repeat on a Pattern B listing (Christian or Spain class) — assert category head leads, design phrase last
6. Confirm no deterministic pass mutates the shipped shape after the judge

---

## 7. Honest risk

Prompts raise the ceiling; the deterministic layer sets the floor. This spec fixes both, which is why it is one PR rather than two. If after V3 the shape still misses, the remaining lever is a deterministic reshaper that assembles the title from labelled slots when the judge score is below threshold — that is a fallback, not the plan, and it would be a follow-up.
