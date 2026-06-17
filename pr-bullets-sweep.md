## BIG SWEEP — bullets coverage + features materiality + actionable rank work-list

Knocks out the remaining "score says one thing, suggestion says another" gaps in one pass, with an internal adversarial review baked in.

### The 9/18 root cause
Bullets dead-ended at 9/18 because the **scorer**, the **bullet generator**, and the **validator** each measured a *different* keyword universe with a *different* gate — no single source of truth, and no deterministic floor (the title has one; bullets didn't).

### What changed
1. **Shared coverage predicate** — `src/lib/keyword-engine/bulletCoverage.ts` (one `BKW_STOP`, token-based `missingBulletKeywords`). Scorer **and** validator/backstop import the SAME predicate → the generator covers EXACTLY what the scorer docks for.
2. **Align the bullet gate** — validateBullets triggers at `>=2` (scorer's first tier); opportunity-pool word-cap `5→6`; council brief now HARD-REQUIRES the *scored* set ("REQUIRED SEARCH KEYPHRASES… cover EVERY one").
3. **Deterministic coverage backstop** — guarantees the scorer's opportunity keywords (+ design name) land in bullets even on a bad LLM pass, mirroring the title floor. Runs LAST; `safeKw()` self-enforces every invariant (drops all-stopword phrases, capacity tokens in capacity families, role-leaks, **and unframed third-party brand / trademark keywords** — a verbatim append can't add `for [Brand]` framing). At most **one** clause per bullet (no keyword-soup).
4. **Design name into bullets** — `oppPlusDesign` leads the brief + is guaranteed by the backstop (parity with title + backend, #91/#92/#159).
5. **Features materiality (#85)** — `productDetailsGaps` counts only TRUE gaps (empty OR enum-invalid), not the full proactive spec-sheet → fixes "10/12 but 8 to push". Enum validation now runs **before** the regen score using the **same** predicate as the sync → Features no longer steps DOWN on the next sync with no seller action.
6. **Scorer bullet universe capped to `<=6` words** to match the generator's pool (no docking for a long-tail the generator won't force).
7. **Actionable rank work-list (PO ask: "actual actionable tasks, not beauty/information")** — the "Rank Top of Amazon" panel now lists concrete tasks ("Ship bullets — draft already covers them" vs "Regenerate to weave them in") wired to the real Ship/Regenerate controls via the SAME token predicate. Capacity-family titles judge "draft covers it" against **every** per-child title (no false promise for non-base SKUs).

### Verification
- `npx tsc --noEmit` → **exit 0**.
- `scripts/verify-rank-honesty.mjs` → **21/21** over-promises caught, **10/10** honest phrases pass.
- **Internal adversarial review** (3 reviewers + per-finding verifier) surfaced **8 real findings**; **all 8 fixed in this PR before push** (incl. the brand-safety hole in the backstop and the capacity-family per-child-title honesty bug).
- Post-deploy: regen B0G884ZJ27 and read the ACTUAL bullet/features scores + confirm the design name in title/bullets/backend.

### Deliberately deferred (flagged, not skipped)
- **Scorer cross-section design-cohesion penalty** — the sync scorer can't get the real design name (`extractDesignName` is async/needs pipeline input); the title heuristic is capacity-unsafe. Generation already guarantees the design name in every section, so the penalty is a clean follow-up that persists the real design name for the scorer.
- **Full KeywordPlan unification** — this PR aligns the predicate + word-cap; the deeper source/gate unification (same DB rows + same coverage gate both sides) is the remaining residual.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
