# FBA Listing Optimizer — Roadmap

**Goal:** Generate, push, and verify Amazon listing content (title / bullets / description / highlights / backend keywords) that both RANKS and reads like natural, accurate, on-brand human copy — across full variation families — with self-healing pushes and faithful verification.

**Stack:** Next.js 16 + TypeScript + Tailwind on Coolify (long-lived `next start`, **manual Publish** to go live) · Supabase (Postgres + RLS) · Amazon SP-API (Catalog / Listings / Feeds). Repo: `simpliolabs/Amazon-packing-Slip-with-Images`. Live: slip.theceo.store.

**How this tracker runs:** GSD here is a lightweight state tracker only — the engineering discipline (reply-from-FACT, adversarial review, architect-vs-patch, karpathy, Superpowers) is unchanged and primary. `.planning/` is auto-resumed at session start and kept current at each milestone WITHOUT being asked. It never plans/executes/verifies engineering work.

---

## Milestone M1 — Content quality foundational (ACTIVE)
The current focus: customer-facing copy was keyword-stuffed, leaked a competitor brand (Nike), and invented wrong garment specs. Root cause: intelligence (councils) writes the copy, then deterministic rule-lists + a keyword-coverage backstop get the LAST WORD and wreck it. Fix: invert the last word — an enforcing audit council gets final say; raw keyword coverage is demoted to backend keywords only.

### Phase 1 — Competitor-brand scrub
Status: **done** (PR #336, merged to main)
Deliverable: apparel/athletic competitor brands (Nike, Adidas, …) added to `THIRD_PARTY_BRANDS` + dropped at the keyword-pool source.
Done when: a competitor brand can never appear in title/bullets/description/highlights/backend.

### Phase 2 — Stop prose keyword-stuffing (coverage → backend)
Status: **done, re-landing** (PR #337 was mis-merged into a feature branch; PR #338 re-lands it on main — awaiting deploy)
Deliverable: bullet coverage backstop weaves ONLY the design-name floor; readability polish is quality-first (deletes stuffing, may drop opportunity keywords); coverage lives in backend.
Done when: bullets read as natural prose, no bolted-on keyword clauses.

### Phase 3 — Enforce the coherence gates
Status: **done, re-landing** (in PR #337/#338)
Deliverable: `TITLE_COHERENCE_GATE` + `BULLET_COHERENCE_GATE` default SHADOW→ENFORCE (PO: "enforce now").
Done when: the intelligent gates actually mutate/veto in prod, not just log.

### Phase 4 — Ground the highlights
Status: **pending — BLOCKED on PO blank-spec-table data**
Deliverable: feed `buildItemHighlights` real live SP-API attributes + a PO-curated blank spec table (CC1717 etc.) + design INTENT (golf widow, not golf enthusiast); add a factual-truth gate to `validateItemHighlights`.
Done when: highlights never invent wrong specs (heavyweight/oversized) or wrong audience.

### Phase 5 — Shared enforcing AUDIT COUNCIL
Status: **pending**
Deliverable: replace `runAuditAgent` (an action-plan writer forbidden to rewrite) with an adversary→judge council that re-reads the FINAL bytes of EVERY field and can REJECT+regen or REWRITE (grammar, no brands, no stuffing, factual accuracy, correct audience). Promote highlights→council; add an adversary-only pass to backend keywords.
Done when: every customer-facing field is audited by intelligence with veto power.

---

## Milestone M0 — Push / verify integrity (recently shipped)
- Deterministic title niche-fill + reconcile-at-push full-family coverage — PR #333 (live).
- Manual-title lock + partial pushes in Change History (migration 044) — PR #334 (live).
- Verify re-checks exactly what was pushed, from `keyword_push_log` — PR #335 (merged, awaiting deploy).

## Backlog (not yet phased)
- Description-brief opportunity-mandate softening (parity with the bullet fix).
- Backend-keyword adversary pass (PO default: adversary-only, not full council).
- Ambiguous-brand context-guard (champion / gap / puma / wrangler — omitted from the brand scrub pending this).
- Details Auto Push stream interrupt at ~20/33 SKUs (task #23).
- Sleeve detail push — all write forms rejected (task #26).
- Scorer: consume `keyword_plan.perDesign` for group-scoped bullet parity (task #30).
