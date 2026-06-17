## G4 — the GIFT & OCCASION bullet (audience keywords finally rank in customer copy, compliantly)

Audience/role keywords (`teacher`, `nursing`, `college`, `bible`, `mom`…) are deliberately banned from titles/bullets as **product-identity claims** ("PLAYFUL TEACHER VIBE" on an alligator tee = the role-leak the #160 guard strips). But they're high-volume search terms your niches genuinely buy on — and the one compliant home for them in customer-facing copy is **gift framing**: "Great gift for teachers, nurses…" is a use-case suggestion, not an identity claim.

### What this PR does (apparel families)
- Builds a **gift-audience pool** from the RAW keyword set (the relevance gate strips exactly these — same raw-read pattern as compatibility brands): top ~4 distinct audience words by opportunity (`teacher`, `nursing`, `college`, `bible`, `mom`, family relations…).
- The bullets brief now dedicates **bullet 5 to GIFT & OCCASION**, framed strictly as a gift suggestion, with an explicit carve-out in the accuracy rule: gift phrases are the ONLY place audience words are allowed.
- The **role-leak guard learned the same exception**: explicit gift clauses (`gift for …`) are masked before leak-scanning and preserved verbatim by the strip backstop — bare role claims outside gift framing are still caught, retried, and stripped exactly as before. One stage never demands what another refuses (the #188/#189 ledger rule).

### What does NOT change
- Non-apparel products: untouched (no gift bullet on an SD card unless you ask).
- The scorer doesn't dock for audience words (they stay out of the keyword plan) — this is pure additive reach for "…gift" queries.
- Bare role claims are stripped exactly as before.

`tsc` exit 0. One file, no migration. Takes effect on the next Regenerate per listing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
