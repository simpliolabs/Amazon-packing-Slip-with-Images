# FOUNDATIONAL PLAN — ONE TERMINAL ENFORCEMENT DOOR
**Scope:** all five published fields (title, backend keywords, bullets, description, item highlights) across all five pipeline exits.
**Status:** decision-ready proposal. No code written. Three PO decisions are required before Phase 3 (§3.4).
**Repo:** `C:/Users/Admin/AppData/Local/Temp/fba-portal`

---

## 1. THE ONE-SENTENCE DIAGNOSIS

**The pipeline enforces its invariants where content is PRODUCED — per producer, per branch, per flag — and has no abstraction that owns "what actually leaves this function is legal," so the only genuinely terminal seam it does have (`scrubPublished`, `src/lib/fba/listingPipeline.ts:7810`) is a string mutator that enforces nothing and *re-breaks* three already-satisfied invariants on its way out.**

The three readers converged on this independently:

- **Title:** the only remediation for every `validateTitle` invariant is a corrective LLM retry loop that ends at `listingPipeline.ts:3376`; fourteen mutating stages run after it and merely recompute `problems` for logging (OB2). Three producers (`buildTitleFor` :5991, per-child :8031, `buildNicheParentTitle` :6351) have three different rule sets, and `buildNicheParentTitle` never calls `validateTitle` at all (OB8).
- **Backend keywords:** the floor gate runs at `:9111/:9115/:9136`, then the editorial audit deletes tokens at `:9386-9391` with no re-gate, no re-fill, no re-cap, no re-dedupe — and `degradedSections` was already frozen at `:9106-9148` and is returned unchanged at `:9455` (VERIFIED: I read both the drop block and the `degradedSections` call sites). That is the 158-byte bug: the gate did not fire because when it ran, the string was in band.
- **Bullets/description/IH:** their enforcers live at generation time or inside a *conditional* LLM audit, while `scrubPublished` applies a **lengthening** trademark scrub after the last cap (`:7813-7814`). The title got the cap-after-scrub fix in PR #450 (`:7796-7801`, VERIFIED — the comment names the class explicitly); bullets, description and IH did not.

The missing abstraction is not "another net." It is a **declared, per-field, ordered chain of pure nets that runs once, last, on the exact bytes that ship, and reports what it could not repair.**

Supporting evidence that this is a rebuild and not a patch (VERIFIED, `git log --oneline --grep=<word> -i | wc -l`): title **406**, bullets **242**, backend **186**, description **177**, highlight **36** prior commits. Every one is far past the 3rd-patch circuit breaker in the `fba-generation-invariants` skill.

---

## 2. THE DOOR

### 2.1 Exact location

`const scrubPublished = (r: PipelineResult, opts?) => ({...})` at **`src/lib/fba/listingPipeline.ts:7810`**.

### 2.2 Why it is the only correct one (VERIFIED)

`partialResult` at `:7832` is **defined as** a `scrubPublished` wrapper:

```
const partialResult = (section, fields): PipelineResult => scrubPublished({ ... }, { titleProduced: section === 'title' })
```

Therefore all five exits pass through it, and there is no other single point that does:

| Exit | Site | Reaches door |
|---|---|---|
| P1 full regen | `return scrubPublished({...})` `:9451` | direct |
| P2 title partial | `partialResult('title', …)` `:8343` | via wrapper |
| P3a bullets partial | `partialResult('bullets', …)` `:8660` | via wrapper |
| P3b keywords partial | `partialResult('keywords', …)` `:9015` | via wrapper |
| P3c description partial | `partialResult('description', …)` `:9061` | via wrapper |
| P4 per-child fan-out | `per_child_titles/_bullets/_descriptions/_keywords` mapped **inside** `scrubPublished` `:7815-7826` | inside the door |

Installing here is **opt-OUT by construction**: a future early return cannot bypass it without deleting the wrapper. That property is why the title band net was put here (`titleBand.ts` docstring states exactly this reasoning) and it is the whole value of the door.

### 2.3 The one hard structural constraint the plan must resolve

`scrubPublished` is a **synchronous** arrow returning an object literal (VERIFIED `:7810-7831`). `applyTerminalNets` is **async** because two of its passes call an LLM: `expandShortBulletsTerminal` (bullets 150-floor rewrite) and `reExpandDescriptionIfShort` (`:7091`, gpt-4.1-mini extend). Making the door `async` would pull two model calls into every exit including the three partials that do not touch those fields.

**Decision: the door is PURE and SYNCHRONOUS. LLM repair never lives in the door.**

This is not a compromise — it is the correct boundary, and the codebase already demonstrates it: `expandShortBulletsTerminal` attempts an LLM rewrite ×2 and then falls back to `padBulletDeterministic` (`:7043`), which is the *actual* 100% floor guarantee. The LLM is a **quality upgrade**; the pure pad is the **enforcer**. The door holds enforcers only.

Consequence: the LLM repair stages become **required, unconditional pre-door stages** on every path that produces the field (§2.4 step M3), and the door holds a pure fallback so the invariant holds even when the LLM stage is skipped, times out, or fails open.

### 2.4 How `applyTerminalNets` is absorbed / retired — migration steps

`applyTerminalNets` is **retired, not widened.** It is the wrong shape: `field: 'bullets' | 'description'` (`:7064`), exactly 2 call sites (`:8650`, `:9041`), both wrapped in `if (CONTENT_SPINE_ON)` where `CONTENT_SPINE` defaults to `'off'` (`:1070`, VERIFIED), and the full path does not call it — it inlines its own copies (`:9410`, `:9413`, `:9428`, `:9444`). Its own docstring justifies excluding keywords on a false premise: *"the keywords-only path already runs its chain"* (`:7061`) — it does, but nothing runs after `scrubTrademarks` (`:7815`).

| Step | Action | What breaks |
|---|---|---|
| **M1** | Extract every existing **pure** net out of `listingPipeline.ts` into leaf modules under `src/lib/fba/ship/` (one file per net, `titleBand.ts` is the template). Candidates, all VERIFIED present: `capTitle75` :1574, `deduplicatePhrases` :1600, `dedupeBrandAndStutter` :5979, the non-adjacent token dedupe inside `collapseGarmentsAndDedup` :6710-6740, `dedupeTokenSoup` :684, `stripOppositeGenderTokens` :448, `scrubFitClaims` :6899, `normalizeBrandInBullet` :7254, `deDangle` :6871, `capBulletLen` :6880, `padBulletDeterministic` :6957, `tidyDescription` :6890, `scrubDescriptionBody` :7118, `capDescriptionVisible` :4904, `capItemHighlightRepeats` `productDetailAttrs.ts:200`. | Nothing behaviourally. Pure code motion; a golden-output diff must be byte-identical (Phase 1 gate). Risk is the escaping class `titleBand.ts:57-71` documents — inline `` new RegExp(`\b${w}\b`) `` was dead code for a release. Leaf extraction is precisely the cure. |
| **M2** | Build `runShipDoor(result, facts, mode)` — the pure composed chain — and call it from inside `scrubPublished`. `scrubTrademarks*` moves **into** the chain as step 0 so the cap/dedupe/floor nets run *after* it. | Fixes ORDER-1, ORDER-8, OB6, and the keyword cap/dedupe breaks in one move. Behaviour change on every path — hence shadow mode first. |
| **M3** | Promote the two LLM stages to a single unconditional pre-door `runLlmRepairs(field, …)` called on **every** producing path: replace `:8649-8655` (bullets partial), `:9040-9047` (description partial), `:9413` and `:9428` (full path inline). Delete the `CONTENT_SPINE_ON` gates. | (a) `[SPINE_DIFF]` shadow logging disappears — replaced by `[SHIP_DOOR]`. (b) The description-only and bullets-only partials **gain behaviour they have never had** (ORDER-6, ORDER-7): this is the point, but it *is* a live behaviour change on the two most-used buttons. (c) Latency on those partials rises by up to 2 model calls; must be measured, not assumed. |
| **M4** | Delete `applyTerminalNets` (`:7063-7091`) and its 2 call sites. Re-point `src/lib/fba/applyTerminalNets.test.ts` (VERIFIED it exists and imports `{ applyTerminalNets } from './listingPipeline'`) at `runShipDoor` + `runLlmRepairs`. Its central assertion — *"the model MUST NOT be called on in-band input"* — carries over verbatim and becomes the door's idempotence test. | Any other importer of `applyTerminalNets`. Grep shows only the test + 2 call sites. |
| **M5** | **The push boundary is a second door and must call the same library.** `pushFields.ts:99` caps title at `slice(0, 200)` not 75; `:103` description at 2000; `:104` bullets at 500; `pushExecutor.ts:3534` runs `scrubCelebrityNames(scrubTrademarks(s))` *after* `resolveProposed` already capped (both readers flagged this). Replace those with `runShipDoor(..., mode:'assert')` so push either agrees with generation or throws. | Push may start **refusing** stored legacy values that were never door-legal (e.g. a 120-char manual title accepted by `page.tsx:5327/:2741` with only an amber warning). That is correct but visible — it needs a UI message, not a silent throw. |

**Honest statement:** after M5 there is ONE net **library** and ONE **contract**, invoked at TWO boundaries (generation exit, push). Claiming "one door" covers Amazon would be false: content also reaches the seller through the read path (`ai-recommendations/route.ts:1531` IH cap, `:1566/:1569` trademark heal-on-serve). Those heal-on-read sites become `mode:'assert'` calls too, or they drift again.

---

## 3. THE CONTRACT

### 3.1 The principle

One constant per bound, declared in `src/lib/fba/contentContract.ts`, imported by **every** consumer. Today the contract is documentation, not truth — VERIFIED by reading the file plus the readers' grep: of the 22 keys, the only ones with live consumers are `title.hardCap` + `title.goldenBandLo` (`titleBand.ts:31-32`), `bullets.min`/`bullets.max` (`listingPipeline.ts:6931-6932`), `description.floor` (`:6935`), and `keywords.minLegacy`/`minStrict` (`backendDegradeGate.ts:29/31`). **Fifteen keys have zero consumers.** `humanizerTrigger: 70` carries a comment asserting it is `== goldenBandLo by construction` while every call site still uses the literal `68` (`:3532`, `:3603`, `:6275`, `:6795`).

### 3.2 Constants to reconcile — TITLE

| Bound | Value | Conflict resolved |
|---|---|---|
| `title.hardCap` = **75** | keep | `capTitle75` uses three literals for one bound: `<= 75` :1577, `slice(0,76)` :1581, `slice(0,75)` :1583. Plus `pushFields.ts:99` caps at **200** and the manual-title UI allows 200 (`page.tsx:5327`, `titleLockInput maxLength=200` :2741) with `title_source='manual'` locking it through every regen (`route.ts:1277-1283`) — a >75 title is pushable today. |
| `title.goldenBandLo` = **70** | keep | Four live "too short" thresholds: 50 (floor :1855), 65 (judge −30 :1203), 68 (humanizer trigger :3532), 70 (band). A 66-char title is simultaneously legal, docked −30, and out of band. |
| `title.humanizerTrigger` → **delete the key; use `goldenBandLo`** | 70 | Removes the 68-vs-70 dead band where a 68-69 char title is below band and triggers nothing. **This is a behaviour change** — titles at 68-69 will now be humanized. Must ship behind the door flag with a shadow diff, not silently. |
| `title.fillTarget` = **73** | keep, and adopt | 11 raw `73`s: :6024, :6085, :6091, :6134, :6209, :6214, :6226, :6587, :6626, :6632, :6672. |
| `title.floor` = **50** | keep | Currently unconsumed; `validateTitle:1855` uses a literal. |
| **NEW** `title.wordRepeatMax` | **2** (Amazon rule) | Reconciles `validateTitle:1869` (`c > 2`, fold-aware :1861-1865) against prompt text saying "NEVER repeat a significant word" (:3295, :3579, :6445, :6461) and against IH's max-1 (`:1663`). One number, not three. |
| **NEW** `title.productNounCount` | **PO DECISION — see §3.4** | Four contradictory live rules on one field: validateTitle allows ≤2 (:1869); `titleQualityJudge` docks −10 when < 2 (:1216-1218); V2/V3 briefs *require* 2 (:3270, :3292, :3555, :3576, :6419, :6441); the editorial-audit prompt says "say it once" (:7288); the legacy multi-design brief says "ONCE and SINGULAR" (:6460). On P5, `collapseGarmentsAndDedup` (:6693-6707) actively removes the second noun its own brief just requested. |
| **NEW** `title.minorWords` | one exported set | Three divergent lists case the same field: `MINOR_WORDS` :275 (13), local `MINOR` :3684 (adds on/at/by), `RETRY_MINOR_WORDS` :6280 (8). |
| **NEW** `title.separator` | **` \| `** | `:3313` forbids ` | ` and ` - `; `:3364` appends "(NO pipes)" unless `TITLE_V3_ON`; V2/V3 Pattern A *requires* it (:3269, :3554, :6418) and the judge awards +5 (:1212-1213). With `TITLE_QUALITY_V2=on` / `TITLE_COUNCIL_V3=off` (a reachable default combination, :1085/:1099) the brief demands the pipe and the retry that follows bans it. |

### 3.3 Constants to reconcile — KEYWORDS / BULLETS / DESCRIPTION / IH

| Bound | Value | Conflict resolved |
|---|---|---|
| `keywords.byteCap` = **250** | adopt everywhere | 10+ raw literals: :544, :552, :591, :4735, :2358, :625; `pushFields.ts:80/101/141/410`; `syncListingContent.ts:1131`. `route.ts:465` prints "/250 chars" (chars, not bytes) straight into an LLM prompt. |
| `keywords.floorHard` = **190**, `keywords.floorStrict` = **220** | keep both, keep the flag | Honest: the doctrine's 220 was never the runtime floor — `backendMinBytesFloor()` returns 220 only when `BACKEND_DEGRADE_STRICT === 'on'` and the module default is `'off'` (VERIFIED `backendDegradeGate.ts:24-36`). |
| `keywords.fillTarget` = **240** | keep, and finally consume | Currently referenced by nothing in `src/`; its own comment admits *"reach 240 was never expressible"*. The door is the first place that can measure it. |
| `keywords.coreTargetColored/Colorless` = **233/244** | adopt | Raw at :4489, :4459, :4475, :4751. Also fixes the capacity divergence: `childCore` truncates to a hardcoded 233 (:4751) for a `!apparel` family that by definition has no colour tail — 11 bytes lost for an impossible reservation. |
| `keywords.phraseStop` = **200**, `keywords.criticalLeadStop` = **180** | name them | Two unnamed budget numbers (:4427, :4370) with no stated relation to 233/244. Separately, `200` means three unrelated things (phrase stop :4427, scoreBackend pool-exhausted low bound :2359, scorer *char* dock `syncListingContent.ts:1120`). |
| `keywords.productTypeMax` = **2** | one number, one counter | Expressed as ≤2 at :4360/:4404/:4472/:4519/:4532 and as ≤1 in a comment at :594, enforced by two mutually blind counters (`productTypeCount` in `runBackendAgent` scope vs the free function at :489). |
| `keywords.stopwords` | one union set | `AMZ_BACKEND_STOPWORDS` :8777 (8) ⊂ `MINOR_WORDS` :275 (13). `fillBackendToBudget` checks neither beyond `length <= 1`, so `or/in/on/to/at` can be appended as content. |
| `keywords.alreadyIndexed` | **one definition** | `excludeWords` :4291-4293 **includes** bullets; `mkAlreadyIndexed` :8822-8835 **deliberately excludes** them (task #69, :8816-8821). Both live in the same regen: a bullet token is banned from the core and permitted by the fill. This one needs a PO/architect call, not a mechanical merge — see §3.4. |
| `bullets.count` = **5** | adopt | Dead key. Live checks are raw `5` at :4049, :5830, :5852, :6998, :7077, :7310, :8220, :8259, :8647, :9367, :9428, `pushFields.ts:168`. |
| `bullets.min` = **150** | keep; **the audit prompt must be corrected** | `runFinalEditorialAudit`'s prompt still asks for "100-200 characters" (:7288) — the *last* LLM stage on the full path is asking for 100 while the contract says 150. `bullets.scorerTooShort: 80` stays a declared, tested divergence (`contentContract.test.ts:30-34`), and the metric loop's own floor is 80 (:5777). |
| `bullets.max` = **200** | adopt | Raw at :7312, :4106, :4136, :4143, :5938, :5954. `pushFields.ts:104` caps at **500** — the only cap that actually runs at push. |
| `description.floor` = **900** | adopt | Raw at :2170, :2226-2233, :5069, :5120, :5137, :7225. `scorerApparelFloor: 700` stays a declared divergence; `validateDescription:2165` tells the LLM "800-2000". |
| `description.ceiling` = **980** | adopt | Dead key; the live value is a default parameter `cap = 980` (VERIFIED `:4904`). |
| **NEW** `itemHighlights.maxChars` = **75** | new section | The field with the harshest Amazon consequence (rejection 100476 + whole-item revalidation) has **no contract entry at all** (VERIFIED — I read the file). Three independent raw `75`s: :1654, :1734, `productDetailAttrs.ts:228`. Seller-facing copy still says "up to 125 characters" (:9358) and comments at :1617/:1743/:9334 still say ≤125. |
| **NEW** `itemHighlights.wordRepeatMax` | **PO DECISION — §3.4** | `validateItemHighlights:1663` flags `> 1`; `capItemHighlightRepeats` enforces `> 2` (VERIFIED, `productDetailAttrs.ts:215`, and `:189-198` documents Amazon's real limit as 2). An Amazon-legal draft with one word twice is rejected, burns the single retry, and is discarded for the deterministic fallback (:1841). |
| **NEW** `itemHighlights.trivialWords` | one set | `HIGHLIGHT_STOPWORDS` :1627 (12) vs `IH_TRIVIAL` `productDetailAttrs.ts:199` (15 — adds `on/or/your`, VERIFIED). A value clean under one is dirty under the other. |
| **NEW** `itemHighlights.minPhrases` = **2** | new | `:1674` requires ≥2; `capItemHighlightRepeats:231` is allowed to return **1** (`kept.slice(0,1)`, VERIFIED). The terminal net can itself break the generator's invariant. |

### 3.4-ANSWERED — PO DECISIONS, RECORDED 2026-07-29 (binding)

The PO answered all three. These are now CONSTRAINTS, not options.

| # | Question | PO ANSWER | What it binds |
|---|---|---|---|
| 1 | `Tee ... Tshirt` — variety or stuffing? | **VARIETY** (keep two nouns) | The net enforces **exactly 2 garment surface forms, and they must be DISTINCT surfaces**. Two nouns is the GOAL, so no net may collapse to one. A repeat of the SAME surface form (`Tshirt` twice) is still a violation and is what gets folded. Implemented via `pickDistinctGarmentForm` (titleBand.ts) — its fold-distinctness test already encodes exactly this. |
| 2 | IH repeat rule max-1 or max-2? | **2** | `capItemHighlightRepeats` max-2 stays authoritative; `validateItemHighlights`' max-1 is downgraded to a PROMPT PREFERENCE, never a gate that discards compliant work. |
| 3 | Does a bullet token count as already-indexed for backend? | **Take recommendation** = adopt the task-#69 answer: **bullets do NOT count as indexed** | `excludeWords` is reconciled to the #69 behaviour. Because this changes which keywords the core places, and therefore shipped bytes, it ships in its OWN shadow-diffed phase (Phase 6b) — never bundled into the door. |

**Worked example of decision 1 against the live defect.**
Input: `THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt, Tshirt for Women` (75).
Garment surfaces present: `Tee`, `Shirt`, `Tshirt`, `Tshirt`. That is 3 distinct surfaces + 1 duplicate.
The net drops the DUPLICATE surface (and its dangling comma), leaving 67 chars, then the band raise
re-spends the freed 8 characters on a fact the title does not yet carry. Two nouns survive, the
repeat is gone, and the title returns to the 70-75 band. Nothing collapses to a single noun.

---

### 3.4 (original, for the record) THREE PO DECISIONS REQUIRED BEFORE PHASE 3

These are **policy**, not engineering. No net can be safely turned on until they are settled, and writing code first would encode a guess.

1. **Is `Tee … Tshirt` sanctioned SEO variety or keyword stuffing?** The judge wants two nouns (`:1216-1218`); the audit prompt forbids it (`:7288`). The live defect — `THE CEO Cupid Valentine Tee Shirt | Comfort Colors Tshirt, Tshirt for Women` — is *three* garment tokens, which is a violation under every reading. But a net that folds `tshirt→shirt` and enforces "once" will also delete the second noun the gold pattern requires. **Recommended:** exactly **2** garment tokens, which must be **fold-distinct surface forms** (`Shirt` + `Tee`, never `Tshirt` + `Tshirt`). That satisfies the judge, the max-2 rule, and the gold pattern simultaneously, and `pickDistinctGarmentForm` (`titleBand.ts:77-90`) already implements the fold-distinctness test.
2. **IH repeat rule: max-1 or max-2?** **Recommended: max-2** (Amazon's actual limit, evidenced at `productDetailAttrs.ts:189-198`), and downgrade `validateItemHighlights`' max-1 to a *preference* that shapes the prompt rather than a gate that discards compliant work.
3. **Does a bullet token count as "already indexed" for backend?** Task #69 deliberately said no (`:8816-8821`); `excludeWords` says yes. **Recommended:** adopt the #69 answer (exclude bullets) uniformly, because bullets are not a reliably indexed surface — but this changes what the core will place and therefore changes shipped bytes, so it belongs in its own shadow-diffed phase, not bundled into the door.

### 3.5 Adoption tripwire

A contract with dead keys is worse than no contract, because CI goes green while the generator runs on independent literals (`contentContract.test.ts` asserts the *values*, never that the pipeline *uses* them). Add a test that greps `src/lib/fba/` for each contract number as a bare literal and fails on any hit outside `contentContract.ts` and an explicit allow-list of scorer divergences. That converts "the contract is documentation" into "the contract is truth" mechanically.

---

## 4. THE NET INTERFACE

```ts
// src/lib/fba/ship/types.ts  — leaf module: imports contentContract and other leaves ONLY.
export interface ShipFacts {              // PRODUCT FACTS ONLY. No keyword pool. Ever.
  apparel: boolean
  brandName: string                       // seller brand, canonical casing
  designName?: string
  productType?: string
  audienceLean?: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null
  blankSpec?: { brand?: string; material?: string; weightNote?: string
                fit?: string; neck?: string; sleeve?: string
                stretch?: string; fitToSize?: string } | null
  garmentAliases?: readonly string[]      // for pickDistinctGarmentForm
  truthHay: string                        // canonicalTitle + repTitle + designName + productType
  childColors?: Record<string, string[]>  // sku -> its OWN shade synonyms (static table)
  capacityBySku?: Record<string, string>
  liveTitle?: string                      // for echo/repeat checks only
}

export interface Violation {
  field: ShipField; code: string          // e.g. 'TITLE_WORD_REPEAT'
  severity: 'repaired' | 'degraded' | 'blocking'
  detail: string; before?: string | number; after?: string | number
}

export interface ShipNetResult<T> { value: T; violations: Violation[] }

/** THE signature. Synchronous. Pure. No openai, no process.env, no Date, no Math.random. */
export type ShipNet<T> = (value: T, facts: ShipFacts) => ShipNetResult<T>
```

The chain order is **declared data**, not control flow — this is what structurally cures the ordering-bug class:

```ts
export const SHIP_CHAIN: Record<ShipField, readonly ShipNet<any>[]> = {
  title:       [scrubMarks, capHard, dedupeBrand, dedupeWordsFoldAware, stripKidsAdultMix,
                hoistBrand, titleCase, enforceAudienceTail, deDangleTitle, bandPad, capHard],
  keywords:    [scrubMarks, scrubCelebrity, stripCommas, stripDirt, stripOwnBrand,
                stripUncorroboratedGarment, stripOffNiche, capProductType,
                dedupeTokens, padFromFacts, capBytes],
  bullets:     [scrubMarks, scrubFit, normalizeBrand, deDangle, capEach, padEach],
  description: [scrubMarks, scrubBody, ensureStructure, padFromFacts, capVisible, tidy],
  itemHighlights: [scrubMarks, scrubFit, dropOffendingPhrases, ensureMinPhrases, capRepeats, capChars],
}
```

Note the deliberate repetition of `capHard`/`capBytes`/`capVisible` **after** the padding nets, and `scrubMarks` **first**. That single ordering choice fixes ORDER-1, ORDER-8, OB6, and the keyword cap/dedupe/floor breaks.

### 4.1 Required properties and how each is TESTED

| Property | Statement | Test |
|---|---|---|
| **Pure** | No I/O, no clock, no RNG, no env. | Module-boundary test: every file in `src/lib/fba/ship/` may import only `contentContract` and sibling leaves. Assert via AST/import-graph test. Plus the existing `applyTerminalNets.test.ts` pattern — pass an `openai` object whose every method **throws** (`openaiThatMustNotBeCalled`, VERIFIED at that file's `:5-8`) and assert the door never touches it. |
| **Deterministic** | `f(x) === f(x)` across processes. | Golden-fixture snapshot per net; a second test runs each net 100× on the same input and asserts identical output. |
| **Total** | Never throws, for any string including `''`, emoji, lone surrogates, 10k chars, regex metacharacters in facts. | Fuzz test per net over a generated corpus. This directly pins the `titleBand.ts:57-71` escaping class and the `dnPhrase`-into-`new RegExp` at `:4448` (safe today only because the `[^a-z0-9\s]` strip at `:4446` happens to run first — safe by ordering luck, not by design). |
| **Idempotent** | `f(f(x)) === f(x)` for every net **and** for the whole chain. | Property test per net + per chain. `enforceTitleBand` already claims and documents this (`titleBand.ts:113-120`). |
| **Fixpoint-stable** | The composed chain reaches a fixed point in ≤2 passes. | Run chain twice; assert pass 2 produces zero `violations` with `severity:'repaired'`. **If it does not, the declared order is wrong** — this is the test that would have caught the pad-then-cap oscillation risk (R8). |
| **Monotone** | Violation count is non-increasing; no net may create a violation of a *different* invariant. | For each net, count violations of the full contract before and after; assert `after ⊆ before`. This is what pins `scrubTrademarks` breaking cap + floor + dedupe (`trademarkGuard.ts:19` `world cup → world futbol cup` +7; `:20-27` `fifa/olympics/nfl/nba/mlb/nhl/ncaa` all `sub: ''` = pure deletion). |
| **Never-blank** | Non-empty in ⇒ non-empty out. | Property test. `capItemHighlightRepeats:231-232` already implements this (`kept.slice(0,1)` fallback, VERIFIED) — and its side effect of dropping to 1 phrase is exactly why `ensureMinPhrases` must run before `capRepeats` in the declared chain. |
| **Facts-only** | Padding output must be a substring-derivable function of `ShipFacts`. | The `ShipFacts` type has **no keyword-pool field** — the type system enforces it. Plus a test asserting no `ship/` module imports `keywordResearcher`, `nicheGuards`, or any pool type. |

---

## 5. THE MEASURE-VS-FIX BOUNDARY

**Rule stated for the record:** a net may pad only from `ShipFacts`. It may never pull a search-pool term, never invent a marketing adjective, and never manufacture the *appearance* of compliance. `titleBand.ts` already states this policy in prose (*"never pulls from the search pool, because a title is a product claim: spec-grounding beats coverage"*); the plan makes it a type constraint.

### 5.1 TITLE

**FIXES from facts alone** (all pure string work, most of the code already exists):
- `>75` truncation — `capTitle75` :1574 (already at the door via `bandTitle` :7800).
- **Non-adjacent repeated significant word — THE live defect.** The code exists and is proven on P5: the token-dedup block in `collapseGarmentsAndDedup` `:6710-6740`. It needs zero product facts. Today `deduplicatePhrases` (:1600, VERIFIED: `for (let len = 3; len >= 2; len--)` — **len=1 is never reached**) and `dedupeBrandAndStutter` (:5987, VERIFIED: `/\b(\w+)(?:\s+\1\b)+/gi` — whitespace-only, so the **comma** in `Tshirt, Tshirt` defeats it) both miss it, and the tail dedupes at :3504/:6173 are conditionally dead because their anchor regex has no bare `shirts?` branch.
- Adjacent stutter; duplicate brand; brand hoist to position 0; duplicate `attributePin`; `for <blankBrand>` strip; `Unisex/Adult` before the noun; dangling separator; Title Case (one minor-word set); gender-word-once; kids/adult mix strip; audience tail from `audienceLean` (logic exists :2899-2927); trademark scrub; band padding from `BLANK_SPECS`.

**MEASURE AND REFUSE ONLY:**
- Restoring a dropped `mustInclude` or UPGRADE keyword — needs the pool, which the door has no access to and must never gain.
- Reaching 70 when `blankSpec` is null. **Important honest limit:** `blankSpec` is computed only when `looksTee` (`:7664-7665`), so the band net is **near-inert on hoodies, sweatshirts and hats**. Degrade behaviour: ship, log `NO product facts available` (`titleBand.ts:148`), flag.
- Pattern A vs B; readability of a rebuilt comma segment.

**Degrade:** ship-with-a-flag. Never abort-and-preserve a title on length — a short honest title beats resurrecting a stale one.

### 5.2 BACKEND KEYWORDS

**FIXES from facts alone** — everything subtractive, plus two additive:
- Re-cap to 250 **after** the scrub (the title got this in PR #450; keywords never did).
- Re-run `dedupeTokenSoup` after the scrub (kills the backend twin of `Tshirt, Tshirt` — VERIFIED `dedupeTokenSoup` is called exactly once, at `:4735`, before `scrubTrademarks` at `:7815`).
- Strip commas (the colour tail at `:4689` is the one unprotected route).
- Strip own-brand, `THIRD_PARTY_BRANDS`, celebrity tokens (and **add the missing `isCelebrityToken` line to `groupBan` :8867-8883** — the readers' diff shows it is the *only* check `groupBan` lacks vs `banBackendTok:8796`, so it reads as a copy oversight, not a decision), the stopword union, `JUNK_WORDS`, `ROLE_WORDS`, `KIDS_AUDIENCE`, and `GARMENT_TYPE_WORDS/STYLE_CUT_WORDS` uncorroborated by `truthHay`.
- **Move `isOffNicheKeyword`/`isForeignKeyword` to the door.** They are deterministic predicates over a token plus a fact-built haystack. This **replaces the LLM `backend_drop` pass entirely**, which simultaneously (a) fixes the 158-byte ordering bug, (b) gives the keywords-partial and multi-design paths cleaning they have never had, and (c) removes an unbounded LLM deletion from the shipped bytes.
- Cap product-type count on the final string with **one** counter.
- **Additive, facts-only:** each child's own colour-shade synonyms from a static table (differentiates children AND recovers the 17 reserved bytes when the tail LLM returns nothing, `:4696`), and `BLANK_SPECS` / garment-alias facts — the exact pattern `titleBand.ts:95-110` already uses.

**MEASURE AND REFUSE ONLY:**
- **Reaching 220, let alone 240, on a thin design.** Facts yield perhaps 40-60 bytes of legitimate additions; closing 158→240 needs ~82 bytes of real *demand* tokens and a terminal seam has no demand data. Per memory `autoseed-picks-blank-brand-not-design` (`jungleScoutClient.ts:235` sorts the harvest volume-DESC and keeps top 100), a niche design's pool may not contain its own keywords at all — which is why `fillBackendToBudget` starves in the first place. **The band is a POOL problem (tasks #144/#146), not a door problem, and no net can fake it.**
- Replacing an echoed token with a non-echo one.

**Degrade:** the floor check **moves into the door** so it measures shipped bytes rather than the stale pre-audit snapshot (`:9106-9148` frozen, returned `:9455`). Below floor ⇒ **ship-with-a-flag** (`degradedSections`), *not* abort-and-preserve — see R4 and memory `ai-quota-outage-looks-like-success`: the existing preserve stays scoped to **empty / unparseable**, because a below-floor preserve rule on a thin-pool catalog would freeze stale junk forever.

### 5.3 BULLETS

**FIXES from facts alone:** `capBulletLen` to 200 after the scrub (pure); `padBulletDeterministic` (`:6957`, curated pre-scrubbed apparel sentences, unique-suffix) for the 150 floor; `scrubFitClaims` from `BLANK_SPECS.fit`; `normalizeBrandInBullet` from `BLANK_SPECS.brand` — **currently missing from the always-run truth gate** (`:9401-9404` applies `scrubFitClaims` + `deDangle` + `collapseDup` but **not** brand casing, so a lowercase `comfort colors` from the metric loop ships, re-opening the #367 class); `deDangle`; capacity-token strip; production-method scrub (today description-only, `:7137-7139` — an invented "screen-printed" claim in a bullet is scrubbed nowhere).

**MEASURE AND REFUSE ONLY:** bullet coherence and "reads naturally" (`bulletHasCoherenceDefect:5749` is pure to *detect*; repair is a rewrite); hook-shape repair beyond a curated hook pool; third-party-brand *framing*; opportunity-keyword coverage (needs the pool, and by policy belongs in backend, `:4069-4074`).

**Special case — `bullets.length !== 5`:** today this silently disables the entire net stack at once (`:6998`, `:7077`, `:5830`, `:8647`, `:9428`) with no log and no abort; `assertCoreHealthy` is empty-only. **The door must FLAG this as `severity:'blocking'`, not skip.** Padding a 5th bullet from the pad pool would be content-free — honest behaviour is fail loud.

**Degrade:** ship-with-a-flag on length; blocking flag on count.

### 5.4 DESCRIPTION

**FIXES from facts alone — the biggest unclaimed win:**
- **HTML structure.** A pure net can `<b>`-wrap the opening sentence and build the required `<ul><li>` from `blankFacts` (`:7704-7710` — material, weightNote, fit, neck, sleeve) plus the currently-unused `stretch`/`fitToSize` (`:7162`). That ONE net satisfies `DESC-HTML-STRUCTURE`, closes the last ~120 chars of `DESC-FLOOR`, and asserts `DESC-SPEC-GROUNDING` at the output — three invariants, zero LLM, zero invented facts, idempotent (no-op when a list exists).
- Prerequisite: **fix `capDescriptionVisible`'s unbalanced-`<ul>` bug.** VERIFIED at `:4913-4917`: `bestEnd` is the max end index across `</p>`/`</li>`/`</ul>`, so when the last `</li>` before the cap sits after the last `</ul>`, the cut lands mid-list and the enclosing `<ul>` is never closed — and this is the *last* thing to touch the shipped HTML (`:9444` full, `:9058` partial).
- `scrubDescriptionBody` (brand strip + production-method) — pure and idempotent; it just needs to live at the door instead of behind `CONTENT_SPINE`.
- `tidyDescription` **after** the cap (today it runs at `:9404`, before both the refill `:9413` and the cap `:9444`).

**MEASURE AND REFUSE ONLY:** a 400-char shortfall (padding it would repeat facts — that is manufacturing the appearance of quality, and is forbidden); widow-POV inversion (detection at `:2283` is pure, repair is a rewrite); a description that scores 100 while containing no product fact at all (`scoreDescription` has no fact-presence term).

**Degrade:** ship-with-a-flag. Note the currently-unguarded path this closes: with `CONTENT_SPINE=off` a **description-only regen on a multi-design family**, or any fail-open audit, ships a broadcast description with **no** brand strip, **no** production-method scrub and **no** 900-floor refill (ORDER-6).

### 5.5 ITEM HIGHLIGHTS

This is the one field where "delete the bad part" is a **clean deterministic repair**, because the field is phrase-structured. Every content rule (off-season, promo, third-party brand, capacity, keyword-list shape) can be fixed by dropping the offending phrase and, if that leaves <2 phrases, appending a `BLANK_SPECS` phrase — `buildHighlightsFallback` (`:1683`) is already a complete pure spec-grounded generator that needs only `details` + `finalTitle` + `designName` + `BLANK_SPECS`, all available at the door.

**FIXES:** ≤75 cap **after** the fit/trademark scrubs (today `:1840` caps, then `:9352` `scrubFitClaims` can lengthen `boxy→relaxed` and `:7830` `scrubTrademarksDeep` can lengthen, with no re-cap — VERIFIED both); max-2 repeats; sentence-punctuation strip (exists nowhere today); ≥2 phrases; `isKeywordList` (`:1816`) heal-on-read — a pre-fix stored keyword-list IH currently survives every read and push.

**MEASURE AND REFUSE ONLY:** "does not repeat the title" (`:1773`) — needs the *current* title; detection pure, repair is regeneration.

**Two structural facts the PO must know:**
1. `buildItemHighlights` is called at `:9348`, **downstream of all four `partialResult` returns**, and the section-regen persist branch (`route.ts:810-850`) never writes `product_details_improvements`. **A title-only regen leaves a stale IH written to avoid the OLD title's words** — silently breaking its central rule against the title that actually ships.
2. The only refresh path, `regenerate-item-highlight/route.ts`, is a **second producer with a divergent contract**: `brandName` hardcoded `'THE CEO'`, `capacityFamily` forced false, `season` omitted (so the blanket policy would strip a Valentine design's own "Valentine"), and no `scrubFitClaims`. That is an INVARIANT-1 path divergence on the field with the harshest Amazon failure mode, and it is the commonly-used path.

Both are out of scope for the door itself and are named as Phase 6 (§7).

---

## 6. THE ANTI-GOODHART SECTION

**A net that hits a number is not quality. Read the flags, not the bands.**

This foundation makes shipped content *legal and internally consistent*. It does not make it *good*, and it does not make it *rank*. Specifically, it does **NOT** fix:

1. **LLM copy quality.** Bullet coherence, hook craft, whether the description reads like a human wrote it, widow-POV correctness, whether a title is *compelling* rather than merely 73 characters. Those are council/prompt problems. A 73-char title assembled from `THE CEO Cupid Valentine Shirt | Comfort Colors Relaxed Fit Tee for Women` is band-compliant and may still be a worse title than a 68-char one.
2. **The backend fill.** 158 → 240 bytes is a **keyword-pool** problem. `jungleScoutClient.ts:235` sorts the harvest volume-DESC and keeps the top 100, so a niche design can never harvest its own keywords (memory: pool floor ~1,173/mo vs valentine ~450/mo). The door can add perhaps 40-60 bytes of legitimate product facts. **If someone later "solves" the 240 band by padding with pool-adjacent filler, they have made the number green and the listing worse.** Tasks #144/#146 remain the real work.
3. **Ranking.** No invariant in this plan is a ranking claim. Amazon indexes tokens; the door only stops us wasting bytes and shipping illegal strings.
4. **Whether the design has demand at all.** A perfectly compliant listing for a design nobody searches for sells nothing.
5. **The producers' bugs.** The door will *mask* symptoms — a 4-bullet council result, a starved fill, a fail-open audit. That is why every repair emits a `Violation` with `severity:'repaired'` and why the ledger is the primary deliverable of Phase 2. **A rising "repaired" count is a producer regression, not a door success.**

**Two hard rules to prevent Goodharting:**
- **The scorer must not read the door's violations.** If `syncListingContent` ever scores "door-clean," the door becomes a target and the numbers stop meaning anything.
- **No net may pad from anything other than `ShipFacts`.** Enforced by the type (§4.1, facts-only) — there is no pool field to reach for.

---

## 7. SEQUENCING

Every phase is independently shippable, independently revertible, and has a stated **evidence gate** that must be met on a **live regen** — not `tsc`, not unit tests alone (memory: `verify-via-ci-build-not-just-tsc`, `shipping-from-fact`).

New flag: **`SHIP_DOOR = off | shadow | on`**, default `off`. Do **not** reuse `CONTENT_SPINE` (overloaded, `off` by default, and its two call sites are being deleted).

---

### PHASE 0 — Prove the already-shipped title band net (no new code paths)

**The problem:** `SHIP_BAND_NET` defaults to `'on'` (VERIFIED `:1067`) and the band net is *already live*, but on the one observed run it was **inert** — the council's output already sat at 75. We currently cannot distinguish "the net works" from "the net never fires" from "the net fires and does nothing," because it logs only when it changes something (`:7807`).

**Work:** add one log line for **every** door pass, including no-ops, with the reason:
`{tag:'SHIP_BAND_DECISION', len, decision:'in-band'|'over-cap'|'padded'|'facts-exhausted'|'no-facts', note}`.

**Evidence gate:**
- At least one live regen shows `decision:'padded'` with `from < 70` and `to` in `[70,75]`. The natural target is the family `titleBand.ts` was written for — the 66-char `THE CEO Cupid Valentine Comfort Colors Relaxed Fit Shirt for Women` on **B0GF49RLDL** (2026-07-29 21:03), cited in that file's docstring.
- At least one live regen shows `decision:'no-facts'` on a **non-tee** family (hoodie/sweatshirt), confirming the `looksTee` limitation (`:7664-7665`) empirically rather than by inference.
- A regen on the Cupid Valentine ASIN reproduces the `Tshirt, Tshirt` output and the log shows the band net returning `in-band` — proving the band net is **not** the source of the repeat defect (the readers established this by code reading; this proves it live).

**If the gate fails** (the net never fires on any family), the band net is dead code and Phase 1 starts by finding out why — do not build a door on top of an unproven net.

---

### PHASE 1 — Contract consolidation + leaf extraction. **Zero behaviour change.**

**Work:** M1 (§2.4). Add the missing contract keys (§3.2/§3.3), replace raw literals with imports, add the adoption tripwire (§3.5). **Deliberately exclude** the three behaviour-changing reconciliations: `humanizerTrigger 68→70`, the audit prompt's `100→150`, and the `alreadyIndexed` merge. Those ship later, one at a time, each with its own diff.

**Evidence gate:** golden-output test — 10 stored `PipelineResult` fixtures (covering single-design full, all four partials, multi-design fan-out, non-apparel capacity) produce **byte-identical** output before and after. Plus the tripwire test passes. Plus CI green (`git status --short` clean of `??` deps).

---

### PHASE 2 — The door in SHADOW. Measure only. **Nothing mutates.**

**Work:** M2 with `SHIP_DOOR=shadow`. `runShipDoor` runs the full declared chain, computes `violations`, logs one JSON line per field per exit — and **discards the repaired value**.

`{tag:'SHIP_DOOR', mode:'shadow', asin, exit:'full'|'title'|'bullets'|'keywords'|'description', field, code, severity, before, after}`

**Evidence gate — this is the phase that converts the inventory from analysis into fact.** After 2 weeks / ≥200 live regens:
- A violation census by field × exit × code. The following classes **must appear** or the inventory is wrong somewhere and the plan needs revision before mutating anything:
  - `KEYWORDS_BELOW_FLOOR` on single-design full regens **after** the editorial audit, with `before ≥ 220` and `after < 190` — the 158-byte bug, measured.
  - `TITLE_WORD_REPEAT` with a comma between the repeats.
  - `KEYWORDS_OVER_CAP` and `KEYWORDS_DUP_TOKEN` immediately after `scrubTrademarks` on any family with a scrubbed mark.
  - `BULLETS_OVER_MAX` on full regens that ran `runBulletsMetricLoops`.
  - `DESC_NO_LIST` / `DESC_BELOW_FLOOR` on description-only partials for multi-design families.
  - `IH_OVER_75` after `scrubFitClaims`/`scrubTrademarksDeep`.
- **Frequency, not just existence.** If `KEYWORDS_BELOW_FLOOR` fires on 60% of full regens, that reframes the priority order for Phases 3-6. The plan does not assume the answer.

---

### PHASE 3 — Turn on the SUBTRACTIVE and PURE-REPAIR nets only

**Precondition:** the three PO decisions in §3.4 are answered.

**Work:** `SHIP_DOOR=on` with the additive/padding nets still disabled. Caps, dedupes, strips, casing, hoists, order fixes. Includes the `groupBan` celebrity line (`:8867`) and `scrubCelebrityNames` in the door.

**Evidence gate:** the Phase-2 census re-run shows **zero** occurrences of every subtractive code, on every exit. Specifically: zero `TITLE_WORD_REPEAT` (the live defect closed, verified by regenerating the Cupid Valentine ASIN and reading the actual output — not a proxy), zero `KEYWORDS_OVER_CAP`, zero `KEYWORDS_DUP_TOKEN`, zero `BULLETS_OVER_MAX`, zero `IH_OVER_75`. **And** no *increase* in floor violations (proving the strips did not push fields below their floors — the monotone property, measured live rather than only unit-tested).

---

### PHASE 4 — Ordering fix at the second boundary (push + read)

**Work:** M5. `pushFields`/`pushExecutor`/`route.ts:1531,1566,1569` call `runShipDoor(..., mode:'assert')`.

**Evidence gate:** a live push of a family with a scrubbed mark shows the PATCH body ≤250 bytes / ≤75 title. Zero `mode:'assert'` throws across a week of pushes for door-generated content. Any throw on *legacy stored* content is expected and must surface in the UI, not the log — count them and confirm the UI message renders before turning assert into a hard block.

---

### PHASE 5 — Retire `applyTerminalNets`; make the LLM repairs unconditional

**Work:** M3 + M4. Delete the `CONTENT_SPINE` gates.

**Evidence gate:** a live **bullets-only** regen and a live **description-only** regen, each on a multi-design family, produce 5 bullets each ≥150 chars and a description with ≥900 visible chars, a `<ul><li>`, no `THE CEO` in the body — read from the actual DB row, not the stream. Plus a measured latency delta on both partials (state the number; if it exceeds ~15s the LLM stage moves to fire-and-flag rather than blocking).

---

### PHASE 6 — Additive facts-only padding + honest degrade

**Work:** description spec-`<li>` builder (+ the `capDescriptionVisible` tag-balance fix, which is a **prerequisite**); backend colour-synonym and `BLANK_SPECS` padding; IH `ensureMinPhrases`; widen `PipelineResult['degradedSections']` (`:267`, today typed `('backend_keywords')[]`) to all five fields and compute it **in the door** from shipped bytes.

**Evidence gate:** two measurements, and **both** must pass.
- Quantitative: floor-violation rate down; `KEYWORDS_BELOW_FLOOR` count and the residual byte gap reported honestly (expect it to shrink, **not** to zero — §6.2).
- **Qualitative, and it is a hard gate: the PO reads 10 padded samples per field and confirms they read like a product, not like filler.** If a padded description reads as repetition, the net is wrong even though the number is green. This is the anti-Goodhart check with teeth.

---

### PHASE 7 — Deferred, named so it is not forgotten

IH path parity: reconcile `regenerate-item-highlight/route.ts` with `buildItemHighlights` (`:9348`) — hardcoded brand, forced `capacityFamily:false`, omitted `season`, missing `scrubFitClaims` — and make section regens refresh the IH (`route.ts:810-850` never writes `product_details_improvements`). Also the `alreadyIndexed` bullets question (§3.4 #3). Each gets its own shadow diff.

---

## 8. RISKS

Ordered by expected damage × likelihood.

| # | Risk | Concrete regression | Test that pins it |
|---|---|---|---|
| **R1** | **A strip pushes a field below its floor.** `scrubTrademarks` deletes outright: `fifa/olympics/nfl/nba/mlb/nhl/ncaa` all carry `sub: ''` (`trademarkGuard.ts:20-27`). Off-niche stripping at the door removes tokens the fill can no longer replace (no pool). | A 235-byte backend string ships at 150 after the door "cleaned" it. We would have converted the 158-byte bug into a *more frequent* 158-byte bug. | Monotone property test per net (§4.1) **plus** a chain-level test: for every fixture, `violations after ⊆ violations before`. Plus the Phase-3 evidence gate explicitly requires "no increase in floor violations." |
| **R2** | **Cap-vs-pad oscillation.** `bandPad` raises to 74, `capHard` cuts to 75-safe, `padFromFacts` fires again. | Non-deterministic output across identical runs; a title that changes on every regen with no input change. | Fixpoint-stability test (§4.1): run the chain twice, assert pass 2 emits zero `'repaired'` violations. Fails loudly if the declared order is wrong. |
| **R3** | **Over-padding manufactures a false product claim.** `blankSpec` is computed only when `looksTee` (`:7664-7665`); `BLANK_SPECS` contains only Comfort Colors (`:7162`). A hoodie family padded with tee facts is a false claim, and `stretch: 'Low Stretch'` / `fitToSize: 'Runs Slightly Small'` have never been exposed to copy. | "Relaxed Fit Ring Spun Cotton" on a sweatshirt. Amazon-legal, factually wrong, and the seller only finds out from a return. | A per-net test asserting every padded segment is substring-derivable from the passed `ShipFacts`, plus a test asserting the net **no-ops** when `blankSpec === null` (and `titleBand.ts:145-148` already degrades honestly with a note — that behaviour becomes a required test). Phase-6's PO read is the human backstop. |
| **R4** | **Widening abort-and-preserve freezes stale content forever.** The tempting reading of the 158-byte bug is "preserve below floor." Memory `ai-quota-outage-looks-like-success`: empty PERSISTED over approved copy; **empty-only** abort-and-preserve; never gate rethrows by text or floors. On a thin-pool catalog a below-floor preserve rule would mean a design *never* gets fresh backend again. | Seller regenerates 5×, sees the same stale keywords, files "regen is broken." | Test: preserve fires **only** on empty/unparseable (`tryParsePriorKeywords` semantics, `backendDegradeGate.ts:56-66`). A below-floor result must produce `degradedSections` + shipped content, and a test asserts the fresh value **is** persisted. |
| **R5** | **The title repeat net deletes sanctioned SEO variety.** If the PO answers §3.4 #1 as "once," a fold-aware net removes the second garment noun the judge (`:1216-1218`) and every V2/V3 brief require. | Every title loses a noun; `titleQualityJudge` scores drop −10 across the catalog; the P5 parent brief and its own net (`:6693-6707`) keep fighting each other. | Behind `SHIP_DOOR` with a dedicated shadow diff logging `nounCountBefore/After` for a full week before `on`. Unit tests on the 8 PO gold titles (memory `title-po-gold-pattern`) asserting **none** is altered by the net. If a gold changes, the net is wrong. |
| **R6** | **Contract consolidation silently changes behaviour.** `humanizerTrigger 68→70` makes 68-69 char titles humanize for the first time; correcting the audit prompt `100→150` changes what the last LLM stage produces. | A "no behaviour change" refactor quietly rewrites titles and bullets across the catalog. | These three are **excluded from Phase 1 by design** (§7). Phase 1's gate is byte-identical golden output on 10 fixtures across all five exits — it fails if any of them leaked in. |
| **R7** | **The door masks producer bugs.** `bullets.length !== 5` today disables five nets silently (`:6998`, `:7077`, `:5830`, `:8647`, `:9428`); a door that pads around it hides a broken council. | Bullets quality degrades for months while the door reports green. | The door **flags** rather than skips: `severity:'blocking'` on count, and a test asserting the door never fabricates a 5th bullet. Plus the Phase-2 ledger is monitored for *rising* `'repaired'` counts as a producer-regression signal (§6.5). |
| **R8** | **Regex/escaping bugs in extracted leaves.** `titleBand.ts:57-71` documents the precedent: a single-backslash `\b` inside a template literal made the filter U+0008 BACKSPACE, so it was dead code that `git diff` renders invisibly — CI, tsc and 15 green tests all missed it. `dnPhrase` into `new RegExp` (`:4448`) is safe today only because a metachar strip happens to run first (`:4446`). | A net is dead code and the invariant it "enforces" is unenforced — exactly the failure the band net had on the case it was written for. | Totality fuzz test per net over inputs containing regex metacharacters, and a *positive* test per net asserting it actually changes a known-bad input (not just that it does not throw). Prefer padded-space containment over `RegExp` where possible — `pickDistinctGarmentForm` (`titleBand.ts:82-84`) already does this deliberately. |
| **R9** | **Per-child fan-out cost.** `scrubPublished` maps `per_child_titles/_bullets/_descriptions/_keywords` (`:7815-7826`); families run to 40-91 children. A synchronous chain of ~11 nets × 5 fields × 91 children on every exit. | Regen latency or a Cloud Run OOM (memory `fba-portal-coolify-oom`: `next build` already OOMs intermittently at 3072MB). | Benchmark test asserting the door on a 91-child fixture completes under a stated budget (propose 150ms) and allocates no unbounded structures. Purity makes this cheap; measure it anyway. |
| **R10** | **Push starts refusing legacy stored content.** A 120-char manual title is accepted by the UI (`page.tsx:5327`, `maxLength=200` at `:2741`) and locked through regens (`route.ts:1277-1283`). `mode:'assert'` would throw on it. | The seller's own manual override becomes unpushable with an opaque error. | Phase 4 counts assert-failures on legacy content **before** blocking, and the failure must render a seller-readable message. Test: an over-cap manual title produces a UI violation, not a 500. |

---

## 9. WHAT I WOULD NOT DO

1. **I would not add net N+1 inside the producers.** Title has 406 prior same-class commits, bullets 242, backend 186, description 177, IH 36 (VERIFIED via `git log --oneline --grep`). Every one is past the circuit breaker. Patch 407 inside `runTitleAgent` would sit *upstream* of the fourteen mutating stages that already ignore `validateTitle` (OB2) and would be re-broken the same day.
2. **I would not widen `applyTerminalNets`' field union and call it the door.** It has 2 flag-gated call sites, `CONTENT_SPINE` defaults to `off`, the full path does not call it (it inlines `:9410`/`:9413`/`:9428`/`:9444`), and its exclusion of keywords rests on a false premise (`:7061`). Widening it produces *two* doors and a false sense of coverage — the exact failure mode the brief asks us to avoid.
3. **I would not let the door call an LLM.** It would forfeit purity, determinism, idempotence and testability — the four properties that make the door trustworthy — and would put two model calls in the path of every partial that does not touch those fields. `padBulletDeterministic` (`:7043`) already proves the pure fallback is the real enforcer.
4. **I would not fix the 158 bytes by padding to 240 at the door.** The door has no pool and must never gain one. Reaching 240 from facts would require inventing demand terms — manufacturing the appearance of quality, which §6 forbids. The honest answer is: enforce cap/dedupe/dirt/fact-floor, report the gap, and fix the pool (tasks #144/#146).
5. **I would not widen abort-and-preserve to "below floor."** See R4 and memory `ai-quota-outage-looks-like-success`. Preserve stays empty-only; below-floor ships flagged.
6. **I would not delete the producer-side nets in the same change as installing the door.** Keep them, let the door's `'repaired'` count prove they are redundant on live traffic, *then* remove them one at a time. Removing first turns any door bug into a total loss of enforcement.
7. **I would not turn on the title repeat net before the PO settles the garment-noun policy** (§3.4 #1). Four contradictory live rules mean any net I write encodes a guess about intent, and on P5 the parent's own net already deletes the noun the parent's own brief requested (`:6460` vs `:6693-6707`).
8. **I would not enforce `validateItemHighlights`' max-1** (`:1663`). It is stricter than Amazon (`productDetailAttrs.ts:189-198,215`), it burns the single corrective retry, and it discards Amazon-legal LLM work for the fallback (`:1841`).
9. **I would not reuse `CONTENT_SPINE` as the rollout flag.** It is overloaded, defaults to `off`, and its two call sites are being deleted. A new `SHIP_DOOR = off|shadow|on` keeps the flip reversible and the shadow diff readable.
10. **I would not expose the door's violations to the scorer.** The moment "door-clean" is scored, it becomes a target and the census stops measuring reality.
11. **I would not attempt to break up `listingPipeline.ts` (~9,400 lines) as part of this.** Extracting the pure nets into leaves (M1) is the necessary and sufficient decomposition; a general refactor would make every phase's byte-identical evidence gate impossible to verify.
12. **I would not claim one door covers Amazon.** There are two write boundaries (generation exit, push) and one read boundary. The plan is ONE net library and ONE contract invoked at all three — stating that honestly is worth more than a tidier headline.

---

### RESIDUAL UNCERTAINTY (stated rather than smoothed over)

- **Frequency is unknown.** The inventory establishes that each defect class *can* occur and, for the 158-byte and `Tshirt, Tshirt` cases, *did*. It does not establish how often. Phase 2's census exists precisely to answer that before anything mutates, and the phase order after Phase 3 should be re-ranked by what it shows.
- **The three readers disagreed on some line numbers** (e.g. `scrubPublished` at 7804 vs 7810; the full return at 9400 vs 9451). I re-verified the load-bearing ones in the current checkout: `bandTitle` **:7794**, `scrubPublished` **:7810**, `partialResult` **:7832**, exits **:8343 / :8660 / :9015 / :9061 / :9451**, `applyTerminalNets` **:7063**. Older numbers in the inventory (and inside `titleBand.ts`'s own docstring, which cites `:8292/:8609/:8964/:9010/:9400/:7784`) are stale by ~40-50 lines. **Every line reference in this plan is against the current checkout.** Any implementation must re-grep rather than trust a number.
- **Latency of Phase 5 is unmeasured.** Making two LLM stages unconditional on the bullets-only and description-only partials adds up to 2 model calls to the two most-used buttons. The plan requires the number before the phase is accepted; it does not assume it is acceptable.
- **`applyTerminalNets.test.ts` exists while `applyTerminalNets.ts` does not** (VERIFIED: the test imports `{ applyTerminalNets } from './listingPipeline'`). Its "the model MUST NOT be called on in-band input" assertion is the single best existing test of the idempotence property and must survive M4 verbatim.