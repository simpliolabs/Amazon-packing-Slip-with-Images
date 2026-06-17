**Live discovery during #167 verification:** Amazon has **already enabled Item Highlights** (ahead of July 27) on SELF_STICK_NOTE — under the schema key **`title_differentiation`** (display title "Item Highlight"), not the documented `item_highlights`.

The good news: the #166 schema rails **auto-mapped it with zero code** — the audit saw it on the menu, recommended a value, the resolver mapped it, and the row came back `pushable=true`. The gap: PR-C's *deterministic* builder gated on the docs key, so the value riding the rails today is the audit's creative copy ("Versatile Variety Pack; Compact Mini Size; …" — semicolons, filler) instead of the comma-separated keyword phrases Amazon documents.

This PR:
- matches the menu attribute by **key OR display title** (`item_highlights|title_differentiation` or `\bhighlights?\b`) — robust to per-category naming ("highlighter" can't false-match, word boundary)
- extends the audit-duplicate dedupe ("Item Highlight" singular + "Title Differentiation")
- always-includes **both** keys in the schema menu

After merge, a regen replaces the creative copy with the deterministic ≤125-char comma-separated phrases built from exactly what the ≤75 title dropped. `tsc` clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
