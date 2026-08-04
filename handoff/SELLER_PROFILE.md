# SELLER PROFILE — THE CEO (canonical business rules)
Assembled 2026-08-03 from the full commit history (~1,100 commits), the encoded code rules, and the session memory record — 178 mined decisions, deduplicated. **This is the plain-English source of truth for every business decision the PO has made.** Where a rule is enforced in code, the pointer is given; if this document and the code ever disagree, flag it — one of them is wrong.
Seed for task #104 (PO-editable rulesets). Review once, correct anything, then it stands.

---

## 1. BRAND IDENTITY
- The brand is **THE CEO** (CEO® on packing slips). Every title **starts** with it — position 0, no exceptions (judge docks −20).
- The brand appears in the **title and brand attribute only**: never in description body prose (stripped, even inside quotes), never in backend keywords (the attribute already indexes it — the byte buys nothing).
- Garment-brand casing is authoritative from the spec table ("Comfort Colors", never "comfort colors").

## 2. GARMENT BLANKS & PRODUCT FACTS
- **Comfort Colors 1717** (confirmed): Relaxed fit, Short Sleeve, Crew Neck, midweight 6.1 oz garment-dyed, 100% Ring-Spun Cotton, Low Stretch, Runs Slightly Small. **The name IS a selling point** — it belongs in titles next to the money keyword.
- **Gildan 64000 Softstyle** (confirmed 2026-07-31): Classic fit, Short Sleeve, Crew Neck, lightweight 4.5 oz ring-spun. Material stated **without** a percentage (heathers are blends). **The name is NOT a selling point** — its facts feed copy, the word "Gildan" never appears in any customer-facing field. SKUs carry the style number (640002XL-…) as identification.
- **Spec beats search**: fit/weight/sleeve/neck/material come ONLY from the confirmed spec table, never inferred from keyword demand ("oversized" search volume does not make a relaxed tee oversized).
- **Weight truth**: pin the real fabric when the blank is known; claim NO weight when it isn't.
- **Production method**: garments are **printed**, never "screen-printed"/"silk-screened" (auto-rewritten to "printed").
- **Unisex truth**: the blanks are unisex — "women's fit"/"men's fit" fabricates a gender the garment doesn't have. Audience targeting ("for Women") is fine; fit-gendering is not.
- A new blank earns copy mentions only by being confirmed and added to the spec table (a PO confirmation like "Gildan 6400 - YES" is the trigger).
- **The spec table lives in the DATABASE** (2026-08-04, migration 053): `blank_specs` in Supabase is the authoritative catalog — adding/correcting a blank is **one SQL INSERT/UPDATE, no deploy**; affected listings heal on their next regen (reader caches 5 min). The two rows above are seeded byte-identically; the same rows exist in code (`src/lib/fba/blankSpecs.ts`) only as a fail-open floor if the DB is unreachable. `brand_in_copy=false` encodes the Gildan rule; `match_pattern` is a case-insensitive regex over title/attributes/productType/SKUs (`\b64000` deliberately unclosed so "640002XL" matches). A fact-starved short ship now names its cure: SHIP_CENSUS title/description floor lines carry `factsGap:"blank.unknown"` when an apparel run matched no blank.

## 3. TITLES
- **Hard law: ≤75 characters** (Amazon auto-rewrites longer, policy 2026-07-27). Golden band **70–75**. The push **refuses** a >75 title rather than truncating.
- **The 8 PO gold titles (2026-07-22) are the authority.** Canonical: `THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt` (72). Golds win over any legacy rule. Protected as test fixtures — no net may alter them.
- **Pattern A** (design-led, pipe ` | `, 6 of 8 golds): `THE CEO [Design Phrase] [Noun] | [Attr] [Category Brand] [Noun-variant] [for Audience?]`. Zero commas, zero dashes.
- **Pattern B** (front-load, for low-search designs): major category keywords first, design phrase LAST — e.g. `THE CEO Christian Tee Shirt Comfort Color I Will Praise Him in Every Season`.
- **Product noun ×2 with variety**: two DISTINCT surface forms ("Tee Shirt … Tshirt", "Cap … Hat") — binding decision: variety, exactly two, never fold distinct nouns to one; only exact repeats ("Tshirt, Tshirt") are violations.
- **No modifier stuffing**: Funny/Novelty/Retro/Cute/Vintage/standalone-Graphic/Farewell/Goodbye banned as decorators. Attribute pairs the PO uses are fine ("Graphic Shirt", "Bold Motivational", "Puff Embroidery").
- **Idiom expansion** (contextual): "Later Gator" → "See You Later Alligator" when characters allow.
- **Design-led**: a keyword enters the title only when grounded in the actual design; titles are product claims. Pads come only from facts — never pool terms, never adjectives. Facts exhausted → honest shorter title.
- Title carries **1–2 keywords max**; no variant attributes (size/color); seasonal terms only when the design IS the occasion.
- Title-Case; existing uppercase (THE CEO, TShirt) preserved.
- **A PO-locked title is the spec** — never regenerated, survives every audit; risky (trademark) locked titles get a warning banner, never a hard block.

## 4. AUDIENCE & GENDER
- Lean set (male/female/lean_male/lean_female) → the title MUST carry the matching tail ("for Women" / "Women's" / "Ladies"). "for Men and Women" is **never** correct on a leaned listing.
- Universal design → audience tail is OPTIONAL; never force gender; a product keyword outranks a generic audience phrase in the 75-char budget.
- **Closed relational lexicons** (PO verbatim): FEMALE carriers = {wife, girlfriend}; MALE = {husband, boyfriend}. Bare pronouns are deliberately NOT carriers ("He's Golfing" is a women's shirt).
- **Hard lean** drops opposite-gender keywords everywhere (backend included); **soft lean** keeps both (cross-gender gift traffic is real).
- **Widow format**: "{Hobby} Widow/Wife" designs — the wearer is the SPOUSE, not the enthusiast. Never "for golf-loving women"; correct: "for the golf widow whose husband is always at the course". These spouse compounds ("golf widow shirt") are the money niche and get seeded deliberately.
- A gift design naming the recipient ("Best Husband Ever" on a ladies cut) blocks the opposite tail.
- A gender word appears at most ONCE in a title.

## 5. KEYWORD PLACEMENT & BACKEND
- **Doctrine: backend is the overflow home.** Title = 1–2 money keywords; bullets = clean shopper prose (keywords only when natural, NEVER forced — bullets carry no coverage duty); description = facts + story; **backend = everything else** (synonyms, occasions, long-tail, misspellings). Coverage anywhere counts everywhere.
- Never duplicate a keyword in title AND backend (Amazon indexes a token once).
- **Backend bands**: 250-byte cap, fill to **240–250** ("why aren't we using the full 250?"), 220 strict floor, <190 = garbage. Per-color shade tails ~17 bytes on colored families (shared core 233). CRITICAL money keywords claim bytes first and are exempt from title-echo dedup.
- Banned backend filler: apparel/clothing/clothes/outfit/wear/fashion/trendy/stylish ("a promotional string, not keywords").
- **"Oversized" nuance**: never in visible copy (blank is Relaxed) — but allowed in backend (invisible indexing of real 636K/mo demand is not a claim).
- **Colors**: shared title/bullets carry NO color word; colors rank per-child via each child's own backend tail.
- **Seasonal**: strip only OFF-season terms — a Valentine design KEEPS "valentine" everywhere (its theme IS the holiday).
- **30 ranking-target seats**, one per search intent (no spelling-variant waste); theme-fit rated against a persisted PO-editable theme card; a thin niche design's own keywords are harvested and seat-reserved even at low volume.
- The 158→240 byte gap on thin designs is a **pool problem** — never "solved" by padding junk.

## 6. BANNED & PROTECTED TERMS (all published fields + research seeds)
- **Trademarks**: "World Cup"→"World Futbol Cup" (futbol per PO; keeps "cup"); "Super Bowl"→"Big Game"; FIFA/Olympics/NFL/NBA/MLB/NHL/NCAA dropped outright; ~60 team/college/franchise word-marks dropped from the pool (no "for [Brand]" framing exists for them). Generic descriptors (spain, jersey, football, cup) are NOT trademarks — never drop them.
- **Living people**: never ship a person's name (athletes, musicians, actors) — curated conservative list, enforced at generation AND push.
- **Competitor blanks** (Gildan, Bella+Canvas, Hanes, …): never in copy, never in backend — own blank exempted.
- **Competitor retail brands** (Nike, Adidas, Grunt Style, …): off-niche everywhere.
- **Off-niche classes**: wholesale/blank intent, activewear terms on casual tees, foreign-language terms, equipment nouns ("golf tees" the peg), wrong garment cut, dated public events (USA-250/semiquincentennial on non-patriotic designs — a public event is not the wearer's anniversary).
- **Soccer identity**: soccer ≡ football ≡ futbol (asymmetric: soccer→football yes, football→soccer never).

## 7. CUSTOMIZATION (Amazon Custom)
- Amazon does NOT expose enrollment in the Listings API (probed live) → **customizable is a seller declaration** (portal flag; toggle UI in progress).
- When TRUE: "**Personalized**" LEADS the title facts, personalization language is encouraged in bullets/description ("with your own text"), `personalized custom` join backend. Both stem families used deliberately (Personalized… + Customize…).
- When FALSE (the catalog default): the words are banned — a false claim is worse than a short title.

## 8. BULLETS · DESCRIPTION · ITEM HIGHLIGHTS
- **Bullets**: exactly 5, each **150–200 chars**: `ALL-CAPS 2-3 WORD BENEFIT HOOK - one complete sentence.` Hook is a real benefit, never a label; never starts with a dash; garment brand named once (when it's a selling point); design name woven in; quality over coverage — clean 776 beats stuffed 900.
- **Description**: **900–980 visible chars**, HTML with `<b>` + `<ul><li>`, grounded in real facts (fabric/weight/dye/fit/neck/sleeve) + design story + styling; no search-phrase prose, no brand in body, no internal jargon (seller/SKU/ASIN/listing/keyword/backend).
- **Item Highlights** (title_differentiation): ≤75 chars, 2–3 short benefit PHRASES (no sentences), customer-facing (never a keyword list), adds what the title lacks, no word repeated >2×, no promo language.

## 9. MULTI-DESIGN FAMILIES
- Each design group gets its OWN title/bullets/description; content anchors on the DESIGN (vision-read artwork), never the shirt color.
- **Couple sets** (two halves of one concept, e.g. Rude Potato + Sweet Potato): ONE shared title naming both + the concept, shared copy broadcast — strict detection so friend-group/family packs keep per-design content.
- A child ASIN always resolves to its parent — the family is the working unit.

## 10. SHIPPING & OPERATIONS
- **Nothing writes to live Amazon without explicit PO GO** — the PO personally clicks Ship. An approved plan is standing authorization for its phases; ship actions are the reserved stop.
- Pushes go to **BOTH FBA and FBM twin SKUs** per ASIN (+ parent SKU for titles); push is **UPDATE-ONLY** (never PATCH an offerless SKU — phantom-listing risk); all pushes route through the serial durable queue with the global 5-req/s bucket.
- **Verification is automatic** (PO verbatim 2026-06-13): cron verifies every push against live Amazon, re-ships until 100%, notifies only on major flags.
- A shipped section **locks for 7 days** ("settling") so scores can't nag; per-section override exists.
- Behavior changes ship **off → shadow → on** with live-regen evidence gates; scorer re-bases are announced, and the PO accepts truth-fix score movement (the 72→70 dip is a rubric fix signal, not a content problem).
- Jungle Scout budget: **950 billable calls/month** self-cap (50 under plan).

## 11. QUALITY PRINCIPLES (anti-Goodhart)
- Terminal nets pad **only from product facts** — never pool terms, never invented adjectives. A number made green with junk is a failure.
- The scorer never reads the ship door's violations; a rising "repaired" count is a producer regression signal.
- Preserve-prior fires only when the fresh output is empty/unparseable OR strictly worse — and a contaminated prior is never "better".
- Honest claims: the optimizer controls **indexing/relevance only** — "indexed for", never "will rank #1".
- The PO's qualitative gate: padded copy must read like a product, not filler — the PO reads samples and the read outranks the numbers.

## 12. OPEN PO DECISIONS (pending — answer any time)
1. Gildan 64000 **stretch / fit-to-size** values (push Amazon attributes; currently blank).
2. **Colour-synonym lexicon** for per-child backend tails (deferred to your gate).
3. **Misspelling lexicon** (which misspellings to index deliberately).
4. Seven title-policy fine points from the contradiction registry (Pattern B internal ordering; "Comfort Color" singular; gold #4 canonical bytes; and four smaller ones — presented on request).

---
*Update rule: when the PO states a new business decision in any session, it gets added here in the same turn the code changes — this document and the enforcement move together.*
