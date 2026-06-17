## "New keywords are now ~130 characters" — your push STARVED the next regen's pool. Foundational fix + a quality gate so degraded output can never ship silently again.

### From-fact diagnosis (live reads)
The regenerated strings: **137/137 SKUs carry ONE identical 131-byte string**, no per-color terms, every one ending in a dangling "for". Three stacked failures, each verified:

1. **Push-starvation (the root cause).** `opportunityScore` is gap-amplified (raw × usage-gap 1–3). The moment you PUSHED the keywords, every covered term's score collapsed to raw/3 and flipped toward `OPTIMIZED` ("fully covered") — which the backend pool **excluded**, and the route's top-50-by-score cut buried. Live proof from the fresh analysis: covered "solid color shirts for women" (12,262 vol) now scores **below** uncovered "black t shirts for men" (132,548 vol) on your Female-selected listing. So the first regen after a push drew from the dregs: opposite-gender terms the Female strip then deleted, plus junk. **The optimizer was eating its own keywords every push→regen cycle.**
   - Fix: `OPTIMIZED` stays IN the backend pool (covered terms ARE the hybrid's "best JS terms" — your chosen strategy), sorted by **raw market value** (sales → volume), which no push can deflate. The route now passes the full stored universe (150) instead of the collapsed top-50. Bullets/title pools unchanged — gap-chasing is correct for placement decisions.
2. **Identical across 82 children**: the per-color tail is ONE JSON call for all ~25 colors at `max_tokens: 800` — right at the truncation edge; a truncated response parses to nothing, the catch swallowed it, every child got the bare core. Now 2000 tokens + one retry + a loud log.
3. **Dangling "for"**: stripping "men" from "…rodeo shirt for men" orphaned the connector. The gender strip now trims orphaned edge connectors (for/with/and/the/…), repeatedly, both ends.

### The foundational piece: a backend quality gate
Every LLM step in the backend chain is best-effort try/catch — so a degraded run **persisted silently as if healthy**. New `backendOutputProblems()` post-conditions after fill+strip: every child ≥190 bytes (healthy = 244–250), and a ≥3-color apparel family must not collapse to one identical string. On failure: **one retry**, then —
- keywords-only regen (its single job): **honest failure** — "Backend keyword regen came back degraded (…). Your previous keywords are untouched — run Regenerate backend again." Nothing persists.
- full regen: proceeds with a loud log (five other sections shouldn't die for backend thinness).

### Verification
12/12 unit tests (strip cleanup incl. the exact live failure string, validator pass/fail matrix incl. 2-color and non-apparel exemptions); `tsc` exit 0. No migration.

**⚠ Do NOT ship the current 131-byte keywords.** After this deploys: ↻ Regenerate backend (expect ~244–250 bytes + per-color tails + "country western") → then Ship.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
