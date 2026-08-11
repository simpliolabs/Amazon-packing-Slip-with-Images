# The synthesized apparel title brief (winner: DERIVED SPEC + reject-mining graft)

Produced 2026-08-11 by the council-from-golds build. Apply with the PR-B amendments in TITLE_BRIEF_REBUILD_SPEC.md (identity-fact licence scoped to attested facts; binding attestation; genuine rejects only — never the revised alligator gold).

```
=====================================================================
SYSTEM — replaces listingPipeline.ts:3421 (`sys`); identical at :3690, :6595
=====================================================================

You write Amazon apparel titles for ${brandName}. Below are the seller's own titles, a measurement of them, and — where available — titles this system generated that the seller DELETED and rewrote by hand. Write a title they would not rewrite. Match their SHAPE, never their words. Output ONLY the final title string — no quotes, no markdown, no explanation.

=====================================================================
USER — replaces listingPipeline.ts:3423-3458 (`usr`); identical at :3691-3715, :6596-6621
  ${goldSpec}    = goldSpecBlock(titles, shape, vocab)   [poGoldCorpus.ts]
  ${rejectBlock} = rejectPairBlock(pairs)                [empty string when none]
=====================================================================

${goldSpec}

${rejectBlock}
═══ THIS PRODUCT ═══
Brand: ${brandName}
Category: ${category}
Design phrase — must survive intact into the title: ${v2ExpandedDesign || '(none)'}
${idiomAltLine}Garment: ${garmentNoun}
${garmentBrandLine}${specFactLine}${audienceLine}Search phrases shoppers type, most valuable first:
${candidateList}
${mustLine}${nicheLine}
═══ WHAT GETS THE 75 CHARACTERS, IN THIS ORDER ═══
Every title above is TWO POSITIONS. A separator may or may not be drawn between them; the positions exist either way.

IDENTITY — opens the title. ${brandName} + the design phrase + a garment noun. Nothing else.
  Budget: ${shape.medianLeftWords} words is typical, ${shape.maxLeftWords} is the most the seller has ever spent (measured over ${shape.leftWordsFrom}). Count "${brandName}" as 2 words. Never exceed the maximum.
  A product fact may sit here as a modifier on the garment noun when it is confirmed above.

MONEY — closes the title. The phrase a shopper actually types: a search phrase from the list above, or the garment brand. The seller's titles use both.
  A product SPEC (fit, sleeve, neck, weight, fabric, "unisex") is not something a shopper types. A spec may MODIFY the phrase that earns this position; it may never BE this position, and it may never close the title alone.
  Then, only if it still fits: the audience tail — and only under AUDIENCE MODE: REQUIRED.

IF THIS DESIGN HAS NO SEARCH PHRASE AND NO GARMENT BRAND FOR THE MONEY POSITION: stop after the identity. A shorter honest title IS the correct output. Do not reach for a product fact, an adjective, a second separator, or a repeated noun to make it longer. Check the tail measurement above: the count of the seller's tails that are specs alone is the number of times they have taken that option.

Fabric, fit, neck, sleeve, weight and care are not lost when you leave them out — they are filed in Item Highlights. Synonyms and long-tail go to backend keywords.

═══ HARD LIMITS — external, never yield to anything above ═══
- ${hardCap} characters maximum, counted exactly. Amazon rejects a longer item_name (error 100476) and this pipeline refuses the push rather than trimming, so an over-length title ships nothing at all.
- "${brandName}" at position 0.
- ${wasteWordList} — these are stripped from your title after you write it, by the seller's own ruling. A title that leans on one comes back shorter and broken.
- ${tmClause}
- Every word must be true of THIS product. Search volume for a word does not make it true. Do not invent a motif, material, occasion or audience that is not given above; if the design is a saying with no object in it, do not give it one.

Write ONE title. Return only the title string.

=====================================================================
RENDERED ${goldSpec} AT HEAD (n=9 seed) — every number measured, none typed
=====================================================================

SELLER-APPROVED TITLES (9) — written or locked by hand by this seller, newest first. These are the specification. Do what they do; do not do what they never do.

  THE CEO Later Alligator Long Sleeve Shirt, Later Gator Comfort Colors Shirt
  THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup
  THE CEO Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men
  THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women
  THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women
  THE CEO Cupid Valentine Tee Shirt | Comfort Colors Graphic Tshirt for Women
  THE CEO I Could Be Meaner Tee Shirt | Funny Comfort Colors Shirt for Men Women
  THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women, Rodeo Shirt
  THE CEO The Rod Father T-Shirt Funny Fishing Mens Graphic Tee for Men

COUNTED FROM THOSE 9 — the seller's own numbers, not rules anyone wrote:
  • Length 69-78 characters, median 74. This is what they had material for, NOT a target.
  • Separator: 5 of 9 use " | ", 2 use a comma, 2 run as one phrase. All three are correct; a title with no separator needs no justification.
  • Identity segment (the 5 with " | "): median 6 words, most ever 10.
  • What actually closes these titles, verbatim:
      Later Gator Comfort Colors Shirt
      Puff Embroidery Cotton Twill Snapback Hat for Men
      Christian Shirts for Women
      Comfort Colors Alligator Tshirt for Women
      Comfort Colors Graphic Tshirt for Women
      Funny Comfort Colors Shirt for Men Women
      Comfort Colors Graphic Tee for Women, Rodeo Shirt
    Of those 7: 1 is a pure search phrase, 6 carry the garment brand, 0 are product specs alone.
  • Garment word named twice in 8 of 9, once in 1. "Tee Shirt" counts as ONE mention.
  • Ending: 7 of 9 name a gender, 0 say "for Men and Women", 2 name no audience.
  • Attribute words that DO appear, and the only company they are ever seen in:
      "graphic" — only as: Comfort Colors Graphic Tshirt / Comfort Colors Graphic Tee / Funny Fishing Mens Graphic Tee
      "funny" — only as: | Funny Comfort Colors Shirt for Men Women / The Rod Father T-Shirt Funny Fishing
      "long sleeve" — only as: Later Alligator Long Sleeve Shirt  (in the IDENTITY position, not the money position)
  • Appear in NONE of the 9: unisex, classic fit, crew neck, short sleeve, novelty, retro, cute, vintage, farewell, goodbye.
  • Brand at position 0: 9 of 9.

=====================================================================
RENDERED ${rejectBlock} — from listing_change_log, live; empty when none
=====================================================================

TITLES THIS SYSTEM WROTE THAT THE SELLER DELETED AND REPLACED BY HAND. The ✗ line is what was generated; the ✓ line is what they typed instead. Do not write anything that fails the way a ✗ line fails.

  ✗ THE CEO 2026 World Soccer Cup Unisex Classic Fit Fan Shirt | Short Sleeve
  ✓ THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup
    changed: dropped "Unisex", "Classic Fit", "Fan"; identity cut 11 words → 12-word single phrase; the spec tail became search language

  ✗ THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt
  ✓ THE CEO Later Alligator Long Sleeve Shirt, Later Gator Comfort Colors Shirt
    changed: "Long Sleeve" moved OUT of the closing position and into the identity; the close became design tag + garment brand + noun; separator pipe → comma

=====================================================================
INTERPOLATION CONTRACT — nothing about title SHAPE is a literal
=====================================================================
FROM THE CORPUS (poGoldCorpus.ts, all counted over the same array printed above, so numbers and examples can never disagree):
  ${goldSpec}       goldSpecBlock(titles, shape, vocab) — one function, three call sites
  shape.medianLen / lenMin / lenMax          length line
  shape.sepMix {pipe, comma, plain}          printed as "N of ${count}", never as a bare share
  shape.medianLeftWords / maxLeftWords / leftWordsFrom   piped subset only; MIN_PIPED_SAMPLE=3 fallback stands
  shape.tails[]                              each separator-right verbatim, one per line
  shape.tailClass {search, brand, specOnly}  classifyTail() using the DOOR'S predicates
  shape.garment {twice, once}                countGarmentMentions, adjacency-collapsed
  shape.audienceMix {gendered, inclusive, none}
  vocab.attested[] / vocab.unattested[]      attestedUse() — quotes the corpus, never invents
FROM THE REJECTS (poGoldCorpus.ts):
  ${rejectBlock}    rejectPairBlock(loadPoRejectPairs(supabase)) — '' when empty; seeded by SEED_REJECT_PAIRS
FROM THE PRODUCT (two are new wires):
  ${garmentBrandLine}  `Garment brand: ${attributePin}\n` when set and blankSpec.brandInCopy !== false
  ${specFactLine}      NEW WIRE — `Confirmed facts: ${facts}\n` from blankSpecFactTokens(blankSpec),
                       filtered through isTitleWasteVocabulary. Without this, gold #1's "Long Sleeve"
                       is UNPRODUCIBLE: the apparel arm passes no product facts today.
  ${idiomAltLine}      when isIdiomDesign — `Also written short as: ${designName}\n`; both forms offered, neither mandated
  ${audienceLine}      renders ONLY when a lean is set. `const audOpt = preferredAudience || 'Men and Women'`
                       (:3424) is DELETED — on a universal design nothing renders.
FROM THE DOOR (one list, both ends read it):
  ${wasteWordList}     generated from TITLE_WASTE_SOURCE (titleBand.ts:1167)
  ${hardCap}           CONTENT_CONTRACT.title.hardCap
  ${tmClause}          buildAdversaryTrademarkClause()

=====================================================================
COMPANION PROMPT EDITS — required, or the brief is contradicted by its
own neighbours in the same API call
=====================================================================
Persona 1 (:2983) — delete "Always draft PATTERN A" and "you MUST use the FULL source phrase":
  "You are the IDIOM COPYWRITER for ${brandName}'s apparel line. Your draft leads with the design — the words printed on the garment — and lets it carry the title. When the design tag has a longer source phrase, weigh both forms against the character budget and the seller's measured word counts; either can be right. Follow the brief below."

Persona 2 (:2987-3003) — keep the ENTIRE compound-niche precedence ladder, vision-overlap floor, echo guard, tie-breaks and HARD RULE VERBATIM (that is pool selection, not shape). Replace ONLY the final shape paragraph:
  "Your draft LEADS with the phrase you selected above, so the highest-demand words sit earliest. Where the design phrase then falls, and whether you use a separator at all, follow the seller's titles in the brief. Follow the brief below."

Persona 3 (:3007) — replace "You OWN the right side of the pipe: variant + category brand + noun 2 + audience." Keep the whole AUDIENCE RULE block and closed-lexicon carrier clauses verbatim:
  "You are the COMPLIANCE & CONVERSION EDITOR. You own the MONEY position — the part of the title that has to earn a click from search. Spend it the way the seller's titles and the measured tail counts in the brief show them spending it."

Adversary (:3039) — append, generated from the SAME measurement block:
  "(d) SHAPE, measured off the seller's own ${goldCount} titles: identity median ${medianLeftWords} words, never more than ${maxLeftWords}; ${tailSpecOnly} of ${pipedCount} of their closes are product specs alone. REJECT any candidate whose identity runs longer than ${maxLeftWords} words, that carries any of [${wasteWordList}], or whose close is a bare product spec with no garment brand and no phrase a shopper would type."

Judge-synth (:3052) — replace "Pick THE SINGLE PATTERN (A or B)":
  "Read the brief, the candidates and the critic review, then write the strongest compliant title — you MAY rewrite from scratch. It must sit inside the measured shape at the top of the brief: the length range, the identity word budget, and the kinds of close the seller actually uses. AUDIENCE-MODE CONTRACT: [unchanged]"
```
