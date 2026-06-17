## Rank Top of Amazon — Competitive Rank Analyst

Adds an **honest, evidence-based** rank panel to the listing-page **Intelligence tab**: what your content *can* and *cannot* do for organic rank — never an over-promise.

### What it does
- **Free stored-core (0 credits, 0 OpenAI):** your top opportunity keywords × **live content coverage** + a deterministic baseline verdict.
- **GET** `/api/fba/rank-analysis/[asin]` — 0-cost cache read (staleness via `content_fingerprint`); degrades to the free core if the migration isn't applied yet.
- **POST** — full-5 **council** (3 analysts → GPT-5 adversary → GPT-5 judge), NDJSON-streamed, **fail-open** to the deterministic baseline. OpenAI key from `app_settings`.
- **Opt-in `?competition=true`** — Jungle Scout Share-of-Voice, **hard-clamped to `min(10, callsRemaining)`**, credits counted from **real billing**, behind a **90s atomic run-lock** (covers every POST). The UI discloses the credit cost before the click.

### Honesty is enforced, not hoped
- A banned-phrase validator (**fail-closed family match, global**) clamps every LLM string.
- The `CONTENT_CANNOT_DO` / honest-note floor is **deterministic and immovable** — the LLM only *enriches*.
- The judge can only key realities to **exact playbook keywords** (no invented terms).
- Proven by `scripts/verify-rank-honesty.mjs` → **21/21 over-promises caught, 6/6 honest phrases pass**.

### Shared extracts (no behavior change)
- `keyword-engine/coverage.ts` — token coverage checker (scorer + rank share it).
- `fba/resolveAsin.ts` — parent→child resolver (intelligence route + rank share it).

### Hardened by two adversarial-review passes
**27 findings total, every real one fixed** — incl. a blocker (free re-run wiping paid SOV → non-destructive rehydrate), the run-lock TOCTOU (→ atomic conditional UPDATE), the honesty regex gaps (→ family match, runtime-proven), credit over-count (→ billed-delta), and a regression introduced mid-fix (no_keywords partial upsert → targeted UPDATE), plus UI hardening (AbortController, `key` remount, shape-coalescing).

### ⚠️ Required before the council can cache
Apply **`supabase/migrations/021_listing_rank_analysis.sql`** to Supabase. It's additive + safe; **GET works (free core) without it**, but POST results won't persist until it's applied.

### Verification
- `tsc --noEmit` → **exit 0**. (Local `next build` exits 1 on the pre-existing env-prerender step — no Supabase env locally — so Coolify is the deploy gate.)
- Honesty runtime test passes.
- **Live-verify on B0G884ZJ27 after deploy** (GET free core → POST council → opt-in competition → confirm the atomic lock + persistence).

### Notes / follow-ups
- **Header naming:** the panel header is **"Rank Top of Amazon"** (product choice). The honesty validator bans that exact phrase in *generated* copy — the deterministic body (CAN'T-do + honest note) carries the honesty; flagged for awareness, easily renamed if preferred.
- The rank tool reads `keyword_analysis` via `resolveToChildAsin`; the scorer uses `resolveKeywordAsin` — coverage is approximate, not byte-identical. Unifying the resolvers is a tracked follow-up.
- **Outcome loop (task #89):** store per-keyword share over time (SQP-primary, SOV occasional) and feed it back into the next suggestion run — the natural next step after this lands.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
