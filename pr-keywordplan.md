## KeywordPlan — scorer↔generator parity (#93) + cross-section design cohesion (#92)

> ⚠️ **REQUIRED before deploy:** apply `supabase/migrations/022_keyword_plan.sql` (adds `keyword_plan jsonb`). Same operational step as migration 021. The code degrades gracefully if it's absent, but the feature only takes effect — and regen↔sync scores only stay in lockstep — once the column exists.

### The holistic plan, completed
#160 unified the coverage **measurement** (one `missingBulletKeywords`). This PR adds the missing half: **one persisted `KeywordPlan` `{ bullets, designName }`** — a single source of truth for *which* keyword the bullets must carry + the identity anchor — read by the scorer.

| Piece | What it does |
|---|---|
| **KeywordPlan persisted** (`migration 022`) | `{ bullets: topOpportunityKwsForBullets, designName }`, written once per regen |
| **#93** scorer reads `bulletPlanKeywords` | docks bullets against the generator's **exact** target set → closes the source / relevance-gate / title-exclusion divergence by construction. **Falls back to legacy** when absent → zero regression on un-regenerated rows |
| **#92** cross-section cohesion | design name in title but token-missing from bullets → −4 bullets; missing from backend → −4 keyword. Off the **real** `designName` (from the plan), never a capacity-unsafe title heuristic — that's why #92 had to wait for #93's plumbing |

### Adversarial review → 4 findings, all handled before push
- **(med)** regen-vs-sync flip if the recommendations upsert hit the minimal-payload fallback (e.g. pre-migration column missing) → **best-effort `keyword_plan` UPDATE** recovers the transient case; the column-missing window is closed by the **migration-first** requirement above.
- **(low)** #92 design dock could double-charge `bullet_score` when the design name is already owned by a #93 opportunity keyword → **dedupe** (skip the bullet cohesion dock when the design is owned by the opportunity set). The "two levers, one number" pattern that got the prior Option-C gate reverted — avoided.
- **(low, by design)** the plan path is intentionally stricter than legacy: bullets must carry their *assigned* keyword even if it lives elsewhere in the family; shipping the **bullets** clears it (shipping only backend doesn't — backend ≠ bullets). Documented.
- **(low)** stale persisted design name → bounded −4, never a false-DONE, self-heals on the next regen. Accepted.

### Backward-compat / safety
- The plan is read in its **own** try/catch + select, so a not-yet-migrated column can't break the product-details read. The dock is purely additive (never raises a score, never marks DONE).

### Verification
- `tsc` exit 0 · `verify-bullet-coverage.mjs` **9/9** · `verify-rank-honesty.mjs` **21/21 + 10/10**.
- Post-deploy (after migration 022): regen B0G884ZJ27 and read the real bullet/keyword scores; confirm regen score == next-sync score (no flip), and that a listing missing the design name from a section gets the −4 cohesion dock.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
