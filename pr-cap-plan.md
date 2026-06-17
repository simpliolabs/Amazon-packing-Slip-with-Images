## "Bullets sent but score not updated" — the score *did* update; the target was impossible. Fixed.

> PO: B0GCF11RKL — all 5 bullets show DONE ("live bullets now matches the recommended version"), card stuck at **12/18**.

### Diagnosis, reproduced to the exact point
- Stored `bullet_score` = **17/25 raw** → ×18/25 = **12/18** shown. The post-push re-score ran fine.
- The scorer docks bullets against the #161 keyword plan. I ran the *verbatim* coverage predicate on your real live bullets: **exactly 4 of 5 plan keywords missing → dock 4×2=8 → 25−8=17.** Reproduced to the point.
- The 4 missing keywords are all **capacity phrases** (`128 gb sd card`, `128 gb sd card for camera`, `sd card 128gb sandisk cards`, `standard sd card 128gb`) — and this family spans **32GB/64GB/128GB sharing broadcast bullets**. Your own safety rails (#76 capacity validator, #160 backstop) **refuse** hardcoded capacities in shared bullets, because a "128GB" bullet would lie on the 32GB variant's page.

So the plan demanded keywords the generator must refuse → bullets frozen at 17/25 **no matter how many times you ship**. Same trap as the role-word filter we added in #160 — this is its capacity sibling.

### The fix (both ends)
1. **Plan build** (pipeline): capacity-token keywords are dropped from the bullet plan when the family spans ≥2 capacities — future plans only demand what bullets can carry.
2. **Scorer**: the same filter applied when scoring (both plan and fallback paths) — so **B0GCF11RKL heals on its next re-score without a regen**: plan filters to `["sd card 128"]` (already covered) → 0 missing → bullets **25/25 raw = 18/18**, overall 82 → ~88.

Those capacity keywords still rank where they belong: each child's **title** carries its exact capacity ("128GB" on the 128GB child), and the backend pool keeps them.

### Found while investigating (your action, no code)
The variation **parent SKU (`Memory-Card-P`) still has EMPTY live bullets** — the diff shows 1 of 6 SKUs stale. After merging: open Ship bullets → push (it will send just that one). That push also triggers the re-score that applies this fix — one click closes both.

`tsc` exit 0. No migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
