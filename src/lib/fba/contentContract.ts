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
} as const
