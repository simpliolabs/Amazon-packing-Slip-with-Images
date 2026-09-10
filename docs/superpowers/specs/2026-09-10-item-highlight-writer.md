# GOAL / PLAN / ADVERSARY — an Item Highlight WRITER, per child, under a provenance net

approved: true   <!-- PO 2026-09-07 verbatim "2+3" (writer + lower floor); PO 2026-09-10 verbatim "A: go" on building the writer, after the per-child experiment. The floor half shipped (#677, min 97). This is the writer half. -->

## 0. WHY NOW, AND WHAT THE EXPERIMENT PROVED

The PO's original complaint, verbatim, on reading the live line:
> *"Crewneck Sweatshirts Women, Fall Sweatshirts for Women, Graphic Crewneck, 50% Cotton / 50% Polyester, Classic Fit — THIS READS AWFUL! Where is the humanizer?"*

Everything built since made this field **safe** — per-design, truthful, non-repeating, refused rather
than truncated, provably so across 51 designs. **None of it made the field READ well**, because the
producer is a phrase assembler: it can only PICK whole pool rows, never re-word. A picker's ceiling
is a comma list.

**The per-child experiment (2026-09-09) settled the architecture question.** Setting the family lean
to `lean_female` unblocked exactly one design, and the six were judged independently:
`DQG` composed `Fall Sweatshirts for Women, Cute Crewnecks, Graphic Crewneck, Classic Fit, Unisex
Fit, Long Sleeve, Piece-Dyed Fabric` while five siblings held on their own reasons. **Per-child
writing works.** What that line also shows is the ceiling: it says *"for Women"* and *"Unisex Fit"*
in one breath, repeats the garment noun, ends in the jargon *"Piece-Dyed Fabric"*, and says nothing
about *Don't Quit*. That is not a bug to patch. It is what picking produces.

**And the field is shopper-visible** — DOM-probed 2026-09-07, ~366×60 px under the h1 on our own
listings. Readability has a value it was assumed not to have when the LLM was retired on 2026-08-21.

## 1. GOAL

**What we are achieving:** each design's Item Highlight is written as one readable, keyword-dense
line whose every claim is traceable to an admitted fact — and a line that cannot be made both
readable and true is HELD, never shipped.

### FINAL PRODUCT — observable

| Property | Requirement |
|---|---|
| Readable | a human line, not a comma-joined keyword list; no internal contradiction; no jargon a shopper would not use |
| About the design | it names or evokes THIS design, not just the garment |
| Provable | **every content token traces to an admitted source** (see §2) — the writer may RE-WORD, never INVENT |
| Bounded | one line per design, within the contract's length band, within the repeat budget |
| Fail-closed | N attempts, then HOLD with a named reason. An unvetted line never ships. |
| Bounded cost | one call per design per regen, hard-capped retries, no call at all when the design would HOLD anyway |

**Non-goals.** Not a new truth vocabulary. Not a second net. Not a change to the floor (97 stands),
the repeat budget, or the hold semantics. Not the title path.

## 2. PLAN — the load-bearing idea is PROVENANCE, not a blocklist

**The lesson the retirement taught, and why "add an LLM under the nets" was wrong twice.** The
2026-08-21 retirement was correct *at the time*: the writer emitted beige "casual apparel", leaked a
trademark ("salt life"), and produced keyword lists. Those were caught by lexicons — and **a lexicon
is a finite list; free text is not.** `trademarkGuard.ts:42` gained "salt life" the day it leaked.
That asymmetry cannot be closed by adding more words to a blocklist.

Research also proved most existing gates judge a POOL PHRASE, not arbitrary prose. A writer walks
through every phrase-scoped gate untouched.

**So the net is not a blocklist. It is provenance.**

1. **Admit first.** Build the design's ADMITTED SET exactly as today: truth-filtered pool phrases
   (already passing `phraseTruthVerdict` for THIS design), the blank's own spec facts, and the design
   identity (name + vision theme). This is the same filtering the composer does — reuse it, do not
   fork it.
2. **The writer re-words the ADMITTED SET only.** It is given those facts and asked for one natural
   line. It is told plainly it may rephrase and reorder but may not add a fact.
3. **Judge the OUTPUT, token by token.** Every content token of the returned line must trace to the
   admitted set (after the existing fold), or be a function word. A token that traces to nothing is
   an invention → reject. This is the `title-coherence-architecture` provenance-allowlist idiom,
   applied to a line instead of a fill fragment.
4. **Then the existing deterministic gates, unchanged**, on the final bytes: repeat budget, length,
   trademark, celebrity, the seam's own classifier. The writer sits UNDER them, not beside them.
5. **Retry with the violation named**, bounded. Then HOLD.

**Sequencing — and this is not optional.** The reverted Phase 2/3 branch (`feat/ih-phase23-wip` @
`c466225`) carries the line-level truth net this writer needs. It was reverted for three specific
design errors, each of which must be fixed BEFORE the writer is wired, not after:
- **the `material-lie` rule judged only a MARKED composition claim** and thereby steered the producer
  into the unmarked spelling of the same lie;
- **the push-path scrub shipped an under-floor line** — its floor check was conditioned on a drop the
  net itself had made;
- **the push seam asserted `designSeasons: []`**, which would have made every legitimately on-season
  family unpushable.

Phase A of this work is redoing that net correctly. Phase B is the writer on top of it.

## 2a. AMENDMENT 2026-09-10 — provenance is judged per SEGMENT, against whole units

*Why.* Review A2 (`.superpowers/sdd/2026-09-10-ih-writer/phase-a-review-2.md`) measured that
token-level provenance (§2 step 3 as first written) cannot stop recombination. In "Girl Dad Tee for
Girls" every token folds back to the design name, so token provenance admits it. And the regex net
behind it misses 26 of 34 lines a fluent writer could plausibly emit. Adding words to that net is
the lexicon treadmill §2 already rejects.

*The rule, replacing §2 step 3:*
1. The admitted set is a set of UNITS, not a bag of words: the composer's own pool candidates for
   this design; the blank's spec-fact renderings; the brand phrase and the sanctioned wear fact when
   they apply; and the design identity (its name as stored, plus its vision phrases, each passing
   `phraseTruthVerdict`).
2. **Atomic units are used whole.** Identity, spec facts, brand, wear fact, and any unit carrying a
   number or "%" may be reordered or inflected but never split. The writer cannot pull "Girls" out
   of "Girls Trip" or "100%" out of "100% Machine Washable".
3. **Pool units may be used in part** (dropping words from a shopper phrase usually weakens it),
   but every segment is re-judged on its own by `phraseTruthVerdict`, and a PARTIAL segment is
   judged WITHOUT the design-own-word exemption. The exemption justifies a word only inside the
   phrase that carried it, which is what rejects "Girls" lifted out of "Dad of Girls Shirt".
4. Words between segments come from a CLOSED glue list of function words that carry no product
   claim. Negations, quantifiers, purity words and gendered pronouns are never glue.
5. The line then goes through the SAME tail as the composer's line (repeat budget, content rules,
   line truth net, floor door): one function, not a copy.

*Consequence.* The writer can say nothing the picker could not have admitted, re-judged piece by
piece. That property is what makes it safe, and it is why the net rounds stop chasing spellings.

*Fail-closed, refined.* After the retry cap, the design gets the composer's OWN result: an
already-vetted line, or its named HOLD. Flag-on is therefore never worse than flag-off, and an
unvetted line still never ships. Hold semantics are unchanged.

*Cost, refined.* No call for an unrated pool (PO ruling) or zero admitted pool units. Designs the
picker held for want of a repeat-free fill ARE eligible: joining admitted facts with glue words is
exactly what a picker cannot do. That is B0DSCDZC6K, where 5 of 6 designs hold.

*Rollout.* `IH_WRITER` = off | shadow | on, default off. Shadow writes and logs but ships the
composer's result, so the PO reads real lines before anything changes.

## 2b. AMENDMENT 2026-09-10 (writer review) — the writer returns an ARRANGEMENT, not text

*Why.* The writer review (`.superpowers/sdd/2026-09-10-ih-writer/phase-b-review.md`) built 16 new
fluent lies, and 12 passed. Every one came from the PARSER that reads the writer's free text back
into admitted units:
- reordering and glue inside an atomic unit: "Girl Dad Shirt" → "Dad Shirt for Girls";
- partial use dropping a negation, a hedge or a relation: "No Polyester Feel" → "Polyester Feel",
  "Soft Cotton-Like Feel" → "Soft Cotton Feel", "Gift For Dad Of Little Ones" → "for Little Ones";
- numbers swapping inside a unit: 52/48 → 48/52.

Tightening that parser rule by rule is the treadmill again.

*The rule, superseding §2a rules 2-4.* The writer returns a JSON ARRANGEMENT: an ordered list of
admitted unit IDs and glue tokens from the closed list. Code renders the line. Every unit is rendered
verbatim, with its own words, order and numbers. The only permitted change is the number (singular or
plural) of a garment head noun. A unit is used at most once. There is no model text for provenance
to parse, so provenance holds by construction. The rendered line then passes the ONE tail and the
readability check, as before.

*Bound.* A lie can reach the line only if it is itself an admitted unit, which is the identical
phrase the picker would ship with the flag off. The writer's safety therefore equals the picker's.
Closing the picker's own admission gaps is the FILED admission-oracle programme, not the writer's
job.

*Readability ceiling.* The writer can choose, order and join approved phrases and name the design.
It cannot re-word inside a phrase. Shadow mode shows the PO whether that is readable enough before
anything ships.

## 2c. AMENDMENT 2026-09-10 (review B2) — a closed arrangement GRAMMAR: relations attach only TRUE spec facts

*Why.* Review B2 (`.superpowers/sdd/2026-09-10-ih-writer/phase-b2-review.md`) showed that
arrangements of admitted units still compose lies, because the GLUE and the ADJACENCY between
units create relations that no unit carries:
- "Keep It Pure" abutting "Soft Cotton Feel" reads as a purity claim on a blend;
- "with Deep Pockets" invents a feature;
- "in Pink Lemonade" invents a colour;
- "for Little Man" and "for Girls" invent an audience.

§2b's Bound ("a lie reaches the line only if it is itself an admitted unit") was false. Meaning is
compositional.

*The rule. These are the only legal joins:*
1. **Abutment** (no glue) is allowed only when the RIGHT-hand unit is a garment-noun unit:
   "<design name> Sweatshirt", "<pool phrase> Tee".
2. **List joins** between any two units: `,` `and` `&` `—` `|`. A list asserts nothing between its
   items; it is the picker's own shape.
3. **Relation joins** `with` / `in` (optionally followed by `a`/`an`) may introduce ONLY a
   spec-class unit: a blank spec fact, the brand phrase, or the sanctioned wear fact. A relation
   therefore only ever attaches a TRUE fact of this product.
4. No other glue exists between units (for/of/from/to/on/the/your/that/this are removed), and there
   is no glue at the start or end of the line.
5. Identity units are the design name as stored, plus vision phrases of 2+ words. Each must pass the
   truth oracle, the trademark door and the celebrity door at admission.
6. When the composer's line needs the brand (`brandPick`), the arrangement must carry the brand
   unit.

*Bound, restated, and now true by construction.* Every clause of a writer line is one of:
- one admitted unit;
- a list of admitted units (the picker's shape);
- a design name or pool phrase followed by a garment noun;
- a unit with true spec facts attached.

The writer's residual risk equals the picker's: the FILED admission gaps.

*Readability ceiling.* Lines such as "Don't Quit Sweatshirt with Long Sleeve and a Classic Fit —
Fall Sweatshirts for Women, Cute Crewnecks & Graphic Crewneck". Review B3's value lens measures,
before merge, whether 97-125 characters is reachable for each design. After merge, shadow mode shows
the PO real model output.

## 2d. AMENDMENT 2026-09-10 (review B3 panel) — the writer meets every contract through its OWNER's predicate

*Why.* The four-lens panel (`phase-b3-review-{truth,compliance,wire,value}.md`) confirmed the
design. The grammar reaches 97-125 characters for all 10 designs measured, with thousands of legal
arrangements, and the lines read as sentences. For example, "Business B*tch Sweatshirt with Long
Sleeve and a Classic Fit, Girl Boss Crewneck and Funny Work Sweatshirt", where today's line is
"Crewneck Sweatshirts Women, Graphic Crewneck, Funny Work Sweatshirt, Mind your Business, Classic
Fit, Unisex Fit".

Every Blocking finding was a SEAM, where the writer checked a copy of a contract instead of the
contract itself:
- Amazon's flat cap of 2, instead of the push seam's absolute no-repeat;
- whether `brandPick` happened to be exposed, instead of the composer's `needBrand`;
- a prompt that omitted rules the validator enforces.

*The rule.*
1. **An accepted writer line ships exactly as rendered.** It passes through the tail byte-identical,
   and it must be pushable by the push seam's OWN classifier (`classifyStoredIhLine`). A line the
   tail would cut, or the seam would refuse, is rejected before acceptance, with the reason named.
2. **Brand** is keyed on the composer's `needBrand` on every exit. The brand unit's class follows
   its ORIGIN: the fixed spec phrase is spec-class, and a pool-sourced brand phrase is a
   pool-class unit (required, list-joined only).
3. **Identity is the design name only.** Vision phrases describe the artwork and read as product
   claims ("100% Organic", "Made in America", "Embroidered Floral Patch"). They reach the line only
   if they are also composer pool candidates. Claims carried by the design name itself are
   TITLE-BOUNDED: the PO-approved title already carries the same words.
4. **Every adjacent pair of units** is also judged by the truth oracle, as rendered.
5. **The prompt's rules are GENERATED from the validator's rule registry.** A rule cannot be
   enforced without being taught.
6. **A regen-level deadline** bounds the writer's wall time. When it passes, the composer's result
   stands.

Part 1's compose change against `150778c` (96 rows) is intended. "Polyester Blend Comfort" on the
100% cotton Gildan 64000 is a lie, and an unresolved blank backs no composition claim. From here on,
the flag-off baseline for writer differentials is `974cb1a`.

## 2e. AMENDMENT 2026-09-10 (B4 panel) — the joins, the shape, and what a relation does NOT bound

*Where this stands.* The truth lens found ZERO Blocking at `7a05570`. What remained were contracts
still judged by the writer's own copy, rules enforced but not taught (a 22-44% first-call pass rate),
and wiring.

*Refinements to the grammar:*
1. **Abutment is legal only after the IDENTITY unit.** `<pool unit><garment head>` manufactures a
   style, cut, feature or size claim that no unit carries: "Cream of the Crop Top", "Test Tube Top",
   "Money in My Pocket Tee", "No Sweat Shirt". After a pool unit, a join is required.
2. **The brand unit is list-joined only**, whatever its origin, and never takes `number`. "Shirt with
   Comfort Colors Tee" reads as a second garment; "Comfort Colors Tees" reads as a multi-pack.
3. **Span truth is judged inside a comma clause**, across every contiguous sub-span, and never across
   a comma. The tail already owns clause scope and line scope, and crossing a comma made the
   PO-sanctioned "Can be worn as Oversized" unusable while the composer ships that same clause.
4. **Readability has one shape:** a line needs at least one relation clause (`with` / `in`) and at
   most one list section. A keyword list has no relation clause at all, which is exactly the PO's
   complaint.
5. **A rule is enforced only if it is taught.** Every rule sentence in the prompt, its violation
   message and its check read the same constants, and a fidelity test fails when they drift.

*What rule 3 does NOT bound.* A relation attaches a TRUE fact of this product; it says nothing about
the SUBJECT it hangs that fact on. "Cozy Nights Tee with a Classic Fit, Brushed Fleece Lining in 100%
Ring-Spun Cotton" ships because the picker itself admits "brushed fleece lining" on that blank. That
is the admission oracle's gap, and it is FILED, not the writer's.

## 3. ADVERSARY

- **"The writer will hallucinate a spec."** Provenance makes that a rejection, not a hope: a token
  tracing to nothing fails. The failure mode that remains is *recombination* — two admitted facts
  joined into a false implication ("heavyweight" + "tee"). The truth net must judge SEGMENTS, not
  only tokens, which is precisely what the reverted Phase 3 was for.
- **"It will cost money on every regen."** Bounded: no call for a design that would HOLD on supply
  anyway, one call per design otherwise, hard retry cap. Measure and report cost per family.
- **"It will produce the beige style again."** The 2026-08-21 failure was a writer given nothing but
  the garment. This one is given the DESIGN — the identity vision already extracts. If it still
  writes beige, that is a scorer problem, and the description generator's `scoreDescription` → 85 →
  retry loop is the working analogue in this repo. Copy that shape; do not invent a new one.
- **"We are optimising a field on a listing with zero sales."** True, and it is still right: the same
  producer runs for every family, and the field is shopper-visible. But price it as content hygiene.
- **"This is the fifth round on this subsystem."** It is. The circuit-breaker question was asked and
  answered: the previous rounds built the SAFETY the writer requires and proved it at scale. This is
  the first round that changes what the field SAYS.

## 4. WHAT STAYS PO-GATED

The Amazon push. Credits. The catalogue split.
