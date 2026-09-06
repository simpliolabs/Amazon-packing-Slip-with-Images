/**
 * Content Contract — the single source of truth for every content length/byte band and the
 * scorer↔generator reconciliation targets (content-spine Step 1, 2026-07-22).
 *
 * Today many of these numbers are duplicated as raw literals across ~40 sites in listingPipeline.ts
 * and syncListingContent.ts, and the SCORER and the GENERATOR disagree for three fields (documented
 * below as `scorer*` fields). This module makes the values one place. Step 1 re-points only the 5
 * canonical exported constants; the scattered raw literals are migrated in later steps. Step 4 will
 * flip the scorer* fields to equal the generator floors — until then the tripwire tests lock them.
 *
 * NOTHING in this module has side effects; it is pure data, safe to import anywhere (no cycles).
 */
/**
 * AMAZON'S REAL item_name LIMIT, read from the LIVE product-type schema — not from a comment.
 *
 * On 2026-09-05, `GET /api/fba/listing-optimizer/push-content?parent_asin=B0DSCDZC6K&debug=1
 * &field=details&detail_field=Item%20Name` returned, for productType SWEATSHIRT (ATVPDKIKX0DER):
 *
 *   "value": { "title":"Item Name", "maxLength": 200, "minLength": 0,
 *              "examples":["Robert Graham Men's Maya Bay Short Sleeve Classic Fit Shirt, Cranberry, X-Large"] }
 *
 * Amazon's own worked example there is 78 characters — over the 75 this file used to call a cap.
 * Live best-sellers in our category confirm it: B0C6TV2Z2Z ships 111 chars, B0B8Z2K3NR 110 WITH a
 * variation twister, B0D968BB8S 88 — none rewritten, none truncated on the PDP.
 *
 * To re-derive this for any attribute rather than trusting this comment, hit that debug branch with
 * `detail_field=<schema title>` and read `rawSubschema`. That is the method; this number is only its
 * cached result.
 */
export const AMAZON_TITLE_MAX = 200

/**
 * WHY WE SHIP FAR UNDER Amazon's 200, and what the 75 actually is.
 *
 * Amazon error 100476 reads, verbatim: "Provide an Item Name that is 75 characters or less TO USE
 * ITEM HIGHLIGHTS". It is a PRECONDITION FOR A DIFFERENT FIELD — never a cap on item_name. Every
 * "Amazon rejects/auto-rewrites a longer title" claim in this repo traced back to this one error
 * being misread, and it cost ~13-36 characters of the highest-attention text on every listing in
 * the catalogue, in the category where winners write LONGEST (sweatshirt best-seller median: 88).
 *
 * NOTE what buying that precondition actually gets: measured across all 34 children of B0DSCDZC6K,
 * the Item Highlights line contributes 4-5 uniquely-indexed tokens (classic, cotton, polyester,
 * sweatshirts, fit) that the backend keywords do not already carry — and the field renders ONLY in
 * the HTML <title>, never anywhere a shopper looks (DOM-probed on the live listing: present in
 * document.title, absent from #centerCol and document.body.innerText).
 *
 * `hardCap` still equals this today so behaviour is byte-identical. Raising it is Phase 4 of
 * docs/superpowers/specs/2026-09-05-title-ceiling-and-shape-implementation.md, and MUST come after
 * the silent-reversal paths are closed — otherwise the 100476 auto-heal walks the raise back one
 * SKU at a time, invisibly.
 */
export const ITEM_HIGHLIGHTS_TITLE_PRECONDITION = 75

export const CONTENT_CONTRACT = {
  title: {
    // NOT Amazon's cap — Amazon's is AMAZON_TITLE_MAX (200, from the live schema). This 75 is the
    // price of keeping Item Highlights (error 100476); see ITEM_HIGHLIGHTS_TITLE_PRECONDITION.
    hardCap: ITEM_HIGHLIGHTS_TITLE_PRECONDITION,
    floor: 50,              // validateTitle under-length trigger
    goldenBandLo: 70,       // scoreTitleQuality golden band low
    goldenBandHi: 75,
    // 68 CONTRADICTED goldenBandLo:70 — a 68-69 char title was below the band yet never triggered
    // the humanizer, so the contract disagreed with itself (task #147, found by seam mapping).
    humanizerTrigger: 70,   // humanizeTitleTo75 fires below this — == goldenBandLo by construction
    fillTarget: 73,         // deterministic fill-to target
    // THE HARD SHIP FLOOR (PO ruling, title-floor-baseline task). NOT `floor` (50, above) — that is
    // `validateTitle`'s unrelated, older under-length trigger. NOT `goldenBandLo` (70) — that is the
    // QUALITY target `scoreTitleQuality` aims for. `shipFloor` is the CORRECTNESS minimum: the
    // truth+band terminal net (`settleTruthBand`/`enforceTitleTruthBand`, titleBand.ts) may ship a
    // title under the golden band (65-69, honest but short of target) but must never ship shorter
    // than this — a title that short reads as broken/truncated to a shopper, the defect class that
    // reverted PRs #646 (29 chars) and #647 (42 chars; that attempt's floor constant existed but sat
    // on a code path the shipped title did not take — see titleBand.ts's TITLE_SHIP_FLOOR doc).
    shipFloor: 65,
  },
  bullets: {
    count: 5,               // exactly 5 bullets
    min: 150,               // BULLET_MIN_CHARS — generator floor, terminal-net enforced
    max: 200,               // BULLET_MAX_CHARS — capBulletLen ceiling
    // The bullets band had a FLOOR and a CEILING but no TARGET, so "150-200" was the only number
    // any prompt, scorer or net could reference — and an open range is exactly where the documented
    // ~20-30% LLM char-count undershoot lands (arXiv 2508.13805, cited at listingPipeline ~:7680).
    // Live B0DSCDZC6K measured 166/150/160/161/178 = 815 of a possible 1000 characters: legal on
    // every gate, and 18.5% of an INDEXED field thrown away. `fillTarget` is the number the
    // generator prompt asks for, the metric scores proximity to, and the terminal expander seeks —
    // the same role `title.fillTarget` (73) and `keywords.fillTarget` (240) already play. (2026-08-21)
    fillTarget: 195,        // bullets golden-band target — prompt + scorer + terminal expander
    scorerTooShort: 80,     // syncListingContent b.length<80 dock — DIVERGES from min (Step-4 reconcile)
  },
  description: {
    floor: 900,             // DESC_MIN_CHARS — generator floor, reExpand-enforced
    ceiling: 980,           // capDescriptionVisible default
    scorerApparelFloor: 700, // syncListingContent apparel desc dock — DIVERGES from floor (Step-4 reconcile)
  },
  keywords: {
    byteCap: 250,           // fillBackendToBudget hard cap
    fillEarlyReturn: 244,   // fillBackendToBudget early-return
    coreTargetColored: 233, // coreByteTarget with color tail
    coreTargetColorless: 244,
    minLegacy: 190,         // backendDegradeGate BACKEND_MIN_LEGACY
    minStrict: 220,         // backendDegradeGate BACKEND_MIN_STRICT + scoreBackend green-band low
    // The 240-250 golden band had NO constant anywhere in the repo — byteCap/minLegacy/minStrict are
    // all ceilings and floors, so "reach 240" was never expressible (task #147).
    fillTarget: 240,        // backend golden-band LOW edge — the number a fill must actually reach
    scorerCharDockLo: 100,  // syncListingContent backend .length<100 dock — DIVERGES (byte vs char) (Step-4)
    scorerCharDockHi: 200,  // syncListingContent backend .length<200 dock
  },
  /**
   * ITEM HIGHLIGHTS (SP-API `title_differentiation`) — Amazon's companion to the 75-char item_name.
   *
   * THE BUDGET IS 125, NOT 75 (raised 2026-08-10 on the PO's ruling, reversing PO 2026-07-19).
   * Amazon's own title-update FAQ states the 200 indexable characters are SPLIT between
   * "Item name (75 characters) and Item highlights (125 characters)", and that "Item name and Item
   * highlights are both inputs for search, and one isn't prioritized over the other". Capping at 75
   * therefore discarded 50 of 125 characters (40%) of an INDEXED, shopper-visible field on every
   * listing in the catalog.
   *
   * WHY IT WAS 75, and why that reasoning expired. The budget was ALREADY 125 and was cut to 75 on
   * 2026-07-19 because the 125-char version shipped a rambling ~120-char comma-sentence live
   * (B0FKKN8XKV) — see the original note at listingPipeline.ts. The rambling was the defect; the
   * budget was not. The other half of the rationale — "Amazon's field shows next to a <=75-char
   * title" — expired on 2026-08-10, when Amazon moved Item Highlights to display BENEATH the item
   * name on desktop and mobile.
   *
   * So the cure keeps what actually worked (short comma-separated benefit phrases, NO sentence
   * punctuation, customer-facing tone, never a keyword list) and restores the space.
   *
   * NOT TO BE CONFUSED WITH the item_name <= 75 DEPENDENCY: Amazon error 100476 is "Provide an Item
   * Name that is 75 characters or less to use Item Highlights". That is a rule about the TITLE and is
   * unchanged — every 75 in the title path and in the 100476 heal must stay 75.
   */
  itemHighlights: {
    max: 125,               // Amazon's stated Item Highlights budget — the hard cap, all nets
    fillTarget: 110,        // band LOW edge: aim 110-125 so the field is actually used, not merely legal
    min: 107,               // PO RULING 2026-08-21 verbatim "44 is NEVER approved, MIN 85% of MAX 125":
                            // ceil(0.85*125). An under-min line is NOT SHIPPABLE — the composer pads
                            // with TRUE spec facts or returns not-ready; it never ships short.
  },
} as const
