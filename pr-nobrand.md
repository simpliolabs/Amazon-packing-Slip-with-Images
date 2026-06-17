## "WHY does it add our Brand name to the Keywords?" — the byte-fill was appending canonical-title bigrams, and "THE CEO" leads your canonical title. Now banned, per Amazon's own rule.

### Where "the ceo" came from
The #201/#205 byte-fill tops each child up toward 250 bytes using your canonical title's word-pairs first ("country western", "vintage rodeo") — and the canonical starts "THE CEO Darlin'…", so "the" + "ceo" landed at the end of every child that had room. The existing brand guard only blocks THIRD-PARTY brands; your own brand was deliberately exempt from that check (correct for titles, wrong for backend).

### The rule (Amazon Seller Central, "Use search terms effectively")
- **No brand names — including your own.** The brand attribute already indexes it; backend bytes spent on it are pure waste.
- **No stop words** (a, an, and, by, for, of, the, with) — Amazon ignores them in queries.

Both are now banned by the backend token gate (core + LLM fill + byte-fill):
- **Own-brand tokens** banned, with the **design-name exemption**: "Darlin'" stays even though brand-adjacent — and a seller whose design IS their brand ("Later Gator" / "Later Gator") keeps it entirely. Identity wins over the brand rule.
- **Amazon's 8 documented stop words** banned everywhere in backend strings ("gift her" still carries "her" — that's a real search token, not a stop word).

Title/bullets/description untouched — brand belongs THERE.

### Verification
14/14 tests: bans `ceo`/`the`/`for`/`with`/`and`; keeps `darlin`, `her`, `cowgirl`, `entrepreneur`; design-overlap brand keeps both tokens; a distinct brand ("Simplio Labs") is fully banned while the design survives. `tsc` exit 0. One file, no migration.

### Note on the strings you already pushed
The trailing "the ceo" on the live strings is harmless (Amazon just ignores it) — no urgent re-push needed. The next natural ↻ Regenerate backend → Ship reclaims those bytes for real terms.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
