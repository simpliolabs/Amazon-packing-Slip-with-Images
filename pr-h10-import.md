## "All the keywords are The Same" — fact-confirmed, root-caused, and fixed

**Fact (live API):** B0F86LPSHZ's entire keyword universe = 25 keywords, ~20 of them permutations of *post it / sticky notes / variety / assorted*. The competitor's H10 panel shows it ranking on **college essentials (33,418/mo)**, **transparent sticky notes (26,068/mo)**, **clear sticky notes (11,950/mo)**, nursing school supplies, bible sticky notes — none in our pool.

**Root cause (structural, not a bug):** both native sources query **our own ASIN** — SQP returns queries we already get impressions for; Jungle Scout keywords-by-asin returns terms we already rank for. A closed loop that deepens what we have but can never *discover* what competitors win on.

## The escape hatch

**`Import H10 CSV →`** button in the Intelligence tab + `POST /api/fba/keywords/import`:
- Parses the Cerebro/Xray export (quoted "2,534"-style numbers, BOM, CRLF; header-mapped).
- Rows ride the **existing engine end-to-end** (`runKeywordEngine`): presence vs OUR live content, the same 0-100 opportunity scoring, the same CRITICAL/UPGRADE actions — imported keywords are first-class, not bolted on. Real H10 *Keyword Sales* feeds the engine's sales channel exactly.
- **Additive** upsert — existing keywords always win (deliberately *not* `storeAnalysis`, which wipes the ASIN's analysis); `data_source='import'` for honest provenance (**migration 024** extends the CHECK; the route returns a friendly "run migration 024" error if it's missing).
- Downstream is untouched: the next **Regenerate** draws these keywords into bullets/backend/Item Highlights via `getStoredAnalysis`; the relevance gate + brand-safety judge keep off-product/branded terms ("mr pen …") out of the copy automatically; the scorer counts the new CRITICALs — real gaps now dock, which is the point.

## Requires
Run `supabase/migrations/024_keyword_import_source.sql` (idempotent, 2 statements) before first import.

`tsc` exit 0. Self-adversarial: BOM-tolerant header match; case-insensitive dedup vs existing; race-safe `ignoreDuplicates`; 2MB cap; `maxDuration 60`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
