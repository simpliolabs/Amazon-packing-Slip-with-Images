## The real cause of the persistent 9/18
The bullet score's opportunity-keyword coverage check (`syncListingContent.ts:735`) had two flaws that **fight the product strategy** — so even good, council-written bullets stayed pinned at 9/18:

1. **Exact-substring matching.** It only credited a keyword written *verbatim*. The council wrote *"see you later alligator **vibe**"* — natural — but that doesn't contain the literal keyword *"see you later alligator **shirt**"*, so it counted as **missing**. (The keyword-intelligence check at line 459 already uses smart **token** matching; the bullet check didn't.)
2. **Seasonal-blind.** `last day of school` (168k) is a top critical, so the check **docked the bullets for lacking it** — even though the strategy correctly routes seasonal terms to **backend, not bullets** (your rule).

## Fix
The bullet coverage check now:
- **(a) excludes seasonal keywords** (`BULLET_SEASONAL_TERMS`, kept in sync with the pipeline's `SEASONAL_TERMS`; duplicated, not imported, to avoid a scorer→pipeline circular dependency), and
- **(b) matches by token** — every significant token of the keyword present across the bullets — so a natural paraphrase counts.

**Effect:** bullet scores rise to reflect reality. Well-formed bullets that cover the concepts are no longer pinned low by verbatim-only + seasonal penalties. This is the change that moves Later Gator off 9/18.

## Also — 2 nit-prevention rules (bullets brief)
So the council's bullets read clean on the next regen:
- No kids/child/youth references unless the title says so (the *"kids gator"* slip on an adult listing).
- No brand/material phrase (*"Comfort Colors"*) repeated more than twice across the 5 bullets.

## Adversarial pass (self-critique — read-path, non-destructive, no Amazon writes)
- Token coverage mirrors the keyword-intelligence check's semantics (consistent, not newly lenient).
- Skip-seasonal correctly drops `last day of school` / `schools out` while keeping `see you later alligator`.
- Empty-bullets / non-seasonal edge cases handled.
- **Bullet scores will rise across listings** — intended (the old check systematically under-scored).

## Follow-up (NOT in this PR)
Align `validateBullets`' opportunity-coverage *retry* check to the same token-based + seasonal-aware logic, for full generation↔scoring consistency.

## Test
- `npm run build` green.
- **Not yet live-verified** — after merge+deploy I'll regen Later Gator (B0G884ZJ27) and confirm `bullet_score` moves up off 9/18 and the bullets read clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
