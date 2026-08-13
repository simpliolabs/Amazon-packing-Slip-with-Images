# TITLE ARCHITECTURE — the line between the LLM and the rules

**Status:** PROPOSED, awaiting PO sign-off. No production code written against this yet.
**Date:** 2026-08-12 · **Measured at HEAD:** `9c68e7e`
**Supersedes:** the "add one more net" approach that produced five consecutive rejections.
**Evidence:** two research passes — ~1,234 commits of this repo's own history, plus external
literature and 6 independent measurements executed against HEAD.

---

## 0. THE ONE-SENTENCE ANSWER TO "WHY RULES AND NO COUNCIL AND JUDGE?"

We kept teaching the machine what a good title **looks like** — but your gold title and a
keyword-soup title are **identical on every measurement a computer can take**. The only
difference between them is what they **mean**. So no rule we write can ever separate them.

That is not a metaphor. It is Measurement 3 below.

---

## 1. THE SIX MEASUREMENTS (all executed against HEAD, `TITLE_SHAPE_JUDGE=on`)

### M1 — The scorer has ZERO separation between your golds and keyword soup
Eight of your nine golds score **100/100 with an empty problems array**. Eight attack titles
that avoid every previously-closed string **also score 100/100 with an empty problems array** —
including:

| Attack | Score |
|---|---|
| `THE CEO Graphic Tee Shirt \| Comfort Colors Cotton Tshirt for Women Gift` (**no design phrase at all**) | 100 |
| `THE CEO Later Gator Tee Shirt \| Later Gator Later Gator Tshirt for Women` (**triple stutter**) | 100 |
| `THE CEO Purple Monday Tee Shirt \| Comfort Colors Banana Tshirt for Women` (**invented design**) | 100 |
| `THE CEO Cupid Valentine Tee Shirt Tshirt Shirts Tees Graphic Shirt Women` (**pure soup**) | 100 |
| **Your gold #7** (`I Could Be Meaner`, 78 chars) | **56** |

**The only title this scorer ranks below the attacks is one of yours.** Gold-vs-attack spread: **zero**.

### M2 — The scorer PAYS the writer to produce soup
Delete ` | ` from your four rejections, words otherwise unchanged:

| Your rejection | with pipe | without pipe |
|---|---|---|
| "WAY off" | 51 | **60** (+9) |
| "STILL BAD" | 51 | **65** (+14) |
| "Still Bad after regen" | 28 | **72** (**+44**) |
| "EVEN WORSE" | 36 | **60** (**+24**) |

*(Measured by me at HEAD on 2026-08-12 via `titleScorerSeparation.test.ts`. The research pass
reported +44/+39/+44/+24; my own run gives +9/+14/+44/+24 — the first two rejections move less than
reported. **The direction is the finding and it is unanimous: deleting the separator NEVER lowers a
rejected title's score, and on two of four it raises it by 24-44 points.**)*

**Cause, in code:** three of five shape checks are reachable only through `t.indexOf(' | ')`
(`listingPipeline.ts:1349`, `:1438`, `:1449`). **Four of your nine golds have no pipe.** A writer
optimising this score is actively rewarded for dropping the separator.

### M3 — THE MEASUREMENT THAT SETTLES THE ARCHITECTURE
I built the separator-agnostic identity rule that every "just write a better rule" proposal
depends on. Identity = words before the first separator of any kind. Over your nine golds:

```
7, 12, 4, 10, 6, 6, 8, 4, 13      ← corpus max = 13 (Rod Father)
```

Now the attacks: stuffed twin = **10**. Unpiped soup = **13**. Comma attack = **12**. Soup = **7**.
**All five pass a ceiling learned from your own corpus.**

Gold #2 has a 12-word identity. The comma attack has a 12-word identity. Gold #9 has 13. The
keyword soup has 13. Same number, same length band, same separator class, same garment-mention
count, both brand-front, both under 75, neither contains known spec vocabulary.

> **There is no number, no regex, and no template that admits your Espana and Rod Father golds
> and rejects the soup — because on every axis a computer can measure, they are the same object.**

Your ruling — *"Main money or design word needs to be short and sweet, up to 6-7 words"* — is
therefore **not a length rule**. Gold #4 has a **10-word** identity and is fine; the 10-word
stuffed twin is not. What makes gold #4 fine is that its ten words are **one thing a person
says**. What makes the twin bad is that its ten words are **three keyword chunks bolted
together**. That distinction is semantic. It is the entire content of your complaint. It is the
one thing an LLM does trivially and code cannot do at all.

### M4 — The lexicon carrying the "don't write specs" ruling is one hyphen from a bypass
`specClaimSpans("short sleeve")` → `["short sleeve"]`
`specClaimSpans("short-sleeve")` → `[]` · `("shortsleeve")` → `[]`
Also unseen: *soft cotton tee · premium quality · breathable fabric · true to size · 100% cotton ·
machine washable · cozy fit* — all `[]`.

### M5 — The door LAUNDERS the defect instead of removing it
`classifyTail("Short Sleeve")` = **specOnly** (droppable, −25).
`classifyTail("Short Sleeve Comfort Colors Tee")` = **brand** (protected, 0).
Appending two words converts the banned class into the protected class — and the component that
appends is the same pad the repo documents as the author of `| Crew Neck` and `| Short Sleeve`.

### M6 — Nothing re-scores the title that actually ships
`bandTitle` (`listingPipeline.ts:8339`) runs **ten mutating stages** and contains **zero** calls to
`titleQualityJudge`. All five judge call sites (`:3163`, `:3165`, `:3229`, `:6565`, `:6566`) read
`.score` and **discard `.problems`** — while the **backend** council already has the repair loop
(`council.reAskJudge(bestScore.problems, …)` at `:4817`). The diagnosis is generated on every regen
and thrown in the bin.

**Consequence:** every claim of the form "the judge scores this 100" is a claim about a draft that
no longer exists by the time you see it.

---

## 2. WHO ACTUALLY WROTE THE FIVE REJECTED STRINGS

From the repo's own attributions:

| # | Rejected string | Author |
|---|---|---|
| 1 | `\| Crew Neck` | **the band pad** (`titleBand.ts:702-706`) |
| 2 | `Unisex Classic Fit Fan Shirt` | the council |
| 3 | `\| Short Sleeve` | **the band pad** (`listingPipeline.ts:3186-3188`) |
| 4 | `for Men … for Women` | **the council's own deterministic terminal net** (`:3206-3227`) |
| 5 | `\| Shirt` | **contradicted** — `:8511` says the council, `poGoldCorpus.ts:226` says the pad |

**Deterministic code authored at least as many rejections as the LLM did, and in case 4 it was the
sole author.** The rules are not the safety net catching a weak writer — they are a co-author of
the defect. Moving more authority into rules moves authority toward the component with the worse
record.

Case 5 also proves the system cannot answer *"who wrote this word"*: nine door stages log
`from.length`/`to.length` and only two carry the actual span.

---

## 3. THE LINE

> **CODE OWNS FACTS. THE LLM OWNS MEANING.**
> **Code may FILTER and PROPOSE. Only the referee may DECIDE. Nothing may ADD TEXT after the ballot closes.**

A decision belongs to **code** if and only if some authority **outside you** settles it from data we
already hold: Amazon's 75-char cap (error 100476) · brand at position 0 · the trademark register ·
whether a fit/weight claim is backed by `blank_specs` · whether the design phrase is present. Closed
questions, with owners, cheap and exact. Code enforces them as **predicates that strike a candidate,
never as edits that rewrite one.**

Everything else — *is this one phrase or a pile of keywords · is it about THIS design · would a
shopper type it · is this your voice* — is an **open question whose only authority is your golds**.
An open question answered by a closed list is exactly what failed five times.

**The asymmetry is the entire safety argument:** a filter can only ever *shrink* the ballot, so it
cannot author a defect. **Every one of the five rejected strings was authored by an ADDITION.**

---

## 4. THE ARCHITECTURE — 8 steps, 2 LLM round-trips, no mutation after the ballot closes

| Step | What | Who |
|---|---|---|
| 0 | **Corpus load.** `loadPoGoldTitles` already turns a seller lock into training data with no deploy. Add `loadPoRejectPairs` over `listing_change_log`. | code |
| 1 | **Nearest-gold retrieval.** Rank the golds by situational similarity (design kind / garment / lean / proper-noun cluster). At N=9 this is a scoring function, not a vector index. *This step alone would have pointed the World Cup design at your **Espana** gold instead of at the piped golds all five failing drafts imitated.* | code |
| 2 | **Write.** N≈8 free-form whole strings. **No slot template, no grammar.** Delete the adversary and the LLM synthesis judge — the synthesis is merely prepended to an array and then out-ranked by a deterministic max, so it wins nothing on merit. Those two deletions **pay for** the referee. | LLM |
| 3 | **Build the ballot.** Normalise identically (`fixApostropheCase` only). Every surviving net runs in **PROPOSE** mode, returning a *tagged variant*, never an imposed edit. Add your own prior manual title for this ASIN if one exists — free, and if you beat us we learn it. → ~10-14 tagged candidates. | code |
| 4 | **Hard filter — 5 strike-only predicates.** len ≤ 75 (a predicate, *not* a truncator) · brand at 0 · no trademark (**runs BEFORE the cap — the scrub LENGTHENS strings**) · no unspec'd fit/weight claim · design phrase present. Every strike logged with a named reason. **Ballot empty ⇒ one retry with the failing constraints stated, then PRESERVE the existing title and raise a visible error. Never pad, never truncate, never manufacture.** | code |
| 5 | **THE REFEREE.** One batched call, temp 0. **Pointwise, reference-anchored, binary checklist** carrying your nine golds + the retrieved anchor + ~7 binary items, each requiring an **evidence quote**. Returns `{item: bool, quote}` per candidate plus one natural-language `tell`. **Code sums; the LLM never does arithmetic.** Run under 3 permuted item orders, take the majority. | LLM |
| 6 | **Tie-break ladder.** (a) checklist total (b) fewest distinct `tell`s (c) closest to corpus median length — **two-sided**, so adding words cannot help (d) lowest ballot index, *arbitrary on purpose: a final tiebreak that cannot be optimised toward is a feature*. | code |
| 7 | **Ship the winning bytes + cache the verdict.** `bandTitle` ceases to exist as a mutation chain. **The cache is not an optimisation — it is the determinism mechanism.** | code |
| 8 | **Repair round** — only when nothing passes as your voice. Feed the `tell`s back and re-run **once**. *This is the pattern the repo already has for backend keywords and has never applied to titles.* | LLM |

### Why pointwise, not pairwise
Pairwise preferences flip ~35% of the time vs ~9% for absolute scores, and are measurably **more**
vulnerable to distractor features that let a generator inflate a weaker output (arXiv:2504.14716).
**A stuffed title IS a distractor-dense candidate** — pairwise is the single protocol most likely to
be fooled by this system's exact failure mode. Reference-anchoring is MT-Bench's own documented
mitigation (arXiv:2306.05685). Permutation ensembling is the documented mitigation for the 16-39%
rubric-order top-1 reversal (arXiv:2602.02219).

### Why the cache is load-bearing
Temperature 0 does **not** make LLM grading reproducible: across 690 API calls spanning two
providers and three model tiers, 1-2 of 7 borderline items stayed non-reproducible even under forced
greedy decoding (arXiv:2606.26185) — batch-size-dependent float reduction, MoE routing variance,
provider load balancing. Caching converts *"non-deterministic"* into *"decided once, then frozen"*,
makes a regen idempotent, and lets you reproduce a result.

### Why N stays at 8
Repeated-sampling gains appear by n≈5 and plateau near n≈25 (arXiv:2505.21941), and Best-of-N
**provably amplifies reward hacking as N grows** (arXiv:2506.19248). Raising N before the ranker
discriminates makes things strictly worse.

---

## 5. THE DELETIONS

| Deleted | Why |
|---|---|
| **The FEEL injector** (`listingPipeline.ts:3819-3833`) | Hash-seeds `Soft/Comfy/Cozy/Cool` into any apparel title <50 chars. Added 2026-06-09 for an 80-char floor superseded twice. **Zero of your nine golds contain those words; neither ban list catches them; my own recent fixes made <50-char titles common.** Task #169. |
| **`enforceTitleBand`'s facts pad + the 70-char floor** | The documented author of `\| Crew Neck` and `\| Short Sleeve`, and the laundering vector of M5. **Your own Rod Father gold is 69 chars.** |
| **The council's terminal net (Rule-1 strip, Rule-2 append)** (`:3194`, `:3213-3227`) | Sole author of `for Men … for Women` — the string you called EVEN WORSE. |
| **The whole scoring body of `titleQualityJudge` + `titleShapeTerms`** (`:1298-1470`) | M1 and M2. It does not model quality; it models the five strings you already rejected. |
| **`TITLE_V2_BANNED_MODIFIERS`** | Measured `vocabAttested = ['funny','graphic','long sleeve']` — **"funny" appears in TWO of your own golds** while the list bans it. |
| **The adversary call + LLM synthesis judge** (`:3128`, `:3144`) | Out-ranked by a deterministic max; wins nothing on merit. |
| **The humanizer's length-extension retry** (`:6550-6590`) | The code's own comment calls it a shape-blind length maximiser; it exists only to reach the floor being deleted. |
| **CONVERT, not delete:** `capTitle75`, `scrubUnspecdGarmentClaims` | Become predicates. Truncation is an edit; the design-name backstop exists only to repair its damage. |
| **DEMOTE to proposers:** `tryMoneyTail`, `stripTitleWasteVocabulary`, `stripVariantColorWords`, `enforceInclusiveAudience`, `collapseRepeatedWords`, `dropSpecOnlyTail` | They may OFFER a variant, never impose one. |
| **RETIRE ON EVIDENCE, one release later** | Log each demoted net's win rate and `wouldChange` rate against the **winning** candidate. A net whose variant never wins and whose change-rate on the winner → 0 is dead code with a measurement behind its removal, not a guess. |

---

## 6. ACCEPTANCE — what "done" means, before any live regen

All of these are **offline, zero Jungle Scout credits, zero seller regens** except the last.

1. **THE FROZEN PROBE SUITE** — 22 strings: your 9 golds, your 5 rejections, 8 measured attacks.
   **PASS: `min(gold) > max(non-gold)`, strictly.** *Today the margin is **−44** (gold #7 = 56 vs every attack = 100).*
2. **THE STUFFED-TWIN PAIR** — gold `…World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee`
   must rank **strictly above** `…World Soccer Cup USA Mexico Canada Tee | Football Tee Shirt`.
   **These two are EXACT ANAGRAMS** — identical word multiset, identical length. This is the real test.
3. **SEPARATOR AGNOSTICISM** — for all 22, `|score(t) − score(t with ' | '→' ')| < 10`. *Today: +9, +14, +44, +24 — never negative.*
4. **ALL NINE GOLDS PRODUCIBLE** — each survives the five hard predicates (gold #7 pinned as an explicit over-cap exception).
5. **LEAVE-ONE-OUT** — hold out each gold, retrieve the nearest of the remaining eight, require the referee to pick the held-out gold from a lineup of its attack twins. **Ship only at ≥ 8/9.**
6. **PERMUTATION STABILITY ≥ 85%** across 3 random item orders.
7. **PER-ITEM FALSE-FIRE FLOOR** — every checklist item fires **zero** times across all nine golds. *An item that docks a gold is a rule you never made.*
8. **BYTE EQUALITY ON SHIP** (the only item costing one regen, and only after 1-7 are green) — the `[BALLOT]` winner must equal the persisted `recommended_title` byte-for-byte. This closes M6.

---

## 7. PHASING — each phase proves itself before the next

| Phase | Cost | Proves |
|---|---|---|
| **P0 — instrument only** (zero behaviour change) | free | Log `.problems` instead of discarding it; give every door stage a before/after **string** joined by one regen id. **One live regen then answers "who wrote this word" for the first time** and settles the `\| Shirt` contradiction with bytes instead of comments. |
| **P1 — the frozen probe suite as a FAILING TEST** | free, ~1s | Records the defect as an executable fact with a measured margin (−44), not a claim. **This is the acceptance gate for everything downstream.** |
| **P2 — the referee, OFFLINE. GO/NO-GO.** | ~30 batched calls, no regen | **This is the whole difference from the previous five rounds.** Ship only if LOO ≥ 8/9 **and** the suite passes with strict separation **and** permutation ≥ 85% **and** zero false fires on golds. If it fails, we have spent a day and learned the approach does not work — instead of shipping a sixth rejection. |
| **P3 — nets become predicates/proposers; the pad dies. SHADOW.** | no regen | Per-regen diff of *today's shipped title* vs *referee winner* with the loser's `tell` — reviewable by you as a list. |
| **P4 — the ballot ships** | 1 regen | The byte-equality assertion. |
| **P5 — the learning loop closes** (task #168) | free | `loadPoRejectPairs` over `listing_change_log`: **the next rejection becomes a new row in the frozen suite automatically**, not a hand-typed constant. |

---

## 8. WHAT THE ADVERSARIAL PASS BROKE (all three reviewers returned `holdsUp: false`)

These are folded into the phases above as **blocking pre-conditions**, not footnotes.

**Must fix BEFORE P2:**
- **The anagram pair is currently unwinnable** and it is the real test — same word multiset, same length. The referee needs enough resolution to break an anagram tie: 7 binary items over a 10-14 candidate ballot gives 8 possible totals, so pigeonhole makes **ties the normal case** and pushes the decision onto the ladder.
- **Delete "closest to corpus median 74" as a discriminator** — measured: gold and stuffed twin **tie**, and the unpiped soup at 74 chars **beats both**. A length metric as last discriminator is the exact defect class this proposal exists to remove.
- **The kill switch must not ship as designed** — "revert to the deterministic ladder" degrades to *closest-to-74-then-index*, i.e. **today's exact failure mode, shipped silently**, in a repo whose signature incident class is a silent degrade that reads as success. On referee timeout: **preserve and surface**, never silently degrade.
- **The identity ceiling is wrong today** — `measureGoldShape` derives `maxLeftWords` from the **piped subset only** (returns 10), and the brief prints that as "the most you have ever spent". Your Rod Father gold is 13.
- **Stratify the ballot by separator class** or the plain-join and comma golds **can never be produced** — the brief says "every gold above is TWO POSITIONS" and Persona 1 says "draft the SEPARATED shape most golds use". Four of your nine have no pipe.
- **Add a PRODUCIBILITY gate to P2**, not just a discrimination gate: measuring whether the referee can *pick* your golds says nothing about whether the writer can *write* them.
- **The referee must not be built on `titleCouncilAsk`** — its `catch { return '' }` makes an HTTP 400 indistinguishable from an empty verdict, the same shape as the three `json_object` sites this repo had dead since birth. Route it through `llmGateway` and require a **positive attestation**.
- **Remove the 70 floor from inside the demoted nets, not just from the pad** — `tryMoneyTail` returns `no-fit` outside [70,75] and `enforceTitleBand` short-circuits at ≥ `TITLE_BAND_LO`, so demoting them while deleting the floor leaves them still enforcing it.
- **Multi-design parent:** make predicate 5 (design phrase present) **producer-scoped**, or every multi-design parent regen empties the ballot — `:8173` sets `effectiveDesignName=''` for multi-design apparel.
- **Empty ballot must not be able to spend Jungle Scout credits** — the route falls through to a full 3-4-credit pull past the 14-day TTL, and filter-only code makes empty ballots *more* likely. Hard-gate it. (Standing directive: **never use credits**.)
- **Test the corpus production actually uses** — acceptance pins `SEED_GOLD_TITLES`, but production runs `loadPoGoldTitles` over the newest 12 manual rows, re-measured at runtime, **with nothing gating entry**: one mediocre lock moves the measured shape for every listing.
- **Make the rubric DATA, not prompt literals** — today `rejectPairBlock(SEED_REJECT_PAIRS)` ignores `ctx.poGolds` and the ~7 items are string literals, so a new ruling still needs a deploy.
- **Cost:** re-derive the budget **per design group** and bound the fan-out — `:8833` runs `Promise.all` over design groups with no cap and every LLM call at `maxRetries: 0`.

---

## 9. LIVE PROOF (2026-08-12, B0GVV3XL4T) — THE FIRST BYTE-LEVEL AUTHORSHIP CHAIN

P0 shipped, deployed, and a real regen produced the evidence this document was arguing for from
inference. **This section supersedes inference with production bytes.**

```
1  COUNCIL JUDGE PICKS   72   …Tee Shirt | Futbol Cup 2026 Soccer T-Shirt   score 100, problems []
2  DEDUPE strips repeats 56   …Tee Shirt | Futbol T-Shirt                   (matches "Title 56/75")
3  FLOOR + HUMANIZER     71   …Tee Shirt | Futbol T-Shirt Fan Tournament    score 70 → 100
4  SHIP DOOR             71   unchanged — [TITLE_DOOR_TRACE] stages: []
```

**THE ROOT IS STEP 1.** The money position the judge scored 100/100 with an EMPTY problems array is
`Futbol Cup 2026 Soccer T-Shirt` — and `cup`, `2026`, `soccer`, `shirt` are ALL already in the
identity. Four of six words are echoes. Only `futbol` is new. Thirty characters of the highest-value
real estate buy ONE search term. That is the seller's 2026-08-12 rule 1 ("every character must buy a
search term") violated at the point of decision, and the scorer cannot see it.

**EVERYTHING DOWNSTREAM WAS CONSEQUENCE, NOT CAUSE:**
- the dedupe was RIGHT to strip the repeats — keep it, it is a token-level fact with an oracle;
- removing them left 56 chars, tripping OUR invented 70-char floor;
- the floor created a vacuum and the humanizer filled it by INVENTING `Fan Tournament`;
- the door then correctly did nothing at all.

**THE DOOR IS EXONERATED ON THIS PATH.** `stages: []` means all ten stages ran and changed zero
bytes — already the state this architecture is aiming for. The deletion order in §7 P3 is therefore
REPRIORITISED: the producer-side humanizer length-extension retry goes first; the door-side nets I
had listed first were no-ops here.

**SPREAD WAS 48, NOT 0 — A CORRECTION.** I predicted a spread of ~0 would show the judge's
indifference live. Across its 4 candidates the judge had a 48-point spread and confidently picked the
top. It is NOT indifferent; it discriminates on the WRONG AXIS, awarding a perfect score with no
complaints to a title that repeats itself four times. That is a stronger argument for the referee
than indifference would have been.

**THE POOL WAS NEVER THE PROBLEM.** `titleDebug.candidatesUsed` contained `usa jersey` and
`mexico football jersey`, and `designGroups` was literally `["HOST-COUNTRIES"]`. The system had the
gold's own vocabulary and the correct theme tag, and still spent 15 characters on `Fan Tournament`.
Selection failure, not research failure.

**THE REFEREE'S FIRST PRODUCTION TEST CASE** (real data, not constructed attacks) — from the same
candidate list it must:
| candidate | required verdict |
|---|---|
| `Futbol Cup 2026 Soccer T-Shirt` | REJECT — 4 of 6 words echo the identity |
| `Futbol T-Shirt Fan Tournament` | REJECT — `Fan Tournament` invented, unsearched |
| `USA Mexico Canada Football Tee` | PREFER — all new, all searched, matches `HOST-COUNTRIES` |

**BEFORE → AFTER on the seller's own rejection:**
```
BEFORE  THE CEO 2026 World Soccer Cup Unisex Tee for Men & Women Fans | Shirt   69   "EVEN WORSE"
AFTER   THE CEO 2026 World Soccer Cup Tee Shirt | Futbol T-Shirt Fan Tournament  71
GOLD    THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee 72
```
The IDENTITY is now byte-identical to the seller's gold. The money position is the remaining gap,
and it is exactly the gap the referee exists to close.

---

## 10. THE POOL IS OFF-THEME, AND THE THEME RATER IS INVERTED (measured 2026-08-13, B0GVV3XL4T)

The seller asked why "Comfort Colors" bleeds into a World Cup design's keywords. Measured from the
live intelligence endpoint, it is not really about Comfort Colors:

```
75 keywords total
27 on-theme (soccer/World Cup/countries)      111,294 volume
48 off-theme (generic women's apparel)      1,966,669 volume   <- 95% of the pool
```

Top of the pool for a 2026 World Cup tee: `oversized tshirts for women` 385,892 · `t shirts for
women` 284,479 · `womens t shirts` 206,724. The design's own vocabulary — `futbol` 14,038,
`mexico soccer jersey` 14,038, `fifa world cup 2026` 9,565 — is an order of magnitude below.

**MECHANISM.** `keywordResearcher.ts:1528` stores the pool sorted `searchVolume DESC`, and `:1241`
takes `allSorted.slice(0, 10)` as the PRIMARY bucket. On a niche design the top 10 by volume are
category head terms by construction, so the design can never surface its own words.

**AND THE GUARD MEANT TO PREVENT THIS IS SCORING BACKWARDS:**

```
usa jersey                     themeFit 0     <- the seller's own gold word
futbol                         themeFit 0     <- the design's core term
oversized tshirts for women    themeFit 2
comfort colors graphic tshirt  themeFit 2
t shirts                       themeFit 2
```

Distribution over 75 rows: {0: 20, 1: 3, 2: 39, 3: 13}.

**HYPOTHESIS (not yet verified):** the rater is judging PRODUCT IDENTITY, not THEME. `usa jersey`
is a jersey rather than a graphic tee, so it rates 0; `oversized tshirts for women` is the right
garment, so it rates 2. Under the seller's own rule that is inverted — their gold uses the host
countries as MODIFIERS on a Tee (`| USA Mexico Canada Football Tee`).

**WHAT THIS KILLED BEFORE IT SHIPPED.** The planned narrowing of the grounding carve-out was
"vetted = actionType AND themeFit >= 2". Measured against this distribution, that would have
DELETED `futbol` and `usa jersey` and KEPT `oversized tshirts for women` — the exact inversion of
the defect it was meant to fix. It is not being built. Measuring the distribution before choosing
the threshold is the only reason that was caught.

**OPEN RISK FROM 2026-08-13's CARVE-OUT.** Exempting vetted targets from the vocabulary test
recovered `usa jersey`; it also stopped dropping `oversized tshirts for women` and `oversized
graphic tees`, which now reach the council. On the verifying regen the council ignored them and
chose `USA Mexico Canada` anyway — a good outcome, not a guarantee. The component that should
decide "is this about THIS design" is the referee (9/9 on the leave-one-out gate), still unwired.
