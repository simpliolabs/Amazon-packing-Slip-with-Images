## A + D from the PO's GO list: the seed-quality fix + the Opp column

**The seed-quality trap (root cause of "all the keywords are the same"):** Manus's 4-phase research pipeline is sound — niche query → Share-of-Voice → harvest the **#1 competitor's** keywords. But everything orbits the Phase-1 **seed**, and the seed came from vision/title — **product-literal** ("post it notes variety pack"). Seeded that way, the niche query returns our own phrasing back and SOV crowns whoever wins that narrow phrase — never the *category* winner (Mr. Pen wins "self stick notes"). `manualSeed` existed in the lib but **no caller ever passed it**, and research caches for 30 days, freezing a bad seed per family.

### What this PR does
- **Category seed from the live productType** (non-apparel): `SELF_STICK_NOTE` → `"self stick notes"` — literally the seed the PO's H10 run used to find the competitor universe. Apparel keeps vision/title seeds (design-led niches). Seed priority: `manualSeed > categorySeed > vision > title`. `APPAREL_PRODUCT_TYPES` exported from listingPipeline for the shared ground-truth gate. Best-effort everywhere — any failure → today's behavior.
- **"Re-research (3 JS credits) →" button + seed box** in the Intelligence tab — exposes the dormant `manualSeed` + `forceRefresh` (fire-and-forget background run, honest "reload in ~1 min" message, credit cost on the button per the standing consent rule). Blank seed = the new auto category seed.
- **D — "Opp" column** (0-100 opportunity score, violet ≥70) between Vol and Action, tooltip explaining the formula inputs (demand × proven sales × competition × rank momentum × listing-gap).

`tsc` exit 0. Self-adversarial: no import cycle (dynamic import); `PRODUCT` fallback PT excluded; apparel families byte-identical; legacy no-body POST trigger unchanged.

### After merge
On B0F86LPSHZ: leave the seed blank → **Re-research (3 credits)** → reload → the pool re-centers on the *category* niche with the right competitor harvested — no more H10 round-trips needed for discovery.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
