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
