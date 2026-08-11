# TITLE BRIEF REBUILD — golds ARE the spec (2026-08-11)

**The PO's question, verbatim: "AGAIN, why rules and And NO Council and Judge having gold standards to build from?"**

**The one-line answer, measured:** the deterministic judge that picks every title scores the PO's own
canonical golds at **55/100** (gold #7: docked for Amazon-cap + "funny") and **80/100** (gold #9:
docked for being 69 chars + "funny") — while it scored the title the PO called "STILL BAD" at 80 and
its predecessor at 95. The hand-written rules dock the seller's taste and reward the defect. The
template at listingPipeline.ts:3429 defines the money position as `[Variant/Attribute]` and blesses
"Long Sleeve Shirt" as a positive example — the 2026-08-11 regression was the council OBEYING it.

This spec replaces the hand-written shape rules with the PO's own corpus, measured at runtime.
Produced by a 4-phase multi-agent build (21 contradictions inventoried; 3 independent brief designs;
judged; adversarially broken — 24 must-fixes distributed below). All numbers were MEASURED by
executing repo exports at HEAD 050a481, not asserted.

## The decisive attack that shaped this spec

An adversary wrote `THE CEO 2026 Soccer Cup Garment Dyed Crew Neck Tee | Comfort Colors Shirt` —
spec-stuffed garbage — and it scored **100/100 with zero problems** under the first draft of this
proposal, because NO predicate in the repo recognizes "crew neck" / "garment dyed" / "short sleeve"
as spec vocabulary (`isTitleWasteVocabulary` is literally two phrases). Every rule scoped to "the
money position" is bypassable by relocation. **Therefore PR-A (the spec lexicon + corpus
attestation) is the keystone and ships first.**

## Measured facts at HEAD (n=9 seed, the PO's verbatim 2026-08-11 list)

- len 69..78, median 74 — one gold UNDER our 70 floor, one OVER Amazon's 75 cap
- separators 5 pipe / 2 comma / 2 plain (pipedShare 0.56); live mine pipedShare 0.30 (n=23)
- piped lefts 4/6/6/8/10 → median 6, max 10 (leftWordsFrom 5)
- tails: 1 search-phrase / 6 brand-carrying / **0 spec-only**
- audience: 7 gendered / 0 "for Men and Women" / 2 none (gold #7's "for Men Women" is a DIFFERENT
  string from the banned "for Men and Women" — never fold them)
- attested vocabulary: graphic ×3, funny ×2, long sleeve ×1; unisex / classic fit / crew neck /
  short sleeve / novelty / retro / cute / vintage: **0**
- garment noun twice in 8 of 9 (adjacency-collapsed: "Tee Shirt" = ONE mention); once in Espana

## PR SEQUENCE

### PR-A — KEYSTONE: spec lexicon + corpus attestation + self-test (no behavior change)
1. `poGoldCorpus.ts`: extend `GoldShape`/`measureGoldShape` with `lenMin`/`lenMax`,
   `sepMix {pipe,comma,plain}` (counts), `tails[]` (verbatim separator-rights),
   `tailClass {search,brand,specOnly}` via new `classifyTail()`, `garment {twice,once}` via new
   exported `countGarmentMentions()` (adjacency-collapsed), `audienceMix {gendered,inclusive,none}`.
2. **Spec lexicon, two layers** (resolves the breaks' static-vs-derived disagreement): CATEGORY
   words (fit/sleeve/neck/collar/weight/fabric/dye/stretch…) are closed-class English — ONE
   exported static list, linguistic not catalog data. VALUES come from
   `blankSpecFactTokens(blankSpec)` where a blank is resolved. `classifyTail` + the judge + the
   brief all read the SAME two-layer predicate.
3. `attestedUse(titles, terms)` — a term is admissible only in collocations the corpus shows
   ("Funny Comfort Colors Shirt", "Funny Fishing", "Long Sleeve" in identity position ×1).
   Ban-by-default for zero-attestation spec words ANYWHERE in the title (position-independent —
   the attack was pure relocation).
4. `goldCorpusSelfTest()` — score every gold through the judge's own predicates; assert in tests
   that NO gold is docked by a taste rule (Amazon's 75 cap MAY flag gold #7 — ship rule, not taste).
   **Currently FAILS at HEAD (55/80) — that failing state IS the PO's answer; pin it as the before.**
5. NEGATIVE fixtures, must score strictly below every gold: the two attack titles and the three
   genuine B0GVV3XL4T rejects.

### PR-B — the brief: ONE builder, exemplars + measured numbers + genuine rejects
1. Extract to ONE `buildApparelTitleBrief(ctx)` called from all THREE sites (:3406 council, :3668
   humanizer, :6565 parent) — kills the triplicate drift. Parent differs only in its input block.
2. `goldSpecBlock(titles, shape, vocab)` replaces `goldBriefBlock`: verbatim tails + tailClass
   counts + attested/unattested vocabulary table. DELETE the three prose lines (:189-191) — every
   sentence becomes a measurement.
3. DELETE: the PATTERN A/B templates (all 3 copies), the attr-pair exemplar clause ("Long Sleeve
   Shirt" is NOT corpus-attested as a standalone pair), `audOpt = preferredAudience || 'Men and
   Women'` (prints the banned string as the default slot content), persona 2's hard "No pipe /
   design LAST" mandate (0 of 9 golds place the design last), the volume-gated Pattern-B switch.
4. The synthesized brief text (verbatim copy in `handoff/TITLE_BRIEF_FINAL.md`) with the break
   amendments:
   - Identity-position fact licence SCOPED to corpus-attested facts only (at HEAD: "long sleeve").
   - The attestation block is BINDING: zero-attestation spec words are inadmissible anywhere.
   - Rejects = the 3 genuine B0GVV3XL4T pairs with the PO's verbatim reasons ("crew neck can go on
     highlights", "short and sweet"). **NEVER list the old alligator gold as a reject — the seller
     REVISED it into another gold; it was never rejected. Fabricating a rejection event falsifies
     PO ground truth.**
   - The DB reject miner (`loadPoRejectPairs` over listing_change_log) is PR-D; it must filter out
     pairs whose before_value matches any gold or whose prior title_source was 'manual'.
   - Interpolation contract: the parent brief's garment-brand variable is `blankBrand`, not
     `attributePin`; deleting `aud` must also rewrite the AUDIENCE MODE comments at
     :3424/:3430/:3445, :3676/:3691/:3706, :6612 — or the brief renders "for undefined".
5. KEEP (real external constraints): Amazon 75 cap + error-100476 push refusal; brand position 0;
   the trademark clause (generated from TRADEMARK_RULES); AUDIENCE MODE REQUIRED when a lean is
   set; never "for Men and Women"; the parent no-design-names rule.

### PR-C — the judge: score the corpus, not the legend
1. Banned modifiers: membership derived from `attestedUse` (banned only when zero-attested), as
   (term, collocation) pairs — "funny" allowed in attested collocations, docked elsewhere. DELETE
   'fit', 'sleeve', 'style' from `TITLE_V2_ATTR_PAIR_NOUNS` (they grant the exemption to exactly
   the seller's banned vocabulary).
2. Length: DELETE the sub-70 docks (-30/-15); derive soft downward pressure from `shape.lenMin`
   (keep SOME floor pressure — the short-title class #147 returns on thin pools otherwise). KEEP
   the >75 Amazon dock unchanged.
3. Pipe bonus: `+5 hasPipe` → `Math.round(10 * (pipedShare - 0.5))` — a bonus only when the corpus
   actually prefers pipes.
4. MONEY-POSITION dock via `classifyTail` — one predicate shared by producer, scorer, and door.
5. Noun count via `countGarmentMentions` — today's regex double-counts "Tee Shirt" and only passes
   the Espana gold by accident.
6. Ceiling robustness: trimmed max (ignore a lone outlier >2 words above the runner-up) plus an
   admission filter in `loadPoGoldTitles` (brand-front required; drop rows >2σ length from the
   window) — one atypical lock must not raise the ceiling for the whole catalog with no deploy.
7. Apparel-gate the new judge terms (the multi-design parent path reaches the judge on
   non-apparel).
8. Humanizer: extension filler = a search phrase or a CORPUS-ATTESTED fact only; if none remains,
   return the title unchanged.

### PR-D — wiring + retirement
1. Thread `blankSpec` into the title producers (4 signatures: :6161, :8743, :8755, :8858 + :8854).
2. `loadPoRejectPairs` + route loading beside `loadPoGoldTitles` (:834) + `poRejects` on
   PipelineInput + the buildNicheParentTitle param.
3. DELETE `PO_GOLD_TITLES` (:1230). Move historical golds #4/#8 to a `HISTORICAL_GOLDS` export
   consumed by the self-test; get a recorded PO ruling before silently retiring gold #4's
   "for Men & Women" tail.
4. `/api/fba/title-golds`: return the new shape fields, tail classifications, the vocabulary
   table, and the reject pairs — the diagnostic endpoint and the brief must read identical numbers.

## ACCEPTANCE (mechanical, per PR)
- **A**: `goldCorpusSelfTest` green — zero golds docked by taste rules; both attack titles + all
  three rejects score STRICTLY below every gold. tsc + full vitest.
- **B**: rendered-brief snapshot test — no hand-typed shape rule survives in the output (grep the
  rendered brief for literal `70-75`, `Pattern A`, `Variant/Attribute`: all must return nothing).
- **C**: judge scores all 9 golds ≥ their pre-change scores; the rejected titles score strictly
  lower than every gold; the gold-beats-reject margin test (≥25) still holds.
- **D**: live regen on B0GVV3XL4T (single-design) AND a multi-design family; run
  `node scripts/check-title.mjs` on the returned bytes; the SHAPE_JUDGE log shows the corpus
  ceiling arriving from the DB mine.

## OPEN PO ITEMS (carried, not blockers)
- The 78-char gold (`I Could Be Meaner…`) exceeds Amazon's cap — trim or keep? The corpus keeps it
  verbatim either way; the push will refuse >75.
- `TITLE_RULING_OVER_FLOOR`: the 69-char Rod Father gold argues for ON; PO call (visible score
  cost until money keywords fill the space).
