# Garment-repetition defect class — closed

## Status

Code complete, full suite green (baseline 96 files / 1804 passed + 4 expected-fail → final 97 files /
1828 passed + 4 expected-fail — the +24 are the new enumeration test, zero regressions, zero length
cost), `tsc --noEmit` clean. Committed on `fix/garment-repetition-class` (worktree
`C:\Users\Admin\AppData\Local\Temp\fba-wt-garmentdupe`), pushed, PR opened, CI checked. Not merged —
PO's call.

## THE DEFECT CLASS, in one sentence

Two title segments can assert the SAME garment concept in two different SURFACE FORMS (a plural vs
singular of the same word, or two distinct synonyms of the same class) and ship unflagged, because
`hasRedundantGarmentMention`'s own internal "same class + ≤1 char apart ⇒ collapse to one mention"
heuristic — meant only to let "Tee"+"Shirt" read as the compound "Tee Shirt" — is a POSITION proxy
that cannot distinguish a genuine two-word noun from an accidental collision of two unrelated
same-class words sitting next to each other.

## Root cause, verified before any edit

Reproduced both live strings against `main` (`hasRedundantGarmentMention` called directly, no other
code involved) before touching anything:

```
hasRedundantGarmentMention('Funny Work Shirts Shirt Long Sleeve for Women') → false   (WRONG)
hasRedundantGarmentMention('Mind Your Graphic Top Tshirt for Women')        → false   (WRONG)
```

`GARMENT_NOUN_RE` matches "Shirts" then "Shirt" (both fold to class `'tee'`) exactly one space apart;
the old adjacency exemption read that as the sanctioned "Tee Shirt" compound and silently merged them
into one mention. Same mechanism, same bug, for "Top"+"Tshirt".

Then I traced every call site of `verdictForAssembledTitle` in `titleBand.ts` (the function that owns
`titleHasDuplicateConcept` → `hasRedundantGarmentMention`) to check the brief's own open question —
"is `hasRedundantGarmentMention` even wired at the pool-segment exit, or is that the missing wire?"
It is wired, comprehensively: `enforceMoneyTail` (:1183, the exact path a pool keyword like "Funny
Work Shirts" ships through), the DFS refill search's per-candidate accept (:1616 in-band fast path,
:1647 per-branch verify), the prior-fallback truth check (:1684), and the settle-title finish
(:1858/:1875). The wire was never missing. The predicate it called was unsound. **The brief's own
"missing wire" hypothesis was WRONG** — see "brief lines that were wrong" below.

## The cure — structural, not a pair list

`src/lib/fba/contentTruth.ts`:

1. **`GARMENT_NOUN_RE`** gained `tee[\s-]?shirts?` as its own multi-word alternative — the same tier
   `tank[\s-]?tops?` and `hooded[\s-]?sweatshirts?` already occupy. "Tee Shirt" (and "Tee-Shirt" /
   "TeeShirt") is now captured as ONE regex match, not two, so the compound is recognized at the
   TOKENIZER, structurally, the same way every other genuine multi-word garment noun already is.
2. **`garmentNounClass`** folds the new compound's flattened form (`teeshirts?`) onto the same `'tee'`
   class every other tee spelling already resolves to.
3. **`hasRedundantGarmentMention`** — the position-based adjacency exemption (the `lastClass`/
   `lastEnd`/`adjacent` machinery) was deleted outright. With the one genuine compound now handled at
   the tokenizer, the function is now exactly what its own doc always claimed it was: any two
   SEPARATE matches of the same folded class within one segment — adjacent or not, a bare plural of
   the same word or an entirely different alias — are two mentions of one concept, full stop.
4. Both classes are now exported as **`GARMENT_NOUN_RE`** and **`garmentNounClass`**, plus a new
   exported table, **`GARMENT_NOUN_ALIASES`** (`Record<class, string[]>`), documented as the single
   extension point: add a future alias there once, and both a recognition check and the pairwise
   redundancy check extend to it automatically (see below).

## Why this makes a future instance structurally impossible

Every admission point that can ship a title already terminates in `verdictForAssembledTitle` →
`titleHasDuplicateConcept` → `hasRedundantGarmentMention`, and that function now reads the SAME
`GARMENT_NOUN_RE`/`garmentNounClass` fold every other truth check in `contentTruth.ts` shares (the
wrong-garment-noun rule, `dominantGarmentGroup`, `garmentGroupsIn`) — there is no second vocabulary
anywhere to fall out of sync. A future alias (a new plural, a hyphenated or glued spelling, a brand-
new synonym) is caught the moment it is added to `GARMENT_NOUN_RE`, with zero new code at any call
site — the redundancy check never enumerates strings, it only ever asks "have I folded this class
before in this segment?"

## The enumeration test — and how it fails on an unfolded alias

`src/lib/fba/garmentRepetitionClass.test.ts`, table-driven over `GARMENT_NOUN_ALIASES` itself (13
tee / 4 sweatshirt / 2 crewneck / 7 hoodie aliases today):

- **Recognition check**: every alias in the table must be matched whole-word by `GARMENT_NOUN_RE` and
  fold, via `garmentNounClass`, to the class the table claims. If a future PR adds `'jorts'` to the
  `tee` array without teaching `GARMENT_NOUN_RE` to match it, `[...('jorts').matchAll(GARMENT_NOUN_RE)]`
  is empty, `matches.length > 0` fails immediately, loudly, by name — the class is NOT silently
  unfolded.
- **Enumeration check (separated)**: every ordered pair of DISTINCT aliases within a class, dropped
  into one segment with filler words between them, must be flagged by `hasRedundantGarmentMention`.
  This is unconditional — no pair is exempt when non-adjacent, because non-adjacency was never a
  legitimate reason to allow a repeat.
- **Enumeration check (adjacent)**: every ordered pair, with NO separator, must ALSO be flagged
  **unless** the two aliases concatenate (`` `${a} ${b}` ``) into a string `GARMENT_NOUN_RE` itself
  matches as a single compound — that ground truth is read from the SAME regex under test, never a
  second hand-typed exception list, so it can't silently grow into a blocklist-in-reverse. A dedicated
  assertion (`recognisedCompoundsFound > 0` for the `tee` class) proves this exemption branch is
  genuinely exercised by exactly the "Tee"+"Shirt" pair and nothing else — it is not vacuously true.
- Both live specimens are pinned verbatim, asserting on the `reason: 'duplicate-concept'` field from
  `verdictForAssembledTitle` (not string absence) — proves the real ship-path branch ran.
- The pinned PO gold (`"THE CEO Alligator Tee Shirt | Comfort Colors TShirt for Women"`) is
  re-asserted here as untouched, and `hasRedundantGarmentMention('Tee Shirt')` is asserted `false`.
- The full B0DSCDZC6K family (`runTruthBandHarness()`, the same fixture `truthBandGate.test.ts` pins)
  is re-run and every one of the 7 rows is asserted 70-75 chars, plus a `console.log` reporting the
  6 designs' exact lengths for this task's report surface.

## A second, previously-unflagged instance this fix also closed

Running the full suite after the fix (before touching any test) surfaced exactly ONE failure, in the
pre-existing pinned gate `truthBandGate.test.ts`'s "THE SEVEN STRINGS": scope `ED` used to ship
`"THE CEO Entrepreneur Definition Sweatshirt | Graphic Sweatshirts Pullover"` — "Sweatshirts" +
"Pullover" are two different surface forms of the SAME sweatshirt concept, the identical defect class,
just never observed live (it shipped clean specifically because it too rode the same adjacency
exemption). With the exemption closed, the additive DFS search backtracked past that now-correctly-
rejected candidate to the next truthful one at the **same length**:
`"THE CEO Entrepreneur Definition Sweatshirt | Graphic Sweatshirts Crewneck"` (73 → 73 chars, still
70-75). I updated that one pinned literal with a comment explaining why, per that file's own stated
doctrine ("if any of these seven change, the change must be reviewed on purpose") — this IS that
review. No length was spent; this was a content correction the search's own existing combinatorial
backtracking absorbed for free.

I deliberately did NOT preemptively "fix" any other same-class adjacent pair I noticed while reading
(e.g. `truthBandHarness.ts`'s `PRIOR.BCS` fixture literally contains "Pullover Sweatshirt") — the full
suite proved that string is never actually verified through `verdictForAssembledTitle` in a way any
test depends on (the harness's search finds a better candidate first for every scope that fixture
feeds), so touching it would be scope creep with no defect to close. If a future regen ever forces
that literal fallback, the SAME fixed predicate will correctly flag it — nothing was carved out for it.

## Character counts — all 6 B0DSCDZC6K designs, after the change

From `garmentRepetitionClass.test.ts`'s own assertion against `runTruthBandHarness()` (live console
output, this run):

```
BB=74  BCS=73  DQ=70  ED=73  HD=72  MH=71
```

All 6 within 70-75. `ED` is the only one whose CONTENT changed (73 chars either way — see above);
`DQ` and `MH` are honest holds (kept the truthful PRIOR, unchanged by this fix); `BB`, `BCS`, `HD` are
byte-identical to before. No length was spent anywhere by this change.

## Baseline vs final test numbers

| | files | passed | expected-fail | total |
|---|---|---|---|---|
| **baseline** (`main` @ 109d8f1, before any edit) | 96 | 1804 | 4 | 1808 |
| **final** (this branch) | 97 | 1828 | 4 | 1832 |

Delta: +1 file, +24 passed, 0 expected-fail change, **0 regressions**. `tsc --noEmit`: clean, both
before and after.

## Brief lines that were wrong

- The brief's suggested "smallest correct cure" — *"determine whether `hasRedundantGarmentMention` is
  wired at this exit at all — if it exists and is simply not called on pool segments, that is the
  missing wire"* — was **wrong**. It is wired, comprehensively, at every ship exit
  (`enforceMoneyTail` :1183, the DFS search :1616/:1647, the prior-fallback check :1684, the
  settle-title finish :1858/:1875, the V4 shadow probe :2770 in `titleBand.ts`). The defect was never
  a missing call site; it was the predicate's own internal adjacency heuristic being unsound. No wire
  needed adding.
- Everything else in the brief — the exact live strings, the :373/:402 wrong-CLASS guard correctly
  not firing on a same-CLASS collision, the :295/:303 surface-token guards being individually
  insufficient (true, but by this file's own architecture they were never meant to be the terminal
  net — `verdictForAssembledTitle` is, and fixing it there is the documented single point of
  leverage), and the pointer to `hasRedundantGarmentMention`/`garmentGroupsIn` already being imported
  at `:32` — all verified correct against the actual file.

## Constraints honored

- No blocklist, no regex of specific pairs — the cure is one additive vocabulary entry
  (`tee[\s-]?shirts?`, same tier as two already-existing compounds) plus deleting a heuristic; the
  redundancy check itself enumerates nothing.
- Cross-gender veto, truth spine, ship floor: untouched (no edits to those code paths; full suite
  covering them stayed green).
- `blankSpecs.ts` and the colour resolver: untouched.
- CI Supabase-env trap: nulled at the top of `garmentRepetitionClass.test.ts`, restored in `afterAll`,
  matching the established sibling pattern (`garmentAudienceProducer.test.ts`).
