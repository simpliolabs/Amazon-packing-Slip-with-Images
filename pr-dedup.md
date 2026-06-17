## Backend keywords: drop repeated tokens (reclaim wasted bytes)

PO spotted the design phrase appearing twice — e.g. "**i could be meaner** comfort colors … could be meaner men". The force-led design phrase plus a keyword carrying the same words duplicated "could/be/meaner/men". Amazon indexes each token once, so a repeat is pure wasted budget.

`buildString` now runs `dedupeTokenSoup` on the assembled core+tail: keeps the **first** occurrence of each normalized token (so the design-name lead stays intact), drops later dupes. `fillBackendToBudget` then tops the reclaimed bytes back up with novel terms, so strings stay at 244–250 bytes — just with more *unique* coverage.

Normalized compare (punctuation-stripped) so "darlin'" and "darlin" collapse to one; distinct tokens like "women" vs "womens" both survive.

9/9 unit tests (design lead intact, each repeated token reduced to one, "men" not matched inside "meaner", apostrophe collapse, no loss when all-unique). `tsc` exit 0. One file, no migration.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
