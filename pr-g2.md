## G2′ — triple the competitor harvest for zero extra credits

Phase 4 of the research pipeline harvested only the **#1** Share-of-Voice competitor. Fact found in `jungleScoutClient`: `keywords_by_asin` accepts **up to 10 ASINs in one request** (rows attributed via `primary_asin`), and credits are counted **per call** — so harvesting the **top-3 competitors costs exactly what one did**. With H10 cancelled, this is the competitor keyword-mining lane — now tripled, free. A full research run stays **4 credits**.

- Top-3 SOV competitors picked (own ASINs excluded); **#1 remains the stored/displayed competitor** — rank panel and competitor meta unchanged.
- One batched call → rows flow into the same merge, `competitorMatch`/`competitorGaps` bucketing, engine scoring, and the #179 rank-overlay (which already clears competitor `organicRank` so it can never masquerade as ours — that guard now matters 3× more).
- Honest cap note: the 100-row API limit now spans all three ASINs, volume-sorted — top terms win; per-competitor depth shrinks, total breadth triples.
- Strict superset of today's behavior when SOV returns just one competitor. `tsc` exit 0, single file.

With this merged, the post-H10 discovery stack is complete: **category seed (#177) → niche keywords + top-3 competitor mining (this PR) + our ranks (#179) → TD/strike/rise-aware councils (#178/#180) → drafts → Ship → rank history measures the result.**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
