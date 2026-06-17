## Three B0FRYMM56C fixes: unisex-fit copy, comfort-colors bullet stuffing, Intelligence-tab refresh

Root-caused + adversarially verified via a workflow; the adversarial pass caught a real regex flaw in the first proposed fix (and my unit test caught a further curly-apostrophe variant).

### 1. "1717 is a unisex relaxed fit, not a womens fit"
The listing is hard-female lean, so the copy correctly targets women — but it also fabricated a **gendered FIT** ("RELAXED WOMENS FIT", "relaxed women's style"). FIT/STYLE/CUT is a **garment fact** (Comfort Colors 1717 is a unisex relaxed blank); AUDIENCE is a marketing choice. `enforceHardAudience` was blindly swapping every gender token, so a fit phrase became "womens fit".
- **Fix:** `enforceHardAudience` now **strips the gender modifier off a fit/style/cut noun** (keeps the noun) instead of swapping it — "relaxed women's fit" → "relaxed fit" — then swaps only genuine audience tokens ("for men" → "for Women"). Matches **both** straight and curly apostrophes (the live bug used `’`).
- Plus a bullets-prompt guard (apparel only): "FIT IS NOT GENDERED — describe fit neutrally; you may still target the buyer audience."

### 2. "Why is comfort colors repeating so many times in bullets?"
"comfort colors" appeared **7× across 5 bullets** (incl. the misspelling "confort colors"). The prompt *said* "max twice" but nothing enforced it, and the keyword pool fed the agent 5+ "comfort colors …" variants as separate opportunities → it stuffed them all.
- **Fix (source):** collapse blend-brand variants in the bullet keyword pool — keep only the shortest form per blend base, so "comfort colors" is **one** opportunity, not seven. (The scorer reads this same set via `keyword_plan`, so generator↔scorer parity holds.)
- **Fix (backstop):** `validateBullets` now flags **phrase overuse** (any blend-brand/material ≥3× → triggers the existing rewrite loop) and **customer-facing misspellings** ("confort", etc.) — misspellings belong only in backend search terms.

### 3. "Why did I have to refresh to see the Intelligence tab?"
The keyword-intelligence fetch was gated on `score.top_child_asin`, which resolves asynchronously *after* the tab list renders — so the tab only appeared on refresh (warm cache). **Fix:** fetch keyed on `asin` (the route param) on mount, in parallel with the score. The endpoint resolves a parent ASIN to its top child internally (same pattern rank-analysis uses — verified).

### Verification
16/16 unit tests (fit-strip incl. straight+curly apostrophes & male mirror; audience preserved; overuse/misspelling detection; blend dedup). `tsc` exit 0. No migration. Existing listings self-heal on their next regen.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
