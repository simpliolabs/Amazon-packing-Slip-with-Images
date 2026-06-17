## Bullets: stop keyword-soup — distribute keyphrase words naturally (batch 4/6)

**PO 2026-06-15:** bullets read like keyword soup — e.g. *"Channel the haitian soccer jersey world soccer cup 2026 aesthetic"* — a whole long-tail search string jammed into one sentence.

### Root cause (verified against `bulletCoverage.ts`)
Coverage is **token-based, not phrase-based**: `missingBulletKeywords()` only needs each significant **word** of a keyphrase to appear *somewhere* across the joined 5 bullets — the words can be **spread across different bullets** and need not be contiguous. But two things forced the literal phrase in:
1. **Generator prompt** said "every word of the phrase present" + "LEAD bullets 1,2,3 with the top three" → the model read it as "insert the whole phrase."
2. **Deterministic backstop** appended the **entire** keyword verbatim (`…, haitian soccer jersey world cup 2026.`) even when only *one* token was missing.

A prompt-only tweak gets overridden by the backstop, so this fixes **both** — without lowering coverage:

| Spot | Before | After |
|---|---|---|
| Generator prompt + retry message | "every word of the phrase present" | "coverage is by WORD — spread the key words across different bullets/sentences; never cram a whole search string into one sentence" + bad-vs-good example. Still requires "cover EVERY phrase." |
| Backstop append | `, ${kw}.` (whole phrase) | `, ${missing tokens}.` (minimal fragment) |

### Why no coverage regression
The scorer, validator, and backstop **all share the same `bulletCoverage` predicate**. Every keyphrase's tokens still end up present — only *how* they're distributed changes. The backstop's minimal fragment is `⊆ kw`, so the existing `safeKw(kw)` role/brand/trademark guards already cover it.

`tsc` 0. `node_modules` has no vitest in this sandbox so the bullet tests couldn't run; the change is surgical (two prompt strings + a minimal-fragment backstop). Independent of the title-fill PR (#247) — different functions/lines in the same file, clean merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
