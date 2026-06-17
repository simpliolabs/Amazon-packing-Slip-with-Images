## One sweep: PR-B (titles ≤75) + PR-C (Item Highlights) — fully wired, fully actionable

Amazon's **July 27, 2026** rule: titles **>75 chars get AUTO-REWRITTEN** (every category except media), and the new **Item Highlights** field (~125 chars, comma-separated phrases) carries what the shorter title can't. #165 taught the *scorer* the bands and left a written contract: *"the title generator flips to ≤75 in a follow-up PR, which is when the dock turns on."* This is that PR.

## PR-B — title generation ≤75

**Prompts (all surfaces):** apparel 50-75 / non-apparel 60-75 with HARD CAP 75; candidate guidance now says 1-2 keywords fit (rest → bullets/backend); retry, brand-safety rewrite, and council adversary briefs all re-briefed. The apparel prompt's own example title was **83 chars** — replaced with an exactly-75-char shape: `THE CEO Later Gator T-Shirt, Comfort Colors Alligator Tee for Men and Women`.

**Deterministic rails (LLM can't miss the cap):**
- New exported `capTitle75()` — final backstop after every other transform: word-boundary tail-trim (everything valuable is front-loaded), connector/punctuation cleanup, and it **drops a truncation-mangled audience** ("…for Men" left from "for Men and Women", incl. possessive/`&` forms) rather than silently narrowing it.
- Brand-prefix guarantee now ALWAYS prefixes (the cap trims tail — adding the brand can never be what gets cut).
- Feel-word pad re-triggered at <50 (it would have padded a perfect 70-char title toward 80).
- Acronym repair post-Title-Case (`Sd→SD`, `Usb→USB`, `128 gb→128GB`).
- Per-child capacity titles: capped at 75 **with capacity-survival** — if the trim cut the swapped capacity token (the one thing that differs per child), it re-inserts up front and re-caps.

**Scoring agreement (generator ↔ scorer, no #160-class divergence):**
- `validateTitle`: >75 problem / <50 floor — same bands as the #165 scorer.
- `syncListingContent`: the **-5 dock for >75 turns ON** (the #165 plan). Heads-up: every live >75 title loses ~1 weighted point until its ≤75 draft ships — that's the intended actionable push, and the draft is ready after each regen.
- Manual title editor: counter is now `X/75` with amber >75 / <50 (was "under 80 mobile cutoff").
- score-title API: >75 no longer trips the red **suppression** banner (auto-rewrite ≠ policy suppression — your whole catalog is 76-150 today and pushes fine); the ≤75 guidance shows in the problems list instead.

## PR-C — Item Highlights, riding the #166 schema rails (zero new endpoints/columns/UI)

- `buildItemHighlights()`: **deterministic** ≤125-char comma-joined phrases from the same gated keyword pool (highest opportunity first), with bullet-grade hygiene — no seasonal, no audience-narrowing role words, no third-party brands, no capacity tokens on capacity families, nothing the title already fully indexes (**net-new index only** — it carries exactly what the 75-char title had to drop).
- **Menu-gated**: the row is added ONLY when the product type's live schema accepts `item_highlights`. Before Amazon ships the field → no row, no fake Features gap. The day they ship it → it appears automatically with a working **Push** button (field_name = the schema's own title → the #166 resolver maps it 1:1 → push/verify/write-through/re-score all just work).
- `listPushableSchemaAttributes` gained an **always-include** for `item_highlights` — the menu fills in schema property order, so without this the feature could silently never activate for categories where the attr lands 15th+ (adversarial-review MAJOR, fixed).
- Audit-guessed "Item Highlights" duplicates are dropped even when our deterministic build is empty — no unreviewed LLM guess ever rides the pushable rails.

## Verification

- `tsc --noEmit` exit 0.
- **Adversarial subagent review: 9 findings — 1 MAJOR + 6 fixed, 2 accepted NITs** (no stemming in the title-covered check; a dangling content-word is possible in the last-line cap — the normal path stays ≤75 via prompts+retries). Clean angles verified in code: capTitle75 mathematically cannot return >75; nothing re-lengthens after the final cap; the highlights push path was walked end-to-end (resolver → pushable → Push → write-through → re-score).

## After merge (PO)

1. Coolify deploys ~3 min.
2. Regenerate any listing → expect a ≤75 title draft + (where Amazon already accepts it) an Item Highlights row with Push.
3. I'll live-verify on B0F86LPSHZ + B0G884ZJ27 via the API and report the actual strings.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
