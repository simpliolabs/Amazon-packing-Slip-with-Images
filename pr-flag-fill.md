## Your two asks: catalog defects now FLAGGED with a fix, and the title fills its 75 chars

### 1. "Our system needs to FLAG and recommend a FIX" — done
The garment-boilerplate strings #196 scrubs are no longer silently discarded. Each one now becomes a **Product Features row**:

> **Style** — current: `men's heavyweight crewneck sweatshirt cotton blend pullover` → recommended: `Men's Heavyweight Crewneck T-Shirt Cotton Blend` — *"Your Amazon catalog attribute says X — that is the blank manufacturer's boilerplate, not this listing (your title says T-Shirt). It confuses Amazon's indexing… Push the corrected value or fix it in Seller Central."*

It rides the normal detail rails — Style is a broadcast-pushable attribute, so where the schema maps it you get the **Push button**; otherwise it's a Copy/Manual card. Find things, fix things.

### 2. "61/75 — under-utilizing the title, WHY?"
Honest answer first: after the truthfulness guards, every remaining candidate phrase was 15–30 characters and only 14 remained — no *whole truthful phrase* fit, and the system had no fill stage. Now it does: a **deterministic title-fill backstop** that, when a title lands under ~70 chars, appends the highest-value unused keyword phrases — and **your own canonical descriptors** ("Vintage Rodeo", "Country Western") — before the audience tail, re-checking every guard per addition (a fill can never smuggle back what a guard removed; segment-aware so it can't splice nonsense like "Tee Vintage").

Verified on your exact title:
`THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women` (61) → **`…Graphic Tee, Rodeo Shirt for Women`** (74–75/75).

`tsc` exit 0. One file, no migration. Re-run **↻ Regenerate title** on B0FKLGWZ4C after deploy to get the filled version + the Style flag row.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
