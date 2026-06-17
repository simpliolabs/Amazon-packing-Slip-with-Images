## Multi-universe seeds (PR2) — research the Agent's secondary universes, not just `seeds[0]` (batch 5/6)

**PO 2026-06-14:** *"The Council should be smart enough to know if they need to query MORE keyword universes from JS — up to 3 — searching storage first."*

The Seed Agent (#239) already returns up to **3** identity-validated seeds (most important first) — but `researchKeywords` used **only `seeds[0]`** and discarded the rest into `seedsConsidered` (surfacing only). A multi-theme design ranked on its primary universe alone.

> **Example:** a Haitian World-Soccer-Cup tee is three universes — `world-soccer-cup ∪ haiti-pride ∪ soccer-supporter`. We researched only "world soccer cup shirt", so the pool (and therefore the generated title/bullets/backend) under-covered two of its three real niches.

### Fix — `Phase 2b` in `researchKeywords`
After the primary `keywords_by_keyword` query, research the secondary Agent seeds (`seeds[1..2]`) and merge their universes into the pool.

| Guard | Behavior |
|---|---|
| **Storage-first** | Skip a seed whose distinctive token already saturates the pool (**0 credits**), reusing the same `nicheTokens`/`NICHE_GENERIC` predicate as vision enrichment. |
| **Credit cap** | **+2 credits max** (3 universes total) — exactly the PO's "up to 3". |
| **Naturally gated** | Only the `agent` source returns >1 seed; manual/category/rules return a single seed → no-op. |
| **Safety** | Agent seeds are already trademark-scrubbed + identity-validated upstream. |
| **Dedup** | Per-iteration `seen` set (rebuilt from the live pool) prevents re-adds; the 2nd seed sees the 1st's additions. |

### Resolves a latent asymmetry
The Agent's seeds now drive **initial** research; the existing vision-based `enrichResearchWithNiche` stays as the complementary **on-demand** supplement (also storage-first → skips universes Phase 2b already covered, **no double-spend**).

`tsc` 0. `node_modules` has no vitest in this sandbox so the keyword tests couldn't run; the change is additive (one new phase block) reusing existing unit-tested helpers. Independent of #247/#248 (different file).

> **Follow-up (not here, small):** surface `seedsConsidered` in the research success message ("Researched 3 universes: X | Y | Z"). The result already carries it; only the fire-and-forget poll needs to thread it to the client. Core ranking value is banked in this PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
