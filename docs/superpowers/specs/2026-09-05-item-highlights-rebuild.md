# GOAL / PLAN / ADVERSARY — Item Highlight is an SEO surface, not conversion copy

approved: true   <!-- PO 2026-09-05: "A/B: GO" (IH truth-fix); 2026-09-06: "it shouldnt be [design-blind] as we gave it VISION"; "proceed with full /superpowers:subagent-driven-development" -->

**REVISION 2 (2026-09-05).** R1 was written to make this field "copy that converts, laid out below
the title." **Market research plus the PO's own live listing proved that premise false**, so R1 is
superseded rather than amended. What changed:

- 20 top-ranked apparel listings examined: **no Item Highlight renders on the page** — not on the PDP,
  not on best-seller rows, not on search cards.
- **Verified on the PO's own populated listing** (B0DSCDZC6K, pushed 2026-07-23): the string appears
  ONLY in the HTML `<title>` — the browser tab and what Google indexes:
  > `Amazon.com: THE CEO Billionare Coming Soon Sweatshirt | Long Sleeve Pullover Crewneck | cotton blend fabric, relaxed unisex fit, crew neck design, cuff sleeves : Clothing, Shoes & Jewelry`
- The visible **"Top highlights"** panel on the PDP is a DIFFERENT thing — Fabric type, Care
  instructions, Origin, Closure — sourced from the **Product Detail attributes**, which this week's
  work already fixed.

**So the PO's spec splits three ways, and each half already has a home:**

| PO asked for | Actual home |
|---|---|
| "About The Fabric" | **Product Details** → the visible "Top highlights" panel (already fixed) |
| "about the benefits", "help convert" | **Bullets** — already doing this well on the live listing |
| "SEO keywords", **"70% weight"** | **Item Highlight** → browser tab + Google. This spec. |

**The PO's 70%-SEO instinct was right. The "converts below the title" framing was the part that did
not survive.** Optimising this field for persuasion optimises a surface no shopper sees.

## 1. GOAL

**What we are achieving:** the Item Highlight is a truthful, non-repeating, keyword-dense SEO tail
appended to the title in the HTML `<title>` — and it stops carrying claims that are false.

**A live falsehood this must kill.** The shipped string says **`relaxed unisex fit`**. Blank `18000`
is **Classic** fit (verified on the live blanks page). That false claim is on Amazon today, in the
field Google reads.

### FINAL PRODUCT — observable

| Property | Requirement |
|---|---|
| Purpose | SEO tail for the HTML `<title>`. **Not** conversion copy. Never scored for persuasion. |
| Weighting | keyword-led, per the PO's 70% ruling |
| Truth | every claim provable from `blank_specs` or the design; **no fit/fabric claim the blank does not state** |
| Audience | no gendered term a design's audience does not support (same rule titles now use) |
| No repeats | no significant word twice — `Women, … Women` is a FAIL (stricter than Amazon's cap of 2) |
| Length | <=125; existing "MIN 85% of MAX 125" PO ruling stands |
| Per-design | **PO RULING 2026-09-05: PER-DESIGN, not one shared line** |

**PER-DESIGN, and why.** R1 surfaced that the 2026-08-21 "ONE shared line, design names stripped"
contract is *what forces the output generic* — a line true for six unrelated designs can only be
garment vocabulary. The PO delegated the call from the correction record; every ruling this session
moves per-design (audience, garment, titles, bullets, descriptions), and the machinery already exists
(`per_child_item_highlights`, migration 060; `buildItemHighlightsPerDesign`, `listingPipeline.ts:2471`).

**Non-goals.** Not conversion copy. Not touching bullets or Product Details (they own the visible
surfaces). Not changing hold logic or the never-borrow-another-design's-line invariant.

## 2. PLAN — per karpathy-dev-principles

**Think before coding.** R1 chose `itemHighlightComposer.ts`. **That was wrong**: the composer is
design-blind (zero `designName`/`designKey` references), so "about the design" is impossible there.
The design-aware layer is `buildItemHighlightsPerDesign` (`:2471`).

**Simplicity first.** The pieces exist — ranked pool phrases, `blank_specs`, design identity, and the
per-design plumbing. What is missing is (a) concept-level dedup and (b) the truth gates the titles
already use. **This is smaller than R1 implied.**

**Surgical.** `buildItemHighlightsPerDesign` + the composer's dedup. Not the push rails, not the
marker row (#668), not the hold reasons.

### Steps

1. **Kill the live falsehood first** — a fit/fabric claim must be provable from `blank_specs`.
   *Verify:* `relaxed` cannot appear for a `Classic` blank. RED against unmodified source.
2. **Concept-level dedup**, reusing the coverage core's existing folding (`women` == `Women` ==
   `women's`), not a new matcher.
   *Verify:* the two women's phrases can never both be selected.
3. **Per-design line** — each design's own ranked phrases and its own audience.
   *Verify:* six designs produce six lines; `BB` (`lean_female`) may say Women, unisex siblings may not.
4. **Audience truth**, reusing the title rule, not a second one.
5. **Live gate:** regen B0DSCDZC6K; six lines, each <=125, no repeats, no false fit, and the PO reads them.

## 3. ADVERSARY — R2

- **"Per-design breaks the push."** All three detail attributes are `scope:'broadcast'`
  (`productDetailAttrs.ts:89-92`) — ONE value per family at the push boundary. **Item Highlights is
  the documented exception (`pushExecutor.ts:778-779`, per-design push path).** VERIFY that before
  building; if it is not a real exception, per-design cannot ship and the PO must be told.
- **"Dedup starves the line below 110."** The pool is women's-skewed and the unisex net rejects most
  of it. If a design cannot reach the minimum truthfully, **HOLD and report** — do not pad with
  untrue attributes. That is the #630/#631 class, which has bitten three times.
- **"Six lines cost six pushes."** More Amazon writes, more 429 risk. Route through the existing
  push queue; do not add a parallel path.
- **"We are optimising a field nobody sees."** Correct — and it is still worth doing, because Google
  indexes it and it currently carries a lie. But it should be **priced as SEO hygiene, not as a
  conversion lever**, and the PO should know that before spending more on it.
- **"The tab shows a different child than the page."** VERIFIED on B0DSCDZC6K: `canonical =
  /dp/B0DSCDZC6K` but `displayedASIN = B0DSB467TB` — the `<title>` carries the REQUESTED ASIN's
  item_name + highlights while the body renders a sibling design Amazon auto-selected. **I first
  recorded this as "the tail went stale"; that was wrong** — nothing rotted, the two surfaces just
  show different children. It still means **Google indexes this URL under one design while shoppers
  landing on it see another**, which per-design lines make *better*, not worse: each child's tab
  would then describe that child.
- **"Regenerating with the title is still required."** Independent of the above: a highlight line
  derived from design + blank must be re-derived whenever either changes, or it will drift from the
  title it sits beside in the tab.

## 4. APPROVAL

PO signs off, then `approved: true`, then implement.
