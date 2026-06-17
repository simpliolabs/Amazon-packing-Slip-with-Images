## ⚠️ Don't ship the "Urban Pulse" title — here's exactly what broke, all four reports fixed

### 1. Where "Urban Pulse" came from (B0FKLGWZ4C) — and why it scored 25/25
Your stored recommendation has `designName: ""` — **the design-name extraction failed on "Darlin'"**, so the #91 anchor had nothing to enforce and the unanchored AI invented a collection name. Two independent bugs, both reproduced against your real canonical title:

- **Curly apostrophe**: your title stores `Darlin’` (curly); the LLM answers `Darlin'` (straight); the verification `.includes` check rejected the **correct** answer. Fixed — apostrophes normalized before matching.
- **The fallback heuristic** stopped at word 1 of "**Comfort** Colors Darlin' T-Shirt…" ("comfort" is a generic) and returned nothing — it could only find designs at the very *start* of a title. Fixed — it now skips leading generics; verified it returns "Darlin" from your exact title.

**Why 25/25 vs your old 18/22:** the checker scores rules it can see — brand prefix ✓, ≤75 chars ✓, keyword coverage ✓ — and with `designName=""` it had no way to know "Urban Pulse" was fiction (your old title docks for being 110+ chars, over the July-27 75-char limit). After this fix, extraction returns "Darlin'" and the existing validation **rejects any title that doesn't carry it** — a fabricated title can no longer validate, let alone score 25.

### 2. "Black T Shirts" in a shared title for 82 colors
The research runs against ONE child — yours happened to be black — and dragged `plain black tshirt men` into the pool. Same disease as #188's capacity bug, color edition. Fixed at every surface: color keywords are dropped from the title candidates, the title pin, the bullet plan, **and the scorer** (so persisted plans heal on re-score). Per-child backend keeps each variant's own color terms. A real design named with a color ("Black Cat") is unaffected — it flows via the verbatim anchor.

### 3. B0GCF11RKL "CRITICAL but not woven — on purpose?" (partly yes, partly a display bug — now fixed)
- `128 gb sd card` (10,042/mo) **is already in your listing** — the 128GB child's live title literally reads "SD Card for Camera **128GB**". The flag missed it because solid "128GB" didn't token-match spaced "128 gb". Fixed (digit-letter bridge); verified both top keywords now match.
- `…sandisk cards` — excluded **on purpose**: Amazon policy forbids competitor brand names in your content/search terms.
- `standard sd card 128gb` — "standard" is a genuine small gap (backend candidate).

### 4. Stale scores after the audit (your hard-refresh)
Real bug: the regen handler never refetched the score row (only push handlers did). Now the cards update in place when the audit completes.

### The 8+ minutes
Not a bug per se: an 82-variant apparel regen runs the full sequential chain — title council (3 proposers + adversary + judge) → bullets council (same shape) → description → backend → brand-safety judge → an audit pass whose prompt carries all 82 children. Parallelizing independent stages is a known optimization I can take up next if you want it.

`tsc` exit 0. No migration. **Action after merge: hit Regenerate AI Audit on B0FKLGWZ4C once** — the stored "Urban Pulse" recommendation needs one regen to be replaced with a Darlin'-anchored, color-neutral title.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
