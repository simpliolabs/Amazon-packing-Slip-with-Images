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
export const CONTENT_CONTRACT = {
  title: {
    hardCap: 75,            // capTitle75 ceiling — Amazon auto-rewrites >75 after 2026-07-27
    floor: 50,              // validateTitle under-length trigger
    goldenBandLo: 70,       // scoreTitleQuality golden band low
    goldenBandHi: 75,
    // 68 CONTRADICTED goldenBandLo:70 — a 68-69 char title was below the band yet never triggered
    // the humanizer, so the contract disagreed with itself (task #147, found by seam mapping).
    humanizerTrigger: 70,   // humanizeTitleTo75 fires below this — == goldenBandLo by construction
    fillTarget: 73,         // deterministic fill-to target
  },
  bullets: {
    count: 5,               // exactly 5 bullets
    min: 150,               // BULLET_MIN_CHARS — generator floor, terminal-net enforced
    max: 200,               // BULLET_MAX_CHARS — capBulletLen ceiling
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
