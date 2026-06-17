## "Score not updated after pushing Keywords" — it DID update; the remaining −6 was two scorer bugs (now fixed) + one workflow note

### From-fact diagnosis
`keyword_score` is **19/25 right now** (15/20 on the card) — the push DID re-score. The −6 was named exactly by the score row's own issues:

1. **−3: "Backend repeats 6 words already in your title"** — but your chosen backend strategy is **HYBRID**: the generator deliberately includes the top search phrases even when they're in the title ("utilize the best Jungle Scout terms" — your call, from way back). The scorer was docking every listing for doing exactly what it's designed to do. **Dock retired** (the trap-class rule: never dock for what the generator must produce).
2. **−3: "1 keyword gap: `mens comfort colors tshirt`"** — a **MENS keyword on your Female-selected listing**, which the hard-Female strip (#198) correctly refuses to place. The scorer's gap counter now **respects the Audience selection**: under hard Female/Male, opposite-gender keywords don't count as gaps (lean/unisex unchanged).

After this deploys, a keywords push (or any re-score) takes this card to **25/25 → 20/20**. Heads-up: retiring the overlap dock nudges OTHER listings' keyword scores up by up to 3 raw points too — scores may shift catalog-wide, upward only.

### The workflow note (why "country western" still isn't in your backend)
The strings you shipped were the **old 228-byte ones** — `changed: 0`, no `country western` (verified live). The #201 byte-fill only enters via regeneration. Order matters: **↻ Regenerate backend first, THEN Ship.**

### Bonus: `scored_at` now updates on push re-scores
It was stuck at the last full Sync (yesterday's timestamp on today's scores), which made freshness undiagnosable.

`tsc` exit 0. No migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
