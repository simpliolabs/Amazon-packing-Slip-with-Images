# GOAL / PLAN / ADVERSARY — grammar defects must be caught where titles are ASSEMBLED

approved: false   <!-- PO sets true. Never self-approve. -->

**REVISION 2 (2026-09-05).** Revision 1 proposed re-running the title judge on the shipped bytes.
**The adversary pass killed it, with arithmetic.** Kept here because the reasoning matters:

- The judge would score the shipped string **~86** vs the draft's **~70** — the pad improves the exact
  axes it measures (length, pipe, garment-noun ×2). The "prefer a better candidate" trigger never fires.
- The judge has **no punctuation term at all**, and its inclusive-audience dock is **exempted on
  `lean='unisex'`** (PR #666, 2026-09-04). Both of the PO's objections score clean.
- No search to re-enter: in-band titles return before the DFS (`titleBand.ts:1670`, `:1336`); the
  67-char design already exhausted it.
- `titleBand.ts` cannot import `listingPipeline.ts` (where the judge lives) — circular. R1's
  "one call site, no restructuring" was false.
- Worst case named: *"every test passes, the title doesn't change by one byte, and now carries a
  score of 86 certifying it."*

**Reclassification: these are ASSEMBLY defects, not RANKING defects.** Ranking chooses among what the
assembler produced; the assembler produced one string. Per this repo's `allocation-defects-need-an-llm-referee`
ruling — classify the defect before writing the rule.

## 1. GOAL

**What we are achieving:** a title that is assembled ungrammatically is REFUSED at assembly, on every
path, by the predicate that already vets every candidate.

**The two live defects** (B0DSCDZC6K, unisex, 34 SKUs):
- `THE CEO Business B*tch Sweatshirt, Long Sleeve | Pullover for Women` — the comma splits the garment
  noun from its modifiers; siblings correctly read `Sweatshirt | Long Sleeve Pullover Crewneck`.
- `THE CEO Don't Quit Sweatshirt | Long Sleeve Pullover Crewneck for Men Women` — dangling conjunction.

**PO RULING 2026-09-05 (delegated to me from the correction record, stated for the record):**
`for Men Women` is a **GRAMMAR** defect, NOT a reversal of PR #666. The PO asked for this vocabulary
in their own words as *"For Man And Wome…"*, and their gold reads *"for Kids & Children"*. The phrase
stays admissible; **the conjunction is mandatory**.

### FINAL PRODUCT — observable

| Property | Requirement |
|---|---|
| Conjunction | `for Men and Women` / `for Men & Women` pass; `for Men Women` is REFUSED |
| Punctuation | a comma may not separate the garment noun from its own modifiers |
| Coverage | enforced in `verdictForAssembledTitle`, so it binds every candidate the search accepts, both ship doors, both money-tail installs, and the prior-title re-judgement |
| No regression | all six designs stay >= 68; the four currently at 73-74 keep their exact strings |
| Not a rubric change | the judge's scoring is untouched — this is a truth/assembly predicate, not a score |

**Non-goals.** Not re-running the judge anywhere. Not changing what the judge values. Not reversing
PR #666. Not touching the DFS ordering (pool phrases outrank garment nouns — that ordering exists
because removing it produced "four garment nouns, all true, all worthless").

## 2. PLAN — per karpathy-dev-principles

**Think before coding.** The adversary proved step 1 of R1 is already-shipped instrumentation:
`settleTitle` emits `TITLE_DOOR_TRACE {id, in, out}` (`titleBand.ts:3045`), plus `SHIP_BAND_NET`,
`TITLE_V4_DIFF` carrying `shipped`/`withoutPad`/`padManufactured`. **Read the live logs before writing
code** — they name which stage introduced the comma and the missing conjunction. It may be
`stripInclusiveAudience` or `repairRemovalResidue`, in which case the fix is in that net, not a new clause.

**Simplicity first.** `verdictForAssembledTitle` already exists, already runs on every accepted
candidate, and already owns `titleHasPunctuationDefect` (`titleBand.ts:1501-1512` — which today tests
`,\s*\|`, `\|\s*,`, `,,`, `||`, doubled space, `,\s+(for|and)`). Two clauses added there cover
everything. No new predicate, no new net, no circular import.

**Surgical.** `titleBand.ts` only.

### Steps, each with its verification

1. **Read the live logs first.** `TITLE_DOOR_TRACE` / `TITLE_V4_DIFF` for B0DSCDZC6K.
   *Verify:* name the stage that introduced `Sweatshirt,` and the one that produced `for Men Women`.
   *If the author is an existing net, fix it THERE and stop — do not add a clause that masks it.*
2. **Extend `titleHasPunctuationDefect`** with the garment-noun-comma-split case.
   *Verify:* RED against unmodified source on the live specimen; the four healthy siblings unaffected.
3. **Add the dangling-conjunction clause** — an audience tail naming two audiences must carry `and`/`&`.
   *Verify:* `for Men Women` refused; `for Men and Women`, `for Men & Women`, `for Kids & Children`
   (the PO's gold) all pass. Table-driven over audience pairs so a new one is covered.
4. **Live gate.** Regen B0DSCDZC6K; all six meet the FINAL PRODUCT table.

## 3. ADVERSARY — R2

- **"Refusing candidates shrinks the pool and titles fall under the floor."** The real risk, and the
  #630/#631 class. Mitigation: these clauses refuse a MALFORMED ASSEMBLY, and the search has other
  combinations — but this MUST be proven, not assumed. If any design cannot reach 68 once the clauses
  are in, STOP and report rather than loosening them.
- **"The comma rule over-fires on a legitimate comma."** Golds do use commas. Scope the clause to a
  comma BETWEEN a garment noun and its own modifier, not commas generally. Test a gold with a
  legitimate comma as the negative control.
- **"Nine ship exits, not two."** The adversary enumerated: locked-regen per-child restore
  (`route.ts:1783`), PATCH per-child (`:2419`), lock-title (`:94/127/163`), push title-override
  (`pushExecutor.ts:444/4326`), IH/Feeds heal (`:1236/3088`). `verdictForAssembledTitle` binds the
  pipeline doors; the seller-typed exits legitimately bypass it (a human typed it). **Exit 8 —
  a manual title becoming a GOLD and redefining the judge — is a REAL and separate hazard: file it,
  do not fix it here.**
- **"A fixture cannot reproduce `shape` (live DB golds) or the LLM council draft."** True, and it is
  why R1 failed. These clauses are PURE STRING PREDICATES — no `shape`, no LLM, no live-only input.
  That is the strongest argument for this layer over R1's.

## 4. APPROVAL

PO signs off, then `approved: true`, then implement.
