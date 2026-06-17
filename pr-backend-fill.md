## Backend keywords: fill the 250-byte budget, and your own title terms join the pool

Your two catches on the regenerated Darlin' backend, both fixed with one deterministic backstop:

1. **"NOT utilizing all 250 characters"** — the agent's soft ~240 target landed at 228, stranding ~20 bytes per child. Every per-child string is now filled to **≥244/250 bytes** (hard cap never crossed).
2. **"COUNTRY … was not part of the new keyword suggestions"** — the backend pool only contained *researched* keywords, so your own title's proven terms never qualified. The fill now draws **first from your canonical title's descriptor phrases** ("country western", "vintage rodeo" — segment-aware, never spliced across punctuation), then leftover pool keywords.

Verified on your exact 228-byte string + your exact canonical title: → **244 bytes** with **`country western`** appended first; token-normalized so no duplicate junk (`darlin'` vs `darlin`), third-party brands skipped, capacity tokens skipped on capacity families, and the fill runs **before** the hard-lean gender strip so additions get cleaned too.

`tsc` exit 0. One file, no migration. Applies on the next backend regen (full audit or ↻ Regenerate backend).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
