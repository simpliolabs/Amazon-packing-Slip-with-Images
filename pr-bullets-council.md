## What
A **bullets council** for apparel — mirrors the title council for the 5-bullet array, optimizing **opportunity-keyword coverage**.

## Why (the 9/18 the PO asked about 3×)
Verified against `syncListingContent`: the bullet score's single biggest lever is **opportunity-keyword coverage** — it docks **up to −12** when bullets miss the listing's top critical/upgrade keywords. On Later Gator, criticals like **"see you later alligator"** and **"later gator after while crocodile"** sit **NOWHERE**, so the bullets take ~−12 → **13/25 = 9/18**. The single-agent bullets generator wasn't covering them; shipping faithfully reproduced 9/18. (The re-score is wired correctly — `push-content:907–914` writes `bullet_score` on every push.)

## How
`runBulletsCouncil`: 3 persona proposers (copywriter / **SEO-coverage** / conversion, gpt-4.1-mini) → **GPT-5 adversary** that names which required keyphrases each set is missing → **GPT-5 judge** that synthesizes the best-covered, compliant 5-bullet set.
- **Gated to apparel** (mirrors the title council); non-apparel keeps the single fast call.
- **Additive + fail-open:** output still flows the existing role-leak guard + `validateBullets` retry. 0 drafts → single agent; judge empty/invalid JSON → coverage-optimized proposer draft.
- Model via `BULLETS_COUNCIL_MODEL || TITLE_COUNCIL_MODEL || 'gpt-5'`. Keepalives between stages keep each call under Cloudflare's ~100s idle window.

## Adversarial pass (self-critique — additive, fail-open, downstream validation intact)
- Parse failure → fail-open chain, never worse than today's single call.
- Broken/role-leaking/uncovered bullets still caught by the **existing** `validateBullets` + role-leak retry that run *after* the council.
- Latency bounded (≤60s/call < ~100s idle, keepalives between stages); cost = 2 GPT-5 calls per apparel bullets regen.

## Test
- `npm run build` green (Compiled + TypeScript finished).
- **NOT yet live-verified** — needs merge+deploy, then regen Later Gator (B0G884ZJ27) and confirm bullets cover the missing criticals and `bullet_score` moves off 13/25. I will verify on prod after merge.

## Known follow-up (separate)
Some misses — **"last day of school" (168k/mo)**, "schools out for summer" — may be **seasonal-classified upstream** and routed to backend rather than bullets/title. If so, the council alone won't surface them; that reclassification is a separate change.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
