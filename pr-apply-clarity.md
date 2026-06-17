## Apply-tab clarity — 3 fixes from a PO review of B0G884ZJ27

All three were "the score says one thing, the suggestion says another" — diagnosed from the code, not guessed.

### 1. Description "3 versions live" but no Ship — **real bug, fixed**
The cohesion Ship button + status were gated on `needUpdate`, which the "optimal" score-gate forces to **0** when `description_score ≥ 23` — **even though the 76 variants diverge (67/8/1)**. So it showed "up to date" with no way to unify them. Now a broadcast field with diverging variants shows **"variants differ — unify" + the Ship** (pushes the recommended value to all), regardless of score. Capacity-family titles (`perChild`) are untouched.

### 2. Red HIGH pill on DONE cards — **cosmetic, fixed**
A DONE item (live-match or cooling-locked) kept the pipeline's hardcoded `priority=HIGH` because the downgrade guard refused to lower an already-HIGH item. A DONE item isn't actionable → `priority='NONE'`.

### 3. Features 10/12 but "8 to push" — **wording, fixed**
Not a contradiction: `features_score` docks a flat −5 for the *length* of `product_details_improvements`, which is a **proactive spec sheet** (the AI suggests a value for every standard attribute, "err toward more", *without* checking what's already filled). So 10/12 + 8 recommendations is consistent. The misleading **"{N} fields are missing or incomplete"** message → **"confirm or refine {N} values — many may already be set."** (The deeper "count only truly-empty fields" rides with #85.)

### Notes
- Diagnosed via a parallel investigation (3 agents over the scoring + display code). `tsc` clean. **No bullet/score logic changed** — the 9/18 bullets question was *not* a bug: DONE = "live bullets match the shipped recommendation"; the score = opportunity-keyword coverage; the two legitimately differ. (Regen → *push* fresh bullets that weave in the missing keywords is what raises it; regen alone re-scores the same text → same number.)
- **Live-verify after deploy:** B0G884ZJ27 → Apply: the Description row now shows "variants differ — unify" + a Ship; DONE bullet cards drop the red HIGH pill; the Features issue text reads "confirm or refine".

🤖 Generated with [Claude Code](https://claude.com/claude-code)
