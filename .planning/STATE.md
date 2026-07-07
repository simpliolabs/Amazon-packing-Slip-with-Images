# FBA Optimizer — Current State

Current milestone: **M1 — Content quality foundational**
Current phase: **Phase 5 (audit council)** — Phases 1‑3 done (deploying via #338), Phase 4 blocked on PO data.
Updated: 2026-07-07

## Active work
- **PR #338** (re-land content steps 2‑3 to main) — open, awaiting PO merge + Coolify Publish. (Fixes the "#337 didn't reach Coolify" issue: #337 was mis-merged into a feature branch, not main.)
- Building Phase 5 (shared audit council) + Phase 4 once the spec table arrives.

## Next step
PO deploys #335, #336, #338 (+ Publish) → regenerate B0FRYMM56C → confirm Nike leak + keyword-stuffing gone. In parallel I build Phase 5 + fold in the description-brief softening.

## Blockers
- **Phase 4** needs the PO's blank spec table: confirm CC1717 = {6.1 oz midweight, garment-dyed, relaxed unisex, crew neck} + the next ~5 blanks sold most (Bella 3001, Gildan 18000, …).

## Recent PRs (this project)
| PR | What | State |
|---|---|---|
| #333 | Deterministic title fill + reconcile-at-push coverage | merged, live |
| #334 | Manual-title lock + partial pushes in Change History (migration 044) | merged, live, migration applied |
| #335 | Verify targets = `keyword_push_log` (true push parity) | merged to main, awaiting deploy |
| #336 | Competitor apparel-brand scrub (Nike leak) | merged, awaiting deploy |
| #337 | Stop bullet stuffing + enforce gates | **mis-merged to feature branch** → superseded by #338 |
| #338 | Re-land #337 on main | open |

## Deploy rules (hard-won)
- **Merge PRs to `main`, never stack onto a feature branch** — CI only runs on `pull_request: branches:[main]`, and Coolify deploys `main`. The #337 mistake: base was a feature branch, so merging it never touched main and Coolify missed it.
- **Merge ≠ deploy.** Coolify requires a manual **Publish**; verify the live build via `buildCommit` in `/api/health` before testing.
- **Migrations are applied manually** by the PO pasting SQL into Supabase — always paste the full SQL inline. New-column writes are coded to degrade gracefully if the migration lags the deploy.

## Key architecture facts (verify against current code before relying on)
- **Content pipeline:** `src/lib/fba/listingPipeline.ts`. Councils (proposer→adversary→judge) exist for title/bullets/description; highlights = single agent; backend = rules. The bad copy came from post-council deterministic layers: the **coverage backstop (~2686)** bolted keywords onto bullets; the coherence gates sat in **shadow** mode.
- **`findThirdPartyBrands` / `THIRD_PARTY_BRANDS`** (~567/708) is the shared brand detector wired into ~10 validators — arming it once fixes all fields.
- **ai-recommendations has TWO write paths** (full regen + #79 partial section regen at route.ts ~680) — any recommendation invariant must be added to BOTH.
- **Verify** reads `keyword_push_log` (ground truth of what was pushed), not a reconstruction; parent SKU is discovered live (retry) + excluded from pass/fail.
- **Coverage at push:** `reconcileFamilyChildren` runs before a full push so all live variation children (incl. FBM twins) are covered.

## Data / decisions outstanding
- Blank spec table (Phase 4) — PO to provide.
- Ambiguous brands (champion/gap/puma/wrangler) — omitted pending a context-guard.
- Backend keywords — adversary-only pass (PO default), not full council.

## Handoff notes
- Standing directives live in the auto-memory (`MEMORY.md`) + mempalace `fba-optimizer` wing — query mempalace before re-mapping the codebase.
- This tracker auto-resumes at session start and is kept current at each milestone without being asked.
