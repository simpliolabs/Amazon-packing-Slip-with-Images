# GOAL / PLAN / ADVERSARY — the 75-char title cap buys a field no shopper sees

approved: false   <!-- PO sets true. Never self-approve. -->

**This spec exists because the PO said "Raise it" and "Test" — and because the research turned up
something larger than a band number: the reason our titles are short is not Amazon's title rule.**

## 0. THE FINDING — verified live on 2026-09-05, not inferred

`TITLE_BAND_HI = 75` is documented in our own code as **"Amazon's, externally enforced"**
(`titleBand.ts:114`) and as a **"2026-07-27 policy"** under which **"Amazon auto-rewrites item_name
over 75"** (`pushExecutor.ts:502`). **Both statements are false for apparel.** Live best-sellers, read
from the DOM today:

| ASIN | Live `#productTitle` chars | Variations? | Rewritten? |
|---|---|---|---|
| B0C6TV2Z2Z | **111** | no | no |
| B0B8Z2K3NR | **110** | **yes (twister)** | no |
| B0D968BB8S | **88** | yes | no |

8 of the 20 sampled best-sellers exceed 75. Amazon displays them in full and appends the variation
colour to the composed name (`... Long Sleeve Shirt Dark Gray`) — the very composition behind 100476.

**What 75 actually is.** Error 100476 reads, verbatim in our own source (`SELLER_PROFILE.md:148`,
`contentContract.ts:85`, `productDetailAttrs.ts:543`):

> *"Provide an Item Name that is 75 characters or less TO USE ITEM HIGHLIGHTS"*

**75 is not a title cap. It is the price of admission to Item Highlights.** We shortened every title
in the catalogue to keep a field which — and this is the part that decides the spec — **renders
nowhere a shopper looks.**

**The controlled test, on the PO's own populated listing (B0DSCDZC6K), today.** All four Item
Highlight phrases probed against the live DOM:

```
probes_found_in_html_title:        ["relaxed unisex fit","cotton blend fabric",
                                    "crew neck design","cuff sleeves"]   <- browser tab only
probes_found_in_visible_centerCol: []
probes_found_in_visible_body:      []                                    <- NOWHERE on the page
```

This is stronger evidence than the competitor sample, where an empty field would also render nothing:
**our field IS populated, and it appears in the browser tab and nowhere else.**

**Two further defects surfaced by the same read, both live right now:**

1. **The tab describes a DIFFERENT DESIGN than the page shows.** `<title>` says `THE CEO Billionare
   Coming Soon Sweatshirt ...` while the live `#productTitle` is `THE CEO Motivational Entrepreneur
   Sweatshirt | Long Sleeve Crewneck Gift` (72 chars).

   **CORRECTION — this is NOT staleness, and I first recorded it wrongly.** A follow-up read settles
   the mechanism: `canonical = /dp/B0DSCDZC6K`, but `displayedASIN = B0DSB467TB`. The `<title>` is
   built from the **requested** ASIN's own item_name + item_highlights; the body renders a
   **different variation child** Amazon auto-selected. Nothing is stale — the two surfaces are
   showing two different children of one family. The SEO consequence is still real and arguably
   worse: **Google indexes this URL as "Billionare Coming Soon" while a shopper landing on it sees
   "Motivational Entrepreneur".** (The competitor "staleness" in the research doc §4 was read the
   same way and is likewise **unconfirmed** — variation selection fits that evidence equally well.)
2. **It carries a falsehood** — `relaxed unisex fit` on blank 18000, which is **Classic** fit. This
   one is unaffected by the correction above: the string is B0DSCDZC6K's own, and it is untrue.

## 1. GOAL

**What we are achieving:** the title ceiling is set by evidence about what wins in our category, and
the Item-Highlights dependency becomes a **priced, PO-owned trade** instead of an unexamined constant.

### THE TRADE, stated honestly — the PO's call, not mine

| | Keep item_name <=75 (today) | Allow up to ~110 |
|---|---|---|
| Item Highlights | works — **125 indexed chars, invisible** | **lost entirely** (100476) |
| Visible title | 70–75 chars | up to ~110 (category median **88**) |
| Category fit | below every sampled sweatshirt winner | matches the winning band |
| Indexed text | 125 invisible + 75 visible | ~110 visible, 0 invisible |

**I will not pretend this is a free win.** Amazon's own help text (quoted at `contentContract.ts:70`)
says item name and item highlights *"are both inputs for search, and one isn't prioritized over the
other"* — so the 125 chars we would give up **are indexed**. On raw indexed volume, staying at 75 is
ahead. The case for going long rests on the extra title characters being **visible, click-driving,
and near-certainly weighted higher**, plus matching every sweatshirt winner sampled.

**THE FACT THAT DECIDES IT, and it is cheap to get (plan step 1):** if the Item-Highlight phrases are
**already covered by the backend search terms**, those 125 chars are largely **redundant indexing**
and the trade tips decisively toward the long title. If they carry keywords nothing else covers, the
loss is real and the answer may be to stay at 75 and simply fix the field. **Measure, then choose.**

### FINAL PRODUCT — observable

| Property | Requirement |
|---|---|
| Ceiling | evidence-set, not folklore; whichever ceiling ships, its comment states what it IS |
| `pushExecutor.ts:502` | the false "Amazon auto-rewrites over 75" comment is corrected either way |
| Shape | tested, not assumed: brand-first vs slogan-first, pipe vs no separator, noun density |
| Truth | every added character is a fact from `blank_specs` or the design — length is never bought with a lie |
| Floor | no design falls under `TITLE_SHIP_FLOOR()`; a raised ceiling must not licence a longer FALSE title |

**Non-goals.** Not deleting Item Highlights (its own spec fixes the content). Not touching bullets,
description, or push queueing.

## 2. PLAN — per karpathy-dev-principles

**Think before coding. Nothing here is a code change until step 1 answers the question.** Steps 1–3
are measurement; the PO rules; only then does code move.

1. **Price the trade.** For B0DSCDZC6K, count the Item-Highlight tokens NOT already covered by that
   child's backend keywords, using the existing `isCovered` from coverage-core — no new predicate.
   *Verify:* a number, per child. High redundancy ⇒ going long is nearly free. Low ⇒ a real cost, reported.
2. **Confirm the constraint before trusting it in either direction.** Our 75 belief came from a real
   100476 on a SKU whose stored title was **73** (`productDetailAttrs.ts:537`) — Amazon measured a
   longer composed name. **100476 measures the COMPOSED name, not item_name**
   ([[item-highlights-100476-not-stored-title]]). Any ceiling must be stated against the composed name.
   *Verify:* longest composed name in the family = item_name + longest colour + size.
3. **Shape question, for the PO.** The gold corpus uses `|` and leads with the brand; **85% of winners
   use no separator and 55% lead with the slogan.** These disagree. **The golds are the spec
   ([[rulings-must-live-in-the-scorer]]), so this is a question FOR the PO, not a rule I change.**
   *Verify:* gold shape and market shape presented side by side; the PO rules.
4. **Only then:** move the constant, correct the false comments, re-derive `measureGoldShape`.
   *Verify:* every design >= floor and <= new ceiling; no design gains a character that is not a fact.
5. **Live gate:** regen B0DSCDZC6K; the PO reads all six.

## 3. ADVERSARY

- **"The judge is calibrated on ~72-char golds."** The real killer. `TITLE_SHIP_FLOOR()` derives from
  `measureGoldShape()` over the PO's corpus; raise the ceiling to 110 and **every title diverges from
  the corpus the judge scores against**, producing long titles that score WORSE. **A ceiling raise
  without new longer golds makes the judge fight the change.** Either the PO writes 2–3 long golds, or
  the raise stays near the corpus. Do not move the number and hope.
- **"Losing Item Highlights is hard to undo."** Not permanent, but re-earning it means shortening
  every title again and re-pushing 34 SKUs. Price the round trip before the first push.
- **"More characters = more room for lies."** The #630/#631 class, three times now. A bigger band
  means a bigger pad, and the pad is where untrue vocabulary entered before. **The truth net must be
  proven at the new length BEFORE the ceiling moves** — truth and band are one contract
  ([[truth-and-band-are-one-contract]]).
- **"20 listings is not a market."** Correct. They are Amazon's own best-seller ranks — the best
  available proxy — but they differ in brand equity, ads and review count, **none of which the title
  explains.** Do not attribute their rank to their title length.
- **"Correlation is not causation, and this is the biggest hole in the spec."** Winners may run long
  titles *despite* it. **Nothing here proves a longer title sells more.** The honest posture is the
  PO's own word: **Test** — change one family, hold the rest, read the outcome.
- **"Amazon could enforce 75 tomorrow."** The 2026-07-27 note in our source may be a real announcement
  merely unenforced on these listings. Whatever ships must **fail SAFE**: a 100476 on push, or a title
  returned rewritten, is a revert signal and must be DETECTED — not discovered months later by
  reading a browser tab, which is exactly how the stale tail above survived.

## 4. APPROVAL

PO signs off, then `approved: true`, then implement. **Steps 1–3 are read-only measurement and may
run now under `GPA-EXEMPT: research`.**
