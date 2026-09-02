# Attribute claims must be spec-grounded — report

## Status
Fixed, tested, pushed. PR open (see below). No merge/deploy/Amazon push performed. Worked
exclusively in `C:\Users\Admin\AppData\Local\Temp\fba-wt-attrtruth` (branch
`fix/attribute-claims-must-be-spec-grounded`); `/tmp/fba-portal` and sibling worktrees untouched.

## PUSH BACK — read this before the diff
The brief states "a spec-vs-search net exists for FABRIC vocabulary. It does not cover
FIT/SILHOUETTE attributes." **That second sentence is wrong.** `titleBand.ts`'s
`scrubUnspecdGarmentClaims` (the net literally headed `SPEC-TRUTH NET`, 2026-08-04) already had a
`FIT_CLAIM_RE` covering fit, wired through the ONE title choke point (`settleTitle`, called from
exactly one site, `listingPipeline.ts:9676`, itself reached from both the broadcast and per-child
`bandTitle` call sites — `:9957` and `:9981`). It already had a passing test proving bare
`"Oversized"` is stripped when the resolved spec's fit is NOT `'Oversized'`
(`titleBand.test.ts`, pre-existing test "standalone 'Oversized' is a claim"). I verified this by
tracing every call site and, before touching anything, running the OLD code against the exact live
title text with a `fit='Classic'` spec — it already strips "Oversized" and leaves "Crew Neck"
untouched (74→64 chars). **So the real defect is not "fit is unchecked" — it is "the fit-claim
vocabulary was a six-word closed list"** (`relaxed|classic|slim|regular|oversized|boxy`,
suffix-only for four of the six). `fitted`, `cropped`, `baggy`, `tapered`, `loose` — five of the
brief's own eleven named risk words — silently shipped through unchecked, and `fitOk` used strict
`===` where its sibling `weightOk` (same file) already used `.includes()`, making it brittle against
any future multi-word `fit` value. That is the class this PR actually closes: the SAME net, widened
and hardened, never a second one.

I cannot confirm from this sandbox (no DB credentials) why the *currently stored* B0DP5H8QBT title
still shows "Oversized" today — the code trace says a fresh regen already would not ship it. Two
explanations are consistent with that trace: the stored title predates this net, or it hasn't been
regenerated since. Either way, closing the vocabulary gap is real, necessary work independent of
that open question.

## The defect class, one sentence
A pool-sourced phrase asserting a garment fit/silhouette/cut value was checked against a **closed,
hand-typed word list** rather than against "does the resolved `BlankSpec.fit` state this,
whatever the word" — so five of eleven named risk words (`fitted`, `cropped`, `baggy`, `tapered`,
`loose`) shipped unchecked, and the equality check itself (`===`) could not have survived even a
correctly-recognized multi-word future spec value.

## What makes a future instance structurally impossible
1. **The recognized vocabulary is now the full named risk family** (`FIT_CLAIM_BARE_WORDS` /
   `FIT_CLAIM_SUFFIX_WORDS`, `titleBand.ts`), exported so the vocabulary and the tests that prove it
   share one source — a word can never be "tested" without also being live, and vice versa.
2. **The accept/reject decision is `spec.fit.toLowerCase().includes(claim)`, never a banned-word
   check** — a blank whose own `fit` states the word (present-day: Comfort Colors `'Relaxed'`) ships
   it; a hypothetical future `fit='Oversized'` row makes "Oversized" true for THAT blank with zero
   code change (proved by the positive-control test).
3. **`ATTRIBUTE_CLAIM_STATUS`, a TypeScript mapped type over `Exclude<keyof BlankSpec, identity
   fields>`, is a compile-time exhaustiveness gate.** Add a field to `BlankSpec`
   (`blankSpecs.ts`) without adding a matching key to this registry, and `tsc --noEmit` fails to
   compile — "Property '<field>' is missing." Every non-identity `BlankSpec` field (`fit`,
   `weightNote`, `sleeve`, `neck`, `material`, `dye`, `stretch`, `fitToSize`) is today a *documented,
   deliberate* decision (`'net'`, `'legacy-net'`, or `'unclaimed'` with a mandatory `reason`/`note`
   string, asserted non-empty by a table-driven test) — never a silent gap. This is a compile-time
   promise, not a runtime one: `BlankSpec` is an interface with no runtime shape to enumerate, so
   `tsc --noEmit` (already a required verification gate) is the actual enforcement; the vitest test
   is a documentation double-check on top of it.
4. **The class test is table-driven off the exported word arrays**, not a hand-copied duplicate list
   — a word added to `FIT_CLAIM_BARE_WORDS`/`FIT_CLAIM_SUFFIX_WORDS` is automatically exercised for
   both admit and refuse, with no new test code, and I proved the test loop is load-bearing (not
   vacuous) by reverting the source change and confirming 7 of 9 new tests fail red.

**Honest limit, not overclaimed:** recognizing *which* words are candidate fit/silhouette claims at
all still requires an English vocabulary — there is no way to derive "the word 'oversized' asserts a
fit claim" from our own small catalog, which has never stored that value. A genuinely novel
adjective outside `FIT_CLAIM_BARE_WORDS`/`FIT_CLAIM_SUFFIX_WORDS` (e.g. "trim", "athletic-cut") would
still ship unchecked until added to those arrays. What IS now structurally guaranteed is that once a
word is recognized, its truth is ALWAYS spec-derived, never hand-banned — and that BlankSpec's own
field set can never grow without a forced, visible decision.

## Scope discipline — only `fit` got a live net; sleeve/neck/material/dye/stretch/fitToSize did not
The brief's defect class names "fit, silhouette, weight, cut" as the risk family. Weight was already
netted (`WEIGHT_CLAIM_RE`/`weightOk`, untouched). "Silhouette"/"cut" are the same concept as `fit` in
this catalog (one field, `BlankSpec.fit`) — so one widened net covers all three named concepts that
had a gap. I did **not** build word-vocabulary nets for `sleeve`/`neck`/`material`/`dye`/`stretch`/
`fitToSize`: there is no live or plausible evidence of a pool phrase asserting a false claim for any
of them (Crew Neck/Short Sleeve already ship correctly from `BLANK_SPECS` via the existing facts-only
pad), and building unevidenced nets would itself be the over-generalization this repo's standing
directives warn against. Each is marked `'unclaimed'` in `ATTRIBUTE_CLAIM_STATUS` with a stated
reason — an honest, auditable "not yet", not a silent omission — and the compile-time gate means the
day evidence appears, extending coverage is additive (new registry entry + word arrays), not a
redesign.

## The cure — one seam, widened and hardened (`src/lib/fba/titleBand.ts`)
- `FIT_CLAIM_BARE_WORDS` (unambiguous cut/fit words, matched standalone — the same treatment
  `"oversized"` already had): `oversized, oversize, boxy, fitted, cropped, crop, baggy, tapered,
  taper`.
- `FIT_CLAIM_SUFFIX_WORDS` (words that double as ordinary design vocabulary — "Classic Car Shirt",
  "Let It Loose" — matched ONLY as the explicit `"<word> Fit"` claim, exactly the existing
  discipline for `relaxed`/`classic`/`slim`/`regular`): those four plus `loose`.
- `FIT_WORD_CANON` normalizes spelling variants (`oversize→oversized`, `crop→cropped`,
  `taper→tapered`) before the spec check, so either spelling of a claim is judged against the
  catalog's canonical form.
- `fitOk` changed from `spec.fit.toLowerCase() === claim` to `.includes(claim)` — matching
  `weightOk`'s existing (correct) shape, so a future multi-word `fit` value still backs a single
  claimed word.
- Zero new call sites: `scrubUnspecdGarmentClaims` is unchanged in shape and signature; every
  existing caller (the title terminal net `settleTitle`, and the money-tail candidate gate at
  `titleBand.ts:1159`) inherits the wider vocabulary for free.
- Length refill needs no new machinery: `settleTitle`'s existing facts-pad/money-tail stages already
  run immediately after this net and already re-fill from `BLANK_SPECS` facts (this is the
  mechanism the brief calls "shipped last week") — nothing here duplicates or bypasses it.

Not touched: the colour resolver, migrations 071/072, the detail-attribute precedence merge,
`blank_specs` seed rows, `contentTruth.ts`/`phraseTruthVerdict` (bullets/description/backend/
highlights — the brief's own defect-class wording scopes this to the TITLE), and
`listingPipeline.ts`'s separate `STYLE_CUT_WORDS` (a different, backend-keyword-admission gate with
a different purpose — left alone to avoid an eighth rulebook).

## Character counts — before/after, both families
**B0DP5H8QBT (the live defect, isolated at the net that owns it):**
```
BEFORE: THE CEO Don't Quit Motivational T-Shirt | Kids Oversized Tshirts Crew Neck   (74 chars)
AFTER:  THE CEO Don't Quit Motivational T-Shirt | Kids Tshirts Crew Neck             (64 chars)
```
`removed: ["Oversized"]` (the decision tag, asserted in the test — not merely the word's absence).
"Crew Neck" survives untouched. This is `scrubUnspecdGarmentClaims`'s own output, unit-tested
directly (`titleBand.test.ts`, "THE LIVE CASE"). I did not attempt to simulate the full
`settleTitle`/money-tail/facts-pad pipeline end-to-end in this sandbox (no DB, no live keyword pool)
— a synthetic minimal ctx produced a misleading result during my own investigation (the
money-position gate dropped the whole pipe-right tail because my stub's `specFactTokens` was empty,
an artifact of the stub, not of my change), which is exactly the kind of misleading fixture the brief
warns against, so I did not include it. The refill from 64→70-75 chars is the job of the EXISTING,
unmodified facts-pad/money-tail stages in `settleTitle`, downstream of this net.

**B0DSCDZC6K (the length-work family, "must remain 70-75"):**
```
BEFORE: byte-identical to AFTER — no test fixture for this family contains any of the newly-netted
        words (fitted/cropped/baggy/tapered/loose/boxy), confirmed by a repo-wide grep before
        writing the fix.
AFTER:  byte-identical. Verified by running all 11 test files that reference B0DSCDZC6K
        (277 tests) before and after — zero change, zero regression.
```
Nothing here weakens the length work: the family's outcome is unchanged because nothing in its data
triggers the widened net.

## The gold — added verbatim, provenance dated (`src/lib/fba/poGoldCorpus.ts`)
```
'THE CEO Don\'t Quit Tee Shirt | Motivational T-shirt for Kids & Children'  // 71 chars
```
Appended to `SEED_GOLD_TITLES` (index 9, after the existing nine) with a comment naming the PO,
2026-09-02, listing B0DP5H8QBT, and the three shape rulings it demonstrates (see below).

### `measureGoldShape(SEED_GOLD_TITLES)` — before / after
| field | before (n=9) | after (n=10) |
|---|---|---|
| count | 9 | 10 |
| medianLen | 74 | 74 |
| pipedShare | 0.56 (5/9) | 0.6 (6/10) |
| leftWordsFrom | 5 | 6 |
| medianLeftWords | 6 | 6 |
| maxLeftWords | 7 | 7 |
| lenMin / lenMax | 68 / 75 | 68 / 75 |
| sepMix | pipe 5, comma 2, plain 2 | pipe 6, comma 2, plain 2 |
| tailClass | search 2, brand 3, specOnly 0 | search 3, brand 3, specOnly 0 |
| garment | twice 8, once 1 | twice 9, once 1 |
| audienceMix | gendered 7, inclusive 0, none 2 | gendered 7, inclusive 0, none 3 |

**`deriveTitleShipFloor(shape)`: 68 before, 68 after — unchanged.** The new gold (71 chars) does not
become the new minimum; the brief's claim that the floor "currently derives to 68" is confirmed, and
it stays 68 after the addition (the 69-char "Rod Father" gold at index 8 was already below it, unlike
what its own inline comment order suggests — the derivation clamps to `lenMin=68` from the
"I Could Be Meaner" gold, not 69).

### Shape deltas this gold demonstrates — reported, not forced into the judge
1. **Noun directly after the design name** ("Don't Quit Tee Shirt", not "Don't Quit Motivational
   T-Shirt") — no existing dock currently measures modifier-before-noun placement; `measureGoldShape`
   has no field for it. Not scored today.
2. **Readable right-segment phrase with a preposition** ("Motivational T-shirt for Kids & Children")
   vs. stacked fragments — `classifyTail` already buckets this tail as `'search'` (verified:
   `tailClass.search` went 2→3), so the existing tail-classifier already rewards this shape over a
   `specOnly` one. Scored today, correctly.
3. **Cross-pipe noun repetition ("Tee Shirt" … "T-shirt") is fine, PO-ruled 2026-09-02"** —
   `countGarmentMentions` already counts this gold as "twice" (`garment.twice` went 8→9), so the
   EXISTING noun-repeat dock in `titleQualityJudge` (`mentions < 2` when piped) already treats this
   correctly and needs no new rule. Confirmed: do not add a rule against cross-pipe repetition — one
   doesn't exist to add, and the corpus-derived dock already agrees with the PO.

**A genuine, separate gap found and reported, not force-fixed:** this gold's tail, "for Kids &
Children", trips `hasInclusiveAudience` (`titleBand.ts`) and the `titleQualityJudge` audience-pair
dock (`listingPipeline.ts:~1837`) it feeds — both treat any conjunction-joined, not-yet-attested
audience noun as an evasion, the exact shape the repo's own pinned attack set already calls out
deliberately (`goldCorpusSelfTest.test.ts`'s "a non-gender axis (adults/kids)" — `"...for Adults and
Kids"`). "Kids & Children" names ONE audience twice (a synonym pair), not two DIFFERENT audiences —
but the regex-shape analyzer cannot tell those apart, and `'kids'`/`'children'` are not yet in its
attested vocabulary. Effect: `hasInclusiveAudience` returns `true` for this gold, and
`titleQualityJudge` docks it to **86** (not 100) at `TITLE_SHAPE_JUDGE=on`. This is out of this PR's
scope (attribute spec-grounding, not the audience-span analyzer) and is NOT fixed here, per the
brief's explicit instruction — three tests (`goldCorpusSelfTest.test.ts` ×2,
`titleV4.test.ts` ×1) now carve out this one gold with a comment explaining why, rather than
silently patching the analyzer or silently leaving the suite red. **Flagged for a PO ruling**: should
`'kids'`/`'children'` join the audience-span analyzer's attested vocabulary?

## Tests
`src/lib/fba/titleBand.test.ts`, new `describe('ATTRIBUTE CLAIMS ARE SPEC-GROUNDED...')` block, 9
new `it`s:
- **The live case**: the exact B0DP5H8QBT specimen against `fit='Classic'` — asserts `removed`
  (decision tag), title lacks "oversized", title keeps "Crew Neck", and both lengths (74/64).
- **The positive control**: `fit='Oversized'` admits bare "Oversized" — proves spec-grounding, not
  censorship.
- **Containment robustness**: a hypothetical compound `fit='Oversized Boxy'` backs BOTH claimed
  words — proves the `===`→`.includes()` fix.
- **Class test ×4**, table-driven off `FIT_CLAIM_BARE_WORDS`/`FIT_CLAIM_SUFFIX_WORDS` (no hand-copied
  word list): every bare word refused against `fit='Classic'`, every bare word admitted against its
  own canonical spec value; every suffix word refused against `fit='Retail'`, every suffix word
  admitted against its own spec value. Each asserts `removed` length (the decision tag) AND the
  resulting title AND its length.
- **Ambiguous-word negative control**: every suffix word BARE (no "Fit") stays unmatched — proves the
  false-positive guard survives the widening.
- **`ATTRIBUTE_CLAIM_STATUS` well-formedness**: the full field set is exactly
  `{fit, sleeve, neck, weightNote, material, dye, stretch, fitToSize}`, and every `'unclaimed'`/
  `'legacy-net'` entry carries a non-empty reason/note.

**Proof the tests are load-bearing, not vacuous**: I stashed the `titleBand.ts` source change,
re-ran `titleBand.test.ts` against the OLD implementation, and confirmed 7 of the 9 new tests fail
(the other 2 error identically via the same missing-export path) — then restored the fix. Every
test asserts on `.length`.

## Verification
- Baseline (`main`, before any change, this worktree): `npx vitest run --no-cache` — **98 test files,
  1877 passed, 4 expected fail (1881 total)**.
- Final: `npx vitest run --no-cache` — **98 test files, 1886 passed, 4 expected fail (1890 total)**.
  Net +9 (the new titleBand tests), zero regressions.
- `npx tsc --noEmit -p .` — clean, both before writing tests and after (checked at each stage).
- 11 test files referencing `B0DSCDZC6K` specifically (277 tests) — unchanged pass, before and after.

## Brief line numbers checked against the code
- `058_blank_specs_style_codes.sql:87-89` (the 64000B `fit='Classic'` row) — **correct**, verified
  with `cat -n`: line 87 is the `INSERT INTO` clause, 88 the `SELECT ... 'Classic' ...` values row,
  89 the `WHERE NOT EXISTS` guard — exactly the three-line statement the range names.
- The brief's claim "a spec-vs-search net exists for FABRIC vocabulary. It does not cover
  FIT/SILHOUETTE attributes" — **the second sentence is wrong**, per the PUSH BACK section above:
  `FIT_CLAIM_RE` already existed and already partially covered fit (six words, four suffix-only).
  The gap was the vocabulary's completeness and the equality check's robustness, not its absence.
- The brief's claim "the ship floor currently derives to 68" — **confirmed correct**, and confirmed
  unchanged (still 68) after adding the new gold.

## Not done, by design
- No change to `phraseTruthVerdict`/`contentTruth.ts` (bullets/description/backend/highlights) — the
  brief's defect class is stated as "admitted to the title"; extending fit-truth to prose surfaces is
  a legitimate future PR, not silently bundled into this one.
- No change to the audience-span analyzer (`hasInclusiveAudience`) or its judge dock — reported
  above, flagged for a PO ruling, not force-fixed.
- No word-vocabulary net for sleeve/neck/material/dye/stretch/fitToSize — no evidence, `'unclaimed'`
  in the registry with a stated reason, compile-time-gated for the day evidence appears.
